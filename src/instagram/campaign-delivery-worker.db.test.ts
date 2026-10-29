import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { cancelCampaignRun, startDueCampaignRuns } from "../app/campaign-runs.ts";
import { connectionAlerts, connectionMetrics, evaluateAlerts } from "../app/operations-health.ts";
import {
  assertCampaignDeliveryAllowed,
  completeCampaignRuns,
  endUnreachableCampaignDeliveries,
  processNextCampaignDelivery,
  recoverStaleCampaignDeliveries,
} from "./campaign-delivery-worker.ts";
import { recordChannelConsentEvent } from "./channel-consent.ts";
import { InstagramFollowTransport } from "./follow-transport.ts";
import { CAMPAIGN_HOURLY_BUDGET } from "./send-quota.ts";

// The campaign delivery worker against a real PostgreSQL database. Graph is mocked through fetchImpl and nothing
// here reaches Meta.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const W = "11111111-1111-4111-8111-111111111111";
const C = "33333333-3333-4333-8333-333333333333";
const owner = "55555555-5555-4555-8555-555555555555";
const admin = "88888888-8888-4888-8888-888888888888";
const TOKEN = "CIPHERTEXT";
const PREVIEW_COUNTS = JSON.stringify({
  original_member_count: "0",
  remaining_member_count: "0",
  connection_unavailable: "0",
  contact_paused: "0",
  no_dm_identity: "0",
  opted_out: "0",
  marketing_consent_required: "0",
  reply_window_closed: "0",
  candidate: "0",
});
let sequence = 0;

before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  mock.restoreAll();
  await pool.query("TRUNCATE workspaces,workspace_deletion_records,scheduled_steps CASCADE");
  await pool.query("INSERT INTO workspaces(id,time_zone,plan) VALUES($1,'UTC','advanced')", [W]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin')", [
    W,
    owner,
    admin,
  ]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,inbox_enabled,inbox_enabled_at,active,send_enabled,access_token_encrypted,token_expires_at)
     VALUES($1,$2,'100',true,now()-interval '1 day',true,true,$3,now()+interval '30 days')`,
    [C, W, TOKEN],
  );
});
after(async () => {
  mock.restoreAll();
  await pool.end();
});

async function bridge(sender: string, recipient: string) {
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
  await pool.query(
    `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,
       private_reply_text,recipient_id,status,provider_message_id,sent_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'REPLY',$8,'sent','acknowledged',now()-interval '1 hour')`,
    [W, C, event.id, rule, event.comment_id, event.media_id, sender, recipient],
  );
}
async function consent(
  kind: "comment_sender" | "dm_recipient",
  value: string,
  purpose: "marketing" | "service_reply",
  decision: "grant" | "revoke",
) {
  await recordChannelConsentEvent(pool, {
    requestKey: randomUUID(),
    workspaceId: W,
    connectionId: C,
    channel: "instagram",
    identityKind: kind,
    identityValue: value,
    purpose,
    decision,
    evidenceKind: "explicit",
    evidenceReference: "test",
    occurredAt: new Date(),
    actorId: owner,
  });
}
// A bridged recipient with a text DM an hour ago and an explicit marketing grant: a candidate.
async function qualifying(sender: string, recipient: string) {
  await bridge(sender, recipient);
  sequence++;
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,$4,'DM','text',now()-interval '1 hour')`,
    [W, C, recipient, `dm-${sequence}`],
  );
  await consent("dm_recipient", recipient, "marketing", "grant");
}
// Approves (directly, approved by the admin) and starts one campaign whose members are all candidates.
async function campaign(members: Array<[string, string]>, body = "Campaign body") {
  for (const [sender, recipient] of members) await qualifying(sender, recipient);
  const segment = (
    await pool.query("INSERT INTO instagram_contact_segments(workspace_id,name) VALUES($1,$2) RETURNING id", [
      W,
      `Audience ${++sequence}`,
    ])
  ).rows[0].id;
  const snapshot = (
    await pool.query(
      `INSERT INTO instagram_segment_snapshots(workspace_id,segment_id,created_by,as_of,definition,segment_name,counts,member_count)
       VALUES($1,$2,$3,now(),'{}','Audience','{}',$4) RETURNING id`,
      [W, segment, admin, members.length],
    )
  ).rows[0].id;
  for (const [sender] of members)
    await pool.query(
      "INSERT INTO instagram_segment_snapshot_members(snapshot_id,workspace_id,connection_id,sender_id) VALUES($1,$2,$3,$4)",
      [snapshot, W, C, sender],
    );
  const draft = (
    await pool.query(
      `INSERT INTO campaign_drafts(id,workspace_id,snapshot_id,name,body,create_request_hash,created_by,updated_by)
       VALUES(gen_random_uuid(),$1,$2,'Campaign',$3,repeat('0',64),$4,$4) RETURNING id`,
      [W, snapshot, body, admin],
    )
  ).rows[0].id;
  const approval = (
    await pool.query(
      `INSERT INTO campaign_approvals(workspace_id,id,draft_id,draft_version,snapshot_id,name,body,schedule_kind,
         preview_as_of,preview_counts,create_request_hash,approved_by)
       VALUES($1,gen_random_uuid(),$2,1,$3,'Campaign',$4,'immediate',now(),$5,repeat('0',64),$6) RETURNING id`,
      [W, draft, snapshot, body, PREVIEW_COUNTS, admin],
    )
  ).rows[0].id;
  await startDueCampaignRuns(pool);
  const run = (await pool.query("SELECT id FROM campaign_runs WHERE approval_id=$1", [approval])).rows[0].id as string;
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM campaign_deliveries WHERE run_id=$1", [run])).rows[0].n,
    members.length,
  );
  return run;
}

