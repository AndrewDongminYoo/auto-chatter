-- Apply only through deploy/migrate-multi-user.sql, which owns the transaction.
-- Recorded state of the contact's verified DM conversations only; a segment never grants delivery permission.
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS dm_consent_purpose text;
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS dm_consent_state text;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_dm_consent') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_dm_consent CHECK(
      (dm_consent_purpose IS NULL AND dm_consent_state IS NULL) OR
      (dm_consent_purpose IS NOT NULL AND dm_consent_state IS NOT NULL
       AND dm_consent_purpose IN ('service_reply','marketing') AND dm_consent_state IN ('granted','revoked','no_record'))
    );
  END IF;
END $$;
