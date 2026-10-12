import type { PoolClient } from "pg";
import { ApiError } from "./auth.ts";

// The plan catalog (#52, docs/specs/2026-10-12-plan-entitlements.md). The workspaces_plan CHECK in
// db/schema.sql and migration 045 lists the same keys; plans.db.test.ts compares them.
// Seats follow ManyChat's 2026 user seats; connections count connected Instagram accounts.
export const PLANS = {
  free: { seats: 1, connections: 1 },
  essential: { seats: 2, connections: 2 },
  pro: { seats: 3, connections: 3 },
  business: { seats: 5, connections: 5 },
  advanced: { seats: 10, connections: 10 },
} as const satisfies Record<string, { seats: number; connections: number }>;

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
  return {
    plan: current.plan,
    limits: planLimits(current.plan),
    usage: { seats: current.members + current.open_invites, connections: current.connections },
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
