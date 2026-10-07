import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { ingestComments, nextWallClockSql, resumeDueFlowRuns } from "../instagram/store.ts";
import { processNextPrivateReply, type PrivateReplyTransport } from "../instagram/reply-worker.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const testUrl = new URL(databaseUrl);
if (!["localhost", "127.0.0.1"].includes(testUrl.hostname) || testUrl.pathname !== "/automations_test")
  throw new Error("TEST_DATABASE_URL must point at the local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const ownerId = "11111111-1111-4111-8111-111111111111";
const adminId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const outsiderId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "55555555-5555-4555-8555-555555555555";
const otherWorkspaceId = "66666666-6666-4666-8666-666666666666";
const connectionId = "77777777-7777-4777-8777-777777777777";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role)
     VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')`,
    [workspaceId, ownerId, adminId, agentId, otherWorkspaceId, outsiderId],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted)
     VALUES($1,$2,'owned-account',true,'token')`,
    [connectionId, workspaceId],
  );
});

after(async () => pool.end());

function request(actorId: string, method: string, path: string, body?: unknown, origin = "https://app.test") {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin, cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () =>
      Response.json({ id: actorId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

async function zoneOf(id = workspaceId): Promise<string> {
  return (await pool.query("SELECT time_zone FROM workspaces WHERE id=$1", [id])).rows[0].time_zone;
}

async function setZone(zone: string) {
  await pool.query("UPDATE workspaces SET time_zone=$2 WHERE id=$1", [workspaceId, zone]);
}

test("the workspace payload carries its time zone, Asia/Seoul by default, for every role", async () => {
  for (const actor of [ownerId, adminId, agentId]) {
    const response = await request(actor, "POST", "/api/workspace");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { workspace_id: string; time_zone: string };
    assert.equal(body.workspace_id, workspaceId);
    assert.equal(body.time_zone, "Asia/Seoul");
  }
});

test("admins and owners change the time zone, agents only read it", async () => {
  const saved = await request(adminId, "PUT", "/api/workspace/settings", { time_zone: "America/New_York" });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { time_zone: "America/New_York" });
  const read = (await (await request(agentId, "POST", "/api/workspace")).json()) as { time_zone: string };
  assert.equal(read.time_zone, "America/New_York");
  const denied = await request(agentId, "PUT", "/api/workspace/settings", { time_zone: "Europe/Paris" });
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as { error: string }).error, "role_forbidden");
  assert.equal(await zoneOf(), "America/New_York");
  assert.equal((await request(ownerId, "PUT", "/api/workspace/settings", { time_zone: "UTC" })).status, 200);
  assert.equal(await zoneOf(), "UTC");
  // Another workspace's owner changes only that workspace.
  assert.equal((await request(outsiderId, "PUT", "/api/workspace/settings", { time_zone: "Asia/Tokyo" })).status, 200);
  assert.equal(await zoneOf(), "UTC");
  assert.equal(await zoneOf(otherWorkspaceId), "Asia/Tokyo");
});

test("only time zone names PostgreSQL knows are stored, compared case-sensitively", async () => {
  for (const time_zone of [
    "asia/seoul",
    "Mars/Olympus",
    "",
    " Asia/Seoul",
    "+09:00",
    "KST",
    "x".repeat(101),
    9,
    null,
  ]) {
    const response = await request(adminId, "PUT", "/api/workspace/settings", { time_zone });
    assert.equal(response.status, 400, JSON.stringify(time_zone));
    assert.equal(((await response.json()) as { error: string }).error, "invalid_time_zone");
  }
  assert.equal((await request(adminId, "PUT", "/api/workspace/settings", {})).status, 400);
  assert.equal(await zoneOf(), "Asia/Seoul");
  const crossOrigin = await request(
    adminId,
    "PUT",
    "/api/workspace/settings",
    { time_zone: "UTC" },
    "https://evil.test",
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(await zoneOf(), "Asia/Seoul");
});

async function nextWallClock(at: string, zone: string, time: string): Promise<string> {
  const result = await pool.query<{ next: Date }>(`SELECT ${nextWallClockSql("$1", "$2", "$3")} AS next`, [
    at,
    zone,
    time,
  ]);
  return result.rows[0]!.next.toISOString();
}

test("the next wall-clock time is strictly later, so the same minute means tomorrow", async () => {
  const cases: [string, string, string, string][] = [
    // 09:00 in Seoul is 00:00 UTC.
    ["2026-10-01T00:00:00Z", "Asia/Seoul", "09:30", "2026-10-01T00:30:00.000Z"],
    ["2026-10-01T00:00:00Z", "Asia/Seoul", "09:00", "2026-10-02T00:00:00.000Z"],
    ["2026-10-01T00:00:30Z", "Asia/Seoul", "09:00", "2026-10-02T00:00:00.000Z"],
    ["2026-09-30T23:59:59.999999Z", "Asia/Seoul", "09:00", "2026-10-01T00:00:00.000Z"],
    ["2026-10-01T00:00:00Z", "Asia/Seoul", "08:59", "2026-10-01T23:59:00.000Z"],
    ["2026-10-01T23:30:00Z", "UTC", "00:15", "2026-10-02T00:15:00.000Z"],
    // 22:00 on 30 September in Los Angeles: the local day is not the UTC or the session day.
    ["2026-10-01T05:00:00Z", "America/Los_Angeles", "23:00", "2026-10-01T06:00:00.000Z"],
    ["2026-10-01T05:00:00Z", "America/Los_Angeles", "00:00", "2026-10-01T07:00:00.000Z"],
  ];
  for (const [at, zone, time, expected] of cases)
    assert.equal(await nextWallClock(at, zone, time), expected, `${at} ${zone} ${time}`);
});

test("the next wall-clock time follows PostgreSQL across daylight-saving changes", async () => {
  const cases: [string, string, string][] = [
    // 8 March 2026: New York skips 02:00-03:00 EST (UTC-5) to EDT (UTC-4).
    ["2026-03-07T14:00:00Z", "09:00", "2026-03-08T13:00:00.000Z"], // 23 hours later
    ["2026-03-08T06:00:00Z", "02:30", "2026-03-08T07:30:00.000Z"], // skipped, read as 03:30 EDT
    ["2026-03-08T06:00:00Z", "01:30", "2026-03-08T06:30:00.000Z"],
    // 1 November 2026: New York repeats 01:00-02:00, EDT then EST.
    ["2026-10-31T13:00:00Z", "09:00", "2026-11-01T14:00:00.000Z"], // 25 hours later
    ["2026-11-01T05:15:00Z", "01:30", "2026-11-01T05:30:00.000Z"], // the first 01:30 (EDT)
    ["2026-11-01T05:45:00Z", "01:30", "2026-11-01T06:30:00.000Z"], // 01:45 EDT, the second 01:30 (EST)
    ["2026-11-01T06:45:00Z", "01:30", "2026-11-02T06:30:00.000Z"], // 01:45 EST, past both
    ["2026-11-01T04:30:00Z", "00:20", "2026-11-02T05:20:00.000Z"], // 00:30 EDT, 25 hours less 10 minutes
  ];
  for (const [at, time, expected] of cases)
    assert.equal(await nextWallClock(at, "America/New_York", time), expected, `${at} ${time}`);
});

test("a time that occurs twice resumes at its first occurrence in a two-hour overlap", async () => {
  // 25 October 2026 at 01:00 UTC: Antarctica/Troll goes from UTC+2 back to UTC+0, so 01:00-03:00 repeats.
  const cases: [string, string, string][] = [
    ["2026-10-24T22:30:00Z", "01:30", "2026-10-24T23:30:00.000Z"], // the first 01:30 (+02)
    ["2026-10-25T00:30:00Z", "01:30", "2026-10-25T01:30:00.000Z"], // 02:30 +02, the second 01:30 (+00)
    ["2026-10-25T01:45:00Z", "01:30", "2026-10-26T01:30:00.000Z"], // 01:45 +00, past both
    ["2026-10-24T22:01:00Z", "00:00", "2026-10-26T00:00:00.000Z"], // 00:01 +02, 26 hours less a minute
  ];
  for (const [at, time, expected] of cases)
    assert.equal(await nextWallClock(at, "Antarctica/Troll", time), expected, `${at} ${time}`);
});

test("the next wall-clock time does not depend on the session time zone", async () => {
  const client = await pool.connect();
  try {
    for (const session of ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Seoul"]) {
      await client.query(`SET TimeZone='${session}'`);
      const result = await client.query<{ next: Date }>(`SELECT ${nextWallClockSql("$1", "$2", "$3")} AS next`, [
        "2026-10-01T05:00:00Z",
        "America/Los_Angeles",
        "23:00",
      ]);
      assert.equal(result.rows[0]!.next.toISOString(), "2026-10-01T06:00:00.000Z", session);
      const overlap = await client.query<{ next: Date }>(`SELECT ${nextWallClockSql("$1", "$2", "$3")} AS next`, [
        "2026-11-01T05:15:00Z",
        "America/New_York",
        "01:30",
      ]);
      assert.equal(overlap.rows[0]!.next.toISOString(), "2026-11-01T05:30:00.000Z", `${session} overlap`);
    }
  } finally {
    await client.query("RESET TimeZone");
    client.release();
  }
});

// start -> add_tag lead [-> delay] -> wait_until -> reply.
function timedDocument(time: string, delayFirst = false) {
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
    ...(delayFirst ? [{ id: "pause", type: "delay", config: { minutes: 5 } }] : []),
    { id: "clock", type: "wait_until", config: { time } },
    { id: "reply", type: "instagram_message", config: { text: "Good morning: {{comment.text}}" } },
  ];
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, port: "next", to: node.id }));
  return { schema_version: 1, nodes, edges };
}

async function enabledFlow(draft: unknown): Promise<string> {
  const created = await request(ownerId, "POST", "/api/flows", { name: "Morning", draft });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  assert.equal((await request(ownerId, "POST", `/api/flows/${id}/publish`, { expected_revision: 0 })).status, 201);
  assert.equal((await request(ownerId, "POST", `/api/flows/${id}/enable`)).status, 200);
  return id;
}

function comment(commentId: string, senderId: string, text = "send the link") {
  return ingestComments(pool, [{ accountId: "owned-account", commentId, postId: "1789", senderId, text }]);
}

type StoredRun = { status: string; resume_node_id: string | null; local: string; ahead: boolean; within: boolean };

// The stored resume time read back in a zone: its local wall-clock time, and whether it lies after
// the run reached the node and no more than a day and an hour later.
async function storedRuns(zone: string): Promise<StoredRun[]> {
  return (
    await pool.query<StoredRun>(
      `SELECT status,resume_node_id,to_char(resume_at AT TIME ZONE $1,'HH24:MI:SS') AS local,
         resume_at>created_at AS ahead,resume_at<=clock_timestamp()+interval '25 hours' AS within
       FROM flow_runs ORDER BY created_at,id`,
      [zone],
    )
  ).rows;
}

async function makeDue() {
  await pool.query("UPDATE flow_runs SET resume_at=now()-interval '1 second' WHERE status='waiting'");
}

const transport: PrivateReplyTransport = {
  verify: async () => ({ commentCreatedAt: new Date(), authorizationVerified: true, mediaOwned: true }),
  send: async (reply) => ({ messageId: `mid-${reply.commentId}` }),
};

test("a comment stops at a time wait until that local time in the workspace's zone", async () => {
  await setZone("America/New_York");
  const id = await enabledFlow(timedDocument("09:30"));
  await comment("comment-1", "sender-1");
  assert.deepEqual(await storedRuns("America/New_York"), [
    { status: "waiting", resume_node_id: "clock", local: "09:30:00", ahead: true, within: true },
  ]);
  const listed = (await (await request(agentId, "GET", `/api/flows/${id}/runs`)).json()) as {
    runs: { resume_at: string; steps: { outcome: string }[] }[];
  };
  assert.match(listed.runs[0]!.resume_at, /Z$/);
  assert.deepEqual(
    listed.runs[0]!.steps.map((step) => step.outcome),
    ["next", "added", "waiting"],
  );
  assert.equal(await resumeDueFlowRuns(pool), 0);
});

test("a time wait reads the zone when the run reaches it; a later change moves no waiting run", async () => {
  await setZone("Asia/Seoul");
  await enabledFlow(timedDocument("09:30"));
  await comment("comment-1", "sender-1");
  const firstResume = (await pool.query("SELECT resume_at FROM flow_runs")).rows[0].resume_at as Date;
  assert.equal(
    (await request(adminId, "PUT", "/api/workspace/settings", { time_zone: "America/Los_Angeles" })).status,
    200,
  );
  await comment("comment-2", "sender-2");
  const [first, second] = await storedRuns("Asia/Seoul");
  assert.equal(first!.local, "09:30:00");
  assert.equal(
    ((await pool.query("SELECT resume_at FROM flow_runs ORDER BY created_at,id")).rows[0].resume_at as Date).getTime(),
    firstResume.getTime(),
  );
  assert.equal(second!.status, "waiting");
  assert.equal((await storedRuns("America/Los_Angeles"))[1]!.local, "09:30:00");
});

test("a time wait for the current local minute resumes the same time tomorrow", async () => {
  await setZone("Europe/Paris");
  const minute = (
    await pool.query<{ minute: string }>(
      "SELECT to_char(clock_timestamp() AT TIME ZONE 'Europe/Paris','HH24:MI') AS minute",
    )
  ).rows[0]!.minute;
  await enabledFlow(timedDocument(minute));
  await comment("comment-1", "sender-1");
  const row = (
    await pool.query(
      `SELECT to_char(resume_at AT TIME ZONE 'Europe/Paris','HH24:MI:SS') AS local,
         resume_at>clock_timestamp()+interval '22 hours' AS tomorrow FROM flow_runs`,
    )
  ).rows[0];
  assert.deepEqual(row, { local: `${minute}:00`, tomorrow: true });
});

test("a due time wait continues the run and queues its reply once", async () => {
  const id = await enabledFlow(timedDocument("07:00"));
  await comment("comment-1", "sender-1", "link please");
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 1);
  assert.equal(await resumeDueFlowRuns(pool), 0);
  const replies = (await pool.query("SELECT private_reply_text,status FROM private_reply_outbox")).rows;
  assert.deepEqual(replies, [{ private_reply_text: "Good morning: link please", status: "pending" }]);
  assert.equal(await processNextPrivateReply(pool, transport, () => new Date(), connectionId), true);
  const listed = (await (await request(ownerId, "GET", `/api/flows/${id}/runs`)).json()) as {
    runs: { status: string; resume_at: string | null; delivery_status: string; steps: { node_id: string }[] }[];
  };
  const [run] = listed.runs;
  assert.deepEqual([run!.status, run!.resume_at, run!.delivery_status], ["delivering", null, "sent"]);
  assert.deepEqual(
    run!.steps.map((step) => step.node_id),
    ["start", "lead", "clock", "reply"],
  );
});

test("a run that reaches a time wait after a delay reads the zone at that moment", async () => {
  await setZone("Asia/Seoul");
  await enabledFlow(timedDocument("18:45", true));
  await comment("comment-1", "sender-1");
  assert.deepEqual(
    (await storedRuns("Asia/Seoul")).map((run) => run.resume_node_id),
    ["pause"],
  );
  await setZone("Australia/Adelaide");
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 1);
  assert.deepEqual(await storedRuns("Australia/Adelaide"), [
    { status: "waiting", resume_node_id: "clock", local: "18:45:00", ahead: true, within: true },
  ]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM private_reply_outbox")).rows[0].count, 0);
});

test("a flow turned off during a time wait cancels the run", async () => {
  const id = await enabledFlow(timedDocument("07:00"));
  await comment("comment-1", "sender-1");
  assert.equal((await request(ownerId, "POST", `/api/flows/${id}/disable`)).status, 200);
  await makeDue();
  assert.equal(await resumeDueFlowRuns(pool), 1);
  const run = (await pool.query("SELECT status,failure_code,resume_at FROM flow_runs")).rows[0];
  assert.deepEqual(run, { status: "cancelled", failure_code: "inactive_flow", resume_at: null });
});

test("migration 027 replays and gives existing workspaces the default zone", async () => {
  const migration = await readFile(new URL("../../db/migrations/027_workspace_time_zone.sql", import.meta.url), "utf8");
  await setZone("Europe/Paris");
  await pool.query(migration);
  assert.equal(await zoneOf(), "Europe/Paris");
  await pool.query("ALTER TABLE workspaces DROP COLUMN time_zone");
  try {
    await pool.query(migration);
    await pool.query(migration);
  } finally {
    await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  }
  assert.equal(await zoneOf(), "Asia/Seoul");
  assert.equal(await zoneOf(otherWorkspaceId), "Asia/Seoul");
  await assert.rejects(pool.query("UPDATE workspaces SET time_zone=NULL"), { code: "23502" });
});
