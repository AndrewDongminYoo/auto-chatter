-- Apply with schema.sql in one administrator transaction on a dedicated project.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auto_chatter_server') THEN
    CREATE ROLE auto_chatter_server NOLOGIN;
  END IF;
  IF EXISTS (
    SELECT FROM pg_roles WHERE rolname = 'auto_chatter_server'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) OR EXISTS (
    SELECT FROM pg_auth_members WHERE member = 'auto_chatter_server'::regrole
  ) THEN
    RAISE EXCEPTION 'auto_chatter_server must be an unprivileged role without memberships';
  END IF;
  IF EXISTS (SELECT FROM pg_class WHERE relowner = 'auto_chatter_server'::regrole)
    OR EXISTS (SELECT FROM pg_namespace WHERE nspowner = 'auto_chatter_server'::regrole)
    OR EXISTS (SELECT FROM pg_database WHERE datname = current_database() AND datdba = 'auto_chatter_server'::regrole)
  THEN
    RAISE EXCEPTION 'auto_chatter_server must not own database objects';
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC, auto_chatter_server;
GRANT USAGE ON SCHEMA public TO auto_chatter_server;

DO $$
DECLARE
  product_table text;
  api_role text;
BEGIN
  FOREACH product_table IN ARRAY ARRAY['workspaces', 'workspace_members', 'instagram_follow_conversations', 'instagram_message_receipts', 'instagram_oauth_states', 'instagram_connections', 'instagram_comment_rules', 'instagram_comment_events', 'private_reply_outbox'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', product_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, auto_chatter_server', product_table);
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', product_table, api_role);
      END IF;
    END LOOP;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO auto_chatter_server', product_table);
    EXECUTE format('DROP POLICY IF EXISTS server_select ON public.%I', product_table);
    EXECUTE format('DROP POLICY IF EXISTS server_insert ON public.%I', product_table);
    EXECUTE format('DROP POLICY IF EXISTS server_update ON public.%I', product_table);
    EXECUTE format('CREATE POLICY server_select ON public.%I FOR SELECT TO auto_chatter_server USING (true)', product_table);
    EXECUTE format('CREATE POLICY server_insert ON public.%I FOR INSERT TO auto_chatter_server WITH CHECK (true)', product_table);
    EXECUTE format('CREATE POLICY server_update ON public.%I FOR UPDATE TO auto_chatter_server USING (true) WITH CHECK (true)', product_table);
  END LOOP;
END $$;

REVOKE ALL ON SEQUENCE public.instagram_comment_events_id_seq, public.private_reply_outbox_id_seq FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.instagram_comment_events_id_seq, public.private_reply_outbox_id_seq FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.instagram_comment_events_id_seq, public.private_reply_outbox_id_seq TO auto_chatter_server;
