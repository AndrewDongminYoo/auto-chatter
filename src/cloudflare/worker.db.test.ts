import { ingestMessages } from "../instagram/follow-flow.ts";
import { sealSecret } from "../app/secrets.ts";
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
    "DROP TABLE IF EXISTS instagram_contact_automation, instagram_contact_field_values, instagram_contact_fields, instagram_contact_segments, instagram_contact_tags, instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
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
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
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
    "UPDATE instagram_connections SET send_enabled=true,token_expires_at=now()+interval '1 day',access_token_encrypted=$1",
    [sealSecret("synthetic", Buffer.alloc(32, 1).toString("base64"), "11111111-1111-4111-8111-111111111111:123")],
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
              timestamp: Date.now(),
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
  await ingestMessages(pool, [
    { accountId: "123", senderId: "456", messageId: "confirm", text: "확인", timestamp: new Date() },
  ]);
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
