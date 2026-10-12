import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { beginInstagramOAuth, finishInstagramOAuth } from "./instagram-oauth.ts";
import { PLANS } from "./plans.ts";
import { disconnectConnection, ensureWorkspace } from "./settings.ts";
import { acceptInvite, createInvite, removeMember, revokeInvite } from "./workspace-members.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
type Actor = { id: string; email: string };
const owner: Actor = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const first: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "first@example.test" };
const second: Actor = { id: "33333333-3333-4333-8333-333333333333", email: "second@example.test" };
const third: Actor = { id: "44444444-4444-4444-8444-444444444444", email: "third@example.test" };
const outsider: Actor = { id: "55555555-5555-4555-8555-555555555555", email: "outsider@example.test" };
const workspaceId = "66666666-6666-4666-8666-666666666666";
const otherWorkspaceId = "77777777-7777-4777-8777-777777777777";
const oauthEnv = {
  APP_ORIGIN: "https://app.test",
  INSTAGRAM_OAUTH_APP_ID: "123",
  INSTAGRAM_OAUTH_APP_SECRET: "synthetic-secret",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  META_GRAPH_VERSION: "v26.0",
};
const apiEnv = {
  ...oauthEnv,
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  INSTAGRAM_PUBLIC_CONNECT_ENABLED: "true",
};

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role,email) VALUES($1,$2,'owner',$3),($4,$5,'owner',$6)",
    [workspaceId, owner.id, owner.email, otherWorkspaceId, outsider.id, outsider.email],
  );
});

after(async () => pool.end());

async function setPlan(plan: string, id = workspaceId) {
  await pool.query("UPDATE workspaces SET plan=$2 WHERE id=$1", [id, plan]);
}

async function invite(email: string) {
  const created = await createInvite(pool, owner, { email, role: "agent" }, "https://app.test");
  return { id: created.id as string, token: created.link.split("#invite=")[1]! };
}

async function memberCount(id = workspaceId): Promise<number> {
  return (
    await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id=$1 AND removed_at IS NULL",
      [id],
    )
  ).rows[0]!.n;
}

const seatRefusal = { status: 409, message: "seat_limit_reached" };
const connectionRefusal = { status: 409, message: "connection_limit_reached" };

