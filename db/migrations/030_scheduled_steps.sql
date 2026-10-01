-- Service-wide operations state (#59). Each scheduled step of the Cloudflare cron keeps its last success,
-- its last failure and a fixed failure code; name 'cron' is a run in which every step that ran succeeded.
-- Each alert (name 'alert_<name>') keeps whether it is active, so a start or clear is logged once.
-- alert_seen_count is the number of unknown outcomes the last evaluation saw (alert_unknown_outcome only), so
-- a new unknown while that alert is already on is logged once more.
-- The table holds no workspace data. Server roles get SELECT/INSERT/UPDATE from deploy/supabase-access.sql.
CREATE TABLE IF NOT EXISTS scheduled_steps (
  name text PRIMARY KEY CHECK(name ~ '^[a-z][a-z0-9_]{0,63}$'),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_code text CHECK(failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  alert_active boolean NOT NULL DEFAULT false,
  alert_changed_at timestamptz,
  alert_seen_count bigint CHECK(alert_seen_count>=0)
);
