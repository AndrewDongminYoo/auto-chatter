-- Apply through deploy/migrate-multi-user.sql.
-- Campaign runs and per-recipient delivery rows (#36). Starting a run writes pending rows only; nothing here
-- calls a provider, queues a message or writes an outbox row.
ALTER TABLE campaign_approvals DROP CONSTRAINT IF EXISTS campaign_approvals_status_check;
ALTER TABLE campaign_approvals ADD CONSTRAINT campaign_approvals_status_check
  CHECK(status IN ('approved','cancelled','executed'));
ALTER TABLE campaign_approvals DROP CONSTRAINT IF EXISTS campaign_approval_cancelled;
ALTER TABLE campaign_approvals ADD CONSTRAINT campaign_approval_cancelled CHECK(
  (status IN ('approved','executed') AND cancelled_by IS NULL AND cancelled_at IS NULL)
  OR (status='cancelled' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL));
-- When the campaign_start step last failed to start this approval; the step orders such approvals after the ones
-- that never failed, so failing approvals cannot hold back the others.
ALTER TABLE campaign_approvals ADD COLUMN IF NOT EXISTS start_failed_at timestamptz;
-- The campaign_start step reads approvals in force with no failed start first, then by due time: the scheduled
-- time, or the last schedule write (updated_at) of an immediate one.
CREATE INDEX IF NOT EXISTS campaign_approvals_due_idx
  ON campaign_approvals(start_failed_at NULLS FIRST,(coalesce(scheduled_at,updated_at)),id) WHERE status='approved';
-- One run per executed approval (#36): what was evaluated when the campaign_start step started it. The counts are
-- the preview's nine decimal strings at started_at, which is that evaluation's as_of; they are never recomputed.
CREATE TABLE IF NOT EXISTS campaign_runs (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  draft_version integer NOT NULL CHECK(draft_version>0),
  snapshot_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  start_counts jsonb NOT NULL CHECK(jsonb_typeof(start_counts)='object' AND start_counts ?& ARRAY[
    'original_member_count','remaining_member_count','connection_unavailable','contact_paused','no_dm_identity',
    'opted_out','marketing_consent_required','reply_window_closed','candidate']),
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','cancelled','completed')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  cancelled_by uuid,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  -- Approval IDs are client-supplied and unique only within a workspace.
  CONSTRAINT campaign_runs_approval UNIQUE(workspace_id,approval_id),
  FOREIGN KEY(workspace_id,approval_id) REFERENCES campaign_approvals(workspace_id,id),
  CONSTRAINT campaign_run_cancelled CHECK(
    (status IN ('running','completed') AND cancelled_by IS NULL AND cancelled_at IS NULL)
    OR (status='cancelled' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL))
);
-- One row per candidate member at the start: the comment sender and the DM recipient chosen for it. The start
-- writes only pending rows and a cancel only cancelled ones; the delivery worker (#36, PR 2) owns the others.
CREATE TABLE IF NOT EXISTS campaign_deliveries (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  sender_id text NOT NULL CHECK(length(btrim(sender_id))>0),
  recipient_id text NOT NULL CHECK(recipient_id ~ '^[0-9]{1,40}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','sending','sent','failed','blocked','unknown','cancelled')),
  attempt_id uuid,
  attempt_started_at timestamptz,
  failure_code text CHECK(failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  provider_message_id text CHECK(length(btrim(provider_message_id))>0),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  -- The duplicate key: one row per member of a run.
  CONSTRAINT campaign_deliveries_member UNIQUE(run_id,connection_id,sender_id),
  FOREIGN KEY(workspace_id,run_id) REFERENCES campaign_runs(workspace_id,id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id),
  -- A pending row holds no attempt; a row that reached the provider keeps the attempt that sent it.
  CONSTRAINT campaign_delivery_attempt CHECK(
    (status IN ('pending','cancelled') OR (attempt_id IS NOT NULL AND attempt_started_at IS NOT NULL))
    AND (status<>'pending' OR (attempt_id IS NULL AND attempt_started_at IS NULL))
    AND ((attempt_id IS NULL)=(attempt_started_at IS NULL))),
  CONSTRAINT campaign_delivery_sent CHECK(
    (status='sent')=(provider_message_id IS NOT NULL AND sent_at IS NOT NULL)
    AND (status='sent' OR (provider_message_id IS NULL AND sent_at IS NULL))),
  CONSTRAINT campaign_delivery_failure CHECK(status NOT IN ('failed','blocked') OR failure_code IS NOT NULL)
);
-- Connection and person deletion find a comment sender's or a DM recipient's rows in every run.
CREATE INDEX IF NOT EXISTS campaign_deliveries_sender_idx ON campaign_deliveries(workspace_id,connection_id,sender_id);
CREATE INDEX IF NOT EXISTS campaign_deliveries_recipient_idx
  ON campaign_deliveries(workspace_id,connection_id,recipient_id);

-- The three deletion functions as db/schema.sql defines them: each one now covers the campaign delivery rows,
-- and workspace deletion also removes the runs before the approvals.
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
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
  END;
  IF EXISTS(SELECT 1 FROM public.private_reply_outbox WHERE connection_id=p_connection AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_follow_conversations WHERE connection_id=p_connection AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_manual_replies WHERE connection_id=p_connection AND status='sending')
    OR EXISTS(SELECT 1 FROM public.webhook_deliveries WHERE connection_id=p_connection AND status='sending')
    OR EXISTS(SELECT 1 FROM public.campaign_deliveries WHERE workspace_id=p_workspace AND connection_id=p_connection AND status='sending')
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

    -- Lock the person's delivery rows before checking them. Workers claim with FOR UPDATE SKIP LOCKED,
    -- so a claim either committed first (and is seen as sending here) or skips these rows.
    PERFORM 1 FROM public.private_reply_outbox WHERE id=ANY(replies) FOR UPDATE;
    PERFORM 1 FROM public.instagram_follow_conversations
    WHERE connection_id=p_connection AND (reply_id=ANY(replies) OR recipient_id=ANY(recipients)) FOR UPDATE;
    PERFORM 1 FROM public.instagram_manual_replies
    WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients) FOR UPDATE;
    PERFORM 1 FROM public.webhook_deliveries WHERE event_id=ANY(deliveries) FOR UPDATE;
    -- Campaign rows refuse instead of waiting, like the connection and workspace deletions: a delivery being
    -- finalized may hold its row while it waits for a connection lock that conflicts with the one held here.
    BEGIN
      PERFORM 1 FROM public.campaign_deliveries WHERE workspace_id=p_workspace AND id=ANY(campaign_rows) ORDER BY id FOR UPDATE NOWAIT;
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
  -- A flow run whose reply or webhook delivery was queued after the rows were locked stays with it.
  DELETE FROM public.flow_step_runs step USING public.flow_runs run, public.instagram_comment_events event
  WHERE step.run_id=run.id AND event.id=run.event_id
    AND run.workspace_id=p_workspace AND run.connection_id=p_connection AND event.sender_id=ANY(senders)
    AND NOT EXISTS(SELECT 1 FROM public.private_reply_outbox reply WHERE reply.flow_run_id=run.id)
    AND NOT EXISTS(SELECT 1 FROM public.webhook_deliveries delivery WHERE delivery.flow_run_id=run.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_step_runs', affected);
  DELETE FROM public.flow_runs run USING public.instagram_comment_events event
  WHERE event.id=run.event_id
    AND run.workspace_id=p_workspace AND run.connection_id=p_connection AND event.sender_id=ANY(senders)
    AND NOT EXISTS(SELECT 1 FROM public.private_reply_outbox reply WHERE reply.flow_run_id=run.id)
    AND NOT EXISTS(SELECT 1 FROM public.webhook_deliveries delivery WHERE delivery.flow_run_id=run.id)
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
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
  END;
  IF EXISTS(SELECT 1 FROM public.private_reply_outbox WHERE workspace_id=p_workspace AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_follow_conversations WHERE connection_id=ANY(connections) AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_manual_replies WHERE workspace_id=p_workspace AND status='sending')
    OR EXISTS(SELECT 1 FROM public.webhook_deliveries WHERE workspace_id=p_workspace AND status='sending')
    OR EXISTS(SELECT 1 FROM public.campaign_deliveries WHERE workspace_id=p_workspace AND status='sending') THEN
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
