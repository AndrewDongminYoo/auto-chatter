import type { Pool } from "pg";
import type { User } from "./auth.ts";
import { logOperation, type OperationStep } from "./operations-log.ts";
import { workspaceFor } from "./settings.ts";

// Alert thresholds are service policy (#59, docs/specs/2026-10-01-operations-health.md).
export const ALERT_THRESHOLDS = {
  oldest_pending_minutes: 15,
  sending_dwell_minutes: 10,
  token_expiry_days: 7,
  cron_stale_minutes: 5,
} as const;

export const ALERTS = ["oldest_pending", "sending_dwell", "unknown_outcome", "token_expiring", "cron_stale"] as const;
export type AlertName = (typeof ALERTS)[number];

export interface ConnectionMetrics {
  id: string;
  username: string | null;
  active: boolean;
  send_enabled: boolean;
  send_paused_until: Date | null;
  // Seconds since the oldest reply that the wake would queue became due; this is the queue latency.
  oldest_due_pending_seconds: number | null;
  // Seconds since the oldest reply still in 'sending' was claimed; this is the outbox dwell.
  longest_sending_seconds: number | null;
  unknown_24h: number;
  failed_24h: number;
  blocked_24h: number;
  token_expires_in_seconds: number | null;
}

// Computed on read; there is no time-series store. The due predicates are those of wakeDueReplies in
// src/cloudflare/index.ts, so held work (contact pause, connection pause, sending off, no valid token) is not
// counted as waiting. The 24-hour window uses the last claim time, or the creation or confirmation time of a
// row that was never claimed, because the rows have no terminal timestamp.
const METRICS_SQL = `
WITH metrics AS (
  SELECT c.id::text AS id,c.username,c.active,c.send_enabled,c.send_paused_until,
    CASE WHEN c.access_token_encrypted IS NOT NULL THEN floor(extract(epoch FROM c.token_expires_at-now()))::int END
      AS token_expires_in_seconds,
    CASE WHEN c.send_paused_until IS NULL OR c.send_paused_until<=now() THEN least(
      CASE WHEN c.send_enabled AND c.access_token_encrypted IS NOT NULL AND c.token_expires_at>now() THEN least(
        (SELECT min(greatest(reply.next_attempt_at,c.send_paused_until)) FROM private_reply_outbox reply
         WHERE reply.connection_id=c.id AND reply.status='pending' AND reply.next_attempt_at<=now()
           AND NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
             AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND (automation.paused OR automation.handoff_paused))),
        (SELECT min(greatest(flow.next_attempt_at,c.send_paused_until)) FROM instagram_follow_conversations flow
         JOIN private_reply_outbox reply ON reply.id=flow.reply_id
         WHERE flow.connection_id=c.id AND flow.status='pending' AND flow.next_attempt_at<=now()
           AND NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
             AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND (automation.paused OR automation.handoff_paused))))
      END,
      (SELECT min(greatest(manual.next_attempt_at,c.send_paused_until)) FROM instagram_manual_replies manual
       WHERE manual.connection_id=c.id AND manual.status='pending' AND manual.next_attempt_at<=now()
         AND NOT EXISTS(SELECT 1 FROM instagram_manual_replies earlier WHERE earlier.workspace_id=manual.workspace_id
           AND earlier.connection_id=manual.connection_id AND earlier.recipient_id=manual.recipient_id
           AND (earlier.created_at,earlier.id)<(manual.created_at,manual.id)
           AND (earlier.status IN ('pending','sending') OR (earlier.status='unknown' AND earlier.resolved_at IS NULL))))
    ) END AS oldest_due_at,
    (SELECT min(sending.attempt_started_at) FROM (
       SELECT attempt_started_at FROM private_reply_outbox WHERE connection_id=c.id AND status='sending'
       UNION ALL SELECT attempt_started_at FROM instagram_follow_conversations WHERE connection_id=c.id AND status='sending'
       UNION ALL SELECT attempt_started_at FROM instagram_manual_replies WHERE connection_id=c.id AND status='sending'
     ) sending) AS oldest_sending_at,
    outcomes.unknown_24h,outcomes.failed_24h,outcomes.blocked_24h
  FROM instagram_connections c
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE outcome.status='unknown')::int AS unknown_24h,
      count(*) FILTER (WHERE outcome.status='failed')::int AS failed_24h,
      count(*) FILTER (WHERE outcome.status='blocked')::int AS blocked_24h
    FROM (
      SELECT status FROM private_reply_outbox WHERE connection_id=c.id AND status IN ('unknown','failed','blocked')
        AND coalesce(attempt_started_at,created_at)>now()-interval '24 hours'
      UNION ALL SELECT status FROM instagram_follow_conversations WHERE connection_id=c.id AND status IN ('unknown','failed','blocked')
        AND coalesce(attempt_started_at,confirmed_at)>now()-interval '24 hours'
      UNION ALL SELECT status FROM instagram_manual_replies WHERE connection_id=c.id AND status IN ('unknown','failed')
        AND (status<>'unknown' OR resolved_at IS NULL) AND coalesce(attempt_started_at,created_at)>now()-interval '24 hours'
    ) outcome
  ) outcomes
  WHERE $1::uuid IS NULL OR c.workspace_id=$1
)
SELECT id,username,active,send_enabled,
  CASE WHEN send_paused_until>now() THEN send_paused_until END AS send_paused_until,
  floor(extract(epoch FROM now()-oldest_due_at))::int AS oldest_due_pending_seconds,
  floor(extract(epoch FROM now()-oldest_sending_at))::int AS longest_sending_seconds,
  unknown_24h,failed_24h,blocked_24h,token_expires_in_seconds
FROM metrics ORDER BY username NULLS LAST,id`;

