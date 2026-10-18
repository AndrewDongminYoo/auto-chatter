import assert from "node:assert/strict";
import { test } from "node:test";
import { appApi } from "./api.ts";
import type { Pool } from "pg";
import { sealSecret } from "./secrets.ts";
import { ApiError } from "./auth.ts";
import {
  CONDITION_TREE_LEAF_LIMIT,
  createContactSegment,
  parseSegmentDefinition,
  SEGMENT_REQUEST_BYTES,
  updateContactSegment,
} from "./contacts.ts";
import { createSegmentSnapshot, parseSnapshotRequest, SEGMENT_SNAPSHOT_LIMITS } from "./segment-snapshots.ts";
const config = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  AUTH_IP_LIMIT: { limit: async () => ({ success: true }) },
  AUTH_EMAIL_LIMIT: { limit: async () => ({ success: true }) },
  AUTH_MAIL_IP_LIMIT: { limit: async () => ({ success: true }) },
  AUTH_MAIL_LIMIT: { limit: async () => ({ success: true }) },
  WORKSPACE_EXPORT_LIMIT: { limit: async () => ({ success: true }) },
  CONTACT_EXPORT_LIMIT: { limit: async () => ({ success: true }) },
  INSTAGRAM_CONNECT_LIMIT: { limit: async () => ({ success: true }) },
  API_WRITE_USER_LIMIT: { limit: async () => ({ success: true }) },
  API_WRITE_WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
  INBOX_LIST_LIMIT: { limit: async () => ({ success: true }) },
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
      rows: sql.includes("workspace_members")
        ? [{ workspace_id: workspaceId, role: "owner" }]
        : owned
          ? [connection]
          : [],
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

test("Instagram review gate blocks public OAuth before database access and reports its reason", async () => {
  const fetchImpl = (async () =>
    Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch;
  const noPool = () => {
    throw new Error("review-blocked OAuth must not open the database");
  };
  const me = await appApi(
    new Request("https://app.test/api/me", { headers: { cookie: "__Host-ac-access=test-session" } }),
    config,
    noPool,
    fetchImpl,
  );
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), {
    user: { id: userId, email: "a@example.test" },
    global_send_enabled: false,
    instagram_connect_available: false,
  });
  const emptyEmail = await appApi(
    new Request("https://app.test/api/me", { headers: { cookie: "__Host-ac-access=test-session" } }),
    config,
    noPool,
    (async () => Response.json({ id: userId, email: "", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
  assert.equal((await emptyEmail.json()).instagram_connect_available, false);
  for (const [method, path] of [
    ["POST", "/api/instagram/connect"],
    ["GET", "/api/instagram/callback"],
  ]) {
    const response = await appApi(
      new Request(`https://app.test${path}`, {
        method,
        headers: {
          cookie: "__Host-ac-access=test-session",
          ...(method === "POST" ? { origin: "https://app.test" } : {}),
        },
      }),
      config,
      noPool,
      fetchImpl,
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "instagram_public_access_restricted" });
  }
});

test("Instagram review allowlist and explicit public switch permit OAuth", async () => {
  const fetchImpl = (async () =>
    Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch;
  const query = async (sql: string) => ({
    rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId, role: "owner" }] : [],
  });
  // Starting OAuth stores its state in a transaction on a client from the pool.
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
    end: async () => {},
  } as unknown as Pool;
  const request = () =>
    new Request("https://app.test/api/instagram/connect", {
      method: "POST",
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test-session" },
    });
  const oauth = {
    ...config,
    APP_ORIGIN: "https://app.test",
    INSTAGRAM_OAUTH_APP_ID: "123",
    INSTAGRAM_OAUTH_APP_SECRET: "synthetic-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    META_GRAPH_VERSION: "v26.0",
  };
  for (const access of [
    { INSTAGRAM_INTERNAL_EMAILS: "other@example.test, A@EXAMPLE.TEST " },
    { INSTAGRAM_PUBLIC_CONNECT_ENABLED: "true" },
  ]) {
    const response = await appApi(request(), { ...oauth, ...access }, () => pool, fetchImpl);
    assert.equal(response.status, 200);
    const result = (await response.json()) as { url: string };
    assert.equal(new URL(result.url).hostname, "www.instagram.com");
  }
  const disabled = await appApi(
    request(),
    { ...oauth, INSTAGRAM_PUBLIC_CONNECT_ENABLED: "TRUE" },
    () => pool,
    fetchImpl,
  );
  assert.equal(disabled.status, 403);
});

test("an agent cannot start an Instagram connection", async () => {
  const fetchImpl = (async () =>
    Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch;
  const pool = {
    query: async (sql: string) => ({
      rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId, role: "agent" }] : [],
    }),
    end: async () => {},
  } as unknown as Pool;
  const response = await appApi(
    new Request("https://app.test/api/instagram/connect", {
      method: "POST",
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test-session" },
    }),
    {
      ...config,
      APP_ORIGIN: "https://app.test",
      INSTAGRAM_OAUTH_APP_ID: "123",
      INSTAGRAM_OAUTH_APP_SECRET: "synthetic-secret",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      META_GRAPH_VERSION: "v26.0",
      INSTAGRAM_PUBLIC_CONNECT_ENABLED: "true",
    },
    () => pool,
    fetchImpl,
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "role_forbidden" });
});

test("a denied Instagram callback returns to the app with a bounded reason", async () => {
  const fetchImpl = (async (input: string | URL | Request) =>
    Response.json(
      String(input).includes("api.instagram.com")
        ? { access_token: "synthetic-token", permissions: [] }
        : { id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" },
    )) as typeof fetch;
  const pool = {
    query: async (sql: string) => ({
      rows: sql.includes("workspace_members")
        ? [{ workspace_id: workspaceId, role: "owner" }]
        : [{ state_hash: "consumed" }],
      rowCount: 1,
    }),
    end: async () => {},
  } as unknown as Pool;
  const oauth = {
    ...config,
    APP_ORIGIN: "https://app.test",
    INSTAGRAM_OAUTH_APP_ID: "123",
    INSTAGRAM_OAUTH_APP_SECRET: "synthetic-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    META_GRAPH_VERSION: "v26.0",
    INSTAGRAM_INTERNAL_EMAILS: "a@example.test",
  };
  const state = "a".repeat(64);
  const response = await appApi(
    new Request(`https://app.test/api/instagram/callback?state=${state}&error=access_denied`, {
      headers: { cookie: `__Host-ac-access=test-session; __Host-ac-oauth=${state}` },
    }),
    oauth,
    () => pool,
    fetchImpl,
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "https://app.test/app/?instagram=instagram_authorization_denied");
  assert.match(response.headers.get("Set-Cookie") ?? "", /__Host-ac-oauth=;.*Max-Age=0/);
  const missingPermissions = await appApi(
    new Request(`https://app.test/api/instagram/callback?state=${state}&code=test-code`, {
      headers: { cookie: `__Host-ac-access=test-session; __Host-ac-oauth=${state}` },
    }),
    oauth,
    () => pool,
    fetchImpl,
  );
  assert.equal(missingPermissions.status, 303);
  assert.equal(
    missingPermissions.headers.get("Location"),
    "https://app.test/app/?instagram=instagram_permissions_required",
  );
  const invalidState = await appApi(
    new Request("https://app.test/api/instagram/callback?error=access_denied", {
      headers: { cookie: "__Host-ac-access=test-session" },
    }),
    oauth,
    () => pool,
    fetchImpl,
  );
  assert.equal(invalidState.status, 400);
  assert.deepEqual(await invalidState.json(), { error: "invalid_oauth_state" });
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

test("session checks forward the caller's IP, and refresh and logout spend a per-IP allowance before Supabase (#164)", async () => {
  const forwarded: Array<string | null> = [];
  const provider = (async (_input: string | URL | Request, init?: RequestInit) => {
    forwarded.push(new Headers(init?.headers).get("sb-forwarded-for"));
    return Response.json({ id: userId, email: "owner@example.test", email_confirmed_at: "2026-01-01" });
  }) as typeof fetch;
  const headers = {
    Origin: "https://app.test",
    "CF-Connecting-IP": "198.51.100.7",
    cookie: "__Host-ac-access=access-test; __Host-ac-refresh=refresh-test",
  };
  const me = await appApi(
    new Request("https://app.test/api/me", { headers }),
    config,
    () => {
      throw new Error("no db");
    },
    provider,
  );
  assert.equal(me.status, 200);
  assert.deepEqual(forwarded, ["198.51.100.7"]);

  forwarded.length = 0;
  const keys: string[] = [];
  const env = {
    ...config,
    AUTH_IP_LIMIT: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    },
  };
  for (const path of ["/api/auth/refresh", "/api/auth/logout"]) {
    const response = await appApi(
      new Request(`https://app.test${path}`, { method: "POST", headers }),
      env,
      () => {
        throw new Error("no db");
      },
      provider,
    );
    assert.equal(response.status, 429, path);
    assert.deepEqual(await response.json(), { error: "auth_rate_limited" }, path);
    // A refused logout still clears the browser session, as a remote logout failure does.
    assert.equal(
      response.headers.getSetCookie().filter((value) => value.includes("Max-Age=0")).length,
      path.endsWith("/logout") ? 2 : 0,
      path,
    );
  }
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.deepEqual(forwarded, []);
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

// A limiter stand-in that records every key it is asked to count.
function recordingLimit(answer: boolean | "throw") {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        if (answer === "throw") throw new Error("limiter down");
        return { success: answer };
      },
    },
  };
}

// A pool that fails the test if a refused request reads the database.
const untouchedPool = () =>
  ({
    query: async () => assert.fail("a refused request must not read the database"),
    connect: async () => assert.fail("a refused request must not read the database"),
    end: async () => {},
  }) as unknown as Pool;

// A pool that answers only the membership read of the workspace write limit (#167) and fails the test on any other
// query, so a write refused by its route handler still reads and writes nothing else.
const membershipOnlyPool = () =>
  ({
    query: async (sql: string) => {
      assert.match(sql, /^SELECT workspace_id FROM workspace_members WHERE user_id=\$1 AND removed_at IS NULL$/);
      return { rows: [{ workspace_id: workspaceId }] };
    },
    connect: async () => assert.fail("a refused request must not write the database"),
    end: async () => {},
  }) as unknown as Pool;

test("media list and single-post lookups spend separate per-user allowances (#166)", async () => {
  const allowed = recordingLimit(true);
  const list = await appApi(
    mediaRequest(),
    { ...mediaConfig, AUTH_IP_LIMIT: allowed.binding },
    () => mediaPool(),
    mediaFetch(),
  );
  assert.equal(list.status, 200);
  const item = await appApi(
    mediaRequest("/456"),
    { ...mediaConfig, AUTH_IP_LIMIT: allowed.binding },
    () => mediaPool(),
    mediaFetch(post),
  );
  assert.equal(item.status, 200);
  assert.deepEqual(allowed.keys, [`connection-media:${userId}`, `connection-media-item:${userId}`]);
});

test("a refused or unavailable media allowance prevents every Graph and database read (#166)", async () => {
  let graphReads = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).hostname !== "project.supabase.co") graphReads++;
    return mediaFetch()(input, init);
  }) as typeof fetch;
  const cases: Array<[{ limit(input: { key: string }): Promise<{ success: boolean }> } | undefined, number, string]> = [
    [recordingLimit(false).binding, 429, "media_rate_limited"],
    [undefined, 503, "media_unavailable"],
    [recordingLimit("throw").binding, 503, "media_unavailable"],
  ];
  for (const [binding, status, error] of cases) {
    for (const suffix of ["", "/456"]) {
      const response = await appApi(
        mediaRequest(suffix),
        { ...mediaConfig, AUTH_IP_LIMIT: binding },
        untouchedPool,
        fetchImpl,
      );
      assert.equal(response.status, status, `${error} ${suffix}`);
      assert.deepEqual(await response.json(), { error }, suffix);
    }
  }
  assert.equal(graphReads, 0);
});

test("the media check on a new rule save spends no media allowance (#166)", async () => {
  const limiter = recordingLimit(false);
  const response = await appApi(
    new Request("https://app.test/api/rules", {
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
    }),
    { ...mediaConfig, AUTH_IP_LIMIT: limiter.binding },
    () => mediaPool(),
    mediaFetch({ ...post, owner: { id: "888" } }),
  );
  // The ownership refusal shows the lookup reached Graph; a counted lookup would have answered 429.
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "media_not_owned" });
  assert.deepEqual(limiter.keys, []);
});

