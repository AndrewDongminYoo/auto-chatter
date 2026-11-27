import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Pool } from "pg";
import { API_KEY_SCOPES, apiKeyHash, apiKeyPrefix, clientIp, generateApiKey, isApiKeyFormat, parseApiKeyRequest } from "./api-keys.ts";
import { ApiError } from "./auth.ts";
import { PUBLIC_API_ROUTES, publicApi } from "./public-api.ts";
import { decodeContactsCursor, encodeContactsCursor, parseContactsQuery } from "./public-contacts.ts";

const keyId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const allow = { limit: async () => ({ success: true }) };

test("a generated API key is ac_live_ and 43 base64url characters, and only its hash and prefix are derived", () => {
  const key = generateApiKey();
  assert.match(key, /^ac_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(isApiKeyFormat(key), true);
  assert.notEqual(generateApiKey(), key);
  assert.match(apiKeyHash(key), /^[0-9a-f]{64}$/);
  assert.equal(apiKeyHash(key), apiKeyHash(key));
  assert.equal(apiKeyPrefix(key), key.slice(0, 12));
  assert.ok(apiKeyPrefix(key).startsWith("ac_live_"));
  for (const value of [undefined, "", `ac_test_${"a".repeat(43)}`, `ac_live_${"a".repeat(42)}`, `ac_live_${"a".repeat(44)}`, `ac_live_${"a".repeat(42)}=`, ` ${key}`]) assert.equal(isApiKeyFormat(value), false, String(value));
});

test("an API key request accepts a subset of the scope list, a listed expiry and a 1-80 character name", () => {
  assert.deepEqual(API_KEY_SCOPES, ["contacts:read"]);
  assert.deepEqual(parseApiKeyRequest({ name: "  CRM  ", scopes: ["contacts:read"] }), { name: "CRM", expiresInDays: 90, scopes: ["contacts:read"] });
  for (const days of [30, 90, 180, 365]) assert.equal(parseApiKeyRequest({ name: "CRM", scopes: ["contacts:read"], expires_in_days: days }).expiresInDays, days);
  assert.equal(parseApiKeyRequest({ name: "a".repeat(80), scopes: ["contacts:read"] }).name.length, 80);
  const refused: [unknown, string][] = [
    [null, "invalid_api_key"],
    [{ name: "CRM", scopes: ["contacts:read"], extra: true }, "invalid_api_key"],
    [{ name: "   ", scopes: ["contacts:read"] }, "invalid_api_key"],
    [{ name: "a".repeat(81), scopes: ["contacts:read"] }, "invalid_api_key"],
    [{ name: "CRM​", scopes: ["contacts:read"] }, "invalid_api_key"],
    [{ name: 5, scopes: ["contacts:read"] }, "invalid_api_key"],
    [{ name: "CRM", scopes: ["contacts:read"], expires_in_days: 0 }, "invalid_api_key_expiry"],
    [{ name: "CRM", scopes: ["contacts:read"], expires_in_days: "90" }, "invalid_api_key_expiry"],
    [{ name: "CRM", scopes: ["contacts:read"], expires_in_days: null }, "invalid_api_key_expiry"],
    [{ name: "CRM" }, "invalid_api_key_scopes"],
    [{ name: "CRM", scopes: [] }, "invalid_api_key_scopes"],
    [{ name: "CRM", scopes: ["contacts:write"] }, "invalid_api_key_scopes"],
    [{ name: "CRM", scopes: ["contacts:read", "contacts:read"] }, "invalid_api_key_scopes"],
    [{ name: "CRM", scopes: "contacts:read" }, "invalid_api_key_scopes"],
  ];
  for (const [input, code] of refused)
    assert.throws(
      () => parseApiKeyRequest(input),
      (error) => error instanceof ApiError && error.status === 400 && error.message === code,
      JSON.stringify(input),
    );
});

test("only an address in the CF-Connecting-IP form is kept for the last use", () => {
  assert.equal(clientIp("203.0.113.9"), "203.0.113.9");
  assert.equal(clientIp("2001:db8::1"), "2001:db8::1");
  for (const value of [null, "", "203.0.113.9, 10.0.0.1", "<script>", "a".repeat(46)]) assert.equal(clientIp(value), null);
});

type Recorded = { sql: string; params: unknown[] }[];
function keyPool(queries: Recorded, row: Record<string, unknown> | undefined, options: { failLookup?: boolean } = {}) {
  let ended = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (options.failLookup) throw new Error("database password=secret");
      if (sql.startsWith("SELECT")) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
    end: async () => {
      ended++;
    },
  };
  return { pool: pool as unknown as Pool, ended: () => ended };
}
const keyRow = { id: keyId, workspace_id: workspaceId, name: "CRM", scopes: ["contacts:read"], expires_at: new Date("2027-01-01T00:00:00Z") };

