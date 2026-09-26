import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import {
  disconnectConnection,
  ensureWorkspace,
  listConnections,
  listRules,
  saveRule,
  updateConnection,
} from "./settings.ts";
import { ApiError } from "./auth.ts";
import { connectionMedia } from "./instagram-media.ts";
import { sealSecret } from "./secrets.ts";

const url = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: url.toString() });
const a = { id: "11111111-1111-4111-8111-111111111111", email: "a@example.test" };
const b = { id: "22222222-2222-4222-8222-222222222222", email: "b@example.test" };
const connectionId = "33333333-3333-4333-8333-333333333333";
const input = {
  connection_id: connectionId,
  media_id: "12345",
  keywords: [" Link "],
  excluded_keywords: [],
  match_mode: "contains",
  private_reply_text: "Hello",
  enabled: true,
  follow_gate_enabled: false,
};

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/004_workspace_settings.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  const workspace = await ensureWorkspace(pool, a);
  await ensureWorkspace(pool, b);
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at) VALUES($1,$2,'123',true,'encrypted-test',now()+interval '1 day')",
    [connectionId, workspace],
  );
});
after(async () => {
  await pool.end();
});

test("parallel first login creates exactly one workspace per user", async () => {
  const user = { id: "44444444-4444-4444-8444-444444444444", email: "c@example.test" };
  const ids = await Promise.all([ensureWorkspace(pool, user), ensureWorkspace(pool, user)]);
  assert.equal(ids[0], ids[1]);
  assert.equal((await pool.query("SELECT count(*) FROM workspaces")).rows[0].count, "3");
});

test("connection listings omit credentials and cannot cross workspaces", async () => {
  const owned = await listConnections(pool, a);
  assert.equal(owned.length, 1);
  assert.equal(owned[0].token_registered, true);
  assert.equal(JSON.stringify(owned).includes("encrypted-test"), false);
  assert.deepEqual(await listConnections(pool, b), []);
});

test("media retrieval uses real workspace predicates before accessing an encrypted credential", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const key = Buffer.alloc(32, 2).toString("base64");
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=$1 WHERE id=$2", [
    sealSecret("media-test-token", key, `${workspace}:123`),
    connectionId,
  ]);
  const fetchImpl = (async (input: string | URL | Request) => {
    return Response.json(
      new URL(String(input)).pathname.endsWith("/me")
        ? { id: "999", user_id: "123" }
        : { data: [{ id: "12345", owner: { id: "999" }, media_type: "IMAGE", caption: "Owned post" }] },
    );
  }) as typeof fetch;
  const env = { TOKEN_ENCRYPTION_KEY: key, META_GRAPH_VERSION: "v26.0" };
  assert.equal((await connectionMedia(pool, a, connectionId, env, {}, fetchImpl)).media[0]?.caption, "Owned post");
  await assert.rejects(
    connectionMedia(pool, b, connectionId, env, {}, (async () => {
      throw new Error("Graph must not be reached");
    }) as typeof fetch),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  await pool.query("UPDATE instagram_connections SET token_expires_at=now()-interval '1 minute' WHERE id=$1", [
    connectionId,
  ]);
  await assert.rejects(
    connectionMedia(pool, a, connectionId, env, {}, fetchImpl),
    (error: unknown) => error instanceof ApiError && error.message === "media_reconnect_required",
  );
});

test("rules are created and updated only within the verified user's workspace", async () => {
  const first = await saveRule(pool, a, input);
  const second = await saveRule(pool, a, { ...input, private_reply_text: "Updated" });
  assert.equal(first.id, second.id);
  assert.equal((await listRules(pool, a))[0].private_reply_text, "Updated");
  assert.deepEqual((await listRules(pool, a))[0].keywords, ["link"]);
  await assert.rejects(saveRule(pool, b, { ...input, private_reply_text: "Hijacked" }), ApiError);
  assert.deepEqual(await listRules(pool, b), []);
  assert.equal((await listRules(pool, a))[0].private_reply_text, "Updated");
});

