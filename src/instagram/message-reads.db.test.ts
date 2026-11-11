import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { resetTestSchema } from "../test-schema.ts";
import { seedWorkspace } from "../app/workspace-fixture.ts";
import { ingestMessageReads, parseMessageReadEvents, type InstagramMessageRead } from "./message-reads.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const workspaceId = "a1111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "a2222222-2222-4222-8222-222222222222";
const userId = "a3333333-3333-4333-8333-333333333333";
const otherUserId = "a4444444-4444-4444-8444-444444444444";
const connectionId = "a5555555-5555-4555-8555-555555555555";
const otherConnectionId = "a6666666-6666-4666-8666-666666666666";
const operatorId = "a9999999-9999-4999-8999-999999999999";
const account = "17841400000000001";
const otherAccount = "17841400000000002";
const sendTables = ["private_reply_outbox", "instagram_follow_conversations", "instagram_manual_replies", "flow_dm_deliveries", "campaign_deliveries"] as const;
const mid = (table: string, owner: string) => `${table}-mid-${owner}`;

before(async () => {
  await resetTestSchema(pool);
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces, workspace_deletion_records CASCADE");
  for (const [workspace, user, connection, owner] of [
    [workspaceId, userId, connectionId, account],
    [otherWorkspaceId, otherUserId, otherConnectionId, otherAccount],
  ] as const) {
    await seedWorkspace(pool, workspace, user, connection, owner);
    await pool.query("UPDATE instagram_connections SET active=true WHERE id=$1", [connection]);
    // One provider-acknowledged message per send table, each with its own provider message ID.
    await pool.query("UPDATE private_reply_outbox SET provider_message_id=$2 WHERE connection_id=$1 AND status='sent'", [connection, mid("private_reply_outbox", owner)]);
    await pool.query("UPDATE instagram_follow_conversations SET provider_message_id=$2 WHERE connection_id=$1", [connection, mid("instagram_follow_conversations", owner)]);
    await pool.query("UPDATE instagram_manual_replies SET status='sent',provider_message_id=$2,sent_at=now() WHERE connection_id=$1", [connection, mid("instagram_manual_replies", owner)]);
    for (const table of ["flow_dm_deliveries", "campaign_deliveries"])
      await pool.query(
        `UPDATE ${table} SET status='sent',attempt_id=gen_random_uuid(),attempt_started_at=now(),provider_message_id=$2,sent_at=now()
         WHERE connection_id=$1`,
        [connection, mid(table, owner)],
      );
  }
  // The fixture's own read rows are not under test here.
  await pool.query("TRUNCATE instagram_message_reads");
});

after(async () => pool.end());

function read(messageId: string, options: Partial<InstagramMessageRead> = {}): InstagramMessageRead {
  return {
    accountId: account,
    readerId: "900",
    messageId,
    readAt: new Date("2026-11-10T01:00:00.000Z"),
    ...options,
  };
}

async function storedReads() {
  return (
    await pool.query<{
      workspace_id: string;
      connection_id: string;
      recipient_id: string;
      message_id: string;
      read_at: Date;
    }>("SELECT workspace_id,connection_id,recipient_id,message_id,read_at FROM instagram_message_reads ORDER BY message_id,recipient_id")
  ).rows;
}

test("a read of each send table's message is stored once, and the first read time stays", async () => {
  await ingestMessageReads(
    pool,
    sendTables.map((table) => read(mid(table, account))),
  );
  assert.deepEqual(
    await storedReads(),
    sendTables
      .map((table) => ({
        workspace_id: workspaceId,
        connection_id: connectionId,
        recipient_id: "900",
        message_id: mid(table, account),
        read_at: new Date("2026-11-10T01:00:00.000Z"),
      }))
      .sort((left, right) => left.message_id.localeCompare(right.message_id)),
  );
  // A redelivered or repeated event, even with a later time, adds nothing and keeps the first read_at.
  await ingestMessageReads(pool, [read(mid("private_reply_outbox", account), { readAt: new Date("2026-11-10T02:00:00.000Z") }), read(mid("private_reply_outbox", account))]);
  const rows = await storedReads();
  assert.equal(rows.length, sendTables.length);
  assert.deepEqual(rows.find((row) => row.message_id === mid("private_reply_outbox", account))?.read_at, new Date("2026-11-10T01:00:00.000Z"));
});

