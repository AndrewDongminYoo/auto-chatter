import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");

test("mobile preview preserves the draft and restores the last input focus", () => {
  const focused: string[] = [];
  const element = (id: string) => ({
    isConnected: true,
    disabled: false,
    getClientRects: () => [1],
    focus: () => focused.push(id),
    scrollIntoView: () => {},
    setAttribute: () => {},
  });
  const input = { ...element("message"), value: "keep this draft" };
  const nodes = new Map([
    ["preview-title", element("preview")],
    ["media-title", element("media")],
    ["rule-preview-toggle", element("toggle")],
  ]);
  const modes: boolean[] = [];
  const context = vm.createContext({
    form: { classList: { toggle: (_name: string, value: boolean) => modes.push(value) } },
    byId: (id: string) => nodes.get(id),
    ruleInputFocus: input,
    updatePreview: () => {},
    dirty: true,
  });
  const begin = source.indexOf("function setRulePreview(");
  vm.runInContext(source.slice(begin, source.indexOf("\n}", begin) + 2), context);
  assert.equal(typeof context.setRulePreview, "function", "preview interaction is available");
  context.setRulePreview(true);
  context.setRulePreview(false);
  assert.deepEqual(modes, [true, false]);
  assert.deepEqual(focused, ["preview", "message"]);
  assert.equal(input.value, "keep this draft");
  assert.equal(context.dirty, true);
  context.setRulePreview(false, { focus: false });
  assert.deepEqual(focused, ["preview", "message"], "validation keeps ownership of the next focus");
  input.isConnected = false;
  context.setRulePreview(false);
  assert.equal(focused.at(-1), "media", "a retired input cannot receive focus");
});

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
    zone: "Asia/Seoul",
    reset() {
      this.date = "default";
    },
    configure(_role: string, zone: string) {
      this.zone = zone;
    },
  };
  const membership = { workspace_id: "workspace-a", role: "owner", time_zone: "Asia/Seoul" };
  const notices: string[] = [];
  byId("retry-load").hidden = true;
  const context = vm.createContext({
    pendingInvite: null,
    segmentsGeneration: 0,
    workspaceGeneration: 0,
    viewLoads: new Map(),
    contactSnapshotContext: undefined,
    workspaceLoadRequest: 0,
    globalSendRevision: 0,
    currentUserId: "user-a",
    currentWorkspaceId: "workspace-a",
    currentRole: "owner",
    workspaceTimeZone: "Asia/Seoul",
    timeZoneWriteRevision: 0,
    currentView: "home",
    connections: [],
    editingSegment: null,
    contactsDirty: new Set(),
    contactsSaving: false,
    byId,
    form: { elements: { connection_id: element() } },
    errors: {},
    errorMessage: (error: Error) => error.message,
    notice: (message: string) => notices.push(message),
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
    "loadView",
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
  return { context, membership, report, byId, notices, load: () => context.loadWorkspace() as Promise<void> };
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
    assert.equal(h.byId("auth").hidden, true);
    assert.equal(h.byId("retry-load").hidden, false);
    assert.deepEqual(h.notices, ["offline"]);
    h.context.api = api;
    await h.load();
    assert.equal(h.byId("workspace").hidden, false);
    assert.equal(h.byId("retry-load").hidden, true);
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

test("a time zone saved during a refresh survives its older membership snapshot", async () => {
  const h = workspaceHarness();
  const api = h.context.api;
  let release!: () => void;
  h.context.api = (url: string) =>
    url === "/api/connections"
      ? new Promise((resolve) => {
          release = () => resolve({ connections: [] });
        })
      : api(url);
  const pending = h.load();
  await new Promise<void>((done) => setImmediate(done));
  h.context.timeZoneWriteRevision++;
  h.context.workspaceTimeZone = "UTC";
  h.byId("time-zone-form").elements.time_zone.value = "UTC";
  release();
  await pending;
  assert.equal(h.byId("time-zone-form").elements.time_zone.value, "UTC");
  assert.equal(h.context.workspaceTimeZone, "UTC");
  assert.equal(h.report.zone, "UTC");
});

test("an unrelated action cannot unlock a rule save already in progress", async () => {
  const save = { disabled: true, hasAttribute: () => true };
  const button = { disabled: false, textContent: "refresh", dataset: {}, closest: () => null, setAttribute() {}, removeAttribute() {} };
  const nodes = new Map<string, { disabled: boolean }>([
    ["save-rule", save],
    ["rule-fields", { disabled: true }],
    ["new-rule", { disabled: true }],
    ["rule-preview-toggle", { disabled: true }],
  ]);
  const context = vm.createContext({
    byId: (id: string) => (id === "rules" ? { querySelectorAll: () => [] } : nodes.get(id)),
    connections: [{}],
    workspaceGeneration: 0,
    viewLoads: new Map(),
    contactSnapshotContext: undefined,
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

test("two documents clear a session change without rebroadcasting it", () => {
  const deliveries: (() => void)[] = [];
  const channels: SessionChannel[] = [];
  let broadcasts = 0;
  class SessionChannel {
    listeners: ((event: { data: unknown }) => void)[] = [];
    constructor() {
      channels.push(this);
    }
    addEventListener(_name: string, listener: (event: { data: unknown }) => void) {
      this.listeners.push(listener);
    }
    postMessage(data: unknown) {
      broadcasts++;
      for (const channel of channels) {
        if (channel !== this) deliveries.push(() => channel.listeners.forEach((listener) => listener({ data })));
      }
    }
  }
  const document = (sessionSource: string) => {
    const noop = () => {};
    const element = () => ({ hidden: false, value: "", disabled: false, reset: noop, replaceChildren: noop, addEventListener: noop, removeAttribute: noop });
    const nodes = new Map<string, ReturnType<typeof element>>();
    const byId = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id)!;
    };
    const context = vm.createContext({
      document: { getElementById: byId },
      byId,
      window: { addEventListener: noop },
      BroadcastChannel: SessionChannel,
      Option: class {},
      contactSessionSource: sessionSource,
      pendingActions: new Map(),
      contactsDirty: new Set(),
      purgedContactConnections: new Set(),
      mediaCache: new Map(),
      healthResults: new Map(),
      ruleMediaObserver: { disconnect: noop },
      form: { reset: noop, elements: { media_id: element(), connection_id: element() } },
      startupRequest: 0,
      workspaceGeneration: 0,
      viewLoads: new Map(),
      contactSnapshotContext: undefined,
      globalSendRevision: 0,
      contactsGeneration: 0,
      segmentsGeneration: 0,
      fieldsGeneration: 0,
      mediaSession: 0,
      fieldFilterRows: () => [],
    });
    for (const name of ["campaignDrafts", "segmentSnapshots", "manualReports", "flowReports", "handoffReports", "campaignReports", "flowEditor"]) context[name] = { reset: noop };
    for (const name of [
      "invalidateContactExport",
      "resetInbox",
      "clearActionErrors",
      "planControls",
      "timeZoneControls",
      "hideInviteLink",
      "hideWebhookSecret",
      "renderConditionTree",
      "leaveSegmentEdit",
      "fieldControls",
      "segmentControls",
      "contactTagControls",
      "showFieldRows",
      "fieldFilterControls",
      "contactActivityControls",
      "contactConsentControls",
      "resetMedia",
      "resetActivity",
      "formConditions",
      "ruleControls",
      "editorState",
      "setRulePreview",
      "notice",
    ])
      context[name] = noop;
    vm.runInContext(readFileSync(new URL("../../public/app/contact-csv-preview.js", import.meta.url), "utf8"), context);
    context.contactCsvPreview = context.createContactCsvPreview({ api: noop, node: element, sessionSource });
    const resetStart = source.indexOf("function resetSession(");
    vm.runInContext(source.slice(resetStart, source.indexOf("\n}", resetStart) + 2), context);
    const listenerStart = source.indexOf("const invalidateContactSession = () => {");
    vm.runInContext(source.slice(listenerStart, source.indexOf("// End contact session listeners.", listenerStart)), context);
    return { context, byId };
  };
  const first = document("document-a");
  const second = document("document-b");
  first.context.resetSession();
  // Drain the actual listener/controller graph with a finite queue instead of relying on timing.
  for (let count = 0; deliveries.length && count < 20; count++) deliveries.shift()!();
  assert.equal(broadcasts, 1, "a received invalidation must not publish a new source marker");
  assert.equal(deliveries.length, 0, "the cross-document message queue must settle");
  assert.equal(first.context.workspaceGeneration, 1);
  assert.equal(second.context.workspaceGeneration, 1);
  assert.equal(second.byId("workspace").hidden, true);
  assert.equal(second.byId("auth").hidden, true);
  assert.equal(second.byId("retry-load").hidden, false);
});

test("home bootstrap does not initialize hidden feature data", async () => {
  const h = workspaceHarness();
  const calls: string[] = [];
  for (const name of ["initializeInbox", "loadContactFields", "loadContacts", "loadOperations", "loadWebhooks", "loadMembers", "loadMedia"]) h.context[name] = () => calls.push(name);
  await h.load();
  assert.deepEqual(calls, []);
});

function viewHarness() {
  const calls: string[] = [];
  const context = vm.createContext({
    currentWorkspaceId: "one",
    workspaceLoadRequest: 1,
    workspaceGeneration: 1,
    viewLoads: new Map(),
    currentView: "home",
    currentRole: "owner",
    workspaceTimeZone: "Asia/Seoul",
    contactSnapshotContext: undefined,
    connections: [],
    contactsDirty: new Set(),
    contactsSaving: false,
    loadActivity: async () => {
      calls.push("activity");
    },
    initializeContacts: () => calls.push("contacts-options"),
    segmentSnapshots: { configure: () => calls.push("snapshots") },
    loadContactSegments: async () => {
      calls.push("segments");
    },
    loadContactFields: async () => {
      calls.push("fields");
      return true;
    },
    loadContacts: async () => {
      calls.push("contacts");
    },
    initializeInbox: () => calls.push("inbox"),
    notice: (text: string) => calls.push(text),
    errorMessage: (error: Error) => error.message,
  });
  vm.runInContext(appFunction("loadView"), context);
  return { context, calls, load: (name: string) => context.loadView(name) as Promise<void> };
}

test("view entry shares initialization and leaves other views idle", async () => {
  const h = viewHarness();
  await Promise.all([h.load("home"), h.load("home")]);
  await h.load("home");
  assert.deepEqual(h.calls, ["activity"]);
  await Promise.all([h.load("contacts"), h.load("contacts")]);
  assert.deepEqual(h.calls, ["activity", "contacts-options", "snapshots", "segments", "fields", "contacts"]);
  h.context.viewLoads.clear();
  await h.load("home");
  assert.equal(h.calls.filter((name) => name === "activity").length, 2);
});

test("retired view initialization cannot continue into a new session", async () => {
  const h = viewHarness();
  let release!: (value: boolean) => void;
  h.context.loadContactFields = () =>
    new Promise<boolean>((resolve) => {
      release = resolve;
    });
  const pending = h.load("contacts");
  await Promise.resolve();
  h.context.workspaceGeneration++;
  h.context.viewLoads.clear();
  release(true);
  await pending;
  assert.ok(!h.calls.includes("contacts"));
});

test("saving a changed time zone retires the reports view load", async () => {
  const begin = source.indexOf('byId("time-zone-form").addEventListener("submit"');
  const end = source.indexOf('\nbyId("operations-refresh")', begin);
  assert.ok(begin >= 0 && end > begin);
  let submit!: (event: { preventDefault(): void; currentTarget: object }) => void;
  let saving: Promise<void> | undefined;
  const loads = new Map([
    ["reports", Promise.resolve()],
    ["inbox", Promise.resolve()],
  ]);
  const noop = () => {};
  const context = vm.createContext({
    formatText: (value: unknown) => (typeof value === "string" ? value : "–"),
    byId: () => ({
      addEventListener: (_name: string, listener: typeof submit) => {
        submit = listener;
      },
    }),
    action: (_button: object, task: () => Promise<void>) => {
      saving = task();
    },
    api: async () => ({ time_zone: "UTC" }),
    workspaceTimeZone: "Asia/Seoul",
    timeZoneWriteRevision: 0,
    currentRole: "owner",
    currentView: "settings",
    connections: [],
    viewLoads: loads,
    inbox: { timeZoneChanged: noop },
    campaignDrafts: { timeZoneChanged: noop },
    manualReports: { configure: noop },
    flowReports: { configure: noop },
    handoffReports: { configure: noop },
    campaignReports: { configure: noop },
    notice: noop,
  });
  vm.runInContext(source.slice(begin, end), context);
  submit({ preventDefault: noop, currentTarget: { elements: { time_zone: { value: "UTC" } }, querySelector: () => ({}) } });
  await saving;
  assert.equal(loads.has("reports"), false);
  assert.equal(loads.has("inbox"), true);
  assert.equal(context.workspaceTimeZone, "UTC");
});

test("a retired view retries after a failed refresh and preserves a newer load", async () => {
  for (const newer of [false, true]) {
    const h = viewHarness();
    let release!: (value: boolean) => void;
    h.context.loadContactFields = () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      });
    const pending = h.load("contacts");
    await Promise.resolve();
    h.context.workspaceLoadRequest++;
    h.context.loadContactFields = async () => true;
    if (newer) {
      h.context.viewLoads.clear();
      await h.load("contacts");
    }
    const replacement = h.context.viewLoads.get("contacts");
    release(true);
    await pending;
    if (newer) assert.equal(h.context.viewLoads.get("contacts"), replacement);
    else {
      assert.equal(h.context.viewLoads.has("contacts"), false);
      await h.load("contacts");
    }
    assert.equal(h.calls.filter((name) => name === "contacts").length, 1);
  }
});

test("a session reset drops the loaded activity so a filter change cannot redraw another workspace's rows", () => {
  // A small element that keeps its children, text and options, enough for the activity renderer.
  type Fake = { tag: string; textContent: string; className: string; value: string; children: Fake[]; options: Fake[]; dataset: Record<string, string>; scope?: string; colSpan?: number; replaceChildren: (...items: Fake[]) => void; append: (...items: Fake[]) => void };
  const make = (tag: string): Fake => {
    const element: Fake = {
      tag,
      textContent: "",
      className: "",
      value: "",
      children: [],
      options: [],
      dataset: {},
      replaceChildren: (...items) => {
        element.children = items;
        element.options = items;
      },
      append: (...items) => {
        element.children.push(...items);
        element.options.push(...items);
      },
    };
    return element;
  };
  const text = (element: Fake): string => element.textContent + element.children.map(text).join("");
  const nodes = new Map([
    ["activity", make("div")],
    ["activity-count", make("span")],
    ["activity-filter", make("select")],
  ]);
  const context = vm.createContext({
    activityRequest: 0,
    activityRows: [],
    byId: (id: string) => nodes.get(id),
    connections: [{ id: "c1" }],
    sendStatusLabels: { sent: "Meta 접수" },
    formatText: (value: unknown) => String(value ?? "—"),
    badge: (label: string) => Object.assign(make("span"), { textContent: label }),
    emptyState: (title: string) => Object.assign(make("div"), { textContent: title }),
    node: (tag: string, label: string, className = "") => Object.assign(make(tag), { textContent: label, className }),
    Option: function (this: Fake, label: string, value: string) {
      return Object.assign(make("option"), { textContent: label, value });
    },
  });
  const begin = source.indexOf("const activityLabels = {");
  const end = source.indexOf("\n}", source.indexOf("function resetActivity("));
  assert.ok(begin >= 0 && end > begin, "the activity renderer and its reset are one block");
  vm.runInContext(source.slice(begin, end + 2), context);
  context.activityRows = [{ media_id: "previous-workspace-post", first_reply_status: "sent", follow_reply_status: "sent", follow_status: "following" }];
  context.renderActivity();
  assert.match(text(nodes.get("activity")!), /previous-workspace-post/);
  const before = context.activityRequest;
  context.resetActivity();
  assert.ok(context.activityRequest > before, "a read started before the reset cannot write its result");
  assert.equal(nodes.get("activity-count")!.textContent, "0건");
  assert.deepEqual(
    nodes.get("activity-filter")!.options.map((option) => option.value),
    ["all"],
  );
  // The new session's read has not answered yet; a filter change must not bring the old rows back.
  nodes.get("activity-filter")!.value = "sent";
  context.renderActivity();
  assert.doesNotMatch(text(nodes.get("activity")!), /previous-workspace-post/);
});

test("a connection data deletion drops the loaded activity before its reload, so a failed reload cannot be filtered back", async () => {
  type Fake = { textContent: string; value: string; children: Fake[]; options: Fake[]; dataset: Record<string, string>; className: string; replaceChildren: (...items: Fake[]) => void; append: (...items: Fake[]) => void; querySelectorAll: () => Fake[] };
  const make = (): Fake => {
    const element: Fake = {
      textContent: "",
      value: "",
      className: "",
      children: [],
      options: [],
      dataset: {},
      replaceChildren: (...items) => {
        element.children = items;
        element.options = items;
      },
      append: (...items) => {
        element.children.push(...items);
        element.options.push(...items);
      },
      querySelectorAll: () => [],
    };
    return element;
  };
  const text = (element: Fake): string => element.textContent + element.children.map(text).join("");
  const nodes = new Map(["activity", "activity-count", "activity-filter", "contacts-list"].map((id) => [id, make()]));
  const noop = () => {};
  const context = vm.createContext({
    activityRequest: 0,
    activityRows: [],
    segmentsGeneration: 1,
    contactsSaving: false,
    contactsDirty: new Set(),
    purgedContactConnections: new Set(),
    contactCsvPreview: { invalidate: noop },
    inbox: { forgetConnection: noop },
    invalidateSegmentPreview: noop,
    invalidateContactExport: noop,
    loadContacts: async () => {},
    byId: (id: string) => nodes.get(id),
    connections: [{ id: "c1" }],
    sendStatusLabels: { sent: "Meta 접수" },
    formatText: (value: unknown) => String(value ?? "—"),
    badge: (label: string) => Object.assign(make(), { textContent: label }),
    emptyState: (title: string) => Object.assign(make(), { textContent: title }),
    node: (_tag: string, label: string, className = "") => Object.assign(make(), { textContent: label, className }),
    Option: function (label: string, value: string) {
      return Object.assign(make(), { textContent: label, value });
    },
  });
  const begin = source.indexOf("const activityLabels = {");
  const end = source.indexOf("\n}", source.indexOf("function resetActivity("));
  vm.runInContext(source.slice(begin, end + 2), context);
  const forget = source.indexOf("function forgetDeletedConnection(");
  vm.runInContext(source.slice(forget, source.indexOf("\n}", forget) + 2), context);
  // The reload after the deletion fails.
  context.loadActivity = () => Promise.reject(new Error("offline"));
  context.activityRows = [
    { connection_id: "c1", media_id: "deleted-connection-post", first_reply_status: "sent", follow_reply_status: "sent", follow_status: "following" },
    { connection_id: "c2", media_id: "other-connection-post", first_reply_status: "sent", follow_reply_status: "sent", follow_status: "following" },
  ];
  context.renderActivity();
  context.forgetDeletedConnection("c1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text(nodes.get("activity")!), /처리 내역을 불러오지 못했습니다/);
  nodes.get("activity-filter")!.value = "sent";
  context.renderActivity();
  assert.doesNotMatch(text(nodes.get("activity")!), /deleted-connection-post/);
  assert.match(text(nodes.get("activity")!), /other-connection-post/, "another connection's rows stay");
});
