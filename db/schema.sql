CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS workspace_members (
  user_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS instagram_oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS instagram_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  account_id text NOT NULL UNIQUE CHECK (length(btrim(account_id)) > 0),
  active boolean NOT NULL DEFAULT false,
  send_enabled boolean NOT NULL DEFAULT false,
  inbox_enabled boolean NOT NULL DEFAULT false,
  inbox_enabled_at timestamptz,
  username text,
  access_token_encrypted text,
  token_expires_at timestamptz,
  token_obtained_at timestamptz NOT NULL DEFAULT now(),
  token_refresh_attempted_at timestamptz,
  send_paused_until timestamptz,
  UNIQUE (id, workspace_id)
);

CREATE TABLE IF NOT EXISTS channel_consent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_key uuid NOT NULL,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  channel text NOT NULL CHECK(channel='instagram'),
  identity_kind text NOT NULL CHECK(identity_kind IN ('comment_sender','dm_recipient')),
  identity_value text NOT NULL CHECK(length(btrim(identity_value)) BETWEEN 1 AND 255),
  purpose text NOT NULL CHECK(purpose IN ('service_reply','marketing','all')),
  decision text NOT NULL CHECK(decision IN ('grant','revoke')),
  evidence_kind text NOT NULL CHECK(evidence_kind IN ('comment','inbound_dm','explicit','import')),
  evidence_reference text NOT NULL CHECK(length(btrim(evidence_reference)) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL,
  actor_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,request_key),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id),
  CHECK(purpose<>'all' OR decision='revoke')
);
CREATE INDEX IF NOT EXISTS channel_consent_events_scope_idx
  ON channel_consent_events(workspace_id,connection_id,channel,identity_kind,identity_value,id);

