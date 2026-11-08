import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { Pool } from "pg";
import { resetTestSchema, schemaTableNames } from "./test-schema.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) {
  throw new Error("Database tests require a local automations_test database");
}

const pool = new Pool({ connectionString: databaseUrl });
const identityLinkTables = ["instagram_contact_identity_links", "instagram_contact_identity_link_events"];

// The drop list that src/instagram/reply-worker.db.test.ts used before the shared reset (issue #262).
const legacyDropList =
  "DROP TABLE IF EXISTS campaign_deliveries, campaign_runs, campaign_approval_events, campaign_approvals, campaign_drafts, workspace_reply_templates, webhook_redelivery_events, webhook_deliveries, webhook_signing_keys, webhook_endpoints, scheduled_steps, workspace_invites, data_deletion_records, instagram_inbox_reminder_events, instagram_inbox_reminders, instagram_inbox_notes, instagram_inbox_label_events, instagram_inbox_label_rules, instagram_inbox_conversation_labels, instagram_inbox_labels, instagram_inbox_read_state, instagram_inbox_conversation_events, instagram_inbox_conversations, flow_step_runs, flow_runs, flow_versions, flows, channel_consent_state, channel_consent_events, instagram_manual_reply_events, instagram_manual_replies, instagram_inbox_handoff_events, instagram_inbox_handoffs, instagram_inbox_messages, instagram_unmatched_replies, instagram_contact_automation, instagram_contact_field_values, instagram_contact_fields, instagram_segment_snapshot_members, instagram_segment_snapshots, instagram_contact_segments, instagram_contact_tags, instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE";

after(async () => {
  await pool.end();
});

async function publicTables(): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return result.rows.map((row) => row.name);
}

async function foreignKeys(): Promise<string[]> {
  const result = await pool.query<{ key: string }>(
    `SELECT format('%s.%s %s', c.conrelid::regclass, c.conname, pg_get_constraintdef(c.oid)) AS key
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = 'f'
      ORDER BY 1`,
  );
  return result.rows.map((row) => row.key);
}

async function connectionKeyTables(): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    `SELECT DISTINCT c.conrelid::regclass::text AS name
       FROM pg_constraint c
      WHERE c.contype = 'f' AND c.confrelid = 'public.instagram_connections'::regclass AND c.conrelid::regclass::text = ANY($1)
      ORDER BY 1`,
    [identityLinkTables],
  );
  return result.rows.map((row) => row.name);
}

test("resetTestSchema restores the foreign keys that an incomplete drop list leaves out", async () => {
  const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");

  // Baseline: drop every public table that the catalog lists, independent of the helper, then apply the schema.
  const existing = await publicTables();
  if (existing.length > 0) await pool.query(`DROP TABLE IF EXISTS ${existing.join(", ")} CASCADE`);
  await pool.query(schema);
  assert.deepEqual(
    [...schemaTableNames(schema)].sort(),
    await publicTables(),
    "the helper's table list must name every table that db/schema.sql creates",
  );
  const baseline = await foreignKeys();
  assert.deepEqual(await connectionKeyTables(), [...identityLinkTables].sort());

  try {
    // Reproduce the defect: the legacy list omits the identity-link tables, so CASCADE drops only their keys.
    await pool.query(legacyDropList);
    await pool.query(schema);
    assert.deepEqual(await connectionKeyTables(), [], "the legacy reset must reach the broken state");

    await resetTestSchema(pool);
    assert.deepEqual(await connectionKeyTables(), [...identityLinkTables].sort());
    assert.deepEqual(await foreignKeys(), baseline);
  } finally {
    await resetTestSchema(pool);
  }
});
