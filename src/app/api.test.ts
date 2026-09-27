import assert from "node:assert/strict";
import { test } from "node:test";
import { appApi } from "./api.ts";
import type { Pool } from "pg";
import { sealSecret } from "./secrets.ts";
const config = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key" };
const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const mediaConfig = {
  ...config,
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  META_GRAPH_VERSION: "v26.0",
};
const connection = {
  account_id: "123",
  access_token_encrypted: sealSecret("server-token", mediaConfig.TOKEN_ENCRYPTION_KEY, `${workspaceId}:123`),
  token_expires_at: new Date(Date.now() + 86400000),
};
const post = {
  id: "456",
  owner: { id: "999" },
  caption: "A recognizable post",
  media_type: "IMAGE",
  media_product_type: "FEED",
  media_url: "https://scontent.cdninstagram.com/example.jpg",
  permalink: "https://www.instagram.com/p/example/",
  timestamp: "2026-09-25T00:00:00+0000",
};
function mediaPool(owned = true) {
  return {
    query: async (sql: string) => ({
      rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId }] : owned ? [connection] : [],
    }),
    end: async () => {},
  } as unknown as Pool;
}
function mediaFetch(
  media: unknown = {
    data: [post],
    paging: { cursors: { after: "next_cursor" }, next: "https://evil.test/?access_token=secret" },
  },
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "project.supabase.co")
      return Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" });
    assert.equal(url.hostname, "graph.instagram.com");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer server-token");
    assert.equal(url.searchParams.has("access_token"), false);
    return Response.json(url.pathname.endsWith("/me") ? { id: "999", user_id: "123" } : media);
  }) as typeof fetch;
}
const mediaRequest = (suffix = "") =>
  new Request(`https://app.test/api/connections/${connectionId}/media${suffix}`, {
    headers: { cookie: "__Host-ac-access=test-session" },
  });

test("owned media list returns display metadata and an opaque cursor without credentials or provider URLs", async () => {
  const response = await appApi(mediaRequest(), mediaConfig, () => mediaPool(), mediaFetch());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.media[0].id, "456");
  assert.equal(body.media[0].caption, "A recognizable post");
  assert.equal(body.after, "next_cursor");
  assert.equal(JSON.stringify(body).includes("access_token"), false);
  assert.equal(JSON.stringify(body).includes("evil.test"), false);
});

test("another workspace's connection cannot trigger a Graph read", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    assert.equal(new URL(String(input)).hostname, "project.supabase.co");
    return Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" });
  }) as typeof fetch;
  const response = await appApi(mediaRequest(), mediaConfig, () => mediaPool(false), fetchImpl);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "connection_not_found" });
});

test("media detail rejects a different owner even when numeric IDs are valid", async () => {
  const response = await appApi(
    mediaRequest("/456"),
    mediaConfig,
    () => mediaPool(),
    mediaFetch({ ...post, owner: { id: "888" } }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "media_not_owned" });
});

test("media requests reject malformed cursors and account identity mismatches", async () => {
  const cursor = await appApi(mediaRequest("?after=https://evil.test"), mediaConfig, () => mediaPool(), mediaFetch());
  assert.equal(cursor.status, 400);
  const mismatched = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).hostname === "graph.instagram.com") return Response.json({ id: "999", user_id: "888" });
    return mediaFetch()(input, init);
  }) as typeof fetch;
  const identity = await appApi(mediaRequest(), mediaConfig, () => mediaPool(), mismatched);
  assert.equal(identity.status, 409);
  assert.deepEqual(await identity.json(), { error: "media_reconnect_required" });
});

test("provider failures never return provider body or credentials", async () => {
  const refused = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname.endsWith("/media"))
      return new Response("server-token provider-error", { status: 429 });
    return mediaFetch()(input, init);
  }) as typeof fetch;
  const response = await appApi(mediaRequest(), mediaConfig, () => mediaPool(), refused);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "media_unavailable" });
});

test("invalid credential expiry cannot authorize media reads", async () => {
  const pool = {
    query: async (sql: string) => ({
      rows: sql.includes("workspace_members")
        ? [{ workspace_id: workspaceId }]
        : [{ ...connection, token_expires_at: "invalid" }],
    }),
    end: async () => {},
  } as unknown as Pool;
  const response = await appApi(mediaRequest(), mediaConfig, () => pool, mediaFetch());
  assert.equal(response.status, 409);
});

test("pagination stays on Graph and passes the cursor rather than a provider next URL", async () => {
  const paged = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/media")) assert.equal(url.searchParams.get("after"), "next_cursor");
    return mediaFetch({ data: [post] })(input, init);
  }) as typeof fetch;
  const response = await appApi(mediaRequest("?after=next_cursor"), mediaConfig, () => mediaPool(), paged);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).after, null);
});

test("unsafe display URLs are removed and unsupported posts cannot be selected", async () => {
  const unsafe = await appApi(
    mediaRequest("/456"),
    mediaConfig,
    () => mediaPool(),
    mediaFetch({ ...post, media_url: "https://evil.test/track", permalink: "javascript:alert(1)" }),
  );
  assert.equal(unsafe.status, 200);
  const display = (await unsafe.json()).media[0];
  assert.equal(display.image_url, null);
  assert.equal(display.permalink, null);
  const story = await appApi(
    mediaRequest("/456"),
    mediaConfig,
    () => mediaPool(),
    mediaFetch({ ...post, media_product_type: "STORY" }),
  );
  assert.equal(story.status, 400);
});

