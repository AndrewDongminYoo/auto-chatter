-- A run can stop at a delay node (#32) and resume later. resume_at is stored as timestamptz (UTC)
-- and resume_node_id names the delay it stopped at; both are set exactly while the run is waiting.
-- A run whose flow or connection is off when it comes due ends as cancelled with a failure code.
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS resume_at timestamptz;
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS resume_node_id text
  CHECK(resume_node_id IS NULL OR resume_node_id ~ '^[A-Za-z0-9_-]{1,40}$');
DO $$
DECLARE
  old_check text;
BEGIN
  -- The status checks from migration 021 are unnamed, so they are found by what they check.
  FOR old_check IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='flow_runs'::regclass AND contype='c' AND conname<>'flow_runs_state'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE flow_runs DROP CONSTRAINT %I', old_check);
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flow_runs'::regclass AND conname='flow_runs_state') THEN
    ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_state CHECK(
      status IN ('delivering','ended','skipped','failed','waiting','cancelled')
      AND (status IN ('skipped','failed','cancelled')) = (failure_code IS NOT NULL)
      AND (status='waiting') = (resume_at IS NOT NULL)
      AND (status='waiting') = (resume_node_id IS NOT NULL)
    );
  END IF;
END $$;
-- The scheduled resume reads due runs oldest first.
CREATE INDEX IF NOT EXISTS flow_runs_due_idx ON flow_runs(resume_at, id) WHERE status='waiting';
