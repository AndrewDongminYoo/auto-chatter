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
