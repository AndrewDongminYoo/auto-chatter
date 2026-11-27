import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "../app/api.ts";
import { ingestComments, resumeDueFlowRuns } from "./store.ts";
import { ingestMessages, processNextFollowReply, reconcileUnmatchedReplies } from "./follow-flow.ts";
import { processNextPrivateReply, type PrivateReplyTransport } from "./reply-worker.ts";
import { processNextCampaignDelivery } from "./campaign-delivery-worker.ts";
import { processNextManualReply } from "./manual-reply-worker.ts";
import { recordChannelConsentEvent } from "./channel-consent.ts";
import type { InstagramMessage } from "./message-events.ts";
import { instagramAdapter, partitionInstagramEvents } from "./channel-adapter.ts";
import { ingestMessageReads, parseMessageReadEvents } from "./message-reads.ts";
import { connectionMetrics } from "../app/operations-health.ts";
import { exportWorkspace } from "../app/workspace-export.ts";
import { DM_START_HOURLY_LIMIT, DM_START_SENDER_COOLDOWN_MINUTES, dmStartSkipCodeSql } from "./send-quota.ts";

// DM start triggers, PR 1 (#33): a typed DM starts a published DM keyword or default-reply flow, records a start
// event, the run and its first message in flow_dm_deliveries, and sends nothing.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const testUrl = new URL(databaseUrl);
if (!["localhost", "127.0.0.1"].includes(testUrl.hostname) || testUrl.pathname !== "/automations_test") throw new Error("TEST_DATABASE_URL must point at the local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const connectionId = "55555555-5555-4555-8555-555555555555";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  // The ledger has no foreign keys, so the workspace cascade leaves it alone; earlier sends would fill the free plan.
  await pool.query("TRUNCATE workspaces,workspace_deletion_records,active_contacts CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [workspaceId]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2)", [workspaceId, userId]);
  // Inbox storage stays off: start events are written whether or not inbox_enabled is set.
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,access_token_encrypted)
     VALUES($1,$2,'owned-account',true,true,'token')`,
    [connectionId, workspaceId],
  );
});

after(async () => pool.end());

function request(method: string, path: string, body?: unknown, source: Pick<Pool, "query" | "connect"> = pool) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    apiEnv,
    () =>
      ({
        query: source.query.bind(source),
        connect: source.connect.bind(source),
        end: async () => {},
      }) as unknown as Pool,
    (async () => Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

type Trigger = { type: "instagram_dm_keyword"; keywords: string[]; mode?: "contains" | "exact" | "all" } | { type: "instagram_dm_default" };

function dmDocument(trigger: Trigger, text: string) {
  return {
    schema_version: 1,
    nodes: [
      {
        id: "start",
        type: trigger.type,
        config:
          trigger.type === "instagram_dm_default"
            ? { connection_id: connectionId }
            : {
                connection_id: connectionId,
                keywords: trigger.keywords,
                match_mode: trigger.mode ?? "contains",
                excluded_keywords: [],
              },
      },
      { id: "reply", type: "instagram_message", config: { text } },
    ],
    edges: [{ from: "start", port: "next", to: "reply" }],
  };
}

async function createFlow(draft: unknown): Promise<string> {
  const created = await request("POST", "/api/flows", { name: `Flow ${Math.random()}`, draft });
  assert.equal(created.status, 201);
  return ((await created.json()) as { id: string }).id;
}

async function enabledFlow(draft: unknown): Promise<string> {
  const id = await createFlow(draft);
  assert.equal((await request("POST", `/api/flows/${id}/publish`, { expected_revision: 0 })).status, 201);
  assert.equal((await request("POST", `/api/flows/${id}/enable`)).status, 200);
  return id;
}

function dm(senderId: string, text: string, options: { id?: string; at?: Date; postback?: string } = {}) {
  return ingestMessages(pool, [
    {
      accountId: "owned-account",
      senderId,
      messageId: options.id ?? `in-${Math.random()}`,
      text,
      timestamp: options.at ?? new Date(Date.now() + 1000),
      ...(options.postback ? { confirmationReplyId: options.postback } : {}),
    },
  ]);
}

async function started() {
  return (
    await pool.query(
      `SELECT start.sender_id,start.message_id,start.trigger_type,start.flow_id::text,run.status,run.failure_code,
         delivery.recipient_id,delivery.message_text,delivery.status AS delivery_status
       FROM instagram_dm_start_events start
       LEFT JOIN flow_runs run ON run.dm_start_event_id=start.id
       LEFT JOIN flow_dm_deliveries delivery ON delivery.flow_run_id=run.id
       ORDER BY start.created_at`,
    )
  ).rows;
}

// A sent private reply from a comment rule of the connection: comment sender 123 reached DM recipient `recipient`.
async function sentReply(recipient: string, followGate = false): Promise<string> {
  const rule = (
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled,follow_gate_enabled,confirmation_keyword,follower_reply_text,non_follower_reply_text)
       VALUES(gen_random_uuid(),$1,$2,$3,'hi','reply',true,$4,'ok','yes','no') RETURNING id`,
      [workspaceId, connectionId, `9${recipient}`, followGate],
    )
  ).rows[0].id;
  const event = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,$4,'123','hi') RETURNING id`,
      [workspaceId, connectionId, `c-${recipient}`, `9${recipient}`],
    )
  ).rows[0].id;
  return (
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text,recipient_id,status,provider_message_id,sent_at)
       VALUES($1,$2,$3,$4,$5,$6,'123','reply',$7,'sent',$8,now()-interval '1 minute') RETURNING id::text`,
      [workspaceId, connectionId, event, rule, `c-${recipient}`, `9${recipient}`, recipient, `mid-${recipient}`],
    )
  ).rows[0].id;
}

const refuse = () => {
  throw new Error("nothing may be sent");
};
const refusingTransport: PrivateReplyTransport = { verify: refuse, send: refuse };

