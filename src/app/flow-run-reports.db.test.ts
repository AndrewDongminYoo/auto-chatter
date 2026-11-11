import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(testUrl.hostname)) throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl });
const workspace = "11111111-1111-4111-8111-111111111111";
const otherWorkspace = "22222222-2222-4222-8222-222222222222";
const owner = "33333333-3333-4333-8333-333333333333";
const agent = "44444444-4444-4444-8444-444444444444";
const connection = "55555555-5555-4555-8555-555555555555";
const otherConnection = "66666666-6666-4666-8666-666666666666";
const secondConnection = "77777777-7777-4777-8777-777777777777";
const flow = "88888888-8888-4888-8888-888888888888";
const archivedFlow = "99999999-9999-4999-8999-999999999999";
const otherFlow = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const params = "from=2026-10-01&before=2026-10-02&expected_time_zone=Asia%2FSeoul";
let serial = 0;

before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  serial = 0;
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspace, otherWorkspace]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent')", [workspace, owner, agent]);
  for (const [ws, id] of [
    [workspace, connection],
    [workspace, secondConnection],
    [otherWorkspace, otherConnection],
  ])
    await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id,username,instagram_user_id) VALUES($1::uuid,$2,$1::text,'SECRET-ACCOUNT',$1::text)", [id, ws]);
  for (const [ws, id, conn] of [
    [workspace, flow, connection],
    [workspace, archivedFlow, connection],
    [otherWorkspace, otherFlow, otherConnection],
  ]) {
    await pool.query("INSERT INTO flows(id,workspace_id,name,draft,archived) VALUES($1,$2,'SECRET-FLOW','{}',$3)", [id, ws, id === archivedFlow]);
    await pool.query(
      `INSERT INTO flow_versions(id,flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,published_by)
       VALUES($1,$1,$2,1,0,'{}',$3,'1789',$4)`,
      [id, ws, conn, owner],
    );
  }
  // The current version uses another account, but older runs keep their original connection.
  const currentVersion = (
    await pool.query(
      `INSERT INTO flow_versions(flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,published_by)
     VALUES($1,$2,2,1,'{}',$3,'1789',$4) RETURNING id`,
      [flow, workspace, secondConnection, owner],
    )
  ).rows[0].id;
  await pool.query("UPDATE flows SET published_version_id=$2 WHERE id=$1", [flow, currentVersion]);
});
after(async () => pool.end());

async function seed(status: string, replyStatus?: string, at = "2026-09-30T15:00:00Z", id = flow, conn = connection) {
  const ws = id === otherFlow ? otherWorkspace : workspace;
  const key = String(++serial);
  const event = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     VALUES($1,$2,$3,'1789',$3,'SECRET-COMMENT') RETURNING id`,
      [ws, conn, key],
    )
  ).rows[0].id;
  const version = (await pool.query("SELECT id FROM flow_versions WHERE flow_id=$1 AND trigger_connection_id=$2 ORDER BY version_no LIMIT 1", [id, conn])).rows[0].id;
  const run = (
    await pool.query(
      `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,event_id,status,failure_code,created_at,resume_at,resume_node_id)
     VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $6 IN ('failed','skipped','cancelled') THEN 'test_reason' END,$7,
       CASE WHEN $6='waiting' THEN now()+interval '1 day' END,CASE WHEN $6 IN ('waiting','awaiting_reply') THEN 'wait' END) RETURNING id`,
      [ws, conn, id, version, event, status, at],
    )
  ).rows[0].id;
  if (replyStatus)
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,flow_run_id,comment_id,media_id,sender_id,private_reply_text,status,attempt_id,attempt_started_at)
     VALUES($1,$2,$3,NULL,$4,$5,'1789',$5,'SECRET-MESSAGE',$6,gen_random_uuid(),now())`,
      [ws, conn, event, run, key, replyStatus],
    );
  return { id: run, event };
}

