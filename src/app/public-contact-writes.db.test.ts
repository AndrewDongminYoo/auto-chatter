import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { publicApi } from "./public-api.ts";

// PATCH /v1/contacts/{connection_id}/{sender_id} and GET /v1/fields against the schema (#48,
// docs/specs/2026-11-27-public-contact-writes-design.md).

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const ownerId = "11111111-1111-4111-8111-111111111111";
const adminId = "22222222-2222-4222-8222-222222222222";
const outsiderId = "88888888-8888-4888-8888-888888888888";
const workspaceId = "55555555-5555-4555-8555-555555555555";
const otherWorkspaceId = "66666666-6666-4666-8666-666666666666";
const connection = "33333333-3333-4333-8333-333333333333";
const foreignConnection = "77777777-7777-4777-8777-777777777777";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };
const allow = { limit: async () => ({ success: true }) };
const sender = "sender/1 %";

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces, workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role,email)
     VALUES($1,$2,'owner','owner@example.test'),($1,$3,'admin','admin@example.test'),($4,$5,'owner','outsider@example.test')`,
    [workspaceId, ownerId, adminId, otherWorkspaceId, outsiderId],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,active)
     VALUES($1,$2,'123','shop',true),($3,$4,'900','foreign_shop',true)`,
    [connection, workspaceId, foreignConnection, otherWorkspaceId],
  );
  await pool.query(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     VALUES($1,$2,'c1','media',$3,'RAW COMMENT'),($4,$5,'c2','media',$3,'FOREIGN COMMENT')`,
    [workspaceId, connection, sender, otherWorkspaceId, foreignConnection],
  );
});

after(async () => pool.end());

const dbPool = () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool;

function dashboard(actorId: string, method: string, path: string, body?: unknown) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...apiEnv, API_WRITE_USER_LIMIT: allow, API_WRITE_WORKSPACE_LIMIT: allow },
    dbPool,
    (async () => Response.json({ id: actorId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

async function issue(scopes = ["contacts:read", "contacts:write"], actor = adminId): Promise<{ id: string; key: string; scopes: string[] }> {
  const response = await dashboard(actor, "POST", "/api/workspace/api-keys", { name: "CRM", scopes });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json() as Promise<{ id: string; key: string; scopes: string[] }>;
}

type Limit = { limit: (input: { key: string; limit?: number }) => Promise<{ success: boolean }> };
function write(key: string, body: unknown, options: { conn?: string; senderId?: string; workspaceLimit?: Limit } = {}) {
  const path = `/v1/contacts/${options.conn ?? connection}/${encodeURIComponent(options.senderId ?? sender)}`;
  return publicApi(
    new Request(`https://app.test${path}`, { method: "PATCH", headers: { Authorization: `Bearer ${key}`, "CF-Connecting-IP": "203.0.113.7", "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    { API_IP_LIMIT: allow, API_KEY_LIMIT: allow, API_WRITE_WORKSPACE_LIMIT: options.workspaceLimit ?? allow },
    dbPool,
    "corr-db",
  );
}

async function errorOf(response: Response, status: number): Promise<string> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return (JSON.parse(text) as { error: string }).error;
}

