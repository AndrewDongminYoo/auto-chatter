BEGIN;

ALTER TABLE instagram_connections
  ADD COLUMN IF NOT EXISTS send_paused_until timestamptz;

ALTER TABLE private_reply_outbox
  ADD COLUMN IF NOT EXISTS rate_limit_retries integer NOT NULL DEFAULT 0 CHECK (rate_limit_retries >= 0);

COMMIT;