function request(query = params, actor = owner, plans?: Record<string, unknown>[]) {
  return appApi(
    new Request(`https://app.test/api/reports/flow-runs?${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
    { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" },
    () =>
      ({
        query: async (sql: string, values: unknown[]) => {
          if (plans && sql.startsWith("WITH context")) {
            const result = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
            plans.push(result.rows[0]["QUERY PLAN"][0].Plan);
          }
          return pool.query(sql, values);
        },
        connect: pool.connect.bind(pool),
        end: async () => {},
      }) as unknown as Pool,
    (async () => Response.json({ id: actor, email: "owner@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}
async function report(query = params) {
  const response = await request(query);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

type Counts = Record<string, string>;
type Group = { key: string; run_counts: Counts; reply_counts: Counts; reply_wait_counts: Counts };
const partitions = ["run_counts", "reply_counts", "reply_wait_counts"] as const;

// Each partition sums to its total, inside every group and at the top, and the groups add up to the top level.
// `read` and `read_unavailable` are disjoint subsets of `sent`, outside the first-reply partition.
function assertPartitions(counts: Group | Record<(typeof partitions)[number], Counts>) {
  const { total, ...states } = counts.run_counts;
  const sum = (values: string[]) => values.reduce((a, b) => a + BigInt(b), 0n);
  assert.equal(sum(Object.values(states)), BigInt(total!));
  const { read, read_unavailable, ...replies } = counts.reply_counts;
  assert.equal(sum(Object.values(replies)), BigInt(total!));
  assert.ok(BigInt(read!) + BigInt(read_unavailable!) <= BigInt(replies.sent!));
  const wait = counts.reply_wait_counts;
  assert.equal(BigInt(wait.replied!) + BigInt(wait.not_replied!), BigInt(wait.reached!));
  assert.ok(BigInt(wait.reached!) <= BigInt(total!));
}
function assertGroupSums(body: Record<string, unknown>) {
  const groups = body.groups as Group[];
  assertPartitions(body as unknown as Group);
  for (const group of groups) assertPartitions(group);
  for (const partition of partitions)
    for (const [metric, value] of Object.entries(body[partition] as Counts))
      assert.equal(
        groups.reduce((total, group) => total + BigInt(group[partition][metric]!), 0n),
        BigInt(value),
        `${partition}/${metric}`,
      );
}

test("flow report keeps run and first-reply states separate, including absent replies and repeated steps", async () => {
  const first = await seed("delivering", "unknown");
  await seed("ended", "sent");
  await seed("skipped");
  await seed("failed");
  await seed("waiting");
  await seed("awaiting_reply", "pending");
  await seed("cancelled", "blocked");
  await seed("delivering", "sending");
  await seed("delivering", "failed");
  await pool.query(
    `INSERT INTO flow_step_runs(run_id,workspace_id,connection_id,seq,node_id,node_type,outcome)
     VALUES($1,$2,$3,1,'start','instagram_comment','next'),($1,$2,$3,2,'end','has_tag','false')`,
    [first.id, workspace, connection],
  );
  const body = await report();
  assert.deepEqual(body.run_counts, {
    total: "9",
    delivering: "3",
    ended: "1",
    skipped: "1",
    failed: "1",
    waiting: "1",
    awaiting_reply: "1",
    cancelled: "1",
  });
  assert.deepEqual(body.reply_counts, {
    absent: "3",
    pending: "1",
    sending: "1",
    sent: "1",
    read: "0",
    read_unavailable: "0",
    blocked: "1",
    failed: "1",
    unknown: "1",
  });
  // Runs that queued a reply and left delivering count as having reached a wait; the writers that produce
  // reached and replied runs are exercised in flow-reply-wait.db.test.ts.
  assert.deepEqual(body.reply_wait_counts, { reached: "3", replied: "0", not_replied: "3" });
  assert.equal(body.group_by, null);
  assert.equal("groups" in body, false);
  assert.equal(body.time_zone, "Asia/Seoul");
  assert.equal(body.period_from, "2026-09-30T15:00:00.000Z");
  assert.equal(body.period_before, "2026-10-01T15:00:00.000Z");
  assert.equal(body.connection_id, null);
  assert.equal(body.flow_id, null);
  assert.ok(Date.now() - Date.parse(body.checked_at) < 60_000);
  assert.equal(JSON.stringify(body).includes("SECRET"), false);
  assert.equal(JSON.stringify(body).includes(first.id), false);
  await pool.query("UPDATE private_reply_outbox SET status='sent',sent_at=now() WHERE flow_run_id=$1", [first.id]);
  const updated = await report();
  assert.equal(updated.run_counts.delivering, "3");
  assert.equal(updated.reply_counts.sent, "2");
  assert.equal(updated.reply_counts.unknown, "0");
});

// Read rows are written directly: the report reads stored reads and never depends on the webhook path.
async function markRead(conn: string, messageId: string, recipient = "901") {
  await pool.query(
    `INSERT INTO instagram_message_reads(workspace_id,connection_id,recipient_id,message_id,read_at)
     SELECT workspace_id,id,$3,$2,now() FROM instagram_connections WHERE id=$1`,
    [conn, messageId, recipient],
  );
}
async function replyMessageId(run: string, messageId: string) {
  await pool.query("UPDATE private_reply_outbox SET provider_message_id=$2,sent_at=now() WHERE flow_run_id=$1", [run, messageId]);
}
// A run a DM started, with its first message in flow_dm_deliveries as the DM delivery worker leaves it.
async function seedDmRun(deliveryStatus: "pending" | "sent", messageId?: string, conn = connection) {
  const key = String(++serial);
  const version = (await pool.query("SELECT id FROM flow_versions WHERE flow_id=$1 AND trigger_connection_id=$2 ORDER BY version_no LIMIT 1", [flow, conn])).rows[0].id;
  const start = (
    await pool.query(
      `INSERT INTO instagram_dm_start_events(workspace_id,connection_id,message_id,sender_id,flow_id,flow_version_id,trigger_type,message_at)
       VALUES($1,$2,$3,$4,$5,$6,'instagram_dm_default','2026-09-30T15:00:00Z') RETURNING id`,
      [workspace, conn, `dm-${key}`, `8${key}`, flow, version],
    )
  ).rows[0].id;
  const run = (
    await pool.query(
      `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,dm_start_event_id,status,created_at)
       VALUES($1,$2,$3,$4,$5,'ended','2026-09-30T15:00:00Z') RETURNING id`,
      [workspace, conn, flow, version, start],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO flow_dm_deliveries(workspace_id,connection_id,flow_run_id,recipient_id,message_text,status,attempt_id,
       attempt_started_at,provider_message_id,sent_at)
     VALUES($1,$2,$3,$4,'SECRET-MESSAGE',$5,CASE WHEN $5='sent' THEN gen_random_uuid() END,
       CASE WHEN $5='sent' THEN now() END,$6::text,CASE WHEN $5='sent' THEN now() END)`,
    [workspace, conn, run, `8${key}`, deliveryStatus, messageId ?? null],
  );
  return run;
}

