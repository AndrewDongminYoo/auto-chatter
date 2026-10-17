-- Apply only through deploy/migrate-multi-user.sql, which owns the transaction.
-- Optimistic version of a saved segment's definition; existing rows start at 1.
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_version') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_version CHECK(version >= 1);
  END IF;
END $$;
