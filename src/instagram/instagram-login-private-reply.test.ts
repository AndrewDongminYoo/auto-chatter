import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InstagramLoginPrivateReplyTransport,
  type InstagramLoginPrivateReplyConfig,
} from "./instagram-login-private-reply.ts";
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

function mockGraph(
  overrides: {
    userId?: string;
    profileAsData?: boolean;
    commentMediaId?: string;
    mediaOwnerId?: string;
    commentTimestamp?: string;
    failSecondProfile?: boolean;
    sendStatus?: number;
    commentErrorCode?: number;
    commentErrorStatus?: number;
    commentErrorTransient?: boolean;
    sendErrorCode?: number;
    sendMalformedError?: boolean;
  } = {},
): { calls: Array<{ url: URL; init: RequestInit }>; fetchImpl: typeof fetch } {
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
      if (overrides.commentErrorCode !== undefined)
        return graphResponse(
          { error: { code: overrides.commentErrorCode, is_transient: overrides.commentErrorTransient ?? false } },
          overrides.commentErrorStatus ?? 400,
        );
      return graphResponse({
        id: "111",
        from: { id: "333" },
        media: { id: overrides.commentMediaId ?? "222" },
        timestamp: overrides.commentTimestamp ?? "2026-09-24T00:00:00+0000",
      });
    }
    if (url.pathname === "/v25.0/222") {
      assert.equal(url.searchParams.get("fields"), "id,owner");
      return graphResponse({ id: "222", owner: { id: overrides.mediaOwnerId ?? "789" } });
    }
    if (url.pathname === "/v25.0/789/messages") {
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), {
        recipient: { comment_id: "111" },
        message: { text: "자료 링크입니다" },
      });
      if (overrides.sendErrorCode !== undefined)
        return graphResponse({ error: { code: overrides.sendErrorCode } }, 400);
      if (overrides.sendMalformedError) return graphResponse({ error: {} }, 400);
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
  assert.equal(
    graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
    false,
  );
  assert.deepEqual(await transport.send(request), { messageId: "mid-instagram" });
  assert.equal(graph.calls.filter(({ url }) => url.pathname.endsWith("/messages")).length, 1);
});

test("a token for another Instagram account cannot authorize a send", async () => {
  const graph = mockGraph({ userId: "999" });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  assert.deepEqual(await transport.inspectAccount(), { verified: false, reason: "account_mismatch" });
  assert.equal((await transport.verify(request)).authorizationVerified, false);
  await assert.rejects(transport.send(request), PreSendVerificationError);
  assert.equal(
    graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
    false,
  );
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
  await assert.rejects(
    transport.send(request),
    (error: unknown) =>
      error instanceof PreSendVerificationError &&
      error.disposition === "block" &&
      error.failureCode === "invalid_request",
  );
  assert.equal(
    graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
    false,
  );
});

test("comment and media ownership mismatches block the send", async () => {
  for (const overrides of [{ commentMediaId: "999" }, { mediaOwnerId: "999" }]) {
    const graph = mockGraph(overrides);
    const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
    assert.equal((await transport.verify(request)).mediaOwned, false);
    await assert.rejects(
      transport.send(request),
      (error: unknown) =>
        error instanceof PreSendVerificationError &&
        error.disposition === "block" &&
        error.failureCode === "media_unverified",
    );
    assert.equal(
      graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
      false,
    );
  }
});

test("a direct Instagram Login send cannot bypass the seven-day window", async () => {
  const graph = mockGraph({ commentTimestamp: "2026-09-18T00:00:00+0000" });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  await assert.rejects(
    transport.send(request),
    (error: unknown) =>
      error instanceof PreSendVerificationError &&
      error.disposition === "block" &&
      error.failureCode === "comment_expired",
  );
  assert.equal(
    graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
    false,
  );
});

test("a read-only failure inside send is marked pre-send", async () => {
  const graph = mockGraph({ failSecondProfile: true });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  assert.equal((await transport.verify(request)).authorizationVerified, true);
  await assert.rejects(
    transport.send(request),
    (error: unknown) => error instanceof PreSendVerificationError && error.disposition === "retry",
  );
  assert.equal(
    graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
    false,
  );
});

test("a failed Instagram send has an unknown outcome", async () => {
  const graph = mockGraph({ sendStatus: 503 });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  await assert.rejects(transport.send(request), /Meta Graph HTTP 503/);
});

test("invalid reply input is blocked before any provider POST", async () => {
  for (const invalid of [
    { ...request, connectionId: "other" },
    { ...request, text: "  " },
  ]) {
    const graph = mockGraph();
    const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
    await assert.rejects(
      transport.send(invalid),
      (error: unknown) =>
        error instanceof PreSendVerificationError &&
        error.disposition === "block" &&
        error.failureCode === "invalid_request",
    );
    assert.equal(
      graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
      false,
    );
  }
});

test("a Graph throttle code in HTTP 400 keeps a pre-send lookup retryable", async () => {
  for (const code of [4, 17, 32, 613]) {
    const graph = mockGraph({ commentErrorCode: code });
    const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
    await assert.rejects(transport.verify(request), new RegExp(`Meta Graph transient error code ${code}`));
    await assert.rejects(
      transport.send(request),
      (error: unknown) => error instanceof PreSendVerificationError && error.disposition === "retry",
    );
    assert.equal(
      graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
      false,
    );
  }
});

test("a transient Graph error in HTTP 403 keeps a pre-send lookup retryable", async () => {
  const graph = mockGraph({ commentErrorCode: 100, commentErrorStatus: 403, commentErrorTransient: true });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  await assert.rejects(transport.verify(request), /Meta Graph transient error code 100/);
  await assert.rejects(
    transport.send(request),
    (error: unknown) => error instanceof PreSendVerificationError && error.disposition === "retry",
  );
  assert.equal(
    graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
    false,
  );
});

test("a clear Graph POST rejection retains its Meta error code", async () => {
  const graph = mockGraph({ sendErrorCode: 100 });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  await assert.rejects(
    transport.send(request),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "ProviderRejectedError" &&
      "failureCode" in error &&
      error.failureCode === "meta_error_100",
  );
  assert.equal(graph.calls.filter(({ url }) => url.pathname.endsWith("/messages")).length, 1);
});

test("a throttled or malformed POST response remains outcome unknown", async () => {
  for (const overrides of [{ sendErrorCode: 4 }, { sendStatus: 400 }, { sendMalformedError: true }]) {
    const graph = mockGraph(overrides);
    const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
    const expectedMessage =
      "sendErrorCode" in overrides ? "Meta Graph transient error code 4" : "Meta private reply outcome is unknown";
    await assert.rejects(
      transport.send(request),
      (error: unknown) => error instanceof Error && error.constructor === Error && error.message === expectedMessage,
    );
    assert.equal(graph.calls.filter(({ url }) => url.pathname.endsWith("/messages")).length, 1);
  }
});
