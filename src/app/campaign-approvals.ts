import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import {
  CAMPAIGN_PREVIEW_REASONS,
  campaignDraftDetail,
  evaluateCampaignPreview,
  transaction,
  utc,
} from "./campaign-drafts.ts";
import { dueLocalSql, localDueSql } from "./inbox-reminders.ts";
import { SCHEDULE_MIN_AHEAD, scheduleLocal } from "./manual-replies.ts";

// Execution approvals record what an administrator approved and when it should run. Nothing here queues, schedules
// or sends a message; the campaign_start step (campaign-runs.ts, #36) starts one run per due approval.
const LIMIT = 100;
// The inbox scheduled-reply bounds (docs/specs/2026-10-16-inbox-scheduled-replies.md) are at least one minute ahead
// and before that recipient's reply window ends. An approval has no single recipient, so only the fixed lower bound
// applies here; the per-recipient window shows only as the preview's reply_window_closed and is #36's to apply.
const COUNT_KEYS = ["original_member_count", "remaining_member_count", ...CAMPAIGN_PREVIEW_REASONS] as const;

function invalid(): never {
  throw new ApiError(400, "invalid_campaign_approval");
}
function fields(input: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(input) || Object.keys(input).length !== keys.length || !keys.every((key) => key in input)) invalid();
  return input;
}
function version(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) >= 2147483647) invalid();
  return Number(value);
}
function schedule(input: Record<string, unknown>) {
  const zone = input.expected_time_zone;
  if (typeof zone !== "string" || !zone || zone.length > 100) invalid();
  return {
    schedule_local:
      input.schedule_local === null ? null : scheduleLocal(input.schedule_local, "invalid_campaign_approval"),
    expected_time_zone: zone,
  };
}
export function parseApprovalRequest(input: unknown) {
  const body = fields(input, ["id", "expected_version", "schedule_local", "expected_time_zone"]);
  if (!isUuid(body.id)) invalid();
  return { id: body.id.toLowerCase(), expected_version: version(body.expected_version), ...schedule(body) };
}
export function parseScheduleRequest(input: unknown) {
  const body = fields(input, ["expected_version", "schedule_local", "expected_time_zone"]);
  return { expected_version: version(body.expected_version), ...schedule(body) };
}
export function parseCancelRequest(input: unknown) {
  return { expected_version: version(fields(input, ["expected_version"]).expected_version) };
}

const COLUMNS = `a.id,a.draft_id,a.draft_version,a.snapshot_id,a.name,a.schedule_kind,${utc("a.scheduled_at")} AS scheduled_at,
  a.schedule_time_zone,${dueLocalSql("a.scheduled_at", "a.schedule_time_zone")} AS schedule_local,
  ${utc("a.preview_as_of")} AS preview_as_of,a.preview_counts,a.status,a.version,a.approved_by,a.approved_at,
  a.cancelled_by,a.cancelled_at,a.updated_at,
  (SELECT r.id FROM campaign_runs r WHERE r.workspace_id=a.workspace_id AND r.approval_id=a.id) AS run_id,
  (SELECT r.status FROM campaign_runs r WHERE r.workspace_id=a.workspace_id AND r.approval_id=a.id) AS run_status`;
function shape(row: Record<string, any>) {
  const { preview_as_of, preview_counts, body, ...rest } = row;
  return {
    ...rest,
    ...(body === undefined ? {} : { body }),
    preview: {
      as_of: preview_as_of,
      original_member_count: preview_counts.original_member_count,
      remaining_member_count: preview_counts.remaining_member_count,
      counts: Object.fromEntries(CAMPAIGN_PREVIEW_REASONS.map((reason) => [reason, preview_counts[reason]])),
    },
    delivery_available: false,
  };
}
async function detail(client: PoolClient, workspace: string, id: string) {
  const row = (
    await client.query(`SELECT ${COLUMNS},a.body FROM campaign_approvals a WHERE a.workspace_id=$1 AND a.id=$2`, [
      workspace,
      id,
    ])
  ).rows[0];
  if (!row) throw new ApiError(404, "campaign_approval_not_found");
  const events = (
    await client.query(
      `SELECT version,kind,actor_id,schedule_kind,${utc("scheduled_at")} AS scheduled_at,schedule_time_zone,created_at
       FROM campaign_approval_events WHERE workspace_id=$1 AND approval_id=$2 ORDER BY version`,
      [workspace, id],
    )
  ).rows;
  return { ...shape(row), events };
}