test("flow report counts a run as read only when its sent first message has a read of that exact message ID", async () => {
  // A comment run whose private reply two readers saw: one run.
  const twice = await seed("ended", "sent");
  await replyMessageId(twice.id, "mid-twice");
  const unread = await seed("ended", "sent");
  await replyMessageId(unread.id, "mid-unread");
  // A reply whose outcome is unknown still carries no proof of a sent message, whatever read names it.
  const unknown = await seed("delivering", "unknown");
  await replyMessageId(unknown.id, "mid-unknown");
  // The same message ID on another connection: a read on `connection` names no message there.
  const foreign = await seed("waiting", "sent", undefined, flow, secondConnection);
  await replyMessageId(foreign.id, "mid-foreign");
  // A DM-started run's first message is read like a private reply; a pending one has no message ID to match.
  await seedDmRun("sent", "mid-dm");
  await seedDmRun("pending");
  await seed("skipped");
  await markRead(connection, "mid-twice", "901");
  await markRead(connection, "mid-twice", "902");
  await markRead(connection, "mid-unknown");
  await markRead(connection, "mid-foreign");
  await markRead(connection, "mid-dm");
  // A read of a later message never marks an earlier one: no watermark.
  await markRead(connection, "mid-later");

  const body = await report();
  assert.deepEqual(body.reply_counts, {
    absent: "1",
    pending: "1",
    sending: "0",
    sent: "4",
    read: "2",
    read_unavailable: "0",
    blocked: "0",
    failed: "0",
    unknown: "1",
  });
  assert.equal(body.run_counts.total, "7");
  assertPartitions(body);
  assert.equal(JSON.stringify(body).includes("mid-"), false);
  const accounts = await report(`${params}&group_by=connection`);
  assertGroupSums(accounts);
  assert.deepEqual(
    accounts.groups.map((group: Group) => [group.key, group.reply_counts.sent, group.reply_counts.read]),
    [
      [connection, "3", "2"],
      [secondConnection, "1", "0"],
    ],
  );
  await markRead(secondConnection, "mid-foreign");
  const days = await report(`${params}&group_by=day`);
  assertGroupSums(days);
  assert.equal(days.reply_counts.read, "3");
  assert.equal((await report(`${params}&connection_id=${secondConnection}`)).reply_counts.read, "1");
});