test("connection activation rejects another user's ID and unavailable tokens", async () => {
  await assert.rejects(updateConnection(pool, b, connectionId, { active: false, send_enabled: true }), ApiError);
  assert.equal((await listConnections(pool, a))[0].active, true);
  await pool.query("UPDATE instagram_connections SET token_expires_at=now()-interval '1 minute'");
  await assert.rejects(updateConnection(pool, a, connectionId, { active: true, send_enabled: true }), ApiError);
  await updateConnection(pool, a, connectionId, { active: false, send_enabled: false });
  assert.equal((await listConnections(pool, a))[0].active, false);
});

test("invalid keyword and follow settings are rejected without changing the stored rule", async () => {
  await saveRule(pool, a, input);
  const original = await listRules(pool, a);
  for (const changes of [
    { keywords: [] },
    { keywords: [""] },
    { keywords: Array(21).fill("a") },
    { follow_gate_enabled: true },
    { media_id: "../other" },
    { private_reply_text: " " },
  ]) {
    await assert.rejects(saveRule(pool, a, { ...input, ...changes }), ApiError);
    assert.deepEqual(await listRules(pool, a), original);
  }
  assert.equal((await listRules(pool, a)).length, 1);
});

test("editing a rule cannot silently change its identity or create another rule", async () => {
  const rule = await saveRule(pool, a, input);
  await assert.rejects(saveRule(pool, a, { ...input, id: rule.id, media_id: "98765" }), ApiError);
  await assert.rejects(saveRule(pool, b, { ...input, id: rule.id }), ApiError);
  await saveRule(pool, a, { ...input, id: rule.id, private_reply_text: "Edited" });
  const rules = await listRules(pool, a);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].private_reply_text, "Edited");
});

test("disconnect clears only owned credentials and disables its rules", async () => {
  await saveRule(pool, a, input);
  await disconnectConnection(pool, b, connectionId);
  assert.equal((await listConnections(pool, a))[0].token_registered, true);
  await disconnectConnection(pool, a, connectionId);
  const connection = (await listConnections(pool, a))[0];
  assert.equal(connection.active, false);
  assert.equal(connection.send_enabled, false);
  assert.equal(connection.token_registered, false);
  await assert.rejects(updateConnection(pool, a, connectionId, { active: true, send_enabled: false }), ApiError);
  assert.equal((await listRules(pool, a))[0].enabled, false);
});

test("administrator ownership assignment requires confirmation and preserves existing owners", async () => {
  const client = await pool.connect();
  try {
    const script = await readFile(new URL("../../deploy/assign-workspace-owner.sql", import.meta.url), "utf8");
    const functionSql = script
      .slice(script.indexOf("CREATE FUNCTION"), script.indexOf("SELECT pg_temp.assign_workspace_owner"))
      .replace("auth.users", "pg_temp.verified_users");
    await client.query("CREATE TEMP TABLE verified_users(id uuid,email_confirmed_at timestamptz)");
    await client.query(functionSql);
    const legacy = "55555555-5555-4555-8555-555555555555";
    await client.query("INSERT INTO workspaces VALUES($1)", [legacy]);
    await assert.rejects(
      client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [b.id, legacy]),
      /Confirmed Supabase user/,
    );
    await client.query("INSERT INTO verified_users VALUES($1,now()),($2,now())", [a.id, b.id]);
    await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [a.id, legacy]), /not empty/);
    await client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [b.id, legacy]);
    await client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [b.id, legacy]);
    await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [a.id, legacy]), /already owned/);
    assert.equal(
      (await client.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1", [b.id])).rows[0].workspace_id,
      legacy,
    );
  } finally {
    await client.query("DROP TABLE IF EXISTS pg_temp.verified_users");
    client.release();
  }
});

test("activity belongs to the verified workspace and excludes recipient content", async () => {
  const { ingestComments } = await import("../instagram/store.ts");
  const { listActivity } = await import("./settings.ts");
  await saveRule(pool, a, input);
  await ingestComments(pool, [{ accountId: "123", commentId: "777", postId: "12345", senderId: "888", text: "link" }]);
  const owned = await listActivity(pool, a);
  assert.equal(owned.length, 1);
  assert.equal(owned[0].first_reply_status, "pending");
  assert.equal("sender_id" in owned[0], false);
  assert.equal("private_reply_text" in owned[0], false);
  assert.deepEqual(await listActivity(pool, b), []);
});
