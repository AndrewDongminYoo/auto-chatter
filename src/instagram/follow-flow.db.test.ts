import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { ingestComments } from "./store.ts";
import { ingestMessages, processNextFollowReply } from "./follow-flow.ts";
import { createNodeFollowTransport, assertNodePrivateReplyAllowed } from "./node-delivery.ts";
import { ProviderRateLimitedError, runPrivateReplyWorker, processNextPrivateReply } from "./reply-worker.ts";
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
  await pool.query(await readFile(new URL("../../db/migrations/007_confirmation_button.sql", import.meta.url), "utf8"));
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

test("Node polling drains confirmed follow replies using its environment account", async () => {
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=NULL,token_expires_at=NULL");
  await ingestMessages(pool, [incoming()]);
  let sends = 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await runPrivateReplyWorker(
      pool,
      {
        verify: async () => {
          throw new Error("No private reply is pending");
        },
        send: async () => {
          throw new Error("No private reply is pending");
        },
      },
      controller.signal,
      5,
      connection,
      {
        follow: {
          accountId: "123",
          transport: createNodeFollowTransport(pool, {
            accountId: "123",
            connectionId: connection,
            accessToken: "synthetic",
            graphVersion: "v26.0",
            fetchImpl: async (input, init) => {
              if (init?.method === "POST") {
                const body = JSON.parse(String(init.body));
                assert.deepEqual(body, { recipient: { id: "456" }, message: { text: "Here is the link" } });
                sends++;
                controller.abort();
                return Response.json({ message_id: "node-follow-1" });
              }
              return Response.json(
                String(input).includes("/me?") ? { user_id: "123" } : { is_user_follow_business: true },
              );
            },
          }),
        },
      },
    );
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(sends, 1);
  assert.equal((await state()).status, "sent");
});

for (const scenario of [
  "mismatched_account",
  "disabled_sending",
  "oauth_credential",
  "expired_window",
  "disabled_rule",
  "paused_connection",
  "lost_claim",
  "ambiguous_post",
] as const) {
  test(`Node follow guard handles ${scenario} without unsafe resends`, async () => {
    await pool.query("UPDATE instagram_connections SET access_token_encrypted=NULL,token_expires_at=NULL");
    await ingestMessages(pool, [incoming()]);
    if (scenario === "mismatched_account") await pool.query("UPDATE instagram_connections SET account_id='999'");
    if (scenario === "disabled_sending") await pool.query("UPDATE instagram_connections SET send_enabled=false");
    if (scenario === "oauth_credential")
      await pool.query("UPDATE instagram_connections SET access_token_encrypted='new-credential'");
    if (scenario === "expired_window")
      await pool.query("UPDATE instagram_follow_conversations SET confirmed_at=now()-interval '24 hours'");
    let posts = 0;
    const transport = createNodeFollowTransport(pool, {
      accountId: "123",
      connectionId: connection,
      accessToken: "synthetic",
      graphVersion: "v26.0",
      fetchImpl: async (input, init) => {
        if (init?.method === "POST") {
          posts++;
          throw new Error("ambiguous network failure");
        }
        if (String(input).includes("/me?")) return Response.json({ user_id: "123" });
        if (scenario === "disabled_rule") await pool.query("UPDATE instagram_comment_rules SET enabled=false");
        if (scenario === "paused_connection")
          await pool.query("UPDATE instagram_connections SET send_paused_until=now()+interval '1 hour'");
        if (scenario === "lost_claim")
          await pool.query("UPDATE instagram_follow_conversations SET attempt_id=gen_random_uuid()");
        return Response.json({ is_user_follow_business: true });
      },
    });
    const process = () => processNextFollowReply(pool, connection, transport, () => new Date(), "123");
    if (scenario === "lost_claim") await assert.rejects(process, /claim was lost/);
    else await process();
    assert.equal(posts, scenario === "ambiguous_post" ? 1 : 0);
    if (scenario === "ambiguous_post") {
      assert.equal((await state()).status, "unknown");
      assert.equal(await process(), false);
      assert.equal(posts, 1);
    }
  });
}