test("image URL fragments and case-varied credential parameters never reach the browser", async () => {
  for (const [url, expected] of [
    [
      "https://scontent.cdninstagram.com/example.jpg#access_token=server-token",
      "https://scontent.cdninstagram.com/example.jpg",
    ],
    ["https://scontent.cdninstagram.com/example.jpg?Access_Token=server-token", null],
    ["https://scontent.cdninstagram.com/example.jpg?client_secret=server-token", null],
  ]) {
    const response = await appApi(
      mediaRequest("/456"),
      mediaConfig,
      () => mediaPool(),
      mediaFetch({ ...post, media_url: url }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.media[0].image_url, expected);
    assert.equal(JSON.stringify(body).includes("server-token"), false);
  }
});

test("new rule creation refuses foreign media before any rule write", async () => {
  const request = new Request("https://app.test/api/rules", {
    method: "PUT",
    headers: {
      cookie: "__Host-ac-access=test-session",
      origin: "https://app.test",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      connection_id: connectionId,
      media_id: "456",
      keywords: ["link"],
      excluded_keywords: [],
      match_mode: "contains",
      private_reply_text: "A reply",
      enabled: false,
      follow_gate_enabled: false,
    }),
  });
  const pool = mediaPool();
  const query = pool.query.bind(pool);
  pool.query = ((sql: string, ...args: unknown[]) => {
    assert.equal(sql.includes("INSERT INTO instagram_comment_rules"), false);
    return query(sql, ...(args as []));
  }) as typeof pool.query;
  const response = await appApi(request, mediaConfig, () => pool, mediaFetch({ ...post, owner: { id: "888" } }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "media_not_owned" });
});

test("fixed-target rule edits remain available without a working provider credential", async () => {
  const existingId = "44444444-4444-4444-8444-444444444444";
  const pool = {
    query: async (sql: string) => ({
      rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId }] : [{ id: existingId }],
    }),
    end: async () => {},
  } as unknown as Pool;
  const request = new Request("https://app.test/api/rules", {
    method: "PUT",
    headers: {
      cookie: "__Host-ac-access=test-session",
      origin: "https://app.test",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: existingId,
      connection_id: connectionId,
      media_id: "456",
      keywords: ["link"],
      excluded_keywords: [],
      match_mode: "contains",
      private_reply_text: "Updated reply",
      enabled: false,
      follow_gate_enabled: false,
    }),
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    assert.equal(new URL(String(input)).hostname, "project.supabase.co");
    return Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" });
  }) as typeof fetch;
  const response = await appApi(request, config, () => pool, fetchImpl);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: existingId });
});

test("API rejects unauthenticated and cross-origin requests before opening a database", async () => {
  const open = () => {
    throw new Error("DB must not be opened");
  };
  const userResponse = await appApi(new Request("https://app.test/api/rules"), config, open);
  assert.equal(userResponse.status, 401);
  const crossOrigin = await appApi(
    new Request("https://app.test/api/rules", { method: "PUT", headers: { origin: "https://attacker.test" } }),
    config,
    open,
  );
  assert.equal(crossOrigin.status, 403);
});

test("contacts API is authenticated and returns only the workspace list", async () => {
  const pool = {
    query: async (sql: string) => ({ rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId }] : [] }),
    end: async () => {},
  } as unknown as Pool;
  const response = await appApi(
    new Request("https://app.test/api/contacts", { headers: { cookie: "__Host-ac-access=test" } }),
    config,
    () => pool,
    mediaFetch(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { contacts: [], after: null });
});

test("saved segment list is authenticated and workspace scoped", async () => {
  const pool = {
    query: async (sql: string) => ({ rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId }] : [] }),
    end: async () => {},
  } as unknown as Pool;
  const response = await appApi(
    new Request("https://app.test/api/contact-segments", { headers: { cookie: "__Host-ac-access=test" } }),
    config,
    () => pool,
    mediaFetch(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { segments: [] });
});

test("segment writes reject cross-origin requests before opening the database", async () => {
  for (const [path, method] of [
    ["/api/contact-segments", "POST"],
    ["/api/contact-segments/123", "DELETE"],
  ]) {
    const response = await appApi(
      new Request(`https://app.test${path}`, { method, headers: { origin: "https://evil.test" } }),
      config,
      () => {
        throw new Error("Database must not be reached");
      },
    );
    assert.equal(response.status, 403);
  }
});

test("contact mutations reject cross-origin writes and invalid tags before a write", async () => {
  const path = `https://app.test/api/connections/${connectionId}/contacts/888`;
  const open = () => {
    throw new Error("DB must not be opened");
  };
  assert.equal(
    (await appApi(new Request(path, { method: "PATCH", headers: { origin: "https://evil.test" } }), config, open))
      .status,
    403,
  );
  const pool = {
    query: async () => {
      throw new Error("No SQL on invalid input");
    },
    end: async () => {},
  } as unknown as Pool;
  const invalid = await appApi(
    new Request(path, {
      method: "PATCH",
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      body: JSON.stringify({ tags: ["x".repeat(41)] }),
    }),
    config,
    () => pool,
    mediaFetch(),
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_contact_tags" });
});

test("contact routes accept encoded string sender IDs without changing identity", async () => {
  const sender = "sender/one% test";
  const pool = {
    query: async (sql: string, values: unknown[]) => ({
      rows: sql.includes("workspace_members")
        ? [{ workspace_id: workspaceId }]
        : values[2] === sender
          ? [{ tags: ["lead"] }]
          : [],
    }),
    end: async () => {},
  } as unknown as Pool;
  const request = new Request(
    `https://app.test/api/connections/${connectionId}/contacts/${encodeURIComponent(sender)}`,
    {
      method: "PATCH",
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      body: JSON.stringify({ tags: ["lead"] }),
    },
  );
  const result = await appApi(request, config, () => pool, mediaFetch());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { tags: ["lead"] });
});
