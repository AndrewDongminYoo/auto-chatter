-- Apply through deploy/migrate-multi-user.sql, then deploy the code that writes skip_code.
-- DM start limits (#400): one messaging sender starts at most one DM-triggered flow run per connection in 10 minutes,
-- and one connection at most 700 per rolling hour. A DM over a limit keeps its start event with skip_code and
-- starts no run, so the limits count only rows with a NULL skip_code. Existing rows are started events and keep NULL.
-- The running code does not name the column, and every row it writes has a NULL skip_code, so it keeps working
-- between this migration and the deploy.
ALTER TABLE instagram_dm_start_events ADD COLUMN IF NOT EXISTS skip_code text;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_dm_start_events'::regclass AND conname='instagram_dm_start_events_skip_code_check') THEN
    ALTER TABLE instagram_dm_start_events ADD CONSTRAINT instagram_dm_start_events_skip_code_check
      CHECK(skip_code IN ('sender_cooldown','connection_hourly_limit'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS instagram_dm_start_events_started_sender_idx
  ON instagram_dm_start_events(connection_id,sender_id,created_at) WHERE skip_code IS NULL;
CREATE INDEX IF NOT EXISTS instagram_dm_start_events_started_idx
  ON instagram_dm_start_events(connection_id,created_at) WHERE skip_code IS NULL;
CREATE INDEX IF NOT EXISTS instagram_dm_start_events_skipped_idx
  ON instagram_dm_start_events(connection_id,created_at) WHERE skip_code IS NOT NULL;
