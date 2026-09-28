import assert from "node:assert/strict";
import { test } from "node:test";
import { appApi } from "./api.ts";
import type { Pool } from "pg";
import { sealSecret } from "./secrets.ts";
const config = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "public-test-key",
  AUTH_IP_LIMIT: { limit: async () => ({ success: true }) },
  AUTH_EMAIL_LIMIT: { limit: async () => ({ success: true }) },
};
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
    assert.equal(init?.redirect, "manual");
    return Response.json(url.pathname.endsWith("/me") ? { id: "999", user_id: "123" } : media);
  }) as typeof fetch;
}
const mediaRequest = (suffix = "") =>
  new Request(`https://app.test/api/connections/${connectionId}/media${suffix}`, {
    headers: { cookie: "__Host-ac-access=test-session" },
  });

test("recovery endpoints require same-origin POST and never open the workspace database", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(new URL(String(input)).pathname);
    return new URL(String(input)).pathname.endsWith("/recover")
      ? Response.json({})
      : new URL(String(input)).pathname.endsWith("/user")
        ? Response.json({ id: userId })
        : new Response(null, { status: 204 });
  }) as typeof fetch;
  const noPool = () => {
    throw new Error("authentication must not open product database");
  };
  const request = (path: string, body: unknown, origin = "https://app.test") =>
    new Request("https://app.test" + path, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const rejected = await appApi(
    request("/api/auth/recover", { email: "x@example.test" }, "https://other.test"),
    config,
    noPool,
    fetchImpl,
  );
  assert.equal(rejected.status, 403);
  assert.deepEqual(calls, []);
  const requested = await appApi(request("/api/auth/recover", { email: "x@example.test" }), config, noPool, fetchImpl);
  assert.deepEqual(await requested.json(), { recovery_requested: true });
  const updated = await appApi(
    request("/api/auth/reset-password", { access_token: "recovery-token", password: "new-password-123" }),
    config,
    noPool,
    fetchImpl,
  );
  assert.deepEqual(await updated.json(), { password_updated: true });
  assert.deepEqual(calls, ["/auth/v1/recover", "/auth/v1/user", "/auth/v1/logout"]);
});

test("rate-limited public auth requests never reach Supabase and cross-origin requests spend no allowance", async () => {
  const keys: string[] = [];
  let providerCalls = 0;
  const env = {
    ...config,
    AUTH_IP_LIMIT: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    },
  };
  const provider = (async () => {
    providerCalls++;
    throw new Error("provider must not be called");
  }) as typeof fetch;
  const request = (origin: string) =>
    new Request("https://app.test/api/auth/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
      body: JSON.stringify({ email: "person@example.test", password: "example-password" }),
    });
  assert.equal(
    (
      await appApi(
        request("https://other.test"),
        env,
        () => {
          throw new Error("no db");
        },
        provider,
      )
    ).status,
    403,
  );
  assert.deepEqual(keys, []);
  const rejected = await appApi(
    request("https://app.test"),
    env,
    () => {
      throw new Error("no db");
    },
    provider,
  );
  assert.equal(rejected.status, 429);
  assert.deepEqual(await rejected.json(), { error: "auth_rate_limited" });
  assert.equal(keys.length, 1);
  assert.equal(providerCalls, 0);
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

const healthRequest = () =>
  new Request(`https://app.test/api/connections/${connectionId}/health`, {
    headers: { cookie: "__Host-ac-access=test-session" },
  });

function healthFetch(me: Response, subscriptions?: Response) {
  const paths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "project.supabase.co")
      return Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" });
    assert.equal(url.hostname, "graph.instagram.com");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer server-token");
    assert.equal(url.searchParams.has("access_token"), false);
    paths.push(url.pathname);
    return url.pathname.endsWith("/me") ? me : (subscriptions ?? Response.json({ data: [] }));
  }) as typeof fetch;
  return { fetchImpl, paths };
}

test("connection health is workspace scoped and never probes another account", async () => {
  const graph = healthFetch(Response.json({ user_id: "123" }));
  const response = await appApi(
    healthRequest(),
    { ...mediaConfig, INSTAGRAM_OAUTH_APP_ID: "789" },
    () => mediaPool(false),
    graph.fetchImpl,
  );
  assert.equal(response.status, 404);
  assert.deepEqual(graph.paths, []);
});

