import assert from "node:assert/strict";
import { test } from "node:test";
import { isMetaTokenRejection, metaTokenRejected, type IdentityCheck } from "./meta-graph-error.ts";
import { InstagramLoginPrivateReplyTransport } from "./instagram-login-private-reply.ts";
import { InstagramFollowTransport } from "./follow-transport.ts";
import type { PrivateReplyRequest } from "./reply-worker.ts";

const connectionId = "22222222-2222-4222-8222-222222222222";

function graphError(status: number, error: Record<string, unknown> | null): Response {
  return new Response(error === null ? "not json" : JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a token rejection is HTTP 401 or a 400/403 Graph code 10, 190 or 200-299", () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    assert.equal(isMetaTokenRejection(status, undefined), status === 401, `status ${status}`);
  }
  for (const code of [10, 190, 200, 250, 299]) {
    assert.equal(isMetaTokenRejection(400, code), true, `code ${code}`);
    assert.equal(isMetaTokenRejection(403, code), true, `code ${code}`);
    // Only a 400 or 403 body counts, so the same code with another status is not a rejection.
    assert.equal(isMetaTokenRejection(429, code), false, `429 code ${code}`);
    assert.equal(isMetaTokenRejection(500, code), false, `500 code ${code}`);
  }
  for (const code of [1, 2, 4, 17, 32, 100, 199, 300, 613, "190", null, undefined])
    assert.equal(isMetaTokenRejection(400, code), false, `code ${String(code)}`);
});

test("metaTokenRejected reads a copy of the body, so the response can still be read", async () => {
  const rejected = graphError(400, { code: 190, message: "Invalid OAuth access token" });
  assert.equal(await metaTokenRejected(rejected), true);
  assert.deepEqual(await rejected.json(), { error: { code: 190, message: "Invalid OAuth access token" } });
  assert.equal(await metaTokenRejected(graphError(401, null)), true);
  assert.equal(await metaTokenRejected(graphError(403, { code: 200 })), true);
  // Rate limits, transient errors, server errors and unreadable bodies are not rejections.
  assert.equal(await metaTokenRejected(graphError(400, { code: 4 })), false);
  assert.equal(await metaTokenRejected(graphError(400, { code: 2, is_transient: true })), false);
  assert.equal(await metaTokenRejected(graphError(429, { code: 190 })), false);
  assert.equal(await metaTokenRejected(graphError(500, { code: 190 })), false);
  assert.equal(await metaTokenRejected(graphError(400, null)), false);
  assert.equal(await metaTokenRejected(new Response("{}", { status: 200 })), false);
});

const request: PrivateReplyRequest = {
  id: "1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  connectionId,
  accountId: "789",
  commentId: "111",
  mediaId: "222",
  senderId: "333",
  text: "reply",
};

function identityFetch(me: () => Response): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/me")) return me();
    if (url.pathname.endsWith("/222")) return Response.json({ id: "222", owner: { id: "789" } });
    return Response.json({
      id: "111",
      from: { id: "333" },
      media: { id: "222" },
      timestamp: new Date().toISOString(),
    });
  };
}

test("both transports report an accepted or rejected identity read and nothing else", async () => {
  const cases: Array<[string, () => Response, IdentityCheck[]]> = [
    ["accepted", () => Response.json({ user_id: "789" }), ["verified"]],
    ["rejected 401", () => graphError(401, { code: 190 }), ["rejected"]],
    ["rejected code 190", () => graphError(400, { code: 190 }), ["rejected"]],
    ["permission code 10", () => graphError(403, { code: 10 }), ["rejected"]],
    ["other account", () => Response.json({ user_id: "999" }), []],
    ["throttled", () => graphError(400, { code: 4 }), []],
    ["server error", () => graphError(500, { code: 190 }), []],
  ];
  for (const [label, me, expected] of cases) {
    const reported: IdentityCheck[] = [];
    const onIdentity = async (check: IdentityCheck) => {
      reported.push(check);
    };
    const reply = new InstagramLoginPrivateReplyTransport({
      graphVersion: "v25.0",
      accessToken: "token",
      accountId: "789",
      connectionId,
      fetchImpl: identityFetch(me),
      onIdentity,
    });
    await reply.verify(request).catch(() => undefined);
    assert.deepEqual(reported, expected, `private reply: ${label}`);
    reported.length = 0;
    const follow = new InstagramFollowTransport({
      graphVersion: "v25.0",
      accessToken: "token",
      accountId: "789",
      fetchImpl: identityFetch(me),
      onIdentity,
    });
    await follow.verifyAccount().catch(() => undefined);
    assert.deepEqual(reported, expected, `follow: ${label}`);
  }
});

test("an observer that throws never changes a verification result", async () => {
  const onIdentity = async () => {
    throw new Error("database unavailable");
  };
  for (const [me, verified] of [
    [() => Response.json({ user_id: "789" }), true],
    [() => graphError(401, { code: 190 }), false],
  ] as const) {
    const reply = new InstagramLoginPrivateReplyTransport({
      graphVersion: "v25.0",
      accessToken: "token",
      accountId: "789",
      connectionId,
      fetchImpl: identityFetch(me),
      onIdentity,
    });
    assert.equal((await reply.verify(request)).authorizationVerified, verified);
    const follow = new InstagramFollowTransport({
      graphVersion: "v25.0",
      accessToken: "token",
      accountId: "789",
      fetchImpl: identityFetch(me),
      onIdentity,
    });
    assert.equal(await follow.verifyAccount(), verified);
  }
});
