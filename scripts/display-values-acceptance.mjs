// Evaluate in a fresh loopback page serving this repository. Only synthetic reads are allowed.
(async () => {
  const page = globalThis;
  const { location, document, loadWorkspace, showView, loadView } = page;
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) throw new Error("Loopback required");
  await (0, eval)(await (await fetch("/scripts/home-actions-acceptance.mjs")).text());
  const original = globalThis.fetch;
  const account = "55555555-5555-4555-8555-555555555555";
  const sender = "12345678901234567890";
  const recipient = "98765432109876543210";
  let mode = "missing";
  const scalar = (normal) => (mode === "missing" ? undefined : mode === "null" ? null : mode === "wrong" ? {} : normal);
  const violations = [];
  const inspected = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(input, location.href).pathname;
    if (init.method && init.method !== "GET" && path !== "/api/workspace") throw new Error("Fixture forbids writes");
    const responses = {
      "/api/reports/manual-replies": { from: scalar("2026-10-01"), before: scalar("2026-10-02"), checked_at: scalar("2026-11-16T00:00:00Z"), time_zone: "UTC", counts: { total: scalar("1234") } },
      "/api/contacts": { contacts: [{ connection_id: account, sender_id: sender, comment_count: scalar("1234"), tags: [], fields: {} }], after: null },
      // The contacts view opens the first contact, so its detail and identity links are read too.
      [`/api/connections/${account}/contacts/${sender}`]: {
        connection_id: account,
        sender_id: sender,
        comment_count: scalar("1234"),
        first_comment_at: scalar("2026-11-15T00:00:00Z"),
        last_comment_at: scalar("2026-11-16T00:00:00Z"),
        tags: [],
        fields: [],
        automation: { paused: false, manual_paused: false, handoff_paused: false },
        consent: [{ purpose: "service_reply", decision: "grant", evidence_kind: "comment", occurred_at: scalar("2026-11-15T00:00:00Z"), recorded_at: scalar("2026-11-15T00:00:00Z") }],
        conversations: [
          {
            recipient_id: recipient,
            evidence_reply_id: "11111",
            message_count: scalar("1234"),
            first_message_at: scalar("2026-11-15T00:00:00Z"),
            last_message_at: scalar("2026-11-16T00:00:00Z"),
            state: "open",
            handoff_active: false,
            consent: [{ purpose: "marketing", decision: "revoke", evidence_kind: "inbound_dm", occurred_at: scalar("2026-11-15T00:00:00Z"), recorded_at: scalar("2026-11-15T00:00:00Z") }],
          },
        ],
        after: null,
      },
      [`/api/connections/${account}/contacts/${sender}/identity-links`]: {
        links: [{ recipient_id: recipient, state: "confirmed", version: 1, evidence_valid: true, current_evidence_reply_id: "11111", blocked: false }],
        after: null,
        can_edit: false,
      },
      "/api/flows": { flows: [{ id: "flow-fixture", name: scalar("테스트 플로"), published_version_no: scalar(1234), updated_at: scalar("2026-11-16T00:00:00Z") }] },
      "/api/campaign-drafts": { drafts: [{ id: "draft-fixture", name: scalar("테스트 캠페인") }] },
      "/api/segment-snapshots": { snapshots: [] },
      "/api/inbox": { conversations: [{ connection_id: account, recipient_id: "12345678901234567890", message_count: scalar(1234), last_message_at: scalar("2026-11-16T00:00:00Z"), state: {} }], after: null },
      "/api/webhooks/deliveries": { deliveries: [{ event_id: "event-fixture", attempt_count: scalar(1234), status: "retry", last_status_code: scalar(503) }] },
      "/api/workspace/health": { checked_at: scalar("2026-11-16T00:00:00Z"), thresholds: {}, alerts: [], connections: [{ username: "test", alerts: [], unknown_24h: scalar(1234), failed_24h: scalar(0), blocked_24h: scalar(0) }] },
    };
    return path in responses ? Response.json(responses[path]) : original(input, init);
  };
  for (mode of ["missing", "null", "wrong", "normal"]) {
    await loadWorkspace();
    for (const menu of ["home", "accounts", "automation", "contacts", "inbox", "campaigns", "reports", "settings"]) {
      showView(menu, false);
      await loadView(menu);
      if (menu === "reports") {
        const form = document.getElementById("manual-report-form");
        form.elements.from.value = "2026-10-01";
        form.elements.before.value = "2026-10-02";
        form.requestSubmit();
        const deadline = Date.now() + 5000;
        while (document.getElementById("manual-report-download").disabled) {
          if (Date.now() > deadline) throw new Error("Report did not render");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (menu === "contacts") {
        // Wait for the selected contact's detail and identity links, then open the closed record details for innerText.
        const panel = document.getElementById("contacts-detail");
        const deadline = Date.now() + 5000;
        while (panel.hidden || !panel.querySelector(".contact-link-state") || panel.innerText.includes("불러오고 있습니다")) {
          if (Date.now() > deadline) throw new Error("Contact detail did not render");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        for (const details of panel.querySelectorAll("details")) details.open = true;
      }
      const text = document.getElementById(`view-${menu}`).innerText;
      if (/\b(?:undefined|null|NaN)\b|Invalid Date/.test(text)) violations.push({ mode, menu, text });
      inspected.push(`${mode}:${menu}`);
    }
    if (mode === "normal" && !document.getElementById("contacts-list").textContent.includes("댓글 1234개")) throw new Error("Normal ungrouped count changed");
    if (mode === "normal" && !document.getElementById("contacts-detail").textContent.includes("1234개")) throw new Error("Normal detail message count changed");
  }
  if (violations.length) throw new Error(JSON.stringify(violations));
  globalThis.displayFixture = {
    inspected,
    setMissing: async () => {
      mode = "missing";
      await loadWorkspace();
      showView("contacts", false);
      await loadView("contacts");
    },
  };
  return { passed: inspected, limits: "Synthetic scalar fields; response containers and routing identities retained. No production or provider calls." };
})();