test("flow report counts a sent first message on a connection that cannot report reads as read_unavailable, not unread", async () => {
  // No Instagram Login user ID: a Facebook Login or environment-managed connection.
  await pool.query("UPDATE instagram_connections SET instagram_user_id=NULL WHERE id=$1", [secondConnection]);
  // A sent reply on a connection that reports reads is in neither count without a read.
  await seed("ended", "sent");
  const unavailable = await seed("waiting", "sent", undefined, flow, secondConnection);
  await replyMessageId(unavailable.id, "mid-unavailable");
  // A read stored for such a connection is still a confirmed read, never also unavailable.
  const confirmed = await seed("ended", "sent", undefined, flow, secondConnection);
  await replyMessageId(confirmed.id, "mid-confirmed");
  // A first message that was not sent counts in neither, whatever its connection or reads.
  const unknown = await seed("delivering", "unknown", undefined, flow, secondConnection);
  await replyMessageId(unknown.id, "mid-unknown");
  // A DM-started run's first message follows the same rule.
  await seedDmRun("sent", "mid-dm", secondConnection);
  await seedDmRun("pending", undefined, secondConnection);
  await markRead(secondConnection, "mid-confirmed");
  await markRead(secondConnection, "mid-unknown");

  const body = await report();
  assert.deepEqual(body.reply_counts, {
    absent: "0",
    pending: "1",
    sending: "0",
    sent: "4",
    read: "1",
    read_unavailable: "2",
    blocked: "0",
    failed: "0",
    unknown: "1",
  });
  assert.equal(body.run_counts.total, "6");
  assertPartitions(body);
  for (const groupBy of ["connection", "flow", "day"]) assertGroupSums(await report(`${params}&group_by=${groupBy}`));
  const accounts = await report(`${params}&group_by=connection`);
  assert.deepEqual(
    accounts.groups.map((group: Group) => [group.key, group.reply_counts.sent, group.reply_counts.read, group.reply_counts.read_unavailable]),
    [
      [connection, "1", "0", "0"],
      [secondConnection, "3", "1", "2"],
    ],
  );
  assert.equal((await report(`${params}&connection_id=${connection}`)).reply_counts.read_unavailable, "0");
});