test("workspace export and Instagram connect spend a per-user allowance before the route reads the database (#166)", async () => {
  const fetchImpl = (async () =>
    Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch;
  const oauth = {
    ...config,
    APP_ORIGIN: "https://app.test",
    INSTAGRAM_OAUTH_APP_ID: "123",
    INSTAGRAM_OAUTH_APP_SECRET: "synthetic-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    META_GRAPH_VERSION: "v26.0",
    INSTAGRAM_PUBLIC_CONNECT_ENABLED: "true",
  };
  const routes = [
    {
      binding: "WORKSPACE_EXPORT_LIMIT",
      request: () =>
        new Request("https://app.test/api/workspace/export", { headers: { cookie: "__Host-ac-access=test-session" } }),
      prefix: "workspace_export",
      pool: untouchedPool,
    },
    {
      binding: "INSTAGRAM_CONNECT_LIMIT",
      request: () =>
        new Request("https://app.test/api/instagram/connect", {
          method: "POST",
          headers: { origin: "https://app.test", cookie: "__Host-ac-access=test-session" },
        }),
      prefix: "instagram_connect",
      // The OAuth start is a write, so the workspace write limit reads the caller's membership first (#167).
      pool: membershipOnlyPool,
    },
  ] as const;
  for (const route of routes) {
    const refused = recordingLimit(false);
    const cases: Array<[unknown, number, string]> = [
      [refused.binding, 429, `${route.prefix}_rate_limited`],
      [undefined, 503, `${route.prefix}_unavailable`],
      [recordingLimit("throw").binding, 503, `${route.prefix}_unavailable`],
    ];
    for (const [binding, status, error] of cases) {
      const response = await appApi(route.request(), { ...oauth, [route.binding]: binding }, route.pool, fetchImpl);
      assert.equal(response.status, status, error);
      assert.deepEqual(await response.json(), { error }, error);
    }
    assert.deepEqual(refused.keys, [userId], route.binding);
  }
});

test("contact CSV export fails closed before opening the database (#196)", async () => {
  for (const [binding, status, error] of [
    [recordingLimit(false).binding, 429, "contact_export_rate_limited"],
    [undefined, 503, "contact_export_unavailable"],
    [recordingLimit("throw").binding, 503, "contact_export_unavailable"],
  ] as const) {
    let opened = false;
    const response = await appApi(
      new Request("https://app.test/api/contacts/export.csv", { headers: { cookie: "__Host-ac-access=test-session" } }),
      { ...config, CONTACT_EXPORT_LIMIT: binding },
      () => {
        opened = true;
        return untouchedPool();
      },
      mediaFetch(),
    );
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
    assert.equal(opened, false);
    assert.equal(response.headers.has("content-disposition"), false);
  }
});

test("contact CSV export validates the session and query before spending the user's allowance (#196)", async () => {
  const limiter = recordingLimit(false);
  const env = { ...config, CONTACT_EXPORT_LIMIT: limiter.binding };
  const noPool = () => {
    throw new Error("refused CSV export must not open the database");
  };
  const unsigned = await appApi(new Request("https://app.test/api/contacts/export.csv"), env, noPool, mediaFetch());
  assert.equal(unsigned.status, 401);
  const invalid = await appApi(
    new Request("https://app.test/api/contacts/export.csv?tag=lead", {
      headers: { cookie: "__Host-ac-access=test-session" },
    }),
    env,
    noPool,
    mediaFetch(),
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_contact_export_request" });
  assert.deepEqual(limiter.keys, []);
  const refused = await appApi(
    new Request("https://app.test/api/contacts/export.csv", { headers: { cookie: "__Host-ac-access=test-session" } }),
    env,
    noPool,
    mediaFetch(),
  );
  assert.equal(refused.status, 429);
  assert.deepEqual(limiter.keys, [userId]);
});

test("segment CSV export accepts exactly one UUID segment_id before spending the allowance", async () => {
  const limiter = recordingLimit(false);
  const env = { ...config, CONTACT_EXPORT_LIMIT: limiter.binding };
  const noPool = () => {
    throw new Error("a refused segment export must not open the database");
  };
  const segment = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const send = (query: string) =>
    appApi(
      new Request(`https://app.test/api/contacts/export.csv${query}`, {
        headers: { cookie: "__Host-ac-access=test-session" },
      }),
      env,
      noPool,
      mediaFetch(),
    );
  for (const query of [
    "?segment_id=",
    "?segment_id",
    "?segment_id=bad",
    `?segment_id=${segment}x`,
    `?segment_id=${segment}&segment_id=${segment}`,
    `?segment_id=${segment}&tag=lead`,
    `?segment_id=${segment}&connection_id=${segment}`,
    `?segment_id=${segment}&preview=true`,
    `?segment=${segment}`,
    `?SEGMENT_ID=${segment}`,
  ]) {
    const response = await send(query);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: "invalid_contact_export_request" });
    assert.equal(response.headers.has("content-disposition"), false);
  }
  assert.deepEqual(limiter.keys, []);
  // A valid request passes validation and reaches the same per-user allowance as the full export.
  for (const id of [segment, segment.toUpperCase()]) {
    const response = await send(`?segment_id=${id}`);
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "contact_export_rate_limited" });
  }
  assert.deepEqual(limiter.keys, [userId, userId]);
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
    [Response.json({ error: { code: 10 } }, { status: 400 }), undefined, "reconnect_required", 1],
    [Response.json({ error: { code: 200 } }, { status: 403 }), undefined, "reconnect_required", 1],
    [
      Response.json({ error: { code: 190, message: "server-token expired" } }, { status: 403 }),
      undefined,
      "reconnect_required",
      1,
    ],
    [Response.json({ error: { code: 4 } }, { status: 403 }), undefined, "unverified", 1],
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
          ? [{ workspace_id: workspaceId, role: "owner" }]
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
        ? [{ workspace_id: workspaceId, role: "owner" }]
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
      rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId, role: "owner" }] : [{ id: existingId }],
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

test("rule saves refuse a keyword with a line break, which the editor would split into two (#144)", async () => {
  for (const [keywords, excluded] of [
    [["a\nb"], []],
    [["link"], ["x\ry"]],
  ]) {
    const pool = {
      query: async (sql: string) => {
        assert.equal(sql.includes("instagram_comment_rules"), false);
        return { rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId, role: "owner" }] : [] };
      },
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
        id: "44444444-4444-4444-8444-444444444444",
        connection_id: connectionId,
        media_id: "456",
        keywords,
        excluded_keywords: excluded,
        match_mode: "contains",
        private_reply_text: "A reply",
        enabled: false,
        follow_gate_enabled: false,
      }),
    });
    const fetchImpl = (async () =>
      Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch;
    const response = await appApi(request, config, () => pool, fetchImpl);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_keywords" });
  }
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

test("state-changing routes refuse a null, missing or foreign Origin before any provider or database call", async () => {
  const open = () => {
    throw new Error("DB must not be opened");
  };
  const provider = (async () => {
    throw new Error("the auth provider must not be called");
  }) as typeof fetch;
  const routes: [string, string][] = [
    ["PUT", "/api/workspace/settings"],
    ["PUT", `/api/connections/${connectionId}/inbox/456/handoff`],
    ["POST", "/api/auth/logout"],
    ["POST", "/api/auth/refresh"],
    ["POST", "/api/auth/reset-password"],
  ];
  for (const [method, path] of routes)
    for (const origin of [null, "null", "https://attacker.test", "https://app.test.attacker.test", "http://app.test"]) {
      const headers: Record<string, string> = { cookie: "__Host-ac-access=test; __Host-ac-refresh=test" };
      if (origin !== null) headers.origin = origin;
      const response = await appApi(
        new Request(`https://app.test${path}`, { method, headers }),
        config,
        open,
        provider,
      );
      assert.equal(response.status, 403, `${method} ${path} with Origin ${origin}`);
    }
});

