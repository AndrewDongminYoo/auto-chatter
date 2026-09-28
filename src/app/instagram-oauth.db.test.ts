import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { beginInstagramOAuth, finishInstagramOAuth } from "./instagram-oauth.ts";
import { refreshDueInstagramTokens } from "./instagram-token-refresh.ts";
import { disconnectConnection, ensureWorkspace } from "./settings.ts";
import { openSecret, sealSecret } from "./secrets.ts";
import { ingestMessages } from "../instagram/follow-flow.ts";

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
    if (calls === 2) return Response.json({ access_token: "long-token", expires_in: 5_184_000 });
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

test("OAuth rejects a token that expires before it is eligible for refresh", async () => {
  const { request } = await authorization();
  let calls = 0;
  const provider: typeof fetch = async () => {
    calls++;
    if (calls === 1)
      return Response.json({
        access_token: "short-token",
        permissions: "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages",
      });
    return Response.json({ access_token: "unexpected-short-lifetime", expires_in: 3600 });
  };
  await assert.rejects(finishInstagramOAuth(pool, user, request, env, provider), /instagram_connection_failed/);
  assert.equal(calls, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_connections")).rows[0].count, 0);
});

test("OAuth reconnection advances opted-in retention past delayed messages while preserving history", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,inbox_enabled,inbox_enabled_at) VALUES($1,$2,'98765',true,true,now()-interval '2 hours')",
    [id, workspaceId],
  );
  const message = {
    accountId: "98765",
    senderId: "456",
    messageId: "before-disconnect",
    text: "stored",
    timestamp: new Date(Date.now() - 3600000),
  };
  await ingestMessages(pool, [message]);
  await disconnectConnection(pool, user, id);
  await pool.query("UPDATE instagram_connections SET token_refresh_attempted_at=now() WHERE id=$1", [id]);
  const stoppedAt = (await pool.query("SELECT clock_timestamp() AS stopped_at")).rows[0].stopped_at;
  await pool.query("SELECT pg_sleep(0.02)");
  const { request } = await authorization();
  const provider: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.instagram.com/oauth"))
      return Response.json({
        access_token: "short",
        permissions: "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages",
      });
    if (url.includes("/access_token")) return Response.json({ access_token: "long", expires_in: 5_184_000 });
    if (url.includes("/me?")) return Response.json({ user_id: "98765", username: "account" });
    return Response.json({ success: true });
  };
  assert.equal((await finishInstagramOAuth(pool, user, request, env, provider)).status, 303);
  const row = (
    await pool.query(
      "SELECT active,inbox_enabled,inbox_enabled_at,token_refresh_attempted_at FROM instagram_connections WHERE id=$1",
      [id],
    )
  ).rows[0];
  assert.equal(row.active, true);
  assert.equal(row.inbox_enabled, true);
  assert.equal(row.token_refresh_attempted_at, null);
  assert.ok(row.inbox_enabled_at.getTime() > stoppedAt.getTime(), "OAuth activation advances the opt-in cutoff");
  await ingestMessages(pool, [
    { ...message, messageId: "delayed-disconnected", timestamp: stoppedAt },
    { ...message, messageId: "after-reconnect", timestamp: new Date(row.inbox_enabled_at.getTime() + 1000) },
  ]);
  assert.deepEqual(
    (await pool.query("SELECT message_id FROM instagram_inbox_messages ORDER BY id")).rows.map(
      (message) => message.message_id,
    ),
    ["before-disconnect", "after-reconnect"],
  );
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
    if (calls === 2) return Response.json({ access_token: "long", expires_in: 5_184_000 });
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
    if (url.includes("/access_token")) return Response.json({ access_token: "long", expires_in: 5_184_000 });
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
  await pool.query(
    "UPDATE instagram_connections SET token_expires_at=now()+interval '20 days',token_obtained_at=now()-interval '2 days'",
  );
  let refreshCalls = 0;
  const refreshProvider: typeof fetch = async () => {
    refreshCalls++;
    return Response.json({ access_token: "unexpected", expires_in: 5_184_000 });
  };
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, refreshProvider), 0);
  assert.equal(refreshCalls, 0);
});

