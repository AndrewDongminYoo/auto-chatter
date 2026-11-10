import type { Pool } from "pg";
import { ApiError, isUuid, type User } from "./auth.ts";
import { CAMPAIGN_PREVIEW_REASONS } from "./campaign-drafts.ts";
import { CAMPAIGN_DELIVERY_STATUSES } from "./campaign-runs.ts";
import { workspaceFor } from "./settings.ts";

// Campaign run reports (#50, docs/specs/2026-11-09-campaign-run-reports.md).
// The start reasons in stored order, plus the reason a monthly campaign send limit (#52) records for a run it kept from
// starting. Every remaining member has exactly one of these eight.
export const CAMPAIGN_REPORT_START_REASONS = [...CAMPAIGN_PREVIEW_REASONS, "plan_limit_exceeded"] as const;
const START_KEYS = ["original_member_count", "remaining_member_count", ...CAMPAIGN_REPORT_START_REASONS] as const;

function dateValue(value: string | null): number {
  if (!value || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, "invalid_report_query");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new ApiError(400, "invalid_report_query");
  return date.getTime();
}

// The query rules of the other reports: exactly the known keys once each, a 1-366 day local period and the zone the
// screen used. `draft_id` is optional.
export function parseCampaignRunReportQuery(query: URLSearchParams) {
  const allowed = new Set(["from", "before", "expected_time_zone", "draft_id"]);
  for (const key of query.keys())
    if (!allowed.has(key) || query.getAll(key).length !== 1) throw new ApiError(400, "invalid_report_query");
  const from = query.get("from");
  const before = query.get("before");
  const days = (dateValue(before) - dateValue(from)) / 86_400_000;
  const zone = query.get("expected_time_zone");
  const draft = query.get("draft_id");
  if (days <= 0 || days > 366 || !zone || zone.length > 100 || (draft !== null && !isUuid(draft)))
    throw new ApiError(400, "invalid_report_query");
  return { from: from!, before: before!, zone, draft };
}

interface ReportRow {
  time_zone: string;
  period_from: Date;
  period_before: Date;
  checked_at: Date;
  draft_exists: boolean;
  run_counts: Record<string, string>;
  start_counts: Record<string, string>;
  delivery_counts: Record<string, string>;
}

// A run the monthly campaign send limit kept from starting is recorded completed with no delivery row; it counts only
// as limit_not_started.
const LIMITED = "c.start_counts ? 'plan_limit_exceeded'";
const startSum = (key: string) => `coalesce(sum(coalesce((c.start_counts->>'${key}')::numeric,0)),0)::text`;

export async function campaignRunReport(pool: Pool, user: User, query: URLSearchParams) {
  const workspace = await workspaceFor(pool, user, "admin");
  const { from, before, zone, draft } = parseCampaignRunReportQuery(query);
  // Run start time selects the cohort. The run and start counts read the cohort alone. Delivery rows are counted per
  // cohort run in a LATERAL aggregate, so a run's many rows cannot multiply the run counts and each run's rows are read
  // through the run_id-leading unique index (campaign_deliveries_member), never by a scan of every workspace's rows.
  // One clock (checked_at) is read once, in context. `read` is the subset of `sent` rows with a stored read of that exact
  // message ID on the same connection (#312), counted inside the same LATERAL; EXISTS keeps several readers to one row.
  // `read_unavailable` is the rest of `sent` on connections without an Instagram Login user ID (Facebook Login or
  // environment-managed), which cannot report reads; a confirmed read stays in `read`, so the two are disjoint.
  const row = (
    await pool.query<ReportRow>(
      `WITH context AS MATERIALIZED (
       SELECT w.time_zone, $2::date::timestamp AT TIME ZONE w.time_zone AS period_from,
         $3::date::timestamp AT TIME ZONE w.time_zone AS period_before, statement_timestamp() AS checked_at,
         ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM campaign_drafts d WHERE d.workspace_id=w.id AND d.id=$5)) AS draft_exists
       FROM workspaces w JOIN workspace_members m ON m.workspace_id=w.id
       WHERE w.id=$1 AND m.user_id=$6 AND m.removed_at IS NULL AND m.role IN ('owner','admin')
     ), cohort AS MATERIALIZED (
       SELECT r.workspace_id,r.id,r.status,r.start_counts FROM campaign_runs r CROSS JOIN context
       WHERE r.workspace_id=$1 AND (r.draft_id=$5 OR $5::uuid IS NULL)
         AND r.started_at>=context.period_from AND r.started_at<context.period_before
         AND context.draft_exists AND context.time_zone=$4
     ), deliveries AS (
       SELECT counted.* FROM cohort c CROSS JOIN LATERAL (SELECT count(*) AS total,
         ${CAMPAIGN_DELIVERY_STATUSES.map((status) => `count(*) FILTER (WHERE d.status='${status}') AS ${status}`).join(",")},
         count(*) FILTER (WHERE d.status='sent' AND EXISTS(SELECT 1 FROM instagram_message_reads mr
           WHERE mr.connection_id=d.connection_id AND mr.message_id=d.provider_message_id)) AS read_confirmed,
         count(*) FILTER (WHERE d.status='sent' AND EXISTS(SELECT 1 FROM instagram_connections ic
           WHERE ic.id=d.connection_id AND ic.workspace_id=d.workspace_id AND ic.instagram_user_id IS NULL)
           AND NOT EXISTS(SELECT 1 FROM instagram_message_reads mr
           WHERE mr.connection_id=d.connection_id AND mr.message_id=d.provider_message_id)) AS read_unavailable_count
         FROM campaign_deliveries d WHERE d.run_id=c.id AND d.workspace_id=c.workspace_id) counted
     )
     SELECT context.*,
       (SELECT json_build_object(
         'total',count(*)::text,
         'running',count(*) FILTER (WHERE c.status='running' AND NOT ${LIMITED})::text,
         'cancelled',count(*) FILTER (WHERE c.status='cancelled' AND NOT ${LIMITED})::text,
         'completed',count(*) FILTER (WHERE c.status='completed' AND NOT ${LIMITED})::text,
         'limit_not_started',count(*) FILTER (WHERE ${LIMITED})::text
       ) FROM cohort c) AS run_counts,
       (SELECT json_build_object(${START_KEYS.map((key) => `'${key}',${startSum(key)}`).join(",")}) FROM cohort c) AS start_counts,
       (SELECT json_build_object(${["total", ...CAMPAIGN_DELIVERY_STATUSES].map((key) => `'${key}',coalesce(sum(${key}),0)::text`).join(",")},
         'read',coalesce(sum(read_confirmed),0)::text,'read_unavailable',coalesce(sum(read_unavailable_count),0)::text)
         FROM deliveries) AS delivery_counts
     FROM context`,
      [workspace, from, before, zone, draft, user.id],
    )
  ).rows[0];
  if (!row) throw new ApiError(403, "role_forbidden");
  if (row.time_zone !== zone) throw new ApiError(409, "report_time_zone_changed");
  if (!row.draft_exists) throw new ApiError(404, "campaign_draft_not_found");
  return {
    from,
    before,
    time_zone: row.time_zone,
    draft_id: draft,
    period_from: row.period_from.toISOString(),
    period_before: row.period_before.toISOString(),
    checked_at: row.checked_at.toISOString(),
    run_counts: row.run_counts,
    start_counts: row.start_counts,
    delivery_counts: row.delivery_counts,
  };
}
