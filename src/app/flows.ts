import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";
import {
  EMPTY_FLOW,
  flowReferences,
  parseFlowDocument,
  validateFlowForPublish,
  type FlowDocument,
  type FlowError,
} from "./flow-schema.ts";
import { flowExecutionErrors } from "./flow-runtime.ts";

const MAX_ACTIVE_FLOWS = 50;
const RUN_HISTORY_LIMIT = 50;
// The 64 KB document limit plus room for the request wrapper (name, revision, keys).
export const FLOW_REQUEST_BYTES = 65_536 + 4_096;
const SUMMARY = `f.id,f.name,f.draft_revision,f.archived,f.enabled,f.updated_at,v.version_no AS published_version_no`;

// An enabled flow runs on a Cloudflare-delivered (OAuth) connection with a version this runtime executes.
function runnableErrors(document: FlowDocument, connection: { active: boolean; oauth: boolean } | null): FlowError[] {
  const errors = flowExecutionErrors(document);
  if (!connection?.active) errors.push({ code: "connection_unavailable", path: "nodes" });
  else if (!connection.oauth) errors.push({ code: "login_mode_required", path: "nodes" });
  return errors;
}

function flowName(value: unknown): string {
  if (typeof value !== "string" || value.length > 300) throw new ApiError(400, "invalid_flow");
  const name = value.trim().normalize("NFC");
  if (!name || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new ApiError(400, "invalid_flow");
  return name;
}

function flowDocument(value: unknown): FlowDocument {
  const parsed = parseFlowDocument(value);
  if ("errors" in parsed) throw new ApiError(400, parsed.errors[0]!.code);
  return parsed.document;
}

function revision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= 2147483647)
    throw new ApiError(400, "invalid_flow");
  return value as number;
}

function onlyKeys(input: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(input) || Object.keys(input).some((key) => !keys.includes(key)))
    throw new ApiError(400, "invalid_flow");
  return input;
}

export async function listFlows(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user);
  return (
    await pool.query(
      `SELECT ${SUMMARY} FROM flows f LEFT JOIN flow_versions v ON v.id=f.published_version_id
       WHERE f.workspace_id=$1 AND NOT f.archived ORDER BY f.created_at,f.id`,
      [workspace],
    )
  ).rows;
}

export async function createFlow(pool: Pool, user: User, input: unknown) {
  const body = onlyKeys(input, ["name", "draft"]);
  const name = flowName(body.name);
  const draft = body.draft === undefined ? EMPTY_FLOW : flowDocument(body.draft);
  const workspace = await workspaceFor(pool, user);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspace]);
    const created = await client.query(
      `INSERT INTO flows(workspace_id,name,draft) SELECT $1,$2,$3::jsonb
       WHERE (SELECT count(*) FROM flows WHERE workspace_id=$1 AND NOT archived)<$4
       RETURNING id,name,draft,draft_revision,archived,updated_at`,
      [workspace, name, JSON.stringify(draft), MAX_ACTIVE_FLOWS],
    );
    if (!created.rows[0]) throw new ApiError(409, "flow_limit_reached");
    await client.query("COMMIT");
    return { ...created.rows[0], published_version_no: null };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getFlow(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_flow");
  const workspace = await workspaceFor(pool, user);
  const flow = (
    await pool.query(
      `SELECT ${SUMMARY},f.draft FROM flows f LEFT JOIN flow_versions v ON v.id=f.published_version_id
       WHERE f.id=$1 AND f.workspace_id=$2`,
      [id, workspace],
    )
  ).rows[0];
  if (!flow) throw new ApiError(404, "flow_not_found");
  return flow;
}

export async function saveFlowDraft(pool: Pool, user: User, id: string, input: unknown) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_flow");
  const body = onlyKeys(input, ["expected_revision", "draft", "name"]);
  const expected = revision(body.expected_revision);
  const draft = flowDocument(body.draft);
  const name = body.name === undefined ? null : flowName(body.name);
  const workspace = await workspaceFor(pool, user);
  const saved = await pool.query(
    `UPDATE flows SET draft=$4::jsonb,name=coalesce($5,name),draft_revision=draft_revision+1,updated_at=clock_timestamp()
     WHERE id=$1 AND workspace_id=$2 AND NOT archived AND draft_revision=$3 RETURNING draft_revision`,
    [id, workspace, expected, JSON.stringify(draft), name],
  );
  if (saved.rows[0]) return { draft_revision: saved.rows[0].draft_revision };
  const current = (await pool.query("SELECT archived FROM flows WHERE id=$1 AND workspace_id=$2", [id, workspace]))
    .rows[0];
  if (!current) throw new ApiError(404, "flow_not_found");
  throw new ApiError(409, current.archived ? "flow_archived" : "revision_conflict");
}

