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
  reply_wait_counts: Record<string, string>;
  groups: unknown[] | null;
}

const GROUP_BY = new Set(["day", "connection", "flow"]);

// The three partitions over the cohort CTE's columns, for the whole cohort and for each group. `read` in reply_counts
// is a subset of `sent`, not a member of the partition.
const COUNTS = `json_build_object(
       'total',count(*)::text,
       'delivering',count(*) FILTER (WHERE status='delivering')::text,
       'ended',count(*) FILTER (WHERE status='ended')::text,
       'skipped',count(*) FILTER (WHERE status='skipped')::text,
       'failed',count(*) FILTER (WHERE status='failed')::text,
       'waiting',count(*) FILTER (WHERE status='waiting')::text,
       'awaiting_reply',count(*) FILTER (WHERE status='awaiting_reply')::text,
       'cancelled',count(*) FILTER (WHERE status='cancelled')::text
     ) AS run_counts, json_build_object(
       'absent',count(*) FILTER (WHERE absent)::text,
       'pending',count(*) FILTER (WHERE delivery='pending')::text,
       'sending',count(*) FILTER (WHERE delivery='sending')::text,
       'sent',count(*) FILTER (WHERE delivery='sent')::text,
       'read',count(*) FILTER (WHERE read_confirmed)::text,
       'blocked',count(*) FILTER (WHERE delivery='blocked')::text,
       'failed',count(*) FILTER (WHERE delivery='failed')::text,
       'unknown',count(*) FILTER (WHERE delivery='unknown')::text
     ) AS reply_counts, json_build_object(
       'reached',count(*) FILTER (WHERE reached)::text,
       'replied',count(*) FILTER (WHERE replied)::text,
       'not_replied',count(*) FILTER (WHERE reached AND NOT replied)::text
     ) AS reply_wait_counts`;

export async function flowRunReport(pool: Pool, user: User, query: URLSearchParams) {
  const workspace = await workspaceFor(pool, user, "admin");
  const allowed = new Set(["from", "before", "expected_time_zone", "connection_id", "flow_id", "group_by"]);
  for (const key of query.keys())
    if (!allowed.has(key) || query.getAll(key).length !== 1) throw new ApiError(400, "invalid_report_query");
  const from = query.get("from");
  const before = query.get("before");
  const days = (dateValue(before) - dateValue(from)) / 86_400_000;
  const zone = query.get("expected_time_zone");
  const connection = query.get("connection_id");
  const flow = query.get("flow_id");
  const groupBy = query.get("group_by");
  if (
    days <= 0 ||
    days > 366 ||
    !zone ||
    zone.length > 100 ||
    (connection !== null && !isUuid(connection)) ||
    (flow !== null && !isUuid(flow)) ||
    (groupBy !== null && !GROUP_BY.has(groupBy))
  )
    throw new ApiError(400, "invalid_report_query");
  // Run creation selects the cohort. The unique outbox and DM delivery flow_run_id permit one left join each (a run
  // has at most one of them: a comment run's reply or a DM-started run's first message, #33);
  // step and webhook histories must not multiply counts or imply delivery success.
  // A run reached a reply wait when it is awaiting a reply, a DM ended its wait, or it queued a private reply and
  // is no longer delivering: only a reply wait may follow a message, and a run that queued one without a wait
  // stays delivering. A wait leaves no step until it resumes, and a cancel at reply or timeout records none.
  // A first message counts as read only when a stored read names its exact message ID on the same connection (#312);
  // EXISTS keeps several readers of one message to one run, and no later message's read marks it.
  const row = (
    await pool.query<ReportRow>(
      `WITH context AS (
       SELECT w.time_zone, $2::date::timestamp AT TIME ZONE w.time_zone AS period_from,
         $3::date::timestamp AT TIME ZONE w.time_zone AS period_before,
         ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM instagram_connections c WHERE c.workspace_id=w.id AND c.id=$5)) AS connection_exists,
         ($7::uuid IS NULL OR EXISTS(SELECT 1 FROM flows f WHERE f.workspace_id=w.id AND f.id=$7)) AS flow_exists,
         statement_timestamp() AS checked_at
       FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
       WHERE w.id=$1 AND m.user_id=$6 AND m.removed_at IS NULL AND m.role IN ('owner','admin')
     ), cohort AS (
       SELECT CASE $8::text WHEN 'day' THEN to_char(r.created_at AT TIME ZONE context.time_zone,'YYYY-MM-DD')
           WHEN 'connection' THEN r.connection_id::text WHEN 'flow' THEN r.flow_id::text END AS group_key,
         r.status, coalesce(reply.status,dm.status) AS delivery, reply.id IS NULL AND dm.id IS NULL AS absent,
         r.status='awaiting_reply' OR r.reply_message_id IS NOT NULL OR (reply.id IS NOT NULL AND r.status<>'delivering') AS reached,
         r.reply_message_id IS NOT NULL AS replied,
         (reply.status='sent' AND EXISTS(SELECT 1 FROM instagram_message_reads mr
             WHERE mr.connection_id=reply.connection_id AND mr.message_id=reply.provider_message_id))
           OR (dm.status='sent' AND EXISTS(SELECT 1 FROM instagram_message_reads mr
             WHERE mr.connection_id=dm.connection_id AND mr.message_id=dm.provider_message_id)) AS read_confirmed
       FROM context JOIN flow_runs r ON r.workspace_id=$1 AND (r.connection_id=$5 OR $5::uuid IS NULL)
         AND (r.flow_id=$7 OR $7::uuid IS NULL)
         AND r.created_at>=context.period_from AND r.created_at<context.period_before
       LEFT JOIN private_reply_outbox reply
         ON reply.flow_run_id=r.id AND reply.workspace_id=r.workspace_id AND reply.connection_id=r.connection_id
       LEFT JOIN flow_dm_deliveries dm
         ON dm.flow_run_id=r.id AND dm.workspace_id=r.workspace_id AND dm.connection_id=r.connection_id
       WHERE context.connection_exists AND context.flow_exists AND context.time_zone=$4
     )
     SELECT context.*,totals.run_counts,totals.reply_counts,totals.reply_wait_counts,
       CASE WHEN $8::text IS NOT NULL THEN (SELECT coalesce(json_agg(json_build_object('key',g.group_key,
           'run_counts',g.run_counts,'reply_counts',g.reply_counts,'reply_wait_counts',g.reply_wait_counts)
           ORDER BY g.group_key COLLATE "C"),'[]'::json)
         FROM (SELECT group_key,${COUNTS} FROM cohort GROUP BY group_key) g) END AS groups
     FROM context CROSS JOIN LATERAL (SELECT ${COUNTS} FROM cohort) totals`,
      [workspace, from, before, zone, connection, user.id, flow, groupBy],
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
    group_by: groupBy,
    period_from: row.period_from.toISOString(),
    period_before: row.period_before.toISOString(),
    checked_at: row.checked_at.toISOString(),
    run_counts: row.run_counts,
    reply_counts: row.reply_counts,
    reply_wait_counts: row.reply_wait_counts,
    ...(groupBy === null ? {} : { groups: row.groups }),
  };
}
