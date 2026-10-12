import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { PreSendVerificationError, processNextPrivateReply, type PrivateReplyTransport } from "./reply-worker.ts";
import { PRIVATE_REPLY_HOURLY_BUDGET } from "./send-quota.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) {
  throw new Error("Database tests require a local automations_test database");
}

const pool = new Pool({ connectionString: databaseUrl });
const workspaceId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const otherConnectionId = "44444444-4444-4444-8444-444444444444";
const ruleIds: Record<string, string> = {
  [connectionId]: "33333333-3333-4333-8333-333333333333",
  [otherConnectionId]: "55555555-5555-4555-8555-555555555555",
};
const now = new Date("2026-09-25T00:00:00.000Z");

// Inserts count replies of one connection in one statement. A row with calledAgo had its provider send request
// that long ago; pending rows are created oldest first in insertion order.
async function insertReplies(
  connection: string,
  prefix: string,
  count: number,
  options: { status?: "pending" | "sent"; calledAgo?: string } = {},
): Promise<void> {
  await pool.query(
    `WITH events AS (
       INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       SELECT $1,$2,$3||n,'post-1',$3||n,'자료' FROM generate_series(1,$4::int) n RETURNING id,comment_id,sender_id
     )
     INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,
       private_reply_text,status,provider_message_id,sent_at,provider_called_at,created_at)
     SELECT $1,$2,id,$5,comment_id,'post-1',sender_id,'자료 링크입니다',$6,
       CASE WHEN $6='sent' THEN 'mid-'||comment_id END,CASE WHEN $6='sent' THEN now() END,
       now()-$7::interval,now()-interval '2 hours'+id*interval '1 millisecond'
     FROM events`,
    [
      workspaceId,
      connection,
      prefix,
      count,
      ruleIds[connection],
      options.status ?? (options.calledAgo ? "sent" : "pending"),
      options.calledAgo ?? null,
    ],
  );
}

async function reply(commentId: string) {
  return (
    await pool.query<{
      status: string;
      failure_code: string | null;
      rate_limit_retries: number;
      attempt_id: string | null;
      next_attempt_at: Date;
      provider_called_at: Date | null;
    }>(
      "SELECT status,failure_code,rate_limit_retries,attempt_id,next_attempt_at,provider_called_at FROM private_reply_outbox WHERE comment_id=$1",
      [commentId],
    )
  ).rows[0]!;
}

function recordingTransport(sent: string[], hold?: Promise<void>): PrivateReplyTransport {
  return {
    verify: async () => ({
      commentCreatedAt: new Date("2026-09-24T00:00:00.000Z"),
      authorizationVerified: true,
      mediaOwned: true,
    }),
    send: async (request) => {
      await hold;
      sent.push(request.commentId);
      return { messageId: `mid-${request.commentId}` };
    },
  };
}

before(async () => {
  await pool.query(
    "DROP TABLE IF EXISTS webhook_redelivery_events, webhook_deliveries, webhook_signing_keys, webhook_endpoints, scheduled_steps, workspace_invites, data_deletion_records, instagram_inbox_reminder_events, instagram_inbox_reminders, instagram_inbox_notes, instagram_inbox_label_events, instagram_inbox_label_rules, instagram_inbox_conversation_labels, instagram_inbox_labels, instagram_inbox_read_state, instagram_inbox_conversation_events, instagram_inbox_conversations, flow_step_runs, flow_runs, flow_versions, flows, channel_consent_state, channel_consent_events, instagram_manual_reply_events, instagram_manual_replies, instagram_inbox_handoff_events, instagram_inbox_handoffs, instagram_inbox_messages, instagram_unmatched_replies, instagram_contact_automation, instagram_contact_field_values, instagram_contact_fields, instagram_contact_segments, instagram_contact_tags, instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
  );
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
  );
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspaceId]);
  for (const [connection, account] of [
    [connectionId, "account-1"],
    [otherConnectionId, "account-2"],
  ] as const) {
    await pool.query(
      "INSERT INTO instagram_connections (id, workspace_id, account_id, active) VALUES ($1, $2, $3, true)",
      [connection, workspaceId, account],
    );
    await pool.query(
      "INSERT INTO instagram_comment_rules (id, workspace_id, connection_id, media_id, keyword, private_reply_text, enabled) VALUES ($1, $2, $3, 'post-1', '자료', '자료 링크입니다', true)",
      [ruleIds[connection], workspaceId, connection],
    );
  }
});