// Converts the local time with the workspace's time zone as it is now (the reminders' and scheduled replies' rule),
// and checks the lower bound against one clock read. A later time zone change does not move a stored time.
async function readSchedule(
  client: PoolClient,
  workspace: string,
  request: { schedule_local: string | null; expected_time_zone: string },
) {
  if (request.schedule_local === null) {
    const zone = (await client.query("SELECT time_zone FROM workspaces WHERE id=$1", [workspace])).rows[0]!.time_zone;
    if (zone !== request.expected_time_zone) throw new ApiError(409, "campaign_schedule_timezone_changed");
    return { schedule_kind: "immediate", scheduled_at: null, schedule_time_zone: null };
  }
  const row = (
    await client.query<{ time_zone: string; scheduled_at: string; in_range: boolean }>(
      `WITH schedule_clock AS (SELECT clock_timestamp() AS now)
       SELECT w.time_zone,${utc("converted.scheduled_at")} AS scheduled_at,
         converted.scheduled_at>=schedule_clock.now+interval '${SCHEDULE_MIN_AHEAD}' AS in_range
       FROM workspaces w CROSS JOIN schedule_clock
       CROSS JOIN LATERAL (SELECT ${localDueSql("$2::text", "w.time_zone")} AS scheduled_at) converted
       WHERE w.id=$1`,
      [workspace, request.schedule_local],
    )
  ).rows[0]!;
  if (row.time_zone !== request.expected_time_zone) throw new ApiError(409, "campaign_schedule_timezone_changed");
  if (!row.in_range) throw new ApiError(400, "campaign_schedule_out_of_range");
  return { schedule_kind: "scheduled", scheduled_at: row.scheduled_at, schedule_time_zone: row.time_zone };
}
// The audit row of the version just written, with the schedule in force after the change.
async function insertEvent(client: PoolClient, workspace: string, id: string, kind: string, actor: string) {
  await client.query(
    `INSERT INTO campaign_approval_events(workspace_id,approval_id,version,kind,actor_id,schedule_kind,scheduled_at,schedule_time_zone)
     SELECT workspace_id,id,version,$3,$4,schedule_kind,scheduled_at,schedule_time_zone FROM campaign_approvals
     WHERE workspace_id=$1 AND id=$2`,
    [workspace, id, kind, actor],
  );
}

export async function listCampaignApprovals(pool: Pool, user: User) {
  return transaction(pool, user, false, async (client, workspace) => ({
    approvals: (
      await client.query(
        `SELECT ${COLUMNS} FROM campaign_approvals a WHERE a.workspace_id=$1 ORDER BY a.approved_at DESC,a.id LIMIT $2`,
        [workspace, LIMIT],
      )
    ).rows.map(shape),
  }));
}
export async function getCampaignApproval(pool: Pool, user: User, id: string) {
  return transaction(pool, user, false, async (client, workspace) => {
    if (!isUuid(id)) throw new ApiError(404, "campaign_approval_not_found");
    return detail(client, workspace, id.toLowerCase());
  });
}

// Records the final execution approval of the draft's current version. The workspace lock (taken by transaction)
// and the draft row lock are the ones a draft edit or archive takes, so an approval and an edit never interleave.
export async function approveCampaignDraft(pool: Pool, user: User, draftId: string, input: unknown) {
  const request = parseApprovalRequest(input);
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        request.id,
        draftId.toLowerCase(),
        request.expected_version,
        request.schedule_local,
        request.expected_time_zone,
      ]),
    )
    .digest("hex");
  return transaction(pool, user, true, async (client, workspace) => {
    if (!isUuid(draftId)) throw new ApiError(404, "campaign_draft_not_found");
    const draft = draftId.toLowerCase();
    // A retry of the original request returns the current state, whatever happened since; it never undoes it.
    const existing = (
      await client.query("SELECT create_request_hash FROM campaign_approvals WHERE workspace_id=$1 AND id=$2", [
        workspace,
        request.id,
      ])
    ).rows[0];
    if (existing) {
      if (existing.create_request_hash !== hash) throw new ApiError(409, "campaign_approval_id_conflict");
      return { error: null, approval: await detail(client, workspace, request.id), created: false };
    }
    const current = (
      await client.query(
        "SELECT version,archived,snapshot_id,name,body FROM campaign_drafts WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [workspace, draft],
      )
    ).rows[0];
    if (!current) throw new ApiError(404, "campaign_draft_not_found");
    // A stale or archived draft, or an approval already in force, answers with the current state; nothing is written.
    if (current.archived || current.version !== request.expected_version)
      return { error: "campaign_draft_conflict" as const, draft: await campaignDraftDetail(client, workspace, draft) };
    const active = (
      await client.query(
        "SELECT id FROM campaign_approvals WHERE workspace_id=$1 AND draft_id=$2 AND status='approved'",
        [workspace, draft],
      )
    ).rows[0];
    if (active) return { error: "approval_exists" as const, approval: await detail(client, workspace, active.id) };
    const scheduled = await readSchedule(client, workspace, request);
    // The same evaluation as the preview API, in this transaction and after the draft lock.
    const preview = (await evaluateCampaignPreview(client, workspace, draft))!;
    const counts = Object.fromEntries(
      COUNT_KEYS.map((key) => [
        key,
        key === "original_member_count" || key === "remaining_member_count" ? preview[key] : preview.counts[key],
      ]),
    );
    await client.query(
      `INSERT INTO campaign_approvals(workspace_id,id,draft_id,draft_version,snapshot_id,name,body,schedule_kind,
         scheduled_at,schedule_time_zone,preview_as_of,preview_counts,create_request_hash,approved_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11::timestamptz,$12::jsonb,$13,$14)`,
      [
        workspace,
        request.id,
        draft,
        current.version,
        current.snapshot_id,
        current.name,
        current.body,
        scheduled.schedule_kind,
        scheduled.scheduled_at,
        scheduled.schedule_time_zone,
        preview.as_of,
        JSON.stringify(counts),
        hash,
        user.id,
      ],
    );
    await insertEvent(client, workspace, request.id, "created", user.id);
    return { error: null, approval: await detail(client, workspace, request.id), created: true };
  });
}

