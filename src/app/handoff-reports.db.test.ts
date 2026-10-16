import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
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
      "INSERT INTO instagram_connections(id,workspace_id,account_id,username) VALUES($1::uuid,$2,$1::text,'SECRET-USERNAME')",
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

async function seed(
  reason: "handoff_started" | "handoff_resumed",
  version: number,
  at = "2026-09-30T15:00:00Z",
  conn = connection,
) {
  return (
    await pool.query(
      `INSERT INTO instagram_inbox_handoff_events(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,
       active,version,actor_id,reason,manual_paused_before,handoff_paused_before,handoff_paused_after,created_at)
     SELECT workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,$2='handoff_started',$3,$4,$2,
       true,$2='handoff_resumed',$2='handoff_started',$5
     FROM instagram_inbox_handoffs WHERE connection_id=$1 RETURNING id`,
      [conn, reason, version, owner, at],
    )
  ).rows[0].id;
}
function request(query = params, actor = owner, plans?: Record<string, unknown>[]) {
  return appApi(
    new Request(`https://app.test/api/reports/handoffs?${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
    { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" },
    () =>
      ({
        query: async (sql: string, values: unknown[]) => {
          if (plans && sql.startsWith("WITH context"))
            plans.push(
              (await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values)).rows[0]["QUERY PLAN"][0].Plan,
            );
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

test("handoff report counts real cycles and distinct account/conversation pairs without inferring current state", async () => {
  const first = await seed("handoff_started", 1);
  await seed("handoff_resumed", 2);
  await seed("handoff_started", 3);
  await seed("handoff_resumed", 2, undefined, secondConnection);
  await seed("handoff_started", 1, undefined, otherConnection);
  await pool.query("UPDATE instagram_inbox_handoffs SET active=false,version=4");
  await pool.query("UPDATE instagram_contact_automation SET paused=true,handoff_paused=true");
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connection]);
  const body = await report();
  assert.deepEqual(body.counts, { total: "4", started: "2", cleared: "2", conversations: "2" });
  assert.equal(body.period_from, "2026-09-30T15:00:00.000Z");
  assert.equal(body.period_before, "2026-10-01T15:00:00.000Z");
  assert.equal(body.connection_id, null);
  assert.ok(Date.now() - Date.parse(body.checked_at) < 60000);
  assert.deepEqual((await report(`${params}&connection_id=${connection}`)).counts, {
    total: "3",
    started: "2",
    cleared: "1",
    conversations: "1",
  });
  assert.deepEqual((await report(`${params}&connection_id=${secondConnection}`)).counts, {
    total: "1",
    started: "0",
    cleared: "1",
    conversations: "1",
  });
  assert.equal(JSON.stringify(body).includes("SECRET"), false);
  assert.equal(JSON.stringify(body).includes(first), false);
  assert.deepEqual(
    Object.keys(body).sort(),
    ["from", "before", "time_zone", "connection_id", "period_from", "period_before", "checked_at", "counts"].sort(),
  );
  // Administrative privacy deletion removes retained events, not a permanent statistics snapshot.
  await pool.query("DELETE FROM instagram_inbox_handoff_events WHERE id=$1", [first]);
  assert.deepEqual((await report()).counts, { total: "3", started: "1", cleared: "2", conversations: "2" });
});

test("handoff report includes one event for an idempotent clear and does not imply automation resumed", async () => {
  await seed("handoff_started", 1);
  await pool.query("UPDATE instagram_contact_automation SET paused=true,handoff_paused=true WHERE connection_id=$1", [
    connection,
  ]);
  async function clear() {
    return appApi(
      new Request(`https://app.test/api/connections/${connection}/inbox/123/handoff`, {
        method: "PUT",
        headers: { cookie: "__Host-ac-access=test", origin: "https://app.test", "content-type": "application/json" },
        body: JSON.stringify({ active: false, expected_version: 1 }),
      }),
      { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" },
      () =>
        ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
      (async () =>
        Response.json({ id: owner, email: "owner@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
    );
  }
  assert.equal((await clear()).status, 200);
  assert.equal((await clear()).status, 200);
  await pool.query("UPDATE instagram_inbox_handoff_events SET created_at='2026-09-30T15:00:00Z'");
  assert.deepEqual((await report()).counts, { total: "2", started: "1", cleared: "1", conversations: "1" });
  assert.equal(
    (await pool.query("SELECT paused FROM instagram_contact_automation WHERE connection_id=$1", [connection])).rows[0]
      .paused,
    true,
  );
});

test("handoff report selects event timestamps at exact half-open boundaries and returns zero for no events", async () => {
  await seed("handoff_started", 1, "2026-09-30T14:59:59.999999Z");
  await seed("handoff_resumed", 2, "2026-09-30T15:00:00Z");
  await seed("handoff_started", 3, "2026-10-01T14:59:59.999999Z");
  await seed("handoff_resumed", 4, "2026-10-01T15:00:00Z");
  assert.deepEqual((await report()).counts, { total: "2", started: "1", cleared: "1", conversations: "1" });
  assert.deepEqual((await report("from=2025-01-01&before=2025-01-02&expected_time_zone=Asia%2FSeoul")).counts, {
    total: "0",
    started: "0",
    cleared: "0",
    conversations: "0",
  });
});

test("handoff report enforces active admins, owned accounts, DST, timezone and strict period input", async () => {
  assert.equal((await request(params, agent)).status, 403);
  await pool.query("UPDATE workspace_members SET role='admin' WHERE user_id=$1", [owner]);
  assert.equal((await request()).status, 200);
  assert.equal((await request(`${params}&connection_id=${otherConnection}`)).status, 404);
  assert.equal((await request(`${params}&connection_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`)).status, 404);
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
    params + "&flow_id=88888888-8888-4888-8888-888888888888",
    params + "&connection_id=bad",
    params + "&connection_id=",
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

test("handoff report bounds the actual aggregate index reads with and without an account filter", async () => {
  await pool.query(
    `INSERT INTO instagram_inbox_handoff_events(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,
    active,version,actor_id,reason,manual_paused_before,handoff_paused_before,handoff_paused_after,created_at)
    SELECT h.workspace_id,h.connection_id,h.recipient_id,h.sender_id,h.evidence_reply_id,true,n,$2,'handoff_started',false,false,true,'2020-01-01'
    FROM instagram_inbox_handoffs h CROSS JOIN generate_series(1,12000) n WHERE h.connection_id=$1`,
    [connection, owner],
  );
  await seed("handoff_resumed", 12001);
  await pool.query("ANALYZE instagram_inbox_handoff_events");
  for (const suffix of ["", `&connection_id=${connection}`]) {
    const plans: Record<string, unknown>[] = [];
    const response = await request(params + suffix, owner, plans);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).counts.total, "1");
    assert.equal(plans.length, 1);
    const scans: Record<string, unknown>[] = [];
    function walk(node: Record<string, unknown>) {
      if (node["Index Name"] === "inbox_handoff_events_report_period_idx") scans.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    }
    walk(plans[0]!);
    assert.equal(scans.length, 1, "report must use the creation-period index");
    assert.match(String(scans[0]["Index Cond"]), /workspace_id =/);
    assert.match(String(scans[0]["Index Cond"]), /created_at >=/);
    assert.match(String(scans[0]["Index Cond"]), /created_at </);
    assert.equal(scans[0]["Actual Rows"], 1);
  }
});
