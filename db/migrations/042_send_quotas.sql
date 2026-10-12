-- The per-account private reply budget and the cron wake order (#60, docs/specs/2026-10-12-send-quotas.md).
-- private_reply_outbox.provider_called_at is set immediately before a private reply's provider send request,
-- overwritten by a later attempt and never cleared; the claim and the wake count a connection's rows from the
-- last hour against the budget. instagram_connections.send_woken_at is when the cron last queued the
-- connection and is used only for the wake order. Both columns are nullable, so a replay is safe.
ALTER TABLE private_reply_outbox ADD COLUMN IF NOT EXISTS provider_called_at timestamptz;
CREATE INDEX IF NOT EXISTS private_reply_outbox_provider_called_idx
  ON private_reply_outbox(connection_id, provider_called_at) WHERE provider_called_at IS NOT NULL;
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS send_woken_at timestamptz;