export type ApprovalChange =
  | { error: null; approval: Awaited<ReturnType<typeof detail>> }
  | {
      error: "campaign_approval_conflict" | "campaign_approval_cancelled" | "campaign_approval_executed";
      approval: Awaited<ReturnType<typeof detail>>;
    };

// Locks an approval for a change; a cancelled or executed approval or a stale version answers with the current state.
// An executed approval started its run (#36), so its schedule can no longer change and it can no longer be cancelled.
async function lockForChange(client: PoolClient, workspace: string, id: string, expected: number) {
  if (!isUuid(id)) throw new ApiError(404, "campaign_approval_not_found");
  id = id.toLowerCase();
  const row = (
    await client.query("SELECT status,version FROM campaign_approvals WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [
      workspace,
      id,
    ])
  ).rows[0];
  if (!row) throw new ApiError(404, "campaign_approval_not_found");
  if (row.status === "cancelled")
    return { id, error: "campaign_approval_cancelled" as const, approval: await detail(client, workspace, id) };
  if (row.status === "executed")
    return { id, error: "campaign_approval_executed" as const, approval: await detail(client, workspace, id) };
  if (row.version !== expected)
    return { id, error: "campaign_approval_conflict" as const, approval: await detail(client, workspace, id) };
  return { id, error: null };
}

// Changes only the schedule of an approval in force; what was approved stays as recorded.
export async function rescheduleCampaignApproval(
  pool: Pool,
  user: User,
  id: string,
  input: unknown,
): Promise<ApprovalChange> {
  const request = parseScheduleRequest(input);
  return transaction(pool, user, true, async (client, workspace) => {
    const locked = await lockForChange(client, workspace, id, request.expected_version);
    if (locked.error) return { error: locked.error, approval: locked.approval! };
    const scheduled = await readSchedule(client, workspace, request);
    await client.query(
      `UPDATE campaign_approvals SET schedule_kind=$3,scheduled_at=$4::timestamptz,schedule_time_zone=$5,version=version+1,
         updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [workspace, locked.id, scheduled.schedule_kind, scheduled.scheduled_at, scheduled.schedule_time_zone],
    );
    await insertEvent(client, workspace, locked.id, "schedule_changed", user.id);
    return { error: null, approval: await detail(client, workspace, locked.id) };
  });
}

// Cancels an approval in force. A cancelled approval never changes again; approve the draft again instead.
export async function cancelCampaignApproval(
  pool: Pool,
  user: User,
  id: string,
  input: unknown,
): Promise<ApprovalChange> {
  const request = parseCancelRequest(input);
  return transaction(pool, user, true, async (client, workspace) => {
    const locked = await lockForChange(client, workspace, id, request.expected_version);
    if (locked.error) return { error: locked.error, approval: locked.approval! };
    await client.query(
      `UPDATE campaign_approvals SET status='cancelled',cancelled_by=$3,cancelled_at=clock_timestamp(),version=version+1,
         updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [workspace, locked.id, user.id],
    );
    await insertEvent(client, workspace, locked.id, "cancelled", user.id);
    return { error: null, approval: await detail(client, workspace, locked.id) };
  });
}
