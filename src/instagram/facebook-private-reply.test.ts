import assert from "node:assert/strict";
import { test } from "node:test";
import { FacebookPrivateReplyTransport, type FacebookPrivateReplyConfig } from "./facebook-private-reply.ts";
import { PreSendVerificationError } from "./reply-worker.ts";
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
          expires_at: 0,
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
