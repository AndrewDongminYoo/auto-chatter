CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS workspace_members (
  user_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS instagram_oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS instagram_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  account_id text NOT NULL UNIQUE CHECK (length(btrim(account_id)) > 0),
  active boolean NOT NULL DEFAULT false,
  send_enabled boolean NOT NULL DEFAULT false,
  username text,
  access_token_encrypted text,
  token_expires_at timestamptz,
  send_paused_until timestamptz,
  UNIQUE (id, workspace_id)
);

CREATE TABLE IF NOT EXISTS instagram_comment_rules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  media_id text NOT NULL CHECK (length(btrim(media_id)) > 0),
  keyword text NOT NULL CHECK (length(btrim(keyword)) > 0),
  keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(keywords) <= 20 AND array_position(keywords, NULL) IS NULL),
  match_mode text NOT NULL DEFAULT 'contains' CHECK (match_mode IN ('contains', 'exact', 'all')),
  excluded_keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(excluded_keywords) <= 20 AND array_position(excluded_keywords, NULL) IS NULL),
  private_reply_text text NOT NULL CHECK (length(btrim(private_reply_text)) > 0),
  follow_gate_enabled boolean NOT NULL DEFAULT false,
  follower_reply_text text NOT NULL DEFAULT '',
  non_follower_reply_text text NOT NULL DEFAULT '',
  confirmation_button_title text NOT NULL DEFAULT '' CHECK(length(confirmation_button_title)<=20),
  confirmation_keyword text NOT NULL DEFAULT '확인' CHECK (length(btrim(confirmation_keyword)) > 0),
  enabled boolean NOT NULL DEFAULT false,
  FOREIGN KEY (connection_id, workspace_id) REFERENCES instagram_connections (id, workspace_id),
  UNIQUE (connection_id, media_id),
  UNIQUE (id, connection_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS instagram_comment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  comment_id text NOT NULL CHECK (length(btrim(comment_id)) > 0),
  media_id text NOT NULL CHECK (length(btrim(media_id)) > 0),
  sender_id text NOT NULL CHECK (length(btrim(sender_id)) > 0),
  comment_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, workspace_id) REFERENCES instagram_connections (id, workspace_id),
  UNIQUE (connection_id, comment_id),
  UNIQUE (id, connection_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS instagram_comment_events_contact_lookup_idx
  ON instagram_comment_events (workspace_id, connection_id, sender_id) INCLUDE (created_at);

CREATE TABLE IF NOT EXISTS private_reply_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  event_id bigint NOT NULL UNIQUE,
  rule_id uuid NOT NULL,
  comment_id text NOT NULL,
  media_id text NOT NULL,
  sender_id text NOT NULL,
  private_reply_text text NOT NULL,
  follow_config jsonb,
  recipient_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'blocked', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_id uuid,
  attempt_started_at timestamptz,
  provider_message_id text,
  failure_code text,
  sent_at timestamptz,
  rate_limit_retries integer NOT NULL DEFAULT 0 CHECK (rate_limit_retries >= 0),
  CONSTRAINT private_reply_outbox_sending_attempt_check CHECK (status <> 'sending' OR (attempt_id IS NOT NULL AND attempt_started_at IS NOT NULL)),
  FOREIGN KEY (connection_id, workspace_id) REFERENCES instagram_connections (id, workspace_id),
  FOREIGN KEY (event_id, connection_id, workspace_id) REFERENCES instagram_comment_events (id, connection_id, workspace_id),
  FOREIGN KEY (rule_id, connection_id, workspace_id) REFERENCES instagram_comment_rules (id, connection_id, workspace_id),
  UNIQUE (connection_id, media_id, sender_id)
);

CREATE TABLE IF NOT EXISTS instagram_follow_conversations (
  reply_id bigint PRIMARY KEY REFERENCES private_reply_outbox(id),
  connection_id uuid NOT NULL REFERENCES instagram_connections(id),
  recipient_id text NOT NULL,
  confirmation_button_title text NOT NULL DEFAULT '' CHECK(length(confirmation_button_title)<=20),
  confirmation_keyword text NOT NULL,
  follower_reply_text text NOT NULL,
  non_follower_reply_text text NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','pending','sending','sent','blocked','failed','unknown')),
  follow_status text NOT NULL DEFAULT 'unknown' CHECK(follow_status IN ('unknown','following','not_following')),
  confirmed_at timestamptz,
  last_message_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_id uuid,
  attempt_started_at timestamptz,
  failure_code text,
  provider_message_id text,
  rate_limit_retries integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS instagram_message_receipts (
  connection_id uuid NOT NULL REFERENCES instagram_connections(id),
  message_id text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY(connection_id,message_id)
);

CREATE TABLE IF NOT EXISTS instagram_contact_tags (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  sender_id text NOT NULL CHECK(length(btrim(sender_id)) > 0),
  tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(tags)<=20 AND array_position(tags,NULL) IS NULL),
  PRIMARY KEY(workspace_id,connection_id,sender_id),
  FOREIGN KEY(connection_id,workspace_id) REFERENCES instagram_connections(id,workspace_id)
);
