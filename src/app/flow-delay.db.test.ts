import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { ingestComments, resumeDueFlowRuns } from "../instagram/store.ts";
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
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };
const now = new Date("2026-09-25T00:00:00.000Z");

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

// start -> add_tag lead -> delay -> has_tag vip -(true)-> reply, with an optional second delay before the reply.
function delayedDocument(options: { minutes?: number; second?: boolean } = {}) {
  const nodes = [
    {
      id: "start",
      type: "instagram_comment",
      config: {
        connection_id: connectionId,
        media_id: "1789",
        keywords: ["link"],
        match_mode: "contains",
        excluded_keywords: [],
      },
    },
    { id: "lead", type: "add_tag", config: { tag: "lead" } },
    { id: "wait", type: "delay", config: { minutes: options.minutes ?? 30 } },
    { id: "vip", type: "has_tag", config: { tag: "vip" } },
    { id: "late", type: "add_tag", config: { tag: "followed_up" } },
    ...(options.second ? [{ id: "again", type: "delay", config: { minutes: 5 } }] : []),
    { id: "reply", type: "instagram_message", config: { text: "Here is the link: {{comment.text}}" } },
  ];
  const edges = [
    { from: "start", port: "next", to: "lead" },
    { from: "lead", port: "next", to: "wait" },
    { from: "wait", port: "next", to: "vip" },
    { from: "vip", port: "true", to: "late" },
    ...(options.second
      ? [
          { from: "late", port: "next", to: "again" },
          { from: "again", port: "next", to: "reply" },
        ]
      : [{ from: "late", port: "next", to: "reply" }]),
  ];
  return { schema_version: 1, nodes, edges };
}

async function enabledFlow(draft: unknown = delayedDocument()): Promise<string> {
  const created = await request("POST", "/api/flows", { name: "Later", draft });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  assert.equal((await request("POST", `/api/flows/${id}/publish`, { expected_revision: 0 })).status, 201);
  assert.equal((await request("POST", `/api/flows/${id}/enable`)).status, 200);
  return id;
}

function comment(commentId: string, senderId: string, text = "send the link") {
  return ingestComments(pool, [{ accountId: "owned-account", commentId, postId: "1789", senderId, text }]);
}

async function tag(senderId: string, tags: string[]) {
  await pool.query(
    `INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,$4)
     ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET tags=EXCLUDED.tags`,
    [workspaceId, connectionId, senderId, tags],
  );
}

async function tagsOf(senderId: string): Promise<string[] | undefined> {
  return (
    await pool.query("SELECT tags FROM instagram_contact_tags WHERE connection_id=$1 AND sender_id=$2", [
      connectionId,
      senderId,
    ])
  ).rows[0]?.tags;
}

// Makes every waiting run due without waiting for the clock.
async function makeDue() {
  await pool.query("UPDATE flow_runs SET resume_at=now()-interval '1 second' WHERE status='waiting'");
}

type Run = {
  status: string;
  failure_code: string | null;
  resume_at: string | null;
  delivery_status: string | null;
  delivery_failure_code: string | null;
  steps: { node_id: string; outcome: string }[];
};

async function runs(id: string): Promise<Run[]> {
  const response = await request("GET", `/api/flows/${id}/runs`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { runs: Run[] }).runs;
}

function transport(commentCreatedAt = new Date("2026-09-24T00:00:00.000Z")): PrivateReplyTransport {
  return {
    verify: async () => ({ commentCreatedAt, authorizationVerified: true, mediaOwned: true }),
    send: async (reply) => ({ messageId: `mid-${reply.commentId}` }),
  };
}

test("a comment stops at the delay as a waiting run due in UTC after the actions before it", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  assert.deepEqual(await tagsOf("sender-1"), ["lead"]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM private_reply_outbox")).rows[0].count, 0);
  const stored = (
    await pool.query(
      "SELECT status,resume_node_id,extract(epoch FROM resume_at-created_at)::int AS seconds FROM flow_runs",
    )
  ).rows[0];
  assert.equal(stored.status, "waiting");
  assert.equal(stored.resume_node_id, "wait");
  assert.ok(Math.abs(stored.seconds - 1800) <= 1, String(stored.seconds));
  const [run] = await runs(id);
  assert.equal(run!.status, "waiting");
  assert.match(run!.resume_at!, /Z$/);
  assert.deepEqual(
    run!.steps.map((step) => step.outcome),
    ["next", "added", "waiting"],
  );
  // Not due yet: nothing resumes.
  assert.equal(await resumeDueFlowRuns(pool), 0);
  assert.equal((await runs(id))[0]!.status, "waiting");
});