// Waits until `count` sessions wait on a lock, or until `settled` reports that the awaited call finished, so a
// missing lock fails a value assertion below instead of a timeout here.
async function lockWaiters(count: number, settled: () => boolean = () => false) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (settled()) return;
    const waiting = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()",
    );
    if (waiting.rows[0]!.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fewer than ${count} lock waiters`);
}

function outcome(promise: Promise<unknown>) {
  const state = { done: false };
  const result = promise.then(
    () => "ok",
    (error: Error) => error.message,
  );
  void result.finally(() => (state.done = true));
  return { result, settled: () => state.done };
}

test("the plan CHECK lists exactly the catalog keys, and a new workspace starts on free", async () => {
  const definition = (
    await pool.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='workspaces'::regclass AND conname='workspaces_plan'",
    )
  ).rows[0]!.def;
  const keys = [...definition.matchAll(/'([a-z]+)'::text/g)].map((match) => match[1]).sort();
  assert.deepEqual(keys, Object.keys(PLANS).sort());
  await assert.rejects(setPlan("gold"), { code: "23514" });
  await assert.rejects(pool.query("UPDATE workspaces SET plan=NULL WHERE id=$1", [workspaceId]), { code: "23502" });
  assert.equal((await pool.query("SELECT plan FROM workspaces WHERE id=$1", [workspaceId])).rows[0].plan, "free");
  const created = await ensureWorkspace(pool, first);
  assert.equal((await pool.query("SELECT plan FROM workspaces WHERE id=$1", [created])).rows[0].plan, "free");
});

test("migration 045 gives existing workspaces advanced, new ones free, and a replay keeps a changed plan", async () => {
  const migration = await readFile(new URL("../../db/migrations/045_workspace_plans.sql", import.meta.url), "utf8");
  await pool.query("ALTER TABLE workspaces DROP COLUMN plan");
  try {
    await pool.query(migration);
    const plans = await pool.query("SELECT plan FROM workspaces ORDER BY id");
    assert.deepEqual(
      plans.rows.map((row) => row.plan),
      ["advanced", "advanced"],
    );
    const fresh = await ensureWorkspace(pool, first);
    assert.equal((await pool.query("SELECT plan FROM workspaces WHERE id=$1", [fresh])).rows[0].plan, "free");
    await setPlan("pro");
    await pool.query(migration);
    await pool.query(migration);
    assert.equal((await pool.query("SELECT plan FROM workspaces WHERE id=$1", [workspaceId])).rows[0].plan, "pro");
    assert.equal((await pool.query("SELECT plan FROM workspaces WHERE id=$1", [fresh])).rows[0].plan, "free");
    await assert.rejects(setPlan("gold"), { code: "23514" });
  } finally {
    await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  }
});

test("an invite needs a free seat; replacing, revoking or expiring an invite and removing a member free one", async () => {
  await assert.rejects(invite("first@example.test"), seatRefusal);
  await setPlan("essential");
  const firstInvite = await invite("first@example.test");
  await assert.rejects(invite("second@example.test"), seatRefusal);
  // A new link for the same email replaces the open invite instead of taking another seat.
  const replaced = await invite("first@example.test");
  await assert.rejects(acceptInvite(pool, first, { token: firstInvite.token }), { message: "invite_revoked" });
  await revokeInvite(pool, owner, replaced.id);
  const expiring = await invite("second@example.test");
  await pool.query(
    "UPDATE workspace_invites SET created_at=now()-interval '8 days',expires_at=now()-interval '1 day' WHERE id=$1",
    [expiring.id],
  );
  const accepted = await invite("first@example.test");
  assert.deepEqual(await acceptInvite(pool, first, { token: accepted.token }), {
    workspace_id: workspaceId,
    role: "agent",
  });
  // The accepted invite is now a member and still takes the seat.
  await assert.rejects(invite("second@example.test"), seatRefusal);
  await removeMember(pool, owner, first.id);
  await invite("second@example.test");
});

test("accepting refuses a full workspace, and a downgrade keeps existing members", async () => {
  await setPlan("pro");
  const a = await invite("first@example.test");
  const b = await invite("second@example.test");
  await acceptInvite(pool, first, { token: a.token });
  await setPlan("free");
  // The workspace already has two members on one seat: both stay, and no one else joins.
  await assert.rejects(acceptInvite(pool, second, { token: b.token }), seatRefusal);
  assert.equal(await memberCount(), 2);
  const open = await pool.query("SELECT accepted_at FROM workspace_invites WHERE id=$1", [b.id]);
  assert.equal(open.rows[0].accepted_at, null);
  await assert.rejects(invite("third@example.test"), seatRefusal);
  await setPlan("pro");
  await acceptInvite(pool, second, { token: b.token });
  assert.equal(await memberCount(), 3);
});

test("an invite creation that started after another one counted waits for it and then sees the seat taken", async () => {
  await setPlan("pro");
  const reopened = await invite("first@example.test");
  await revokeInvite(pool, owner, reopened.id);
  await invite("third@example.test");
  // The blocker reopens the revoked invite without committing. Its UPDATE leaves workspace_id unchanged, so it
  // takes no lock on the workspace row, and the first creation stops at its INSERT on the open-email unique
  // index, after its seat count, while it holds the workspace row.
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("UPDATE workspace_invites SET revoked_at=NULL WHERE id=$1", [reopened.id]);
    const firstCreate = outcome(invite("first@example.test"));
    await lockWaiters(1, firstCreate.settled);
    const secondCreate = outcome(invite("second@example.test"));
    await lockWaiters(2, secondCreate.settled);
    await blocker.query("ROLLBACK");
    assert.deepEqual([await firstCreate.result, await secondCreate.result], ["ok", "seat_limit_reached"]);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  const open = await pool.query(
    "SELECT email FROM workspace_invites WHERE workspace_id=$1 AND revoked_at IS NULL AND accepted_at IS NULL ORDER BY email",
    [workspaceId],
  );
  assert.deepEqual(
    open.rows.map((row) => row.email),
    ["first@example.test", "third@example.test"],
  );
});

test("an acceptance that started after another one counted waits for it and then sees the seat taken", async () => {
  await setPlan("pro");
  const a = await invite("first@example.test");
  const b = await invite("second@example.test");
  await setPlan("essential");
  // The blocker holds an uncommitted membership row for the first user, so the first acceptance stops at its
  // INSERT, after its seat count, while it holds the workspace row.
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("INSERT INTO workspace_members(user_id,workspace_id,role) VALUES($1,$2,'agent')", [
      first.id,
      otherWorkspaceId,
    ]);
    const firstAccept = outcome(acceptInvite(pool, first, { token: a.token }));
    await lockWaiters(1, firstAccept.settled);
    const secondAccept = outcome(acceptInvite(pool, second, { token: b.token }));
    await lockWaiters(2, secondAccept.settled);
    await blocker.query("ROLLBACK");
    assert.deepEqual([await firstAccept.result, await secondAccept.result], ["ok", "seat_limit_reached"]);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  assert.equal(await memberCount(), 2);
});

function provider(account: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://project.supabase.co/"))
      return Response.json({ id: owner.id, email: owner.email, email_confirmed_at: "2026-10-12" });
    if (url.startsWith("https://api.instagram.com/oauth/access_token"))
      return Response.json({
        access_token: `short-${account}`,
        permissions: [
          "instagram_business_basic",
          "instagram_business_manage_comments",
          "instagram_business_manage_messages",
        ],
      });
    if (url.startsWith("https://graph.instagram.com/access_token"))
      return Response.json({ access_token: `long-${account}`, expires_in: 5_184_000 });
    if (url.includes("/me?")) return Response.json({ user_id: account, username: `user${account}` });
    if (url.endsWith("/subscribed_apps")) return Response.json({ success: true });
    throw new Error(`unexpected provider call ${url}`);
  }) as typeof fetch;
}

async function callback(actor: Actor = owner) {
  const response = await beginInstagramOAuth(pool, actor, oauthEnv);
  const state = new URL(((await response.json()) as { url: string }).url).searchParams.get("state")!;
  return new Request(`https://app.test/api/instagram/callback?state=${state}&code=test-code`, {
    headers: { cookie: `__Host-ac-oauth=${state}; __Host-ac-access=test` },
  });
}