interface Graph {
  posts: { path: string; body: unknown }[];
  gets: string[];
}
interface Options {
  // Answers the POST; the default acknowledges it.
  post?: () => Response;
  // Runs inside the account verification read: after the first guard and before the second.
  onVerify?: () => Promise<void>;
  me?: string | Error;
  globalSendEnabled?: boolean;
}
function graph(): Graph {
  return { posts: [], gets: [] };
}
// The Cloudflare composition: InstagramFollowTransport with mocked fetch and the final guard as beforeSend.
function transport(seen: Graph, options: Options = {}) {
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "graph.instagram.com");
    if (init?.method === "POST") {
      seen.posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      return options.post ? options.post() : Response.json({ message_id: `campaign-message-${seen.posts.length}` });
    }
    seen.gets.push(url.pathname);
    await options.onVerify?.();
    if (options.me instanceof Error) throw options.me;
    return Response.json({ user_id: options.me ?? "100" });
  }) as typeof fetch;
  return new InstagramFollowTransport({
    accountId: "100",
    accessToken: "synthetic",
    graphVersion: "v24.0",
    fetchImpl,
    beforeSend: (context) =>
      assertCampaignDeliveryAllowed(pool, {
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
  return processNextCampaignDelivery(source, C, transport(seen, options), TOKEN, {
    globalSendEnabled: options.globalSendEnabled ?? true,
  });
}
async function rows(run: string) {
  return (
    await pool.query(
      `SELECT sender_id,status,failure_code,attempt_id IS NOT NULL AS attempted,provider_message_id,
         provider_called_at IS NOT NULL AS called,next_attempt_at>clock_timestamp() AS deferred
       FROM campaign_deliveries WHERE run_id=$1 ORDER BY sender_id`,
      [run],
    )
  ).rows;
}
async function runState(run: string) {
  return (await pool.query("SELECT status,version FROM campaign_runs WHERE id=$1", [run])).rows[0];
}
const adminUser = { id: admin, email: "admin@example.test" };

// A pool whose client runs `pause`'s first matching query and then holds its transaction until `release`.
const GATE_TIMEOUT_MS = 10_000;
function pausingPool(pause: RegExp) {
  let reached!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no query matched ${pause}`)), GATE_TIMEOUT_MS);
    timer.unref();
    reached = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const gate = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  const wrapped = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (input: string | QueryConfig, values?: unknown[]) => {
          const query = typeof input === "string" ? { text: input, values } : input;
          const result = await client.query(query);
          if (!paused && pause.test(query.text)) {
            paused = true;
            reached();
            await gate;
          }
          return result;
        },
        release: (destroy?: boolean | Error) => client.release(destroy),
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  return { pool: wrapped, held, release };
}
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
async function waitForLock(text: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const waiting = await pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
       AND strpos(query,$1)>0`,
      [text],
    );
    if (waiting.rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`no transaction waited for a lock in: ${text}`);
}

test("a claimed row is sent once as plain text to its stored recipient, and its run completes", async () => {
  const run = await campaign([["1001", "2001"]], "Hello from the campaign");
  const seen = graph();
  assert.equal(await deliver(seen), true);
  assert.deepEqual(seen.posts, [
    { path: "/v24.0/100/messages", body: { recipient: { id: "2001" }, message: { text: "Hello from the campaign" } } },
  ]);
  assert.deepEqual(await rows(run), [
    {
      sender_id: "1001",
      status: "sent",
      failure_code: null,
      attempted: true,
      provider_message_id: "campaign-message-1",
      called: true,
      deferred: false,
    },
  ]);
  assert.equal(
    (await pool.query("SELECT sent_at IS NOT NULL AS sent FROM campaign_deliveries WHERE run_id=$1", [run])).rows[0]
      .sent,
    true,
  );
  assert.deepEqual(await runState(run), { status: "completed", version: 2 });
  // Nothing is left to claim, and nothing else reached Graph.
  assert.equal(await deliver(seen), false);
  assert.equal(seen.posts.length, 1);
  assert.deepEqual(seen.gets, ["/v24.0/me"]);
});

test("the claim takes the oldest due row first and skips deferred, paused-contact and cancelled-run rows", async () => {
  const run = await campaign([
    ["1001", "2001"],
    ["1002", "2002"],
    ["1003", "2003"],
  ]);
  await pool.query(
    "UPDATE campaign_deliveries SET next_attempt_at=now()-interval '5 minutes' WHERE run_id=$1 AND sender_id='1003'",
    [run],
  );
  await pool.query(
    "UPDATE campaign_deliveries SET next_attempt_at=now()+interval '5 minutes' WHERE run_id=$1 AND sender_id='1002'",
    [run],
  );
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,'1001',true)",
    [W, C],
  );
  const seen = graph();
  assert.equal(await deliver(seen), true);
  assert.deepEqual(
    seen.posts.map((post) => (post.body as { recipient: { id: string } }).recipient.id),
    ["2003"],
  );
  // 1002 is not due yet and 1001's contact is paused, so nothing else is claimed.
  assert.equal(await deliver(seen), false);
  await pool.query("DELETE FROM instagram_contact_automation");
  assert.equal(await deliver(seen), true);
  assert.equal(seen.posts.length, 2);
  // A cancelled run's rows are cancelled and never claimed.
  await pool.query("UPDATE campaign_deliveries SET next_attempt_at=now() WHERE run_id=$1", [run]);
  const cancelled = await cancelCampaignRun(pool, adminUser, run, { expected_version: 1 });
  assert.equal(cancelled.error, null);
  assert.equal(await deliver(seen), false);
  assert.deepEqual(
    (await rows(run)).map((row) => [row.sender_id, row.status]),
    [
      ["1001", "sent"],
      ["1002", "cancelled"],
      ["1003", "sent"],
    ],
  );
});