async function ok(response: Response): Promise<Record<string, unknown> & { tags: string[]; fields: Record<string, { name: string; type: string; value: unknown }> }> {
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function stored(conn = connection) {
  const tags = (await pool.query<{ tags: string[] }>("SELECT tags FROM instagram_contact_tags WHERE connection_id=$1 AND sender_id=$2", [conn, sender])).rows[0]?.tags ?? null;
  const values = (await pool.query<{ field_id: string; value: unknown }>("SELECT field_id::text,value FROM instagram_contact_field_values WHERE connection_id=$1 AND sender_id=$2 ORDER BY field_id", [conn, sender])).rows;
  return { tags, values };
}

async function field(name: string, type: string, workspace = workspaceId, archived = false): Promise<string> {
  return (await pool.query<{ id: string }>("INSERT INTO instagram_contact_fields(workspace_id,name,type,archived) VALUES($1,$2,$3,$4) RETURNING id::text", [workspace, name, type, archived])).rows[0]!.id;
}

function counting(): Limit & { calls: { key: string; limit?: number }[] } {
  const calls: { key: string; limit?: number }[] = [];
  return {
    calls,
    limit: async (input) => {
      calls.push(input);
      return { success: true };
    },
  };
}

test("a write removes, then adds, keeps the tags it does not name, and sets and clears typed fields", async () => {
  const { key } = await issue();
  await pool.query("INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,ARRAY['agent','trial'])", [workspaceId, connection, sender]);
  const tier = await field("tier", "text");
  const spent = await field("spent", "number");
  const vip = await field("vip", "boolean");
  const since = await field("since", "date");
  const contact = await ok(await write(key, { tags: { add: [" VIP ", "구매"], remove: ["TRIAL", "never"] }, fields: { [tier]: "gold", [spent]: 1234.5, [vip]: false, [since]: "2026-11-27" } }));
  assert.deepEqual(contact.tags, ["agent", "vip", "구매"]);
  assert.equal(contact.sender_id, sender);
  assert.equal(contact.connection_id, connection);
  assert.deepEqual(contact.fields[tier], { name: "tier", type: "text", value: "gold" });
  assert.deepEqual(contact.fields[vip], { name: "vip", type: "boolean", value: false });
  assert.equal(contact.fields[spent]!.value, 1234.5);
  assert.equal(contact.fields[since]!.value, "2026-11-27");
  assert.equal(JSON.stringify(contact).includes("RAW COMMENT"), false);
  // null clears one value and leaves the others; a tag that is not named stays.
  const cleared = await ok(await write(key, { fields: { [tier]: null } }));
  assert.equal(cleared.fields[tier], undefined);
  assert.deepEqual(cleared.tags, ["agent", "vip", "구매"]);
  assert.equal(cleared.fields[vip]!.value, false);
  const after = await stored();
  // A cleared value is stored as NULL, as the dashboard clears it; no row is deleted.
  assert.equal(after.values.length, 4);
  assert.equal(after.values.find((row) => row.field_id === tier)!.value, null);
});

test("the same request sent again gives the same result", async () => {
  const { key } = await issue();
  const tier = await field("tier", "text");
  const body = { tags: { add: ["vip"], remove: ["trial"] }, fields: { [tier]: "gold" } };
  const first = await ok(await write(key, body));
  const firstStored = await stored();
  const second = await ok(await write(key, body));
  assert.deepEqual(second.tags, first.tags);
  assert.deepEqual(second.fields, first.fields);
  assert.deepEqual(await stored(), firstStored);
});

test("a result above 20 tags, a wrong value type and an archived field write nothing at all", async () => {
  const { key } = await issue();
  const full = Array.from({ length: 19 }, (_, index) => `t${String(index).padStart(2, "0")}`);
  await pool.query("INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,$4)", [workspaceId, connection, sender, full]);
  const tier = await field("tier", "text");
  const spent = await field("spent", "number");
  const archived = await field("old", "text", workspaceId, true);
  const date = await field("since", "date");
  const before = await stored();
  assert.equal(await errorOf(await write(key, { tags: { add: ["a", "b"] }, fields: { [tier]: "gold" } }), 409), "contact_tag_limit");
  assert.equal(await errorOf(await write(key, { tags: { add: ["a"] }, fields: { [tier]: "gold", [spent]: "12" } }), 400), "invalid_field_value");
  assert.equal(await errorOf(await write(key, { tags: { add: ["a"] }, fields: { [spent]: 12, [archived]: "x" } }), 404), "field_not_found");
  for (const [id, value] of [
    [tier, 12],
    [tier, "x".repeat(1001)],
    [spent, true],
    [date, "2026-02-30"],
  ] as const)
    assert.equal(await errorOf(await write(key, { fields: { [id]: value } }), 400), "invalid_field_value", `${id} ${String(value)}`);
  assert.deepEqual(await stored(), before);
  // Removing one makes room for one more; exactly 20 is accepted.
  assert.equal((await ok(await write(key, { tags: { add: ["a", "b"], remove: ["t00"] } }))).tags.length, 20);
});

test("a read-only key, a foreign connection, contact or field, and a key of a removed member change nothing", async () => {
  const readOnly = await issue(["contacts:read"]);
  assert.deepEqual(readOnly.scopes, ["contacts:read"]);
  const writer = await issue(["contacts:write", "contacts:read"]);
  assert.deepEqual(writer.scopes, ["contacts:read", "contacts:write"]);
  const foreignField = await field("tier", "text", otherWorkspaceId);
  const workspace = counting();
  const body = { tags: { add: ["vip"] } };
  assert.equal(await errorOf(await write(readOnly.key, body, { workspaceLimit: workspace }), 403), "insufficient_scope");
  // A read-only key spends nothing of the workspace write limit.
  assert.deepEqual(workspace.calls, []);
  assert.equal(await errorOf(await write(writer.key, body, { conn: foreignConnection }), 404), "connection_not_found");
  assert.equal(await errorOf(await write(writer.key, body, { senderId: "no-such-sender" }), 404), "contact_not_found");
  assert.equal(await errorOf(await write(writer.key, { fields: { [foreignField]: "gold" } }), 404), "field_not_found");
  assert.equal(await errorOf(await write(writer.key, body, { conn: "not-a-uuid" }), 400), "invalid_request");
  assert.deepEqual(await stored(), { tags: null, values: [] });
  assert.deepEqual(await stored(foreignConnection), { tags: null, values: [] });
  // The foreign workspace's own contact with the same sender ID is never touched by this key.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_contact_tags")).rows[0].n, 0);
  const removed = await dashboard(ownerId, "DELETE", `/api/workspace/members/${adminId}`);
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal(await errorOf(await write(writer.key, body), 401), "invalid_api_key");
  assert.deepEqual(await stored(), { tags: null, values: [] });
});

test("a write spends the workspace limit with the plan's hourly count, and only a 200 records the key's use", async () => {
  const { id, key } = await issue();
  await pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [workspaceId]);
  const lastUse = async () => (await pool.query("SELECT last_used_at FROM api_keys WHERE id=$1", [id])).rows[0].last_used_at;
  const workspace = counting();
  assert.equal(await errorOf(await write(key, {}, { workspaceLimit: workspace }), 400), "invalid_request");
  assert.deepEqual(workspace.calls, []);
  assert.equal(await errorOf(await write(key, { tags: { add: ["vip"] } }, { senderId: "missing", workspaceLimit: workspace }), 404), "contact_not_found");
  assert.equal(await lastUse(), null);
  await ok(await write(key, { tags: { add: ["vip"] } }, { workspaceLimit: workspace }));
  assert.deepEqual(workspace.calls, [
    { key: workspaceId, limit: 1500 },
    { key: workspaceId, limit: 1500 },
  ]);
  assert.ok(await lastUse());
  // Over the limit: 429 and nothing written.
  const refused = await write(key, { tags: { add: ["more"] } }, { workspaceLimit: { limit: async () => ({ success: false }) } });
  assert.equal(await errorOf(refused, 429), "rate_limited");
  assert.deepEqual((await stored()).tags, ["vip"]);
});

