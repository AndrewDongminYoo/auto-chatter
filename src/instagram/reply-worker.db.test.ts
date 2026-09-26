import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { ingestComments } from "./store.ts";
import {
  PreSendVerificationError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  processNextPrivateReply,
  recoverStalePrivateReplies,
  runPrivateReplyWorker,
  type PrivateReplyTransport,
} from "./reply-worker.ts";

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
  await ingestComments(pool, [
    {
      accountId: "account-1",
      commentId: "comment-1",
      postId: "post-1",
      senderId: "sender-1",
      text: "자료 부탁해요",
    },
  ]);
}

async function outbox(): Promise<{
  status: string;
  provider_message_id: string | null;
  failure_code: string | null;
  next_attempt_at: Date;
}> {
  const result = await pool.query<{
    status: string;
    provider_message_id: string | null;
    failure_code: string | null;
    next_attempt_at: Date;
  }>("SELECT status, provider_message_id, failure_code, next_attempt_at FROM private_reply_outbox");
  return result.rows[0]!;
}

before(async () => {
  await pool.query(
    "DROP TABLE IF EXISTS instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
  );
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
  );
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspaceId]);
  await pool.query(
    "INSERT INTO instagram_connections (id, workspace_id, account_id, active) VALUES ($1, $2, $3, true)",
    [connectionId, workspaceId, "account-1"],
  );
  await pool.query(
    "INSERT INTO instagram_comment_rules (id, workspace_id, connection_id, media_id, keyword, private_reply_text, enabled) VALUES ($1, $2, $3, $4, $5, $6, true)",
    [ruleId, workspaceId, connectionId, "post-1", "자료", "자료 링크입니다"],
  );
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
    processNextPrivateReply(pool, transport, () => now, connectionId),
    processNextPrivateReply(pool, transport, () => now, connectionId),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(sends, 1);
  assert.equal((await outbox()).status, "sent");
  assert.equal((await outbox()).provider_message_id, "mid-1");
});

test("an expired comment is blocked before the send callback", async () => {
  await queueReply();
  let sends = 0;
  await processNextPrivateReply(
    pool,
    {
      verify: async () => ({
        commentCreatedAt: new Date("2026-09-18T00:00:00.000Z"),
        authorizationVerified: true,
        mediaOwned: true,
      }),
      send: async () => {
        sends++;
        return { messageId: "unexpected" };
      },
    },
    () => now,
    connectionId,
  );
  assert.equal(sends, 0);
  assert.equal((await outbox()).status, "blocked");
  assert.equal((await outbox()).failure_code, "comment_expired");
});

test("an inactive connection is blocked even with otherwise valid metadata", async () => {
  await queueReply();
  await pool.query("UPDATE instagram_connections SET active = false WHERE id = $1", [connectionId]);
  let sends = 0;
  await processNextPrivateReply(
    pool,
    {
      verify: verified,
      send: async () => {
        sends++;
        return { messageId: "unexpected" };
      },
    },
    () => now,
    connectionId,
  );
  assert.equal(sends, 0);
  assert.equal((await outbox()).failure_code, "inactive_connection");
});

test("unverified Meta authorization blocks the send callback", async () => {
  await queueReply();
  let sends = 0;
  await processNextPrivateReply(
    pool,
    {
      verify: async () => ({
        commentCreatedAt: new Date("2026-09-24T00:00:00.000Z"),
        authorizationVerified: false,
        mediaOwned: true,
      }),
      send: async () => {
        sends++;
        return { messageId: "unexpected" };
      },
    },
    () => now,
    connectionId,
  );
  assert.equal(sends, 0);
  assert.equal((await outbox()).failure_code, "authorization_unverified");
});

test("the account's own comment cannot trigger a private reply", async () => {
  await ingestComments(pool, [
    { accountId: "account-1", commentId: "comment-1", postId: "post-1", senderId: "account-1", text: "자료" },
  ]);
  let sends = 0;
  await processNextPrivateReply(
    pool,
    {
      verify: verified,
      send: async () => {
        sends++;
        return { messageId: "unexpected" };
      },
    },
    () => now,
    connectionId,
  );
  assert.equal(sends, 0);
  assert.equal((await outbox()).failure_code, "own_comment");
});