function call(headers: Record<string, string>, env: Parameters<typeof publicApi>[1], pool: Pool, path = "/v1/key", method = "GET") {
  return publicApi(new Request(`https://app.test${path}`, { method, headers }), env, () => pool, "corr-1");
}

test("GET /v1/key answers the key's ID, name, scopes, workspace and expiry, and records its use", async () => {
  const key = generateApiKey();
  const queries: Recorded = [];
  const { pool, ended } = keyPool(queries, keyRow);
  const spent: string[] = [];
  const env = {
    API_IP_LIMIT: { limit: async ({ key: name }: { key: string }) => (spent.push(`ip:${name}`), { success: true }) },
    API_KEY_LIMIT: { limit: async ({ key: name }: { key: string }) => (spent.push(`key:${name}`), { success: true }) },
  };
  const response = await call({ Authorization: `Bearer ${key}`, "CF-Connecting-IP": "203.0.113.9" }, env, pool);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await response.json();
  assert.deepEqual(body, { id: keyId, name: "CRM", scopes: ["contacts:read"], workspace_id: workspaceId, expires_at: "2027-01-01T00:00:00.000Z" });
  assert.ok(!JSON.stringify(body).includes(key));
  assert.deepEqual(spent, ["ip:203.0.113.9", `key:${keyId}`]);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0]!.params, [apiKeyHash(key)]);
  assert.match(queries[0]!.sql, /revoked_at IS NULL AND expires_at>now\(\)/);
  assert.match(queries[1]!.sql, /^UPDATE api_keys SET last_used_at/);
  assert.match(queries[1]!.sql, /interval '1 minute'/);
  assert.deepEqual(queries[1]!.params, [keyId, "203.0.113.9"]);
  assert.equal(ended(), 1);
});

test("a missing, malformed, unknown, revoked or expired key is the same 401", async () => {
  const key = generateApiKey();
  const env = { API_IP_LIMIT: allow, API_KEY_LIMIT: allow };
  const answers: string[] = [];
  const malformed: Record<string, string>[] = [{}, { Authorization: key }, { Authorization: `Basic ${key}` }, { Authorization: `Bearer ${key.slice(0, -1)}` }, { Authorization: `Bearer  ${key}` }, { Authorization: `bearer ${key.toUpperCase()}` }];
  for (const headers of malformed) {
    const queries: Recorded = [];
    const response = await call(headers, env, keyPool(queries, keyRow).pool);
    assert.equal(queries.length, 0, JSON.stringify(headers));
    answers.push(`${response.status} ${response.headers.get("www-authenticate")} ${await response.text()}`);
  }
  // An unknown key, and a revoked or expired one, which the lookup's conditions leave out the same way.
  const queries: Recorded = [];
  const unknown = await call({ Authorization: `Bearer ${key}` }, env, keyPool(queries, undefined).pool);
  answers.push(`${unknown.status} ${unknown.headers.get("www-authenticate")} ${await unknown.text()}`);
  assert.equal(queries.length, 1);
  assert.equal(new Set(answers).size, 1, answers.join("\n"));
  assert.equal(answers[0], '401 Bearer realm="auto-chatter" {"error":"invalid_api_key"}');
  // A key in the query string is never read.
  const query = await call({}, env, keyPool([], keyRow).pool, `/v1/key?api_key=${key}`);
  assert.equal(query.status, 401);
});

test("the Bearer scheme name is case-insensitive", async () => {
  const key = generateApiKey();
  const env = { API_IP_LIMIT: allow, API_KEY_LIMIT: allow };
  for (const scheme of ["bearer", "BEARER", "bEaReR"]) {
    const queries: Recorded = [];
    const response = await call({ Authorization: `${scheme} ${key}` }, env, keyPool(queries, keyRow).pool);
    assert.equal(response.status, 200, scheme);
    assert.deepEqual(queries[0]!.params, [apiKeyHash(key)]);
  }
});

