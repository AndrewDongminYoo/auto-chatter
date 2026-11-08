import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { Pool } from "pg";
import { listFlowRuns } from "../app/flows.ts";
import { connectionMetrics, evaluateAlerts } from "../app/operations-health.ts";
import { resetTestSchema } from "../test-schema.ts";
import { recordChannelConsentEvent } from "./channel-consent.ts";
import {
  assertDmFlowDeliveryAllowed,
  processNextDmFlowDelivery,
  recoverStaleDmFlowDeliveries,
} from "./dm-flow-delivery-worker.ts";
import { InstagramFollowTransport } from "./follow-transport.ts";

// The DM flow delivery worker (#291) against a real PostgreSQL database. Graph is mocked through fetchImpl and
// nothing here reaches Meta.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const W = "11111111-1111-4111-8111-111111111111";
const C = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const owner = "55555555-5555-4555-8555-555555555555";
const TOKEN = "CIPHERTEXT";
let flow: { id: string; version: string } | null = null;
let sequence = 0;

before(async () => resetTestSchema(pool));
beforeEach(async () => {
  mock.restoreAll();
  flow = null;
  await pool.query("TRUNCATE workspaces,workspace_deletion_records,scheduled_steps CASCADE");
  await pool.query("INSERT INTO workspaces(id,time_zone) VALUES($1,'UTC')", [W]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [W, owner]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,access_token_encrypted,token_expires_at)
     VALUES($1,$3,'100',true,true,$4,now()+interval '30 days'),($2,$3,'200',true,true,$4,now()+interval '30 days')`,
    [C, OTHER, W, TOKEN],
  );
});
after(async () => {
  mock.restoreAll();
  await pool.end();
});

// One enabled DM default-reply flow per test, then one start event, run and pending first message per call. The
// start event's message time defaults to a minute ago.
async function dmRow(recipient: string, options: { messageAt?: string; connection?: string; text?: string } = {}) {
  const connection = options.connection ?? C;
  if (!flow) {
    const id = (await pool.query("INSERT INTO flows(workspace_id,name,draft) VALUES($1,'DM','{}') RETURNING id", [W]))
      .rows[0].id;
    const version = (
      await pool.query(
        `INSERT INTO flow_versions(flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_type,published_by)
         VALUES($1,$2,1,0,'{}'::jsonb,$3,'instagram_dm_default',$4) RETURNING id`,
        [id, W, C, owner],
      )
    ).rows[0].id;
    await pool.query("UPDATE flows SET published_version_id=$2,enabled=true WHERE id=$1", [id, version]);
    flow = { id, version };
  }
  sequence++;
  const start = (
    await pool.query(
      `INSERT INTO instagram_dm_start_events(workspace_id,connection_id,message_id,sender_id,flow_id,flow_version_id,trigger_type,message_at)
       VALUES($1,$2,$3,$4,$5,$6,'instagram_dm_default',${options.messageAt ?? "now()-interval '1 minute'"}) RETURNING id`,
      [W, connection, `dm-${sequence}`, recipient, flow.id, flow.version],
    )
  ).rows[0].id;
  const run = (
    await pool.query(
      `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,dm_start_event_id,status)
       VALUES($1,$2,$3,$4,$5,'delivering') RETURNING id`,
      [W, connection, flow.id, flow.version, start],
    )
  ).rows[0].id;
  return (
    await pool.query(
      `INSERT INTO flow_dm_deliveries(workspace_id,connection_id,flow_run_id,recipient_id,message_text)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [W, connection, run, recipient, options.text ?? "Thanks, we will reply soon"],
    )
  ).rows[0].id as string;
}
async function consent(kind: "comment_sender" | "dm_recipient", value: string) {
  await recordChannelConsentEvent(pool, {
    requestKey: randomUUID(),
    workspaceId: W,
    connectionId: C,
    channel: "instagram",
    identityKind: kind,
    identityValue: value,
    purpose: "service_reply",
    decision: "revoke",
    evidenceKind: "explicit",
    evidenceReference: "test",
    occurredAt: new Date(),
    actorId: owner,
  });
}
// A provider-acknowledged private reply from comment sender `sender` that reached messaging ID `recipient`; returns
// the reply's ID.
async function bridge(sender: string, recipient: string): Promise<string> {
  sequence++;
  const event = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,$3,$4,'COMMENT') RETURNING id::text,comment_id,media_id`,
      [W, C, `comment-${sequence}`, sender],
    )
  ).rows[0];
  const rule = (
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text)
       VALUES(gen_random_uuid(),$1,$2,$3,'hello','REPLY') RETURNING id`,
      [W, C, event.media_id],
    )
  ).rows[0].id;
  return (
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,
         private_reply_text,recipient_id,status,provider_message_id,sent_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'REPLY',$8,'sent','acknowledged',now()-interval '1 hour') RETURNING id::text`,
      [W, C, event.id, rule, event.comment_id, event.media_id, sender, recipient],
    )
  ).rows[0].id;
}
const pause = (recipient: string) =>
  pool.query(
    "INSERT INTO instagram_dm_automation(workspace_id,connection_id,recipient_id,paused) VALUES($1,$2,$3,true)",
    [W, C, recipient],
  );
// An active inbox handoff of the messaging ID, on a verified bridge from a comment sender of its own.
async function handoff(recipient: string) {
  const sender = `7${recipient}`;
  const reply = await bridge(sender, recipient);
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,handoff_paused) VALUES($1,$2,$3,true)",
    [W, C, sender],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
     VALUES($1,$2,$3,$4,$5,true,1,$6)`,
    [W, C, recipient, sender, reply, owner],
  );
}
const closeWindow = () =>
  pool.query(
    "UPDATE instagram_dm_start_events SET message_at=now()-interval '25 hours',created_at=now()-interval '25 hours'",
  );

