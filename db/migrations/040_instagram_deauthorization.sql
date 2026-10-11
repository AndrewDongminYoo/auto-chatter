-- The deauthorize callback (#16): Meta calls it when an account owner removes the app in Instagram.
-- instagram_user_id is the app-scoped Instagram user ID that the OAuth token exchange returns as user_id; the
-- callback matches it or account_id. deauthorized_at records when a verified callback disconnected the
-- connection; a manual disconnect or an OAuth reconnect clears it. Both columns are nullable, so a replay is safe.
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS instagram_user_id text;
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS deauthorized_at timestamptz;
