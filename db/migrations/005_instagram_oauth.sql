-- Run through deploy/migrate-multi-user.sql; the caller owns the transaction.
CREATE TABLE IF NOT EXISTS instagram_oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
ALTER TABLE instagram_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON instagram_oauth_states FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=api_role) THEN
      EXECUTE format('REVOKE ALL ON instagram_oauth_states FROM %I',api_role);
    END IF;
  END LOOP;
END $$;
