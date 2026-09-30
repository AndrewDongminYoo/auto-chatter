-- A workspace can have several members, each with one role; a user still belongs to one workspace.
-- Existing single members become owners.
ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'owner';
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='workspace_members'::regclass AND conname='workspace_members_role') THEN
    ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role CHECK(role IN ('owner','admin','agent'));
  END IF;
END $$;
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_workspace_id_key;
CREATE INDEX IF NOT EXISTS workspace_members_workspace_idx ON workspace_members(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_one_owner_idx ON workspace_members(workspace_id) WHERE role='owner';
