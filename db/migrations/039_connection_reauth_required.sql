-- The reconnect marker (#16): when Meta rejects a connection's token, the cron token refresh records
-- refresh_rejected and the Cloudflare pre-send identity read records token_rejected. It is display only.
-- reauth_token_obtained_at copies token_obtained_at of the rejected token, so a marker never applies to a
-- newer token. Both constraints are added by name, so a replay finds them.
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS reauth_required_at timestamptz;
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS reauth_reason text;
ALTER TABLE instagram_connections ADD COLUMN IF NOT EXISTS reauth_token_obtained_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_connections'::regclass AND conname='instagram_connections_reauth_reason') THEN
    ALTER TABLE instagram_connections ADD CONSTRAINT instagram_connections_reauth_reason
      CHECK(reauth_reason IN ('refresh_rejected','token_rejected'));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_connections'::regclass AND conname='instagram_connections_reauth_marker') THEN
    ALTER TABLE instagram_connections ADD CONSTRAINT instagram_connections_reauth_marker
      CHECK((reauth_required_at IS NULL) = (reauth_reason IS NULL) AND (reauth_reason IS NULL) = (reauth_token_obtained_at IS NULL));
  END IF;
END $$;