test("a keyword DM starts exactly one run and one delivery row, and never stores the DM text", async () => {
  const flow = await enabledFlow(dmDocument({ type: "instagram_dm_keyword", keywords: ["price"] }, "Our prices: …"));
  await dm("9100", "What is the PRICE of secret-body-123?", { id: "dm-1" });
  assert.deepEqual(await started(), [
    {
      sender_id: "9100",
      message_id: "dm-1",
      trigger_type: "instagram_dm_keyword",
      flow_id: flow,
      status: "delivering",
      failure_code: null,
      recipient_id: "9100",
      message_text: "Our prices: …",
      delivery_status: "pending",
    },
  ]);
  const steps = await pool.query("SELECT node_id,node_type,outcome FROM flow_step_runs ORDER BY seq");
  assert.deepEqual(steps.rows, [
    { node_id: "start", node_type: "instagram_dm_keyword", outcome: "next" },
    { node_id: "reply", node_type: "instagram_message", outcome: "queued" },
  ]);
  // No outbox row, no inbox row (storage is off), and the DM body is in none of the new tables.
  assert.equal((await pool.query("SELECT count(*) FROM private_reply_outbox")).rows[0].count, "0");
  for (const table of ["instagram_dm_start_events", "flow_runs", "flow_step_runs", "flow_dm_deliveries"]) {
    const rows = (await pool.query(`SELECT * FROM ${table}`)).rows;
    assert.doesNotMatch(JSON.stringify(rows), /secret-body/, table);
  }
  // The run history and the run report read the DM delivery row as the run's delivery state, not as absent.
  const runs = (await (await request("GET", `/api/flows/${flow}/runs`)).json()) as {
    runs: { status: string; delivery_status: string | null }[];
  };
  assert.deepEqual(
    runs.runs.map((run) => [run.status, run.delivery_status]),
    [["delivering", "pending"]],
  );
  const period = (
    await pool.query(
      `SELECT time_zone,(now() AT TIME ZONE time_zone)::date::text AS today,
         ((now() AT TIME ZONE time_zone)::date+1)::text AS tomorrow FROM workspaces WHERE id=$1`,
      [workspaceId],
    )
  ).rows[0];
  const query = new URLSearchParams({
    from: period.today,
    before: period.tomorrow,
    expected_time_zone: period.time_zone,
    flow_id: flow,
  });
  const report = await request("GET", `/api/reports/flow-runs?${query}`);
  assert.equal(report.status, 200);
  const counts = ((await report.json()) as { reply_counts: Record<string, string> }).reply_counts;
  assert.equal(counts.pending, "1");
  assert.equal(counts.absent, "0");
});

test("a keyword match beats the default reply, the oldest matching keyword flow wins, and the default answers the rest", async () => {
  const fallback = await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "We will get back to you"));
  const price = await enabledFlow(dmDocument({ type: "instagram_dm_keyword", keywords: ["price"] }, "Prices"));
  await enabledFlow(dmDocument({ type: "instagram_dm_keyword", keywords: ["shipping"] }, "Shipping"));
  await dm("9101", "price and shipping please", { id: "a" });
  await dm("9102", "hello there", { id: "b" });
  const rows = await started();
  assert.deepEqual(
    rows.map((row) => [row.message_id, row.flow_id, row.trigger_type, row.message_text]),
    [
      ["a", price, "instagram_dm_keyword", "Prices"],
      ["b", fallback, "instagram_dm_default", "We will get back to you"],
    ],
  );
  assert.equal((await pool.query("SELECT count(*) FROM flow_runs")).rows[0].count, "2");
});

test("an all keyword trigger answers every DM but its excluded keywords, which fall to the default reply", async () => {
  const fallback = await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Default"));
  const draft = dmDocument({ type: "instagram_dm_keyword", keywords: [], mode: "all" }, "All");
  (draft.nodes[0]!.config as { excluded_keywords: string[] }).excluded_keywords = ["refund"];
  const all = await enabledFlow(draft);
  await dm("9111", "hello", { id: "a" });
  await dm("9112", "I want a refund", { id: "b" });
  assert.deepEqual(
    (await started()).map((row) => [row.message_id, row.flow_id]),
    [
      ["a", all],
      ["b", fallback],
    ],
  );
});

test("a redelivered DM, a disabled flow, a postback and a sender ID the tables cannot store start nothing", async () => {
  const flow = await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9103", "hello", { id: "same" });
  await dm("9103", "hello", { id: "same" });
  await ingestMessages(pool, [
    { accountId: "owned-account", senderId: "9103", messageId: "same", text: "hello", timestamp: new Date() },
    { accountId: "owned-account", senderId: "9104", messageId: "same", text: "hello", timestamp: new Date() },
  ]);
  assert.equal((await started()).length, 1);
  await dm("9105", "hello", { postback: "1" });
  await dm("9".repeat(41), "hello");
  assert.equal((await started()).length, 1);
  assert.equal((await request("POST", `/api/flows/${flow}/disable`)).status, 200);
  await dm("9106", "hello");
  assert.equal((await started()).length, 1);
});

test("an attachment, an unsupported message and a withdrawal start nothing, while a typed DM with an attachment does (#20)", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  const at = new Date(Date.now() + 1000);
  const base = { accountId: "owned-account", text: "", timestamp: at };
  await ingestMessages(pool, [
    { ...base, senderId: "9201", messageId: "a1", content: "attachment", attachments: [{ type: "image" }] },
    { ...base, senderId: "9202", messageId: "u1", content: "unsupported" },
    { ...base, senderId: "9203", messageId: "d1", content: "deleted" },
  ]);
  assert.deepEqual(await started(), []);
  // The withdrawal is not a DM: it opens no window and counts no active contact. The other two do both.
  const inbound = await pool.query("SELECT recipient_id FROM instagram_dm_last_inbound ORDER BY recipient_id");
  assert.deepEqual(
    inbound.rows.map((row) => row.recipient_id),
    ["9201", "9202"],
  );
  const counted = await pool.query("SELECT count(*)::int AS count FROM active_contacts");
  assert.equal(counted.rows[0].count, 2);
  await ingestMessages(pool, [{ ...base, senderId: "9204", messageId: "t1", text: "사진이에요", attachments: [{ type: "image" }] }]);
  assert.deepEqual(
    (await started()).map((row) => row.sender_id),
    ["9204"],
  );
});

test("an original that arrives after its withdrawal starts nothing on a connection that stores the inbox (#20)", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await pool.query("UPDATE instagram_connections SET inbox_enabled=true,inbox_enabled_at=now()-interval '1 day' WHERE id=$1", [connectionId]);
  const at = new Date(Date.now() + 1000);
  await ingestMessages(pool, [{ accountId: "owned-account", senderId: "9301", messageId: "late", text: "", timestamp: at, content: "deleted" }]);
  await dm("9301", "취소한 말", { id: "late", at });
  await dm("9302", "다른 말", { at });
  assert.deepEqual(
    (await started()).map((row) => row.sender_id),
    ["9302"],
  );
});

test("a DM that the reply wait takes starts nothing, also when it is delivered again", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  const flow = await createFlow({
    schema_version: 1,
    nodes: [
      {
        id: "start",
        type: "instagram_comment",
        config: {
          connection_id: connectionId,
          media_id: "1789",
          keywords: ["size"],
          match_mode: "contains",
          excluded_keywords: [],
        },
      },
      { id: "ask", type: "instagram_message", config: { text: "Which size?" } },
      { id: "wait", type: "wait_for_reply", config: { timeout_minutes: 60 } },
    ],
    edges: [
      { from: "start", port: "next", to: "ask" },
      { from: "ask", port: "next", to: "wait" },
    ],
  });
  assert.equal((await request("POST", `/api/flows/${flow}/publish`, { expected_revision: 0 })).status, 201);
  assert.equal((await request("POST", `/api/flows/${flow}/enable`)).status, 200);
  await ingestComments(pool, [{ accountId: "owned-account", commentId: "c1", postId: "1789", senderId: "123", text: "size" }]);
  const transport: PrivateReplyTransport = {
    verify: async () => ({ commentCreatedAt: new Date(), authorizationVerified: true, mediaOwned: true }),
    send: async () => ({ messageId: "mid-c1", recipientId: "9200" }),
  };
  assert.equal(await processNextPrivateReply(pool, transport, () => new Date(), connectionId), true);
  // A DM dated before the reply was sent cannot answer the wait, and the run that waits blocks the trigger.
  await dm("9200", "early", { at: new Date(Date.now() - 60_000) });
  assert.equal((await started()).length, 0);
  await dm("9200", "XL", { id: "answer" });
  assert.equal((await pool.query("SELECT status FROM flow_runs WHERE event_id IS NOT NULL")).rows[0].status, "ended");
  await dm("9200", "XL", { id: "answer" });
  assert.equal((await started()).length, 0);
  // Once nothing is waiting for this person, a new DM starts the default reply.
  await dm("9200", "thanks");
  assert.equal((await started()).length, 1);
});

