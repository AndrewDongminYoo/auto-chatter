import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { Pool } from "pg";
import { checkDueInstagramSubscriptions } from "./instagram-subscription-check.ts";
import { connectionHealth } from "./instagram-connection-health.ts";
import { beginInstagramOAuth, finishInstagramOAuth } from "./instagram-oauth.ts";
import { deauthorizeInstagramUser } from "./instagram-deauthorization.ts";
import { disconnectConnection, ensureWorkspace, listConnections } from "./settings.ts";
import { ConfigurationError } from "./operations-log.ts";
import { sealSecret } from "./secrets.ts";

const url = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: url.toString() });
const user = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const key = Buffer.alloc(32, 7).toString("base64");
const env = {
  APP_ORIGIN: "https://app.test",
  INSTAGRAM_OAUTH_APP_ID: "123",
  INSTAGRAM_OAUTH_APP_SECRET: "synthetic-secret",
  TOKEN_ENCRYPTION_KEY: key,
  META_GRAPH_VERSION: "v26.0",
};
const connection = "33333333-3333-4333-8333-333333333333";
const correlationId = "run-179";
let workspaceId: string;
let ciphertext: string;
let logLines: Record<string, string>[];

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  workspaceId = await ensureWorkspace(pool, user);
  ciphertext = await addConnection(connection, "98765");
  logLines = [];
  for (const method of ["log", "warn", "error"] as const)
    mock.method(console, method, (line: string) => logLines.push(JSON.parse(line) as Record<string, string>));
});
afterEach(() => {
  mock.restoreAll();
});
after(async () => {
  await pool.end();
});

