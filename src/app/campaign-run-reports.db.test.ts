import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { startDueCampaignRuns } from "./campaign-runs.ts";
import { recordChannelConsentEvent } from "../instagram/channel-consent.ts";

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
const outsider = "99999999-9999-4999-8999-999999999999";
const params = "from=2026-10-01&before=2026-10-02&expected_time_zone=Asia%2FSeoul";
const REASONS = [
  "connection_unavailable",
  "contact_paused",
  "no_dm_identity",
  "opted_out",
  "marketing_consent_required",
  "reply_window_closed",
  "candidate",
  "plan_limit_exceeded",
] as const;
const STATUSES = ["pending", "sending", "sent", "failed", "blocked", "unknown", "cancelled"] as const;
type DeliveryStatus = (typeof STATUSES)[number];
let draft: string;
let archivedDraft: string;
let otherDraft: string;
let sequence = 0;

before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  sequence = 0;
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query(
    "INSERT INTO workspaces(id,time_zone,plan) VALUES($1,'Asia/Seoul','advanced'),($2,'Asia/Seoul','advanced')",
    [workspace, otherWorkspace],
  );
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')",
    [workspace, owner, agent, otherWorkspace, outsider],
  );
  for (const [ws, id, account] of [
    [workspace, connection, "100"],
    [workspace, secondConnection, "101"],
    [otherWorkspace, otherConnection, "102"],
  ])
    await pool.query(
      `INSERT INTO instagram_connections(id,workspace_id,account_id,username,inbox_enabled,inbox_enabled_at,active,send_enabled,
         access_token_encrypted,token_expires_at)
       VALUES($1,$2,$3,'SECRET-ACCOUNT',true,now()-interval '1 day',true,true,'CIPHERTEXT',now()+interval '30 days')`,
      [id, ws, account],
    );
  draft = await draftFor([]);
  archivedDraft = await draftFor([]);
  await pool.query("UPDATE campaign_drafts SET archived=true,version=2 WHERE id=$1", [archivedDraft]);
  otherDraft = await draftFor([], otherWorkspace);
});
after(async () => pool.end());