test("a follow confirmation takes its DM, and a pending confirmation blocks the trigger", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  const reply = await sentReply("9300", true);
  await pool.query(
    `INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text,status)
     VALUES($1,$2,'9300','ok','yes','no','waiting')`,
    [reply, connectionId],
  );
  await dm("9300", "something else");
  await dm("9300", "OK", { id: "confirm" });
  assert.equal((await pool.query("SELECT status FROM instagram_follow_conversations")).rows[0].status, "pending");
  await dm("9300", "OK", { id: "confirm" });
  assert.equal((await started()).length, 0);
  // A finished confirmation no longer blocks the person.
  await pool.query("UPDATE instagram_follow_conversations SET status='sent'");
  await dm("9300", "hello again");
  assert.equal((await started()).length, 1);
});

test("a read of a sent reply neither starts a DM flow nor answers a follow confirmation (#312)", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  const gated = await sentReply("9300", true);
  await pool.query(
    `INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text,status)
     VALUES($1,$2,'9300','ok','yes','no','waiting')`,
    [gated, connectionId],
  );
  await sentReply("9400");
  const read = (reader: string) => ({
    sender: { id: reader },
    recipient: { id: "owned-account" },
    timestamp: Date.now() + 1000,
    read: { mid: `mid-${reader}` },
  });
  const body = new TextEncoder().encode(
    JSON.stringify({
      object: "instagram",
      entry: [{ id: "owned-account", time: Date.now(), messaging: [read("9300"), read("9400")] }],
    }),
  );
  // The calls of the webhook ingress, in its order.
  await ingestMessages(pool, partitionInstagramEvents(instagramAdapter.decodeWebhook(body)).messages);
  await ingestMessageReads(pool, parseMessageReadEvents(body));
  assert.deepEqual((await pool.query("SELECT recipient_id FROM instagram_message_reads ORDER BY 1")).rows, [{ recipient_id: "9300" }, { recipient_id: "9400" }]);
  assert.equal((await started()).length, 0);
  assert.equal((await pool.query("SELECT status FROM instagram_follow_conversations")).rows[0].status, "waiting");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_message_receipts")).rows[0].count, 0);
  // A DM from the same people reaches both paths, so the fixture can produce the states the read did not.
  await dm("9400", "hello");
  assert.equal((await started()).length, 1);
  await dm("9300", "OK");
  assert.equal((await pool.query("SELECT status FROM instagram_follow_conversations")).rows[0].status, "pending");
});

// #291: ingestion accepts a DM dated up to 60 seconds ahead, so a DM can start a DM trigger flow before a private
// reply to its sender is recorded as sent. When Meta then delivers the same message ID again, the reply's follow
// confirmation, reply wait and kept-DM store would otherwise all accept it.
test("a redelivered DM that started a DM flow is taken by neither the follow confirmation nor the kept-DM store", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  const at = new Date(Date.now() + 50_000);
  await dm("9500", "OK", { id: "started", at });
  assert.equal((await started()).length, 1);
  // Sent a minute ago, so the follow confirmation accepts a DM dated `at`.
  const reply = await sentReply("9500", true);
  await pool.query(
    `INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text,status)
     VALUES($1,$2,'9500','ok','yes','no','waiting')`,
    [reply, connectionId],
  );
  // A reply of the connection in `sending` makes ingestion keep a DM that nothing took.
  const sending = await sentReply("9501");
  await pool.query(
    `UPDATE private_reply_outbox SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now(),
       provider_message_id=NULL,recipient_id=NULL,sent_at=NULL WHERE id=$1`,
    [sending],
  );
  await dm("9500", "OK", { id: "started", at });
  assert.equal((await pool.query("SELECT 1 FROM instagram_message_receipts")).rowCount, 0);
  assert.equal((await pool.query("SELECT status FROM instagram_follow_conversations")).rows[0].status, "waiting");
  assert.equal((await pool.query("SELECT 1 FROM instagram_unmatched_replies")).rowCount, 0);
  assert.equal((await started()).length, 1);
  // Another message ID from the same sender is still taken and kept as before.
  await dm("9500", "OK", { id: "confirm", at });
  assert.deepEqual(
    (await pool.query("SELECT message_id FROM instagram_message_receipts")).rows.map((row) => row.message_id),
    ["confirm"],
  );
  assert.equal((await pool.query("SELECT status FROM instagram_follow_conversations")).rows[0].status, "pending");
  await dm("9500", "later", { id: "kept", at });
  assert.deepEqual(
    (await pool.query("SELECT message_id FROM instagram_unmatched_replies")).rows.map((row) => row.message_id),
    ["kept"],
  );
  assert.equal((await started()).length, 1);
});

test("a redelivered DM that started a DM flow does not answer a reply wait", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  const at = new Date(Date.now() + 50_000);
  await dm("9600", "XL", { id: "started", at });
  assert.equal((await started()).length, 1);
  const flow = await createFlow({
    schema_version: 1,
    nodes: [
      {
        id: "start",
        type: "instagram_comment",
        config: {
          connection_id: connectionId,
          media_id: "1789",
          keywords: ["size"],
          match_mode: "contains",
          excluded_keywords: [],
        },
      },
      { id: "ask", type: "instagram_message", config: { text: "Which size?" } },
      { id: "wait", type: "wait_for_reply", config: { timeout_minutes: 60 } },
    ],
    edges: [
      { from: "start", port: "next", to: "ask" },
      { from: "ask", port: "next", to: "wait" },
    ],
  });
  assert.equal((await request("POST", `/api/flows/${flow}/publish`, { expected_revision: 0 })).status, 201);
  assert.equal((await request("POST", `/api/flows/${flow}/enable`)).status, 200);
  await ingestComments(pool, [{ accountId: "owned-account", commentId: "c1", postId: "1789", senderId: "123", text: "size" }]);
  const transport: PrivateReplyTransport = {
    verify: async () => ({ commentCreatedAt: new Date(), authorizationVerified: true, mediaOwned: true }),
    send: async () => ({ messageId: "mid-c1", recipientId: "9600" }),
  };
  assert.equal(await processNextPrivateReply(pool, transport, () => new Date(), connectionId), true);
  const waitingRun = "SELECT status,reply_message_id FROM flow_runs WHERE event_id IS NOT NULL";
  assert.deepEqual((await pool.query(waitingRun)).rows, [{ status: "awaiting_reply", reply_message_id: null }]);
  await dm("9600", "XL", { id: "started", at });
  assert.deepEqual((await pool.query(waitingRun)).rows, [{ status: "awaiting_reply", reply_message_id: null }]);
  // Another message ID from the same sender still answers the wait.
  await dm("9600", "XL", { id: "answer", at });
  assert.deepEqual((await pool.query(waitingRun)).rows, [{ status: "ended", reply_message_id: "answer" }]);
  assert.equal((await started()).length, 1);
});

