import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { manualReplyReport } from "./manual-reply-reports.ts";

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
const params = "from=2026-10-01&before=2026-10-02&expected_time_zone=Asia%2FSeoul";

before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspace, otherWorkspace]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent')", [
    workspace,
    owner,
    agent,
  ]);
  for (const [ws, id] of [
    [workspace, connection],
    [otherWorkspace, otherConnection],
    [workspace, secondConnection],
  ]) {
    await pool.query(
      "INSERT INTO instagram_connections(id,workspace_id,account_id,username,instagram_user_id) VALUES($1::uuid,$2,$1::text,'SECRET-USERNAME',$1::text)",
      [id, ws],
    );
    const rule = (
      await pool.query(
        `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text)
       VALUES(gen_random_uuid(),$1,$2,'1789','link','SECRET-TEXT') RETURNING id`,
        [ws, id],
      )
    ).rows[0].id;
    const event = (
      await pool.query(
        `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,'c','1789','456','SECRET-COMMENT') RETURNING id`,
        [ws, id],
      )
    ).rows[0].id;
    const reply = (
      await pool.query(
        `INSERT INTO private_reply_outbox(workspace_id,connection_id,rule_id,event_id,comment_id,media_id,sender_id,private_reply_text)
       VALUES($1,$2,$3,$4,'c','1789','456','SECRET-TEXT') RETURNING id`,
        [ws, id, rule, event],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id) VALUES($1,$2,'456')",
      [ws, id],
    );
    await pool.query(
      `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
       VALUES($1,$2,'123','456',$3,true,1,$4)`,
      [ws, id, reply, owner],
    );
  }
});
after(async () => pool.end());

