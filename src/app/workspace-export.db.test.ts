import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { EXCLUDED_ITEMS, EXCLUDED_TABLES, EXPORTED_TABLES } from "./workspace-export.ts";
import { seedWorkspace } from "./workspace-fixture.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const strangerId = "33333333-3333-4333-8333-333333333330";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const connectionId = "55555555-5555-4555-8555-555555555555";
const foreignConnectionId = "77777777-7777-4777-8777-777777777777";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };
// Columns whose names look secret but hold only timestamps.
const benignSecretLikeColumns = new Set(["token_expires_at", "token_obtained_at", "token_refresh_attempted_at"]);

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await seedWorkspace(pool, workspaceId, userId, connectionId, "account-own");
  await seedWorkspace(pool, otherWorkspaceId, otherUserId, foreignConnectionId, "account-foreign");
});

after(async () => pool.end());

function request(actorId = userId) {
  return appApi(
    new Request("https://app.test/api/workspace/export", {
      method: "GET",
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test" },
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () =>
      Response.json({ id: actorId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

test("exports every table of the caller's workspace and nothing from another workspace", async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment; filename="auto-chatter-export-\d{4}-\d{2}-\d{2}\.json"$/,
  );
  const body = await response.json();
  assert.equal(body.format, "auto-chatter-workspace-export");
  assert.equal(body.version, 1);
  assert.equal(body.workspace_id, workspaceId);
  assert.deepEqual(body.excluded, EXCLUDED_ITEMS);
  assert.ok(body.excluded.includes("instagram_connections.access_token_encrypted"));
  assert.deepEqual(Object.keys(body.tables).sort(), Object.keys(EXPORTED_TABLES).sort());
  for (const [table, rows] of Object.entries(body.tables as Record<string, Record<string, unknown>[]>)) {
    assert.ok(rows.length > 0, `${table} was seeded but exported no rows`);
    for (const row of rows) {
      if ("workspace_id" in row) assert.equal(row.workspace_id, workspaceId, table);
      if ("connection_id" in row) assert.equal(row.connection_id, connectionId, table);
    }
  }
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /SECRET-CIPHERTEXT/);
  assert.doesNotMatch(text, /state-hash-/);
  assert.doesNotMatch(text, /account-foreign/);
  assert.ok(text.includes("comment text account-own"));
  assert.equal(body.tables.instagram_connections[0].access_token_encrypted, undefined);
  assert.ok(body.excluded.includes("instagram_unmatched_replies.message_text"));
  assert.doesNotMatch(text, /kept dm text/);
  assert.equal(body.tables.instagram_unmatched_replies[0].message_id, "kept-account-own");
  assert.ok(body.tables.instagram_connections[0].token_expires_at);
});

test("the export carries the caller's workspace row with its time zone and no other workspace", async () => {
  await pool.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1", [workspaceId]);
  await pool.query("UPDATE workspaces SET time_zone='Europe/Paris' WHERE id=$1", [otherWorkspaceId]);
  const body = await (await request()).json();
  assert.deepEqual(body.tables.workspaces, [{ id: workspaceId, time_zone: "America/New_York" }]);
  assert.ok(!body.excluded.includes("workspaces"));
});

test("every public table is exported or explicitly excluded, and secret-like columns are omitted", async () => {
  const tables = (
    await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
    )
  ).rows.map((row) => row.table_name);
  const classified = new Set([...Object.keys(EXPORTED_TABLES), ...EXCLUDED_TABLES]);
  assert.deepEqual(
    tables.filter((table) => !classified.has(table)),
    [],
    "a new table must be added to EXPORTED_TABLES or EXCLUDED_TABLES",
  );
  const columns = (
    await pool.query<{ table_name: string; column_name: string }>(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'",
    )
  ).rows;
  for (const { table_name: table, column_name: column } of columns) {
    const config = EXPORTED_TABLES[table];
    if (!config || benignSecretLikeColumns.has(column) || !/token|secret|encrypt|password|hash/i.test(column)) continue;
    assert.ok(config.omit?.includes(column), `${table}.${column} looks secret and must be omitted from the export`);
  }
});

test("bigint identifiers above 2^53 are exported exactly", async () => {
  await pool.query(
    `INSERT INTO instagram_comment_events(id,workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     OVERRIDING SYSTEM VALUE VALUES(9007199254740993,$1,$2,'comment-big','1789','123','big id')`,
    [workspaceId, connectionId],
  );
  const text = await (await request()).text();
  assert.ok(text.includes('"id": 9007199254740993') || text.includes('"id":9007199254740993'), "bigint id was rounded");
});

test("a signed-in user without a workspace cannot export", async () => {
  const response = await request(strangerId);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "workspace_required");
});
