import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { ingestComments } from "./store.ts";
import { processNextPrivateReply, recoverStalePrivateReplies, runPrivateReplyWorker, type PrivateReplyTransport } from "./reply-worker.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) {
  throw new Error("Database tests require a local automations_test database");
}

const pool = new Pool({ connectionString: databaseUrl });
const workspaceId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const ruleId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-09-25T00:00:00.000Z");

const verified: PrivateReplyTransport["verify"] = async () => ({
  commentCreatedAt: new Date("2026-09-24T00:00:00.000Z"),
  authorizationVerified: true,
  mediaOwned: true,
});

async function queueReply(): Promise<void> {
  await ingestComments(pool, [{
    accountId: "account-1",
    commentId: "comment-1",
    postId: "post-1",
    senderId: "sender-1",
    text: "자료 부탁해요",
  }]);
}

async function outbox(): Promise<{ status: string; provider_message_id: string | null; failure_code: string | null; next_attempt_at: Date }> {
  const result = await pool.query<{ status: string; provider_message_id: string | null; failure_code: string | null; next_attempt_at: Date }>(
    "SELECT status, provider_message_id, failure_code, next_attempt_at FROM private_reply_outbox",
  );
  return result.rows[0]!;
}

before(async () => {
  await pool.query("DROP TABLE IF EXISTS private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE");
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspaceId]);
  await pool.query("INSERT INTO instagram_connections (id, workspace_id, account_id, active) VALUES ($1, $2, $3, true)", [connectionId, workspaceId, "account-1"]);
  await pool.query("INSERT INTO instagram_comment_rules (id, workspace_id, connection_id, media_id, keyword, private_reply_text, enabled) VALUES ($1, $2, $3, $4, $5, $6, true)", [ruleId, workspaceId, connectionId, "post-1", "자료", "자료 링크입니다"]);
});

after(async () => {
  await pool.end();
});

