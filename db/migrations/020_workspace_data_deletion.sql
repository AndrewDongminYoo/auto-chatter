-- Evidence of a deleted workspace. It has no foreign keys because the workspace and its connections are gone,
-- and it holds only counts, time and the administrator who ran the deletion (see the workspace deletion spec).
CREATE TABLE IF NOT EXISTS workspace_deletion_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_counts jsonb NOT NULL CHECK(jsonb_typeof(deleted_counts)='object')
);

-- Administrator-only: deletes every record of one workspace, including opt-outs and deletion evidence,
-- then the membership and the workspace. The Supabase Auth user is deleted separately by the administrator.
-- It is a SECURITY INVOKER function with EXECUTE revoked from every runtime and API role.
CREATE OR REPLACE FUNCTION public.delete_workspace_data(p_workspace uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  connections uuid[];
  members uuid[];
  deleted jsonb := '{}'::jsonb;
  affected bigint;
  saved public.workspace_deletion_records%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'invalid_actor' USING ERRCODE='AC006';
  END IF;
  PERFORM 1 FROM public.workspaces WHERE id=p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found' USING ERRCODE='AC001';
  END IF;
  -- FOR UPDATE also blocks new rows that reference these connections until this transaction ends.
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO connections
  FROM (SELECT id FROM public.instagram_connections WHERE workspace_id=p_workspace ORDER BY id FOR UPDATE) locked;
  IF EXISTS(SELECT 1 FROM public.instagram_connections WHERE id=ANY(connections)
    AND (active OR send_enabled OR access_token_encrypted IS NOT NULL)) THEN
    RAISE EXCEPTION 'connection_active' USING ERRCODE='AC002';
  END IF;
  -- Lock the delivery rows first: an uncommitted claim would otherwise still read as pending here,
  -- and the DELETE below would remove the row after the claim commits it as sending.
  PERFORM 1 FROM public.private_reply_outbox WHERE workspace_id=p_workspace ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.instagram_follow_conversations WHERE connection_id=ANY(connections) ORDER BY reply_id FOR UPDATE;
  PERFORM 1 FROM public.instagram_manual_replies WHERE workspace_id=p_workspace ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.private_reply_outbox WHERE workspace_id=p_workspace AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_follow_conversations WHERE connection_id=ANY(connections) AND status='sending')
    OR EXISTS(SELECT 1 FROM public.instagram_manual_replies WHERE workspace_id=p_workspace AND status='sending') THEN
    RAISE EXCEPTION 'sending_in_progress' USING ERRCODE='AC003';
  END IF;
  SELECT coalesce(array_agg(user_id ORDER BY user_id), '{}') INTO members
  FROM public.workspace_members WHERE workspace_id=p_workspace;

  -- Children before parents, following the foreign keys (the multi-user cutover note keeps the same order).
  UPDATE public.flows SET published_version_id=NULL WHERE workspace_id=p_workspace;
  DELETE FROM public.flow_versions WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flow_versions', affected);
  DELETE FROM public.flows WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('flows', affected);
  DELETE FROM public.instagram_manual_reply_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_manual_reply_events', affected);
  DELETE FROM public.instagram_manual_replies WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_manual_replies', affected);
  DELETE FROM public.instagram_inbox_handoff_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoff_events', affected);
  DELETE FROM public.instagram_inbox_handoffs WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_handoffs', affected);
  DELETE FROM public.instagram_inbox_messages WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_inbox_messages', affected);
  DELETE FROM public.instagram_contact_automation WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_automation', affected);
  DELETE FROM public.instagram_contact_tags WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_tags', affected);
  DELETE FROM public.instagram_contact_field_values WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_field_values', affected);
  DELETE FROM public.instagram_contact_segments WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_segments', affected);
  DELETE FROM public.instagram_contact_fields WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_contact_fields', affected);
  DELETE FROM public.instagram_follow_conversations WHERE connection_id=ANY(connections);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_follow_conversations', affected);
  DELETE FROM public.instagram_message_receipts WHERE connection_id=ANY(connections);
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_message_receipts', affected);
  DELETE FROM public.private_reply_outbox WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('private_reply_outbox', affected);
  DELETE FROM public.channel_consent_state WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('channel_consent_state', affected);
  DELETE FROM public.channel_consent_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('channel_consent_events', affected);
  DELETE FROM public.instagram_comment_events WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_comment_events', affected);
  DELETE FROM public.instagram_comment_rules WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_comment_rules', affected);
  DELETE FROM public.data_deletion_records WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('data_deletion_records', affected);
  DELETE FROM public.instagram_connections WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_connections', affected);
  DELETE FROM public.instagram_oauth_states WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('instagram_oauth_states', affected);
  DELETE FROM public.workspace_members WHERE workspace_id=p_workspace;
  GET DIAGNOSTICS affected = ROW_COUNT;
  deleted := deleted || jsonb_build_object('workspace_members', affected);
  DELETE FROM public.workspaces WHERE id=p_workspace;

  INSERT INTO public.workspace_deletion_records(workspace_id,requested_by,deleted_counts)
  VALUES(p_workspace,p_actor,deleted)
  RETURNING * INTO saved;
  -- Member IDs are returned so the administrator can delete the Auth users; they are not stored.
  RETURN jsonb_build_object(
    'id', saved.id,
    'completed_at', saved.completed_at,
    'deleted_counts', saved.deleted_counts,
    'member_user_ids', to_jsonb(members)
  );
END $$;
REVOKE ALL ON FUNCTION public.delete_workspace_data(uuid,uuid) FROM PUBLIC;
