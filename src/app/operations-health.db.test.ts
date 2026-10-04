import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { evaluateAlerts, recordStep, recordSteps } from "./operations-health.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const adminId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const connectionId = "55555555-5555-4555-8555-555555555555";
const foreignConnectionId = "77777777-7777-4777-8777-777777777777";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SEND_ENABLED: "true" };

before(async () => {
  // scheduled_steps has no foreign keys; recreating it keeps its columns current with db/schema.sql.
  await pool.query("DROP TABLE IF EXISTS scheduled_steps");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

async function seedConnection(workspace: string, connection: string, account: string) {
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [workspace]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,active,send_enabled,access_token_encrypted,token_expires_at)
     VALUES($1,$2,$3,$3,true,true,'SECRET-CIPHERTEXT',now()+interval '30 days')`,
    [connection, workspace, account],
  );
  await pool.query(
    `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled)
     VALUES(gen_random_uuid(),$1,$2,'1789','link','reply text',true)`,
    [workspace, connection],
  );
}

// One outbox row per sender with the given state; times are minutes before now.
async function reply(
  connection: string,
  sender: string,
  status: string,
  options: { dueMinutesAgo?: number; claimedMinutesAgo?: number; hoursAgo?: number } = {},
) {
  const { workspace_id: workspace, id: rule } = (
    await pool.query("SELECT workspace_id,id FROM instagram_comment_rules WHERE connection_id=$1", [connection])
  ).rows[0];
  const event = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at)
       VALUES($1,$2,$3,'1789',$4,'secret comment text',now()-make_interval(hours=>$5)) RETURNING id`,
      [workspace, connection, `comment-${sender}`, sender, options.hoursAgo ?? 0],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text,
       status,created_at,next_attempt_at,attempt_id,attempt_started_at)
     VALUES($1,$2,$3,$4,$5,'1789',$6,'reply text',$7,now()-make_interval(hours=>$8),now()-make_interval(mins=>$9),
       CASE WHEN $10::int IS NULL THEN NULL ELSE gen_random_uuid() END,now()-make_interval(mins=>$10::int))`,
    [
      workspace,
      connection,
      event,
      rule,
      `comment-${sender}`,
      sender,
      status,
      options.hoursAgo ?? 0,
      options.dueMinutesAgo ?? 0,
      options.claimedMinutesAgo ?? null,
    ],
  );
}

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces, scheduled_steps CASCADE");
  await seedConnection(workspaceId, connectionId, "account-own");
  await seedConnection(otherWorkspaceId, foreignConnectionId, "account-foreign");
  await pool.query(
    "INSERT INTO workspace_members(user_id,workspace_id,role,email) VALUES($1,$3,'owner','owner@example.test'),($2,$3,'agent','agent@example.test')",
    [adminId, agentId, workspaceId],
  );
});

after(async () => pool.end());

function health(actorId = adminId, env: Record<string, string> = apiEnv) {
  return appApi(
    new Request("https://app.test/api/workspace/health", {
      method: "GET",
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test" },
    }),
    env,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () =>
      Response.json({ id: actorId, email: "owner@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

test("admins see their own connections' delivery metrics and alerts, agents are refused", async () => {
  // Queue latency counts from when a reply became due, and held work is not waiting.
  await reply(connectionId, "100", "pending", { dueMinutesAgo: 20 });
  await reply(connectionId, "101", "pending", { dueMinutesAgo: 90 });
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,'101',true)",
    [workspaceId, connectionId],
  );
  await reply(connectionId, "102", "pending", { dueMinutesAgo: -30 });
  await reply(connectionId, "103", "sending", { claimedMinutesAgo: 12 });
  await reply(connectionId, "104", "unknown", { claimedMinutesAgo: 60 });
  await reply(connectionId, "105", "failed", { claimedMinutesAgo: 60 });
  await reply(connectionId, "106", "blocked", { claimedMinutesAgo: 60 });
  // Outcomes older than 24 hours are not counted.
  await reply(connectionId, "107", "unknown", { claimedMinutesAgo: 25 * 60, hoursAgo: 25 });
  await reply(foreignConnectionId, "200", "unknown", { claimedMinutesAgo: 1 });
  await pool.query("UPDATE instagram_connections SET token_expires_at=now()+interval '3 days 1 hour' WHERE id=$1", [
    connectionId,
  ]);
  await recordStep(pool, "cron", null);

  const response = await health();
  assert.equal(response.status, 200);
  const text = await response.text();
  for (const forbidden of [
    "secret comment text",
    "reply text",
    "SECRET-CIPHERTEXT",
    "@example.test",
    "recipient",
    "sender",
  ])
    assert.equal(text.includes(forbidden), false, forbidden);
  const body = JSON.parse(text);
  assert.deepEqual(body.alerts, []);
  assert.equal(body.global_send_enabled, true);
  assert.deepEqual(body.thresholds, {
    oldest_pending_minutes: 15,
    sending_dwell_minutes: 10,
    token_expiry_days: 7,
    cron_stale_minutes: 5,
  });
  assert.ok(Date.now() - Date.parse(body.last_cron_success_at) < 60_000);
  assert.equal(body.connections.length, 1);
  const [connection] = body.connections;
  assert.equal(connection.id, connectionId);
  assert.ok(connection.oldest_due_pending_seconds >= 20 * 60 && connection.oldest_due_pending_seconds < 21 * 60);
  assert.ok(connection.longest_sending_seconds >= 12 * 60 && connection.longest_sending_seconds < 13 * 60);
  assert.deepEqual(
    [connection.unknown_24h, connection.failed_24h, connection.blocked_24h, connection.token_expires_in_days],
    [1, 1, 1, 3],
  );
  assert.equal(connection.send_paused_until, null);
  assert.deepEqual(connection.alerts, ["oldest_pending", "sending_dwell", "unknown_outcome", "token_expiring"]);

  // With global sending off, waiting replies are expected and raise no alert.
  const off = await (await health(adminId, { ...apiEnv, SEND_ENABLED: "false" })).json();
  assert.deepEqual(off.connections[0].alerts, ["sending_dwell", "unknown_outcome", "token_expiring"]);

  const refused = await health(agentId);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "role_forbidden" });
});

test("a follow reply outcome is dated by its last claim, not by the confirmation", async () => {
  // Confirmed almost 24 hours before the send, which became unknown an hour ago.
  await reply(connectionId, "108", "sent", { claimedMinutesAgo: 25 * 60 });
  await pool.query(
    `INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,
       non_follower_reply_text,status,confirmed_at,attempt_started_at)
     SELECT id,connection_id,'908','ok','follower text','nonfollower text','unknown',now()-interval '24 hours 50 minutes',
       now()-interval '1 hour' FROM private_reply_outbox WHERE sender_id='108'`,
  );
  await recordStep(pool, "cron", null);
  const [connection] = (await (await health()).json()).connections;
  assert.deepEqual([connection.unknown_24h, connection.failed_24h, connection.blocked_24h], [1, 0, 0]);
  assert.deepEqual(connection.alerts, ["unknown_outcome"]);
});

test("a paused connection reports the pause and holds its replies out of the queue latency", async () => {
  await reply(connectionId, "100", "pending", { dueMinutesAgo: 30 });
  await pool.query("UPDATE instagram_connections SET send_paused_until=now()+interval '15 minutes' WHERE id=$1", [
    connectionId,
  ]);
  const body = await (await health()).json();
  assert.deepEqual(body.alerts, ["cron_stale"]);
  assert.equal(body.last_cron_success_at, null);
  const [connection] = body.connections;
  assert.ok(Date.parse(connection.send_paused_until) > Date.now());
  assert.equal(connection.oldest_due_pending_seconds, null);
  // After the pause the wait counts from the end of the pause, not from the original due time.
  await pool.query("UPDATE instagram_connections SET send_paused_until=now()-interval '2 minutes' WHERE id=$1", [
    connectionId,
  ]);
  const resumed = (await (await health()).json()).connections[0];
  assert.equal(resumed.send_paused_until, null);
  assert.ok(resumed.oldest_due_pending_seconds >= 120 && resumed.oldest_due_pending_seconds < 180);
});

test("an overlapping cron run with an older unknown count cannot lower the seen count and log the occurrence twice", async () => {
  const lines: unknown[] = [];
  for (const method of ["log", "warn", "error"] as const)
    mock.method(console, method, (line: string) => lines.push(JSON.parse(line)));
  try {
    await reply(connectionId, "104", "unknown", { claimedMinutesAgo: 5 });
    await evaluateAlerts(pool, true, "corr-1", true);
    // Run A reads the unknown count and stalls; run B sees one more unknown and logs it before A resumes.
    let overlapped = false;
    const stalled = {
      async query(sql: string, values?: unknown[]) {
        const result = await pool.query(sql, values);
        if (!overlapped && sql.includes("AS total")) {
          overlapped = true;
          await reply(connectionId, "105", "unknown", { claimedMinutesAgo: 1 });
          await evaluateAlerts(pool, true, "corr-b", true);
        }
        return result;
      },
    } as unknown as Pool;
    await evaluateAlerts(stalled, true, "corr-a", true);
    assert.equal(overlapped, true);
    await evaluateAlerts(pool, true, "corr-next", true);
    assert.deepEqual(lines, [
      { event: "alert_started", code: "alert_unknown_outcome", correlation_id: "corr-1" },
      { event: "alert_new_occurrence", code: "alert_unknown_outcome", correlation_id: "corr-b" },
    ]);
  } finally {
    mock.restoreAll();
  }
  assert.equal(
    (await pool.query("SELECT alert_seen_count FROM scheduled_steps WHERE name='alert_unknown_outcome'")).rows[0]
      .alert_seen_count,
    "2",
  );
});

// A pool on which a cron run stalls right after it reads the metrics, while overlap runs another run.
function stalledAfterMetrics(overlap: () => Promise<void>) {
  const state = { overlapped: false };
  const stalled = {
    async query(sql: string, values?: unknown[]) {
      const result = await pool.query(sql, values);
      if (!state.overlapped && sql.includes("WITH metrics")) {
        state.overlapped = true;
        await overlap();
      }
      return result;
    },
  } as unknown as Pool;
  return { stalled, state };
}

test("an overlapping cron run that read older metrics cannot undo a newer run's start or clear", async () => {
  const lines: unknown[] = [];
  for (const method of ["log", "warn", "error"] as const)
    mock.method(console, method, (line: string) => lines.push(JSON.parse(line)));
  try {
    // Run A reads no unknown and stalls; run B sees a new one and starts the alert; A must not clear it.
    const started = stalledAfterMetrics(async () => {
      await reply(connectionId, "104", "unknown", { claimedMinutesAgo: 1 });
      await evaluateAlerts(pool, true, "corr-b", true);
    });
    await evaluateAlerts(started.stalled, true, "corr-a", true);
    assert.equal(started.state.overlapped, true);
    await evaluateAlerts(pool, true, "corr-next", true);
    assert.deepEqual(lines, [{ event: "alert_started", code: "alert_unknown_outcome", correlation_id: "corr-b" }]);
    // Run C still sees the unknown and stalls; run D sees it age out and clears the alert; C must not restart it.
    lines.length = 0;
    const cleared = stalledAfterMetrics(async () => {
      await pool.query("UPDATE private_reply_outbox SET attempt_started_at=now()-interval '25 hours'");
      await evaluateAlerts(pool, true, "corr-d", true);
    });
    await evaluateAlerts(cleared.stalled, true, "corr-c", true);
    assert.equal(cleared.state.overlapped, true);
    await evaluateAlerts(pool, true, "corr-after", true);
    assert.deepEqual(lines, [{ event: "alert_cleared", code: "alert_unknown_outcome", correlation_id: "corr-d" }]);
  } finally {
    mock.restoreAll();
  }
  assert.equal(
    (await pool.query("SELECT alert_active FROM scheduled_steps WHERE name='alert_unknown_outcome'")).rows[0]
      .alert_active,
    false,
  );
});

test("a run that read older state cannot undo a transition made after its read, even when it matches its read", async () => {
  const lines: unknown[] = [];
  for (const method of ["log", "warn", "error"] as const)
    mock.method(console, method, (line: string) => lines.push(JSON.parse(line)));
  const active = async () =>
    (await pool.query("SELECT alert_active FROM scheduled_steps WHERE name='alert_unknown_outcome'")).rows[0]
      .alert_active;
  try {
    // The alert is on and its unknown has aged out, so run A reads it on and wants to clear it. While A stalls,
    // run B clears it and run C starts it again for a new unknown; A must not clear C's start.
    await reply(connectionId, "104", "unknown", { claimedMinutesAgo: 1 });
    await evaluateAlerts(pool, true, "corr-0", true);
    await pool.query("UPDATE private_reply_outbox SET attempt_started_at=now()-interval '25 hours'");
    lines.length = 0;
    const clear = stalledAfterMetrics(async () => {
      await evaluateAlerts(pool, true, "corr-b", true);
      await reply(connectionId, "105", "unknown", { claimedMinutesAgo: 1 });
      await evaluateAlerts(pool, true, "corr-c", true);
    });
    await evaluateAlerts(clear.stalled, true, "corr-a", true);
    assert.equal(clear.state.overlapped, true);
    assert.deepEqual(lines, [
      { event: "alert_cleared", code: "alert_unknown_outcome", correlation_id: "corr-b" },
      { event: "alert_started", code: "alert_unknown_outcome", correlation_id: "corr-c" },
    ]);
    assert.equal(await active(), true);
    // The alert is off again and a new unknown appears, so run D reads it off and wants to start it. While D
    // stalls, run E starts it and run F clears it after the unknowns age out; D must not start it again.
    await pool.query("UPDATE private_reply_outbox SET attempt_started_at=now()-interval '25 hours'");
    await evaluateAlerts(pool, true, "corr-1", true);
    await reply(connectionId, "106", "unknown", { claimedMinutesAgo: 1 });
    lines.length = 0;
    const start = stalledAfterMetrics(async () => {
      await evaluateAlerts(pool, true, "corr-e", true);
      await pool.query("UPDATE private_reply_outbox SET attempt_started_at=now()-interval '25 hours'");
      await evaluateAlerts(pool, true, "corr-f", true);
    });
    await evaluateAlerts(start.stalled, true, "corr-d", true);
    assert.equal(start.state.overlapped, true);
    assert.deepEqual(lines, [
      { event: "alert_started", code: "alert_unknown_outcome", correlation_id: "corr-e" },
      { event: "alert_cleared", code: "alert_unknown_outcome", correlation_id: "corr-f" },
    ]);
    assert.equal(await active(), false);
  } finally {
    mock.restoreAll();
  }
});

test("alert starts and clears are each logged once, with only allowed fields", async () => {
  const lines: unknown[] = [];
  for (const method of ["log", "warn", "error"] as const)
    mock.method(console, method, (line: string) => lines.push(JSON.parse(line)));
  try {
    await recordStep(pool, "cron", null);
    await reply(connectionId, "104", "unknown", { claimedMinutesAgo: 5 });
    await evaluateAlerts(pool, true, "corr-1");
    await evaluateAlerts(pool, true, "corr-2");
    assert.deepEqual(lines, [{ event: "alert_started", code: "alert_unknown_outcome", correlation_id: "corr-1" }]);
    // Each new unknown while the alert is already on is logged once more.
    await reply(connectionId, "105", "unknown", { claimedMinutesAgo: 1 });
    await evaluateAlerts(pool, true, "corr-new");
    await evaluateAlerts(pool, true, "corr-new-again");
    // Deleted rows (person or connection data deletion) lower the count silently; a later unknown is still new.
    await pool.query("DELETE FROM private_reply_outbox WHERE sender_id='105'");
    await evaluateAlerts(pool, true, "corr-deleted");
    await reply(connectionId, "106", "unknown", { claimedMinutesAgo: 1 });
    await evaluateAlerts(pool, true, "corr-after-delete");
    assert.deepEqual(lines.slice(1), [
      { event: "alert_new_occurrence", code: "alert_unknown_outcome", correlation_id: "corr-new" },
      { event: "alert_new_occurrence", code: "alert_unknown_outcome", correlation_id: "corr-after-delete" },
    ]);
    lines.length = 0;
    await pool.query("UPDATE private_reply_outbox SET attempt_started_at=now()-interval '25 hours'");
    await pool.query("UPDATE scheduled_steps SET last_success_at=now()-interval '6 minutes' WHERE name='cron'");
    await evaluateAlerts(pool, true, "corr-3");
    await evaluateAlerts(pool, true, "corr-4");
    assert.deepEqual(lines, [
      { event: "alert_cleared", code: "alert_unknown_outcome", correlation_id: "corr-3" },
      { event: "alert_started", code: "alert_cron_stale", correlation_id: "corr-3" },
    ]);
    // A run whose earlier steps all succeeded is not stale: it clears the cron alert before it records itself.
    lines.length = 0;
    await evaluateAlerts(pool, true, "corr-5", true);
    await evaluateAlerts(pool, true, "corr-6");
    assert.deepEqual(lines, [
      { event: "alert_cleared", code: "alert_cron_stale", correlation_id: "corr-5" },
      { event: "alert_started", code: "alert_cron_stale", correlation_id: "corr-6" },
    ]);
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(
    (await pool.query("SELECT name,alert_active FROM scheduled_steps WHERE name LIKE 'alert_%' ORDER BY name")).rows,
    [
      { name: "alert_cron_stale", alert_active: true },
      { name: "alert_unknown_outcome", alert_active: false },
    ],
  );
});

test("an alert evaluation with nothing to change issues only its single read", async () => {
  const lines: unknown[] = [];
  for (const method of ["log", "warn", "error"] as const)
    mock.method(console, method, (line: string) => lines.push(JSON.parse(line)));
  const statements: string[] = [];
  const counted = {
    async query(sql: string, values?: unknown[]) {
      statements.push(sql);
      return pool.query(sql, values);
    },
  } as unknown as Pool;
  try {
    await reply(connectionId, "104", "unknown", { claimedMinutesAgo: 5 });
    await evaluateAlerts(counted, true, "corr-1", true);
    assert.equal(statements.length, 2);
    // unknown_outcome is already on with the same count, and every other alert is already off.
    statements.length = 0;
    await evaluateAlerts(counted, true, "corr-2", true);
    assert.equal(statements.length, 1);
    // A changed count is still written, and an alert that turns off is still cleared.
    await reply(connectionId, "105", "unknown", { claimedMinutesAgo: 1 });
    await evaluateAlerts(counted, true, "corr-3", true);
    await pool.query("UPDATE private_reply_outbox SET attempt_started_at=now()-interval '25 hours'");
    await evaluateAlerts(counted, true, "corr-4", true);
    statements.length = 0;
    await evaluateAlerts(counted, true, "corr-5", true);
    assert.equal(statements.length, 1);
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(lines, [
    { event: "alert_started", code: "alert_unknown_outcome", correlation_id: "corr-1" },
    { event: "alert_new_occurrence", code: "alert_unknown_outcome", correlation_id: "corr-3" },
    { event: "alert_cleared", code: "alert_unknown_outcome", correlation_id: "corr-4" },
  ]);
});

test("a run without connections still evaluates the service alerts", async () => {
  await pool.query("TRUNCATE workspaces, scheduled_steps CASCADE");
  const lines: unknown[] = [];
  for (const method of ["log", "warn", "error"] as const)
    mock.method(console, method, (line: string) => lines.push(JSON.parse(line)));
  try {
    await evaluateAlerts(pool, true, "corr-stale");
    await evaluateAlerts(pool, true, "corr-ok", true);
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(lines, [
    { event: "alert_started", code: "alert_cron_stale", correlation_id: "corr-stale" },
    { event: "alert_cleared", code: "alert_cron_stale", correlation_id: "corr-ok" },
  ]);
});

test("a batched record changes each row as a single-row record would", async () => {
  await recordStep(pool, "wake", "database_error");
  await recordStep(pool, "flow_resume", null);
  const read = async () =>
    (
      await pool.query(
        `SELECT name,last_success_at,last_failure_at,failure_code FROM scheduled_steps
         WHERE name IN ('alerts','cron','flow_resume','wake') ORDER BY name`,
      )
    ).rows;
  const [flowBefore, wakeBefore] = await read();
  await recordSteps(pool, [
    { name: "wake", failure: null },
    { name: "flow_resume", failure: "database_unavailable" },
    { name: "alerts", failure: null },
    { name: "cron", failure: "step_failed" },
  ]);
  const [alerts, cron, flow, wake] = await read();
  // A success sets only last_success_at and keeps the last failure; a failure keeps the last success.
  assert.ok(wake.last_success_at instanceof Date);
  assert.deepEqual([wake.last_failure_at, wake.failure_code], [wakeBefore.last_failure_at, "database_error"]);
  assert.deepEqual(flow.last_success_at, flowBefore.last_success_at);
  assert.ok(flow.last_failure_at instanceof Date);
  assert.equal(flow.failure_code, "database_unavailable");
  assert.ok(alerts.last_success_at instanceof Date);
  assert.deepEqual([alerts.last_failure_at, alerts.failure_code], [null, null]);
  assert.equal(cron.last_success_at, null);
  assert.ok(cron.last_failure_at instanceof Date);
  assert.equal(cron.failure_code, "step_failed");
});

test("a database failure behind an API request returns 503 and logs only a fixed code", async () => {
  const lines: unknown[][] = [];
  for (const method of ["log", "warn", "error"] as const)
    mock.method(console, method, (...args: string[]) => lines.push(args.map((line) => JSON.parse(line))));
  try {
    const response = await appApi(
      new Request("https://app.test/api/workspace/health", {
        method: "GET",
        headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "cf-ray": "8c1f2e3d4b5a6978-ICN" },
      }),
      apiEnv,
      () =>
        ({
          query: async () => {
            throw Object.assign(new Error("relation for owner@example.test secret comment text"), { code: "08006" });
          },
          end: async () => {},
        }) as unknown as Pool,
      (async () =>
        Response.json({ id: adminId, email: "owner@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(lines, [
    [{ event: "request_failed", code: "database_unavailable", correlation_id: "8c1f2e3d4b5a6978-ICN" }],
  ]);
});

test("an API request without cf-ray logs a fresh UUID correlation ID, also from its pool", async () => {
  const lines: unknown[][] = [];
  for (const method of ["log", "warn", "error"] as const)
    mock.method(console, method, (...args: string[]) => lines.push(args.map((line) => JSON.parse(line))));
  let poolCorrelationId: string | undefined;
  try {
    const response = await appApi(
      new Request("https://app.test/api/workspace/health", {
        method: "GET",
        headers: { origin: "https://app.test", cookie: "__Host-ac-access=test" },
      }),
      apiEnv,
      (correlationId) => {
        poolCorrelationId = correlationId;
        return {
          query: async () => {
            throw Object.assign(new Error("connection refused"), { code: "08006" });
          },
          end: async () => {},
        } as unknown as Pool;
      },
      (async () =>
        Response.json({ id: adminId, email: "owner@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
    );
    assert.equal(response.status, 503);
  } finally {
    mock.restoreAll();
  }
  assert.equal(lines.length, 1);
  const [[entry]] = lines as [[{ event: string; code: string; correlation_id: string }]];
  assert.equal(entry.event, "request_failed");
  assert.match(entry.correlation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(poolCorrelationId, entry.correlation_id);
});
