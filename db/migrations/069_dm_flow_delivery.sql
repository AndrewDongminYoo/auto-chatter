-- Apply through deploy/migrate-multi-user.sql.
-- DM start triggers, PR 2 (#291): the delivery state of flow_dm_deliveries, the messaging-ID automation pause
-- (instagram_dm_automation) and the deletion functions that lock sending DM flow rows and remove the pause. Every
-- stored flow_dm_deliveries row is pending and stays valid. The deletion functions are redefined whole.
-- DM flow delivery (#291): the Cloudflare queue consumer claims a pending row and sends it as one DM to the
-- messaging sender ID within 24 hours of that sender's latest inbound DM. The Node worker never reads these rows.
-- next_attempt_at: when a pending row may next be claimed; a deferred row stays pending with a later time.
-- rate_limit_retries: the rate-limited retries already spent, as in private_reply_outbox.
-- provider_called_at: set immediately before the provider send request. No hourly budget reads it.
-- updated_at: the last state change; operations health dates a row that stale recovery made unknown by it.
ALTER TABLE flow_dm_deliveries ADD COLUMN IF NOT EXISTS attempt_id uuid;
ALTER TABLE flow_dm_deliveries ADD COLUMN IF NOT EXISTS attempt_started_at timestamptz;
ALTER TABLE flow_dm_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE flow_dm_deliveries ADD COLUMN IF NOT EXISTS rate_limit_retries integer NOT NULL DEFAULT 0
  CHECK(rate_limit_retries>=0);
ALTER TABLE flow_dm_deliveries ADD COLUMN IF NOT EXISTS failure_code text
  CHECK(failure_code ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE flow_dm_deliveries ADD COLUMN IF NOT EXISTS provider_called_at timestamptz;
ALTER TABLE flow_dm_deliveries ADD COLUMN IF NOT EXISTS provider_message_id text
  CHECK(length(btrim(provider_message_id))>0);
ALTER TABLE flow_dm_deliveries ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE flow_dm_deliveries ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
-- Migration 068's unnamed status CHECK allowed pending only; every stored row is pending and stays valid.
ALTER TABLE flow_dm_deliveries DROP CONSTRAINT IF EXISTS flow_dm_deliveries_status_check;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flow_dm_deliveries'::regclass AND conname='flow_dm_delivery_status') THEN
    ALTER TABLE flow_dm_deliveries ADD CONSTRAINT flow_dm_delivery_status
      CHECK(status IN ('pending','sending','sent','failed','blocked','unknown'));
  END IF;
  -- A pending row holds no attempt; every other row was claimed and keeps the attempt that last held it.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flow_dm_deliveries'::regclass AND conname='flow_dm_delivery_attempt') THEN
    ALTER TABLE flow_dm_deliveries ADD CONSTRAINT flow_dm_delivery_attempt CHECK(
      (status='pending' OR (attempt_id IS NOT NULL AND attempt_started_at IS NOT NULL))
      AND (status<>'pending' OR (attempt_id IS NULL AND attempt_started_at IS NULL)));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flow_dm_deliveries'::regclass AND conname='flow_dm_delivery_sent') THEN
    ALTER TABLE flow_dm_deliveries ADD CONSTRAINT flow_dm_delivery_sent CHECK(
      (status='sent')=(provider_message_id IS NOT NULL AND sent_at IS NOT NULL)
      AND (status='sent' OR (provider_message_id IS NULL AND sent_at IS NULL)));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flow_dm_deliveries'::regclass AND conname='flow_dm_delivery_failure') THEN
    ALTER TABLE flow_dm_deliveries ADD CONSTRAINT flow_dm_delivery_failure
      CHECK(status NOT IN ('failed','blocked') OR failure_code IS NOT NULL);
  END IF;
END $$;
-- The claim and the wake read a connection's due pending rows, oldest first.
CREATE INDEX IF NOT EXISTS flow_dm_deliveries_due_idx
  ON flow_dm_deliveries(connection_id,next_attempt_at,created_at,id) WHERE status='pending';
-- Stale recovery reads the rows still in sending.
CREATE INDEX IF NOT EXISTS flow_dm_deliveries_sending_idx
  ON flow_dm_deliveries(attempt_started_at) WHERE status='sending';
-- The automation pause of one messaging sender ID (#291). A DM sender is an identity of its own, never linked to a
-- comment sender, so instagram_contact_automation (keyed by the comment sender) does not apply to it. The DM flow
-- delivery claim skips a paused recipient's rows and its final guard rechecks the pause. No API route or screen
-- sets it yet; the inbox work adds them. Deletion removes it by the dm_recipient identity.
CREATE TABLE IF NOT EXISTS instagram_dm_automation (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  recipient_id text NOT NULL CHECK(recipient_id ~ '^[0-9]{1,40}$'),
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,connection_id,recipient_id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);
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
    PERFORM 1 FROM public.webhook_deliveries WHERE connection_id=p_connection ORDER BY event_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.campaign_deliveries WHERE workspace_id=p_workspace AND connection_id=p_connection ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.flow_dm_deliveries WHERE workspace_id=p_workspace AND connection_id=p_connection ORDER BY id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
  END;
  IF EXISTS(SELECT 1 FROM public.private_reply_outbox WHERE connection_id=p_connection AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_follow_conversations WHERE connection_id=p_connection AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_manual_replies WHERE connection_id=p_connection AND status='sending')
    OR EXISTS(SELECT 1 FROM public.webhook_deliveries WHERE connection_id=p_connection AND status='sending')
    OR EXISTS(SELECT 1 FROM public.campaign_deliveries WHERE workspace_id=p_workspace AND connection_id=p_connection AND status='sending')
    OR EXISTS(SELECT 1 FROM public.flow_dm_deliveries WHERE workspace_id=p_workspace AND connection_id=p_connection AND status='sending')
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
  DELETE FROM public.instagram_inbox_conversation_events WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_conversation_events', affected);
  DELETE FROM public.instagram_inbox_conversations WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_conversations', affected);
  DELETE FROM public.instagram_inbox_read_state WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_read_state', affected);
  -- Label sets, their audit and internal notes; the workspace's label definitions stay.
  DELETE FROM public.instagram_inbox_label_events WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_label_events', affected);
  DELETE FROM public.instagram_inbox_conversation_labels WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_conversation_labels', affected);
  DELETE FROM public.instagram_inbox_notes WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_notes', affected);
  -- Every member's reminders on the connection's conversations and their audit.
  DELETE FROM public.instagram_inbox_reminder_events WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_reminder_events', affected);
  DELETE FROM public.instagram_inbox_reminders WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_reminders', affected);
  DELETE FROM public.instagram_inbox_handoff_events WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoff_events', affected);
  DELETE FROM public.instagram_inbox_handoffs WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoffs', affected);
  DELETE FROM public.instagram_inbox_messages WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_messages', affected);
  DELETE FROM public.instagram_unmatched_replies WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_unmatched_replies', affected);
  DELETE FROM public.instagram_contact_identity_links WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_identity_links', affected);
  DELETE FROM public.instagram_contact_identity_link_events WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_identity_link_events', affected);

  DELETE FROM public.instagram_contact_automation WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_automation', affected);
  DELETE FROM public.instagram_dm_automation WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_automation', affected);
  DELETE FROM public.instagram_contact_tags WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_tags', affected);
  DELETE FROM public.instagram_contact_field_values WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_field_values', affected);
  -- The connection's members of every target snapshot; the snapshots and their stored counts stay.
  DELETE FROM public.instagram_segment_snapshot_members WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_segment_snapshot_members', affected);
  -- The connection's campaign delivery rows; the runs and their stored start counts stay.
  DELETE FROM public.campaign_deliveries WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('campaign_deliveries', affected);
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
  -- Webhook deliveries point at the flow runs deleted next; their redelivery audit goes first.
  DELETE FROM public.webhook_redelivery_events WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('webhook_redelivery_events', affected);
  DELETE FROM public.webhook_deliveries WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('webhook_deliveries', affected);
  -- The first-message rows of DM-started runs point at the runs; the DM start events go after the runs.
  DELETE FROM public.flow_dm_deliveries WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_dm_deliveries', affected);
  DELETE FROM public.flow_step_runs WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_step_runs', affected);
  DELETE FROM public.flow_runs WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_runs', affected);
  DELETE FROM public.instagram_dm_start_events WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_start_events', affected);
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
  deliveries uuid[];
  campaign_rows uuid[];
  dm_rows uuid[];
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
    -- Webhook deliveries are keyed by the comment sender of the flow run that queued them.
    SELECT coalesce(array_agg(event_id), '{}') INTO deliveries FROM public.webhook_deliveries
    WHERE workspace_id=p_workspace AND connection_id=p_connection AND sender_id=ANY(senders);
    -- Campaign delivery rows name both the comment sender and the DM recipient chosen for it.
    SELECT coalesce(array_agg(id), '{}') INTO campaign_rows FROM public.campaign_deliveries
    WHERE workspace_id=p_workspace AND connection_id=p_connection
      AND (sender_id=ANY(senders) OR recipient_id=ANY(recipients));
    -- DM flow delivery rows are keyed by the messaging sender ID.
    SELECT coalesce(array_agg(id), '{}') INTO dm_rows FROM public.flow_dm_deliveries
    WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);

    -- Lock the person's delivery rows before checking them. Workers claim with FOR UPDATE SKIP LOCKED,
    -- so a claim either committed first (and is seen as sending here) or skips these rows.
    PERFORM 1 FROM public.private_reply_outbox WHERE id=ANY(replies) FOR UPDATE;
    PERFORM 1 FROM public.instagram_follow_conversations
    WHERE connection_id=p_connection AND (reply_id=ANY(replies) OR recipient_id=ANY(recipients)) FOR UPDATE;
    PERFORM 1 FROM public.instagram_manual_replies
    WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients) FOR UPDATE;
    PERFORM 1 FROM public.webhook_deliveries WHERE event_id=ANY(deliveries) FOR UPDATE;
    -- Campaign and DM flow rows refuse instead of waiting, like the connection and workspace deletions: a delivery
    -- being finalized may hold its row while it waits for a connection lock that conflicts with the one held here.
    BEGIN
      PERFORM 1 FROM public.campaign_deliveries WHERE workspace_id=p_workspace AND id=ANY(campaign_rows) ORDER BY id FOR UPDATE NOWAIT;
      PERFORM 1 FROM public.flow_dm_deliveries WHERE id=ANY(dm_rows) ORDER BY id FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
    END;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.private_reply_outbox WHERE id=ANY(replies) AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_follow_conversations
      WHERE connection_id=p_connection AND status='sending' AND (reply_id=ANY(replies) OR recipient_id=ANY(recipients)))
    OR EXISTS(SELECT 1 FROM public.instagram_manual_replies
      WHERE workspace_id=p_workspace AND connection_id=p_connection AND status='sending' AND recipient_id=ANY(recipients))
    OR EXISTS(SELECT 1 FROM public.webhook_deliveries WHERE event_id=ANY(deliveries) AND status='sending')
    OR EXISTS(SELECT 1 FROM public.campaign_deliveries
      WHERE workspace_id=p_workspace AND id=ANY(campaign_rows) AND status='sending')
    OR EXISTS(SELECT 1 FROM public.flow_dm_deliveries WHERE id=ANY(dm_rows) AND status='sending')
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
  -- Conversation status and assignment are keyed by the DM recipient, like the inbox.
  DELETE FROM public.instagram_inbox_conversation_events
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_conversation_events', affected);
  DELETE FROM public.instagram_inbox_conversations
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_conversations', affected);
  -- Every member's read position of the person's conversations, keyed by the DM recipient like the inbox.
  DELETE FROM public.instagram_inbox_read_state
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_read_state', affected);
  -- The person's label sets, their audit and internal notes, keyed by the DM recipient like the inbox.
  DELETE FROM public.instagram_inbox_label_events
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_label_events', affected);
  DELETE FROM public.instagram_inbox_conversation_labels
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_conversation_labels', affected);
  DELETE FROM public.instagram_inbox_notes
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_notes', affected);
  -- Every member's reminders on the person's conversations and their audit, keyed by the DM recipient.
  DELETE FROM public.instagram_inbox_reminder_events
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_reminder_events', affected);
  DELETE FROM public.instagram_inbox_reminders
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_reminders', affected);
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
  -- A kept DM's sender is the DM recipient a reply reaches, so it is keyed like the inbox.
  DELETE FROM public.instagram_unmatched_replies
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND sender_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_unmatched_replies', affected);
  DELETE FROM public.instagram_contact_identity_links WHERE workspace_id=p_workspace AND connection_id=p_connection AND (sender_id=ANY(senders) OR recipient_id=ANY(recipients) OR last_event_id IN (SELECT id FROM public.instagram_contact_identity_link_events WHERE workspace_id=p_workspace AND connection_id=p_connection AND (sender_id=ANY(senders) OR previous_sender_id=ANY(senders) OR recipient_id=ANY(recipients))));
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_identity_links', affected);
  DELETE FROM public.instagram_contact_identity_link_events WHERE workspace_id=p_workspace AND connection_id=p_connection AND (sender_id=ANY(senders) OR previous_sender_id=ANY(senders) OR recipient_id=ANY(recipients));
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_identity_link_events', affected);

  DELETE FROM public.instagram_contact_automation
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND sender_id=ANY(senders);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_automation', affected);
  -- The automation pause of a messaging sender ID, keyed like the inbox.
  DELETE FROM public.instagram_dm_automation
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_automation', affected);
  DELETE FROM public.instagram_contact_tags
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND sender_id=ANY(senders);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_tags', affected);
  DELETE FROM public.instagram_contact_field_values
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND sender_id=ANY(senders);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_field_values', affected);
  -- The person's member rows of every target snapshot, keyed by the comment sender; the stored counts stay.
  DELETE FROM public.instagram_segment_snapshot_members
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND sender_id=ANY(senders);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_segment_snapshot_members', affected);
  -- The person's campaign delivery rows that were locked above; the runs and their start counts stay.
  DELETE FROM public.campaign_deliveries WHERE workspace_id=p_workspace AND id=ANY(campaign_rows);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('campaign_deliveries', affected);
  DELETE FROM public.instagram_follow_conversations
  WHERE connection_id=p_connection AND (reply_id=ANY(replies) OR recipient_id=ANY(recipients));
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_follow_conversations', affected);
  DELETE FROM public.private_reply_outbox WHERE id=ANY(replies);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('private_reply_outbox', affected);
  -- The person's webhook deliveries that were locked above, and their redelivery audit.
  DELETE FROM public.webhook_redelivery_events WHERE delivery_event_id=ANY(deliveries);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('webhook_redelivery_events', affected);
  DELETE FROM public.webhook_deliveries WHERE event_id=ANY(deliveries);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('webhook_deliveries', affected);
  -- The first-message rows of runs a DM started, keyed by the messaging sender ID like the inbox.
  DELETE FROM public.flow_dm_deliveries
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_dm_deliveries', affected);
  -- A flow run belongs to the person through its comment sender or, for a run a DM started, its messaging
  -- sender ID. A run whose reply or webhook delivery was queued after the rows were locked stays with it.
  DELETE FROM public.flow_step_runs step USING public.flow_runs run
  WHERE step.run_id=run.id AND run.workspace_id=p_workspace AND run.connection_id=p_connection
    AND (EXISTS(SELECT 1 FROM public.instagram_comment_events event
        WHERE event.id=run.event_id AND event.sender_id=ANY(senders))
      OR EXISTS(SELECT 1 FROM public.instagram_dm_start_events start
        WHERE start.id=run.dm_start_event_id AND start.sender_id=ANY(recipients)))
    AND NOT EXISTS(SELECT 1 FROM public.private_reply_outbox reply WHERE reply.flow_run_id=run.id)
    AND NOT EXISTS(SELECT 1 FROM public.webhook_deliveries delivery WHERE delivery.flow_run_id=run.id)
    AND NOT EXISTS(SELECT 1 FROM public.flow_dm_deliveries dm WHERE dm.flow_run_id=run.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_step_runs', affected);
  DELETE FROM public.flow_runs run
  WHERE run.workspace_id=p_workspace AND run.connection_id=p_connection
    AND (EXISTS(SELECT 1 FROM public.instagram_comment_events event
        WHERE event.id=run.event_id AND event.sender_id=ANY(senders))
      OR EXISTS(SELECT 1 FROM public.instagram_dm_start_events start
        WHERE start.id=run.dm_start_event_id AND start.sender_id=ANY(recipients)))
    AND NOT EXISTS(SELECT 1 FROM public.private_reply_outbox reply WHERE reply.flow_run_id=run.id)
    AND NOT EXISTS(SELECT 1 FROM public.webhook_deliveries delivery WHERE delivery.flow_run_id=run.id)
    AND NOT EXISTS(SELECT 1 FROM public.flow_dm_deliveries dm WHERE dm.flow_run_id=run.id)
    AND NOT EXISTS(SELECT 1 FROM public.flow_step_runs step WHERE step.run_id=run.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_runs', affected);
  DELETE FROM public.instagram_dm_start_events start
  WHERE start.workspace_id=p_workspace AND start.connection_id=p_connection AND start.sender_id=ANY(recipients)
    AND NOT EXISTS(SELECT 1 FROM public.flow_runs run WHERE run.dm_start_event_id=start.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_start_events', affected);
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
CREATE OR REPLACE FUNCTION public.delete_workspace_data(p_workspace uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  connections uuid[];
  members uuid[];
  owner uuid;
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
    PERFORM 1 FROM public.webhook_deliveries WHERE workspace_id=p_workspace ORDER BY event_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.campaign_deliveries WHERE workspace_id=p_workspace ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.flow_dm_deliveries WHERE workspace_id=p_workspace ORDER BY id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
  END;
  IF EXISTS(SELECT 1 FROM public.private_reply_outbox WHERE workspace_id=p_workspace AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_follow_conversations WHERE connection_id=ANY(connections) AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_manual_replies WHERE workspace_id=p_workspace AND status='sending')
    OR EXISTS(SELECT 1 FROM public.webhook_deliveries WHERE workspace_id=p_workspace AND status='sending')
    OR EXISTS(SELECT 1 FROM public.campaign_deliveries WHERE workspace_id=p_workspace AND status='sending')
    OR EXISTS(SELECT 1 FROM public.flow_dm_deliveries WHERE workspace_id=p_workspace AND status='sending') THEN
    RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
  END IF;
  SELECT coalesce(array_agg(user_id ORDER BY user_id), '{}') INTO members
  FROM public.workspace_members WHERE workspace_id=p_workspace;
  -- Only the requesting owner's login is deleted afterwards; other members just lose the workspace.
  SELECT user_id INTO owner FROM public.workspace_members
  WHERE workspace_id=p_workspace AND role='owner' AND removed_at IS NULL;

  -- Children before parents, following the foreign keys; this function body owns the order the multi-user cutover note refers to.
  DELETE FROM public.instagram_manual_reply_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_manual_reply_events', affected);
  DELETE FROM public.instagram_manual_replies WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_manual_replies', affected);
  DELETE FROM public.instagram_inbox_conversation_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_conversation_events', affected);
  DELETE FROM public.instagram_inbox_conversations WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_conversations', affected);
  DELETE FROM public.instagram_inbox_read_state WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_read_state', affected);
  DELETE FROM public.instagram_inbox_label_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_label_events', affected);
  DELETE FROM public.instagram_inbox_conversation_labels WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_conversation_labels', affected);
  DELETE FROM public.instagram_inbox_notes WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_notes', affected);
  DELETE FROM public.instagram_inbox_reminder_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_reminder_events', affected);
  DELETE FROM public.instagram_inbox_reminders WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_reminders', affected);
  DELETE FROM public.workspace_reply_templates WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('workspace_reply_templates', affected);
  -- Keyword rules follow the label events that name them and precede the labels they add.
  DELETE FROM public.instagram_inbox_label_rules WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_label_rules', affected);
  DELETE FROM public.instagram_inbox_labels WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_labels', affected);
  DELETE FROM public.instagram_inbox_handoff_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoff_events', affected);
  DELETE FROM public.instagram_inbox_handoffs WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoffs', affected);
  DELETE FROM public.instagram_inbox_messages WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_messages', affected);
  DELETE FROM public.instagram_unmatched_replies WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_unmatched_replies', affected);
  DELETE FROM public.instagram_contact_identity_links WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_identity_links', affected);
  DELETE FROM public.instagram_contact_identity_link_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_identity_link_events', affected);

  DELETE FROM public.instagram_contact_automation WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_automation', affected);
  DELETE FROM public.instagram_dm_automation WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_automation', affected);
  DELETE FROM public.instagram_contact_tags WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_tags', affected);
  DELETE FROM public.instagram_contact_field_values WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_field_values', affected);
  -- Target snapshot members, then the snapshots, before the segments they point at.
  DELETE FROM public.instagram_segment_snapshot_members WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_segment_snapshot_members', affected);
  -- Campaign delivery rows point at their runs, and the runs at the approvals, so both go before the approvals.
  DELETE FROM public.campaign_deliveries WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('campaign_deliveries', affected);
  DELETE FROM public.campaign_runs WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('campaign_runs', affected);
  -- Campaign approvals and their audit point at the drafts and snapshots, so they go first.
  DELETE FROM public.campaign_approval_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('campaign_approval_events', affected);
  DELETE FROM public.campaign_approvals WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('campaign_approvals', affected);
  DELETE FROM public.campaign_drafts WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('campaign_drafts', affected);
  DELETE FROM public.instagram_segment_snapshots WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_segment_snapshots', affected);
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
  -- Webhook deliveries point at flow runs, flows and endpoints, so they and their audit go first.
  DELETE FROM public.webhook_redelivery_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('webhook_redelivery_events', affected);
  DELETE FROM public.webhook_deliveries WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('webhook_deliveries', affected);
  DELETE FROM public.webhook_signing_keys WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('webhook_signing_keys', affected);
  DELETE FROM public.webhook_endpoints WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('webhook_endpoints', affected);
  -- Flow runs follow the replies that point at them and precede the versions they are pinned to.
  DELETE FROM public.flow_dm_deliveries WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_dm_deliveries', affected);
  DELETE FROM public.flow_step_runs WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_step_runs', affected);
  DELETE FROM public.flow_runs WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_runs', affected);
  -- DM start events point at the flow versions deleted next.
  DELETE FROM public.instagram_dm_start_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_start_events', affected);
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
  DELETE FROM public.workspace_invites WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('workspace_invites', affected);
  DELETE FROM public.workspace_members WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('workspace_members', affected);
  DELETE FROM public.workspaces WHERE id=p_workspace;

  INSERT INTO public.workspace_deletion_records(workspace_id,requested_by,deleted_counts)
  VALUES(p_workspace,p_actor,deleted)
  RETURNING * INTO saved;
  -- The owner ID is the one Auth user the administrator deletes; member IDs are informational. Neither is stored.
  RETURN jsonb_build_object(
    'id', saved.id,
    'completed_at', saved.completed_at,
    'deleted_counts', saved.deleted_counts,
    'member_user_ids', to_jsonb(members),
    'owner_user_id', owner
  );
END $$;
REVOKE ALL ON FUNCTION public.delete_workspace_data(uuid,uuid) FROM PUBLIC;