interface Graph {
  posts: { path: string; body: unknown }[];
  gets: string[];
}
interface Options {
  // Answers the POST; the default acknowledges it.
  post?: () => Response;
  // Runs inside the account verification read: after the first guard and before the second.
  onVerify?: () => Promise<void>;
  // The account read: a user_id, a thrown fetch error, or a raw 200 body.
  me?: string | Error | { body: unknown };
  globalSendEnabled?: boolean;
}
const graph = (): Graph => ({ posts: [], gets: [] });
// The Cloudflare composition: InstagramFollowTransport with mocked fetch and the final guard as beforeSend.
function transport(seen: Graph, options: Options = {}, guardPool: Pool = pool) {
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "graph.instagram.com");
    if (init?.method === "POST") {
      seen.posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      return options.post ? options.post() : Response.json({ message_id: `dm-message-${seen.posts.length}` });
    }
    seen.gets.push(url.pathname);
    await options.onVerify?.();
    if (options.me instanceof Error) throw options.me;
    if (typeof options.me === "object") return Response.json(options.me.body);
    return Response.json({ user_id: options.me ?? "100" });
  }) as typeof fetch;
  return new InstagramFollowTransport({
    accountId: "100",
    accessToken: "synthetic",
    graphVersion: "v24.0",
    fetchImpl,
    beforeSend: (context) =>
      assertDmFlowDeliveryAllowed(guardPool, {
        workspaceId: W,
        id: context.replyId,
        attempt: context.attemptId,
        connectionId: C,
        encryptedToken: TOKEN,
        globalSendEnabled: options.globalSendEnabled ?? true,
      }),
  });
}
function deliver(seen: Graph, options: Options = {}, source: Pool = pool) {
  return processNextDmFlowDelivery(source, C, transport(seen, options, source), TOKEN, {
    globalSendEnabled: options.globalSendEnabled ?? true,
  });
}
async function row(id: string) {
  return (
    await pool.query(
      `SELECT status,failure_code,attempt_id IS NOT NULL AS attempted,provider_message_id,sent_at IS NOT NULL AS sent,
         provider_called_at IS NOT NULL AS called,next_attempt_at>clock_timestamp() AS deferred,rate_limit_retries
       FROM flow_dm_deliveries WHERE id=$1`,
      [id],
    )
  ).rows[0];
}
const recipients = (seen: Graph) => seen.posts.map((post) => (post.body as { recipient: { id: string } }).recipient.id);
// A pool that runs `action` once, right after the first pool.query whose text matches `match`.
function hookedPool(match: RegExp, action: () => Promise<unknown>) {
  let done = false;
  return {
    query: async (...args: Parameters<Pool["query"]>) => {
      const result = await (pool.query as (...input: unknown[]) => Promise<unknown>)(...args);
      if (!done && typeof args[0] === "string" && match.test(args[0])) {
        done = true;
        await action();
      }
      return result;
    },
    connect: () => pool.connect(),
  } as unknown as Pool;
}