test("refreshes a due Instagram token and keeps it encrypted for the same account", async () => {
  const connection = "33333333-3333-4333-8333-333333333333";
  const oldCiphertext = sealSecret("old-token", env.TOKEN_ENCRYPTION_KEY, `${workspaceId}:98765`);
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at,token_obtained_at) VALUES($1,$2,'98765',true,$3,now()+interval '20 days',now()-interval '2 days')",
    [connection, workspaceId, oldCiphertext],
  );
  const calls: string[] = [];
  const provider: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === "/refresh_access_token") {
      assert.equal(url.searchParams.get("grant_type"), "ig_refresh_token");
      assert.equal(url.searchParams.get("access_token"), "old-token");
      return Response.json({ access_token: "new-token", token_type: "bearer", expires_in: 5_184_000 });
    }
    assert.equal(url.pathname, "/v26.0/me");
    return Response.json({ user_id: "98765" });
  };
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, provider), 1);
  const row = (
    await pool.query(
      "SELECT access_token_encrypted,token_expires_at,token_obtained_at FROM instagram_connections WHERE id=$1",
      [connection],
    )
  ).rows[0];
  assert.equal(openSecret(row.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY, `${workspaceId}:98765`), "new-token");
  assert.ok(row.token_expires_at.getTime() > Date.now() + 59 * 86400_000);
  assert.ok(row.token_obtained_at.getTime() > Date.now() - 60_000);
  assert.deepEqual(calls, ["/refresh_access_token", "/v26.0/me"]);
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, provider), 0);
});

test("does not refresh unexpired tokens before the threshold or tokens that already expired", async () => {
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at) VALUES($1,$2,'98765',true,'ciphertext',now()+interval '40 days')",
    ["33333333-3333-4333-8333-333333333333", workspaceId],
  );
  const provider: typeof fetch = async () => {
    throw new Error("provider must not be called");
  };
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, provider), 0);
  await pool.query("UPDATE instagram_connections SET token_expires_at=now()-interval '1 second'");
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, provider), 0);
});

test("does not refresh inactive connections or tokens younger than 24 hours", async () => {
  const connection = "33333333-3333-4333-8333-333333333333";
  const ciphertext = sealSecret("old-token", env.TOKEN_ENCRYPTION_KEY, `${workspaceId}:98765`);
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at,token_obtained_at) VALUES($1,$2,'98765',false,$3,now()+interval '20 days',now()-interval '2 days')",
    [connection, workspaceId, ciphertext],
  );
  let calls = 0;
  const provider: typeof fetch = async () => {
    calls++;
    return Response.json({ access_token: "new-token", expires_in: 5_184_000 });
  };
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, provider), 0);
  await pool.query("UPDATE instagram_connections SET active=true,token_obtained_at=now() WHERE id=$1", [connection]);
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, provider), 0);
  assert.equal(calls, 0);
  const row = (
    await pool.query(
      "SELECT access_token_encrypted,token_refresh_attempted_at FROM instagram_connections WHERE id=$1",
      [connection],
    )
  ).rows[0];
  assert.equal(row.access_token_encrypted, ciphertext);
  assert.equal(row.token_refresh_attempted_at, null);
});