test("Node transport repeats the policy guard immediately before POST", async () => {
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=NULL,token_expires_at=NULL");
  await ingestMessages(pool, [incoming()]);
  const attemptId = "44444444-4444-4444-8444-444444444444";
  await pool.query("UPDATE instagram_follow_conversations SET status='sending',attempt_id=$1", [attemptId]);
  let posts = 0;
  const transport = createNodeFollowTransport(pool, {
    accountId: "123",
    connectionId: connection,
    accessToken: "synthetic",
    graphVersion: "v26.0",
    fetchImpl: async () => {
      posts++;
      return Response.json({ message_id: "unexpected" });
    },
  });
  await pool.query("UPDATE instagram_comment_rules SET enabled=false");
  await assert.rejects(() => transport.send("456", "Link", { replyId, attemptId }), {
    failureCode: "delivery_not_permitted",
  });
  assert.equal(posts, 0);
});

test("Cloudflare default still requires a stored unexpired credential", async () => {
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=NULL,token_expires_at=NULL");
  await ingestMessages(pool, [incoming()]);
  await processNextFollowReply(pool, connection, {
    followStatus: async () => {
      throw new Error("must not inspect");
    },
    send: async () => {
      throw new Error("must not send");
    },
  });
  assert.equal((await state()).status, "blocked");
});

test("Node startup recovery scopes stale follow claims to its configured connection", async () => {
  await pool.query(
    "UPDATE instagram_follow_conversations SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now()-interval '11 minutes'",
  );
  const foreignConnection = "55555555-5555-4555-8555-555555555555";
  const controller = new AbortController();
  controller.abort();
  const options = {
    follow: {
      accountId: "123",
      transport: {
        followStatus: async () => true,
        send: async () => {
          throw new Error("must not send");
        },
      },
    },
  };
  const privateTransport = {
    verify: async () => {
      throw new Error("must not verify");
    },
    send: async () => {
      throw new Error("must not send");
    },
  };
  await runPrivateReplyWorker(pool, privateTransport, controller.signal, 5, foreignConnection, options);
  assert.equal((await state()).status, "sending");
  await runPrivateReplyWorker(pool, privateTransport, controller.signal, 5, connection, options);
  assert.equal((await state()).status, "unknown");
  assert.equal((await state()).failure_code, "worker_interrupted");
});

test("an unsupported transport blocks a follow rule before its first DM", async () => {
  await pool.query("UPDATE private_reply_outbox SET status='pending',follow_config=$1", [
    JSON.stringify({ confirmation_keyword: "confirm" }),
  ]);
  await processNextPrivateReply(
    pool,
    {
      supportsFollowReplies: false,
      verify: async () => {
        throw new Error("must not verify");
      },
      send: async () => {
        throw new Error("must not send");
      },
    },
    () => new Date(),
    connection,
  );
  const reply = (await pool.query("SELECT status,failure_code FROM private_reply_outbox WHERE id=$1", [replyId]))
    .rows[0];
  assert.equal(reply.status, "blocked");
  assert.equal(reply.failure_code, "follow_requires_instagram_login");
});

for (const condition of ["enabled", "disabled", "oauth", "foreign_account", "lost_claim", "inactive_rule"] as const) {
  test(`Node private reply pre-POST authorization: ${condition}`, async () => {
    const attemptId = "44444444-4444-4444-8444-444444444444";
    await pool.query("UPDATE instagram_connections SET access_token_encrypted=NULL,token_expires_at=NULL");
    await pool.query("UPDATE private_reply_outbox SET status='sending',attempt_id=$1,attempt_started_at=now()", [
      attemptId,
    ]);
    if (condition === "disabled") await pool.query("UPDATE instagram_connections SET send_enabled=false");
    if (condition === "oauth")
      await pool.query("UPDATE instagram_connections SET access_token_encrypted='managed-token'");
    if (condition === "foreign_account") await pool.query("UPDATE instagram_connections SET account_id='999'");
    if (condition === "lost_claim") await pool.query("UPDATE private_reply_outbox SET attempt_id=gen_random_uuid()");
    if (condition === "inactive_rule") await pool.query("UPDATE instagram_comment_rules SET enabled=false");
    const guard = () =>
      assertNodePrivateReplyAllowed(
        pool,
        { accountId: "123", connectionId: connection },
        {
          id: replyId,
          attemptId,
          workspaceId: workspace,
          connectionId: connection,
          accountId: "123",
          commentId: "222",
          mediaId: "111",
          senderId: "456",
          text: "Confirm",
        },
      );
    if (condition === "enabled") await guard();
    else await assert.rejects(guard, { failureCode: "delivery_not_permitted" });
  });
}

