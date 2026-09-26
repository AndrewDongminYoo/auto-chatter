import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

test("Supabase roles cannot read product data; the server role has DML without DELETE or DDL", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const url = new URL(databaseUrl);
  if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
    throw new Error("Database tests require a local automations_test database");
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query(
      "DROP TABLE IF EXISTS instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
    );
    await client.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
    await client.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='auto_chatter_server') THEN CREATE ROLE auto_chatter_server; END IF; END $$",
    );
    await client.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END $$",
    );
    await client.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='automations_app') THEN CREATE ROLE automations_app; END IF; END $$",
    );
    await client.query("GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO automations_app");
    await client.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role");
    await client.query("GRANT CREATE ON SCHEMA public TO PUBLIC");
    await client.query(await readFile(new URL("../../deploy/supabase-access.sql", import.meta.url), "utf8"));
    for (const role of ["anon", "authenticated", "service_role"]) {
      await client.query(`SET ROLE ${role}`);
      for (const table of [
        "workspaces",
        "workspace_members",
        "instagram_oauth_states",
        "instagram_connections",
        "instagram_comment_rules",
        "instagram_comment_events",
        "private_reply_outbox",
        "instagram_follow_conversations",
        "instagram_message_receipts",
      ])
        await assert.rejects(client.query(`SELECT * FROM ${table}`), { code: "42501" });
      await client.query("RESET ROLE");
    }
    await client.query("SET ROLE auto_chatter_server");
    await client.query("INSERT INTO workspaces VALUES ('11111111-1111-4111-8111-111111111111')");
    await client.query("UPDATE workspaces SET id=id");
    await client.query(
      "INSERT INTO workspace_members VALUES ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111')",
    );
    assert.equal((await client.query("SELECT count(*) FROM workspaces")).rows[0].count, "1");
    await assert.rejects(client.query("DELETE FROM workspaces"), { code: "42501" });
    await assert.rejects(client.query("CREATE TABLE public.forbidden(id int)"), { code: "42501" });
    await client.query("RESET ROLE");
    await client.query("SET ROLE automations_app");
    assert.equal((await client.query("SELECT count(*) FROM workspace_members")).rows[0].count, "1");
    await client.query(
      "INSERT INTO instagram_oauth_states(state_hash,user_id,workspace_id,expires_at) VALUES ('compose-test','33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',now()+interval '1 hour')",
    );
    assert.equal(
      (await client.query("UPDATE instagram_oauth_states SET consumed_at=now() WHERE state_hash='compose-test'"))
        .rowCount,
      1,
    );
    assert.equal((await client.query("SELECT count(*) FROM workspaces")).rows[0].count, "1");
    await client.query("INSERT INTO workspaces VALUES ('22222222-2222-4222-8222-222222222222')");
    await client.query("UPDATE workspaces SET id=id");
    await assert.rejects(client.query("DELETE FROM workspaces"), { code: "42501" });
    await assert.rejects(client.query("CREATE TABLE public.forbidden_compose(id int)"), { code: "42501" });
    for (const table of [
      "workspace_members",
      "instagram_oauth_states",
      "instagram_follow_conversations",
      "instagram_message_receipts",
    ])
      await client.query(`SELECT * FROM ${table}`);
    await client.query("RESET ROLE");
    const protectedTables = await client.query(
      "SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity AND relname IN ('workspaces','workspace_members','instagram_oauth_states','instagram_follow_conversations','instagram_message_receipts','instagram_connections','instagram_comment_rules','instagram_comment_events','private_reply_outbox')",
    );
    assert.equal(protectedTables.rowCount, 9);
    // Exercise RLS independently of table grants: an accidental future grant must not expose rows.
    await client.query("GRANT SELECT ON workspaces TO anon");
    await client.query("SET ROLE anon");
    assert.equal((await client.query("SELECT count(*) FROM workspaces")).rows[0].count, "0");
    await client.query("RESET ROLE");
    await client.query("ALTER TABLE workspaces OWNER TO auto_chatter_server");
    await assert.rejects(
      client.query(await readFile(new URL("../../deploy/supabase-access.sql", import.meta.url), "utf8")),
      /must not own database objects/,
    );
  } finally {
    await client.query("RESET ROLE");
    client.release();
    await pool.end();
  }
});