test("consent mutation rejects unauthenticated and cross-origin requests before DB access", async () => {
  let openCount = 0;
  const open = () => {
    openCount += 1;
    return membershipOnlyPool();
  };
  const path = `https://app.test/api/connections/${connectionId}/channel-consent-events`;
  const unauthenticated = await appApi(
    new Request(path, { method: "POST", headers: { origin: "https://app.test" } }),
    config,
    open,
  );
  assert.equal(unauthenticated.status, 401);
  const crossOrigin = await appApi(
    new Request(path, {
      method: "POST",
      headers: { origin: "https://attacker.test", cookie: "__Host-ac-access=test" },
    }),
    config,
    open,
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(openCount, 0);

  const malformed = await appApi(
    new Request(path, {
      method: "POST",
      headers: {
        origin: "https://app.test",
        cookie: "__Host-ac-access=test",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    config,
    open,
    (async () =>
      Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
  assert.equal(malformed.status, 400);
  assert.equal(openCount, 1);
});

test("contacts API is authenticated and returns only the workspace list", async () => {
  const pool = {
    query: async (sql: string) => ({
      rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId, role: "owner" }] : [],
    }),
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

test("contact preview returns an exact total string without changing the ordinary list response", async () => {
  const statements: string[] = [];
  let matches: Record<string, unknown>[] = [];
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("workspace_members")) return { rows: [{ workspace_id: workspaceId, role: "owner" }] };
      statements.push(sql);
      return { rows: matches };
    },
    end: async () => {},
  } as unknown as Pool;
  const request = (query = "") =>
    appApi(
      new Request(`https://app.test/api/contacts${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
      config,
      () => pool,
      mediaFetch(),
    );
  const empty = await request("?preview=true");
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), {
    contacts: [],
    after: null,
    total: "0",
    evaluated: "0",
    excluded: { tag: "0", field: "0", both: "0" },
  });
  matches = [
    {
      connection_id: connectionId,
      sender_id: "sender",
      preview_total: "9007199254740993",
      preview_evaluated: "9007199254741000",
      preview_excluded_tag: "2",
      preview_excluded_field: "3",
      preview_excluded_both: "2",
    },
  ];
  const counted = await request("?preview=true");
  assert.equal(counted.status, 200);
  assert.deepEqual(await counted.json(), {
    contacts: [{ connection_id: connectionId, sender_id: "sender" }],
    after: null,
    total: "9007199254740993",
    evaluated: "9007199254741000",
    excluded: { tag: "2", field: "3", both: "2" },
  });
  matches = [];
  const ordinary = await request();
  assert.deepEqual(await ordinary.json(), { contacts: [], after: null });
  assert.equal(statements.length, 3);
  assert.match(statements[0]!, /preview_evaluated/);
  assert.equal(statements[2]!.includes("preview_evaluated"), false);
});

test("contact activity validates canonical UTC bounds and preserves an exact exclusion count", async () => {
  let values: unknown[] = [];
  let queried = false;
  const pool = {
    query: async (sql: string, parameters: unknown[]) => {
      queried = true;
      if (sql.includes("workspace_members")) return { rows: [{ workspace_id: workspaceId, role: "owner" }] };
      values = parameters;
      return {
        rows: [
          {
            connection_id: null,
            preview_total: "0",
            preview_evaluated: "9007199254740993",
            preview_excluded_activity: "9007199254740993",
            preview_excluded_tag: "0",
            preview_excluded_field: "0",
            preview_excluded_both: "0",
          },
        ],
      };
    },
    end: async () => {},
  } as unknown as Pool;
  const request = (query: URLSearchParams) =>
    appApi(
      new Request(`https://app.test/api/contacts?${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
      config,
      () => pool,
      mediaFetch(),
    );
  const from = "2026-10-10T00:00:00.000Z",
    before = "2026-10-12T00:00:00.000Z";
  const query = new URLSearchParams({ preview: "true", last_comment_from: from, last_comment_before: before });
  const response = await request(query);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    contacts: [],
    after: null,
    total: "0",
    evaluated: "9007199254740993",
    excluded: { activity: "9007199254740993", tag: "0", field: "0", both: "0" },
  });
  assert.deepEqual(values.slice(9, 11), [from, before]);
  for (const invalid of [
    { last_comment_from: from },
    { last_comment_before: before },
    { last_comment_from: "", last_comment_before: before },
    { last_comment_from: "2026-02-30T00:00:00.000Z", last_comment_before: before },
    { last_comment_from: "2026-10-10T00:00:00.000+00:00", last_comment_before: before },
    { last_comment_from: "0000-01-01T00:00:00.000Z", last_comment_before: before },
    { last_comment_from: "2026-10-10T24:00:00.000Z", last_comment_before: before },
    { last_comment_from: "2026-10-10", last_comment_before: before },
    { last_comment_from: before, last_comment_before: before },
    { last_comment_from: before, last_comment_before: from },
    { last_comment_from: from, last_comment_before: before, segment_id: "44444444-4444-4444-8444-444444444444" },
  ]) {
    queried = false;
    assert.equal((await request(new URLSearchParams(Object.entries(invalid)))).status, 400);
    assert.equal(queried, false, "invalid activity must fail before database access");
  }
  query.append("last_comment_from", from);
  queried = false;
  assert.equal((await request(query)).status, 400);
  assert.equal(queried, false);
});

test("contact consent filters validate an exact purpose-state pair before database access", async () => {
  let values: unknown[] = [];
  let queried = false;
  const pool = {
    query: async (sql: string, parameters: unknown[]) => {
      queried = true;
      if (sql.includes("workspace_members")) return { rows: [{ workspace_id: workspaceId, role: "owner" }] };
      values = parameters;
      return {
        rows: [
          {
            connection_id: null,
            preview_total: "0",
            preview_evaluated: "9007199254740993",
            preview_excluded_consent: "9007199254740993",
            preview_excluded_activity: "0",
            preview_excluded_tag: "0",
            preview_excluded_field: "0",
            preview_excluded_both: "0",
          },
        ],
      };
    },
    end: async () => {},
  } as unknown as Pool;
  const request = (query: URLSearchParams) =>
    appApi(
      new Request(`https://app.test/api/contacts?${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
      config,
      () => pool,
      mediaFetch(),
    );
  for (const purpose of ["service_reply", "marketing"]) {
    for (const state of ["granted", "revoked", "no_record"]) {
      const response = await request(
        new URLSearchParams({ preview: "true", consent_purpose: purpose, consent_state: state }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        contacts: [],
        after: null,
        total: "0",
        evaluated: "9007199254740993",
        excluded: { consent: "9007199254740993", tag: "0", field: "0", both: "0" },
      });
      assert.deepEqual(values.slice(11, 13), [purpose, state]);
    }
  }
  for (const invalid of [
    { consent_purpose: "marketing" },
    { consent_state: "granted" },
    { consent_purpose: "", consent_state: "granted" },
    { consent_purpose: "marketing", consent_state: "" },
    { consent_purpose: "all", consent_state: "revoked" },
    { consent_purpose: "marketing", consent_state: "eligible" },
    { consent_purpose: "marketing", consent_state: "grant" },
    { consent_purpose: "MARKETING", consent_state: "granted" },
    { consent_purpose: "marketing", consent_state: "granted", segment_id: "44444444-4444-4444-8444-444444444444" },
  ]) {
    queried = false;
    assert.equal((await request(new URLSearchParams(Object.entries(invalid)))).status, 400);
    assert.equal(queried, false);
  }
  for (const duplicate of ["consent_purpose", "consent_state"]) {
    const query = new URLSearchParams({ consent_purpose: "marketing", consent_state: "granted" });
    query.append(duplicate, query.get(duplicate)!);
    queried = false;
    assert.equal((await request(query)).status, 400);
    assert.equal(queried, false);
  }
});

test("contact DM consent filters validate an exact purpose-state pair before database access", async () => {
  let values: unknown[] = [];
  let queried = false;
  const pool = {
    query: async (sql: string, parameters: unknown[]) => {
      queried = true;
      if (sql.includes("workspace_members")) return { rows: [{ workspace_id: workspaceId, role: "owner" }] };
      values = parameters;
      return {
        rows: [
          {
            connection_id: null,
            preview_total: "0",
            preview_evaluated: "9007199254740995",
            preview_excluded_consent: "1",
            preview_excluded_dm_identity: "9007199254740993",
            preview_excluded_dm_consent: "1",
            preview_excluded_activity: "0",
            preview_excluded_tag: "0",
            preview_excluded_field: "0",
            preview_excluded_both: "0",
          },
        ],
      };
    },
    end: async () => {},
  } as unknown as Pool;
  const request = (query: URLSearchParams) =>
    appApi(
      new Request(`https://app.test/api/contacts?${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
      config,
      () => pool,
      mediaFetch(),
    );
  for (const purpose of ["service_reply", "marketing"]) {
    for (const state of ["granted", "revoked", "no_record"]) {
      const response = await request(
        new URLSearchParams({ preview: "true", dm_consent_purpose: purpose, dm_consent_state: state }),
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      // The comment consent key stays omitted without its own condition; the DM keys keep their order.
      assert.deepEqual(body, {
        contacts: [],
        after: null,
        total: "0",
        evaluated: "9007199254740995",
        excluded: { dm_identity: "9007199254740993", dm_consent: "1", tag: "0", field: "0", both: "0" },
      });
      assert.deepEqual(Object.keys(body.excluded), ["dm_identity", "dm_consent", "tag", "field", "both"]);
      assert.deepEqual(values.slice(11, 13), [null, null]);
      assert.deepEqual(values.slice(15, 17), [purpose, state]);
    }
  }
  const both = await request(
    new URLSearchParams({
      preview: "true",
      consent_purpose: "marketing",
      consent_state: "granted",
      dm_consent_purpose: "service_reply",
      dm_consent_state: "revoked",
    }),
  );
  assert.deepEqual(Object.keys((await both.json()).excluded), [
    "consent",
    "dm_identity",
    "dm_consent",
    "tag",
    "field",
    "both",
  ]);
  assert.deepEqual(values.slice(11, 17), ["marketing", "granted", null, null, "service_reply", "revoked"]);
  await request(new URLSearchParams({ preview: "true" }));
  assert.deepEqual(values.slice(15, 17), [null, null]);
  for (const invalid of [
    { dm_consent_purpose: "marketing" },
    { dm_consent_state: "granted" },
    { dm_consent_purpose: "", dm_consent_state: "granted" },
    { dm_consent_purpose: "marketing", dm_consent_state: "" },
    { dm_consent_purpose: "all", dm_consent_state: "revoked" },
    { dm_consent_purpose: "marketing", dm_consent_state: "eligible" },
    { dm_consent_purpose: "marketing", dm_consent_state: "grant" },
    { dm_consent_purpose: "MARKETING", dm_consent_state: "granted" },
  ]) {
    queried = false;
    const response = await request(new URLSearchParams(Object.entries(invalid)));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_contact_consent");
    assert.equal(queried, false);
  }
  for (const mixed of [
    { dm_consent_purpose: "marketing", dm_consent_state: "granted" },
    { dm_consent_purpose: "marketing" },
    { dm_consent_state: "granted" },
  ] as Record<string, string>[]) {
    queried = false;
    const response = await request(
      new URLSearchParams({ ...mixed, segment_id: "44444444-4444-4444-8444-444444444444" }),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_contact_request");
    assert.equal(queried, false);
  }
  for (const duplicate of ["dm_consent_purpose", "dm_consent_state"]) {
    const query = new URLSearchParams({ dm_consent_purpose: "marketing", dm_consent_state: "granted" });
    query.append(duplicate, query.get(duplicate)!);
    queried = false;
    const response = await request(query);
    assert.equal(response.status, 400);
    assert.equal(queried, false);
  }
});

test("contact DM activity takes canonical days 1 to 366 in $18 and refuses other values before database access", async () => {
  let values: unknown[] = [];
  let statement = "";
  let queried = false;
  const dmWindow = { from: "2026-10-15T03:00:00.000000Z", before: "2026-10-18T03:00:00.000000Z" };
  const pool = {
    query: async (sql: string, parameters: unknown[]) => {
      queried = true;
      if (sql.includes("workspace_members")) return { rows: [{ workspace_id: workspaceId, role: "owner" }] };
      values = parameters;
      statement = sql;
      return {
        rows: [
          {
            connection_id: null,
            preview_total: "0",
            preview_evaluated: "9007199254740997",
            preview_excluded_activity: "1",
            preview_excluded_consent: "0",
            preview_excluded_dm_identity: "9007199254740993",
            preview_excluded_dm_consent: "1",
            preview_excluded_dm_activity: "2",
            preview_excluded_tag: "0",
            preview_excluded_field: "0",
            preview_excluded_both: "0",
            dm_activity_window: dmWindow,
          },
        ],
      };
    },
    end: async () => {},
  } as unknown as Pool;
  const request = (query: URLSearchParams) =>
    appApi(
      new Request(`https://app.test/api/contacts?${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
      config,
      () => pool,
      mediaFetch(),
    );
  for (const days of ["1", "30", "366"]) {
    const preview = await request(new URLSearchParams({ preview: "true", last_dm_days: days }));
    assert.equal(preview.status, 200);
    const body = await preview.json();
    // DM activity alone adds dm_identity and dm_activity, and returns only the window's UTC bounds.
    assert.deepEqual(body, {
      contacts: [],
      dm_activity_window: dmWindow,
      after: null,
      total: "0",
      evaluated: "9007199254740997",
      excluded: { dm_identity: "9007199254740993", dm_activity: "2", tag: "0", field: "0", both: "0" },
    });
    assert.equal(values.length, 19);
    assert.equal(values[17], Number(days));
    assert.deepEqual(values.slice(13, 17), [null, null, null, null]);
    assert.match(statement, /\$18::int IS NOT NULL/);
    const list = await request(new URLSearchParams({ last_dm_days: days }));
    assert.deepEqual(await list.json(), { contacts: [], dm_activity_window: dmWindow, after: null });
    assert.equal(values[17], Number(days));
  }
  // Every DM and comment limit together: the reasons keep their order.
  const all = await request(
    new URLSearchParams({
      preview: "true",
      last_comment_days: "7",
      consent_purpose: "marketing",
      consent_state: "granted",
      dm_consent_purpose: "service_reply",
      dm_consent_state: "granted",
      last_dm_days: "3",
    }),
  );
  const allBody = await all.json();
  assert.deepEqual(Object.keys(allBody.excluded), [
    "activity",
    "consent",
    "dm_identity",
    "dm_consent",
    "dm_activity",
    "tag",
    "field",
    "both",
  ]);
  assert.equal(values[13], 7);
  assert.deepEqual(values.slice(15, 18), ["service_reply", "granted", 3]);
  // Each comment activity form combines with DM activity.
  for (const activity of [
    { last_comment_period: "today" },
    { last_comment_from: "2026-10-01T00:00:00.000Z", last_comment_before: "2026-10-02T00:00:00.000Z" },
  ] as Record<string, string>[]) {
    const response = await request(new URLSearchParams({ ...activity, last_dm_days: "5" }));
    assert.equal(response.status, 200);
    assert.equal(values[17], 5);
  }
  // Without the condition the key, the window and the parameter stay absent.
  const none = await request(
    new URLSearchParams({ preview: "true", dm_consent_purpose: "marketing", dm_consent_state: "granted" }),
  );
  const noneBody = await none.json();
  assert.equal("dm_activity_window" in noneBody, false);
  assert.deepEqual(Object.keys(noneBody.excluded), ["dm_identity", "dm_consent", "tag", "field", "both"]);
  assert.equal(values[17], null);
  for (const invalid of ["0", "367", "999", "1000", "07", "+7", "7.0", "1e2", " 7", "7 ", "", "-1", "seven"]) {
    queried = false;
    const response = await request(new URLSearchParams({ last_dm_days: invalid }));
    assert.equal(response.status, 400, invalid);
    assert.equal((await response.json()).error, "invalid_contact_activity");
    assert.equal(queried, false);
  }
  queried = false;
  const mixed = await request(
    new URLSearchParams({ last_dm_days: "7", segment_id: "44444444-4444-4444-8444-444444444444" }),
  );
  assert.equal(mixed.status, 400);
  assert.equal((await mixed.json()).error, "invalid_contact_request");
  assert.equal(queried, false);
  const duplicate = new URLSearchParams({ last_dm_days: "7" });
  duplicate.append("last_dm_days", "7");
  queried = false;
  const repeated = await request(duplicate);
  assert.equal(repeated.status, 400);
  assert.equal((await repeated.json()).error, "invalid_contact_request");
  assert.equal(queried, false);
});

test("contact calendar periods accept four exact values and refuse mixing before database access", async () => {
  let values: unknown[] = [];
  let queried = false;
  const window = {
    from: "2026-10-16T15:00:00.000000Z",
    before: "2026-10-17T15:00:00.000000Z",
    time_zone: "Asia/Seoul",
  };
  const pool = {
    query: async (sql: string, parameters: unknown[]) => {
      queried = true;
      if (sql.includes("workspace_members")) return { rows: [{ workspace_id: workspaceId, role: "owner" }] };
      values = parameters;
      return {
        rows: [
          {
            connection_id: null,
            preview_total: "0",
            preview_evaluated: "9007199254740993",
            preview_excluded_activity: "9007199254740993",
            preview_excluded_tag: "0",
            preview_excluded_field: "0",
            preview_excluded_both: "0",
            activity_window: window,
          },
        ],
      };
    },
    end: async () => {},
  } as unknown as Pool;
  const request = (query: URLSearchParams) =>
    appApi(
      new Request(`https://app.test/api/contacts?${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
      config,
      () => pool,
      mediaFetch(),
    );
  for (const period of ["today", "yesterday", "this_month", "last_month"]) {
    const preview = await request(new URLSearchParams({ preview: "true", last_comment_period: period }));
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), {
      contacts: [],
      after: null,
      activity_window: window,
      total: "0",
      evaluated: "9007199254740993",
      excluded: { activity: "9007199254740993", tag: "0", field: "0", both: "0" },
    });
    // Appended last, so the earlier parameter positions stay as they were.
    assert.equal(values.length, 19);
    assert.deepEqual(values.slice(9, 11), [null, null]);
    assert.equal(values[13], null);
    assert.equal(values[14], period);
    const list = await request(new URLSearchParams({ last_comment_period: period }));
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).activity_window, window);
  }
  // An empty query value means no calendar period, and the response keeps its old shape.
  const empty = await request(new URLSearchParams({ last_comment_period: "" }));
  assert.equal(empty.status, 200);
  assert.equal("activity_window" in (await empty.json()), false);
  assert.equal(values[14], null);
  const fixed = { last_comment_from: "2026-10-01T00:00:00.000Z", last_comment_before: "2026-10-02T00:00:00.000Z" };
  for (const invalid of [
    { last_comment_period: "TODAY" },
    { last_comment_period: "this_week" },
    { last_comment_period: " today" },
    { last_comment_period: "today", last_comment_days: "7" },
    { last_comment_period: "today", ...fixed },
    { last_comment_period: "today", last_comment_from: fixed.last_comment_from },
    { last_comment_period: "today", segment_id: "44444444-4444-4444-8444-444444444444" },
    { last_comment_period: "", segment_id: "44444444-4444-4444-8444-444444444444" },
  ]) {
    queried = false;
    const response = await request(new URLSearchParams(Object.entries(invalid)));
    assert.equal(response.status, 400);
    assert.equal(queried, false, "an invalid calendar period must fail before database access");
  }
  const duplicate = new URLSearchParams({ last_comment_period: "today" });
  duplicate.append("last_comment_period", "yesterday");
  queried = false;
  assert.equal((await request(duplicate)).status, 400);
  assert.equal(queried, false);
});

test("contact preview rejects malformed flags and every cursor before querying contacts", async () => {
  let queried = false;
  const pool = {
    query: async () => {
      queried = true;
      throw new Error("Invalid preview must not query the database");
    },
    end: async () => {},
  } as unknown as Pool;
  for (const query of [
    "preview=",
    "preview=false",
    "preview=TRUE",
    "preview=1",
    "preview=true&preview=true",
    "preview=true&after=",
    "preview=true&after=cursor",
  ]) {
    const response = await appApi(
      new Request(`https://app.test/api/contacts?${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
      config,
      () => pool,
      mediaFetch(),
    );
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: "invalid_contact_request" });
  }
  assert.equal(queried, false);
  const unsigned = await appApi(
    new Request("https://app.test/api/contacts?preview=true"),
    config,
    () => {
      throw new Error("Unauthenticated preview must not open the database");
    },
    mediaFetch(),
  );
  assert.equal(unsigned.status, 401);
});

test("saved segment list is authenticated and workspace scoped", async () => {
  const pool = {
    query: async (sql: string) => ({
      rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId, role: "owner" }] : [],
    }),
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
    query: async (sql: string) => ({
      rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId, role: "owner" }] : [],
    }),
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
    ["/api/contact-segments/123", "PUT"],
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

// Validation runs before the database: a refused shape never reaches the pool, and an accepted one does.
const segmentPool = {
  query: async () => {
    throw new Error("database reached");
  },
  connect: async () => {
    throw new Error("database reached");
  },
} as unknown as Pool;
const segmentUser = { id: userId, email: "a@example.test" };
const segmentId = "44444444-4444-4444-8444-444444444444";
const reachedDatabase = (error: unknown) => error instanceof Error && error.message === "database reached";
const refused = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.status === 400 && error.message === code;

test("segment edits refuse a missing or invalid expected_version, unknown keys and invalid names before the database", async () => {
  for (const [body, code] of [
    [{ name: "Leads" }, "invalid_segment"],
    [{ name: "Leads", expected_version: 0 }, "invalid_segment"],
    [{ name: "Leads", expected_version: -1 }, "invalid_segment"],
    [{ name: "Leads", expected_version: 1.5 }, "invalid_segment"],
    [{ name: "Leads", expected_version: "1" }, "invalid_segment"],
    [{ name: "Leads", expected_version: null }, "invalid_segment"],
    [{ name: "Leads", expected_version: Number.MAX_SAFE_INTEGER + 1 }, "invalid_segment"],
    [{ name: "Leads", expected_version: 1, extra: true }, "invalid_segment"],
    [{ name: " ", expected_version: 1 }, "invalid_segment"],
    [{ name: "x".repeat(61), expected_version: 1 }, "invalid_segment"],
    [{ name: "bad\nname", expected_version: 1 }, "invalid_segment"],
    [{ expected_version: 1 }, "invalid_segment"],
    [{ name: "Leads", expected_version: 1, field_operator: "eq" }, "invalid_field_condition"],
    [{ name: "Leads", expected_version: 1, last_comment_days: 0 }, "invalid_contact_activity"],
    [{ name: "Leads", expected_version: 1, consent_purpose: "marketing" }, "invalid_contact_consent"],
    [{ name: "Leads", expected_version: 1, dm_consent_purpose: "marketing" }, "invalid_contact_consent"],
    [{ name: "Leads", expected_version: 1, dm_consent_state: "granted" }, "invalid_contact_consent"],
    [
      { name: "Leads", expected_version: 1, dm_consent_purpose: "all", dm_consent_state: "revoked" },
      "invalid_contact_consent",
    ],
    [
      { name: "Leads", expected_version: 1, dm_consent_purpose: "marketing", dm_consent_state: "eligible" },
      "invalid_contact_consent",
    ],
    [
      { name: "Leads", expected_version: 1, dm_consent_purpose: "", dm_consent_state: "granted" },
      "invalid_contact_consent",
    ],
    [{ name: "Leads", expected_version: 1, condition_operator: "or" }, "invalid_contact_condition"],
  ] as const)
    await assert.rejects(updateContactSegment(segmentPool, segmentUser, segmentId, body), refused(code));
  await assert.rejects(
    updateContactSegment(segmentPool, segmentUser, "not-a-uuid", { name: "Leads", expected_version: 1 }),
    refused("invalid_segment"),
  );
  // Create keeps its own key set: expected_version belongs only to an edit.
  await assert.rejects(
    createContactSegment(segmentPool, segmentUser, { name: "Leads", expected_version: 1 }),
    refused("invalid_segment"),
  );
});

test("segment create and edit share one definition parser", async () => {
  const definitions = [
    { name: "Leads" },
    { name: " Leads ", connection_id: connectionId, tag: " Lead " },
    {
      name: "Scored",
      tag: "lead",
      field_id: segmentId,
      field_operator: "gte",
      field_value: 10,
      condition_operator: "or",
      last_comment_days: 7,
      consent_purpose: "marketing",
      consent_state: "granted",
      dm_consent_purpose: "service_reply",
      dm_consent_state: "no_record",
    },
    { name: "Window", last_comment_from: "2026-10-01T00:00:00.000Z", last_comment_before: "2026-10-02T00:00:00.000Z" },
    { name: "DM", dm_consent_purpose: "marketing", dm_consent_state: "revoked" },
    { name: "No DM", dm_consent_purpose: null, dm_consent_state: null },
  ];
  for (const definition of definitions) {
    await assert.rejects(createContactSegment(segmentPool, segmentUser, definition), reachedDatabase);
    await assert.rejects(
      updateContactSegment(segmentPool, segmentUser, segmentId, { ...definition, expected_version: 1 }),
      reachedDatabase,
    );
    const { input: _created, ...created } = parseSegmentDefinition(definition);
    const { input: _edited, ...edited } = parseSegmentDefinition({ ...definition, expected_version: 3 }, [
      "expected_version",
    ]);
    assert.deepEqual(edited, created);
  }
});

test("segment create and edit share last_dm_days and refuse an invalid one before the database", async () => {
  for (const [body, code] of [
    [{ name: "Leads", expected_version: 1, last_dm_days: 0 }, "invalid_contact_activity"],
    [{ name: "Leads", expected_version: 1, last_dm_days: 367 }, "invalid_contact_activity"],
    [{ name: "Leads", expected_version: 1, last_dm_days: "7" }, "invalid_contact_activity"],
  ] as const)
    await assert.rejects(updateContactSegment(segmentPool, segmentUser, segmentId, body), refused(code));
  const definitions = [
    {
      name: "DM activity",
      last_dm_days: 30,
      last_comment_days: 7,
      dm_consent_purpose: "marketing",
      dm_consent_state: "granted",
    },
    { name: "No DM activity", last_dm_days: null },
  ];
  for (const definition of definitions) {
    await assert.rejects(createContactSegment(segmentPool, segmentUser, definition), reachedDatabase);
    await assert.rejects(
      updateContactSegment(segmentPool, segmentUser, segmentId, { ...definition, expected_version: 1 }),
      reachedDatabase,
    );
    const { input: _created, ...created } = parseSegmentDefinition(definition);
    const { input: _edited, ...edited } = parseSegmentDefinition({ ...definition, expected_version: 3 }, [
      "expected_version",
    ]);
    assert.deepEqual(edited, created);
  }
});

test("segment definitions take the DM consent pair beside the comment consent pair", () => {
  const parsed = parseSegmentDefinition({
    name: "DM",
    consent_purpose: "marketing",
    consent_state: "granted",
    dm_consent_purpose: "service_reply",
    dm_consent_state: "no_record",
  });
  assert.deepEqual(parsed.consent, { consent_purpose: "marketing", consent_state: "granted" });
  assert.deepEqual(parsed.dmConsent, { dm_consent_purpose: "service_reply", dm_consent_state: "no_record" });
  assert.equal(parseSegmentDefinition({ name: "None" }).dmConsent, null);
  assert.equal(
    parseSegmentDefinition({ name: "Null", dm_consent_purpose: null, dm_consent_state: null }).dmConsent,
    null,
  );
  for (const invalid of [
    { dm_consent_purpose: "marketing", dm_consent_state: null },
    { dm_consent_purpose: false, dm_consent_state: "granted" },
    { dm_consent_purpose: ["marketing"], dm_consent_state: "granted" },
  ])
    assert.throws(() => parseSegmentDefinition({ name: "Invalid", ...invalid }), refused("invalid_contact_consent"));
});

test("segment definitions take last_dm_days as an integer beside every comment activity form", () => {
  for (const days of [1, 30, 366]) {
    const parsed = parseSegmentDefinition({ name: "DM", last_dm_days: days });
    assert.deepEqual(parsed.dmActivity, { last_dm_days: days });
    assert.equal(parsed.activity, null);
  }
  assert.equal(parseSegmentDefinition({ name: "None" }).dmActivity, null);
  assert.equal(parseSegmentDefinition({ name: "Null", last_dm_days: null }).dmActivity, null);
  // Independent of the comment activity forms: each combination keeps both conditions.
  for (const activity of [
    { last_comment_days: 7 },
    { last_comment_period: "today" },
    { last_comment_from: "2026-10-01T00:00:00.000Z", last_comment_before: "2026-10-02T00:00:00.000Z" },
  ]) {
    const parsed = parseSegmentDefinition({ name: "Both", last_dm_days: 3, ...activity });
    assert.deepEqual(parsed.dmActivity, { last_dm_days: 3 });
    assert.deepEqual(parsed.activity, activity);
  }
  for (const invalid of [0, 367, -1, 1.5, "7", true, [7], Number.NaN])
    assert.throws(
      () => parseSegmentDefinition({ name: "Invalid", last_dm_days: invalid }),
      refused("invalid_contact_activity"),
    );
});

test("segment definitions take a calendar period as an exact string and refuse mixing with other activity forms", async () => {
  for (const period of ["today", "yesterday", "this_month", "last_month"]) {
    const { activity } = parseSegmentDefinition({ name: "Leads", last_comment_period: period });
    assert.deepEqual(activity, { last_comment_period: period });
  }
  assert.equal(parseSegmentDefinition({ name: "Leads", last_comment_period: null }).activity, null);
  assert.equal(parseSegmentDefinition({ name: "Leads" }).activity, null);
  const fixed = { last_comment_from: "2026-10-01T00:00:00.000Z", last_comment_before: "2026-10-02T00:00:00.000Z" };
  for (const body of [
    { name: "Leads", last_comment_period: "" },
    { name: "Leads", last_comment_period: "Today" },
    { name: "Leads", last_comment_period: "last_week" },
    { name: "Leads", last_comment_period: 1 },
    { name: "Leads", last_comment_period: true },
    { name: "Leads", last_comment_period: ["today"] },
    { name: "Leads", last_comment_period: "today", last_comment_days: 7 },
    { name: "Leads", last_comment_period: "today", ...fixed },
    { name: "Leads", last_comment_period: "today", last_comment_before: fixed.last_comment_before },
  ]) {
    assert.throws(() => parseSegmentDefinition(body), refused("invalid_contact_activity"));
    await assert.rejects(createContactSegment(segmentPool, segmentUser, body), refused("invalid_contact_activity"));
    await assert.rejects(
      updateContactSegment(segmentPool, segmentUser, segmentId, { ...body, expected_version: 1 }),
      refused("invalid_contact_activity"),
    );
  }
  await assert.rejects(
    createContactSegment(segmentPool, segmentUser, { name: "Leads", last_comment_period: "this_month" }),
    reachedDatabase,
  );
});

test("contact tag filters repeat tag up to five times with one mode and refuse other shapes before database access", async () => {
  let values: unknown[] = [];
  let statement = "";
  let queried = false;
  const pool = {
    query: async (sql: string, parameters: unknown[]) => {
      queried = true;
      if (sql.includes("workspace_members")) return { rows: [{ workspace_id: workspaceId, role: "owner" }] };
      values = parameters;
      statement = sql;
      return { rows: [] };
    },
    end: async () => {},
  } as unknown as Pool;
  const request = (query: string) =>
    appApi(
      new Request(`https://app.test/api/contacts?${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
      config,
      () => pool,
      mediaFetch(),
    );
  const all = /coalesce\(t\.tags,'\{\}'::text\[\]\) @> \$3::text\[\]/;
  const any = /coalesce\(t\.tags,'\{\}'::text\[\]\) && \$3::text\[\]/;
  // One tag without a mode keeps the response, the parameter positions and the containment predicate.
  const single = await request("tag=%20Lead%20");
  assert.equal(single.status, 200);
  assert.deepEqual(await single.json(), { contacts: [], after: null });
  assert.equal(values.length, 19);
  assert.deepEqual(values[2], ["lead"]);
  assert.match(statement, all);
  assert.doesNotMatch(statement, any);
  for (const [query, tags, predicate] of [
    ["tag=b&tag=A", ["a", "b"], all],
    ["tag=b&tag=A&tag_mode=all", ["a", "b"], all],
    ["tag=b&tag=A&tag_mode=any", ["a", "b"], any],
    ["tag=e&tag=d&tag=c&tag=b&tag=a&tag_mode=any", ["a", "b", "c", "d", "e"], any],
    // Values that normalize equal collapse; one remaining tag is the single-tag condition whatever the mode.
    ["tag=Lead&tag=%20lead&tag_mode=any", ["lead"], all],
    ["tag=lead&tag_mode=any", ["lead"], all],
  ] as const) {
    const response = await request(query);
    assert.equal(response.status, 200, query);
    assert.deepEqual(values[2], tags, query);
    assert.match(statement, predicate, query);
  }
  await request("");
  assert.equal(values[2], null);
  for (const [query, error] of [
    ["tag=a&tag=b&tag=c&tag=d&tag=e&tag=f", "invalid_contact_tags"],
    ["tag=a&tag=a&tag=a&tag=a&tag=a&tag=a", "invalid_contact_tags"],
    ["tag=a&tag=", "invalid_contact_tags"],
    [`tag=a&tag=${"x".repeat(41)}`, "invalid_contact_tags"],
    ["tag=a&tag=b&tag_mode=none", "invalid_contact_tags"],
    ["tag=a&tag=b&tag_mode=ANY", "invalid_contact_tags"],
    ["tag=a&tag=b&tag_mode=", "invalid_contact_tags"],
    ["tag_mode=all", "invalid_contact_condition"],
    ["tag_mode=", "invalid_contact_condition"],
    ["tag=a&tag=b&tag_mode=all&tag_mode=any", "invalid_contact_request"],
    ["tag=a&connection_id=x&connection_id=y", "invalid_contact_request"],
    ["tag=a&tag=b&condition_operator=or", "invalid_contact_condition"],
    // A tag value is validated before the segment_id mixing check, as with the single tag before this change.
    [`segment_id=${segmentId}&tag=`, "invalid_contact_tags"],
    [`segment_id=${segmentId}&tag=${"x".repeat(41)}`, "invalid_contact_tags"],
    [`segment_id=${segmentId}&tag=a`, "invalid_contact_request"],
    [`segment_id=${segmentId}&tag=a&tag=b`, "invalid_contact_request"],
    [`segment_id=${segmentId}&tag_mode=any`, "invalid_contact_request"],
  ] as const) {
    queried = false;
    const response = await request(query);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error }, query);
    assert.equal(queried, false, `${query} must fail before database access`);
  }
});

test("segment definitions take a legacy tag or a set of one to five tags with a mode", async () => {
  const tags = (definition: Record<string, unknown>) => parseSegmentDefinition({ name: "Leads", ...definition });
  assert.equal(tags({}).tagCondition, null);
  assert.equal(tags({ tag: null, tags: null }).tagCondition, null);
  assert.deepEqual(tags({ tag: " Lead " }).tagCondition, { tags: ["lead"], mode: "all" });
  assert.deepEqual(tags({ tags: ["b", "A"] }).tagCondition, { tags: ["a", "b"], mode: "all" });
  assert.deepEqual(tags({ tags: ["b", "A"], tag_mode: "any" }).tagCondition, { tags: ["a", "b"], mode: "any" });
  assert.deepEqual(tags({ tags: ["e", "d", "c", "b", "a"], tag_mode: "all" }).tagCondition, {
    tags: ["a", "b", "c", "d", "e"],
    mode: "all",
  });
  // A set that collapses to one tag is the single-tag condition, whatever the mode.
  assert.deepEqual(tags({ tags: ["Lead", " lead"], tag_mode: "any" }).tagCondition, { tags: ["lead"], mode: "all" });
  assert.deepEqual(tags({ tag: "lead", tag_mode: "any" }).tagCondition, { tags: ["lead"], mode: "all" });
  // An empty legacy tag counts as no tag, so it can go with a set.
  assert.deepEqual(tags({ tag: "", tags: ["a", "b"] }).tagCondition, { tags: ["a", "b"], mode: "all" });
  for (const [body, code] of [
    [{ tag: "a", tags: ["b", "c"] }, "invalid_segment"],
    [{ tag: "a", tags: ["a"] }, "invalid_segment"],
    [{ tags: [] }, "invalid_contact_tags"],
    [{ tags: "a" }, "invalid_contact_tags"],
    [{ tags: ["a", "b", "c", "d", "e", "f"] }, "invalid_contact_tags"],
    [{ tags: ["a", "a", "a", "a", "a", "a"] }, "invalid_contact_tags"],
    [{ tags: ["a", null] }, "invalid_contact_tags"],
    [{ tags: ["a", ""] }, "invalid_contact_tags"],
    [{ tags: ["a", "x".repeat(41)] }, "invalid_contact_tags"],
    [{ tags: ["a", "b"], tag_mode: "none" }, "invalid_contact_tags"],
    [{ tags: ["a", "b"], tag_mode: 1 }, "invalid_contact_tags"],
    [{ tag_mode: "all" }, "invalid_contact_condition"],
    [{ tags: ["a", "b"], condition_operator: "or" }, "invalid_contact_condition"],
  ] as const) {
    assert.throws(() => tags(body), refused(code), JSON.stringify(body));
    await assert.rejects(createContactSegment(segmentPool, segmentUser, { name: "Leads", ...body }), refused(code));
    await assert.rejects(
      updateContactSegment(segmentPool, segmentUser, segmentId, { name: "Leads", ...body, expected_version: 1 }),
      refused(code),
    );
  }
  await assert.rejects(
    createContactSegment(segmentPool, segmentUser, { name: "Leads", tags: ["a", "b"], tag_mode: "any" }),
    reachedDatabase,
  );
});

// Sorted field IDs for the field-set tests; the mock answers every field lookup with the type below.
const setFields = [
  "a1111111-1111-4111-8111-111111111111",
  "b2222222-2222-4222-8222-222222222222",
  "c3333333-3333-4333-8333-333333333333",
  "d4444444-4444-4444-8444-444444444444",
] as const;
const setFieldTypes: Record<string, string> = {
  [setFields[0]]: "text",
  [setFields[1]]: "number",
  [setFields[2]]: "date",
  [setFields[3]]: "boolean",
};

test("contact field filters take the legacy keys or a field_conditions set of up to three and refuse other shapes before database access", async () => {
  let values: unknown[] = [];
  let lookups: unknown[] = [];
  let queried = false;
  const pool = {
    query: async (sql: string, parameters: unknown[]) => {
      queried = true;
      if (sql.includes("workspace_members")) return { rows: [{ workspace_id: workspaceId, role: "owner" }] };
      if (sql.includes("FROM instagram_contact_fields WHERE")) {
        lookups.push(parameters[1]);
        return { rows: [{ type: setFieldTypes[String(parameters[1])] }] };
      }
      values = parameters;
      return { rows: [] };
    },
    end: async () => {},
  } as unknown as Pool;
  const request = (query: URLSearchParams | string) =>
    appApi(
      new Request(`https://app.test/api/contacts?${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
      config,
      () => pool,
      mediaFetch(),
    );
  const set = (conditions: unknown, extra: Record<string, string> = {}) =>
    new URLSearchParams({ field_conditions: JSON.stringify(conditions), ...extra });
  const text = { field_id: setFields[0], field_operator: "eq", field_value: "x" };
  const score = { field_id: setFields[1], field_operator: "gt", field_value: 3 };
  const day = { field_id: setFields[2], field_operator: "lte", field_value: "2026-10-18" };
  const flag = { field_id: setFields[3], field_operator: "is_unset" };
  // The legacy keys keep the response and the parameter positions; the condition becomes a set of one.
  const legacy = await request(
    new URLSearchParams({ field_id: setFields[0], field_operator: "eq", field_value: JSON.stringify("x") }),
  );
  assert.equal(legacy.status, 200);
  assert.deepEqual(await legacy.json(), { contacts: [], after: null });
  assert.equal(values.length, 19);
  assert.deepEqual(values.slice(5, 7), [[setFields[0]], "all"]);
  assert.deepEqual(JSON.parse(String(values[7])), [text]);
  for (const [query, conditions, mode] of [
    [set([text]), [text], "all"],
    [set([text], { field_mode: "any" }), [text], "all"],
    [
      new URLSearchParams({ field_id: setFields[0], field_operator: "eq", field_value: '"x"', field_mode: "any" }),
      [text],
      "all",
    ],
    [set([score, text]), [text, score], "all"],
    [set([score, text], { field_mode: "all" }), [text, score], "all"],
    [set([day, score, text], { field_mode: "any" }), [text, score, day], "any"],
    [set([flag, { ...day, field_id: setFields[2].toUpperCase() }]), [day, flag], "all"],
  ] as const) {
    lookups = [];
    const response = await request(query);
    assert.equal(response.status, 200, String(query));
    assert.deepEqual(
      values[5],
      conditions.map((condition) => condition.field_id),
      String(query),
    );
    assert.equal(values[6], mode, String(query));
    assert.deepEqual(JSON.parse(String(values[7])), conditions, String(query));
    // Each field is checked once, in field_id order.
    assert.deepEqual(
      lookups,
      conditions.map((condition) => condition.field_id),
      String(query),
    );
  }
  await request("");
  assert.deepEqual(values.slice(5, 8), [null, null, null]);
  // Three text values of 1000 characters that JSON doubles in length stay under the 8192-character bound.
  const quoted = '"'.repeat(1000);
  const large = JSON.stringify([
    { ...text, field_value: quoted },
    { field_id: setFields[1], field_operator: "is_set" },
    { field_id: setFields[2], field_operator: "is_unset" },
  ]);
  assert.ok(large.length > 2000 && large.length <= 8192);
  assert.equal((await request(new URLSearchParams({ field_conditions: large }))).status, 200);
  const longest = JSON.stringify([text]).padEnd(8192, " ");
  assert.equal((await request(new URLSearchParams({ field_conditions: longest }))).status, 200);
  for (const [query, error] of [
    [set([text, score, day, flag]), "invalid_field_condition"],
    [set([text, { ...text, field_value: "y" }]), "invalid_field_condition"],
    [set([text, { ...text, field_id: setFields[0].toUpperCase() }]), "invalid_field_condition"],
    [set([]), "invalid_field_condition"],
    [set(text), "invalid_field_condition"],
    [set(null), "invalid_field_condition"],
    [set([null]), "invalid_field_condition"],
    [set(["x"]), "invalid_field_condition"],
    [set([{ field_operator: "is_set" }]), "invalid_field_condition"],
    [set([{ field_id: null, field_operator: "is_set" }]), "invalid_field_condition"],
    [set([{ ...text, extra: 1 }]), "invalid_field_condition"],
    [set([{ field_id: setFields[0], field_operator: "eq" }]), "invalid_field_condition"],
    [set([{ field_id: setFields[0], field_operator: "eq", field_value: null }]), "invalid_field_condition"],
    [set([{ ...flag, field_value: true }]), "invalid_field_condition"],
    [set([{ field_id: "not-a-uuid", field_operator: "is_set" }]), "invalid_field_condition"],
    [set([{ ...text, field_operator: "contains" }]), "invalid_field_condition"],
    // A JSON-escaped lone surrogate parses, but PostgreSQL refuses it as jsonb input.
    [set([{ ...text, field_value: "\ud800" }]), "invalid_field_condition"],
    [set([text, { field_id: setFields[2], field_operator: "eq", field_value: "x\udc00" }]), "invalid_field_condition"],
    [
      new URLSearchParams({ field_id: setFields[0], field_operator: "eq", field_value: '"\\ud800"' }),
      "invalid_field_condition",
    ],
    [new URLSearchParams({ field_conditions: "[{" }), "invalid_field_condition"],
    [new URLSearchParams({ field_conditions: "" }), "invalid_field_condition"],
    [new URLSearchParams({ field_conditions: JSON.stringify([text]).padEnd(8193, " ") }), "invalid_field_condition"],
    [set([text], { field_id: setFields[1], field_operator: "is_set" }), "invalid_field_condition"],
    [set([text], { field_operator: "is_set" }), "invalid_field_condition"],
    [set([text, score], { field_mode: "none" }), "invalid_field_condition"],
    [set([text, score], { field_mode: "ANY" }), "invalid_field_condition"],
    [set([text, score], { field_mode: "" }), "invalid_field_condition"],
    [new URLSearchParams({ field_mode: "all" }), "invalid_field_condition"],
    [new URLSearchParams({ field_mode: "" }), "invalid_field_condition"],
    [`field_conditions=${encodeURIComponent(JSON.stringify([text]))}&field_conditions=[]`, "invalid_contact_request"],
    [`${set([text, score], { field_mode: "all" })}&field_mode=any`, "invalid_contact_request"],
    // The field set is one side of the tag/field OR, which still needs a tag.
    [set([text, score], { condition_operator: "or" }), "invalid_contact_condition"],
    [set([text, score], { segment_id: segmentId }), "invalid_contact_request"],
    [new URLSearchParams({ segment_id: segmentId, field_mode: "any" }), "invalid_contact_request"],
    [new URLSearchParams({ segment_id: segmentId, field_conditions: "[{" }), "invalid_contact_request"],
  ] as const) {
    queried = false;
    const response = await request(query);
    assert.equal(response.status, 400, String(query));
    assert.deepEqual(await response.json(), { error }, String(query));
    assert.equal(queried, false, `${query} must fail before database access`);
  }
  // A set with a tag OR passes the operator check.
  const either = await request(set([text, score], { tag: "lead", condition_operator: "or" }));
  assert.equal(either.status, 200);
  assert.equal(values[8], "or");
});

test("segment definitions take the legacy field keys or a set of one to three field conditions with a mode", async () => {
  const fields = (definition: Record<string, unknown>) =>
    parseSegmentDefinition({ name: "Scored", ...definition }).fieldCondition;
  const text = { field_id: setFields[0], field_operator: "eq", field_value: "x" };
  const score = { field_id: setFields[1], field_operator: "gt", field_value: 3 };
  const flag = { field_id: setFields[3], field_operator: "is_set" };
  assert.equal(fields({}), null);
  assert.equal(fields({ field_conditions: null, field_mode: null }), null);
  assert.equal(fields({ field_id: null, field_conditions: null }), null);
  assert.deepEqual(fields(text), { conditions: [text], mode: "all" });
  // A set of one condition is the legacy condition, whatever the mode.
  assert.deepEqual(fields({ field_conditions: [text], field_mode: "any" }), { conditions: [text], mode: "all" });
  assert.deepEqual(fields({ ...text, field_mode: "any" }), { conditions: [text], mode: "all" });
  assert.deepEqual(fields({ field_conditions: [score, text] }), { conditions: [text, score], mode: "all" });
  assert.deepEqual(
    fields({ field_conditions: [flag, score, { ...text, field_id: setFields[0].toUpperCase() }], field_mode: "any" }),
    { conditions: [text, score, flag], mode: "any" },
  );
  // A legacy key that is null counts as absent, so it can go with a set.
  assert.deepEqual(fields({ field_id: null, field_conditions: [text, score] }), {
    conditions: [text, score],
    mode: "all",
  });
  for (const [body, code] of [
    [{ ...text, field_conditions: [score, flag] }, "invalid_field_condition"],
    [{ ...text, field_conditions: [text] }, "invalid_field_condition"],
    [{ field_operator: "is_set", field_conditions: [text, score] }, "invalid_field_condition"],
    [{ field_conditions: [] }, "invalid_field_condition"],
    [{ field_conditions: text }, "invalid_field_condition"],
    [{ field_conditions: JSON.stringify([text, score]) }, "invalid_field_condition"],
    [
      { field_conditions: [text, score, flag, { field_id: setFields[2], field_operator: "is_set" }] },
      "invalid_field_condition",
    ],
    [{ field_conditions: [text, { field_id: setFields[0], field_operator: "is_set" }] }, "invalid_field_condition"],
    [{ field_conditions: [text, null] }, "invalid_field_condition"],
    [{ field_conditions: [text, { ...score, extra: true }] }, "invalid_field_condition"],
    [{ field_conditions: [text, { field_operator: "is_set" }] }, "invalid_field_condition"],
    [{ field_conditions: [text, { field_id: setFields[1], field_operator: "gt" }] }, "invalid_field_condition"],
    [{ field_conditions: [text, score], field_mode: "none" }, "invalid_field_condition"],
    [{ field_conditions: [text, score], field_mode: 1 }, "invalid_field_condition"],
    [{ field_conditions: [{ ...text, field_value: "\ud800" }, score] }, "invalid_field_condition"],
    [{ ...text, field_value: "\udc00x" }, "invalid_field_condition"],
    [{ field_mode: "all" }, "invalid_field_condition"],
    [{ field_conditions: [text, score], condition_operator: "or" }, "invalid_contact_condition"],
  ] as const) {
    assert.throws(() => fields(body), refused(code), JSON.stringify(body));
    await assert.rejects(createContactSegment(segmentPool, segmentUser, { name: "Scored", ...body }), refused(code));
    await assert.rejects(
      updateContactSegment(segmentPool, segmentUser, segmentId, { name: "Scored", ...body, expected_version: 1 }),
      refused(code),
    );
  }
  for (const definition of [
    { field_conditions: [score, text], field_mode: "any" },
    { field_conditions: [score, text], field_mode: "any", tags: ["a", "b"], condition_operator: "or" },
  ]) {
    await assert.rejects(
      createContactSegment(segmentPool, segmentUser, { name: "Scored", ...definition }),
      reachedDatabase,
    );
    await assert.rejects(
      updateContactSegment(segmentPool, segmentUser, segmentId, { name: "Scored", ...definition, expected_version: 1 }),
      reachedDatabase,
    );
  }
});

// Condition tree builders: a tag leaf, a negated tag leaf, a group and a tree.
const has = (tag: string) => ({ tag });
const lacks = (tag: string) => ({ tag, negate: true });
const group = (mode: string, ...conditions: unknown[]) => ({ mode, conditions });
const tree = (mode: string, ...groups: unknown[]) => ({ mode, groups });

test("contact condition trees take one bounded JSON tree in $19 and refuse other shapes before database access", async () => {
  let values: unknown[] = [];
  let lookups: unknown[] = [];
  let queried = false;
  const pool = {
    query: async (sql: string, parameters: unknown[]) => {
      queried = true;
      if (sql.includes("workspace_members")) return { rows: [{ workspace_id: workspaceId, role: "owner" }] };
      if (sql.includes("FROM instagram_contact_fields WHERE")) {
        lookups.push(parameters[1]);
        return { rows: [{ type: setFieldTypes[String(parameters[1])] }] };
      }
      values = parameters;
      return {
        rows: [
          {
            connection_id: null,
            preview_total: "1",
            preview_evaluated: "9007199254740997",
            preview_excluded_activity: "2",
            preview_excluded_conditions: "9007199254740994",
            preview_excluded_tag: "0",
            preview_excluded_field: "0",
            preview_excluded_both: "0",
          },
        ],
      };
    },
    end: async () => {},
  } as unknown as Pool;
  const request = (query: URLSearchParams | string) =>
    appApi(
      new Request(`https://app.test/api/contacts?${query}`, { headers: { cookie: "__Host-ac-access=test" } }),
      config,
      () => pool,
      mediaFetch(),
    );
  const withTree = (value: unknown, extra: Record<string, string> = {}) =>
    new URLSearchParams({ condition_tree: JSON.stringify(value), ...extra });
  const text = { field_id: setFields[0], field_operator: "eq", field_value: "x" };
  const score = { field_id: setFields[1], field_operator: "gte", field_value: 100000 };
  const day = { field_id: setFields[2], field_operator: "lt", field_value: "2026-10-18" };
  const flag = { field_id: setFields[3], field_operator: "is_unset" };
  // "(VIP and spent at least 100000) or event": the tree goes in $19, and the tag, field and operator positions stay
  // NULL, NULL and "and", so their predicates are true.
  const vip = tree("any", group("all", has("vip"), score), group("all", has("event")));
  const list = await request(withTree(vip));
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { contacts: [], after: null });
  assert.equal(values.length, 19);
  assert.deepEqual(JSON.parse(String(values[18])), vip);
  assert.deepEqual([values[2], values[5], values[6], values[7], values[8]], [null, null, null, null, "and"]);
  // Without a tree $19 is NULL.
  await request("");
  assert.equal(values[18], null);
  // Normalization: tags as contact tags, lowercase field IDs and negate false dropped; groups and leaves keep their
  // order, a tag or a field may repeat, and field leaves are checked in leaf order, repeats included.
  for (const [input, normalized] of [
    [tree("all", group("any", has(" VIP "))), tree("all", group("any", has("vip")))],
    [
      tree("all", group("all", { tag: "b", negate: false }, lacks("A"))),
      tree("all", group("all", has("b"), lacks("a"))),
    ],
    [
      tree(
        "any",
        group("all", { ...day, field_id: setFields[2].toUpperCase() }, has("b"), has("a")),
        group("any", text, has("b"), { ...score, field_operator: "lt", field_value: 100 }, score),
      ),
      tree(
        "any",
        group("all", day, has("b"), has("a")),
        group("any", text, has("b"), { ...score, field_operator: "lt", field_value: 100 }, score),
      ),
    ],
    [tree("all", group("all", flag), group("all", flag)), tree("all", group("all", flag), group("all", flag))],
  ] as const) {
    lookups = [];
    const response = await request(withTree(input));
    assert.equal(response.status, 200, JSON.stringify(input));
    assert.deepEqual(JSON.parse(String(values[18])), normalized, JSON.stringify(input));
    assert.deepEqual(
      lookups,
      (normalized.groups as { conditions: Record<string, unknown>[] }[]).flatMap((value) =>
        value.conditions.flatMap((leaf) => ("field_id" in leaf ? [leaf.field_id] : [])),
      ),
    );
  }
  // Counts: 1 to 5 groups, 1 to 5 leaves per group and at most 10 leaves in all.
  const leaves = (count: number) => Array.from({ length: count }, (_, index) => has(`t${index}`));
  for (const value of [
    tree("all", group("all", ...leaves(1))),
    tree("all", group("all", ...leaves(5))),
    tree("any", ...Array.from({ length: 5 }, () => group("any", ...leaves(2)))),
    tree("all", group("all", ...leaves(5)), group("all", ...leaves(5))),
  ])
    assert.equal((await request(withTree(value))).status, 200, JSON.stringify(value));
  // Preview with a tree: one reason after the limits, and no tag, field or both keys.
  const preview = await request(withTree(vip, { preview: "true", last_comment_days: "7" }));
  assert.deepEqual((await preview.json()).excluded, { activity: "2", conditions: "9007199254740994" });
  // Ten text leaves of 1000 characters that need no escaping stay under the bound; the bound is on decoded text.
  const wide = tree(
    "all",
    ...Array.from({ length: 5 }, () =>
      group("all", ...[0, 1].map(() => ({ ...text, field_value: "가".repeat(1000) }))),
    ),
  );
  assert.ok(JSON.stringify(wide).length > 10000 && JSON.stringify(wide).length <= 16384);
  assert.equal((await request(withTree(wide))).status, 200);
  assert.equal(
    (await request(new URLSearchParams({ condition_tree: JSON.stringify(vip).padEnd(16384, " ") }))).status,
    200,
  );
  const repeated = new URLSearchParams({ condition_tree: JSON.stringify(vip) });
  repeated.append("condition_tree", JSON.stringify(vip));
  for (const [query, error] of [
    [withTree(tree("all")), "invalid_contact_condition"],
    [withTree(tree("all", ...Array.from({ length: 6 }, () => group("all", has("a"))))), "invalid_contact_condition"],
    [withTree(tree("all", group("all"))), "invalid_contact_condition"],
    [withTree(tree("all", group("all", ...leaves(6)))), "invalid_contact_condition"],
    [
      withTree(tree("all", group("all", ...leaves(5)), group("all", ...leaves(5)), group("all", ...leaves(1)))),
      "invalid_contact_condition",
    ],
    [withTree({ groups: [group("all", has("a"))] }), "invalid_contact_condition"],
    [withTree(tree("none", group("all", has("a")))), "invalid_contact_condition"],
    [withTree(tree("ALL", group("all", has("a")))), "invalid_contact_condition"],
    [withTree(tree("all", group("either", has("a")))), "invalid_contact_condition"],
    [withTree(tree("all", { conditions: [has("a")] })), "invalid_contact_condition"],
    [withTree({ ...tree("all", group("all", has("a"))), extra: 1 }), "invalid_contact_condition"],
    [withTree(tree("all", { ...group("all", has("a")), extra: 1 })), "invalid_contact_condition"],
    [withTree(tree("all", group("all", { tag: "a", extra: 1 }))), "invalid_contact_condition"],
    [withTree(tree("all", group("all", { tag: "a", ...flag }))), "invalid_contact_condition"],
    [withTree(tree("all", group("all", {}))), "invalid_contact_condition"],
    [withTree(tree("all", group("all", { negate: true }))), "invalid_contact_condition"],
    [withTree(tree("all", group("all", null))), "invalid_contact_condition"],
    [withTree(tree("all", group("all", "a"))), "invalid_contact_condition"],
    [withTree(tree("all", "a")), "invalid_contact_condition"],
    [withTree({ mode: "all", groups: {} }), "invalid_contact_condition"],
    [withTree({ mode: "all", groups: [{ mode: "all", conditions: has("a") }] }), "invalid_contact_condition"],
    [withTree([group("all", has("a"))]), "invalid_contact_condition"],
    [withTree(null), "invalid_contact_condition"],
    [withTree("tree"), "invalid_contact_condition"],
    [new URLSearchParams({ condition_tree: "{" }), "invalid_contact_condition"],
    [new URLSearchParams({ condition_tree: "" }), "invalid_contact_condition"],
    [new URLSearchParams({ condition_tree: JSON.stringify(vip).padEnd(16385, " ") }), "invalid_contact_condition"],
    // negate is true or false only.
    ...["true", 1, null, "yes"].map(
      (negate) =>
        [withTree(tree("all", group("all", { tag: "a", negate }))), "invalid_contact_condition"] as [
          URLSearchParams,
          string,
        ],
    ),
    // Tag leaves follow the contact tag rules, field leaves the field condition rules.
    [withTree(tree("all", group("all", has("")))), "invalid_contact_tags"],
    [withTree(tree("all", group("all", has("x".repeat(41))))), "invalid_contact_tags"],
    [withTree(tree("all", group("all", { tag: 1 }))), "invalid_contact_tags"],
    [withTree(tree("all", group("all", { tag: null }))), "invalid_contact_tags"],
    [withTree(tree("all", group("all", has("a\u0000")))), "invalid_contact_tags"],
    // A JSON-escaped lone surrogate parses, but PostgreSQL refuses it as jsonb input.
    [
      new URLSearchParams({
        condition_tree: '{"mode":"all","groups":[{"mode":"all","conditions":[{"tag":"\\ud800"}]}]}',
      }),
      "invalid_contact_tags",
    ],
    [withTree(tree("all", group("all", { field_id: null, field_operator: "is_set" }))), "invalid_field_condition"],
    [
      withTree(tree("all", group("all", { field_id: "not-a-uuid", field_operator: "is_set" }))),
      "invalid_field_condition",
    ],
    [withTree(tree("all", group("all", { ...text, field_operator: "contains" }))), "invalid_field_condition"],
    [withTree(tree("all", group("all", { field_id: setFields[0], field_operator: "eq" }))), "invalid_field_condition"],
    [withTree(tree("all", group("all", { ...text, field_value: null }))), "invalid_field_condition"],
    [withTree(tree("all", group("all", { ...flag, field_value: true }))), "invalid_field_condition"],
    // An unknown key on a field leaf is a tree shape error, as at every other level.
    [withTree(tree("all", group("all", { ...text, field_mode: "all" }))), "invalid_contact_condition"],
    [withTree(tree("all", group("all", { ...text, field_value: "\ud800" }))), "invalid_field_condition"],
    // The tree is the third condition form, never mixed with the tag, field or operator keys or with segment_id.
    ...(
      [
        { tag: "lead" },
        { tag_mode: "all" },
        { field_id: setFields[0], field_operator: "is_set" },
        { field_operator: "is_set" },
        { field_value: '"x"' },
        { field_conditions: JSON.stringify([text]) },
        { field_mode: "all" },
        { condition_operator: "and" },
        { condition_operator: "or" },
      ] as Record<string, string>[]
    ).map((extra) => [withTree(vip, extra), "invalid_contact_condition"] as [URLSearchParams, string]),
    [withTree(vip, { segment_id: segmentId }), "invalid_contact_request"],
    [new URLSearchParams({ segment_id: segmentId, condition_tree: "{" }), "invalid_contact_request"],
    [repeated, "invalid_contact_request"],
  ] as [URLSearchParams | string, string][]) {
    queried = false;
    const response = await request(query);
    assert.equal(response.status, 400, String(query));
    assert.deepEqual(await response.json(), { error }, String(query));
    assert.equal(queried, false, `${query} must fail before database access`);
  }
  // The outer limits combine with a tree.
  const limited = await request(
    withTree(vip, {
      connection_id: connectionId,
      last_comment_days: "7",
      consent_purpose: "marketing",
      consent_state: "granted",
      dm_consent_purpose: "marketing",
      dm_consent_state: "granted",
      last_dm_days: "3",
    }),
  );
  assert.equal(limited.status, 200);
  assert.deepEqual(
    [values[1], values[13], values[11], values[15], values[17]],
    [connectionId, 7, "marketing", "marketing", 3],
  );
  assert.deepEqual(JSON.parse(String(values[18])), vip);
});

test("segment definitions take a condition tree as a third form and lock its fields in field_id order", async () => {
  const parsed = (definition: Record<string, unknown>) => parseSegmentDefinition({ name: "Grouped", ...definition });
  const score = { field_id: setFields[1], field_operator: "gte", field_value: 100000 };
  const text = { field_id: setFields[0], field_operator: "eq", field_value: "x" };
  const vip = tree("any", group("all", has("vip"), score), group("all", has("event")));
  assert.equal(parsed({}).conditionTree, null);
  assert.equal(parsed({ condition_tree: null }).conditionTree, null);
  const definition = parsed({
    condition_tree: tree(
      "any",
      group("all", { tag: " VIP ", negate: false }, { ...score, field_id: setFields[1].toUpperCase() }),
      group("all", has("event")),
    ),
  });
  assert.deepEqual(definition.conditionTree, vip);
  assert.deepEqual([definition.tagCondition, definition.fieldCondition, definition.operator], [null, null, "and"]);
  // Absent, null and empty legacy keys count as absent, as for the other forms.
  for (const absent of [
    { tag: null },
    { tag: "" },
    { tags: null },
    { field_id: null },
    { field_conditions: null },
    { field_mode: null },
  ])
    assert.deepEqual(parsed({ condition_tree: vip, ...absent }).conditionTree, vip, JSON.stringify(absent));
  for (const [body, code] of [
    [{ tag: "lead" }, "invalid_contact_condition"],
    [{ tags: ["a", "b"] }, "invalid_contact_condition"],
    [{ tags: [] }, "invalid_contact_condition"],
    [{ tag_mode: "any" }, "invalid_contact_condition"],
    [{ ...text }, "invalid_contact_condition"],
    [{ field_operator: "is_set" }, "invalid_contact_condition"],
    [{ field_value: null }, "invalid_contact_condition"],
    [{ field_conditions: [text, score] }, "invalid_contact_condition"],
    [{ field_mode: "all" }, "invalid_contact_condition"],
    [{ condition_operator: "and" }, "invalid_contact_condition"],
    [{ condition_operator: "or" }, "invalid_contact_condition"],
    [{ condition_operator: null }, "invalid_contact_condition"],
  ] as const) {
    const mixed = { name: "Grouped", condition_tree: vip, ...body };
    assert.throws(() => parseSegmentDefinition(mixed), refused(code), JSON.stringify(body));
    await assert.rejects(createContactSegment(segmentPool, segmentUser, mixed), refused(code));
    await assert.rejects(
      updateContactSegment(segmentPool, segmentUser, segmentId, { ...mixed, expected_version: 1 }),
      refused(code),
    );
  }
  for (const [value, code] of [
    [tree("all"), "invalid_contact_condition"],
    [[], "invalid_contact_condition"],
    ["tree", "invalid_contact_condition"],
    [JSON.stringify(vip), "invalid_contact_condition"],
    [tree("all", group("all", has(" "))), "invalid_contact_tags"],
    [tree("all", group("all", { field_id: setFields[0], field_operator: "eq" })), "invalid_field_condition"],
    [tree("all", group("all", { field_id: null, field_operator: "is_set" })), "invalid_field_condition"],
    [tree("all", group("all", { ...text, extra: 1 })), "invalid_contact_condition"],
    [tree("all", group("all", { ...has("a"), extra: 1 })), "invalid_contact_condition"],
  ] as const) {
    assert.throws(() => parsed({ condition_tree: value }), refused(code), JSON.stringify(value));
    await assert.rejects(
      createContactSegment(segmentPool, segmentUser, { name: "Grouped", condition_tree: value }),
      refused(code),
    );
  }
  // A write validates every field leaf, repeats included, in field_id order rather than leaf order, locks each
  // distinct field FOR SHARE once, with its first leaf, and stores the tree as one jsonb value after the other
  // definition columns.
  const lookups: unknown[] = [];
  let inserted: unknown[] = [];
  const client = {
    query: async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes("FROM instagram_contact_fields WHERE")) {
        lookups.push([parameters[1], sql.endsWith(" FOR SHARE")]);
        return { rows: [{ type: setFieldTypes[String(parameters[1])] }] };
      }
      if (sql.includes("workspace_members")) return { rows: [{ role: "owner" }] };
      if (sql.includes("INSERT INTO instagram_contact_segments")) {
        inserted = parameters;
        return {
          rows: [
            {
              id: segmentId,
              name: "Grouped",
              connection_id: null,
              tag: null,
              tags: null,
              tag_mode: null,
              field_id: null,
              field_operator: null,
              field_value: null,
              field_conditions: null,
              field_mode: null,
              condition_operator: "and",
              condition_tree: JSON.parse(String(parameters[21])),
              version: 1,
            },
          ],
        };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const writePool = {
    query: async () => ({ rows: [{ workspace_id: workspaceId, role: "owner" }] }),
    connect: async () => client,
  } as unknown as Pool;
  const ordered = tree("all", group("any", score, text), group("all", has("a"), score));
  const created = await createContactSegment(writePool, segmentUser, { name: "Grouped", condition_tree: ordered });
  assert.deepEqual(lookups, [
    [setFields[0], true],
    [setFields[1], true],
    [setFields[1], false],
  ]);
  assert.equal(inserted.length, 22);
  // tag, field_id, field_operator, field_value and condition_operator follow the workspace, name and connection.
  assert.deepEqual(inserted.slice(3, 8), [null, null, null, null, "and"]);
  assert.deepEqual(JSON.parse(String(inserted[21])), ordered);
  // A tree segment answers with its tree and no tag or field key.
  assert.deepEqual(created, {
    id: segmentId,
    name: "Grouped",
    connection_id: null,
    condition_tree: ordered,
    version: 1,
  });
});

test("segment create and edit read a body large enough for the largest tree the parser accepts", async () => {
  // Ten text leaves of 1,000 Korean characters (three UTF-8 bytes each, the most JSON.stringify writes per UTF-16
  // unit for a valid value) and a 60-character Korean name padded to the 300-unit raw name limit.
  const leaf = { field_id: setFields[0], field_operator: "eq", field_value: "가".repeat(1000) };
  const largest = {
    name: `${"가".repeat(60)}${" ".repeat(240)}`,
    connection_id: connectionId,
    condition_tree: tree(
      "any",
      ...Array.from({ length: 2 }, () =>
        group("all", ...Array.from({ length: CONDITION_TREE_LEAF_LIMIT / 2 }, () => leaf)),
      ),
    ),
    last_comment_days: 366,
    consent_purpose: "marketing",
    consent_state: "granted",
    dm_consent_purpose: "marketing",
    dm_consent_state: "granted",
    last_dm_days: 366,
  };
  assert.doesNotThrow(() => parseSegmentDefinition(largest));
  const bytes = Buffer.byteLength(JSON.stringify({ ...largest, expected_version: 1 }));
  assert.ok(bytes > 16_384, "the default readJson limit alone must refuse it");
  assert.ok(bytes <= SEGMENT_REQUEST_BYTES / 2, `${bytes} bytes`);
  // An agent passes the write limits and the body read, then the admin check refuses it; an oversized body is 413.
  const pool = {
    query: async (sql: string) => {
      assert.match(sql, /FROM workspace_members WHERE user_id=\$1 AND removed_at IS NULL$/);
      return { rows: [{ workspace_id: workspaceId, role: "agent" }] };
    },
    connect: async () => assert.fail("a refused request must not write the database"),
    end: async () => {},
  } as unknown as Pool;
  for (const [path, method, body] of [
    ["/api/contact-segments", "POST", largest],
    [`/api/contact-segments/${segmentId}`, "PUT", { ...largest, expected_version: 1 }],
  ] as const) {
    const send = (text: string) =>
      appApi(
        new Request(`https://app.test${path}`, {
          method,
          headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
          body: text,
        }),
        config,
        () => pool,
        mediaFetch(),
      );
    const accepted = await send(JSON.stringify(body));
    assert.equal(accepted.status, 403, method);
    assert.deepEqual(await accepted.json(), { error: "role_forbidden" }, method);
    const oversized = await send(JSON.stringify(body).padEnd(SEGMENT_REQUEST_BYTES + 1, " "));
    assert.equal(oversized.status, 413, method);
    assert.deepEqual(await oversized.json(), { error: "request_too_large" }, method);
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
  // Invalid input runs no SQL after the workspace write limit's membership read (#167).
  const pool = membershipOnlyPool();
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
  const query = async (sql: string, values: unknown[] = []) => ({
    rows: sql.includes("workspace_members")
      ? [{ workspace_id: workspaceId, role: "owner" }]
      : values[2] === sender
        ? [{ tags: ["lead"] }]
        : [],
  });
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
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

// Default API request limits (#167).
const sessionFetch = (async () =>
  Response.json({ id: userId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch;
const writeRequest = (path: string, method = "POST") =>
  new Request(`https://app.test${path}`, {
    method,
    headers: {
      origin: "https://app.test",
      cookie: "__Host-ac-access=test-session",
      "content-type": "application/json",
    },
    body: "{}",
  });
const sessionGet = (path: string) =>
  new Request(`https://app.test${path}`, { headers: { cookie: "__Host-ac-access=test-session" } });
const memberId = "33333333-3333-4333-8333-333333333333";
// A pool for an owner of the test workspace: every read answers the caller's membership, its time zone and its
// plan usage, and a transaction finds the target member as an agent.
const ownerPool = () => {
  const row = { workspace_id: workspaceId, role: "owner", time_zone: "Asia/Seoul" };
  const usage = { plan: "free", members: 1, open_invites: 0, connections: 0 };
  return {
    query: async (sql: string) => ({ rows: [sql.includes("open_invites") ? usage : row], rowCount: 1 }),
    connect: async () => ({
      query: async (sql: string) =>
        sql.includes("SELECT role FROM workspace_members")
          ? { rows: [{ role: "agent" }], rowCount: 1 }
          : { rows: sql.includes("workspace_members") ? [row] : [], rowCount: 0 },
      release: () => {},
    }),
    end: async () => {},
  } as unknown as Pool;
};

test("a write over the per-user limit returns 429 before any route handler or database access (#167)", async () => {
  const user = recordingLimit(false),
    workspace = recordingLimit(true);
  let opened = 0;
  for (const [path, method] of [
    [`/api/connections/${connectionId}/contacts/888`, "PATCH"],
    // Member removal skips only the workspace limit.
    [`/api/workspace/members/${memberId}`, "DELETE"],
    [`/api/connections/${connectionId}`, "DELETE"],
  ] as const) {
    const response = await appApi(
      writeRequest(path, method),
      { ...config, API_WRITE_USER_LIMIT: user.binding, API_WRITE_WORKSPACE_LIMIT: workspace.binding },
      () => {
        opened++;
        return untouchedPool();
      },
      sessionFetch,
    );
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "rate_limited" });
  }
  assert.equal(opened, 0);
  assert.deepEqual(user.keys, [userId, userId, userId]);
  assert.deepEqual(workspace.keys, []);
});

test("a write over the per-workspace limit returns 429 after only the membership read (#167)", async () => {
  const user = recordingLimit(true),
    workspace = recordingLimit(false);
  const response = await appApi(
    writeRequest(`/api/connections/${connectionId}/contacts/888`, "PATCH"),
    { ...config, API_WRITE_USER_LIMIT: user.binding, API_WRITE_WORKSPACE_LIMIT: workspace.binding },
    membershipOnlyPool,
    sessionFetch,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "rate_limited" });
  assert.deepEqual(user.keys, [userId]);
  assert.deepEqual(workspace.keys, [workspaceId]);
});

test("the dashboard bootstrap spends no write limit for a member and only the user limit to create (#167)", async () => {
  const user = recordingLimit(false),
    workspace = recordingLimit(false);
  const env = { ...config, API_WRITE_USER_LIMIT: user.binding, API_WRITE_WORKSPACE_LIMIT: workspace.binding };
  // A member loads the dashboard even after both write limits are spent.
  const member = await appApi(writeRequest("/api/workspace"), env, ownerPool, sessionFetch);
  assert.equal(member.status, 200);
  assert.deepEqual(await member.json(), {
    workspace_id: workspaceId,
    role: "owner",
    time_zone: "Asia/Seoul",
    plan: "free",
    limits: { seats: 1, connections: 1 },
    usage: { seats: 1, connections: 0 },
  });
  assert.deepEqual([user.keys, workspace.keys], [[], []]);
  // Without a membership the request creates a workspace, so it spends the user limit after the membership read.
  const queries: string[] = [];
  const create = await appApi(
    writeRequest("/api/workspace"),
    env,
    () =>
      ({
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: [] };
        },
        connect: async () => assert.fail("a refused bootstrap must not write the database"),
        end: async () => {},
      }) as unknown as Pool,
    sessionFetch,
  );
  assert.equal(create.status, 429);
  assert.deepEqual(await create.json(), { error: "rate_limited" });
  assert.equal(queries.length, 1);
  assert.deepEqual([user.keys, workspace.keys], [[userId], []]);
});

test("an owner removes a member after the workspace write limit is spent (#167)", async () => {
  const user = recordingLimit(true),
    workspace = recordingLimit(false);
  const response = await appApi(
    writeRequest(`/api/workspace/members/${memberId}`, "DELETE"),
    { ...config, API_WRITE_USER_LIMIT: user.binding, API_WRITE_WORKSPACE_LIMIT: workspace.binding },
    ownerPool,
    sessionFetch,
  );
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { removed: boolean }).removed, true);
  assert.deepEqual([user.keys, workspace.keys], [[userId], []]);
  // Any other write of the same owner is still refused by the spent workspace limit.
  const other = await appApi(
    writeRequest(`/api/workspace/members/${memberId}`, "PATCH"),
    { ...config, API_WRITE_USER_LIMIT: user.binding, API_WRITE_WORKSPACE_LIMIT: workspace.binding },
    ownerPool,
    sessionFetch,
  );
  assert.equal(other.status, 429);
  assert.deepEqual(workspace.keys, [workspaceId]);
});

test("a user without a workspace spends only the per-user write limit (#167)", async () => {
  const user = recordingLimit(true),
    workspace = recordingLimit(true);
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
    connect: async () => assert.fail("no write is expected"),
    end: async () => {},
  } as unknown as Pool;
  const response = await appApi(
    writeRequest("/api/no-such-route"),
    { ...config, API_WRITE_USER_LIMIT: user.binding, API_WRITE_WORKSPACE_LIMIT: workspace.binding },
    () => pool,
    sessionFetch,
  );
  assert.equal(response.status, 404);
  assert.deepEqual(user.keys, [userId]);
  assert.deepEqual(workspace.keys, []);
  assert.equal(queries.length, 1);
});

test("GET routes other than the inbox list and the auth routes spend none of the default limits (#167)", async () => {
  const user = recordingLimit(false),
    workspace = recordingLimit(false),
    inbox = recordingLimit(false);
  const env = {
    ...config,
    API_WRITE_USER_LIMIT: user.binding,
    API_WRITE_WORKSPACE_LIMIT: workspace.binding,
    INBOX_LIST_LIMIT: inbox.binding,
  };
  const pool = () =>
    ({
      query: async (sql: string) => ({
        rows: sql.includes("workspace_members") ? [{ workspace_id: workspaceId, role: "owner" }] : [],
      }),
      end: async () => {},
    }) as unknown as Pool;
  for (const path of ["/api/me", "/api/contacts", "/api/inbox/labels", "/api/no-such-route"]) {
    const response = await appApi(sessionGet(path), env, pool, sessionFetch);
    assert.notEqual(response.status, 429, path);
  }
  // Auth routes return before the session check, or (any other /api/auth/ path) are excluded by prefix.
  const login = await appApi(
    new Request("https://app.test/api/auth/login", {
      method: "POST",
      headers: { origin: "https://app.test", "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.test", password: "password-123" }),
    }),
    { ...env, AUTH_IP_LIMIT: { limit: async () => ({ success: false }) } },
    untouchedPool,
    sessionFetch,
  );
  assert.equal(login.status, 429);
  assert.deepEqual(await login.json(), { error: "auth_rate_limited" });
  const otherAuth = await appApi(writeRequest("/api/auth/unknown", "PUT"), env, pool, sessionFetch);
  assert.equal(otherAuth.status, 404);
  assert.deepEqual([user.keys, workspace.keys, inbox.keys], [[], [], []]);
});

test("the inbox list over its per-user limit returns 429 before any database access (#167)", async () => {
  const inbox = recordingLimit(false),
    user = recordingLimit(true);
  const response = await appApi(
    sessionGet("/api/inbox"),
    { ...config, INBOX_LIST_LIMIT: inbox.binding, API_WRITE_USER_LIMIT: user.binding },
    untouchedPool,
    sessionFetch,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "rate_limited" });
  assert.deepEqual(inbox.keys, [userId]);
  assert.deepEqual(user.keys, []);
});

