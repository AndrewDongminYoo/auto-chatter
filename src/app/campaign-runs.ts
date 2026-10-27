import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { CAMPAIGN_PREVIEW_REASONS, evaluateCampaignStart, transaction, utc } from "./campaign-drafts.ts";
import { CampaignStartFailedError, failureCode, logOperation } from "./operations-log.ts";

// Campaign runs (#36, docs/specs/2026-10-27-campaign-runs.md). Starting a run writes one pending delivery row per
// candidate member; nothing here calls a provider, publishes a queue message or writes an outbox row. The delivery
// worker (PR 2) claims the rows and rechecks every condition immediately before each send.

// Due approvals one campaign_start step starts at most, oldest due first. Each start re-evaluates up to 5,000
// snapshot members (the freeze limit) in one statement, so a run of the step stays a handful of statements.
export const CAMPAIGN_START_LIMIT = 5;
export const CAMPAIGN_DELIVERY_STATUSES = [
  "pending",
  "sending",
  "sent",
  "failed",
  "blocked",
  "unknown",
  "cancelled",
] as const;
const COUNT_KEYS = ["original_member_count", "remaining_member_count", ...CAMPAIGN_PREVIEW_REASONS] as const;
// An approval in force is due when it is immediate or its scheduled time has come. The run's transaction rechecks it
// after the locks with the same text.
const DUE = "status='approved' AND (schedule_kind='immediate' OR scheduled_at<=now())";

// Starts one approval's run in its own transaction. The lock order is the approval API's: the workspace, then the
// approval, then the draft, so a start and a reschedule, cancel or draft edit never interleave. The snapshot's
// connections are then locked FOR SHARE in ID order, as a snapshot freeze does, so connection and person deletion
// wait for the start or the start waits for them; no delivery row appears after a deletion commits. Returns false
// when the approval is no longer approved and due, which writes nothing.
async function startOne(client: PoolClient, workspace: string, id: string): Promise<boolean> {
  await client.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspace]);
  const approval = (
    await client.query<{ draft_id: string; draft_version: number; snapshot_id: string }>(
      `SELECT draft_id,draft_version,snapshot_id FROM campaign_approvals WHERE workspace_id=$1 AND id=$2 AND ${DUE}
       FOR UPDATE`,
      [workspace, id],
    )
  ).rows[0];
  if (!approval) return false;
  await client.query("SELECT id FROM campaign_drafts WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [
    workspace,
    approval.draft_id,
  ]);
  await client.query(
    `SELECT id FROM instagram_connections WHERE workspace_id=$1
     AND id IN (SELECT connection_id FROM instagram_segment_snapshot_members WHERE workspace_id=$1 AND snapshot_id=$2)
     ORDER BY id FOR SHARE`,
    [workspace, approval.snapshot_id],
  );
  // An approval in force freezes its draft, so the draft still holds what was approved.
  const evaluated = await evaluateCampaignStart(client, workspace, approval.draft_id);
  if (
    !evaluated ||
    evaluated.draft_version !== approval.draft_version ||
    evaluated.snapshot_id !== approval.snapshot_id
  )
    throw new Error("Campaign approval no longer matches its draft");
  const counts = Object.fromEntries(
    COUNT_KEYS.map((key) =>
      key === "original_member_count" || key === "remaining_member_count"
        ? [key, evaluated[key]]
        : [key, evaluated.counts[key]],
    ),
  );
  const run = (
    await client.query<{ id: string }>(
      `INSERT INTO campaign_runs(workspace_id,approval_id,draft_id,draft_version,snapshot_id,started_at,start_counts)
       VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb) RETURNING id`,
      [
        workspace,
        id,
        approval.draft_id,
        approval.draft_version,
        approval.snapshot_id,
        evaluated.as_of,
        JSON.stringify(counts),
      ],
    )
  ).rows[0]!.id;
  const { candidates } = evaluated;
  if (candidates.length)
    await client.query(
      `INSERT INTO campaign_deliveries(workspace_id,run_id,connection_id,sender_id,recipient_id)
       SELECT $1,$2,member.connection_id,member.sender_id,member.recipient_id
       FROM unnest($3::uuid[],$4::text[],$5::text[]) AS member(connection_id,sender_id,recipient_id)`,
      [
        workspace,
        run,
        candidates.map((row) => row.connection_id),
        candidates.map((row) => row.sender_id),
        candidates.map((row) => row.recipient_id),
      ],
    );
  // The run row is the execution record: the approval keeps its version and its audit gets no row, because the
  // step has no actor.
  await client.query(
    "UPDATE campaign_approvals SET status='executed',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",
    [workspace, id],
  );
  return true;
}

