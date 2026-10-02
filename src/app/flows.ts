import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { lockWorkspaceForMember, workspaceFor } from "./settings.ts";
import {
  EMPTY_FLOW,
  fieldWriteTargets,
  flowReferences,
  normalizeTag,
  parseFlowDocument,
  validateFlowForPublish,
  webhookFieldIds,
  type FlowDocument,
  type FlowError,
  type PublishContext,
} from "./flow-schema.ts";
import {
  flowExecutionErrors,
  flowWebhookPayload,
  matchesFlowTrigger,
  planFlowRun,
  type ContactFacts,
  type FlowStep,
  type ResumeEntry,
} from "./flow-runtime.ts";
import { isValidFieldValue, replySavedFields } from "./contact-fields.ts";

const MAX_ACTIVE_FLOWS = 50;
const RUN_HISTORY_LIMIT = 50;
// The 64 KB document limit plus room for the request wrapper (name, revision, keys).
export const FLOW_REQUEST_BYTES = 65_536 + 4_096;
const SUMMARY = `f.id,f.name,f.draft_revision,f.archived,f.enabled,f.updated_at,v.version_no AS published_version_no`;

// Publish and enable lock the flow row FOR NO KEY UPDATE: they change no key column, and a stronger
// lock would block the foreign-key checks of an ingestion that holds a connection lock, while this
// transaction waits for that connection row.
// An enabled flow runs on a Cloudflare-delivered (OAuth) connection with a version this runtime executes.
function runnableErrors(
  document: FlowDocument,
  connection: { active: boolean; oauth: boolean } | null,
  fieldTypes: ReadonlyMap<string, string>,
): FlowError[] {
  const errors = flowExecutionErrors(document, fieldTypes);
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
  const workspace = await workspaceFor(pool, user, "agent");
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
  const workspace = await workspaceFor(pool, user, "admin");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockWorkspaceForMember(client, workspace, user, "admin");
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
  const workspace = await workspaceFor(pool, user, "agent");
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
  const workspace = await workspaceFor(pool, user, "admin");
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

// Field types never change, so the types of a published version's fields decide which variables render.
async function versionFieldTypes(client: PoolClient, workspace: string, fieldIds: string[]) {
  return new Map<string, string>(
    (
      await client.query<{ id: string; type: string }>(
        "SELECT id,type FROM instagram_contact_fields WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
        [workspace, fieldIds],
      )
    ).rows.map((row) => [row.id, row.type]),
  );
}

// What publish validates a draft against. With `lock` (publish), the connection row is locked FOR NO KEY
// UPDATE and the field rows FOR SHARE, after the flow row its caller locked; rule enabling takes the same
// connection lock. Without it (a test run), the same reads take no lock.
async function readPublishContext(
  client: PoolClient,
  workspace: string,
  id: string,
  references: ReturnType<typeof flowReferences> | null,
  lock: boolean,
): Promise<PublishContext> {
  const connectionId = references?.connection_id ?? null;
  const mediaId = references?.media_id ?? null;
  const connection = connectionId
    ? ((
        await client.query(
          `SELECT id,active,access_token_encrypted IS NOT NULL AS oauth FROM instagram_connections
           WHERE id=$1 AND workspace_id=$2${lock ? " FOR NO KEY UPDATE" : ""}`,
          [connectionId, workspace],
        )
      ).rows[0] ?? null)
    : null;
  const fields = new Map<string, string>(
    (
      await client.query<{ id: string; type: string }>(
        `SELECT id,type FROM instagram_contact_fields WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND NOT archived${lock ? " FOR SHARE" : ""}`,
        [workspace, references?.field_ids ?? []],
      )
    ).rows.map((row) => [row.id, row.type]),
  );
  // A webhook node may name only an active endpoint of this workspace. Disabling the endpoint later is
  // allowed: its deliveries then end as dead (endpoint_inactive) instead of being sent.
  const endpoints = new Set<string>(
    (
      await client.query<{ id: string }>(
        "SELECT id::text FROM webhook_endpoints WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND active",
        [workspace, references?.endpoint_ids ?? []],
      )
    ).rows.map((row) => row.id),
  );
  // Reply text never leaves through a webhook: among the fields the draft names, those a published version
  // saves a reply into and those another flow's current version sends. Neither read takes a lock, so two
  // concurrent publishes can pass both; a run then leaves such a field out of its payload (planFlowRun).
  const replyFields = await replySavedFields(client, workspace, references?.field_ids ?? []);
  const webhookFields = new Set<string>(
    (
      await client.query<{ id: string }>(
        `SELECT DISTINCT lower(target #>> '{}') AS id FROM flows f JOIN flow_versions v ON v.id=f.published_version_id
         CROSS JOIN LATERAL jsonb_path_query(v.definition,
           'lax $.nodes[*] ? (@.type == "webhook").config.field_ids[*]') target
         WHERE f.workspace_id=$1 AND f.id<>$2 AND NOT f.archived AND v.field_ids && $3::uuid[]
           AND jsonb_typeof(target)='string'`,
        [workspace, id, references?.field_ids ?? []],
      )
    ).rows.map((row) => row.id),
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
  return {
    connection,
    fields,
    endpoints,
    replyFields,
    webhookFields,
    legacyRuleEnabled: conflicts.legacy,
    otherFlowPublished: conflicts.other,
  };
}

export async function publishFlow(
  pool: Pool,
  user: User,
  id: string,
  input: unknown,
): Promise<{ version_no: number; published_at: Date; replayed: boolean } | { errors: FlowError[] }> {
  if (!isUuid(id)) throw new ApiError(400, "invalid_flow");
  const expected = revision(onlyKeys(input, ["expected_revision"]).expected_revision);
  const workspace = await workspaceFor(pool, user, "admin");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const flow = (
      await client.query(
        "SELECT draft,draft_revision,archived,enabled FROM flows WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE",
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
    const context = await readPublishContext(client, workspace, id, references, true);
    const { connection, fields } = context;
    const errors = validateFlowForPublish(flow.draft, context);
    // A new version of an enabled flow starts runs immediately, so it must be runnable too.
    if (!errors.length && flow.enabled && "document" in parsed)
      errors.push(...runnableErrors(parsed.document, connection, fields));
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
  const workspace = await workspaceFor(pool, user, "admin");
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
  const workspace = await workspaceFor(pool, user, "agent");
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
  const workspace = await workspaceFor(pool, user, "agent");
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
  const workspace = await workspaceFor(pool, user, "admin");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const flow = (
      await client.query(
        `SELECT f.archived,v.definition,v.trigger_connection_id,v.field_ids FROM flows f
         LEFT JOIN flow_versions v ON v.id=f.published_version_id AND v.flow_id=f.id
         WHERE f.id=$1 AND f.workspace_id=$2 FOR NO KEY UPDATE OF f`,
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
      const fieldTypes = await versionFieldTypes(client, workspace, flow.field_ids);
      const parsed = parseFlowDocument(flow.definition);
      const errors = "document" in parsed ? runnableErrors(parsed.document, connection, fieldTypes) : parsed.errors;
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
  const workspace = await workspaceFor(pool, user, "agent");
  if (!(await pool.query("SELECT 1 FROM flows WHERE id=$1 AND workspace_id=$2", [id, workspace])).rowCount)
    throw new ApiError(404, "flow_not_found");
  return (
    await pool.query(
      `SELECT r.id,v.version_no,r.status,r.failure_code,r.created_at,r.resume_at,
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

// The longest synthetic comment or reply text a test run accepts (service policy).
const MAX_TEST_TEXT = 2_000;
const MAX_TEST_TAGS = 20;
// A test run walks from the trigger, then once more from each delay, time wait or reply wait it stops at.
// A publishable document has no cycle and at most 100 nodes, so its path stops fewer times than this and
// records fewer steps (a reply wait records up to two); the caps only bound a walk that would not end.
const MAX_TEST_RUN_RESUMES = 100;
const MAX_TEST_RUN_STEPS = 300;

type TestRunInput = {
  source: "draft" | "published";
  commentText: string;
  tags: string[];
  fields: Map<string, unknown>;
  replyText?: string;
  replyBranch: "replied" | "timeout";
  expectedRevision?: number;
};

function testRunInput(input: unknown): TestRunInput {
  const keys = ["source", "comment_text", "tags", "fields", "reply_text", "reply_branch", "expected_revision"];
  if (!isRecord(input) || Object.keys(input).some((key) => !keys.includes(key)))
    throw new ApiError(400, "invalid_test_run");
  const text = (value: unknown) => typeof value === "string" && value.length <= MAX_TEST_TEXT;
  if (
    (input.source !== "draft" && input.source !== "published") ||
    !text(input.comment_text) ||
    (input.reply_text !== undefined && !text(input.reply_text)) ||
    (input.reply_branch !== undefined && input.reply_branch !== "replied" && input.reply_branch !== "timeout") ||
    (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > MAX_TEST_TAGS)) ||
    (input.fields !== undefined && !isRecord(input.fields)) ||
    // Only a draft has a revision; a published version never changes.
    (input.expected_revision !== undefined &&
      (input.source !== "draft" ||
        !Number.isInteger(input.expected_revision) ||
        (input.expected_revision as number) < 0 ||
        (input.expected_revision as number) >= 2147483647))
  )
    throw new ApiError(400, "invalid_test_run");
  const tags = ((input.tags as unknown[] | undefined) ?? []).map(normalizeTag);
  if (tags.some((tag) => tag === null)) throw new ApiError(400, "invalid_contact_tags");
  // Stored field IDs are lower case, and the walk reads them that way.
  const fields = new Map<string, unknown>();
  for (const [id, value] of Object.entries((input.fields as Record<string, unknown> | undefined) ?? {})) {
    if (!isUuid(id) || fields.has(id.toLowerCase())) throw new ApiError(400, "invalid_test_run");
    fields.set(id.toLowerCase(), value);
  }
  return {
    source: input.source,
    commentText: input.comment_text as string,
    tags: [...new Set(tags as string[])],
    fields,
    ...(input.reply_text === undefined ? {} : { replyText: input.reply_text as string }),
    replyBranch: (input.reply_branch as "replied" | "timeout" | undefined) ?? "replied",
    ...(input.expected_revision === undefined ? {} : { expectedRevision: input.expected_revision as number }),
  };
}

type TestRunResult = {
  status: "not_matched" | "ended" | "delivering" | "failed";
  failure_code: string | null;
  steps: FlowStep[];
  messages: { node_id: string; text: string }[];
  waits: { node_id: string; node_type: string; port: string; delay_minutes?: number; until_time?: string }[];
  changes: { tags: Record<string, boolean>; fields: Record<string, unknown> };
  webhooks: { node_id: string; endpoint_id: string; payload: ReturnType<typeof flowWebhookPayload> }[];
};

// Walks a document as a run would, continuing at once from each delay, time wait and reply wait, with
// synthetic facts in place of a contact. Between walks the facts change as the store writes them
// (applyContactChanges): removed tags leave, added tags follow the kept ones, and set fields take
// their values, so every walk reads what a resumed run would read back.
function simulateFlowRun(
  document: FlowDocument,
  facts: ContactFacts,
  input: Omit<TestRunInput, "source" | "tags" | "fields"> & {
    writableFields: ReadonlySet<string>;
    replyFields: ReadonlySet<string>;
  },
  ids: { flowId: string; versionNo: number | null },
): TestRunResult {
  let tags = [...facts.tags];
  const fields = new Map(facts.fields);
  const result: TestRunResult = {
    status: "not_matched",
    failure_code: null,
    steps: [],
    messages: [],
    waits: [],
    changes: { tags: {}, fields: {} },
    webhooks: [],
  };
  if (!matchesFlowTrigger(document, input.commentText)) return result;
  let entry: ResumeEntry | undefined;
  for (let resumes = 0; ; resumes++) {
    if (resumes > MAX_TEST_RUN_RESUMES || result.steps.length > MAX_TEST_RUN_STEPS) {
      result.status = "failed";
      result.failure_code = "test_run_limit";
      break;
    }
    const plan = planFlowRun(
      document,
      { tags: new Set(tags), fields },
      {
        commentText: input.commentText,
        writableFields: input.writableFields,
        replyFields: input.replyFields,
        ...(entry?.port === "replied" && input.replyText !== undefined ? { replyText: input.replyText } : {}),
      },
      entry,
    );
    result.steps.push(...plan.steps);
    tags = [
      ...tags.filter((tag) => plan.changes.tags.get(tag) !== false),
      ...[...plan.changes.tags].filter(([, member]) => member).map(([tag]) => tag),
    ];
    for (const [id, value] of plan.changes.fields) fields.set(id, value);
    for (const webhook of plan.webhooks ?? [])
      result.webhooks.push({
        node_id: webhook.node_id,
        endpoint_id: webhook.endpoint_id,
        payload: flowWebhookPayload(
          { event_id: null, created_at: null, flow_id: ids.flowId, flow_version: ids.versionNo, run_id: null },
          webhook,
        ),
      });
    const last = plan.steps.at(-1);
    if (plan.status === "waiting") {
      result.waits.push({
        node_id: plan.resume_node_id,
        node_type: last?.node_type ?? "",
        port: "next",
        ...("until_time" in plan ? { until_time: plan.until_time } : { delay_minutes: plan.delay_minutes }),
      });
      entry = { node_id: plan.resume_node_id, port: "next" };
      continue;
    }
    if (plan.status === "message") {
      result.messages.push({ node_id: last!.node_id, text: plan.text });
      if (plan.wait_node_id !== undefined) {
        result.waits.push({ node_id: plan.wait_node_id, node_type: "wait_for_reply", port: input.replyBranch });
        entry = { node_id: plan.wait_node_id, port: input.replyBranch };
        continue;
      }
      result.status = "delivering";
      break;
    }
    result.status = plan.status;
    if (plan.status === "failed") result.failure_code = plan.failure_code;
    break;
  }
  // Object.fromEntries defines own properties, so a tag named __proto__ is kept instead of
  // reaching the inherited setter that plain assignment calls.
  result.changes.tags = Object.fromEntries(
    [...new Set([...facts.tags, ...tags])]
      .filter((tag) => facts.tags.has(tag) !== tags.includes(tag))
      .map((tag) => [tag, tags.includes(tag)]),
  );
  for (const [id, value] of fields) if (facts.fields.get(id) !== value) result.changes.fields[id] = value;
  return result;
}

// Shows what one comment would do in a flow's draft or published version, with synthetic contact facts
// and a reply branch chosen by the caller. The role check reads membership first; every other read is
// in one read-only transaction. Nothing is written or sent, and no stored contact, comment or message is read.
export async function testFlowRun(
  pool: Pool,
  user: User,
  id: string,
  input: unknown,
): Promise<
  | ({ source: "draft" | "published"; version_no: number | null } & TestRunResult)
  | { error: "flow_invalid" | "flow_not_executable"; errors: FlowError[] }
> {
  if (!isUuid(id)) throw new ApiError(400, "invalid_flow");
  const body = testRunInput(input);
  const workspace = await workspaceFor(pool, user, "admin");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const flow = (
      await client.query(
        `SELECT f.id::text,f.draft,f.draft_revision,f.archived,v.version_no,v.definition,v.field_ids FROM flows f
         LEFT JOIN flow_versions v ON v.id=f.published_version_id AND v.flow_id=f.id
         WHERE f.id=$1 AND f.workspace_id=$2`,
        [id, workspace],
      )
    ).rows[0];
    if (!flow) throw new ApiError(404, "flow_not_found");
    if (flow.archived) throw new ApiError(409, "flow_archived");
    if (body.source === "published" && !flow.definition) throw new ApiError(409, "flow_not_published");
    // The draft and its revision come from the same snapshot, so a matching revision means the caller's
    // copy of the draft is the document that runs.
    if (body.expectedRevision !== undefined && flow.draft_revision !== body.expectedRevision)
      throw new ApiError(409, "revision_conflict");
    const types = new Map<string, string>(
      (
        await client.query<{ id: string; type: string }>(
          "SELECT id::text,type FROM instagram_contact_fields WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND NOT archived",
          [workspace, [...body.fields.keys()]],
        )
      ).rows.map((row) => [row.id, row.type]),
    );
    for (const [field, value] of body.fields) {
      const type = types.get(field);
      if (!type) throw new ApiError(400, "unknown_field");
      if (!isValidFieldValue(type, value)) throw new ApiError(400, "invalid_field_value");
    }
    // A draft must pass publish validation against the same context publish reads, and either source must
    // pass the enable check's execution rules; otherwise only the errors are returned.
    const definition = body.source === "draft" ? flow.draft : flow.definition;
    const parsed = parseFlowDocument(definition);
    if ("errors" in parsed) return { error: "flow_invalid", errors: parsed.errors };
    const document = parsed.document;
    let fieldTypes: ReadonlyMap<string, string>;
    if (body.source === "draft") {
      const context = await readPublishContext(client, workspace, id, flowReferences(document), false);
      const errors = validateFlowForPublish(definition, context);
      if (errors.length) return { error: "flow_invalid", errors };
      fieldTypes = context.fields;
    } else fieldTypes = await versionFieldTypes(client, workspace, flow.field_ids);
    const executionErrors = flowExecutionErrors(document, fieldTypes);
    if (executionErrors.length) return { error: "flow_not_executable", errors: executionErrors };
    // The fields a set_field node or a reply wait may still write, and the fields a reply wait of any
    // published version saves into, read as a run reads them but without its locks.
    const writableFields = new Set(
      (
        await client.query<{ id: string }>(
          "SELECT id::text FROM instagram_contact_fields WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND NOT archived",
          [workspace, fieldWriteTargets(document)],
        )
      ).rows.map((row) => row.id),
    );
    const replyFields = await replySavedFields(client, workspace, webhookFieldIds(document));
    const versionNo = body.source === "published" ? (flow.version_no as number) : null;
    return {
      source: body.source,
      version_no: versionNo,
      ...simulateFlowRun(
        document,
        { tags: new Set(body.tags), fields: body.fields },
        {
          commentText: body.commentText,
          replyBranch: body.replyBranch,
          ...(body.replyText === undefined ? {} : { replyText: body.replyText }),
          writableFields,
          replyFields,
        },
        { flowId: flow.id, versionNo },
      ),
    };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