test("a claimed row is sent once as plain text to its messaging sender ID, and the run keeps its delivery state", async () => {
  const id = await dmRow("9001", { text: "Hello from the flow" });
  const seen = graph();
  assert.equal(await deliver(seen), true);
  assert.deepEqual(seen.posts, [
    { path: "/v24.0/100/messages", body: { recipient: { id: "9001" }, message: { text: "Hello from the flow" } } },
  ]);
  assert.deepEqual(await row(id), {
    status: "sent",
    failure_code: null,
    attempted: true,
    provider_message_id: "dm-message-1",
    sent: true,
    called: true,
    deferred: false,
    rate_limit_retries: 0,
  });
  // The run stays delivering, as a comment run does after its reply; the history reads the row's outcome.
  const [run] = await listFlowRuns(pool, { id: owner, email: "owner@example.test" }, flow!.id);
  assert.equal(run.status, "delivering");
  assert.equal(run.delivery_status, "sent");
  assert.equal(run.delivery_failure_code, null);
  assert.ok(run.sent_at instanceof Date);
  // Nothing is left to claim, and nothing else reached Graph.
  assert.equal(await deliver(seen), false);
  assert.equal(seen.posts.length, 1);
  assert.deepEqual(seen.gets, ["/v24.0/me"]);
});

test("the 24-hour window is anchored on the sender's latest inbound DM and read on the database clock", async () => {
  // A DM dated up to 60 s ahead is accepted at ingestion and must not read as outside the window.
  const ahead = await dmRow("9001", { messageAt: "now()+interval '30 seconds'" });
  const seen = graph();
  assert.equal(await deliver(seen), true);
  assert.equal((await row(ahead)).status, "sent");
  // A start 25 hours old with a later inbox text from the same sender is still inside the window.
  const later = await dmRow("9002", { messageAt: "now()-interval '25 hours'" });
  await pool.query("UPDATE instagram_dm_start_events SET created_at=now()-interval '25 hours' WHERE sender_id='9002'");
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,'9002','inbox-1','again','text',now()-interval '1 hour')`,
    [W, C],
  );
  assert.equal(await deliver(seen), true);
  assert.equal((await row(later)).status, "sent");
  // A postback, another sender's DM and another connection's DM do not move the anchor.
  const stale = await dmRow("9003", { messageAt: "now()-interval '25 hours'" });
  await pool.query("UPDATE instagram_dm_start_events SET created_at=now()-interval '25 hours' WHERE sender_id='9003'");
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,'9003','inbox-2','button','postback',now()),($1,$2,'9004','inbox-3','hi','text',now()),
       ($1,$3,'9003','inbox-4','hi','text',now())`,
    [W, C, OTHER],
  );
  assert.equal(await deliver(seen), true);
  assert.deepEqual(
    [(await row(stale)).status, (await row(stale)).failure_code, (await row(stale)).called],
    ["blocked", "reply_window_closed", false],
  );
  // The history reads the blocked DM row's failure code, not only a private reply's.
  const staleRun = (await pool.query("SELECT flow_run_id FROM flow_dm_deliveries WHERE id=$1", [stale])).rows[0]
    .flow_run_id;
  const run = (await listFlowRuns(pool, { id: owner, email: "owner@example.test" }, flow!.id)).find(
    (entry) => entry.id === staleRun,
  );
  assert.deepEqual([run?.delivery_status, run?.delivery_failure_code], ["blocked", "reply_window_closed"]);
  assert.deepEqual(recipients(seen), ["9001", "9002"]);
});