// Freezes the given members into a snapshot and returns a version-1 draft that references it.
async function draftFor(members: Array<[string, string]>, ws = workspace) {
  const actor = ws === workspace ? owner : outsider;
  const segment = (
    await pool.query("INSERT INTO instagram_contact_segments(workspace_id,name) VALUES($1,$2) RETURNING id", [
      ws,
      `Audience ${++sequence}`,
    ])
  ).rows[0]!.id;
  const snapshot = (
    await pool.query(
      `INSERT INTO instagram_segment_snapshots(workspace_id,segment_id,created_by,as_of,definition,segment_name,counts,member_count)
       VALUES($1,$2,$3,now(),'{}','Audience','{}',$4) RETURNING id`,
      [ws, segment, actor, members.length],
    )
  ).rows[0]!.id as string;
  for (const [conn, sender] of members)
    await pool.query(
      "INSERT INTO instagram_segment_snapshot_members(snapshot_id,workspace_id,connection_id,sender_id) VALUES($1,$2,$3,$4)",
      [snapshot, ws, conn, sender],
    );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO campaign_drafts(id,workspace_id,snapshot_id,name,body,create_request_hash,created_by,updated_by)
     VALUES($1,$2,$3,'SECRET-CAMPAIGN','SECRET-BODY',repeat('0',64),$4,$4)`,
    [id, ws, snapshot, actor],
  );
  return id;
}

function startCounts(overrides: Record<string, number> = {}) {
  const counts: Record<string, string> = {};
  for (const key of ["original_member_count", "remaining_member_count", ...REASONS.slice(0, 7)])
    counts[key] = String(overrides[key] ?? 0);
  for (const key of ["plan_limit_exceeded", "plan_limit", "plan_limit_used", "plan_limit_reserved"])
    if (key in overrides) counts[key] = String(overrides[key]);
  return counts;
}

// A run of `draftId` written as the start and the worker would leave it: an executed approval, the run with its stored
// counts and the given number of delivery rows per status, each satisfying the delivery CHECKs.
async function seedRun(options: {
  draftId?: string;
  status?: "running" | "cancelled" | "completed";
  startedAt?: string;
  counts?: Record<string, string>;
  deliveries?: Partial<Record<DeliveryStatus, number>>;
  conn?: string;
}) {
  const draftId = options.draftId ?? draft;
  const { workspace_id: ws, snapshot_id: snapshot } = (
    await pool.query("SELECT workspace_id,snapshot_id FROM campaign_drafts WHERE id=$1", [draftId])
  ).rows[0];
  const counts = JSON.stringify(options.counts ?? startCounts());
  const approval = randomUUID();
  await pool.query(
    `INSERT INTO campaign_approvals(workspace_id,id,draft_id,draft_version,snapshot_id,name,body,schedule_kind,
       preview_as_of,preview_counts,create_request_hash,approved_by,status)
     VALUES($1,$2,$3,1,$4,'SECRET-CAMPAIGN','SECRET-BODY','immediate',now(),$5::jsonb,repeat('0',64),$6,'executed')`,
    [ws, approval, draftId, snapshot, counts, ws === workspace ? owner : outsider],
  );
  const status = options.status ?? "running";
  const run = (
    await pool.query(
      `INSERT INTO campaign_runs(workspace_id,approval_id,draft_id,draft_version,snapshot_id,started_at,start_counts,status,
         cancelled_by,cancelled_at)
       VALUES($1,$2,$3,1,$4,$5,$6::jsonb,$7,CASE WHEN $7='cancelled' THEN $8::uuid END,CASE WHEN $7='cancelled' THEN now() END)
       RETURNING id`,
      [ws, approval, draftId, snapshot, options.startedAt ?? "2026-09-30T15:00:00Z", counts, status, owner],
    )
  ).rows[0].id as string;
  for (const [deliveryStatus, count] of Object.entries(options.deliveries ?? {}))
    await pool.query(
      `INSERT INTO campaign_deliveries(workspace_id,run_id,connection_id,sender_id,recipient_id,status,attempt_id,
         attempt_started_at,failure_code,provider_message_id,sent_at)
       SELECT $1,$2,$3,'SECRET-'||$4::text||'-'||g,'9'||g,$4::text,
         CASE WHEN $4::text IN ('sending','sent','failed','unknown') THEN gen_random_uuid() END,
         CASE WHEN $4::text IN ('sending','sent','failed','unknown') THEN now() END,
         CASE WHEN $4::text IN ('failed','blocked') THEN 'test_reason' END,
         CASE WHEN $4::text='sent' THEN 'SECRET-MID-'||g END,
         CASE WHEN $4::text='sent' THEN now() END
       FROM generate_series(1,$5::int) g`,
      [ws, run, options.conn ?? (ws === workspace ? connection : otherConnection), deliveryStatus, count],
    );
  return run;
}

function request(path: string, actor = owner, plans?: Record<string, unknown>[], method = "GET", body?: unknown) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { cookie: "__Host-ac-access=test", origin: "https://app.test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      SEND_ENABLED: "true",
      API_WRITE_USER_LIMIT: { limit: async () => ({ success: true }) },
      API_WRITE_WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
    },
    () =>
      ({
        query: async (sql: string, values: unknown[]) => {
          if (plans && typeof sql === "string" && sql.startsWith("WITH context")) {
            const result = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, values);
            plans.push(result.rows[0]["QUERY PLAN"][0].Plan);
          }
          return pool.query(sql, values);
        },
        connect: pool.connect.bind(pool),
        end: async () => {},
      }) as unknown as Pool,
    (async () =>
      Response.json({ id: actor, email: "member@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}
const reportPath = (query: string) => `/api/reports/campaign-runs?${query}`;
async function report(query = params, actor = owner) {
  const response = await request(reportPath(query), actor);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
async function refused(query: string, status: number, code: string, actor = owner) {
  const response = await request(reportPath(query), actor);
  assert.equal(response.status, status, query);
  assert.equal((await response.json()).error, code, query);
}
const sum = (values: Record<string, string>, keys: readonly string[]) =>
  keys.reduce((total, key) => total + BigInt(values[key]!), 0n);

test("campaign report partitions run states, start reasons and delivery rows without multiplying runs", async () => {
  const running = await seedRun({
    counts: startCounts({ original_member_count: 6, remaining_member_count: 5, no_dm_identity: 2, candidate: 3 }),
    deliveries: { pending: 1, sending: 1, sent: 1 },
  });
  // A cancelled run keeps its sent, failed, blocked and unknown rows; only its pending rows became cancelled.
  await seedRun({
    status: "cancelled",
    counts: startCounts({ original_member_count: 7, remaining_member_count: 7, opted_out: 1, candidate: 6 }),
    deliveries: { sent: 1, failed: 1, blocked: 1, unknown: 1, cancelled: 2 },
  });
  await seedRun({
    status: "completed",
    counts: startCounts({
      original_member_count: 4,
      remaining_member_count: 4,
      connection_unavailable: 1,
      contact_paused: 1,
      marketing_consent_required: 1,
      candidate: 1,
    }),
    deliveries: { sent: 1 },
  });
  // A run the monthly limit kept from starting: completed, no rows, its candidates moved to plan_limit_exceeded.
  await seedRun({
    status: "completed",
    counts: startCounts({
      original_member_count: 3,
      remaining_member_count: 3,
      reply_window_closed: 1,
      plan_limit_exceeded: 2,
      plan_limit: 1000,
      plan_limit_used: 999,
      plan_limit_reserved: 0,
    }),
  });
  const body = await report();
  assert.deepEqual(body.run_counts, {
    total: "4",
    running: "1",
    cancelled: "1",
    completed: "1",
    limit_not_started: "1",
  });
  assert.deepEqual(body.start_counts, {
    original_member_count: "20",
    remaining_member_count: "19",
    connection_unavailable: "1",
    contact_paused: "1",
    no_dm_identity: "2",
    opted_out: "1",
    marketing_consent_required: "1",
    reply_window_closed: "1",
    candidate: "10",
    plan_limit_exceeded: "2",
  });
  assert.deepEqual(body.delivery_counts, {
    total: "10",
    pending: "1",
    sending: "1",
    sent: "3",
    failed: "1",
    blocked: "1",
    unknown: "1",
    cancelled: "2",
  });
  assert.equal(sum(body.run_counts, ["running", "cancelled", "completed", "limit_not_started"]), 4n);
  assert.equal(sum(body.start_counts, REASONS), BigInt(body.start_counts.remaining_member_count));
  assert.equal(sum(body.delivery_counts, STATUSES), BigInt(body.delivery_counts.total));
  assert.equal(body.time_zone, "Asia/Seoul");
  assert.equal(body.period_from, "2026-09-30T15:00:00.000Z");
  assert.equal(body.period_before, "2026-10-01T15:00:00.000Z");
  assert.equal(body.draft_id, null);
  assert.ok(Date.now() - Date.parse(body.checked_at) < 60_000);
  const text = JSON.stringify(body);
  for (const secret of ["SECRET", running, owner, connection, draft])
    assert.equal(text.includes(secret), false, secret);
  // Counts are current: a later worker transition moves a row between statuses, not the run total.
  await pool.query(
    `UPDATE campaign_deliveries SET status='sent',provider_message_id='mid',sent_at=now() WHERE run_id=$1 AND status='sending'`,
    [running],
  );
  const updated = await report();
  assert.equal(updated.delivery_counts.sending, "0");
  assert.equal(updated.delivery_counts.sent, "4");
  assert.equal(updated.delivery_counts.total, "10");
});

test("real starts: a started run's candidates equal its rows until a deletion, and a limited run counts only as not started", async () => {
  await pool.query("UPDATE workspaces SET time_zone='UTC' WHERE id=$1", [workspace]);
  const today = new Date();
  const day = (offset: number) => new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const query = `from=${day(-1)}&before=${day(1)}&expected_time_zone=UTC`;
  for (const [sender, recipient] of [
    ["1001", "2001"],
    ["1003", "2003"],
  ]) {
    const event = (
      await pool.query(
        `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
         VALUES($1,$2,$3,$4,$5,'SECRET-COMMENT') RETURNING id`,
        [workspace, connection, `comment-${sender}`, `media-${sender}`, sender],
      )
    ).rows[0].id;
    const rule = (
      await pool.query(
        `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text)
         VALUES(gen_random_uuid(),$1,$2,$3,'hello','SECRET-REPLY') RETURNING id`,
        [workspace, connection, `media-${sender}`],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,
         private_reply_text,recipient_id,status,provider_message_id,sent_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'SECRET-REPLY',$8,'sent','acknowledged',now()-interval '1 hour')`,
      [workspace, connection, event, rule, `comment-${sender}`, `media-${sender}`, sender, recipient],
    );
    await pool.query(
      `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
       VALUES($1,$2,$3,$4,'SECRET-DM','text',now()-interval '1 hour')`,
      [workspace, connection, recipient, `dm-${recipient}`],
    );
    await recordChannelConsentEvent(pool, {
      requestKey: randomUUID(),
      workspaceId: workspace,
      connectionId: connection,
      channel: "instagram",
      identityKind: "dm_recipient",
      identityValue: recipient,
      purpose: "marketing",
      decision: "grant",
      evidenceKind: "explicit",
      evidenceReference: "test",
      occurredAt: new Date(),
      actorId: owner,
    });
  }
  const approve = async (draftId: string) => {
    const response = await request(`/api/campaign-drafts/${draftId}/approvals`, owner, undefined, "POST", {
      id: randomUUID(),
      expected_version: 1,
      schedule_local: null,
      expected_time_zone: "UTC",
    });
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  };
  // One qualifying member and one with no DM identity: the run starts with one row.
  const started = await draftFor([
    [connection, "1001"],
    [connection, "1002"],
  ]);
  await approve(started);
  assert.deepEqual(await startDueCampaignRuns(pool), { started: 1, skipped: 0, failed: 0 });
  // A qualifying member whose start the free plan's limit of 0 stops.
  const limited = await draftFor([[connection, "1003"]]);
  await approve(limited);
  await pool.query("UPDATE workspaces SET plan='free' WHERE id=$1", [workspace]);
  assert.deepEqual(await startDueCampaignRuns(pool), { started: 1, skipped: 0, failed: 0 });

  const body = await report(query);
  assert.deepEqual(body.run_counts, {
    total: "2",
    running: "1",
    cancelled: "0",
    completed: "0",
    limit_not_started: "1",
  });
  assert.equal(body.start_counts.remaining_member_count, "3");
  assert.equal(body.start_counts.no_dm_identity, "1");
  assert.equal(body.start_counts.candidate, "1");
  assert.equal(body.start_counts.plan_limit_exceeded, "1");
  // The writer's invariant (plan entitlements spec): the eight reasons add up to the remaining members.
  assert.equal(sum(body.start_counts, REASONS), 3n);
  assert.equal(body.delivery_counts.total, "1");
  assert.equal(body.delivery_counts.pending, "1");
  const limitedOnly = await report(`${query}&draft_id=${limited}`);
  assert.equal(limitedOnly.run_counts.limit_not_started, "1");
  assert.equal(limitedOnly.start_counts.candidate, "0");
  assert.equal(limitedOnly.delivery_counts.total, "0");

  // Person deletion removes the row but keeps the run and its stored counts: candidates exceed the rows.
  await pool.query("SELECT public.delete_person_data($1,$2,$3,'comment_sender','1001')", [
    workspace,
    connection,
    owner,
  ]);
  const deleted = await report(query);
  assert.equal(deleted.run_counts.total, "2");
  assert.equal(deleted.start_counts.candidate, "1");
  assert.equal(deleted.delivery_counts.total, "0");
});

