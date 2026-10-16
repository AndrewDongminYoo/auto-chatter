ALTER TABLE instagram_manual_replies
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS schedule_time_zone text,
  ADD COLUMN IF NOT EXISTS schedule_version integer NOT NULL DEFAULT 1;
ALTER TABLE instagram_manual_replies DROP CONSTRAINT IF EXISTS instagram_manual_replies_status_check;
ALTER TABLE instagram_manual_replies ADD CONSTRAINT instagram_manual_replies_status_check
  CHECK(status IN ('pending','sending','sent','failed','unknown','cancelled'));
ALTER TABLE instagram_manual_replies DROP CONSTRAINT IF EXISTS instagram_manual_replies_schedule_version_check;
ALTER TABLE instagram_manual_replies ADD CONSTRAINT instagram_manual_replies_schedule_version_check CHECK(schedule_version>0);
ALTER TABLE instagram_manual_replies DROP CONSTRAINT IF EXISTS instagram_manual_replies_schedule_pair;
ALTER TABLE instagram_manual_replies ADD CONSTRAINT instagram_manual_replies_schedule_pair
  CHECK((scheduled_at IS NULL)=(schedule_time_zone IS NULL));
ALTER TABLE instagram_manual_replies DROP CONSTRAINT IF EXISTS instagram_manual_replies_cancelled_schedule;
ALTER TABLE instagram_manual_replies ADD CONSTRAINT instagram_manual_replies_cancelled_schedule
  CHECK(status<>'cancelled' OR scheduled_at IS NOT NULL);

ALTER TABLE instagram_manual_reply_events
  ADD COLUMN IF NOT EXISTS request_fingerprint text,
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS schedule_version integer;
ALTER TABLE instagram_manual_reply_events DROP CONSTRAINT IF EXISTS instagram_manual_reply_events_kind_check;
ALTER TABLE instagram_manual_reply_events ADD CONSTRAINT instagram_manual_reply_events_kind_check
  CHECK(kind IN ('queued','retry_requested','sending','sent','failed','deferred','unknown','no_retry','rescheduled','cancelled'));
ALTER TABLE instagram_manual_reply_events DROP CONSTRAINT IF EXISTS instagram_manual_reply_events_check;
ALTER TABLE instagram_manual_reply_events ADD CONSTRAINT instagram_manual_reply_events_check
  CHECK((kind IN ('queued','retry_requested','no_retry','rescheduled','cancelled') AND actor_id IS NOT NULL)
    OR (kind NOT IN ('queued','retry_requested','no_retry','rescheduled','cancelled') AND actor_id IS NULL));
ALTER TABLE instagram_manual_reply_events DROP CONSTRAINT IF EXISTS instagram_manual_reply_events_request_fingerprint_check;
ALTER TABLE instagram_manual_reply_events ADD CONSTRAINT instagram_manual_reply_events_request_fingerprint_check
  CHECK(request_fingerprint ~ '^[a-f0-9]{64}$');
ALTER TABLE instagram_manual_reply_events DROP CONSTRAINT IF EXISTS instagram_manual_reply_events_schedule_version_check;
ALTER TABLE instagram_manual_reply_events ADD CONSTRAINT instagram_manual_reply_events_schedule_version_check CHECK(schedule_version>0);
