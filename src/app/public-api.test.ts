import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { API_KEY_SCOPES, apiKeyHash, apiKeyPrefix, clientIp, generateApiKey, isApiKeyFormat, parseApiKeyRequest } from "./api-keys.ts";
import { ApiError } from "./auth.ts";
import { publicApi } from "./public-api.ts";

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
  assert.equal((await call({}, env, keyPool([], keyRow).pool, "/v1/contacts")).status, 401);
  // A refused path or method is not a successful use, so the key's last use is not recorded.
  let queries: Recorded = [];
  assert.equal((await call({ Authorization: `Bearer ${key}` }, env, keyPool(queries, keyRow).pool, "/v1/contacts")).status, 404);
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
