import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMessageEvents } from "./message-events.ts";
import { InstagramFollowTransport } from "./follow-transport.ts";
import { ProviderRateLimitedError, ProviderRejectedError } from "./reply-worker.ts";
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
      throw new Error("delivery disabled before POST");
    },
  });
  await assert.rejects(transport.send("456", "hello", { replyId: "1", attemptId: "attempt-1" }), /delivery disabled/);
  assert.equal(requests, 0);
});