// Runs the first delivery of a message through ingestMessages and holds its transaction just before COMMIT, after the
// start event was written, until `release` is called.
function deliveryHeldBeforeCommit(message: InstagramMessage) {
  let reached!: () => void;
  let release!: () => void;
  const atCommit = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const connect = async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (text: string, values?: unknown[]) => {
            if (text === "COMMIT") {
              reached();
              await released;
            }
            return target.query(text, values);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const done = ingestMessages({ connect } as unknown as Pool, [message]);
  return { done, atCommit, release };
}

async function waitForMessageLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%instagram-message:%'");
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("the redelivery did not wait for the message lock");
}

// With inbox storage off no conversation lock serializes the two deliveries; the message lock does. The reply is
// recorded as sent and its follow confirmation starts waiting while the first delivery is uncommitted, so the
// redelivery would otherwise miss the uncommitted start event and take the message.
test("a concurrent redelivery waits for the delivery that started a DM flow and is not taken", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  const message: InstagramMessage = {
    accountId: "owned-account",
    senderId: "9700",
    messageId: "started",
    text: "OK",
    timestamp: new Date(Date.now() + 50_000),
  };
  const first = deliveryHeldBeforeCommit(message);
  let redelivery: Promise<void> | undefined;
  try {
    await Promise.race([first.atCommit, first.done.then(() => assert.fail("the first delivery did not reach COMMIT"))]);
    const reply = await sentReply("9700", true);
    await pool.query(
      `INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text,status)
       VALUES($1,$2,'9700','ok','yes','no','waiting')`,
      [reply, connectionId],
    );
    redelivery = ingestMessages(pool, [message]);
    await waitForMessageLock();
  } finally {
    first.release();
  }
  await first.done;
  await redelivery;
  assert.equal((await pool.query("SELECT 1 FROM instagram_message_receipts")).rowCount, 0);
  assert.equal((await pool.query("SELECT status FROM instagram_follow_conversations")).rows[0].status, "waiting");
  assert.deepEqual(
    (await started()).map((row) => row.message_id),
    ["started"],
  );
});

// The message locks are taken in key order, not in the batch's order: while another session holds the lower key, a
// batch that lists the higher key first waits on the lower key and holds no message lock yet. Taking them in input
// order would hold the higher key while waiting, and two batches with the same IDs in opposite orders could deadlock.
test("a batch takes its message locks in key order, whatever the order of its messages", async () => {
  const holder = await pool.connect();
  let batch: Promise<void> | undefined;
  try {
    await holder.query("BEGIN");
    const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('instagram-message:owned-account:lock-a',0))");
    const at = new Date();
    batch = ingestMessages(pool, [
      { accountId: "owned-account", senderId: "9800", messageId: "lock-b", text: "b", timestamp: at },
      { accountId: "owned-account", senderId: "9801", messageId: "lock-a", text: "a", timestamp: at },
    ]);
    await waitForMessageLock();
    const held = await pool.query("SELECT count(*)::int AS held FROM pg_locks WHERE locktype='advisory' AND granted AND pid<>$1", [holderPid]);
    assert.equal(held.rows[0].held, 0);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  await batch;
});

test("a kept DM inside its 15-minute window blocks its sender until it is matched or expires", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await pool.query(
    `INSERT INTO instagram_unmatched_replies(workspace_id,connection_id,sender_id,message_id,message_text,message_at)
     VALUES($1,$2,'9400','kept-1','kept text',now())`,
    [workspaceId, connectionId],
  );
  await dm("9400", "hello");
  await dm("9401", "hello");
  assert.deepEqual(
    (await started()).map((row) => row.sender_id),
    ["9401"],
  );
  await pool.query("UPDATE instagram_unmatched_replies SET received_at=now()-interval '16 minutes'");
  await dm("9400", "hello");
  // The kept DM's own message ID never starts a trigger.
  await dm("9400", "kept text", { id: "kept-1" });
  assert.deepEqual(
    (await started()).map((row) => row.sender_id),
    ["9401", "9400"],
  );
});

test("an opted-out messaging identity and a handed-off conversation start nothing", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await recordChannelConsentEvent(pool, {
    requestKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId,
    connectionId,
    channel: "instagram",
    identityKind: "dm_recipient",
    identityValue: "9500",
    purpose: "service_reply",
    decision: "revoke",
    evidenceKind: "explicit",
    evidenceReference: "test:stop",
    occurredAt: new Date(),
    actorId: userId,
  });
  const reply = await sentReply("9501");
  await pool.query("INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id) VALUES($1,$2,'123')", [workspaceId, connectionId]);
  await pool.query(
    `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
     VALUES($1,$2,'9501','123',$3,true,1,$4)`,
    [workspaceId, connectionId, reply, userId],
  );
  await dm("9500", "hello");
  await dm("9501", "hello");
  assert.equal((await started()).length, 0);
  await pool.query("UPDATE instagram_inbox_handoffs SET active=false,version=2");
  await dm("9501", "hello");
  assert.deepEqual(
    (await started()).map((row) => row.sender_id),
    ["9501"],
  );
});

function revoke(identityKind: "comment_sender" | "dm_recipient", identityValue: string) {
  return recordChannelConsentEvent(pool, {
    requestKey: crypto.randomUUID(),
    workspaceId,
    connectionId,
    channel: "instagram",
    identityKind,
    identityValue,
    purpose: "service_reply",
    decision: "revoke",
    evidenceKind: "explicit",
    evidenceReference: "test:stop",
    occurredAt: new Date(),
    actorId: userId,
  });
}

test("a comment sender's revoke blocks the messaging ID a provider-acknowledged reply bridged to it", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await revoke("comment_sender", "123");
  await sentReply("9701");
  // A reply that Meta never acknowledged is no bridge, so its recipient is not the comment sender's.
  const unacknowledged = await sentReply("9704");
  await pool.query("UPDATE private_reply_outbox SET status='unknown',provider_message_id=NULL,sent_at=NULL WHERE id=$1", [unacknowledged]);
  await dm("9701", "hello");
  await dm("9704", "hello");
  await dm("9799", "hello");
  assert.deepEqual(
    (await started()).map((row) => row.sender_id),
    ["9704", "9799"],
  );
});

test("a DM recipient's revoke blocks another messaging ID bridged to the same comment sender", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await revoke("dm_recipient", "9702");
  await sentReply("9702");
  await sentReply("9703");
  await dm("9703", "hello");
  assert.equal((await started()).length, 0);
});

