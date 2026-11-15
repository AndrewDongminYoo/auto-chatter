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
    empty: false,
    reads: [],
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
    fixture.reads.push(route);
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
      "/api/connections": { connections: fixture.empty ? [] : [account] },
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
  page.location.hash = "home";
  await page.start();
  await until(() => !get("workspace").hidden);
  check(fixture.reads.length === 5, `Home expected five requests: ${fixture.reads.join(", ")}`);
  check(get("manual-reports-section").closest(".view").dataset.view === "reports", "Reports still occupy home");
  check(!get("getting-started").hidden && !get("step-rule").querySelector("a").hidden, "First-rule next action missing");
  const homeReads = [...fixture.reads];
  page.showView("reports", true);
  await page.loadView("reports");
  check(!get("view-reports").hidden && get("view-home").hidden, "Reports entry failed");
  check(page.document.activeElement.id === "view-reports", "Reports entry lost focus");
  const form = get("manual-report-form");
  form.elements.from.value = "2026-10-01";
  form.elements.before.value = "2026-10-02";
  form.dispatchEvent(new Event("input", { bubbles: true }));
  form.requestSubmit();
  await until(() => !get("manual-report-download").disabled);
  const summary = get("manual-report-summary").textContent;
  const before = fixture.reads.length;
  page.showView("home", false);
  page.showView("reports", false);
  await page.loadView("reports");
  check(fixture.reads.length === before, "Menu re-entry repeated requests");
  check(form.elements.from.value === "2026-10-01" && get("manual-report-summary").textContent === summary, "Menu entry discarded report snapshot");
  get("manual-report-download").click();
  check(fixture.reads.length === before, "Report CSV reread the server");
  get("reports-refresh").click();
  await until(() => !get("reports-refresh").disabled);
  check(fixture.reads.length === before + 2, "Explicit report refresh did not reread both option lists");
  check(form.elements.from.value === "2026-10-01" && get("manual-report-summary").textContent === summary, "Option refresh discarded report query or snapshot");
  page.showView("settings", false);
  await page.loadView("settings");
  const zoneForm = get("time-zone-form");
  zoneForm.elements.time_zone.value = "UTC";
  zoneForm.requestSubmit();
  await until(() => !zoneForm.querySelector("button[type=submit]").disabled);
  page.showView("reports", false);
  await page.loadView("reports");
  check(!get("flow-report-form").elements.flow_id.disabled && !get("campaign-report-form").elements.draft_id.disabled, "Saved time zone left cached report pickers disabled");
  check(get("manual-report-download").disabled, "Changed report context retained an old CSV snapshot");
  page.location.hash = "manual-reports-section";
  await until(() => !get("view-reports").hidden);
  for (const name of ["automation", "contacts", "inbox", "campaigns", "settings"]) {
    page.showView(name, false);
    await page.loadView(name);
    const reads = fixture.reads.length;
    page.showView(name, false);
    await page.loadView(name);
    check(fixture.reads.length === reads, `Repeated ${name} entry duplicated initialization`);
  }
  fixture.empty = true;
  await page.loadWorkspace();
  page.showView("home", false);
  await page.loadView("home");
  check(!get("getting-started").hidden && !get("step-connect").querySelector("a").hidden, "Empty workspace omitted account action");
  fixture.empty = false;
  fixture.rules = [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", connection_id: account.id, media_id: media.id, enabled: true, keyword: "자료", keywords: ["자료"], excluded_keywords: [], match_mode: "contains", private_reply_text: "합성 답장", follow_gate_enabled: false }];
  await page.loadWorkspace();
  check(!get("home-actions").hidden, "Operating workspace omitted next actions");
  check(get("getting-started").hidden, "Completed setup still dominates operating home");
  fixture.role = "agent";
  await page.loadWorkspace();
  check(get("nav-reports").hidden && get("home-reports-link").hidden, "Agent received report entry");
  fixture.role = "owner";
  await page.loadWorkspace();
  page.showView("home", false);
  await page.loadView("home");
  check(!fixture.unexpected.length, `Incomplete fixture: ${fixture.unexpected.join(", ")}`);
  return { passed: ["home next actions", "five initial requests", "report entry and focus", "CSV from snapshot", "menu input/result preservation", "empty and active workspace", "role boundary"], homeReads, fixture: "workspaceFixture" };
})();
