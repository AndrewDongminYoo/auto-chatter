CREATE INDEX IF NOT EXISTS instagram_comment_events_contact_lookup_idx
  ON instagram_comment_events (workspace_id, connection_id, sender_id) INCLUDE (created_at);

CREATE TABLE IF NOT EXISTS instagram_contact_tags (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  sender_id text NOT NULL CHECK(length(btrim(sender_id)) > 0),
  tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(tags)<=20 AND array_position(tags,NULL) IS NULL),
  PRIMARY KEY(workspace_id,connection_id,sender_id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);
