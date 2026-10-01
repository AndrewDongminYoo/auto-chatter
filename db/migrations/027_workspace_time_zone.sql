-- Each workspace has one IANA time zone (#32), read when a flow run reaches a wait_until node.
-- Existing workspaces get the default. The API accepts only names in pg_timezone_names; there is no
-- CHECK constraint because that list is not immutable.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS time_zone text NOT NULL DEFAULT 'Asia/Seoul';
