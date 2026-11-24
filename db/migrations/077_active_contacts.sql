-- Apply through deploy/migrate-multi-user.sql, then deploy the code that records comments and inbound DMs in
-- active_contacts, then run deploy/backfill-active-contacts.sql once. The triggers below record sends from this
-- migration on; the running code does not name the table, so it keeps working between this migration and the deploy.
-- This migration writes no ledger rows: the runner replays it on every later rollout, and a backfill here would record
-- old activity again under the identity links and time zone of that rollout. The deletion functions are redefined whole
-- to clear the person key of the ledger rows in their scope.
-- The billing-month active contact ledger (#51, docs/specs/2026-11-24-active-contact-ledger-design.md). One row per
-- workspace, billing month, connection and person key: the first recorded message exchanged with that person in that
-- month. billing_month is the first day of the calendar month of the activity time in the workspace time zone that was
-- in force when the row was written (time_zone); a later time zone change moves no row. The person key is the comment
-- sender ID, or the DM recipient ID, or for a DM recipient with a currently valid confirmed identity link at write time
-- the linked comment sender ID; it is fixed at write time. first_activity_at and activity_kind belong to the activity
-- that created the row (ON CONFLICT DO NOTHING), not always the earliest one. There are no foreign keys: the deletion
-- functions set person_key to NULL and keep the row, so the month count stays and no Instagram ID remains, and the
-- default NULLS DISTINCT keeps a NULL key from colliding with a later row. Server roles may only SELECT and INSERT.
CREATE TABLE IF NOT EXISTS active_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  billing_month date NOT NULL CHECK(billing_month=date_trunc('month',billing_month)::date),
  connection_id uuid NOT NULL,
  person_key_kind text NOT NULL CHECK(person_key_kind IN ('comment_sender','dm_recipient')),
  person_key text CHECK(person_key IS NULL OR length(btrim(person_key))>0),
  first_activity_at timestamptz NOT NULL,
  activity_kind text NOT NULL CHECK(activity_kind IN
    ('comment','dm_received','private_reply','follow_message','manual_reply','campaign','flow_dm')),
  time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 255),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT active_contacts_person UNIQUE(workspace_id,billing_month,connection_id,person_key_kind,person_key)
);
-- The deletion functions find one person's or one connection's rows in every month.
CREATE INDEX IF NOT EXISTS active_contacts_person_idx
  ON active_contacts(workspace_id,connection_id,person_key_kind,person_key) WHERE person_key IS NOT NULL;

