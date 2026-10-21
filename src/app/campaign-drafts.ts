import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { lockWorkspaceForMember, membershipFor } from "./settings.ts";

const LIMIT = 100;
function invalid(): never {
  throw new ApiError(400, "invalid_campaign_draft");
}
function uuid(value: unknown): string {
  if (!isUuid(value)) invalid();
  return value.toLowerCase();
}
function version(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) >= 2147483647) invalid();
  return Number(value);
}
export function parseCampaignDraft(input: unknown, editing = false) {
  const fields = [editing ? "expected_version" : "id", "snapshot_id", "name", "body"];
  if (!isRecord(input) || Object.keys(input).length !== fields.length || !fields.every((key) => key in input))
    invalid();
  if (typeof input.name !== "string" || /[\u0000-\u001f\u007f]/.test(input.name)) invalid();
  const name = input.name.normalize("NFC").trim();
  if (!name || [...name].length > 60) invalid();
  if (
    typeof input.body !== "string" ||
    !input.body.trim() ||
    input.body.length > 1000 ||
    input.body.includes("\u0000") ||
    input.body.includes("{{") ||
    input.body.includes("}}")
  )
    invalid();
  return {
    id: editing ? null : uuid(input.id),
    snapshot_id: uuid(input.snapshot_id),
    name,
    body: input.body,
    expected_version: editing ? version(input.expected_version) : null,
  };
}
async function transaction<T>(
  pool: Pool,
  user: User,
  write: boolean,
  work: (client: PoolClient, workspace: string) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query(write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { workspace_id: workspace } = await membershipFor(client, user, "admin");
    if (write) await lockWorkspaceForMember(client, workspace, user, "admin");
    const result = await work(client, workspace);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
const SUMMARY = "d.id,d.snapshot_id,d.name,d.version,d.archived,d.created_at,d.updated_at";
async function detail(client: PoolClient, workspace: string, id: string) {
  const row = (
    await client.query(
      `SELECT ${SUMMARY},d.body,d.created_by,d.updated_by,s.member_count AS original_member_count,
    (SELECT count(*)::int FROM instagram_segment_snapshot_members m WHERE m.workspace_id=d.workspace_id AND m.snapshot_id=d.snapshot_id) AS stored_member_count
    FROM campaign_drafts d JOIN instagram_segment_snapshots s ON s.workspace_id=d.workspace_id AND s.id=d.snapshot_id
    WHERE d.workspace_id=$1 AND d.id=$2`,
      [workspace, id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "campaign_draft_not_found");
  return row;
}
async function requireSnapshot(client: PoolClient, workspace: string, id: string) {
  const row = await client.query("SELECT id FROM instagram_segment_snapshots WHERE workspace_id=$1 AND id=$2", [
    workspace,
    id,
  ]);
  if (!row.rows.length) throw new ApiError(404, "snapshot_not_found");
}
export async function listCampaignDrafts(pool: Pool, user: User) {
  return transaction(pool, user, false, async (client, workspace) => ({
    drafts: (
      await client.query(
        `SELECT ${SUMMARY} FROM campaign_drafts d WHERE d.workspace_id=$1 ORDER BY d.created_at DESC,d.id LIMIT $2`,
        [workspace, LIMIT],
      )
    ).rows,
  }));
}
export async function getCampaignDraft(pool: Pool, user: User, id: string) {
  id = uuid(id);
  return transaction(pool, user, false, (client, workspace) => detail(client, workspace, id));
}
export async function createCampaignDraft(pool: Pool, user: User, input: unknown) {
  const draft = parseCampaignDraft(input);
  const hash = createHash("sha256")
    .update(JSON.stringify([draft.id, draft.snapshot_id, draft.name, draft.body]))
    .digest("hex");
  return transaction(pool, user, true, async (client, workspace) => {
    const current = (
      await client.query("SELECT create_request_hash FROM campaign_drafts WHERE workspace_id=$1 AND id=$2", [
        workspace,
        draft.id,
      ])
    ).rows[0];
    if (current) {
      if (current.create_request_hash !== hash) throw new ApiError(409, "campaign_draft_conflict");
      return { draft: await detail(client, workspace, draft.id!), created: false };
    }
    await requireSnapshot(client, workspace, draft.snapshot_id);
    const count = (
      await client.query("SELECT count(*)::int AS total FROM campaign_drafts WHERE workspace_id=$1", [workspace])
    ).rows[0]!.total;
    if (count >= LIMIT) throw new ApiError(409, "campaign_draft_limit_reached");
    await client.query(
      `INSERT INTO campaign_drafts(id,workspace_id,snapshot_id,name,body,create_request_hash,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
      [draft.id, workspace, draft.snapshot_id, draft.name, draft.body, hash, user.id],
    );
    return { draft: await detail(client, workspace, draft.id!), created: true };
  });
}
export async function updateCampaignDraft(pool: Pool, user: User, id: string, input: unknown, archive = false) {
  id = uuid(id);
  let expected: number;
  let draft: ReturnType<typeof parseCampaignDraft> | null = null;
  if (archive) {
    if (!isRecord(input) || Object.keys(input).length !== 1 || !("expected_version" in input)) invalid();
    expected = version(input.expected_version);
  } else {
    draft = parseCampaignDraft(input, true);
    expected = draft.expected_version!;
  }
  return transaction(pool, user, true, async (client, workspace) => {
    const current = (
      await client.query("SELECT version,archived FROM campaign_drafts WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [
        workspace,
        id,
      ])
    ).rows[0];
    if (!current) throw new ApiError(404, "campaign_draft_not_found");
    if (current.archived || current.version !== expected) throw new ApiError(409, "campaign_draft_conflict");
    if (draft) {
      await requireSnapshot(client, workspace, draft.snapshot_id);
      await client.query(
        `UPDATE campaign_drafts SET snapshot_id=$3,name=$4,body=$5,version=version+1,updated_by=$6,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2`,
        [workspace, id, draft.snapshot_id, draft.name, draft.body, user.id],
      );
    } else {
      await client.query(
        `UPDATE campaign_drafts SET archived=true,version=version+1,updated_by=$3,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2`,
        [workspace, id, user.id],
      );
    }
    return detail(client, workspace, id);
  });
}
