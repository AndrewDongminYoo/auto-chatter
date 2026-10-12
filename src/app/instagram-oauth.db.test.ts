import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { beginInstagramOAuth, deleteExpiredOAuthStates, finishInstagramOAuth } from "./instagram-oauth.ts";
import { refreshDueInstagramTokens, refreshDueInstagramTokensWithFailures } from "./instagram-token-refresh.ts";
import { disconnectConnection, ensureWorkspace } from "./settings.ts";
import { openSecret, sealSecret } from "./secrets.ts";
import { markReauthRequired } from "./instagram-reauth.ts";
import { deauthorizeInstagramUser } from "./instagram-deauthorization.ts";
import { ingestMessages } from "../instagram/follow-flow.ts";
import { acceptInvite, createInvite } from "./workspace-members.ts";

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
  // The other workspace invites this user in the move tests; plans.db.test.ts covers the limits themselves.
  await pool.query("UPDATE workspaces SET plan='essential' WHERE id<>$1", [workspaceId]);
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

test("an OAuth reconnect that stores a new token clears the reconnect marker", async () => {
  const provider: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/oauth/access_token")
      return Response.json({
        access_token: "short-token",
        permissions: [
          "instagram_business_basic",
          "instagram_business_manage_comments",
          "instagram_business_manage_messages",
        ],
      });
    if (path === "/access_token") return Response.json({ access_token: "long-token", expires_in: 5_184_000 });
    if (path.endsWith("/me")) return Response.json({ user_id: "98765", username: "account" });
    return Response.json({ success: true });
  };
  assert.equal((await finishInstagramOAuth(pool, user, (await authorization()).request, env, provider)).status, 303);
  const { id, access_token_encrypted } = (
    await pool.query("SELECT id,access_token_encrypted FROM instagram_connections")
  ).rows[0];
  assert.equal(await markReauthRequired(pool, id, access_token_encrypted, "token_rejected"), true);
  assert.equal((await finishInstagramOAuth(pool, user, (await authorization()).request, env, provider)).status, 303);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT active,reauth_required_at,reauth_reason,reauth_token_obtained_at,access_token_encrypted<>$1 AS replaced FROM instagram_connections",
        [access_token_encrypted],
      )
    ).rows,
    [{ active: true, reauth_required_at: null, reauth_reason: null, reauth_token_obtained_at: null, replaced: true }],
  );
});

