// Run in a fresh loopback dashboard page. All API traffic is replaced by synthetic responses.
(async () => {
  const page = globalThis;
  if (!["127.0.0.1", "localhost"].includes(page.location.hostname)) throw new Error("Loopback preview required");
  const get = (id) => page.document.getElementById(id);
  const check = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const until = async (condition) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Fixture condition timed out");
      await new Promise((resolve) => page.setTimeout(resolve, 10));
    }
  };
  const fixture = { empty: false, fail: false, writes: 0, rules: [], release: null, unexpected: [] };
  const connection = { id: "55555555-5555-4555-8555-555555555555", account_id: "123456789", username: "preview_shop", active: true, send_enabled: true, inbox_enabled: true, token_registered: true, credential_status: "valid", token_expires_at: "2027-12-01T00:00:00Z" };
  const media = { id: "987654321", media_type: "IMAGE", caption: "Synthetic rule fixture", timestamp: "2026-11-16T00:00:00Z" };
  const plan = { plan: "advanced", limits: { seats: 10, connections: 10, campaign_sends_per_month: 1000 }, usage: { seats: 1, connections: 1, campaign_sends: 0 } };
  page.fetch = async (input, init = {}) => {
    const url = new URL(input, page.location.href);
    check(url.origin === page.location.origin, "External request forbidden");
    const route = url.pathname;
    if (route === "/api/rules" && init.method === "PUT") {
      fixture.writes++;
      if (fixture.release)
        await new Promise((resolve) => {
          fixture.release = resolve;
        });
      if (fixture.fail) return Response.json({ error: "service_unavailable" }, { status: 503 });
      const rule = { ...JSON.parse(init.body), id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", keyword: "자료" };
      fixture.rules = [rule];
      return Response.json(rule);
    }
    if (route.startsWith(`/api/connections/${connection.id}/media`)) return Response.json({ media: [media], after: null });
    const responses = {
      "/api/me": { user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, global_send_enabled: false, instagram_connect_available: true },
      "/api/workspace": { workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "owner", time_zone: "Asia/Seoul", ...plan },
      "/api/connections": { connections: fixture.empty ? [] : [connection] },
      "/api/rules": { rules: fixture.rules },
      "/api/activity": { activity: [] },
      "/api/flows": { flows: [] },
    };
    if (!(route in responses)) {
      fixture.unexpected.push(route);
      throw new Error(`Unexpected fixture request: ${route}`);
    }
    return Response.json(responses[route]);
  };
  page.mobileRuleFixture = fixture;
  await page.start();
  page.showView("automation", false);
  await page.loadView("automation");
  const form = get("rule-form");
  const fields = form.elements;
  const toggle = get("rule-preview-toggle");
  const mobile = page.matchMedia("(max-width: 767px)").matches;
  const visible = (element) => element.getClientRects().length > 0;
  check(get("rule-list-panel").hidden && !form.hidden, "Empty list duplicated the new editor");
  const nav = page.document.querySelector(".workspace-nav");
  check(nav.scrollWidth <= nav.clientWidth + 1, "Navigation requires horizontal scrolling");
  check(page.document.documentElement.scrollWidth <= page.innerWidth, "Page overflows horizontally");
  for (const link of nav.querySelectorAll("a:not([hidden])")) {
    const box = link.getBoundingClientRect();
    check(box.left >= 0 && box.right <= page.innerWidth, "A navigation link is off screen");
  }
  await until(() => get("media-list").querySelector("button"));
  get("media-list").querySelector("button").click();
  fields.keywords.value = "자료";
  fields.private_reply_text.value = "첫 메시지 초안";
  fields.follow_gate_enabled.checked = true;
  fields.confirmation_button_enabled.checked = true;
  fields.confirmation_button_title.value = "자료 받기";
  fields.follower_reply_text.value = "팔로우한 사람의 자료";
  fields.non_follower_reply_text.value = "팔로우 후 확인해 주세요";
  fields.private_reply_text.dispatchEvent(new Event("input", { bubbles: true }));
  fields.private_reply_text.focus();
  if (mobile) {
    toggle.click();
    check(visible(get("rule-preview")) && !visible(get("rule-fields")), "Preview did not replace composition");
    check(page.document.activeElement.id === "preview-title", "Preview heading did not receive focus");
    check(fixture.writes === 0, "Preview performed a write");
    check(get("preview-follower").textContent === fields.follower_reply_text.value && get("preview-first-button").textContent === "자료 받기", "Follow preview lost current input");
    toggle.click();
    check(page.document.activeElement === fields.private_reply_text && fields.private_reply_text.value === "첫 메시지 초안", "Return lost draft or input focus");
    fields.private_reply_text.value = "";
    fields.private_reply_text.dispatchEvent(new Event("input", { bubbles: true }));
    toggle.click();
    form.requestSubmit();
    check(visible(fields.private_reply_text) && page.document.activeElement === fields.private_reply_text && fixture.writes === 0, "Validation did not reveal and focus the invalid input");
    fields.private_reply_text.value = "첫 메시지 초안";
    fields.private_reply_text.dispatchEvent(new Event("input", { bubbles: true }));
    toggle.click();
  } else check(visible(get("rule-preview")) && visible(get("rule-fields")), "Desktop lost its side-by-side content");
  if (mobile) {
    if (form.classList.contains("preview-open")) toggle.click();
    fields.private_reply_text.scrollIntoView({ block: "center" });
  }
  fixture.fail = true;
  fixture.release = true;
  get("save-rule").focus();
  form.requestSubmit();
  await until(() => typeof fixture.release === "function");
  check(get("rule-fields").disabled && toggle.disabled, "Save did not lock composition and preview controls");
  fixture.release();
  fixture.release = null;
  await until(() => !get("save-rule").hasAttribute("aria-busy"));
  check(fields.private_reply_text.value === "첫 메시지 초안" && get("edit-state").textContent === "저장 전", "Failed save lost the draft");
  check(get("save-status").textContent.includes("저장하지 못했습니다") && page.document.querySelector(".action-error")?.textContent, "Save failure recovery missing");
  if (mobile) {
    const error = page.document.querySelector(".action-error").getBoundingClientRect();
    check(error.top >= 0 && error.bottom <= page.innerHeight, "Save error scrolled away from the sticky save action");
  }
  check(page.document.activeElement === get("save-rule"), "Failed save lost keyboard focus");
  fixture.fail = false;
  form.requestSubmit();
  await until(() => !get("save-rule").hasAttribute("aria-busy"));
  check(fixture.writes === 2 && get("edit-state").textContent === "저장됨" && fields.private_reply_text.value === "첫 메시지 초안", "Save outcome or retained draft is incorrect");
  check(!get("rule-list-panel").hidden, "Saved rule list unavailable");
  const originalConfirm = page.confirm;
  let discardAsked = false;
  page.confirm = () => {
    discardAsked = true;
    return false;
  };
  if (mobile && form.classList.contains("preview-open")) toggle.click();
  fields.private_reply_text.value = "수정 중인 초안";
  fields.private_reply_text.dispatchEvent(new Event("input", { bubbles: true }));
  get("new-rule").click();
  page.confirm = originalConfirm;
  check(discardAsked && fields.private_reply_text.value === "수정 중인 초안", "New rule bypassed the discard warning");
  fixture.empty = true;
  fixture.rules = [];
  await page.loadWorkspace();
  check(form.hidden && !get("editor-empty").hidden && visible(get("editor-empty").querySelector("a")), "No-account state does not prioritize connection");
  fixture.empty = false;
  await page.loadWorkspace();
  check(!fixture.unexpected.length, `Incomplete fixture: ${fixture.unexpected.join(", ")}`);
  return { passed: ["navigation", "empty rules", "preview/return focus", "follow branches", "native validation", "busy lock", "save failure", "saved state", "discard warning", "no account"], mobile, writes: fixture.writes, fixture: "mobileRuleFixture" };
})();