async function seed(status: string, at = "2026-09-30T15:00:00Z", conn = connection, resolved = false) {
  return (
    await pool.query(
      `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,
       status,created_at,resolved_at,scheduled_at,schedule_time_zone)
     SELECT workspace_id,id,'123',gen_random_uuid(),$2,'SECRET-MANUAL-TEXT',1,$3,$4,
       CASE WHEN $5 THEN now() END,CASE WHEN $3='cancelled' THEN now() END,CASE WHEN $3='cancelled' THEN 'Asia/Seoul' END
     FROM instagram_connections WHERE id=$1 RETURNING id,request_key`,
      [conn, owner, status, at, resolved],
    )
  ).rows[0];
}
function request(query = params, actor = owner) {
  return appApi(
    new Request(`https://app.test/api/reports/manual-replies?${query}`, {
      headers: { cookie: "__Host-ac-access=test" },
    }),
    { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" },
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
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

test("manual report counts current requests once, isolates workspaces and distinguishes resolved unknown", async () => {
  const pending = await seed("pending");
  for (const status of ["sending", "sent", "failed", "unknown", "cancelled"]) await seed(status);
  await seed("unknown", undefined, connection, true);
  await seed("failed", undefined, otherConnection);
  await seed("pending", undefined, secondConnection);
  // Retry is a new accepted request; repeated audit records never multiply the original request.
  const retry = await seed("pending");
  const failed = (
    await pool.query("SELECT id FROM instagram_manual_replies WHERE connection_id=$1 AND status='failed'", [connection])
  ).rows[0].id;
  await pool.query("UPDATE instagram_manual_replies SET retry_of=$2,retry_reason='user decision' WHERE id=$1", [
    retry.id,
    failed,
  ]);
  await pool.query(
    `INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,actor_id,kind,reason)
     VALUES($1,$2,'123',$3,$4,'queued',NULL),($1,$2,'123',$3,$4,'queued',NULL)`,
    [workspace, connection, pending.id, owner],
  );
  const body = await report();
  assert.deepEqual(body.counts, {
    total: "9",
    pending: "3",
    sending: "1",
    sent: "1",
    read: "0",
    read_unavailable: "0",
    failed: "1",
    unknown_unresolved: "1",
    unknown_resolved: "1",
    cancelled: "1",
  });
  assert.equal(body.time_zone, "Asia/Seoul");
  assert.equal(body.period_from, "2026-09-30T15:00:00.000Z");
  assert.equal(body.period_before, "2026-10-01T15:00:00.000Z");
  assert.equal(body.connection_id, null);
  assert.ok(Date.now() - Date.parse(body.checked_at) < 60_000);
  assert.equal(JSON.stringify(body).includes("SECRET"), false);
  assert.equal(JSON.stringify(body).includes(pending.id), false);
  const scoped = await report(`${params}&connection_id=${connection}`);
  assert.equal(scoped.counts.total, "8");
  assert.equal(scoped.counts.pending, "2");
  assert.equal(scoped.connection_id, connection);
  await pool.query("UPDATE instagram_manual_replies SET status='sent',sent_at=now() WHERE id=$1", [pending.id]);
  assert.equal((await report()).counts.sent, "2");
});

test("manual report uses creation cohort with exact half-open boundaries, not send or scheduled time", async () => {
  await seed("sent", "2026-09-30T14:59:59.999999Z");
  const inside = await seed("pending", "2026-09-30T15:00:00Z");
  await pool.query(
    "UPDATE instagram_manual_replies SET scheduled_at='2026-12-01',schedule_time_zone='Asia/Seoul' WHERE id=$1",
    [inside.id],
  );
  await seed("failed", "2026-10-01T14:59:59.999999Z");
  await seed("sent", "2026-10-01T15:00:00Z");
  assert.deepEqual((await report()).counts, {
    total: "2",
    pending: "1",
    sending: "0",
    sent: "0",
    read: "0",
    read_unavailable: "0",
    failed: "1",
    unknown_unresolved: "0",
    unknown_resolved: "0",
    cancelled: "0",
  });
  assert.equal((await report("from=2025-01-01&before=2025-01-02&expected_time_zone=Asia%2FSeoul")).counts.total, "0");
});

// Read rows are written directly: the report reads stored reads and never depends on the webhook path.
async function markRead(conn: string, messageId: string, recipient = "901") {
  await pool.query(
    `INSERT INTO instagram_message_reads(workspace_id,connection_id,recipient_id,message_id,read_at)
     SELECT workspace_id,id,$3,$2,now() FROM instagram_connections WHERE id=$1`,
    [conn, messageId, recipient],
  );
}
async function withMessageId(id: string, messageId: string) {
  await pool.query("UPDATE instagram_manual_replies SET provider_message_id=$2,sent_at=now() WHERE id=$1", [
    id,
    messageId,
  ]);
}
// `read` and `read_unavailable` are disjoint subsets of `sent` and stay outside the status partition.
function assertReadSubsets(counts: Record<string, string>) {
  const { total, read, read_unavailable, ...statuses } = counts;
  assert.equal(
    Object.values(statuses).reduce((sum, value) => sum + BigInt(value), 0n),
    BigInt(total!),
  );
  assert.ok(BigInt(read!) + BigInt(read_unavailable!) <= BigInt(counts.sent!));
}

test("manual report counts a sent request as read only on an exact message ID match on its own connection", async () => {
  const twice = await seed("sent");
  await withMessageId(twice.id, "mid-twice");
  const unread = await seed("sent");
  await withMessageId(unread.id, "mid-unread");
  // A failed request that still carries a message ID and a matching read is not a sent message.
  const failed = await seed("failed");
  await withMessageId(failed.id, "mid-failed");
  // The same message ID on another connection of the workspace: its read on `connection` names no request there.
  const foreign = await seed("sent", undefined, secondConnection);
  await withMessageId(foreign.id, "mid-foreign");
  await markRead(connection, "mid-twice", "901");
  await markRead(connection, "mid-twice", "902");
  await markRead(connection, "mid-failed");
  await markRead(connection, "mid-foreign");
  // A read of a later message never marks an earlier one: no watermark.
  await markRead(connection, "mid-later");
  const body = await report();
  assert.deepEqual(body.counts, {
    total: "4",
    pending: "0",
    sending: "0",
    sent: "3",
    read: "1",
    read_unavailable: "0",
    failed: "1",
    unknown_unresolved: "0",
    unknown_resolved: "0",
    cancelled: "0",
  });
  assertReadSubsets(body.counts);
  assert.equal(JSON.stringify(body).includes("mid-"), false);
  assert.equal((await report(`${params}&connection_id=${secondConnection}`)).counts.read, "0");
  await markRead(secondConnection, "mid-foreign");
  assert.equal((await report()).counts.read, "2");
  assert.equal((await report(`${params}&connection_id=${secondConnection}`)).counts.read, "1");
  assert.equal((await report(`${params}&connection_id=${connection}`)).counts.read, "1");
});

test("manual report counts a sent request on a connection that cannot report reads as read_unavailable, not unread", async () => {
  // No Instagram Login user ID: a Facebook Login or environment-managed connection.
  await pool.query("UPDATE instagram_connections SET instagram_user_id=NULL WHERE id=$1", [secondConnection]);
  // A sent request on a connection that reports reads is in neither count without a read.
  await seed("sent");
  const unavailable = await seed("sent", undefined, secondConnection);
  await withMessageId(unavailable.id, "mid-unavailable");
  // A read stored for such a connection is still a confirmed read, never also unavailable.
  const confirmed = await seed("sent", undefined, secondConnection);
  await withMessageId(confirmed.id, "mid-confirmed");
  // A request that was not sent counts in neither, whatever its connection or reads.
  const failed = await seed("failed", undefined, secondConnection);
  await withMessageId(failed.id, "mid-failed");
  await markRead(secondConnection, "mid-confirmed");
  await markRead(secondConnection, "mid-failed");
  const body = await report();
  assert.deepEqual(body.counts, {
    total: "4",
    pending: "0",
    sending: "0",
    sent: "3",
    read: "1",
    read_unavailable: "1",
    failed: "1",
    unknown_unresolved: "0",
    unknown_resolved: "0",
    cancelled: "0",
  });
  assertReadSubsets(body.counts);
  assert.equal((await report(`${params}&connection_id=${connection}`)).counts.read_unavailable, "0");
  assert.equal((await report(`${params}&connection_id=${secondConnection}`)).counts.read_unavailable, "1");
  // Reconnecting through Instagram Login records the user ID, and the count follows the connection's current state.
  await pool.query("UPDATE instagram_connections SET instagram_user_id='4242' WHERE id=$1", [secondConnection]);
  assert.equal((await report()).counts.read_unavailable, "0");
});

test("manual report follows workspace DST boundaries and rejects stale time zone", async () => {
  await pool.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1", [workspace]);
  assert.equal((await request()).status, 409);
  const spring = await report("from=2026-03-08&before=2026-03-09&expected_time_zone=America%2FNew_York");
  assert.equal(spring.period_from, "2026-03-08T05:00:00.000Z");
  assert.equal(spring.period_before, "2026-03-09T04:00:00.000Z");
  const fall = await report("from=2026-11-01&before=2026-11-02&expected_time_zone=America%2FNew_York");
  assert.equal(fall.period_from, "2026-11-01T04:00:00.000Z");
  assert.equal(fall.period_before, "2026-11-02T05:00:00.000Z");
});

test("manual report requires active admin membership and an owned connection", async () => {
  assert.equal((await request(params, agent)).status, 403);
  assert.equal((await request(`${params}&connection_id=${otherConnection}`)).status, 404);
  assert.equal((await request(`${params}&connection_id=88888888-8888-4888-8888-888888888888`)).status, 404);
  await pool.query("UPDATE workspace_members SET role='admin' WHERE user_id=$1", [owner]);
  assert.equal((await request()).status, 200);
  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$1 WHERE user_id=$1", [owner]);
  assert.equal((await request()).status, 403);
});

test("manual report rejects ambiguous, invalid, unbounded or unsupported query input", async () => {
  for (const query of [
    "",
    params + "&from=2026-10-01",
    params + "&anything=1",
    params + "&connection_id=bad",
    params + "&connection_id=",
    params.replace("2026-10-01", "2026-02-30"),
    params.replace("2026-10-02", "2026-10-01"),
    params.replace("2026-10-02", "2028-10-02"),
    params.replace("2026-10-01", "2026-1-01"),
    params.replace("Asia%2FSeoul", ""),
  ]) {
    const response = await request(query);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error, "invalid_report_query", query);
  }
});

test("manual report bounds index reads by creation period with and without a connection filter", async () => {
  // Spread history across recipients so a single-recipient skip scan cannot replace the period-index check.
  await pool.query(
    `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
     SELECT workspace_id,connection_id,(n+1000)::text,sender_id,evidence_reply_id,active,version,updated_by
     FROM instagram_inbox_handoffs CROSS JOIN generate_series(1,12000) n WHERE connection_id=$1`,
    [connection],
  );
  await pool.query(
    `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,status,created_at)
     SELECT $1,$2,(n+1000)::text,gen_random_uuid(),$3,'historical request',1,'sent',
       '2020-01-01'::timestamptz + n * interval '1 minute' FROM generate_series(1,12000) n`,
    [workspace, connection, owner],
  );
  await seed("sent");
  await pool.query("ANALYZE instagram_manual_replies");
  for (const suffix of ["", `&connection_id=${connection}`]) {
    const plans: string[] = [];
    const explainedPool = {
      query: async (sql: string, values: unknown[]) => {
        if (sql.startsWith("WITH context")) {
          const result = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
          plans.push(JSON.stringify(result.rows[0]["QUERY PLAN"]));
        }
        return pool.query(sql, values);
      },
    } as unknown as Pool;
    const result = await manualReplyReport(
      explainedPool,
      { id: owner, email: "owner@example.test" },
      new URLSearchParams(params + suffix),
    );
    assert.equal(result.counts.total, "1");
    assert.equal(plans.length, 1);
    const scans: Record<string, unknown>[] = [];
    function walk(node: Record<string, unknown>) {
      if (node["Index Name"] === "instagram_manual_replies_report_period_idx") scans.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    }
    walk(JSON.parse(plans[0])[0].Plan);
    assert.equal(scans.length, 1, "report must use the creation-period index");
    assert.match(String(scans[0]["Index Cond"]), /workspace_id =/);
    assert.match(String(scans[0]["Index Cond"]), /created_at >=/);
    assert.match(String(scans[0]["Index Cond"]), /created_at </);
    assert.equal(scans[0]["Actual Rows"], 1);
  }
});
