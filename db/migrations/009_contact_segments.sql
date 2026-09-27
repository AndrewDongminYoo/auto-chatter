CREATE TABLE IF NOT EXISTS instagram_contact_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 60),
  connection_id uuid,
  tag text CHECK(tag IS NULL OR length(tag) BETWEEN 1 AND 40),
  archived boolean NOT NULL DEFAULT false,
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS instagram_contact_segments_active_name_idx
  ON instagram_contact_segments(workspace_id,name) WHERE NOT archived;