test("GET /v1/fields lists the workspace's active fields by name with contacts:read", async () => {
  const { key } = await issue(["contacts:read"]);
  const beta = await field("beta", "number");
  const alpha = await field("alpha", "text");
  await field("archived", "text", workspaceId, true);
  await field("foreign", "text", otherWorkspaceId);
  const response = await publicApi(new Request("https://app.test/v1/fields", { headers: { Authorization: `Bearer ${key}` } }), { API_IP_LIMIT: allow, API_KEY_LIMIT: allow }, dbPool, "corr-db");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    fields: [
      { id: alpha, name: "alpha", type: "text" },
      { id: beta, name: "beta", type: "number" },
    ],
  });
});

test("tag adds of overlapping writes are both kept", async () => {
  const { key } = await issue();
  // A third session holds the contact lock, so both writes wait for it inside their transactions.
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2, 0))", [connection, sender]);
    const first = write(key, { tags: { add: ["first"] } });
    const second = write(key, { tags: { add: ["second"] } });
    for (let attempt = 0; attempt < 200; attempt++) {
      const waiting = (await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n;
      if (waiting === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n, 2);
    await holder.query("COMMIT");
    await ok(await first);
    await ok(await second);
  } finally {
    holder.release();
  }
  assert.deepEqual([...(await stored()).tags!].sort(), ["first", "second"]);
});

