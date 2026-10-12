-- The webhook subscription check (#179): the cron and the manual status check read the account's
-- subscribed_apps and store the result. It is display only. subscription_check_attempted_at is the last attempt
-- and is used only for scheduling; subscription_checked_at is the last definite result (fields present or
-- missing), and subscription_missing_at is when the loss was first recorded, NULL when the last definite result
-- was present. subscription_token_obtained_at copies token_obtained_at of the token the result belongs to, so a
-- result never applies to a newer token. All columns are nullable, so a replay is safe.
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS subscription_check_attempted_at timestamptz;
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS subscription_checked_at timestamptz;
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS subscription_missing_at timestamptz;
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS subscription_token_obtained_at timestamptz;
