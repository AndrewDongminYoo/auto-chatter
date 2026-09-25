import assert from "node:assert/strict";
import { test } from "node:test";
import { InstagramLoginPrivateReplyTransport, type InstagramLoginPrivateReplyConfig } from "./instagram-login-private-reply.ts";
import { PreSendVerificationError, type PrivateReplyRequest } from "./reply-worker.ts";

const connectionId = "22222222-2222-4222-8222-222222222222";
const request: PrivateReplyRequest = {
  id: "1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  connectionId,
  accountId: "789",
  commentId: "111",
  mediaId: "222",
  senderId: "333",
  text: "자료 링크입니다",
};

function graphResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockGraph(overrides: {
  userId?: string;
  profileAsData?: boolean;
  commentMediaId?: string;
  mediaOwnerId?: string;
  commentTimestamp?: string;
  failSecondProfile?: boolean;
  sendStatus?: number;
} = {}): { calls: Array<{ url: URL; init: RequestInit }>; fetchImpl: typeof fetch } {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({ url, init });
    assert.equal(url.hostname, "graph.instagram.com");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer instagram-token");
    if (url.pathname === "/v25.0/me") {
      assert.equal(url.searchParams.get("fields"), "user_id,username");
      if (overrides.failSecondProfile && calls.filter((call) => call.url.pathname === url.pathname).length === 2) {
        return graphResponse({ error: { message: "temporary" } }, 503);
      }
      const profile = { user_id: overrides.userId ?? "789", username: "test-account" };
      return graphResponse(overrides.profileAsData ? { data: [profile] } : profile);
    }
    if (url.pathname === "/v25.0/111") {
      assert.equal(url.searchParams.get("fields"), "id,from,media,timestamp");
      return graphResponse({ id: "111", from: { id: "333" }, media: { id: overrides.commentMediaId ?? "222" }, timestamp: overrides.commentTimestamp ?? "2026-09-24T00:00:00+0000" });
    }
    if (url.pathname === "/v25.0/222") {
      assert.equal(url.searchParams.get("fields"), "id,owner");
      return graphResponse({ id: "222", owner: { id: overrides.mediaOwnerId ?? "789" } });
    }
    if (url.pathname === "/v25.0/789/messages") {
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), { recipient: { comment_id: "111" }, message: { text: "자료 링크입니다" } });
      return graphResponse({ message_id: "mid-instagram" }, overrides.sendStatus ?? 200);
    }
    throw new Error(`Unexpected Graph path: ${url.pathname}`);
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

function config(fetchImpl: typeof fetch): InstagramLoginPrivateReplyConfig {
  return {
    graphVersion: "v25.0",
    accessToken: "instagram-token",
    accountId: "789",
    connectionId,
    fetchImpl,
    now: () => new Date("2026-09-25T00:00:00.000Z"),
  };
}

test("Instagram Login checks the account, comment, and media before one private reply", async () => {
  const graph = mockGraph();
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  assert.deepEqual(await transport.inspectAccount(), { verified: true });
  assert.deepEqual(await transport.verify(request), {
    commentCreatedAt: new Date("2026-09-24T00:00:00.000Z"),
    authorizationVerified: true,
    mediaOwned: true,
  });
  assert.equal(graph.calls.some(({ url }) => url.pathname.endsWith("/messages")), false);
  assert.deepEqual(await transport.send(request), { messageId: "mid-instagram" });
  assert.equal(graph.calls.filter(({ url }) => url.pathname.endsWith("/messages")).length, 1);
});

test("a token for another Instagram account cannot authorize a send", async () => {
  const graph = mockGraph({ userId: "999" });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  assert.deepEqual(await transport.inspectAccount(), { verified: false, reason: "account_mismatch" });
  assert.equal((await transport.verify(request)).authorizationVerified, false);
  await assert.rejects(transport.send(request), PreSendVerificationError);
  assert.equal(graph.calls.some(({ url }) => url.pathname.endsWith("/messages")), false);
});

test("the documented data-wrapped profile response identifies the same account", async () => {
  const graph = mockGraph({ profileAsData: true });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  assert.deepEqual(await transport.inspectAccount(), { verified: true });
});

test("permission inspection can run without a database connection but sending cannot", async () => {
  const graph = mockGraph();
  const transport = new InstagramLoginPrivateReplyTransport({ ...config(graph.fetchImpl), connectionId: undefined });
  assert.deepEqual(await transport.inspectAccount(), { verified: true });
  await assert.rejects(transport.send(request), /Private reply connection or text is invalid/);
  assert.equal(graph.calls.some(({ url }) => url.pathname.endsWith("/messages")), false);
});

test("comment and media ownership mismatches block the send", async () => {
  for (const overrides of [{ commentMediaId: "999" }, { mediaOwnerId: "999" }]) {
    const graph = mockGraph(overrides);
    const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
    assert.equal((await transport.verify(request)).mediaOwned, false);
    await assert.rejects(transport.send(request), (error: unknown) =>
      error instanceof PreSendVerificationError && error.disposition === "block" && error.failureCode === "media_unverified");
    assert.equal(graph.calls.some(({ url }) => url.pathname.endsWith("/messages")), false);
  }
});

test("a direct Instagram Login send cannot bypass the seven-day window", async () => {
  const graph = mockGraph({ commentTimestamp: "2026-09-18T00:00:00+0000" });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  await assert.rejects(transport.send(request), (error: unknown) =>
    error instanceof PreSendVerificationError && error.disposition === "block" && error.failureCode === "comment_expired");
  assert.equal(graph.calls.some(({ url }) => url.pathname.endsWith("/messages")), false);
});

test("a read-only failure inside send is marked pre-send", async () => {
  const graph = mockGraph({ failSecondProfile: true });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  assert.equal((await transport.verify(request)).authorizationVerified, true);
  await assert.rejects(transport.send(request), (error: unknown) =>
    error instanceof PreSendVerificationError && error.disposition === "retry");
  assert.equal(graph.calls.some(({ url }) => url.pathname.endsWith("/messages")), false);
});

test("a failed Instagram send has an unknown outcome", async () => {
  const graph = mockGraph({ sendStatus: 503 });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  await assert.rejects(transport.send(request), /Meta Graph HTTP 503/);
});
