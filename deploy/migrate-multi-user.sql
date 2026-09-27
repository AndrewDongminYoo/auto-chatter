-- Run with psql -f deploy/migrate-multi-user.sql against the intended database.
-- Keep the old receiver deployed and sends disabled until this succeeds.
\set ON_ERROR_STOP on
BEGIN;
\ir ../db/migrations/003_comment_rule_matching.sql
\ir ../db/migrations/004_workspace_settings.sql
\ir ../db/migrations/005_instagram_oauth.sql
\ir ../db/migrations/006_follow_conversations.sql
\ir ../db/migrations/007_confirmation_button.sql
\ir ../db/migrations/008_instagram_contact_tags.sql
\ir ../db/migrations/009_contact_segments.sql
\ir ../db/migrations/010_contact_fields.sql
\ir ../db/migrations/011_contact_automation.sql
\ir ../db/migrations/012_instagram_inbox.sql
\ir ../db/migrations/013_inbox_handoffs.sql
\ir ../db/migrations/014_manual_replies.sql
\ir supabase-access.sql
COMMIT;
