-- A run whose private reply is followed by a wait_for_reply node (#32) waits for the recipient's
-- answer as awaiting_reply. resume_node_id names the wait and resume_at stays NULL, because the wait
-- counts from when the reply is sent (private_reply_outbox.sent_at) plus the pinned version's timeout.
-- The constraint keeps the name flow_runs_state, so migration 025 replayed later leaves it alone.
DO $$ BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint WHERE conrelid='flow_runs'::regclass AND conname='flow_runs_state'
      AND pg_get_constraintdef(oid) LIKE '%awaiting_reply%'
  ) THEN
    ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_state;
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_state CHECK(
      status IN ('delivering','ended','skipped','failed','waiting','cancelled','awaiting_reply')
      AND (status IN ('skipped','failed','cancelled')) = (failure_code IS NOT NULL)
      AND (status='waiting') = (resume_at IS NOT NULL)
      AND (status IN ('waiting','awaiting_reply')) = (resume_node_id IS NOT NULL)
    );
  END IF;
END $$;
-- The scheduled timeout scan and the reply lookup read only runs awaiting a reply.
CREATE INDEX IF NOT EXISTS flow_runs_awaiting_reply_idx ON flow_runs(connection_id, id) WHERE status='awaiting_reply';
-- The provider ID of the DM that ended a reply wait, so a redelivered message is found here and
-- advances no other run waiting on the same person.
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS reply_message_id text;
CREATE INDEX IF NOT EXISTS flow_runs_reply_message_idx ON flow_runs(connection_id, reply_message_id)
  WHERE reply_message_id IS NOT NULL;
