import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePrivateReply, type PrivateReplyPolicyInput } from "./reply-policy.ts";

const now = new Date("2026-09-25T00:00:00.000Z");

function eligibleInput(overrides: Partial<PrivateReplyPolicyInput> = {}): PrivateReplyPolicyInput {
  return {
    now,
    commentCreatedAt: new Date("2026-09-19T00:00:00.000Z"),
    connectionActive: true,
    authorizationVerified: true,
    mediaOwned: true,
    isOwnComment: false,
    ...overrides,
  };
}

test("a verified reply within seven days is eligible", () => {
  assert.deepEqual(evaluatePrivateReply(eligibleInput()), { eligible: true });
});

test("the seven-day boundary and older comments are rejected", () => {
  assert.deepEqual(evaluatePrivateReply(eligibleInput({ commentCreatedAt: new Date("2026-09-18T00:00:00.000Z") })), {
    eligible: false,
    reason: "comment_expired",
  });
  assert.deepEqual(evaluatePrivateReply(eligibleInput({ commentCreatedAt: new Date("2026-09-17T00:00:00.000Z") })), {
    eligible: false,
    reason: "comment_expired",
  });
});

test("a missing, invalid, or future comment creation time cannot authorize a send", () => {
  for (const commentCreatedAt of [null, new Date("invalid"), new Date("2026-09-25T00:00:01.000Z")]) {
    assert.deepEqual(evaluatePrivateReply(eligibleInput({ commentCreatedAt })), {
      eligible: false,
      reason: "comment_time_unverified",
    });
  }
});

test("inactive connection, missing authorization, and unowned media block a reply", () => {
  assert.deepEqual(evaluatePrivateReply(eligibleInput({ connectionActive: false })), {
    eligible: false,
    reason: "inactive_connection",
  });
  assert.deepEqual(evaluatePrivateReply(eligibleInput({ authorizationVerified: false })), {
    eligible: false,
    reason: "authorization_unverified",
  });
  assert.deepEqual(evaluatePrivateReply(eligibleInput({ mediaOwned: false })), {
    eligible: false,
    reason: "media_unverified",
  });
});

test("the account does not privately reply to its own comment", () => {
  assert.deepEqual(evaluatePrivateReply(eligibleInput({ isOwnComment: true })), {
    eligible: false,
    reason: "own_comment",
  });
});
