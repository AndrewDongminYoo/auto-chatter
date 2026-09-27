import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { beginInstagramOAuth, finishInstagramOAuth } from "./instagram-oauth.ts";
import { ensureWorkspace } from "./settings.ts";
import { openSecret } from "./secrets.ts";

const url = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: url.toString() });
const user = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const other = { id: "22222222-2222-4222-8222-222222222222", email: "other@example.test" };
const env = {
  APP_ORIGIN: "https://app.test",
  INSTAGRAM_OAUTH_APP_ID: "123",
  INSTAGRAM_OAUTH_APP_SECRET: "synthetic-secret",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  META_GRAPH_VERSION: "v26.0",
};
let workspaceId: string;
before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  workspaceId = await ensureWorkspace(pool, user);
  await ensureWorkspace(pool, other);
});
after(async () => {
  await pool.end();
});

async function authorization() {
  const response = await beginInstagramOAuth(pool, user, env);
  const redirect = new URL(((await response.json()) as { url: string }).url);
  const state = redirect.searchParams.get("state")!;
  const request = new Request(`https://app.test/api/instagram/callback?state=${state}&code=test-code`, {
    headers: { cookie: `__Host-ac-oauth=${state}` },
  });
  return { request, state };
}

test("OAuth verifies ownership, stores ciphertext, subscribes webhooks, and consumes state once", async () => {
  const { request } = await authorization();
  let calls = 0;
  const provider: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    if (calls === 1)
      return Response.json({
        access_token: "short-token",
        permissions: [
          "instagram_business_basic",
          "instagram_business_manage_comments",
          "instagram_business_manage_messages",
        ],
      });
    if (calls === 2) return Response.json({ access_token: "long-token", expires_in: 3600 });
    if (calls === 3) return Response.json({ user_id: "98765", username: "account" });
    assert.equal(String(input), "https://graph.instagram.com/v26.0/98765/subscribed_apps");
    assert.equal(init?.method, "POST");
    assert.equal(
      new URLSearchParams(String(init?.body)).get("subscribed_fields"),
      "comments,messages,messaging_postbacks",
    );
    return Response.json({ success: true });
  };
  const response = await finishInstagramOAuth(pool, user, request, env, provider);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://app.test/app/?instagram=connected");
  const row = (await pool.query("SELECT * FROM instagram_connections")).rows[0];
  assert.equal(row.active, true);
  assert.equal(row.send_enabled, false);
  assert.equal(openSecret(row.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY, `${workspaceId}:98765`), "long-token");
  assert.equal(calls, 4);
  await assert.rejects(finishInstagramOAuth(pool, user, request, env, provider));
  assert.equal(calls, 4);
});

test("expired, cross-user, and browser-mismatched states make no provider call", async () => {
  const { request, state } = await authorization();
  const provider: typeof fetch = async () => {
    throw new Error("provider must not be called");
  };
  await assert.rejects(finishInstagramOAuth(pool, other, request, env, provider), /invalid_oauth_state/);
  const mismatch = new Request(request.url, { headers: { cookie: `__Host-ac-oauth=${"a".repeat(64)}` } });
  assert.notEqual(state, "a".repeat(64));
  await assert.rejects(finishInstagramOAuth(pool, user, mismatch, env, provider), /invalid_oauth_state/);
  await pool.query("UPDATE instagram_oauth_states SET expires_at=now()-interval '1 minute'");
  await assert.rejects(finishInstagramOAuth(pool, user, request, env, provider), /invalid_oauth_state/);
});

test("a callback overtaken by another connection update cannot claim success", async () => {
  const { request } = await authorization();
  let calls = 0;
  const provider: typeof fetch = async () => {
    calls++;
    if (calls === 1)
      return Response.json({
        access_token: "short",
        permissions: "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages",
      });
    if (calls === 2) return Response.json({ access_token: "long", expires_in: 3600 });
    if (calls === 3) return Response.json({ user_id: "98765", username: "account" });
    await pool.query(
      "UPDATE instagram_connections SET access_token_encrypted='replaced-by-other-callback',active=false",
    );
    return Response.json({ success: true });
  };
  await assert.rejects(finishInstagramOAuth(pool, user, request, env, provider), /instagram_connection_changed/);
  assert.equal((await pool.query("SELECT active FROM instagram_connections")).rows[0].active, false);
});

test("OAuth cannot transfer another workspace's account or activate a failed subscription", async () => {
  const otherWorkspace = await ensureWorkspace(pool, other);
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES('33333333-3333-4333-8333-333333333333',$1,'98765')",
    [otherWorkspace],
  );
  const provider: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.instagram.com/oauth"))
      return Response.json({
        data: [
          {
            access_token: "short",
            permissions:
              "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages",
          },
        ],
      });
    if (url.includes("/access_token")) return Response.json({ access_token: "long", expires_in: 3600 });
    if (url.includes("/me?")) return Response.json({ user_id: "98765", username: "account" });
    return Response.json({ success: false });
  };
  const first = await authorization();
  await assert.rejects(finishInstagramOAuth(pool, user, first.request, env, provider), /already_connected/);
  assert.equal(
    (await pool.query("SELECT workspace_id FROM instagram_connections")).rows[0].workspace_id,
    otherWorkspace,
  );
  await pool.query("UPDATE instagram_connections SET workspace_id=$1", [workspaceId]);
  const next = await authorization();
  await assert.rejects(finishInstagramOAuth(pool, user, next.request, env, provider), /subscription_failed/);
  const row = (await pool.query("SELECT active,send_enabled FROM instagram_connections")).rows[0];
  assert.deepEqual(row, { active: false, send_enabled: false });
});
