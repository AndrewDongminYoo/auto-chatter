-- Apply only through deploy/migrate-multi-user.sql, which owns the transaction.
-- A calendar period of the workspace time zone; it excludes the fixed bounds (046) and the day count (053).
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS last_comment_period text;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_calendar_period') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_calendar_period CHECK(
      last_comment_period IS NULL OR (last_comment_period IN ('today','yesterday','this_month','last_month')
        AND last_comment_from IS NULL AND last_comment_before IS NULL AND last_comment_days IS NULL)
    );
  END IF;
END $$;