// The campaign_start cron step: starts at most `limit` due approvals. Approvals whose start never failed go first,
// oldest due first (the scheduled time, or the last schedule write of an immediate approval); approvals whose start
// failed follow, least recently failed first. One approval that fails is logged with a fixed code, stamped with
// start_failed_at and the others still start; the step then fails. A failed start rolls back, so without the stamp
// the same `limit` failing approvals would be selected on every run and hold back every approval behind them.
export async function startDueCampaignRuns(
  pool: Pool,
  options: { limit?: number; correlationId?: string } = {},
): Promise<{ started: number; skipped: number; failed: number }> {
  const due = (
    await pool.query<{ workspace_id: string; id: string }>(
      `SELECT workspace_id,id FROM campaign_approvals WHERE ${DUE}
       ORDER BY start_failed_at NULLS FIRST,coalesce(scheduled_at,updated_at),id LIMIT $1`,
      [options.limit ?? CAMPAIGN_START_LIMIT],
    )
  ).rows;
  const result = { started: 0, skipped: 0, failed: 0 };
  for (const { workspace_id, id } of due) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const started = await startOne(client, workspace_id, id);
      await client.query("COMMIT");
      result[started ? "started" : "skipped"]++;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      result.failed++;
      logOperation({ event: "campaign_start_failed", code: failureCode(error), correlation_id: options.correlationId });
      // Outside the rolled-back transaction, so the stamp stays. It changes neither the version nor the due time;
      // when it cannot be written the approval keeps its place and the step still fails.
      await client
        .query(
          "UPDATE campaign_approvals SET start_failed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status='approved'",
          [workspace_id, id],
        )
        .catch(() => undefined);
    } finally {
      client.release();
    }
  }
  if (result.failed) throw new CampaignStartFailedError();
  return result;
}

function invalid(): never {
  throw new ApiError(400, "invalid_campaign_run");
}
export function parseRunCancel(input: unknown) {
  if (!isRecord(input) || Object.keys(input).length !== 1 || !("expected_version" in input)) invalid();
  const value = input.expected_version;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) >= 2147483647) invalid();
  return { expected_version: Number(value) };
}

// The run with its stored start counts and the current number of delivery rows per status. No comment sender or
// DM recipient identifier leaves through this read.
async function detail(client: PoolClient, workspace: string, id: string) {
  const row = (
    await client.query(
      `SELECT r.id,r.approval_id,r.draft_id,r.draft_version,r.snapshot_id,${utc("r.started_at")} AS started_at,
         r.start_counts,r.status,r.version,r.cancelled_by,r.cancelled_at,r.updated_at,
         coalesce((SELECT json_object_agg(grouped.status,grouped.total) FROM (
           SELECT d.status,count(*)::text AS total FROM campaign_deliveries d
           WHERE d.workspace_id=r.workspace_id AND d.run_id=r.id GROUP BY d.status) grouped),'{}') AS delivery_counts
       FROM campaign_runs r WHERE r.workspace_id=$1 AND r.id=$2`,
      [workspace, id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "campaign_run_not_found");
  const { start_counts, delivery_counts, ...rest } = row;
  return {
    ...rest,
    start: {
      as_of: row.started_at as string,
      original_member_count: start_counts.original_member_count as string,
      remaining_member_count: start_counts.remaining_member_count as string,
      counts: Object.fromEntries(CAMPAIGN_PREVIEW_REASONS.map((reason) => [reason, start_counts[reason] as string])),
    },
    delivery_counts: Object.fromEntries(
      CAMPAIGN_DELIVERY_STATUSES.map((status) => [status, (delivery_counts[status] as string | undefined) ?? "0"]),
    ),
    // This PR writes delivery rows but sends nothing; the delivery worker (PR 2) changes this.
    delivery_available: false,
  };
}

export async function getCampaignRun(pool: Pool, user: User, id: string) {
  return transaction(pool, user, false, async (client, workspace) => {
    if (!isUuid(id)) throw new ApiError(404, "campaign_run_not_found");
    return detail(client, workspace, id.toLowerCase());
  });
}

export type RunCancel =
  | {
      error: null;
      run: Awaited<ReturnType<typeof detail>> & { cancelled_delivery_count: string; sending_recalled: false };
    }
  | {
      error: "campaign_run_conflict" | "campaign_run_cancelled" | "campaign_run_completed";
      run: Awaited<ReturnType<typeof detail>>;
    };

// Cancels a running run: the run and every pending delivery row become cancelled in one transaction. A row that is
// already sending cannot be recalled and keeps its status (sending_recalled: false). The lock order is the workspace
// (taken by transaction), the run, then its delivery rows.
export async function cancelCampaignRun(pool: Pool, user: User, id: string, input: unknown): Promise<RunCancel> {
  const request = parseRunCancel(input);
  return transaction(pool, user, true, async (client, workspace): Promise<RunCancel> => {
    if (!isUuid(id)) throw new ApiError(404, "campaign_run_not_found");
    id = id.toLowerCase();
    const current = (
      await client.query<{ status: string; version: number }>(
        "SELECT status,version FROM campaign_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [workspace, id],
      )
    ).rows[0];
    if (!current) throw new ApiError(404, "campaign_run_not_found");
    if (current.status === "cancelled")
      return { error: "campaign_run_cancelled", run: await detail(client, workspace, id) };
    if (current.status === "completed")
      return { error: "campaign_run_completed", run: await detail(client, workspace, id) };
    if (current.version !== request.expected_version)
      return { error: "campaign_run_conflict", run: await detail(client, workspace, id) };
    const cancelled = await client.query(
      `UPDATE campaign_deliveries SET status='cancelled',updated_at=clock_timestamp()
       WHERE workspace_id=$1 AND run_id=$2 AND status='pending'`,
      [workspace, id],
    );
    await client.query(
      `UPDATE campaign_runs SET status='cancelled',cancelled_by=$3,cancelled_at=clock_timestamp(),version=version+1,
         updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [workspace, id, user.id],
    );
    return {
      error: null,
      run: {
        ...(await detail(client, workspace, id)),
        cancelled_delivery_count: String(cancelled.rowCount ?? 0),
        sending_recalled: false,
      },
    };
  });
}
