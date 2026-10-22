// Run only in the documented OS sandbox; /target, /tools, and /fixture are read-only inputs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { createRequire } from "node:module";

import { writeFile, mkdir, statfs } from "node:fs/promises";
import net from "node:net";
async function isolationProbe() {
  const allowed = ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "PLAYWRIGHT_BROWSERS_PATH", "LANG"];
  assert.deepEqual(Object.keys(process.env).sort(), allowed.sort(), "Environment is not the explicit allowlist");
  assert.equal(process.getuid(), 65534, "Fixture must not run as root");
  for (const file of ["/target/write-probe", "/tools/write-probe", "/fixture/write-probe", "/tmp/write-probe"]) {
    await assert.rejects(
      writeFile(file, "probe"),
      (e) => ["EROFS", "EACCES"].includes(e.code),
      `Unexpected writable path: ${file}`,
    );
  }
  await mkdir("/scratch/tmp", { recursive: true });
  await mkdir("/scratch/home", { recursive: true });
  await writeFile("/scratch/write-probe", "allowed");
  const disk = await statfs("/scratch");
  assert.ok(disk.blocks * disk.bsize <= 256 * 1024 * 1024, "Scratch exceeds the declared disk limit");
  const status = await readFile("/proc/self/status", "utf8");
  assert.match(status, /^CapEff:\s+0+$/m, "Linux capabilities must be empty");
  const routes = await readFile("/proc/net/route", "utf8");
  assert.equal(routes.trim().split("\n").length, 1, "External network route exists");
  const outcome = await new Promise((resolve) => {
    const socket = net.createConnection({ host: "192.0.2.1", port: 9 });
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error) => resolve(error.code));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve("timeout");
    });
  });
  assert.notEqual(outcome, "connected", "External network probe escaped");
  const limits = {};
  for (const key of ["memory.max", "pids.max", "cpu.max"])
    limits[key] = (await readFile(`/sys/fs/cgroup/${key}`, "utf8")).trim();
  assert.equal(limits["memory.max"], String(768 * 1024 * 1024));
  assert.equal(limits["pids.max"], "128");
  assert.equal(limits["cpu.max"], "100000 100000");
  return {
    uid: process.getuid(),
    write_probe: "scratch only",
    external_probe: outcome,
    routes: "loopback only",
    scratch_bytes: disk.blocks * disk.bsize,
    limits,
  };
}

import { appApi } from "/target/src/app/api.ts";
const require = createRequire(import.meta.url);
const { chromium } = require("/tools/playwright-core");
const mode = process.argv[2];
assert.ok(["negative", "observe", "fixed"].includes(mode), "Choose negative, observe, or fixed mode");
const origin = "https://localhost:4175";
const users = {
  A: { id: "55555555-5555-4555-8555-555555555555", email: "admin@example.test" },
  B: { id: "66666666-6666-4666-8666-666666666666", email: "agent@example.test" },
};
const events = [],
  pageErrors = [];
let forceUnauthorized = false,
  releaseRefresh,
  refreshArrived;