after(async () => {
  await pool.end();
});

test("a connection sends while 699 replies were called in the last hour and holds the next one at 700", async () => {
  await insertReplies(connectionId, "called-", PRIVATE_REPLY_HOURLY_BUDGET - 1, { calledAgo: "30 minutes" });
  await insertReplies(connectionId, "queued-", 2);
  const sent: string[] = [];
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, connectionId), true);
  assert.deepEqual(sent, ["queued-1"]);
  assert.equal((await reply("queued-1")).status, "sent");
  assert.notEqual((await reply("queued-1")).provider_called_at, null);

  const before = await reply("queued-2");
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, connectionId), false);
  assert.deepEqual(sent, ["queued-1"]);
  // A held reply keeps its due time and spends no rate-limit retry.
  assert.deepEqual(await reply("queued-2"), before);
  assert.equal(before.status, "pending");
  assert.equal(before.rate_limit_retries, 0);
  assert.equal(before.failure_code, null);
  assert.equal(before.attempt_id, null);
});

test("the budget frees as calls leave the rolling hour", async () => {
  await insertReplies(connectionId, "called-", PRIVATE_REPLY_HOURLY_BUDGET, { calledAgo: "59 minutes" });
  await insertReplies(connectionId, "queued-", 1);
  const sent: string[] = [];
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, connectionId), false);
  await pool.query(
    "UPDATE private_reply_outbox SET provider_called_at=now()-interval '61 minutes' WHERE comment_id='called-1'",
  );
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, connectionId), true);
  assert.deepEqual(sent, ["queued-1"]);
});

test("another connection keeps sending while one connection is held", async () => {
  await insertReplies(connectionId, "called-", PRIVATE_REPLY_HOURLY_BUDGET, { calledAgo: "10 minutes" });
  await insertReplies(connectionId, "held-", 1);
  await insertReplies(otherConnectionId, "other-", 1);
  const sent: string[] = [];
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, connectionId), false);
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, otherConnectionId), true);
  assert.deepEqual(sent, ["other-1"]);
  assert.equal((await reply("held-1")).status, "pending");
});

test("concurrent claims at the budget edge send each reply at most once", async () => {
  await insertReplies(connectionId, "called-", PRIVATE_REPLY_HOURLY_BUDGET - 2, { calledAgo: "30 minutes" });
  await insertReplies(connectionId, "queued-", 4);
  const sent: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const claims = Promise.all(
    Array.from({ length: 3 }, () =>
      processNextPrivateReply(pool, recordingTransport(sent, hold), () => now, connectionId),
    ),
  );
  await sleep(200);
  release();
  const results = await claims;
  // The claims read the count before any of them recorded its call, so up to one call per concurrent claim
  // can pass the budget; no reply is sent twice.
  assert.equal(new Set(sent).size, sent.length);
  assert.equal(results.filter(Boolean).length, sent.length);
  assert.ok(sent.length >= 2 && sent.length <= 3);
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, connectionId), false);
  const called = await pool.query(
    "SELECT count(*)::int AS count FROM private_reply_outbox WHERE connection_id=$1 AND provider_called_at>now()-interval '1 hour'",
    [connectionId],
  );
  assert.ok(called.rows[0].count <= PRIVATE_REPLY_HOURLY_BUDGET + 1);
});