test("a verified scoped account's own comment is blocked without calling send", async () => {
  await queueReply();
  let sends = 0;
  await processNextPrivateReply(
    pool,
    {
      verify: async () => ({
        commentCreatedAt: new Date("2026-09-24T00:00:00.000Z"),
        authorizationVerified: true,
        mediaOwned: true,
        isOwnComment: true,
      }),
      send: async () => {
        sends++;
        return { messageId: "unexpected" };
      },
    },
    () => now,
    connectionId,
  );
  assert.equal(sends, 0);
  assert.equal((await outbox()).failure_code, "own_comment");
});

test("a failed read-only verification returns the job to pending with a delay", async () => {
  await queueReply();
  let sends = 0;
  await processNextPrivateReply(
    pool,
    {
      verify: async () => {
        throw new Error("temporary lookup failure");
      },
      send: async () => {
        sends++;
        return { messageId: "unexpected" };
      },
    },
    () => now,
    connectionId,
  );
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
    send: async () => {
      sends++;
      throw new Error("connection lost after request");
    },
  };
  assert.equal(await processNextPrivateReply(pool, transport, () => now, connectionId), true);
  assert.equal((await outbox()).status, "unknown");
  assert.equal((await outbox()).failure_code, "send_outcome_unknown");
  assert.equal(await processNextPrivateReply(pool, transport, () => now, connectionId), false);
  assert.equal(sends, 1);
});

test("a definite provider rejection is failed with its Meta code and not retried", async () => {
  await queueReply();
  let sends = 0;
  const transport: PrivateReplyTransport = {
    verify: verified,
    send: async () => {
      sends++;
      throw new ProviderRejectedError(100);
    },
  };
  assert.equal(await processNextPrivateReply(pool, transport, () => now, connectionId), true);
  assert.equal((await outbox()).status, "failed");
  assert.equal((await outbox()).failure_code, "meta_error_100");
  assert.equal(await processNextPrivateReply(pool, transport, () => now, connectionId), false);
  assert.equal(sends, 1);
});

async function rateLimitState(senderId = "sender-1"): Promise<{
  status: string;
  failure_code: string | null;
  rate_limit_retries: number;
  delay_seconds: number;
  pause_seconds: number | null;
}> {
  const result = await pool.query<{
    status: string;
    failure_code: string | null;
    rate_limit_retries: number;
    delay_seconds: number;
    pause_seconds: number | null;
  }>(
    `SELECT reply.status, reply.failure_code, reply.rate_limit_retries,
       extract(epoch FROM reply.next_attempt_at - now())::float AS delay_seconds,
       extract(epoch FROM connection.send_paused_until - now())::float AS pause_seconds
     FROM private_reply_outbox AS reply
     JOIN instagram_connections AS connection ON connection.id = reply.connection_id
     WHERE reply.sender_id = $1`,
    [senderId],
  );
  return result.rows[0]!;
}

function assertAbout(actual: number | null, expected: number): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < 60, `expected about ${expected}s, got ${actual}`);
}

async function elapseRateLimit(): Promise<void> {
  await pool.query("UPDATE private_reply_outbox SET next_attempt_at = now() - interval '1 second'");
  await pool.query("UPDATE instagram_connections SET send_paused_until = now() - interval '1 second'");
}

function rateLimitedTransport(
  codes: readonly number[],
  retryAfterSeconds: number | null = null,
): PrivateReplyTransport & { sends: () => number } {
  let sends = 0;
  return {
    verify: verified,
    send: async () => {
      const code = codes[Math.min(sends, codes.length - 1)]!;
      sends++;
      throw new ProviderRateLimitedError(code, retryAfterSeconds);
    },
    sends: () => sends,
  };
}

test("a rate-limited send returns to pending after the first backoff and pauses the connection", async () => {
  await queueReply();
  const transport = rateLimitedTransport([4]);
  assert.equal(await processNextPrivateReply(pool, transport, () => now, connectionId), true);
  const state = await rateLimitState();
  assert.equal(state.status, "pending");
  assert.equal(state.failure_code, "meta_error_4");
  assert.equal(state.rate_limit_retries, 1);
  assertAbout(state.delay_seconds, 15 * 60);
  assertAbout(state.pause_seconds, 15 * 60);
  assert.equal(await processNextPrivateReply(pool, transport, () => now, connectionId), false);
  assert.equal(transport.sends(), 1);
});

