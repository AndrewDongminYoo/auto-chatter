-- The private reply budget carry (#189, docs/specs/2026-10-12-send-quotas.md). The budget counts a connection's
-- private_reply_outbox rows whose provider_called_at is in the last hour. Connection and person data deletion
-- remove such rows, and an OAuth reconnect reuses the same instagram_connections row, so without a carry the
-- count would start again at zero. When rows with a call in the last hour are deleted, the trigger below adds
-- their number to private_reply_carried_calls, and the budget counts it while private_reply_carried_until is
-- in the future. Both columns are added only when missing, the constraint by name, and the function and the
-- trigger are replaced, so a replay is safe.
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS private_reply_carried_calls integer NOT NULL DEFAULT 0;
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS private_reply_carried_until timestamptz;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_connections'::regclass AND conname='instagram_connections_private_reply_carried_calls') THEN
    ALTER TABLE instagram_connections ADD CONSTRAINT instagram_connections_private_reply_carried_calls
      CHECK(private_reply_carried_calls>=0);
  END IF;
END $$;
-- Server roles have no DELETE on private_reply_outbox, so this runs only inside the administrator deletion
-- functions. It is SECURITY INVOKER: in delete_connection_data (SECURITY DEFINER) it runs as that function's
-- administrator owner, and in delete_person_data and delete_workspace_data as the calling administrator. Each
-- of them already holds the connection rows it deletes from (delete_connection_data and delete_workspace_data
-- FOR UPDATE, delete_person_data FOR NO KEY UPDATE), and this UPDATE changes only non-key columns, so it takes
-- no lock those functions do not hold. delete_workspace_data deletes the outbox before the connections, so a
-- carry it writes is deleted with its connection. A carry still in force keeps its calls and is extended to the
-- latest deleted call's hour; an expired one is replaced. Every carried call counts until that time, so an
-- older call can be held back slightly too long but never counts too little. TRUNCATE does not fire this.
CREATE OR REPLACE FUNCTION public.carry_deleted_private_reply_calls()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.instagram_connections connection
  SET private_reply_carried_calls=CASE WHEN connection.private_reply_carried_until>now()
      THEN connection.private_reply_carried_calls ELSE 0 END+recent.calls,
    private_reply_carried_until=greatest(
      CASE WHEN connection.private_reply_carried_until>now() THEN connection.private_reply_carried_until END,
      recent.until)
  FROM (
    SELECT deleted_row.connection_id,count(*)::integer AS calls,
      max(deleted_row.provider_called_at)+interval '1 hour' AS until
    FROM deleted_replies deleted_row
    WHERE deleted_row.provider_called_at>now()-interval '1 hour'
    GROUP BY deleted_row.connection_id
  ) recent
  WHERE connection.id=recent.connection_id;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS carry_deleted_private_reply_calls ON public.private_reply_outbox;
CREATE TRIGGER carry_deleted_private_reply_calls
AFTER DELETE ON public.private_reply_outbox
REFERENCING OLD TABLE AS deleted_replies
FOR EACH STATEMENT EXECUTE FUNCTION public.carry_deleted_private_reply_calls();
