import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { exportContactCsv, CONTACT_CSV_HEADER } from "./contact-csv.ts";
import { decodeContactScalar, parseContactCsv } from "./contact-csv-test-utils.ts";
import { publicApi } from "./public-api.ts";
import { decodeContactsCursor, encodeContactsCursor } from "./public-contacts.ts";

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
// The UUID order is the page order: connection, then disconnected, then the other workspace's connection.
const connection = "33333333-3333-4333-8333-333333333333";
const disconnected = "44444444-4444-4444-8444-444444444444";
const foreignConnection = "77777777-7777-4777-8777-777777777777";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };
const allow = { limit: async () => ({ success: true }) };
const contactKeys = ["channel", "identity_kind", "connection_id", "sender_id", "connection_username", "first_comment_recorded_at", "last_comment_recorded_at", "comment_count", "automation_paused", "tags", "fields"];

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
     VALUES($1,$2,'123','shop',true),($3,$2,'124',NULL,false),($4,$5,'900','foreign_shop',true)`,
    [connection, workspaceId, disconnected, foreignConnection, otherWorkspaceId],
  );
});

after(async () => pool.end());

function dashboard(actorId: string, method: string, path: string, body?: unknown) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...apiEnv, CONTACT_EXPORT_LIMIT: allow },
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () => Response.json({ id: actorId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

async function issue(actor = adminId): Promise<{ id: string; key: string }> {
  const response = await dashboard(actor, "POST", "/api/workspace/api-keys", { name: "CRM", scopes: ["contacts:read"] });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json() as Promise<{ id: string; key: string }>;
}

function read(key: string, query = "", headers: Record<string, string> = { Authorization: `Bearer ${key}` }) {
  return publicApi(new Request(`https://app.test/v1/contacts${query}`, { headers: { "CF-Connecting-IP": "203.0.113.7", ...headers } }), { API_IP_LIMIT: allow, API_KEY_LIMIT: allow }, () => ({ query: pool.query.bind(pool), end: async () => {} }) as unknown as Pool, "corr-db");
}

type Contact = Record<string, unknown> & { connection_id: string; sender_id: string };
type Page = { contacts: Contact[]; next_cursor: string | null };

async function page(key: string, query = ""): Promise<Page> {
  const response = await read(key, query);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as Page;
}

// Follows next_cursor to the end and returns every page.
async function readAll(key: string, query: Record<string, string> = {}): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams(query);
    if (cursor) params.set("after", cursor);
    const next = await page(key, `?${params}`);
    pages.push(next);
    cursor = next.next_cursor;
  } while (cursor && pages.length < 1000);
  return pages;
}

