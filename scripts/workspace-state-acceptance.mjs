// Evaluate in a fresh browser page serving public/app over loopback. Every API is synthetic.
// The returned fixture remains available for inspecting error states and responsive rendering.
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
  const connectionId = "55555555-5555-4555-8555-555555555555";
  const fixture = {
    user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspace: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    role: "owner",
    zone: "Asia/Seoul",
    offline: false,
    unauthorized: false,
    activityFailure: false,
    writes: 0,
    rules: [],
    rulesFailure: false,
    unexpected: [],
    logoutFailure: false,
    holdRuleSave: null,
    holdReport: null,
    holdMembership: null,
  };
  page.workspaceFixture = fixture;
  const entitlements = { plan: "advanced", limits: { seats: 10, connections: 10, campaign_sends_per_month: 1000 }, usage: { seats: 1, connections: 1, campaign_sends: 0 } };
  const account = { id: connectionId, account_id: "123456789", username: "preview_shop", active: true, send_enabled: false, inbox_enabled: true, credential_status: "valid", token_registered: true, token_expires_at: "2027-12-01T00:00:00Z" };
  const media = { id: "987654321", media_type: "IMAGE", caption: "합성 테스트 게시물", timestamp: "2026-11-15T00:00:00Z" };
  const report = {
    from: "2026-10-01",
    before: "2026-10-02",
    time_zone: "Asia/Seoul",
    period_from: "2026-09-30T15:00:00Z",
    period_before: "2026-10-01T15:00:00Z",
    checked_at: "2026-11-15T03:00:00Z",
    connection_id: null,
    counts: { total: "3", pending: "0", sending: "0", sent: "3", read: "1", read_unavailable: "2", failed: "0", unknown_unresolved: "0", unknown_resolved: "0", cancelled: "0" },
  };
  page.fetch = async (input, init = {}) => {
    const url = new URL(input, page.location.href);
    check(url.origin === page.location.origin, "External request forbidden");
    const route = url.pathname;
    if (fixture.unauthorized && (route === "/api/me" || route === "/api/auth/refresh")) return Response.json({ error: "login_required" }, { status: 401 });
    if (route === "/api/me") {
      if (fixture.offline) throw new TypeError("Synthetic network failure");
      return Response.json({ user: { id: fixture.user }, global_send_enabled: false, instagram_connect_available: true });
    }
    if (route === "/api/auth/logout" && fixture.logoutFailure) return Response.json({ error: "remote_logout_unconfirmed" }, { status: 503 });
    if (route.startsWith("/api/auth/")) return Response.json({ ok: true });
    if (route === "/api/workspace") {
      const membership = { workspace_id: fixture.workspace, role: fixture.role, time_zone: fixture.zone, ...entitlements };
      if (fixture.holdMembership) await fixture.holdMembership();
      return Response.json(membership);
    }
    if (route === "/api/workspace/settings" && init.method === "PUT") {
      fixture.zone = JSON.parse(init.body).time_zone;
      return Response.json({ time_zone: fixture.zone });
    }
    if (route === "/api/rules") {
      if (fixture.rulesFailure) return Response.json({ error: "service_unavailable" }, { status: 503 });
      if (init.method === "PUT") {
        if (fixture.holdRuleSave) await fixture.holdRuleSave();
        fixture.rules = [{ ...JSON.parse(init.body), id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", keyword: "자료" }];
        fixture.writes++;
        return Response.json(fixture.rules[0]);
      }
      return Response.json({ rules: fixture.rules });
    }
    if (route === `/api/connections/${connectionId}` && init.method === "PATCH") {
      Object.assign(account, JSON.parse(init.body));
      fixture.writes++;
      return Response.json(account);
    }
    if (route.startsWith(`/api/connections/${connectionId}/media`)) return Response.json({ media: [media], after: null });
    if (route === "/api/reports/manual-replies") {
      if (fixture.holdReport) await fixture.holdReport();
      return Response.json(report);
    }
    if (route === "/api/activity" && fixture.activityFailure) return Response.json({ error: "service_unavailable" }, { status: 503 });
    const responses = {
      "/api/connections": { connections: [account] },
      "/api/activity": { activity: [] },
      "/api/flows": { flows: [] },
      "/api/contact-fields": { fields: [] },
      "/api/contact-segments": { segments: [] },
      "/api/contacts": { contacts: [], after: null },
      "/api/segment-snapshots": { snapshots: [] },
      "/api/campaign-drafts": { drafts: [] },
      "/api/inbox": { conversations: [], after: null },
      "/api/inbox/assignees": { assignees: [] },
      "/api/inbox/labels": { labels: [] },
      "/api/inbox/label-rules": { rules: [] },
      "/api/inbox/reply-templates": { templates: [] },
      "/api/workspace/members": { members: [], ...entitlements },
      "/api/workspace/invites": { invites: [] },
      "/api/webhooks/endpoints": { endpoints: [] },
      "/api/webhooks/deliveries": { deliveries: [] },
      "/api/workspace/health": { checked_at: "2026-11-15T03:00:00Z", last_cron_success_at: null, thresholds: {}, alerts: [], connections: [], global_send_enabled: false },
    };
    if (!(route in responses)) {
      fixture.unexpected.push(route);
      throw new Error(`Unexpected fixture request: ${route}`);
    }
    return Response.json(responses[route]);
  };
  await page.start();
  await until(() => !get("workspace").hidden);
  const dateInputs = ["manual", "flow", "handoff", "campaign"].map((name) => get(`${name}-report-form`).elements.from);
  for (const input of dateInputs) {
    input.value = "2026-10-01";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  get("manual-report-form").elements.before.value = "2026-10-02";
  get("manual-report-form").requestSubmit();
  await until(() => !get("manual-report-download").disabled);
  const resultText = get("manual-report-summary").textContent;
  get("webhook-form").elements.name.value = "unsaved endpoint";
  await page.loadWorkspace();
  check(
    dateInputs.every((input) => input.value === "2026-10-01"),
    "Workspace refresh discarded report dates",
  );
  check(get("manual-report-summary").textContent === resultText && !get("manual-report-download").disabled, "Workspace refresh discarded a valid report");
  check(get("webhook-form").elements.name.value === "unsaved endpoint", "Workspace refresh discarded settings input");

  const rule = get("rule-form");
  rule.elements.media_id.value = media.id;
  rule.elements.keywords.value = "자료";
  rule.elements.private_reply_text.value = "합성 테스트 답장";
  rule.dispatchEvent(new Event("input", { bubbles: true }));
  let releaseReport;
  fixture.holdReport = () =>
    new Promise((resolve) => {
      releaseReport = resolve;
    });
  get("manual-report-form").requestSubmit();
  await until(() => Boolean(releaseReport));
  rule.requestSubmit();
  await until(() => fixture.writes === 1 && !get("save-rule").hasAttribute("aria-busy"));
  check(
    dateInputs.every((input) => input.value === "2026-10-01"),
    "Rule save discarded report dates",
  );
  check(get("manual-report-form").querySelector("button[type=submit]").disabled, "Rule save unlocked a pending report");
  fixture.holdReport = null;
  releaseReport();
  await until(() => !get("manual-report-download").disabled);
  rule.elements.private_reply_text.value = "아직 저장하지 않은 수정";
  rule.dispatchEvent(new Event("input", { bubbles: true }));
  const toggle = [...get("connections").querySelectorAll("button[role=switch]")].find((button) => get(button.getAttribute("aria-labelledby"))?.textContent === "자동 DM 발송" && button.getAttribute("aria-checked") === "false");
  check(Boolean(toggle), "Account toggle missing from fixture");
  toggle.click();
  await until(() => fixture.writes === 2 && !toggle.hasAttribute("aria-busy"));
  check(rule.elements.private_reply_text.value === "아직 저장하지 않은 수정", "Account update discarded the rule draft");
  check(
    dateInputs.every((input) => input.value === "2026-10-01"),
    "Account update discarded report dates",
  );

  fixture.rules.push({ ...fixture.rules[0], id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", private_reply_text: "다른 규칙의 답장" });
  await page.loadWorkspace();
  let releaseSave;
  fixture.holdRuleSave = () =>
    new Promise((resolve) => {
      releaseSave = resolve;
    });
  rule.requestSubmit();
  await until(() => Boolean(releaseSave));
  const otherRule = get("rules").children[1].querySelector("button");
  check(otherRule.disabled, "Rule editing remained enabled during save");
  otherRule.click();
  check(rule.elements.private_reply_text.value === "아직 저장하지 않은 수정", "Rule selection changed during save");
  fixture.holdRuleSave = null;
  releaseSave();
  await until(() => !get("save-rule").hasAttribute("aria-busy"));

  fixture.offline = true;
  await page.start();
  check(get("auth").hidden && !get("workspace").hidden && !get("retry-load").hidden, "Network failure mixed login and workspace");
  fixture.offline = false;
  await page.start();
  check(get("auth").hidden && get("retry-load").hidden && !get("notice").textContent, "Retry retained the old failure");
  fixture.activityFailure = true;
  page.showView("home", false);
  await page.start();
  check(get("auth").hidden && !get("workspace").hidden && get("activity").textContent.includes("불러오지 못했습니다"), "Partial failure hid the workspace");
  fixture.activityFailure = false;

  let releaseMembership;
  fixture.holdMembership = () => {
    fixture.holdMembership = null;
    return new Promise((resolve) => {
      releaseMembership = resolve;
    });
  };
  const older = page.loadWorkspace();
  await until(() => Boolean(releaseMembership));
  fixture.zone = "UTC";
  await page.loadWorkspace();
  releaseMembership();
  await older;
  check(get("time-zone-form").elements.time_zone.value === "UTC", "Older refresh replaced the newer context");

  fixture.holdMembership = () => {
    fixture.holdMembership = null;
    return new Promise((resolve) => {
      releaseMembership = resolve;
    });
  };
  releaseMembership = null;
  const beforeZoneSave = page.loadWorkspace();
  await until(() => Boolean(releaseMembership));
  const zoneForm = get("time-zone-form");
  zoneForm.elements.time_zone.value = "Asia/Seoul";
  zoneForm.requestSubmit();
  await until(() => !zoneForm.querySelector("button[type=submit]").hasAttribute("aria-busy"));
  check(zoneForm.elements.time_zone.value === "Asia/Seoul", "Time zone save did not complete");
  releaseMembership();
  await beforeZoneSave;
  check(zoneForm.elements.time_zone.value === "Asia/Seoul" && get("manual-report-zone").textContent.includes("Asia/Seoul"), "A pending refresh restored the zone from before the save");

  fixture.unauthorized = true;
  await page.start();
  check(!get("auth").hidden && get("workspace").hidden && !rule.elements.private_reply_text.value, "401 retained protected input");
  fixture.unauthorized = false;
  fixture.offline = true;
  const login = get("login-form");
  login.elements.email.value = "fixture@example.test";
  login.elements.password.value = "synthetic-only";
  login.requestSubmit();
  await until(() => !login.querySelector("button[type=submit]").hasAttribute("aria-busy"));
  check(get("notice").textContent.includes("서버에 연결하지 못했습니다") && !get("retry-load").hidden, "Login bootstrap failure was lost");
  fixture.offline = false;
  await page.start();
  fixture.logoutFailure = true;
  get("logout").click();
  await until(() => !get("logout").hasAttribute("aria-busy"));
  check(get("notice").textContent.includes("서버 세션 종료를 확인하지 못했으니") && !get("auth").hidden, "Logout failure was lost");
  fixture.logoutFailure = false;
  await page.api("/api/auth/login", "POST", { email: "fixture@example.test", password: "synthetic-only" });
  await page.start();
  for (const field of ["workspace", "user", "role"]) {
    rule.elements.private_reply_text.value = "previous-context-private";
    fixture[field] = field === "role" ? "agent" : "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await page.loadWorkspace();
    check(!rule.elements.private_reply_text.value, `${field} transition retained protected input`);
  }
  check(get("manual-reports-section").hidden, "Agent role retained owner reports");
  const otherTab = new page.BroadcastChannel("auto-chatter-session");
  otherTab.postMessage({ source: "synthetic-other-document" });
  await until(() => get("workspace").hidden);
  otherTab.close();
  check(get("auth").hidden && !get("retry-load").hidden, "Session transition requires verification before login UI");
  fixture.role = "owner";
  fixture.zone = "Asia/Seoul";
  await page.start();
  await until(() => !get("workspace").hidden);
  fixture.role = "admin";
  fixture.rulesFailure = true;
  await page.action(get("refresh-activity"), () => page.loadWorkspace());
  check(get("auth").hidden && get("workspace").hidden && !get("retry-load").hidden && get("notice").textContent, "Retired action left a failed replacement context without recovery");
  fixture.rulesFailure = false;
  fixture.role = "owner";
  await page.start();
  check(!get("workspace").hidden && get("retry-load").hidden && !get("notice").textContent, "Replacement context retry did not recover");
  check(!fixture.unexpected.length, `Incomplete fixture: ${fixture.unexpected.join(", ")}`);
  return {
    passed: [
      "workspace refresh",
      "rule save",
      "account update",
      "independent busy state",
      "rule selection during save",
      "login bootstrap failure",
      "logout failure",
      "network retry",
      "partial failure",
      "out-of-order response",
      "401",
      "user/workspace/role isolation",
      "cross-tab isolation",
      "replacement context recovery",
      "saved time zone during refresh",
    ],
    fixture: "workspaceFixture",
  };
})();