test("flow report isolates workspace and combines owned account and flow filters across versions and archives", async () => {
  await seed("ended");
  await seed("waiting", undefined, undefined, flow, secondConnection);
  await seed("failed", undefined, undefined, archivedFlow);
  await seed("delivering", "sent", undefined, otherFlow, otherConnection);
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connection]);
  assert.equal((await report()).run_counts.total, "3");
  assert.equal((await report(`${params}&flow_id=${flow}`)).run_counts.total, "2");
  assert.equal((await report(`${params}&connection_id=${connection}`)).run_counts.total, "2");
  assert.equal((await report(`${params}&flow_id=${flow}&connection_id=${connection}`)).run_counts.total, "1");
  assert.equal((await report(`${params}&flow_id=${archivedFlow}`)).run_counts.failed, "1");
  assert.equal((await report(`${params}&flow_id=${archivedFlow}&connection_id=${secondConnection}`)).run_counts.total, "0");
  assert.equal((await request(`${params}&connection_id=${otherConnection}`)).status, 404);
  assert.equal((await request(`${params}&flow_id=${otherFlow}`)).status, 404);
  assert.equal((await request(`${params}&flow_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`)).status, 404);
});

test("flow report uses exact run creation boundaries independently of reply creation and send times", async () => {
  await seed("ended", "sent", "2026-09-30T14:59:59.999999Z");
  await seed("delivering", "pending", "2026-09-30T15:00:00Z");
  await seed("ended", "sent", "2026-10-01T14:59:59.999999Z");
  await seed("ended", "sent", "2026-10-01T15:00:00Z");
  const body = await report();
  assert.equal(body.run_counts.total, "2");
  assert.equal(body.reply_counts.pending, "1");
  assert.equal(body.reply_counts.sent, "1");
  const empty = await report("from=2025-01-01&before=2025-01-02&expected_time_zone=Asia%2FSeoul");
  assert.ok(Object.values(empty.run_counts).every((value) => value === "0"));
  assert.ok(Object.values(empty.reply_counts).every((value) => value === "0"));
});

test("flow report breaks runs down by day, account or flow and the groups add up to the cohort", async () => {
  await seed("ended", "sent", "2026-09-29T15:00:00Z");
  await seed("awaiting_reply", "pending", "2026-09-30T15:00:00Z");
  await seed("delivering", "sent", "2026-09-30T16:00:00Z", flow, secondConnection);
  await seed("failed", undefined, "2026-10-01T14:59:59.999999Z", archivedFlow);
  await seed("cancelled", "sent", "2026-10-01T15:00:00Z", archivedFlow);
  await seed("waiting", undefined, "2026-10-02T03:00:00Z", flow, secondConnection);
  await pool.query("UPDATE flow_runs SET reply_message_id='mid-1' WHERE status='cancelled'");
  // Another workspace's run in the same period never forms a group.
  await seed("delivering", "sent", "2026-09-30T15:00:00Z", otherFlow, otherConnection);
  const period = "from=2026-09-30&before=2026-10-03&expected_time_zone=Asia%2FSeoul";
  const keys = (body: { groups: Group[] }) => body.groups.map((group) => [group.key, group.run_counts.total]);

  const days = await report(`${period}&group_by=day`);
  assert.equal(days.group_by, "day");
  assert.equal(days.run_counts.total, "6");
  assert.deepEqual(keys(days), [
    ["2026-09-30", "1"],
    ["2026-10-01", "3"],
    ["2026-10-02", "2"],
  ]);
  assertGroupSums(days);
  assert.deepEqual(days.reply_wait_counts, { reached: "3", replied: "1", not_replied: "2" });
  const second = days.groups[2] as Group;
  assert.deepEqual(second.reply_wait_counts, { reached: "1", replied: "1", not_replied: "0" });
  assert.equal(second.run_counts.cancelled, "1");

  const accounts = await report(`${period}&group_by=connection`);
  assert.deepEqual(keys(accounts), [
    [connection, "4"],
    [secondConnection, "2"],
  ]);
  assertGroupSums(accounts);
  const flows = await report(`${period}&group_by=flow`);
  assert.deepEqual(keys(flows), [
    [flow, "4"],
    [archivedFlow, "2"],
  ]);
  assertGroupSums(flows);
  assert.equal(JSON.stringify([days, accounts, flows]).includes(otherConnection), false);
  assert.equal(JSON.stringify([days, accounts, flows]).includes(otherFlow), false);
  assert.equal(JSON.stringify([days, accounts, flows]).includes("SECRET"), false);

  // Filters narrow the cohort before grouping.
  const filtered = await report(`${period}&connection_id=${connection}&group_by=flow`);
  assert.deepEqual(keys(filtered), [
    [flow, "2"],
    [archivedFlow, "2"],
  ]);
  assertGroupSums(filtered);
  const both = await report(`${period}&connection_id=${secondConnection}&flow_id=${flow}&group_by=day`);
  assert.deepEqual(keys(both), [
    ["2026-10-01", "1"],
    ["2026-10-02", "1"],
  ]);
  assertGroupSums(both);
  const none = await report(`${period}&connection_id=${secondConnection}&flow_id=${archivedFlow}&group_by=connection`);
  assert.deepEqual(none.groups, []);

  for (const dimension of ["day", "connection", "flow"]) {
    const empty = await report(`from=2025-01-01&before=2025-01-02&expected_time_zone=Asia%2FSeoul&group_by=${dimension}`);
    assert.deepEqual(empty.groups, []);
    assert.deepEqual(empty.reply_wait_counts, { reached: "0", replied: "0", not_replied: "0" });
  }
});

