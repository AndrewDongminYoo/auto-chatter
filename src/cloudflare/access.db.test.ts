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
      "DROP TABLE IF EXISTS private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
    );
    await client.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
    await client.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='auto_chatter_server') THEN CREATE ROLE auto_chatter_server; END IF; END $$",
    );
    await client.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END $$",
    );
    await client.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role");
    await client.query("GRANT CREATE ON SCHEMA public TO PUBLIC");
    await client.query(await readFile(new URL("../../deploy/supabase-access.sql", import.meta.url), "utf8"));
    for (const role of ["anon", "authenticated", "service_role"]) {
      await client.query(`SET ROLE ${role}`);
      await assert.rejects(client.query("SELECT * FROM private_reply_outbox"), { code: "42501" });
      await client.query("RESET ROLE");
    }
    await client.query("SET ROLE auto_chatter_server");
    await client.query("INSERT INTO workspaces VALUES ('11111111-1111-4111-8111-111111111111')");
    await client.query("UPDATE workspaces SET id=id");
    assert.equal((await client.query("SELECT count(*) FROM workspaces")).rows[0].count, "1");
    await assert.rejects(client.query("DELETE FROM workspaces"), { code: "42501" });
    await assert.rejects(client.query("CREATE TABLE public.forbidden(id int)"), { code: "42501" });
    await client.query("RESET ROLE");
    const protectedTables = await client.query(
      "SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity AND relname IN ('workspaces','instagram_connections','instagram_comment_rules','instagram_comment_events','private_reply_outbox')",
    );
    assert.equal(protectedTables.rowCount, 5);
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