test("a call is recorded before the transport's send, so a send stopped before its POST still counts", async () => {
  await insertReplies(connectionId, "queued-", 1);
  await processNextPrivateReply(
    pool,
    {
      ...recordingTransport([]),
      send: async () => {
        throw new PreSendVerificationError("retry", "token_rotated");
      },
    },
    () => now,
    connectionId,
  );
  const first = await reply("queued-1");
  assert.equal(first.status, "pending");
  assert.notEqual(first.provider_called_at, null);
  // A later attempt overwrites the time, so one reply counts once however often it is attempted.
  await pool.query(
    "UPDATE private_reply_outbox SET next_attempt_at=now(),provider_called_at=now()-interval '2 hours' WHERE comment_id='queued-1'",
  );
  assert.equal(await processNextPrivateReply(pool, recordingTransport([]), () => now, connectionId), true);
  const second = await reply("queued-1");
  assert.equal(second.status, "sent");
  assert.ok(second.provider_called_at! > first.provider_called_at!);
});

const operatorId = "66666666-6666-4666-8666-666666666666";

async function carry(connection = connectionId) {
  return (
    await pool.query<{ calls: number; until: Date | null }>(
      "SELECT private_reply_carried_calls AS calls,private_reply_carried_until AS until FROM instagram_connections WHERE id=$1",
      [connection],
    )
  ).rows[0]!;
}

async function calledAt(commentId: string): Promise<Date> {
  return (await reply(commentId)).provider_called_at!;
}

function hourAfter(time: Date): Date {
  return new Date(time.getTime() + 60 * 60 * 1000);
}

async function deletePerson(sender: string) {
  await pool.query("SELECT public.delete_person_data($1,$2,$3,'comment_sender',$4)", [
    workspaceId,
    connectionId,
    operatorId,
    sender,
  ]);
}

test("connection data deletion and a reconnect keep the deleted rows' recent calls counted until they expire", async () => {
  await insertReplies(connectionId, "called-", 400, { calledAgo: "30 minutes" });
  const latest = await calledAt("called-400");
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connectionId]);
  await pool.query("SELECT public.delete_connection_data($1,$2,$3,'account-1')", [
    workspaceId,
    connectionId,
    operatorId,
  ]);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM private_reply_outbox WHERE connection_id=$1", [connectionId]))
      .rows[0].count,
    0,
  );
  assert.deepEqual(await carry(), { calls: 400, until: hourAfter(latest) });
  // The reconnect reuses the same connection row, as the OAuth upsert does.
  await pool.query("UPDATE instagram_connections SET active=true WHERE id=$1", [connectionId]);
  await insertReplies(connectionId, "recent-", PRIVATE_REPLY_HOURLY_BUDGET - 400 - 1, { calledAgo: "10 minutes" });
  await insertReplies(connectionId, "queued-", 2);
  const sent: string[] = [];
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, connectionId), true);
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, connectionId), false);
  assert.deepEqual(sent, ["queued-1"]);
  assert.equal((await reply("queued-2")).status, "pending");
  // Moving the carry's end into the past stands for the hour passing.
  await pool.query(
    "UPDATE instagram_connections SET private_reply_carried_until=now()-interval '1 second' WHERE id=$1",
    [connectionId],
  );
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, connectionId), true);
  assert.deepEqual(sent, ["queued-1", "queued-2"]);
});

test("person data deletion keeps the person's recent calls counted", async () => {
  await insertReplies(connectionId, "called-", PRIVATE_REPLY_HOURLY_BUDGET - 1, { calledAgo: "30 minutes" });
  await insertReplies(connectionId, "queued-", 2);
  const deletedCall = await calledAt("called-1");
  await deletePerson("called-1");
  assert.equal(await reply("called-1"), undefined);
  assert.deepEqual(await carry(), { calls: 1, until: hourAfter(deletedCall) });
  const sent: string[] = [];
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, connectionId), true);
  assert.equal(await processNextPrivateReply(pool, recordingTransport(sent), () => now, connectionId), false);
  assert.deepEqual(sent, ["queued-1"]);
});

