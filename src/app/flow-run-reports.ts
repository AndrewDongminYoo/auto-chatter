import type { Pool } from "pg";
import { ApiError, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";

function dateValue(value: string | null): number {
  if (!value || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, "invalid_report_query");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new ApiError(400, "invalid_report_query");
  return date.getTime();
}

interface ReportRow {
  time_zone: string;
  period_from: Date;
  period_before: Date;
  checked_at: Date;
  connection_exists: boolean;
  flow_exists: boolean;
  run_counts: Record<string, string>;
  reply_counts: Record<string, string>;
}

export async function flowRunReport(pool: Pool, user: User, query: URLSearchParams) {
  const workspace = await workspaceFor(pool, user, "admin");
  const allowed = new Set(["from", "before", "expected_time_zone", "connection_id", "flow_id"]);
  for (const key of query.keys())
    if (!allowed.has(key) || query.getAll(key).length !== 1) throw new ApiError(400, "invalid_report_query");
  const from = query.get("from");
  const before = query.get("before");
  const days = (dateValue(before) - dateValue(from)) / 86_400_000;
  const zone = query.get("expected_time_zone");
  const connection = query.get("connection_id");
  const flow = query.get("flow_id");
  if (
    days <= 0 ||
    days > 366 ||
    !zone ||
    zone.length > 100 ||
    (connection !== null && !isUuid(connection)) ||
    (flow !== null && !isUuid(flow))
  )
    throw new ApiError(400, "invalid_report_query");
  // Run creation selects the cohort. The unique outbox flow_run_id permits one left join;
  // step and webhook histories must not multiply counts or imply delivery success.
  const row = (
    await pool.query<ReportRow>(
      `WITH context AS (
       SELECT w.time_zone, $2::date::timestamp AT TIME ZONE w.time_zone AS period_from,
         $3::date::timestamp AT TIME ZONE w.time_zone AS period_before,
         ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM instagram_connections c WHERE c.workspace_id=w.id AND c.id=$5)) AS connection_exists,
         ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM flows f WHERE f.workspace_id=w.id AND f.id=$7)) AS flow_exists
       FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
       WHERE w.id=$1 AND m.user_id=$6 AND m.removed_at IS NULL AND m.role IN ('owner','admin')
     )
     SELECT context.*,statement_timestamp() AS checked_at,totals.run_counts,totals.reply_counts
     FROM context CROSS JOIN LATERAL (SELECT json_build_object(
       'total',count(*)::text,
       'delivering',count(*) FILTER (WHERE r.status='delivering')::text,
       'ended',count(*) FILTER (WHERE r.status='ended')::text,
       'skipped',count(*) FILTER (WHERE r.status='skipped')::text,
       'failed',count(*) FILTER (WHERE r.status='failed')::text,
       'waiting',count(*) FILTER (WHERE r.status='waiting')::text,
       'awaiting_reply',count(*) FILTER (WHERE r.status='awaiting_reply')::text,
       'cancelled',count(*) FILTER (WHERE r.status='cancelled')::text
     ) AS run_counts, json_build_object(
       'absent',count(*) FILTER (WHERE reply.id IS NULL)::text,
       'pending',count(*) FILTER (WHERE reply.status='pending')::text,
       'sending',count(*) FILTER (WHERE reply.status='sending')::text,
       'sent',count(*) FILTER (WHERE reply.status='sent')::text,
       'blocked',count(*) FILTER (WHERE reply.status='blocked')::text,
       'failed',count(*) FILTER (WHERE reply.status='failed')::text,
       'unknown',count(*) FILTER (WHERE reply.status='unknown')::text
     ) AS reply_counts
     FROM flow_runs r LEFT JOIN private_reply_outbox reply
       ON reply.flow_run_id=r.id AND reply.workspace_id=r.workspace_id AND reply.connection_id=r.connection_id
     WHERE r.workspace_id=$1 AND (r.connection_id=$5 OR $5::uuid IS NULL) AND (r.flow_id=$7 OR $7::uuid IS NULL)
       AND r.created_at>=context.period_from AND r.created_at<context.period_before
       AND context.connection_exists AND context.flow_exists AND context.time_zone=$4
     ) totals`,
      [workspace, from, before, zone, connection, user.id, flow],
    )
  ).rows[0];
  if (!row) throw new ApiError(403, "role_forbidden");
  if (row.time_zone !== zone) throw new ApiError(409, "report_time_zone_changed");
  if (!row.connection_exists) throw new ApiError(404, "connection_not_found");
  if (!row.flow_exists) throw new ApiError(404, "flow_not_found");
  return {
    from,
    before,
    time_zone: row.time_zone,
    connection_id: connection,
    flow_id: flow,
    period_from: row.period_from.toISOString(),
    period_before: row.period_before.toISOString(),
    checked_at: row.checked_at.toISOString(),
    run_counts: row.run_counts,
    reply_counts: row.reply_counts,
  };
}
