ALTER TABLE instagram_contact_automation ADD COLUMN IF NOT EXISTS handoff_paused boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS private_reply_outbox_identity_idx
  ON private_reply_outbox(id,connection_id,workspace_id);
CREATE TABLE IF NOT EXISTS instagram_inbox_handoffs (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  recipient_id text NOT NULL CHECK(recipient_id ~ '^[0-9]{1,40}$'),
  sender_id text NOT NULL CHECK(length(btrim(sender_id))>0),
  evidence_reply_id bigint NOT NULL,
  active boolean NOT NULL,
  version integer NOT NULL CHECK(version>0),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,connection_id,recipient_id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id),
  FOREIGN KEY(workspace_id,connection_id,sender_id) REFERENCES instagram_contact_automation(workspace_id,connection_id,sender_id),
  FOREIGN KEY(evidence_reply_id,connection_id,workspace_id) REFERENCES private_reply_outbox(id,connection_id,workspace_id)
);
CREATE INDEX IF NOT EXISTS instagram_inbox_handoffs_sender_idx
  ON instagram_inbox_handoffs(workspace_id,connection_id,sender_id) WHERE active;
CREATE TABLE IF NOT EXISTS instagram_inbox_handoff_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  recipient_id text NOT NULL,
  sender_id text NOT NULL,
  evidence_reply_id bigint NOT NULL,
  active boolean NOT NULL,
  version integer NOT NULL CHECK(version>0),
  actor_id uuid NOT NULL,
  reason text NOT NULL CHECK(reason IN ('handoff_started','handoff_resumed')),
  manual_paused_before boolean NOT NULL,
  handoff_paused_before boolean NOT NULL,
  handoff_paused_after boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,connection_id,recipient_id,version),
  FOREIGN KEY(workspace_id,connection_id,recipient_id) REFERENCES instagram_inbox_handoffs(workspace_id,connection_id,recipient_id),
  FOREIGN KEY(evidence_reply_id,connection_id,workspace_id) REFERENCES private_reply_outbox(id,connection_id,workspace_id),
  CHECK((active AND reason='handoff_started') OR (NOT active AND reason='handoff_resumed'))
);
