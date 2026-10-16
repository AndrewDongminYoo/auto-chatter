-- Recorded comment-sender state only; a segment never grants delivery permission.
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS consent_purpose text;
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS consent_state text;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_consent_condition') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_consent_condition CHECK(
      (consent_purpose IS NULL AND consent_state IS NULL) OR
      (consent_purpose IS NOT NULL AND consent_state IS NOT NULL
       AND consent_purpose IN ('service_reply','marketing') AND consent_state IN ('granted','revoked','no_record'))
    );
  END IF;
END $$;