test("flow report day groups follow workspace-local midnight, including DST days", async () => {
  await seed("ended", undefined, "2026-09-30T14:59:59.999999Z");
  await seed("ended", undefined, "2026-09-30T15:00:00Z");
  await seed("ended", undefined, "2026-10-01T14:59:59.999999Z");
  await seed("ended", undefined, "2026-10-01T15:00:00Z");
  const seoul = await report("from=2026-09-30&before=2026-10-03&expected_time_zone=Asia%2FSeoul&group_by=day");
  assert.deepEqual(
    seoul.groups.map((group: Group) => [group.key, group.run_counts.total]),
    [
      ["2026-09-30", "1"],
      ["2026-10-01", "2"],
      ["2026-10-02", "1"],
    ],
  );
  assertGroupSums(seoul);

  await pool.query("TRUNCATE flow_step_runs, private_reply_outbox, flow_runs CASCADE");
  await pool.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1", [workspace]);
  // 2026-03-08 is 23 hours long in New York and 2026-11-01 is 25 hours long.
  for (const at of ["2026-03-08T04:59:59Z", "2026-03-08T05:00:00Z", "2026-03-09T03:59:59Z", "2026-03-09T04:00:00Z", "2026-11-01T04:00:00Z", "2026-11-02T04:59:59Z", "2026-11-02T05:00:00Z"]) await seed("ended", undefined, at);
  const spring = await report("from=2026-03-07&before=2026-03-10&expected_time_zone=America%2FNew_York&group_by=day");
  assert.deepEqual(
    spring.groups.map((group: Group) => [group.key, group.run_counts.total]),
    [
      ["2026-03-07", "1"],
      ["2026-03-08", "2"],
      ["2026-03-09", "1"],
    ],
  );
  assertGroupSums(spring);
  const fall = await report("from=2026-11-01&before=2026-11-03&expected_time_zone=America%2FNew_York&group_by=day");
  assert.deepEqual(
    fall.groups.map((group: Group) => [group.key, group.run_counts.total]),
    [
      ["2026-11-01", "2"],
      ["2026-11-02", "1"],
    ],
  );
  assertGroupSums(fall);
});