test("no claim of another send path, worker or resume selects a DM delivery row", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9600", "hello");
  const before = (await pool.query("SELECT * FROM flow_dm_deliveries")).rows;
  assert.equal(before.length, 1);
  assert.equal(await processNextPrivateReply(pool, refusingTransport, () => new Date(), connectionId), false);
  assert.equal(await processNextFollowReply(pool, connectionId, { followStatus: refuse, send: refuse }, () => new Date()), false);
  assert.equal(await processNextCampaignDelivery(pool, connectionId, { send: refuse } as never, null, { globalSendEnabled: true }), false);
  assert.equal(await processNextManualReply(pool, connectionId, null, null), false);
  assert.equal(await resumeDueFlowRuns(pool), 0);
  assert.equal(await reconcileUnmatchedReplies(pool), 0);
  assert.deepEqual((await pool.query("SELECT * FROM flow_dm_deliveries")).rows, before);
  assert.equal((await pool.query("SELECT count(*) FROM private_reply_outbox")).rows[0].count, "0");
});

test("enable and publish refuse a second default reply and overlapping keywords on one connection", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  const second = await createFlow(dmDocument({ type: "instagram_dm_default" }, "Hello"));
  // Publishing a disabled flow is checked against the enabled ones too.
  const published = await request("POST", `/api/flows/${second}/publish`, { expected_revision: 0 });
  assert.equal(published.status, 422);
  assert.deepEqual(
    ((await published.json()) as { errors: { code: string }[] }).errors.map((error) => error.code),
    ["dm_default_conflict"],
  );
  const price = await enabledFlow(dmDocument({ type: "instagram_dm_keyword", keywords: ["price"] }, "Prices"));
  const overlapping = await createFlow(dmDocument({ type: "instagram_dm_keyword", keywords: ["price list"], mode: "exact" }, "List"));
  assert.equal((await request("POST", `/api/flows/${overlapping}/publish`, { expected_revision: 0 })).status, 422);
  // A flow published while the other was off cannot be enabled next to it.
  assert.equal((await request("POST", `/api/flows/${price}/disable`)).status, 200);
  const other = await enabledFlow(dmDocument({ type: "instagram_dm_keyword", keywords: ["prices"] }, "More"));
  assert.ok(other);
  const enabled = await request("POST", `/api/flows/${price}/enable`);
  assert.equal(enabled.status, 422);
  assert.deepEqual(
    ((await enabled.json()) as { errors: { code: string }[] }).errors.map((error) => error.code),
    ["dm_keyword_conflict"],
  );
  const versions = await pool.query("SELECT trigger_type,trigger_media_id FROM flow_versions ORDER BY published_at");
  assert.ok(versions.rows.every((row) => row.trigger_media_id === null && row.trigger_type.startsWith("instagram_dm_")));
});

// Security audit #62, fourth pass: starts an enable that holds its transaction after its UPDATE, before the commit,
// and returns the backend that holds the connection lock. Fails instead of hanging the suite if the enable's UPDATE
// text changes and the pause never matches.
async function heldEnable(flowId: string) {
  let reached!: (pid: number) => void;
  const held = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the enable UPDATE was never reached")), 10_000);
    timer.unref();
    reached = (pid) => {
      clearTimeout(timer);
      resolve(pid);
    };
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  const pausing = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: unknown[]) => {
          const result = await client.query(text, values);
          if (!paused && /^UPDATE flows SET enabled=\$3/.test(text)) {
            paused = true;
            reached((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
            await gate;
          }
          return result;
        },
        release: (destroy?: boolean | Error) => client.release(destroy),
      };
    },
  } as unknown as Pool;
  const enable = request("POST", `/api/flows/${flowId}/enable`, undefined, pausing);
  // An enable that fails before the pause must not leave the caller waiting for the full timeout.
  enable.catch(() => undefined);
  return { enable, holder: await held, release };
}

// Waits until another backend waits for `holder` on the connection row, and fails if `other` settles first or the
// wait never shows, so the test cannot pass without the connection lock.
async function waitsOnConnectionLock(holder: number, other: Promise<unknown>) {
  let settled = false;
  void other.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let attempt = 0; attempt < 250; attempt++) {
    assert.equal(settled, false, "the second request finished without waiting for the connection lock");
    const waiting = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query ~ 'FROM instagram_connections'`,
      [holder],
    );
    if (waiting.rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("the second request never waited for the connection lock");
}

// Security audit #62, fourth pass: two enables of different default-reply flows lock different flow rows, so only the
// connection lock serializes them. The second enable must wait for the first one on the connection and then see its
// commit.
test("concurrent enables of two default-reply flows on one connection leave one enabled", async () => {
  const first = await createFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  const second = await createFlow(dmDocument({ type: "instagram_dm_default" }, "Hello"));
  for (const id of [first, second]) assert.equal((await request("POST", `/api/flows/${id}/publish`, { expected_revision: 0 })).status, 201);
  const { enable: firstEnable, holder, release } = await heldEnable(first);
  let secondEnable: Promise<Response> | undefined;
  try {
    secondEnable = request("POST", `/api/flows/${second}/enable`);
    await waitsOnConnectionLock(holder, secondEnable);
  } finally {
    release();
    await Promise.allSettled([firstEnable, ...(secondEnable ? [secondEnable] : [])]);
  }
  assert.deepEqual([(await firstEnable).status, (await secondEnable).status], [200, 422]);
  assert.deepEqual(
    (await pool.query("SELECT id::text FROM flows WHERE enabled")).rows.map((row) => row.id),
    [first],
  );
});

// Security audit #62, fourth pass: publishing a disabled keyword flow takes the same connection lock as enabling, so a
// publish that overlaps an enable still in flight waits for it and is refused once that enable commits.
test("a publish that overlaps an enable in flight waits for it and is refused", async () => {
  const enabling = await createFlow(dmDocument({ type: "instagram_dm_keyword", keywords: ["price"] }, "Prices"));
  assert.equal((await request("POST", `/api/flows/${enabling}/publish`, { expected_revision: 0 })).status, 201);
  const overlapping = await createFlow(dmDocument({ type: "instagram_dm_keyword", keywords: ["price list"], mode: "exact" }, "List"));
  const { enable, holder, release } = await heldEnable(enabling);
  let publish: Promise<Response> | undefined;
  try {
    publish = request("POST", `/api/flows/${overlapping}/publish`, { expected_revision: 0 });
    await waitsOnConnectionLock(holder, publish);
  } finally {
    release();
    await Promise.allSettled([enable, ...(publish ? [publish] : [])]);
  }
  assert.equal((await enable).status, 200);
  const refused = await publish;
  assert.equal(refused.status, 422);
  assert.deepEqual(
    ((await refused.json()) as { errors: { code: string }[] }).errors.map((error) => error.code),
    ["dm_keyword_conflict"],
  );
});

// Security audit #62, fourth pass: a DM starts only flows whose trigger names the connection that received it, even
// when another connection of the same workspace has an enabled default reply.
test("a DM starts only the flows of the connection that received it", async () => {
  const otherConnection = "66666666-6666-4666-8666-666666666666";
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,access_token_encrypted)
     VALUES($1,$2,'other-account',true,true,'token')`,
    [otherConnection, workspaceId],
  );
  const document = dmDocument({ type: "instagram_dm_default" }, "Other account");
  // The cast only names the mutable shape; `tsc` with parallel checkers reported this assignment as read-only.
  (document.nodes[0]!.config as { connection_id: string }).connection_id = otherConnection;
  const other = await enabledFlow(document);
  await dm("9800", "hello");
  assert.deepEqual(await started(), []);
  await ingestMessages(pool, [{ accountId: "other-account", senderId: "9800", messageId: "in-other", text: "hello", timestamp: new Date() }]);
  assert.deepEqual(
    (await started()).map((row) => [row.flow_id, row.message_id, row.recipient_id]),
    [[other, "in-other", "9800"]],
  );
});

