import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { refreshDueInstagramTokensWithFailures } from "./instagram-token-refresh.ts";
import { clearReauthRequired, markReauthRequired } from "./instagram-reauth.ts";
import { disconnectConnection, ensureWorkspace, listConnections } from "./settings.ts";
import { sealSecret } from "./secrets.ts";

const url = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: url.toString() });
const user = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const key = Buffer.alloc(32, 7).toString("base64");
const connection = "33333333-3333-4333-8333-333333333333";
let workspaceId: string;
let context: string;
let oldCiphertext: string;

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  workspaceId = await ensureWorkspace(pool, user);
  context = `${workspaceId}:98765`;
  oldCiphertext = sealSecret("old-token", key, context);
  // Due for refresh: valid for 20 more days and obtained five days ago.
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at,token_obtained_at) VALUES($1,$2,'98765',true,$3,now()+interval '20 days',now()-interval '5 days')",
    [connection, workspaceId, oldCiphertext],
  );
});
after(async () => {
  await pool.end();
});

async function marker() {
  return (
    await pool.query(
      "SELECT reauth_required_at,reauth_reason,reauth_token_obtained_at=token_obtained_at AS same_token FROM instagram_connections WHERE id=$1",
      [connection],
    )
  ).rows[0];
}

test("a rejected refresh call records refresh_rejected for the stored token, and the list shows it", async () => {
  const now = new Date(Date.now() - 1000);
  const rejected: typeof fetch = async () =>
    Response.json({ error: { code: 190, message: "Invalid OAuth access token" } }, { status: 400 });
  // A rejection is still a failed refresh, and the old token is kept.
  assert.deepEqual(await refreshDueInstagramTokensWithFailures(pool, key, rejected, now), { refreshed: 0, failed: 1 });
  assert.deepEqual(await marker(), { reauth_required_at: now, reauth_reason: "refresh_rejected", same_token: true });
  const [listed] = await listConnections(pool, user);
  assert.equal(listed.reauth_reason, "refresh_rejected");
  assert.deepEqual(listed.reauth_required_at, now);
  assert.equal(listed.credential_status, "valid");
  assert.equal(
    (await pool.query("SELECT access_token_encrypted FROM instagram_connections WHERE id=$1", [connection])).rows[0]
      .access_token_encrypted,
    oldCiphertext,
  );
});

test("transient refresh failures and a rejection of the unstored new token record nothing", async () => {
  const failures: Array<[string, typeof fetch]> = [
    ["throttle", async () => Response.json({ error: { code: 4 } }, { status: 400 })],
    ["transient", async () => Response.json({ error: { code: 2, is_transient: true } }, { status: 400 })],
    ["429", async () => Response.json({ error: { code: 190 } }, { status: 429 })],
    ["5xx", async () => Response.json({ error: { code: 190 } }, { status: 500 })],
    ["network", async () => Promise.reject(new TypeError("fetch failed"))],
    ["invalid body", async () => new Response("not json", { status: 200 })],
    // The refresh succeeds but Meta rejects the returned token's profile read: that token is never stored.
    [
      "profile",
      async (input) =>
        String(input).includes("refresh_access_token")
          ? Response.json({ access_token: "new-token", expires_in: 5_184_000 })
          : Response.json({ error: { code: 190 } }, { status: 401 }),
    ],
  ];
  let now = Date.now() - 8 * 86400_000;
  for (const [label, provider] of failures) {
    // Each attempt runs a day after the last, so the connection is claimed again.
    now += 86400_001;
    await pool.query(
      "UPDATE instagram_connections SET token_obtained_at=$2::timestamptz-interval '2 days' WHERE id=$1",
      [connection, new Date(now)],
    );
    assert.deepEqual(
      await refreshDueInstagramTokensWithFailures(pool, key, provider, new Date(now)),
      { refreshed: 0, failed: 1 },
      label,
    );
    assert.deepEqual(await marker(), { reauth_required_at: null, reauth_reason: null, same_token: null }, label);
  }
});

