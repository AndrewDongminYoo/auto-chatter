import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthClient, ApiError, readJson, requireSameOrigin } from "./auth.ts";
import { limitAuthRequest } from "./auth-rate-limit.ts";

test("request bodies are refused above the size limit and when not declared as JSON", async () => {
  const body = (bytes: number) => JSON.stringify({ text: "x".repeat(bytes - 11) });
  assert.equal(body(16_384).length, 16_384);
  const json = (text: string) =>
    new Request("https://app.test/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });
  assert.deepEqual(await readJson(json(body(16_384))), { text: "x".repeat(16_373) });
  await assert.rejects(
    readJson(json(body(16_385))),
    (e: unknown) => e instanceof ApiError && e.status === 413 && e.message === "request_too_large",
  );
  // A route with a larger allowance (flow documents) still stops one byte above it.
  assert.ok(await readJson(json(body(69_632)), 69_632));
  await assert.rejects(readJson(json(body(69_633)), 69_632), (e: unknown) => e instanceof ApiError && e.status === 413);
  for (const type of ["text/plain", "application/x-www-form-urlencoded", ""])
    await assert.rejects(
      readJson(
        new Request("https://app.test/api/x", { method: "POST", headers: { "content-type": type }, body: "{}" }),
      ),
      (e: unknown) => e instanceof ApiError && e.status === 415 && e.message === "json_required",
      type,
    );
});

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

test("an expired, revoked or unverifiable session is refused instead of trusted", async () => {
  const request = new Request("https://app.test/api/me", { headers: { cookie: "__Host-ac-access=old-token" } });
  for (const [status, expected] of [
    [401, 401],
    [403, 401],
    [404, 401],
    [500, 503],
    [503, 503],
  ] as const) {
    const client = new AuthClient(config, async () => Response.json({ msg: "refused" }, { status }));
    await assert.rejects(
      client.user(request),
      (e: unknown) => e instanceof ApiError && e.status === expected,
      `provider ${status} must answer ${expected}`,
    );
  }
  const offline = new AuthClient(config, async () => {
    throw new TypeError("network down");
  });
  await assert.rejects(offline.user(request), (e: unknown) => e instanceof ApiError && e.status === 503);
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

test("password recovery request hides account existence and provider rejection", async () => {
  for (const providerStatus of [200, 400, 429]) {
    let calls = 0;
    const client = new AuthClient(config, async (input, init) => {
      calls++;
      assert.equal(String(input), "https://project.supabase.co/auth/v1/recover");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { email: "owner@example.test" });
      return Response.json({}, { status: providerStatus });
    });
    const response = await client.recover({ email: " owner@example.test " });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { recovery_requested: true });
    assert.equal(calls, 1);
  }
});

test("signup and confirmation resend hide provider account state and cooldowns", async () => {
  for (const providerStatus of [200, 400, 422, 429]) {
    const paths: string[] = [];
    const client = new AuthClient(config, async (input) => {
      paths.push(new URL(String(input)).pathname);
      return Response.json({}, { status: providerStatus });
    });
    assert.deepEqual(
      await (await client.signup({ email: "owner@example.test", password: "example-password" })).json(),
      {
        confirmation_required: true,
      },
    );
    assert.deepEqual(await (await client.resendConfirmation({ email: "owner@example.test" })).json(), {
      confirmation_requested: true,
    });
    assert.deepEqual(paths, ["/auth/v1/signup", "/auth/v1/resend"]);
  }
});

test("authentication throttles use both trusted caller IP and normalized email without forwarding credentials", async () => {
  const keys: string[] = [];
  const limiter = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: true };
    },
  };
  const request = new Request("https://app.test/api/auth/login", {
    method: "POST",
    headers: { Origin: "https://app.test", "CF-Connecting-IP": "203.0.113.10" },
  });
  await limitAuthRequest(
    request,
    "/api/auth/login",
    { email: " Owner@Example.Test " },
    {
      AUTH_IP_LIMIT: limiter,
      AUTH_EMAIL_LIMIT: limiter,
    },
  );
  assert.equal(keys.length, 2);
  assert.doesNotMatch(keys[0]!, /203\.0\.113\.10/);
  assert.doesNotMatch(keys.join(" "), /Owner@Example|owner@example/);
  assert.notEqual(keys[0], keys[1]);
});

