-- Apply only through deploy/migrate-multi-user.sql, which owns the transaction.
-- A two-level condition tree, the third condition form; existing rows keep NULL and their tag and field conditions.
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS condition_tree jsonb;
DO $$ BEGIN
  -- The root is an object with only mode (all or any) and groups (an array of 1 to 5 elements), and a tree row has no
  -- tag or field condition and the operator 'and'. The CASE guards keep a non-object or non-array a CHECK violation
  -- rather than a function error, and coalesce keeps a missing mode a violation rather than NULL. The groups, the
  -- leaves, their counts and field ownership stay with the application parser and validateFieldCondition, as 057
  -- leaves field ownership to the application. contact_segment_condition_operator needs no change: it allows 'and'.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_condition_tree') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_condition_tree CHECK(
      condition_tree IS NULL OR (
        CASE WHEN jsonb_typeof(condition_tree)='object' THEN
          condition_tree - 'mode' - 'groups' = '{}'::jsonb
          AND coalesce(condition_tree->>'mode' IN ('all','any'),false)
          AND CASE WHEN jsonb_typeof(condition_tree->'groups')='array' THEN
            jsonb_array_length(condition_tree->'groups') BETWEEN 1 AND 5 ELSE false END
        ELSE false END
        AND tag IS NULL AND tags IS NULL AND tag_mode IS NULL
        AND field_id IS NULL AND field_operator IS NULL AND field_value IS NULL
        AND field_conditions IS NULL AND field_mode IS NULL
        AND condition_operator='and')
    );
  END IF;
END $$;