test("campaign report filters by an owned draft, archived included, and isolates other workspaces", async () => {
  await seedRun({ deliveries: { sent: 2 } });
  await seedRun({ status: "completed", deliveries: { sent: 1 }, conn: secondConnection });
  await seedRun({ draftId: archivedDraft, status: "cancelled", deliveries: { cancelled: 3 } });
  await seedRun({ draftId: otherDraft, deliveries: { pending: 5 } });
  const all = await report();
  assert.equal(all.run_counts.total, "3");
  assert.equal(all.delivery_counts.total, "6");
  const one = await report(`${params}&draft_id=${draft}`);
  assert.equal(one.draft_id, draft);
  assert.equal(one.run_counts.total, "2");
  assert.equal(one.delivery_counts.sent, "3");
  const archived = await report(`${params}&draft_id=${archivedDraft}`);
  assert.equal(archived.run_counts.cancelled, "1");
  assert.equal(archived.delivery_counts.cancelled, "3");
  const unused = await draftFor([]);
  assert.equal((await report(`${params}&draft_id=${unused}`)).run_counts.total, "0");
  await refused(`${params}&draft_id=${otherDraft}`, 404, "campaign_draft_not_found");
  await refused(`${params}&draft_id=${randomUUID()}`, 404, "campaign_draft_not_found");
  const foreign = await report(params, outsider);
  assert.equal(foreign.run_counts.total, "1");
  assert.equal(foreign.delivery_counts.pending, "5");
});