test("the IP limit runs before the key is read, and the key limit before its use is recorded", async () => {
  const key = generateApiKey();
  const refuse = { limit: async () => ({ success: false }) };
  let queries: Recorded = [];
  let response = await call({ Authorization: `Bearer ${key}`, "CF-Connecting-IP": "203.0.113.9" }, { API_IP_LIMIT: refuse, API_KEY_LIMIT: allow }, keyPool(queries, keyRow).pool);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "rate_limited" });
  assert.equal(queries.length, 0);
  // A request without a client address shares one bucket instead of skipping the limit.
  const spent: string[] = [];
  response = await call({}, { API_IP_LIMIT: { limit: async ({ key: name }: { key: string }) => (spent.push(name), { success: true }) }, API_KEY_LIMIT: allow }, keyPool([], keyRow).pool);
  assert.equal(response.status, 401);
  assert.deepEqual(spent, ["unattributed"]);
  queries = [];
  response = await call({ Authorization: `Bearer ${key}` }, { API_IP_LIMIT: allow, API_KEY_LIMIT: refuse }, keyPool(queries, keyRow).pool);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "rate_limited" });
  assert.equal(queries.length, 1, "the lookup only; no use is recorded");
});

test("a missing or failing limiter refuses with 503 api_key_limit_unavailable", async () => {
  const key = generateApiKey();
  const broken = {
    limit: async () => {
      throw new Error("limiter down");
    },
  };
  for (const env of [{ API_KEY_LIMIT: allow }, { API_IP_LIMIT: broken, API_KEY_LIMIT: allow }, { API_IP_LIMIT: allow }, { API_IP_LIMIT: allow, API_KEY_LIMIT: broken }]) {
    const queries: Recorded = [];
    const response = await call({ Authorization: `Bearer ${key}` }, env, keyPool(queries, keyRow).pool);
    assert.equal(response.status, 503, JSON.stringify(Object.keys(env)));
    assert.deepEqual(await response.json(), { error: "api_key_limit_unavailable" });
    assert.ok(!queries.some(({ sql }) => sql.startsWith("UPDATE")));
  }
});

test("other /v1/ paths and methods need a valid key first, and a database failure logs no key", async () => {
  const key = generateApiKey();
  const env = { API_IP_LIMIT: allow, API_KEY_LIMIT: allow };
  assert.equal((await call({}, env, keyPool([], keyRow).pool, "/v1/unknown")).status, 401);
  // A refused path or method is not a successful use, so the key's last use is not recorded.
  let queries: Recorded = [];
  assert.equal((await call({ Authorization: `Bearer ${key}` }, env, keyPool(queries, keyRow).pool, "/v1/unknown")).status, 404);
  assert.equal((await call({ Authorization: `Bearer ${key}` }, env, keyPool(queries, keyRow).pool, "/v1/toString")).status, 404);
  assert.ok(!queries.some(({ sql }) => sql.startsWith("UPDATE")));
  queries = [];
  const post = await call({ Authorization: `Bearer ${key}` }, env, keyPool(queries, keyRow).pool, "/v1/key", "POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  assert.ok(!queries.some(({ sql }) => sql.startsWith("UPDATE")));
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const failed = await call({ Authorization: `Bearer ${key}` }, env, keyPool([], keyRow, { failLookup: true }).pool);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: "service_unavailable" });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /"event":"request_failed"/);
  assert.ok(!lines[0]!.includes(key) && !lines[0]!.includes("secret"));
});

const connectionId = "33333333-3333-4333-8333-333333333333";

test("the contacts query accepts limit 1-100, a connection UUID and a canonical cursor, and refuses everything else", () => {
  assert.deepEqual(parseContactsQuery(new URLSearchParams("")), { limit: 100, after: null, connectionId: null });
  assert.equal(parseContactsQuery(new URLSearchParams("limit=1")).limit, 1);
  assert.equal(parseContactsQuery(new URLSearchParams("limit=100")).limit, 100);
  assert.equal(parseContactsQuery(new URLSearchParams(`connection_id=${connectionId.toUpperCase()}`)).connectionId, connectionId);
  const cursor = encodeContactsCursor({ connectionId, senderId: "00123" });
  assert.deepEqual(parseContactsQuery(new URLSearchParams(`after=${cursor}&connection_id=${connectionId}&limit=5`)), { limit: 5, after: { connectionId, senderId: "00123" }, connectionId });
  const other = encodeContactsCursor({ connectionId: "44444444-4444-4444-8444-444444444444", senderId: "1" });
  const aliased = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=-1",
    "limit=01",
    "limit=1.5",
    "limit=",
    "limit=1&limit=2",
    "api_key=x",
    "connection_id=not-a-uuid",
    "connection_id=",
    "after=",
    "after=***",
    `after=${cursor}=`,
    `after=${aliased}`,
    `after=${Buffer.from("[1,2]").toString("base64url")}`,
    `after=${Buffer.from(JSON.stringify([connectionId, ""])).toString("base64url")}`,
    `after=${Buffer.from(JSON.stringify([connectionId, "1", "2"])).toString("base64url")}`,
    `after=${Buffer.from(JSON.stringify({ connectionId, senderId: "1" })).toString("base64url")}`,
    `after=${Buffer.from([0xff, 0xfe]).toString("base64url")}`,
    `after=${Buffer.from(JSON.stringify([connectionId, "1\u00002"])).toString("base64url")}`,
    `after=${other}&connection_id=${connectionId}`,
  ])
    assert.throws(
      () => parseContactsQuery(new URLSearchParams(query)),
      (error) => error instanceof ApiError && error.status === 400 && error.message === "invalid_request",
      query,
    );
});

