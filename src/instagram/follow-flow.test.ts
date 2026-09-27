import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMessageEvents } from "./message-events.ts";
import { InstagramFollowTransport } from "./follow-transport.ts";
import { PreSendVerificationError, ProviderRateLimitedError, ProviderRejectedError } from "./reply-worker.ts";
const body = (messaging: unknown[]) =>
  Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: "123", messaging }] }));
const message = {
  sender: { id: "456" },
  recipient: { id: "123" },
  timestamp: Date.now(),
  message: { mid: "message-1", text: "확인" },
};
test("messages accept inbound text only and reject echo, self, deleted and mismatched recipients", () => {
  assert.equal(parseMessageEvents(body([message])).length, 1);
  for (const changed of [
    { ...message, message: { ...message.message, is_echo: true } },
    { ...message, sender: { id: "123" } },
    { ...message, recipient: { id: "999" } },
    { ...message, message: { ...message.message, is_deleted: true } },
    { ...message, timestamp: "bad" },
  ])
    assert.deepEqual(parseMessageEvents(body([changed])), []);
});
test("follow lookup distinguishes false from unknown and pins the account before lookup", async () => {
  for (const flag of [true, false, undefined]) {
    const calls: string[] = [];
    const transport = new InstagramFollowTransport({
      accountId: "123",
      accessToken: "test-token",
      graphVersion: "v26.0",
      fetchImpl: async (url) => {
        calls.push(String(url));
        return Response.json(
          String(url).includes("/me?")
            ? { user_id: "123" }
            : flag === undefined
              ? {}
              : { is_user_follow_business: flag },
        );
      },
    });
    assert.equal(await transport.followStatus("456"), flag ?? null);
    assert.equal(calls.length, 2);
  }
});
test("normal DM retries only a definite throttle refusal, preserving ambiguous outcomes", async () => {
  for (const [status, code, errorType] of [
    [400, 4, ProviderRateLimitedError],
    [400, 10, ProviderRejectedError],
    [503, 4, Error],
  ] as const) {
    const transport = new InstagramFollowTransport({
      accountId: "123",
      accessToken: "test-token",
      graphVersion: "v26.0",
      fetchImpl: async () => Response.json({ error: { code } }, { status }),
    });
    await assert.rejects(transport.send("456", "hello"), errorType);
  }
});

test("the final delivery guard runs with the claim and prevents a provider POST", async () => {
  let requests = 0;
  const transport = new InstagramFollowTransport({
    accountId: "123",
    accessToken: "synthetic",
    graphVersion: "v26.0",
    fetchImpl: async () => {
      requests++;
      return Response.json({ message_id: "unexpected" });
    },
    beforeSend: async (context) => {
      assert.deepEqual(context, { replyId: "1", attemptId: "attempt-1" });
      throw new PreSendVerificationError("block", "delivery_disabled");
    },
  });
  await assert.rejects(
    transport.send("456", "hello", { replyId: "1", attemptId: "attempt-1" }),
    (error) =>
      error instanceof PreSendVerificationError &&
      error.disposition === "block" &&
      error.failureCode === "delivery_disabled",
  );
  assert.equal(requests, 0);
});

test("confirmation postbacks carry a conversation binding rather than trusting the visible title", () => {
  const event = {
    ...message,
    message: undefined,
    postback: { mid: "tap-1", title: "자료 받기", payload: "auto-chatter:confirm:42" },
  };
  assert.deepEqual(parseMessageEvents(body([event])), [
    {
      accountId: "123",
      senderId: "456",
      messageId: "tap-1",
      text: "자료 받기",
      timestamp: new Date(event.timestamp),
      confirmationReplyId: "42",
    },
  ]);
  for (const payload of ["other:42", "auto-chatter:confirm:0", "auto-chatter:confirm:42x"])
    assert.deepEqual(parseMessageEvents(body([{ ...event, postback: { ...event.postback, payload } }])), []);
  assert.deepEqual(parseMessageEvents(body([{ ...event, recipient: { id: "999" } }])), []);
  assert.deepEqual(parseMessageEvents(body([{ ...event, is_self: true }])), []);
});

test("normal nonfollower DM includes the bound confirmation button and rejects long templates before POST", async () => {
  let payload: unknown;
  const transport = new InstagramFollowTransport({
    accountId: "123",
    accessToken: "synthetic",
    graphVersion: "v26.0",
    fetchImpl: async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({ message_id: "sent" });
    },
  });
  const context = { replyId: "42", attemptId: "attempt", confirmationButtonTitle: "팔로우 확인" };
  await transport.send("456", "팔로우한 뒤 눌러 주세요", context);
  assert.deepEqual(payload, {
    recipient: { id: "456" },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "팔로우한 뒤 눌러 주세요",
          buttons: [{ type: "postback", title: "팔로우 확인", payload: "auto-chatter:confirm:42" }],
        },
      },
    },
  });
  payload = undefined;
  await assert.rejects(transport.send("456", "x".repeat(641), context));
  assert.equal(payload, undefined);
});

test("manual account verification checks only the stored Instagram user_id", async () => {
  for (const user_id of ["123", "999", undefined]) {
    const transport = new InstagramFollowTransport({
      accountId: "123",
      accessToken: "synthetic",
      graphVersion: "v26.0",
      fetchImpl: async (input, init) => {
        assert.equal(String(input), "https://graph.instagram.com/v26.0/me?fields=user_id");
        assert.equal(init?.method, "GET");
        return Response.json({ user_id });
      },
    });
    assert.equal(await transport.verifyAccount(), user_id === "123");
  }
});

test("DM pre-POST guard exceptions remain definite unsent verification failures", async () => {
  const { PreSendVerificationError } = await import("./reply-worker.ts");
  let posts = 0;
  const transport = new InstagramFollowTransport({
    accountId: "123",
    accessToken: "synthetic",
    graphVersion: "v26.0",
    fetchImpl: async () => {
      posts++;
      return Response.json({ message_id: "forbidden" });
    },
    beforeSend: async () => {
      throw new Error("database read unavailable");
    },
  });
  await assert.rejects(
    transport.send("456", "Manual reply", { replyId: "manual", attemptId: "attempt" }),
    (error) =>
      error instanceof PreSendVerificationError &&
      error.disposition === "retry" &&
      error.failureCode === "verification_unavailable",
  );
  assert.equal(posts, 0);
});
