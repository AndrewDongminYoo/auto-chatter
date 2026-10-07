import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { ingestComments, resumeDueFlowRuns } from "../instagram/store.ts";
import { ingestMessages, reconcileUnmatchedReplies } from "../instagram/follow-flow.ts";
import { processNextPrivateReply, type PrivateReplyTransport } from "../instagram/reply-worker.ts";
import { lockContact } from "./contact-fields.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const testUrl = new URL(databaseUrl);
if (!["localhost", "127.0.0.1"].includes(testUrl.hostname) || testUrl.pathname !== "/automations_test")
  throw new Error("TEST_DATABASE_URL must point at the local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const connectionId = "55555555-5555-4555-8555-555555555555";
const sizeField = "66666666-6666-4666-8666-666666666666";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [workspaceId]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2)", [workspaceId, userId]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted)
     VALUES($1,$2,'owned-account',true,'token')`,
    [connectionId, workspaceId],
  );
  await pool.query("INSERT INTO instagram_contact_fields(id,workspace_id,name,type) VALUES($1,$2,'Size','text')", [
    sizeField,
    workspaceId,
  ]);
});

after(async () => pool.end());

function request(method: string, path: string, body?: unknown) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () =>
      Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

// start -> ask -> wait (replied -> answered tag, timeout -> silent tag), saving the reply into Size.
function waitingDocument(options: { mediaId?: string; timeout?: number; save?: boolean } = {}) {
  return {
    schema_version: 1,
    nodes: [
      {
        id: "start",
        type: "instagram_comment",
        config: {
          connection_id: connectionId,
          media_id: options.mediaId ?? "1789",
          keywords: ["size"],
          match_mode: "contains",
          excluded_keywords: [],
        },
      },
      { id: "ask", type: "instagram_message", config: { text: "Which size do you need?" } },
      {
        id: "wait",
        type: "wait_for_reply",
        config: {
          timeout_minutes: options.timeout ?? 60,
          ...(options.save === false ? {} : { save_field_id: sizeField }),
        },
      },
      { id: "answered", type: "add_tag", config: { tag: "answered" } },
      { id: "silent", type: "add_tag", config: { tag: "silent" } },
    ],
    edges: [
      { from: "start", port: "next", to: "ask" },
      { from: "ask", port: "next", to: "wait" },
      { from: "wait", port: "replied", to: "answered" },
      { from: "wait", port: "timeout", to: "silent" },
    ],
  };
}

async function enabledFlow(draft: unknown = waitingDocument()): Promise<string> {
  const created = await request("POST", "/api/flows", { name: `Ask ${Math.random()}`, draft });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  assert.equal((await request("POST", `/api/flows/${id}/publish`, { expected_revision: 0 })).status, 201);
  assert.equal((await request("POST", `/api/flows/${id}/enable`)).status, 200);
  return id;
}

function comment(commentId: string, senderId: string, postId = "1789") {
  return ingestComments(pool, [{ accountId: "owned-account", commentId, postId, senderId, text: "size please" }]);
}

// Each comment's private reply reaches the DM recipient named after it: comment-1 -> 9001.
function recipientOf(commentId: string): string {
  return `900${commentId.replace(/\D/g, "")}`;
}

const transport: PrivateReplyTransport = {
  verify: async () => ({ commentCreatedAt: new Date(), authorizationVerified: true, mediaOwned: true }),
  send: async (reply) => ({ messageId: `mid-${reply.commentId}`, recipientId: recipientOf(reply.commentId) }),
};

async function sendAll(): Promise<void> {
  while (await processNextPrivateReply(pool, transport, () => new Date(), connectionId));
}

// Sends the next reply with a transport that receives a DM while the reply is being sent (#108): the
// DM is dated just after the claim, so it is earlier than the sent_at recorded after send() returns.
async function sendWhileReceiving(deliver: (at: Date) => Promise<void>): Promise<Date> {
  let deliveredAt: Date | undefined;
  await processNextPrivateReply(
    pool,
    {
      ...transport,
      send: async (reply) => {
        const started = (
          await pool.query<{ at: Date }>("SELECT attempt_started_at AS at FROM private_reply_outbox WHERE id=$1", [
            reply.id,
          ])
        ).rows[0]!.at;
        deliveredAt = new Date(started.getTime() + 1);
        await deliver(deliveredAt);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return transport.send(reply);
      },
    },
    () => new Date(),
    connectionId,
  );
  const sent = (await pool.query<{ sent_at: Date }>("SELECT max(sent_at) AS sent_at FROM private_reply_outbox"))
    .rows[0]!;
  assert.ok(deliveredAt! < sent.sent_at, "the DM must be dated before the reply was recorded as sent");
  return deliveredAt!;
}

// A DM dated a second from now by default: Meta stamps messages in milliseconds and the reply's sent_at
// has microseconds, so a DM ingested within the same millisecond as the send would read as earlier.
// `postback` is the bound reply ID, or true for an unrelated one.
function dm(senderId: string, text: string, options: { at?: Date; id?: string; postback?: boolean | string } = {}) {
  return ingestMessages(pool, [
    {
      accountId: "owned-account",
      senderId,
      messageId: options.id ?? `in-${Math.random()}`,
      text,
      timestamp: options.at ?? new Date(Date.now() + 1000),
      ...(options.postback ? { confirmationReplyId: options.postback === true ? "1" : options.postback } : {}),
    },
  ]);
}

async function tagsOf(senderId: string): Promise<string[] | undefined> {
  return (
    await pool.query("SELECT tags FROM instagram_contact_tags WHERE connection_id=$1 AND sender_id=$2", [
      connectionId,
      senderId,
    ])
  ).rows[0]?.tags;
}

async function sizeOf(senderId: string): Promise<unknown> {
  return (
    await pool.query(
      "SELECT value FROM instagram_contact_field_values WHERE connection_id=$1 AND sender_id=$2 AND field_id=$3",
      [connectionId, senderId, sizeField],
    )
  ).rows[0]?.value;
}

type Run = {
  status: string;
  failure_code: string | null;
  resume_at: string | null;
  delivery_status: string | null;
  steps: { node_id: string; outcome: string }[];
};

async function runs(id: string): Promise<Run[]> {
  const response = await request("GET", `/api/flows/${id}/runs`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { runs: Run[] }).runs;
}

function outcomes(run: Run | undefined) {
  return run!.steps.map((step) => `${step.node_id}:${step.outcome}`);
}

// Moves every sent reply back in time, so its wait is over or nearly over.
async function sentMinutesAgo(minutes: number) {
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-make_interval(mins=>$1) WHERE status='sent'", [
    minutes,
  ]);
}

async function waitForLock(pattern: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event_type IN ('Lock','advisory') AND query LIKE $1",
      [pattern],
    );
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`nothing waited on ${pattern}`);
}

test("a queued reply followed by a wait leaves the run awaiting a reply at that wait", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  const stored = (await pool.query("SELECT status,resume_at,resume_node_id FROM flow_runs")).rows[0];
  assert.deepEqual(stored, { status: "awaiting_reply", resume_at: null, resume_node_id: "wait" });
  const [run] = await runs(id);
  assert.deepEqual([run!.status, run!.resume_at, run!.delivery_status], ["awaiting_reply", null, "pending"]);
  assert.deepEqual(outcomes(run), ["start:next", "ask:queued"]);
  // The reply is not sent yet, so the wait has not started and nothing times out.
  assert.equal(await resumeDueFlowRuns(pool), 0);
  await dm("9001", "XL");
  assert.equal((await runs(id))[0]!.status, "awaiting_reply");
});

test("a DM reply continues the run on replied and saves the text for the comment sender", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendAll();
  await dm("9001", "XL");
  const [run] = await runs(id);
  assert.deepEqual([run!.status, run!.failure_code, run!.resume_at], ["ended", null, null]);
  assert.deepEqual(outcomes(run), ["start:next", "ask:queued", "wait:replied", "wait:set", "answered:added"]);
  assert.equal(await sizeOf("sender-1"), "XL");
  assert.deepEqual(await tagsOf("sender-1"), ["answered"]);
  assert.equal(await sizeOf("9001"), undefined);
  assert.equal((await pool.query("SELECT resume_node_id FROM flow_runs")).rows[0].resume_node_id, null);
  // The run is over, so the cron has nothing to time out.
  await sentMinutesAgo(120);
  assert.equal(await resumeDueFlowRuns(pool), 0);
});

test("a reply that arrives while the private reply is being sent still continues the run (#108)", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendWhileReceiving((at) => dm("9001", "XL", { at, id: "early-1" }));
  const [run] = await runs(id);
  assert.equal(run!.status, "ended");
  assert.deepEqual(outcomes(run), ["start:next", "ask:queued", "wait:replied", "wait:set", "answered:added"]);
  assert.equal(await sizeOf("sender-1"), "XL");
  const stored = (
    await pool.query("SELECT message_id,matched_at IS NOT NULL AS matched FROM instagram_unmatched_replies")
  ).rows;
  assert.deepEqual(stored, [{ message_id: "early-1", matched: true }]);
});

test("an early reply delivered again, during or after the send, advances the run once", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  const at = await sendWhileReceiving(async (time) => {
    await dm("9001", "XL", { at: time, id: "early-1" });
    await dm("9001", "XL", { at: time, id: "early-1" });
  });
  await dm("9001", "XL", { at, id: "early-1" });
  assert.equal(await reconcileUnmatchedReplies(pool), 0);
  const [run] = await runs(id);
  assert.equal(run!.status, "ended");
  assert.equal(run!.steps.filter((step) => step.outcome === "replied").length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_unmatched_replies")).rows[0].count, 1);
});

test("an early message dated before the send started, or a postback, does not answer the wait", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendWhileReceiving(async (at) => {
    await dm("9001", "XL", { at: new Date(at.getTime() - 1000), id: "before" });
    const sending = (await pool.query("SELECT id::text FROM private_reply_outbox WHERE status='sending'")).rows[0];
    await dm("9001", "Yes", { at, id: "tap", postback: sending.id as string });
  });
  assert.equal((await runs(id))[0]!.status, "awaiting_reply");
  // A message dated before the attempt cannot answer it and is not kept; the postback was offered once.
  assert.deepEqual(
    (await pool.query("SELECT message_id,matched_at IS NOT NULL AS matched FROM instagram_unmatched_replies")).rows,
    [{ message_id: "tap", matched: true }],
  );
  assert.equal(await reconcileUnmatchedReplies(pool), 0);
});

test("the scheduled reconcile links an early reply that the send path left behind", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await pool.query(
    "UPDATE private_reply_outbox SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now()-interval '1 minute'",
  );
  await dm("9001", "XL", { at: new Date(Date.now() - 30_000), id: "early-1" });
  assert.equal((await runs(id))[0]!.status, "awaiting_reply");
  // The reply is recorded as sent elsewhere, without the reconcile that normally follows.
  await pool.query(
    "UPDATE private_reply_outbox SET status='sent',recipient_id='9001',provider_message_id='mid',sent_at=now()",
  );
  assert.equal(await reconcileUnmatchedReplies(pool), 1);
  assert.equal(await reconcileUnmatchedReplies(pool), 0);
  assert.equal((await runs(id))[0]!.status, "ended");
  assert.equal(await sizeOf("sender-1"), "XL");
});

test("neither reconcile gives a kept reply to an earlier reply while another one is being sent", async () => {
  const id = await enabledFlow();
  // Reply A to 9001 went out earlier and its wait was answered.
  await comment("comment-1", "sender-1");
  await sendAll();
  await dm("9001", "S", { id: "in-a" });
  const a = (
    await pool.query(
      "UPDATE private_reply_outbox SET attempt_started_at=now()-interval '5 minutes',sent_at=now()-interval '5 minutes' RETURNING id::text",
    )
  ).rows[0].id as string;
  // Reply B goes to the same person and is being sent when the answer to it arrives.
  await comment("comment-2", "sender-2");
  await pool.query(
    "UPDATE private_reply_outbox SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now()-interval '1 minute' WHERE comment_id='comment-2'",
  );
  await dm("9001", "XL", { at: new Date(Date.now() - 30_000), id: "early-b" });
  assert.equal(await reconcileUnmatchedReplies(pool), 0);
  assert.equal(await reconcileUnmatchedReplies(pool, { connectionId }), 0);
  // A's post-send pass (A was being sent too when the DM arrived) must not use it up either.
  assert.equal(await reconcileUnmatchedReplies(pool, { replyId: a }), 0);
  assert.deepEqual(
    (await pool.query("SELECT message_id,matched_at IS NOT NULL AS matched FROM instagram_unmatched_replies")).rows,
    [{ message_id: "early-b", matched: false }],
  );
  const b = (
    await pool.query(
      "UPDATE private_reply_outbox SET status='sent',recipient_id='9001',provider_message_id='mid-b',sent_at=now() WHERE comment_id='comment-2' RETURNING id::text",
    )
  ).rows[0].id as string;
  assert.equal(await reconcileUnmatchedReplies(pool, { replyId: b }), 1);
  const statuses = (await runs(id)).map((run) => run.status);
  assert.deepEqual(statuses, ["ended", "ended"]);
  assert.equal(await sizeOf("sender-2"), "XL");
});

// A 1-minute wait whose reply was recorded as sent 2 minutes ago, so the wait is over, with a DM that
// answered it in time kept from while the reply was being sent and not linked yet.
async function keptAnswerAfterWaitEnded(): Promise<string> {
  const id = await enabledFlow(waitingDocument({ timeout: 1 }));
  await comment("comment-1", "sender-1");
  await pool.query(
    "UPDATE private_reply_outbox SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now()-interval '3 minutes'",
  );
  await dm("9001", "XL", { at: new Date(Date.now() - 150_000), id: "early-1" });
  await pool.query(
    "UPDATE private_reply_outbox SET status='sent',recipient_id='9001',provider_message_id='mid',sent_at=now()-interval '2 minutes'",
  );
  return id;
}

test("a wait does not time out while a reply kept in time is not linked yet", async () => {
  const id = await keptAnswerAfterWaitEnded();
  assert.equal(await resumeDueFlowRuns(pool), 0);
  assert.equal((await runs(id))[0]!.status, "awaiting_reply");
  assert.equal(await reconcileUnmatchedReplies(pool), 1);
  assert.deepEqual(outcomes((await runs(id))[0]), [
    "start:next",
    "ask:queued",
    "wait:replied",
    "wait:set",
    "answered:added",
  ]);
  assert.equal(await sizeOf("sender-1"), "XL");
  assert.equal(await resumeDueFlowRuns(pool), 0);
});

test("a kept reply no longer holds the wait 15 minutes after it was received", async () => {
  const id = await keptAnswerAfterWaitEnded();
  await pool.query("UPDATE instagram_unmatched_replies SET received_at=now()-interval '15 minutes'");
  assert.equal(await resumeDueFlowRuns(pool), 1);
  assert.deepEqual(outcomes((await runs(id))[0]), ["start:next", "ask:queued", "wait:timeout", "silent:added"]);
  assert.equal(await reconcileUnmatchedReplies(pool), 0);
});

test("a kept reply that turns 15 minutes old while the reconcile waits for its connection is not linked", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await pool.query(
    "UPDATE private_reply_outbox SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now()-interval '1 minute'",
  );
  await dm("9001", "XL", { at: new Date(Date.now() - 30_000), id: "early-1" });
  await pool.query(
    "UPDATE private_reply_outbox SET status='sent',recipient_id='9001',provider_message_id='mid',sent_at=now()",
  );
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM instagram_connections WHERE id=$1 FOR UPDATE", [connectionId]);
    const reconciling = reconcileUnmatchedReplies(pool);
    await waitForLock("SELECT account_id FROM instagram_connections%");
    await pool.query("UPDATE instagram_unmatched_replies SET received_at=now()-interval '15 minutes'");
    await holder.query("COMMIT");
    assert.equal(await reconciling, 0);
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  assert.equal((await runs(id))[0]!.status, "awaiting_reply");
  assert.equal(await sizeOf("sender-1"), undefined);
  assert.deepEqual(
    (await pool.query("SELECT matched_at IS NOT NULL AS matched FROM instagram_unmatched_replies")).rows,
    [{ matched: false }],
  );
});

test("a redelivered or later message advances the run once, and a postback never does", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendAll();
  await dm("9001", "Yes", { postback: true });
  assert.equal((await runs(id))[0]!.status, "awaiting_reply");
  await dm("9001", "XL", { id: "in-1" });
  await dm("9001", "XL", { id: "in-1" });
  await dm("9001", "Actually M", { id: "in-2" });
  const [run] = await runs(id);
  assert.equal(run!.status, "ended");
  assert.equal(run!.steps.filter((step) => step.outcome === "replied").length, 1);
  assert.equal(await sizeOf("sender-1"), "XL");
});

test("a message from someone else, or sent before the reply, does not count", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendAll();
  await dm("9002", "XL");
  await dm("sender-1", "XL");
  const sentAt = (await pool.query<{ sent_at: Date }>("SELECT sent_at FROM private_reply_outbox")).rows[0]!.sent_at;
  await dm("9001", "XL", { at: new Date(sentAt.getTime() - 1000) });
  assert.equal((await runs(id))[0]!.status, "awaiting_reply");
});

test("a reply after the wait expired is ignored and the cron times the run out", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendAll();
  await sentMinutesAgo(61);
  await dm("9001", "XL");
  assert.equal((await runs(id))[0]!.status, "awaiting_reply");
  assert.equal(await resumeDueFlowRuns(pool), 1);
  assert.equal(await resumeDueFlowRuns(pool), 0);
  const [run] = await runs(id);
  assert.equal(run!.status, "ended");
  assert.deepEqual(outcomes(run), ["start:next", "ask:queued", "wait:timeout", "silent:added"]);
  assert.equal(await sizeOf("sender-1"), undefined);
  // A message dated inside the wait but delivered after the timeout no longer counts.
  await dm("9001", "XL", { at: new Date(Date.now() - 2 * 60_000) });
  assert.equal((await runs(id))[0]!.steps.length, 4);
});

test("a wait that is not over yet does not time out", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendAll();
  await sentMinutesAgo(59);
  assert.equal(await resumeDueFlowRuns(pool), 0);
  assert.equal((await runs(id))[0]!.status, "awaiting_reply");
});

test("a reply that is pending, blocked, failed or unknown never times out", async () => {
  const id = await enabledFlow();
  const states = ["pending", "blocked", "failed", "unknown"];
  for (const [index] of states.entries()) await comment(`comment-${index + 1}`, `sender-${index + 1}`);
  for (const [index, status] of states.entries())
    await pool.query(
      `UPDATE private_reply_outbox SET status=$2,failure_code=CASE WHEN $2='pending' THEN NULL ELSE 'test' END,
       created_at=now()-interval '8 days',next_attempt_at=now()+interval '1 day' WHERE comment_id=$1`,
      [`comment-${index + 1}`, status],
    );
  assert.equal(await resumeDueFlowRuns(pool), 0);
  assert.deepEqual(
    (await runs(id)).map((run) => run.status),
    ["awaiting_reply", "awaiting_reply", "awaiting_reply", "awaiting_reply"],
  );
});

test("a timeout that claimed the run first wins over a reply that arrives while it runs", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendAll();
  await sentMinutesAgo(61);
  const holder = await pool.connect();
  try {
    // The timeout claims the run, then waits on the contact lock a manual edit holds.
    await holder.query("BEGIN");
    await lockContact(holder, connectionId, "sender-1");
    const timedOut = resumeDueFlowRuns(pool);
    await waitForLock("%pg_advisory_xact_lock%");
    // The reply is dated inside the wait, so it waits for the run row the timeout holds.
    const replied = dm("9001", "XL", { at: new Date(Date.now() - 2 * 60_000) });
    await waitForLock("%FOR UPDATE OF run%");
    await holder.query("COMMIT");
    assert.equal(await timedOut, 1);
    await replied;
  } finally {
    holder.release();
  }
  const [run] = await runs(id);
  assert.deepEqual(outcomes(run), ["start:next", "ask:queued", "wait:timeout", "silent:added"]);
  assert.equal(await sizeOf("sender-1"), undefined);
});

test("a reply that claimed the run first wins and the cron skips it", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendAll();
  await sentMinutesAgo(61);
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await lockContact(holder, connectionId, "sender-1");
    const replied = dm("9001", "XL", { at: new Date(Date.now() - 2 * 60_000) });
    await waitForLock("%pg_advisory_xact_lock%");
    // The run row is held by the reply, so the timeout passes it over.
    assert.equal(await resumeDueFlowRuns(pool), 0);
    await holder.query("COMMIT");
    await replied;
  } finally {
    holder.release();
  }
  assert.equal(await resumeDueFlowRuns(pool), 0);
  const [run] = await runs(id);
  assert.deepEqual(outcomes(run), ["start:next", "ask:queued", "wait:replied", "wait:set", "answered:added"]);
});

test("a flow turned off or an inactive connection cancels the run when the reply or timeout arrives", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await comment("comment-2", "sender-2");
  await sendAll();
  assert.equal((await request("POST", `/api/flows/${id}/disable`)).status, 200);
  await dm("9001", "XL");
  await sentMinutesAgo(61);
  assert.equal(await resumeDueFlowRuns(pool), 1);
  for (const run of await runs(id)) {
    assert.deepEqual([run.status, run.failure_code], ["cancelled", "inactive_flow"]);
    assert.deepEqual(outcomes(run), ["start:next", "ask:queued"]);
  }
  assert.equal(await sizeOf("sender-1"), undefined);
  assert.equal(await tagsOf("sender-2"), undefined);
});

test("an inactive connection cancels the run at reply time", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendAll();
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connectionId]);
  await dm("9001", "XL");
  const [run] = await runs(id);
  assert.deepEqual([run!.status, run!.failure_code], ["cancelled", "connection_unavailable"]);
  assert.equal(await sizeOf("sender-1"), undefined);
});

test("a paused contact's reply still advances the run, which sends nothing more", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendAll();
  await pool.query(
    `INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused,handoff_paused)
     VALUES($1,$2,'sender-1',true,false)`,
    [workspaceId, connectionId],
  );
  await dm("9001", "XL");
  assert.equal((await runs(id))[0]!.status, "ended");
  assert.equal(await sizeOf("sender-1"), "XL");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM private_reply_outbox")).rows[0].count, 1);
});

test("a reply too long for a text field is recorded and the run still continues", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendAll();
  await dm("9001", "x".repeat(1001));
  const [run] = await runs(id);
  assert.deepEqual(outcomes(run), ["start:next", "ask:queued", "wait:replied", "wait:reply_invalid", "answered:added"]);
  assert.equal(await sizeOf("sender-1"), undefined);
});

test("the most recent reply's run takes the message when one person waits on two flows", async () => {
  const first = await enabledFlow(waitingDocument({ save: false }));
  const second = await enabledFlow(waitingDocument({ mediaId: "1790", save: false }));
  await comment("comment-1", "sender-1");
  await comment("comment-2", "sender-1", "1790");
  // Both private replies reach the same DM conversation.
  const sameRecipient: PrivateReplyTransport = {
    ...transport,
    send: async () => ({ messageId: "m", recipientId: "9001" }),
  };
  while (await processNextPrivateReply(pool, sameRecipient, () => new Date(), connectionId));
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '2 minutes' WHERE comment_id='comment-1'");
  await dm("9001", "XL");
  assert.equal((await runs(first))[0]!.status, "awaiting_reply");
  assert.equal((await runs(second))[0]!.status, "ended");
  await dm("9001", "M");
  assert.equal((await runs(first))[0]!.status, "ended");
});

test("a redelivered message does not advance a second run waiting on the same person", async () => {
  const { first, second } = await twoRunsWaitingOnOnePerson();
  await dm("9001", "XL", { id: "in-1" });
  // Meta delivers the same message again, alone and twice within one batch.
  await dm("9001", "XL", { id: "in-1" });
  await ingestMessages(pool, [
    {
      accountId: "owned-account",
      senderId: "9001",
      messageId: "in-1",
      text: "XL",
      timestamp: new Date(Date.now() + 1000),
    },
    {
      accountId: "owned-account",
      senderId: "9001",
      messageId: "in-1",
      text: "XL",
      timestamp: new Date(Date.now() + 1000),
    },
  ]);
  assert.equal((await runs(second))[0]!.status, "ended");
  assert.equal((await runs(first))[0]!.status, "awaiting_reply");
  assert.equal(await sizeOf("sender-1"), undefined);
  // A different message is a new answer and advances the remaining run.
  await dm("9001", "M", { id: "in-2" });
  assert.equal((await runs(first))[0]!.status, "ended");
  assert.equal(await sizeOf("sender-1"), "M");
});

// Two flows wait on sender-1, and both private replies reach DM recipient 9001; comment-2's is newer.
async function twoRunsWaitingOnOnePerson() {
  const first = await enabledFlow(waitingDocument());
  const second = await enabledFlow(waitingDocument({ mediaId: "1790", save: false }));
  await comment("comment-1", "sender-1");
  await comment("comment-2", "sender-1", "1790");
  const sameRecipient: PrivateReplyTransport = {
    ...transport,
    send: async () => ({ messageId: "m", recipientId: "9001" }),
  };
  while (await processNextPrivateReply(pool, sameRecipient, () => new Date(), connectionId));
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '2 minutes' WHERE comment_id='comment-1'");
  return { first, second };
}

// The first message claims the newest run and waits on the contact lock a manual edit holds; the second
// message picks the same run and waits on its row lock until the first one commits.
async function deliverConcurrently(firstId: string, secondId: string) {
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await lockContact(holder, connectionId, "sender-1");
    const firstMessage = dm("9001", "XL", { id: firstId });
    await waitForLock("%pg_advisory_xact_lock%");
    const secondMessage = dm("9001", "M", { id: secondId });
    await waitForLock("%FOR UPDATE OF run%");
    await holder.query("COMMIT");
    await Promise.all([firstMessage, secondMessage]);
  } finally {
    holder.release();
  }
}

test("two different messages arriving together advance two runs waiting on the same person", async () => {
  const { first, second } = await twoRunsWaitingOnOnePerson();
  await deliverConcurrently("in-1", "in-2");
  assert.equal((await runs(second))[0]!.status, "ended");
  // The message that lost the newest run moves on to the older one, as it would have one after the other.
  assert.equal((await runs(first))[0]!.status, "ended");
  assert.equal(await sizeOf("sender-1"), "M");
});

test("the same message delivered twice at once advances only one of two waiting runs", async () => {
  const { first, second } = await twoRunsWaitingOnOnePerson();
  await deliverConcurrently("in-1", "in-1");
  assert.equal((await runs(second))[0]!.status, "ended");
  assert.equal((await runs(first))[0]!.status, "awaiting_reply");
  assert.equal(await sizeOf("sender-1"), undefined);
});

test("a duplicate reply to the same person and media skips the run without a wait", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await comment("comment-2", "sender-1");
  const stored = (await pool.query("SELECT status,failure_code,resume_node_id FROM flow_runs ORDER BY created_at"))
    .rows;
  assert.deepEqual(stored, [
    { status: "awaiting_reply", failure_code: null, resume_node_id: "wait" },
    { status: "skipped", failure_code: "duplicate_recipient", resume_node_id: null },
  ]);
  assert.equal((await runs(id)).length, 2);
});

test("the field a wait saves into is in use while the version is published", async () => {
  await enabledFlow();
  assert.equal((await request("DELETE", `/api/contact-fields/${sizeField}`)).status, 409);
  await pool.query("INSERT INTO instagram_contact_fields(id,workspace_id,name,type) VALUES($1,$2,'Count','number')", [
    "77777777-7777-4777-8777-777777777777",
    workspaceId,
  ]);
  const draft = waitingDocument({ mediaId: "1790" });
  draft.nodes[2]!.config = { timeout_minutes: 60, save_field_id: "77777777-7777-4777-8777-777777777777" };
  const created = await request("POST", "/api/flows", { name: "Wrong type", draft });
  const { id } = (await created.json()) as { id: string };
  const published = await request("POST", `/api/flows/${id}/publish`, { expected_revision: 0 });
  assert.equal(published.status, 422);
  const body = (await published.json()) as { errors: { code: string }[] };
  assert.deepEqual(
    body.errors.map((error) => error.code),
    ["invalid_field_type"],
  );
});

test("deleting the comment sender or the DM recipient removes an awaiting run", async () => {
  await enabledFlow();
  await comment("comment-1", "sender-1");
  await comment("comment-2", "sender-2");
  await sendAll();
  for (const [kind, value] of [
    ["comment_sender", "sender-1"],
    ["dm_recipient", "9002"],
  ]) {
    const result = (
      await pool.query<{ result: { deleted_counts: Record<string, number> } }>(
        "SELECT public.delete_person_data($1,$2,$3,$4,$5) AS result",
        [workspaceId, connectionId, userId, kind, value],
      )
    ).rows[0]!.result;
    assert.equal(result.deleted_counts.flow_runs, 1, kind);
  }
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM flow_runs")).rows[0].count, 0);
  await sentMinutesAgo(120);
  assert.equal(await resumeDueFlowRuns(pool), 0);
});

test("deleting the connection removes its awaiting runs", async () => {
  await enabledFlow();
  await comment("comment-1", "sender-1");
  await sendAll();
  await pool.query("UPDATE instagram_connections SET active=false,access_token_encrypted=NULL WHERE id=$1", [
    connectionId,
  ]);
  const connection = (
    await pool.query<{ result: { deleted_counts: Record<string, number> } }>(
      "SELECT public.delete_connection_data($1,$2,$3,'owned-account') AS result",
      [workspaceId, connectionId, userId],
    )
  ).rows[0]!.result;
  assert.equal(connection.deleted_counts.flow_runs, 1);
});

test("migration 026 replays after 025 and only an awaiting run carries a wait without a resume time", async () => {
  // No run exists while the migrations replay, so a constraint 025 put back silently would not
  // fail on existing rows and only the assertions below can catch it.
  const delays = await readFile(new URL("../../db/migrations/025_flow_delays.sql", import.meta.url), "utf8");
  const waits = await readFile(new URL("../../db/migrations/026_flow_reply_waits.sql", import.meta.url), "utf8");
  const definition = async () =>
    (
      await pool.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='flow_runs'::regclass AND conname='flow_runs_state'",
      )
    ).rows[0].def;
  await pool.query(waits);
  // 025 replayed after 026 must keep the wider constraint: read it before anything reapplies 026.
  await pool.query(delays);
  assert.match(await definition(), /awaiting_reply/);
  await pool.query(waits);
  assert.match(await definition(), /awaiting_reply/);
  await enabledFlow();
  await comment("comment-1", "sender-1");
  assert.equal((await pool.query("SELECT status FROM flow_runs")).rows[0].status, "awaiting_reply");
  // The runner replays both migrations on later deploys, while runs are already awaiting a reply.
  await pool.query(delays);
  await pool.query(waits);
  assert.match(await definition(), /awaiting_reply/);
  assert.equal((await pool.query("SELECT status FROM flow_runs")).rows[0].status, "awaiting_reply");
  await assert.rejects(pool.query("UPDATE flow_runs SET resume_node_id=NULL"), { code: "23514" });
  await assert.rejects(pool.query("UPDATE flow_runs SET resume_at=now()"), { code: "23514" });
  await assert.rejects(pool.query("UPDATE flow_runs SET status='delivering'"), { code: "23514" });
  await pool.query("UPDATE flow_runs SET status='delivering',resume_node_id=NULL");
});
