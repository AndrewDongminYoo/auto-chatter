import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { appApi } from "./api.ts";
import { startDueCampaignRuns } from "./campaign-runs.ts";
import { recordChannelConsentEvent } from "../instagram/channel-consent.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const workspace = "11111111-1111-4111-8111-111111111111";
const foreignWorkspace = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const FC = "44444444-4444-4444-8444-444444444444";
const owner = "55555555-5555-4555-8555-555555555555";
const agent = "66666666-6666-4666-8666-666666666666";
const outsider = "77777777-7777-4777-8777-777777777777";
const admin = "88888888-8888-4888-8888-888888888888";
let sequence = 0;

before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces,workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id,time_zone,plan) VALUES($1,'UTC','advanced'),($2,'UTC','advanced')", [
    workspace,
    foreignWorkspace,
  ]);
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role)
     VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$5,'admin'),($4,$6,'owner')`,
    [workspace, owner, agent, foreignWorkspace, admin, outsider],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,inbox_enabled,inbox_enabled_at,active,send_enabled,access_token_encrypted,token_expires_at)
     VALUES($1,$2,'100',true,now()-interval '1 day',true,true,'CIPHERTEXT',now()+interval '30 days'),
       ($3,$4,'102',true,now()-interval '1 day',true,true,'CIPHERTEXT',now()+interval '30 days')`,
    [C, workspace, FC, foreignWorkspace],
  );
});
after(async () => pool.end());

