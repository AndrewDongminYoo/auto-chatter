import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { ingestMessages, processNextFollowReply } from "./follow-flow.ts";
import { ProviderRateLimitedError } from "./reply-worker.ts";
const url = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: url.toString() });
const workspace = "11111111-1111-4111-8111-111111111111",
  connection = "22222222-2222-4222-8222-222222222222",
  rule = "33333333-3333-4333-8333-333333333333";
let replyId: string;
before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await pool.query(
    await readFile(new URL("../../db/migrations/006_follow_conversations.sql", import.meta.url), "utf8"),
  );
});
after(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces VALUES($1)", [workspace]);
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,access_token_encrypted,token_expires_at) VALUES($1,$2,'123',true,true,'test',now()+interval '1 day')",
    [connection, workspace],
  );
  await pool.query(
    "INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled) VALUES($1,$2,$3,'111','link','Reply with confirm',true)",
    [rule, workspace, connection],
  );
  const event = (
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'222','111','456','link') RETURNING id",
      [workspace, connection],
    )
  ).rows[0].id;
  replyId = (
    await pool.query(
      "INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text,status,sent_at,recipient_id) VALUES($1,$2,$3,$4,'222','111','456','Confirm','sent',now()-interval '1 hour','456') RETURNING id",
      [workspace, connection, event, rule],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text) VALUES($1,$2,'456','확인','Here is the link','Follow then reply again')",
    [replyId, connection],
  );
});
const incoming = (id = "mid-1", text = "확인", timestamp = new Date()) => ({
  accountId: "123",
  senderId: "456",
  messageId: id,
  text,
  timestamp,
});
const state = async () =>
  (await pool.query("SELECT * FROM instagram_follow_conversations WHERE reply_id=$1", [replyId])).rows[0];
test("only matching inbound confirmation starts work; old, future, foreign and replay events do not", async () => {
  await ingestMessages(pool, [
    incoming("old", "확인", new Date(Date.now() - 2 * 3600000)),
    incoming("future", "확인", new Date(Date.now() + 600000)),
    incoming("other", "hello"),
    { ...incoming("foreign"), accountId: "999" },
  ]);
  assert.equal((await state()).status, "waiting");
  await ingestMessages(pool, [incoming()]);
  assert.equal((await state()).status, "pending");
  await processNextFollowReply(pool, connection, {
    followStatus: async () => false,
    send: async () => ({ messageId: "sent-nonfollower" }),
  });
  assert.equal((await state()).status, "waiting");
  await ingestMessages(pool, [incoming()]);
  assert.equal((await state()).status, "waiting");
});
test("nonfollowers can confirm again; followers receive one final response and duplicate delivery cannot resend", async () => {
  const sent: string[] = [];
  let follows = false;
  const transport = {
    followStatus: async () => follows,
    send: async (_id: string, text: string) => {
      sent.push(text);
      return { messageId: "sent-" + sent.length };
    },
  };
  await ingestMessages(pool, [incoming()]);
  await processNextFollowReply(pool, connection, transport);
  assert.equal((await state()).follow_status, "not_following");
  follows = true;
  await ingestMessages(pool, [incoming("mid-2", " 확인 ", new Date(Date.now() + 10))]);
  await Promise.all([
    processNextFollowReply(pool, connection, transport),
    processNextFollowReply(pool, connection, transport),
  ]);
  assert.deepEqual(sent, ["Follow then reply again", "Here is the link"]);
  assert.equal((await state()).status, "sent");
  await ingestMessages(pool, [incoming("mid-3")]);
  assert.equal(await processNextFollowReply(pool, connection, transport), false);
});
test("unknown profile never selects nonfollower content and expired windows never send", async () => {
  let sends = 0;
  const transport = {
    followStatus: async () => null,
    send: async () => {
      sends++;
      return { messageId: "bad" };
    },
  };
  await ingestMessages(pool, [incoming()]);
  await processNextFollowReply(pool, connection, transport);
  assert.equal((await state()).status, "pending");
  assert.equal((await state()).follow_status, "unknown");
  assert.equal(sends, 0);
  await pool.query(
    "UPDATE instagram_follow_conversations SET confirmed_at=now()-interval '24 hours',next_attempt_at=now()",
  );
  await processNextFollowReply(pool, connection, transport);
  assert.equal((await state()).status, "waiting");
  assert.equal((await state()).failure_code, "response_window_expired");
  assert.equal(sends, 0);
});
test("a rule disabled during profile lookup prevents the POST", async () => {
  let sends = 0;
  await ingestMessages(pool, [incoming()]);
  await processNextFollowReply(pool, connection, {
    followStatus: async () => {
      await pool.query("UPDATE instagram_comment_rules SET enabled=false");
      return true;
    },
    send: async () => {
      sends++;
      return { messageId: "bad" };
    },
  });
  assert.equal(sends, 0);
  assert.equal((await state()).status, "blocked");
});
test("definite throttle retries with a connection pause; ambiguous POST never retries", async () => {
  await ingestMessages(pool, [incoming()]);
  await processNextFollowReply(pool, connection, {
    followStatus: async () => true,
    send: async () => {
      throw new ProviderRateLimitedError(4);
    },
  });
  assert.equal((await state()).status, "pending");
  assert.equal((await state()).rate_limit_retries, 1);
  await pool.query("UPDATE instagram_connections SET send_paused_until=NULL");
  await pool.query("UPDATE instagram_follow_conversations SET next_attempt_at=now()");
  await processNextFollowReply(pool, connection, {
    followStatus: async () => true,
    send: async () => {
      throw new Error("timeout after write");
    },
  });
  assert.equal((await state()).status, "unknown");
  assert.equal(
    await processNextFollowReply(pool, connection, {
      followStatus: async () => true,
      send: async () => {
        throw new Error("must not send");
      },
    }),
    false,
  );
});