async function add(senders: string[], conn = connection, workspace = workspaceId) {
  await pool.query(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,sender_username,comment_text,created_at)
     SELECT $1,$2,gen_random_uuid()::text,'media',sender,'sender_secret_name','RAW COMMENT SECRET','2026-10-04T12:34:56.123456Z' FROM unnest($3::text[]) AS sender`,
    [workspace, conn, senders],
  );
}

async function errorOf(response: Response, status: number): Promise<string> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return (JSON.parse(text) as { error: string }).error;
}

async function lastUse(id: string) {
  return (await pool.query("SELECT last_used_at,last_used_ip FROM api_keys WHERE id=$1", [id])).rows[0];
}

const numbered = (count: number) => Array.from({ length: count }, (_, index) => String(index + 1).padStart(4, "0"));

test("pages of exactly 0, 100 and 101 contacts end with a null cursor and never repeat or skip a contact", async () => {
  const { key } = await issue();
  assert.deepEqual(await page(key), { contacts: [], next_cursor: null });

  await add(numbered(100));
  const full = await page(key);
  assert.equal(full.contacts.length, 100);
  assert.equal(full.next_cursor, null);

  await add(["0101"]);
  const pages = await readAll(key);
  assert.deepEqual(
    pages.map((each) => each.contacts.length),
    [100, 1],
  );
  assert.equal(pages[1]!.next_cursor, null);
  assert.deepEqual(decodeContactsCursor(pages[0]!.next_cursor!), { connectionId: connection, senderId: "0100" });
  assert.deepEqual(
    pages.flatMap((each) => each.contacts.map((contact) => contact.sender_id)),
    numbered(101),
  );
});

test("small pages follow the connection order, then the sender order of the column's collation, and include disconnected accounts", async () => {
  const { key } = await issue();
  // Mixed case and punctuation, whose order depends on the collation: the expected order comes from the same database.
  await add(["b", "B", "a", "_z", "10", "9"]);
  await add(["1"], disconnected);
  // Two comments of one sender are one contact.
  await add(["a"]);
  const pages = await readAll(key, { limit: "2" });
  assert.deepEqual(
    pages.map((each) => each.contacts.length),
    [2, 2, 2, 1],
  );
  const order = pages.flatMap((each) => each.contacts.map((contact) => [contact.connection_id, contact.sender_id]));
  const expected = await pool.query<{ connection_id: string; sender_id: string }>("SELECT DISTINCT connection_id,sender_id FROM instagram_comment_events WHERE workspace_id=$1 ORDER BY connection_id,sender_id", [workspaceId]);
  assert.deepEqual(
    order,
    expected.rows.map((row) => [row.connection_id, row.sender_id]),
  );
  assert.equal(order.length, 7);
  assert.deepEqual(order.at(-1), [disconnected, "1"]);
  const disconnectedContact = pages.at(-1)!.contacts[0]!;
  assert.equal(disconnectedContact.connection_username, null);
  assert.equal(pages.flatMap((each) => each.contacts).find((contact) => contact.sender_id === "a")!.comment_count, "2");

  // connection_id keeps the page to one connection of the workspace, and its cursor must match.
  const only = await readAll(key, { connection_id: disconnected, limit: "1" });
  assert.deepEqual(
    only.flatMap((each) => each.contacts.map((contact) => contact.sender_id)),
    ["1"],
  );
  const first = await page(key, `?connection_id=${connection}&limit=1`);
  assert.equal(await errorOf(await read(key, `?connection_id=${disconnected}&after=${first.next_cursor}`), 400), "invalid_request");
  // An owned connection without contacts is an empty page, not a 404.
  await pool.query("DELETE FROM instagram_comment_events WHERE connection_id=$1", [disconnected]);
  assert.deepEqual(await page(key, `?connection_id=${disconnected}`), { contacts: [], next_cursor: null });
});

test("every contact carries the CSV v1 values with exact field types and numbers, and nothing else", async () => {
  const { key } = await issue();
  await add(["00123", "00123", "90071992547409931234567890"]);
  await add(["00123"], disconnected);
  await pool.query("INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'00123',ARRAY['한글','alpha'])", [workspaceId, connection]);
  await pool.query("INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused,handoff_paused) VALUES($1,$2,'00123',false,true)", [workspaceId, connection]);
  await pool.query("UPDATE instagram_connections SET access_token_encrypted='TOKEN-SECRET' WHERE id=$1", [connection]);
  await pool.query("INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at) VALUES($1,$2,'00123','dm','RAW-DM-SECRET','text',now())", [workspaceId, connection]);
  const fields: Record<string, string> = {};
  for (const [name, type, value, archived] of [
    ["zero", "number", "0", false],
    ["no", "boolean", "false", false],
    ["empty", "text", '""', false],
    ["date", "date", '"2026-10-04"', false],
    ["big", "number", "9007199254740993.123456789", false],
    ["archived", "text", '"ARCHIVED SECRET"', true],
  ] as const) {
    const id = (await pool.query("INSERT INTO instagram_contact_fields(workspace_id,name,type,archived) VALUES($1,$2,$3,$4) RETURNING id", [workspaceId, name, type, archived])).rows[0].id as string;
    await pool.query("INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,'00123',$3,$4::jsonb)", [workspaceId, connection, id, value]);
    fields[name] = id;
  }
  const response = await read(key);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  // The raw text keeps every digit; a JavaScript number would round it.
  assert.match(text, /"value" ?: ?9007199254740993\.123456789[,}\s]/);
  assert.doesNotMatch(text, /sender_secret_name|RAW COMMENT SECRET|RAW-DM-SECRET|TOKEN-SECRET|ARCHIVED SECRET|foreign_shop/);
  const body = JSON.parse(text) as Page;
  assert.equal(body.contacts.length, 3);
  for (const contact of body.contacts) assert.deepEqual(Object.keys(contact).sort(), [...contactKeys].sort());
  const [first] = body.contacts;
  assert.deepEqual(first, {
    channel: "instagram",
    identity_kind: "comment_sender",
    connection_id: connection,
    sender_id: "00123",
    connection_username: "shop",
    first_comment_recorded_at: "2026-10-04T12:34:56.123456Z",
    last_comment_recorded_at: "2026-10-04T12:34:56.123456Z",
    comment_count: "2",
    automation_paused: true,
    tags: ["alpha", "한글"],
    fields: {
      [fields.zero!]: { name: "zero", type: "number", value: 0 },
      [fields.no!]: { name: "no", type: "boolean", value: false },
      [fields.empty!]: { name: "empty", type: "text", value: "" },
      [fields.date!]: { name: "date", type: "date", value: "2026-10-04" },
      // JSON.parse rounds it; the raw text check above proves the response keeps every digit.
      [fields.big!]: { name: "big", type: "number", value: Number("9007199254740993.123456789") },
    },
  });
  assert.equal(body.contacts[1]!.sender_id, "90071992547409931234567890");

  // The same rows as the CSV export v1, without the spreadsheet marker and the per-file columns.
  const csv = parseContactCsv((await exportContactCsv(pool, { id: ownerId, email: "owner@example.test" })).body)
    .slice(1)
    .map((row) => Object.fromEntries(CONTACT_CSV_HEADER.map((name, index) => [name, row[index]!])));
  assert.equal(csv.length, body.contacts.length);
  // The CSV orders sender IDs with "C" and the API with the column's collation, so rows are matched by identity.
  for (const row of csv) {
    const contact = body.contacts.find((each) => each.connection_id === row.connection_id && each.sender_id === decodeContactScalar(row.sender_id!))!;
    assert.ok(contact);
    assert.equal(contact.connection_id, row.connection_id);
    assert.equal(contact.sender_id, decodeContactScalar(row.sender_id!));
    assert.equal(contact.connection_username ?? "", row.connection_username === "" ? "" : decodeContactScalar(row.connection_username!));
    assert.equal(contact.first_comment_recorded_at, row.first_comment_recorded_at);
    assert.equal(contact.last_comment_recorded_at, row.last_comment_recorded_at);
    assert.equal(contact.comment_count, row.comment_count);
    assert.equal(String(contact.automation_paused), row.automation_paused);
    assert.deepEqual(contact.tags, JSON.parse(row.tags_json!));
    assert.deepEqual(contact.fields, JSON.parse(row.fields_json!));
  }
});

test("a key reads only its own workspace, whatever connection ID or cursor it sends", async () => {
  const { key } = await issue();
  const outsider = await issue(outsiderId);
  await add(["1", "2"]);
  await add(["0", "1", "3", "zzz"], foreignConnection, otherWorkspaceId);

  // The other workspace's connection is answered exactly like an ID that exists nowhere.
  const foreign = await read(key, `?connection_id=${foreignConnection}`);
  const missing = await read(key, "?connection_id=99999999-9999-4999-8999-999999999999");
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(await foreign.text(), await missing.text());

  // A cursor at a position of the other workspace's rows is only a position: it reads nothing of that workspace.
  for (const senderId of ["0", "1", "!"]) {
    const after = encodeContactsCursor({ connectionId: foreignConnection, senderId });
    assert.deepEqual(await page(key, `?after=${after}`), { contacts: [], next_cursor: null });
  }
  const before = encodeContactsCursor({ connectionId: "00000000-0000-4000-8000-000000000000", senderId: "0" });
  const fromStart = await page(key, `?after=${before}`);
  assert.deepEqual(
    fromStart.contacts.map((contact) => contact.connection_id),
    [connection, connection],
  );

  // A full read of each workspace holds only its own contacts.
  const own = (await readAll(key, { limit: "1" })).flatMap((each) => each.contacts);
  assert.ok(own.every((contact) => contact.connection_id === connection));
  assert.equal(own.length, 2);
  const theirs = (await readAll(outsider.key)).flatMap((each) => each.contacts);
  assert.deepEqual(
    theirs.map((contact) => contact.sender_id),
    ["0", "1", "3", "zzz"],
  );
  assert.ok(theirs.every((contact) => contact.connection_id === foreignConnection));
});

test("a revoked, expired, malformed or query-string key, and the key of a removed member, read nothing", async () => {
  await add(["1"]);
  const revoked = await issue();
  const response = await dashboard(ownerId, "POST", `/api/workspace/api-keys/${revoked.id}/revoke`);
  assert.equal(response.status, 200);
  const expired = await issue();
  await pool.query("UPDATE api_keys SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
  const valid = await issue();
  const refusals = [await read(revoked.key), await read(expired.key), await read("", "", { Authorization: `Bearer ${valid.key.slice(0, -1)}` }), await read("", "", { Authorization: valid.key }), await read("", `?api_key=${valid.key}`, {})];
  for (const refusal of refusals) assert.equal(await errorOf(refusal, 401), "invalid_api_key");

  assert.equal((await page(valid.key)).contacts.length, 1);
  const removed = await dashboard(ownerId, "DELETE", `/api/workspace/members/${adminId}`);
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal(await errorOf(await read(valid.key), 401), "invalid_api_key");
});

test("only a 200 records the key's last use; a 400 or 404 does not", async () => {
  await add(["1"]);
  const { id, key } = await issue();
  assert.equal(await errorOf(await read(key, "?limit=0"), 400), "invalid_request");
  assert.equal(await errorOf(await read(key, "?unknown=1"), 400), "invalid_request");
  assert.equal(await errorOf(await read(key, `?connection_id=${foreignConnection}`), 404), "connection_not_found");
  assert.deepEqual(await lastUse(id), { last_used_at: null, last_used_ip: null });
  await page(key);
  const used = await lastUse(id);
  assert.ok(used.last_used_at);
  assert.equal(used.last_used_ip, "203.0.113.7");
});
