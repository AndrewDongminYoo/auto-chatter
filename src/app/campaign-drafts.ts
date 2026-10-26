import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { verifiedDmRecipientsSql } from "./inbox-identity.ts";
import { lockWorkspaceForMember, membershipFor } from "./settings.ts";
import { instagramCapabilities } from "../instagram/channel-adapter.ts";

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
// The preview reasons in evaluation order; each remaining member gets exactly one, the first that applies.
export const CAMPAIGN_PREVIEW_REASONS = [
  "connection_unavailable",
  "contact_paused",
  "no_dm_identity",
  "opted_out",
  "marketing_consent_required",
  "reply_window_closed",
  "candidate",
] as const;
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// One statement and one clock (as_of). Stages 1-3 belong to the member; stages 4-6 belong to each verified DM
// recipient, and the member takes the furthest stage any of its recipients reaches (7 is candidate). The
// verified bridge reads its own freshness clock (now()), as the contact detail does. The bridge and the per-member
// recipient stage are MATERIALIZED and joined, so neither runs again for each snapshot member. The bridge groups
// per connection, so reading only the snapshot's connections gives the same rows for its members.
const PREVIEW_SQL = `WITH evaluation AS MATERIALIZED (SELECT statement_timestamp() AS as_of),
 draft AS (
   SELECT d.id,d.version,d.archived,d.snapshot_id,s.member_count
   FROM campaign_drafts d JOIN instagram_segment_snapshots s ON s.workspace_id=d.workspace_id AND s.id=d.snapshot_id
   WHERE d.workspace_id=$1 AND d.id=$2
 ), members AS (
   SELECT m.connection_id,m.sender_id FROM instagram_segment_snapshot_members m JOIN draft ON m.snapshot_id=draft.snapshot_id
   WHERE m.workspace_id=$1
 ), verified AS MATERIALIZED (${verifiedDmRecipientsSql("workspace_id=$1 AND id IN (SELECT connection_id FROM members)")}),
 recipients AS MATERIALIZED (
   SELECT v.connection_id,v.sender_id,max(CASE
     WHEN EXISTS(SELECT 1 FROM channel_consent_state state WHERE state.workspace_id=$1 AND state.connection_id=v.connection_id
       AND state.channel='instagram' AND state.purpose IN ('marketing','service_reply') AND state.decision='revoke'
       AND ((state.identity_kind='dm_recipient' AND state.identity_value=v.recipient_id)
         OR (state.identity_kind='comment_sender' AND state.identity_value=v.sender_id))) THEN 4
     WHEN NOT EXISTS(SELECT 1 FROM channel_consent_state state WHERE state.workspace_id=$1 AND state.connection_id=v.connection_id
       AND state.channel='instagram' AND state.identity_kind='dm_recipient' AND state.identity_value=v.recipient_id
       AND state.purpose='marketing' AND state.decision='grant' AND state.evidence_kind='explicit') THEN 5
     WHEN NOT coalesce((SELECT max(message.message_at)<=evaluation.as_of AND evaluation.as_of-max(message.message_at)<interval '24 hours'
       FROM instagram_inbox_messages message WHERE message.workspace_id=$1 AND message.connection_id=v.connection_id
         AND message.recipient_id=v.recipient_id AND message.kind='text'),false) THEN 6
     ELSE 7 END) AS stage
   FROM verified v JOIN members m ON m.connection_id=v.connection_id AND m.sender_id=v.sender_id CROSS JOIN evaluation
   GROUP BY v.connection_id,v.sender_id
 ), staged AS (
   SELECT CASE
     WHEN NOT coalesce(c.active AND c.send_enabled AND c.access_token_encrypted IS NOT NULL AND c.token_expires_at>evaluation.as_of,false) THEN 1
     WHEN coalesce(a.paused OR a.handoff_paused,false) THEN 2
     ELSE coalesce(r.stage,3)
   END AS stage
   FROM members m CROSS JOIN evaluation
   LEFT JOIN instagram_connections c ON c.workspace_id=$1 AND c.id=m.connection_id
   LEFT JOIN instagram_contact_automation a ON a.workspace_id=$1 AND a.connection_id=m.connection_id AND a.sender_id=m.sender_id
   LEFT JOIN recipients r ON r.connection_id=m.connection_id AND r.sender_id=m.sender_id
 )
 SELECT draft.id AS draft_id,draft.version AS draft_version,draft.snapshot_id,draft.archived,
   draft.member_count::text AS original_member_count,${utc("evaluation.as_of")} AS as_of,
   (SELECT count(*) FROM staged)::text AS remaining_member_count,
   ${CAMPAIGN_PREVIEW_REASONS.map((reason, index) => `(SELECT count(*) FROM staged WHERE stage=${index + 1})::text AS ${reason}`).join(",")}
 FROM draft CROSS JOIN evaluation`;
// Read-only: it writes nothing and its candidate count is not a claim that anyone can be sent to (#35).
export async function previewCampaignDraft(pool: Pool, user: User, id: string, globalSendEnabled: boolean) {
  return transaction(pool, user, false, async (client, workspace) => {
    if (!isUuid(id)) throw new ApiError(404, "campaign_draft_not_found");
    const row = (await client.query(PREVIEW_SQL, [workspace, id.toLowerCase()])).rows[0];
    if (!row) throw new ApiError(404, "campaign_draft_not_found");
    const counts = Object.fromEntries(CAMPAIGN_PREVIEW_REASONS.map((reason) => [reason, row[reason] as string]));
    return {
      draft_id: row.draft_id,
      draft_version: row.draft_version,
      snapshot_id: row.snapshot_id,
      archived: row.archived,
      as_of: row.as_of,
      original_member_count: row.original_member_count,
      remaining_member_count: row.remaining_member_count,
      counts,
      candidate_meaning: "passed_recorded_conditions_at_as_of",
      sendability_claimed: false,
      estimated_provider_calls: counts.candidate,
      plan_broadcast_limit: null,
      channel_marketing_supported: instagramCapabilities("cloudflare_oauth").operations.marketing.supported,
      global_send_enabled: globalSendEnabled,
    };
  });
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
