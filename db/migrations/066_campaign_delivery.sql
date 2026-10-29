-- Apply through deploy/migrate-multi-user.sql.
-- The campaign delivery worker (#36, PR 2) claims pending campaign_deliveries rows and sends each as one DM.
-- next_attempt_at: when a pending row may next be claimed; a deferred row stays pending with a later time.
ALTER TABLE campaign_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
-- provider_called_at: set immediately before the provider send request, so the hourly campaign budget counts calls.
ALTER TABLE campaign_deliveries ADD COLUMN IF NOT EXISTS provider_called_at timestamptz;
-- The claim and the wake read a connection's due pending rows, oldest first.
CREATE INDEX IF NOT EXISTS campaign_deliveries_due_idx
  ON campaign_deliveries(connection_id,next_attempt_at,created_at,id) WHERE status='pending';
-- The hourly campaign budget counts a connection's provider calls of the last hour.
CREATE INDEX IF NOT EXISTS campaign_deliveries_called_idx
  ON campaign_deliveries(connection_id,provider_called_at) WHERE provider_called_at IS NOT NULL;
-- Stale recovery reads the rows still in sending.
CREATE INDEX IF NOT EXISTS campaign_deliveries_sending_idx
  ON campaign_deliveries(attempt_started_at) WHERE status='sending';