test("reads of other messages, other connections and inactive connections leave no row", async () => {
  await ingestMessageReads(pool, [
    // A message the service never sent, such as one a person sent from the Instagram app.
    read("unknown-mid"),
    // The other connection's message, reported to this account.
    read(mid("private_reply_outbox", otherAccount)),
    // An account with no connection.
    read(mid("private_reply_outbox", account), { accountId: "17841400000000009" }),
  ]);
  assert.deepEqual(await storedReads(), []);
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connectionId]);
  await ingestMessageReads(pool, [read(mid("private_reply_outbox", account))]);
  assert.deepEqual(await storedReads(), []);
  // The other account's own message is stored on its own connection only.
  await ingestMessageReads(pool, [read(mid("private_reply_outbox", otherAccount), { accountId: otherAccount })]);
  assert.deepEqual(
    (await storedReads()).map((row) => [row.workspace_id, row.connection_id]),
    [[otherWorkspaceId, otherConnectionId]],
  );
});

test("a read whose recipient is not the entry account is never parsed, so it stores nothing", async () => {
  const body = new TextEncoder().encode(
    JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: account,
          time: 1762736400000,
          messaging: [
            {
              sender: { id: "900" },
              recipient: { id: otherAccount },
              timestamp: 1762736400000,
              read: { mid: mid("private_reply_outbox", account) },
            },
          ],
        },
      ],
    }),
  );
  const reads = parseMessageReadEvents(body);
  assert.deepEqual(reads, []);
  await ingestMessageReads(pool, reads);
  assert.deepEqual(await storedReads(), []);
});

test("out-of-order reads of different messages and different readers are independent", async () => {
  await ingestMessageReads(pool, [read(mid("campaign_deliveries", account), { readAt: new Date("2026-11-10T03:00Z") })]);
  await ingestMessageReads(pool, [read(mid("private_reply_outbox", account), { readAt: new Date("2026-11-10T01:00Z") }), read(mid("private_reply_outbox", account), { readerId: "901", readAt: new Date("2026-11-10T04:00Z") })]);
  assert.deepEqual(
    (await storedReads()).map((row) => [row.message_id, row.recipient_id, row.read_at.toISOString()]),
    [
      [mid("campaign_deliveries", account), "900", "2026-11-10T03:00:00.000Z"],
      [mid("private_reply_outbox", account), "900", "2026-11-10T01:00:00.000Z"],
      [mid("private_reply_outbox", account), "901", "2026-11-10T04:00:00.000Z"],
    ],
  );
});

async function seedReads() {
  await ingestMessageReads(pool, [read(mid("private_reply_outbox", account)), read(mid("campaign_deliveries", account), { readerId: "777" }), read(mid("private_reply_outbox", otherAccount), { accountId: otherAccount })]);
  assert.equal((await storedReads()).length, 3);
}

async function readCount(connection: string, recipient?: string): Promise<number> {
  return Number((await pool.query("SELECT count(*) FROM instagram_message_reads WHERE connection_id=$1 AND ($2::text IS NULL OR recipient_id=$2)", [connection, recipient ?? null])).rows[0].count);
}

async function disconnect(connection: string) {
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1", [connection]);
}

test("connection deletion removes the connection's reads and counts them", async () => {
  await seedReads();
  await disconnect(connectionId);
  const { result } = (await pool.query("SELECT public.delete_connection_data($1,$2,$3,$4) AS result", [workspaceId, connectionId, operatorId, account])).rows[0];
  assert.equal(result.deleted_counts.instagram_message_reads, 2);
  assert.equal(await readCount(connectionId), 0);
  assert.equal(await readCount(otherConnectionId), 1);
});