test("person, connection and workspace deletion remove the DM start events, runs and delivery rows", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9700", "hello");
  await dm("9701", "hello");
  const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  const person = (await pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','9700') AS result", [workspaceId, connectionId, userId])).rows[0].result;
  assert.equal(person.deleted_counts.instagram_dm_start_events, 1);
  assert.equal(person.deleted_counts.flow_runs, 1);
  assert.equal(person.deleted_counts.flow_step_runs, 2);
  assert.equal(person.deleted_counts.flow_dm_deliveries, 1);
  assert.deepEqual(
    (await started()).map((row) => row.sender_id),
    ["9701"],
  );
  // A comment-sender deletion of the same digits does not reach the messaging identity.
  await pool.query("SELECT public.delete_person_data($1,$2,$3,'comment_sender','9701')", [workspaceId, connectionId, userId]);
  assert.equal(await count("instagram_dm_start_events"), 1);
  await pool.query("UPDATE flows SET enabled=false");
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL");
  const connection = (await pool.query("SELECT public.delete_connection_data($1,$2,$3,'owned-account') AS result", [workspaceId, connectionId, userId])).rows[0].result;
  assert.equal(connection.deleted_counts.instagram_dm_start_events, 1);
  assert.equal(connection.deleted_counts.flow_dm_deliveries, 1);
  for (const table of ["instagram_dm_start_events", "flow_dm_deliveries", "flow_runs"]) assert.equal(await count(table), 0);
  const workspace = (await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspaceId, userId])).rows[0].result;
  assert.equal(workspace.deleted_counts.instagram_dm_start_events, 0);
});

