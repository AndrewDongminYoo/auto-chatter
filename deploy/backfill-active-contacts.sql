-- One-off backfill of the active contact ledger (#51, docs/specs/2026-11-24-active-contact-ledger-design.md).
-- Run it exactly once, with an administrator connection (psql -f deploy/backfill-active-contacts.sql), after
-- migration 077 has been applied and after the code that records comments and inbound DMs is deployed. It is not part
-- of migration 077 or deploy/migrate-multi-user.sql: that runner replays every migration on every rollout, and a
-- backfill replayed later would record the same activity again under the identity links and time zone valid at that
-- later time, so one person could count twice in one month. Run after the deploy, it also covers the comments and
-- inbound DMs that arrived between the migration and the deploy, which the earlier code did not record.
-- It records the activity stored since the start of each workspace's current billing month through the same function
-- as the triggers and the ingestion paths, so person keys use the identity links valid when it runs. Inbound DMs come
-- from the stored inbox messages, the DM start events and the latest inbound DM time of each sender (the only trace of
-- a DM on an inbox-disabled account; it is the latest time, not the first). Earlier months stay empty, and a workspace
-- whose time_zone AT TIME ZONE rejects is skipped. Rows that live traffic already wrote conflict and stay unchanged.
-- An activity is skipped when its month already has a row for the same person under either key: its own identity,
-- or the other side of any identity link that was ever confirmed between the two IDs (a confirm event, whatever the
-- link's state now). A live write keys a person by the link valid at that time; a link confirmed or detached between
-- that write and this backfill would otherwise make the backfill record the same person again under the other ID.
-- ON_ERROR_STOP makes psql exit non-zero when the statement fails, for example on the lock timeout.
-- It runs while traffic flows: it takes no table lock beyond what its INSERT needs, and lock_timeout stops it instead
-- of letting it wait long on a live transaction's uncommitted ledger key; a stopped run commits nothing and can be
-- started again. Do not run it while a deletion function runs: it does not lock the connections, so a row it writes
-- for a person being deleted could keep that person's ID.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '2s';
SELECT public.record_active_contacts(array_agg(activity.workspace_id),array_agg(activity.connection_id),
  array_agg(activity.identity_kind),array_agg(activity.identity),array_agg(activity.activity_at),
  array_agg(activity.activity_kind))
FROM (
  SELECT event.workspace_id,event.connection_id,'comment_sender' AS identity_kind,event.sender_id AS identity,
    event.created_at AS activity_at,'comment' AS activity_kind
  FROM instagram_comment_events event
  JOIN instagram_connections own ON own.id=event.connection_id AND own.workspace_id=event.workspace_id
  -- The connected account's own comments are not a contact, as in the ingestion write.
  WHERE event.sender_id<>own.account_id AND event.sender_id IS DISTINCT FROM own.instagram_user_id
  UNION ALL
  SELECT workspace_id,connection_id,'comment_sender',sender_id,sent_at,'private_reply'
  FROM private_reply_outbox WHERE status='sent' AND sent_at IS NOT NULL
  UNION ALL
  SELECT reply.workspace_id,reply.connection_id,'comment_sender',reply.sender_id,message.sent_at,'follow_message'
  FROM instagram_follow_messages message
  JOIN instagram_follow_conversations flow ON flow.reply_id=message.reply_id
  JOIN private_reply_outbox reply ON reply.id=flow.reply_id
  WHERE message.sent_at IS NOT NULL
  UNION ALL
  SELECT workspace_id,connection_id,'dm_recipient',recipient_id,sent_at,'manual_reply'
  FROM instagram_manual_replies WHERE status='sent' AND sent_at IS NOT NULL
  UNION ALL
  SELECT workspace_id,connection_id,'dm_recipient',recipient_id,sent_at,'campaign'
  FROM campaign_deliveries WHERE status='sent'
  UNION ALL
  SELECT workspace_id,connection_id,'dm_recipient',recipient_id,sent_at,'flow_dm'
  FROM flow_dm_deliveries WHERE status='sent'
  UNION ALL
  SELECT workspace_id,connection_id,'dm_recipient',recipient_id,least(message_at,received_at),'dm_received'
  FROM instagram_inbox_messages
  UNION ALL
  SELECT workspace_id,connection_id,'dm_recipient',sender_id,least(message_at,created_at),'dm_received'
  FROM instagram_dm_start_events
  UNION ALL
  SELECT workspace_id,connection_id,'dm_recipient',recipient_id,last_message_at,'dm_received'
  FROM instagram_dm_last_inbound
) activity
JOIN workspaces workspace ON workspace.id=activity.workspace_id
-- CASE keeps AT TIME ZONE from reading a zone that it rejects; record_active_contacts skips such a zone too.
WHERE CASE WHEN public.active_contact_time_zone_valid(workspace.time_zone)
    THEN activity.activity_at>=(date_trunc('month',now() AT TIME ZONE workspace.time_zone) AT TIME ZONE workspace.time_zone)
    ELSE false END
  AND activity.activity_at<=now()
  AND NOT EXISTS(
    SELECT 1 FROM active_contacts stored
    WHERE stored.workspace_id=activity.workspace_id AND stored.connection_id=activity.connection_id
      AND stored.billing_month=CASE WHEN public.active_contact_time_zone_valid(workspace.time_zone)
        THEN date_trunc('month',activity.activity_at AT TIME ZONE workspace.time_zone)::date END
      AND ((stored.person_key_kind=activity.identity_kind AND stored.person_key=activity.identity)
        OR (stored.person_key_kind<>activity.identity_kind AND EXISTS(
          SELECT 1 FROM instagram_contact_identity_link_events link
          WHERE link.workspace_id=activity.workspace_id AND link.connection_id=activity.connection_id AND link.action='confirm'
            AND link.recipient_id=CASE WHEN activity.identity_kind='dm_recipient' THEN activity.identity ELSE stored.person_key END
            AND link.sender_id=CASE WHEN activity.identity_kind='comment_sender' THEN activity.identity ELSE stored.person_key END))));
COMMIT;
