import { ingestMessages } from "../instagram/follow-flow.ts";
import { recordChannelConsentEvent } from "../instagram/channel-consent.ts";
import { openSecret, sealSecret } from "../app/secrets.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { Pool } from "pg";
import worker, { type Env } from "./index.ts";
import { operationsHealth } from "../app/operations-health.ts";
import { signingKeyContext } from "../app/webhook-delivery.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const url = new URL(databaseUrl);
if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl });
const connectionId = "22222222-2222-4222-8222-222222222222";
let published: unknown[];
let env: Env;
let sends: number;

function request(comment = "comment-1", sender = "sender-1", valid = true): Request {
  const body = JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: "123",
        field: "comments",
        value: {
          id: comment,
          text: "hello",
          from: { id: sender },
          media: { id: "media-1" },
        },
      },
    ],
  });
  return new Request("https://example.test/webhooks/instagram", {
    method: "POST",
    body,
    headers: {
      "x-hub-signature-256": `sha256=${valid ? createHmac("sha256", "test-secret").update(body).digest("hex") : "0".repeat(64)}`,
    },
  });
}

async function consume(body: unknown = { connectionId }) {
  let result = "unacknowledged";
  await worker.queue(
    {
      messages: [
        {
          body,
          ack() {
            result = "ack";
          },
          retry() {
            result = "retry";
          },
        },
      ],
    },
    env,
  );
  return result;
}
async function rows() {
  return (await pool.query("SELECT status, failure_code, rate_limit_retries FROM private_reply_outbox ORDER BY id"))
    .rows;
}

async function resetStoredFixture() {
  await pool.query(
    "TRUNCATE private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces, scheduled_steps CASCADE",
  );
  await pool.query("INSERT INTO workspaces VALUES ('11111111-1111-4111-8111-111111111111')");
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active) VALUES ($1,'11111111-1111-4111-8111-111111111111','123',true)",
    [connectionId],
  );
  await pool.query(
    "UPDATE instagram_connections SET send_enabled=true,token_expires_at=now()+interval '1 day',access_token_encrypted=$1",
    [sealSecret("synthetic", Buffer.alloc(32, 1).toString("base64"), "11111111-1111-4111-8111-111111111111:123")],
  );
  await pool.query(
    "INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled) VALUES ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',$1,'media-1','hello','reply',true)",
    [connectionId],
  );
}

async function recordConsent(
  identityKind: "comment_sender" | "dm_recipient",
  identityValue: string,
  requestKey: string,
  decision: "grant" | "revoke" = "revoke",
) {
  await recordChannelConsentEvent(pool, {
    requestKey,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    connectionId,
    channel: "instagram",
    identityKind,
    identityValue,
    purpose: "service_reply",
    decision,
    evidenceKind: "explicit",
    evidenceReference: `test:${decision}`,
    occurredAt: new Date(),
    actorId: "99999999-9999-4999-8999-999999999999",
  });
}

function mockDefaultGraphFetch() {
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const graphUrl = new URL(String(input));
    assert.equal(graphUrl.hostname, "graph.instagram.com");
    if (init?.method === "POST") {
      sends++;
      return Response.json({ message_id: "message-1" });
    }
    if (graphUrl.pathname.endsWith("/me")) return Response.json({ user_id: "123" });
    if (graphUrl.pathname.endsWith("/media-1")) return Response.json({ id: "media-1", owner: { id: "123" } });
    return Response.json({
      id: graphUrl.pathname.split("/").at(-1),
      from: { id: "sender-1" },
      media: { id: "media-1" },
      timestamp: new Date().toISOString(),
    });
  });
}

// Every test captures every console call; afterEach checks that each one is a single-line JSON operations log
// string that holds only the allow-listed fields. logLines holds the parsed entries.
type LogLine = Record<string, string>;
let logLines: LogLine[] = [];
let logCalls: unknown[][] = [];
function captureLogs(): void {
  for (const method of ["log", "warn", "error"] as const)
    mock.method(console, method, (...args: unknown[]) => {
      logCalls.push(args);
      logLines.push(typeof args[0] === "string" ? (JSON.parse(args[0]) as LogLine) : (args[0] as LogLine));
    });
}
// mock.restoreAll() for a test's own mocks, keeping the log capture.
function restoreMocks(): void {
  mock.restoreAll();
  captureLogs();
}

function failConsentRead(failAt: number): () => number {
  const originalQuery = Pool.prototype.query;
  let consentReads = 0;
  mock.method(Pool.prototype, "query", async function (this: Pool, sql: string, values?: unknown[]) {
    if (sql.includes("FROM channel_consent_state state") && ++consentReads === failAt)
      throw new Error("consent database unavailable");
    return Reflect.apply(originalQuery, this, [sql, values]);
  });
  return () => consentReads;
}

before(async () => {
  await pool.query(
    "DROP TABLE IF EXISTS webhook_redelivery_events, webhook_deliveries, webhook_signing_keys, webhook_endpoints, scheduled_steps, workspace_invites, data_deletion_records, instagram_inbox_reminder_events, instagram_inbox_reminders, instagram_inbox_notes, instagram_inbox_label_events, instagram_inbox_label_rules, instagram_inbox_conversation_labels, instagram_inbox_labels, instagram_inbox_read_state, instagram_inbox_conversation_events, instagram_inbox_conversations, flow_step_runs, flow_runs, flow_versions, flows, channel_consent_state, channel_consent_events, instagram_manual_reply_events, instagram_manual_replies, instagram_inbox_handoff_events, instagram_inbox_handoffs, instagram_inbox_messages, instagram_unmatched_replies, instagram_contact_automation, instagram_contact_field_values, instagram_contact_fields, instagram_contact_segments, instagram_contact_tags, instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
  );
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  mock.restoreAll();
  logLines = [];
  logCalls = [];
  captureLogs();
  published = [];
  sends = 0;
  env = {
    AUTH_IP_LIMIT: { limit: async () => ({ success: true }) },
    AUTH_EMAIL_LIMIT: { limit: async () => ({ success: true }) },
    HYPERDRIVE: { connectionString: databaseUrl! },
    REPLY_QUEUE: {
      async send(body) {
        published.push(body);
      },
    },
    INSTAGRAM_APP_SECRET: "test-secret",
    INSTAGRAM_VERIFY_TOKEN: "test-verify",
    META_INSTAGRAM_CONNECTION_ID: connectionId,
    META_INSTAGRAM_ACCOUNT_ID: "123",
    META_GRAPH_VERSION: "v24.0",
    META_INSTAGRAM_ACCESS_TOKEN: "synthetic",
    SEND_ENABLED: "true",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };
  await resetStoredFixture();
  mockDefaultGraphFetch();
});
afterEach(() => {
  for (const args of logCalls) {
    assert.equal(args.length, 1);
    const [line] = args;
    assert.equal(typeof line, "string");
    assert.ok(!(line as string).includes("\n"));
    const entry: unknown = JSON.parse(line as string);
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
    for (const key of Object.keys(entry))
      assert.ok(["event", "code", "correlation_id", "connection_id", "step"].includes(key), key);
  }
});
after(async () => {
  mock.restoreAll();
  await pool.end();
});

test("subscription verifies without a DB connection; invalid signatures cannot persist", async () => {
  const response = await worker.fetch(
    new Request(
      "https://example.test/webhooks/instagram?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=challenge",
    ),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "challenge");
  assert.equal((await worker.fetch(request("comment-1", "sender-1", false), env)).status, 403);
  assert.deepEqual(await rows(), []);
});

test("scheduled token refresh runs while global message sending is disabled", async () => {
  env.SEND_ENABLED = "false";
  await pool.query(
    "UPDATE instagram_connections SET token_expires_at=now()+interval '20 days',token_obtained_at=now()-interval '2 days' WHERE id=$1",
    [connectionId],
  );
  restoreMocks();
  const calls: string[] = [];
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo) => {
    const graphUrl = new URL(String(input));
    calls.push(graphUrl.pathname);
    if (graphUrl.pathname === "/refresh_access_token")
      return Response.json({ access_token: "renewed-token", token_type: "bearer", expires_in: 5_184_000 });
    return Response.json({ user_id: "123" });
  });
  await worker.scheduled(undefined, env);
  const result = await pool.query(
    "SELECT access_token_encrypted,token_expires_at FROM instagram_connections WHERE id=$1",
    [connectionId],
  );
  assert.equal(
    openSecret(
      result.rows[0].access_token_encrypted,
      env.TOKEN_ENCRYPTION_KEY!,
      "11111111-1111-4111-8111-111111111111:123",
    ),
    "renewed-token",
  );
  assert.ok(result.rows[0].token_expires_at.getTime() > Date.now() + 59 * 86400_000);
  assert.deepEqual(calls, ["/refresh_access_token", "/v24.0/me"]);
  assert.equal(sends, 0);
  assert.deepEqual(published, []);
});

test("a failed Meta token refresh fails the token_refresh step without logging the provider response", async () => {
  await pool.query(
    "UPDATE instagram_connections SET token_expires_at=now()+interval '20 days',token_obtained_at=now()-interval '2 days' WHERE id=$1",
    [connectionId],
  );
  // A recent successful run keeps cron_stale off, so the only line is the refresh failure.
  await pool.query("INSERT INTO scheduled_steps(name,last_success_at) VALUES('cron',now())");
  restoreMocks();
  mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "token for owner@example.test", code: 190 } }, { status: 400 }),
  );
  await assert.rejects(worker.scheduled({}, env), /^Error: Cloudflare scheduled recovery failed$/);
  assert.deepEqual(
    logLines.map(({ correlation_id, ...line }) => line),
    [{ event: "cron_step_failed", code: "token_refresh_failed", step: "token_refresh" }],
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT name,failure_code,last_success_at IS NOT NULL AS succeeded FROM scheduled_steps WHERE name IN ('token_refresh','wake','cron') ORDER BY name",
      )
    ).rows,
    [
      { name: "cron", failure_code: "step_failed", succeeded: true },
      { name: "token_refresh", failure_code: "token_refresh_failed", succeeded: false },
      { name: "wake", failure_code: null, succeeded: true },
    ],
  );
});

