-- Run with psql -f deploy/migrate-multi-user.sql against the intended database.
-- Keep the old receiver deployed and sends disabled until this succeeds.
\set ON_ERROR_STOP on
BEGIN;
\ir ../db/migrations/003_comment_rule_matching.sql
\ir ../db/migrations/004_workspace_settings.sql
\ir ../db/migrations/005_instagram_oauth.sql
\ir ../db/migrations/006_follow_conversations.sql
\ir supabase-access.sql
COMMIT;