test("the claim takes the oldest due row and skips deferred, paused, handed-off and other connections' rows", async () => {
  const deferred = await dmRow("9001");
  const paused = await dmRow("9002");
  const handedOff = await dmRow("9003");
  await dmRow("9004", { connection: OTHER });
  const due = await dmRow("9005");
  const oldest = await dmRow("9006");
  await pool.query("UPDATE flow_dm_deliveries SET next_attempt_at=now()+interval '5 minutes' WHERE id=$1", [deferred]);
  await pool.query("UPDATE flow_dm_deliveries SET next_attempt_at=now()-interval '5 minutes' WHERE id=$1", [oldest]);
  await pause("9002");
  await handoff("9003");
  // A pause row that is off holds nothing.
  await pool.query(
    "INSERT INTO instagram_dm_automation(workspace_id,connection_id,recipient_id,paused) VALUES($1,$2,'9005',false)",
    [W, C],
  );
  const seen = graph();
  assert.equal(await deliver(seen), true);
  assert.equal(await deliver(seen), true);
  assert.equal(await deliver(seen), false);
  assert.deepEqual(recipients(seen), ["9006", "9005"]);
  for (const id of [deferred, paused, handedOff]) assert.equal((await row(id)).status, "pending");
  assert.equal((await row(due)).status, "sent");
  // A paused connection is not claimed at all.
  await pool.query("UPDATE instagram_dm_automation SET paused=false");
  await pool.query("UPDATE instagram_connections SET send_paused_until=now()+interval '10 minutes' WHERE id=$1", [C]);
  assert.equal(await deliver(seen), false);
  await pool.query("UPDATE instagram_connections SET send_paused_until=NULL");
  assert.equal(await deliver(seen), true);
  assert.equal((await row(paused)).status, "sent");
});

// Each case changes one recorded condition. Retries go back to pending a minute later with the attempt cleared;
// blocks end the row with its attempt. No case reaches the POST.
const guardCases: Array<{ name: string; change: () => Promise<unknown>; expect: [string, string] }> = [
  { name: "the 24-hour window closed", change: closeWindow, expect: ["blocked", "reply_window_closed"] },
  { name: "the messaging ID was paused", change: () => pause("9001"), expect: ["pending", "contact_paused"] },
  { name: "an inbox handoff started", change: () => handoff("9001"), expect: ["pending", "handoff_active"] },
  {
    name: "the messaging ID opted out",
    change: () => consent("dm_recipient", "9001"),
    expect: ["blocked", "recipient_opted_out"],
  },
  {
    name: "a comment sender bridged to the messaging ID opted out",
    change: async () => {
      await bridge("1001", "9001");
      await consent("comment_sender", "1001");
    },
    expect: ["blocked", "recipient_opted_out"],
  },
  {
    name: "the flow was disabled",
    change: () => pool.query("UPDATE flows SET enabled=false"),
    expect: ["blocked", "inactive_flow"],
  },
  {
    name: "the run was cancelled",
    change: () => pool.query("UPDATE flow_runs SET status='cancelled',failure_code='flow_disabled'"),
    expect: ["blocked", "run_cancelled"],
  },
  {
    name: "the connection was paused",
    change: () => pool.query("UPDATE instagram_connections SET send_paused_until=now()+interval '10 minutes'"),
    expect: ["pending", "connection_paused"],
  },
  {
    name: "the connection's sending was switched off",
    change: () => pool.query("UPDATE instagram_connections SET send_enabled=false"),
    expect: ["blocked", "connection_unavailable"],
  },
  {
    name: "the token expired",
    change: () => pool.query("UPDATE instagram_connections SET token_expires_at=now()-interval '1 second'"),
    expect: ["blocked", "connection_unavailable"],
  },
  {
    name: "the token was rotated",
    change: () => pool.query("UPDATE instagram_connections SET access_token_encrypted='ROTATED'"),
    expect: ["pending", "token_rotated"],
  },
  {
    name: "a block reason wins over a retry reason",
    change: async () => {
      await pause("9001");
      await closeWindow();
    },
    expect: ["blocked", "reply_window_closed"],
  },
];
for (const { name, change, expect } of guardCases)
  test(`the final guard after the claim: ${name}`, async () => {
    const id = await dmRow("9001");
    const seen = graph();
    assert.equal(await deliver(seen, { onVerify: async () => void (await change()) }), true);
    assert.deepEqual(seen.posts, []);
    const state = await row(id);
    assert.deepEqual([state.status, state.failure_code], expect);
    assert.equal(state.attempted, expect[0] !== "pending");
    if (expect[0] === "pending") assert.equal(state.deferred, true);
    assert.equal(state.called, false);
    assert.equal(state.rate_limit_retries, 0);
  });

