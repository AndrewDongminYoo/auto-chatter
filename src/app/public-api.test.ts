import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { Pool } from "pg";
import { API_KEY_SCOPES, apiKeyHash, apiKeyPrefix, clientIp, generateApiKey, isApiKeyFormat, parseApiKeyRequest } from "./api-keys.ts";
import { ApiError } from "./auth.ts";
import { matchPublicApiRoute, PUBLIC_API_ROUTES, publicApi } from "./public-api.ts";
import { exactNumberReviver, hasDuplicateJsonKey, parseContactWrite, parseContactWriteBody, parseContactWriteTarget } from "./public-contact-writes.ts";
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

test("an API key request accepts contacts:read with or without contacts:write, a listed expiry and a 1-80 character name", () => {
  assert.deepEqual(API_KEY_SCOPES, ["contacts:read", "contacts:write"]);
  assert.deepEqual(parseApiKeyRequest({ name: "  CRM  ", scopes: ["contacts:read"] }), { name: "CRM", expiresInDays: 90, scopes: ["contacts:read"] });
  // A write key is stored in one order, the order the api_keys CHECK compares.
  for (const scopes of [
    ["contacts:read", "contacts:write"],
    ["contacts:write", "contacts:read"],
  ])
    assert.deepEqual(parseApiKeyRequest({ name: "CRM", scopes }).scopes, ["contacts:read", "contacts:write"]);
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
    [{ name: "CRM", scopes: ["contacts:read", "contacts:write", "contacts:write"] }, "invalid_api_key_scopes"],
    [{ name: "CRM", scopes: ["contacts:read", "contacts:delete"] }, "invalid_api_key_scopes"],
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
  for (const code of [
    "invalid_request",
    "invalid_api_key",
    "insufficient_scope",
    "connection_not_found",
    "not_found",
    "method_not_allowed",
    "rate_limited",
    "api_key_limit_unavailable",
    "service_unavailable",
    "invalid_field_value",
    "contact_not_found",
    "field_not_found",
    "contact_tag_limit",
    "json_required",
    "request_too_large",
  ])
    assert.ok(text.includes(`"${code}"`), code);
  // Every templated path matches its own template, and only that one.
  for (const path of Object.keys(PUBLIC_API_ROUTES)) assert.equal(matchPublicApiRoute(path.replace(/\{[a-z_]+\}/g, "x"))?.path, path);
});

test("the routes match whole path segments, and the write path keeps its raw parameters", () => {
  assert.deepEqual(matchPublicApiRoute("/v1/contacts"), { path: "/v1/contacts", params: [] });
  assert.deepEqual(matchPublicApiRoute(`/v1/contacts/${connectionId}/a%2Fb`), { path: "/v1/contacts/{connection_id}/{sender_id}", params: [connectionId, "a%2Fb"] });
  for (const path of ["/v1/contacts/", "/v1/contacts/x", "/v1/contacts/x/y/z", "/v1/contacts//y", "/v1/contacts/x/", "/v1/fields/", `/v1/contacts/${encodeURIComponent("{connection_id}")}`]) assert.equal(matchPublicApiRoute(path), undefined, path);
  assert.equal(matchPublicApiRoute("/v1/toString"), undefined);
});

test("the write path needs a connection UUID and a decodable, non-empty sender ID", () => {
  assert.deepEqual(parseContactWriteTarget(connectionId.toUpperCase(), encodeURIComponent("sender/one% x")), { connectionId, senderId: "sender/one% x" });
  for (const [connection, sender] of [
    ["not-a-uuid", "1"],
    [connectionId, "%E0%A4%A"],
    [connectionId, "%20%20"],
    [connectionId, "a%00b"],
  ])
    assert.throws(
      () => parseContactWriteTarget(connection!, sender!),
      (error) => error instanceof ApiError && error.status === 400 && error.message === "invalid_request",
      `${connection} ${sender}`,
    );
});

