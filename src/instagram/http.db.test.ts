import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { createInstagramWebhookServer } from "./http.ts";

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
let server: Server;
let baseUrl: string;

function commentBody(
  options: { accountId?: string; commentId?: string; postId?: string; senderId?: string; text?: string } = {},
): string {
  return JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: options.accountId ?? "account-1",
        field: "comments",
        value: {
          id: options.commentId ?? "comment-1",
          text: options.text ?? "자료 부탁해요",
          from: { id: options.senderId ?? "sender-1" },
          media: { id: options.postId ?? "post-1" },
        },
      },
    ],
  });
}

function signedPost(body: string, signature?: string): Promise<Response> {
  const digest = createHmac("sha256", "test-app-secret").update(body).digest("hex");
  return fetch(`${baseUrl}/webhooks/instagram`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature ?? `sha256=${digest}`,
    },
    body,
  });
}

async function rowCount(table: "instagram_comment_events" | "private_reply_outbox"): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(result.rows[0]!.count);
}

before(async () => {
  const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
  await pool.query(
    "DROP TABLE IF EXISTS webhook_redelivery_events, webhook_deliveries, webhook_signing_keys, webhook_endpoints, scheduled_steps, workspace_invites, data_deletion_records, instagram_inbox_reminder_events, instagram_inbox_reminders, instagram_inbox_notes, instagram_inbox_label_events, instagram_inbox_conversation_labels, instagram_inbox_labels, instagram_inbox_read_state, instagram_inbox_conversation_events, instagram_inbox_conversations, flow_step_runs, flow_runs, flow_versions, flows, channel_consent_state, channel_consent_events, instagram_manual_reply_events, instagram_manual_replies, instagram_inbox_handoff_events, instagram_inbox_handoffs, instagram_inbox_messages, instagram_unmatched_replies, instagram_contact_automation, instagram_contact_field_values, instagram_contact_fields, instagram_contact_segments, instagram_contact_tags, instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
  );
  await pool.query(schema);
  server = createInstagramWebhookServer({ pool, appSecret: "test-app-secret", verifyToken: "test-verify-token" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
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
  if (server)
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await pool.end();
});

test("configured keyword modes queue only matching comments and never replay stored comments", async () => {
  await pool.query(
    "UPDATE instagram_comment_rules SET keywords = $1, match_mode = 'exact', excluded_keywords = $2 WHERE id = $3",
    [["LINK", "자료"], ["거절"], ruleId],
  );
  assert.equal((await signedPost(commentBody({ text: "send link" }))).status, 200);
  assert.equal(await rowCount("private_reply_outbox"), 0);
  await pool.query("UPDATE instagram_comment_rules SET match_mode='contains' WHERE id=$1", [ruleId]);
  // An already stored event is not re-evaluated when settings change.
  assert.equal((await signedPost(commentBody({ text: "send link" }))).status, 200);
  assert.equal(await rowCount("private_reply_outbox"), 0);
  assert.equal((await signedPost(commentBody({ commentId: "comment-2", text: "자료 거절" }))).status, 200);
  assert.equal(await rowCount("private_reply_outbox"), 0);
  assert.equal((await signedPost(commentBody({ commentId: "comment-3", text: "Send LINK" }))).status, 200);
  assert.equal(await rowCount("private_reply_outbox"), 1);
  assert.equal((await signedPost(commentBody({ commentId: "comment-3", text: "Send LINK" }))).status, 200);
  assert.equal(await rowCount("private_reply_outbox"), 1);
});

test("all-comment rules still apply exclusions", async () => {
  await pool.query("UPDATE instagram_comment_rules SET match_mode='all', excluded_keywords=$1 WHERE id=$2", [
    ["skip"],
    ruleId,
  ]);
  await signedPost(commentBody({ text: "please SKIP" }));
  assert.equal(await rowCount("private_reply_outbox"), 0);
  await signedPost(commentBody({ commentId: "other", text: "unrelated comment" }));
  assert.equal(await rowCount("private_reply_outbox"), 1);
});

test("rule migration preserves legacy data and can be applied twice", async () => {
  await pool.query(
    "ALTER TABLE instagram_comment_rules DROP COLUMN keywords, DROP COLUMN match_mode, DROP COLUMN excluded_keywords",
  );
  const migration = await readFile(
    new URL("../../db/migrations/003_comment_rule_matching.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);
  const rule = (
    await pool.query(
      "SELECT keyword, keywords, match_mode, excluded_keywords FROM instagram_comment_rules WHERE id=$1",
      [ruleId],
    )
  ).rows[0];
  assert.deepEqual(rule, { keyword: "자료", keywords: [], match_mode: "contains", excluded_keywords: [] });
  await signedPost(commentBody());
  assert.equal(await rowCount("private_reply_outbox"), 1);
});

test("subscription challenge accepts the configured token and rejects another", async () => {
  const accepted = await fetch(
    `${baseUrl}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=challenge-123`,
  );
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), "challenge-123");

  const rejected = await fetch(
    `${baseUrl}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123`,
  );
  assert.equal(rejected.status, 403);
});

test("invalid signature cannot create an event or a private reply request", async () => {
  const response = await signedPost(commentBody(), `sha256=${"0".repeat(64)}`);
  assert.equal(response.status, 403);
  assert.equal(await rowCount("instagram_comment_events"), 0);
  assert.equal(await rowCount("private_reply_outbox"), 0);
});

test("replayed and concurrent signed comments create one event and one private reply request", async () => {
  const body = commentBody();
  const responses = await Promise.all([signedPost(body), signedPost(body), signedPost(body)]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200],
  );
  assert.equal(await rowCount("instagram_comment_events"), 1);
  assert.equal(await rowCount("private_reply_outbox"), 1);

  const result = await pool.query<{
    workspace_id: string;
    comment_id: string;
    status: string;
    private_reply_text: string;
  }>("SELECT workspace_id, comment_id, status, private_reply_text FROM private_reply_outbox");
  assert.deepEqual(result.rows, [
    {
      workspace_id: workspaceId,
      comment_id: "comment-1",
      status: "pending",
      private_reply_text: "자료 링크입니다",
    },
  ]);
});

test("a nonmatching keyword stores the comment without a private reply request", async () => {
  assert.equal((await signedPost(commentBody({ text: "안녕하세요" }))).status, 200);
  assert.equal(await rowCount("instagram_comment_events"), 1);
  assert.equal(await rowCount("private_reply_outbox"), 0);
});

test("an entry changes comment follows the same ingestion path", async () => {
  const payload = JSON.parse(commentBody());
  payload.entry[0] = { id: "account-1", changes: [{ field: "comments", value: payload.entry[0].value }] };
  assert.equal((await signedPost(JSON.stringify(payload))).status, 200);
  assert.equal(await rowCount("instagram_comment_events"), 1);
  assert.equal(await rowCount("private_reply_outbox"), 1);
});

test("an unconnected account creates no workspace data", async () => {
  assert.equal((await signedPost(commentBody({ accountId: "unknown-account" }))).status, 200);
  assert.equal(await rowCount("instagram_comment_events"), 0);
  assert.equal(await rowCount("private_reply_outbox"), 0);
});

test("a second comment by the same sender on one post does not request another DM", async () => {
  assert.equal((await signedPost(commentBody())).status, 200);
  assert.equal((await signedPost(commentBody({ commentId: "comment-2" }))).status, 200);
  assert.equal(await rowCount("instagram_comment_events"), 2);
  assert.equal(await rowCount("private_reply_outbox"), 1);
});

test("the same comment identifier in another workspace remains separate", async () => {
  const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
  const otherConnectionId = "55555555-5555-4555-8555-555555555555";
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [otherWorkspaceId]);
  await pool.query(
    "INSERT INTO instagram_connections (id, workspace_id, account_id, active) VALUES ($1, $2, $3, true)",
    [otherConnectionId, otherWorkspaceId, "account-2"],
  );
  await pool.query(
    "INSERT INTO instagram_comment_rules (id, workspace_id, connection_id, media_id, keyword, private_reply_text, enabled) VALUES ($1, $2, $3, $4, $5, $6, true)",
    [
      "66666666-6666-4666-8666-666666666666",
      otherWorkspaceId,
      otherConnectionId,
      "post-1",
      "자료",
      "다른 작업 공간의 답장",
    ],
  );

  assert.equal((await signedPost(commentBody())).status, 200);
  assert.equal((await signedPost(commentBody({ accountId: "account-2" }))).status, 200);
  const result = await pool.query<{ workspace_id: string; private_reply_text: string }>(
    "SELECT workspace_id, private_reply_text FROM private_reply_outbox ORDER BY workspace_id",
  );
  assert.deepEqual(result.rows, [
    { workspace_id: workspaceId, private_reply_text: "자료 링크입니다" },
    { workspace_id: otherWorkspaceId, private_reply_text: "다른 작업 공간의 답장" },
  ]);
});