// The shared pool behind the API and the step; `end` is a no-op so a request cannot close it. When `pause` is given,
// the first client query whose text matches it is held after it ran until `release` is called, inside its
// transaction, so a test can order two transactions. `held` rejects when no matching query ran within
// GATE_TIMEOUT_MS, so a statement that stops matching fails the test instead of hanging it (`test:db` sets no
// per-test timeout).
const GATE_TIMEOUT_MS = 10_000;
function sharedPool(pause?: RegExp) {
  let reached!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve, reject) => {
    if (!pause) {
      reached = resolve;
      return;
    }
    const timer = setTimeout(
      () => reject(new Error(`no query matched ${pause} within ${GATE_TIMEOUT_MS} ms`)),
      GATE_TIMEOUT_MS,
    );
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
          if (pause && !paused && pause.test(query.text)) {
            paused = true;
            reached();
            await gate;
          }
          return result;
        },
        release: (destroy?: boolean | Error) => client.release(destroy),
      } as unknown as PoolClient;
    },
    end: async () => {},
  } as unknown as Pool;
  return { pool: wrapped, held, release };
}
// Waits until another backend running a statement that contains `text` waits for a lock; by default the workspace
// row lock that every write here takes first.
async function waitForWorkspaceLock(text = "FROM workspaces WHERE id=$1 FOR UPDATE"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
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
async function request(method: string, path: string, body?: unknown, actor = owner, source = sharedPool().pool) {
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
      WORKSPACE_EXPORT_LIMIT: { limit: async () => ({ success: true }) },
    },
    () => source,
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
async function comment(sender: string, conn = C, ws = workspace) {
  sequence++;
  return (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,$3,$4,'PRIVATE COMMENT BODY') RETURNING id::text,comment_id,media_id`,
      [ws, conn, `comment-${sequence}`, sender],
    )
  ).rows[0];
}
// A provider-acknowledged private reply from the sender's comment to the recipient, sent an hour ago (fresh).
async function bridge(sender: string, recipient: string, conn = C, ws = workspace) {
  const event = await comment(sender, conn, ws);
  const rule = (
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text)
       VALUES(gen_random_uuid(),$1,$2,$3,'hello','PRIVATE SEND BODY') RETURNING id`,
      [ws, conn, event.media_id],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,
       private_reply_text,recipient_id,status,provider_message_id,sent_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'PRIVATE SEND BODY',$8,'sent','acknowledged',now()-interval '1 hour')`,
    [ws, conn, event.id, rule, event.comment_id, event.media_id, sender, recipient],
  );
}
async function message(recipient: string, ago: string, conn = C, ws = workspace) {
  sequence++;
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,$4,'PRIVATE DM BODY','text',now()-$5::interval)`,
    [ws, conn, recipient, `dm-${sequence}`, ago],
  );
}
async function consent(recipient: string, decision: "grant" | "revoke", conn = C, ws = workspace) {
  await recordChannelConsentEvent(pool, {
    requestKey: randomUUID(),
    workspaceId: ws,
    connectionId: conn,
    channel: "instagram",
    identityKind: "dm_recipient",
    identityValue: recipient,
    purpose: "marketing",
    decision,
    evidenceKind: "explicit",
    evidenceReference: "test",
    occurredAt: new Date(),
    actorId: owner,
  });
}
// A recipient that passes every recipient-level check: explicit marketing grant and a text DM in the window.
async function qualifying(sender: string, recipient: string, ago = "1 hour", conn = C, ws = workspace) {
  await bridge(sender, recipient, conn, ws);
  await message(recipient, ago, conn, ws);
  await consent(recipient, "grant", conn, ws);
}
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
     VALUES($1,$2,$3,'Campaign','Hello',repeat('0',64),$4,$4)`,
    [id, ws, snapshot, actor],
  );
  return id;
}
// Approves the draft through the API: immediately, or for a far-future time a test can then move.
async function approve(draft: string, later = false, actor = owner) {
  return expect(
    await request(
      "POST",
      `/api/campaign-drafts/${draft}/approvals`,
      {
        id: randomUUID(),
        expected_version: 1,
        schedule_local: later ? "2099-01-01T00:00" : null,
        expected_time_zone: "UTC",
      },
      actor,
    ),
    201,
  );
}
async function approvalStatus(id: string) {
  return (await pool.query("SELECT status FROM campaign_approvals WHERE id=$1", [id])).rows[0].status as string;
}
async function runOf(approval: string) {
  return (await pool.query("SELECT * FROM campaign_runs WHERE approval_id=$1", [approval])).rows[0];
}
async function deliveries(run: string) {
  return (
    await pool.query(
      "SELECT connection_id,sender_id,recipient_id,status FROM campaign_deliveries WHERE run_id=$1 ORDER BY sender_id",
      [run],
    )
  ).rows;
}
// A row the delivery worker (PR 2) would have claimed; this PR never writes one.
async function insertSending(run: string, sender: string, recipient: string, ws = workspace, conn = C) {
  await pool.query(
    `INSERT INTO campaign_deliveries(workspace_id,run_id,connection_id,sender_id,recipient_id,status,attempt_id,attempt_started_at)
     VALUES($1,$2,$3,$4,$5,'sending',gen_random_uuid(),now())`,
    [ws, run, conn, sender, recipient],
  );
}
// Digest of the delivery tables this PR must never write, so a test can prove they are unchanged.
async function untouched() {
  return (
    await pool.query(
      `SELECT (SELECT md5(coalesce(string_agg(t::text,',' ORDER BY t::text),'')) FROM private_reply_outbox t) AS outbox,
        (SELECT md5(coalesce(string_agg(t::text,',' ORDER BY t::text),'')) FROM instagram_manual_replies t) AS manual,
        (SELECT md5(coalesce(string_agg(t::text,',' ORDER BY t::text),'')) FROM instagram_follow_conversations t) AS follow,
        (SELECT md5(coalesce(string_agg(t::text,',' ORDER BY t::text),'')) FROM channel_consent_events t) AS consent_events,
        (SELECT md5(coalesce(string_agg(t::text,',' ORDER BY t::text),'')) FROM channel_consent_state t) AS consent_state,
        (SELECT md5(coalesce(string_agg(t::text,',' ORDER BY t::text),'')) FROM webhook_deliveries t) AS webhooks`,
    )
  ).rows[0];
}

test("only approved approvals that are due start, and each run writes one pending row per candidate", async () => {
  await qualifying("1001", "2001");
  const now = await approve(await draftFor([[C, "1001"]]));
  const past = await approve(await draftFor([[C, "1001"]]), true);
  await pool.query("UPDATE campaign_approvals SET scheduled_at=now()-interval '1 minute' WHERE id=$1", [past.id]);
  const future = await approve(await draftFor([[C, "1001"]]), true);
  const cancelled = await approve(await draftFor([[C, "1001"]]));
  await expect(await request("POST", `/api/campaign-approvals/${cancelled.id}/cancel`, { expected_version: 1 }));
  const baseline = await untouched();
  assert.deepEqual(await startDueCampaignRuns(pool), { started: 2, skipped: 0, failed: 0 });
  assert.equal(await approvalStatus(now.id), "executed");
  assert.equal(await approvalStatus(past.id), "executed");
  assert.equal(await approvalStatus(future.id), "approved");
  assert.equal(await approvalStatus(cancelled.id), "cancelled");
  assert.equal(await runOf(future.id), undefined);
  assert.equal(await runOf(cancelled.id), undefined);
  for (const approval of [now, past]) {
    const run = await runOf(approval.id);
    assert.equal(run.status, "running");
    assert.equal(run.version, 1);
    assert.equal(run.draft_id, approval.draft_id);
    assert.equal(run.draft_version, 1);
    assert.equal(run.snapshot_id, approval.snapshot_id);
    assert.equal(run.start_counts.candidate, "1");
    assert.deepEqual(await deliveries(run.id), [
      { connection_id: C, sender_id: "1001", recipient_id: "2001", status: "pending" },
    ]);
  }
  // An executed approval is never started again, and nothing reached an outbox, consent or webhook table.
  assert.deepEqual(await startDueCampaignRuns(pool), { started: 0, skipped: 0, failed: 0 });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM campaign_runs")).rows[0].n, 2);
  assert.deepEqual(await untouched(), baseline);
  // The approval keeps its version and audit: the run row is the execution record.
  const executed = await expect(await request("GET", `/api/campaign-approvals/${now.id}`));
  assert.equal(executed.version, 1);
  assert.equal(executed.events.length, 1);
});

test("each step run starts at most the cap, oldest due first", async () => {
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) ids.push((await approve(await draftFor([[C, `90${index}`]]))).id);
  // Due times: the second is a scheduled approval whose time came earliest; the immediate ones by their last write.
  const scheduled = await approve(await draftFor([[C, "903"]]), true);
  await pool.query("UPDATE campaign_approvals SET updated_at=now()-interval '3 hours' WHERE id=$1", [ids[0]]);
  await pool.query("UPDATE campaign_approvals SET updated_at=now()-interval '1 hour' WHERE id=$1", [ids[1]]);
  await pool.query("UPDATE campaign_approvals SET updated_at=now()-interval '30 minutes' WHERE id=$1", [ids[2]]);
  await pool.query("UPDATE campaign_approvals SET scheduled_at=now()-interval '2 hours' WHERE id=$1", [scheduled.id]);
  assert.deepEqual(await startDueCampaignRuns(pool, { limit: 2 }), { started: 2, skipped: 0, failed: 0 });
  assert.deepEqual(await Promise.all([ids[0]!, scheduled.id, ids[1]!, ids[2]!].map(approvalStatus)), [
    "executed",
    "executed",
    "approved",
    "approved",
  ]);
  assert.deepEqual(await startDueCampaignRuns(pool, { limit: 1 }), { started: 1, skipped: 0, failed: 0 });
  assert.equal(await approvalStatus(ids[1]!), "executed");
  assert.equal(await approvalStatus(ids[2]!), "approved");
});

test("an approval that cannot start is logged and does not hold back the ones behind it", async () => {
  const broken = await approve(await draftFor([[C, "1001"]]));
  const healthy = await approve(await draftFor([[C, "1002"]]));
  await pool.query("UPDATE campaign_approvals SET updated_at=now()-interval '1 hour' WHERE id=$1", [broken.id]);
  // Only an administrator statement can break the draft freeze; the start refuses rather than run another version.
  await pool.query("UPDATE campaign_drafts SET version=2 WHERE id=$1", [broken.draft_id]);
  const lines: string[] = [];
  mock.method(console, "error", (line: string) => lines.push(line));
  try {
    await assert.rejects(startDueCampaignRuns(pool, { correlationId: "campaign-test" }), {
      name: "CampaignStartFailedError",
    });
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [{ event: "campaign_start_failed", code: "unexpected_error", correlation_id: "campaign-test" }],
  );
  assert.equal(await approvalStatus(broken.id), "approved");
  assert.equal(await runOf(broken.id), undefined);
  assert.equal(await approvalStatus(healthy.id), "executed");
});

test("approvals that keep failing go behind the others, so a full batch of failures cannot hold back a start", async () => {
  const broken: Array<{ id: string; draft_id: string }> = [];
  for (const [index, sender] of ["1001", "1002"].entries()) {
    broken.push(await approve(await draftFor([[C, sender]])));
    await pool.query(`UPDATE campaign_approvals SET updated_at=now()-interval '${3 - index} hours' WHERE id=$1`, [
      broken[index]!.id,
    ]);
    await pool.query("UPDATE campaign_drafts SET version=2 WHERE id=$1", [broken[index]!.draft_id]);
  }
  const healthy = await approve(await draftFor([[C, "1003"]]));
  const failedAt = async (id: string) =>
    (await pool.query("SELECT start_failed_at FROM campaign_approvals WHERE id=$1", [id])).rows[0]
      .start_failed_at as Date | null;
  mock.method(console, "error", () => undefined);
  try {
    // The two oldest due approvals fill the batch and both fail; the healthy one is not reached.
    await assert.rejects(startDueCampaignRuns(pool, { limit: 2 }), { name: "CampaignStartFailedError" });
    assert.equal(await approvalStatus(healthy.id), "approved");
    assert.equal(await failedAt(healthy.id), null);
    const [first, second] = [await failedAt(broken[0]!.id), await failedAt(broken[1]!.id)];
    assert.ok(first && second && first < second);
    // Without the stamp the same two would be selected again. The healthy approval now goes first, then the least
    // recently failed one, and the failures rotate.
    await assert.rejects(startDueCampaignRuns(pool, { limit: 2 }), { name: "CampaignStartFailedError" });
    assert.equal(await approvalStatus(healthy.id), "executed");
    assert.ok((await failedAt(broken[0]!.id))! > second);
    assert.equal((await failedAt(broken[1]!.id))!.getTime(), second.getTime());
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(await Promise.all(broken.map(({ id }) => approvalStatus(id))), ["approved", "approved"]);
});

test("two workspaces that hold the same approval ID each start their run", async () => {
  const id = randomUUID();
  for (const [ws, conn, actor] of [
    [workspace, C, owner],
    [foreignWorkspace, FC, outsider],
  ] as const) {
    const draft = await draftFor([[conn, "1001"]], ws);
    await expect(
      await request(
        "POST",
        `/api/campaign-drafts/${draft}/approvals`,
        { id, expected_version: 1, schedule_local: null, expected_time_zone: "UTC" },
        actor,
      ),
      201,
    );
  }
  assert.deepEqual(await startDueCampaignRuns(pool), { started: 2, skipped: 0, failed: 0 });
  assert.deepEqual(
    (
      await pool.query("SELECT workspace_id FROM campaign_runs WHERE approval_id=$1 ORDER BY workspace_id", [id])
    ).rows.map((row) => row.workspace_id),
    [workspace, foreignWorkspace],
  );
});

test("two concurrent starts write one run and one row per member; the member key refuses a duplicate", async () => {
  await qualifying("1001", "2001");
  await qualifying("1002", "2002");
  const approval = await approve(
    await draftFor([
      [C, "1001"],
      [C, "1002"],
    ]),
  );
  const results = await Promise.all([startDueCampaignRuns(pool), startDueCampaignRuns(pool)]);
  assert.equal(
    results.reduce((total, result) => total + result.started, 0),
    1,
  );
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM campaign_runs")).rows[0].n, 1);
  const run = await runOf(approval.id);
  assert.equal((await deliveries(run.id)).length, 2);
  await assert.rejects(
    pool.query(
      "INSERT INTO campaign_deliveries(workspace_id,run_id,connection_id,sender_id,recipient_id) VALUES($1,$2,$3,'1001','2009')",
      [workspace, run.id, C],
    ),
    { code: "23505", constraint: "campaign_deliveries_member" },
  );
  // One run per approval, also against a second insert that bypassed the status check.
  await assert.rejects(
    pool.query(
      `INSERT INTO campaign_runs(workspace_id,approval_id,draft_id,draft_version,snapshot_id,started_at,start_counts)
       SELECT workspace_id,approval_id,draft_id,draft_version,snapshot_id,started_at,start_counts FROM campaign_runs`,
    ),
    { code: "23505", constraint: "campaign_runs_approval" },
  );
});

test("a start and an approval cancel or schedule change serialize in either order", async () => {
  // The change commits first: the start waits on the workspace lock and then finds nothing to start.
  for (const change of ["cancel", "schedule"] as const) {
    const approval = await approve(await draftFor([[C, "1001"]]));
    const gated = sharedPool(change === "cancel" ? /SET status='cancelled'/ : /SET schedule_kind=/);
    const pending =
      change === "cancel"
        ? request("POST", `/api/campaign-approvals/${approval.id}/cancel`, { expected_version: 1 }, owner, gated.pool)
        : request(
            "PUT",
            `/api/campaign-approvals/${approval.id}/schedule`,
            { expected_version: 1, schedule_local: "2099-01-01T00:00", expected_time_zone: "UTC" },
            owner,
            gated.pool,
          );
    await gated.held;
    const starting = startDueCampaignRuns(pool);
    await waitForWorkspaceLock();
    gated.release();
    await expect(await pending);
    assert.deepEqual(await starting, { started: 0, skipped: 1, failed: 0 });
    assert.equal(await runOf(approval.id), undefined);
    assert.equal(await approvalStatus(approval.id), change === "cancel" ? "cancelled" : "approved");
  }
  // The start commits first: the change waits on the workspace lock and then refuses the executed approval.
  for (const change of ["cancel", "schedule"] as const) {
    const approval = await approve(await draftFor([[C, "1002"]]));
    const gated = sharedPool(/FOR SHARE/);
    const starting = startDueCampaignRuns(gated.pool);
    await gated.held;
    const pending =
      change === "cancel"
        ? request("POST", `/api/campaign-approvals/${approval.id}/cancel`, { expected_version: 1 })
        : request("PUT", `/api/campaign-approvals/${approval.id}/schedule`, {
            expected_version: 1,
            schedule_local: "2099-01-01T00:00",
            expected_time_zone: "UTC",
          });
    await waitForWorkspaceLock();
    gated.release();
    assert.deepEqual(await starting, { started: 1, skipped: 0, failed: 0 });
    const refused = await expect(await pending, 409);
    assert.equal(refused.error, "campaign_approval_executed");
    assert.equal(refused.approval.status, "executed");
    assert.equal(refused.approval.run_id, (await runOf(approval.id)).id);
  }
});

test("the start re-evaluates the frozen target and its counts can differ from the approval's", async () => {
  await qualifying("1001", "2001");
  await qualifying("1002", "2002");
  const approval = await approve(
    await draftFor([
      [C, "1001"],
      [C, "1002"],
    ]),
  );
  assert.equal(approval.preview.counts.candidate, "2");
  // After the approval, one recipient opts out and the other member is paused.
  await consent("2001", "revoke");
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,'1002',true)",
    [workspace, C],
  );
  await startDueCampaignRuns(pool);
  const run = await runOf(approval.id);
  assert.deepEqual(run.start_counts, {
    original_member_count: "2",
    remaining_member_count: "2",
    connection_unavailable: "0",
    contact_paused: "1",
    no_dm_identity: "0",
    opted_out: "1",
    marketing_consent_required: "0",
    reply_window_closed: "0",
    candidate: "0",
  });
  assert.deepEqual(await deliveries(run.id), []);
  const stored = await expect(await request("GET", `/api/campaign-approvals/${approval.id}`));
  assert.equal(stored.preview.counts.candidate, "2");
});

test("the candidate count equals the rows, and a candidate gets its qualifying recipient with the latest text DM", async () => {
  // 1001 has three verified recipients: two qualify, and the most recent DM came from one without a marketing grant.
  await qualifying("1001", "2001", "3 hours");
  await qualifying("1001", "2002", "2 hours");
  await bridge("1001", "2003");
  await message("2003", "10 minutes");
  // 1002 qualifies once; 1003 has no DM identity; 1004's only recipient's window has closed.
  await qualifying("1002", "2004");
  await qualifying("1004", "2005", "25 hours");
  const approval = await approve(
    await draftFor([
      [C, "1001"],
      [C, "1002"],
      [C, "1003"],
      [C, "1004"],
    ]),
  );
  await startDueCampaignRuns(pool);
  const run = await runOf(approval.id);
  assert.equal(run.start_counts.candidate, "2");
  assert.equal(run.start_counts.no_dm_identity, "1");
  assert.equal(run.start_counts.reply_window_closed, "1");
  // started_at is the evaluation's one clock, as the preview's as_of is.
  assert.equal(
    (await pool.query("SELECT started_at<=now() AND started_at>now()-interval '1 minute' AS ok FROM campaign_runs"))
      .rows[0].ok,
    true,
  );
  assert.deepEqual(await deliveries(run.id), [
    { connection_id: C, sender_id: "1001", recipient_id: "2002", status: "pending" },
    { connection_id: C, sender_id: "1002", recipient_id: "2004", status: "pending" },
  ]);
});

test("cancelling a run cancels its pending rows only, and the read returns counts without identifiers", async () => {
  await qualifying("1001", "2001");
  await qualifying("1002", "2002");
  const approval = await approve(
    await draftFor([
      [C, "1001"],
      [C, "1002"],
    ]),
  );
  await startDueCampaignRuns(pool);
  const { id } = await runOf(approval.id);
  await insertSending(id, "1003", "2003");
  const baseline = await untouched();
  assert.equal(
    (await expect(await request("GET", `/api/campaign-runs/${id}`, undefined, agent), 403)).error,
    "role_forbidden",
  );
  const path = `/api/campaign-runs/${id}`;
  const read = await expect(await request("GET", path, undefined, admin));
  assert.equal(read.status, "running");
  assert.equal(read.version, 1);
  assert.equal(read.approval_id, approval.id);
  assert.equal(read.delivery_available, true);
  assert.equal(read.start.counts.candidate, "2");
  assert.equal(read.start.original_member_count, "2");
  assert.deepEqual(read.delivery_counts, {
    pending: "2",
    sending: "1",
    sent: "0",
    failed: "0",
    blocked: "0",
    unknown: "0",
    cancelled: "0",
  });
  for (const identifier of ["1001", "1002", "1003", "2001", "2002", "2003"])
    assert.ok(!JSON.stringify(read).includes(identifier), identifier);
  const approvalRead = await expect(await request("GET", `/api/campaign-approvals/${approval.id}`));
  assert.deepEqual([approvalRead.run_id, approvalRead.run_status], [id, "running"]);
  assert.equal(
    (await expect(await request("GET", "/api/campaign-approvals"))).approvals.find(
      (item: { id: string }) => item.id === approval.id,
    ).run_id,
    id,
  );

  for (const body of [{}, { expected_version: 0 }, { expected_version: 1, extra: true }, { expected_version: "1" }])
    assert.equal((await expect(await request("POST", `${path}/cancel`, body), 400)).error, "invalid_campaign_run");
  assert.equal(
    (await expect(await request("POST", `${path}/cancel`, { expected_version: 1 }, agent), 403)).error,
    "role_forbidden",
  );
  const stale = await expect(await request("POST", `${path}/cancel`, { expected_version: 2 }), 409);
  assert.equal(stale.error, "campaign_run_conflict");
  assert.equal(stale.run.status, "running");

  const cancelled = await expect(await request("POST", `${path}/cancel`, { expected_version: 1 }, admin));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.version, 2);
  assert.equal(cancelled.cancelled_by, admin);
  assert.equal(cancelled.cancelled_delivery_count, "2");
  assert.equal(cancelled.sending_recalled, false);
  assert.equal(cancelled.delivery_counts.cancelled, "2");
  assert.equal(cancelled.delivery_counts.sending, "1");
  assert.deepEqual(
    (await pool.query("SELECT sender_id,status FROM campaign_deliveries WHERE run_id=$1 ORDER BY sender_id", [id]))
      .rows,
    [
      { sender_id: "1001", status: "cancelled" },
      { sender_id: "1002", status: "cancelled" },
      { sender_id: "1003", status: "sending" },
    ],
  );
  const again = await expect(await request("POST", `${path}/cancel`, { expected_version: 2 }), 409);
  assert.equal(again.error, "campaign_run_cancelled");
  assert.deepEqual(await untouched(), baseline);

  await pool.query("UPDATE campaign_runs SET status='completed',cancelled_by=NULL,cancelled_at=NULL WHERE id=$1", [id]);
  assert.equal(
    (await expect(await request("POST", `${path}/cancel`, { expected_version: 2 }), 409)).error,
    "campaign_run_completed",
  );
  for (const missing of [randomUUID(), "not-a-uuid"]) {
    assert.equal(
      (await expect(await request("GET", `/api/campaign-runs/${missing}`), 404)).error,
      "campaign_run_not_found",
    );
    assert.equal(
      (await expect(await request("POST", `/api/campaign-runs/${missing}/cancel`, { expected_version: 1 }), 404)).error,
      "campaign_run_not_found",
    );
  }
  // Another workspace's run is not found.
  assert.equal((await expect(await request("GET", path, undefined, outsider), 404)).error, "campaign_run_not_found");
  assert.equal((await expect(await request("GET", `${path}?x=1`), 400)).error, "invalid_campaign_run");
});

test("an executed approval refuses a schedule change and a cancel, and its draft is no longer frozen", async () => {
  const approval = await approve(await draftFor([[C, "1001"]]));
  await startDueCampaignRuns(pool);
  const schedule = await expect(
    await request("PUT", `/api/campaign-approvals/${approval.id}/schedule`, {
      expected_version: 1,
      schedule_local: "2099-01-01T00:00",
      expected_time_zone: "UTC",
    }),
    409,
  );
  assert.equal(schedule.error, "campaign_approval_executed");
  assert.equal(schedule.approval.status, "executed");
  assert.equal(schedule.approval.schedule_kind, "immediate");
  const cancel = await expect(
    await request("POST", `/api/campaign-approvals/${approval.id}/cancel`, { expected_version: 1 }),
    409,
  );
  assert.equal(cancel.error, "campaign_approval_executed");
  assert.equal(await approvalStatus(approval.id), "executed");
  // The executed draft version is not approved again (#36): the refusal carries the executed approval and writes
  // nothing, so one snapshot never starts twice without an edit.
  const again = {
    id: randomUUID(),
    expected_version: 1,
    schedule_local: null,
    expected_time_zone: "UTC",
  };
  const refused = await expect(
    await request("POST", `/api/campaign-drafts/${approval.draft_id}/approvals`, again),
    409,
  );
  assert.equal(refused.error, "campaign_version_executed");
  assert.equal(refused.approval.id, approval.id);
  assert.equal(refused.approval.status, "executed");
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM campaign_approvals WHERE draft_id=$1", [approval.draft_id]))
      .rows[0].n,
    1,
  );
  // The draft can be edited and its new version approved; that approval would start its own run.
  const snapshot = (await pool.query("SELECT snapshot_id FROM campaign_drafts WHERE id=$1", [approval.draft_id]))
    .rows[0].snapshot_id;
  await expect(
    await request("PUT", `/api/campaign-drafts/${approval.draft_id}`, {
      snapshot_id: snapshot,
      name: "Again",
      body: "Hello again",
      expected_version: 1,
    }),
  );
  const edited = await expect(
    await request("POST", `/api/campaign-drafts/${approval.draft_id}/approvals`, { ...again, expected_version: 2 }),
    201,
  );
  assert.equal(edited.draft_version, 2);
  // A replay of the request that created the executed approval still answers it as a success.
  const replayed = await expect(
    await request("POST", `/api/campaign-drafts/${approval.draft_id}/approvals`, {
      ...again,
      id: approval.id,
    }),
    200,
  );
  assert.equal(replayed.id, approval.id);
  assert.equal(replayed.status, "executed");
});

test("connection, person and workspace deletion remove delivery rows and refuse while one is sending", async () => {
  await qualifying("1001", "2001");
  await qualifying("1002", "2002");
  const approval = await approve(
    await draftFor([
      [C, "1001"],
      [C, "1002"],
    ]),
  );
  await startDueCampaignRuns(pool);
  const run = (await runOf(approval.id)).id;
  const sending = () =>
    pool.query(
      "UPDATE campaign_deliveries SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE run_id=$1 AND sender_id='1001'",
      [run],
    );
  const pending = () =>
    pool.query(
      "UPDATE campaign_deliveries SET status='pending',attempt_id=NULL,attempt_started_at=NULL WHERE run_id=$1 AND sender_id='1001'",
      [run],
    );
  const person = (kind: string, value: string) =>
    pool.query("SELECT public.delete_person_data($1,$2,$3,$4,$5) AS result", [workspace, C, owner, kind, value]);

  await sending();
  await assert.rejects(person("comment_sender", "1001"), { message: "sending_in_progress" });
  await pending();
  // A pending row that another transaction holds refuses at once (NOWAIT) instead of waiting for it.
  const personHolder = await pool.connect();
  try {
    await personHolder.query("BEGIN");
    await personHolder.query("SELECT 1 FROM campaign_deliveries WHERE run_id=$1 AND sender_id='1001' FOR UPDATE", [
      run,
    ]);
    // Bounded, so a deletion that waits on the held row fails here instead of hanging the file.
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the person deletion waited for the held row")), GATE_TIMEOUT_MS);
    });
    try {
      await assert.rejects(Promise.race([person("comment_sender", "1001"), waited]), {
        message: "sending_in_progress",
      });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await personHolder.query("ROLLBACK");
    personHolder.release();
  }
  // Person deletion by the comment sender, then by the DM recipient of the other member.
  assert.equal((await person("comment_sender", "1001")).rows[0].result.deleted_counts.campaign_deliveries, 1);
  assert.equal((await person("dm_recipient", "2002")).rows[0].result.deleted_counts.campaign_deliveries, 1);
  assert.deepEqual(await deliveries(run), []);

  // Connection deletion: a sending row or a row held by another transaction refuses; the run and its counts stay.
  await insertSending(run, "1005", "2005");
  await pool.query(
    "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
    [C],
  );
  const connection = () =>
    pool.query("SELECT public.delete_connection_data($1,$2,$3,'100') AS result", [workspace, C, owner]);
  await assert.rejects(connection(), { message: "sending_in_progress" });
  await pool.query(
    "UPDATE campaign_deliveries SET status='pending',attempt_id=NULL,attempt_started_at=NULL WHERE run_id=$1",
    [run],
  );
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM campaign_deliveries WHERE run_id=$1 FOR UPDATE", [run]);
    await assert.rejects(connection(), { message: "sending_in_progress" });
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  assert.equal((await connection()).rows[0].result.deleted_counts.campaign_deliveries, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM campaign_runs")).rows[0].n, 1);

  // Workspace deletion removes the rows and the runs before the approvals.
  await insertSending(run, "1006", "2006");
  const wipe = () => pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspace, owner]);
  await assert.rejects(wipe(), { message: "sending_in_progress" });
  await pool.query(
    "UPDATE campaign_deliveries SET status='pending',attempt_id=NULL,attempt_started_at=NULL WHERE run_id=$1",
    [run],
  );
  const deleted = (await wipe()).rows[0].result.deleted_counts;
  assert.equal(deleted.campaign_deliveries, 1);
  assert.equal(deleted.campaign_runs, 1);
  assert.equal(deleted.campaign_approvals, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM campaign_runs")).rows[0].n, 0);
});

test("a person deletion waits for a start on the connection lock and then removes the row it wrote", async () => {
  await qualifying("1001", "2001");
  const approval = await approve(await draftFor([[C, "1001"]]));
  // Held after the evaluation, before the rows are written: without the connection lock the deletion would finish
  // first and the start would then write a row for the deleted person.
  const gated = sharedPool(/AS candidates/);
  const starting = startDueCampaignRuns(gated.pool);
  await gated.held;
  const deleting = pool.query("SELECT public.delete_person_data($1,$2,$3,'comment_sender','1001') AS result", [
    workspace,
    C,
    owner,
  ]);
  try {
    await waitForWorkspaceLock("delete_person_data");
  } finally {
    // A failed wait must not leave the start's transaction open, or the file never ends.
    gated.release();
  }
  assert.deepEqual(await starting, { started: 1, skipped: 0, failed: 0 });
  assert.equal((await deleting).rows[0].result.deleted_counts.campaign_deliveries, 1);
  assert.deepEqual(await deliveries((await runOf(approval.id)).id), []);
});

test("the export carries runs and delivery rows, and either table alone blocks both workspace move paths", async () => {
  await qualifying("1001", "2001");
  const approval = await approve(await draftFor([[C, "1001"]]));
  await startDueCampaignRuns(pool);
  const exported = await expect(await request("GET", "/api/workspace/export"));
  assert.equal(exported.tables.campaign_runs.length, 1);
  assert.equal(exported.tables.campaign_runs[0].approval_id, approval.id);
  assert.equal(exported.tables.campaign_deliveries.length, 1);
  assert.equal(exported.tables.campaign_deliveries[0].recipient_id, "2001");

  for (const table of ["campaign_runs", "campaign_deliveries"]) {
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
      if (table === "campaign_runs")
        await client.query(
          `INSERT INTO campaign_runs(workspace_id,approval_id,draft_id,draft_version,snapshot_id,started_at,start_counts)
           VALUES($1,gen_random_uuid(),gen_random_uuid(),1,gen_random_uuid(),now(),
             '{"original_member_count":"0","remaining_member_count":"0","connection_unavailable":"0","contact_paused":"0",
               "no_dm_identity":"0","opted_out":"0","marketing_consent_required":"0","reply_window_closed":"0","candidate":"0"}')`,
          [own],
        );
      else
        await client.query(
          `INSERT INTO campaign_deliveries(workspace_id,run_id,connection_id,sender_id,recipient_id)
           VALUES($1,gen_random_uuid(),gen_random_uuid(),'1','2')`,
          [own],
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

test("delivery rows tie their status to their columns", async () => {
  const approval = await approve(await draftFor([[C, "1001"]]));
  await startDueCampaignRuns(pool);
  const run = (await runOf(approval.id)).id;
  const insert = (columns: string, values: string) =>
    pool.query(
      `INSERT INTO campaign_deliveries(workspace_id,run_id,connection_id,sender_id,recipient_id,${columns})
       VALUES($1,$2,$3,'${++sequence}','2001',${values})`,
      [workspace, run, C],
    );
  await assert.rejects(insert("status", "'sending'"), { code: "23514" });
  await assert.rejects(insert("status,attempt_id", "'pending',gen_random_uuid()"), { code: "23514" });
  await assert.rejects(insert("status,attempt_id,attempt_started_at", "'sent',gen_random_uuid(),now()"), {
    code: "23514",
  });
  await assert.rejects(insert("status,attempt_id,attempt_started_at", "'failed',gen_random_uuid(),now()"), {
    code: "23514",
  });
  await assert.rejects(insert("status,provider_message_id,sent_at", "'pending','m',now()"), { code: "23514" });
  await insert(
    "status,attempt_id,attempt_started_at,provider_message_id,sent_at",
    "'sent',gen_random_uuid(),now(),'m',now()",
  );
  await insert(
    "status,attempt_id,attempt_started_at,failure_code",
    "'blocked',gen_random_uuid(),now(),'recipient_opted_out'",
  );
  await insert("status", "'cancelled'");
  // Recipient IDs are the DM recipient's numeric ID; the foreign workspace's connection is refused.
  await assert.rejects(
    pool.query(
      "INSERT INTO campaign_deliveries(workspace_id,run_id,connection_id,sender_id,recipient_id) VALUES($1,$2,$3,'x','abc')",
      [workspace, run, C],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO campaign_deliveries(workspace_id,run_id,connection_id,sender_id,recipient_id) VALUES($1,$2,$3,'x','1')",
      [workspace, run, FC],
    ),
    { code: "23503" },
  );
});

test("migration 065 replays over stored runs and reproduces the canonical deletion functions", async () => {
  await qualifying("1001", "2001");
  const approval = await approve(await draftFor([[C, "1001"]]));
  await startDueCampaignRuns(pool);
  const definitions = async () =>
    (
      await pool.query(
        "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('delete_person_data','delete_connection_data','delete_workspace_data') ORDER BY proname",
      )
    ).rows;
  const canonical = await definitions();
  for (const { definition } of canonical) assert.match(definition, /campaign_deliveries/);
  const sql = await readFile(new URL("../../db/migrations/065_campaign_runs.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  assert.deepEqual(await definitions(), canonical);
  assert.equal(await approvalStatus(approval.id), "executed");
  assert.equal((await deliveries((await runOf(approval.id)).id)).length, 1);
  // The executed status needs the replaced checks; a cancelled approval still needs its cancel columns.
  await assert.rejects(
    pool.query("UPDATE campaign_approvals SET cancelled_by=$2,cancelled_at=now() WHERE id=$1", [approval.id, owner]),
    { code: "23514" },
  );
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(
    runner.indexOf("065_campaign_runs.sql") > runner.indexOf("064_campaign_approvals.sql") &&
      runner.indexOf("065_campaign_runs.sql") < runner.indexOf("supabase-access.sql"),
  );
});

test("migration 066 replays over stored rows and keeps the delivery checks", async () => {
  await qualifying("1001", "2001");
  const approval = await approve(await draftFor([[C, "1001"]]));
  await startDueCampaignRuns(pool);
  const run = (await runOf(approval.id)).id;
  const sql = await readFile(new URL("../../db/migrations/066_campaign_delivery.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  const row = (
    await pool.query(
      "SELECT status,next_attempt_at<=clock_timestamp() AS due,provider_called_at FROM campaign_deliveries WHERE run_id=$1",
      [run],
    )
  ).rows;
  assert.deepEqual(row, [{ status: "pending", due: true, provider_called_at: null }]);
  const indexes = (
    await pool.query(
      "SELECT indexname FROM pg_indexes WHERE tablename='campaign_deliveries' AND indexname LIKE 'campaign_deliveries_%_idx' ORDER BY indexname",
    )
  ).rows.map((index) => index.indexname);
  for (const name of [
    "campaign_deliveries_called_idx",
    "campaign_deliveries_due_idx",
    "campaign_deliveries_sending_idx",
  ])
    assert.ok(indexes.includes(name), name);
  // A pending row still holds no attempt.
  await assert.rejects(
    pool.query("UPDATE campaign_deliveries SET attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE run_id=$1", [
      run,
    ]),
    { code: "23514" },
  );
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(
    runner.indexOf("066_campaign_delivery.sql") > runner.indexOf("065_campaign_runs.sql") &&
      runner.indexOf("066_campaign_delivery.sql") < runner.indexOf("supabase-access.sql"),
  );
});
