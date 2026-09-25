import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InstagramLoginPrivateReplyTransport,
  type InstagramLoginPrivateReplyConfig,
} from "./instagram-login-private-reply.ts";
import { PreSendVerificationError, ProviderRateLimitedError, type PrivateReplyRequest } from "./reply-worker.ts";

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
    commentResponse?: () => Response;
    sendResponse?: () => Response;
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
      if (overrides.commentResponse) return overrides.commentResponse();
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
      if (overrides.sendResponse) return overrides.sendResponse();
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

test("a malformed POST response remains outcome unknown", async () => {
  for (const overrides of [{ sendStatus: 400 }, { sendMalformedError: true }]) {
    const graph = mockGraph(overrides);
    const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
    await assert.rejects(
      transport.send(request),
      (error: unknown) =>
        error instanceof Error &&
        error.constructor === Error &&
        error.message === "Meta private reply outcome is unknown",
    );
    assert.equal(graph.calls.filter(({ url }) => url.pathname.endsWith("/messages")).length, 1);
  }
});

test("a throttle code in a 4xx POST body is a retryable rate limit", async () => {
  for (const status of [400, 403, 429]) {
    for (const code of [4, 17, 32, 613]) {
      const graph = mockGraph({
        sendResponse: () => graphResponse({ error: { code, is_transient: true } }, status),
      });
      const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
      await assert.rejects(
        transport.send(request),
        (error: unknown) =>
          error instanceof ProviderRateLimitedError &&
          error.failureCode === `meta_error_${code}` &&
          error.retryAfterSeconds === null,
      );
      assert.equal(graph.calls.filter(({ url }) => url.pathname.endsWith("/messages")).length, 1);
    }
  }
});

test("a valid Retry-After header is carried on the rate limit", async () => {
  for (const [header, expected] of [
    ["7200", 7200],
    ["Fri, 25 Sep 2026 02:00:00 GMT", 7200],
    ["Thu, 24 Sep 2026 23:00:00 GMT", null],
    ["soon", null],
    ["-5", null],
  ] as const) {
    const graph = mockGraph({
      sendResponse: () =>
        new Response(JSON.stringify({ error: { code: 4 } }), {
          status: 400,
          headers: { "content-type": "application/json", "retry-after": header },
        }),
    });
    const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
    await assert.rejects(
      transport.send(request),
      (error: unknown) => error instanceof ProviderRateLimitedError && error.retryAfterSeconds === expected,
    );
  }
});

test("an ambiguous POST failure stays outcome unknown rather than rate limited", async () => {
  for (const [sendResponse, message] of [
    [() => graphResponse({ error: { code: 100, is_transient: true } }, 400), "Meta Graph transient error code 100"],
    [() => new Response(null, { status: 429 }), "Meta Graph HTTP 429"],
    [() => graphResponse({ error: { code: 100 } }, 429), "Meta Graph HTTP 429"],
    [() => graphResponse({ error: { code: 4 } }, 503), "Meta Graph HTTP 503"],
    [
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      "Meta Graph request failed",
    ],
    [
      () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
      "Meta Graph response was invalid",
    ],
  ] as const) {
    const graph = mockGraph({ sendResponse });
    const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
    await assert.rejects(
      transport.send(request),
      (error: unknown) => error instanceof Error && error.constructor === Error && error.message === message,
    );
    assert.equal(graph.calls.filter(({ url }) => url.pathname.endsWith("/messages")).length, 1);
  }
});

test("an empty-body 429 on a lookup keeps the reply retryable before any POST", async () => {
  const graph = mockGraph({ commentResponse: () => new Response(null, { status: 429 }) });
  const transport = new InstagramLoginPrivateReplyTransport(config(graph.fetchImpl));
  await assert.rejects(transport.verify(request), /Meta Graph HTTP 429/);
  await assert.rejects(
    transport.send(request),
    (error: unknown) => error instanceof PreSendVerificationError && error.disposition === "retry",
  );
  assert.equal(
    graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
    false,
  );
});