CREATE TABLE IF NOT EXISTS channel_consent_state (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  channel text NOT NULL CHECK(channel='instagram'),
  identity_kind text NOT NULL CHECK(identity_kind IN ('comment_sender','dm_recipient')),
  identity_value text NOT NULL CHECK(length(btrim(identity_value)) BETWEEN 1 AND 255),
  purpose text NOT NULL CHECK(purpose IN ('service_reply','marketing')),
  decision text NOT NULL CHECK(decision IN ('grant','revoke')),
  evidence_kind text NOT NULL CHECK(evidence_kind IN ('comment','inbound_dm','explicit','import')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  last_event_id bigint NOT NULL REFERENCES channel_consent_events(id),
  PRIMARY KEY(workspace_id,connection_id,channel,identity_kind,identity_value,purpose),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);

CREATE OR REPLACE FUNCTION public.enforce_channel_consent_state_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_event public.channel_consent_events%ROWTYPE;
BEGIN
  SELECT * INTO source_event FROM public.channel_consent_events WHERE id=NEW.last_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel consent state event does not exist' USING ERRCODE='23503';
  END IF;
  IF TG_OP='UPDATE' AND NEW.last_event_id<OLD.last_event_id THEN
    RAISE EXCEPTION 'channel consent state event cannot move backwards' USING ERRCODE='23514';
  END IF;
  IF source_event.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR source_event.connection_id IS DISTINCT FROM NEW.connection_id
    OR source_event.channel IS DISTINCT FROM NEW.channel
    OR source_event.identity_kind IS DISTINCT FROM NEW.identity_kind
    OR source_event.identity_value IS DISTINCT FROM NEW.identity_value
    OR source_event.decision IS DISTINCT FROM NEW.decision
    OR source_event.evidence_kind IS DISTINCT FROM NEW.evidence_kind
    OR source_event.occurred_at IS DISTINCT FROM NEW.occurred_at
    OR source_event.recorded_at IS DISTINCT FROM NEW.recorded_at
    OR NOT(source_event.purpose=NEW.purpose OR (source_event.purpose='all' AND source_event.decision='revoke'))
  THEN
    RAISE EXCEPTION 'channel consent state must match its event' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS enforce_channel_consent_state_event ON public.channel_consent_state;
CREATE TRIGGER enforce_channel_consent_state_event
BEFORE INSERT OR UPDATE ON public.channel_consent_state
FOR EACH ROW EXECUTE FUNCTION public.enforce_channel_consent_state_event();

CREATE TABLE IF NOT EXISTS instagram_comment_rules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  media_id text NOT NULL CHECK (length(btrim(media_id)) > 0),
  keyword text NOT NULL CHECK (length(btrim(keyword)) > 0),
  keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(keywords) <= 20 AND array_position(keywords, NULL) IS NULL),
  match_mode text NOT NULL DEFAULT 'contains' CHECK (match_mode IN ('contains', 'exact', 'all')),
  excluded_keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(excluded_keywords) <= 20 AND array_position(excluded_keywords, NULL) IS NULL),
  private_reply_text text NOT NULL CHECK (length(btrim(private_reply_text)) > 0),
  follow_gate_enabled boolean NOT NULL DEFAULT false,
  follower_reply_text text NOT NULL DEFAULT '',
  non_follower_reply_text text NOT NULL DEFAULT '',
  confirmation_button_title text NOT NULL DEFAULT '' CHECK(length(confirmation_button_title)<=20),
  confirmation_keyword text NOT NULL DEFAULT '확인' CHECK (length(btrim(confirmation_keyword)) > 0),
  enabled boolean NOT NULL DEFAULT false,
  FOREIGN KEY (connection_id, workspace_id) REFERENCES instagram_connections (id, workspace_id),
  UNIQUE (connection_id, media_id),
  UNIQUE (id, connection_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS instagram_comment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  comment_id text NOT NULL CHECK (length(btrim(comment_id)) > 0),
  media_id text NOT NULL CHECK (length(btrim(media_id)) > 0),
  sender_id text NOT NULL CHECK (length(btrim(sender_id)) > 0),
  comment_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, workspace_id) REFERENCES instagram_connections (id, workspace_id),
  UNIQUE (connection_id, comment_id),
  UNIQUE (id, connection_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS instagram_comment_events_contact_lookup_idx
  ON instagram_comment_events (workspace_id, connection_id, sender_id) INCLUDE (created_at);

CREATE TABLE IF NOT EXISTS private_reply_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  event_id bigint NOT NULL UNIQUE,
  rule_id uuid NOT NULL,
  comment_id text NOT NULL,
  media_id text NOT NULL,
  sender_id text NOT NULL,
  private_reply_text text NOT NULL,
  follow_config jsonb,
  recipient_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'blocked', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_id uuid,
  attempt_started_at timestamptz,
  provider_message_id text,
  failure_code text,
  sent_at timestamptz,
  rate_limit_retries integer NOT NULL DEFAULT 0 CHECK (rate_limit_retries >= 0),
  CONSTRAINT private_reply_outbox_sending_attempt_check CHECK (status <> 'sending' OR (attempt_id IS NOT NULL AND attempt_started_at IS NOT NULL)),
  FOREIGN KEY (connection_id, workspace_id) REFERENCES instagram_connections (id, workspace_id),
  FOREIGN KEY (event_id, connection_id, workspace_id) REFERENCES instagram_comment_events (id, connection_id, workspace_id),
  FOREIGN KEY (rule_id, connection_id, workspace_id) REFERENCES instagram_comment_rules (id, connection_id, workspace_id),
  UNIQUE (connection_id, media_id, sender_id)
);

CREATE TABLE IF NOT EXISTS instagram_follow_conversations (
  reply_id bigint PRIMARY KEY REFERENCES private_reply_outbox(id),
  connection_id uuid NOT NULL REFERENCES instagram_connections(id),
  recipient_id text NOT NULL,
  confirmation_button_title text NOT NULL DEFAULT '' CHECK(length(confirmation_button_title)<=20),
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

CREATE TABLE IF NOT EXISTS instagram_inbox_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  recipient_id text NOT NULL CHECK(recipient_id ~ '^[0-9]+$'),
  message_id text NOT NULL,
  text text NOT NULL CHECK(length(text)<=10000),
  kind text NOT NULL CHECK(kind IN ('text','postback')),
  message_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id),
  UNIQUE(connection_id,message_id)
);
CREATE INDEX IF NOT EXISTS instagram_inbox_messages_conversation_idx
  ON instagram_inbox_messages(workspace_id,connection_id,recipient_id,id DESC);

CREATE TABLE IF NOT EXISTS instagram_contact_automation (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  sender_id text NOT NULL CHECK(length(btrim(sender_id)) > 0),
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,connection_id,sender_id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);

