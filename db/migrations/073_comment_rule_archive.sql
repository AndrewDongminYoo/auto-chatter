-- Apply through deploy/migrate-multi-user.sql, then deploy the code that reads archived_at right away.
-- Comment rule archive (#371): DELETE /api/rules/<id> sets archived_at and turns the rule off in one statement.
-- An archived row is final: the CHECK keeps it disabled, so every send and ingest guard that reads enabled skips
-- it, and its outbox rows keep their rule_id. A new rule on the same media is a new row, so the one-rule-per-media
-- uniqueness now covers only rows that are not archived.
-- Between this migration and the deploy, the running code's ON CONFLICT(connection_id, media_id) without the
-- index predicate cannot infer the partial index, so saving a new rule fails until the new code is deployed.
-- Existing rows keep NULL. No backfill.
ALTER TABLE instagram_comment_rules ADD COLUMN IF NOT EXISTS archived_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='instagram_comment_rules'::regclass AND conname='instagram_comment_rules_archived_disabled') THEN
    ALTER TABLE instagram_comment_rules ADD CONSTRAINT instagram_comment_rules_archived_disabled
      CHECK(archived_at IS NULL OR NOT enabled);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS instagram_comment_rules_active_media
  ON instagram_comment_rules(connection_id, media_id) WHERE archived_at IS NULL;
ALTER TABLE instagram_comment_rules DROP CONSTRAINT IF EXISTS instagram_comment_rules_connection_id_media_id_key;
