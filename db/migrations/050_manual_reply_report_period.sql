CREATE INDEX IF NOT EXISTS instagram_manual_replies_report_period_idx
  ON instagram_manual_replies(workspace_id,created_at,connection_id);
