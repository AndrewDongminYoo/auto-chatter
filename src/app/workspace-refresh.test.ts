import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
function appFunction(name: string) {
  const begin = source.indexOf(`async function ${name}(`);
  return source.slice(begin, source.indexOf("\n}", begin) + 2);
}

function startupHarness(loadWorkspace: () => Promise<void>, loaded = true) {
  const elements = new Map<string, { hidden: boolean }>([
    ["auth", { hidden: true }],
    ["workspace", { hidden: !loaded }],
    ["startup", { hidden: true }],
    ["retry-load", { hidden: true }],
  ]);
  const notices: string[] = [];
  const context = vm.createContext({
    URLSearchParams,
    acceptedAuthRevision: "ready:one",
    authSessionRevision: () => "ready:one",
    startupRequest: 0,
    location: { protocol: "https:", search: "", hash: "" },
    sessionStorage: { getItem: () => null },
    instagramErrors: [],
    pendingInvite: null,
    recoveryToken: null,
    authLinkNotice: null,
    loadWorkspace,
    byId: (id: string) => elements.get(id),
    notice: (text: string) => {
      if (text) notices.push(text);
    },
    errorMessage: (error: Error) => error.message,
  });
  vm.runInContext(appFunction("start"), context);
  return { start: () => context.start() as Promise<void>, elements, notices };
}

for (const loaded of [true, false]) {
  test(`network failure keeps authentication separate with loaded=${loaded}`, async () => {
    const h = startupHarness(async () => {
      throw new Error("offline");
    }, loaded);
    await h.start();
    assert.equal(h.elements.get("auth")!.hidden, true);
    assert.equal(h.elements.get("workspace")!.hidden, !loaded);
    assert.equal(h.elements.get("retry-load")!.hidden, false);
    assert.equal(h.elements.get("startup")!.hidden, true);
    assert.deepEqual(h.notices, ["offline"]);
  });
}

test("an older startup failure cannot replace a newer retry result", async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const h = startupHarness(() => (++calls === 1 ? pending : Promise.resolve()));
  const first = h.start();
  await h.start();
  reject(new Error("old offline"));
  await first;
  assert.deepEqual(h.notices, []);
  assert.equal(h.elements.get("retry-load")!.hidden, true);
  assert.equal(h.elements.get("auth")!.hidden, true);
});

test("authentication refusal exposes login without retaining a visible workspace", async () => {
  const h = startupHarness(async () => {
    throw Object.assign(new Error("login"), { status: 401 });
  });
  await h.start();
  assert.equal(h.elements.get("auth")!.hidden, false);
  assert.equal(h.elements.get("workspace")!.hidden, true);
  assert.equal(h.elements.get("retry-load")!.hidden, true);
});

