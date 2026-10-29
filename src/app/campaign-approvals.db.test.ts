import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool, type QueryConfig } from "pg";
import { appApi } from "./api.ts";
import { seedWorkspace } from "./workspace-fixture.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const workspace = "11111111-1111-4111-8111-111111111111";
const foreignWorkspace = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const OFF = "44444444-4444-4444-8444-444444444444";
const owner = "55555555-5555-4555-8555-555555555555";
const agent = "66666666-6666-4666-8666-666666666666";
const outsider = "77777777-7777-4777-8777-777777777777";
const admin = "88888888-8888-4888-8888-888888888888";
// Pinned clocks: the schedule statement's one clock_timestamp() and the preview's one statement_timestamp().
let scheduleClock: string | null = null;
let previewClock: string | null = null;
let sequence = 0;

before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  scheduleClock = null;
  previewClock = null;
  await pool.query("TRUNCATE workspaces,workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id,time_zone) VALUES($1,'UTC'),($2,'UTC')", [workspace, foreignWorkspace]);
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role)
     VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$5,'admin'),($4,$6,'owner')`,
    [workspace, owner, agent, foreignWorkspace, admin, outsider],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,inbox_enabled,inbox_enabled_at,active,send_enabled,access_token_encrypted,token_expires_at)
     VALUES($1,$3,'100',true,now()-interval '1 day',true,true,'CIPHERTEXT',now()+interval '30 days'),
       ($2,$3,'101',true,now()-interval '1 day',true,false,'CIPHERTEXT',now()+interval '30 days')`,
    [C, OFF, workspace],
  );
});
after(async () => pool.end());

