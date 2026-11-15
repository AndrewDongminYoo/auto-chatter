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
    connectAvailable: true,
    globalEnabled: false,
    replyAllowed: false,
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
      return Response.json({ user: { id: fixture.user }, global_send_enabled: fixture.globalEnabled, instagram_connect_available: fixture.connectAvailable });
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
    const thread = `/api/connections/${connectionId}/inbox/999`;
    if (route === thread) return Response.json({ messages: [], before: null });
    if (route === `${thread}/replies`) return Response.json({ replies: [], before: null });
    if (route === `${thread}/reply-status`)
      return Response.json({
        allowed: fixture.replyAllowed,
        failure_code: fixture.replyAllowed ? null : "recipient_opted_out",
        channel: "instagram",
        capabilities: { schema_version: 1, channel: "instagram", operations: { manual_reply: { supported: true, content_types: ["text"] } } },
        checked_at: new Date().toISOString(),
        window_expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    if (route === `${thread}/context`) return Response.json({ mapping_status: "unverified" });
    if (route.endsWith("/999/notes")) return Response.json({ notes: [], before: null });
    const responses = {
      "/api/connections": { connections: [account] },
      "/api/activity": { activity: [] },
      "/api/flows": { flows: [] },
      "/api/contact-fields": { fields: [] },
      "/api/contact-segments": { segments: [] },
      "/api/contacts": { contacts: [], after: null },
      "/api/segment-snapshots": { snapshots: [] },
      "/api/campaign-drafts": { drafts: [] },
      "/api/inbox": { conversations: [{ connection_id: connectionId, recipient_id: "999", username: "preview_shop", message_count: 0, unread_count: 0, state: { status: "open", version: 0, assignee: null } }], after: null, checked_at: new Date().toISOString() },
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
  await until(() => get("inbox-conversations").querySelector("button"));
  get("inbox-conversations").querySelector("button").click();
  await until(() => get("inbox-eligibility").textContent);
  get("inbox-reply-text").value = "인박스 초안";
  get("inbox-reply-text").dispatchEvent(new Event("input", { bubbles: true }));
  const rule = get("rule-form");
  rule.elements.private_reply_text.value = "보존할 규칙 초안";
  rule.dispatchEvent(new Event("input", { bubbles: true }));
  get("inbox-status-filter").value = "open";
  const refresh = async () => {
    get("send-settings-refresh").click();
    await until(() => !get("send-settings-refresh").disabled);
  };
  const preserved = () => {
    check(rule.elements.private_reply_text.value === "보존할 규칙 초안", "Settings reread discarded rule draft");
    check(get("inbox-reply-text").value === "인박스 초안", "Settings reread discarded inbox draft");
    check(get("inbox-status-filter").value === "open", "Settings reread discarded inbox query");
  };
  for (const global of [false, true]) {
    fixture.globalEnabled = global;
    for (const enabled of [false, true]) {
      account.send_enabled = enabled;
      await page.loadWorkspace();
      for (const ruleEnabled of [false, true]) {
        rule.elements.enabled.checked = ruleEnabled;
        rule.dispatchEvent(new Event("input", { bubbles: true }));
        await refresh();
        const text = get("rule-send-settings").textContent;
        check(text.includes("전달을 보장하지 않습니다"), "Settings promised delivery");
        check(global || text.includes("서비스 운영자"), "Global stop omitted operator action");
        check(enabled || text.includes("계정 발송 설정 꺼짐"), "Account stop omitted action");
        check(ruleEnabled || text.includes("규칙 중지"), "Rule stop omitted action");
        check(get("inbox-send-settings").textContent.includes("전달을 보장하지 않습니다"), "Inbox omitted common guidance");
        check(get("inbox-eligibility").textContent.includes("수신 거부"), "Server refusal was hidden by incomplete capability data");
        check(get("inbox-send").disabled, "Guidance bypassed server reply eligibility");
        preserved();
      }
    }
  }
  fixture.replyAllowed = true;
  get("inbox-thread-refresh").click();
  await until(() => get("inbox-eligibility").textContent.includes("답장 가능 ·"));
  check(!get("inbox-send").disabled, "Settings guidance blocked a server-allowed reply");
  fixture.offline = true;
  await refresh();
  check(get("delivery-title").textContent.includes("확인하지 못했습니다"), "Failed read retained a positive state");
  check(get("rule-send-settings").textContent.includes("다시 확인"), "Editor omitted failed read");
  preserved();
  check(!get("inbox-send").disabled, "Unknown global guidance replaced server reply eligibility");
  fixture.offline = false;
  await refresh();
  check(get("delivery-title").textContent.includes("켜져"), "Successful retry failed to recover");
  account.credential_status = "expired";
  await page.loadWorkspace();
  check(get("rule-send-settings").textContent.includes("다시 연결"), "Expired token omitted reconnection");
  fixture.connectAvailable = false;
  await page.loadWorkspace();
  check(get("connect").disabled && get("rule-send-settings").textContent.includes("연결 제한이 해제된 뒤"), "Restricted connection action contradicted contextual guidance");
  check(!get("connections").textContent.includes("상단의 '계정 연결'에서 같은 Instagram 계정을 다시 선택해 주세요."), "Account details still recommend a restricted connection action");
  fixture.connectAvailable = true;
  account.credential_status = "valid";
  account.active = false;
  await page.loadWorkspace();
  check(get("rule-send-settings").textContent.includes("수신 설정"), "Inactive connection omitted action");
  account.active = true;
  await page.loadWorkspace();
  preserved();
  check(!fixture.unexpected.length, `Incomplete fixture: ${fixture.unexpected.join(", ")}`);
  return { passed: ["eight switch combinations", "unknown read", "retry", "token expired", "inactive connection", "draft and query preservation"], fixture: "workspaceFixture" };
})();