function workspaceHarness() {
  const noop = () => {};
  const element = () => ({ hidden: false, disabled: false, value: "", textContent: "", replaceChildren: noop, append: noop, elements: { time_zone: { value: "unsaved zone" } } });
  const nodes = new Map<string, ReturnType<typeof element>>();
  const byId = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id)!;
  };
  const report = {
    date: "2026-10-01",
    reset() {
      this.date = "default";
    },
    configure: noop,
  };
  const membership = { workspace_id: "workspace-a", role: "owner", time_zone: "Asia/Seoul" };
  const context = vm.createContext({
    pendingInvite: null,
    segmentsGeneration: 0,
    workspaceGeneration: 0,
    workspaceLoadRequest: 0,
    globalSendRevision: 0,
    currentUserId: "user-a",
    currentWorkspaceId: "workspace-a",
    currentRole: "owner",
    workspaceTimeZone: "Asia/Seoul",
    currentView: "home",
    connections: [],
    editingSegment: null,
    contactsDirty: new Set(),
    contactsSaving: false,
    byId,
    form: { elements: { connection_id: element() } },
    errors: {},
    manualReports: report,
    flowReports: report,
    handoffReports: report,
    campaignReports: report,
    contactCsvPreview: { reset: noop, configure: noop },
    segmentSnapshots: { reset: noop, configure: noop },
    campaignDrafts: { configure: noop },
    flowEditor: { initialize: noop },
    viewFromHash: () => "home",
    emptyState: element,
    api: async (url: string) => {
      if (url === "/api/me") return { user: { id: "user-a" } };
      if (url === "/api/workspace") return membership;
      if (url === "/api/connections") return { connections: [] };
      if (url === "/api/rules") return { rules: [] };
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  for (const name of [
    "ruleControls",
    "segmentControls",
    "invalidateContactExport",
    "planControls",
    "timeZoneControls",
    "loadOperations",
    "loadWebhooks",
    "loadMembers",
    "renderGlobalSend",
    "showView",
    "formConditions",
    "loadMedia",
    "initializeContacts",
    "initializeInbox",
    "loadContactSegments",
    "loadContactFields",
    "loadContacts",
    "loadActivity",
    "scrollToSectionHash",
  ])
    context[name] = noop;
  context.resetSession = () => {
    context.workspaceGeneration++;
    context.segmentsGeneration++;
    context.currentUserId = undefined;
    context.currentWorkspaceId = undefined;
    context.currentRole = undefined;
    report.reset();
    byId("workspace").hidden = true;
  };
  vm.runInContext(appFunction("readWorkspace") + "\n" + appFunction("loadWorkspace"), context);
  return { context, membership, report, byId, load: () => context.loadWorkspace() as Promise<void> };
}

test("workspace refresh preserves unrelated report and settings drafts", async () => {
  const h = workspaceHarness();
  await h.load();
  assert.equal(h.report.date, "2026-10-01");
  assert.equal(h.byId("time-zone-form").elements.time_zone.value, "unsaved zone");
});

test("a core read failure leaves the previous workspace context untouched", async () => {
  const h = workspaceHarness();
  const api = h.context.api;
  h.membership.time_zone = "UTC";
  h.context.api = (url: string) => (url === "/api/rules" ? Promise.reject(new Error("offline")) : api(url));
  await assert.rejects(h.load(), /offline/);
  assert.equal(h.context.workspaceTimeZone, "Asia/Seoul");
  assert.equal(h.report.date, "2026-10-01");
});

for (const change of ["user", "workspace", "role"]) {
  test(`a ${change} transition discards the previous context before a core read can fail`, async () => {
    const h = workspaceHarness();
    if (change === "workspace") h.membership.workspace_id = "workspace-b";
    if (change === "role") h.membership.role = "agent";
    const api = h.context.api;
    h.context.api = (url: string) => {
      if (change === "user" && url === "/api/me") return Promise.resolve({ user: { id: "user-b" } });
      if (url === "/api/rules") return Promise.reject(new Error("offline"));
      return api(url);
    };
    await assert.rejects(h.load(), /offline/);
    assert.equal(h.report.date, "default");
    assert.equal(h.byId("workspace").hidden, true);
  });
}

test("a superseded workspace request cannot commit its older settings", async () => {
  const h = workspaceHarness();
  const api = h.context.api;
  let resolve!: (value: unknown) => void;
  let reads = 0;
  h.context.api = (url: string) =>
    url === "/api/workspace" && ++reads === 1
      ? new Promise((done) => {
          resolve = done;
        })
      : api(url);
  const older = h.load();
  await new Promise<void>((done) => setImmediate(done));
  await h.load();
  resolve({ ...h.membership, time_zone: "UTC" });
  await older;
  assert.equal(h.context.workspaceTimeZone, "Asia/Seoul");
});

test("an unrelated action cannot unlock a rule save already in progress", async () => {
  const save = { disabled: true, hasAttribute: () => true };
  const button = { disabled: false, textContent: "refresh", dataset: {}, closest: () => null, setAttribute() {}, removeAttribute() {} };
  const nodes = new Map<string, { disabled: boolean }>([
    ["save-rule", save],
    ["rule-fields", { disabled: true }],
    ["new-rule", { disabled: true }],
  ]);
  const context = vm.createContext({
    byId: (id: string) => (id === "rules" ? { querySelectorAll: () => [] } : nodes.get(id)),
    connections: [{}],
    workspaceGeneration: 0,
    pendingActions: new Map(),
    holdFocus: () => () => {},
    clearActionError: () => {},
  });
  const begin = source.indexOf("function ruleControls(");
  if (begin >= 0) vm.runInContext(source.slice(begin, source.indexOf("\n}", begin) + 2), context);
  vm.runInContext(appFunction("action"), context);
  await context.action(button, async () => {});
  assert.equal(save.disabled, true);
});