export async function connectionMetrics(pool: Pool, workspaceId: string | null): Promise<ConnectionMetrics[]> {
  return (await pool.query<ConnectionMetrics>(METRICS_SQL, [workspaceId])).rows;
}

// The alerts one connection raises. Waiting replies are expected while global sending is off, so the
// oldest-pending alert is suppressed then.
export function connectionAlerts(metrics: ConnectionMetrics, globalSendEnabled: boolean): AlertName[] {
  const alerts: AlertName[] = [];
  if (
    globalSendEnabled &&
    metrics.oldest_due_pending_seconds !== null &&
    metrics.oldest_due_pending_seconds > ALERT_THRESHOLDS.oldest_pending_minutes * 60
  )
    alerts.push("oldest_pending");
  if (
    metrics.longest_sending_seconds !== null &&
    metrics.longest_sending_seconds > ALERT_THRESHOLDS.sending_dwell_minutes * 60
  )
    alerts.push("sending_dwell");
  if (metrics.unknown_24h > 0) alerts.push("unknown_outcome");
  if (
    metrics.active &&
    metrics.token_expires_in_seconds !== null &&
    metrics.token_expires_in_seconds < ALERT_THRESHOLDS.token_expiry_days * 86_400
  )
    alerts.push("token_expiring");
  return alerts;
}

const CRON_STATUS_SQL = `SELECT step.last_success_at,
    step.last_success_at IS NULL OR step.last_success_at<now()-make_interval(mins=>${ALERT_THRESHOLDS.cron_stale_minutes}) AS stale
  FROM (SELECT NULL::int AS anchor) anchor LEFT JOIN scheduled_steps step ON step.name='cron'`;

async function cronStatus(pool: Pool): Promise<{ last_success_at: Date | null; stale: boolean }> {
  return (await pool.query<{ last_success_at: Date | null; stale: boolean }>(CRON_STATUS_SQL)).rows[0]!;
}

// Records one cron step outcome; name 'cron' is a run in which every step that ran succeeded, alerts included.
export async function recordStep(pool: Pool, name: OperationStep | "cron", failure: string | null): Promise<void> {
  if (failure === null)
    await pool.query(
      `INSERT INTO scheduled_steps(name,last_success_at) VALUES($1,now())
       ON CONFLICT(name) DO UPDATE SET last_success_at=now()`,
      [name],
    );
  else
    await pool.query(
      `INSERT INTO scheduled_steps(name,last_failure_at,failure_code) VALUES($1,now(),$2)
       ON CONFLICT(name) DO UPDATE SET last_failure_at=now(),failure_code=$2`,
      [name, failure],
    );
}

