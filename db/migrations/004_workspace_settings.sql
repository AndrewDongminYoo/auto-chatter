BEGIN;

CREATE TABLE IF NOT EXISTS workspace_members (
  user_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces (id)
);

ALTER TABLE instagram_connections
  ADD COLUMN IF NOT EXISTS send_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS access_token_encrypted text,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;

ALTER TABLE instagram_comment_rules
  ADD COLUMN IF NOT EXISTS follow_gate_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS follower_reply_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS non_follower_reply_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS confirmation_keyword text NOT NULL DEFAULT '확인' CHECK (length(btrim(confirmation_keyword)) > 0);

-- Apply deploy/supabase-access.sql in the same administrator session before serving APIs.
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workspace_members FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON workspace_members FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

COMMIT;