CREATE TABLE IF NOT EXISTS instagram_contact_tags (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  sender_id text NOT NULL CHECK(length(btrim(sender_id)) > 0),
  tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(tags)<=20 AND array_position(tags,NULL) IS NULL),
  PRIMARY KEY(workspace_id,connection_id,sender_id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);

CREATE TABLE IF NOT EXISTS instagram_contact_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 60),
  connection_id uuid,
  tag text CHECK(tag IS NULL OR length(tag) BETWEEN 1 AND 40),
  archived boolean NOT NULL DEFAULT false,
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS instagram_contact_segments_active_name_idx
  ON instagram_contact_segments(workspace_id,name) WHERE NOT archived;

CREATE TABLE IF NOT EXISTS instagram_contact_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 60),
  type text NOT NULL CHECK(type IN ('text','number','boolean','date')),
  archived boolean NOT NULL DEFAULT false,
  UNIQUE(id,workspace_id),
  UNIQUE(workspace_id,name)
);
CREATE TABLE IF NOT EXISTS instagram_contact_field_values (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id uuid NOT NULL,
  sender_id text NOT NULL CHECK(length(btrim(sender_id))>0),
  field_id uuid NOT NULL,
  value jsonb CHECK(value IS NULL OR jsonb_typeof(value) IN ('string','number','boolean')),
  PRIMARY KEY(workspace_id,connection_id,sender_id,field_id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id),
  FOREIGN KEY(field_id,workspace_id) REFERENCES instagram_contact_fields(id,workspace_id)
);
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS field_id uuid;
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS field_operator text;
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS field_value jsonb;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_field_owner') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_field_owner FOREIGN KEY(field_id,workspace_id) REFERENCES instagram_contact_fields(id,workspace_id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_field_condition') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_field_condition CHECK(
      (field_id IS NULL AND field_operator IS NULL AND field_value IS NULL) OR
      (field_id IS NOT NULL AND field_operator IS NOT NULL AND (
        (field_operator IN ('is_set','is_unset') AND field_value IS NULL) OR
        (field_operator='eq' AND field_value IS NOT NULL AND jsonb_typeof(field_value) IN ('string','number','boolean'))
      ))
    );
  END IF;
END $$;

ALTER TABLE instagram_contact_automation ADD COLUMN IF NOT EXISTS handoff_paused boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS private_reply_outbox_identity_idx
  ON private_reply_outbox(id,connection_id,workspace_id);
CREATE TABLE IF NOT EXISTS instagram_inbox_handoffs (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  recipient_id text NOT NULL CHECK(recipient_id ~ '^[0-9]{1,40}$'),
  sender_id text NOT NULL CHECK(length(btrim(sender_id))>0),
  evidence_reply_id bigint NOT NULL,
  active boolean NOT NULL,
  version integer NOT NULL CHECK(version>0),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,connection_id,recipient_id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id),
  FOREIGN KEY(workspace_id,connection_id,sender_id) REFERENCES instagram_contact_automation(workspace_id,connection_id,sender_id),
  FOREIGN KEY(evidence_reply_id,connection_id,workspace_id) REFERENCES private_reply_outbox(id,connection_id,workspace_id)
);
CREATE INDEX IF NOT EXISTS instagram_inbox_handoffs_sender_idx
  ON instagram_inbox_handoffs(workspace_id,connection_id,sender_id) WHERE active;
CREATE TABLE IF NOT EXISTS instagram_inbox_handoff_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  recipient_id text NOT NULL,
  sender_id text NOT NULL,
  evidence_reply_id bigint NOT NULL,
  active boolean NOT NULL,
  version integer NOT NULL CHECK(version>0),
  actor_id uuid NOT NULL,
  reason text NOT NULL CHECK(reason IN ('handoff_started','handoff_resumed')),
  manual_paused_before boolean NOT NULL,
  handoff_paused_before boolean NOT NULL,
  handoff_paused_after boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,connection_id,recipient_id,version),
  FOREIGN KEY(workspace_id,connection_id,recipient_id) REFERENCES instagram_inbox_handoffs(workspace_id,connection_id,recipient_id),
  FOREIGN KEY(evidence_reply_id,connection_id,workspace_id) REFERENCES private_reply_outbox(id,connection_id,workspace_id),
  CHECK((active AND reason='handoff_started') OR (NOT active AND reason='handoff_resumed'))
);
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
