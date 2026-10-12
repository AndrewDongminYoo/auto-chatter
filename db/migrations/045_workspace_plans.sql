-- Plan entitlements, phase 1 (#52, docs/specs/2026-10-12-plan-entitlements.md). Each workspace has one plan
-- whose seat and connection limits live in PLANS in src/app/plans.ts; the CHECK lists the same keys. Existing
-- workspaces get advanced and new ones free. The column is added with the advanced default only when it is
-- missing (ADD COLUMN IF NOT EXISTS changes nothing when it exists, its default included), so a replay keeps a
-- plan an administrator changed since. The constraint is added by name only when missing.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'advanced';
ALTER TABLE workspaces ALTER COLUMN plan SET DEFAULT 'free';
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='workspaces'::regclass AND conname='workspaces_plan') THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_plan
      CHECK(plan IN ('free','essential','pro','business','advanced'));
  END IF;
END $$;