test("migration 068 replays over stored rows, keeps the canonical deletion functions and runs in the runner", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9800", "hello");
  const definitions = async () => (await pool.query("SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('delete_person_data','delete_connection_data','delete_workspace_data') ORDER BY proname")).rows;
  const canonical = await definitions();
  for (const { definition } of canonical) assert.match(definition, /flow_dm_deliveries/);
  const sql = await readFile(new URL("../../db/migrations/068_dm_start_triggers.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  // Migrations 069 (#291), 070 (#312), 071 (#321) and 072 (#300) redefine the three deletion functions; 072 holds the latest body.
  await pool.query(await readFile(new URL("../../db/migrations/069_dm_flow_delivery.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/070_instagram_message_reads.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/071_instagram_follow_messages.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/072_instagram_dm_last_inbound.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/076_instagram_dm_profiles.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/077_active_contacts.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/078_active_contact_deletion_counts.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/080_api_keys.sql", import.meta.url), "utf8"));
  assert.deepEqual(await definitions(), canonical);
  assert.equal((await started()).length, 1);
  // The source CHECK holds: a run has exactly one of a comment event and a DM start event.
  await assert.rejects(pool.query("UPDATE flow_runs SET dm_start_event_id=NULL"), { code: "23514" });
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(runner.indexOf("068_dm_start_triggers.sql") > runner.indexOf("067_campaign_sweep_recovered_at.sql") && runner.indexOf("068_dm_start_triggers.sql") < runner.indexOf("supabase-access.sql"));
});

// DM start limits (#400): every start event with its skip code, and the run rows that exist.
async function startEvents() {
  return (
    await pool.query(
      `SELECT start.sender_id,start.message_id,start.skip_code,run.id IS NOT NULL AS has_run
       FROM instagram_dm_start_events start LEFT JOIN flow_runs run ON run.dm_start_event_id=start.id
       ORDER BY start.created_at,start.message_id`,
    )
  ).rows;
}

async function runRowCounts() {
  const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  return { runs: await count("flow_runs"), deliveries: await count("flow_dm_deliveries"), steps: await count("flow_step_runs") };
}

// Writes `count` start events of the flow on the connection, one per sender `prefix`N, created `age` ago (an SQL
// interval), with the given skip code. The limits count only these rows, so no run is needed.
async function seedStartEvents(flow: string, count: number, prefix: string, age: string, skipCode: string | null = null, connection = connectionId) {
  await pool.query(
    `INSERT INTO instagram_dm_start_events(workspace_id,connection_id,message_id,sender_id,flow_id,flow_version_id,trigger_type,message_at,created_at,skip_code)
     SELECT $1,$2,'seed-'||$4||n,$4||n,f.id,f.published_version_id,'instagram_dm_default',now(),now()-$5::interval,$6
     FROM flows f CROSS JOIN generate_series(1,$3::int) n WHERE f.id=$7`,
    [workspaceId, connection, count, prefix, age, skipCode, flow],
  );
}

test("a sender starts at most one DM flow per 10 minutes, and a skipped DM writes only its start event", async () => {
  assert.equal(DM_START_SENDER_COOLDOWN_MINUTES, 10);
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9900", "hello", { id: "first" });
  // Another sender is not held by this sender's start.
  await dm("9910", "hello", { id: "other" });
  // The exact boundary is pinned in one transaction by the next test; here the margins leave room for the time
  // between the UPDATE and the ingestion transaction.
  await pool.query("UPDATE instagram_dm_start_events SET created_at=now()-interval '9 minutes 30 seconds' WHERE message_id='first'");
  await dm("9900", "again", { id: "inside" });
  assert.deepEqual(await runRowCounts(), { runs: 2, deliveries: 2, steps: 4 });
  // The skipped DM does not count: 10 minutes or more after the start the next DM starts although the skip is new.
  await pool.query("UPDATE instagram_dm_start_events SET created_at=now()-interval '10 minutes' WHERE message_id='first'");
  await dm("9900", "later", { id: "boundary" });
  assert.deepEqual(
    (await startEvents()).map((row) => [row.message_id, row.skip_code, row.has_run]),
    [
      ["first", null, true],
      ["other", null, true],
      ["inside", "sender_cooldown", false],
      ["boundary", null, true],
    ],
  );
  assert.deepEqual(await runRowCounts(), { runs: 3, deliveries: 3, steps: 6 });
  // A redelivery of the skipped DM writes nothing more.
  await dm("9900", "again", { id: "inside" });
  assert.equal((await startEvents()).length, 4);
});

// The decision reads clock_timestamp(), the clock that writes created_at, not now(), which is fixed at transaction
// start: inside an open transaction a start written 10 minutes before clock_timestamp() no longer counts although now()
// would still count it. The boundaries are then checked against one pinned decision time, so a slow runner cannot move
// a start across them: a start 10 or 60 minutes before it no longer counts, and one second short of either still counts.
test("the limits count a start until 10 and 60 minutes have passed on the clock that wrote it", async () => {
  const flow = await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  const client = await pool.connect();
  const skipCodeNow = async (sender: string) => (await client.query(`SELECT ${dmStartSkipCodeSql("$1::uuid", "$2::text", "decision.decided_at")} AS code FROM (SELECT clock_timestamp() AS decided_at) decision`, [connectionId, sender])).rows[0].code;
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO instagram_dm_start_events(workspace_id,connection_id,message_id,sender_id,flow_id,flow_version_id,trigger_type,message_at,created_at)
       SELECT $1,$2,'pinned-9989','9989',f.id,f.published_version_id,'instagram_dm_default',now(),clock_timestamp()-interval '10 minutes' FROM flows f WHERE f.id=$3`,
      [workspaceId, connectionId, flow],
    );
    assert.equal(await skipCodeNow("9989"), null);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  const decidedAt = (await pool.query<{ at: string }>("SELECT clock_timestamp()::text AS at")).rows[0].at;
  const skipCode = async (sender: string) => (await pool.query(`SELECT ${dmStartSkipCodeSql("$1::uuid", "$2::text", "$3::timestamptz")} AS code`, [connectionId, sender, decidedAt])).rows[0].code;
  const seed = (sender: string, age: string) =>
    pool.query(
      `INSERT INTO instagram_dm_start_events(workspace_id,connection_id,message_id,sender_id,flow_id,flow_version_id,trigger_type,message_at,created_at)
       SELECT $1,$2,'pinned-'||$3,$3,f.id,f.published_version_id,'instagram_dm_default',now(),$4::timestamptz-$5::interval FROM flows f WHERE f.id=$6`,
      [workspaceId, connectionId, sender, decidedAt, age, flow],
    );
  const age = (sender: string, interval: string) => pool.query("UPDATE instagram_dm_start_events SET created_at=$1::timestamptz-$2::interval WHERE sender_id=$3", [decidedAt, interval, sender]);
  await seed("9990", "10 minutes");
  assert.equal(await skipCode("9990"), null);
  await age("9990", "9 minutes 59 seconds");
  assert.equal(await skipCode("9990"), "sender_cooldown");
  await pool.query("DELETE FROM instagram_dm_start_events");
  await pool.query(
    `INSERT INTO instagram_dm_start_events(workspace_id,connection_id,message_id,sender_id,flow_id,flow_version_id,trigger_type,message_at,created_at)
     SELECT $1,$2,'pinned-79'||n,'79'||n,f.id,f.published_version_id,'instagram_dm_default',now(),$3::timestamptz-interval '59 minutes'
     FROM flows f CROSS JOIN generate_series(1,$4::int) n WHERE f.id=$5`,
    [workspaceId, connectionId, decidedAt, DM_START_HOURLY_LIMIT - 1, flow],
  );
  await seed("9991", "60 minutes");
  assert.equal(await skipCode("9992"), null);
  await age("9991", "59 minutes 59 seconds");
  assert.equal(await skipCode("9992"), "connection_hourly_limit");
});

test("a connection starts at most 700 DM flows in the last 60 minutes; older and skipped starts do not count", async () => {
  assert.equal(DM_START_HOURLY_LIMIT, 700);
  const flow = await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await seedStartEvents(flow, 699, "71", "59 minutes");
  await seedStartEvents(flow, 50, "72", "61 minutes");
  await seedStartEvents(flow, 50, "73", "1 minute", "connection_hourly_limit");
  await seedStartEvents(flow, 50, "74", "1 minute", "sender_cooldown");
  await dm("9920", "hello", { id: "700th" });
  await dm("9921", "hello", { id: "701st" });
  // Another connection keeps its own limit.
  const otherConnection = "66666666-6666-4666-8666-666666666666";
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,access_token_encrypted)
     VALUES($1,$2,'other-account',true,true,'token')`,
    [otherConnection, workspaceId],
  );
  const document = dmDocument({ type: "instagram_dm_default" }, "Other");
  (document.nodes[0]!.config as { connection_id: string }).connection_id = otherConnection;
  await enabledFlow(document);
  await ingestMessages(pool, [{ accountId: "other-account", senderId: "9921", messageId: "other-connection", text: "hello", timestamp: new Date() }]);
  // A start that leaves the 60-minute window makes room for one more.
  await pool.query("UPDATE instagram_dm_start_events SET created_at=now()-interval '60 minutes' WHERE message_id='seed-711'");
  await dm("9922", "hello", { id: "after-room" });
  await dm("9923", "hello", { id: "full-again" });
  const events = new Map((await startEvents()).map((row) => [row.message_id, [row.skip_code, row.has_run]]));
  assert.deepEqual(
    ["700th", "701st", "other-connection", "after-room", "full-again"].map((id) => events.get(id)),
    [
      [null, true],
      ["connection_hourly_limit", false],
      [null, true],
      [null, true],
      ["connection_hourly_limit", false],
    ],
  );
  assert.equal((await runRowCounts()).runs, 3);
});

test("a sender's cooldown wins over the connection limit when both apply", async () => {
  const flow = await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9930", "hello", { id: "first" });
  await seedStartEvents(flow, 699, "75", "1 minute");
  await dm("9930", "hello", { id: "second" });
  assert.equal((await startEvents()).find((row) => row.message_id === "second")?.skip_code, "sender_cooldown");
});

// The two deliveries hold different message IDs, so only the sender lock orders them: the second one waits for the
// first one's commit and then sees its start event.
test("two concurrent DMs of one sender start exactly one run", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  const at = new Date();
  const first = deliveryHeldBeforeCommit({ accountId: "owned-account", senderId: "9940", messageId: "concurrent-1", text: "hi", timestamp: at });
  let second: Promise<void> | undefined;
  try {
    await Promise.race([first.atCommit, first.done.then(() => assert.fail("the first delivery did not reach COMMIT"))]);
    second = ingestMessages(pool, [{ accountId: "owned-account", senderId: "9940", messageId: "concurrent-2", text: "hi", timestamp: at }]);
    await waitForSenderLock();
  } finally {
    first.release();
  }
  await first.done;
  await second;
  assert.deepEqual(
    (await startEvents()).map((row) => [row.message_id, row.skip_code, row.has_run]),
    [
      ["concurrent-1", null, true],
      ["concurrent-2", "sender_cooldown", false],
    ],
  );
  assert.deepEqual(await runRowCounts(), { runs: 1, deliveries: 1, steps: 2 });
});

async function waitForSenderLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%dm-start-sender:%'");
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("the second delivery did not wait for the sender lock");
}