// An active connection whose token is valid for 30 more days; the token's plaintext is token-<account>.
async function addConnection(id: string, account: string, columns = "", values: unknown[] = []): Promise<string> {
  const encrypted = sealSecret(`token-${account}`, key, `${workspaceId}:${account}`);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at${columns})
     VALUES($1,$2,$3,true,$4,now()+interval '30 days'${values.map((_, index) => `,$${index + 5}`).join("")})`,
    [id, workspaceId, account, encrypted, ...values],
  );
  return encrypted;
}

async function record(id = connection) {
  return (
    await pool.query(
      `SELECT subscription_check_attempted_at,subscription_checked_at,subscription_missing_at,
         subscription_token_obtained_at=token_obtained_at AS same_token,reauth_reason
       FROM instagram_connections WHERE id=$1`,
      [id],
    )
  ).rows[0];
}

// A Meta stand-in: me answers the token's own account, subscribed_apps answers fields. Either can be replaced.
function meta(
  fields: string[] | (() => Response | Promise<Response>) = ["comments", "messages", "messaging_postbacks"],
  me?: () => Response | Promise<Response>,
) {
  const accounts: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(input));
    assert.equal(target.hostname, "graph.instagram.com");
    const account = new Headers(init?.headers).get("Authorization")!.replace("Bearer token-", "");
    if (target.pathname === "/v26.0/me") {
      accounts.push(account);
      return me ? me() : Response.json({ user_id: account });
    }
    assert.equal(target.pathname, `/v26.0/${account}/subscribed_apps`);
    return typeof fields === "function"
      ? fields()
      : Response.json({ data: [{ id: "app", subscribed_fields: fields }] });
  }) as typeof fetch;
  return { fetchImpl, accounts };
}
const missing = ["comments", "messages"];

const run = (fetchImpl: typeof fetch, now = new Date()) =>
  checkDueInstagramSubscriptions(pool, key, fetchImpl, now, "v26.0", correlationId);

test("the cron claims only eligible connections, longest-unchecked first, at most two per run", async () => {
  const hours = (count: number) => new Date(Date.now() - count * 3600_000);
  await addConnection("10000000-0000-4000-8000-000000000001", "1", ",subscription_check_attempted_at", [hours(7)]);
  await addConnection("10000000-0000-4000-8000-000000000002", "2", ",subscription_check_attempted_at", [hours(1)]);
  await addConnection("10000000-0000-4000-8000-000000000003", "3");
  await addConnection("10000000-0000-4000-8000-000000000004", "4", ",deauthorized_at", [new Date()]);
  await addConnection("10000000-0000-4000-8000-000000000005", "5", ",subscription_check_attempted_at", [hours(9)]);
  await addConnection("10000000-0000-4000-8000-000000000006", "6");
  await addConnection("10000000-0000-4000-8000-000000000007", "7");
  await pool.query(
    "UPDATE instagram_connections SET access_token_encrypted=NULL,token_expires_at=NULL WHERE account_id='6'",
  );
  await pool.query("UPDATE instagram_connections SET token_expires_at=now()-interval '1 second' WHERE account_id='7'");
  await pool.query("UPDATE instagram_connections SET active=false WHERE account_id='3'");
  const provider = meta();
  // Never attempted first (the fixture, 33333333-...), then the oldest attempt (9 hours, then 7 hours).
  assert.deepEqual(await run(provider.fetchImpl), { checked: 2, failed: 0 });
  assert.deepEqual(provider.accounts, ["98765", "5"]);
  assert.deepEqual(await run(provider.fetchImpl), { checked: 1, failed: 0 });
  assert.deepEqual(await run(provider.fetchImpl), { checked: 0, failed: 0 });
  assert.deepEqual(provider.accounts, ["98765", "5", "1"]);
  for (const account of ["2", "3", "4", "6", "7"])
    assert.equal(
      (
        await pool.query(
          "SELECT subscription_checked_at FROM instagram_connections WHERE account_id=$1 AND subscription_checked_at IS NOT NULL",
          [account],
        )
      ).rowCount,
      0,
      account,
    );
});

test("a connection is attempted at most once every six hours, also after a transient failure", async () => {
  const start = new Date(Date.now() - 7 * 3600_000);
  const unavailable = meta(undefined, () => new Response("down", { status: 503 }));
  assert.deepEqual(await run(unavailable.fetchImpl, start), { checked: 1, failed: 0 });
  assert.deepEqual(await record(), {
    subscription_check_attempted_at: start,
    subscription_checked_at: null,
    subscription_missing_at: null,
    same_token: null,
    reauth_reason: null,
  });
  assert.deepEqual(await run(unavailable.fetchImpl, new Date(start.getTime() + 6 * 3600_000 - 1000)), {
    checked: 0,
    failed: 0,
  });
  assert.equal(unavailable.accounts.length, 1);
  const later = new Date(start.getTime() + 6 * 3600_000);
  assert.deepEqual(await run(meta().fetchImpl, later), { checked: 1, failed: 0 });
  assert.deepEqual((await record()).subscription_check_attempted_at, later);
  assert.notEqual((await record()).subscription_checked_at, null);
  assert.deepEqual(logLines, []);
});

test("a lost subscription keeps its first time for the same token, a present result clears it, and each change is logged once", async () => {
  const setDue = () => pool.query("UPDATE instagram_connections SET subscription_check_attempted_at=NULL");
  const checkedAtMicros = async () =>
    BigInt(
      (
        await pool.query<{ microseconds: string }>(
          "SELECT (extract(epoch FROM subscription_checked_at)*1000000)::bigint::text AS microseconds FROM instagram_connections WHERE id=$1",
          [connection],
        )
      ).rows[0]!.microseconds,
    );
  await run(meta(missing).fetchImpl);
  const first = await record();
  const firstCheckedAt = await checkedAtMicros();
  assert.notEqual(first.subscription_missing_at, null);
  assert.deepEqual(first.subscription_checked_at, first.subscription_missing_at);
  assert.equal(first.same_token, true);
  let [listed] = await listConnections(pool, user);
  assert.deepEqual(listed.subscription_missing_at, first.subscription_missing_at);
  assert.deepEqual(listed.subscription_checked_at, first.subscription_checked_at);
  assert.deepEqual(logLines, [
    {
      event: "instagram_subscription_check",
      code: "subscription_lost",
      correlation_id: correlationId,
      connection_id: connection,
    },
  ]);
  await setDue();
  await run(meta(missing).fetchImpl);
  const second = await record();
  const secondCheckedAt = await checkedAtMicros();
  assert.deepEqual(second.subscription_missing_at, first.subscription_missing_at);
  assert.ok(secondCheckedAt > firstCheckedAt);
  assert.equal(logLines.length, 1);
  await setDue();
  await run(meta().fetchImpl);
  const restored = await record();
  assert.equal(restored.subscription_missing_at, null);
  assert.ok((await checkedAtMicros()) > secondCheckedAt);
  [listed] = await listConnections(pool, user);
  assert.equal(listed.subscription_missing_at, null);
  assert.deepEqual(listed.subscription_checked_at, restored.subscription_checked_at);
  await setDue();
  await run(meta().fetchImpl);
  assert.deepEqual(logLines.slice(1), [
    {
      event: "instagram_subscription_check",
      code: "subscription_restored",
      correlation_id: correlationId,
      connection_id: connection,
    },
  ]);
  // A loss after the restore is a new loss with a new time.
  await setDue();
  await run(meta(missing).fetchImpl);
  assert.ok((await record()).subscription_missing_at > first.subscription_missing_at);
  assert.equal(logLines.length, 3);
});

test("a result for a replaced token writes nothing, and the list hides a record for an older token", async () => {
  const replacement = sealSecret("token-98765", key, `${workspaceId}:98765`);
  const racing = meta(missing, async () => {
    await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2,token_obtained_at=now() WHERE id=$1", [
      connection,
      replacement,
    ]);
    return Response.json({ error: { code: 190 } }, { status: 400 });
  });
  assert.deepEqual(await run(racing.fetchImpl), { checked: 1, failed: 0 });
  // Neither the loss nor the rejection of the old token reaches the new one.
  assert.deepEqual(
    { ...(await record()), subscription_check_attempted_at: undefined },
    {
      subscription_check_attempted_at: undefined,
      subscription_checked_at: null,
      subscription_missing_at: null,
      same_token: null,
      reauth_reason: null,
    },
  );
  const lateMissing = meta(missing, async () => {
    await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [
      connection,
      sealSecret("token-98765", key, `${workspaceId}:98765`),
    ]);
    return Response.json({ user_id: "98765" });
  });
  await pool.query("UPDATE instagram_connections SET subscription_check_attempted_at=NULL");
  await run(lateMissing.fetchImpl);
  assert.equal((await record()).subscription_missing_at, null);
  assert.deepEqual(logLines, []);
  // A record for the stored token is listed until a refresh stores a token obtained later.
  await pool.query("UPDATE instagram_connections SET subscription_check_attempted_at=NULL");
  await run(meta(missing).fetchImpl);
  assert.notEqual((await listConnections(pool, user))[0].subscription_missing_at, null);
  await pool.query("UPDATE instagram_connections SET token_obtained_at=token_obtained_at+interval '1 second'");
  const [listed] = await listConnections(pool, user);
  assert.equal(listed.subscription_missing_at, null);
  assert.equal(listed.subscription_checked_at, null);
  // The next loss for the new token records its own first time.
  const before = (await record()).subscription_missing_at;
  await pool.query("UPDATE instagram_connections SET subscription_check_attempted_at=NULL");
  await run(meta(missing).fetchImpl);
  assert.ok((await record()).subscription_missing_at > before);
  assert.equal((await record()).same_token, true);
});

test("a Meta rejection records the reconnect marker and leaves the subscription record; an accepted identity clears it", async () => {
  await run(meta(missing).fetchImpl);
  const lost = await record();
  const due = () => pool.query("UPDATE instagram_connections SET subscription_check_attempted_at=NULL");
  await due();
  await run(meta(missing, () => new Response("denied", { status: 401 })).fetchImpl);
  assert.deepEqual(
    { ...(await record()), subscription_check_attempted_at: undefined },
    { ...lost, subscription_check_attempted_at: undefined, reauth_reason: "token_rejected" },
  );
  assert.equal((await listConnections(pool, user))[0].reauth_reason, "token_rejected");
  // A mismatch or a transient read of me leaves the marker; only an identity Meta accepted clears it.
  for (const me of [() => Response.json({ user_id: "other" }), () => new Response("busy", { status: 429 })]) {
    await due();
    await run(meta(missing, me).fetchImpl);
    assert.equal((await record()).reauth_reason, "token_rejected");
  }
  await due();
  await run(meta(() => new Response("down", { status: 503 })).fetchImpl);
  assert.deepEqual(
    { ...(await record()), subscription_check_attempted_at: undefined },
    { ...lost, subscription_check_attempted_at: undefined },
  );
  // A rejection of subscribed_apps after an accepted identity is a rejection too.
  await due();
  await run(meta(() => Response.json({ error: { code: 10 } }, { status: 403 })).fetchImpl);
  assert.equal((await record()).reauth_reason, "token_rejected");
  assert.deepEqual((await record()).subscription_missing_at, lost.subscription_missing_at);
});

test("an accepted identity keeps a refresh_rejected marker and its first time", async () => {
  const rejectedAt = new Date("2026-10-11T00:00:00Z");
  await pool.query(
    `UPDATE instagram_connections SET reauth_required_at=$2,reauth_reason='refresh_rejected',
       reauth_token_obtained_at=token_obtained_at WHERE id=$1`,
    [connection, rejectedAt],
  );
  const marker = async () =>
    (
      await pool.query(
        `SELECT reauth_required_at,reauth_reason,reauth_token_obtained_at=token_obtained_at AS same_token
         FROM instagram_connections WHERE id=$1`,
        [connection],
      )
    ).rows[0];
  assert.equal((await run(meta().fetchImpl)).checked, 1);
  assert.deepEqual(await marker(), {
    reauth_required_at: rejectedAt,
    reauth_reason: "refresh_rejected",
    same_token: true,
  });
  assert.equal((await record()).subscription_missing_at, null);
  assert.notEqual((await record()).subscription_checked_at, null);
  const response = await connectionHealth(pool, user, connection, env, meta(missing).fetchImpl);
  assert.equal(response.status, "fields_missing");
  assert.deepEqual(await marker(), {
    reauth_required_at: rejectedAt,
    reauth_reason: "refresh_rejected",
    same_token: true,
  });
});

test("missing configuration fails before any claim, and a token that does not decrypt counts as a failure", async () => {
  const provider = meta();
  await assert.rejects(
    checkDueInstagramSubscriptions(pool, undefined, provider.fetchImpl, new Date(), "v26.0"),
    ConfigurationError,
  );
  for (const version of [undefined, "26.0", "v26"])
    await assert.rejects(
      checkDueInstagramSubscriptions(pool, key, provider.fetchImpl, new Date(), version),
      ConfigurationError,
    );
  await assert.rejects(
    checkDueInstagramSubscriptions(pool, "short", provider.fetchImpl, new Date(), "v26.0"),
    ConfigurationError,
  );
  assert.equal((await record()).subscription_check_attempted_at, null);
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [
    connection,
    sealSecret("token-98765", key, "another-context"),
  ]);
  assert.deepEqual(await run(provider.fetchImpl), { checked: 1, failed: 1 });
  assert.notEqual((await record()).subscription_check_attempted_at, null);
  assert.deepEqual(provider.accounts, []);
});

async function authorization() {
  const response = await beginInstagramOAuth(pool, user, env);
  const state = new URL(((await response.json()) as { url: string }).url).searchParams.get("state")!;
  return new Request(`https://app.test/api/instagram/callback?state=${state}&code=test-code`, {
    headers: { cookie: `__Host-ac-oauth=${state}` },
  });
}

