ALTER TABLE private_reply_outbox ADD COLUMN IF NOT EXISTS follow_config jsonb;
ALTER TABLE private_reply_outbox ADD COLUMN IF NOT EXISTS recipient_id text;

CREATE TABLE IF NOT EXISTS instagram_follow_conversations (
  reply_id bigint PRIMARY KEY REFERENCES private_reply_outbox(id),
  connection_id uuid NOT NULL REFERENCES instagram_connections(id),
  recipient_id text NOT NULL,
  confirmation_keyword text NOT NULL,
  follower_reply_text text NOT NULL,
  non_follower_reply_text text NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','pending','sending','sent','blocked','failed','unknown')),
  follow_status text NOT NULL DEFAULT 'unknown' CHECK(follow_status IN ('unknown','following','not_following')),
  confirmed_at timestamptz,
  last_message_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_id uuid,
  attempt_started_at timestamptz,
  failure_code text,
  provider_message_id text,
  rate_limit_retries integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS instagram_message_receipts (
  connection_id uuid NOT NULL REFERENCES instagram_connections(id),
  message_id text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY(connection_id,message_id)
);
ALTER TABLE instagram_follow_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_message_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON instagram_follow_conversations, instagram_message_receipts FROM PUBLIC;
DO $$ DECLARE api_role text; BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=api_role) THEN
      EXECUTE format('REVOKE ALL ON instagram_follow_conversations, instagram_message_receipts FROM %I',api_role);
    END IF;
  END LOOP;
END $$;