test("an unavailable default limiter lets the request through and logs one fixed code (#167)", async (t) => {
  const lines: unknown[] = [];
  for (const method of ["error", "warn", "log"] as const)
    t.mock.method(console, method, (line: string) => lines.push(JSON.parse(line)));
  const expected = { event: "rate_limit_unavailable", code: "api_limit_unavailable", correlation_id: "corr-167" };
  // Both write limits unavailable: a throwing per-user limiter and a missing workspace binding.
  const write = await appApi(
    writeRequest("/api/no-such-route"),
    { ...config, API_WRITE_USER_LIMIT: recordingLimit("throw").binding, API_WRITE_WORKSPACE_LIMIT: undefined },
    untouchedPool,
    sessionFetch,
    undefined,
    "corr-167",
  );
  assert.equal(write.status, 404);
  assert.deepEqual(lines, [expected]);
  // A limiter object that answers with a non-OK status throws from durableLimits; a missing per-user binding too.
  lines.length = 0;
  const workspaceDown = await appApi(
    writeRequest("/api/no-such-route"),
    { ...config, API_WRITE_USER_LIMIT: undefined, API_WRITE_WORKSPACE_LIMIT: recordingLimit("throw").binding },
    membershipOnlyPool,
    sessionFetch,
    undefined,
    "corr-167",
  );
  assert.equal(workspaceDown.status, 404);
  assert.deepEqual(lines, [expected]);
  lines.length = 0;
  const inbox = await appApi(
    sessionGet("/api/inbox?unknown=1"),
    { ...config, INBOX_LIST_LIMIT: undefined },
    () =>
      ({
        query: async () => ({ rows: [{ workspace_id: workspaceId, role: "owner" }] }),
        end: async () => {},
      }) as unknown as Pool,
    sessionFetch,
    undefined,
    "corr-167",
  );
  // The list handler ran: it refused the unknown query key.
  assert.equal(inbox.status, 400);
  assert.deepEqual(await inbox.json(), { error: "invalid_inbox_query" });
  assert.deepEqual(lines, [expected]);
  assert.equal(JSON.stringify(lines).includes(userId), false);
});

