-- Bound handoff-event report reads by workspace and creation period.
CREATE INDEX IF NOT EXISTS inbox_handoff_events_report_period_idx
  ON instagram_inbox_handoff_events(workspace_id,created_at,connection_id);
