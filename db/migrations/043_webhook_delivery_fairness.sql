-- Webhook delivery order across workspaces (#167, docs/specs/2026-10-01-flow-webhook-delivery.md). Each claim
-- reads the latest attempt_started_at of a workspace's deliveries; this index answers that lookup without
-- reading the workspace's whole delivery history. It adds no column, so a replay is safe.
CREATE INDEX IF NOT EXISTS webhook_deliveries_workspace_attempt_idx
  ON webhook_deliveries(workspace_id, attempt_started_at);
