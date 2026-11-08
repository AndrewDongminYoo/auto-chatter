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

// DM start triggers, PR 1 (#33): a typed DM starts a published DM keyword or default-reply flow, records a start
// event, the run and its first message in flow_dm_deliveries, and sends nothing.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const testUrl = new URL(databaseUrl);
if (!["localhost", "127.0.0.1"].includes(testUrl.hostname) || testUrl.pathname !== "/automations_test")
  throw new Error("TEST_DATABASE_URL must point at the local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const connectionId = "55555555-5555-4555-8555-555555555555";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces,workspace_deletion_records CASCADE");
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

type Trigger =
  | { type: "instagram_dm_keyword"; keywords: string[]; mode?: "contains" | "exact" | "all" }
  | { type: "instagram_dm_default" };

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
  await ingestComments(pool, [
    { accountId: "owned-account", commentId: "c1", postId: "1789", senderId: "123", text: "size" },
  ]);
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
  await ingestComments(pool, [
    { accountId: "owned-account", commentId: "c1", postId: "1789", senderId: "123", text: "size" },
  ]);
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
    const waiting = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%instagram-message:%'",
    );
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
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id) VALUES($1,$2,'123')",
    [workspaceId, connectionId],
  );
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
  await pool.query(
    "UPDATE private_reply_outbox SET status='unknown',provider_message_id=NULL,sent_at=NULL WHERE id=$1",
    [unacknowledged],
  );
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

test("no claim, worker or resume selects a DM delivery row", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9600", "hello");
  const before = (await pool.query("SELECT * FROM flow_dm_deliveries")).rows;
  assert.equal(before.length, 1);
  assert.equal(await processNextPrivateReply(pool, refusingTransport, () => new Date(), connectionId), false);
  assert.equal(
    await processNextFollowReply(pool, connectionId, { followStatus: refuse, send: refuse }, () => new Date()),
    false,
  );
  assert.equal(
    await processNextCampaignDelivery(pool, connectionId, { send: refuse } as never, null, { globalSendEnabled: true }),
    false,
  );
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
  const overlapping = await createFlow(
    dmDocument({ type: "instagram_dm_keyword", keywords: ["price list"], mode: "exact" }, "List"),
  );
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
  assert.ok(
    versions.rows.every((row) => row.trigger_media_id === null && row.trigger_type.startsWith("instagram_dm_")),
  );
});

test("person, connection and workspace deletion remove the DM start events, runs and delivery rows", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9700", "hello");
  await dm("9701", "hello");
  const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  const person = (
    await pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','9700') AS result", [
      workspaceId,
      connectionId,
      userId,
    ])
  ).rows[0].result;
  assert.equal(person.deleted_counts.instagram_dm_start_events, 1);
  assert.equal(person.deleted_counts.flow_runs, 1);
  assert.equal(person.deleted_counts.flow_step_runs, 2);
  assert.equal(person.deleted_counts.flow_dm_deliveries, 1);
  assert.deepEqual(
    (await started()).map((row) => row.sender_id),
    ["9701"],
  );
  // A comment-sender deletion of the same digits does not reach the messaging identity.
  await pool.query("SELECT public.delete_person_data($1,$2,$3,'comment_sender','9701')", [
    workspaceId,
    connectionId,
    userId,
  ]);
  assert.equal(await count("instagram_dm_start_events"), 1);
  await pool.query("UPDATE flows SET enabled=false");
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL");
  const connection = (
    await pool.query("SELECT public.delete_connection_data($1,$2,$3,'owned-account') AS result", [
      workspaceId,
      connectionId,
      userId,
    ])
  ).rows[0].result;
  assert.equal(connection.deleted_counts.instagram_dm_start_events, 1);
  assert.equal(connection.deleted_counts.flow_dm_deliveries, 1);
  for (const table of ["instagram_dm_start_events", "flow_dm_deliveries", "flow_runs"])
    assert.equal(await count(table), 0);
  const workspace = (await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspaceId, userId]))
    .rows[0].result;
  assert.equal(workspace.deleted_counts.instagram_dm_start_events, 0);
});

test("migration 068 replays over stored rows, keeps the canonical deletion functions and runs in the runner", async () => {
  await enabledFlow(dmDocument({ type: "instagram_dm_default" }, "Hi"));
  await dm("9800", "hello");
  const definitions = async () =>
    (
      await pool.query(
        "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('delete_person_data','delete_connection_data','delete_workspace_data') ORDER BY proname",
      )
    ).rows;
  const canonical = await definitions();
  for (const { definition } of canonical) assert.match(definition, /flow_dm_deliveries/);
  const sql = await readFile(new URL("../../db/migrations/068_dm_start_triggers.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  assert.deepEqual(await definitions(), canonical);
  assert.equal((await started()).length, 1);
  // The source CHECK holds: a run has exactly one of a comment event and a DM start event.
  await assert.rejects(pool.query("UPDATE flow_runs SET dm_start_event_id=NULL"), { code: "23514" });
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(
    runner.indexOf("068_dm_start_triggers.sql") > runner.indexOf("067_campaign_sweep_recovered_at.sql") &&
      runner.indexOf("068_dm_start_triggers.sql") < runner.indexOf("supabase-access.sql"),
  );
});
