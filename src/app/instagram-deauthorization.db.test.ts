import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { deauthorizeInstagramUser } from "./instagram-deauthorization.ts";
import { disconnectConnection, ensureWorkspace, listConnections } from "./settings.ts";

const url = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: url.toString() });
const user = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const other = { id: "22222222-2222-4222-8222-222222222222", email: "other@example.test" };
const first = "33333333-3333-4333-8333-333333333333";
const second = "44444444-4444-4444-8444-444444444444";
let workspaceId: string;
let otherWorkspaceId: string;

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  workspaceId = await ensureWorkspace(pool, user);
  otherWorkspaceId = await ensureWorkspace(pool, other);
});
after(async () => {
  await pool.end();
});

// A connected account with a reconnect marker, an enabled comment rule and an enabled flow that triggers on it.
async function connected(id: string, workspace: string, accountId: string, instagramUserId: string | null) {
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,instagram_user_id,active,send_enabled,inbox_enabled,
       access_token_encrypted,token_expires_at,token_obtained_at,reauth_required_at,reauth_reason,reauth_token_obtained_at)
     VALUES($1,$2,$3,$4,true,true,true,'encrypted-test',now()+interval '30 days',now()-interval '1 day',now(),'token_rejected',now()-interval '1 day')`,
    [id, workspace, accountId, instagramUserId],
  );
  await pool.query(
    "INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled) VALUES(gen_random_uuid(),$1,$2,'1001','hello','reply',true)",
    [workspace, id],
  );
  const flow = (
    await pool.query("INSERT INTO flows(workspace_id,name,draft) VALUES($1,'flow','{}') RETURNING id", [workspace])
  ).rows[0].id;
  const version = (
    await pool.query(
      `INSERT INTO flow_versions(flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,published_by)
       VALUES($1,$2,1,0,'{}',$3,'2002',$4) RETURNING id`,
      [flow, workspace, id, user.id],
    )
  ).rows[0].id;
  await pool.query("UPDATE flows SET published_version_id=$2,enabled=true WHERE id=$1", [flow, version]);
}

// A verified request issued now; the fixture's token was obtained a day earlier.
const request = (userId: string, issuedAt: number | null = Math.floor(Date.now() / 1000)) => ({ userId, issuedAt });
const epochSeconds = async (sql: string, id: string) =>
  Number(
    (
      await pool.query(`SELECT floor(extract(epoch FROM ${sql}))::bigint AS s FROM instagram_connections WHERE id=$1`, [
        id,
      ])
    ).rows[0].s,
  );

async function state(id: string) {
  return (
    await pool.query(
      `SELECT c.active,c.send_enabled,c.access_token_encrypted,c.token_expires_at,c.reauth_required_at,c.reauth_reason,
         c.reauth_token_obtained_at,c.deauthorized_at IS NOT NULL AS deauthorized,
         (SELECT bool_or(enabled) FROM instagram_comment_rules WHERE connection_id=c.id) AS rule_enabled,
         (SELECT bool_or(f.enabled) FROM flows f JOIN flow_versions v ON v.id=f.published_version_id WHERE v.trigger_connection_id=c.id) AS flow_enabled
       FROM instagram_connections c WHERE c.id=$1`,
      [id],
    )
  ).rows[0];
}
const disconnectedState = {
  active: false,
  send_enabled: false,
  access_token_encrypted: null,
  token_expires_at: null,
  reauth_required_at: null,
  reauth_reason: null,
  reauth_token_obtained_at: null,
  deauthorized: true,
  rule_enabled: false,
  flow_enabled: false,
};
async function everything() {
  return {
    connections: (await pool.query("SELECT * FROM instagram_connections ORDER BY id")).rows,
    rules: (await pool.query("SELECT * FROM instagram_comment_rules ORDER BY id")).rows,
    flows: (await pool.query("SELECT * FROM flows ORDER BY id")).rows,
  };
}

test("a callback matching account_id disconnects like the settings screen and records the time", async () => {
  await connected(first, workspaceId, "98765", null);
  await connected(second, otherWorkspaceId, "55555", null);
  const untouched = await state(second);
  const startedAt = (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now;
  assert.deepEqual(await deauthorizeInstagramUser(pool, request("98765")), { disconnected: [first], skipped: [] });
  assert.deepEqual(await state(first), disconnectedState);
  assert.deepEqual(await state(second), untouched);
  const [listed] = await listConnections(pool, user);
  assert.ok(listed.deauthorized_at >= startedAt && listed.deauthorized_at <= new Date());
  assert.equal(listed.credential_status, "missing");
  assert.equal((await listConnections(pool, other))[0].deauthorized_at, null);
});

test("a callback matches the stored app-scoped user ID too, in every workspace and in ID order", async () => {
  // The first connection matches by instagram_user_id, the second (another workspace) by account_id.
  await connected(second, otherWorkspaceId, "17841400000000001", null);
  await connected(first, workspaceId, "98765", "17841400000000001");
  assert.deepEqual(await deauthorizeInstagramUser(pool, request("17841400000000001")), {
    disconnected: [first, second],
    skipped: [],
  });
  assert.deepEqual(await state(first), disconnectedState);
  assert.deepEqual(await state(second), disconnectedState);
});

test("a callback that matches no connection changes nothing", async () => {
  await connected(first, workspaceId, "98765", "12345");
  const before = await everything();
  assert.deepEqual(await deauthorizeInstagramUser(pool, request("424242")), { disconnected: [], skipped: [] });
  assert.deepEqual(await everything(), before);
});

test("an already disconnected connection still records the callback, and a manual disconnect clears it", async () => {
  await connected(first, workspaceId, "98765", null);
  await disconnectConnection(pool, user, first);
  assert.equal((await state(first)).deauthorized, false);
  assert.deepEqual(await deauthorizeInstagramUser(pool, request("98765")), { disconnected: [first], skipped: [] });
  assert.deepEqual(await state(first), disconnectedState);
  await disconnectConnection(pool, user, first);
  assert.deepEqual(await state(first), { ...disconnectedState, deauthorized: false });
  assert.equal((await listConnections(pool, user))[0].deauthorized_at, null);
});

test("a callback issued before the stored token was obtained changes nothing", async () => {
  await connected(first, workspaceId, "98765", null);
  const before = await everything();
  const obtained = await epochSeconds("token_obtained_at", first);
  assert.deepEqual(await deauthorizeInstagramUser(pool, request("98765", obtained - 1)), {
    disconnected: [],
    skipped: [first],
  });
  assert.deepEqual(await everything(), before);
  // issued_at is whole seconds, so a request issued in the second the token was obtained still disconnects.
  assert.deepEqual(await deauthorizeInstagramUser(pool, request("98765", obtained)), {
    disconnected: [first],
    skipped: [],
  });
  assert.deepEqual(await state(first), disconnectedState);
});

test("a delayed or replayed callback cannot undo a reconnect that followed it", async () => {
  await connected(first, workspaceId, "98765", "12345");
  const issued = (await epochSeconds("token_obtained_at", first)) + 60;
  assert.deepEqual(await deauthorizeInstagramUser(pool, request("12345", issued)), {
    disconnected: [first],
    skipped: [],
  });
  // The owner reconnects later, as the OAuth upsert does: a new token, deauthorized_at cleared.
  await pool.query(
    `UPDATE instagram_connections SET active=true,send_enabled=true,access_token_encrypted='encrypted-new',
       token_expires_at=now()+interval '60 days',token_obtained_at=to_timestamp($2::bigint+1),deauthorized_at=NULL
     WHERE id=$1`,
    [first, issued],
  );
  await pool.query("UPDATE instagram_comment_rules SET enabled=true WHERE connection_id=$1", [first]);
  const before = await everything();
  assert.deepEqual(await deauthorizeInstagramUser(pool, request("12345", issued)), {
    disconnected: [],
    skipped: [first],
  });
  assert.deepEqual(await everything(), before);
  // Without issued_at the request cannot be dated, so it still disconnects.
  assert.deepEqual(await deauthorizeInstagramUser(pool, request("12345", null)), {
    disconnected: [first],
    skipped: [],
  });
});