test("OAuth stores the exchange's user ID when it is unambiguous, and a reconnect clears the deauthorization", async () => {
  let exchangeUserId: unknown;
  const provider: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/oauth/access_token")
      return Response.json({
        data: [
          {
            access_token: "short-token",
            user_id: exchangeUserId,
            permissions:
              "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages",
          },
        ],
      });
    if (path === "/access_token") return Response.json({ access_token: "long-token", expires_in: 5_184_000 });
    if (path.endsWith("/me")) return Response.json({ user_id: "98765", username: "account" });
    return Response.json({ success: true });
  };
  const connect = async (userId: unknown) => {
    exchangeUserId = userId;
    assert.equal((await finishInstagramOAuth(pool, user, (await authorization()).request, env, provider)).status, 303);
    return (await pool.query("SELECT active,instagram_user_id,deauthorized_at FROM instagram_connections")).rows;
  };
  // A number above 2^53 was rounded by the parser: the connection succeeds without an ID.
  assert.deepEqual(await connect(2 ** 53), [{ active: true, instagram_user_id: null, deauthorized_at: null }]);
  assert.deepEqual(await connect(12345), [{ active: true, instagram_user_id: "12345", deauthorized_at: null }]);
  assert.deepEqual(await deauthorizeInstagramUser(pool, { userId: "12345", issuedAt: null }), {
    disconnected: [(await pool.query("SELECT id FROM instagram_connections")).rows[0].id],
    skipped: [],
  });
  assert.notEqual(
    (await pool.query("SELECT deauthorized_at FROM instagram_connections")).rows[0].deauthorized_at,
    null,
  );
  // A reconnect clears the deauthorization and stores what this exchange returned, NULL when it has no ID.
  assert.deepEqual(await connect(undefined), [{ active: true, instagram_user_id: null, deauthorized_at: null }]);
  assert.deepEqual(await connect("17841400000000001"), [
    { active: true, instagram_user_id: "17841400000000001", deauthorized_at: null },
  ]);
  assert.deepEqual(await connect("12a"), [{ active: true, instagram_user_id: null, deauthorized_at: null }]);
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

test("a repeated or missing state parameter and a role lost mid-flow make no provider call", async () => {
  const { request, state } = await authorization();
  const provider: typeof fetch = async () => {
    throw new Error("provider must not be called");
  };
  const cookie = { cookie: `__Host-ac-oauth=${state}` };
  const repeated = new Request(`https://app.test/api/instagram/callback?state=${state}&state=${state}&code=test-code`, {
    headers: cookie,
  });
  await assert.rejects(finishInstagramOAuth(pool, user, repeated, env, provider), /invalid_oauth_state/);
  const missing = new Request("https://app.test/api/instagram/callback?code=test-code", { headers: cookie });
  await assert.rejects(finishInstagramOAuth(pool, user, missing, env, provider), /invalid_oauth_state/);
  await pool.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [user.id]);
  await assert.rejects(finishInstagramOAuth(pool, user, request, env, provider), /role_forbidden/);
  const states = await pool.query("SELECT consumed_at FROM instagram_oauth_states");
  assert.deepEqual(states.rows, [{ consumed_at: null }]);
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

test("refresh accepts a same-account profile wrapped in Graph data", async () => {
  const connection = "33333333-3333-4333-8333-333333333333";
  const context = `${workspaceId}:98765`;
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at,token_obtained_at) VALUES($1,$2,'98765',true,$3,now()+interval '20 days',now()-interval '2 days')",
    [connection, workspaceId, sealSecret("old-token", env.TOKEN_ENCRYPTION_KEY, context)],
  );
  const provider: typeof fetch = async (input) =>
    String(input).includes("refresh_access_token")
      ? Response.json({ access_token: "new-token", expires_in: 5_184_000 })
      : Response.json({ data: [{ user_id: "98765" }] });
  assert.equal(await refreshDueInstagramTokens(pool, env.TOKEN_ENCRYPTION_KEY, provider), 1);
  const row = (await pool.query("SELECT access_token_encrypted FROM instagram_connections WHERE id=$1", [connection]))
    .rows[0];
  assert.equal(openSecret(row.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY, context), "new-token");
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
  // The failed attempt is counted once; the next run within a day does not claim the connection again.
  assert.deepEqual(await refreshDueInstagramTokensWithFailures(pool, env.TOKEN_ENCRYPTION_KEY, failed, now), {
    refreshed: 0,
    failed: 1,
  });
  assert.deepEqual(await refreshDueInstagramTokensWithFailures(pool, env.TOKEN_ENCRYPTION_KEY, failed, now), {
    refreshed: 0,
    failed: 0,
  });
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
  // Losing to a newer OAuth token is not a refresh failure.
  assert.deepEqual(await refreshDueInstagramTokensWithFailures(pool, env.TOKEN_ENCRYPTION_KEY, racing, later), {
    refreshed: 0,
    failed: 0,
  });
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
  assert.deepEqual(
    await refreshDueInstagramTokensWithFailures(pool, Buffer.alloc(32, 3).toString("base64"), provider),
    { refreshed: 0, failed: 1 },
  );
  assert.equal(
    (await pool.query("SELECT access_token_encrypted FROM instagram_connections WHERE id=$1", [connection])).rows[0]
      .access_token_encrypted,
    ciphertext,
  );
});