test("a write refused by a default limit spends no Instagram connect allowance (#167)", async () => {
  const oauth = {
    ...config,
    APP_ORIGIN: "https://app.test",
    INSTAGRAM_OAUTH_APP_ID: "123",
    INSTAGRAM_OAUTH_APP_SECRET: "synthetic-secret",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    META_GRAPH_VERSION: "v26.0",
    INSTAGRAM_PUBLIC_CONNECT_ENABLED: "true",
  };
  for (const refused of ["API_WRITE_USER_LIMIT", "API_WRITE_WORKSPACE_LIMIT"] as const) {
    const connect = recordingLimit(true);
    const response = await appApi(
      writeRequest("/api/instagram/connect"),
      { ...oauth, [refused]: recordingLimit(false).binding, INSTAGRAM_CONNECT_LIMIT: connect.binding },
      membershipOnlyPool,
      sessionFetch,
    );
    assert.equal(response.status, 429, refused);
    assert.deepEqual(await response.json(), { error: "rate_limited" }, refused);
    assert.deepEqual(connect.keys, [], refused);
  }
});

// Segment target snapshots (#35): shape refusals never reach the database, and the CSV spends the contact export
// allowance before the database is opened.
test("segment snapshot routes refuse cross-origin writes, malformed IDs, queries and bodies before the database", async () => {
  const send = (path: string, method = "GET", init: RequestInit = {}, env: Parameters<typeof appApi>[1] = config) =>
    appApi(
      new Request(`https://app.test${path}`, {
        method,
        ...init,
        headers: { cookie: "__Host-ac-access=test-session", origin: "https://app.test", ...init.headers },
      }),
      env,
      membershipOnlyPool,
      mediaFetch(),
    );
  const crossOrigin = await appApi(
    new Request(`https://app.test/api/contact-segments/${segmentId}/snapshots`, {
      method: "POST",
      headers: { origin: "https://evil.test" },
    }),
    config,
    untouchedPool,
  );
  assert.equal(crossOrigin.status, 403);
  for (const [path, method] of [
    ["/api/contact-segments/123/snapshots", "POST"],
    ["/api/contact-segments/123/snapshots", "GET"],
    ["/api/segment-snapshots/123", "GET"],
    [`/api/segment-snapshots/${segmentId}?after=bad!`, "GET"],
    [`/api/segment-snapshots/${segmentId}?page=2`, "GET"],
  ]) {
    const response = await send(path, method);
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: "invalid_snapshot_request" }, path);
  }
  for (const body of ['{"note":"x"}', "[]", "null", "1"]) {
    const response = await send(`/api/contact-segments/${segmentId}/snapshots`, "POST", {
      body,
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 400, body);
    assert.deepEqual(await response.json(), { error: "invalid_snapshot_request" }, body);
  }
  const limiter = recordingLimit(true);
  const csv = await send(
    `/api/segment-snapshots/${segmentId}/members.csv?x=1`,
    "GET",
    {},
    {
      ...config,
      CONTACT_EXPORT_LIMIT: limiter.binding,
    },
  );
  assert.equal(csv.status, 400);
  assert.deepEqual(await csv.json(), { error: "invalid_snapshot_request" });
  assert.deepEqual(limiter.keys, []);
});

