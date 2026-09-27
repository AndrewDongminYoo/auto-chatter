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
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.instagram_comment_events_id_seq, public.private_reply_outbox_id_seq, public.instagram_inbox_messages_id_seq TO %I', server_role);
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
  FOREACH product_table IN ARRAY ARRAY['instagram_inbox_messages', 'instagram_contact_automation', 'instagram_contact_fields', 'instagram_contact_field_values', 'instagram_contact_segments', 'instagram_contact_tags', 'workspaces', 'workspace_members', 'instagram_follow_conversations', 'instagram_message_receipts', 'instagram_oauth_states', 'instagram_connections', 'instagram_comment_rules', 'instagram_comment_events', 'private_reply_outbox'] LOOP
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

REVOKE ALL ON SEQUENCE public.instagram_comment_events_id_seq, public.private_reply_outbox_id_seq, public.instagram_inbox_messages_id_seq FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.instagram_comment_events_id_seq, public.private_reply_outbox_id_seq, public.instagram_inbox_messages_id_seq FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