test("a longer Retry-After replaces the backoff and a shorter one is ignored", async () => {
  for (const [retryAfterSeconds, expected] of [
    [7200, 7200],
    [60, 15 * 60],
  ] as const) {
    await pool.query("TRUNCATE private_reply_outbox, instagram_comment_events CASCADE");
    await pool.query("UPDATE instagram_connections SET send_paused_until = NULL");
    await queueReply();
    await processNextPrivateReply(pool, rateLimitedTransport([17], retryAfterSeconds), () => now, connectionId);
    const state = await rateLimitState();
    assertAbout(state.delay_seconds, expected);
    assertAbout(state.pause_seconds, expected);
  }
});

test("rate-limit retries follow the backoff tiers and then fail with the last Meta code", async () => {
  await queueReply();
  const transport = rateLimitedTransport([4, 17, 32, 613]);
  for (const [retries, delay] of [
    [1, 15 * 60],
    [2, 60 * 60],
    [3, 4 * 60 * 60],
  ] as const) {
    assert.equal(await processNextPrivateReply(pool, transport, () => now, connectionId), true);
    const state = await rateLimitState();
    assert.equal(state.status, "pending");
    assert.equal(state.rate_limit_retries, retries);
    assertAbout(state.delay_seconds, delay);
    await elapseRateLimit();
  }
  assert.equal(await processNextPrivateReply(pool, transport, () => now, connectionId), true);
  const state = await rateLimitState();
  assert.equal(state.status, "failed");
  assert.equal(state.failure_code, "meta_error_613");
  assert.equal(state.rate_limit_retries, 3);
  assertAbout(state.pause_seconds, 4 * 60 * 60);

  await elapseRateLimit();
  assert.equal(await processNextPrivateReply(pool, transport, () => now, connectionId), false);
  assert.equal(transport.sends(), 4);
});

test("a paused connection holds its other replies, including ones queued during the pause", async () => {
  await queueReply();
  await processNextPrivateReply(pool, rateLimitedTransport([4]), () => now, connectionId);
  await ingestComments(pool, [
    { accountId: "account-1", commentId: "comment-2", postId: "post-1", senderId: "sender-2", text: "자료 주세요" },
  ]);
  let sends = 0;
  const transport: PrivateReplyTransport = {
    verify: verified,
    send: async () => {
      sends++;
      return { messageId: "mid-2" };
    },
  };
  assert.equal(await processNextPrivateReply(pool, transport, () => now, connectionId), false);
  assert.equal(sends, 0);
  assert.equal((await rateLimitState("sender-2")).status, "pending");

  await pool.query("UPDATE instagram_connections SET send_paused_until = now() - interval '1 second'");
  assert.equal(await processNextPrivateReply(pool, transport, () => now, connectionId), true);
  assert.equal(sends, 1);
  assert.equal((await rateLimitState("sender-2")).status, "sent");
  assert.equal((await rateLimitState("sender-1")).status, "pending");
});

test("a rate-limited reply is re-verified and blocked once its comment has expired", async () => {
  await queueReply();
  const limited = rateLimitedTransport([4]);
  await processNextPrivateReply(pool, limited, () => now, connectionId);
  await elapseRateLimit();
  let sends = 0;
  let verifications = 0;
  await processNextPrivateReply(
    pool,
    {
      verify: async () => {
        verifications++;
        return {
          commentCreatedAt: new Date("2026-09-17T00:00:00.000Z"),
          authorizationVerified: true,
          mediaOwned: true,
        };
      },
      send: async () => {
        sends++;
        return { messageId: "unexpected" };
      },
    },
    () => now,
    connectionId,
  );
  assert.equal(verifications, 1);
  assert.equal(sends, 0);
  assert.equal((await outbox()).status, "blocked");
  assert.equal((await outbox()).failure_code, "comment_expired");
  assert.equal(limited.sends(), 1);
});