test("a segment snapshot request with a zero-byte body passes the body check whatever its headers say", async () => {
  const send = async (init: RequestInit) => {
    let reached = false;
    const response = await appApi(
      new Request(`https://app.test/api/contact-segments/${segmentId}/snapshots`, {
        method: "POST",
        ...init,
        headers: { cookie: "__Host-ac-access=test-session", origin: "https://app.test", ...init.headers },
      }),
      config,
      () =>
        ({
          query: async (sql: string) => {
            if (/^SELECT workspace_id FROM workspace_members WHERE user_id=\$1 AND removed_at IS NULL$/.test(sql))
              return { rows: [{ workspace_id: workspaceId }] };
            reached = true;
            throw new Error("database reached");
          },
          connect: async () => {
            reached = true;
            throw new Error("database reached");
          },
          end: async () => {},
        }) as unknown as Pool,
      mediaFetch(),
    );
    return { response, reached };
  };
  // A streamed empty body has a non-null body and no Content-Length, and the runtime adds a text/plain type.
  const streamed = new Request("https://app.test/", { method: "POST", body: "" });
  assert.notEqual(streamed.body, null);
  assert.equal(streamed.headers.get("content-length"), null);
  for (const init of [
    {},
    { body: "" },
    { body: "", headers: { "content-type": "application/json" } },
    { body: "{}", headers: { "content-type": "application/json" } },
  ] as RequestInit[]) {
    const { response, reached } = await send(init);
    assert.equal(response.status, 503, JSON.stringify(init));
    assert.equal(reached, true, JSON.stringify(init));
  }
  for (const [init, status, error] of [
    [{ body: "{}" }, 415, "json_required"],
    [{ body: " ", headers: { "content-type": "application/json" } }, 400, "invalid_json"],
    [{ body: "x".repeat(1025), headers: { "content-type": "application/json" } }, 413, "request_too_large"],
  ] as const) {
    const { response, reached } = await send(init);
    assert.equal(response.status, status, init.body);
    assert.deepEqual(await response.json(), { error }, init.body);
    assert.equal(reached, false, init.body);
  }
});