test("duplicate webhook and queue delivery send one persisted reply", async () => {
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.deepEqual(published, [{ connectionId }, { connectionId }]);
  assert.equal(await consume(), "ack");
  assert.equal(await consume(), "ack");
  assert.equal(sends, 1);
  assert.deepEqual(await rows(), [{ status: "sent", failure_code: null, rate_limit_retries: 0 }]);
});

// The stored fixture token expires within the alert window; the operations tests use a longer one.
async function longLivedToken() {
  await pool.query("UPDATE instagram_connections SET token_expires_at=now()+interval '30 days'");
}

test("cron recovers a committed reply after queue publish failure", async () => {
  await longLivedToken();
  const lines = logLines;
  const queue = env.REPLY_QUEUE;
  env.REPLY_QUEUE = {
    async send() {
      throw new Error("queue offline");
    },
  };
  const webhook = request();
  webhook.headers.set("cf-ray", "8c1f2e3d4b5a6978-ICN");
  assert.equal((await worker.fetch(webhook, env)).status, 200);
  assert.equal((await rows())[0].status, "pending");
  assert.deepEqual(lines, [
    { event: "queue_publish_failed", code: "reply_notification_failed", correlation_id: "8c1f2e3d4b5a6978-ICN" },
  ]);
  env.REPLY_QUEUE = queue;
  await worker.scheduled({}, env);
  assert.deepEqual(published, [{ connectionId }]);
  assert.equal(await consume(), "ack");
  assert.equal((await rows())[0].status, "sent");
  assert.equal(lines.length, 1);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT name FROM scheduled_steps WHERE last_success_at IS NOT NULL AND last_failure_at IS NULL ORDER BY name",
      )
    ).rows.map((row) => row.name),
    [
      "alerts",
      "cron",
      "early_reply_reconcile",
      "flow_resume",
      "kept_reply_cleanup",
      "stale_recovery",
      "token_refresh",
      "wake",
      "webhook_delivery",
    ],
  );
});

test("a database failure in one cron step is recorded and alerted once, other steps continue, and recovery clears it", async () => {
  await longLivedToken();
  const lines = logLines;
  const queue = env.REPLY_QUEUE;
  env.REPLY_QUEUE = {
    async send() {
      throw new Error("queue offline");
    },
  };
  assert.equal((await worker.fetch(request(), env)).status, 200);
  env.REPLY_QUEUE = queue;
  await pool.query("INSERT INTO scheduled_steps(name,last_success_at) VALUES('cron',now()-interval '6 minutes')");
  const originalQuery = Pool.prototype.query;
  const failing = mock.method(Pool.prototype, "query", async function (this: Pool, sql: string, values?: unknown[]) {
    if (typeof sql === "string" && sql.includes("FROM flow_runs") && sql.includes("resume_at<=now()"))
      throw Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
    return Reflect.apply(originalQuery, this, [sql, values]);
  });
  await assert.rejects(worker.scheduled({}, env), /scheduled recovery failed/);
  await assert.rejects(worker.scheduled({}, env), /scheduled recovery failed/);
  // The wake after the failed step still repaired the lost notification, on both runs.
  assert.deepEqual(published, [{ connectionId }, { connectionId }]);
  const failures = lines.filter((line) => line.event === "cron_step_failed");
  assert.equal(failures.length, 2);
  assert.deepEqual(
    failures.map(({ correlation_id, ...line }) => line),
    [
      { event: "cron_step_failed", code: "database_unavailable", step: "flow_resume" },
      { event: "cron_step_failed", code: "database_unavailable", step: "flow_resume" },
    ],
  );
  const started = lines.filter((line) => line.event === "alert_started");
  assert.deepEqual(
    started.map(({ correlation_id, ...line }) => line),
    [{ event: "alert_started", code: "alert_cron_stale" }],
  );
  assert.equal(started[0]!.correlation_id, failures[0]!.correlation_id);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT name,failure_code,last_success_at IS NOT NULL AS succeeded FROM scheduled_steps WHERE name IN ('flow_resume','wake','cron') ORDER BY name",
      )
    ).rows,
    [
      { name: "cron", failure_code: "step_failed", succeeded: true },
      { name: "flow_resume", failure_code: "database_unavailable", succeeded: false },
      { name: "wake", failure_code: null, succeeded: true },
    ],
  );
  failing.mock.restore();
  lines.length = 0;
  await worker.scheduled({}, env);
  assert.deepEqual(
    lines.map(({ correlation_id, ...line }) => line),
    [{ event: "alert_cleared", code: "alert_cron_stale" }],
  );
  assert.equal(
    (
      await pool.query(
        "SELECT last_success_at>last_failure_at AS recovered FROM scheduled_steps WHERE name='flow_resume'",
      )
    ).rows[0].recovered,
    true,
  );
});

test("a provider rate limit pauses the connection, and admins see the pause in operations health", async () => {
  await longLivedToken();
  await pool.query(
    "INSERT INTO workspace_members(user_id,workspace_id,role) VALUES('99999999-9999-4999-8999-999999999999','11111111-1111-4111-8111-111111111111','admin')",
  );
  const graphFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ error: { code: 4 } }, { status: 400 });
    return graphFetch(input, init);
  });
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal(await consume(), "ack");
  assert.deepEqual(await rows(), [{ status: "pending", failure_code: "meta_error_4", rate_limit_retries: 1 }]);
  const health = await operationsHealth(pool, { id: "99999999-9999-4999-8999-999999999999", email: "" }, true);
  const [connection] = health.connections;
  assert.ok(
    connection && connection.send_paused_until && Date.parse(connection.send_paused_until) > Date.now() + 14 * 60_000,
  );
  // The deferred reply is not due yet, so it is not counted as waiting in the queue.
  assert.equal(connection.oldest_due_pending_seconds, null);
  assert.deepEqual(connection.alerts, []);
  // A rate limit is an expected deferral: it writes no log line, so the Meta response cannot reach the logs.
  assert.deepEqual(logLines, []);
});

test("a failed alerts step fails the cron row, so the run is not recorded as a success", async () => {
  await longLivedToken();
  const originalQuery = Pool.prototype.query;
  mock.method(Pool.prototype, "query", async function (this: Pool, sql: string, values?: unknown[]) {
    if (typeof sql === "string" && sql.includes("WITH metrics AS"))
      throw Object.assign(new Error("metrics for owner@example.test"), { code: "42P01" });
    return Reflect.apply(originalQuery, this, [sql, values]);
  });
  await assert.rejects(worker.scheduled({}, env), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Cloudflare scheduled recovery failed");
    return true;
  });
  assert.deepEqual(
    logLines.map(({ correlation_id, ...line }) => line),
    [{ event: "cron_step_failed", code: "database_error", step: "alerts" }],
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT name,failure_code,last_success_at IS NOT NULL AS succeeded FROM scheduled_steps WHERE name IN ('alerts','cron','wake') ORDER BY name",
      )
    ).rows,
    [
      { name: "alerts", failure_code: "database_error", succeeded: false },
      { name: "cron", failure_code: "step_failed", succeeded: false },
      { name: "wake", failure_code: null, succeeded: true },
    ],
  );
});

test("a failed step record write is logged and fails the run, also for the final cron row", async () => {
  await longLivedToken();
  const originalQuery = Pool.prototype.query;
  let failingName = "wake";
  // A recent successful run keeps cron_stale off, so only the record failure is logged.
  await pool.query("INSERT INTO scheduled_steps(name,last_success_at) VALUES('cron',now())");
  // Fails every record write that carries the name: the run's batched write and the single-row retry.
  mock.method(Pool.prototype, "query", async function (this: Pool, sql: string, values?: unknown[]) {
    const names = values?.[0];
    if (
      typeof sql === "string" &&
      sql.includes("INTO scheduled_steps(name,last_") &&
      (Array.isArray(names) ? names.includes(failingName) : names === failingName)
    )
      throw Object.assign(new Error("record for owner@example.test"), { code: "08006" });
    return Reflect.apply(originalQuery, this, [sql, values]);
  });
  await assert.rejects(worker.scheduled({}, env), /^Error: Cloudflare scheduled recovery failed$/);
  assert.deepEqual(
    logLines.map(({ correlation_id, ...line }) => line),
    [{ event: "cron_step_record_failed", code: "database_unavailable", step: "wake" }],
  );
  // The step succeeded, but its outcome is not stored, so the run is not recorded as a success.
  assert.equal(
    (await pool.query("SELECT failure_code FROM scheduled_steps WHERE name='cron'")).rows[0].failure_code,
    "step_failed",
  );
  logLines.length = 0;
  failingName = "cron";
  await assert.rejects(worker.scheduled({}, env), /^Error: Cloudflare scheduled recovery failed$/);
  assert.deepEqual(
    logLines.map(({ correlation_id, ...line }) => line),
    [{ event: "cron_record_failed", code: "database_unavailable" }],
  );
});

test("a batched record write that fails once fails the run even when every row is then stored", async () => {
  await longLivedToken();
  const originalQuery = Pool.prototype.query;
  // A recent successful run keeps cron_stale off, so only the record failure is logged.
  await pool.query("INSERT INTO scheduled_steps(name,last_success_at) VALUES('cron',now())");
  let batches = 0;
  mock.method(Pool.prototype, "query", async function (this: Pool, sql: string, values?: unknown[]) {
    if (typeof sql === "string" && sql.includes("INTO scheduled_steps(name,last_") && Array.isArray(values?.[0])) {
      batches++;
      if (batches === 1) throw Object.assign(new Error("record for owner@example.test"), { code: "08006" });
    }
    return Reflect.apply(originalQuery, this, [sql, values]);
  });
  await assert.rejects(worker.scheduled({}, env), /^Error: Cloudflare scheduled recovery failed$/);
  assert.equal(batches, 2);
  // Every row of the failed statement is logged once, in step order, because no row's own retry failed.
  const steps = [
    "kept_reply_cleanup",
    "token_refresh",
    "early_reply_reconcile",
    "flow_resume",
    "stale_recovery",
    "wake",
    "webhook_delivery",
  ];
  assert.deepEqual(
    logLines.map(({ correlation_id, ...line }) => line),
    steps.map((step) => ({ event: "cron_step_record_failed", code: "database_unavailable", step })),
  );
  // The retry stored every step's success, but the run counts the failed write.
  const rows = (
    await pool.query<{ name: string; failure_code: string | null; succeeded: boolean }>(
      "SELECT name,failure_code,last_success_at IS NOT NULL AS succeeded FROM scheduled_steps WHERE name=ANY($1)",
      [[...steps, "alerts"]],
    )
  ).rows;
  assert.deepEqual(rows.map((row) => row.name).sort(), [...steps, "alerts"].sort());
  assert.ok(rows.every((row) => row.failure_code === null && row.succeeded));
  assert.equal(
    (await pool.query("SELECT failure_code FROM scheduled_steps WHERE name='cron'")).rows[0].failure_code,
    "step_failed",
  );
});