test("a resumable run, an opt-out, a handoff and a kept DM still block first and write no skip row", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9950", "hello", { id: "opt-start" });
  await dm("9951", "hello", { id: "handoff-start" });
  await dm("9952", "hello", { id: "kept-start" });
  await dm("9953", "hello", { id: "waiting-start" });
  await pool.query("UPDATE flow_runs SET status='waiting',resume_at=now()+interval '1 hour',resume_node_id='reply' FROM instagram_dm_start_events start WHERE start.id=flow_runs.dm_start_event_id AND start.sender_id='9953'");
  await revoke("dm_recipient", "9950");
  const reply = await sentReply("9951");
  await pool.query("INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id) VALUES($1,$2,'123')", [workspaceId, connectionId]);
  await pool.query(
    `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
     VALUES($1,$2,'9951','123',$3,true,1,$4)`,
    [workspaceId, connectionId, reply, userId],
  );
  await pool.query(
    `INSERT INTO instagram_unmatched_replies(workspace_id,connection_id,sender_id,message_id,message_text,message_at)
     VALUES($1,$2,'9952','kept-9952','kept text',now())`,
    [workspaceId, connectionId],
  );
  await dm("9950", "hello", { id: "opt-blocked" });
  await dm("9951", "hello", { id: "handoff-blocked" });
  await dm("9952", "hello", { id: "kept-blocked" });
  await dm("9953", "hello", { id: "waiting-blocked" });
  assert.deepEqual(
    (await startEvents()).map((row) => row.message_id),
    ["opt-start", "handoff-start", "kept-start", "waiting-start"],
  );
});

test("a DM that the reply wait takes writes no skip row while both limits apply to its sender", async () => {
  const dmFlow = await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9954", "hello", { id: "wait-start" });
  await seedStartEvents(dmFlow, DM_START_HOURLY_LIMIT - 1, "79", "1 minute");
  const flow = await createFlow({
    schema_version: 1,
    nodes: [
      {
        id: "start",
        type: "instagram_comment",
        config: { connection_id: connectionId, media_id: "1789", keywords: ["size"], match_mode: "contains", excluded_keywords: [] },
      },
      { id: "ask", type: "instagram_message", config: { text: "Which size?" } },
      { id: "wait", type: "wait_for_reply", config: { timeout_minutes: 60 } },
    ],
    edges: [
      { from: "start", port: "next", to: "ask" },
      { from: "ask", port: "next", to: "wait" },
    ],
  });
  assert.equal((await request("POST", `/api/flows/${flow}/publish`, { expected_revision: 0 })).status, 201);
  assert.equal((await request("POST", `/api/flows/${flow}/enable`)).status, 200);
  await ingestComments(pool, [{ accountId: "owned-account", commentId: "c-limits", postId: "1789", senderId: "124", text: "size" }]);
  const transport: PrivateReplyTransport = {
    verify: async () => ({ commentCreatedAt: new Date(), authorizationVerified: true, mediaOwned: true }),
    send: async () => ({ messageId: "mid-limits", recipientId: "9954" }),
  };
  assert.equal(await processNextPrivateReply(pool, transport, () => new Date(), connectionId), true);
  // Both limits apply to 9954 now: its own start is inside the cooldown and the connection holds 700 starts.
  await dm("9954", "XL", { id: "answer" });
  const waited = (await pool.query("SELECT status,reply_message_id FROM flow_runs WHERE flow_id=$1", [flow])).rows;
  assert.deepEqual(waited, [{ status: "ended", reply_message_id: "answer" }]);
  assert.equal((await pool.query("SELECT 1 FROM instagram_dm_start_events WHERE message_id='answer'")).rowCount, 0);
  // With nothing waiting any more, the next DM of 9954 reaches the limits and is skipped.
  await dm("9954", "thanks", { id: "after-wait" });
  assert.equal((await startEvents()).find((row) => row.message_id === "after-wait")?.skip_code, "sender_cooldown");
});

test("operations health counts the skipped DM starts of the last 24 hours by code", async () => {
  const flow = await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9960", "hello");
  await dm("9960", "hello");
  await seedStartEvents(flow, 3, "76", "23 hours", "connection_hourly_limit");
  await seedStartEvents(flow, 2, "77", "25 hours", "connection_hourly_limit");
  await seedStartEvents(flow, 2, "78", "25 hours", "sender_cooldown");
  const [metrics] = await connectionMetrics(pool, workspaceId);
  assert.deepEqual([metrics!.dm_start_cooldown_24h, metrics!.dm_start_hourly_limit_24h], [1, 3]);
  const health = (await (await request("GET", "/api/workspace/health")).json()) as { connections: Record<string, unknown>[] };
  assert.deepEqual([health.connections[0]!.dm_start_cooldown_24h, health.connections[0]!.dm_start_hourly_limit_24h], [1, 3]);
});

test("deletion removes skipped DM starts, and the export carries their skip code", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9970", "hello", { id: "kept-run" });
  await dm("9970", "hello", { id: "skipped" });
  await dm("9971", "hello", { id: "other-run" });
  await dm("9971", "hello", { id: "other-skipped" });
  const exported = JSON.parse((await exportWorkspace(pool, { id: userId, email: "a@example.test" })).body) as { tables: { instagram_dm_start_events: { message_id: string; skip_code: string | null }[] } };
  assert.deepEqual(exported.tables.instagram_dm_start_events.map((row) => [row.message_id, row.skip_code]).sort(), [
    ["kept-run", null],
    ["other-run", null],
    ["other-skipped", "sender_cooldown"],
    ["skipped", "sender_cooldown"],
  ]);
  const person = (await pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','9970') AS result", [workspaceId, connectionId, userId])).rows[0].result;
  assert.equal(person.deleted_counts.instagram_dm_start_events, 2);
  assert.deepEqual(
    (await startEvents()).map((row) => row.message_id),
    ["other-run", "other-skipped"],
  );
  await pool.query("UPDATE flows SET enabled=false");
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL");
  const connection = (await pool.query("SELECT public.delete_connection_data($1,$2,$3,'owned-account') AS result", [workspaceId, connectionId, userId])).rows[0].result;
  assert.equal(connection.deleted_counts.instagram_dm_start_events, 2);
  assert.equal((await startEvents()).length, 0);
});

test("migration 075 replays over stored rows, keeps the deletion functions and runs in the runner", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9980", "hello", { id: "a" });
  await dm("9980", "hello", { id: "b" });
  const definitions = async () => (await pool.query("SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('delete_person_data','delete_connection_data','delete_workspace_data') ORDER BY proname")).rows;
  const canonical = await definitions();
  const sql = await readFile(new URL("../../db/migrations/075_dm_start_limits.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  assert.deepEqual(await definitions(), canonical);
  assert.deepEqual(
    (await startEvents()).map((row) => row.skip_code),
    [null, "sender_cooldown"],
  );
  await assert.rejects(pool.query("UPDATE instagram_dm_start_events SET skip_code='other'"), { code: "23514" });
  const indexes = (await pool.query("SELECT indexname FROM pg_indexes WHERE tablename='instagram_dm_start_events' AND (indexname LIKE '%started%' OR indexname LIKE '%skipped%') ORDER BY indexname")).rows;
  assert.deepEqual(
    indexes.map((row) => row.indexname),
    ["instagram_dm_start_events_skipped_idx", "instagram_dm_start_events_started_idx", "instagram_dm_start_events_started_sender_idx"],
  );
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(runner.indexOf("075_dm_start_limits.sql") > runner.indexOf("074_comment_sender_username.sql") && runner.indexOf("075_dm_start_limits.sql") < runner.indexOf("supabase-access.sql"));
});