test("a dashboard save from an editor opened before an API write is refused, and the API's tag stays", async () => {
  const { key } = await issue();
  const path = `/api/connections/${connection}/contacts/${encodeURIComponent(sender)}`;
  const saved = await dashboard(ownerId, "PATCH", path, { tags: ["agent"], expected_tags: [] });
  assert.equal(saved.status, 200, await saved.clone().text());
  // The editor reads ["agent"]; then the CRM adds a tag.
  await ok(await write(key, { tags: { add: ["crm"] } }));
  const stale = await dashboard(ownerId, "PATCH", path, { tags: ["agent", "new"], expected_tags: ["agent"] });
  assert.equal(await errorOf(stale, 409), "contact_tags_stale");
  assert.deepEqual((await stored()).tags, ["agent", "crm"]);
  // After a reload the save builds on the stored tags.
  const fresh = await dashboard(ownerId, "PATCH", path, { tags: ["agent", "crm", "new"], expected_tags: ["crm", "agent"] });
  assert.equal(fresh.status, 200, await fresh.clone().text());
  assert.deepEqual((await stored()).tags, ["agent", "crm", "new"]);
});

test("a write waiting behind a workspace deletion holds no connection lock, so the deletion does not deadlock", async () => {
  const { key } = await issue();
  const tier = await field("tier", "text");
  // The first two steps of delete_workspace_data: the workspace FOR UPDATE, then its connections FOR UPDATE. A field
  // value insert takes a key share on the workspace through its foreign key.
  const deletion = await pool.connect();
  try {
    await deletion.query("BEGIN");
    await deletion.query("SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
    const pending = write(key, { tags: { add: ["crm"] }, fields: { [tier]: "gold" } });
    const waiting = async () => (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n;
    for (let attempt = 0; attempt < 200 && (await waiting()) === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await waiting(), 1);
    // The deadlock check runs after deadlock_timeout (1s); a writer holding the connection would end one side with 40P01.
    await deletion.query("SET LOCAL lock_timeout='3s'");
    await deletion.query("SELECT id FROM instagram_connections WHERE workspace_id=$1 ORDER BY id FOR UPDATE", [workspaceId]);
    await deletion.query("ROLLBACK");
    const written = await ok(await pending);
    assert.deepEqual(written.tags, ["crm"]);
    assert.equal(written.fields[tier]?.value, "gold");
  } finally {
    deletion.release();
  }
});

test("a tag the old rule stored matches its normalized form in a dashboard save and an API removal", async () => {
  const { key } = await issue();
  const path = `/api/connections/${connection}/contacts/${encodeURIComponent(sender)}`;
  const legacy = (tags: string[]) => pool.query("UPDATE instagram_contact_tags SET tags=$3::text[] WHERE connection_id=$1 AND sender_id=$2", [connection, sender, tags]);
  // "J" + U+030C has no composed capital; lowercasing makes "j" + U+030C, which NFC composes to U+01F0. The old rule
  // stopped after lowercasing and stored "j" + U+030C; the rule now stores U+01F0.
  const saved = await dashboard(ownerId, "PATCH", path, { tags: ["J\u030C", "keep"], expected_tags: [] });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual((await stored()).tags, ["keep", "\u01F0"]);
  // The editor sends back the tags it read, and a save of the same list stores the same strings.
  const again = await dashboard(ownerId, "PATCH", path, { tags: ["keep", "\u01F0"], expected_tags: ["keep", "\u01F0"] });
  assert.equal(again.status, 200, await again.clone().text());
  assert.deepEqual((await stored()).tags, ["keep", "\u01F0"]);
  // Every spelling of the tag is the stored tag, so an add changes nothing.
  for (const spelling of ["J\u030C", "j\u030C", "\u01F0"]) {
    assert.deepEqual((await ok(await write(key, { tags: { add: [spelling] } }))).tags, ["keep", "\u01F0"]);
  }
  // A dashboard save of a list the old rule stored moves the tag to its normalized form.
  await legacy(["j\u030C", "keep"]);
  const moved = await dashboard(ownerId, "PATCH", path, { tags: ["j\u030C", "keep"], expected_tags: ["j\u030C", "keep"] });
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.deepEqual((await stored()).tags, ["keep", "\u01F0"]);
  await legacy(["j\u030C", "keep"]);
  assert.deepEqual((await ok(await write(key, { tags: { add: ["vip"] } }))).tags, ["j\u030C", "keep", "vip"]);
  // The API stores the normalized form beside the old one, which it keeps. A repeated add changes nothing, and one
  // remove takes both forms.
  assert.deepEqual((await ok(await write(key, { tags: { add: ["J\u030C"] } }))).tags, ["j\u030C", "keep", "vip", "\u01F0"]);
  assert.deepEqual((await ok(await write(key, { tags: { add: ["\u01F0"] } }))).tags, ["j\u030C", "keep", "vip", "\u01F0"]);
  assert.deepEqual((await ok(await write(key, { tags: { remove: ["j\u030C"] } }))).tags, ["keep", "vip"]);
  await legacy(["j\u030C", "keep"]);
  assert.deepEqual((await ok(await write(key, { tags: { remove: ["J\u030C"] } }))).tags, ["keep"]);
  // The dashboard save compares the exact stored strings. An editor that read only U+01F0 is stale when the old form is
  // stored beside it, so its save cannot remove that tag; a list in another spelling is stale too.
  await legacy(["j\u030C", "\u01F0"]);
  const behind = await dashboard(ownerId, "PATCH", path, { tags: ["\u01F0", "new"], expected_tags: ["\u01F0"] });
  assert.equal(await errorOf(behind, 409), "contact_tags_stale");
  const respelled = await dashboard(ownerId, "PATCH", path, { tags: ["\u01F0", "new"], expected_tags: ["J\u030C", "\u01F0"] });
  assert.equal(await errorOf(respelled, 409), "contact_tags_stale");
  assert.deepEqual((await stored()).tags, ["j\u030C", "\u01F0"]);
  const current = await dashboard(ownerId, "PATCH", path, { tags: ["\u01F0", "new"], expected_tags: ["\u01F0", "j\u030C"] });
  assert.equal(current.status, 200, await current.clone().text());
  assert.deepEqual((await stored()).tags, ["new", "\u01F0"]);
});

test("migration 081 replays, keeps read-only keys and admits only the two scope sets in order", async () => {
  const readOnly = await issue(["contacts:read"]);
  const migration = await readFile(new URL("../../db/migrations/081_api_key_contact_writes.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  assert.deepEqual((await pool.query("SELECT scopes FROM api_keys WHERE id=$1", [readOnly.id])).rows[0].scopes, ["contacts:read"]);
  const insert = (scopes: string[]) =>
    pool.query(
      `INSERT INTO api_keys(workspace_id,name,key_prefix,key_hash,scopes,created_by,expires_at)
       VALUES($1,'raw','ac_live_abcd',encode(sha256(gen_random_uuid()::text::bytea),'hex'),$2::text[],$3,now()+interval '1 day')`,
      [workspaceId, scopes, adminId],
    );
  await insert(["contacts:read", "contacts:write"]);
  for (const scopes of [["contacts:write"], ["contacts:write", "contacts:read"], ["contacts:read", "contacts:read"], [], ["contacts:read", "contacts:write", "contacts:delete"]])
    await assert.rejects(insert(scopes), (error: unknown) => (error as { code?: string }).code === "23514", JSON.stringify(scopes));
});