export interface StepOutcome {
  name: OperationStep | "cron";
  failure: string | null;
}

// Records several outcomes in one statement, each with recordStep's effect on its own row: a success sets only
// last_success_at, a failure only last_failure_at and failure_code. A name may appear only once. The rows are
// written in name order, so two overlapping runs lock them in the same order.
export async function recordSteps(pool: Pool, outcomes: readonly StepOutcome[]): Promise<void> {
  if (outcomes.length === 0) return;
  await pool.query(
    `INSERT INTO scheduled_steps(name,last_success_at,last_failure_at,failure_code)
     SELECT outcome.name,CASE WHEN outcome.failure IS NULL THEN now() END,
       CASE WHEN outcome.failure IS NOT NULL THEN now() END,outcome.failure
     FROM unnest($1::text[],$2::text[]) AS outcome(name,failure) ORDER BY outcome.name
     ON CONFLICT(name) DO UPDATE SET
       last_success_at=CASE WHEN excluded.failure_code IS NULL THEN now() ELSE scheduled_steps.last_success_at END,
       last_failure_at=CASE WHEN excluded.failure_code IS NULL THEN scheduled_steps.last_failure_at ELSE now() END,
       failure_code=coalesce(excluded.failure_code,scheduled_steps.failure_code)`,
    [outcomes.map((outcome) => outcome.name), outcomes.map((outcome) => outcome.failure)],
  );
}

// Every unknown outcome ever stored, resolved manual replies included, so a resolution cannot hide a new
// unknown; only data deletion lowers it. The stored count is read in the same statement, so the two come
// from one snapshot.
const UNKNOWN_TOTAL_SQL = `SELECT (SELECT count(*) FROM private_reply_outbox WHERE status='unknown')
  +(SELECT count(*) FROM instagram_follow_conversations WHERE status='unknown')
  +(SELECT count(*) FROM instagram_manual_replies WHERE status='unknown') AS total,
  (SELECT alert_seen_count FROM scheduled_steps WHERE name='alert_unknown_outcome') AS seen`;

// Everything one alert evaluation reads, in one statement and so from one snapshot: every connection's metrics
// (as JSON, so a database without connections still returns the row), whether the 'cron' row is stale, the
// unknown total with its stored count, and which alert rows are on. read_at is now(), the start of this
// statement's own transaction, which comes before the statement takes its snapshot; clock_timestamp() would
// be read after it. It stays text because a JavaScript Date would drop the microseconds and could precede a
// transition made after it.
const ALERT_INPUTS_SQL = `SELECT now()::text AS read_at,
  (SELECT coalesce(json_agg(metric_row),'[]'::json) FROM (${METRICS_SQL}) metric_row) AS metrics,
  (SELECT cron_row.stale FROM (${CRON_STATUS_SQL}) cron_row) AS cron_stale,
  unknown_row.total,unknown_row.seen,
  ARRAY(SELECT name FROM scheduled_steps WHERE name=ANY($2::text[]) AND alert_active) AS active_alerts
FROM (${UNKNOWN_TOTAL_SQL}) unknown_row`;

interface AlertInputs {
  read_at: string;
  metrics: ConnectionMetrics[];
  cron_stale: boolean;
  total: string;
  seen: string | null;
  active_alerts: string[];
}