test("a rejection of a token replaced during the refresh call does not mark the new token", async () => {
  const replacement = sealSecret("reconnected-token", key, context);
  const racing: typeof fetch = async () => {
    await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2,token_obtained_at=now() WHERE id=$1", [
      connection,
      replacement,
    ]);
    return Response.json({ error: { code: 190 } }, { status: 400 });
  };
  assert.deepEqual(await refreshDueInstagramTokensWithFailures(pool, key, racing), { refreshed: 0, failed: 1 });
  assert.deepEqual(await marker(), { reauth_required_at: null, reauth_reason: null, same_token: null });
  // The same holds for a pre-send rejection read with the old ciphertext.
  assert.equal(await markReauthRequired(pool, connection, oldCiphertext, "token_rejected"), false);
  assert.deepEqual(await marker(), { reauth_required_at: null, reauth_reason: null, same_token: null });
});

test("a later successful refresh of the same token clears the marker", async () => {
  const first = new Date(Date.now() - 2 * 86400_000);
  await refreshDueInstagramTokensWithFailures(
    pool,
    key,
    async () => Response.json({ error: { code: 190 } }, { status: 400 }),
    first,
  );
  assert.equal((await marker()).reauth_reason, "refresh_rejected");
  const later = new Date(first.getTime() + 86400_001);
  const renewed: typeof fetch = async (input) =>
    String(input).includes("refresh_access_token")
      ? Response.json({ access_token: "new-token", expires_in: 5_184_000 })
      : Response.json({ user_id: "98765" });
  assert.deepEqual(await refreshDueInstagramTokensWithFailures(pool, key, renewed, later), { refreshed: 1, failed: 0 });
  assert.deepEqual(await marker(), { reauth_required_at: null, reauth_reason: null, same_token: null });
  assert.equal((await listConnections(pool, user))[0].reauth_reason, null);
});

test("a marker keeps its first time, clears only with the same token, and is hidden once the token changes", async () => {
  const first = new Date(Date.now() - 60_000);
  assert.equal(await markReauthRequired(pool, connection, oldCiphertext, "refresh_rejected", first), true);
  // A second rejection of the same token keeps the first time and reason.
  assert.equal(await markReauthRequired(pool, connection, oldCiphertext, "token_rejected"), false);
  assert.deepEqual(await marker(), { reauth_required_at: first, reauth_reason: "refresh_rejected", same_token: true });
  // A success read with another token does not clear it.
  assert.equal(await clearReauthRequired(pool, connection, sealSecret("other", key, context)), false);
  assert.equal((await marker()).reauth_reason, "refresh_rejected");
  assert.equal(await clearReauthRequired(pool, connection, oldCiphertext), true);
  assert.deepEqual(await marker(), { reauth_required_at: null, reauth_reason: null, same_token: null });
  // A token stored by a path that does not clear the marker hides it from the list.
  await markReauthRequired(pool, connection, oldCiphertext, "token_rejected");
  await pool.query("UPDATE instagram_connections SET token_obtained_at=now() WHERE id=$1", [connection]);
  const [listed] = await listConnections(pool, user);
  assert.equal(listed.reauth_reason, null);
  assert.equal(listed.reauth_required_at, null);
});

test("disconnecting clears the marker with the token", async () => {
  await markReauthRequired(pool, connection, oldCiphertext, "token_rejected");
  assert.equal((await listConnections(pool, user))[0].reauth_reason, "token_rejected");
  await disconnectConnection(pool, user, connection);
  assert.deepEqual(await marker(), { reauth_required_at: null, reauth_reason: null, same_token: null });
  const [listed] = await listConnections(pool, user);
  assert.equal(listed.credential_status, "missing");
  assert.equal(listed.reauth_reason, null);
});

test("the marker columns are all set or all null and the reason is a fixed code", async () => {
  const partial = [
    "reauth_required_at=now()",
    "reauth_reason='token_rejected'",
    "reauth_token_obtained_at=token_obtained_at",
    "reauth_required_at=now(),reauth_reason='token_rejected'",
    "reauth_reason='token_rejected',reauth_token_obtained_at=token_obtained_at",
  ];
  for (const assignment of partial)
    await assert.rejects(
      pool.query(`UPDATE instagram_connections SET ${assignment} WHERE id=$1`, [connection]),
      /instagram_connections_reauth_marker/,
      assignment,
    );
  await assert.rejects(
    pool.query(
      "UPDATE instagram_connections SET reauth_required_at=now(),reauth_reason='revoked',reauth_token_obtained_at=token_obtained_at WHERE id=$1",
      [connection],
    ),
    /instagram_connections_reauth_reason/,
  );
});