// The required rechecks immediately before the POST (#291): each change is made after the worker's own guards, when
// it stamps provider_called_at, so only the transport's beforeSend guard can see it.
for (const { name, change, expect } of guardCases.filter((guard) =>
  [
    "the 24-hour window closed",
    "the messaging ID was paused",
    "an inbox handoff started",
    "the messaging ID opted out",
  ].includes(guard.name),
))
  test(`the guard immediately before the POST: ${name}`, async () => {
    const id = await dmRow("9001");
    const seen = graph();
    assert.equal(await deliver(seen, {}, hookedPool(/SET provider_called_at/, change)), true);
    assert.deepEqual(seen.posts, []);
    const state = await row(id);
    assert.deepEqual([state.status, state.failure_code, state.called], [...expect, true]);
    assert.equal(state.attempted, expect[0] !== "pending");
  });

test("with the global send switch off the guard defers without any Graph call", async () => {
  const id = await dmRow("9001");
  const seen = graph();
  assert.equal(await deliver(seen, { globalSendEnabled: false }), true);
  assert.deepEqual(seen, { posts: [], gets: [] });
  assert.deepEqual([(await row(id)).status, (await row(id)).failure_code], ["pending", "global_send_disabled"]);
});

test("a consent read failure defers the row as consent_unavailable", async () => {
  const id = await dmRow("9001");
  const failing = {
    query: async (...args: Parameters<Pool["query"]>) => {
      if (typeof args[0] === "string" && args[0].includes("FROM channel_consent_state state"))
        throw new Error("consent database unavailable");
      return (pool.query as (...input: unknown[]) => Promise<unknown>)(...args);
    },
    connect: () => pool.connect(),
  } as unknown as Pool;
  const seen = graph();
  assert.equal(await deliver(seen, {}, failing), true);
  assert.deepEqual(seen, { posts: [], gets: [] });
  assert.deepEqual([(await row(id)).status, (await row(id)).failure_code], ["pending", "consent_unavailable"]);
});

test("the account check: a mismatch blocks the row and a failed read defers it", async () => {
  const mismatch = await dmRow("9001");
  const seen = graph();
  assert.equal(await deliver(seen, { me: "999" }), true);
  assert.deepEqual(
    [(await row(mismatch)).status, (await row(mismatch)).failure_code],
    ["blocked", "authorization_unverified"],
  );
  const failed = await dmRow("9002");
  assert.equal(await deliver(seen, { me: new Error("network") }), true);
  assert.deepEqual(
    [(await row(failed)).status, (await row(failed)).failure_code],
    ["pending", "verification_unavailable"],
  );
  // A 200 body without a usable user_id is a failed read too, not a mismatch.
  const empty = await dmRow("9003");
  assert.equal(await deliver(seen, { me: { body: {} } }), true);
  assert.deepEqual(
    [(await row(empty)).status, (await row(empty)).failure_code],
    ["pending", "verification_unavailable"],
  );
  assert.deepEqual(seen.posts, []);
});

test("a definite provider rejection fails the row; an ambiguous outcome is unknown and never retried", async () => {
  const rejected = await dmRow("9001");
  const ambiguous = await dmRow("9002");
  const missing = await dmRow("9003");
  const seen = graph();
  assert.equal(
    await deliver(seen, {
      post: () => Response.json({ error: { code: 100, message: "Invalid parameter" } }, { status: 400 }),
    }),
    true,
  );
  assert.equal(await deliver(seen, { post: () => new Response("upstream", { status: 502 }) }), true);
  assert.equal(await deliver(seen, { post: () => Response.json({}) }), true);
  const states = [await row(rejected), await row(ambiguous), await row(missing)].map((state) => [
    state.status,
    state.failure_code,
    state.called,
    state.attempted,
  ]);
  assert.deepEqual(states, [
    ["failed", "meta_error_100", true, true],
    ["unknown", "send_outcome_unknown", true, true],
    ["unknown", "send_outcome_unknown", true, true],
  ]);
  assert.equal(await deliver(seen), false);
  assert.equal(seen.posts.length, 3);
});