test("a due run continues with the contact read at resume time and queues its reply once", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1", "link please");
  await tag("sender-1", ["lead", "vip"]);
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 1);
  assert.equal(await resumeDueFlowRuns(pool), 0);
  assert.deepEqual(await tagsOf("sender-1"), ["lead", "vip", "followed_up"]);
  const replies = (await pool.query("SELECT private_reply_text,status FROM private_reply_outbox")).rows;
  assert.deepEqual(replies, [{ private_reply_text: "Here is the link: link please", status: "pending" }]);
  const [run] = await runs(id);
  assert.equal(run!.status, "delivering");
  assert.equal(run!.resume_at, null);
  assert.deepEqual(
    run!.steps.map((step) => [step.node_id, step.outcome]),
    [
      ["start", "next"],
      ["lead", "added"],
      ["wait", "waiting"],
      ["vip", "true"],
      ["late", "added"],
      ["reply", "queued"],
    ],
  );
  assert.equal(await processNextPrivateReply(pool, transport(), () => now, connectionId), true);
  assert.equal((await runs(id))[0]!.delivery_status, "sent");
});

test("a contact that no longer matches after the delay ends the run without a reply", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 1);
  const [run] = await runs(id);
  assert.equal(run!.status, "ended");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM private_reply_outbox")).rows[0].count, 0);
});

test("a second delay sets a new due time and the run resumes twice", async () => {
  const id = await enabledFlow(delayedDocument({ second: true }));
  await comment("comment-1", "sender-1");
  await tag("sender-1", ["lead", "vip"]);
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 1);
  const waiting = (await pool.query("SELECT status,resume_node_id,resume_at>now() AS future FROM flow_runs")).rows[0];
  assert.deepEqual(waiting, { status: "waiting", resume_node_id: "again", future: true });
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 1);
  const [run] = await runs(id);
  assert.equal(run!.status, "delivering");
  assert.deepEqual(
    run!.steps.map((step) => step.outcome),
    ["next", "added", "waiting", "true", "added", "waiting", "queued"],
  );
});

test("the next delay counts from when the run reaches it, not from when the resume began", async () => {
  await enabledFlow(delayedDocument({ second: true }));
  await comment("comment-1", "sender-1");
  await tag("sender-1", ["lead", "vip"]);
  await makeDue();
  const holder = await pool.connect();
  let finishedAt: Date;
  try {
    // A manual edit holding the contact lock makes the resume wait before it reaches the second delay.
    await holder.query("BEGIN");
    await lockContact(holder, connectionId, "sender-1");
    const resumed = resumeDueFlowRuns(pool).then((count) => {
      finishedAt = new Date();
      return count;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await holder.query("COMMIT");
    assert.equal(await resumed, 1);
  } finally {
    holder.release();
  }
  const row = (await pool.query<{ resume_at: Date }>("SELECT resume_at FROM flow_runs")).rows[0]!;
  // The second delay is 5 minutes; the lock wait must not shorten it.
  assert.ok(row.resume_at.getTime() - finishedAt!.getTime() >= 5 * 60_000 - 500, String(row.resume_at));
});

test("a flow turned off during the delay cancels the run and stays cancelled when turned on again", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await tag("sender-1", ["lead", "vip"]);
  assert.equal((await request("POST", `/api/flows/${id}/disable`)).status, 200);
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 1);
  assert.equal((await request("POST", `/api/flows/${id}/enable`)).status, 200);
  assert.equal(await resumeDueFlowRuns(pool), 0);
  const [run] = await runs(id);
  assert.deepEqual([run!.status, run!.failure_code], ["cancelled", "inactive_flow"]);
  assert.deepEqual(
    run!.steps.map((step) => step.outcome),
    ["next", "added", "waiting"],
  );
  assert.deepEqual(await tagsOf("sender-1"), ["lead", "vip"]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM private_reply_outbox")).rows[0].count, 0);
});

test("an inactive connection cancels a due run without running the nodes after the delay", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await tag("sender-1", ["lead", "vip"]);
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connectionId]);
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 1);
  const [run] = await runs(id);
  assert.deepEqual([run!.status, run!.failure_code], ["cancelled", "connection_unavailable"]);
  assert.deepEqual(await tagsOf("sender-1"), ["lead", "vip"]);
});

test("overlapping resumers advance a due run once", async () => {
  const id = await enabledFlow();
  for (const index of [1, 2, 3, 4]) {
    await comment(`comment-${index}`, `sender-${index}`);
    await tag(`sender-${index}`, ["lead", "vip"]);
  }
  await makeDue();
  const advanced = await Promise.all([resumeDueFlowRuns(pool), resumeDueFlowRuns(pool), resumeDueFlowRuns(pool)]);
  assert.equal(
    advanced.reduce((sum: number, count: number) => sum + count, 0),
    4,
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM private_reply_outbox")).rows[0].count, 4);
  for (const run of await runs(id)) {
    assert.equal(run.status, "delivering");
    assert.equal(run.steps.length, 6);
  }
});

test("a reply already queued for the same sender and media marks the resumed run skipped", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await comment("comment-2", "sender-1");
  await tag("sender-1", ["lead", "vip"]);
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 2);
  const states = (await runs(id)).map((run) => [run.status, run.failure_code, run.steps.at(-1)!.outcome]).sort();
  assert.deepEqual(states, [
    ["delivering", null, "queued"],
    ["skipped", "duplicate_recipient", "duplicate_recipient"],
  ]);
});