test("a pool that fails to close cannot put its raw error message into the cron failure", async () => {
  await longLivedToken();
  mock.method(Pool.prototype, "end", async () => {
    throw new Error("SENTINEL owner@example.test token");
  });
  await assert.rejects(worker.scheduled({}, env), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Cloudflare scheduled recovery failed");
    return true;
  });
  assert.deepEqual(
    logLines.map(({ correlation_id, ...line }) => line),
    [{ event: "cron_run_failed", code: "unexpected_error" }],
  );
});

// A flow run that stopped at a delay and is already due, as ingestion leaves it after the delay passes.
async function dueDelayedRun(): Promise<void> {
  const workspace = "11111111-1111-4111-8111-111111111111";
  const flow = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const version = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const definition = {
    schema_version: 1,
    nodes: [
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
      { id: "wait", type: "delay", config: { minutes: 30 } },
      { id: "reply", type: "instagram_message", config: { text: "Later link" } },
    ],
    edges: [
      { from: "start", port: "next", to: "wait" },
      { from: "wait", port: "next", to: "reply" },
    ],
  };
  await pool.query("INSERT INTO flows(id,workspace_id,name,draft) VALUES($1,$2,'Later','{}')", [flow, workspace]);
  await pool.query(
    `INSERT INTO flow_versions(id,flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,published_by)
     VALUES($1,$2,$3,1,0,$4,$5,'1789','99999999-9999-4999-8999-999999999999')`,
    [version, flow, workspace, JSON.stringify(definition), connectionId],
  );
  await pool.query("UPDATE flows SET published_version_id=$2,enabled=true WHERE id=$1", [flow, version]);
  const event = await pool.query<{ id: string }>(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     VALUES($1,$2,'comment-late','1789','sender-late','link') RETURNING id`,
    [workspace, connectionId],
  );
  await pool.query(
    `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,event_id,status,resume_at,resume_node_id)
     VALUES($1,$2,$3,$4,$5,'waiting',now()-interval '1 second','wait')`,
    [workspace, connectionId, flow, version, event.rows[0]!.id],
  );
}

test("cron resumes a due flow run while sending is off and sends its reply once sending is on", async () => {
  await dueDelayedRun();
  env.SEND_ENABLED = "false";
  await worker.scheduled({}, env);
  assert.equal((await pool.query("SELECT status FROM flow_runs")).rows[0].status, "delivering");
  assert.deepEqual(await rows(), [{ status: "pending", failure_code: null, rate_limit_retries: 0 }]);
  assert.deepEqual(published, []);
  assert.equal(sends, 0);

  env.SEND_ENABLED = "true";
  // Graph answers for the flow's numeric media and its commenter instead of the rule fixture's.
  restoreMocks();
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const graphUrl = new URL(String(input));
    if (init?.method === "POST") {
      sends++;
      return Response.json({ message_id: "message-late" });
    }
    if (graphUrl.pathname.endsWith("/me")) return Response.json({ user_id: "123" });
    if (graphUrl.pathname.endsWith("/1789")) return Response.json({ id: "1789", owner: { id: "123" } });
    return Response.json({
      id: graphUrl.pathname.split("/").at(-1),
      from: { id: "sender-late" },
      media: { id: "1789" },
      timestamp: new Date().toISOString(),
    });
  });
  await worker.scheduled({}, env);
  assert.deepEqual(published, [{ connectionId }]);
  assert.equal(await consume(), "ack");
  assert.equal(sends, 1);
  assert.deepEqual(await rows(), [{ status: "sent", failure_code: null, rate_limit_retries: 0 }]);
});

// Flow runs whose private reply was sent to DM recipient 456 (comment-ask) and 457 (comment-quiet)
// and which now wait for that person's reply; the quiet one's reply went out two hours ago.
async function awaitingReplyRuns(): Promise<void> {
  const workspace = "11111111-1111-4111-8111-111111111111";
  const flow = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const version = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const definition = {
    schema_version: 1,
    nodes: [
      {
        id: "start",
        type: "instagram_comment",
        config: {
          connection_id: connectionId,
          media_id: "1789",
          keywords: ["size"],
          match_mode: "contains",
          excluded_keywords: [],
        },
      },
      { id: "ask", type: "instagram_message", config: { text: "Which size?" } },
      { id: "wait", type: "wait_for_reply", config: { timeout_minutes: 60 } },
      { id: "answered", type: "add_tag", config: { tag: "answered" } },
      { id: "silent", type: "add_tag", config: { tag: "silent" } },
    ],
    edges: [
      { from: "start", port: "next", to: "ask" },
      { from: "ask", port: "next", to: "wait" },
      { from: "wait", port: "replied", to: "answered" },
      { from: "wait", port: "timeout", to: "silent" },
    ],
  };
  await pool.query("INSERT INTO flows(id,workspace_id,name,draft) VALUES($1,$2,'Ask','{}')", [flow, workspace]);
  await pool.query(
    `INSERT INTO flow_versions(id,flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,published_by)
     VALUES($1,$2,$3,1,0,$4,$5,'1789','99999999-9999-4999-8999-999999999999')`,
    [version, flow, workspace, JSON.stringify(definition), connectionId],
  );
  await pool.query("UPDATE flows SET published_version_id=$2,enabled=true WHERE id=$1", [flow, version]);
  for (const [comment, recipient, sentAgo] of [
    ["comment-ask", "456", "1 minute"],
    ["comment-quiet", "457", "2 hours"],
  ]) {
    const event = await pool.query<{ id: string }>(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,'1789',$4,'size') RETURNING id`,
      [workspace, connectionId, comment, `sender-${recipient}`],
    );
    const run = await pool.query<{ id: string }>(
      `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,event_id,status,resume_node_id)
       VALUES($1,$2,$3,$4,$5,'awaiting_reply','wait') RETURNING id`,
      [workspace, connectionId, flow, version, event.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,flow_run_id,comment_id,media_id,sender_id,private_reply_text,status,recipient_id,sent_at,provider_message_id)
       VALUES($1,$2,$3,$4,$5,'1789',$6,'Which size?','sent',$7,now()-$8::interval,$9)`,
      [
        workspace,
        connectionId,
        event.rows[0]!.id,
        run.rows[0]!.id,
        comment,
        `sender-${recipient}`,
        recipient,
        sentAgo,
        `m-${comment}`,
      ],
    );
  }
}

test("a webhook DM continues the run waiting for its reply and the cron times out the quiet one", async () => {
  await awaitingReplyRuns();
  const body = JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: "123",
        messaging: [
          {
            sender: { id: "456" },
            recipient: { id: "123" },
            timestamp: Date.now(),
            message: { mid: "dm-1", text: "XL" },
          },
          {
            sender: { id: "457" },
            recipient: { id: "123" },
            timestamp: Date.now(),
            message: { mid: "dm-2", text: "L" },
          },
        ],
      },
    ],
  });
  const dm = () =>
    new Request("https://example.test/webhooks/instagram", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", "test-secret").update(body).digest("hex") },
    });
  assert.equal((await worker.fetch(dm(), env)).status, 200);
  assert.equal((await worker.fetch(dm(), env)).status, 200);
  const state = async () =>
    (
      await pool.query(
        `SELECT reply.comment_id,run.status,array_agg(step.node_id||':'||step.outcome ORDER BY step.seq) FILTER (WHERE step.seq IS NOT NULL) AS steps
         FROM flow_runs run JOIN private_reply_outbox reply ON reply.flow_run_id=run.id
         LEFT JOIN flow_step_runs step ON step.run_id=run.id GROUP BY reply.comment_id,run.status ORDER BY reply.comment_id`,
      )
    ).rows;
  // 457's message came after its wait ended, so only 456's run continues.
  assert.deepEqual(await state(), [
    { comment_id: "comment-ask", status: "ended", steps: ["wait:replied", "answered:added"] },
    { comment_id: "comment-quiet", status: "awaiting_reply", steps: null },
  ]);
  env.SEND_ENABLED = "false";
  await worker.scheduled({}, env);
  assert.deepEqual(await state(), [
    { comment_id: "comment-ask", status: "ended", steps: ["wait:replied", "answered:added"] },
    { comment_id: "comment-quiet", status: "ended", steps: ["wait:timeout", "silent:added"] },
  ]);
  assert.equal(sends, 0);
});

test("the cron links a kept reply before it times out the wait that reply answered in time", async () => {
  await awaitingReplyRuns();
  // 457 answered while the reply was being sent, two hours ago, and only the cron can link it now.
  await pool.query(
    "UPDATE private_reply_outbox SET attempt_started_at=sent_at-interval '1 second' WHERE comment_id='comment-quiet'",
  );
  await pool.query(
    `INSERT INTO instagram_unmatched_replies(workspace_id,connection_id,sender_id,message_id,message_text,message_at)
     SELECT workspace_id,connection_id,'457','early-quiet','L',sent_at-interval '500 milliseconds'
     FROM private_reply_outbox WHERE comment_id='comment-quiet'`,
  );
  env.SEND_ENABLED = "false";
  await worker.scheduled({}, env);
  assert.deepEqual(
    (
      await pool.query(
        `SELECT run.status,array_agg(step.node_id||':'||step.outcome ORDER BY step.seq) AS steps
         FROM flow_runs run JOIN private_reply_outbox reply ON reply.flow_run_id=run.id
         JOIN flow_step_runs step ON step.run_id=run.id WHERE reply.comment_id='comment-quiet' GROUP BY run.status`,
      )
    ).rows,
    [{ status: "ended", steps: ["wait:replied", "answered:added"] }],
  );
  assert.equal(
    (await pool.query("SELECT matched_at IS NOT NULL AS matched FROM instagram_unmatched_replies")).rows[0].matched,
    true,
  );
});

test("a failed flow resume still lets the cron wake pending replies, then reports the failure", async () => {
  const queue = env.REPLY_QUEUE;
  env.REPLY_QUEUE = {
    async send() {
      throw new Error("queue offline");
    },
  };
  assert.equal((await worker.fetch(request(), env)).status, 200);
  env.REPLY_QUEUE = queue;
  const originalQuery = Pool.prototype.query;
  mock.method(Pool.prototype, "query", async function (this: Pool, sql: string, values?: unknown[]) {
    if (typeof sql === "string" && sql.includes("FROM flow_runs") && sql.includes("resume_at<=now()"))
      throw new Error("flow runs unavailable");
    return Reflect.apply(originalQuery, this, [sql, values]);
  });
  await assert.rejects(worker.scheduled({}, env), /scheduled recovery failed/);
  assert.deepEqual(published, [{ connectionId }]);
});

test("the cron links a kept DM to its sent reply and removes kept text after 15 minutes, with sending off", async () => {
  assert.equal((await worker.fetch(request(), env)).status, 200);
  await pool.query(
    "UPDATE private_reply_outbox SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now()-interval '1 minute'",
  );
  const at = new Date(Date.now() - 30_000);
  await ingestMessages(pool, [
    { accountId: "123", senderId: "7890", messageId: "early-confirm", text: "확인", timestamp: at },
    { accountId: "123", senderId: "7891", messageId: "old", text: "hello", timestamp: at },
  ]);
  await pool.query(
    "UPDATE instagram_unmatched_replies SET received_at=now()-interval '15 minutes' WHERE message_id='old'",
  );
  // The reply is recorded as sent elsewhere, without the reconcile that normally follows it.
  const reply = (
    await pool.query(
      "UPDATE private_reply_outbox SET status='sent',recipient_id='7890',provider_message_id='m',sent_at=now() RETURNING id",
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text) VALUES($1,$2,'7890','확인','링크','팔로우 안내')",
    [reply, connectionId],
  );
  env.SEND_ENABLED = "false";
  await worker.scheduled({}, env);
  assert.deepEqual((await pool.query("SELECT status,confirmed_at FROM instagram_follow_conversations")).rows, [
    { status: "pending", confirmed_at: at },
  ]);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT message_id,message_text,matched_at IS NOT NULL AS matched FROM instagram_unmatched_replies ORDER BY message_id",
      )
    ).rows,
    [
      { message_id: "early-confirm", message_text: "확인", matched: true },
      { message_id: "old", message_text: null, matched: false },
    ],
  );
  assert.equal(sends, 0);
});

test("disabled sending preserves pending replies and does not schedule work", async () => {
  env.SEND_ENABLED = "false";
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal(await consume(), "ack");
  await worker.scheduled({}, env);
  assert.equal((await rows())[0].status, "pending");
  assert.deepEqual(published, []);
  assert.equal(sends, 0);
});

test("foreign and malformed queue messages cannot claim work", async () => {
  await worker.fetch(request(), env);
  for (const body of [null, {}, { connectionId: "foreign" }]) assert.equal(await consume(body), "ack");
  assert.equal((await rows())[0].status, "pending");
  assert.equal(sends, 0);
});

test("cron respects future due time and connection pause, then wakes due work", async () => {
  await worker.fetch(request(), env);
  published = [];
  await pool.query("UPDATE private_reply_outbox SET next_attempt_at = now() + interval '1 hour'");
  await worker.scheduled({}, env);
  assert.deepEqual(published, []);
  await pool.query("UPDATE private_reply_outbox SET next_attempt_at = now() - interval '1 second'");
  await pool.query("UPDATE instagram_connections SET send_paused_until = now() + interval '1 hour'");
  await worker.scheduled({}, env);
  assert.deepEqual(published, []);
  await pool.query("UPDATE instagram_connections SET send_paused_until = NULL");
  await worker.scheduled({}, env);
  assert.deepEqual(published, [{ connectionId }]);
});

test("interrupted sends remain unknown on queue redelivery", async () => {
  await worker.fetch(request(), env);
  await pool.query(
    "UPDATE private_reply_outbox SET status='sending', attempt_id='44444444-4444-4444-8444-444444444444', attempt_started_at=now()-interval '11 minutes'",
  );
  published = [];
  await worker.scheduled({}, env);
  assert.equal((await rows())[0].status, "unknown");
  assert.equal(await consume(), "ack");
  assert.equal(sends, 0);
  assert.deepEqual(published, []);
});

test("DB failure retries the queue notification", async () => {
  env.HYPERDRIVE.connectionString = "postgres://postgres:test@127.0.0.1:1/automations_test";
  assert.equal(await consume(), "retry");
});

test("ambiguous send remains unknown, while a structured throttle defers the row", async () => {
  await worker.fetch(request(), env);
  const graphFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("socket closed after POST");
    return graphFetch(input, init);
  });
  assert.equal(await consume(), "ack");
  assert.equal((await rows())[0].status, "unknown");
  assert.equal(await consume(), "ack");
  assert.equal((await rows())[0].status, "unknown");
  await pool.query("UPDATE private_reply_outbox SET status='pending', attempt_id=NULL, attempt_started_at=NULL");
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ error: { code: 4 } }, { status: 400 });
    return graphFetch(input, init);
  });
  published = [];
  assert.equal(await consume(), "ack");
  assert.deepEqual(await rows(), [{ status: "pending", failure_code: "meta_error_4", rate_limit_retries: 1 }]);
  assert.deepEqual(published, []);
  assert.equal(
    (await pool.query("SELECT send_paused_until > now() AS paused FROM instagram_connections")).rows[0].paused,
    true,
  );
});

test("one notification processes only one row and wakes the remaining backlog", async () => {
  await worker.fetch(request(), env);
  await worker.fetch(request("comment-2", "sender-2"), env);
  published = [];
  assert.equal(await consume(), "ack");
  assert.deepEqual(
    (await rows()).map((row) => row.status),
    ["sent", "pending"],
  );
  assert.deepEqual(published, [{ connectionId }]);
});

test("Workers fetch refuses redirects without following a token-bearing request", async () => {
  await worker.fetch(request(), env);
  let requests = 0;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(new URL(String(input)).hostname, "graph.instagram.com");
    assert.equal(init?.redirect, "manual");
    requests++;
    return new Response(null, { status: 302, headers: { location: "https://untrusted.test" } });
  });
  assert.equal(await consume(), "ack");
  assert.deepEqual(await rows(), [{ status: "pending", failure_code: "verification_failed", rate_limit_retries: 0 }]);
  assert.equal(requests, 1);
});

test("oversized body is rejected before persistence even with no content-length", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/webhooks/instagram", {
      method: "POST",
      body: "x".repeat(1024 * 1024 + 1),
    }),
    env,
  );
  assert.equal(response.status, 413);
  assert.deepEqual(await rows(), []);
});

test("cron wakes a missed notification for an inactive connection so its reply becomes blocked", async () => {
  env.SEND_ENABLED = "false";
  assert.equal((await worker.fetch(request(), env)).status, 200);
  await pool.query("UPDATE instagram_connections SET active=false");
  env.SEND_ENABLED = "true";
  await worker.scheduled({}, env);
  assert.deepEqual(published, [{ connectionId }]);
  assert.equal(await consume(), "ack");
  assert.deepEqual(await rows(), [{ status: "blocked", failure_code: "inactive_connection", rate_limit_retries: 0 }]);
  assert.equal(sends, 0);
});

test("signed comment and confirmation webhooks complete the conditional DM flow once", async () => {
  await pool.query(
    "UPDATE instagram_comment_rules SET follow_gate_enabled=true,confirmation_keyword='확인',follower_reply_text='Final link',non_follower_reply_text='Follow and confirm again'",
  );
  let follows = false;
  const delivered: string[] = [];
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      delivered.push(body.message.text);
      return Response.json({ message_id: "message-" + delivered.length, recipient_id: "456" });
    }
    if (url.pathname.endsWith("/me")) return Response.json({ user_id: "123" });
    if (url.pathname.endsWith("/456")) return Response.json({ is_user_follow_business: follows });
    if (url.pathname.endsWith("/media-1")) return Response.json({ id: "media-1", owner: { id: "123" } });
    return Response.json({
      id: "comment-1",
      from: { id: "456" },
      media: { id: "media-1" },
      timestamp: new Date().toISOString(),
    });
  });
  await worker.fetch(request("comment-1", "456"), env);
  assert.equal(await consume(), "ack");
  assert.equal((await pool.query("SELECT status FROM instagram_follow_conversations")).rows[0].status, "waiting");
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '1 second'");
  const firstConfirmationAt = Date.now() - 200;
  const confirmation = (id: string) => {
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "123",
          messaging: [
            {
              sender: { id: "456" },
              recipient: { id: "123" },
              timestamp: firstConfirmationAt + (id === "confirm-1" ? 0 : 1),
              message: { mid: id, text: "확인" },
            },
          ],
        },
      ],
    });
    return new Request("https://example.test/webhooks/instagram", {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", "test-secret").update(body).digest("hex") },
    });
  };
  assert.equal((await worker.fetch(confirmation("confirm-1"), env)).status, 200);
  await consume();
  assert.equal((await pool.query("SELECT status FROM instagram_follow_conversations")).rows[0].status, "waiting");
  assert.deepEqual(delivered, ["reply", "Follow and confirm again"]);
  follows = true;
  await worker.fetch(confirmation("confirm-2"), env);
  await consume();
  await consume();
  assert.deepEqual(delivered, ["reply", "Follow and confirm again", "Final link"]);
  assert.equal((await pool.query("SELECT status FROM instagram_follow_conversations")).rows[0].status, "sent");
});

test("each connection uses its own encrypted token and send switch", async () => {
  const other = "44444444-4444-4444-8444-444444444444";
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,access_token_encrypted,token_expires_at) VALUES($1,'11111111-1111-4111-8111-111111111111','999',true,true,$2,now()+interval '1 day')",
    [other, sealSecret("other-token", env.TOKEN_ENCRYPTION_KEY!, "11111111-1111-4111-8111-111111111111:999")],
  );
  await pool.query(
    "INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled) VALUES('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111',$1,'other-media','hello','other reply',true)",
    [other],
  );
  const body = JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: "999",
        field: "comments",
        value: { id: "other-comment", from: { id: "777" }, media: { id: "other-media" }, text: "hello" },
      },
    ],
  });
  const signed = new Request("https://example.test/webhooks/instagram", {
    method: "POST",
    body,
    headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", "test-secret").update(body).digest("hex") },
  });
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer other-token");
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") {
      assert.ok(path.endsWith("/999/messages"));
      sends++;
      return Response.json({ message_id: "other-sent" });
    }
    if (path.endsWith("/me")) return Response.json({ user_id: "999" });
    if (path.endsWith("/other-media")) return Response.json({ id: "other-media", owner: { id: "999" } });
    return Response.json({
      id: "other-comment",
      from: { id: "777" },
      media: { id: "other-media" },
      timestamp: new Date().toISOString(),
    });
  });
  assert.equal((await worker.fetch(signed, env)).status, 200);
  assert.ok(published.some((value) => (value as { connectionId: string }).connectionId === other));
  await pool.query("UPDATE instagram_connections SET send_enabled=false WHERE id=$1", [other]);
  await consume({ connectionId: other });
  assert.equal(sends, 0);
  await pool.query("UPDATE instagram_connections SET send_enabled=true WHERE id=$1", [other]);
  await consume({ connectionId: other });
  assert.equal(sends, 1);
});

test("a successful first DM without recipient ID exposes a terminal follow failure and never resends", async () => {
  await pool.query(
    "UPDATE instagram_comment_rules SET follow_gate_enabled=true,follower_reply_text='Final',non_follower_reply_text='Follow'",
  );
  await worker.fetch(request(), env);
  await consume();
  await consume();
  assert.equal(sends, 1);
  assert.deepEqual((await rows())[0], {
    status: "sent",
    failure_code: "follow_recipient_unavailable",
    rate_limit_retries: 0,
  });
  assert.equal((await pool.query("SELECT count(*) FROM instagram_follow_conversations")).rows[0].count, "0");
});

test("consuming one account cannot multiply notifications for another due account", async () => {
  await worker.fetch(request(), env);
  await worker.fetch(request("comment-2", "sender-2"), env);
  const other = "44444444-4444-4444-8444-444444444444";
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,access_token_encrypted,token_expires_at)
    SELECT $1,workspace_id,'999',true,true,access_token_encrypted,token_expires_at FROM instagram_connections WHERE id=$2`,
    [other, connectionId],
  );
  await pool.query(
    `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled)
    VALUES ('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111',$1,'other-media','hello','reply',true)`,
    [other],
  );
  await pool.query(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
    VALUES ('11111111-1111-4111-8111-111111111111',$1,'other-comment','other-media','other-sender','hello')`,
    [other],
  );
  await pool.query(
    `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text)
    SELECT workspace_id,connection_id,id,'55555555-5555-4555-8555-555555555555',comment_id,media_id,sender_id,'reply' FROM instagram_comment_events WHERE connection_id=$1`,
    [other],
  );
  published = [];
  assert.equal(await consume(), "ack");
  assert.deepEqual(published, [{ connectionId }]);
  published = [];
  await worker.fetch(request("comment-3", "sender-3"), env);
  assert.deepEqual(published, [{ connectionId }]);
  published = [];
  await worker.scheduled({}, env);
  assert.deepEqual(published, [{ connectionId }, { connectionId: other }]);
});

async function pauseSender(sender = "sender-1") {
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) SELECT workspace_id,id,$2,true FROM instagram_connections WHERE id=$1 ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET paused=true",
    [connectionId, sender],
  );
}
test("Cloudflare cron and queue exclude paused contacts while another contact can send", async () => {
  await worker.fetch(request(), env);
  await pauseSender();
  published = [];
  await worker.scheduled({}, env);
  assert.deepEqual(published, []);
  await consume();
  assert.equal(sends, 0);
  assert.equal((await rows())[0].status, "pending");
  const providerFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) =>
    new URL(String(input)).pathname.endsWith("/comment-2")
      ? Response.json({
          id: "comment-2",
          from: { id: "sender-2" },
          media: { id: "media-1" },
          timestamp: new Date().toISOString(),
        })
      : providerFetch(input, init),
  );
  await worker.fetch(request("comment-2", "sender-2"), env);
  await consume();
  assert.equal(sends, 1);
});

test("Cloudflare private final POST guard sees a pause during second verification", async () => {
  let mediaReads = 0;
  const providerFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method !== "POST" && new URL(String(input)).pathname.endsWith("/media-1") && ++mediaReads === 2)
      await pauseSender();
    return providerFetch(input, init);
  });
  await worker.fetch(request(), env);
  await consume();
  assert.equal(mediaReads, 2);
  assert.equal(sends, 0);
  assert.equal((await rows())[0].status, "pending");
  assert.equal((await rows())[0].failure_code, "contact_paused");
  await pool.query("UPDATE instagram_contact_automation SET paused=false");
  await pool.query("UPDATE private_reply_outbox SET next_attempt_at=now()");
  await consume();
  assert.equal(sends, 1);
});

test("Cloudflare private final POST guard retries after an Instagram token rotation", async () => {
  let mediaReads = 0;
  const providerFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method !== "POST" && new URL(String(input)).pathname.endsWith("/media-1") && ++mediaReads === 2)
      await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [
        connectionId,
        sealSecret("rotated-token", env.TOKEN_ENCRYPTION_KEY!, "11111111-1111-4111-8111-111111111111:123"),
      ]);
    return providerFetch(input, init);
  });
  await worker.fetch(request(), env);
  await consume();
  assert.equal(sends, 0);
  assert.deepEqual((await rows())[0], { status: "pending", failure_code: "token_rotated", rate_limit_retries: 0 });
  await pool.query("UPDATE private_reply_outbox SET next_attempt_at=now()");
  await consume();
  assert.equal(sends, 1);
});

test("Cloudflare verification retries when a rotated old token is rejected by Meta", async () => {
  const providerFetch = globalThis.fetch;
  let rotated = false;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (!rotated && init?.method !== "POST" && new URL(String(input)).pathname.endsWith("/me")) {
      rotated = true;
      await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [
        connectionId,
        sealSecret("rotated-token", env.TOKEN_ENCRYPTION_KEY!, "11111111-1111-4111-8111-111111111111:123"),
      ]);
      return Response.json({ error: { code: 190 } }, { status: 400 });
    }
    return providerFetch(input, init);
  });
  await worker.fetch(request(), env);
  await consume();
  assert.equal(sends, 0);
  assert.equal((await rows())[0].status, "pending");
  await pool.query("UPDATE private_reply_outbox SET next_attempt_at=now()");
  await consume();
  assert.equal(sends, 1);
});

test("Cloudflare retries a definite POST rejection after token rotation", async () => {
  const providerFetch = globalThis.fetch;
  let rejected = false;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (!rejected && init?.method === "POST") {
      rejected = true;
      sends++;
      await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [
        connectionId,
        sealSecret("rotated-token", env.TOKEN_ENCRYPTION_KEY!, "11111111-1111-4111-8111-111111111111:123"),
      ]);
      return Response.json({ error: { code: 190 } }, { status: 400 });
    }
    return providerFetch(input, init);
  });
  await worker.fetch(request(), env);
  await consume();
  assert.equal(sends, 1);
  assert.deepEqual((await rows())[0], { status: "pending", failure_code: "token_rotated", rate_limit_retries: 0 });
  await pool.query("UPDATE private_reply_outbox SET next_attempt_at=now()");
  await consume();
  assert.equal(sends, 2);
  assert.equal((await rows())[0].status, "sent");
});

test("Cloudflare preserves Meta throttle backoff when a token rotates during POST", async () => {
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      sends++;
      await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [
        connectionId,
        sealSecret("rotated-token", env.TOKEN_ENCRYPTION_KEY!, "11111111-1111-4111-8111-111111111111:123"),
      ]);
      return Response.json({ error: { code: 4 } }, { status: 400 });
    }
    const graphUrl = new URL(String(input));
    if (graphUrl.pathname.endsWith("/me")) return Response.json({ user_id: "123" });
    if (graphUrl.pathname.endsWith("/media-1")) return Response.json({ id: "media-1", owner: { id: "123" } });
    return Response.json({
      id: "comment-1",
      from: { id: "sender-1" },
      media: { id: "media-1" },
      timestamp: new Date().toISOString(),
    });
  });
  await worker.fetch(request(), env);
  await consume();
  assert.equal(sends, 1);
  assert.deepEqual((await rows())[0], { status: "pending", failure_code: "meta_error_4", rate_limit_retries: 1 });
  assert.equal(
    (
      await pool.query("SELECT send_paused_until>now() AS paused FROM instagram_connections WHERE id=$1", [
        connectionId,
      ])
    ).rows[0].paused,
    true,
  );
});

test("Cloudflare does not retry an ambiguous POST failure after token rotation", async () => {
  let postCount = 0;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      postCount++;
      await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [
        connectionId,
        sealSecret("rotated-token", env.TOKEN_ENCRYPTION_KEY!, "11111111-1111-4111-8111-111111111111:123"),
      ]);
      return Response.json({ error: { code: 190 } }, { status: 503 });
    }
    if (new URL(String(input)).pathname.endsWith("/me")) return Response.json({ user_id: "123" });
    if (new URL(String(input)).pathname.endsWith("/media-1"))
      return Response.json({ id: "media-1", owner: { id: "123" } });
    return Response.json({
      id: "comment-1",
      from: { id: "sender-1" },
      media: { id: "media-1" },
      timestamp: new Date().toISOString(),
    });
  });
  await worker.fetch(request(), env);
  await consume();
  assert.equal(postCount, 1);
  assert.equal((await rows())[0].status, "unknown");
});

test("Cloudflare keeps a transient 4xx POST outcome unknown after token rotation", async () => {
  let postCount = 0;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      postCount++;
      await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [
        connectionId,
        sealSecret("rotated-token", env.TOKEN_ENCRYPTION_KEY!, "11111111-1111-4111-8111-111111111111:123"),
      ]);
      return Response.json({ error: { code: 2, is_transient: true } }, { status: 400 });
    }
    const graphUrl = new URL(String(input));
    if (graphUrl.pathname.endsWith("/me")) return Response.json({ user_id: "123" });
    if (graphUrl.pathname.endsWith("/media-1")) return Response.json({ id: "media-1", owner: { id: "123" } });
    return Response.json({
      id: "comment-1",
      from: { id: "sender-1" },
      media: { id: "media-1" },
      timestamp: new Date().toISOString(),
    });
  });
  await worker.fetch(request(), env);
  await consume();
  assert.equal(postCount, 1);
  assert.equal((await rows())[0].status, "unknown");
});

test("Cloudflare follow final guard defers a pause after worker permissions", async () => {
  await pool.query(
    "UPDATE instagram_comment_rules SET follow_gate_enabled=true,confirmation_keyword='확인',follower_reply_text='Final',non_follower_reply_text='Follow'",
  );
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") {
      sends++;
      return Response.json({ message_id: "sent-" + sends, recipient_id: "456" });
    }
    if (path.endsWith("/me")) return Response.json({ user_id: "123" });
    if (path.endsWith("/456")) return Response.json({ is_user_follow_business: true });
    if (path.endsWith("/media-1")) return Response.json({ id: "media-1", owner: { id: "123" } });
    return Response.json({
      id: "comment-1",
      from: { id: "456" },
      media: { id: "media-1" },
      timestamp: new Date().toISOString(),
    });
  });
  await worker.fetch(request("comment-1", "456"), env);
  await consume();
  assert.equal(sends, 1);
  // Keep the arrival after the PostgreSQL send timestamp despite JS millisecond precision.
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '1 second'");
  await ingestMessages(pool, [
    { accountId: "123", senderId: "456", messageId: "confirm", text: "확인", timestamp: new Date() },
  ]);
  assert.equal((await pool.query("SELECT status FROM instagram_follow_conversations")).rows[0].status, "pending");
  let finalChecks = 0;
  const originalQuery = Pool.prototype.query;
  mock.method(Pool.prototype, "query", async function (this: Pool, sql: string, values?: unknown[]) {
    if (sql.includes("flow.confirmed_at>now()-interval '24 hours'") && sql.includes("c.access_token_encrypted=$4")) {
      finalChecks++;
      await pauseSender("456");
    }
    return Reflect.apply(originalQuery, this, [sql, values]);
  });
  await consume();
  assert.equal(finalChecks, 1);
  assert.equal(sends, 1);
  const flow = (await pool.query("SELECT status,failure_code FROM instagram_follow_conversations")).rows[0];
  assert.deepEqual(flow, { status: "pending", failure_code: "contact_paused" });
  published = [];
  await worker.scheduled({}, env);
  assert.deepEqual(published, []);
});

async function handoffSender(sender = "sender-1") {
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,handoff_paused) SELECT workspace_id,id,$2,true FROM instagram_connections WHERE id=$1",
    [connectionId, sender],
  );
}
test("Cloudflare handoff excludes cron wake and queue claims", async () => {
  await worker.fetch(request(), env);
  await handoffSender();
  published = [];
  await worker.scheduled({}, env);
  assert.deepEqual(published, []);
  await consume();
  assert.equal(sends, 0);
  assert.equal((await rows())[0].status, "pending");
});
test("Cloudflare handoff committed during verification prevents private final POST", async () => {
  let mediaReads = 0;
  const providerFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method !== "POST" && new URL(String(input)).pathname.endsWith("/media-1") && ++mediaReads === 2)
      await handoffSender();
    return providerFetch(input, init);
  });
  await worker.fetch(request(), env);
  await consume();
  assert.equal(mediaReads, 2);
  assert.equal(sends, 0);
  assert.equal((await rows())[0].failure_code, "contact_paused");
});
test("Cloudflare handoff committed after follow permissions prevents final POST", async () => {
  await pool.query(
    "UPDATE instagram_comment_rules SET follow_gate_enabled=true,confirmation_keyword='확인',follower_reply_text='Final',non_follower_reply_text='Follow'",
  );
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") {
      sends++;
      return Response.json({ message_id: "sent-" + sends, recipient_id: "456" });
    }
    if (path.endsWith("/me")) return Response.json({ user_id: "123" });
    if (path.endsWith("/456")) return Response.json({ is_user_follow_business: true });
    if (path.endsWith("/media-1")) return Response.json({ id: "media-1", owner: { id: "123" } });
    return Response.json({
      id: "comment-1",
      from: { id: "456" },
      media: { id: "media-1" },
      timestamp: new Date().toISOString(),
    });
  });
  await worker.fetch(request("comment-1", "456"), env);
  await consume();
  assert.equal(sends, 1);
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '1 second'");
  await ingestMessages(pool, [
    { accountId: "123", senderId: "456", messageId: "handoff-confirm", text: "확인", timestamp: new Date() },
  ]);
  assert.equal((await pool.query("SELECT status FROM instagram_follow_conversations")).rows[0].status, "pending");
  const originalQuery = Pool.prototype.query;
  let finalChecks = 0;
  mock.method(Pool.prototype, "query", async function (this: Pool, sql: string, values?: unknown[]) {
    if (sql.includes("flow.confirmed_at>now()-interval '24 hours'") && sql.includes("c.access_token_encrypted=$4")) {
      finalChecks++;
      await handoffSender("456");
    }
    return Reflect.apply(originalQuery, this, [sql, values]);
  });
  await consume();
  assert.equal(finalChecks, 1);
  assert.equal(sends, 1);
  assert.equal(
    (await pool.query("SELECT failure_code FROM instagram_follow_conversations")).rows[0].failure_code,
    "contact_paused",
  );
});

async function manualFixture() {
  const user = { id: "44444444-4444-4444-8444-444444444444", email: "operator@example.test" };
  await pool.query(
    "INSERT INTO workspace_members(user_id,workspace_id) VALUES($1,'11111111-1111-4111-8111-111111111111')",
    [user.id],
  );
  assert.equal((await worker.fetch(request("manual-comment", "888"), env)).status, 200);
  await pool.query(
    "UPDATE private_reply_outbox SET status='sent',recipient_id='456',provider_message_id='bridge',sent_at=now()-interval '1 second'; UPDATE instagram_connections SET inbox_enabled=true,inbox_enabled_at=now()-interval '1 hour'",
  );
  await ingestMessages(pool, [
    {
      accountId: "123",
      senderId: "456",
      messageId: "manual-inbound",
      text: "Please help",
      timestamp: new Date(Date.now() - 500),
    },
  ]);
  const { saveInboxHandoff } = await import("../app/inbox-handoff.ts");
  await saveInboxHandoff(pool, user, connectionId, "456", new URLSearchParams(), { active: true, expected_version: 0 });
  const { queueManualReply } = await import("../app/manual-replies.ts");
  const reply = await queueManualReply(
    pool,
    user,
    connectionId,
    "456",
    new URLSearchParams(),
    { request_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: "Manual response", expected_handoff_version: 1 },
    true,
  );
  return { user, reply };
}

test("Cloudflare opt-out final guards block private follow and manual POST", async () => {
  const { user } = await manualFixture();
  let manualPosts = 0;
  let manualRevokeRecorded = false;
  mock.method(globalThis, "fetch", async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      manualPosts++;
      return Response.json({ message_id: "must-not-send" });
    }
    if (!manualRevokeRecorded) {
      await recordConsent("dm_recipient", "456", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      manualRevokeRecorded = true;
    }
    return Response.json({ user_id: "123" });
  });
  assert.equal(await consume(), "ack");
  assert.equal(manualRevokeRecorded, true);
  assert.equal(manualPosts, 0);
  assert.deepEqual(
    (await pool.query("SELECT status,failure_code,safe_to_retry FROM instagram_manual_replies")).rows[0],
    { status: "failed", failure_code: "recipient_opted_out", safe_to_retry: false },
  );
  const { queueManualReply } = await import("../app/manual-replies.ts");
  await assert.rejects(
    queueManualReply(
      pool,
      user,
      connectionId,
      "456",
      new URLSearchParams(),
      { request_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", text: "Blocked", expected_handoff_version: 1 },
      true,
    ),
    (error: unknown) => error instanceof Error && error.message === "recipient_opted_out",
  );

  restoreMocks();
  published = [];
  sends = 0;
  await resetStoredFixture();
  const bridgeEvent = (
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES('11111111-1111-4111-8111-111111111111',$1,'prior-bridge','prior-media','sender-1','hello') RETURNING id",
      [connectionId],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text,status,recipient_id,provider_message_id,sent_at) VALUES('11111111-1111-4111-8111-111111111111',$1,$2,'33333333-3333-4333-8333-333333333333','prior-bridge','prior-media','sender-1','reply','sent','777','prior-ack',now()-interval '1 minute')",
    [connectionId, bridgeEvent],
  );
  let privateMediaReads = 0;
  let privatePosts = 0;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const graphUrl = new URL(String(input));
    if (init?.method === "POST") {
      privatePosts++;
      return Response.json({ message_id: "must-not-send" });
    }
    if (graphUrl.pathname.endsWith("/me")) return Response.json({ user_id: "123" });
    if (graphUrl.pathname.endsWith("/media-1")) {
      privateMediaReads++;
      if (privateMediaReads === 2) await recordConsent("dm_recipient", "777", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
      return Response.json({ id: "media-1", owner: { id: "123" } });
    }
    return Response.json({
      id: graphUrl.pathname.split("/").at(-1),
      from: { id: "sender-1" },
      media: { id: "media-1" },
      timestamp: new Date().toISOString(),
    });
  });
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal(await consume(), "ack");
  assert.equal(privateMediaReads, 2);
  assert.equal(privatePosts, 0);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT status,failure_code,rate_limit_retries FROM private_reply_outbox WHERE comment_id='comment-1'",
      )
    ).rows[0],
    { status: "blocked", failure_code: "recipient_opted_out", rate_limit_retries: 0 },
  );

  restoreMocks();
  published = [];
  sends = 0;
  await resetStoredFixture();
  await pool.query(
    "UPDATE instagram_comment_rules SET follow_gate_enabled=true,confirmation_keyword='확인',follower_reply_text='Final',non_follower_reply_text='Follow'",
  );
  let followPosts = 0;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const graphUrl = new URL(String(input));
    if (init?.method === "POST") {
      followPosts++;
      return Response.json({ message_id: `follow-${followPosts}`, recipient_id: "456" });
    }
    if (graphUrl.pathname.endsWith("/me")) return Response.json({ user_id: "123" });
    if (graphUrl.pathname.endsWith("/456")) return Response.json({ is_user_follow_business: true });
    if (graphUrl.pathname.endsWith("/media-1")) return Response.json({ id: "media-1", owner: { id: "123" } });
    return Response.json({
      id: graphUrl.pathname.split("/").at(-1),
      from: { id: "456" },
      media: { id: "media-1" },
      timestamp: new Date().toISOString(),
    });
  });
  assert.equal((await worker.fetch(request("follow-race", "456"), env)).status, 200);
  assert.equal(await consume(), "ack");
  assert.equal(followPosts, 1);
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '1 second'");
  await ingestMessages(pool, [
    { accountId: "123", senderId: "456", messageId: "follow-confirm", text: "확인", timestamp: new Date() },
  ]);
  const originalQuery = Pool.prototype.query;
  let followRevokeRecorded = false;
  mock.method(Pool.prototype, "query", async function (this: Pool, sql: string, values?: unknown[]) {
    if (
      !followRevokeRecorded &&
      sql.includes("flow.confirmed_at>now()-interval '24 hours'") &&
      sql.includes("c.access_token_encrypted=$4")
    ) {
      await recordConsent("dm_recipient", "456", "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
      followRevokeRecorded = true;
    }
    return Reflect.apply(originalQuery, this, [sql, values]);
  });
  followPosts = 0;
  assert.equal(await consume(), "ack");
  assert.equal(followRevokeRecorded, true);
  assert.equal(followPosts, 0);
  assert.deepEqual((await pool.query("SELECT status,failure_code FROM instagram_follow_conversations")).rows[0], {
    status: "blocked",
    failure_code: "recipient_opted_out",
  });
});

test("Cloudflare consent read failures defer private follow and manual before POST", async () => {
  assert.equal((await worker.fetch(request("private-consent-fault"), env)).status, 200);
  const privateConsentReads = failConsentRead(3);
  assert.equal(await consume(), "ack");
  assert.equal(privateConsentReads(), 3);
  assert.equal(sends, 0);
  assert.deepEqual((await rows())[0], {
    status: "pending",
    failure_code: "consent_unavailable",
    rate_limit_retries: 0,
  });

  restoreMocks();
  published = [];
  sends = 0;
  await resetStoredFixture();
  await pool.query(
    "UPDATE instagram_comment_rules SET follow_gate_enabled=true,confirmation_keyword='확인',follower_reply_text='Final',non_follower_reply_text='Follow'",
  );
  let followPosts = 0;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const graphUrl = new URL(String(input));
    if (init?.method === "POST") {
      followPosts++;
      return Response.json({ message_id: `follow-fault-${followPosts}`, recipient_id: "456" });
    }
    if (graphUrl.pathname.endsWith("/me")) return Response.json({ user_id: "123" });
    if (graphUrl.pathname.endsWith("/456")) return Response.json({ is_user_follow_business: true });
    if (graphUrl.pathname.endsWith("/media-1")) return Response.json({ id: "media-1", owner: { id: "123" } });
    return Response.json({
      id: graphUrl.pathname.split("/").at(-1),
      from: { id: "456" },
      media: { id: "media-1" },
      timestamp: new Date().toISOString(),
    });
  });
  assert.equal((await worker.fetch(request("follow-consent-fault", "456"), env)).status, 200);
  assert.equal(await consume(), "ack");
  assert.equal(followPosts, 1);
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '1 second'");
  await ingestMessages(pool, [
    { accountId: "123", senderId: "456", messageId: "follow-fault-confirm", text: "확인", timestamp: new Date() },
  ]);
  followPosts = 0;
  const followConsentReads = failConsentRead(3);
  assert.equal(await consume(), "ack");
  assert.equal(followConsentReads(), 3);
  assert.equal(followPosts, 0);
  assert.deepEqual(
    (await pool.query("SELECT status,failure_code,attempt_id FROM instagram_follow_conversations")).rows[0],
    { status: "pending", failure_code: "consent_unavailable", attempt_id: null },
  );

  restoreMocks();
  published = [];
  sends = 0;
  await resetStoredFixture();
  mockDefaultGraphFetch();
  await manualFixture();
  let manualPosts = 0;
  mock.method(globalThis, "fetch", async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      manualPosts++;
      return Response.json({ message_id: "must-not-send" });
    }
    return Response.json({ user_id: "123" });
  });
  const manualConsentReads = failConsentRead(3);
  assert.equal(await consume(), "ack");
  assert.equal(manualConsentReads(), 3);
  assert.equal(manualPosts, 0);
  assert.deepEqual(
    (await pool.query("SELECT status,failure_code,safe_to_retry FROM instagram_manual_replies")).rows[0],
    { status: "pending", failure_code: "consent_unavailable", safe_to_retry: false },
  );
});

test("manual queued reply wakes on cron and duplicate queue messages send once", async () => {
  await manualFixture();
  published = [];
  await worker.scheduled(null, env);
  assert.deepEqual(published, [{ connectionId }]);
  assert.equal(await consume(), "ack");
  assert.equal(await consume(), "ack");
  assert.equal(sends, 1);
  assert.deepEqual((await pool.query("SELECT status,provider_message_id FROM instagram_manual_replies")).rows, [
    { status: "sent", provider_message_id: "message-1" },
  ]);
});

test("manual POST guard rejects token rotation handoff resume expiry and receive stop after verification", async () => {
  for (const change of [
    "access_token_encrypted='rotated'",
    "active=false",
    "inbox_enabled=false",
    "token_expires_at=now()-interval '1 second'",
    "handoff",
  ]) {
    await pool.query("TRUNCATE workspaces CASCADE");
    await pool.query(
      "INSERT INTO workspaces VALUES ('11111111-1111-4111-8111-111111111111'); INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,token_expires_at,access_token_encrypted) VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','123',true,true,now()+interval '1 day','unused'); INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled) VALUES('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','media-1','hello','reply',true)",
    );
    await pool.query("UPDATE instagram_connections SET access_token_encrypted=$1", [
      sealSecret("synthetic", env.TOKEN_ENCRYPTION_KEY!, "11111111-1111-4111-8111-111111111111:123"),
    ]);
    await manualFixture();
    let posts = 0;
    mock.method(globalThis, "fetch", async (_input: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts++;
        return Response.json({ message_id: "forbidden" });
      }
      await pool.query(
        change === "handoff"
          ? "UPDATE instagram_inbox_handoffs SET active=false"
          : `UPDATE instagram_connections SET ${change}`,
      );
      return Response.json({ user_id: "123" });
    });
    assert.equal(await consume(), "ack");
    assert.equal(posts, 0);
    assert.equal(
      (await pool.query("SELECT status FROM instagram_manual_replies")).rows[0].status,
      change === "access_token_encrypted='rotated'" ? "pending" : "failed",
    );
  }
});

test("manual Meta throttle refusal is audited failed without retry and shares cooldown", async () => {
  await manualFixture();
  mock.method(globalThis, "fetch", async (_input: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === "POST") {
      sends++;
      return Response.json({ error: { code: 4 } }, { status: 400 });
    }
    return Response.json({ user_id: "123" });
  });
  assert.equal(await consume(), "ack");
  assert.equal(await consume(), "ack");
  assert.equal(sends, 1);
  assert.deepEqual((await pool.query("SELECT status,safe_to_retry,failure_code FROM instagram_manual_replies")).rows, [
    { status: "failed", safe_to_retry: true, failure_code: "meta_error_4" },
  ]);
  assert.equal(
    (await pool.query("SELECT send_paused_until>now() AS paused FROM instagram_connections")).rows[0].paused,
    true,
  );
});

for (const [label, change] of [
  ["send disabled", "send_enabled=false"],
  ["expired token", "token_expires_at=now()-interval '1 second'"],
  ["missing token", "access_token_encrypted=NULL"],
])
  test(`manual cron repairs lost notification after ${label} without Graph requests`, async () => {
    await manualFixture();
    published = [];
    await pool.query("UPDATE instagram_connections SET token_expires_at=now()+interval '60 days'");
    await pool.query(`UPDATE instagram_connections SET ${change}`);
    let graphRequests = 0;
    mock.method(globalThis, "fetch", async () => {
      graphRequests++;
      throw new Error("must not reach Graph");
    });
    await worker.scheduled(null, env);
    assert.deepEqual(published, [{ connectionId }]);
    assert.equal(await consume(), "ack");
    assert.equal(graphRequests, 0);
    assert.equal((await pool.query("SELECT status FROM instagram_manual_replies")).rows[0].status, "failed");
    assert.equal(
      (await pool.query("SELECT count(*) FROM instagram_manual_reply_events WHERE kind='failed'")).rows[0].count,
      "1",
    );
  });

// A flow run that reached a webhook node: one delivery is queued for an active endpoint with one signing key.
async function queuedWebhook(): Promise<{ eventId: string; keyId: string; secret: string }> {
  const workspace = "11111111-1111-4111-8111-111111111111";
  const flow = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const version = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const endpoint = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const keyId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const eventId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const secret = "whsec_cron-test";
  await pool.query("INSERT INTO flows(id,workspace_id,name,draft) VALUES($1,$2,'Notify','{}')", [flow, workspace]);
  await pool.query(
    `INSERT INTO flow_versions(id,flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,published_by)
     VALUES($1,$2,$3,1,0,'{}',$4,'1789','99999999-9999-4999-8999-999999999999')`,
    [version, flow, workspace, connectionId],
  );
  const event = await pool.query<{ id: string }>(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     VALUES($1,$2,'comment-hook','1789','sender-hook','link') RETURNING id`,
    [workspace, connectionId],
  );
  const run = await pool.query<{ id: string }>(
    `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,event_id,status)
     VALUES($1,$2,$3,$4,$5,'ended') RETURNING id`,
    [workspace, connectionId, flow, version, event.rows[0]!.id],
  );
  await pool.query(
    "INSERT INTO webhook_endpoints(id,workspace_id,name,url) VALUES($1,$2,'crm','https://hooks.example.test/in')",
    [endpoint, workspace],
  );
  await pool.query(
    "INSERT INTO webhook_signing_keys(id,workspace_id,endpoint_id,slot,secret_encrypted) VALUES($1,$2,$3,1,$4)",
    [
      keyId,
      workspace,
      endpoint,
      sealSecret(secret, env.TOKEN_ENCRYPTION_KEY!, signingKeyContext(workspace, endpoint, keyId)),
    ],
  );
  await pool.query(
    `INSERT INTO webhook_deliveries(event_id,workspace_id,endpoint_id,connection_id,flow_id,flow_run_id,node_id,sender_id,payload)
     VALUES($1,$2,$3,$4,$5,$6,'notify','sender-hook',$7)`,
    [
      eventId,
      workspace,
      endpoint,
      connectionId,
      flow,
      run.rows[0]!.id,
      JSON.stringify({ event_id: eventId, fields: {} }),
    ],
  );
  return { eventId, keyId, secret };
}