test("campaign report selects runs by start time at local midnight, independent of delivery times", async () => {
  await seedRun({ startedAt: "2026-09-30T14:59:59.999999Z", deliveries: { sent: 1 } });
  await seedRun({ startedAt: "2026-09-30T15:00:00Z", deliveries: { pending: 1 } });
  await seedRun({ startedAt: "2026-10-01T14:59:59.999999Z", deliveries: { sent: 1 } });
  await seedRun({ startedAt: "2026-10-01T15:00:00Z", deliveries: { sent: 1 } });
  const body = await report();
  assert.equal(body.run_counts.total, "2");
  assert.equal(body.delivery_counts.pending, "1");
  assert.equal(body.delivery_counts.sent, "1");
  const empty = await report("from=2025-01-01&before=2025-01-02&expected_time_zone=Asia%2FSeoul");
  for (const group of ["run_counts", "start_counts", "delivery_counts"])
    assert.ok(
      Object.values(empty[group]).every((value) => value === "0"),
      group,
    );
  assert.equal(Object.keys(empty.start_counts).length, 10);
  assert.equal(Object.keys(empty.delivery_counts).length, 8);
});

test("campaign report enforces active admins, the current time zone, DST and bounded input", async () => {
  await refused(params, 403, "role_forbidden", agent);
  await pool.query("UPDATE workspace_members SET role='admin' WHERE user_id=$1", [owner]);
  assert.equal((await report()).run_counts.total, "0");
  await pool.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1", [workspace]);
  await refused(params, 409, "report_time_zone_changed");
  await seedRun({ startedAt: "2026-03-08T04:59:59Z" });
  await seedRun({ startedAt: "2026-03-08T05:00:00Z" });
  await seedRun({ startedAt: "2026-03-09T03:59:59Z" });
  await seedRun({ startedAt: "2026-03-09T04:00:00Z" });
  const spring = await report("from=2026-03-08&before=2026-03-09&expected_time_zone=America%2FNew_York");
  assert.equal(spring.period_from, "2026-03-08T05:00:00.000Z");
  assert.equal(spring.period_before, "2026-03-09T04:00:00.000Z");
  assert.equal(spring.run_counts.total, "2");
  const fall = await report("from=2026-11-01&before=2026-11-02&expected_time_zone=America%2FNew_York");
  assert.equal(fall.period_from, "2026-11-01T04:00:00.000Z");
  assert.equal(fall.period_before, "2026-11-02T05:00:00.000Z");
  const zoned = "from=2026-10-01&before=2026-10-02&expected_time_zone=America%2FNew_York";
  for (const query of [
    "",
    zoned + "&from=2026-10-01",
    zoned + "&extra=1",
    zoned + "&connection_id=" + connection,
    zoned + "&draft_id=bad",
    zoned + "&draft_id=",
    zoned.replace("2026-10-01", "2026-02-30"),
    zoned.replace("2026-10-02", "2026-10-01"),
    zoned.replace("2026-10-02", "2027-10-03"),
    zoned.replace("America%2FNew_York", ""),
  ])
    await refused(query, 400, "invalid_report_query");
  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$1 WHERE user_id=$1", [owner]);
  assert.equal((await request(reportPath(zoned))).status, 403);
});