test("bound button taps ignore visible text, reject foreign actors and deduplicate receipts", async () => {
  await pool.query(
    "UPDATE instagram_follow_conversations SET confirmation_button_title='자료 받기' WHERE reply_id=$1",
    [replyId],
  );
  const tap = { ...incoming("tap", "자료 받기"), confirmationReplyId: replyId };
  await ingestMessages(pool, [
    { ...tap, senderId: "999" },
    { ...tap, accountId: "999" },
    { ...tap, confirmationReplyId: "999999" },
  ]);
  assert.equal((await state()).status, "waiting");
  await ingestMessages(pool, [tap]);
  assert.equal((await state()).status, "pending");
  let context: unknown;
  await processNextFollowReply(pool, connection, {
    followStatus: async () => false,
    send: async (_id, _text, sentContext) => {
      context = sentContext;
      return { messageId: "nonfollower-button" };
    },
  });
  assert.equal((context as { confirmationButtonTitle: string }).confirmationButtonTitle, "자료 받기");
  await ingestMessages(pool, [tap]);
  assert.equal((await state()).status, "waiting");
  await pool.query("UPDATE instagram_follow_conversations SET confirmation_button_title='' WHERE reply_id=$1", [
    replyId,
  ]);
  await ingestMessages(pool, [{ ...tap, messageId: "new-tap", timestamp: new Date(Date.now() + 1000) }]);
  assert.equal((await state()).status, "waiting");
});

test("comment ingestion snapshots button settings through first delivery and later rule edits", async () => {
  await pool.query(
    "UPDATE instagram_comment_rules SET follow_gate_enabled=true,confirmation_button_title='자료 받기',follower_reply_text='링크',non_follower_reply_text='팔로우 안내' WHERE id=$1",
    [rule],
  );
  await ingestComments(pool, [{ accountId: "123", commentId: "333", postId: "111", senderId: "789", text: "link" }]);
  const queued = (await pool.query("SELECT * FROM private_reply_outbox WHERE comment_id='333'")).rows[0];
  assert.equal(queued.follow_config.confirmation_button_title, "자료 받기");
  await pool.query("UPDATE instagram_comment_rules SET confirmation_button_title='새 이름' WHERE id=$1", [rule]);
  let deliveredTitle: string | undefined;
  await processNextPrivateReply(
    pool,
    {
      verify: async () => ({ commentCreatedAt: new Date(), authorizationVerified: true, mediaOwned: true }),
      send: async (request) => {
        deliveredTitle = request.confirmationButtonTitle;
        return { messageId: "first-button", recipientId: "789" };
      },
    },
    () => new Date(),
    connection,
  );
  assert.equal(deliveredTitle, "자료 받기");
  const flow = (
    await pool.query("SELECT confirmation_button_title FROM instagram_follow_conversations WHERE reply_id=$1", [
      queued.id,
    ])
  ).rows[0];
  assert.equal(flow.confirmation_button_title, "자료 받기");
});