const fieldA = "55555555-5555-4555-8555-555555555555";
const fieldB = "66666666-6666-4666-8666-666666666666";
const fieldC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("a contact write body adds and removes normalized tags and names fields by ID", () => {
  assert.deepEqual(parseContactWrite({ tags: { add: [" VIP ", "vip", "구매"], remove: ["Old"] } }), { add: ["vip", "구매"], remove: ["old"], fields: [] });
  assert.deepEqual(parseContactWrite({ fields: { [fieldB.toUpperCase()]: null, [fieldA]: "gold" } }), {
    add: [],
    remove: [],
    fields: [
      [fieldA, "gold"],
      [fieldB, null],
    ],
  });
  // An empty tag object is no change, but the fields still are.
  assert.deepEqual(parseContactWrite({ tags: {}, fields: { [fieldA]: 0 } }).fields, [[fieldA, 0]]);
  // A tag gets the dashboard's form: "J" + U+030C lowercases to "j" + U+030C, which NFC composes to U+01F0, so the three
  // spellings are one tag.
  assert.deepEqual(parseContactWrite({ tags: { add: ["J\u030C"] } }).add, ["\u01F0"]);
  assert.deepEqual(parseContactWrite({ tags: { add: ["J\u030C", "j\u030C", "\u01F0"] } }).add, ["\u01F0"]);
  const refused: [unknown, string][] = [
    [null, "invalid_request"],
    [[], "invalid_request"],
    [{}, "invalid_request"],
    [{ tags: { add: [] }, fields: {} }, "invalid_request"],
    [{ tags: { add: ["a"] }, extra: 1 }, "invalid_request"],
    [{ tags: { add: ["a"], replace: ["b"] } }, "invalid_request"],
    [{ tags: ["a"] }, "invalid_request"],
    [{ tags: { add: "a" } }, "invalid_request"],
    [{ tags: { add: ["x".repeat(41)] } }, "invalid_request"],
    [{ tags: { add: ["a\u0000"] } }, "invalid_request"],
    // A lone surrogate would be stored as U+FFFD.
    [{ tags: { add: ["a\ud800"] } }, "invalid_request"],
    [{ tags: { remove: ["\udc00b"] } }, "invalid_request"],
    [{ tags: { add: Array.from({ length: 21 }, (_, index) => `t${index}`) } }, "invalid_request"],
    // The same tag after normalization in both lists.
    [{ tags: { add: ["VIP"], remove: [" vip"] } }, "invalid_request"],
    [{ tags: { add: ["J\u030C"], remove: ["\u01F0"] } }, "invalid_request"],
    [{ fields: [] }, "invalid_request"],
    [{ fields: { "not-a-uuid": 1 } }, "invalid_request"],
    [{ fields: { [fieldC]: 1, [fieldC.toUpperCase()]: 2 } }, "invalid_request"],
    [{ fields: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`${String(index).padStart(8, "0")}-5555-4555-8555-555555555555`, 1])) }, "invalid_request"],
    [{ fields: { [fieldA]: { value: 1 } } }, "invalid_field_value"],
    [{ fields: { [fieldA]: [1] } }, "invalid_field_value"],
    [{ fields: { [fieldA]: "\ud800" } }, "invalid_field_value"],
  ];
  for (const [input, code] of refused)
    assert.throws(
      () => parseContactWrite(input),
      (error) => error instanceof ApiError && error.status === 400 && error.message === code,
      JSON.stringify(input),
    );
  assert.equal(parseContactWrite({ fields: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`${String(index).padStart(8, "0")}-5555-4555-8555-555555555555`, 1])) }).fields.length, 20);
});

test("a body that names a key twice in one object is refused", () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":[{"a":1},{"b":{"a":1,"c":[1,{"a":2,"a":3}]}}]}', '{"a":{"b":1},"c":{"b":2},"a":3}']) assert.equal(hasDuplicateJsonKey(text), true, text);
  for (const text of ['{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}', '{"a":"\\"a\\":1,{\\"a\\":2}","b":["a","a"]}', '[{"a":1},{"a":1}]', "{}", '"a"']) assert.equal(hasDuplicateJsonKey(text), false, text);
  assert.throws(
    () => parseContactWriteBody(`{"fields":{"${fieldA}":true,"${fieldA}":false}}`),
    (error) => error instanceof ApiError && error.status === 400 && error.message === "invalid_request",
  );
  assert.deepEqual(parseContactWriteBody(`{"fields":{"${fieldA}":true}}`), { fields: { [fieldA]: true } });
});

