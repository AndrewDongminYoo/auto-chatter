import type { PoolClient } from "pg";
import { ApiError } from "./auth.ts";

// The plan catalog (#52, docs/specs/2026-10-12-plan-entitlements.md). The workspaces_plan CHECK in
// db/schema.sql and migration 045 lists the same keys; plans.db.test.ts compares them.
// Seats follow ManyChat's 2026 user seats; connections count connected Instagram accounts. campaign_sends_per_month
// counts campaign delivery rows per calendar month in the workspace time zone; free approves no campaign.
export const PLANS = {
  free: { seats: 1, connections: 1, campaign_sends_per_month: 0 },
  essential: { seats: 2, connections: 2, campaign_sends_per_month: 1000 },
  pro: { seats: 3, connections: 3, campaign_sends_per_month: 5000 },
  business: { seats: 5, connections: 5, campaign_sends_per_month: 20000 },
  advanced: { seats: 10, connections: 10, campaign_sends_per_month: 50000 },
} as const satisfies Record<string, { seats: number; connections: number; campaign_sends_per_month: number }>;

export type PlanKey = keyof typeof PLANS;
export type PlanLimits = (typeof PLANS)[PlanKey];

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && Object.hasOwn(PLANS, value);
}

export function planLimits(plan: unknown): PlanLimits {
  if (!isPlanKey(plan)) throw new Error("Unknown workspace plan");
  return PLANS[plan];
}

type Db = Pick<PoolClient, "query">;

// A seat is an active member (owner included) or an open invite: not accepted, not revoked and not expired.
// A connected account is a row that holds a token or is active; a disconnect clears both.
const USAGE_SQL = `SELECT w.plan,
  (SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id=w.id AND m.removed_at IS NULL) AS members,
  (SELECT count(*)::int FROM workspace_invites i WHERE i.workspace_id=w.id AND i.accepted_at IS NULL
     AND i.revoked_at IS NULL AND i.expires_at>now()) AS open_invites,
  (SELECT count(*)::int FROM instagram_connections c WHERE c.workspace_id=w.id
     AND (c.active OR c.access_token_encrypted IS NOT NULL) AND c.account_id IS DISTINCT FROM $2) AS connections
FROM workspaces w WHERE w.id=$1`;

interface Usage {
  plan: PlanKey;
  members: number;
  open_invites: number;
  connections: number;
}

async function usage(db: Db, workspace: string, excludedAccount: string | null = null): Promise<Usage> {
  const row = (await db.query<Usage>(USAGE_SQL, [workspace, excludedAccount])).rows[0];
  if (!row) throw new ApiError(403, "workspace_required");
  return row;
}

// The plan, its limits and the current usage, as the dashboard shows them to every role.
export async function workspaceEntitlements(db: Db, workspace: string) {
  const current = await usage(db, workspace);
  const campaign = await campaignSendAllowance(db, workspace, null);
  return {
    plan: current.plan,
    limits: planLimits(current.plan),
    usage: {
      seats: current.members + current.open_invites,
      connections: current.connections,
      campaign_sends: campaign.used,
    },
  };
}

// The calendar month that holds an approval's due time, in the workspace's current time zone. A due time is never
// earlier than the reference time: an immediate approval, or one whose scheduled time passed while sending was off,
// starts in that month or later. `due` is a timestamptz expression that may be NULL (immediate); `zone` is the time
// zone expression. The reference defaults to statement_timestamp(), not now(): every caller runs its statement after
// taking the workspace lock, and now() is the transaction start, which can fall in the previous month when the lock
// wait crosses midnight in the workspace time zone.
export const campaignDueMonthSql = (due: string, zone: string, reference = "statement_timestamp()") =>
  `date_trunc('month',greatest(coalesce(${due},${reference}),${reference}) AT TIME ZONE ${zone})`;

// The allowance's reference time, read once in the `reference` CTE: the caller's post-lock clock when it passes one (a
// run start passes its as_of), otherwise the allowance statement's own start, which runs after the workspace lock.
// One statement_timestamp() per statement, like the other evaluation clocks, so a test can pin it.
const ALLOWANCE_REFERENCE = "(SELECT at FROM reference)";

