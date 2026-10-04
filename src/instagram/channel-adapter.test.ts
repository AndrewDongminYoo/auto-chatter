import assert from "node:assert/strict";
import { test } from "node:test";
import { instagramAdapter, instagramCapabilities, partitionInstagramEvents } from "./channel-adapter.ts";
import { checkCapability } from "../channels/contract.ts";
import { parseCommentEvents } from "./webhook.ts";
import { parseMessageEvents } from "./message-events.ts";
import { PreSendVerificationError, ProviderRateLimitedError, ProviderRejectedError } from "./reply-worker.ts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const message = {
  sender: { id: "456" },
  recipient: { id: "123" },
  timestamp: 1000,
  message: { mid: "m1", text: "hello" },
};
const comment = {
  field: "comments",
  value: { id: "c1", from: { id: "456" }, media: { id: "789" }, text: "comment", parent_id: "parent" },
};

test("Instagram channel event seam preserves parser content ordering and postback distinctions", () => {
  const body = bytes({
    object: "instagram",
    entry: [
      {
        id: "123",
        changes: [comment],
        messaging: [
          message,
          {
            ...message,
            message: undefined,
            postback: { mid: "p1", title: "confirm", payload: "auto-chatter:confirm:1" },
          },
          { ...message, message: { ...message.message, is_echo: true } },
          { ...message, message: { ...message.message, is_deleted: true } },
          { ...message, is_self: true },
          { ...message, message: undefined, postback: { mid: "bad", title: "other", payload: "arbitrary" } },
        ],
      },
    ],
  });
  const events = instagramAdapter.decodeWebhook(body);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["comment", "text_message", "confirmation_postback"],
  );
  assert.equal(events[0]!.occurredAt, null);
  assert.deepEqual(partitionInstagramEvents(events), {
    comments: parseCommentEvents(body),
    messages: parseMessageEvents(body),
  });
  assert.throws(() =>
    partitionInstagramEvents([{ ...events[0]!, account: { channel: "test-only", accountId: "123" } }]),
  );
  assert.throws(() => partitionInstagramEvents([{ ...events[0]!, actor: { kind: "dm_recipient", value: "456" } }]));
  assert.throws(() => partitionInstagramEvents([{ ...events[1]!, receipt: { family: "comment", providerId: "m1" } }]));
  assert.deepEqual(instagramAdapter.decodeWebhook(bytes({ object: "instagram", entry: [] })), []);
  for (const body of [
    bytes({ object: "other", entry: [] }),
    bytes({ object: "instagram", entry: [{ id: "123", changes: [{ field: "comments", value: {} }] }] }),
    bytes(null),
  ])
    assert.throws(() => instagramAdapter.decodeWebhook(body));
});

test("Instagram capability variants describe implemented support without provider authorization", () => {
  for (const surface of ["cloudflare_oauth", "node_instagram", "node_facebook"] as const) {
    const caps = instagramCapabilities(surface);
    assert.equal(checkCapability(caps, "comment_private_reply", "text"), true);
    assert.equal(checkCapability(caps, "manual_reply", "text"), surface === "cloudflare_oauth");
    assert.equal(checkCapability(caps, "follow_reply", "text"), surface !== "node_facebook");
    assert.equal(caps.templates.confirmation_postback, surface !== "node_facebook");
    assert.equal(caps.templates.approved_message, false);
    for (const type of ["attachment", "provider_template"])
      assert.equal(checkCapability(caps, "manual_reply", type), false);
    assert.equal(checkCapability(caps, "marketing", "text"), false);
    assert.equal(Object.isFrozen(caps.operations.manual_reply.content_types), true);
  }
});

test("Instagram outcome classification preserves known no-send refusals and ambiguous sends", () => {
  assert.deepEqual(instagramAdapter.acceptSendResult({ messageId: " message " }), {
    kind: "accepted",
    messageId: " message ",
  });
  for (const value of [null, {}, { messageId: " " }, { messageId: 1 }])
    assert.throws(() => instagramAdapter.acceptSendResult(value));
  assert.deepEqual(instagramAdapter.classifySendError(new PreSendVerificationError("retry", "token_rotated")), {
    kind: "not_attempted",
    disposition: "retry",
    code: "token_rotated",
  });
  assert.deepEqual(instagramAdapter.classifySendError(new PreSendVerificationError("block", "recipient_opted_out")), {
    kind: "not_attempted",
    disposition: "block",
    code: "recipient_opted_out",
  });
  assert.deepEqual(instagramAdapter.classifySendError(new ProviderRateLimitedError(4, 2000)), {
    kind: "refused",
    refusal: "rate_limited",
    code: "meta_error_4",
    retryAfterSeconds: 2000,
  });
  assert.deepEqual(instagramAdapter.classifySendError(new ProviderRejectedError(10)), {
    kind: "refused",
    refusal: "other",
    code: "meta_error_10",
    retryAfterSeconds: null,
  });
  for (const error of [
    new Error("private provider body"),
    { name: "ProviderRejectedError", failureCode: "token-secret" },
    null,
  ])
    assert.deepEqual(instagramAdapter.classifySendError(error), { kind: "unknown", code: "send_outcome_unknown" });
});