test("person deletion by the DM recipient removes only that reader's reads", async () => {
  await seedReads();
  const { result } = (await pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','777') AS result", [workspaceId, connectionId, operatorId])).rows[0];
  assert.equal(result.deleted_counts.instagram_message_reads, 1);
  assert.equal(await readCount(connectionId, "777"), 0);
  assert.equal(await readCount(connectionId, "900"), 1);
  assert.equal(await readCount(otherConnectionId), 1);
});

test("workspace deletion removes the workspace's reads and keeps other workspaces' reads", async () => {
  await seedReads();
  await disconnect(connectionId);
  const { result } = (await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspaceId, operatorId])).rows[0];
  assert.equal(result.deleted_counts.instagram_message_reads, 2);
  assert.equal(await readCount(connectionId), 0);
  assert.equal(await readCount(otherConnectionId), 1);
});

test("migration 070 replays over stored reads, keeps the canonical deletion functions and runs in the runner", async () => {
  await seedReads();
  const definitions = async () => (await pool.query("SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('delete_person_data','delete_connection_data','delete_workspace_data') ORDER BY proname")).rows;
  const canonical = await definitions();
  for (const { definition } of canonical) assert.match(definition, /instagram_message_reads/);
  const sql = await readFile(new URL("../../db/migrations/070_instagram_message_reads.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  // Migration 071 (#321) redefines the deletion functions after 070 in the runner.
  await pool.query(await readFile(new URL("../../db/migrations/071_instagram_follow_messages.sql", import.meta.url), "utf8"));
  assert.deepEqual(await definitions(), canonical);
  assert.equal((await storedReads()).length, 3);
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(runner.indexOf("070_instagram_message_reads.sql") > runner.indexOf("069_dm_flow_delivery.sql") && runner.indexOf("070_instagram_message_reads.sql") < runner.indexOf("supabase-access.sql"));
});

test("migration 071 copies each follow row's current message ID, replays and runs in the runner", async () => {
  const definitions = async () => (await pool.query("SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('delete_person_data','delete_connection_data','delete_workspace_data') ORDER BY proname")).rows;
  const canonical = await definitions();
  for (const { definition } of canonical) assert.match(definition, /instagram_follow_messages/);
  // A database before 071: no history rows, and one follow row without a sent message.
  await pool.query("TRUNCATE instagram_follow_messages");
  await pool.query("UPDATE instagram_follow_conversations SET provider_message_id=NULL WHERE connection_id=$1", [otherConnectionId]);
  const copied = async () =>
    (
      await pool.query(
        `SELECT m.connection_id,m.provider_message_id,m.follow_status,m.sent_at,m.reply_id=f.reply_id AS same_reply
         FROM instagram_follow_messages m JOIN instagram_follow_conversations f USING(reply_id) ORDER BY m.provider_message_id`,
      )
    ).rows;
  const sql = await readFile(new URL("../../db/migrations/071_instagram_follow_messages.sql", import.meta.url), "utf8");
  await pool.query(sql);
  const expected = [
    {
      connection_id: connectionId,
      provider_message_id: mid("instagram_follow_conversations", account),
      follow_status: "unknown",
      sent_at: null,
      same_reply: true,
    },
  ];
  assert.deepEqual(await copied(), expected);
  // A replay copies nothing twice and keeps the canonical deletion functions.
  await pool.query(sql);
  assert.deepEqual(await copied(), expected);
  assert.deepEqual(await definitions(), canonical);
  // A read of the copied ID is stored once the follow row's own ID has moved on.
  await pool.query("UPDATE instagram_follow_conversations SET provider_message_id='later-mid' WHERE connection_id=$1", [connectionId]);
  await ingestMessageReads(pool, [read(mid("instagram_follow_conversations", account))]);
  assert.deepEqual(
    (await storedReads()).map((row) => row.message_id),
    [mid("instagram_follow_conversations", account)],
  );
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(runner.indexOf("071_instagram_follow_messages.sql") > runner.indexOf("070_instagram_message_reads.sql") && runner.indexOf("071_instagram_follow_messages.sql") < runner.indexOf("supabase-access.sql"));
});
