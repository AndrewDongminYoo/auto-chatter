-- Administrator-only psql script. Supply verified user_id and workspace_id via -v.
-- Requires Supabase auth.users; never expose this operation through the public API.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assign_workspace_owner(target_user uuid, target_workspace uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE previous_workspace uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=target_user AND email_confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Confirmed Supabase user required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(target_user::text));
  PERFORM 1 FROM workspaces WHERE id=target_workspace FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found'; END IF;
  IF EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=target_workspace AND role='owner' AND removed_at IS NULL AND user_id<>target_user) THEN
    RAISE EXCEPTION 'Workspace already owned';
  END IF;
  SELECT workspace_id INTO previous_workspace FROM workspace_members WHERE user_id=target_user AND removed_at IS NULL FOR UPDATE;
  IF previous_workspace IS NOT NULL AND previous_workspace<>target_workspace THEN
    PERFORM 1 FROM workspaces WHERE id=previous_workspace FOR UPDATE;
    -- The same emptiness rule as currentWorkspaceMovable in src/app/workspace-members.ts.
    IF EXISTS(SELECT 1 FROM instagram_connections WHERE workspace_id=previous_workspace)
      OR EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=previous_workspace AND user_id<>target_user AND removed_at IS NULL)
      OR EXISTS(SELECT 1 FROM instagram_comment_rules WHERE workspace_id=previous_workspace)
      OR EXISTS(SELECT 1 FROM flows WHERE workspace_id=previous_workspace)
      OR EXISTS(SELECT 1 FROM instagram_contact_fields WHERE workspace_id=previous_workspace)
      OR EXISTS(SELECT 1 FROM instagram_contact_segments WHERE workspace_id=previous_workspace)
      OR EXISTS(SELECT 1 FROM workspace_invites WHERE workspace_id=previous_workspace)
      OR EXISTS(SELECT 1 FROM instagram_oauth_states WHERE workspace_id=previous_workspace AND consumed_at IS NULL AND expires_at>now()) THEN
      RAISE EXCEPTION 'Existing workspace is not empty or has an active OAuth flow';
    END IF;
  END IF;
  INSERT INTO workspace_members(user_id,workspace_id,role) VALUES(target_user,target_workspace,'owner')
    ON CONFLICT(user_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,role='owner',removed_at=NULL,removed_by=NULL;
END $$;
SELECT pg_temp.assign_workspace_owner(:'user_id'::uuid, :'workspace_id'::uuid);
COMMIT;
