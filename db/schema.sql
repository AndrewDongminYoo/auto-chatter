CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS workspace_members (
  user_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id)
);
-- A workspace can have several members, each with one role; a user still belongs to one workspace.
-- Existing single members become owners.
ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'owner';
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='workspace_members'::regclass AND conname='workspace_members_role') THEN
    ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role CHECK(role IN ('owner','admin','agent'));
  END IF;
END $$;
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_workspace_id_key;
CREATE INDEX IF NOT EXISTS workspace_members_workspace_idx ON workspace_members(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_one_owner_idx ON workspace_members(workspace_id) WHERE role='owner';

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
  CHECK(purpose<>'all' OR decision='revoke'),
  CHECK(purpose<>'service_reply' OR decision<>'grant' OR evidence_kind='explicit')
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
CREATE TABLE IF NOT EXISTS flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
  draft jsonb NOT NULL CHECK(jsonb_typeof(draft)='object'),
  draft_revision integer NOT NULL DEFAULT 0 CHECK(draft_revision>=0),
  published_version_id uuid,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,workspace_id),
  CHECK(NOT archived OR published_version_id IS NULL)
);
CREATE TABLE IF NOT EXISTS flow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  version_no integer NOT NULL CHECK(version_no>0),
  draft_revision integer NOT NULL CHECK(draft_revision>=0),
  definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
  trigger_connection_id uuid NOT NULL,
  trigger_media_id text NOT NULL CHECK(trigger_media_id ~ '^[0-9]{1,40}$'),
  field_ids uuid[] NOT NULL DEFAULT '{}' CHECK(array_position(field_ids,NULL) IS NULL),
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(flow_id,version_no),
  UNIQUE(flow_id,draft_revision),
  UNIQUE(id,flow_id),
  FOREIGN KEY(flow_id,workspace_id) REFERENCES flows(id,workspace_id),
  FOREIGN KEY(trigger_connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);
CREATE INDEX IF NOT EXISTS flow_versions_trigger_idx ON flow_versions(trigger_connection_id,trigger_media_id);
CREATE INDEX IF NOT EXISTS flow_versions_field_ids_idx ON flow_versions USING gin(field_ids);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flows'::regclass AND conname='flows_published_version') THEN
    ALTER TABLE flows ADD CONSTRAINT flows_published_version FOREIGN KEY(published_version_id,id) REFERENCES flow_versions(id,flow_id);
  END IF;
END $$;
-- A flow runs only while its switch is on; publishing alone never sends.
ALTER TABLE flows ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flows'::regclass AND conname='flows_enabled_published') THEN
    ALTER TABLE flows ADD CONSTRAINT flows_enabled_published CHECK(NOT enabled OR (published_version_id IS NOT NULL AND NOT archived));
  END IF;
