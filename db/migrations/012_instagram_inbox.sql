ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS inbox_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS inbox_enabled_at timestamptz;
CREATE TABLE IF NOT EXISTS instagram_inbox_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  recipient_id text NOT NULL CHECK(recipient_id ~ '^[0-9]+$'),
  message_id text NOT NULL,
  text text NOT NULL CHECK(length(text)<=10000),
  kind text NOT NULL CHECK(kind IN ('text','postback')),
  message_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id),
  UNIQUE(connection_id,message_id)
);
CREATE INDEX IF NOT EXISTS instagram_inbox_messages_conversation_idx
  ON instagram_inbox_messages(workspace_id,connection_id,recipient_id,id DESC);
