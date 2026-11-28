-- Apply through deploy/migrate-multi-user.sql before deploying the code that starts flows with an API key (#48,
-- docs/specs/2026-11-28-public-flow-start-design.md). The running code does not name the new tables or the new
-- flow_runs column, issues only the scopes the old CHECK admits, and writes runs with one source, so it keeps working
-- between this migration and the deploy. The three deletion functions are redefined whole to delete the external
-- starts with their connection, person or workspace, and the request keys with the workspace only.
-- A key always reads contacts, and may also write contacts and start flows (migrations 081 and 082):
-- {contacts:read}, {contacts:read,contacts:write}, {contacts:read,flows:start} or
-- {contacts:read,contacts:write,flows:start}, stored in this order. A write key always reads too, because a write
-- answers with the written contact.
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check
  CHECK(scopes = ARRAY['contacts:read']::text[] OR scopes = ARRAY['contacts:read','contacts:write']::text[]
    OR scopes = ARRAY['contacts:read','flows:start']::text[]
    OR scopes = ARRAY['contacts:read','contacts:write','flows:start']::text[]);
-- External flow starts (#48, docs/specs/2026-11-28-public-flow-start-design.md, migration 082). An API key with the
-- flows:start scope starts one published DM flow for one comment contact. flow_api_start_keys keeps every accepted
-- request key and the SHA-256 hex of its request, with no personal data and no connection, so a deletion of the
-- person or the connection never lets the same key start again; only delete_workspace_data deletes it. Those two
-- deletions set the hash of their starts' keys to 64 zeros, the unlinked marker that no request produces.
-- flow_api_starts is one accepted start: the comment contact (connection_id, sender_id), the verified DM recipient
-- chosen for it, the flow, the pinned version and the key. A refused request writes neither row. Server roles may only
-- SELECT and INSERT both tables.
CREATE TABLE IF NOT EXISTS flow_api_start_keys (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,request_key)
);
CREATE TABLE IF NOT EXISTS flow_api_starts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  sender_id text NOT NULL CHECK(length(btrim(sender_id))>0),
  recipient_id text NOT NULL CHECK(recipient_id ~ '^[0-9]{1,40}$'),
  flow_id uuid NOT NULL,
  flow_version_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,request_key),
  UNIQUE(id,connection_id,workspace_id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id),
  FOREIGN KEY(flow_id,workspace_id) REFERENCES flows(id,workspace_id),
  FOREIGN KEY(flow_version_id,flow_id) REFERENCES flow_versions(id,flow_id),
  FOREIGN KEY(api_key_id,workspace_id) REFERENCES api_keys(id,workspace_id),
  FOREIGN KEY(workspace_id,request_key) REFERENCES flow_api_start_keys(workspace_id,request_key)
);
-- The DM start limits (dmStartSkipCodeSql) count these rows by recipient and by connection, and the person data
-- deletion finds them by comment sender.
CREATE INDEX IF NOT EXISTS flow_api_starts_recipient_idx ON flow_api_starts(connection_id,recipient_id,created_at);
CREATE INDEX IF NOT EXISTS flow_api_starts_connection_idx ON flow_api_starts(connection_id,created_at);
CREATE INDEX IF NOT EXISTS flow_api_starts_sender_idx ON flow_api_starts(workspace_id,connection_id,sender_id);
-- A run starts from exactly one source: a comment event, a DM start event or an external start, with one run per
-- flow and source.
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS api_start_id uuid;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flow_runs'::regclass AND conname='flow_runs_api_start') THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_api_start
      FOREIGN KEY(api_start_id,connection_id,workspace_id) REFERENCES flow_api_starts(id,connection_id,workspace_id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flow_runs'::regclass AND conname='flow_runs_api_start_unique') THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_api_start_unique UNIQUE(flow_id,api_start_id);
  END IF;
END $$;
ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_source;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_source CHECK(num_nonnulls(event_id,dm_start_event_id,api_start_id)=1);
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
  DELETE FROM public.instagram_message_reads WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_message_reads', affected);
  DELETE FROM public.instagram_dm_last_inbound WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_last_inbound', affected);
  DELETE FROM public.instagram_dm_profiles WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_profiles', affected);
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
  -- Follow reply message IDs reference the follow rows, so they go first.
  DELETE FROM public.instagram_follow_messages WHERE connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_follow_messages', affected);
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
  -- External starts go after their runs; their request keys stay, so the same key never starts again. Each kept
  -- key's request hash becomes 64 zeros, which no SHA-256 of a request produces, so no deleted sender ID can be
  -- tested against it, and a replay of the key still answers idempotency_conflict.
  UPDATE public.flow_api_start_keys k SET request_hash=repeat('0',64)
  FROM public.flow_api_starts start
  WHERE start.workspace_id=p_workspace AND start.connection_id=p_connection
    AND k.workspace_id=start.workspace_id AND k.request_key=start.request_key;
  DELETE FROM public.flow_api_starts WHERE workspace_id=p_workspace AND connection_id=p_connection;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_api_starts', affected);
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

  -- The connection's active contact rows stay for their months; only the person key is removed. The record counts the
  -- rows this run cleared.
  UPDATE public.active_contacts SET person_key=NULL
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND person_key IS NOT NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;

  retained := jsonb_build_object(
    'active_contacts', affected,
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
    -- DM flow delivery rows are keyed by the messaging sender ID; the first message of an external start also
    -- belongs to the comment sender that start names.
    SELECT coalesce(array_agg(dm.id), '{}') INTO dm_rows FROM public.flow_dm_deliveries dm
    WHERE dm.workspace_id=p_workspace AND dm.connection_id=p_connection
      AND (dm.recipient_id=ANY(recipients)
        OR EXISTS(SELECT 1 FROM public.flow_runs run JOIN public.flow_api_starts start ON start.id=run.api_start_id
          WHERE run.id=dm.flow_run_id AND start.sender_id=ANY(senders)));

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
  -- The person's reads of messages the service sent, keyed by the reader's messaging sender ID like the inbox.
  DELETE FROM public.instagram_message_reads
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_message_reads', affected);
  -- The time of the person's latest inbound text DM, keyed by the messaging sender ID like the inbox.
  DELETE FROM public.instagram_dm_last_inbound
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_last_inbound', affected);
  -- The person's Instagram profile username, keyed by the messaging sender ID like the inbox.
  DELETE FROM public.instagram_dm_profiles
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND recipient_id=ANY(recipients);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_profiles', affected);
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
  -- The message IDs of the person's follow replies, which reference the follow rows locked above.
  DELETE FROM public.instagram_follow_messages
  WHERE reply_id IN(SELECT reply_id FROM public.instagram_follow_conversations
    WHERE connection_id=p_connection AND (reply_id=ANY(replies) OR recipient_id=ANY(recipients)));
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_follow_messages', affected);
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
  -- The first-message rows of runs a DM started, keyed by the messaging sender ID like the inbox, and those of the
  -- person's external starts that were locked above.
  DELETE FROM public.flow_dm_deliveries
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND (recipient_id=ANY(recipients) OR id=ANY(dm_rows));
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_dm_deliveries', affected);
  -- A flow run belongs to the person through its comment sender, for a run a DM started its messaging sender ID,
  -- and for an external start either the comment sender or the DM recipient it names. A run whose reply or webhook delivery was queued after the rows were locked stays with it.
  DELETE FROM public.flow_step_runs step USING public.flow_runs run
  WHERE step.run_id=run.id AND run.workspace_id=p_workspace AND run.connection_id=p_connection
    AND (EXISTS(SELECT 1 FROM public.instagram_comment_events event
        WHERE event.id=run.event_id AND event.sender_id=ANY(senders))
      OR EXISTS(SELECT 1 FROM public.instagram_dm_start_events start
        WHERE start.id=run.dm_start_event_id AND start.sender_id=ANY(recipients))
      OR EXISTS(SELECT 1 FROM public.flow_api_starts start
        WHERE start.id=run.api_start_id AND (start.sender_id=ANY(senders) OR start.recipient_id=ANY(recipients))))
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
        WHERE start.id=run.dm_start_event_id AND start.sender_id=ANY(recipients))
      OR EXISTS(SELECT 1 FROM public.flow_api_starts start
        WHERE start.id=run.api_start_id AND (start.sender_id=ANY(senders) OR start.recipient_id=ANY(recipients))))
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
  -- The person's external starts go after their runs; the request keys stay, so the same key never starts again.
  -- Each kept key's request hash becomes 64 zeros first, as in connection deletion, so the hash no longer ties the
  -- key to the person.
  UPDATE public.flow_api_start_keys k SET request_hash=repeat('0',64)
  FROM public.flow_api_starts start
  WHERE start.workspace_id=p_workspace AND start.connection_id=p_connection
    AND (start.sender_id=ANY(senders) OR start.recipient_id=ANY(recipients))
    AND NOT EXISTS(SELECT 1 FROM public.flow_runs run WHERE run.api_start_id=start.id)
    AND k.workspace_id=start.workspace_id AND k.request_key=start.request_key;
  DELETE FROM public.flow_api_starts start
  WHERE start.workspace_id=p_workspace AND start.connection_id=p_connection
    AND (start.sender_id=ANY(senders) OR start.recipient_id=ANY(recipients))
    AND NOT EXISTS(SELECT 1 FROM public.flow_runs run WHERE run.api_start_id=start.id);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_api_starts', affected);
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

  -- The person's active contact rows stay for their months; only the person key is removed. A row keyed by a linked
  -- comment sender is the comment sender's row and is cleared when that sender is in the person's identity set. The
  -- record counts the rows this run cleared.
  UPDATE public.active_contacts SET person_key=NULL
  WHERE workspace_id=p_workspace AND connection_id=p_connection
    AND ((person_key_kind='comment_sender' AND person_key=ANY(senders))
      OR (person_key_kind='dm_recipient' AND person_key=ANY(recipients)));
  GET DIAGNOSTICS affected = ROW_COUNT;

  retained := jsonb_build_object(
    'active_contacts', affected,
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
  DELETE FROM public.instagram_message_reads WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_message_reads', affected);
  DELETE FROM public.instagram_dm_last_inbound WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_last_inbound', affected);
  DELETE FROM public.instagram_dm_profiles WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_dm_profiles', affected);
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
  DELETE FROM public.instagram_follow_messages WHERE connection_id=ANY(connections);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_follow_messages', affected);
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
  -- External starts point at the flow versions and the API keys deleted later, and at their request keys.
  DELETE FROM public.flow_api_starts WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_api_starts', affected);
  DELETE FROM public.flow_api_start_keys WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_api_start_keys', affected);
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
  -- API key audit points at the keys.
  DELETE FROM public.api_key_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('api_key_events', affected);
  DELETE FROM public.api_keys WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('api_keys', affected);
  DELETE FROM public.workspace_invites WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('workspace_invites', affected);
  DELETE FROM public.workspace_members WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('workspace_members', affected);
  DELETE FROM public.workspaces WHERE id=p_workspace;
  -- The workspace's active contact rows have no foreign key and stay for their months without a person key.
  UPDATE public.active_contacts SET person_key=NULL WHERE workspace_id=p_workspace AND person_key IS NOT NULL;

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
