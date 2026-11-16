// Evaluate in a fresh loopback page serving this repository. Only synthetic reads are allowed.
(async () => {
  const page = globalThis;
  const { location, document, loadWorkspace, showView, loadView } = page;
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) throw new Error("Loopback required");
  await (0, eval)(await (await fetch("/scripts/home-actions-acceptance.mjs")).text());
  const original = globalThis.fetch;
  const account = "55555555-5555-4555-8555-555555555555";
  let mode = "missing";
  const scalar = (normal) => (mode === "missing" ? undefined : mode === "null" ? null : mode === "wrong" ? {} : normal);
  const violations = [];
  const inspected = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(input, location.href).pathname;
    if (init.method && init.method !== "GET" && path !== "/api/workspace") throw new Error("Fixture forbids writes");
    const responses = {
      "/api/reports/manual-replies": { from: scalar("2026-10-01"), before: scalar("2026-10-02"), checked_at: scalar("2026-11-16T00:00:00Z"), time_zone: "UTC", counts: { total: scalar("1234") } },
      "/api/contacts": { contacts: [{ connection_id: account, sender_id: "12345678901234567890", comment_count: scalar("1234"), tags: [], fields: {} }], after: null },
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
    for (const menu of ["home", "automation", "contacts", "inbox", "campaigns", "reports", "settings"]) {
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
      const text = document.getElementById(`view-${menu}`).innerText;
      if (/\b(?:undefined|null|NaN)\b|Invalid Date/.test(text)) violations.push({ mode, menu, text });
      inspected.push(`${mode}:${menu}`);
    }
    if (mode === "normal" && !document.getElementById("contacts-list").textContent.includes("댓글 1234개")) throw new Error("Normal ungrouped count changed");
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