test("a connection pause during verification defers an already claimed reply without spending a retry", async () => {
  await queueReply();
  let releaseVerification!: () => void;
  let signalVerification!: () => void;
  const verificationStarted = new Promise<void>((resolve) => {
    signalVerification = resolve;
  });
  const verificationReleased = new Promise<void>((resolve) => {
    releaseVerification = resolve;
  });
  let sends = 0;
  const waitingWorker = processNextPrivateReply(
    pool,
    {
      verify: async (request) => {
        signalVerification();
        await verificationReleased;
        return verified(request);
      },
      send: async () => {
        sends++;
        return { messageId: "unexpected" };
      },
    },
    () => now,
    connectionId,
  );
  try {
    await verificationStarted;
    await ingestComments(pool, [
      { accountId: "account-1", commentId: "comment-2", postId: "post-1", senderId: "sender-2", text: "자료 주세요" },
    ]);
    assert.equal(await processNextPrivateReply(pool, rateLimitedTransport([4]), () => now, connectionId), true);
  } finally {
    releaseVerification();
    await waitingWorker;
  }
  assert.equal(sends, 0);
  const state = await rateLimitState();
  assert.equal(state.status, "pending");
  assert.equal(state.failure_code, "connection_paused");
  assert.equal(state.rate_limit_retries, 0);
  assertAbout(state.delay_seconds, 15 * 60);
  const attempt = await pool.query(
    "SELECT attempt_id, attempt_started_at FROM private_reply_outbox WHERE sender_id = 'sender-1'",
  );
  assert.deepEqual(attempt.rows[0], { attempt_id: null, attempt_started_at: null });
});

test("rate-limit migration preserves existing replies and retry state when reapplied", async () => {
  await queueReply();
  const migration = await readFile(new URL("../../db/migrations/002_rate_limit_backoff.sql", import.meta.url), "utf8");
  await pool.query("ALTER TABLE instagram_connections DROP COLUMN send_paused_until");
  await pool.query("ALTER TABLE private_reply_outbox DROP COLUMN rate_limit_retries");
  try {
    await pool.query(migration);
    assert.equal((await rateLimitState()).rate_limit_retries, 0);
    assert.equal((await rateLimitState()).status, "pending");
    await processNextPrivateReply(pool, rateLimitedTransport([4]), () => now, connectionId);
    await pool.query(migration);
    const state = await rateLimitState();
    assert.equal(state.rate_limit_retries, 1);
    assert.equal(state.failure_code, "meta_error_4");
    assertAbout(state.pause_seconds, 15 * 60);
    assert.equal(await processNextPrivateReply(pool, rateLimitedTransport([4]), () => now, connectionId), false);
  } finally {
    await pool.query(migration);
  }
});

test("invalid reply input is blocked before a provider POST", async () => {
  await queueReply();
  await processNextPrivateReply(
    pool,
    {
      verify: verified,
      send: async () => {
        throw new PreSendVerificationError("block", "invalid_request");
      },
    },
    () => now,
    connectionId,
  );
  assert.equal((await outbox()).status, "blocked");
  assert.equal((await outbox()).failure_code, "invalid_request");
});

test("a failed read-only check inside send returns to pending before a POST", async () => {
  await queueReply();
  await processNextPrivateReply(
    pool,
    {
      verify: verified,
      send: async () => {
        throw new PreSendVerificationError();
      },
    },
    () => now,
    connectionId,
  );
  const result = await outbox();
  assert.equal(result.status, "pending");
  assert.equal(result.failure_code, "verification_failed");
  assert.ok(result.next_attempt_at.getTime() > Date.now());
});

test("stale in-flight work becomes unknown rather than pending", async () => {
  await queueReply();
  await pool.query(
    "UPDATE private_reply_outbox SET status = 'sending', attempt_id = $1, attempt_started_at = now() - interval '10 minutes'",
    ["77777777-7777-4777-8777-777777777777"],
  );
  assert.equal(await recoverStalePrivateReplies(pool, new Date(Date.now() - 5 * 60_000), connectionId), 1);
  assert.equal((await outbox()).status, "unknown");
  assert.equal((await outbox()).failure_code, "worker_interrupted");
});

test("the worker loop processes a job and stops when cancelled", async () => {
  await queueReply();
  const controller = new AbortController();
  let sends = 0;
  await runPrivateReplyWorker(
    pool,
    {
      verify: async () => ({
        commentCreatedAt: new Date(Date.now() - 60_000),
        authorizationVerified: true,
        mediaOwned: true,
      }),
      send: async () => {
        sends++;
        controller.abort();
        return { messageId: "mid-loop" };
      },
    },
    controller.signal,
    10,
    connectionId,
  );
  assert.equal(sends, 1);
  assert.equal((await outbox()).status, "sent");
});