test("deletions within the hour add to the carry and keep its latest end; an expired carry is replaced", async () => {
  await insertReplies(connectionId, "called-", 3, { calledAgo: "30 minutes" });
  await pool.query(
    "UPDATE private_reply_outbox SET provider_called_at=now()-interval '10 minutes' WHERE comment_id='called-2'",
  );
  const later = await calledAt("called-2");
  await deletePerson("called-2");
  assert.deepEqual(await carry(), { calls: 1, until: hourAfter(later) });
  // An earlier call deleted afterwards adds its count and does not move the end back.
  await deletePerson("called-1");
  assert.deepEqual(await carry(), { calls: 2, until: hourAfter(later) });

  await pool.query(
    "UPDATE instagram_connections SET private_reply_carried_until=now()-interval '1 second' WHERE id=$1",
    [connectionId],
  );
  const last = await calledAt("called-3");
  await deletePerson("called-3");
  assert.deepEqual(await carry(), { calls: 1, until: hourAfter(last) });
});

test("deleted rows called over an hour ago or never called carry nothing", async () => {
  await insertReplies(connectionId, "old-", 2, { calledAgo: "61 minutes" });
  await insertReplies(connectionId, "never-", 1);
  await insertReplies(otherConnectionId, "other-", 1, { calledAgo: "5 minutes" });
  const otherCall = await calledAt("other-1");
  // One statement across two connections carries each connection's own recent calls only.
  await pool.query("DELETE FROM private_reply_outbox");
  assert.deepEqual(await carry(), { calls: 0, until: null });
  assert.deepEqual(await carry(otherConnectionId), { calls: 1, until: hourAfter(otherCall) });
});

test("workspace data deletion still succeeds with recent calls and removes the connections with their carry", async () => {
  await insertReplies(connectionId, "called-", 3, { calledAgo: "5 minutes" });
  await insertReplies(otherConnectionId, "other-", 2, { calledAgo: "5 minutes" });
  await pool.query("UPDATE instagram_connections SET active=false");
  const result = await pool.query<{ result: { deleted_counts: Record<string, number> } }>(
    "SELECT public.delete_workspace_data($1,$2) AS result",
    [workspaceId, operatorId],
  );
  assert.equal(result.rows[0]!.result.deleted_counts.private_reply_outbox, 5);
  assert.equal(result.rows[0]!.result.deleted_counts.instagram_connections, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_connections")).rows[0].count, 0);
});

test("the budget carry migration keeps a carry and one trigger when reapplied", async () => {
  await insertReplies(connectionId, "called-", 1, { calledAgo: "5 minutes" });
  await deletePerson("called-1");
  const before = await carry();
  assert.equal(before.calls, 1);
  const migration = await readFile(
    new URL("../../db/migrations/044_private_reply_budget_carry.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);
  assert.deepEqual(await carry(), before);
  const triggers = await pool.query(
    "SELECT tgname FROM pg_trigger WHERE tgrelid='private_reply_outbox'::regclass AND NOT tgisinternal",
  );
  assert.deepEqual(triggers.rows, [{ tgname: "carry_deleted_private_reply_calls" }]);
  await assert.rejects(
    pool.query("UPDATE instagram_connections SET private_reply_carried_calls=-1 WHERE id=$1", [connectionId]),
    { code: "23514" },
  );
});

test("the send quota migration keeps recorded calls and wake times when reapplied", async () => {
  await insertReplies(connectionId, "called-", 1, { calledAgo: "5 minutes" });
  await pool.query("UPDATE instagram_connections SET send_woken_at=now()-interval '1 minute' WHERE id=$1", [
    connectionId,
  ]);
  const migration = await readFile(new URL("../../db/migrations/042_send_quotas.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  const state = await pool.query(
    `SELECT reply.provider_called_at>now()-interval '6 minutes' AS called,connection.send_woken_at IS NOT NULL AS woken
     FROM private_reply_outbox reply JOIN instagram_connections connection ON connection.id=reply.connection_id`,
  );
  assert.deepEqual(state.rows, [{ called: true, woken: true }]);
});