test("a body number is kept only when its double denotes the same decimal value as its source text", () => {
  const read = (text: string) => (JSON.parse(`[${text}]`, exactNumberReviver) as unknown[])[0];
  for (const [text, value] of [
    ["0", 0],
    ["-0", -0],
    ["1.50", 1.5],
    ["15e-1", 1.5],
    ["0.1", 0.1],
    ["1E21", 1e21],
    ["-12.5e3", -12500],
    ["9007199254740992", 9007199254740992],
    ["1.7976931348623157e308", Number.MAX_VALUE],
  ] as const)
    assert.equal(read(text), value, text);
  for (const text of ["9007199254740993", "0.10000000000000000001", "1e400", "123456789012345678901234567890"]) {
    const value = read(text);
    assert.equal(typeof value, "object", text);
    assert.throws(
      () => parseContactWrite({ fields: { [fieldA]: value } }),
      (error) => error instanceof ApiError && error.status === 400 && error.message === "invalid_field_value",
      text,
    );
  }
  // Without the source text every number is refused rather than possibly changed.
  assert.equal(typeof exactNumberReviver("", 1), "object");
  assert.equal(exactNumberReviver("", "9007199254740993"), "9007199254740993");
});

type WriteState = { found: boolean; tags: string[] | null; fields: { id: string; type: string }[]; connection: boolean };
// A pool for the write path: the key lookup, the unlocked field check, the plan and the use record on the pool, and the
// transaction on a client. Every statement is recorded with whether it ran on the client.
function writePool(queries: (Recorded[number] & { client: boolean })[], key: Record<string, unknown>, state: WriteState) {
  const answer = (sql: string, params: unknown[], client: boolean) => {
    queries.push({ sql, params, client });
    if (sql.includes("FROM api_keys")) return { rows: [key], rowCount: 1 };
    if (sql.includes("FROM instagram_contact_fields")) {
      const ids = (params[1] as string[] | undefined) ?? [];
      const rows = sql.includes("id=ANY") ? state.fields.filter((field) => ids.includes(field.id)) : state.fields.map((field) => ({ ...field, name: `name-${field.id}` }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT plan")) return { rows: [{ plan: "free" }], rowCount: 1 };
    if (sql.startsWith("SELECT id FROM instagram_connections")) return { rows: state.connection ? [{ id: connectionId }] : [], rowCount: state.connection ? 1 : 0 };
    if (sql.startsWith("SELECT EXISTS")) return { rows: [{ found: state.found, tags: state.tags }], rowCount: 1 };
    if (sql.startsWith("WITH contacts")) return { rows: [{ ...contactRow("sender/1"), tags_json: '["vip"]', fields_json: "{}" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  return {
    query: async (sql: string, params: unknown[] = []) => answer(sql, params, false),
    connect: async () => ({ query: async (sql: string, params: unknown[] = []) => answer(sql, params, true), release: () => {} }),
    end: async () => {},
  } as unknown as Pool;
}
const writeKey = { ...keyRow, scopes: ["contacts:read", "contacts:write"] };
const writePath = `/v1/contacts/${connectionId}/sender%2F1`;
function patch(pool: Pool, env: Parameters<typeof publicApi>[1], body: string | undefined, path = writePath, headers: Record<string, string> = { "Content-Type": "application/json" }) {
  return publicApi(new Request(`https://app.test${path}`, { method: "PATCH", headers: { Authorization: `Bearer ${generateApiKey()}`, "CF-Connecting-IP": "203.0.113.9", ...headers }, body }), env, () => pool, "corr-2");
}
function countingLimit(result: boolean | "throw") {
  const calls: { key: string; limit?: number }[] = [];
  return {
    calls,
    binding: {
      limit: async (input: { key: string; limit?: number }) => {
        calls.push(input);
        if (result === "throw") throw new Error("limiter down");
        return { success: result };
      },
    },
  };
}

test("PATCH /v1/contacts/{connection_id}/{sender_id} removes, then adds, writes the fields in one transaction and answers the contact", async () => {
  const workspace = countingLimit(true);
  const env = { API_IP_LIMIT: allow, API_KEY_LIMIT: allow, API_WRITE_WORKSPACE_LIMIT: workspace.binding };
  const queries: (Recorded[number] & { client: boolean })[] = [];
  const state = { found: true, tags: ["agent", "old"], fields: [{ id: fieldA, type: "text" }], connection: true };
  const response = await patch(writePool(queries, writeKey, state), env, JSON.stringify({ tags: { add: ["VIP"], remove: ["old", "never"] }, fields: { [fieldA]: "gold" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["channel", "identity_kind", "connection_id", "sender_id", "connection_username", "first_comment_recorded_at", "last_comment_recorded_at", "comment_count", "automation_paused", "tags", "fields"]);
  // The workspace write limit is the dashboard's: the workspace ID and the plan's hourly count.
  assert.deepEqual(workspace.calls, [{ key: workspaceId, limit: 500 }]);
  // The workspace key share, then the connection, the fields and the contact lock, as the dashboard saves take them.
  const client = queries.filter((query) => query.client).map((query) => query.sql);
  const expected = [
    "BEGIN",
    "SELECT 1 FROM workspaces WHERE id=$1 FOR KEY SHARE",
    "SELECT id FROM instagram_connections",
    "SELECT id::text,type FROM instagram_contact_fields",
    "SELECT pg_advisory_xact_lock",
    "SELECT EXISTS",
    "INSERT INTO instagram_contact_tags",
    "INSERT INTO instagram_contact_field_values",
    "WITH contacts",
    "COMMIT",
  ];
  assert.equal(client.length, expected.length);
  expected.forEach((prefix, index) => assert.ok(client[index]!.startsWith(prefix), `${index}: ${client[index]}`));
  const locked = queries.find((query) => query.client && query.sql.includes("instagram_contact_fields"))!;
  assert.match(locked.sql, /ORDER BY id FOR SHARE$/);
  const tags = queries.find((query) => query.sql.startsWith("INSERT INTO instagram_contact_tags"))!;
  // The agent's tag stays, the removed one goes, a tag that was never there is ignored.
  assert.deepEqual(tags.params, [workspaceId, connectionId, "sender/1", ["agent", "vip"]]);
  const value = queries.find((query) => query.sql.startsWith("INSERT INTO instagram_contact_field_values"))!;
  assert.deepEqual(value.params, [workspaceId, connectionId, "sender/1", fieldA, '"gold"']);
  // The unlocked field check and the limit come before the transaction; the use is recorded after it.
  const order = queries.map((query) => (query.client ? "client" : query.sql.split(" ")[0]));
  assert.ok(order.indexOf("client") > queries.findIndex((query) => query.sql.startsWith("SELECT plan")));
  assert.match(queries.at(-1)!.sql, /^UPDATE api_keys SET last_used_at/);
  assert.equal(queries.at(-1)!.client, false);
  // Fields only: the tags are not touched, and null clears the value.
  const only: typeof queries = [];
  assert.equal((await patch(writePool(only, writeKey, state), env, JSON.stringify({ fields: { [fieldA]: null } }))).status, 200);
  assert.ok(!only.some((query) => query.sql.startsWith("INSERT INTO instagram_contact_tags")));
  assert.deepEqual(only.find((query) => query.sql.startsWith("INSERT INTO instagram_contact_field_values"))!.params[4], null);
});

test("a committed contact write answers 200 when recording the key's last use fails", async () => {
  const env = { API_IP_LIMIT: allow, API_KEY_LIMIT: allow, API_WRITE_WORKSPACE_LIMIT: countingLimit(true).binding };
  const queries: (Recorded[number] & { client: boolean })[] = [];
  const pool = writePool(queries, writeKey, { found: true, tags: [], fields: [], connection: true });
  const query = pool.query.bind(pool) as (sql: string, params?: unknown[]) => Promise<unknown>;
  (pool as unknown as { query: typeof query }).query = async (sql, params) => {
    if (sql.startsWith("UPDATE api_keys")) throw new Error("connection lost");
    return query(sql, params);
  };
  const response = await patch(pool, env, JSON.stringify({ tags: { add: ["vip"] } }));
  assert.equal(response.status, 200);
  assert.ok(queries.some((recorded) => recorded.client && recorded.sql === "COMMIT"));
});

test("a contact write refused with 401, 403, 400, 413 or 415 spends no workspace write and writes nothing", async () => {
  const state = { found: true, tags: null, fields: [{ id: fieldA, type: "number" }], connection: true };
  const cases: [string, Record<string, unknown>, string | undefined, Record<string, string>, number, string][] = [
    ["read-only key", keyRow, JSON.stringify({ tags: { add: ["vip"] } }), { "Content-Type": "application/json" }, 403, "insufficient_scope"],
    ["empty body", writeKey, "{}", { "Content-Type": "application/json" }, 400, "invalid_request"],
    ["not JSON", writeKey, "{", { "Content-Type": "application/json" }, 400, "invalid_request"],
    ["no JSON type", writeKey, JSON.stringify({ tags: { add: ["vip"] } }), { "Content-Type": "text/plain" }, 415, "json_required"],
    ["over 16 KiB", writeKey, JSON.stringify({ tags: { add: ["vip"] } }).padEnd(16_385, " "), { "Content-Type": "application/json" }, 413, "request_too_large"],
    ["wrong type", writeKey, JSON.stringify({ fields: { [fieldA]: "1" } }), { "Content-Type": "application/json" }, 400, "invalid_field_value"],
    ["unknown field", writeKey, JSON.stringify({ fields: { [fieldB]: 1 } }), { "Content-Type": "application/json" }, 404, "field_not_found"],
    // JSON.parse would read 9007199254740992 and store a value the caller did not send.
    ["inexact number", writeKey, `{"fields":{"${fieldA}":9007199254740993}}`, { "Content-Type": "application/json" }, 400, "invalid_field_value"],
    // JSON.parse would keep only the last value of a repeated key.
    ["field ID twice", writeKey, `{"fields":{"${fieldA}":1,"${fieldA}":2}}`, { "Content-Type": "application/json" }, 400, "invalid_request"],
    ["escaped key twice", writeKey, `{"tags":{"add":["vip"]},"\\u0074ags":{"remove":["vip"]}}`, { "Content-Type": "application/json" }, 400, "invalid_request"],
  ];
  for (const [name, key, body, headers, status, code] of cases) {
    const workspace = countingLimit(true);
    const queries: (Recorded[number] & { client: boolean })[] = [];
    const response = await patch(writePool(queries, key, state), { API_IP_LIMIT: allow, API_KEY_LIMIT: allow, API_WRITE_WORKSPACE_LIMIT: workspace.binding }, body, writePath, headers);
    assert.equal(response.status, status, name);
    assert.deepEqual(await response.json(), { error: code }, name);
    assert.deepEqual(workspace.calls, [], name);
    assert.ok(!queries.some((query) => query.client || query.sql.startsWith("UPDATE")), name);
  }
  const queries: (Recorded[number] & { client: boolean })[] = [];
  const bad = await patch(writePool(queries, writeKey, state), { API_IP_LIMIT: allow, API_KEY_LIMIT: allow }, JSON.stringify({ tags: { add: ["vip"] } }), "/v1/contacts/not-a-uuid/1");
  assert.equal(bad.status, 400);
  // A key that is not valid is refused before the route.
  const unknown = await publicApi(new Request(`https://app.test${writePath}`, { method: "PATCH", body: "{}", headers: { "Content-Type": "application/json" } }), { API_IP_LIMIT: allow, API_KEY_LIMIT: allow }, () => writePool([], writeKey, state), "corr-3");
  assert.equal(unknown.status, 401);
  // GET on the write path is 405 with the method it serves.
  const get = await call({ Authorization: `Bearer ${generateApiKey()}` }, { API_IP_LIMIT: allow, API_KEY_LIMIT: allow }, writePool([], writeKey, state), writePath);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "PATCH");
});

test("a contact write over the workspace limit is 429 before the transaction, and an unavailable limiter lets it through with one log line", async () => {
  const state = { found: true, tags: null, fields: [], connection: true };
  const body = JSON.stringify({ tags: { add: ["vip"] } });
  const refused = countingLimit(false);
  let queries: (Recorded[number] & { client: boolean })[] = [];
  const limited = await patch(writePool(queries, writeKey, state), { API_IP_LIMIT: allow, API_KEY_LIMIT: allow, API_WRITE_WORKSPACE_LIMIT: refused.binding }, body);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "rate_limited" });
  assert.ok(!queries.some((query) => query.client || query.sql.startsWith("UPDATE")));
  for (const binding of [undefined, countingLimit("throw").binding]) {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    queries = [];
    try {
      const response = await patch(writePool(queries, writeKey, state), { API_IP_LIMIT: allow, API_KEY_LIMIT: allow, API_WRITE_WORKSPACE_LIMIT: binding }, body);
      assert.equal(response.status, 200);
    } finally {
      console.warn = original;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /"code":"api_limit_unavailable"/);
    assert.ok(queries.some((query) => query.sql.startsWith("INSERT INTO instagram_contact_tags")));
  }
});

test("a contact write answers 404 for a missing connection or contact and 409 above 20 tags, rolls back and records no use", async () => {
  const env = { API_IP_LIMIT: allow, API_KEY_LIMIT: allow, API_WRITE_WORKSPACE_LIMIT: allow };
  const cases: [Partial<WriteState>, string, number, string][] = [
    [{ connection: false }, JSON.stringify({ tags: { add: ["vip"] } }), 404, "connection_not_found"],
    [{ found: false }, JSON.stringify({ tags: { add: ["vip"] } }), 404, "contact_not_found"],
    [{ tags: Array.from({ length: 20 }, (_, index) => `t${index}`) }, JSON.stringify({ tags: { add: ["vip"], remove: ["missing"] } }), 409, "contact_tag_limit"],
  ];
  for (const [change, body, status, code] of cases) {
    const queries: (Recorded[number] & { client: boolean })[] = [];
    const response = await patch(writePool(queries, writeKey, { found: true, tags: null, fields: [], connection: true, ...change }), env, body);
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), { error: code });
    assert.equal(queries.filter((query) => query.client).at(-1)!.sql, "ROLLBACK");
    assert.ok(!queries.some((query) => query.sql.startsWith("INSERT") || query.sql.startsWith("UPDATE")), code);
  }
  // Removing one of 20 makes room for one more.
  const queries: (Recorded[number] & { client: boolean })[] = [];
  const full = Array.from({ length: 20 }, (_, index) => `t${String(index).padStart(2, "0")}`);
  assert.equal((await patch(writePool(queries, writeKey, { found: true, tags: full, fields: [], connection: true }), env, JSON.stringify({ tags: { add: ["vip"], remove: ["t00"] } }))).status, 200);
  assert.equal((queries.find((query) => query.sql.startsWith("INSERT INTO instagram_contact_tags"))!.params[3] as string[]).length, 20);
});

test("GET /v1/fields lists the active fields with contacts:read and records the use", async () => {
  const env = { API_IP_LIMIT: allow, API_KEY_LIMIT: allow };
  const queries: (Recorded[number] & { client: boolean })[] = [];
  const state = { found: true, tags: null, fields: [{ id: fieldA, type: "text" }], connection: true };
  const response = await call({ Authorization: `Bearer ${generateApiKey()}` }, env, writePool(queries, keyRow, state), "/v1/fields");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { fields: [{ id: fieldA, type: "text", name: `name-${fieldA}` }] });
  const list = queries.find((query) => query.sql.includes("instagram_contact_fields"))!;
  assert.match(list.sql, /WHERE workspace_id=\$1 AND NOT archived ORDER BY name,id$/);
  assert.deepEqual(list.params, [workspaceId]);
  assert.match(queries.at(-1)!.sql, /^UPDATE api_keys SET last_used_at/);
  const noScope: typeof queries = [];
  const refused = await call({ Authorization: `Bearer ${generateApiKey()}` }, env, writePool(noScope, { ...keyRow, scopes: [] }, state), "/v1/fields");
  assert.equal(refused.status, 403);
  assert.equal(noScope.length, 1);
  const query = await call({ Authorization: `Bearer ${generateApiKey()}` }, env, writePool([], keyRow, state), "/v1/fields?limit=1");
  assert.equal(query.status, 400);
  const post = await call({ Authorization: `Bearer ${generateApiKey()}` }, env, writePool([], keyRow, state), "/v1/fields", "POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});
