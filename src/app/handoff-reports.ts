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
  counts: Record<string, string>;
}

// Count retained transition events, not current handoff state or inferred consultation outcomes.
// Account and recipient together identify a conversation; no identity-evidence or delivery joins.
export async function handoffReport(pool: Pool, user: User, query: URLSearchParams) {
  const workspace = await workspaceFor(pool, user, "admin");
  const allowed = new Set(["from", "before", "expected_time_zone", "connection_id"]);
  for (const key of query.keys())
    if (!allowed.has(key) || query.getAll(key).length !== 1) throw new ApiError(400, "invalid_report_query");
  const from = query.get("from");
  const before = query.get("before");
  const days = (dateValue(before) - dateValue(from)) / 86_400_000;
  const zone = query.get("expected_time_zone");
  const connection = query.get("connection_id");
  if (days <= 0 || days > 366 || !zone || zone.length > 100 || (connection !== null && !isUuid(connection)))
    throw new ApiError(400, "invalid_report_query");
  const row = (
    await pool.query<ReportRow>(
      `WITH context AS (
       SELECT w.time_zone, $2::date::timestamp AT TIME ZONE w.time_zone AS period_from,
         $3::date::timestamp AT TIME ZONE w.time_zone AS period_before,
         ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM instagram_connections c WHERE c.workspace_id=w.id AND c.id=$5)) AS connection_exists
       FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
       WHERE w.id=$1 AND m.user_id=$6 AND m.removed_at IS NULL AND m.role IN ('owner','admin')
     )
     SELECT context.*,statement_timestamp() AS checked_at,totals.counts
     FROM context CROSS JOIN LATERAL (SELECT json_build_object(
       'total',count(*)::text,
       'started',count(*) FILTER (WHERE r.reason='handoff_started')::text,
       'cleared',count(*) FILTER (WHERE r.reason='handoff_resumed')::text,
       'conversations',count(DISTINCT (r.connection_id,r.recipient_id))::text
     ) AS counts
     FROM instagram_inbox_handoff_events r WHERE r.workspace_id=$1
         AND (r.connection_id=$5 OR $5::uuid IS NULL)
         AND r.created_at>=context.period_from AND r.created_at<context.period_before
         AND context.connection_exists AND context.time_zone=$4
     ) totals`,
      [workspace, from, before, zone, connection, user.id],
    )
  ).rows[0];
  if (!row) throw new ApiError(403, "role_forbidden");
  if (row.time_zone !== zone) throw new ApiError(409, "report_time_zone_changed");
  if (!row.connection_exists) throw new ApiError(404, "connection_not_found");
  return {
    from,
    before,
    time_zone: row.time_zone,
    connection_id: connection,
    period_from: row.period_from.toISOString(),
    period_before: row.period_before.toISOString(),
    checked_at: row.checked_at.toISOString(),
    counts: row.counts,
  };
}