function clockedPool(): Pool {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (input: string | QueryConfig, values?: unknown[]) => {
          const query = typeof input === "string" ? { text: input, values } : input;
          let text = query.text;
          if (scheduleClock && text.includes("schedule_clock")) {
            assert.equal(text.match(/clock_timestamp\(\)/g)?.length, 1, "one schedule clock");
            text = text.replace("clock_timestamp()", `'${scheduleClock}'::timestamptz`);
          }
          if (previewClock && text.includes("statement_timestamp()"))
            text = text.replace("statement_timestamp()", `'${previewClock}'::timestamptz`);
          return client.query({ ...query, text });
        },
        release: (destroy?: boolean | Error) => client.release(destroy),
      };
    },
    end: async () => {},
  } as unknown as Pool;
}
async function request(method: string, path: string, body?: unknown, actor = owner) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { cookie: "__Host-ac-access=test", origin: "https://app.test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      API_WRITE_USER_LIMIT: { limit: async () => ({ success: true }) },
      API_WRITE_WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
      WORKSPACE_EXPORT_LIMIT: { limit: async () => ({ success: true }) },
    },
    clockedPool,
    (async () =>
      Response.json({ id: actor, email: "member@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}
async function expect(response: Response, status = 200) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body;
}
// A draft over a snapshot of the given members, created through the API so its version is real.
async function draftFor(members: Array<[string, string]> = [[C, "1001"]], ws = workspace, actor = owner) {
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
  await expect(
    await request(
      "POST",
      "/api/campaign-drafts",
      { id, snapshot_id: snapshot, name: "Campaign", body: "Hello" },
      actor,
    ),
    201,
  );
  return { id, snapshot };
}
function approval(draftVersion = 1, schedule: string | null = null, zone = "UTC") {
  return { id: randomUUID(), expected_version: draftVersion, schedule_local: schedule, expected_time_zone: zone };
}
const approve = (draft: string, body: unknown, actor = owner) =>
  request("POST", `/api/campaign-drafts/${draft}/approvals`, body, actor);
const reschedule = (id: string, body: unknown, actor = owner) =>
  request("PUT", `/api/campaign-approvals/${id}/schedule`, body, actor);
const cancel = (id: string, expected: number, actor = owner) =>
  request("POST", `/api/campaign-approvals/${id}/cancel`, { expected_version: expected }, actor);
const editDraft = (draft: string, snapshot: string, expected: number, name = "Edited") =>
  request("PUT", `/api/campaign-drafts/${draft}`, {
    snapshot_id: snapshot,
    name,
    body: "Changed",
    expected_version: expected,
  });
async function waitingForLocks(count: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = (
      await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      )
    ).rows[0].n;
    if (waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${count} requests did not wait for the workspace lock`);
}

test("an admin records an immediate approval with copies, the preview and an audit row; nothing is queued", async () => {
  const { id: draft, snapshot } = await draftFor([
    [OFF, "1001"],
    [C, "1002"],
  ]);
  const input = approval();
  const created = await expect(await approve(draft, input, admin), 201);
  assert.equal(created.id, input.id);
  assert.equal(created.draft_id, draft);
  assert.equal(created.draft_version, 1);
  assert.equal(created.snapshot_id, snapshot);
  assert.equal(created.name, "Campaign");
  assert.equal(created.body, "Hello");
  assert.equal(created.schedule_kind, "immediate");
  assert.equal(created.scheduled_at, null);
  assert.equal(created.schedule_time_zone, null);
  assert.equal(created.schedule_local, null);
  assert.equal(created.status, "approved");
  assert.equal(created.version, 1);
  assert.equal(created.approved_by, admin);
  assert.equal(created.cancelled_by, null);
  assert.equal(created.delivery_available, true);
  assert.equal("create_request_hash" in created, false);
  assert.equal(created.preview.original_member_count, "2");
  assert.equal(created.preview.counts.connection_unavailable, "1");
  assert.equal(created.preview.counts.no_dm_identity, "1");
  assert.deepEqual(
    created.events.map((event: Record<string, unknown>) => [
      event.version,
      event.kind,
      event.actor_id,
      event.schedule_kind,
    ]),
    [[1, "created", admin, "immediate"]],
  );
  const listed = await expect(await request("GET", "/api/campaign-approvals"));
  assert.equal(listed.approvals.length, 1);
  assert.equal("body" in listed.approvals[0], false);
  assert.equal("events" in listed.approvals[0], false);
  assert.equal(listed.approvals[0].delivery_available, true);
  for (const table of ["private_reply_outbox", "instagram_manual_replies", "webhook_deliveries", "flow_runs"])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
});

test("only active admins reach every approval route, and an agent is refused before any ID is read", async () => {
  const { id: draft } = await draftFor();
  const saved = await expect(await approve(draft, approval()), 201);
  for (const [method, path, body] of [
    ["POST", `/api/campaign-drafts/${draft}/approvals`, approval()],
    ["POST", "/api/campaign-drafts/not-a-uuid/approvals", approval()],
    ["GET", "/api/campaign-approvals", undefined],
    ["GET", `/api/campaign-approvals/${saved.id}`, undefined],
    ["GET", "/api/campaign-approvals/not-a-uuid", undefined],
    [
      "PUT",
      `/api/campaign-approvals/${saved.id}/schedule`,
      { expected_version: 1, schedule_local: null, expected_time_zone: "UTC" },
    ],
    ["POST", `/api/campaign-approvals/${saved.id}/cancel`, { expected_version: 1 }],
  ] as const)
    assert.equal((await expect(await request(method, path, body, agent), 403)).error, "role_forbidden", path);
  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [admin, owner]);
  await expect(await request("GET", "/api/campaign-approvals", undefined, admin), 403);
  assert.equal((await expect(await request("GET", `/api/campaign-approvals/${saved.id}`))).version, 1);
});

test("missing, foreign and malformed IDs answer the same 404, and malformed requests 400", async () => {
  const { id: draft } = await draftFor();
  const { id: foreignDraft } = await draftFor([], foreignWorkspace, outsider);
  for (const id of [foreignDraft, randomUUID(), "not-a-uuid"])
    assert.equal((await expect(await approve(id, approval()), 404)).error, "campaign_draft_not_found");
  const foreign = await expect(await approve(foreignDraft, approval(), outsider), 201);
  for (const id of [foreign.id, randomUUID(), "not-a-uuid"]) {
    assert.equal(
      (await expect(await request("GET", `/api/campaign-approvals/${id}`), 404)).error,
      "campaign_approval_not_found",
    );
    await expect(await reschedule(id, { expected_version: 1, schedule_local: null, expected_time_zone: "UTC" }), 404);
    await expect(await cancel(id, 1), 404);
  }
  const good = approval();
  for (const body of [
    { ...good, extra: true },
    { ...good, id: "not-a-uuid" },
    { ...good, expected_version: 0 },
    { ...good, expected_version: "1" },
    { ...good, schedule_local: "2026-11-10 10:00" },
    { ...good, schedule_local: "2026-02-30T10:00" },
    { ...good, schedule_local: "" },
    { ...good, expected_time_zone: "" },
    { ...good, expected_time_zone: null },
    { id: good.id, expected_version: 1, expected_time_zone: "UTC" },
  ])
    assert.equal((await expect(await approve(draft, body), 400)).error, "invalid_campaign_approval");
  const saved = await expect(await approve(draft, good), 201);
  await expect(await reschedule(saved.id, { expected_version: 1, schedule_local: null }), 400);
  await expect(await cancel(saved.id, 0), 400);
  await expect(await request("POST", `/api/campaign-approvals/${saved.id}/cancel`, { expected_version: 1, x: 1 }), 400);
  await expect(await request("GET", "/api/campaign-approvals?limit=5"), 400);
  // The foreign workspace's approval is untouched and still visible to its own admin.
  assert.equal(
    (await expect(await request("GET", `/api/campaign-approvals/${foreign.id}`, undefined, outsider))).version,
    1,
  );
});

test("the foreign keys keep an approval's draft and snapshot in its own workspace", async () => {
  const { id: draft, snapshot } = await draftFor();
  const { id: foreignDraft, snapshot: foreignSnapshot } = await draftFor([], foreignWorkspace, outsider);
  const insert = (draftId: string, snapshotId: string) =>
    pool.query(
      `INSERT INTO campaign_approvals(workspace_id,id,draft_id,draft_version,snapshot_id,name,body,schedule_kind,
         preview_as_of,preview_counts,create_request_hash,approved_by)
       VALUES($1,gen_random_uuid(),$2,1,$3,'n','b','immediate',now(),
         '{"original_member_count":"0","remaining_member_count":"0","connection_unavailable":"0","contact_paused":"0",
           "no_dm_identity":"0","opted_out":"0","marketing_consent_required":"0","reply_window_closed":"0","candidate":"0"}',
         repeat('0',64),$4)`,
      [workspace, draftId, snapshotId, owner],
    );
  await assert.rejects(insert(foreignDraft, snapshot), { code: "23503" });
  await assert.rejects(insert(draft, foreignSnapshot), { code: "23503" });
  // The schedule and cancellation pairings are enforced by CHECKs, not only by the API.
  await insert(draft, snapshot);
  await assert.rejects(
    pool.query("UPDATE campaign_approvals SET scheduled_at=now() WHERE workspace_id=$1", [workspace]),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query("UPDATE campaign_approvals SET status='cancelled' WHERE workspace_id=$1", [workspace]),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query("UPDATE campaign_approvals SET cancelled_at=now() WHERE workspace_id=$1", [workspace]),
    { code: "23514" },
  );
  // A second approval in force for one draft violates the partial unique index.
  await assert.rejects(insert(draft, snapshot), { code: "23505" });
});

test("a retry of the original request returns the current state and never undoes later changes", async () => {
  const { id: draft } = await draftFor();
  const input = { ...approval(), id: randomUUID().toUpperCase() };
  const created = await expect(await approve(draft, input), 201);
  assert.equal(created.id, input.id.toLowerCase());
  await expect(await cancel(created.id, 1));
  const replay = await expect(await approve(draft, { ...input, id: input.id.toLowerCase() }));
  assert.equal(replay.status, "cancelled");
  assert.equal(replay.version, 2);
  // The same ID with a different original request, or on another draft, is a conflict.
  for (const [target, body] of [
    [draft, { ...input, expected_time_zone: "Asia/Seoul" }],
    [draft, { ...input, expected_version: 2 }],
    [(await draftFor()).id, input],
  ] as const)
    assert.equal((await expect(await approve(target, body), 409)).error, "campaign_approval_id_conflict");
  // Concurrent identical requests store one approval: one 201 and one replay.
  const { id: other } = await draftFor();
  const twice = approval();
  const responses = await Promise.all([approve(other, twice), approve(other, twice)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM campaign_approvals WHERE draft_id=$1", [other])).rows[0].n,
    1,
  );
});

test("approval needs the draft's current version and no approval in force, also under concurrency", async () => {
  const { id: draft, snapshot } = await draftFor();
  await expect(await editDraft(draft, snapshot, 1));
  // A stale version answers with the draft as GET returns it.
  const stale = await expect(await approve(draft, approval(1)), 409);
  assert.equal(stale.error, "campaign_draft_conflict");
  assert.deepEqual(stale.draft, await expect(await request("GET", `/api/campaign-drafts/${draft}`)));
  assert.equal(stale.draft.version, 2);
  const results = await Promise.all([approve(draft, approval(2)), approve(draft, approval(2))]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  const created = await results.find((response) => response.status === 201)!.json();
  const refused = await results.find((response) => response.status === 409)!.json();
  assert.equal(refused.error, "approval_exists");
  assert.equal(refused.approval.id, created.id);
  // The approval in force is returned as GET returns it.
  const exists = await expect(await approve(draft, approval(2)), 409);
  assert.equal(exists.error, "approval_exists");
  assert.deepEqual(exists.approval, await expect(await request("GET", `/api/campaign-approvals/${created.id}`)));
  const { id: archived } = await draftFor();
  await expect(await request("POST", `/api/campaign-drafts/${archived}/archive`, { expected_version: 1 }));
  const archivedConflict = await expect(await approve(archived, approval(2)), 409);
  assert.equal(archivedConflict.error, "campaign_draft_conflict");
  assert.equal(archivedConflict.draft.archived, true);
  assert.equal(archivedConflict.draft.version, 2);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM campaign_approvals WHERE draft_id=$1", [archived])).rows[0].n,
    0,
  );
});

test("a draft with an approval in force refuses edit and archive; cancel, edit and approve again", async () => {
  const { id: draft, snapshot } = await draftFor();
  const first = await expect(await approve(draft, approval()), 201);
  assert.equal((await expect(await editDraft(draft, snapshot, 1), 409)).error, "approval_active");
  assert.equal(
    (await expect(await request("POST", `/api/campaign-drafts/${draft}/archive`, { expected_version: 1 }), 409)).error,
    "approval_active",
  );
  const cancelled = await expect(await cancel(first.id, 1));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelled_by, owner);
  assert.ok(cancelled.cancelled_at);
  assert.deepEqual(
    cancelled.events.map((event: Record<string, unknown>) => [event.version, event.kind]),
    [
      [1, "created"],
      [2, "cancelled"],
    ],
  );
  const edited = await expect(await editDraft(draft, snapshot, 1, "Revised"));
  assert.equal(edited.version, 2);
  const second = await expect(await approve(draft, approval(2)), 201);
  assert.equal(second.draft_version, 2);
  assert.equal(second.name, "Revised");
  assert.equal(second.body, "Changed");
  // The first approval keeps the copies it recorded.
  const kept = await expect(await request("GET", `/api/campaign-approvals/${first.id}`));
  assert.equal(kept.name, "Campaign");
  assert.equal(kept.body, "Hello");
  assert.equal(kept.draft_version, 1);
  const listed = await expect(await request("GET", "/api/campaign-approvals"));
  assert.deepEqual(
    listed.approvals.map((row: Record<string, unknown>) => row.id),
    [second.id, first.id],
  );
});

test("an approval and a draft edit or archive serialize on the workspace lock in both orders", async () => {
  for (const change of ["edit", "archive"] as const)
    for (const order of ["approval_first", "change_first"] as const) {
      const { id: draft, snapshot } = await draftFor();
      const modify = () =>
        change === "edit"
          ? editDraft(draft, snapshot, 1)
          : request("POST", `/api/campaign-drafts/${draft}/archive`, { expected_version: 1 });
      const blocker = await pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspace]);
        const first = order === "approval_first" ? approve(draft, approval(1)) : modify();
        await waitingForLocks(1);
        const second = order === "approval_first" ? modify() : approve(draft, approval(1));
        await waitingForLocks(2);
        await blocker.query("COMMIT");
        const [a, b] = await Promise.all([first, second]);
        const label = `${change} ${order}`;
        if (order === "approval_first") {
          await expect(a, 201);
          assert.equal((await expect(b, 409)).error, "approval_active", label);
          const stored = await expect(await request("GET", `/api/campaign-drafts/${draft}`));
          assert.equal(stored.version, 1, label);
          assert.equal(stored.archived, false, label);
        } else {
          const changed = await expect(a);
          assert.equal(changed.version, 2, label);
          assert.equal(changed.archived, change === "archive", label);
          assert.equal((await expect(b, 409)).error, "campaign_draft_conflict", label);
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM campaign_approvals WHERE draft_id=$1", [draft])).rows[0]
              .n,
            0,
            label,
          );
        }
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }
    }
});

test("schedule and cancel require the current version; a cancelled approval never changes again", async () => {
  const { id: draft } = await draftFor();
  const saved = await expect(await approve(draft, approval()), 201);
  scheduleClock = "2026-11-10T00:00:00Z";
  const moved = await expect(
    await reschedule(saved.id, { expected_version: 1, schedule_local: "2026-11-10T09:00", expected_time_zone: "UTC" }),
  );
  assert.equal(moved.version, 2);
  assert.equal(moved.schedule_kind, "scheduled");
  assert.equal(moved.scheduled_at, "2026-11-10T09:00:00.000000Z");
  assert.equal(moved.schedule_time_zone, "UTC");
  assert.equal(moved.schedule_local, "2026-11-10T09:00");
  // The approved content, copies and preview stay as recorded.
  for (const key of ["draft_version", "name", "body", "preview", "approved_at", "approved_by"])
    assert.deepEqual(moved[key], saved[key], key);
  const stale = await expect(
    await reschedule(saved.id, { expected_version: 1, schedule_local: null, expected_time_zone: "UTC" }),
    409,
  );
  assert.equal(stale.error, "campaign_approval_conflict");
  assert.equal(stale.approval.version, 2);
  assert.equal(stale.approval.scheduled_at, "2026-11-10T09:00:00.000000Z");
  const staleCancel = await expect(await cancel(saved.id, 1), 409);
  assert.equal(staleCancel.error, "campaign_approval_conflict");
  assert.equal(staleCancel.approval.status, "approved");
  const back = await expect(
    await reschedule(saved.id, { expected_version: 2, schedule_local: null, expected_time_zone: "UTC" }),
  );
  assert.equal(back.schedule_kind, "immediate");
  assert.equal(back.scheduled_at, null);
  const done = await expect(await cancel(saved.id, 3));
  assert.equal(done.version, 4);
  for (const response of [
    await cancel(saved.id, 4),
    await reschedule(saved.id, { expected_version: 4, schedule_local: null, expected_time_zone: "UTC" }),
  ]) {
    const body = await expect(response, 409);
    assert.equal(body.error, "campaign_approval_cancelled");
    assert.equal(body.approval.version, 4);
  }
  assert.deepEqual(
    done.events.map((event: Record<string, unknown>) => [
      event.version,
      event.kind,
      event.schedule_kind,
      event.scheduled_at,
    ]),
    [
      [1, "created", "immediate", null],
      [2, "schedule_changed", "scheduled", "2026-11-10T09:00:00.000000Z"],
      [3, "schedule_changed", "immediate", null],
      [4, "cancelled", "immediate", null],
    ],
  );
});

test("a schedule is accepted from one minute ahead, the scheduled replies' only fixed bound", async () => {
  const { id: draft } = await draftFor();
  const at = (local: string, expected: number) => ({
    expected_version: expected,
    schedule_local: local,
    expected_time_zone: "UTC",
  });
  scheduleClock = "2026-11-10T00:00:00.000001Z";
  // One microsecond short of a minute ahead, at creation and on a change.
  assert.equal(
    (await expect(await approve(draft, approval(1, "2026-11-10T00:01")), 400)).error,
    "campaign_schedule_out_of_range",
  );
  // No fixed upper bound: the reply window belongs to each recipient at delivery (#36).
  const saved = await expect(await approve(draft, approval(1, "2026-12-10T00:00")), 201);
  assert.equal(saved.scheduled_at, "2026-12-10T00:00:00.000000Z");
  scheduleClock = "2026-11-10T00:00:00Z";
  // Exactly one minute ahead is accepted.
  await expect(await reschedule(saved.id, at("2026-11-10T00:01", 1)));
  for (const local of ["2026-11-09T23:59", "2026-11-10T00:00"])
    assert.equal((await expect(await reschedule(saved.id, at(local, 2)), 400)).error, "campaign_schedule_out_of_range");
  const far = await expect(await reschedule(saved.id, at("2027-11-10T00:00", 2)));
  assert.equal(far.scheduled_at, "2027-11-10T00:00:00.000000Z");
  scheduleClock = "2026-11-10T00:00:00.000001Z";
  assert.equal(
    (await expect(await reschedule(saved.id, at("2026-11-10T00:01", 3)), 400)).error,
    "campaign_schedule_out_of_range",
  );
  await expect(await reschedule(saved.id, at("2026-11-10T00:02", 3)));
});

test("local times use the workspace zone with the shared DST rule, and a later zone change moves nothing", async () => {
  await pool.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1", [workspace]);
  const { id: draft } = await draftFor();
  // The zone the client saw must still be the workspace zone, for a schedule and for an immediate approval.
  assert.equal(
    (await expect(await approve(draft, approval(1, null, "UTC")), 409)).error,
    "campaign_schedule_timezone_changed",
  );
  scheduleClock = "2026-03-07T12:00:00Z";
  assert.equal(
    (await expect(await approve(draft, approval(1, "2026-03-08T02:30", "UTC")), 409)).error,
    "campaign_schedule_timezone_changed",
  );
  // A time skipped by the spring-forward gap is read with the offset before the change.
  const gap = await expect(await approve(draft, approval(1, "2026-03-08T02:30", "America/New_York")), 201);
  assert.equal(gap.scheduled_at, "2026-03-08T07:30:00.000000Z");
  assert.equal(gap.schedule_local, "2026-03-08T03:30");
  assert.equal(gap.schedule_time_zone, "America/New_York");
  // A time repeated by the fall-back overlap is read as the later occurrence.
  scheduleClock = "2026-10-31T12:00:00Z";
  const overlap = await expect(
    await reschedule(gap.id, {
      expected_version: 1,
      schedule_local: "2026-11-01T01:30",
      expected_time_zone: "America/New_York",
    }),
  );
  assert.equal(overlap.scheduled_at, "2026-11-01T06:30:00.000000Z");
  assert.equal(overlap.schedule_local, "2026-11-01T01:30");
  await pool.query("UPDATE workspaces SET time_zone='Asia/Seoul' WHERE id=$1", [workspace]);
  const reread = await expect(await request("GET", `/api/campaign-approvals/${gap.id}`));
  assert.equal(reread.scheduled_at, "2026-11-01T06:30:00.000000Z");
  assert.equal(reread.schedule_time_zone, "America/New_York");
  assert.equal(reread.schedule_local, "2026-11-01T01:30");
  assert.equal(
    (
      await expect(
        await reschedule(gap.id, {
          expected_version: 2,
          schedule_local: "2026-11-01T09:00",
          expected_time_zone: "America/New_York",
        }),
        409,
      )
    ).error,
    "campaign_schedule_timezone_changed",
  );
  const seoul = await expect(
    await reschedule(gap.id, {
      expected_version: 2,
      schedule_local: "2026-11-01T09:00",
      expected_time_zone: "Asia/Seoul",
    }),
  );
  assert.equal(seoul.scheduled_at, "2026-11-01T00:00:00.000000Z");
  assert.equal(seoul.schedule_time_zone, "Asia/Seoul");
});

test("the stored preview equals the preview API at the same moment", async () => {
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,'1003',true)",
    [workspace, C],
  );
  const { id: draft } = await draftFor([
    [OFF, "1001"],
    [C, "1002"],
    [C, "1003"],
  ]);
  previewClock = "2026-10-27T01:02:03.456789Z";
  const preview = await expect(await request("GET", `/api/campaign-drafts/${draft}/preview`));
  const saved = await expect(await approve(draft, approval()), 201);
  assert.deepEqual(saved.preview, {
    as_of: preview.as_of,
    original_member_count: preview.original_member_count,
    remaining_member_count: preview.remaining_member_count,
    counts: preview.counts,
  });
  assert.equal(saved.preview.as_of, "2026-10-27T01:02:03.456789Z");
  assert.deepEqual(
    Object.entries(saved.preview.counts).filter(([, count]) => count !== "0"),
    [
      ["connection_unavailable", "1"],
      ["contact_paused", "1"],
      ["no_dm_identity", "1"],
    ],
  );
  // The stored preview is the moment of approval: a later member deletion changes the live preview only.
  await pool.query("DELETE FROM instagram_segment_snapshot_members WHERE sender_id='1003'");
  assert.equal(
    (await expect(await request("GET", `/api/campaign-drafts/${draft}/preview`))).remaining_member_count,
    "2",
  );
  assert.equal(
    (await expect(await request("GET", `/api/campaign-approvals/${saved.id}`))).preview.remaining_member_count,
    "3",
  );
});

test("approval writes leave delivery, consent and snapshot rows unchanged and survive person and connection deletion", async () => {
  const ws = randomUUID(),
    actor = randomUUID(),
    conn = randomUUID();
  await seedWorkspace(pool, ws, actor, conn, "approval-boundary");
  await pool.query("UPDATE workspaces SET time_zone='UTC' WHERE id=$1", [ws]);
  // The fixture also holds an executed approval with its run; this test changes the one in force.
  const fixture = (
    await pool.query("SELECT id,draft_id FROM campaign_approvals WHERE workspace_id=$1 AND status='approved'", [ws])
  ).rows[0];
  const tables = [
    "private_reply_outbox",
    "instagram_manual_replies",
    "channel_consent_events",
    "channel_consent_state",
    "instagram_segment_snapshots",
    "instagram_segment_snapshot_members",
    "webhook_deliveries",
  ];
  const state = async () => {
    const result: Record<string, unknown> = {};
    for (const table of tables) {
      const row = (
        await pool.query(
          `SELECT count(*)::int AS rows,md5(coalesce(string_agg(t::text,',' ORDER BY t::text),'')) AS hash
           FROM ${table} t WHERE t.workspace_id=$1`,
          [ws],
        )
      ).rows[0];
      assert.ok(row.rows > 0, `${table} fixture must contain data`);
      result[table] = row;
    }
    return result;
  };
  const before = await state();
  await expect(await cancel(fixture.id, 1, actor));
  // The fixture's executed approval ran draft version 1, which is never approved again (#36), so edit the draft first.
  const { snapshot_id } = (await pool.query("SELECT snapshot_id FROM campaign_drafts WHERE id=$1", [fixture.draft_id]))
    .rows[0];
  await expect(
    await request(
      "PUT",
      `/api/campaign-drafts/${fixture.draft_id}`,
      { snapshot_id, name: "Campaign", body: "Draft message", expected_version: 1 },
      actor,
    ),
  );
  const saved = await expect(await approve(fixture.draft_id, approval(2), actor), 201);
  scheduleClock = "2026-11-10T00:00:00Z";
  await expect(
    await reschedule(
      saved.id,
      { expected_version: 1, schedule_local: "2026-11-10T12:00", expected_time_zone: "UTC" },
      actor,
    ),
  );
  await expect(await cancel(saved.id, 2, actor));
  assert.deepEqual(await state(), before);
  const approvals = async () =>
    (
      await pool.query(
        `SELECT md5(string_agg(t::text,',' ORDER BY t::text)) AS a,
           (SELECT md5(string_agg(e::text,',' ORDER BY e::text)) FROM campaign_approval_events e WHERE e.workspace_id=$1) AS e
         FROM campaign_approvals t WHERE t.workspace_id=$1`,
        [ws],
      )
    ).rows[0];
  const kept = await approvals();
  await pool.query("SELECT delete_person_data($1,$2,$3,'comment_sender','123')", [ws, conn, actor]);
  assert.deepEqual(await approvals(), kept);
  await pool.query(
    "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
    [conn],
  );
  const deletion = (
    await pool.query("SELECT delete_connection_data($1,$2,$3,'approval-boundary') AS result", [ws, conn, actor])
  ).rows[0].result;
  assert.equal(deletion.deleted_counts.campaign_approvals, undefined);
  assert.deepEqual(await approvals(), kept);
  assert.equal(
    (await expect(await request("GET", `/api/campaign-approvals/${saved.id}`, undefined, actor))).version,
    3,
  );
});

test("the export carries both tables without the request hash, and workspace deletion removes them", async () => {
  const { id: draft } = await draftFor();
  const saved = await expect(await approve(draft, approval()), 201);
  const exported = await expect(await request("GET", "/api/workspace/export"));
  assert.equal(exported.tables.campaign_approvals.length, 1);
  assert.equal(exported.tables.campaign_approvals[0].id, saved.id);
  assert.equal("create_request_hash" in exported.tables.campaign_approvals[0], false);
  assert.ok(exported.excluded.includes("campaign_approvals.create_request_hash"));
  assert.equal(exported.tables.campaign_approval_events.length, 1);
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL");
  const result = (await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspace, randomUUID()]))
    .rows[0].result;
  assert.equal(result.deleted_counts.campaign_approvals, 1);
  assert.equal(result.deleted_counts.campaign_approval_events, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM campaign_approvals")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM campaign_approval_events")).rows[0].n, 0);
});

test("an approval or its audit alone blocks both workspace move paths", async () => {
  await pool.query("UPDATE workspaces SET plan='advanced' WHERE id=$1", [workspace]);
  for (const table of ["campaign_approvals", "campaign_approval_events"]) {
    const mover = randomUUID(),
      own = randomUUID(),
      target = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("INSERT INTO workspaces(id) VALUES($1),($2)", [own, target]);
      await client.query("INSERT INTO workspace_members(user_id,workspace_id,role) VALUES($1,$2,'owner')", [
        mover,
        own,
      ]);
      await client.query("SET session_replication_role=replica");
      if (table === "campaign_approvals")
        await client.query(
          `INSERT INTO campaign_approvals(workspace_id,id,draft_id,draft_version,snapshot_id,name,body,schedule_kind,
             preview_as_of,preview_counts,create_request_hash,approved_by)
           VALUES($1,gen_random_uuid(),gen_random_uuid(),1,gen_random_uuid(),'n','b','immediate',now(),
             '{"original_member_count":"0","remaining_member_count":"0","connection_unavailable":"0","contact_paused":"0",
               "no_dm_identity":"0","opted_out":"0","marketing_consent_required":"0","reply_window_closed":"0","candidate":"0"}',
             repeat('0',64),$2)`,
          [own, mover],
        );
      else
        await client.query(
          `INSERT INTO campaign_approval_events(workspace_id,approval_id,version,kind,actor_id,schedule_kind)
           VALUES($1,gen_random_uuid(),1,'created',$2,'immediate')`,
          [own, mover],
        );
      await client.query("RESET session_replication_role");
      const invite = await expect(
        await request("POST", "/api/workspace/invites", { email: "member@example.test", role: "agent" }),
        201,
      );
      await expect(
        await request("POST", "/api/invites/accept", { token: invite.link.split("#invite=")[1] }, mover),
        409,
      );
      const script = await readFile(new URL("../../deploy/assign-workspace-owner.sql", import.meta.url), "utf8");
      await client.query("CREATE TEMP TABLE IF NOT EXISTS verified_users(id uuid,email_confirmed_at timestamptz)");
      await client.query(
        script
          .slice(script.indexOf("CREATE FUNCTION"), script.indexOf("SELECT pg_temp.assign_workspace_owner"))
          .replace("auth.users", "pg_temp.verified_users")
          .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"),
      );
      await client.query("INSERT INTO verified_users VALUES($1,now())", [mover]);
      await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [mover, target]), /not empty/);
      await pool.query("UPDATE workspace_invites SET revoked_at=now() WHERE workspace_id=$1", [workspace]);
    } finally {
      await client.query("RESET session_replication_role");
      await client.query("DROP TABLE IF EXISTS pg_temp.verified_users");
      client.release();
    }
  }
});

test("migration 064 replays over stored approvals and reproduces the canonical workspace deletion function", async () => {
  const { id: draft } = await draftFor();
  const saved = await expect(await approve(draft, approval()), 201);
  const definition = async () =>
    (await pool.query("SELECT pg_get_functiondef('delete_workspace_data(uuid,uuid)'::regprocedure) AS body")).rows[0]!
      .body;
  const canonical = await definition();
  const sql = await readFile(new URL("../../db/migrations/064_campaign_approvals.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  // 065 redefines the function after 064, so the runner's order reproduces the canonical one.
  await pool.query(await readFile(new URL("../../db/migrations/065_campaign_runs.sql", import.meta.url), "utf8"));
  assert.equal(await definition(), canonical);
  assert.equal((await expect(await request("GET", `/api/campaign-approvals/${saved.id}`))).version, 1);
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(
    runner.indexOf("064_campaign_approvals.sql") > runner.indexOf("063_campaign_drafts.sql") &&
      runner.indexOf("064_campaign_approvals.sql") < runner.indexOf("supabase-access.sql"),
  );
});