test("two workers claim one row each, and a held row is skipped rather than waited on", async () => {
  const run = await campaign([
    ["1001", "2001"],
    ["1002", "2002"],
  ]);
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM campaign_deliveries WHERE run_id=$1 AND sender_id='1001' FOR UPDATE", [run]);
    const seen = graph();
    const claimed = await Promise.race([
      deliver(seen),
      new Promise<string>((resolve) => setTimeout(() => resolve("waited"), 5_000).unref()),
    ]);
    assert.equal(claimed, true, "the claim must skip the locked row");
    assert.deepEqual(
      seen.posts.map((post) => (post.body as { recipient: { id: string } }).recipient.id),
      ["2002"],
    );
    await holder.query("COMMIT");
  } finally {
    holder.release();
  }
  const other = await campaign([
    ["1011", "2011"],
    ["1012", "2012"],
  ]);
  const first = graph();
  const second = graph();
  assert.deepEqual(await Promise.all([deliver(first), deliver(second)]), [true, true]);
  // The two oldest due rows, one each: the released 1001 and the second run's first row.
  assert.equal(first.posts.length, 1);
  assert.equal(second.posts.length, 1);
  assert.deepEqual(
    [...first.posts, ...second.posts].map((post) => (post.body as { recipient: { id: string } }).recipient.id).sort(),
    ["2001", "2011"],
  );
  assert.deepEqual(
    [...(await rows(run)), ...(await rows(other))].map((row) => [row.sender_id, row.status]),
    [
      ["1001", "sent"],
      ["1002", "sent"],
      ["1011", "sent"],
      ["1012", "pending"],
    ],
  );
});

// Each case changes one recorded condition while the account is being verified, so the second guard (after the
// verification read, before the POST) sees it. Retries go back to pending a minute later with the attempt cleared;
// blocks end the row. No case reaches the POST.
const guardCases: Array<{ name: string; change: () => Promise<unknown>; expect: [string, string] }> = [
  {
    name: "the 24-hour window closed",
    change: () => pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '25 hours'"),
    expect: ["blocked", "reply_window_closed"],
  },
  {
    name: "the marketing grant is absent",
    change: () => pool.query("DELETE FROM channel_consent_state WHERE purpose='marketing'"),
    expect: ["blocked", "marketing_consent_required"],
  },
  {
    name: "the marketing grant was revoked",
    change: () => consent("dm_recipient", "2001", "marketing", "revoke"),
    expect: ["blocked", "recipient_opted_out"],
  },
  {
    name: "the comment sender opted out",
    change: () => consent("comment_sender", "1001", "service_reply", "revoke"),
    expect: ["blocked", "recipient_opted_out"],
  },
  {
    name: "another DM recipient bridged to the sender opted out",
    change: async () => {
      await bridge("1001", "2099");
      await consent("dm_recipient", "2099", "service_reply", "revoke");
    },
    expect: ["blocked", "recipient_opted_out"],
  },
  {
    name: "the DM identity became ambiguous",
    change: () => bridge("1009", "2001"),
    expect: ["blocked", "no_dm_identity"],
  },
  {
    name: "the contact was paused",
    change: () =>
      pool.query(
        "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,'1001',true)",
        [W, C],
      ),
    expect: ["pending", "contact_paused"],
  },
  {
    name: "a handoff paused the contact",
    change: () =>
      pool.query(
        "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,handoff_paused) VALUES($1,$2,'1001',true)",
        [W, C],
      ),
    expect: ["pending", "contact_paused"],
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
    name: "the approving admin was removed",
    change: () =>
      pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [admin, owner]),
    expect: ["blocked", "approver_unavailable"],
  },
  {
    name: "the approving admin became an agent",
    change: () => pool.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [admin]),
    expect: ["blocked", "approver_unavailable"],
  },
  {
    name: "a block reason wins over a retry reason",
    change: async () => {
      await pool.query(
        "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,'1001',true)",
        [W, C],
      );
      await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '25 hours'");
    },
    expect: ["blocked", "reply_window_closed"],
  },
];
for (const { name, change, expect } of guardCases)
  test(`the final guard: ${name}`, async () => {
    const run = await campaign([["1001", "2001"]]);
    const seen = graph();
    assert.equal(await deliver(seen, { onVerify: async () => void (await change()) }), true);
    assert.deepEqual(seen.posts, []);
    const [row] = await rows(run);
    assert.deepEqual([row.status, row.failure_code], expect);
    if (expect[0] === "pending") {
      assert.equal(row.attempted, false);
      assert.equal(row.deferred, true);
      assert.deepEqual(await runState(run), { status: "running", version: 1 });
    } else {
      assert.equal(row.attempted, true);
      assert.deepEqual(await runState(run), { status: "completed", version: 2 });
    }
    assert.equal(row.called, false);
  });