test("a rate limit defers the row to the pause end through the retry tiers, then fails it", async () => {
  const id = await dmRow("9001");
  const other = await dmRow("9002");
  const throttled = (headers: Record<string, string> = {}) => ({
    post: () => Response.json({ error: { code: 4, message: "Too many calls" } }, { status: 400, headers }),
  });
  const seen = graph();
  const state = async () =>
    (
      await pool.query(
        `SELECT d.status,d.failure_code,d.attempt_id,d.rate_limit_retries,d.next_attempt_at=c.send_paused_until AS at_pause_end,
           round(extract(epoch FROM c.send_paused_until-clock_timestamp())) AS paused_for
         FROM flow_dm_deliveries d JOIN instagram_connections c ON c.id=d.connection_id WHERE d.id=$1`,
        [id],
      )
    ).rows[0];
  assert.equal(await deliver(seen, throttled({ "retry-after": "1200" })), true);
  let current = await state();
  assert.deepEqual(
    [current.status, current.failure_code, current.attempt_id, current.rate_limit_retries, current.at_pause_end],
    ["pending", "meta_error_4", null, 1, true],
  );
  assert.ok(Number(current.paused_for) > 1100 && Number(current.paused_for) <= 1200, String(current.paused_for));
  // The pause holds every other row of the connection.
  assert.equal(await deliver(seen), false);
  // The tiers: 15 minutes, 1 hour, 4 hours; a later rate limit after the third retry fails the row.
  for (const [retries, tier] of [
    [2, 3600],
    [3, 14400],
  ] as const) {
    await pool.query("UPDATE instagram_connections SET send_paused_until=NULL");
    await pool.query("UPDATE flow_dm_deliveries SET next_attempt_at=now()-interval '1 hour' WHERE id=$1", [id]);
    assert.equal(await deliver(seen, throttled()), true);
    current = await state();
    assert.deepEqual([current.status, current.rate_limit_retries], ["pending", retries]);
    assert.ok(Math.abs(Number(current.paused_for) - tier) <= 5, String(current.paused_for));
  }
  await pool.query("UPDATE instagram_connections SET send_paused_until=NULL");
  await pool.query("UPDATE flow_dm_deliveries SET next_attempt_at=now()-interval '1 hour' WHERE id=$1", [id]);
  assert.equal(await deliver(seen, throttled()), true);
  current = await state();
  assert.deepEqual([current.status, current.failure_code, current.rate_limit_retries], ["failed", "meta_error_4", 3]);
  // The connection is still paused, so the other row waits.
  assert.ok(Number(current.paused_for) > 14000, String(current.paused_for));
  assert.equal((await row(other)).status, "pending");
  assert.equal(seen.posts.length, 4);
});

test("a pause recorded after the guards defers the row as connection_paused without spending a retry", async () => {
  const id = await dmRow("9001");
  const seen = graph();
  const source = hookedPool(/SET provider_called_at/, () =>
    pool.query("UPDATE instagram_connections SET send_paused_until=now()+interval '10 minutes'"),
  );
  assert.equal(await deliver(seen, {}, source), true);
  assert.deepEqual(seen.posts, []);
  const state = await row(id);
  assert.deepEqual(
    [state.status, state.failure_code, state.rate_limit_retries, state.attempted, state.deferred],
    ["pending", "connection_paused", 0, false, true],
  );
});

