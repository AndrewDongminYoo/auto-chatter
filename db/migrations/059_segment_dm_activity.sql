-- Apply only through deploy/migrate-multi-user.sql, which owns the transaction.
-- Recent received DMs of the contact's verified DM conversations only; a segment never grants delivery permission.
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS last_dm_days integer;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_dm_activity') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_dm_activity CHECK(
      last_dm_days IS NULL OR last_dm_days BETWEEN 1 AND 366
    );
  END IF;
END $$;