test("mail requests also spend an hourly per-IP and a project-wide mail allowance; login spends neither (#165)", async () => {
  const seen: Record<string, string[]> = { ip: [], email: [], mailIp: [], mail: [] };
  const recording = (name: string, success = true) => ({
    limit: async ({ key }: { key: string }) => {
      seen[name]!.push(key);
      return { success };
    },
  });
  const env = (mailIp = true, mail = true) => ({
    AUTH_IP_LIMIT: recording("ip"),
    AUTH_EMAIL_LIMIT: recording("email"),
    AUTH_MAIL_IP_LIMIT: recording("mailIp", mailIp),
    AUTH_MAIL_LIMIT: recording("mail", mail),
  });
  const from = (ip: string) =>
    new Request("https://app.test/api/auth/recover", { method: "POST", headers: { "CF-Connecting-IP": ip } });
  const mailPaths = ["/api/auth/signup", "/api/auth/recover", "/api/auth/resend-confirmation"];
  for (const [index, pathname] of mailPaths.entries())
    await limitAuthRequest(from("203.0.113.10"), pathname, { email: `user${index}@example.test` }, env());
  await limitAuthRequest(from("198.51.100.7"), "/api/auth/recover", { email: "other@example.test" }, env());
  await limitAuthRequest(from("203.0.113.10"), "/api/auth/login", { email: "user0@example.test" }, env());
  // One per-IP mail key for every mail path from the same address, a different one for another address.
  assert.equal(seen.mailIp!.length, 4);
  assert.equal(new Set(seen.mailIp!.slice(0, 3)).size, 1);
  assert.notEqual(seen.mailIp![0], seen.mailIp![3]);
  assert.doesNotMatch(seen.mailIp!.join(" "), /203\.0\.113\.10|198\.51\.100\.7/);
  // One project-wide key whatever the address, email or path.
  assert.equal(seen.mail!.length, 4);
  assert.equal(new Set(seen.mail).size, 1);

  // A refusal at either mail allowance is a 429; a client over its own allowance spends nothing project-wide.
  seen.mail = [];
  await assert.rejects(
    limitAuthRequest(from("203.0.113.10"), "/api/auth/recover", { email: "x@example.test" }, env(false)),
    (e: unknown) => e instanceof ApiError && e.status === 429 && e.message === "auth_rate_limited",
  );
  assert.deepEqual(seen.mail, []);
  await assert.rejects(
    limitAuthRequest(from("203.0.113.10"), "/api/auth/signup", { email: "x@example.test" }, env(true, false)),
    (e: unknown) => e instanceof ApiError && e.status === 429 && e.message === "auth_rate_limited",
  );
  // The mail allowances are required for mail paths only.
  const withoutMail = { AUTH_IP_LIMIT: recording("ip"), AUTH_EMAIL_LIMIT: recording("email") };
  for (const pathname of mailPaths)
    await assert.rejects(
      limitAuthRequest(from("203.0.113.10"), pathname, { email: "x@example.test" }, withoutMail),
      (e: unknown) => e instanceof ApiError && e.status === 503,
    );
  await limitAuthRequest(from("203.0.113.10"), "/api/auth/login", { email: "x@example.test" }, withoutMail);
});

test("signup, recovery, and resend share one email allowance while login has a separate allowance", async () => {
  const emailKeys: string[] = [];
  const allow = { limit: async () => ({ success: true }) };
  const emailLimit = {
    limit: async ({ key }: { key: string }) => {
      emailKeys.push(key);
      return { success: true };
    },
  };
  const request = new Request("https://app.test/api/auth/signup", { method: "POST" });
  for (const pathname of ["/api/auth/signup", "/api/auth/recover", "/api/auth/resend-confirmation", "/api/auth/login"])
    await limitAuthRequest(
      request,
      pathname,
      { email: " Owner@Example.Test " },
      {
        AUTH_IP_LIMIT: allow,
        AUTH_EMAIL_LIMIT: emailLimit,
        AUTH_MAIL_IP_LIMIT: allow,
        AUTH_MAIL_LIMIT: allow,
      },
    );
  assert.equal(new Set(emailKeys.slice(0, 3)).size, 1);
  assert.notEqual(emailKeys[2], emailKeys[3]);
});