// Answers the DNS-over-HTTPS lookups with a public address and hands webhook requests to the test.
function mockWebhookFetch(answer: (init: RequestInit) => Response | Promise<Response>) {
  const graphFetch = globalThis.fetch;
  const hosts: string[] = [];
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const target = new URL(String(input));
    if (target.hostname === "graph.instagram.com") return graphFetch(input, init);
    hosts.push(target.hostname);
    if (target.hostname === "cloudflare-dns.com")
      return Response.json(
        target.searchParams.get("type") === "A"
          ? { Status: 0, Answer: [{ name: "hooks.example.test", type: 1, data: "93.184.216.34" }] }
          : { Status: 0 },
      );
    assert.equal(target.href, "https://hooks.example.test/in");
    return answer(init ?? {});
  });
  return hosts;
}

test("the cron delivers a queued flow webhook after the message steps, and only while sending is on", async () => {
  await longLivedToken();
  const webhook = await queuedWebhook();
  // A reply whose queue notification was lost, so the wake step has work in the same run.
  assert.equal((await worker.fetch(request(), env)).status, 200);
  published = [];
  let received: RequestInit | undefined;
  let publishedBeforeWebhook: unknown[] = [];
  const hosts = mockWebhookFetch((init) => {
    received = init;
    publishedBeforeWebhook = [...published];
    return new Response("ok");
  });

  env.SEND_ENABLED = "false";
  await worker.scheduled({}, env);
  assert.deepEqual(hosts, []);
  assert.equal((await pool.query("SELECT status FROM webhook_deliveries")).rows[0].status, "pending");
  assert.equal(
    (await pool.query("SELECT count(*) FROM scheduled_steps WHERE name='webhook_delivery'")).rows[0].count,
    "0",
  );

  env.SEND_ENABLED = "true";
  await worker.scheduled({}, env);
  assert.deepEqual(hosts, ["cloudflare-dns.com", "cloudflare-dns.com", "hooks.example.test"]);
  // The wake had already published the reply notification when the webhook request left.
  assert.deepEqual(publishedBeforeWebhook, [{ connectionId }]);
  assert.equal(received!.method, "POST");
  assert.equal(received!.redirect, "manual");
  const headers = new Headers(received!.headers);
  assert.equal(headers.get("x-autochatter-event-id"), webhook.eventId);
  const [timestamp, key, signature] = headers.get("x-autochatter-signature")!.split(",");
  assert.equal(key, `k=${webhook.keyId}`);
  assert.equal(
    signature,
    `v1=${createHmac("sha256", webhook.secret)
      .update(`${timestamp!.slice(2)}.${String(received!.body)}`)
      .digest("hex")}`,
  );
  assert.deepEqual((await pool.query("SELECT status,payload,last_status_code FROM webhook_deliveries")).rows, [
    { status: "sent", payload: null, last_status_code: 200 },
  ]);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT failure_code,last_success_at IS NOT NULL AS succeeded FROM scheduled_steps WHERE name='webhook_delivery'",
      )
    ).rows,
    [{ failure_code: null, succeeded: true }],
  );
  assert.equal(sends, 0);
  assert.deepEqual(logLines, []);
});

