import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthClient, ApiError, requireSameOrigin } from "./auth.ts";

const config = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key" };
const userId = "11111111-1111-4111-8111-111111111111";

test("protected requests require a session and a remotely verified confirmed user", async () => {
  let calls = 0;
  const client = new AuthClient(config, async (_input, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer signed-token");
    return Response.json({ id: userId, email: "owner@example.test", email_confirmed_at: "2026-01-01" });
  });
  await assert.rejects(
    client.user(new Request("https://app.test/api/me")),
    (e: unknown) => e instanceof ApiError && e.status === 401,
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await client.user(new Request("https://app.test/api/me", { headers: { cookie: "__Host-ac-access=signed-token" } })),
    { id: userId, email: "owner@example.test" },
  );
  assert.equal(calls, 1);
});

test("invalid or unconfirmed remote users cannot authorize requests", async () => {
  for (const data of [
    { id: userId, email: "x@test" },
    { id: "bad-id", email_confirmed_at: "yes" },
  ]) {
    const client = new AuthClient(config, async () => Response.json(data));
    await assert.rejects(
      client.user(new Request("https://app.test/api/me", { headers: { cookie: "__Host-ac-access=untrusted" } })),
      ApiError,
    );
  }
});

test("login puts session tokens in secure HttpOnly cookies, never response JSON", async () => {
  const client = new AuthClient(config, async () =>
    Response.json({ access_token: "access-test", refresh_token: "refresh-test", expires_in: 3600 }),
  );
  const response = await client.login({ email: "owner@example.test", password: "example-password" });
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) {
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
  }
  assert.doesNotMatch(await response.text(), /access-test|refresh-test/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("remote redirects are refused rather than following credentials", async () => {
  const client = new AuthClient(config, async (_url, init) => {
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://attacker.test" } });
  });
  await assert.rejects(client.login({ email: "x@y.test", password: "test-password" }), ApiError);
});

test("mutations reject missing and cross-origin Origin headers", () => {
  for (const origin of [undefined, "https://attacker.test", "null"]) {
    assert.throws(
      () =>
        requireSameOrigin(
          new Request("https://app.test/api/rules", { method: "POST", headers: origin ? { Origin: origin } : {} }),
        ),
      ApiError,
    );
  }
  requireSameOrigin(
    new Request("https://app.test/api/rules", { method: "POST", headers: { Origin: "https://app.test" } }),
  );
});

test("duplicate access cookies are rejected rather than choosing an identity", async () => {
  const client = new AuthClient(config, async () => {
    throw new Error("must not call provider");
  });
  await assert.rejects(
    client.user(
      new Request("https://app.test/api/me", { headers: { cookie: "__Host-ac-access=a; __Host-ac-access=b" } }),
    ),
    (e: unknown) => e instanceof ApiError && e.status === 401,
  );
});

test("logout refreshes an expired access session before remote revocation", async () => {
  const calls: string[] = [];
  const client = new AuthClient(config, async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("/token?"))
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer new-access");
    return new Response(null, { status: 204 });
  });
  const response = await client.logout(
    new Request("https://app.test", { headers: { cookie: "__Host-ac-refresh=refresh-test" } }),
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.endsWith("/logout?scope=local"));
  assert.ok(response.headers.getSetCookie().every((value) => value.includes("Max-Age=0")));
});

test("ambiguous logout clears the browser but reports remote revocation failure", async () => {
  const client = new AuthClient(config, async () => {
    throw new Error("offline");
  });
  const response = await client.logout(
    new Request("https://app.test", { headers: { cookie: "__Host-ac-access=access-test" } }),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.getSetCookie().length, 2);
});

test("rejected refresh expires both cookies while transient failures retain them", async () => {
  for (const status of [401, 503]) {
    const client = new AuthClient(config, async () => new Response(null, { status }));
    const request = new Request("https://app.test", { headers: { cookie: "__Host-ac-refresh=invalid" } });
    if (status === 401) {
      const response = await client.refresh(request);
      assert.equal(response.status, 401);
      assert.equal(response.headers.getSetCookie().length, 2);
    } else await assert.rejects(client.refresh(request), ApiError);
  }
});