test("authentication throttle keys stay within the binding's 64-byte limit", async () => {
  const keys: string[] = [];
  const limiter = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      assert.ok(new TextEncoder().encode(key).byteLength <= 64);
      return { success: true };
    },
  };
  const request = new Request("https://app.test/api/auth/login", {
    method: "POST",
    headers: { "CF-Connecting-IP": "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
  });
  for (const pathname of ["/api/auth/login", "/api/auth/signup", "/api/auth/recover", "/api/auth/resend-confirmation"])
    await limitAuthRequest(
      request,
      pathname,
      { email: "Owner@Example.Test" },
      {
        AUTH_IP_LIMIT: limiter,
        AUTH_EMAIL_LIMIT: limiter,
        AUTH_MAIL_IP_LIMIT: limiter,
        AUTH_MAIL_LIMIT: limiter,
      },
    );
  // Login spends the IP and email allowances; each of the three mail paths also spends both mail allowances.
  assert.equal(keys.length, 14);
});

test("authentication throttles reject excess attempts and missing bindings before provider calls", async () => {
  const request = new Request("https://app.test/api/auth/signup", { method: "POST" });
  const allow = { limit: async () => ({ success: true }) };
  const refuse = { limit: async () => ({ success: false }) };
  await assert.rejects(
    limitAuthRequest(
      request,
      "/api/auth/signup",
      { email: "x@example.test" },
      { AUTH_IP_LIMIT: refuse, AUTH_EMAIL_LIMIT: allow, AUTH_MAIL_IP_LIMIT: allow, AUTH_MAIL_LIMIT: allow },
    ),
    (error: unknown) => error instanceof ApiError && error.status === 429,
  );
  await assert.rejects(
    limitAuthRequest(request, "/api/auth/signup", { email: "x@example.test" }, { AUTH_IP_LIMIT: allow }),
    (error: unknown) => error instanceof ApiError && error.status === 503,
  );
});

test("password recovery rejects malformed input and reports provider outages without leaking details", async () => {
  const client = new AuthClient(config, async () => new Response("secret provider body", { status: 503 }));
  await assert.rejects(
    client.recover({ email: "invalid" }),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
  await assert.rejects(
    client.recover({ email: "owner@example.test" }),
    (error: unknown) => error instanceof ApiError && error.status === 503 && !error.message.includes("secret"),
  );
});

test("reset uses only the supplied access token, clears cookies, and never returns credentials", async () => {
  const calls: string[] = [];
  const client = new AuthClient(config, async (input, init) => {
    calls.push(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer recovery-access");
    if (String(input).endsWith("/user")) {
      assert.equal(init?.method, "PUT");
      assert.deepEqual(JSON.parse(String(init?.body)), { password: "new-password-123" });
      return Response.json({ id: userId });
    }
    assert.ok(String(input).endsWith("/logout?scope=global"));
    return new Response(null, { status: 204 });
  });
  const response = await client.resetPassword({ access_token: "recovery-access", password: "new-password-123" });
  assert.deepEqual(calls.length, 2);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { password_updated: true });
  assert.ok(response.headers.getSetCookie().every((value) => value.includes("Max-Age=0")));
});

test("invalid recovery tokens never update a password and expired tokens get a generic error", async () => {
  let calls = 0;
  const client = new AuthClient(config, async () => {
    calls++;
    return new Response("provider details", { status: 401 });
  });
  await assert.rejects(client.resetPassword({ access_token: "bad token", password: "new-password-123" }), ApiError);
  assert.equal(calls, 0);
  await assert.rejects(
    client.resetPassword({ access_token: "expired-token", password: "new-password-123" }),
    (error: unknown) => error instanceof ApiError && error.status === 401 && error.message === "recovery_link_invalid",
  );
  assert.equal(calls, 1);
});

test("provider password policy rejection is distinct from an expired recovery link", async () => {
  const client = new AuthClient(config, async () => new Response("secret password policy", { status: 422 }));
  await assert.rejects(
    client.resetPassword({ access_token: "recovery-access", password: "new-password-123" }),
    (error: unknown) => error instanceof ApiError && error.status === 400 && error.message === "password_rejected",
  );
});

test("password update never claims confirmed logout when provider refuses revocation", async () => {
  for (const status of [400, 401, 403, 503]) {
    const client = new AuthClient(config, async (input) =>
      String(input).endsWith("/user") ? Response.json({ id: userId }) : new Response(null, { status }),
    );
    const response = await client.resetPassword({ access_token: "recovery-access", password: "new-password-123" });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "password_updated_logout_unconfirmed" });
    assert.ok(response.headers.getSetCookie().every((value) => value.includes("Max-Age=0")));
  }
});
