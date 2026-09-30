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

-- The deletion functions now remove flow run history with the rows it points at.
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
  WHERE id=p_connection AND workspace_id=p_workspace FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection_not_found' USING ERRCODE='AC001';
  END IF;
  IF target.account_id IS DISTINCT FROM p_confirm_account_id THEN
    RAISE EXCEPTION 'confirmation_mismatch' USING ERRCODE='AC004';
  END IF;
  IF target.active OR target.send_enabled OR target.access_token_encrypted IS NOT NULL THEN
    RAISE EXCEPTION 'connection_active' USING ERRCODE='AC002';
  END IF;
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
  -- Lock the delivery rows first: an uncommitted claim would otherwise still read as pending here,
  -- and the DELETE below would remove the row after the claim commits it as sending.
  PERFORM 1 FROM public.private_reply_outbox WHERE workspace_id=p_workspace ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.instagram_follow_conversations WHERE connection_id=ANY(connections) ORDER BY reply_id FOR UPDATE;
  PERFORM 1 FROM public.instagram_manual_replies WHERE workspace_id=p_workspace ORDER BY id FOR UPDATE;
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
