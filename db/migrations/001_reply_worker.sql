BEGIN;

ALTER TABLE private_reply_outbox
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS attempt_id uuid,
  ADD COLUMN IF NOT EXISTS attempt_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;

ALTER TABLE private_reply_outbox
  DROP CONSTRAINT IF EXISTS private_reply_outbox_status_check;
ALTER TABLE private_reply_outbox
  ADD CONSTRAINT private_reply_outbox_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'blocked', 'unknown'));

ALTER TABLE private_reply_outbox
  DROP CONSTRAINT IF EXISTS private_reply_outbox_sending_attempt_check;
ALTER TABLE private_reply_outbox
  ADD CONSTRAINT private_reply_outbox_sending_attempt_check
  CHECK (status <> 'sending' OR (attempt_id IS NOT NULL AND attempt_started_at IS NOT NULL));

COMMIT;