test("stale sending rows become unknown and are never claimed again", async () => {
  const stale = await dmRow("9001");
  const fresh = await dmRow("9002");
  await pool.query(
    `UPDATE flow_dm_deliveries SET status='sending',attempt_id=gen_random_uuid(),
       attempt_started_at=now()-CASE WHEN id=$1 THEN interval '11 minutes' ELSE interval '1 minute' END`,
    [stale],
  );
  await recoverStaleDmFlowDeliveries(pool);
  assert.deepEqual([(await row(stale)).status, (await row(stale)).failure_code], ["unknown", "worker_interrupted"]);
  assert.equal((await row(fresh)).status, "sending");
  assert.equal(await deliver(graph()), false);
});

test("operations health counts DM flow rows in the due, sending and outcome metrics and the unknown alert", async () => {
  const ids = [];
  for (const recipient of ["9001", "9002", "9003", "9004", "9005"]) ids.push(await dmRow(recipient));
  await pool.query("UPDATE flow_dm_deliveries SET next_attempt_at=now()-interval '20 minutes'");
  const [due] = await connectionMetrics(pool, W);
  assert.ok(due!.oldest_due_pending_seconds! >= 1199, String(due!.oldest_due_pending_seconds));
  const outcome = (id: string, status: string, code: string | null) =>
    pool.query(
      `UPDATE flow_dm_deliveries SET status=$2,failure_code=$3,attempt_id=gen_random_uuid(),
         attempt_started_at=now()-interval '12 minutes' WHERE id=$1`,
      [id, status, code],
    );
  await outcome(ids[0]!, "sending", null);
  await outcome(ids[1]!, "unknown", "send_outcome_unknown");
  await outcome(ids[2]!, "failed", "meta_error_100");
  await outcome(ids[3]!, "blocked", "reply_window_closed");
  // A messaging-ID pause holds the last pending row, so nothing counts as waiting.
  await pause("9005");
  const [metrics] = await connectionMetrics(pool, W);
  assert.equal(metrics!.oldest_due_pending_seconds, null);
  assert.ok(metrics!.longest_sending_seconds! >= 719, String(metrics!.longest_sending_seconds));
  assert.deepEqual([metrics!.unknown_24h, metrics!.failed_24h, metrics!.blocked_24h], [1, 1, 1]);
  mock.method(console, "warn", () => undefined);
  await evaluateAlerts(pool, true, "dm-flow-health-test");
  const alerts = (
    await pool.query(
      "SELECT name,alert_seen_count FROM scheduled_steps WHERE alert_active AND name<>'alert_cron_stale' ORDER BY name",
    )
  ).rows;
  assert.deepEqual(alerts, [
    { name: "alert_sending_dwell", alert_seen_count: null },
    { name: "alert_unknown_outcome", alert_seen_count: "1" },
  ]);
});

test("the deletion functions refuse while a DM flow row is sending or held, and remove the messaging-ID pause", async () => {
  const sending = await dmRow("9001");
  await dmRow("9002");
  await pause("9001");
  await pause("9002");
  await pool.query(
    "UPDATE flow_dm_deliveries SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE id=$1",
    [sending],
  );
  await pool.query(
    "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
    [C],
  );
  const person = (kind: string, value: string) =>
    pool.query("SELECT public.delete_person_data($1,$2,$3,$4,$5) AS result", [W, C, owner, kind, value]);
  const refused = { code: "AC003" };
  await assert.rejects(person("dm_recipient", "9001"), refused);
  await assert.rejects(
    pool.query("SELECT public.delete_connection_data($1,$2,$3,'100') AS result", [W, C, owner]),
    refused,
  );
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL");
  await assert.rejects(pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [W, owner]), refused);
  // A row another transaction holds (a finish in progress) refuses instead of waiting.
  await pool.query("UPDATE flow_dm_deliveries SET status='sent',provider_message_id='m',sent_at=now() WHERE id=$1", [
    sending,
  ]);
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM flow_dm_deliveries WHERE recipient_id='9002' FOR UPDATE");
    await assert.rejects(person("dm_recipient", "9002"), refused);
    await assert.rejects(
      pool.query("SELECT public.delete_connection_data($1,$2,$3,'100') AS result", [W, C, owner]),
      refused,
    );
    await holder.query("ROLLBACK");
  } finally {
    holder.release();
  }
  // The same number as a comment sender reaches no messaging identity.
  const comment = (await person("comment_sender", "9002")).rows[0].result;
  assert.equal(comment.deleted_counts.instagram_dm_automation, 0);
  const deleted = (await person("dm_recipient", "9002")).rows[0].result;
  assert.equal(deleted.deleted_counts.instagram_dm_automation, 1);
  assert.equal(deleted.deleted_counts.flow_dm_deliveries, 1);
  const connection = (await pool.query("SELECT public.delete_connection_data($1,$2,$3,'100') AS result", [W, C, owner]))
    .rows[0].result;
  assert.equal(connection.deleted_counts.instagram_dm_automation, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_dm_automation")).rows[0].n, 0);
  await pool.query(
    "INSERT INTO instagram_dm_automation(workspace_id,connection_id,recipient_id,paused) VALUES($1,$2,'9009',true)",
    [W, OTHER],
  );
  const workspace = (await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [W, owner])).rows[0]
    .result;
  assert.equal(workspace.deleted_counts.instagram_dm_automation, 1);
});

