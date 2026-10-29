-- Apply through deploy/migrate-multi-user.sql.
-- recovered_at (#274): when stale recovery turned a row that was still sending after 10 minutes into unknown /
-- worker_interrupted. Operations health dates such an outcome from this time instead of its attempt start.
-- Rows recovered before this migration keep NULL and are dated by their attempt start, as before. No backfill.
-- campaign_deliveries already has updated_at, which its recovery sets, and manual replies have the unknown event.
ALTER TABLE private_reply_outbox ADD COLUMN IF NOT EXISTS recovered_at timestamptz;
ALTER TABLE instagram_follow_conversations ADD COLUMN IF NOT EXISTS recovered_at timestamptz;
-- The campaign sweep (#273) ends a pending row that the worker cannot reach as blocked without claiming it, so a
-- blocked row may now have no attempt. Every other rule of the constraint stays. The relaxation covers every blocked
-- row: the worker claims a row before it blocks it, so its blocked rows still carry their attempt, but the CHECK no
-- longer enforces that; the worker's DB tests assert it instead.
ALTER TABLE campaign_deliveries DROP CONSTRAINT IF EXISTS campaign_delivery_attempt;
ALTER TABLE campaign_deliveries ADD CONSTRAINT campaign_delivery_attempt CHECK(
  (status IN ('pending','cancelled','blocked') OR (attempt_id IS NOT NULL AND attempt_started_at IS NOT NULL))
  AND (status<>'pending' OR (attempt_id IS NULL AND attempt_started_at IS NULL))
  AND ((attempt_id IS NULL)=(attempt_started_at IS NULL)));
