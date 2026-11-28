-- Apply through deploy/migrate-multi-user.sql before deploying the code that issues keys with the contacts:write
-- scope (#48, docs/specs/2026-11-27-public-contact-writes-design.md). Existing keys hold {contacts:read}, which the
-- new CHECK still admits, so no key row changes. The running code issues only {contacts:read}, so it keeps working
-- between this migration and the deploy.
-- A key is read-only ({contacts:read}) or reads and writes contacts ({contacts:read,contacts:write}). A write key
-- always reads too, because a write answers with the written contact. The code stores the scopes in this order.
-- The runner replays this file on every rollout, after migration 082 admitted flows:start keys, so the constraint is
-- added NOT VALID: stored keys are not checked here, and 082 then replaces it with the validated wider constraint in
-- the same transaction.
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check
  CHECK(scopes = ARRAY['contacts:read']::text[] OR scopes = ARRAY['contacts:read','contacts:write']::text[]) NOT VALID;