test("the segment snapshot CSV fails closed on the contact export allowance before opening the database", async () => {
  for (const [binding, status, error] of [
    [recordingLimit(false).binding, 429, "contact_export_rate_limited"],
    [undefined, 503, "contact_export_unavailable"],
    [recordingLimit("throw").binding, 503, "contact_export_unavailable"],
  ] as const) {
    let opened = false;
    const response = await appApi(
      new Request(`https://app.test/api/segment-snapshots/${segmentId}/members.csv`, {
        headers: { cookie: "__Host-ac-access=test-session" },
      }),
      { ...config, CONTACT_EXPORT_LIMIT: binding },
      () => {
        opened = true;
        return untouchedPool();
      },
      mediaFetch(),
    );
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
    assert.equal(opened, false);
    assert.equal(response.headers.has("content-disposition"), false);
  }
});

test("a snapshot request body is empty or exactly {}, checked before the role read", async () => {
  assert.equal(parseSnapshotRequest(undefined), undefined);
  assert.equal(parseSnapshotRequest({}), undefined);
  for (const input of [null, [], "", 0, { note: 1 }, { expected_version: 1 }])
    assert.throws(() => parseSnapshotRequest(input), refused("invalid_snapshot_request"), JSON.stringify(input));
  await assert.rejects(
    createSegmentSnapshot(segmentPool, segmentUser, segmentId, { x: 1 }),
    refused("invalid_snapshot_request"),
  );
  await assert.rejects(
    createSegmentSnapshot(segmentPool, segmentUser, "bad", undefined),
    refused("invalid_snapshot_request"),
  );
  await assert.rejects(createSegmentSnapshot(segmentPool, segmentUser, segmentId, undefined), reachedDatabase);
  assert.deepEqual(SEGMENT_SNAPSHOT_LIMITS, {
    maxMembers: 5000,
    perWorkspace: 200,
    maxStoredMembers: 20_000,
    pageSize: 50,
  });
});