-- The comment sender that a currently valid confirmed identity link names for a DM recipient, or NULL. "Currently
-- valid" is the inbox rule (verifiedDmRecipientsSql in src/app/inbox-identity.ts; keep the two in step): the link is
-- confirmed, its recipient has a stored inbox message, every provider-acknowledged reply to the recipient names one
-- comment sender (the linked one), at least one of them was sent after the inbox was enabled, and the newest such fresh
-- reply is the link's evidence. The link primary key is probed first, so a recipient without a link reads nothing else.
CREATE OR REPLACE FUNCTION public.active_contact_linked_sender(p_workspace uuid, p_connection uuid, p_recipient text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT link.sender_id
  FROM public.instagram_contact_identity_links link
  JOIN public.instagram_connections owned ON owned.id=link.connection_id AND owned.workspace_id=link.workspace_id
  WHERE link.workspace_id=p_workspace AND link.connection_id=p_connection AND link.recipient_id=p_recipient
    AND link.state='confirmed'
    AND EXISTS(SELECT 1 FROM public.instagram_inbox_messages message WHERE message.workspace_id=link.workspace_id
      AND message.connection_id=link.connection_id AND message.recipient_id=link.recipient_id)
    AND coalesce((
      SELECT count(DISTINCT reply.sender_id)=1 AND min(reply.sender_id)=link.sender_id
        AND bool_or(reply.sent_at>=owned.inbox_enabled_at)
        AND (array_agg(reply.id::text ORDER BY reply.sent_at DESC,reply.id DESC)
          FILTER (WHERE reply.sent_at>=owned.inbox_enabled_at))[1]=link.evidence_reply_id::text
      FROM public.private_reply_outbox reply
      JOIN public.instagram_comment_events event ON event.id=reply.event_id AND event.connection_id=reply.connection_id
        AND event.workspace_id=reply.workspace_id AND event.sender_id=reply.sender_id
      WHERE reply.workspace_id=link.workspace_id AND reply.connection_id=link.connection_id
        AND reply.recipient_id=link.recipient_id AND reply.status='sent'
        AND length(btrim(reply.provider_message_id))>0 AND reply.sent_at<=now()
    ),false)
$$;

-- Whether AT TIME ZONE accepts the zone. The API stores only pg_timezone_names names, but that list can change, and
-- reading pg_timezone_names costs tens of milliseconds, too much for every send; an unknown zone raises 22023, which
-- this catches. The exception block writes nothing, so it is assigned no transaction ID.
CREATE OR REPLACE FUNCTION public.active_contact_time_zone_valid(p_time_zone text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM now() AT TIME ZONE p_time_zone;
  RETURN true;
EXCEPTION WHEN invalid_parameter_value THEN
  RETURN false;
END $$;

-- Records activities in the ledger: the arrays hold one activity each (workspace, connection, identity kind, identity,
-- activity time, activity kind). It resolves the person key, takes the billing month from the workspace's current
-- time zone, skips the activities of a workspace whose zone AT TIME ZONE rejects (so one such workspace does not drop
-- the other workspaces' rows of the same call), keeps the earliest activity of each key in this call and writes the rows in key order with
-- ON CONFLICT DO NOTHING, so a repeated, redelivered or older activity changes no stored row. The send triggers below,
-- the comment ingestion in src/instagram/store.ts and the inbound DM path in src/instagram/follow-flow.ts call it; each
-- catches its errors, so the ledger never fails the source write.
CREATE OR REPLACE FUNCTION public.record_active_contacts(
  p_workspaces uuid[],
  p_connections uuid[],
  p_identity_kinds text[],
  p_identities text[],
  p_activity_times timestamptz[],
  p_activity_kinds text[]
)
RETURNS void
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.active_contacts(workspace_id,billing_month,connection_id,person_key_kind,person_key,
    first_activity_at,activity_kind,time_zone)
  SELECT DISTINCT ON (keyed.workspace_id,keyed.billing_month,keyed.connection_id,keyed.person_key_kind,keyed.person_key)
    keyed.workspace_id,keyed.billing_month,keyed.connection_id,keyed.person_key_kind,keyed.person_key,
    keyed.activity_at,keyed.activity_kind,keyed.time_zone
  FROM (
    SELECT activity.workspace_id,activity.connection_id,activity.activity_at,activity.activity_kind,workspace.time_zone,
      CASE WHEN public.active_contact_time_zone_valid(workspace.time_zone)
        THEN date_trunc('month',activity.activity_at AT TIME ZONE workspace.time_zone)::date END AS billing_month,
      CASE WHEN linked.sender_id IS NULL THEN activity.identity_kind ELSE 'comment_sender' END AS person_key_kind,
      coalesce(linked.sender_id,activity.identity) AS person_key
    FROM unnest(p_workspaces,p_connections,p_identity_kinds,p_identities,p_activity_times,p_activity_kinds)
      AS activity(workspace_id,connection_id,identity_kind,identity,activity_at,activity_kind)
    JOIN public.workspaces workspace ON workspace.id=activity.workspace_id
    LEFT JOIN LATERAL (
      SELECT public.active_contact_linked_sender(activity.workspace_id,activity.connection_id,activity.identity) AS sender_id
      WHERE activity.identity_kind='dm_recipient'
    ) linked ON true
  ) keyed
  WHERE keyed.billing_month IS NOT NULL
  ORDER BY keyed.workspace_id,keyed.billing_month,keyed.connection_id,keyed.person_key_kind,keyed.person_key,
    keyed.activity_at
  ON CONFLICT ON CONSTRAINT active_contacts_person DO NOTHING
$$;

-- Only the server roles execute the three ledger functions (deploy/supabase-access.sql); the API roles never do.
REVOKE ALL ON FUNCTION public.active_contact_linked_sender(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.active_contact_time_zone_valid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_active_contacts(uuid[],uuid[],text[],text[],timestamptz[],text[]) FROM PUBLIC;
-- One trigger function for every send trigger below. The ledger write runs in its own exception block: any error
-- (an invalid time zone, a lock or privilege error) is rolled back to that block and leaves a WARNING with the SQLSTATE
-- only, never the message or detail, which can hold Instagram IDs; the source write continues. A follow message's person
-- is the comment sender of the private reply that started the follow conversation. Each send finalizer runs its
-- trigger in its last lock-taking statement (see the design spec), so an uncommitted ledger key is never held while the
-- finalizer waits on another lock. Comments are not recorded here but as the last statement of their ingestion: a
-- comment trigger would hold the sender's ledger key while the same transaction's private reply insert waits on a send
-- finalize of that sender's earlier reply, whose ledger write waits on that key. lock_timeout bounds the wait for
-- another transaction's uncommitted key of the same person and month on the server (a client query timeout does not
-- cancel the statement); the 55P03 lands in the exception block and the send still commits without the row.
CREATE OR REPLACE FUNCTION public.record_active_contact_activity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
SET lock_timeout = '2s'
AS $$
DECLARE
  reply record;
BEGIN
  BEGIN
    IF TG_TABLE_NAME='private_reply_outbox' THEN
      PERFORM public.record_active_contacts(ARRAY[NEW.workspace_id],ARRAY[NEW.connection_id],ARRAY['comment_sender'],
        ARRAY[NEW.sender_id],ARRAY[NEW.sent_at],ARRAY['private_reply']);
    ELSIF TG_TABLE_NAME='instagram_follow_messages' THEN
      SELECT outbox.workspace_id,outbox.connection_id,outbox.sender_id INTO reply
      FROM public.instagram_follow_conversations flow
      JOIN public.private_reply_outbox outbox ON outbox.id=flow.reply_id
      WHERE flow.reply_id=NEW.reply_id;
      IF FOUND THEN
        PERFORM public.record_active_contacts(ARRAY[reply.workspace_id],ARRAY[reply.connection_id],ARRAY['comment_sender'],
          ARRAY[reply.sender_id],ARRAY[NEW.sent_at],ARRAY['follow_message']);
      END IF;
    ELSIF TG_TABLE_NAME='instagram_manual_replies' THEN
      PERFORM public.record_active_contacts(ARRAY[NEW.workspace_id],ARRAY[NEW.connection_id],ARRAY['dm_recipient'],
        ARRAY[NEW.recipient_id],ARRAY[NEW.sent_at],ARRAY['manual_reply']);
    ELSIF TG_TABLE_NAME='campaign_deliveries' THEN
      PERFORM public.record_active_contacts(ARRAY[NEW.workspace_id],ARRAY[NEW.connection_id],ARRAY['dm_recipient'],
        ARRAY[NEW.recipient_id],ARRAY[NEW.sent_at],ARRAY['campaign']);
    ELSIF TG_TABLE_NAME='flow_dm_deliveries' THEN
      PERFORM public.record_active_contacts(ARRAY[NEW.workspace_id],ARRAY[NEW.connection_id],ARRAY['dm_recipient'],
        ARRAY[NEW.recipient_id],ARRAY[NEW.sent_at],ARRAY['flow_dm']);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'active contact ledger write skipped (SQLSTATE %)', SQLSTATE;
  END;
  RETURN NULL;
END $$;
-- A send counts only when its row becomes sent; failed, blocked, unknown and cancelled rows never fire.
DROP TRIGGER IF EXISTS record_active_contact ON public.private_reply_outbox;
CREATE TRIGGER record_active_contact
AFTER UPDATE ON public.private_reply_outbox
FOR EACH ROW WHEN (NEW.status='sent' AND OLD.status IS DISTINCT FROM 'sent')
EXECUTE FUNCTION public.record_active_contact_activity();
DROP TRIGGER IF EXISTS record_active_contact ON public.instagram_manual_replies;
CREATE TRIGGER record_active_contact
AFTER UPDATE ON public.instagram_manual_replies
FOR EACH ROW WHEN (NEW.status='sent' AND OLD.status IS DISTINCT FROM 'sent')
EXECUTE FUNCTION public.record_active_contact_activity();
DROP TRIGGER IF EXISTS record_active_contact ON public.campaign_deliveries;
CREATE TRIGGER record_active_contact
AFTER UPDATE ON public.campaign_deliveries
FOR EACH ROW WHEN (NEW.status='sent' AND OLD.status IS DISTINCT FROM 'sent')
EXECUTE FUNCTION public.record_active_contact_activity();
DROP TRIGGER IF EXISTS record_active_contact ON public.flow_dm_deliveries;
CREATE TRIGGER record_active_contact
AFTER UPDATE ON public.flow_dm_deliveries
FOR EACH ROW WHEN (NEW.status='sent' AND OLD.status IS DISTINCT FROM 'sent')
EXECUTE FUNCTION public.record_active_contact_activity();
-- The follow worker inserts a row only for a follow reply that was sent.
DROP TRIGGER IF EXISTS record_active_contact ON public.instagram_follow_messages;
CREATE TRIGGER record_active_contact
AFTER INSERT ON public.instagram_follow_messages
FOR EACH ROW WHEN (NEW.sent_at IS NOT NULL)
EXECUTE FUNCTION public.record_active_contact_activity();
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

  -- The connection's active contact rows stay for their months; only the person key is removed.
  UPDATE public.active_contacts SET person_key=NULL
  WHERE workspace_id=p_workspace AND connection_id=p_connection AND person_key IS NOT NULL;

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

  -- The person's active contact rows stay for their months; only the person key is removed. A row keyed by a linked
  -- comment sender is the comment sender's row and is cleared when that sender is in the person's identity set.
  UPDATE public.active_contacts SET person_key=NULL
  WHERE workspace_id=p_workspace AND connection_id=p_connection
    AND ((person_key_kind='comment_sender' AND person_key=ANY(senders))
      OR (person_key_kind='dm_recipient' AND person_key=ANY(recipients)));

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
