import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { appApi } from "./api.ts";
import { MAX_ACTIVE_API_KEYS, recordApiKeyUse, revokeMemberApiKeys } from "./api-keys.ts";
import { publicApi } from "./public-api.ts";
import { exportWorkspace } from "./workspace-export.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const ownerId = "11111111-1111-4111-8111-111111111111";
const adminId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const outsiderId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "55555555-5555-4555-8555-555555555555";
const otherWorkspaceId = "66666666-6666-4666-8666-666666666666";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };
const allow = { limit: async () => ({ success: true }) };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces, workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role,email)
     VALUES($1,$2,'owner','owner@example.test'),($1,$3,'admin','admin@example.test'),($1,$4,'agent','agent@example.test'),($5,$6,'owner','outsider@example.test')`,
    [workspaceId, ownerId, adminId, agentId, otherWorkspaceId, outsiderId],
  );
});

after(async () => pool.end());

type Queryable = { query: Pool["query"]; connect: () => Promise<PoolClient>; end: () => Promise<void> };
const sharedPool = (): Queryable => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} });

function request(actorId: string, method: string, path: string, body?: unknown, database: Queryable = sharedPool()) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    apiEnv,
    () => database as unknown as Pool,
    (async () => Response.json({ id: actorId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

async function expectStatus<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

type Issued = { id: string; key: string; key_prefix: string; scopes: string[]; created_by: string; created_by_email: string | null; expires_at: string; active: boolean };

async function issue(actor = adminId, name = "CRM", extra: Record<string, unknown> = {}): Promise<Issued> {
  return expectStatus<Issued>(await request(actor, "POST", "/api/workspace/api-keys", { name, scopes: ["contacts:read"], ...extra }), 201);
}

function checkKey(key: string, ip = "203.0.113.7") {
  return publicApi(new Request("https://app.test/v1/key", { headers: { Authorization: `Bearer ${key}`, "CF-Connecting-IP": ip } }), { API_IP_LIMIT: allow, API_KEY_LIMIT: allow }, () => ({ query: pool.query.bind(pool), end: async () => {} }) as unknown as Pool, "corr-db");
}

async function events(): Promise<{ api_key_id: string; kind: string; actor_id: string | null }[]> {
  return (await pool.query("SELECT api_key_id,kind,actor_id FROM api_key_events ORDER BY created_at,id")).rows;
}

test("an admin issues a key that is shown once, stored only as its hash, and works on GET /v1/key", async () => {
  const issued = await issue(adminId, "  CRM sync ", { expires_in_days: 30 });
  assert.match(issued.key, /^ac_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.key_prefix, issued.key.slice(0, 12));
  assert.deepEqual(issued.scopes, ["contacts:read"]);
  assert.equal(issued.created_by, adminId);
  assert.equal(issued.created_by_email, "admin@example.test");
  assert.equal(issued.active, true);
  const days = (Date.parse(issued.expires_at) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, String(days));
  const stored = (await pool.query("SELECT name,key_hash,key_prefix FROM api_keys WHERE id=$1", [issued.id])).rows[0];
  assert.equal(stored.name, "CRM sync");
  assert.equal(stored.key_hash, createHash("sha256").update(issued.key).digest("hex"));
  // No column holds the key itself.
  const row = JSON.stringify((await pool.query("SELECT * FROM api_keys")).rows);
  assert.ok(!row.includes(issued.key));
  assert.deepEqual(await events(), [{ api_key_id: issued.id, kind: "created", actor_id: adminId }]);

  const listed = await expectStatus<{ keys: Record<string, unknown>[]; scopes: string[]; max_active: number; default_expiry_days: number }>(await request(ownerId, "GET", "/api/workspace/api-keys"), 200);
  assert.equal(listed.keys.length, 1);
  assert.ok(!("key" in listed.keys[0]!) && !("key_hash" in listed.keys[0]!));
  assert.ok(!JSON.stringify(listed).includes(issued.key.slice(12)));
  assert.deepEqual(listed.scopes, ["contacts:read", "contacts:write"]);
  assert.equal(listed.max_active, MAX_ACTIVE_API_KEYS);
  assert.equal(listed.default_expiry_days, 90);

  const checked = await checkKey(issued.key);
  assert.equal(checked.status, 200);
  assert.deepEqual(await checked.json(), { id: issued.id, name: "CRM sync", scopes: ["contacts:read"], workspace_id: workspaceId, expires_at: issued.expires_at });
  const used = (await pool.query("SELECT last_used_at,last_used_ip FROM api_keys WHERE id=$1", [issued.id])).rows[0];
  assert.ok(used.last_used_at);
  assert.equal(used.last_used_ip, "203.0.113.7");
});

test("only admins and the owner see, issue and revoke keys", async () => {
  const issued = await issue(ownerId);
  for (const [method, path, body] of [
    ["GET", "/api/workspace/api-keys", undefined],
    ["POST", "/api/workspace/api-keys", { name: "agent", scopes: ["contacts:read"] }],
    ["POST", `/api/workspace/api-keys/${issued.id}/revoke`, undefined],
  ] as const) {
    assert.deepEqual(await expectStatus(await request(agentId, method, path, body), 403), { error: "role_forbidden" });
  }
  // Another workspace's admin cannot see or revoke the key.
  assert.deepEqual((await expectStatus<{ keys: unknown[] }>(await request(outsiderId, "GET", "/api/workspace/api-keys"), 200)).keys, []);
  assert.deepEqual(await expectStatus(await request(outsiderId, "POST", `/api/workspace/api-keys/${issued.id}/revoke`), 404), { error: "api_key_not_found" });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM api_keys")).rows[0].count, 1);
  assert.deepEqual(await expectStatus(await request(adminId, "POST", "/api/workspace/api-keys", { name: "CRM", scopes: ["contacts:write"] }), 400), { error: "invalid_api_key_scopes" });
  assert.deepEqual(await expectStatus(await request(adminId, "POST", "/api/workspace/api-keys", { name: "CRM", scopes: ["contacts:read"], expires_in_days: 3650 }), 400), { error: "invalid_api_key_expiry" });
});

test("a revoked key is refused at once and cannot be revoked or used again", async () => {
  const issued = await issue();
  const revoked = await expectStatus<{ revoked_reason: string; active: boolean }>(await request(ownerId, "POST", `/api/workspace/api-keys/${issued.id}/revoke`), 200);
  assert.equal(revoked.revoked_reason, "revoked");
  assert.equal(revoked.active, false);
  assert.deepEqual((await pool.query("SELECT revoked_by FROM api_keys WHERE id=$1", [issued.id])).rows[0], { revoked_by: ownerId });
  assert.deepEqual(await expectStatus(await request(adminId, "POST", `/api/workspace/api-keys/${issued.id}/revoke`), 409), { error: "api_key_already_revoked" });
  const refused = await checkKey(issued.key);
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: "invalid_api_key" });
  assert.deepEqual(await events(), [
    { api_key_id: issued.id, kind: "created", actor_id: adminId },
    { api_key_id: issued.id, kind: "revoked", actor_id: ownerId },
  ]);
  // Server code cannot clear a revocation into an inconsistent row.
  await assert.rejects(pool.query("UPDATE api_keys SET revoked_reason=NULL WHERE id=$1", [issued.id]), { code: "23514" });
});

test("an expired key is refused like an unknown one", async () => {
  const issued = await issue();
  await pool.query("UPDATE api_keys SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE id=$1", [issued.id]);
  const refused = await checkKey(issued.key);
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: "invalid_api_key" });
  const listed = await expectStatus<{ keys: { active: boolean; revoked_at: string | null }[] }>(await request(adminId, "GET", "/api/workspace/api-keys"), 200);
  assert.deepEqual(
    listed.keys.map(({ active, revoked_at }) => ({ active, revoked_at })),
    [{ active: false, revoked_at: null }],
  );
});

test("a workspace holds at most ten active keys; revoked and expired keys do not count", async () => {
  const keys: Issued[] = [];
  for (let index = 0; index < MAX_ACTIVE_API_KEYS; index++) keys.push(await issue(adminId, `key ${index}`));
  assert.deepEqual(await expectStatus(await request(adminId, "POST", "/api/workspace/api-keys", { name: "eleventh", scopes: ["contacts:read"] }), 409), { error: "api_key_limit_reached" });
  await expectStatus(await request(adminId, "POST", `/api/workspace/api-keys/${keys[0]!.id}/revoke`), 200);
  await pool.query("UPDATE api_keys SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE id=$1", [keys[1]!.id]);
  await issue(adminId, "replacement 1");
  await issue(adminId, "replacement 2");
  assert.equal((await request(adminId, "POST", "/api/workspace/api-keys", { name: "over", scopes: ["contacts:read"] })).status, 409);
  // The other workspace has its own count.
  await issue(outsiderId, "outsider");
});

test("concurrent issues cannot pass the active key limit", async () => {
  for (let index = 0; index < MAX_ACTIVE_API_KEYS - 2; index++) await issue(adminId, `key ${index}`);
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => request(index % 2 ? adminId : ownerId, "POST", "/api/workspace/api-keys", { name: `race ${index}`, scopes: ["contacts:read"] })));
  assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 201, 409, 409, 409, 409]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM api_keys WHERE workspace_id=$1 AND revoked_at IS NULL", [workspaceId])).rows[0].count, MAX_ACTIVE_API_KEYS);
});

test("removing the member who made keys revokes them in the same transaction with audit rows that have no actor", async () => {
  const first = await issue(adminId, "first");
  const second = await issue(adminId, "second");
  const ownerKey = await issue(ownerId, "owner");
  await pool.query("UPDATE api_keys SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE id=$1", [second.id]);
  const removed = await expectStatus<{ revoked_api_keys: number }>(await request(ownerId, "DELETE", `/api/workspace/members/${adminId}`), 200);
  assert.equal(removed.revoked_api_keys, 2);
  const rows = (await pool.query("SELECT id,revoked_reason,revoked_by,revoked_at IS NOT NULL AS revoked FROM api_keys ORDER BY name")).rows;
  assert.deepEqual(rows, [
    { id: first.id, revoked_reason: "member_removed", revoked_by: null, revoked: true },
    { id: ownerKey.id, revoked_reason: null, revoked_by: null, revoked: false },
    { id: second.id, revoked_reason: "member_removed", revoked_by: null, revoked: true },
  ]);
  const audit = (await events()).filter(({ kind }) => kind === "member_removed");
  assert.deepEqual(audit.map(({ api_key_id }) => api_key_id).sort(), [first.id, second.id].sort());
  assert.ok(audit.every(({ actor_id }) => actor_id === null));
  assert.equal((await checkKey(first.key)).status, 401);
  assert.equal((await checkKey(ownerKey.key)).status, 200);
});

test("demoting the creator below admin revokes their keys; a change that keeps admin does not", async () => {
  const issued = await issue(adminId);
  // A change that keeps the role at admin leaves the key alone.
  assert.equal((await expectStatus<{ revoked_api_keys: number }>(await request(ownerId, "PATCH", `/api/workspace/members/${adminId}`, { role: "admin" }), 200)).revoked_api_keys, 0);
  assert.equal((await checkKey(issued.key)).status, 200);
  const demoted = await expectStatus<{ role: string; revoked_api_keys: number }>(await request(ownerId, "PATCH", `/api/workspace/members/${adminId}`, { role: "agent" }), 200);
  assert.deepEqual(demoted, { user_id: adminId, role: "agent", revoked_api_keys: 1 });
  assert.deepEqual((await pool.query("SELECT revoked_reason,revoked_by FROM api_keys WHERE id=$1", [issued.id])).rows[0], { revoked_reason: "member_demoted", revoked_by: null });
  assert.deepEqual((await events()).at(-1), { api_key_id: issued.id, kind: "member_demoted", actor_id: null });
  assert.equal((await checkKey(issued.key)).status, 401);
  // Promoting the member back does not bring the key back.
  await expectStatus(await request(ownerId, "PATCH", `/api/workspace/members/${agentId}`, { role: "admin" }), 200);
  await expectStatus(await request(ownerId, "PATCH", `/api/workspace/members/${adminId}`, { role: "admin" }), 200);
  assert.equal((await checkKey(issued.key)).status, 401);
});

async function waitForLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    if (waiting.rows[0].count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no statement waited on a lock");
}

test("a demotion that commits before the issue reads the membership refuses the issue", async () => {
  const demotion = await pool.connect();
  try {
    await demotion.query("BEGIN");
    await demotion.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [adminId]);
    // The issue passes its first role check on the committed admin row, then waits on the membership lock.
    const pending = request(adminId, "POST", "/api/workspace/api-keys", { name: "late", scopes: ["contacts:read"] });
    await waitForLock();
    await revokeMemberApiKeys(demotion, workspaceId, adminId, "member_demoted");
    await demotion.query("COMMIT");
    assert.deepEqual(await expectStatus(await pending, 403), { error: "role_forbidden" });
  } finally {
    await demotion.query("ROLLBACK").catch(() => undefined);
    demotion.release();
  }
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM api_keys")).rows[0].count, 0);
});

test("a demotion or removal that commits before the revoke reads the membership refuses the revoke", async () => {
  const issued = await issue(ownerId);
  for (const change of ["UPDATE workspace_members SET role='agent' WHERE user_id=$1", `UPDATE workspace_members SET removed_at=now(),removed_by='${ownerId}' WHERE user_id=$1`]) {
    await pool.query("UPDATE workspace_members SET role='admin',removed_at=NULL,removed_by=NULL WHERE user_id=$1", [adminId]);
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(change, [adminId]);
      // The revoke passes its first role check on the committed admin row, then waits on the membership lock.
      const pending = request(adminId, "POST", `/api/workspace/api-keys/${issued.id}/revoke`);
      await waitForLock();
      await holder.query("COMMIT");
      const response = await pending;
      assert.equal(response.status, 403, await response.clone().text());
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  }
  assert.deepEqual((await pool.query("SELECT revoked_at FROM api_keys WHERE id=$1", [issued.id])).rows[0], { revoked_at: null });
  assert.equal((await events()).length, 1);
});

test("an issue that holds the membership first is revoked by the demotion that waited for it", async () => {
  let reachedGate!: () => void;
  const reached = new Promise<void>((resolve) => (reachedGate = resolve));
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => (openGate = resolve));
  // Holds the issue's transaction open after its key row is written and before it commits.
  const paused: Queryable = {
    ...sharedPool(),
    connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].startsWith("INSERT INTO api_key_events")) {
          reachedGate();
          await gate;
        }
        return query(...args);
      };
      return client;
    },
  };
  const pending = request(adminId, "POST", "/api/workspace/api-keys", { name: "racing", scopes: ["contacts:read"] }, paused);
  await reached;
  const demotion = request(ownerId, "PATCH", `/api/workspace/members/${adminId}`, { role: "agent" });
  try {
    await waitForLock();
  } finally {
    // Opened on failure too, so a missing lock fails the assertions below instead of hanging the run.
    openGate();
  }
  const issued = await expectStatus<Issued>(await pending, 201);
  assert.equal((await expectStatus<{ revoked_api_keys: number }>(await demotion, 200)).revoked_api_keys, 1);
  assert.deepEqual((await pool.query("SELECT revoked_reason FROM api_keys WHERE id=$1", [issued.id])).rows[0], { revoked_reason: "member_demoted" });
  assert.equal((await checkKey(issued.key)).status, 401);
});

test("a demotion waits for the workspace row before it locks the member, as a workspace deletion takes them", async () => {
  await issue(adminId);
  const deletion = await pool.connect();
  try {
    await deletion.query("BEGIN");
    await deletion.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
    const demotion = request(ownerId, "PATCH", `/api/workspace/members/${adminId}`, { role: "agent" });
    await waitForLock();
    // The demotion holds no member or key row yet, so the deletion's next locks do not wait on it.
    await deletion.query("SELECT 1 FROM workspace_members WHERE user_id=$1 FOR UPDATE", [adminId]);
    await deletion.query("SELECT 1 FROM api_keys WHERE workspace_id=$1 FOR UPDATE", [workspaceId]);
    await deletion.query("ROLLBACK");
    assert.equal((await expectStatus<{ revoked_api_keys: number }>(await demotion, 200)).revoked_api_keys, 1);
  } finally {
    await deletion.query("ROLLBACK").catch(() => undefined);
    deletion.release();
  }
});

test("the owner assignment script locks workspace rows before the membership, as an API key issue does", async () => {
  const script = await readFile(new URL("../../deploy/assign-workspace-owner.sql", import.meta.url), "utf8");
  const functionSql = script.slice(script.indexOf("CREATE FUNCTION"), script.indexOf("SELECT pg_temp.assign_workspace_owner")).replace("auth.users", "pg_temp.verified_users").replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
  const issuer = await pool.connect();
  const administrator = await pool.connect();
  try {
    await administrator.query("CREATE TEMP TABLE IF NOT EXISTS verified_users(id uuid,email_confirmed_at timestamptz)");
    await administrator.query("INSERT INTO verified_users VALUES($1,now())", [adminId]);
    await administrator.query(functionSql);
    // An unowned target, so the script goes on to lock the membership and the previous workspace.
    const target = "77777777-7777-4777-8777-777777777777";
    await pool.query("INSERT INTO workspaces(id) VALUES($1)", [target]);
    // createApiKey's first two locks, split around the script: the workspace row, then the caller's membership.
    await issuer.query("BEGIN");
    await issuer.query("SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE", [workspaceId]);
    const assignment = administrator.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [adminId, target]);
    const settled = assignment.then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitForLock();
    await issuer.query("SELECT role FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 FOR SHARE", [adminId, workspaceId]);
    await issuer.query("COMMIT");
    // The script reaches its own emptiness check instead of a deadlock.
    assert.match(String(await settled), /not empty/);
  } finally {
    await issuer.query("ROLLBACK").catch(() => undefined);
    await administrator.query("DROP TABLE IF EXISTS pg_temp.verified_users").catch(() => undefined);
    issuer.release();
    administrator.release();
  }
});

test("the last use is written at most once a minute per key", async () => {
  const issued = await issue();
  assert.equal((await checkKey(issued.key, "203.0.113.1")).status, 200);
  const first = (await pool.query("SELECT last_used_at,last_used_ip FROM api_keys WHERE id=$1", [issued.id])).rows[0];
  assert.equal((await checkKey(issued.key, "203.0.113.2")).status, 200);
  assert.deepEqual((await pool.query("SELECT last_used_at,last_used_ip FROM api_keys WHERE id=$1", [issued.id])).rows[0], first);
  await pool.query("UPDATE api_keys SET last_used_at=now()-interval '61 seconds' WHERE id=$1", [issued.id]);
  assert.equal((await checkKey(issued.key, "203.0.113.3")).status, 200);
  const later = (await pool.query("SELECT last_used_at,last_used_ip FROM api_keys WHERE id=$1", [issued.id])).rows[0];
  assert.equal(later.last_used_ip, "203.0.113.3");
  assert.ok(later.last_used_at > first.last_used_at);
  // A revoked key's last use is not written.
  await expectStatus(await request(adminId, "POST", `/api/workspace/api-keys/${issued.id}/revoke`), 200);
  await pool.query("UPDATE api_keys SET last_used_at=now()-interval '61 seconds' WHERE id=$1", [issued.id]);
  const before = (await pool.query("SELECT last_used_at FROM api_keys WHERE id=$1", [issued.id])).rows[0];
  await recordApiKeyUse(pool, issued.id, "203.0.113.4");
  assert.deepEqual((await pool.query("SELECT last_used_at FROM api_keys WHERE id=$1", [issued.id])).rows[0], before);
});

test("the workspace export carries keys and their audit without the hash", async () => {
  const issued = await issue();
  assert.equal((await checkKey(issued.key)).status, 200);
  const exported = JSON.parse((await exportWorkspace(pool, { id: adminId, email: "admin@example.test" })).body);
  const [row] = exported.tables.api_keys;
  assert.equal(row.id, issued.id);
  assert.equal(row.key_prefix, issued.key_prefix);
  assert.equal(row.last_used_ip, "203.0.113.7");
  assert.ok(!("key_hash" in row));
  assert.equal(exported.tables.api_key_events.length, 1);
  assert.ok(exported.excluded.includes("api_keys.key_hash"));
  const text = JSON.stringify(exported);
  assert.ok(!text.includes(issued.key.slice(12)));
  assert.ok(!text.includes(createHash("sha256").update(issued.key).digest("hex")));
});

test("workspace deletion removes the keys and their audit, and keys keep a sole owner from moving", async () => {
  await issue(ownerId);
  // An owner whose workspace holds a key cannot leave it through an invite.
  await pool.query("UPDATE workspaces SET plan='advanced' WHERE id=$1", [otherWorkspaceId]);
  const invite = await expectStatus<{ link: string }>(await request(outsiderId, "POST", "/api/workspace/invites", { email: "a@example.test", role: "agent" }), 201);
  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id IN ($1,$3)", [adminId, ownerId, agentId]);
  const token = invite.link.split("#invite=")[1];
  assert.deepEqual(await expectStatus(await request(ownerId, "POST", "/api/invites/accept", { token }), 409), { error: "workspace_not_empty" });
  const result = (await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspaceId, ownerId])).rows[0].result;
  assert.equal(result.deleted_counts.api_keys, 1);
  assert.equal(result.deleted_counts.api_key_events, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM api_keys")).rows[0].count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM api_key_events")).rows[0].count, 0);
});
