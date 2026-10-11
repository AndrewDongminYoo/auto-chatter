-- Expired Instagram OAuth states (#173). OAuth completion and the invite move check already ignore a state
-- whose expires_at has passed, so removing it changes no behavior. Server roles have no table DELETE, so the
-- Cloudflare cron removes them through this administrator-owned function, at most 1,000 rows per call; the
-- next run removes the rest. SKIP LOCKED leaves a row that another transaction holds for a later run.
CREATE OR REPLACE FUNCTION public.delete_expired_oauth_states()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH gone AS (
    DELETE FROM public.instagram_oauth_states
    WHERE state_hash IN (
      SELECT state_hash FROM public.instagram_oauth_states
      WHERE expires_at<=now()
      LIMIT 1000
      FOR UPDATE SKIP LOCKED
    )
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;
REVOKE ALL ON FUNCTION public.delete_expired_oauth_states() FROM PUBLIC;