test("a signed malformed payload returns 400 without storing an event", async () => {
  assert.equal((await signedPost("{")).status, 400);
  assert.equal(await rowCount("instagram_comment_events"), 0);
});

test("an inactive connection cannot create workspace data", async () => {
  await pool.query("UPDATE instagram_connections SET active = false WHERE id = $1", [connectionId]);
  assert.equal((await signedPost(commentBody())).status, 200);
  assert.equal(await rowCount("instagram_comment_events"), 0);
  assert.equal(await rowCount("private_reply_outbox"), 0);
});

test("a large signed body is rejected before parsing or storing it", async () => {
  const response = await signedPost("x".repeat(1024 * 1024 + 1));
  assert.equal(response.status, 413);
  assert.equal(await rowCount("instagram_comment_events"), 0);
});

test("a malformed comment in a batch prevents partial storage", async () => {
  const payload = JSON.parse(commentBody());
  payload.entry.push({ id: "account-1", field: "comments", value: { id: "comment-2" } });
  assert.equal((await signedPost(JSON.stringify(payload))).status, 400);
  assert.equal(await rowCount("instagram_comment_events"), 0);
});

test("concurrent comments by one sender on one post queue only one reply", async () => {
  const responses = await Promise.all([
    signedPost(commentBody({ commentId: "comment-1" })),
    signedPost(commentBody({ commentId: "comment-2" })),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.equal(await rowCount("instagram_comment_events"), 2);
  assert.equal(await rowCount("private_reply_outbox"), 1);
});

test("the database rejects an outbox rule from another workspace", async () => {
  assert.equal((await signedPost(commentBody())).status, 200);
  const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
  const otherConnectionId = "55555555-5555-4555-8555-555555555555";
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [otherWorkspaceId]);
  await pool.query(
    "INSERT INTO instagram_connections (id, workspace_id, account_id, active) VALUES ($1, $2, $3, true)",
    [otherConnectionId, otherWorkspaceId, "account-2"],
  );
  const event = await pool.query<{ id: string }>(
    "INSERT INTO instagram_comment_events (workspace_id, connection_id, comment_id, media_id, sender_id, comment_text) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [otherWorkspaceId, otherConnectionId, "comment-2", "post-2", "sender-2", "자료"],
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO private_reply_outbox (workspace_id, connection_id, event_id, rule_id, comment_id, media_id, sender_id, private_reply_text) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        otherWorkspaceId,
        otherConnectionId,
        event.rows[0]!.id,
        ruleId,
        "comment-2",
        "post-2",
        "sender-2",
        "잘못된 교차 참조",
      ],
    ),
    /foreign key constraint/,
  );
});

test("the database rejects an outbox event from another workspace", async () => {
  const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
  const otherConnectionId = "55555555-5555-4555-8555-555555555555";
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [otherWorkspaceId]);
  await pool.query(
    "INSERT INTO instagram_connections (id, workspace_id, account_id, active) VALUES ($1, $2, $3, true)",
    [otherConnectionId, otherWorkspaceId, "account-2"],
  );
  const event = await pool.query<{ id: string }>(
    "INSERT INTO instagram_comment_events (workspace_id, connection_id, comment_id, media_id, sender_id, comment_text) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [otherWorkspaceId, otherConnectionId, "comment-2", "post-2", "sender-2", "자료"],
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO private_reply_outbox (workspace_id, connection_id, event_id, rule_id, comment_id, media_id, sender_id, private_reply_text) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [workspaceId, connectionId, event.rows[0]!.id, ruleId, "comment-2", "post-1", "sender-2", "잘못된 교차 참조"],
    ),
    /foreign key constraint/,
  );
});