test("an OAuth reconnect, a disconnect and a deauthorize callback clear the subscription record", async () => {
  const columns = () =>
    pool.query(
      `SELECT subscription_check_attempted_at,subscription_checked_at,subscription_missing_at,subscription_token_obtained_at
       FROM instagram_connections WHERE id=$1`,
      [connection],
    );
  const cleared = {
    subscription_check_attempted_at: null,
    subscription_checked_at: null,
    subscription_missing_at: null,
    subscription_token_obtained_at: null,
  };
  const oauth: typeof fetch = async (input) => {
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
  await run(meta(missing).fetchImpl);
  assert.equal((await finishInstagramOAuth(pool, user, await authorization(), env, oauth)).status, 303);
  assert.deepEqual((await columns()).rows, [cleared]);
  // The new token is due at once.
  const provider = meta(missing);
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [connection, ciphertext]);
  await run(provider.fetchImpl);
  assert.deepEqual(provider.accounts, ["98765"]);
  await disconnectConnection(pool, user, connection);
  assert.deepEqual((await columns()).rows, [cleared]);
  await pool.query(
    "UPDATE instagram_connections SET active=true,access_token_encrypted=$2,token_expires_at=now()+interval '30 days' WHERE id=$1",
    [connection, ciphertext],
  );
  await run(meta(missing).fetchImpl);
  assert.notEqual((await record()).subscription_missing_at, null);
  assert.deepEqual(await deauthorizeInstagramUser(pool, { userId: "98765", issuedAt: null }), {
    disconnected: [connection],
    skipped: [],
  });
  assert.deepEqual((await columns()).rows, [cleared]);
});

