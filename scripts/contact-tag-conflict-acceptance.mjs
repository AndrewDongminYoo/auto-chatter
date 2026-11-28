// Evaluate in a fresh browser page serving public/app over loopback. Every API is synthetic.
// Covers the dashboard tag save conflict (#48): the save sends the tags the editor started from as expected_tags, a
// 409 contact_tags_stale shows its message, rereads the stored tags and applies the draft's own additions and removals
// to them, so the next save, even without an edit, keeps the other write.
(async () => {
  const page = globalThis;
  const { location, document } = page;
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) throw new Error("Loopback required");
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const until = async (condition) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Fixture condition timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const account = "55555555-5555-4555-8555-555555555555";
  const sender = "12345678901234567890";
  const fixture = { stored: ["agent", "vip"], saves: [], detailReads: 0 };
  page.tagConflictFixture = fixture;
  const detailPath = `/api/connections/${account}/contacts/${sender}`;
  const entitlements = { plan: "advanced", limits: { seats: 10, connections: 10, campaign_sends_per_month: 1000 }, usage: { seats: 1, connections: 1, campaign_sends: 0 } };
  const connection = { id: account, account_id: "123456789", username: "preview_shop", active: true, send_enabled: false, inbox_enabled: true, credential_status: "valid", token_registered: true, token_expires_at: "2027-12-01T00:00:00Z" };
  const reads = {
    "/api/connections": { connections: [connection] },
    "/api/rules": { rules: [] },
    "/api/activity": { activity: [] },
    "/api/flows": { flows: [] },
    "/api/contact-fields": { fields: [] },
    "/api/contact-segments": { segments: [] },
    "/api/segment-snapshots": { snapshots: [] },
  };
  page.fetch = async (input, init = {}) => {
    const url = new URL(input, location.href);
    check(url.origin === location.origin, "External request forbidden");
    const path = url.pathname;
    const method = init.method ?? "GET";
    if (path === "/api/me") return Response.json({ user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, global_send_enabled: false, instagram_connect_available: true });
    if (path.startsWith("/api/auth/")) return Response.json({ ok: true });
    if (path === "/api/workspace") return Response.json({ workspace_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "agent", time_zone: "Asia/Seoul", ...entitlements });
    if (path === "/api/contacts") return Response.json({ contacts: [{ connection_id: account, sender_id: sender, comment_count: "3", tags: [...fixture.stored], fields: {} }], after: null });
    if (path === detailPath && method === "PATCH") {
      const body = JSON.parse(init.body);
      fixture.saves.push(body);
      const current = [...fixture.stored].sort();
      if (JSON.stringify([...body.expected_tags].sort()) !== JSON.stringify(current)) return Response.json({ error: "contact_tags_stale" }, { status: 409 });
      fixture.stored = [...new Set(body.tags)].sort();
      return Response.json({ tags: fixture.stored });
    }
    if (path === detailPath) {
      fixture.detailReads++;
      return Response.json({
        connection_id: account,
        sender_id: sender,
        comment_count: "3",
        first_comment_at: "2026-11-15T00:00:00Z",
        last_comment_at: "2026-11-16T00:00:00Z",
        tags: [...fixture.stored],
        fields: [],
        automation: { paused: false, manual_paused: false, handoff_paused: false },
        consent: [],
        conversations: [],
        after: null,
      });
    }
    if (path === `${detailPath}/identity-links`) return Response.json({ links: [], after: null, can_edit: false });
    if (method === "GET" && path in reads) return Response.json(reads[path]);
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  };
  await page.start();
  await until(() => !document.getElementById("workspace").hidden);
  page.showView("contacts", false);
  await page.loadView("contacts");
  const panel = document.getElementById("contacts-detail");
  await until(() => !panel.hidden && panel.querySelector("#contact-tag-editor") && !panel.innerText.includes("불러오고 있습니다"));
  const editor = panel.querySelector("#contact-tag-editor");
  const input = editor.querySelector("textarea");
  const save = editor.querySelector("button[type=submit]");
  [...panel.querySelectorAll("button")].find((button) => button.textContent === "태그 편집").click();
  check(!editor.hidden && input.value === "agent\nvip", "The editor does not start from the stored tags");

  // While the editor is open the CRM removes "vip" and adds "crm". The agent's draft removes "agent", only respells
  // "vip" as "VIP" and adds "new". The save is refused, and the editor applies the draft's changes to the reread tags:
  // the respelled tag is neither an addition nor a removal, so the CRM's removal of "vip" stands.
  fixture.stored = ["agent", "crm"];
  input.value = "VIP\nnew";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const readsBefore = fixture.detailReads;
  save.click();
  await until(() => fixture.saves.length === 1 && fixture.detailReads > readsBefore && !panel.innerText.includes("불러오고 있습니다") && !save.disabled);
  check(JSON.stringify(fixture.saves[0]) === JSON.stringify({ tags: ["VIP", "new"], expected_tags: ["agent", "vip"] }), `The save body is wrong: ${JSON.stringify(fixture.saves[0])}`);
  check(panel.textContent.includes("다른 곳에서 이 연락처의 태그가 바뀌어 저장하지 않았습니다."), "The conflict message is not shown");
  check(input.value === "crm\nnew", `The draft was not merged with the reread tags: ${JSON.stringify(input.value)}`);
  check(panel.querySelector(".contact-detail-tags").textContent.includes("crm"), "The stored tags were not reread");
  check(JSON.stringify(fixture.stored) === JSON.stringify(["agent", "crm"]), "The refused save changed the stored tags");

  // Saving again without an edit keeps the CRM's tag and applies the agent's removal and addition.
  save.click();
  await until(() => fixture.saves.length === 2 && !save.disabled);
  check(JSON.stringify(fixture.saves[1]) === JSON.stringify({ tags: ["crm", "new"], expected_tags: ["agent", "crm"] }), `The second save body is wrong: ${JSON.stringify(fixture.saves[1])}`);
  check(JSON.stringify(fixture.stored) === JSON.stringify(["crm", "new"]), "The second save was not stored");
  check(document.getElementById("notice").textContent.includes("태그를 저장했습니다."), "The save did not confirm its result");
  return { passed: ["expected_tags sent", "409 message", "draft merged onto reread tags", "respelled tag not re-added", "stored tags reread", "unedited resave keeps the other write"], fixture: "tagConflictFixture" };
})();