test("migration 069 replays over stored rows, keeps the canonical deletion functions and runs in the runner", async () => {
  const first = await dmRow("9001");
  const second = await dmRow("9002");
  const named = [
    "flow_dm_delivery_attempt",
    "flow_dm_delivery_failure",
    "flow_dm_delivery_sent",
    "flow_dm_delivery_status",
  ];
  const constraints = async () =>
    (
      await pool.query(
        "SELECT conname FROM pg_constraint WHERE conrelid='flow_dm_deliveries'::regclass AND conname=ANY($1) ORDER BY conname",
        [[...named, "flow_dm_deliveries_status_check"]],
      )
    ).rows.map(({ conname }) => conname);
  const definitions = async () =>
    (
      await pool.query(
        "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('delete_person_data','delete_connection_data','delete_workspace_data') ORDER BY proname",
      )
    ).rows;
  const canonical = await definitions();
  for (const { definition } of canonical) assert.match(definition, /instagram_dm_automation/);
  // db/schema.sql already holds the 069 constraints; return the table to the migration 068 constraint set, so the
  // first replay runs the install path of 069 over stored pending rows.
  await pool.query(
    `ALTER TABLE flow_dm_deliveries DROP CONSTRAINT flow_dm_delivery_attempt,DROP CONSTRAINT flow_dm_delivery_failure,
       DROP CONSTRAINT flow_dm_delivery_sent,DROP CONSTRAINT flow_dm_delivery_status,
       ADD CONSTRAINT flow_dm_deliveries_status_check CHECK(status IN ('pending'))`,
  );
  assert.deepEqual(await constraints(), ["flow_dm_deliveries_status_check"]);
  const sql = await readFile(new URL("../../db/migrations/069_dm_flow_delivery.sql", import.meta.url), "utf8");
  await pool.query(sql);
  assert.deepEqual(await constraints(), named);
  await deliver(graph());
  // The second replay runs over a sent row and keeps the installed constraints.
  await pool.query(sql);
  assert.deepEqual(await constraints(), named);
  assert.deepEqual(await definitions(), canonical);
  const stored = (
    await pool.query("SELECT id,status FROM flow_dm_deliveries WHERE id=ANY($1) ORDER BY status", [[first, second]])
  ).rows;
  assert.deepEqual(
    stored.map(({ status }) => status),
    ["pending", "sent"],
  );
  const pending = stored[0].id;
  // The status set and the attempt rule hold; each update breaks only the named constraint.
  await assert.rejects(
    pool.query(
      "UPDATE flow_dm_deliveries SET status='cancelled',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE id=$1",
      [pending],
    ),
    { code: "23514", constraint: "flow_dm_delivery_status" },
  );
  await assert.rejects(pool.query("UPDATE flow_dm_deliveries SET status='sending' WHERE id=$1", [pending]), {
    code: "23514",
    constraint: "flow_dm_delivery_attempt",
  });
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(
    runner.indexOf("069_dm_flow_delivery.sql") > runner.indexOf("068_dm_start_triggers.sql") &&
      runner.indexOf("069_dm_flow_delivery.sql") < runner.indexOf("supabase-access.sql"),
  );
});