async function connect(account: string, actor: Actor = owner) {
  const response = await finishInstagramOAuth(pool, actor, await callback(actor), oauthEnv, provider(account));
  assert.equal(response.status, 303);
}

async function connectedAccounts(id = workspaceId): Promise<string[]> {
  return (
    await pool.query<{ account_id: string }>(
      `SELECT account_id FROM instagram_connections WHERE workspace_id=$1
       AND (active OR access_token_encrypted IS NOT NULL) ORDER BY account_id`,
      [id],
    )
  ).rows.map((row) => row.account_id);
}

test("a new account is refused at the connection limit, and re-authorizing a connected one is not", async () => {
  await connect("1001");
  const before = (await pool.query("SELECT token_obtained_at FROM instagram_connections WHERE account_id='1001'"))
    .rows[0].token_obtained_at;
  await assert.rejects(connect("1002"), connectionRefusal);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_connections")).rows[0].n, 1);
  await connect("1001");
  const after = (await pool.query("SELECT token_obtained_at FROM instagram_connections WHERE account_id='1001'"))
    .rows[0].token_obtained_at;
  assert.ok(after > before, "the re-authorization stores a new token");
  assert.deepEqual(await connectedAccounts(), ["1001"]);
});

test("a disconnect frees the connection, and reconnecting a disconnected account takes one", async () => {
  await connect("1001");
  const id = (await pool.query("SELECT id FROM instagram_connections WHERE account_id='1001'")).rows[0].id;
  await disconnectConnection(pool, owner, id);
  await connect("1002");
  await assert.rejects(connect("1001"), connectionRefusal);
  assert.deepEqual(await connectedAccounts(), ["1002"]);
  await setPlan("essential");
  await connect("1001");
  assert.deepEqual(await connectedAccounts(), ["1001", "1002"]);
});