// The monthly campaign send count (#52). `used` counts the delivery rows of runs started in the month, except rows
// cancelled before any provider call; `reserved` adds the stored candidate counts of the approvals in force due in
// that month, except `excludedApproval`. The month and both counts use the workspace's current time zone.
const ALLOWANCE_SQL = `WITH reference AS MATERIALIZED (SELECT coalesce($4::timestamptz,statement_timestamp()) AS at),
 bounds AS MATERIALIZED (
   SELECT w.plan,w.time_zone,month.start,to_char(month.start,'YYYY-MM') AS month,
     month.start AT TIME ZONE w.time_zone AS starts,(month.start+interval '1 month') AT TIME ZONE w.time_zone AS ends
   FROM workspaces w CROSS JOIN LATERAL (SELECT ${campaignDueMonthSql("$2::timestamptz", "w.time_zone", ALLOWANCE_REFERENCE)} AS start) month
   WHERE w.id=$1)
 SELECT b.plan,b.month,
   (SELECT count(*) FROM campaign_runs r JOIN campaign_deliveries d ON d.workspace_id=r.workspace_id AND d.run_id=r.id
    WHERE r.workspace_id=$1 AND r.started_at>=b.starts AND r.started_at<b.ends
      AND NOT (d.status='cancelled' AND d.provider_called_at IS NULL))::text AS used,
   (SELECT coalesce(sum((a.preview_counts->>'candidate')::bigint),0) FROM campaign_approvals a
    WHERE a.workspace_id=$1 AND a.status='approved' AND a.id IS DISTINCT FROM $3::uuid
      AND ${campaignDueMonthSql("a.scheduled_at", "b.time_zone", ALLOWANCE_REFERENCE)}=b.start)::text AS reserved
 FROM bounds b`;

export interface CampaignSendAllowance {
  month: string;
  limit: number;
  used: number;
  reserved: number;
}

// The allowance of the month that holds `due` (null: the reference time). The approval and run start callers hold the
// workspace row FOR UPDATE, so two writers never count the same month at once. `reference` is the post-lock clock that
// places immediate and past-due approvals in a month; a run start passes its as_of so the run, its used rows and the
// other approvals' reservations fall in one month.
export async function campaignSendAllowance(
  db: Db,
  workspace: string,
  due: string | null,
  excludedApproval: string | null = null,
  reference: string | null = null,
): Promise<CampaignSendAllowance> {
  const row = (
    await db.query<{ plan: PlanKey; month: string; used: string; reserved: string }>(ALLOWANCE_SQL, [
      workspace,
      due,
      excludedApproval,
      reference,
    ])
  ).rows[0];
  if (!row) throw new ApiError(403, "workspace_required");
  return {
    month: row.month,
    limit: planLimits(row.plan).campaign_sends_per_month,
    used: Number(row.used),
    reserved: Number(row.reserved),
  };
}

// An approval of `requested` candidates fits when this month's rows, the other approvals due in the month and the
// request stay within the limit. A limit of 0 refuses every approval, a zero-candidate one included.
export function campaignSendsFit(allowance: CampaignSendAllowance, requested: number): boolean {
  return allowance.limit > 0 && allowance.used + allowance.reserved + requested <= allowance.limit;
}

// The API shape: decimal strings, like the preview counts. remaining is never below zero.
export function campaignAllowanceBody(allowance: CampaignSendAllowance) {
  return {
    month: allowance.month,
    limit: String(allowance.limit),
    used: String(allowance.used),
    reserved: String(allowance.reserved),
    remaining: String(Math.max(0, allowance.limit - allowance.used - allowance.reserved)),
  };
}

// Creating an invite takes a seat. The caller holds the workspace row FOR UPDATE.
export async function requireInviteSeat(db: Db, workspace: string): Promise<void> {
  const current = await usage(db, workspace);
  if (current.members + current.open_invites >= planLimits(current.plan).seats)
    throw new ApiError(409, "seat_limit_reached");
}

// Accepting turns a counted invite into a member, but a downgrade or invites from before the limit can leave
// more open invites than seats. The caller holds the workspace row FOR NO KEY UPDATE or stronger.
export async function requireMemberSeat(db: Db, workspace: string): Promise<void> {
  const current = await usage(db, workspace);
  if (current.members >= planLimits(current.plan).seats) throw new ApiError(409, "seat_limit_reached");
}

// Connecting an account that is not connected in this workspace takes a connection; re-authorizing a connected
// one does not. The caller holds the workspace row FOR NO KEY UPDATE or stronger.
export async function requireConnectionSlot(db: Db, workspace: string, accountId: string): Promise<void> {
  const connected = await db.query(
    `SELECT 1 FROM instagram_connections WHERE workspace_id=$1 AND account_id=$2
     AND (active OR access_token_encrypted IS NOT NULL)`,
    [workspace, accountId],
  );
  if (connected.rowCount) return;
  const current = await usage(db, workspace, accountId);
  if (current.connections >= planLimits(current.plan).connections) throw new ApiError(409, "connection_limit_reached");
}