const provider = async (input, init) => {
  const url = new URL(input),
    body = init.body ? JSON.parse(init.body) : undefined;
  if (url.pathname === "/auth/v1/token") {
    const account =
      url.searchParams.get("grant_type") === "refresh_token"
        ? body.refresh_token?.[0]
        : Object.keys(users).find((k) => users[k].email === body.email);
    assert.ok(users[account], "Dummy provider must identify A or B");
    events.push({ event: "provider_token", account, grant: url.searchParams.get("grant_type") });
    return Response.json({ access_token: account + "-access", refresh_token: account + "-refresh", expires_in: 3600 });
  }
  if (url.pathname === "/auth/v1/user") {
    const account = new Headers(init.headers).get("authorization")?.slice(7, 8);
    return users[account]
      ? Response.json({ ...users[account], email_confirmed_at: "2026-10-22T00:00:00Z" })
      : new Response(null, { status: 401 });
  }
  throw new Error("Unexpected provider call");
};
const limit = { limit: async () => ({ success: true }) };
const env = {
  SUPABASE_URL: "https://dummy.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_dummy",
  AUTH_IP_LIMIT: limit,
  AUTH_EMAIL_LIMIT: limit,
  SEND_ENABLED: "false",
};
function json(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
const server = https.createServer(
  { key: await readFile("/fixture/key.pem"), cert: await readFile("/fixture/cert.pem") },
  async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith("/api/")) {
        const account = /__Host-ac-access=([AB])-access/.exec(req.headers.cookie ?? "")?.[1];
        events.push({ event: "request", path: url.pathname, account: account ?? null, method: req.method });
        if (url.pathname === "/api/me" && forceUnauthorized) {
          forceUnauthorized = false;
          return json(res, 401, { error: "login_required" });
        }
        if (url.pathname.startsWith("/api/auth/") || url.pathname === "/api/me") {
          let body = "";
          for await (const chunk of req) body += chunk;
          const request = new Request(url, { method: req.method, headers: req.headers, ...(body ? { body } : {}) });
          const response = await appApi(
            request,
            env,
            () => {
              throw new Error("Database access forbidden in auth fixture");
            },
            provider,
          );
          if (url.pathname === "/api/auth/refresh" && refreshArrived) {
            const arrived = refreshArrived;
            refreshArrived = undefined;
            await new Promise((resolve) => {
              releaseRefresh = resolve;
              arrived();
            });
          }
          const headers = Object.fromEntries(response.headers);
          delete headers["set-cookie"];
          headers["set-cookie"] = response.headers.getSetCookie();
          res.writeHead(response.status, headers);
          res.end(Buffer.from(await response.arrayBuffer()));
          events.push({ event: "response", path: url.pathname, account: account ?? null, status: response.status });
          return;
        }
        if (!account) return json(res, 401, { error: "login_required" });
        if (url.pathname === "/api/workspace")
          return json(res, 200, {
            role: account === "A" ? "admin" : "agent",
            time_zone: "UTC",
            plan: "advanced",
            limits: { seats: 10, connections: 10 },
            usage: { seats: 1, connections: 0 },
          });
        const empty = {
          "/api/connections": { connections: [] },
          "/api/rules": { rules: [] },
          "/api/flows": { flows: [] },
          "/api/contact-fields": { fields: [] },
          "/api/contact-segments": { segments: [] },
          "/api/contacts": { contacts: [], next_cursor: null },
          "/api/webhooks/endpoints": { endpoints: [] },
          "/api/webhooks/deliveries": { deliveries: [] },
          "/api/workspace/health": {
            checked_at: "2026-10-22T00:00:00Z",
            thresholds: {},
            alerts: [],
            connections: [],
            global_send_enabled: false,
          },
        };
        return json(res, empty[url.pathname] ? 200 : 503, empty[url.pathname] ?? { error: "service_unavailable" });
      }
      const root = "/target/public",
        target = path.resolve(root, "." + (url.pathname === "/app/" ? "/app/index.html" : url.pathname));
      assert.ok(target.startsWith(root + "/"));
      const csp = /^\s+Content-Security-Policy: (.+)$/m.exec(await readFile(root + "/_headers", "utf8"))?.[1];
      res.writeHead(200, {
        "Content-Type": target.endsWith(".html")
          ? "text/html"
          : target.endsWith(".js")
            ? "text/javascript"
            : "text/css",
        "Cache-Control": "no-cache",
        ...(csp ? { "Content-Security-Policy": csp } : {}),
      });
      res.end(await readFile(target));
    } catch (e) {
      events.push({ event: "fixture_error", message: e.message });
      json(res, 500, { error: "fixture_failure" });
    }
  },
);
let browser, contextForDiagnostics;
const pending = new Set();
try {
  const isolation = await isolationProbe();
  await new Promise((resolve) => server.listen(4175, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  contextForDiagnostics = context;
  context.on("request", (req) => {
    pending.add(req.url());
    events.push({ event: "browser_request", url: req.url() });
  });
  context.on("requestfinished", (req) => {
    pending.delete(req.url());
    events.push({ event: "browser_finished", url: req.url() });
  });
  context.on("requestfailed", (req) => {
    pending.delete(req.url());
    events.push({ event: "browser_failed", url: req.url(), error: req.failure() });
  });
  const a = await context.newPage(),
    b = await context.newPage();
  for (const tab of [a, b]) tab.on("pageerror", (e) => pageErrors.push(e.message));
  for (const tab of [a, b]) {
    await tab.goto(origin + "/app/", { waitUntil: "domcontentloaded" });
    await tab.waitForFunction(
      () =>
        typeof api === "function" &&
        document.querySelector("#startup").hidden &&
        !document.querySelector("#auth").hidden &&
        refreshPromise === undefined,
    );
    events.push({ event: "initialization_settled", page: tab === a ? "A" : "B" });
  }
  await a.waitForFunction(() => typeof api === "function");
  await b.waitForFunction(() => typeof api === "function");
  const login = (tab, account) =>
    tab.evaluate(async ({ email }) => {
      await api("/api/auth/login", "POST", { email, password: "dummy-password-123" });
    }, users[account]);
  const principal = (tab) => tab.evaluate(async () => (await (await fetch("/api/me")).json()).user.id);
  await login(a, "A");
  assert.equal(await principal(a), users.A.id);
  // Orderly control: completed refresh precedes B login and cannot roll B back.
  await a.evaluate(() => api("/api/auth/refresh", "POST", undefined, false));
  await login(b, "B");
  assert.equal(await principal(b), users.B.id);
  const orderly = { principal: await principal(b), expected: users.B.id };
  await login(a, "A");
  // Hold response headers generated by the real appApi/AuthClient after dummy-provider acceptance.
  const arrived = new Promise((resolve) => {
    refreshArrived = resolve;
  });
  forceUnauthorized = true;
  await a.evaluate(() => {
    window.raceResult = null;
    window.racePromise = api("/api/me").then(
      (value) => {
        window.raceResult = { ok: true, value };
      },
      (error) => {
        window.raceResult = { ok: false, message: error.message };
      },
    );
  });
  await arrived;
  const requestCount = events.filter((e) => e.event === "request" && e.path === "/api/me").length;
  let before;
  if (mode === "fixed") {
    await b.evaluate(({ email }) => {
      window.loginResult = null;
      api("/api/auth/login", "POST", { email, password: "dummy-password-123" }).then(
        () => {
          window.loginResult = { ok: true };
        },
        (error) => {
          window.loginResult = { ok: false, message: error.message };
        },
      );
    }, users.B);
    // Observe an actual pending Web Lock, or an incorrectly completed login on affected source.
    await b.waitForFunction(
      async () =>
        window.loginResult !== null ||
        (await navigator.locks.query()).pending.some((lock) => lock.name === "auto-chatter-auth-cookies"),
    );
    assert.equal(
      await b.evaluate(() => window.loginResult),
      null,
      "Login must wait until the older refresh response settles",
    );
    events.push({ event: "login_waited_for_refresh" });
    releaseRefresh();
    await b.waitForFunction(() => window.loginResult !== null);
    assert.equal(await b.evaluate(() => window.loginResult.ok), true);
    before = await principal(b);
  } else {
    await login(b, "B");
    before = await principal(b);
    assert.equal(before, users.B.id);
    await a.waitForTimeout(200);
    releaseRefresh();
  }
  await a.evaluate(() => window.racePromise);
  const result = await a.evaluate(() => window.raceResult);
  const after = await principal(b);
  const afterCount = events.filter((e) => e.event === "request" && e.path === "/api/me").length;
  assert.equal(result.ok, false, "Original request must reject after account switch");
  assert.match(result.message, /로그인 상태가 변경되었습니다/);
  assert.equal(
    afterCount,
    requestCount + 2,
    "Only native before/after identity probes may run; original A request must not replay",
  );
  const rollback = after === users.A.id;
  if (mode === "negative" || mode === "fixed")
    assert.equal(after, users.B.id, "Late refresh response must not roll shared cookies from B back to A");
  if (mode === "observe") assert.equal(rollback, true, "Observation must reproduce the proposed cookie rollback");
  events.push({ event: "assertions_passed", original_request_replays: afterCount - requestCount - 2 });
  const screenshot = await b.screenshot();
  const output = {
    mode,
    isolation,
    orderly_control: orderly,
    before,
    after,
    rollback,
    original_request: result,
    events,
    page_errors: pageErrors,
    evidence_limits:
      "Real appApi/AuthClient and unmodified dashboard assets; in-process dummy provider accepts A refresh. No database, production provider revocation, live credentials, or customer-data disclosure tested.",
    screenshot_base64: screenshot.toString("base64"),
  };
  await browser.close();
  browser = undefined;
  await new Promise((resolve) => server.close(resolve));
  process.stdout.write(JSON.stringify(output));
} catch (error) {
  events.push({ event: "pending_on_failure", urls: [...pending] });
  if (contextForDiagnostics)
    for (const page of contextForDiagnostics.pages())
      events.push({
        event: "page_state",
        state: await page
          .evaluate(() => ({
            ready: document.readyState,
            startup: document.querySelector("#startup")?.hidden,
            auth: document.querySelector("#auth")?.hidden,
            refreshPending: typeof refreshPromise !== "undefined",
          }))
          .catch((e) => ({ error: e.message })),
      });
  if (browser) await browser.close().catch(() => {});
  server.close();
  process.stderr.write(JSON.stringify({ failure: error.message, stack: error.stack, events, page_errors: pageErrors }));
  process.exitCode = 1;
}