test("the guard immediately before the POST sees a change made after the second guard", async () => {
  const run = await campaign([["1001", "2001"]]);
  const seen = graph();
  const source = hookedPool(/SET provider_called_at/, () =>
    pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '25 hours'"),
  );
  assert.equal(await deliver(seen, {}, source), true);
  assert.deepEqual(seen.posts, []);
  const [row] = await rows(run);
  // Migration 067 lets a blocked row have no attempt, so this row's attempt is asserted here, not by the CHECK.
  assert.deepEqual(
    [row.status, row.failure_code, row.called, row.attempted],
    ["blocked", "reply_window_closed", true, true],
  );
});

test("a run cancelled between the claim and the POST lands the claimed row cancelled", async () => {
  const run = await campaign([
    ["1001", "2001"],
    ["1002", "2002"],
  ]);
  const seen = graph();
  assert.equal(
    await deliver(seen, {
      onVerify: async () => {
        const cancelled = await cancelCampaignRun(pool, adminUser, run, { expected_version: 1 });
        assert.equal(cancelled.error, null);
        assert.equal(cancelled.error === null && cancelled.run.cancelled_delivery_count, "1");
      },
    }),
    true,
  );
  assert.deepEqual(seen.posts, []);
  assert.deepEqual(
    (await rows(run)).map((row) => [row.sender_id, row.status, row.failure_code]),
    [
      ["1001", "cancelled", "run_cancelled"],
      ["1002", "cancelled", null],
    ],
  );
  assert.equal((await runState(run)).status, "cancelled");
});

test("with the global send switch off the guard defers without any Graph call", async () => {
  const run = await campaign([["1001", "2001"]]);
  const seen = graph();
  assert.equal(await deliver(seen, { globalSendEnabled: false }), true);
  assert.deepEqual(seen, { posts: [], gets: [] });
  const [row] = await rows(run);
  assert.deepEqual(
    [row.status, row.failure_code, row.attempted, row.deferred],
    ["pending", "global_send_disabled", false, true],
  );
});

test("a consent read failure defers the row as consent_unavailable", async () => {
  const run = await campaign([["1001", "2001"]]);
  const original = Pool.prototype.query;
  mock.method(Pool.prototype, "query", async function (this: Pool, sql: unknown, values?: unknown[]) {
    if (typeof sql === "string" && sql.includes("FROM channel_consent_state state"))
      throw new Error("consent database unavailable");
    return Reflect.apply(original, this, [sql, values]);
  });
  const seen = graph();
  try {
    assert.equal(await deliver(seen), true);
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(seen.posts, []);
  const [row] = await rows(run);
  assert.deepEqual([row.status, row.failure_code], ["pending", "consent_unavailable"]);
});

test("the account check: a mismatch blocks the row and a failed read defers it", async () => {
  const run = await campaign([
    ["1001", "2001"],
    ["1002", "2002"],
  ]);
  const seen = graph();
  assert.equal(await deliver(seen, { me: "999" }), true);
  assert.equal(await deliver(seen, { me: new Error("network") }), true);
  assert.deepEqual(seen.posts, []);
  assert.deepEqual(
    (await rows(run)).map((row) => [row.sender_id, row.status, row.failure_code]),
    [
      ["1001", "blocked", "authorization_unverified"],
      ["1002", "pending", "verification_unavailable"],
    ],
  );
});

test("a definite provider rejection fails the row; an ambiguous outcome is unknown and never retried", async () => {
  const run = await campaign([
    ["1001", "2001"],
    ["1002", "2002"],
  ]);
  const seen = graph();
  assert.equal(
    await deliver(seen, {
      post: () => Response.json({ error: { code: 100, message: "Invalid parameter" } }, { status: 400 }),
    }),
    true,
  );
  assert.equal(await deliver(seen, { post: () => new Response("upstream", { status: 502 }) }), true);
  assert.deepEqual(
    (await rows(run)).map((row) => [row.sender_id, row.status, row.failure_code, row.called]),
    [
      ["1001", "failed", "meta_error_100", true],
      ["1002", "unknown", "send_outcome_unknown", true],
    ],
  );
  assert.equal(await deliver(seen), false);
  assert.equal(seen.posts.length, 2);
  assert.deepEqual(await runState(run), { status: "completed", version: 2 });
});

test("a rate limit returns the row to pending at the pause end and holds the connection's other rows", async () => {
  const run = await campaign([
    ["1001", "2001"],
    ["1002", "2002"],
  ]);
  const seen = graph();
  assert.equal(
    await deliver(seen, {
      post: () =>
        Response.json(
          { error: { code: 4, message: "Too many calls" } },
          { status: 400, headers: { "retry-after": "1200" } },
        ),
    }),
    true,
  );
  const state = (
    await pool.query(
      `SELECT d.status,d.failure_code,d.attempt_id,d.provider_called_at IS NOT NULL AS called,
         d.next_attempt_at=c.send_paused_until AS at_pause_end,
         extract(epoch FROM c.send_paused_until-clock_timestamp()) BETWEEN 1100 AND 1200 AS paused_for_retry_after
       FROM campaign_deliveries d JOIN instagram_connections c ON c.id=d.connection_id
       WHERE d.run_id=$1 AND d.failure_code IS NOT NULL`,
      [run],
    )
  ).rows;
  assert.deepEqual(state, [
    {
      status: "pending",
      failure_code: "meta_error_4",
      attempt_id: null,
      called: true,
      at_pause_end: true,
      paused_for_retry_after: true,
    },
  ]);
  // The pause holds every other row of the connection: nothing is claimed.
  assert.equal(await deliver(seen), false);
  assert.equal(seen.posts.length, 1);
  // A shorter Retry-After still pauses for at least 15 minutes.
  await pool.query("UPDATE instagram_connections SET send_paused_until=NULL");
  await pool.query(
    "UPDATE campaign_deliveries SET next_attempt_at=now()+interval '1 hour' WHERE failure_code IS NOT NULL",
  );
  assert.equal(
    await deliver(seen, {
      post: () => Response.json({ error: { code: 613, message: "Throttled" } }, { status: 400 }),
    }),
    true,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT extract(epoch FROM send_paused_until-clock_timestamp()) BETWEEN 800 AND 900 AS ok FROM instagram_connections",
      )
    ).rows[0].ok,
    true,
  );
  assert.deepEqual(await runState(run), { status: "running", version: 1 });
});