END $$;
-- One run per flow and comment event, pinned to the version that was published when it started.
CREATE TABLE IF NOT EXISTS flow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  flow_id uuid NOT NULL,
  flow_version_id uuid NOT NULL,
  event_id bigint NOT NULL,
  status text NOT NULL CHECK(status IN ('delivering','ended','skipped','failed')),
  failure_code text CHECK(failure_code IS NULL OR failure_code ~ '^[a-z_]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((status IN ('skipped','failed')) = (failure_code IS NOT NULL)),
  UNIQUE(flow_id,event_id),
  UNIQUE(id,connection_id,workspace_id),
  FOREIGN KEY(flow_id,workspace_id) REFERENCES flows(id,workspace_id),
  FOREIGN KEY(flow_version_id,flow_id) REFERENCES flow_versions(id,flow_id),
  FOREIGN KEY(event_id,connection_id,workspace_id) REFERENCES instagram_comment_events(id,connection_id,workspace_id)
);
CREATE INDEX IF NOT EXISTS flow_runs_history_idx ON flow_runs(flow_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS flow_runs_connection_idx ON flow_runs(workspace_id,connection_id);
-- Append-only record of the path a run took: node, type and the port or result it produced.
CREATE TABLE IF NOT EXISTS flow_step_runs (
  run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  seq smallint NOT NULL CHECK(seq BETWEEN 0 AND 100),
  node_id text NOT NULL CHECK(node_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  node_type text NOT NULL CHECK(node_type ~ '^[A-Za-z0-9_-]{1,40}$'),
  outcome text NOT NULL CHECK(outcome ~ '^[a-z_]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(run_id,seq),
  FOREIGN KEY(run_id,connection_id,workspace_id) REFERENCES flow_runs(id,connection_id,workspace_id)
);
-- A queued reply comes from exactly one source: a legacy comment rule or a flow run.
ALTER TABLE private_reply_outbox ALTER COLUMN rule_id DROP NOT NULL;
ALTER TABLE private_reply_outbox ADD COLUMN IF NOT EXISTS flow_run_id uuid;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='private_reply_outbox'::regclass AND conname='private_reply_outbox_flow_run') THEN
    ALTER TABLE private_reply_outbox ADD CONSTRAINT private_reply_outbox_flow_run
      FOREIGN KEY(flow_run_id,connection_id,workspace_id) REFERENCES flow_runs(id,connection_id,workspace_id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='private_reply_outbox'::regclass AND conname='private_reply_outbox_source') THEN
    ALTER TABLE private_reply_outbox ADD CONSTRAINT private_reply_outbox_source
      CHECK((rule_id IS NULL) <> (flow_run_id IS NULL) AND (flow_run_id IS NULL OR follow_config IS NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS private_reply_outbox_flow_run_idx ON private_reply_outbox(flow_run_id) WHERE flow_run_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS data_deletion_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_counts jsonb NOT NULL CHECK(jsonb_typeof(deleted_counts)='object'),
  retained_counts jsonb NOT NULL CHECK(jsonb_typeof(retained_counts)='object'),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);
CREATE INDEX IF NOT EXISTS data_deletion_records_connection_idx
  ON data_deletion_records(workspace_id,connection_id,completed_at DESC);

-- The only path that deletes product rows. It runs as its administrator owner, so the
-- runtime roles need EXECUTE on this function and no table DELETE grant.
CREATE OR REPLACE FUNCTION public.delete_connection_data(
  p_workspace uuid,
  p_connection uuid,
  p_actor uuid,
  p_confirm_account_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  target public.instagram_connections%ROWTYPE;
  deleted jsonb := '{}'::jsonb;
  retained jsonb;
  affected bigint;
  saved public.data_deletion_records%ROWTYPE;
  bridge record;
  carried_event bigint;
  carried bigint := 0;
BEGIN
  SELECT * INTO target FROM public.instagram_connections
  -- FOR UPDATE (not NO KEY UPDATE) also conflicts with the key-share locks that inserts referencing this
  -- connection take, so no delivery row can appear after the scan below.
  WHERE id=p_connection AND workspace_id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection_not_found' USING ERRCODE='AC001';
  END IF;
  IF target.account_id IS DISTINCT FROM p_confirm_account_id THEN
    RAISE EXCEPTION 'confirmation_mismatch' USING ERRCODE='AC004';
  END IF;
  IF target.active OR target.send_enabled OR target.access_token_encrypted IS NOT NULL THEN
    RAISE EXCEPTION 'connection_active' USING ERRCODE='AC002';
  END IF;
  -- Lock the delivery rows before the check: an uncommitted claim would otherwise still read as pending,
  -- and the deletes below would remove the row after the claim commits it as sending. NOWAIT refuses
  -- instead of waiting, because a send being finalized holds its row and then waits for this connection lock.
  BEGIN
    PERFORM 1 FROM public.private_reply_outbox WHERE connection_id=p_connection ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.instagram_follow_conversations WHERE connection_id=p_connection ORDER BY reply_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.instagram_manual_replies WHERE connection_id=p_connection ORDER BY id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
  END;
  IF EXISTS(SELECT 1 FROM public.private_reply_outbox WHERE connection_id=p_connection AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_follow_conversations WHERE connection_id=p_connection AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_manual_replies WHERE connection_id=p_connection AND status='sending')
  THEN
    RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
  END IF;

  -- A DM-recipient opt-out reaches the comment sender only through a provider-acknowledged reply
  -- (see deliveryRecipientOptedOut). Record it on the comment sender before that bridge is deleted.
  FOR bridge IN
    SELECT DISTINCT state.purpose, state.evidence_kind, state.occurred_at, state.last_event_id, reply.sender_id
    FROM public.channel_consent_state state
    JOIN public.private_reply_outbox reply ON reply.workspace_id=state.workspace_id
      AND reply.connection_id=state.connection_id AND reply.recipient_id=state.identity_value
    JOIN public.instagram_comment_events event ON event.id=reply.event_id
      AND event.workspace_id=reply.workspace_id AND event.connection_id=reply.connection_id
      AND event.sender_id=reply.sender_id
    WHERE state.workspace_id=p_workspace AND state.connection_id=p_connection
      AND state.identity_kind='dm_recipient' AND state.decision='revoke'
      AND reply.status='sent' AND reply.provider_message_id IS NOT NULL AND length(btrim(reply.provider_message_id))>0
      AND NOT EXISTS(
        SELECT 1 FROM public.channel_consent_state existing
        WHERE existing.workspace_id=p_workspace AND existing.connection_id=p_connection
          AND existing.channel='instagram' AND existing.identity_kind='comment_sender'
          AND existing.identity_value=reply.sender_id AND existing.purpose=state.purpose AND existing.decision='revoke'
      )
  LOOP
    INSERT INTO public.channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
    VALUES(gen_random_uuid(),p_workspace,p_connection,'instagram','comment_sender',bridge.sender_id,bridge.purpose,'revoke',bridge.evidence_kind,'data_deletion_bridge:'||bridge.last_event_id,bridge.occurred_at,p_actor)
    RETURNING id INTO carried_event;
    INSERT INTO public.channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
    SELECT workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,id
    FROM public.channel_consent_events WHERE id=carried_event
    ON CONFLICT(workspace_id,connection_id,channel,identity_kind,identity_value,purpose) DO UPDATE SET
      decision=EXCLUDED.decision,evidence_kind=EXCLUDED.evidence_kind,occurred_at=EXCLUDED.occurred_at,
      recorded_at=EXCLUDED.recorded_at,last_event_id=EXCLUDED.last_event_id;
    carried := carried + 1;
  END LOOP;

  DELETE FROM public.instagram_manual_reply_events WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_manual_reply_events', affected);
  DELETE FROM public.instagram_manual_replies WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_manual_replies', affected);
  DELETE FROM public.instagram_inbox_handoff_events WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoff_events', affected);
  DELETE FROM public.instagram_inbox_handoffs WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoffs', affected);
  DELETE FROM public.instagram_inbox_messages WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_messages', affected);
  DELETE FROM public.instagram_contact_automation WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_automation', affected);
  DELETE FROM public.instagram_contact_tags WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_tags', affected);
  DELETE FROM public.instagram_contact_field_values WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_field_values', affected);
  -- Follow rows first: confirmation ingestion locks them before writing a receipt.
  DELETE FROM public.instagram_follow_conversations WHERE connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_follow_conversations', affected);
  DELETE FROM public.instagram_message_receipts WHERE connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_message_receipts', affected);
  DELETE FROM public.private_reply_outbox WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('private_reply_outbox', affected);
  DELETE FROM public.flow_step_runs WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_step_runs', affected);
  DELETE FROM public.flow_runs WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_runs', affected);
  DELETE FROM public.instagram_comment_events WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_comment_events', affected);
  -- Opt-outs stay so a later reconnection cannot message people who revoked consent.
  DELETE FROM public.channel_consent_state
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND decision='grant';
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('channel_consent_state', affected);
  DELETE FROM public.channel_consent_events event
  WHERE event.workspace_id=p_workspace AND event.connection_id=p_connection AND event.decision='grant'
    AND NOT EXISTS(SELECT 1 FROM public.channel_consent_state state WHERE state.last_event_id=event.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('channel_consent_events', affected);

  retained := jsonb_build_object(
    'carried_comment_sender_revokes', carried,
    'channel_consent_events',
    (SELECT count(*) FROM public.channel_consent_events WHERE workspace_id=p_workspace AND connection_id=p_connection),
    'channel_consent_state',
    (SELECT count(*) FROM public.channel_consent_state WHERE workspace_id=p_workspace AND connection_id=p_connection)
  );
  INSERT INTO public.data_deletion_records(workspace_id,connection_id,requested_by,deleted_counts,retained_counts)
  VALUES(p_workspace,p_connection,p_actor,deleted,retained)
  RETURNING * INTO saved;
  RETURN jsonb_build_object(
    'id', saved.id,
    'completed_at', saved.completed_at,
    'deleted_counts', saved.deleted_counts,
    'retained_counts', saved.retained_counts
  );
END $$;
REVOKE ALL ON FUNCTION public.delete_connection_data(uuid,uuid,uuid,text) FROM PUBLIC;
ALTER TABLE data_deletion_records ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'connection';
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='data_deletion_records'::regclass AND conname='data_deletion_records_scope') THEN
    ALTER TABLE data_deletion_records ADD CONSTRAINT data_deletion_records_scope CHECK(scope IN ('connection','person'));
  END IF;
END $$;

-- Administrator-only: deletes one external requester's records inside one connection.
-- It is a SECURITY INVOKER function with EXECUTE revoked from every runtime and API role,
-- so only an administrator session can run it (see the person data deletion spec).
CREATE OR REPLACE FUNCTION public.delete_person_data(
  p_workspace uuid,
  p_connection uuid,
  p_actor uuid,
  p_identity_kind text,
  p_identity_value text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  senders text[];
  recipients text[];
  replies bigint[];
  deleted jsonb := '{}'::jsonb;
  retained jsonb;
  affected bigint;
  saved public.data_deletion_records%ROWTYPE;
  bridge record;
  carried_event bigint;
  carried bigint := 0;
  found_senders text[];
  found_recipients text[];
  size_before int;
  size_locked int := -1;
BEGIN
  IF p_identity_kind IS NULL OR p_identity_kind NOT IN ('comment_sender','dm_recipient')
    OR p_identity_value IS NULL OR length(btrim(p_identity_value))=0 THEN
    RAISE EXCEPTION 'invalid_identity' USING ERRCODE='AC005';
  END IF;
  PERFORM 1 FROM public.instagram_connections
  WHERE id=p_connection AND workspace_id=p_workspace FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection_not_found' USING ERRCODE='AC001';
  END IF;

  IF p_identity_kind='comment_sender' THEN
    senders := ARRAY[p_identity_value];
    recipients := '{}';
  ELSE
    senders := '{}';
    recipients := ARRAY[p_identity_value];
  END IF;
  -- Resolve, lock, and resolve again: a send confirmed while this waited for a row lock can add
  -- a new bridge, whose rows must be locked and checked as well.
  LOOP
    -- Follow the provider-acknowledged reply bridge (the one consent checks use) and handoff pairs,
    -- which start only on a verified bridge, until the person's identity set stops growing.
    LOOP
      size_before := cardinality(senders) + cardinality(recipients);
      SELECT coalesce(array_agg(DISTINCT pair.sender_id), '{}'), coalesce(array_agg(DISTINCT pair.recipient_id), '{}')
      INTO found_senders, found_recipients
      FROM (
        SELECT reply.sender_id, reply.recipient_id
        FROM public.private_reply_outbox reply
        JOIN public.instagram_comment_events event ON event.id=reply.event_id
          AND event.workspace_id=reply.workspace_id AND event.connection_id=reply.connection_id
          AND event.sender_id=reply.sender_id
        WHERE reply.workspace_id=p_workspace AND reply.connection_id=p_connection
          AND reply.status='sent' AND reply.recipient_id IS NOT NULL
          AND reply.provider_message_id IS NOT NULL AND length(btrim(reply.provider_message_id))>0
          AND (reply.sender_id=ANY(senders) OR reply.recipient_id=ANY(recipients))
        UNION
        SELECT handoff.sender_id, handoff.recipient_id
        FROM public.instagram_inbox_handoffs handoff
        WHERE handoff.workspace_id=p_workspace AND handoff.connection_id=p_connection
          AND (handoff.sender_id=ANY(senders) OR handoff.recipient_id=ANY(recipients))
      ) pair;
      senders := ARRAY(SELECT DISTINCT unnest(senders || found_senders));
      recipients := ARRAY(SELECT DISTINCT unnest(recipients || found_recipients));
      EXIT WHEN cardinality(senders) + cardinality(recipients) = size_before;
    END LOOP;
    EXIT WHEN cardinality(senders) + cardinality(recipients) = size_locked;
    size_locked := cardinality(senders) + cardinality(recipients);
    SELECT coalesce(array_agg(id), '{}') INTO replies FROM public.private_reply_outbox
    WHERE workspace_id=p_workspace AND connection_id=p_connection AND sender_id=ANY(senders);

    -- Lock the person's delivery rows before checking them. Workers claim with FOR UPDATE SKIP LOCKED,
    -- so a claim either committed first (and is seen as sending here) or skips these rows.
    PERFORM 1 FROM public.private_reply_outbox WHERE id=ANY(replies) FOR UPDATE;
    PERFORM 1 FROM public.instagram_follow_conversations
    WHERE connection_id=p_connection AND (reply_id=ANY(replies) OR recipient_id=ANY(recipients)) FOR UPDATE;
    PERFORM 1 FROM public.instagram_manual_replies
    WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients) FOR UPDATE;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.private_reply_outbox WHERE id=ANY(replies) AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_follow_conversations
      WHERE connection_id=p_connection AND status='sending' AND (reply_id=ANY(replies) OR recipient_id=ANY(recipients)))
    OR EXISTS(SELECT 1 FROM public.instagram_manual_replies
      WHERE workspace_id=p_workspace AND connection_id=p_connection AND status='sending' AND recipient_id=ANY(recipients))
  THEN
    RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
  END IF;

  -- Keep a bridged DM-recipient opt-out effective on the comment sender after the bridge is gone.
  FOR bridge IN
    SELECT DISTINCT state.purpose, state.evidence_kind, state.occurred_at, state.last_event_id, reply.sender_id
    FROM public.channel_consent_state state
    JOIN public.private_reply_outbox reply ON reply.workspace_id=state.workspace_id
      AND reply.connection_id=state.connection_id AND reply.recipient_id=state.identity_value
    JOIN public.instagram_comment_events event ON event.id=reply.event_id
      AND event.workspace_id=reply.workspace_id AND event.connection_id=reply.connection_id
      AND event.sender_id=reply.sender_id
    WHERE state.workspace_id=p_workspace AND state.connection_id=p_connection
      AND state.identity_kind='dm_recipient' AND state.decision='revoke'
      AND state.identity_value=ANY(recipients) AND reply.sender_id=ANY(senders)
      AND reply.status='sent' AND reply.provider_message_id IS NOT NULL AND length(btrim(reply.provider_message_id))>0
      AND NOT EXISTS(
        SELECT 1 FROM public.channel_consent_state existing
        WHERE existing.workspace_id=p_workspace AND existing.connection_id=p_connection
          AND existing.channel='instagram' AND existing.identity_kind='comment_sender'
          AND existing.identity_value=reply.sender_id AND existing.purpose=state.purpose AND existing.decision='revoke'
      )
  LOOP
    INSERT INTO public.channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
    VALUES(gen_random_uuid(),p_workspace,p_connection,'instagram','comment_sender',bridge.sender_id,bridge.purpose,'revoke',bridge.evidence_kind,'data_deletion_bridge:'||bridge.last_event_id,bridge.occurred_at,p_actor)
    RETURNING id INTO carried_event;
    INSERT INTO public.channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
    SELECT workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,id
    FROM public.channel_consent_events WHERE id=carried_event
    ON CONFLICT(workspace_id,connection_id,channel,identity_kind,identity_value,purpose) DO UPDATE SET
      decision=EXCLUDED.decision,evidence_kind=EXCLUDED.evidence_kind,occurred_at=EXCLUDED.occurred_at,
      recorded_at=EXCLUDED.recorded_at,last_event_id=EXCLUDED.last_event_id;
    carried := carried + 1;
  END LOOP;

  DELETE FROM public.instagram_manual_reply_events
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_manual_reply_events', affected);
  DELETE FROM public.instagram_manual_replies
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_manual_replies', affected);
  DELETE FROM public.instagram_inbox_handoff_events
  WHERE workspace_id=p_workspace AND connection_id=p_connection
    AND (recipient_id=ANY(recipients) OR sender_id=ANY(senders));
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoff_events', affected);
  DELETE FROM public.instagram_inbox_handoffs
  WHERE workspace_id=p_workspace AND connection_id=p_connection
    AND (recipient_id=ANY(recipients) OR sender_id=ANY(senders));
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoffs', affected);
  DELETE FROM public.instagram_inbox_messages
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_messages', affected);
  DELETE FROM public.instagram_contact_automation
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND sender_id=ANY(senders);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_automation', affected);
  DELETE FROM public.instagram_contact_tags
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND sender_id=ANY(senders);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_tags', affected);
  DELETE FROM public.instagram_contact_field_values
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND sender_id=ANY(senders);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_field_values', affected);
  DELETE FROM public.instagram_follow_conversations
  WHERE connection_id=p_connection AND (reply_id=ANY(replies) OR recipient_id=ANY(recipients));
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_follow_conversations', affected);
  DELETE FROM public.private_reply_outbox WHERE id=ANY(replies);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('private_reply_outbox', affected);
  -- A flow run whose reply was queued after the rows were locked stays with that reply.
  DELETE FROM public.flow_step_runs step USING public.flow_runs run, public.instagram_comment_events event
  WHERE step.run_id=run.id AND event.id=run.event_id
    AND run.workspace_id=p_workspace AND run.connection_id=p_connection AND event.sender_id=ANY(senders)
    AND NOT EXISTS(SELECT 1 FROM public.private_reply_outbox reply WHERE reply.flow_run_id=run.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_step_runs', affected);
  DELETE FROM public.flow_runs run USING public.instagram_comment_events event
  WHERE event.id=run.event_id
    AND run.workspace_id=p_workspace AND run.connection_id=p_connection AND event.sender_id=ANY(senders)
    AND NOT EXISTS(SELECT 1 FROM public.private_reply_outbox reply WHERE reply.flow_run_id=run.id)
    AND NOT EXISTS(SELECT 1 FROM public.flow_step_runs step WHERE step.run_id=run.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_runs', affected);
  -- A comment that arrived after the rows were locked keeps its new reply or flow run and stays for a later run.
  DELETE FROM public.instagram_comment_events event
  WHERE event.workspace_id=p_workspace AND event.connection_id=p_connection AND event.sender_id=ANY(senders)
    AND NOT EXISTS(SELECT 1 FROM public.private_reply_outbox reply WHERE reply.event_id=event.id)
    AND NOT EXISTS(SELECT 1 FROM public.flow_runs run WHERE run.event_id=event.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_comment_events', affected);
  DELETE FROM public.channel_consent_state
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND decision='grant'
    AND ((identity_kind='comment_sender' AND identity_value=ANY(senders))
      OR (identity_kind='dm_recipient' AND identity_value=ANY(recipients)));
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('channel_consent_state', affected);
  DELETE FROM public.channel_consent_events event
  WHERE event.workspace_id=p_workspace AND event.connection_id=p_connection AND event.decision='grant'
    AND ((event.identity_kind='comment_sender' AND event.identity_value=ANY(senders))
      OR (event.identity_kind='dm_recipient' AND event.identity_value=ANY(recipients)))
    AND NOT EXISTS(SELECT 1 FROM public.channel_consent_state state WHERE state.last_event_id=event.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('channel_consent_events', affected);

  retained := jsonb_build_object(
    'carried_comment_sender_revokes', carried,
    'channel_consent_events',
    (SELECT count(*) FROM public.channel_consent_events
     WHERE workspace_id=p_workspace AND connection_id=p_connection
       AND ((identity_kind='comment_sender' AND identity_value=ANY(senders))
         OR (identity_kind='dm_recipient' AND identity_value=ANY(recipients)))),
    'channel_consent_state',
    (SELECT count(*) FROM public.channel_consent_state
     WHERE workspace_id=p_workspace AND connection_id=p_connection
       AND ((identity_kind='comment_sender' AND identity_value=ANY(senders))
         OR (identity_kind='dm_recipient' AND identity_value=ANY(recipients))))
  );
  INSERT INTO public.data_deletion_records(workspace_id,connection_id,requested_by,scope,deleted_counts,retained_counts)
  VALUES(p_workspace,p_connection,p_actor,'person',deleted,retained)
  RETURNING * INTO saved;
  RETURN jsonb_build_object(
    'id', saved.id,
    'completed_at', saved.completed_at,
    'deleted_counts', saved.deleted_counts,
    'retained_counts', saved.retained_counts
  );
END $$;
REVOKE ALL ON FUNCTION public.delete_person_data(uuid,uuid,uuid,text,text) FROM PUBLIC;
-- Evidence of a deleted workspace. It has no foreign keys because the workspace and its connections are gone,
-- and it holds only counts, time and the administrator who ran the deletion (see the workspace deletion spec).
CREATE TABLE IF NOT EXISTS workspace_deletion_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_counts jsonb NOT NULL CHECK(jsonb_typeof(deleted_counts)='object')
);

-- Administrator-only: deletes every record of one workspace, including opt-outs and deletion evidence,
-- then the membership and the workspace. The Supabase Auth user is deleted separately by the administrator.
-- It is a SECURITY INVOKER function with EXECUTE revoked from every runtime and API role.
CREATE OR REPLACE FUNCTION public.delete_workspace_data(p_workspace uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  connections uuid[];
  members uuid[];
  deleted jsonb := '{}'::jsonb;
  affected bigint;
  saved public.workspace_deletion_records%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'invalid_actor' USING ERRCODE='AC006';
  END IF;
  PERFORM 1 FROM public.workspaces WHERE id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE='AC001';
  END IF;
  -- FOR UPDATE also blocks new rows that reference these connections until this transaction ends.
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO connections
  FROM (SELECT id FROM public.instagram_connections WHERE workspace_id=p_workspace ORDER BY id FOR UPDATE) locked;
  IF EXISTS(SELECT 1 FROM public.instagram_connections WHERE id=ANY(connections)
    AND (active OR send_enabled OR access_token_encrypted IS NOT NULL)) THEN
    RAISE EXCEPTION 'connection_active' USING ERRCODE='AC002';
  END IF;
  -- Lock the delivery rows before the check: an uncommitted claim would otherwise still read as pending,
  -- and the DELETE below would remove the row after the claim commits it as sending. NOWAIT refuses
  -- instead of waiting, because a send being finalized holds its row and then waits for a connection lock.
  BEGIN
    PERFORM 1 FROM public.private_reply_outbox WHERE workspace_id=p_workspace ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.instagram_follow_conversations WHERE connection_id=ANY(connections) ORDER BY reply_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.instagram_manual_replies WHERE workspace_id=p_workspace ORDER BY id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
  END;
  IF EXISTS(SELECT 1 FROM public.private_reply_outbox WHERE workspace_id=p_workspace AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_follow_conversations WHERE connection_id=ANY(connections) AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_manual_replies WHERE workspace_id=p_workspace AND status='sending') THEN
    RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
  END IF;
  SELECT coalesce(array_agg(user_id ORDER BY user_id), '{}') INTO members
  FROM public.workspace_members WHERE workspace_id=p_workspace;

  -- Children before parents, following the foreign keys (the multi-user cutover note keeps the same order).
  DELETE FROM public.instagram_manual_reply_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_manual_reply_events', affected);
  DELETE FROM public.instagram_manual_replies WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_manual_replies', affected);
  DELETE FROM public.instagram_inbox_handoff_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoff_events', affected);
  DELETE FROM public.instagram_inbox_handoffs WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoffs', affected);
  DELETE FROM public.instagram_inbox_messages WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_messages', affected);
  DELETE FROM public.instagram_contact_automation WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_automation', affected);
  DELETE FROM public.instagram_contact_tags WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_tags', affected);
  DELETE FROM public.instagram_contact_field_values WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_field_values', affected);
  DELETE FROM public.instagram_contact_segments WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_segments', affected);
  DELETE FROM public.instagram_contact_fields WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_fields', affected);
  DELETE FROM public.instagram_follow_conversations WHERE connection_id=ANY(connections);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_follow_conversations', affected);
  DELETE FROM public.instagram_message_receipts WHERE connection_id=ANY(connections);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_message_receipts', affected);
  DELETE FROM public.private_reply_outbox WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('private_reply_outbox', affected);
  -- Flow runs follow the replies that point at them and precede the versions they are pinned to.
  DELETE FROM public.flow_step_runs WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_step_runs', affected);
  DELETE FROM public.flow_runs WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_runs', affected);
  UPDATE public.flows SET enabled=false,published_version_id=NULL WHERE workspace_id=p_workspace;
  DELETE FROM public.flow_versions WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_versions', affected);
  DELETE FROM public.flows WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flows', affected);
  DELETE FROM public.channel_consent_state WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('channel_consent_state', affected);
  DELETE FROM public.channel_consent_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('channel_consent_events', affected);
  DELETE FROM public.instagram_comment_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_comment_events', affected);
  DELETE FROM public.instagram_comment_rules WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_comment_rules', affected);
  DELETE FROM public.data_deletion_records WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('data_deletion_records', affected);
  DELETE FROM public.instagram_connections WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_connections', affected);
  DELETE FROM public.instagram_oauth_states WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_oauth_states', affected);
  DELETE FROM public.workspace_members WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('workspace_members', affected);
  DELETE FROM public.workspaces WHERE id=p_workspace;

  INSERT INTO public.workspace_deletion_records(workspace_id,requested_by,deleted_counts)
  VALUES(p_workspace,p_actor,deleted)
  RETURNING * INTO saved;
  -- Member IDs are returned so the administrator can delete the Auth users; they are not stored.
  RETURN jsonb_build_object(
    'id', saved.id,
    'completed_at', saved.completed_at,
    'deleted_counts', saved.deleted_counts,
    'member_user_ids', to_jsonb(members)
  );
END $$;
REVOKE ALL ON FUNCTION public.delete_workspace_data(uuid,uuid) FROM PUBLIC;
