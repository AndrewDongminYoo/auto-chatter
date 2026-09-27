CREATE TABLE IF NOT EXISTS instagram_manual_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  recipient_id text NOT NULL CHECK(recipient_id ~ '^[0-9]{1,40}$'),
  request_key uuid NOT NULL,
  created_by uuid NOT NULL,
  text text NOT NULL CHECK(length(btrim(text))>0 AND length(text)<=1000),
  handoff_version integer NOT NULL CHECK(handoff_version>0),
  retry_of uuid,
  retry_reason text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','unknown')),
  failure_code text,
  safe_to_retry boolean NOT NULL DEFAULT false,
  attempt_id uuid,
  attempt_started_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_message_id text,
  sent_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,connection_id,recipient_id,request_key),
  UNIQUE(workspace_id,connection_id,recipient_id,id),
  UNIQUE(retry_of),
  FOREIGN KEY(workspace_id,connection_id,recipient_id) REFERENCES instagram_inbox_handoffs(workspace_id,connection_id,recipient_id),
  FOREIGN KEY(workspace_id,connection_id,recipient_id,retry_of) REFERENCES instagram_manual_replies(workspace_id,connection_id,recipient_id,id),
  CHECK((retry_of IS NULL AND retry_reason IS NULL) OR (retry_of IS NOT NULL AND length(btrim(retry_reason)) BETWEEN 1 AND 500)),
  CHECK(NOT safe_to_retry OR status='failed'),
  CHECK(resolved_at IS NULL OR status='unknown')
);
CREATE UNIQUE INDEX IF NOT EXISTS instagram_manual_replies_sending_idx ON instagram_manual_replies(workspace_id,connection_id,recipient_id) WHERE status='sending';
CREATE INDEX IF NOT EXISTS instagram_manual_replies_order_idx ON instagram_manual_replies(connection_id,recipient_id,created_at,id);
CREATE INDEX IF NOT EXISTS instagram_manual_replies_due_idx ON instagram_manual_replies(connection_id,next_attempt_at) WHERE status='pending';
CREATE TABLE IF NOT EXISTS instagram_manual_reply_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  recipient_id text NOT NULL,
  reply_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('queued','retry_requested','sending','sent','failed','deferred','unknown','no_retry')),
  attempt_id uuid,
  actor_id uuid,
  request_key uuid,
  reason text CHECK(reason IS NULL OR length(reason)<=500),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,connection_id,recipient_id,request_key),
  FOREIGN KEY(workspace_id,connection_id,recipient_id,reply_id) REFERENCES instagram_manual_replies(workspace_id,connection_id,recipient_id,id),
  CHECK((kind IN ('queued','retry_requested','no_retry') AND actor_id IS NOT NULL) OR (kind NOT IN ('queued','retry_requested','no_retry') AND actor_id IS NULL))
);
CREATE INDEX IF NOT EXISTS instagram_manual_reply_events_reply_idx ON instagram_manual_reply_events(reply_id,created_at,id);