async function pauseAutomation(paused = true) {
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,'456',$3) ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET paused=$3",
    [workspace, connection, paused],
  );
}
test("paused confirmation is ignored and deduplicated after resume", async () => {
  await pauseAutomation();
  const message = incoming();
  await ingestMessages(pool, [message]);
  assert.equal((await state()).status, "waiting");
  await pauseAutomation(false);
  await ingestMessages(pool, [message]);
  assert.equal((await state()).status, "waiting");
  await ingestMessages(pool, [incoming("new")]);
  assert.equal((await state()).status, "pending");
});
test("paused follow work stays pending and resume cannot extend its response window", async () => {
  await ingestMessages(pool, [incoming()]);
  await pauseAutomation();
  let calls = 0;
  const transport = {
    followStatus: async () => {
      calls++;
      return true;
    },
    send: async () => {
      calls++;
      return { messageId: "sent" };
    },
  };
  assert.equal(await processNextFollowReply(pool, connection, transport), false);
  assert.equal(calls, 0);
  await pauseAutomation(false);
  await processNextFollowReply(pool, connection, transport, () => new Date(Date.now() + 25 * 3600000));
  assert.equal(calls, 0);
  assert.equal((await state()).status, "waiting");
  assert.equal((await state()).failure_code, "response_window_expired");
});
test("pause during follow lookup defers without a provider POST", async () => {
  await ingestMessages(pool, [incoming()]);
  let sends = 0;
  await processNextFollowReply(pool, connection, {
    followStatus: async () => {
      await pauseAutomation();
      return true;
    },
    send: async () => {
      sends++;
      return { messageId: "sent" };
    },
  });
  assert.equal(sends, 0);
  assert.equal((await state()).status, "pending");
  assert.equal((await state()).failure_code, "contact_paused");
  assert.equal((await state()).attempt_id, null);
  assert.equal((await state()).rate_limit_retries, 0);
});
test("Node final private and follow guards defer a contact paused after authorization", async () => {
  const attemptId = "44444444-4444-4444-8444-444444444444";
  await pauseAutomation();
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=NULL,token_expires_at=NULL");
  await pool.query("UPDATE private_reply_outbox SET status='sending',attempt_id=$1,attempt_started_at=now()", [
    attemptId,
  ]);
  await assert.rejects(
    assertNodePrivateReplyAllowed(
      pool,
      { accountId: "123", connectionId: connection },
      {
        id: replyId,
        attemptId,
        workspaceId: workspace,
        connectionId: connection,
        accountId: "123",
        commentId: "222",
        mediaId: "111",
        senderId: "456",
        text: "Confirm",
      },
    ),
    { disposition: "retry", failureCode: "contact_paused" },
  );
  await pool.query("UPDATE private_reply_outbox SET status='sent'");
  await pool.query(
    "UPDATE instagram_follow_conversations SET status='sending',confirmed_at=now(),attempt_id=$1,attempt_started_at=now()",
    [attemptId],
  );
  let sends = 0;
  const transport = createNodeFollowTransport(pool, {
    accountId: "123",
    connectionId: connection,
    accessToken: "synthetic",
    graphVersion: "v26.0",
    fetchImpl: async () => {
      sends++;
      return Response.json({ message_id: "sent" });
    },
  });
  await assert.rejects(transport.send("456", "Confirm", { replyId, attemptId }), {
    disposition: "retry",
    failureCode: "contact_paused",
  });
  assert.equal(sends, 0);
});

test("a pause committed while the confirmation receipt waits prevents later activation", async () => {
  const lock = await pool.connect();
  let pending: Promise<void> | undefined;
  try {
    await lock.query("BEGIN");
    await lock.query("LOCK TABLE instagram_message_receipts IN ACCESS EXCLUSIVE MODE");
    pending = ingestMessages(pool, [incoming("paused-race")]);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const blocked = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO instagram_message_receipts%'",
      );
      if (blocked.rowCount) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "Fixture must block receipt insertion after the initial flow lookup");
    await pauseAutomation();
    await lock.query("COMMIT");
    await pending;
    assert.equal((await state()).status, "waiting");
    assert.equal((await state()).confirmed_at, null);
    await pauseAutomation(false);
    let sends = 0;
    assert.equal(
      await processNextFollowReply(pool, connection, {
        followStatus: async () => true,
        send: async () => {
          sends++;
          return { messageId: "sent" };
        },
      }),
      false,
    );
    assert.equal(sends, 0);
    await ingestMessages(pool, [incoming("paused-race")]);
    assert.equal((await state()).status, "waiting");
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
    if (pending) await pending;
  }
});