test("two workers claim one reply and record one provider message", async () => {
  await queueReply();
  let sends = 0;
  const transport: PrivateReplyTransport = {
    verify: verified,
    send: async (request) => {
      sends++;
      assert.equal(request.commentId, "comment-1");
      assert.equal(request.text, "자료 링크입니다");
      return { messageId: "mid-1" };
    },
  };
  const results = await Promise.all([
    processNextPrivateReply(pool, transport, () => now),
    processNextPrivateReply(pool, transport, () => now),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(sends, 1);
  assert.equal((await outbox()).status, "sent");
  assert.equal((await outbox()).provider_message_id, "mid-1");
});

test("an expired comment is blocked before the send callback", async () => {
  await queueReply();
  let sends = 0;
  await processNextPrivateReply(pool, {
    verify: async () => ({ commentCreatedAt: new Date("2026-09-18T00:00:00.000Z"), authorizationVerified: true, mediaOwned: true }),
    send: async () => { sends++; return { messageId: "unexpected" }; },
  }, () => now);
  assert.equal(sends, 0);
  assert.equal((await outbox()).status, "blocked");
  assert.equal((await outbox()).failure_code, "comment_expired");
});

test("an inactive connection is blocked even with otherwise valid metadata", async () => {
  await queueReply();
  await pool.query("UPDATE instagram_connections SET active = false WHERE id = $1", [connectionId]);
  let sends = 0;
  await processNextPrivateReply(pool, {
    verify: verified,
    send: async () => { sends++; return { messageId: "unexpected" }; },
  }, () => now);
  assert.equal(sends, 0);
  assert.equal((await outbox()).failure_code, "inactive_connection");
});

test("unverified Meta authorization blocks the send callback", async () => {
  await queueReply();
  let sends = 0;
  await processNextPrivateReply(pool, {
    verify: async () => ({ commentCreatedAt: new Date("2026-09-24T00:00:00.000Z"), authorizationVerified: false, mediaOwned: true }),
    send: async () => { sends++; return { messageId: "unexpected" }; },
  }, () => now);
  assert.equal(sends, 0);
  assert.equal((await outbox()).failure_code, "authorization_unverified");
});

test("the account's own comment cannot trigger a private reply", async () => {
  await ingestComments(pool, [{ accountId: "account-1", commentId: "comment-1", postId: "post-1", senderId: "account-1", text: "자료" }]);
  let sends = 0;
  await processNextPrivateReply(pool, {
    verify: verified,
    send: async () => { sends++; return { messageId: "unexpected" }; },
  }, () => now);
  assert.equal(sends, 0);
  assert.equal((await outbox()).failure_code, "own_comment");
});

test("a failed read-only verification returns the job to pending with a delay", async () => {
  await queueReply();
  let sends = 0;
  await processNextPrivateReply(pool, {
    verify: async () => { throw new Error("temporary lookup failure"); },
    send: async () => { sends++; return { messageId: "unexpected" }; },
  }, () => now);
  const result = await outbox();
  assert.equal(sends, 0);
  assert.equal(result.status, "pending");
  assert.equal(result.failure_code, "verification_failed");
  assert.ok(result.next_attempt_at.getTime() > Date.now());
});

test("an uncertain send is never automatically retried", async () => {
  await queueReply();
  let sends = 0;
  const transport: PrivateReplyTransport = {
    verify: verified,
    send: async () => { sends++; throw new Error("connection lost after request"); },
  };
  assert.equal(await processNextPrivateReply(pool, transport, () => now), true);
  assert.equal((await outbox()).status, "unknown");
  assert.equal((await outbox()).failure_code, "send_outcome_unknown");
  assert.equal(await processNextPrivateReply(pool, transport, () => now), false);
  assert.equal(sends, 1);
});

test("stale in-flight work becomes unknown rather than pending", async () => {
  await queueReply();
  await pool.query(
    "UPDATE private_reply_outbox SET status = 'sending', attempt_id = $1, attempt_started_at = now() - interval '10 minutes'",
    ["77777777-7777-4777-8777-777777777777"],
  );
  assert.equal(await recoverStalePrivateReplies(pool, new Date(Date.now() - 5 * 60_000)), 1);
  assert.equal((await outbox()).status, "unknown");
  assert.equal((await outbox()).failure_code, "worker_interrupted");
});

test("the worker loop processes a job and stops when cancelled", async () => {
  await queueReply();
  const controller = new AbortController();
  let sends = 0;
  await runPrivateReplyWorker(pool, {
    verify: verified,
    send: async () => {
      sends++;
      controller.abort();
      return { messageId: "mid-loop" };
    },
  }, controller.signal, 10);
  assert.equal(sends, 1);
  assert.equal((await outbox()).status, "sent");
});

test("a connection-scoped worker leaves another connection's reply pending", async () => {
  const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
  const otherConnectionId = "55555555-5555-4555-8555-555555555555";
  const otherRuleId = "66666666-6666-4666-8666-666666666666";
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [otherWorkspaceId]);
  await pool.query("INSERT INTO instagram_connections (id, workspace_id, account_id, active) VALUES ($1, $2, $3, true)", [otherConnectionId, otherWorkspaceId, "account-2"]);
  await pool.query("INSERT INTO instagram_comment_rules (id, workspace_id, connection_id, media_id, keyword, private_reply_text, enabled) VALUES ($1, $2, $3, $4, $5, $6, true)", [otherRuleId, otherWorkspaceId, otherConnectionId, "post-2", "자료", "다른 계정 답장"]);
  await ingestComments(pool, [{ accountId: "account-2", commentId: "comment-2", postId: "post-2", senderId: "sender-2", text: "자료" }]);
  await queueReply();

  const sentConnectionIds: string[] = [];
  await processNextPrivateReply(pool, {
    verify: verified,
    send: async (request) => {
      sentConnectionIds.push(request.connectionId);
      return { messageId: "mid-scoped" };
    },
  }, () => now, connectionId);

  assert.deepEqual(sentConnectionIds, [connectionId]);
  const rows = await pool.query<{ connection_id: string; status: string }>("SELECT connection_id, status FROM private_reply_outbox ORDER BY connection_id");
  assert.deepEqual(rows.rows, [
    { connection_id: connectionId, status: "sent" },
    { connection_id: otherConnectionId, status: "pending" },
  ]);

  await pool.query(
    "UPDATE private_reply_outbox SET status = 'sending', attempt_id = $1, attempt_started_at = now() - interval '10 minutes' WHERE connection_id = $2",
    ["77777777-7777-4777-8777-777777777777", otherConnectionId],
  );
  assert.equal(await recoverStalePrivateReplies(pool, new Date(Date.now() - 5 * 60_000), connectionId), 0);
  const other = await pool.query<{ status: string }>("SELECT status FROM private_reply_outbox WHERE connection_id = $1", [otherConnectionId]);
  assert.equal(other.rows[0]?.status, "sending");
});
