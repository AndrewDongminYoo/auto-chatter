import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { EXPORTED_TABLES } from "./workspace-export.ts";
import { seedWorkspace } from "./workspace-fixture.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const operatorId = "99999999-9999-4999-8999-999999999990";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const connectionId = "55555555-5555-4555-8555-555555555555";
const foreignConnectionId = "77777777-7777-4777-8777-777777777777";

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces, workspace_deletion_records CASCADE");
  await seedWorkspace(pool, workspaceId, userId, connectionId, "account-own");
  await seedWorkspace(pool, otherWorkspaceId, otherUserId, foreignConnectionId, "account-foreign");
  // Disconnected, as the deletion requires; the other workspace stays connected.
  await pool.query(
    "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
    [connectionId],
  );
});

after(async () => pool.end());

async function counts(workspace: string, connection: string) {
  const result: Record<string, number> = {};
  for (const [table, { scope }] of Object.entries(EXPORTED_TABLES)) {
    const [column, value] = scope === "workspace" ? ["workspace_id", workspace] : ["connection_id", connection];
    result[table] = Number(
      (await pool.query(`SELECT count(*) FROM ${table} WHERE ${column}=$1`, [value])).rows[0].count,
    );
  }
  for (const table of ["workspaces", "instagram_oauth_states"]) {
    const column = table === "workspaces" ? "id" : "workspace_id";
    result[table] = Number(
      (await pool.query(`SELECT count(*) FROM ${table} WHERE ${column}=$1`, [workspace])).rows[0].count,
    );
  }
  return result;
}

function deleteWorkspace(workspace = workspaceId) {
  return pool.query<{ result: Record<string, unknown> }>("SELECT public.delete_workspace_data($1,$2) AS result", [
    workspace,
    operatorId,
  ]);
}

test("deletes every record of the workspace, including opt-outs, and leaves other workspaces intact", async () => {
  const before = await counts(workspaceId, connectionId);
  assert.ok(
    Object.values(before).every((count) => count > 0),
    "every table must be seeded for the workspace",
  );
  const foreignBefore = await counts(otherWorkspaceId, foreignConnectionId);

  const { result } = (await deleteWorkspace()).rows[0]!;

  assert.deepEqual(
    Object.entries(await counts(workspaceId, connectionId)).filter(([, count]) => count > 0),
    [],
  );
  assert.deepEqual(await counts(otherWorkspaceId, foreignConnectionId), foreignBefore);
  assert.deepEqual(result.member_user_ids, [userId]);
  const deleted = result.deleted_counts as Record<string, number>;
  for (const [table, count] of Object.entries(before)) {
    if (table === "workspaces") continue;
    assert.equal(deleted[table], count, `${table} deleted count`);
  }
  const evidence = await pool.query("SELECT * FROM workspace_deletion_records");
  assert.equal(evidence.rowCount, 1);
  assert.equal(evidence.rows[0].workspace_id, workspaceId);
  assert.equal(evidence.rows[0].requested_by, operatorId);
  assert.deepEqual(evidence.rows[0].deleted_counts, deleted);
  assert.doesNotMatch(JSON.stringify(evidence.rows[0]), new RegExp(userId));
  // The Instagram account can be connected again by another workspace.
  await pool.query("INSERT INTO workspaces(id) VALUES(gen_random_uuid())");
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id) SELECT gen_random_uuid(),id,'account-own' FROM workspaces WHERE id<>$1",
    [otherWorkspaceId],
  );
});

test("refuses while a connection is still connected and deletes nothing", async () => {
  for (const change of ["active=true", "send_enabled=true", "access_token_encrypted='ciphertext'"]) {
    await pool.query(`UPDATE instagram_connections SET ${change} WHERE id=$1`, [connectionId]);
    const before = await counts(workspaceId, connectionId);
    await assert.rejects(deleteWorkspace(), { code: "AC002" });
    assert.deepEqual(await counts(workspaceId, connectionId), before);
    await pool.query(
      "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
      [connectionId],
    );
  }
});

test("refuses while any delivery is sending and deletes nothing", async () => {
  for (const [table, column, value] of [
    ["private_reply_outbox", "workspace_id", workspaceId],
    ["instagram_follow_conversations", "connection_id", connectionId],
    ["instagram_manual_replies", "workspace_id", workspaceId],
  ] as const) {
    await pool.query(
      `UPDATE ${table} SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE ${column}=$1`,
      [value],
    );
    const before = await counts(workspaceId, connectionId);
    await assert.rejects(deleteWorkspace(), { code: "AC003" }, table);
    assert.deepEqual(await counts(workspaceId, connectionId), before);
    await pool.query(`UPDATE ${table} SET status='failed',attempt_id=NULL,attempt_started_at=NULL WHERE ${column}=$1`, [
      value,
    ]);
  }
});

test("waits for an uncommitted claim and refuses once it commits as sending", async () => {
  await pool.query("UPDATE private_reply_outbox SET status='pending' WHERE workspace_id=$1", [workspaceId]);
  const claim = await pool.connect();
  try {
    await claim.query("BEGIN");
    await claim.query(
      "UPDATE private_reply_outbox SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE workspace_id=$1",
      [workspaceId],
    );
    const outcome = deleteWorkspace().then(
      () => "deleted",
      (error: { code?: string }) => error.code,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await claim.query("COMMIT");
    assert.equal(await outcome, "AC003");
  } finally {
    claim.release();
  }
  const kept = await pool.query("SELECT status FROM private_reply_outbox WHERE workspace_id=$1", [workspaceId]);
  assert.deepEqual(
    kept.rows.map((row) => row.status),
    ["sending"],
  );
});

test("rejects an unknown workspace and a missing administrator", async () => {
  await assert.rejects(deleteWorkspace("88888888-8888-4888-8888-888888888888"), { code: "AC001" });
  await assert.rejects(pool.query("SELECT public.delete_workspace_data($1,NULL)", [workspaceId]), { code: "AC006" });
  assert.equal(Number((await pool.query("SELECT count(*) FROM workspace_deletion_records")).rows[0].count), 0);
});
