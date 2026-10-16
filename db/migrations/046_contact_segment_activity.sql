-- Fixed UTC bounds filter each contact's latest stored comment, not provider event time.
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS last_comment_from timestamptz;
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS last_comment_before timestamptz;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_activity_window') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_activity_window CHECK(
      (last_comment_from IS NULL AND last_comment_before IS NULL) OR
      (last_comment_from IS NOT NULL AND last_comment_before IS NOT NULL
       AND isfinite(last_comment_from) AND isfinite(last_comment_before) AND last_comment_from < last_comment_before)
    );
  END IF;
END $$;