test("a connection at its hourly campaign budget is not claimed until a call leaves the hour", async () => {
  const run = await campaign([["1001", "2001"]]);
  const filler = await campaign([]);
  await pool.query(
    `INSERT INTO campaign_deliveries(workspace_id,run_id,connection_id,sender_id,recipient_id,status,attempt_id,
       attempt_started_at,provider_message_id,sent_at,provider_called_at)
     SELECT $1,$2,$3,'budget-'||n,'3'||n,'sent',gen_random_uuid(),now()-interval '30 minutes','m'||n,
       now()-interval '30 minutes',now()-interval '30 minutes' FROM generate_series(1,$4::int) n`,
    [W, filler, C, CAMPAIGN_HOURLY_BUDGET],
  );
  const seen = graph();
  assert.equal(await deliver(seen), false);
  await pool.query(
    "UPDATE campaign_deliveries SET provider_called_at=now()-interval '61 minutes' WHERE sender_id='budget-1'",
  );
  assert.equal(await deliver(seen), true);
  assert.equal((await rows(run))[0].status, "sent");
});

test("stale sending rows become unknown, and the cron completion then completes their run", async () => {
  const stale = await campaign([["1001", "2001"]]);
  const empty = await campaign([]);
  const cancelled = await campaign([["1002", "2002"]]);
  assert.equal((await cancelCampaignRun(pool, adminUser, cancelled, { expected_version: 1 })).error, null);
  await pool.query(
    `UPDATE campaign_deliveries SET status='sending',attempt_id=gen_random_uuid(),
       attempt_started_at=now()-interval '11 minutes' WHERE run_id=$1`,
    [stale],
  );
  // A recent sending row is left alone.
  const fresh = await campaign([["1003", "2003"]]);
  await pool.query(
    "UPDATE campaign_deliveries SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE run_id=$1",
    [fresh],
  );
  await recoverStaleCampaignDeliveries(pool);
  assert.deepEqual(
    (await rows(stale)).map((row) => [row.status, row.failure_code, row.attempted]),
    [["unknown", "worker_interrupted", true]],
  );
  assert.equal((await rows(fresh))[0].status, "sending");
  assert.equal(await completeCampaignRuns(pool), 2);
  assert.deepEqual(await runState(stale), { status: "completed", version: 2 });
  assert.deepEqual(await runState(empty), { status: "completed", version: 2 });
  assert.deepEqual(await runState(cancelled), { status: "cancelled", version: 2 });
  assert.deepEqual(await runState(fresh), { status: "running", version: 1 });
  assert.equal(await completeCampaignRuns(pool), 0);
});

test("a run completes only after its last row is final", async () => {
  const run = await campaign([
    ["1001", "2001"],
    ["1002", "2002"],
  ]);
  const seen = graph();
  assert.equal(await deliver(seen), true);
  assert.deepEqual(await runState(run), { status: "running", version: 1 });
  assert.equal(await deliver(seen), true);
  assert.deepEqual(await runState(run), { status: "completed", version: 2 });
  const completed = await cancelCampaignRun(pool, adminUser, run, { expected_version: 2 });
  assert.equal(completed.error, "campaign_run_completed");
});

