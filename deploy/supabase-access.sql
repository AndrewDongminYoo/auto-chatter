-- Apply with schema.sql in one administrator transaction on a dedicated project.
DO $$
DECLARE server_role text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auto_chatter_server') THEN
    CREATE ROLE auto_chatter_server NOLOGIN;
  END IF;
  -- Existing Compose installations keep their DML role after the same migration.
  FOREACH server_role IN ARRAY ARRAY['auto_chatter_server', 'automations_app'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = server_role) THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT FROM pg_roles WHERE rolname = server_role
        AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    ) OR EXISTS (
      SELECT FROM pg_auth_members WHERE member = server_role::regrole
    ) THEN
      RAISE EXCEPTION '% must be an unprivileged role without memberships', server_role;
    END IF;
    IF EXISTS (SELECT FROM pg_class WHERE relowner = server_role::regrole)
      OR EXISTS (SELECT FROM pg_namespace WHERE nspowner = server_role::regrole)
      OR EXISTS (SELECT FROM pg_database WHERE datname = current_database() AND datdba = server_role::regrole)
    THEN
      RAISE EXCEPTION '% must not own database objects', server_role;
    END IF;
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', server_role);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', server_role);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.channel_consent_events_id_seq, public.instagram_comment_events_id_seq, public.private_reply_outbox_id_seq, public.instagram_inbox_messages_id_seq TO %I', server_role);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
DECLARE
  product_table text;
  api_role text;
  server_roles text := 'auto_chatter_server';
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'automations_app') THEN
    server_roles := server_roles || ', automations_app';
  END IF;
  FOREACH product_table IN ARRAY ARRAY['data_deletion_records', 'flows', 'flow_versions', 'flow_runs', 'flow_step_runs', 'channel_consent_state', 'channel_consent_events', 'instagram_manual_replies', 'instagram_manual_reply_events', 'instagram_inbox_handoffs', 'instagram_inbox_handoff_events', 'instagram_inbox_messages', 'instagram_contact_automation', 'instagram_contact_fields', 'instagram_contact_field_values', 'instagram_contact_segments', 'instagram_contact_tags', 'workspaces', 'workspace_members', 'instagram_follow_conversations', 'instagram_message_receipts', 'instagram_oauth_states', 'instagram_connections', 'instagram_comment_rules', 'instagram_comment_events', 'private_reply_outbox'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', product_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, %s', product_table, server_roles);
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', product_table, api_role);
      END IF;
    END LOOP;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO %s', product_table, server_roles);
    EXECUTE format('DROP POLICY IF EXISTS server_select ON public.%I', product_table);
    EXECUTE format('DROP POLICY IF EXISTS server_insert ON public.%I', product_table);
    EXECUTE format('DROP POLICY IF EXISTS server_update ON public.%I', product_table);
    EXECUTE format('CREATE POLICY server_select ON public.%I FOR SELECT TO %s USING (true)', product_table, server_roles);
    EXECUTE format('CREATE POLICY server_insert ON public.%I FOR INSERT TO %s WITH CHECK (true)', product_table, server_roles);
    EXECUTE format('CREATE POLICY server_update ON public.%I FOR UPDATE TO %s USING (true) WITH CHECK (true)', product_table, server_roles);
  END LOOP;
END $$;

REVOKE ALL ON SEQUENCE public.channel_consent_events_id_seq, public.instagram_comment_events_id_seq, public.private_reply_outbox_id_seq, public.instagram_inbox_messages_id_seq FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.channel_consent_events_id_seq, public.instagram_comment_events_id_seq, public.private_reply_outbox_id_seq, public.instagram_inbox_messages_id_seq FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

-- Handoff audit is append-only even for the server roles.
DO $$
DECLARE server_role text;
BEGIN
  FOREACH server_role IN ARRAY ARRAY['auto_chatter_server','automations_app'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=server_role) THEN
      EXECUTE format('REVOKE UPDATE ON public.instagram_inbox_handoff_events FROM %I',server_role);
    END IF;
  END LOOP;
