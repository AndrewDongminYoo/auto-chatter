import assert from "node:assert/strict";
import { test } from "node:test";
import { FacebookPrivateReplyTransport, type FacebookPrivateReplyConfig } from "./facebook-private-reply.ts";
import { PreSendVerificationError, ProviderRateLimitedError } from "./reply-worker.ts";
import type { PrivateReplyRequest } from "./reply-worker.ts";

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

interface MockGraph {
  calls: Array<{ url: URL; init: RequestInit }>;
  fetchImpl: typeof fetch;
}

function graphResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockGraph(
  overrides: {
    scopes?: string[];
    pageAccountId?: string;
    pageTasks?: string[];
    commentMediaId?: string;
    mediaOwnerId?: string;
    commentTimestamp?: string;
    sendStatus?: number;
    commentErrorCode?: number;
    sendErrorCode?: number;
    commentResponse?: () => Response;
    sendResponse?: () => Response;
    expiresAt?: number;
    dataAccessExpiresAt?: number;
    failSecondDebug?: boolean;
  } = {},
): MockGraph {
  const calls: MockGraph["calls"] = [];
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({ url, init });
    assert.equal(url.hostname, "graph.facebook.com");
    if (url.pathname === "/v25.0/debug_token") {
      if (overrides.failSecondDebug && calls.filter((call) => call.url.pathname === url.pathname).length === 2) {
        return graphResponse({ error: { message: "temporary" } }, 503);
      }
      assert.equal(url.searchParams.get("input_token"), "user-token");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer app-token");
      return graphResponse({
        data: {
          app_id: "123",
          is_valid: true,
          expires_at: overrides.expiresAt ?? 0,
          data_access_expires_at: overrides.dataAccessExpiresAt ?? 0,
          scopes: overrides.scopes ?? [
            "pages_show_list",
            "instagram_basic",
            "instagram_manage_comments",
            "pages_read_engagement",
            "pages_messaging",
          ],
        },
      });
    }
    if (url.pathname === "/v25.0/me/accounts") {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer user-token");
      return graphResponse({
        data: [
          {
            id: "456",
            access_token: "page-token",
            tasks: overrides.pageTasks ?? ["MESSAGING"],
            instagram_business_account: { id: overrides.pageAccountId ?? "789" },
          },
        ],
      });
    }
    if (url.pathname === "/v25.0/111") {
      assert.equal(url.searchParams.get("fields"), "id,from,media,timestamp");
      if (overrides.commentResponse) return overrides.commentResponse();
      if (overrides.commentErrorCode !== undefined)
        return graphResponse({ error: { code: overrides.commentErrorCode } }, 400);
      return graphResponse({
        id: "111",
        from: { id: "333" },
        media: { id: overrides.commentMediaId ?? "222" },
        timestamp: overrides.commentTimestamp ?? "2026-09-24T00:00:00+0000",
      });
    }
    if (url.pathname === "/v25.0/222") {
      assert.equal(url.searchParams.get("fields"), "id,owner,media_product_type");
      return graphResponse({ id: "222", owner: { id: overrides.mediaOwnerId ?? "789" }, media_product_type: "FEED" });
    }
    if (url.pathname === "/v25.0/456/messages") {
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer page-token");
      assert.deepEqual(JSON.parse(String(init.body)), {
        recipient: { comment_id: "111" },
        message: { text: "자료 링크입니다" },
      });
      if (overrides.sendResponse) return overrides.sendResponse();
      if (overrides.sendErrorCode !== undefined)
        return graphResponse({ error: { code: overrides.sendErrorCode } }, 400);
      return graphResponse({ message_id: "mid-123" }, overrides.sendStatus ?? 200);
    }
    throw new Error(`Unexpected Graph path: ${url.pathname}`);
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

function config(fetchImpl: typeof fetch): FacebookPrivateReplyConfig {
  return {
    graphVersion: "v25.0",
    appId: "123",
    appAccessToken: "app-token",
    userAccessToken: "user-token",
    pageId: "456",
    accountId: "789",
    connectionId,
    fetchImpl,
    now: () => new Date("2026-09-25T00:00:00.000Z"),
  };
}

test("verifies token scopes, Page task, comment time and media ownership before a private reply", async () => {
  const graph = mockGraph();
  const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
  assert.deepEqual(await transport.inspectPermissions(), { verified: true });
  const verified = await transport.verify(request);
  assert.deepEqual(verified, {
    commentCreatedAt: new Date("2026-09-24T00:00:00.000Z"),
    authorizationVerified: true,
    mediaOwned: true,
  });
  assert.equal(
    graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
    false,
  );
  assert.deepEqual(await transport.send(request), { messageId: "mid-123" });
  assert.equal(graph.calls.filter(({ url }) => url.pathname.endsWith("/messages")).length, 1);
});

test("missing messaging scope or Page task cannot authorize a send", async () => {
  for (const overrides of [
    { scopes: ["pages_show_list", "instagram_basic", "instagram_manage_comments", "pages_read_engagement"] },
    { pageTasks: ["MANAGE"] },
    { pageAccountId: "999" },
  ]) {
    const graph = mockGraph(overrides);
    const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
    assert.equal((await transport.inspectPermissions()).verified, false);
    assert.equal((await transport.verify(request)).authorizationVerified, false);
    await assert.rejects(transport.send(request));
    assert.equal(
      graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
      false,
    );
  }
});

test("a mismatched comment or media owner cannot pass verification", async () => {
  for (const overrides of [{ commentMediaId: "999" }, { mediaOwnerId: "999" }]) {
    const graph = mockGraph(overrides);
    const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
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

test("a direct send cannot bypass the seven-day comment window", async () => {
  const graph = mockGraph({ commentTimestamp: "2026-09-18T00:00:00+0000" });
  const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
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

test("an uncertain Graph send does not produce a success result", async () => {
  const graph = mockGraph({ sendStatus: 503 });
  const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
  await assert.rejects(transport.send(request), /Meta Graph HTTP 503/);
});

test("a Graph lookup failure inside send is identified as pre-send", async () => {
  const graph = mockGraph({ failSecondDebug: true });
  const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
  assert.equal((await transport.verify(request)).authorizationVerified, true);
  await assert.rejects(transport.send(request), PreSendVerificationError);
  assert.equal(
    graph.calls.some(({ url }) => url.pathname.endsWith("/messages")),
    false,
  );
});

test("invalid reply input is blocked before any provider POST", async () => {
  for (const invalid of [
    { ...request, connectionId: "other" },
    { ...request, text: "  " },
  ]) {
    const graph = mockGraph();
    const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
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
    const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
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

test("a clear Graph POST rejection retains its Meta error code", async () => {
  const graph = mockGraph({ sendErrorCode: 100 });
  const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
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

test("a throttle code in a 4xx POST body is a retryable rate limit with its Retry-After", async () => {
  for (const status of [400, 429]) {
    for (const code of [4, 17, 32, 613]) {
      const graph = mockGraph({
        sendResponse: () =>
          new Response(JSON.stringify({ error: { code } }), {
            status,
            headers: { "content-type": "application/json", "retry-after": "5400" },
          }),
      });
      const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
      await assert.rejects(
        transport.send(request),
        (error: unknown) =>
          error instanceof ProviderRateLimitedError &&
          error.failureCode === `meta_error_${code}` &&
          error.retryAfterSeconds === 5400,
      );
      assert.equal(graph.calls.filter(({ url }) => url.pathname.endsWith("/messages")).length, 1);
    }
  }
});

test("an ambiguous POST failure stays outcome unknown rather than rate limited", async () => {
  for (const [sendResponse, message] of [
    [() => graphResponse({ error: { code: 4 } }, 302), "Meta Graph HTTP 302"],
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
    const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
    await assert.rejects(
      transport.send(request),
      (error: unknown) => error instanceof Error && error.constructor === Error && error.message === message,
    );
    assert.equal(graph.calls.filter(({ url }) => url.pathname.endsWith("/messages")).length, 1);
  }
});

test("an empty-body 429 on a lookup keeps the reply retryable before any POST", async () => {
  const graph = mockGraph({ commentResponse: () => new Response(null, { status: 429 }) });
  const transport = new FacebookPrivateReplyTransport(config(graph.fetchImpl));
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

test("token expiration uses the injected policy clock", async () => {
  const expiresAt = Date.parse("2026-09-26T00:00:00.000Z") / 1000;
  for (const [overrides, reason] of [
    [{ expiresAt }, "user_token_expired"],
    [{ dataAccessExpiresAt: expiresAt }, "data_access_expired"],
  ] as const) {
    const graph = mockGraph(overrides);
    const transport = new FacebookPrivateReplyTransport({
      ...config(graph.fetchImpl),
      now: () => new Date("2026-09-27T00:00:00.000Z"),
    });
    assert.deepEqual(await transport.inspectPermissions(), { verified: false, reason });
  }
});