test("refresh failure keeps the old token and a newer OAuth token wins a refresh race", async () => {
  const connection = "33333333-3333-4333-8333-333333333333";
  const context = `${workspaceId}:98765`;
  const oldCiphertext = sealSecret("old-token", env.TOKEN_ENCRYPTION_KEY, context);
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at,token_obtained_at) VALUES($1,$2,'98765',true,$3,now()+interval '20 days',now()-interval '2 days')",
    [connection, workspaceId, oldCiphertext],
  );
  const now = new Date();
  let calls = 0;
  const failed: typeof fetch = async () => {
    calls++;
    return Response.json({ error: { code: 4 } }, { status: 400 });
  };
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, failed, now), 0);
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, failed, now), 0);
  assert.equal(calls, 1);
  assert.equal(
    (await pool.query("SELECT access_token_encrypted FROM instagram_connections WHERE id=$1", [connection])).rows[0]
      .access_token_encrypted,
    oldCiphertext,
  );
  const later = new Date(now.getTime() + 86400_001);
  const replacement = sealSecret("reconnected-token", env.TOKEN_ENCRYPTION_KEY, context);
  const racing: typeof fetch = async (input) => {
    if (String(input).includes("refresh_access_token")) {
      await pool.query(
        "UPDATE instagram_connections SET access_token_encrypted=$2,token_expires_at=now()+interval '60 days',token_obtained_at=now(),token_refresh_attempted_at=NULL WHERE id=$1",
        [connection, replacement],
      );
      return Response.json({ access_token: "stale-refresh", token_type: "bearer", expires_in: 5_184_000 });
    }
    return Response.json({ user_id: "98765" });
  };
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, racing, later), 0);
  assert.equal(
    (await pool.query("SELECT access_token_encrypted FROM instagram_connections WHERE id=$1", [connection])).rows[0]
      .access_token_encrypted,
    replacement,
  );
});

test("only one concurrent refresh can claim a connection", async () => {
  const connection = "33333333-3333-4333-8333-333333333333";
  const context = `${workspaceId}:98765`;
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at,token_obtained_at) VALUES($1,$2,'98765',true,$3,now()+interval '20 days',now()-interval '2 days')",
    [connection, workspaceId, sealSecret("old-token", env.TOKEN_ENCRYPTION_KEY, context)],
  );
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refreshCalls = 0;
  const provider: typeof fetch = async (input) => {
    if (String(input).includes("refresh_access_token")) {
      refreshCalls++;
      entered();
      await waiting;
      return Response.json({ access_token: "new-token", expires_in: 5_184_000 });
    }
    return Response.json({ user_id: "98765" });
  };
  const first = refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, provider);
  await started;
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, provider), 0);
  release();
  assert.equal(await first, 1);
  assert.equal(refreshCalls, 1);
});

test("stopping receipt during a provider refresh does not extend the token", async () => {
  const connection = "33333333-3333-4333-8333-333333333333";
  const context = `${workspaceId}:98765`;
  const ciphertext = sealSecret("old-token", env.TOKEN_ENCRYPTION_KEY, context);
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at,token_obtained_at) VALUES($1,$2,'98765',true,$3,now()+interval '20 days',now()-interval '2 days')",
    [connection, workspaceId, ciphertext],
  );
  const before = (await pool.query("SELECT token_expires_at FROM instagram_connections WHERE id=$1", [connection]))
    .rows[0].token_expires_at;
  const provider: typeof fetch = async (input) => {
    if (String(input).includes("refresh_access_token")) {
      await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false WHERE id=$1", [connection]);
      return Response.json({ access_token: "new-token", expires_in: 5_184_000 });
    }
    return Response.json({ user_id: "98765" });
  };
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, provider), 0);
  const after = (
    await pool.query("SELECT active,access_token_encrypted,token_expires_at FROM instagram_connections WHERE id=$1", [
      connection,
    ])
  ).rows[0];
  assert.equal(after.active, false);
  assert.equal(after.access_token_encrypted, ciphertext);
  assert.equal(after.token_expires_at.getTime(), before.getTime());
});

test("wrong encryption key cannot change the token or call Meta", async () => {
  const connection = "33333333-3333-4333-8333-333333333333";
  const ciphertext = sealSecret("old-token", env.TOKEN_ENCRYPTION_KEY, `${workspaceId}:98765`);
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at,token_obtained_at) VALUES($1,$2,'98765',true,$3,now()+interval '20 days',now()-interval '2 days')",
    [connection, workspaceId, ciphertext],
  );
  const provider: typeof fetch = async () => {
    throw new Error("provider must not be called");
  };
  assert.equal(await refreshDueInstagramTokens(pool, Buffer.alloc(32, 3).toString("base64"), provider), 0);
  assert.equal(
    (await pool.query("SELECT access_token_encrypted FROM instagram_connections WHERE id=$1", [connection])).rows[0]
      .access_token_encrypted,
    ciphertext,
  );
});