test("flow report enforces active admins, current time zone, DST and unambiguous bounded input", async () => {
  assert.equal((await request(params, agent)).status, 403);
  await pool.query("UPDATE workspace_members SET role='admin' WHERE user_id=$1", [owner]);
  assert.equal((await request()).status, 200);
  await pool.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1", [workspace]);
  assert.equal((await request()).status, 409);
  const spring = await report("from=2026-03-08&before=2026-03-09&expected_time_zone=America%2FNew_York");
  assert.equal(spring.period_from, "2026-03-08T05:00:00.000Z");
  assert.equal(spring.period_before, "2026-03-09T04:00:00.000Z");
  const fall = await report("from=2026-11-01&before=2026-11-02&expected_time_zone=America%2FNew_York");
  assert.equal(fall.period_from, "2026-11-01T04:00:00.000Z");
  assert.equal(fall.period_before, "2026-11-02T05:00:00.000Z");
  for (const query of [
    "",
    params + "&from=2026-10-01",
    params + "&extra=1",
    params + "&flow_id=bad",
    params + "&flow_id=",
    params + "&connection_id=bad",
    params.replace("2026-10-01", "2026-02-30"),
    params.replace("2026-10-02", "2026-10-01"),
    params.replace("2026-10-02", "2028-10-02"),
    params.replace("Asia%2FSeoul", ""),
    params + "&group_by=",
    params + "&group_by=week",
    params + "&group_by=DAY",
    params + "&group_by=day&group_by=day",
    params + "&group_by=day&group_by=flow",
  ]) {
    const response = await request(query);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error, "invalid_report_query");
  }
  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$1 WHERE user_id=$1", [owner]);
  assert.equal((await request()).status, 403);
});

test("flow report bounds real aggregate index reads in all optional filter combinations", async () => {
  // Distinct event IDs satisfy the actual run deduplication constraint.
  await pool.query(
    `WITH events AS (INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       SELECT $1,$2,'old-'||n,'1789',n::text,'old' FROM generate_series(1,12000) n RETURNING id)
     INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,event_id,status,created_at)
       SELECT $1,$2,$3,$3,id,'ended','2020-01-01' FROM events`,
    [workspace, connection, flow],
  );
  // Out-of-period step history: the report must not read step rows at all.
  await pool.query(
    `INSERT INTO flow_step_runs(run_id,workspace_id,connection_id,seq,node_id,node_type,outcome)
     SELECT id,workspace_id,connection_id,0,'wait','wait_for_reply','timeout' FROM flow_runs`,
  );
  await seed("delivering", "sent");
  await pool.query("ANALYZE flow_runs");
  await pool.query("ANALYZE flow_step_runs");
  // Every filter set with every dimension, including none: 16 combinations.
  const filters = ["", `&connection_id=${connection}`, `&flow_id=${flow}`, `&connection_id=${connection}&flow_id=${flow}`];
  const dimensions = ["", "&group_by=day", "&group_by=connection", "&group_by=flow"];
  for (const suffix of filters.flatMap((filter) => dimensions.map((dimension) => filter + dimension))) {
    const plans: Record<string, unknown>[] = [];
    const response = await request(params + suffix, owner, plans);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.run_counts.total, "1");
    if (suffix.includes("group_by")) assert.equal(body.groups.length, 1);
    assert.equal(plans.length, 1);
    const scans: Record<string, unknown>[] = [];
    const relations: string[] = [];
    function walk(node: Record<string, unknown>) {
      if (node["Relation Name"]) relations.push(String(node["Relation Name"]));
      const condition = String(node["Index Cond"]);
      if (String(node["Index Name"]).startsWith("flow_runs_") && condition.includes("created_at >=") && condition.includes("created_at <")) scans.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    }
    walk(plans[0]!);
    assert.equal(scans.length, 1, "report must bound index reads by the creation period");
    assert.equal(relations.includes("flow_step_runs"), false, "report must not read step history");
    // The existing flow history index is also valid when an owned flow is selected.
    assert.match(String(scans[0]["Index Cond"]), suffix.includes("flow_id=") ? /(?:workspace_id|flow_id) =/ : /workspace_id =/);
    assert.match(String(scans[0]["Index Cond"]), /created_at >=/);
    assert.match(String(scans[0]["Index Cond"]), /created_at </);
    assert.equal(scans[0]["Actual Rows"], 1);
  }
});
