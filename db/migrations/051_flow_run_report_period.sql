CREATE INDEX IF NOT EXISTS flow_runs_report_period_idx
  ON flow_runs(workspace_id,created_at,connection_id,flow_id);