test("connection health rate limit prevents Meta requests", async () => {
  const graph = healthFetch(Response.json({ user_id: "123" }));
  const response = await appApi(
    healthRequest(),
    { ...mediaConfig, AUTH_IP_LIMIT: { limit: async () => ({ success: false }) } },
    () => mediaPool(),
    graph.fetchImpl,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(graph.paths, []);
});

test("connection health distinguishes token expiry, account access and webhook subscription", async () => {
  const env = { ...mediaConfig, INSTAGRAM_OAUTH_APP_ID: "789" };
  const cases: Array<[Response, Response | undefined, string, number]> = [
    [
      Response.json({ user_id: "123" }),
      Response.json({
        data: [{ id: "unmapped-subscription", subscribed_fields: ["comments", "messages", "messaging_postbacks"] }],
      }),
      "fields_present",
      2,
    ],
    [
      Response.json({ user_id: "123" }),
      Response.json({ data: [{ id: "unmapped-subscription", subscribed_fields: ["comments", "messages"] }] }),
      "fields_missing",
      2,
    ],
    [Response.json({ user_id: "123" }), Response.json({ data: [{ id: "broken-subscription" }] }), "unverified", 2],
    [
      Response.json({ user_id: "123" }),
      Response.json({
        data: [{ id: "other", subscribed_fields: ["comments"] }],
        paging: { next: "https://graph.instagram.com/other" },
      }),
      "unverified",
      2,
    ],
    [
      Response.json({ user_id: "123" }),
      new Response(null, { status: 302, headers: { Location: "https://other.test" } }),
      "unverified",
      2,
    ],
    [Response.json({ user_id: "999" }), undefined, "reconnect_required", 1],
    [new Response("server-token denied", { status: 401 }), undefined, "reconnect_required", 1],
    [
      Response.json({ error: { code: 190, message: "server-token expired" } }, { status: 403 }),
      undefined,
      "reconnect_required",
      1,
    ],
    [new Response("server-token busy", { status: 429 }), undefined, "unverified", 1],
  ];
  for (const [me, subscriptions, expected, callCount] of cases) {
    const graph = healthFetch(me, subscriptions);
    const response = await appApi(healthRequest(), env, () => mediaPool(), graph.fetchImpl);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, expected);
    assert.equal(graph.paths.length, callCount);
    assert.equal(JSON.stringify(result).includes("server-token"), false);
  }
  for (const [token, expiry, expected] of [
    [null, new Date(Date.now() + 86400000), "missing"],
    [connection.access_token_encrypted, new Date(Date.now() - 1000), "expired"],
  ] as const) {
    const graph = healthFetch(Response.json({ user_id: "123" }));
    const pool = {
      query: async (sql: string) => ({
        rows: sql.includes("workspace_members")
          ? [{ workspace_id: workspaceId }]
          : [{ ...connection, access_token_encrypted: token, token_expires_at: expiry }],
      }),
      end: async () => {},
    } as unknown as Pool;
    const response = await appApi(healthRequest(), env, () => pool, graph.fetchImpl);
    assert.equal((await response.json()).status, expected);
    assert.deepEqual(graph.paths, []);
  }
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
  const contextResponse = await appApi(
    new Request(`https://app.test/api/connections/${connectionId}/inbox/456/context`),
    config,
    open,
  );
  assert.equal(contextResponse.status, 401);
  for (const method of ["GET", "PUT"]) {
    const response = await appApi(
      new Request(`https://app.test/api/connections/${connectionId}/inbox/456/handoff`, {
        method,
        headers: method === "PUT" ? { origin: "https://app.test" } : {},
      }),
      config,
      open,
    );
    assert.equal(response.status, 401);
  }
  const handoffOrigin = await appApi(
    new Request(`https://app.test/api/connections/${connectionId}/inbox/456/handoff`, {
      method: "PUT",
      headers: { origin: "https://attacker.test", cookie: "__Host-ac-access=test" },
    }),
    config,
    open,
  );
  assert.equal(handoffOrigin.status, 403);
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

test("custom field list is authenticated and workspace scoped", async () => {
  const pool = {
    query: async (sql: string) => ({ rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId }] : [] }),
    end: async () => {},
  } as unknown as Pool;
  const response = await appApi(
    new Request("https://app.test/api/contact-fields", {
      headers: { cookie: "__Host-ac-access=test" },
    }),
    config,
    () => pool,
    mediaFetch(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { fields: [] });
});

test("custom field mutations reject cross-origin access before database reads", async () => {
  for (const [path, method] of [
    ["/api/contact-fields", "POST"],
    ["/api/contact-fields/123", "DELETE"],
    [`/api/connections/${connectionId}/contacts/888/fields/123`, "PUT"],
  ]) {
    const response = await appApi(
      new Request(`https://app.test${path}`, {
        method,
        headers: { origin: "https://evil.test" },
      }),
      config,
      () => {
        throw new Error("Database must not be opened");
      },
    );
    assert.equal(response.status, 403);
  }
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

test("contact automation rejects unauthenticated and cross-origin writes before opening DB", async () => {
  const open = () => {
    throw new Error("DB must not be opened");
  };
  const path = `https://app.test/api/connections/${connectionId}/contacts/sender/automation`;
  assert.equal(
    (await appApi(new Request(path, { method: "PUT", headers: { origin: "https://evil.test" } }), config, open)).status,
    403,
  );
  assert.equal(
    (await appApi(new Request(path, { method: "PUT", headers: { origin: "https://app.test" } }), config, open)).status,
    401,
  );
});