test("a downgrade keeps connected accounts and their re-authorization, and another workspace is unaffected", async () => {
  await setPlan("essential");
  await connect("1001");
  await connect("1002");
  await setPlan("free");
  assert.deepEqual(await connectedAccounts(), ["1001", "1002"]);
  await connect("1002");
  await assert.rejects(connect("1003"), connectionRefusal);
  // The other workspace's own limit counts only its own accounts.
  await connect("2001", outsider);
  assert.deepEqual(await connectedAccounts(otherWorkspaceId), ["2001"]);
  // An account held by another workspace keeps its existing answer, even when the caller is at its own limit.
  await assert.rejects(connect("1001", outsider), { status: 409, message: "instagram_account_already_connected" });
  assert.deepEqual(await connectedAccounts(), ["1001", "1002"]);
});

test("a completion that started after another one counted waits for it and then sees the connection taken", async () => {
  const firstCallback = await callback();
  const secondCallback = await callback();
  // The blocker holds an uncommitted row for the first account, so the first completion stops at its INSERT,
  // after its connection count, while it holds the workspace row.
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES(gen_random_uuid(),$1,'1001')",
      [otherWorkspaceId],
    );
    const firstCompletion = outcome(finishInstagramOAuth(pool, owner, firstCallback, oauthEnv, provider("1001")));
    await lockWaiters(1, firstCompletion.settled);
    const secondCompletion = outcome(finishInstagramOAuth(pool, owner, secondCallback, oauthEnv, provider("1002")));
    await lockWaiters(2, secondCompletion.settled);
    await blocker.query("ROLLBACK");
    assert.deepEqual([await firstCompletion.result, await secondCompletion.result], ["ok", "connection_limit_reached"]);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  assert.deepEqual(await connectedAccounts(), ["1001"]);
});

test("an account held by another workspace is refused even when that row is deleted before the insert", async () => {
  await connect("1001", outsider);
  await connect("1002");
  const pending = await callback();
  // The blocker deletes the other workspace's row and holds the delete open. A completion that relied on its
  // INSERT to refuse that account would wait on the blocker and then insert past the limit after its commit.
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("DELETE FROM instagram_connections WHERE account_id='1001'");
    const completion = outcome(finishInstagramOAuth(pool, owner, pending, oauthEnv, provider("1001")));
    await lockWaiters(1, completion.settled);
    await blocker.query("COMMIT");
    assert.equal(await completion.result, "instagram_account_already_connected");
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  assert.deepEqual(await connectedAccounts(), ["1002"]);
});

function apiRequest(actor: Actor, method: string, path: string) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () => Response.json({ id: actor.id, email: actor.email, email_confirmed_at: "2026-10-12" })) as typeof fetch,
  );
}

test("every role reads the plan, its limits and the usage; the owner's member list carries them too", async () => {
  await setPlan("business");
  const a = await invite("first@example.test");
  await acceptInvite(pool, first, { token: a.token });
  await invite("second@example.test");
  const expired = await invite("third@example.test");
  await pool.query(
    "UPDATE workspace_invites SET created_at=now()-interval '8 days',expires_at=now()-interval '1 day' WHERE id=$1",
    [expired.id],
  );
  await revokeInvite(pool, owner, (await invite("revoked@example.test")).id);
  await connect("1001");
  await connect("1002");
  const id = (await pool.query("SELECT id FROM instagram_connections WHERE account_id='1002'")).rows[0].id;
  await disconnectConnection(pool, owner, id);
  const expected = { plan: "business", limits: { seats: 5, connections: 5 }, usage: { seats: 3, connections: 1 } };
  const agent = await apiRequest(first, "POST", "/api/workspace");
  assert.equal(agent.status, 200);
  const workspace = (await agent.json()) as Record<string, unknown>;
  assert.equal(workspace.role, "agent");
  assert.deepEqual({ plan: workspace.plan, limits: workspace.limits, usage: workspace.usage }, expected);
  const members = (await (await apiRequest(owner, "GET", "/api/workspace/members")).json()) as Record<string, unknown>;
  assert.equal((members.members as unknown[]).length, 2);
  assert.deepEqual({ plan: members.plan, limits: members.limits, usage: members.usage }, expected);
});

test("the callback sends a refused connection back to the dashboard with the limit code", async () => {
  await connect("1001");
  const response = await appApi(
    await callback(),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    provider("1002"),
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://app.test/app/?instagram=connection_limit_reached");
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-ac-oauth=; .*Max-Age=0/);
  assert.deepEqual(await connectedAccounts(), ["1001"]);
});
