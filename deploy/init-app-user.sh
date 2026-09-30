#!/bin/sh
set -eu

# Runs after schema creation, only when PostgreSQL initializes an empty volume.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE automations_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE automations TO automations_app;
GRANT USAGE ON SCHEMA public TO automations_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO automations_app;
REVOKE UPDATE ON instagram_manual_reply_events FROM automations_app;
REVOKE UPDATE ON instagram_inbox_handoff_events FROM automations_app;
REVOKE UPDATE ON channel_consent_events FROM automations_app;
REVOKE UPDATE ON flow_versions FROM automations_app;
REVOKE INSERT, UPDATE ON data_deletion_records FROM automations_app;
REVOKE ALL ON workspace_deletion_records FROM automations_app;
GRANT EXECUTE ON FUNCTION public.delete_connection_data(uuid,uuid,uuid,text) TO automations_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO automations_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO automations_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO automations_app;
SQL