// The cancel and a finish meet on the run row: the cancel locks it FOR UPDATE and then its pending rows; the finish
// locks it FOR SHARE and then the claimed row. Either order ends without a deadlock and without a pending row in a
// cancelled run.
const CANCEL_LOCK = /FROM campaign_runs WHERE workspace_id=\$1 AND id=\$2 FOR UPDATE/;
const FINISH_LOCK = /FROM campaign_runs WHERE workspace_id=\$1 AND id=\$2 FOR SHARE/;
for (const outcome of ["sent", "retried"] as const) {
  test(`a cancel that holds the run first, then a finish that ${outcome === "sent" ? "sends" : "defers"}`, async () => {
    const run = await campaign([["1001", "2001"]]);
    const gated = pausingPool(CANCEL_LOCK);
    const cancel = cancelCampaignRun(gated.pool, adminUser, run, { expected_version: 1 });
    await gated.held;
    const seen = graph();
    const delivered = deliver(
      seen,
      outcome === "sent"
        ? {}
        : { post: () => Response.json({ error: { code: 4, message: "Too many calls" } }, { status: 400 }) },
    );
    // The finish waits on the run lock while the cancel holds it.
    await waitForLock("FOR SHARE");
    gated.release();
    const [cancelled, sent] = await Promise.all([cancel, delivered]);
    assert.equal(cancelled.error, null);
    assert.equal(sent, true);
    const [row] = await rows(run);
    assert.deepEqual(
      [row.status, row.failure_code],
      outcome === "sent" ? ["sent", null] : ["cancelled", "run_cancelled"],
    );
    assert.equal((await runState(run)).status, "cancelled");
  });
}
test("a finish that holds the run first, then a cancel, cancels the row the finish returned to pending", async () => {
  const run = await campaign([["1001", "2001"]]);
  const gated = pausingPool(FINISH_LOCK);
  const seen = graph();
  const delivered = deliver(
    seen,
    { post: () => Response.json({ error: { code: 4, message: "Too many calls" } }, { status: 400 }) },
    gated.pool,
  );
  await gated.held;
  const cancel = cancelCampaignRun(pool, adminUser, run, { expected_version: 1 });
  await waitForLock("FOR UPDATE");
  gated.release();
  const [sent, cancelled] = await Promise.all([delivered, cancel]);
  assert.equal(sent, true);
  assert.equal(cancelled.error, null);
  assert.equal(cancelled.error === null && cancelled.run.cancelled_delivery_count, "1");
  const [row] = await rows(run);
  assert.deepEqual([row.status, row.failure_code], ["cancelled", "meta_error_4"]);
  assert.equal((await runState(run)).status, "cancelled");
});
test("a finish that holds the run first and sends the last row completes the run, and the cancel then refuses", async () => {
  const run = await campaign([["1001", "2001"]]);
  const gated = pausingPool(FINISH_LOCK);
  const delivered = deliver(graph(), {}, gated.pool);
  await gated.held;
  const cancel = cancelCampaignRun(pool, adminUser, run, { expected_version: 1 });
  await waitForLock("FOR UPDATE");
  gated.release();
  const [sent, cancelled] = await Promise.all([delivered, cancel]);
  assert.equal(sent, true);
  // The cancel read the run after the finish committed but before the separate completion statement, or after it.
  assert.ok(cancelled.error === null || cancelled.error === "campaign_run_completed", String(cancelled.error));
  const [row] = await rows(run);
  assert.equal(row.status, "sent");
  assert.equal((await runState(run)).status, cancelled.error === null ? "cancelled" : "completed");
});

test("operations health counts campaign rows in the due, sending and outcome metrics and the unknown alert", async () => {
  const run = await campaign([
    ["1001", "2001"],
    ["1002", "2002"],
    ["1003", "2003"],
    ["1004", "2004"],
    ["1005", "2005"],
  ]);
  await pool.query("UPDATE campaign_deliveries SET next_attempt_at=now()-interval '20 minutes' WHERE run_id=$1", [run]);
  const [due] = await connectionMetrics(pool, W);
  assert.ok(due!.oldest_due_pending_seconds! >= 1199, String(due!.oldest_due_pending_seconds));
  assert.equal(due!.longest_sending_seconds, null);
  const outcome = async (sender: string, status: string, code: string | null) =>
    pool.query(
      `UPDATE campaign_deliveries SET status=$3,failure_code=$4,attempt_id=gen_random_uuid(),
         attempt_started_at=now()-interval '12 minutes' WHERE run_id=$1 AND sender_id=$2`,
      [run, sender, status, code],
    );
  await outcome("1001", "sending", null);
  await outcome("1002", "unknown", "send_outcome_unknown");
  await outcome("1003", "failed", "meta_error_100");
  await outcome("1004", "blocked", "reply_window_closed");
  // A contact pause holds the last pending row, so nothing counts as waiting.
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,'1005',true)",
    [W, C],
  );
  const [metrics] = await connectionMetrics(pool, W);
  assert.equal(metrics!.oldest_due_pending_seconds, null);
  assert.ok(metrics!.longest_sending_seconds! >= 719, String(metrics!.longest_sending_seconds));
  assert.deepEqual([metrics!.unknown_24h, metrics!.failed_24h, metrics!.blocked_24h], [1, 1, 1]);
  mock.method(console, "warn", () => undefined);
  await evaluateAlerts(pool, true, "campaign-health-test");
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

