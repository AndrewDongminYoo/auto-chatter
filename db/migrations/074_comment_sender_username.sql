-- Apply through deploy/migrate-multi-user.sql, then deploy the code that writes sender_username.
-- Commenter username (#388): the comments webhook sends from.username beside from.id. Ingestion stores it when it
-- is a valid Instagram username and leaves NULL otherwise, so a missing or malformed value never rejects the event.
-- The contacts list shows the username of each contact's latest comment that carried one.
-- Existing rows keep NULL. No backfill.
-- The running code does not name the column, so it keeps working between this migration and the deploy.
ALTER TABLE instagram_comment_events ADD COLUMN IF NOT EXISTS sender_username text;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_comment_events'::regclass AND conname='instagram_comment_events_sender_username_format') THEN
    ALTER TABLE instagram_comment_events ADD CONSTRAINT instagram_comment_events_sender_username_format
      CHECK(sender_username IS NULL OR sender_username ~ '^[A-Za-z0-9._]{1,30}$');
  END IF;
END $$;
