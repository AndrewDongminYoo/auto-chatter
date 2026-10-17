-- Apply only through deploy/migrate-multi-user.sql, which owns the transaction.
-- A field condition set of 2 or 3 conditions with a mode; one condition stays in the legacy field columns, so existing rows are unchanged.
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS field_conditions jsonb;
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS field_mode text;
DO $$ BEGIN
  -- A CHECK cannot read jsonb_array_elements, so the at most three positions are checked one by one. Each is an
  -- object with only field_id (a lowercase UUID string), field_operator and a field_value exactly when the operator
  -- needs one; the IDs are strictly ascending, so they are distinct. The CASE guards keep a non-array or non-object
  -- a CHECK violation rather than a function error. Field ownership, active state, the value type of each field and
  -- ordered operators only on number or date fields stay with the application parser and validateFieldCondition.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_multi_field') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_multi_field CHECK(
      (field_conditions IS NULL AND field_mode IS NULL) OR
      (field_conditions IS NOT NULL AND field_mode IS NOT NULL AND field_mode IN ('all','any')
       AND field_id IS NULL AND field_operator IS NULL AND field_value IS NULL
       AND CASE WHEN jsonb_typeof(field_conditions)='array' THEN
         jsonb_array_length(field_conditions) BETWEEN 2 AND 3
         AND CASE WHEN jsonb_typeof(field_conditions->0)='object' THEN
           (field_conditions->0) - 'field_id' - 'field_operator' - 'field_value' = '{}'::jsonb
           AND coalesce(jsonb_typeof(field_conditions->0->'field_id')='string'
             AND (field_conditions->0->>'field_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)
           AND CASE WHEN field_conditions->0->>'field_operator' IN ('is_set','is_unset') THEN NOT (field_conditions->0 ? 'field_value')
             WHEN field_conditions->0->>'field_operator'='eq' THEN coalesce(jsonb_typeof(field_conditions->0->'field_value') IN ('string','number','boolean'),false)
             WHEN field_conditions->0->>'field_operator' IN ('gt','gte','lt','lte') THEN coalesce(jsonb_typeof(field_conditions->0->'field_value') IN ('string','number'),false)
             ELSE false END
         ELSE false END
         AND CASE WHEN jsonb_typeof(field_conditions->1)='object' THEN
           (field_conditions->1) - 'field_id' - 'field_operator' - 'field_value' = '{}'::jsonb
           AND coalesce(jsonb_typeof(field_conditions->1->'field_id')='string'
             AND (field_conditions->1->>'field_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND (field_conditions->0->>'field_id') COLLATE "C" < (field_conditions->1->>'field_id') COLLATE "C",false)
           AND CASE WHEN field_conditions->1->>'field_operator' IN ('is_set','is_unset') THEN NOT (field_conditions->1 ? 'field_value')
             WHEN field_conditions->1->>'field_operator'='eq' THEN coalesce(jsonb_typeof(field_conditions->1->'field_value') IN ('string','number','boolean'),false)
             WHEN field_conditions->1->>'field_operator' IN ('gt','gte','lt','lte') THEN coalesce(jsonb_typeof(field_conditions->1->'field_value') IN ('string','number'),false)
             ELSE false END
         ELSE false END
         AND CASE WHEN jsonb_array_length(field_conditions)<3 THEN true WHEN jsonb_typeof(field_conditions->2)='object' THEN
           (field_conditions->2) - 'field_id' - 'field_operator' - 'field_value' = '{}'::jsonb
           AND coalesce(jsonb_typeof(field_conditions->2->'field_id')='string'
             AND (field_conditions->2->>'field_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             AND (field_conditions->1->>'field_id') COLLATE "C" < (field_conditions->2->>'field_id') COLLATE "C",false)
           AND CASE WHEN field_conditions->2->>'field_operator' IN ('is_set','is_unset') THEN NOT (field_conditions->2 ? 'field_value')
             WHEN field_conditions->2->>'field_operator'='eq' THEN coalesce(jsonb_typeof(field_conditions->2->'field_value') IN ('string','number','boolean'),false)
             WHEN field_conditions->2->>'field_operator' IN ('gt','gte','lt','lte') THEN coalesce(jsonb_typeof(field_conditions->2->'field_value') IN ('string','number'),false)
             ELSE false END
         ELSE false END
       ELSE false END)
    );
  END IF;
  -- OR needs a tag condition and a field condition; the field condition may now be the field set.
  -- contact_segment_field_condition needs no change: a field set leaves all three legacy field columns NULL.
  ALTER TABLE instagram_contact_segments DROP CONSTRAINT IF EXISTS contact_segment_condition_operator;
  ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_condition_operator CHECK(
    condition_operator IN ('and','or') AND (condition_operator='and' OR ((tag IS NOT NULL OR tags IS NOT NULL) AND (field_id IS NOT NULL OR field_conditions IS NOT NULL)))
  );
END $$;