test("a budget-limited campaign's wait counts from its last provider call or the budget reopening", async () => {
  const run = await campaign([["1001", "2001"]]);
  await pool.query("UPDATE campaign_deliveries SET next_attempt_at=now()-interval '65 minutes' WHERE run_id=$1", [run]);
  const filler = await campaign([]);
  // The budget closed about an hour ago and regained room a minute ago, when its oldest counted call left the hour.
  await pool.query(
    `INSERT INTO campaign_deliveries(workspace_id,run_id,connection_id,sender_id,recipient_id,status,attempt_id,
       attempt_started_at,provider_message_id,sent_at,provider_called_at)
     SELECT $1,$2,$3,'budget-'||n,'3'||n,'sent',gen_random_uuid(),now()-interval '61 minutes','m'||n,
       now()-interval '61 minutes',now()-CASE WHEN n=1 THEN interval '61 minutes' ELSE interval '59 minutes' END
     FROM generate_series(1,$4::int) n`,
    [W, filler, C, CAMPAIGN_HOURLY_BUDGET],
  );
  const wait = async () => (await connectionMetrics(pool, W))[0]!;
  const reopened = await wait();
  assert.ok(
    reopened.oldest_due_pending_seconds! >= 59 && reopened.oldest_due_pending_seconds! < 120,
    String(reopened.oldest_due_pending_seconds),
  );
  assert.equal(connectionAlerts(reopened, true).includes("oldest_pending"), false);
  // While the run makes progress, the wait counts from the last call.
  await pool.query(
    `UPDATE campaign_deliveries SET provider_called_at=CASE WHEN sender_id='budget-2' THEN now()-interval '10 seconds'
       ELSE now()-interval '2 hours' END WHERE run_id=$1`,
    [filler],
  );
  const progressing = await wait();
  assert.ok(progressing.oldest_due_pending_seconds! < 60, String(progressing.oldest_due_pending_seconds));
  // A queue that stopped after the budget reopened still raises the alert.
  await pool.query("UPDATE campaign_deliveries SET provider_called_at=now()-interval '2 hours' WHERE run_id=$1", [
    filler,
  ]);
  const stuck = await wait();
  assert.ok(stuck.oldest_due_pending_seconds! >= 3599, String(stuck.oldest_due_pending_seconds));
  assert.equal(connectionAlerts(stuck, true).includes("oldest_pending"), true);
});

// The sweep (#273). A paused contact's row is never claimed, so the sweep gives it the final guard's code when a
// block reason applies and leaves it pending otherwise. Each guard case runs again with the contact paused and the
// sweep must reach the guard's outcome without any attempt.
const pauseContact = (sender: string) =>
  pool.query(
    `INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,$3,true)
     ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET paused=true`,
    [W, C, sender],
  );
const closeWindow = (recipient: string) =>
  pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '25 hours' WHERE recipient_id=$1", [
    recipient,
  ]);
for (const { name, change, expect } of guardCases)
  test(`the sweep gives a paused contact's row the guard's outcome: ${name}`, async () => {
    const run = await campaign([["1001", "2001"]]);
    await change();
    await pauseContact("1001");
    const [row] = await rows(run);
    if (expect[0] === "blocked") {
      assert.equal(await endUnreachableCampaignDeliveries(pool), 1);
      const [ended] = await rows(run);
      assert.deepEqual([ended.status, ended.failure_code], expect);
      assert.equal(ended.attempted, false);
      assert.equal(await completeCampaignRuns(pool), 1);
      assert.deepEqual(await runState(run), { status: "completed", version: 2 });
    } else {
      // Only retry reasons apply, so the row stays for the worker exactly as it was.
      assert.equal(await endUnreachableCampaignDeliveries(pool), 0);
      assert.deepEqual(await rows(run), [row]);
      assert.equal(row.status, "pending");
      assert.equal(row.failure_code, null);
      assert.deepEqual(await runState(run), { status: "running", version: 1 });
    }
    assert.equal((await rows(run))[0].called, false);
  });

// A connection that cannot send is never woken, so its rows end as connection_unavailable without a contact pause.
for (const [name, change] of [
  ["inactive", "UPDATE instagram_connections SET active=false"],
  ["sending switched off", "UPDATE instagram_connections SET send_enabled=false"],
  ["no token", "UPDATE instagram_connections SET access_token_encrypted=NULL,token_expires_at=NULL"],
  ["token expired", "UPDATE instagram_connections SET token_expires_at=now()-interval '1 second'"],
] as const)
  test(`the sweep ends the rows of a connection that cannot send: ${name}`, async () => {
    const run = await campaign([
      ["1001", "2001"],
      ["1002", "2002"],
    ]);
    await pool.query(change);
    // The approver became an agent and 1002's window closed too; the guard's first reason, the connection, wins.
    await closeWindow("2002");
    await pool.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [admin]);
    assert.equal(await endUnreachableCampaignDeliveries(pool), 2);
    assert.deepEqual(
      (await rows(run)).map((row) => [row.status, row.failure_code, row.attempted, row.called]),
      [
        ["blocked", "connection_unavailable", false, false],
        ["blocked", "connection_unavailable", false, false],
      ],
    );
  });

