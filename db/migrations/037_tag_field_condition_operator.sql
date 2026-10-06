-- Existing filters keep AND. OR combines a required tag and one required field.
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS condition_operator text NOT NULL DEFAULT 'and';
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_condition_operator') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_condition_operator CHECK(
      condition_operator IN ('and','or') AND (condition_operator='and' OR (tag IS NOT NULL AND field_id IS NOT NULL))
    );
  END IF;
END $$;