test("token refresh and webhook delivery share one subrequest budget per cron invocation", async () => {
  await longLivedToken();
  // Ten connections whose tokens are due, so token refresh makes two Graph calls for each of them.
  for (let index = 0; index < 10; index++) {
    const account = `refresh-${index}`;
    await pool.query(
      `INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at,token_obtained_at)
       VALUES($1,'11111111-1111-4111-8111-111111111111',$2,true,$3,now()+interval '20 days',now()-interval '2 days')`,
      [
        crypto.randomUUID(),
        account,
        sealSecret(`token-${account}`, env.TOKEN_ENCRYPTION_KEY!, `11111111-1111-4111-8111-111111111111:${account}`),
      ],
    );
  }
  await queuedWebhook();
  await pool.query(
    `INSERT INTO webhook_deliveries(event_id,workspace_id,endpoint_id,connection_id,flow_id,flow_run_id,node_id,sender_id,payload)
     SELECT gen_random_uuid(),workspace_id,endpoint_id,connection_id,flow_id,flow_run_id,'notify-'||n,sender_id,payload
     FROM webhook_deliveries, generate_series(1,9) n`,
  );
  restoreMocks();
  let calls = 0;
  mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    calls++;
    const target = new URL(String(input));
    if (target.pathname === "/refresh_access_token")
      return Response.json({ access_token: target.searchParams.get("access_token"), expires_in: 5_184_000 });
    if (target.hostname === "graph.instagram.com")
      return Response.json({
        user_id: new Headers(init?.headers).get("authorization")!.replace("Bearer token-", ""),
      });
    if (target.hostname === "cloudflare-dns.com")
      return Response.json(
        target.searchParams.get("type") === "A"
          ? { Status: 0, Answer: [{ name: "hooks.example.test", type: 1, data: "93.184.216.34" }] }
          : { Status: 0 },
      );
    return new Response("ok");
  });
  await worker.scheduled({}, env);
  // 20 refresh calls leave 25 of the 45: eight attempts of three subrequests, and no claim for the ninth.
  assert.equal(calls, 20 + 8 * 3);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT status,attempt_count,count(*)::int AS count FROM webhook_deliveries GROUP BY status,attempt_count ORDER BY status",
      )
    ).rows,
    [
      { status: "pending", attempt_count: 0, count: 2 },
      { status: "sent", attempt_count: 1, count: 8 },
    ],
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM instagram_connections WHERE account_id LIKE 'refresh-%' AND token_obtained_at>now()-interval '1 minute'",
      )
    ).rows[0].count,
    10,
  );
});