END $$;
DROP POLICY IF EXISTS server_update ON public.instagram_inbox_handoff_events;

-- Manual delivery audit is append-only for both runtime roles.
DO $$
DECLARE server_role text;
BEGIN
  FOREACH server_role IN ARRAY ARRAY['auto_chatter_server','automations_app'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=server_role) THEN
      EXECUTE format('REVOKE UPDATE ON public.instagram_manual_reply_events FROM %I',server_role);
    END IF;
  END LOOP;
END $$;
DROP POLICY IF EXISTS server_update ON public.instagram_manual_reply_events;

-- Consent evidence is append-only; only its current-state projection can be updated.
DO $$
DECLARE server_role text;
BEGIN
  FOREACH server_role IN ARRAY ARRAY['auto_chatter_server','automations_app'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=server_role) THEN
      EXECUTE format('REVOKE UPDATE ON public.channel_consent_events FROM %I',server_role);
    END IF;
  END LOOP;
END $$;
DROP POLICY IF EXISTS server_update ON public.channel_consent_events;

-- Published flow versions are immutable; only the flow draft and its publish pointer change.
DO $$
DECLARE server_role text;
BEGIN
  FOREACH server_role IN ARRAY ARRAY['auto_chatter_server','automations_app'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=server_role) THEN
      EXECUTE format('REVOKE UPDATE ON public.flow_versions FROM %I',server_role);
    END IF;
  END LOOP;
END $$;
DROP POLICY IF EXISTS server_update ON public.flow_versions;

-- Flow step history is append-only; a run keeps the path it took.
DO $$
DECLARE server_role text;
BEGIN
  FOREACH server_role IN ARRAY ARRAY['auto_chatter_server','automations_app'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=server_role) THEN
      EXECUTE format('REVOKE UPDATE ON public.flow_step_runs FROM %I',server_role);
    END IF;
  END LOOP;
END $$;
DROP POLICY IF EXISTS server_update ON public.flow_step_runs;

-- Deletion evidence is written only by delete_connection_data; runtime roles may read it.
DO $$
DECLARE server_role text; api_role text;
BEGIN
  FOREACH server_role IN ARRAY ARRAY['auto_chatter_server','automations_app'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=server_role) THEN
      EXECUTE format('REVOKE INSERT, UPDATE ON public.data_deletion_records FROM %I',server_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.delete_connection_data(uuid,uuid,uuid,text) TO %I',server_role);
    END IF;
  END LOOP;
  FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.delete_connection_data(uuid,uuid,uuid,text) FROM %I',api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.delete_connection_data(uuid,uuid,uuid,text) FROM PUBLIC;
DROP POLICY IF EXISTS server_insert ON public.data_deletion_records;
DROP POLICY IF EXISTS server_update ON public.data_deletion_records;

-- Person deletion is administrator-only: no runtime or API role may execute it.
DO $$
DECLARE any_role text;
BEGIN
  FOREACH any_role IN ARRAY ARRAY['auto_chatter_server','automations_app','anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=any_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.delete_person_data(uuid,uuid,uuid,text,text) FROM %I',any_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.delete_person_data(uuid,uuid,uuid,text,text) FROM PUBLIC;

-- Workspace deletion and its evidence are administrator-only: no runtime or API role may execute or read them.
ALTER TABLE public.workspace_deletion_records ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE any_role text;
BEGIN
  FOREACH any_role IN ARRAY ARRAY['auto_chatter_server','automations_app','anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=any_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.delete_workspace_data(uuid,uuid) FROM %I',any_role);
      EXECUTE format('REVOKE ALL ON TABLE public.workspace_deletion_records FROM %I',any_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.delete_workspace_data(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON TABLE public.workspace_deletion_records FROM PUBLIC;