export async function publishFlow(
  pool: Pool,
  user: User,
  id: string,
  input: unknown,
): Promise<{ version_no: number; published_at: Date; replayed: boolean } | { errors: FlowError[] }> {
  if (!isUuid(id)) throw new ApiError(400, "invalid_flow");
  const expected = revision(onlyKeys(input, ["expected_revision"]).expected_revision);
  const workspace = await workspaceFor(pool, user);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const flow = (
      await client.query(
        "SELECT draft,draft_revision,archived,enabled FROM flows WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
        [id, workspace],
      )
    ).rows[0];
    if (!flow) throw new ApiError(404, "flow_not_found");
    if (flow.archived) throw new ApiError(409, "flow_archived");
    if (flow.draft_revision !== expected) throw new ApiError(409, "revision_conflict");
    // A retried publish of the same revision returns the version it already created.
    const existing = (
      await client.query("SELECT version_no,published_at FROM flow_versions WHERE flow_id=$1 AND draft_revision=$2", [
        id,
        expected,
      ])
    ).rows[0];
    if (existing) {
      await client.query("COMMIT");
      return { version_no: existing.version_no, published_at: existing.published_at, replayed: true };
    }
    const parsed = parseFlowDocument(flow.draft);
    const references = "document" in parsed ? flowReferences(parsed.document) : null;
    const connectionId = references?.connection_id ?? null;
    const mediaId = references?.media_id ?? null;
    // Lock order: flow row, then connection row. Rule enabling takes the same connection lock.
    const connection = connectionId
      ? ((
          await client.query(
            `SELECT id,active,access_token_encrypted IS NOT NULL AS oauth FROM instagram_connections
             WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE`,
            [connectionId, workspace],
          )
        ).rows[0] ?? null)
      : null;
    const fields = new Map<string, string>(
      (
        await client.query<{ id: string; type: string }>(
          "SELECT id,type FROM instagram_contact_fields WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND NOT archived FOR SHARE",
          [workspace, references?.field_ids ?? []],
        )
      ).rows.map((row) => [row.id, row.type]),
    );
    const conflicts =
      connection && mediaId
        ? (
            await client.query<{ legacy: boolean; other: boolean }>(
              `SELECT EXISTS(SELECT 1 FROM instagram_comment_rules WHERE workspace_id=$1 AND connection_id=$2 AND media_id=$3 AND enabled) AS legacy,
                EXISTS(SELECT 1 FROM flows f JOIN flow_versions v ON v.id=f.published_version_id
                  WHERE f.workspace_id=$1 AND f.id<>$4 AND NOT f.archived AND v.trigger_connection_id=$2 AND v.trigger_media_id=$3) AS other`,
              [workspace, connection.id, mediaId, id],
            )
          ).rows[0]!
        : { legacy: false, other: false };
    const errors = validateFlowForPublish(flow.draft, {
      connection,
      fields,
      legacyRuleEnabled: conflicts.legacy,
      otherFlowPublished: conflicts.other,
    });
    // A new version of an enabled flow starts runs immediately, so it must be runnable too.
    if (!errors.length && flow.enabled && "document" in parsed)
      errors.push(...runnableErrors(parsed.document, connection));
    if (errors.length) {
      await client.query("ROLLBACK");
      return { errors };
    }
    const version = (
      await client.query(
        `INSERT INTO flow_versions(flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,field_ids,published_by)
         SELECT $1,$2,coalesce(max(version_no),0)+1,$8,$3::jsonb,$4,$5,$6::uuid[],$7 FROM flow_versions WHERE flow_id=$1
         RETURNING id,version_no,published_at`,
        [id, workspace, JSON.stringify(flow.draft), connectionId, mediaId, references!.field_ids, user.id, expected],
      )
    ).rows[0]!;
    await client.query("UPDATE flows SET published_version_id=$2,updated_at=clock_timestamp() WHERE id=$1", [
      id,
      version.id,
    ]);
    await client.query("COMMIT");
    return { version_no: version.version_no, published_at: version.published_at, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function archiveFlow(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_flow");
  const workspace = await workspaceFor(pool, user);
  const archived = await pool.query(
    `UPDATE flows SET archived=true,enabled=false,published_version_id=NULL,updated_at=clock_timestamp()
     WHERE id=$1 AND workspace_id=$2 RETURNING id`,
    [id, workspace],
  );
  if (!archived.rows[0]) throw new ApiError(404, "flow_not_found");
  return { id };
}

export async function listFlowVersions(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_flow");
  const workspace = await workspaceFor(pool, user);
  const flow = (
    await pool.query("SELECT published_version_id FROM flows WHERE id=$1 AND workspace_id=$2", [id, workspace])
  ).rows[0];
  if (!flow) throw new ApiError(404, "flow_not_found");
  return (
    await pool.query(
      `SELECT version_no,published_at,published_by,id IS NOT DISTINCT FROM $3::uuid AS current FROM flow_versions
       WHERE flow_id=$1 AND workspace_id=$2 ORDER BY version_no DESC`,
      [id, workspace, flow.published_version_id],
    )
  ).rows;
}

export async function getFlowVersion(pool: Pool, user: User, id: string, versionNo: string) {
  if (!isUuid(id) || !/^\d{1,9}$/.test(versionNo)) throw new ApiError(400, "invalid_flow");
  const workspace = await workspaceFor(pool, user);
  const version = (
    await pool.query(
      `SELECT version_no,definition,published_at,published_by FROM flow_versions
       WHERE flow_id=$1 AND workspace_id=$2 AND version_no=$3`,
      [id, workspace, Number(versionNo)],
    )
  ).rows[0];
  if (!version) throw new ApiError(404, "flow_version_not_found");
  return version;
}

export async function setFlowEnabled(
  pool: Pool,
  user: User,
  id: string,
  enabled: boolean,
): Promise<{ enabled: boolean } | { errors: FlowError[] }> {
  if (!isUuid(id)) throw new ApiError(400, "invalid_flow");
  const workspace = await workspaceFor(pool, user);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const flow = (
      await client.query(
        `SELECT f.archived,v.definition,v.trigger_connection_id FROM flows f
         LEFT JOIN flow_versions v ON v.id=f.published_version_id AND v.flow_id=f.id
         WHERE f.id=$1 AND f.workspace_id=$2 FOR UPDATE OF f`,
        [id, workspace],
      )
    ).rows[0];
    if (!flow) throw new ApiError(404, "flow_not_found");
    if (enabled) {
      if (flow.archived) throw new ApiError(409, "flow_archived");
      if (!flow.definition) throw new ApiError(409, "flow_not_published");
      // Lock order: flow row, then connection row, as publishing does.
      const connection =
        (
          await client.query(
            `SELECT active,access_token_encrypted IS NOT NULL AS oauth FROM instagram_connections
             WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE`,
            [flow.trigger_connection_id, workspace],
          )
        ).rows[0] ?? null;
      const parsed = parseFlowDocument(flow.definition);
      const errors = "document" in parsed ? runnableErrors(parsed.document, connection) : parsed.errors;
      if (errors.length) {
        await client.query("ROLLBACK");
        return { errors };
      }
    }
    await client.query("UPDATE flows SET enabled=$3,updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2", [
      id,
      workspace,
      enabled,
    ]);
    await client.query("COMMIT");
    return { enabled };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Latest runs with the path each took and the delivery state of the reply it queued.
// Sender IDs and comment text stay out of the history.
export async function listFlowRuns(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_flow");
  const workspace = await workspaceFor(pool, user);
  if (!(await pool.query("SELECT 1 FROM flows WHERE id=$1 AND workspace_id=$2", [id, workspace])).rowCount)
    throw new ApiError(404, "flow_not_found");
  return (
    await pool.query(
      `SELECT r.id,v.version_no,r.status,r.failure_code,r.created_at,
         reply.status AS delivery_status,reply.failure_code AS delivery_failure_code,reply.sent_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object('node_id',s.node_id,'node_type',s.node_type,'outcome',s.outcome) ORDER BY s.seq)
           FROM flow_step_runs s WHERE s.run_id=r.id),'[]'::jsonb) AS steps
       FROM flow_runs r JOIN flow_versions v ON v.id=r.flow_version_id
       LEFT JOIN private_reply_outbox reply ON reply.flow_run_id=r.id
       WHERE r.flow_id=$1 AND r.workspace_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT $3`,
      [id, workspace, RUN_HISTORY_LIMIT],
    )
  ).rows;
}
