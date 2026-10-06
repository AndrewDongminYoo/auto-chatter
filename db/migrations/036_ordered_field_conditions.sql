-- Retain existing equality/presence conditions and allow numeric/date thresholds.
ALTER TABLE instagram_contact_segments DROP CONSTRAINT IF EXISTS contact_segment_field_condition;
ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_field_condition CHECK(
  (field_id IS NULL AND field_operator IS NULL AND field_value IS NULL) OR
  (field_id IS NOT NULL AND field_operator IS NOT NULL AND (
    (field_operator IN ('is_set','is_unset') AND field_value IS NULL) OR
    (field_operator='eq' AND field_value IS NOT NULL AND jsonb_typeof(field_value) IN ('string','number','boolean')) OR
    (field_operator IN ('gt','gte','lt','lte') AND field_value IS NOT NULL AND jsonb_typeof(field_value) IN ('string','number'))
  ))
);