test("an invite accepted while the callback runs leaves no connection in the abandoned workspace", async () => {
  const { request } = await authorization();
  const invite = await createInvite(pool, other, { email: user.email, role: "admin" }, "https://app.test");
  const token = new URL(invite.link).hash.slice("#invite=".length);
  let calls = 0;
  const provider: typeof fetch = async () => {
    calls++;
    // The user joins the other workspace after the state was consumed and before the connection is stored.
    if (calls === 1) {
      await acceptInvite(pool, user, { token });
      return Response.json({
        access_token: "short-token",
        permissions: [
          "instagram_business_basic",
          "instagram_business_manage_comments",
          "instagram_business_manage_messages",
        ],
      });
    }
    if (calls === 2) return Response.json({ access_token: "long-token", expires_in: 5_184_000 });
    if (calls === 3) return Response.json({ user_id: "98765", username: "account" });
    return Response.json({ success: true });
  };
  await assert.rejects(finishInstagramOAuth(pool, user, request, env, provider), /workspace_required/);
  assert.equal((await pool.query("SELECT count(*) FROM instagram_connections")).rows[0].count, "0");
});

test("starting a connection while an invite moves the user does not leave a state in the abandoned workspace", async () => {
  const invite = await createInvite(pool, other, { email: user.email, role: "admin" }, "https://app.test");
  const token = new URL(invite.link).hash.slice("#invite=".length);
  const blocker = await pool.connect();
  try {
    // Queue the acceptance first, then the connection start, behind a lock on the user's own workspace.
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
    const accepting = acceptInvite(pool, user, { token });
    const waiters = async (count: number) => {
      for (let attempt = 0; attempt < 80; attempt++) {
        const waiting = await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock'",
        );
        if (waiting.rows[0].n >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`fewer than ${count} lock waiters`);
    };
    await waiters(1);
    const starting = beginInstagramOAuth(pool, user, env).then(
      (response) => response.status,
      (error: { status?: number }) => error.status,
    );
    await waiters(2);
    await blocker.query("COMMIT");
    await accepting;
    assert.equal(await starting, 403);
  } finally {
    blocker.release();
  }
  const states = await pool.query("SELECT count(*) FROM instagram_oauth_states WHERE workspace_id=$1", [workspaceId]);
  assert.equal(states.rows[0].count, "0");
});

test("expired OAuth state cleanup removes only expired states, consumed or not", async () => {
  await pool.query(
    `INSERT INTO instagram_oauth_states(state_hash,user_id,workspace_id,expires_at,consumed_at) VALUES
       ('expired',$1,$2,now()-interval '1 second',NULL),
       ('expired-consumed',$1,$2,now()-interval '1 minute',now()-interval '2 minutes'),
       ('live',$1,$2,now()+interval '10 minutes',NULL),
       ('live-consumed',$1,$2,now()+interval '5 minutes',now()-interval '1 minute')`,
    [user.id, workspaceId],
  );
  assert.equal(await deleteExpiredOAuthStates(pool), 2);
  assert.deepEqual(
    (await pool.query("SELECT state_hash FROM instagram_oauth_states ORDER BY state_hash")).rows.map(
      (row) => row.state_hash,
    ),
    ["live", "live-consumed"],
  );
  assert.equal(await deleteExpiredOAuthStates(pool), 0);
  const definer = await pool.query(
    "SELECT prosecdef, proconfig FROM pg_proc WHERE oid='public.delete_expired_oauth_states()'::regprocedure",
  );
  assert.equal(definer.rows[0].prosecdef, true);
  assert.deepEqual(definer.rows[0].proconfig, ["search_path=public, pg_temp"]);
});

test("expired OAuth state cleanup removes at most 1,000 rows per call", async () => {
  await pool.query(
    "INSERT INTO instagram_oauth_states(state_hash,user_id,workspace_id,expires_at) SELECT 'expired-'||n,$1,$2,now()-interval '1 minute' FROM generate_series(1,1005) n",
    [user.id, workspaceId],
  );
  await pool.query(
    "INSERT INTO instagram_oauth_states(state_hash,user_id,workspace_id,expires_at) VALUES('live',$1,$2,now()+interval '10 minutes')",
    [user.id, workspaceId],
  );
  assert.equal(await deleteExpiredOAuthStates(pool), 1000);
  assert.equal(await deleteExpiredOAuthStates(pool), 5);
  assert.equal(await deleteExpiredOAuthStates(pool), 0);
  assert.deepEqual((await pool.query("SELECT state_hash FROM instagram_oauth_states")).rows, [{ state_hash: "live" }]);
});
