CREATE TABLE IF NOT EXISTS flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
  draft jsonb NOT NULL CHECK(jsonb_typeof(draft)='object'),
  draft_revision integer NOT NULL DEFAULT 0 CHECK(draft_revision>=0),
  published_version_id uuid,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,workspace_id),
  CHECK(NOT archived OR published_version_id IS NULL)
);
CREATE TABLE IF NOT EXISTS flow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  version_no integer NOT NULL CHECK(version_no>0),
  draft_revision integer NOT NULL CHECK(draft_revision>=0),
  definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
  trigger_connection_id uuid NOT NULL,
  trigger_media_id text NOT NULL CHECK(trigger_media_id ~ '^[0-9]{1,40}$'),
  field_ids uuid[] NOT NULL DEFAULT '{}' CHECK(array_position(field_ids,NULL) IS NULL),
  published_by uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(flow_id,version_no),
  UNIQUE(flow_id,draft_revision),
  UNIQUE(id,flow_id),
  FOREIGN KEY(flow_id,workspace_id) REFERENCES flows(id,workspace_id),
  FOREIGN KEY(trigger_connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);
CREATE INDEX IF NOT EXISTS flow_versions_trigger_idx ON flow_versions(trigger_connection_id,trigger_media_id);
CREATE INDEX IF NOT EXISTS flow_versions_field_ids_idx ON flow_versions USING gin(field_ids);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flows'::regclass AND conname='flows_published_version') THEN
    ALTER TABLE flows ADD CONSTRAINT flows_published_version FOREIGN KEY(published_version_id,id) REFERENCES flow_versions(id,flow_id);
  END IF;
END $$;