test("campaign report reaches delivery rows through the run_id-leading unique index", async () => {
  // Out-of-period history: 300 runs with 100 rows each, so a delivery scan would read 30,000 rows.
  const { snapshot_id: snapshot } = (await pool.query("SELECT snapshot_id FROM campaign_drafts WHERE id=$1", [draft]))
    .rows[0];
  await pool.query(
    `WITH approvals AS (
       INSERT INTO campaign_approvals(workspace_id,id,draft_id,draft_version,snapshot_id,name,body,schedule_kind,
         preview_as_of,preview_counts,create_request_hash,approved_by,status)
       SELECT $1,gen_random_uuid(),$2,1,$3,'Old','Old','immediate',now(),$4::jsonb,repeat('0',64),$5,'executed'
       FROM generate_series(1,300) RETURNING id)
     INSERT INTO campaign_runs(workspace_id,approval_id,draft_id,draft_version,snapshot_id,started_at,start_counts,status)
     SELECT $1,id,$2,1,$3,'2020-01-01',$4::jsonb,'completed' FROM approvals`,
    [workspace, draft, snapshot, JSON.stringify(startCounts()), owner],
  );
  await pool.query(
    `INSERT INTO campaign_deliveries(workspace_id,run_id,connection_id,sender_id,recipient_id,status)
     SELECT r.workspace_id,r.id,$2,'old-'||g,'9'||g,'cancelled'
     FROM campaign_runs r CROSS JOIN generate_series(1,100) g WHERE r.workspace_id=$1`,
    [workspace, connection],
  );
  await seedRun({ deliveries: { sent: 2 } });
  await pool.query("ANALYZE campaign_runs");
  await pool.query("ANALYZE campaign_deliveries");
  for (const suffix of ["", `&draft_id=${draft}`]) {
    const plans: Record<string, unknown>[] = [];
    const response = await request(reportPath(params + suffix), owner, plans);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.run_counts.total, "1");
    assert.equal(body.delivery_counts.total, "2");
    assert.equal(plans.length, 1);
    const deliveryNodes: Record<string, unknown>[] = [];
    function walk(node: Record<string, unknown>) {
      if (
        node["Relation Name"] === "campaign_deliveries" ||
        String(node["Index Name"]).startsWith("campaign_deliveries")
      )
        deliveryNodes.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) walk(child);
    }
    walk(plans[0]!);
    assert.ok(deliveryNodes.length > 0, "the plan reads campaign_deliveries");
    for (const node of deliveryNodes)
      assert.notEqual(
        node["Node Type"],
        "Seq Scan",
        `delivery rows must not be read by a sequential scan: ${JSON.stringify(plans[0])}`,
      );
    const member = deliveryNodes.filter((node) => node["Index Name"] === "campaign_deliveries_member");
    assert.ok(
      member.length > 0,
      `delivery rows are read through campaign_deliveries_member: ${JSON.stringify(deliveryNodes)}`,
    );
    for (const node of member) {
      assert.match(String(node["Index Cond"]), /run_id =/);
      // One lookup per cohort run: the out-of-period history is never visited.
      assert.equal(node["Actual Loops"], 1);
      assert.equal(node["Actual Rows"], 2);
    }
    assert.ok(
      deliveryNodes.every(
        (node) => node["Index Name"] === undefined || node["Index Name"] === "campaign_deliveries_member",
      ),
      "no other delivery index is used",
    );
  }
});
