CREATE TABLE IF NOT EXISTS instagram_contact_automation (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  sender_id text NOT NULL CHECK(length(btrim(sender_id)) > 0),
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,connection_id,sender_id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);
