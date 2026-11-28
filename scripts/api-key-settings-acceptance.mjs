// Evaluate in a fresh browser page serving public/app over loopback. Every API is synthetic.
// Covers the workspace API key settings (#48): issue, the key shown once, list states, the revoke confirmation and the
// contacts:write checkbox.
// The returned fixture remains available for inspecting the rendered section.
(async () => {
  const page = globalThis;
  if (!["127.0.0.1", "localhost"].includes(page.location.hostname)) throw new Error("Loopback preview required");
  const get = (id) => page.document.getElementById(id);
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const until = async (condition) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Fixture condition timed out");
      await new Promise((resolve) => page.setTimeout(resolve, 10));
    }
  };
  const day = 24 * 60 * 60 * 1000;
  const iso = (offset) => new Date(Date.now() + offset).toISOString();
  const issuedKey = `ac_live_${"Q".repeat(43)}`;
  const key = (id, name, fields) => ({
    id,
    name,
    key_prefix: "ac_live_Abcd",
    scopes: ["contacts:read"],
    created_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    created_by_email: "admin@example.test",
    created_at: iso(-30 * day),
    expires_at: iso(60 * day),
    last_used_at: null,
    last_used_ip: null,
    revoked_at: null,
    revoked_reason: null,
    active: true,
    ...fields,
  });
  const fixture = {
    keys: [
      key("11111111-1111-4111-8111-111111111111", "CRM 운영", { last_used_at: iso(-5 * 60 * 1000), last_used_ip: "203.0.113.9" }),
      key("22222222-2222-4222-8222-222222222222", "만료 임박 키", { expires_at: iso(3 * day) }),
      key("33333333-3333-4333-8333-333333333333", "만료된 키", { expires_at: iso(-day), active: false }),
      key("44444444-4444-4444-8444-444444444444", "떠난 관리자의 키", { revoked_at: iso(-2 * day), revoked_reason: "member_removed", active: false }),
    ],
    posts: [],
    unexpected: [],
  };
  page.apiKeyFixture = fixture;
  const entitlements = { plan: "advanced", limits: { seats: 10, connections: 10, campaign_sends_per_month: 1000 }, usage: { seats: 1, connections: 0, campaign_sends: 0 } };
  page.fetch = async (input, init = {}) => {
    const url = new URL(input, page.location.href);
    check(url.origin === page.location.origin, "External request forbidden");
    const route = url.pathname;
    const method = init.method ?? "GET";
    if (route === "/api/me") return Response.json({ user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, global_send_enabled: false, instagram_connect_available: true });
    if (route.startsWith("/api/auth/")) return Response.json({ ok: true });
    if (route === "/api/workspace") return Response.json({ workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "admin", time_zone: "Asia/Seoul", ...entitlements });
    if (route === "/api/workspace/api-keys" && method === "GET") {
      const listed = { keys: fixture.keys, scopes: ["contacts:read", "contacts:write"], expiry_days: [30, 90, 180, 365], default_expiry_days: 90, max_active: 10 };
      if (fixture.holdList) {
        fixture.holdList = false;
        await new Promise((resolve) => (fixture.releaseList = resolve));
      }
      return Response.json(listed);
    }
    if (route === "/api/workspace/api-keys" && method === "POST") {
      const body = JSON.parse(init.body);
      fixture.posts.push(body);
      const created = key("55555555-5555-4555-8555-555555555555", body.name, { created_at: iso(0), expires_at: iso(body.expires_in_days * day), key_prefix: issuedKey.slice(0, 12), scopes: body.scopes });
      fixture.keys = [created, ...fixture.keys];
      return Response.json({ ...created, key: issuedKey }, { status: 201 });
    }
    const revoke = /^\/api\/workspace\/api-keys\/([0-9a-f-]+)\/revoke$/.exec(route);
    if (revoke && method === "POST") {
      fixture.posts.push({ revoke: revoke[1] });
      fixture.keys = fixture.keys.map((item) => (item.id === revoke[1] ? { ...item, revoked_at: iso(0), revoked_reason: "revoked", active: false } : item));
      return Response.json(fixture.keys.find((item) => item.id === revoke[1]));
    }
    const responses = {
      "/api/connections": { connections: [] },
      "/api/rules": { rules: [] },
      "/api/activity": { activity: [] },
      "/api/flows": { flows: [] },
      "/api/webhooks/endpoints": { endpoints: [] },
      "/api/webhooks/deliveries": { deliveries: [] },
      "/api/workspace/health": { checked_at: iso(0), last_cron_success_at: null, thresholds: {}, alerts: [], connections: [], global_send_enabled: false },
    };
    if (!(route in responses)) {
      fixture.unexpected.push(`${method} ${route}`);
      throw new Error(`Unexpected fixture request: ${route}`);
    }
    return Response.json(responses[route]);
  };
  await page.start();
  await until(() => !get("workspace").hidden);
  page.showView("settings", false);
  await page.loadView("settings");
  check(!get("api-keys-section").hidden, "An admin does not see the API key section");
  await until(() => get("api-keys").querySelectorAll(".item").length === 4);

  // List states: in use with the last use, expiring, expired, and revoked with its reason.
  const items = () => [...get("api-keys").querySelectorAll(".item")];
  const itemFor = (name) => items().find((item) => item.querySelector("strong")?.textContent === name);
  const text = (name) => itemFor(name)?.textContent ?? "";
  check(text("CRM 운영").includes("사용 중") && text("CRM 운영").includes("IP 203.0.113.9") && text("CRM 운영").includes("ac_live_Abcd…"), "The active key misses its state, prefix or last use");
  check(text("CRM 운영").includes("만든 사람 admin@example.test") && text("CRM 운영").includes("권한 contacts:read"), "The active key misses its creator or scope");
  check(text("만료 임박 키").includes("만료 임박") && text("만료 임박 키").includes("아직 사용한 적 없음"), "The expiring key misses its warning");
  check(text("만료된 키").includes("만료됨"), "The expired key is not marked expired");
  check(text("떠난 관리자의 키").includes("폐기됨 · 만든 멤버가 제거되어 자동 폐기"), "The revoked key misses its reason");
  check(!itemFor("떠난 관리자의 키").querySelector("button"), "A revoked key still offers revoke");
  check(get("api-key-form").elements.expires_in_days.value === "90", "The expiry does not default to 90 days");

  // Issue: the key is shown once, issuing stays locked while it shows, and no browser storage holds it.
  const form = get("api-key-form");
  const submit = form.querySelector("button[type=submit]");
  check(!form.elements.contacts_write.checked, "Contact writes are allowed by default");
  form.elements.name.value = "새 CRM";
  form.elements.expires_in_days.value = "30";
  submit.click();
  await until(() => !get("api-key-secret").hidden && items().length === 5);
  check(get("api-key-secret-value").value === issuedKey, "The issued key is not shown");
  check(get("api-key-secret-help").textContent.includes('"새 CRM" 키입니다'), "The shown key is not named");
  check(JSON.stringify(fixture.posts[0]) === JSON.stringify({ name: "새 CRM", expires_in_days: 30, scopes: ["contacts:read"] }), "The issue request body is wrong");
  await until(() => submit.disabled);
  check(form.elements.name.value === "", "The form was not reset after the issue");
  const stored = [];
  for (const storage of [page.localStorage, page.sessionStorage]) for (let index = 0; index < storage.length; index++) stored.push(storage.getItem(storage.key(index)));
  check(!stored.some((value) => value?.includes(issuedKey)), "The key reached browser storage");
  check(!get("api-keys").textContent.includes(issuedKey), "The list shows the full key");
  get("dismiss-api-key-secret").click();
  check(get("api-key-secret").hidden && get("api-key-secret-value").value === "", "Dismissing did not clear the key");
  check(!submit.disabled, "Issuing stays locked after the key was dismissed");
  check(!page.document.body.textContent.includes(issuedKey), "The key is still on the page after dismissal");

  // Revoke: a declined confirmation sends nothing, an accepted one revokes and rereads the list.
  const confirmations = [];
  const originalConfirm = page.confirm;
  try {
    page.confirm = (message) => (confirmations.push(message), false);
    itemFor("CRM 운영").querySelector("button").click();
    await new Promise((resolve) => page.setTimeout(resolve, 50));
    check(confirmations.length === 1 && confirmations[0].includes('"CRM 운영" 키를 폐기할까요?'), "Revoke did not ask for confirmation");
    check(fixture.posts.length === 1, "A declined confirmation still revoked the key");
    page.confirm = (message) => (confirmations.push(message), true);
    itemFor("CRM 운영").querySelector("button").click();
    await until(() => text("CRM 운영").includes("폐기됨 · 관리자가 폐기"));
  } finally {
    page.confirm = originalConfirm;
  }
  check(fixture.posts[1]?.revoke === "11111111-1111-4111-8111-111111111111", "The accepted confirmation did not revoke the key");
  check(!itemFor("CRM 운영").querySelector("button"), "The revoked key still offers revoke");
  check(get("notice").textContent.includes("키를 폐기했습니다."), "Revoke did not confirm its result");

  // Out of order: a list read that started before a revoke and answers after the reread does not restore the key.
  fixture.holdList = true;
  get("api-keys-refresh").click();
  await until(() => typeof fixture.releaseList === "function");
  try {
    page.confirm = () => true;
    itemFor("만료 임박 키").querySelector("button").click();
    await until(() => text("만료 임박 키").includes("폐기됨 · 관리자가 폐기"));
  } finally {
    page.confirm = originalConfirm;
  }
  fixture.releaseList();
  await until(() => !get("api-keys-refresh").disabled);
  await new Promise((resolve) => page.setTimeout(resolve, 50));
  check(text("만료 임박 키").includes("폐기됨 · 관리자가 폐기") && !itemFor("만료 임박 키").querySelector("button"), "A stale list response restored a revoked key");

  // A write key: the checkbox adds contacts:write, the list shows both scopes, and the form resets the checkbox.
  form.elements.name.value = "CRM 쓰기";
  form.elements.contacts_write.checked = true;
  submit.click();
  await until(() => !get("api-key-secret").hidden && itemFor("CRM 쓰기"));
  check(JSON.stringify(fixture.posts.at(-1)) === JSON.stringify({ name: "CRM 쓰기", expires_in_days: 90, scopes: ["contacts:read", "contacts:write"] }), "The write key request body is wrong");
  check(text("CRM 쓰기").includes("권한 contacts:read, contacts:write"), "The write key does not show both scopes");
  check(!form.elements.contacts_write.checked, "The checkbox stays on after the issue");
  get("dismiss-api-key-secret").click();
  check(!fixture.unexpected.length, `Incomplete fixture: ${fixture.unexpected.join(", ")}`);
  return { passed: ["list states", "issue and one-time key", "no key in storage", "dismiss clears key", "declined and accepted revoke", "stale list ignored", "write key checkbox"], fixture: "apiKeyFixture" };
})();
