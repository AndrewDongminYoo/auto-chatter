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
\ir ../db/migrations/015_instagram_token_refresh.sql
\ir ../db/migrations/016_channel_consent.sql
\ir ../db/migrations/017_flow_versions.sql
\ir ../db/migrations/018_connection_data_deletion.sql
\ir ../db/migrations/019_person_data_deletion.sql
\ir ../db/migrations/020_workspace_data_deletion.sql
\ir ../db/migrations/021_flow_runs.sql
\ir ../db/migrations/022_workspace_roles.sql
\ir ../db/migrations/023_connection_deletion_locks.sql
\ir ../db/migrations/024_workspace_invites.sql
\ir ../db/migrations/025_flow_delays.sql
\ir ../db/migrations/026_flow_reply_waits.sql
\ir ../db/migrations/027_workspace_time_zone.sql
\ir ../db/migrations/028_unmatched_replies.sql
\ir ../db/migrations/029_conversation_assignment.sql
\ir ../db/migrations/030_scheduled_steps.sql
\ir ../db/migrations/031_flow_webhooks.sql
\ir ../db/migrations/032_inbox_read_state.sql
\ir ../db/migrations/033_inbox_labels_notes.sql
\ir supabase-access.sql
COMMIT;