test("a cursor round-trips any sender ID and its connection in lowercase", () => {
  for (const senderId of ["00123", "90071992547409931234567890", 'a"b\\c', "한글", " ", "9".repeat(10_000)]) {
    const cursor = encodeContactsCursor({ connectionId, senderId });
    assert.match(cursor, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeContactsCursor(cursor), { connectionId, senderId });
    assert.deepEqual(parseContactsQuery(new URLSearchParams({ after: cursor })).after, { connectionId, senderId });
  }
  assert.equal(decodeContactsCursor(encodeContactsCursor({ connectionId: connectionId.toUpperCase(), senderId: "1" })).connectionId, connectionId);
});

type ContactRow = { connection_id: string; sender_id: string; username: string | null; first_at: string; last_at: string; comment_count: string; paused: boolean; tags_json: string; fields_json: string };
function contactRow(senderId: string): ContactRow {
  return {
    connection_id: connectionId,
    sender_id: senderId,
    username: "shop",
    first_at: "2026-10-04T12:34:56.123456Z",
    last_at: "2026-10-04T12:34:56.123456Z",
    comment_count: "2",
    paused: false,
    tags_json: '["vip"]',
    fields_json: '{"f":{"name":"big","type":"number","value":9007199254740993.123456789}}',
  };
}
function contactsPool(queries: { sql: string; params: unknown[] }[], key: Record<string, unknown>, page: (ContactRow & { found: boolean })[]) {
  return {
    query: async (input: string | { text: string; values: unknown[]; query_timeout?: number }, params: unknown[] = []) => {
      const sql = typeof input === "string" ? input : input.text;
      queries.push({ sql, params: typeof input === "string" ? params : input.values });
      if (typeof input !== "string") {
        assert.equal(input.query_timeout, 10_000);
        return { rows: page, rowCount: page.length };
      }
      if (sql.startsWith("SELECT")) return { rows: [key], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    end: async () => {},
  } as unknown as Pool;
}

test("GET /v1/contacts reads one page under the key's workspace, keeps field numbers exact and records the use", async () => {
  const key = generateApiKey();
  const env = { API_IP_LIMIT: allow, API_KEY_LIMIT: allow };
  const queries: Recorded = [];
  const rows = ["1", "2", "3"].map((sender) => ({ ...contactRow(sender), found: true }));
  const response = await call({ Authorization: `Bearer ${key}`, "CF-Connecting-IP": "203.0.113.9" }, env, contactsPool(queries, keyRow, rows), "/v1/contacts?limit=2");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const text = await response.text();
  assert.match(text, /"value":9007199254740993\.123456789/);
  const body = JSON.parse(text);
  assert.equal(body.contacts.length, 2);
  assert.deepEqual(Object.keys(body.contacts[0]), ["channel", "identity_kind", "connection_id", "sender_id", "connection_username", "first_comment_recorded_at", "last_comment_recorded_at", "comment_count", "automation_paused", "tags", "fields"]);
  assert.deepEqual(body.contacts[0].tags, ["vip"]);
  assert.deepEqual(decodeContactsCursor(body.next_cursor), { connectionId, senderId: "2" });
  // The page statement is bound to the key's workspace and asks for one row more than the limit.
  assert.deepEqual(queries[1]!.params, [workspaceId, null, 3]);
  // Without a cursor or connection_id, the statement has no condition for them; no range or order uses "C", so the
  // contact lookup index drives the read.
  assert.doesNotMatch(queries[1]!.sql, /\$4|\$5|e\.connection_id=\$2/);
  assert.doesNotMatch(queries[1]!.sql.split("), page AS (")[0]!, /COLLATE/);
  assert.doesNotMatch(queries[1]!.sql.split("SELECT owned.found")[1]!, /COLLATE/);
  // A cursor adds the range on the index's own collation.
  const cursor = encodeContactsCursor({ connectionId, senderId: "2" });
  const paged: Recorded = [];
  assert.equal((await call({ Authorization: `Bearer ${key}` }, env, contactsPool(paged, keyRow, rows), `/v1/contacts?connection_id=${connectionId}&after=${cursor}&limit=2`)).status, 200);
  assert.deepEqual(paged[1]!.params, [workspaceId, connectionId, 3, connectionId, "2"]);
  assert.match(paged[1]!.sql, /e\.workspace_id=\$1 AND e\.connection_id=\$2::uuid AND \(e\.connection_id,e\.sender_id\)>\(\$4::uuid,\$5::text\)/);
  assert.match(queries[2]!.sql, /^UPDATE api_keys SET last_used_at/);
  assert.equal(queries.length, 3);
  // A full last page has no cursor.
  const last = await call({ Authorization: `Bearer ${key}` }, env, contactsPool([], keyRow, rows), "/v1/contacts?limit=3");
  assert.equal((await last.json()).next_cursor, null);
  // An empty page of an owned connection is the one LEFT JOIN row without a contact.
  const empty = await call({ Authorization: `Bearer ${key}` }, env, contactsPool([], keyRow, [{ found: true, connection_id: null } as unknown as ContactRow & { found: boolean }]), `/v1/contacts?connection_id=${connectionId}`);
  assert.equal(await empty.text(), '{"contacts":[],"next_cursor":null}');
});

test("GET /v1/contacts refuses a key without contacts:read, a bad query and a foreign connection without recording a use", async () => {
  const key = generateApiKey();
  const env = { API_IP_LIMIT: allow, API_KEY_LIMIT: allow };
  const headers = { Authorization: `Bearer ${key}` };
  let queries: Recorded = [];
  const noScope = await call(headers, env, contactsPool(queries, { ...keyRow, scopes: [] }, []), "/v1/contacts?limit=abc");
  assert.equal(noScope.status, 403);
  assert.deepEqual(await noScope.json(), { error: "insufficient_scope" });
  assert.equal(queries.length, 1, "the key lookup only");
  // /v1/key needs no scope.
  assert.equal((await call(headers, env, contactsPool([], { ...keyRow, scopes: [] }, []))).status, 200);
  queries = [];
  const bad = await call(headers, env, contactsPool(queries, keyRow, []), "/v1/contacts?limit=101");
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "invalid_request" });
  assert.equal(queries.length, 1);
  queries = [];
  const foreign = await call(headers, env, contactsPool(queries, keyRow, [{ found: false, connection_id: null } as unknown as ContactRow & { found: boolean }]), `/v1/contacts?connection_id=${connectionId}`);
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), { error: "connection_not_found" });
  assert.ok(!queries.some(({ sql }) => sql.startsWith("UPDATE")));
  const post = await call(headers, env, contactsPool([], keyRow, []), "/v1/contacts", "POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  // The key is read from the header only, before the query, so a key in the query string is a 401, not a 400.
  assert.equal((await call({}, env, contactsPool([], keyRow, []), `/v1/contacts?api_key=${key}`)).status, 401);
});

test("the OpenAPI document lists exactly the paths and methods the external API serves", async () => {
  const document = JSON.parse(await readFile(new URL("../../docs/api/openapi-v1.json", import.meta.url), "utf8"));
  assert.equal(document.openapi, "3.1.0");
  const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
  const documented = Object.fromEntries(
    Object.entries(document.paths as Record<string, Record<string, unknown>>).map(([path, item]) => [
      path,
      Object.keys(item)
        .filter((name) => methods.has(name))
        .map((name) => name.toUpperCase())
        .sort(),
    ]),
  );
  const served = Object.fromEntries(Object.entries(PUBLIC_API_ROUTES).map(([path, list]) => [path, [...list].sort()]));
  assert.deepEqual(documented, served);
  // Every error code the contacts path answers is in the document.
  const text = JSON.stringify(document);
  for (const code of ["invalid_request", "invalid_api_key", "insufficient_scope", "connection_not_found", "not_found", "method_not_allowed", "rate_limited", "api_key_limit_unavailable", "service_unavailable"]) assert.ok(text.includes(`"${code}"`), code);
});