// Compares the service-wide alerts with the stored state and logs each start or clear once, and each new
// unknown outcome while alert_unknown_outcome is already on. An alert whose stored state already matches is
// not written, so a run with no change issues only the read. The conditional writes make a transition visible
// to exactly one of two overlapping cron runs. A start or clear also applies only to state that changed before
// this run began reading, so a run that read older metrics cannot undo a transition a newer run made; it leaves
// that alert to the next run. The seen count changes only from the value read with the total, so a run that
// read an older count cannot overwrite a newer one. runSucceeded says every earlier step of the calling cron
// run succeeded: that run records the 'cron' row after this evaluation, so it is not stale.
export async function evaluateAlerts(
  pool: Pool,
  globalSendEnabled: boolean,
  correlationId: string,
  runSucceeded = false,
): Promise<void> {
  const inputs = (await pool.query<AlertInputs>(ALERT_INPUTS_SQL, [null, ALERTS.map((alert) => `alert_${alert}`)]))
    .rows[0]!;
  const readAt = inputs.read_at;
  const active = new Set<AlertName>();
  for (const metrics of inputs.metrics)
    for (const alert of connectionAlerts(metrics, globalSendEnabled)) active.add(alert);
  if (!runSucceeded && inputs.cron_stale) active.add("cron_stale");
  const unknown = { total: inputs.total, seen: inputs.seen };
  const storedActive = new Set(inputs.active_alerts);
  for (const alert of ALERTS) {
    const name = `alert_${alert}`;
    const seenCount = alert === "unknown_outcome" ? unknown.total : null;
    if (active.has(alert)) {
      const started = storedActive.has(name)
        ? null
        : await pool.query(
            `INSERT INTO scheduled_steps(name,alert_active,alert_changed_at,alert_seen_count) VALUES($1,true,now(),$2)
             ON CONFLICT(name) DO UPDATE SET alert_active=true,alert_changed_at=now(),alert_seen_count=$2
             WHERE NOT scheduled_steps.alert_active
               AND (scheduled_steps.alert_changed_at IS NULL OR scheduled_steps.alert_changed_at<$3::timestamptz)
             RETURNING 1`,
            [name, seenCount, readAt],
          );
      if (started?.rowCount === 1)
        logOperation({ event: "alert_started", code: name, correlation_id: correlationId }, "warn");
      else if (seenCount !== null && seenCount !== unknown.seen) {
        // Raised or lowered (data deletion) only if no other run changed it since the read.
        const changed = await pool.query(
          "UPDATE scheduled_steps SET alert_seen_count=$2 WHERE name=$1 AND alert_active AND alert_seen_count IS NOT DISTINCT FROM $3::bigint RETURNING 1",
          [name, seenCount, unknown.seen],
        );
        if (changed.rowCount === 1 && unknown.seen !== null && BigInt(seenCount) > BigInt(unknown.seen))
          logOperation({ event: "alert_new_occurrence", code: name, correlation_id: correlationId }, "warn");
      }
    } else if (storedActive.has(name)) {
      const cleared = await pool.query(
        "UPDATE scheduled_steps SET alert_active=false,alert_changed_at=now() WHERE name=$1 AND alert_active AND alert_changed_at<$2::timestamptz RETURNING 1",
        [name, readAt],
      );
      if (cleared.rowCount === 1)
        logOperation({ event: "alert_cleared", code: name, correlation_id: correlationId }, "info");
    }
  }
}

// GET /api/workspace/health: admins see their workspace's delivery metrics and alerts. The response holds
// counts, ages and times only; no message text, sender or recipient IDs, emails or tokens.
export async function operationsHealth(pool: Pool, user: User, globalSendEnabled: boolean) {
  const workspaceId = await workspaceFor(pool, user, "admin");
  const [metrics, cron] = await Promise.all([connectionMetrics(pool, workspaceId), cronStatus(pool)]);
  return {
    checked_at: new Date().toISOString(),
    global_send_enabled: globalSendEnabled,
    thresholds: ALERT_THRESHOLDS,
    last_cron_success_at: cron.last_success_at?.toISOString() ?? null,
    alerts: cron.stale ? ["cron_stale"] : [],
    connections: metrics.map(({ token_expires_in_seconds, send_paused_until, ...connection }) => ({
      ...connection,
      send_paused_until: send_paused_until?.toISOString() ?? null,
      token_expires_in_days: token_expires_in_seconds === null ? null : Math.floor(token_expires_in_seconds / 86_400),
      alerts: connectionAlerts({ ...connection, send_paused_until, token_expires_in_seconds }, globalSendEnabled),
    })),
  };
}