test("confirmations received while paused pending work cannot restart a waiting flow after resume", async () => {
  const first = incoming("first");
  await ingestMessages(pool, [first]);
  await pauseAutomation();
  const pausedMessage = incoming("paused-pending", "확인", new Date(first.timestamp.getTime() + 1000));
  await ingestMessages(pool, [pausedMessage]);
  await pauseAutomation(false);
  let sends = 0;
  await processNextFollowReply(pool, connection, {
    followStatus: async () => false,
    send: async () => {
      sends++;
      return { messageId: "sent" };
    },
  });
  assert.equal(sends, 1);
  assert.equal((await state()).status, "waiting");
  await ingestMessages(pool, [pausedMessage]);
  assert.equal((await state()).status, "waiting");
});

async function handoffPause() {
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,handoff_paused) VALUES($1,$2,'456',true)",
    [workspace, connection],
  );
}
test("handoff ignores and deduplicates confirmations without replay on resume", async () => {
  await handoffPause();
  const message = incoming();
  await ingestMessages(pool, [message]);
  assert.equal((await state()).status, "waiting");
  await pool.query("UPDATE instagram_contact_automation SET handoff_paused=false");
  await ingestMessages(pool, [message]);
  assert.equal((await state()).status, "waiting");
});
test("handoff stops follow claim and a pause during profile lookup prevents send", async () => {
  await ingestMessages(pool, [incoming()]);
  await handoffPause();
  const transport = {
    followStatus: async () => true,
    send: async () => {
      throw new Error("must not send");
    },
  };
  assert.equal(await processNextFollowReply(pool, connection, transport), false);
  await pool.query("UPDATE instagram_contact_automation SET handoff_paused=false");
  let sends = 0;
  await processNextFollowReply(pool, connection, {
    followStatus: async () => {
      await pool.query("UPDATE instagram_contact_automation SET handoff_paused=true");
      return true;
    },
    send: async () => {
      sends++;
      return { messageId: "sent" };
    },
  });
  assert.equal(sends, 0);
  assert.equal((await state()).failure_code, "contact_paused");
});
test("handoff is checked by Node private final authorization", async () => {
  await handoffPause();
  const attemptId = "44444444-4444-4444-8444-444444444444";
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=NULL,token_expires_at=NULL");
  await pool.query("UPDATE private_reply_outbox SET status='sending',attempt_id=$1,attempt_started_at=now()", [
    attemptId,
  ]);
  await assert.rejects(
    assertNodePrivateReplyAllowed(
      pool,
      { connectionId: connection, accountId: "123" },
      {
        id: replyId,
        workspaceId: workspace,
        connectionId: connection,
        accountId: "123",
        commentId: "comment",
        mediaId: "media",
        senderId: "456",
        text: "hello",
        attemptId,
      },
    ),
    { disposition: "retry", failureCode: "contact_paused" },
  );
});

test("handoff is checked by Node follow final authorization", async () => {
  await handoffPause();
  const attemptId = "44444444-4444-4444-8444-444444444444";
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=NULL,token_expires_at=NULL");
  await pool.query(
    "UPDATE instagram_follow_conversations SET status='sending',confirmed_at=now(),attempt_id=$1,attempt_started_at=now()",
    [attemptId],
  );
  let sends = 0;
  const transport = createNodeFollowTransport(pool, {
    accountId: "123",
    connectionId: connection,
    accessToken: "synthetic",
    graphVersion: "v26.0",
    fetchImpl: async () => {
      sends++;
      return Response.json({ message_id: "sent" });
    },
  });
  await assert.rejects(transport.send("456", "Confirm", { replyId, attemptId }), {
    disposition: "retry",
    failureCode: "contact_paused",
  });
  assert.equal(sends, 0);
});
