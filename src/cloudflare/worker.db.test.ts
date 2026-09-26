import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, mock, test } from "node:test";
import { Pool } from "pg";
import worker, { type Env } from "./index.ts";

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

before(async () => {
  await pool.query(
    "DROP TABLE IF EXISTS private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
  );
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  mock.restoreAll();
  published = [];
  sends = 0;
  env = {
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
  };
  await pool.query(
    "TRUNCATE private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
  );
  await pool.query("INSERT INTO workspaces VALUES ('11111111-1111-4111-8111-111111111111')");
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active) VALUES ($1,'11111111-1111-4111-8111-111111111111','123',true)",
    [connectionId],
  );
  await pool.query(
    "INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled) VALUES ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',$1,'media-1','hello','reply',true)",
    [connectionId],
  );
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

test("duplicate webhook and queue delivery send one persisted reply", async () => {
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.deepEqual(published, [{ connectionId }, { connectionId }]);
  assert.equal(await consume(), "ack");
  assert.equal(await consume(), "ack");
  assert.equal(sends, 1);
  assert.deepEqual(await rows(), [{ status: "sent", failure_code: null, rate_limit_retries: 0 }]);
});

test("cron recovers a committed reply after queue publish failure", async () => {
  const queue = env.REPLY_QUEUE;
  env.REPLY_QUEUE = {
    async send() {
      throw new Error("queue offline");
    },
  };
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal((await rows())[0].status, "pending");
  env.REPLY_QUEUE = queue;
  await worker.scheduled({}, env);
  assert.deepEqual(published, [{ connectionId }]);
  assert.equal(await consume(), "ack");
  assert.equal((await rows())[0].status, "sent");
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