test("the manual check writes the same record and attempt time, and keeps its response statuses", async () => {
  // The attempt time is the database clock; a minute of margin covers a container clock.
  const before = new Date(Date.now() - 60_000);
  const result = await connectionHealth(pool, user, connection, env, meta(missing).fetchImpl, correlationId);
  assert.equal(result.status, "fields_missing");
  const manual = await record();
  assert.ok(manual.subscription_check_attempted_at >= before);
  assert.notEqual(manual.subscription_missing_at, null);
  assert.equal(manual.same_token, true);
  assert.deepEqual(logLines, [
    {
      event: "instagram_subscription_check",
      code: "subscription_lost",
      correlation_id: correlationId,
      connection_id: connection,
    },
  ]);
  // The cron then waits a full interval for this token.
  assert.deepEqual(await run(meta().fetchImpl), { checked: 0, failed: 0 });
  // A mismatch stays reconnect_required without a marker; a Meta rejection records one.
  assert.equal(
    (
      await connectionHealth(
        pool,
        user,
        connection,
        env,
        meta(missing, () => Response.json({ user_id: "1" })).fetchImpl,
      )
    ).status,
    "reconnect_required",
  );
  assert.equal((await record()).reauth_reason, null);
  assert.equal(
    (
      await connectionHealth(
        pool,
        user,
        connection,
        env,
        meta(missing, () => Response.json({ error: { code: 190 } }, { status: 400 })).fetchImpl,
      )
    ).status,
    "reconnect_required",
  );
  assert.equal((await record()).reauth_reason, "token_rejected");
  assert.equal((await connectionHealth(pool, user, connection, env, meta().fetchImpl)).status, "fields_present");
  assert.deepEqual(
    { ...(await record()), subscription_check_attempted_at: undefined, subscription_checked_at: undefined },
    {
      subscription_check_attempted_at: undefined,
      subscription_checked_at: undefined,
      subscription_missing_at: null,
      same_token: true,
      reauth_reason: null,
    },
  );
});