test("a failing webhook endpoint or delivery step neither stops nor fails the message steps", async () => {
  await longLivedToken();
  await queuedWebhook();
  await pool.query("INSERT INTO scheduled_steps(name,last_success_at) VALUES('cron',now())");
  assert.equal((await worker.fetch(request(), env)).status, 200);
  published = [];
  mockWebhookFetch(() => {
    throw new Error("connection refused by https://hooks.example.test/in");
  });
  // An endpoint failure is a delivery outcome, not a step failure: the run succeeds and the reply is woken.
  await worker.scheduled({}, env);
  assert.deepEqual(published, [{ connectionId }]);
  assert.deepEqual((await pool.query("SELECT status,failure_code,attempt_count FROM webhook_deliveries")).rows, [
    { status: "retry", failure_code: "request_failed", attempt_count: 1 },
  ]);
  assert.deepEqual(
    logLines.map(({ correlation_id, ...line }) => line),
    [{ event: "webhook_delivery_failed", code: "request_failed", connection_id: connectionId }],
  );
  assert.deepEqual(await rows(), [{ status: "pending", failure_code: null, rate_limit_retries: 0 }]);

  // A database failure inside the delivery step fails that step only; wake ran before it and is recorded.
  logLines.length = 0;
  published = [];
  await pool.query("UPDATE webhook_deliveries SET next_attempt_at=now()-interval '1 second'");
  const originalQuery = Pool.prototype.query;
  mock.method(Pool.prototype, "query", async function (this: Pool, sql: string, values?: unknown[]) {
    if (typeof sql === "string" && sql.includes("UPDATE webhook_deliveries"))
      throw Object.assign(new Error("deliveries for https://hooks.example.test/in"), { code: "42P01" });
    return Reflect.apply(originalQuery, this, [sql, values]);
  });
  await assert.rejects(worker.scheduled({}, env), /^Error: Cloudflare scheduled recovery failed$/);
  assert.deepEqual(published, [{ connectionId }]);
  assert.deepEqual(
    logLines.map(({ correlation_id, ...line }) => line),
    [{ event: "cron_step_failed", code: "database_error", step: "webhook_delivery" }],
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT name,failure_code,last_success_at>last_failure_at AS recovered FROM scheduled_steps WHERE name IN ('wake','webhook_delivery') ORDER BY name",
      )
    ).rows,
    [
      { name: "wake", failure_code: null, recovered: null },
      { name: "webhook_delivery", failure_code: "database_error", recovered: false },
    ],
  );
  assert.equal(await consume(), "ack");
  assert.equal((await rows())[0].status, "sent");
});
