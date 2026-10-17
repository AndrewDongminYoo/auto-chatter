-- Apply only through deploy/migrate-multi-user.sql, which owns the transaction.
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS last_comment_days integer;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_relative_activity') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_relative_activity CHECK(
      last_comment_days IS NULL OR (last_comment_days BETWEEN 1 AND 366 AND last_comment_from IS NULL AND last_comment_before IS NULL)
    );
  END IF;
END $$;