test("a failed record write never changes the manual response and is logged with a fixed code", async () => {
  const originalQuery = Pool.prototype.query;
  mock.method(pool, "query", async function (this: Pool, sql: string, values?: unknown[]) {
    if (typeof sql === "string" && /subscription_check_attempted_at=clock|subscription_checked_at=now_/.test(sql))
      throw Object.assign(new Error("write failed for token-98765"), { code: "40001" });
    return Reflect.apply(originalQuery, this, [sql, values]);
  });
  const result = await connectionHealth(pool, user, connection, env, meta(missing).fetchImpl, correlationId);
  assert.equal(result.status, "fields_missing");
  assert.deepEqual(
    logLines,
    [1, 2].map(() => ({
      event: "subscription_record_failed",
      code: "database_error",
      correlation_id: correlationId,
      connection_id: connection,
    })),
  );
  mock.restoreAll();
  assert.equal((await record()).subscription_check_attempted_at, null);
  assert.equal((await record()).subscription_missing_at, null);
});

// Security audit #62, third pass: the manual check is a GET that writes, so its ownership read is what keeps another
// workspace from spending this token's Meta calls or moving this connection's record and marker.
test("another workspace or a user without one cannot run the manual check on this connection", async () => {
  const other = { id: "22222222-2222-4222-8222-222222222222", email: "other@example.test" };
  const stranger = { id: "44444444-4444-4444-8444-444444444444", email: "stranger@example.test" };
  await ensureWorkspace(pool, other);
  const before = (await pool.query("SELECT * FROM instagram_connections ORDER BY id")).rows;
  const graph = meta(() => Response.json({ error: { code: 190 } }, { status: 400 }));
  await assert.rejects(connectionHealth(pool, other, connection, env, graph.fetchImpl, correlationId), {
    status: 404,
    message: "connection_not_found",
  });
  await assert.rejects(connectionHealth(pool, stranger, connection, env, graph.fetchImpl, correlationId), {
    status: 403,
    message: "workspace_required",
  });
  assert.deepEqual(graph.accounts, []);
  assert.deepEqual((await pool.query("SELECT * FROM instagram_connections ORDER BY id")).rows, before);
  assert.deepEqual(logLines, []);
});