test("a running worker recovers another interrupted attempt on its connection", async () => {
  await queueReply();
  const controller = new AbortController();
  let currentTime = new Date();
  await runPrivateReplyWorker(
    pool,
    {
      verify: async () => ({
        commentCreatedAt: new Date(currentTime.getTime() - 60_000),
        authorizationVerified: true,
        mediaOwned: true,
      }),
      send: async () => {
        await ingestComments(pool, [
          { accountId: "account-1", commentId: "comment-2", postId: "post-1", senderId: "sender-2", text: "자료" },
        ]);
        await pool.query(
          "UPDATE private_reply_outbox SET status = 'sending', attempt_id = $1, attempt_started_at = now() - interval '11 minutes' WHERE comment_id = 'comment-2'",
          ["77777777-7777-4777-8777-777777777777"],
        );
        currentTime = new Date(currentTime.getTime() + 60_000);
        setTimeout(() => controller.abort(), 100);
        return { messageId: "mid-1" };
      },
    },
    controller.signal,
    5,
    connectionId,
    { recoveryIntervalMs: 10, now: () => currentTime },
  );
  const result = await pool.query<{ status: string; failure_code: string }>(
    "SELECT status, failure_code FROM private_reply_outbox WHERE comment_id = 'comment-2'",
  );
  assert.equal(result.rows[0]?.status, "unknown");
  assert.equal(result.rows[0]?.failure_code, "worker_interrupted");
});

test("a connection-scoped worker leaves another connection's reply pending", async () => {
  const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
  const otherConnectionId = "55555555-5555-4555-8555-555555555555";
  const otherRuleId = "66666666-6666-4666-8666-666666666666";
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [otherWorkspaceId]);
  await pool.query(
    "INSERT INTO instagram_connections (id, workspace_id, account_id, active) VALUES ($1, $2, $3, true)",
    [otherConnectionId, otherWorkspaceId, "account-2"],
  );
  await pool.query(
    "INSERT INTO instagram_comment_rules (id, workspace_id, connection_id, media_id, keyword, private_reply_text, enabled) VALUES ($1, $2, $3, $4, $5, $6, true)",
    [otherRuleId, otherWorkspaceId, otherConnectionId, "post-2", "자료", "다른 계정 답장"],
  );
  await ingestComments(pool, [
    { accountId: "account-2", commentId: "comment-2", postId: "post-2", senderId: "sender-2", text: "자료" },
  ]);
  await queueReply();

  await assert.rejects(
    processNextPrivateReply(
      pool,
      { verify: verified, send: async () => ({ messageId: "unexpected" }) },
      () => now,
      undefined as unknown as string,
    ),
    /Instagram connection ID is required/,
  );
  const untouched = await pool.query<{ status: string }>(
    "SELECT status FROM private_reply_outbox ORDER BY connection_id",
  );
  assert.deepEqual(
    untouched.rows.map((row) => row.status),
    ["pending", "pending"],
  );

  const sentConnectionIds: string[] = [];
  await processNextPrivateReply(
    pool,
    {
      verify: verified,
      send: async (request) => {
        sentConnectionIds.push(request.connectionId);
        return { messageId: "mid-scoped" };
      },
    },
    () => now,
    connectionId,
  );

  assert.deepEqual(sentConnectionIds, [connectionId]);
  const rows = await pool.query<{ connection_id: string; status: string }>(
    "SELECT connection_id, status FROM private_reply_outbox ORDER BY connection_id",
  );
  assert.deepEqual(rows.rows, [
    { connection_id: connectionId, status: "sent" },
    { connection_id: otherConnectionId, status: "pending" },
  ]);

  await pool.query(
    "UPDATE private_reply_outbox SET status = 'sending', attempt_id = $1, attempt_started_at = now() - interval '10 minutes' WHERE connection_id = $2",
    ["77777777-7777-4777-8777-777777777777", otherConnectionId],
  );
  assert.equal(await recoverStalePrivateReplies(pool, new Date(Date.now() - 5 * 60_000), connectionId), 0);
  const other = await pool.query<{ status: string }>(
    "SELECT status FROM private_reply_outbox WHERE connection_id = $1",
    [otherConnectionId],
  );
  assert.equal(other.rows[0]?.status, "sending");
});
