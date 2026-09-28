ALTER TABLE instagram_connections
  ADD COLUMN IF NOT EXISTS token_obtained_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS token_refresh_attempted_at timestamptz;
