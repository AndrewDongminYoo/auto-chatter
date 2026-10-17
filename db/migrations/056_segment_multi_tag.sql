-- Apply only through deploy/migrate-multi-user.sql, which owns the transaction.
-- A tag condition of 2 to 5 tags with a mode; one tag stays in the legacy tag column, so existing rows are unchanged.
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS tags text[];
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS tag_mode text;
DO $$ BEGIN
  -- A CHECK cannot read unnest(tags), so the at most five positions are checked one by one.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_multi_tag') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_multi_tag CHECK(
      (tags IS NULL AND tag_mode IS NULL) OR
      (tags IS NOT NULL AND tag IS NULL AND tag_mode IS NOT NULL AND tag_mode IN ('all','any')
       AND array_ndims(tags)=1 AND array_lower(tags,1)=1 AND cardinality(tags) BETWEEN 2 AND 5
       AND array_position(tags,NULL) IS NULL
       AND coalesce(length(tags[1]) BETWEEN 1 AND 40,false) AND coalesce(length(tags[2]) BETWEEN 1 AND 40,false)
       AND coalesce(length(tags[3]) BETWEEN 1 AND 40,true) AND coalesce(length(tags[4]) BETWEEN 1 AND 40,true)
       AND coalesce(length(tags[5]) BETWEEN 1 AND 40,true))
    );
  END IF;
  -- OR needs a tag condition and a field condition; the tag condition may now be the tag set.
  -- Once 057 has replaced this rule with one that reads field_conditions, a re-run leaves it alone: this older rule
  -- would reject a stored OR segment whose field condition is a field set.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
    WHERE c.conrelid='instagram_contact_segments'::regclass AND c.conname='contact_segment_condition_operator' AND a.attname='field_conditions') THEN
    ALTER TABLE instagram_contact_segments DROP CONSTRAINT IF EXISTS contact_segment_condition_operator;
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_condition_operator CHECK(
      condition_operator IN ('and','or') AND (condition_operator='and' OR ((tag IS NOT NULL OR tags IS NOT NULL) AND field_id IS NOT NULL))
    );
  END IF;
END $$;