test("a resume waits for a lock on its connection before it locks the run", async () => {
  await enabledFlow();
  await comment("comment-1", "sender-1");
  await tag("sender-1", ["lead", "vip"]);
  await makeDue();
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM instagram_connections WHERE id=$1 FOR UPDATE", [connectionId]);
    const resumed = resumeDueFlowRuns(pool);
    for (let attempt = 0; attempt < 60; attempt++) {
      const waiting = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%instagram_connections%FOR SHARE%'",
      );
      if (waiting.rowCount) break;
      if (attempt === 59) assert.fail("the resume did not wait on the connection lock");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // The run row itself is still free while the resume waits on its connection.
    const free = await pool.query("SELECT id FROM flow_runs FOR UPDATE NOWAIT");
    assert.equal(free.rowCount, 1);
    await holder.query("COMMIT");
    assert.equal(await resumed, 1);
  } finally {
    holder.release();
  }
});

test("after the delay the reply still passes the opt-out, pause and comment window guards", async () => {
  await enabledFlow();
  for (const sender of ["opted-out", "paused", "expired", "eligible"]) {
    await comment(`comment-${sender}`, sender);
    await tag(sender, ["lead", "vip"]);
  }
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 4);
  const event = (
    await pool.query(
      `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
       VALUES(gen_random_uuid(),$1,$2,'instagram','comment_sender','opted-out','service_reply','revoke','explicit','ref',now(),$3) RETURNING id`,
      [workspaceId, connectionId, userId],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
     SELECT workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,id
     FROM channel_consent_events WHERE id=$1`,
    [event],
  );
  await pool.query(
    `INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused,handoff_paused)
     VALUES($1,$2,'paused',true,false)`,
    [workspaceId, connectionId],
  );
  // The comment window is checked against the time Meta reports for the comment, at send time.
  const checked: PrivateReplyTransport = {
    ...transport(),
    verify: async (reply) => ({
      commentCreatedAt: reply.commentId === "comment-expired" ? new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000) : now,
      authorizationVerified: true,
      mediaOwned: true,
    }),
  };
  let processed = 0;
  while (await processNextPrivateReply(pool, checked, () => now, connectionId)) processed++;
  assert.equal(processed, 3);
  const outcomes = (
    await pool.query("SELECT sender_id,status,failure_code FROM private_reply_outbox ORDER BY sender_id")
  ).rows.map((row) => [row.sender_id, row.status, row.failure_code]);
  assert.deepEqual(outcomes, [
    ["eligible", "sent", null],
    ["expired", "blocked", "comment_expired"],
    ["opted-out", "blocked", "recipient_opted_out"],
    ["paused", "pending", null],
  ]);
});

test("a flow turned off after its delayed reply was queued blocks that reply", async () => {
  const id = await enabledFlow();
  await comment("comment-1", "sender-1");
  await tag("sender-1", ["lead", "vip"]);
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 1);
  assert.equal((await request("POST", `/api/flows/${id}/disable`)).status, 200);
  assert.equal(await processNextPrivateReply(pool, transport(), () => now, connectionId), true);
  const [run] = await runs(id);
  assert.deepEqual([run!.delivery_status, run!.delivery_failure_code], ["blocked", "inactive_flow"]);
});

test("deleting a connection or a person removes their waiting runs", async () => {
  await enabledFlow();
  await comment("comment-a", "sender-a");
  await comment("comment-b", "sender-b");
  const person = (
    await pool.query<{ result: { deleted_counts: Record<string, number> } }>(
      "SELECT public.delete_person_data($1,$2,$3,'comment_sender','sender-a') AS result",
      [workspaceId, connectionId, userId],
    )
  ).rows[0]!.result;
  assert.equal(person.deleted_counts.flow_runs, 1);
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
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 0);
});

test("migration 025 replays and only a waiting run carries a resume point", async () => {
  await enabledFlow();
  await comment("comment-1", "sender-1");
  const migration = await readFile(new URL("../../db/migrations/025_flow_delays.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  assert.equal((await pool.query("SELECT status FROM flow_runs")).rows[0].status, "waiting");
  await assert.rejects(pool.query("UPDATE flow_runs SET resume_at=NULL"), { code: "23514" });
  await assert.rejects(pool.query("UPDATE flow_runs SET status='ended'"), { code: "23514" });
  await assert.rejects(pool.query("UPDATE flow_runs SET status='cancelled',resume_at=NULL,resume_node_id=NULL"), {
    code: "23514",
  });
  await pool.query(
    "UPDATE flow_runs SET status='cancelled',failure_code='inactive_flow',resume_at=NULL,resume_node_id=NULL",
  );
});
