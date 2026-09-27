CREATE TABLE IF NOT EXISTS instagram_contact_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 60),
  type text NOT NULL CHECK(type IN ('text','number','boolean','date')),
  archived boolean NOT NULL DEFAULT false,
  UNIQUE(id,workspace_id),
  UNIQUE(workspace_id,name)
);
CREATE TABLE IF NOT EXISTS instagram_contact_field_values (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  connection_id uuid NOT NULL,
  sender_id text NOT NULL CHECK(length(btrim(sender_id))>0),
  field_id uuid NOT NULL,
  value jsonb CHECK(value IS NULL OR jsonb_typeof(value) IN ('string','number','boolean')),
  PRIMARY KEY(workspace_id,connection_id,sender_id,field_id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id),
  FOREIGN KEY(field_id,workspace_id) REFERENCES instagram_contact_fields(id,workspace_id)
);
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS field_id uuid;
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS field_operator text;
ALTER TABLE instagram_contact_segments ADD COLUMN IF NOT EXISTS field_value jsonb;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_field_owner') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_field_owner FOREIGN KEY(field_id,workspace_id) REFERENCES instagram_contact_fields(id,workspace_id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_field_condition') THEN
    ALTER TABLE instagram_contact_segments ADD CONSTRAINT contact_segment_field_condition CHECK(
      (field_id IS NULL AND field_operator IS NULL AND field_value IS NULL) OR
      (field_id IS NOT NULL AND field_operator IS NOT NULL AND (
        (field_operator IN ('is_set','is_unset') AND field_value IS NULL) OR
        (field_operator='eq' AND field_value IS NOT NULL AND jsonb_typeof(field_value) IN ('string','number','boolean'))
      ))
    );
  END IF;
END $$;