test("the sweep leaves reachable rows and the rows of runs that are not running", async () => {
  // Reachable: the worker's guard decides it, even though its window has closed.
  const reachable = await campaign([["1001", "2001"]]);
  await closeWindow("2001");
  // A cancelled run with a row left pending (written directly; a cancel cancels its rows).
  const cancelled = await campaign([["1002", "2002"]]);
  await pauseContact("1002");
  await closeWindow("2002");
  await pool.query("UPDATE campaign_runs SET status='cancelled',cancelled_by=$2,cancelled_at=now() WHERE id=$1", [
    cancelled,
    admin,
  ]);
  const completed = await campaign([["1003", "2003"]]);
  await pauseContact("1003");
  await closeWindow("2003");
  await pool.query("UPDATE campaign_runs SET status='completed' WHERE id=$1", [completed]);
  assert.equal(await endUnreachableCampaignDeliveries(pool), 0);
  for (const run of [reachable, cancelled, completed])
    assert.deepEqual(
      (await rows(run)).map((row) => [row.status, row.failure_code]),
      [["pending", null]],
    );
  // The reachable row is then ended by the worker's guard, as before.
  const seen = graph();
  assert.equal(await deliver(seen), true);
  assert.deepEqual(seen.posts, []);
  assert.deepEqual(
    (await rows(reachable)).map((row) => [row.status, row.failure_code]),
    [["blocked", "reply_window_closed"]],
  );
});

test("the sweep ends at most its limit, oldest first, counting only rows it ends", async () => {
  const run = await campaign([
    ["1001", "2001"],
    ["1002", "2002"],
    ["1003", "2003"],
    ["1004", "2004"],
  ]);
  for (const sender of ["1001", "1002", "1003", "1004"]) await pauseContact(sender);
  for (const recipient of ["2002", "2003", "2004"]) await closeWindow(recipient);
  // 1001 is the oldest and only paused (stage 7), so it never takes a place in the batch.
  await pool.query(
    `UPDATE campaign_deliveries SET created_at=now()-make_interval(mins=>10-(sender_id::int-1000)) WHERE run_id=$1`,
    [run],
  );
  const statuses = async () => (await rows(run)).map((row) => [row.sender_id, row.status]);
  assert.equal(await endUnreachableCampaignDeliveries(pool, { limit: 2 }), 2);
  assert.deepEqual(await statuses(), [
    ["1001", "pending"],
    ["1002", "blocked"],
    ["1003", "blocked"],
    ["1004", "pending"],
  ]);
  assert.equal(await endUnreachableCampaignDeliveries(pool, { limit: 2 }), 1);
  assert.equal(await endUnreachableCampaignDeliveries(pool, { limit: 2 }), 0);
  assert.deepEqual((await statuses()).at(-1), ["1004", "blocked"]);
  assert.deepEqual(await runState(run), { status: "running", version: 1 });
});

test("the sweep skips a held row and never waits on a run or connection lock", async () => {
  const run = await campaign([
    ["1001", "2001"],
    ["1002", "2002"],
  ]);
  for (const sender of ["1001", "1002"]) await pauseContact(sender);
  for (const recipient of ["2001", "2002"]) await closeWindow(recipient);
  const holder = await pool.connect();
  const timeout = () => new Promise<string>((resolve) => setTimeout(() => resolve("waited"), 5_000).unref());
  try {
    await holder.query("BEGIN");
    // A cancel's first lock, a deletion's first lock, and one row held by another worker.
    await holder.query("SELECT id FROM campaign_runs WHERE id=$1 FOR UPDATE", [run]);
    await holder.query("SELECT id FROM instagram_connections WHERE id=$1 FOR UPDATE", [C]);
    await holder.query("SELECT id FROM campaign_deliveries WHERE run_id=$1 AND sender_id='1001' FOR UPDATE", [run]);
    assert.equal(await Promise.race([endUnreachableCampaignDeliveries(pool), timeout()]), 1);
    assert.deepEqual(
      (await rows(run)).map((row) => [row.sender_id, row.status]),
      [
        ["1001", "pending"],
        ["1002", "blocked"],
      ],
    );
    await holder.query("COMMIT");
  } finally {
    holder.release();
  }
  assert.equal(await endUnreachableCampaignDeliveries(pool), 1);
  assert.equal(await completeCampaignRuns(pool), 1);
});

test("a campaign row recovered from a stale sending counts from its recovery, not its attempt start (#274)", async () => {
  const run = await campaign([
    ["1001", "2001"],
    ["1002", "2002"],
  ]);
  await pool.query(
    `UPDATE campaign_deliveries SET status='sending',attempt_id=gen_random_uuid(),
       attempt_started_at=now()-interval '25 hours' WHERE run_id=$1 AND sender_id='1001'`,
    [run],
  );
  // An ordinary unknown outcome that old stays outside the window.
  await pool.query(
    `UPDATE campaign_deliveries SET status='unknown',failure_code='send_outcome_unknown',attempt_id=gen_random_uuid(),
       attempt_started_at=now()-interval '25 hours' WHERE run_id=$1 AND sender_id='1002'`,
    [run],
  );
  assert.equal((await connectionMetrics(pool, W))[0]!.unknown_24h, 0);
  await recoverStaleCampaignDeliveries(pool);
  const [metrics] = await connectionMetrics(pool, W);
  assert.deepEqual([metrics!.unknown_24h, metrics!.failed_24h, metrics!.blocked_24h], [1, 0, 0]);
  mock.method(console, "warn", () => undefined);
  await evaluateAlerts(pool, true, "campaign-recovered-test");
  assert.deepEqual(
    (
      await pool.query(
        "SELECT alert_seen_count FROM scheduled_steps WHERE name='alert_unknown_outcome' AND alert_active",
      )
    ).rows,
    [{ alert_seen_count: "2" }],
  );
});
