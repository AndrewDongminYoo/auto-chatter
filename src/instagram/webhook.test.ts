import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommentEvents, verifySignature, verifySubscription } from "./webhook.ts";

test("subscription challenge requires one matching token and subscribe mode", () => {
  const valid = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "local-test-token",
    "hub.challenge": "challenge-123",
  });

  assert.equal(verifySubscription(valid, "local-test-token"), "challenge-123");
  assert.equal(verifySubscription(valid, "wrong-token"), null);
  assert.equal(verifySubscription(valid, ""), null);

  valid.append("hub.verify_token", "local-test-token");
  assert.equal(verifySubscription(valid, "local-test-token"), null);
  valid.set("hub.verify_token", "local-test-token");
  valid.set("hub.mode", "unsubscribe");
  assert.equal(verifySubscription(valid, "local-test-token"), null);
});

test("signature verifies the exact raw body and rejects malformed headers", () => {
  const body = Buffer.from('{"object":"instagram","entry":[]}');
  const signature = "sha256=fd560cdf8633c797205dabdc729d4b0c41c1d9f10a87b152c2559ec3676f4488";

  assert.equal(verifySignature(body, signature, "test-secret"), true);
  assert.equal(verifySignature(Buffer.concat([body, Buffer.from(" ")]), signature, "test-secret"), false);
  assert.equal(verifySignature(body, signature.slice(0, -2), "test-secret"), false);
  assert.equal(verifySignature(body, null, "test-secret"), false);
  assert.equal(verifySignature(body, signature, ""), false);
});

test("comment events normalize both supported webhook shapes without changing text", () => {
  const payload = {
    object: "instagram",
    entry: [
      {
        id: "account-1",
        field: "comments",
        value: {
          id: "comment-1",
          text: "  안내  ",
          from: { id: "sender-1" },
          media: { id: "post-1" },
        },
      },
      {
        id: "account-2",
        changes: [
          { field: "messages", value: { id: "message-1" } },
          {
            field: "comments",
            value: {
              id: "comment-2",
              text: "자료",
              parent_id: "parent-1",
              from: { id: "sender-2" },
              media: { id: "reel-1" },
            },
          },
        ],
      },
    ],
  };

  assert.deepEqual(parseCommentEvents(Buffer.from(JSON.stringify(payload))), [
    {
      accountId: "account-1",
      commentId: "comment-1",
      postId: "post-1",
      senderId: "sender-1",
      text: "  안내  ",
    },
    {
      accountId: "account-2",
      commentId: "comment-2",
      postId: "reel-1",
      senderId: "sender-2",
      parentId: "parent-1",
      text: "자료",
    },
  ]);
});

test("a recognized comment missing its post identifier is rejected", () => {
  const payload = {
    object: "instagram",
    entry: [
      {
        id: "account-1",
        field: "comments",
        value: { id: "comment-1", text: "자료", from: { id: "sender-1" } },
      },
    ],
  };

  assert.throws(() => parseCommentEvents(Buffer.from(JSON.stringify(payload))), /comment event/i);
});

test("non-Instagram payloads are rejected", () => {
  assert.throws(() => parseCommentEvents(Buffer.from('{"object":"page","entry":[]}')), /Instagram webhook/i);
});
