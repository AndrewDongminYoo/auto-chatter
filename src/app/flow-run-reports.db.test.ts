import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");
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
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent')", [
    workspace,
    owner,
    agent,
  ]);
  for (const [ws, id] of [
    [workspace, connection],
    [workspace, secondConnection],
    [otherWorkspace, otherConnection],
  ])
    await pool.query(
      "INSERT INTO instagram_connections(id,workspace_id,account_id,username) VALUES($1::uuid,$2,$1::text,'SECRET-ACCOUNT')",
      [id, ws],
    );
  for (const [ws, id, conn] of [
    [workspace, flow, connection],
    [workspace, archivedFlow, connection],
    [otherWorkspace, otherFlow, otherConnection],
  ]) {
    await pool.query("INSERT INTO flows(id,workspace_id,name,draft,archived) VALUES($1,$2,'SECRET-FLOW','{}',$3)", [
      id,
      ws,
      id === archivedFlow,
    ]);
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
  const version = (
    await pool.query(
      "SELECT id FROM flow_versions WHERE flow_id=$1 AND trigger_connection_id=$2 ORDER BY version_no LIMIT 1",
      [id, conn],
    )
  ).rows[0].id;
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
    (async () =>
      Response.json({ id: actor, email: "owner@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}
async function report(query = params) {
  const response = await request(query);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
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
    blocked: "1",
    failed: "1",
    unknown: "1",
  });
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
  assert.equal(
    (await report(`${params}&flow_id=${archivedFlow}&connection_id=${secondConnection}`)).run_counts.total,
    "0",
  );
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
  await seed("delivering", "sent");
  await pool.query("ANALYZE flow_runs");
  for (const suffix of [
    "",
    `&connection_id=${connection}`,
    `&flow_id=${flow}`,
    `&connection_id=${connection}&flow_id=${flow}`,
  ]) {
    const plans: Record<string, unknown>[] = [];
    const response = await request(params + suffix, owner, plans);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).run_counts.total, "1");
    assert.equal(plans.length, 1);
    const scans: Record<string, unknown>[] = [];
    function walk(node: Record<string, unknown>) {
      const condition = String(node["Index Cond"]);
      if (
        String(node["Index Name"]).startsWith("flow_runs_") &&
        condition.includes("created_at >=") &&
        condition.includes("created_at <")
      )
        scans.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    }
    walk(plans[0]!);
    assert.equal(scans.length, 1, "report must bound index reads by the creation period");
    // The existing flow history index is also valid when an owned flow is selected.
    assert.match(
      String(scans[0]["Index Cond"]),
      suffix.includes("flow_id=") ? /(?:workspace_id|flow_id) =/ : /workspace_id =/,
    );
    assert.match(String(scans[0]["Index Cond"]), /created_at >=/);
    assert.match(String(scans[0]["Index Cond"]), /created_at </);
    assert.equal(scans[0]["Actual Rows"], 1);
  }
});
