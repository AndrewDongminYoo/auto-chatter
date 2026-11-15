import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

interface RereadState {
  loaded: boolean;
  visible: boolean;
  inFlight: boolean;
  lastReadAt: number;
  now: number;
}

interface GlobalSendState {
  globalSendRereadDue(state: RereadState): boolean;
  globalSendDeliveryTitle(globalSendEnabled: boolean): string;
  globalSendDeliveryStatus(globalSendEnabled: boolean, connectAvailable: boolean): string;
  globalSendAccountBadge(sendEnabled: boolean, credentialValid: boolean, globalSendEnabled: boolean): [string, string];
  globalSendRuleBadge(ruleEnabled: boolean, globalSendEnabled: boolean): [string, string];
}

// public/app/global-send-state.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/global-send-state.js", import.meta.url), "utf8"), context);
const state = context as unknown as GlobalSendState;
const read = (name: string) => readFileSync(new URL(`../../public/app/${name}`, import.meta.url), "utf8");
// Arrays from the vm context have another realm's prototype, so compare plain copies.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
// The source of one top-level function in app.js, up to its closing brace at column zero.
function appFunction(name: string): string {
  const source = read("app.js");
  const start = source.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `app.js has no function ${name}`);
  return source.slice(start, source.indexOf("\n}\n", start) + 2);
}

const base: RereadState = { loaded: true, visible: true, inFlight: false, lastReadAt: 100_000, now: 130_000 };

test("a re-read runs once the last read is 30 seconds old", () => {
  assert.equal(state.globalSendRereadDue({ ...base, now: 129_999 }), false);
  assert.equal(state.globalSendRereadDue(base), true);
});

test("a re-read waits for a loaded, visible workspace and one request at a time", () => {
  assert.equal(state.globalSendRereadDue({ ...base, loaded: false }), false);
  assert.equal(state.globalSendRereadDue({ ...base, visible: false }), false);
  assert.equal(state.globalSendRereadDue({ ...base, inFlight: true }), false);
});

test("a clock that moved backwards reads again", () => {
  assert.equal(state.globalSendRereadDue({ ...base, now: 99_999 }), true);
});

test("the banner and badges name the global state", () => {
  assert.equal(state.globalSendDeliveryTitle(true), "자동 발송을 시작할 수 있습니다");
  assert.equal(state.globalSendDeliveryTitle(false), "전체 발송이 중지되어 있습니다");
  assert.equal(state.globalSendDeliveryStatus(true, false), "계정별로 발송을 켜고 규칙을 활성화하면 자동화를 시작합니다.");
  assert.match(state.globalSendDeliveryStatus(false, true), /계정 연결과 규칙 저장은 계속할 수 있습니다\.$/);
  assert.match(state.globalSendDeliveryStatus(false, false), /새 Instagram 연결은 현재 제한됩니다\.$/);
  assert.deepEqual(plain(state.globalSendAccountBadge(true, true, true)), ["발송 설정 켜짐", "success"]);
  assert.deepEqual(plain(state.globalSendAccountBadge(true, false, true)), ["발송 설정 켜짐", ""]);
  assert.deepEqual(plain(state.globalSendAccountBadge(true, true, false)), ["발송 설정 켜짐 · 전체 중지 중", ""]);
  assert.deepEqual(plain(state.globalSendAccountBadge(false, true, true)), ["발송 설정 꺼짐", ""]);
  assert.deepEqual(plain(state.globalSendRuleBadge(true, true)), ["활성", "success"]);
  assert.deepEqual(plain(state.globalSendRuleBadge(true, false)), ["활성 · 전체 중지 중", ""]);
  assert.deepEqual(plain(state.globalSendRuleBadge(false, true)), ["중지", ""]);
});

test("the dashboard loads the state script before app.js", () => {
  const html = read("index.html");
  const position = (name: string) => html.indexOf(`<script src="./${name}" defer></script>`);
  assert.ok(position("global-send-state.js") > 0, "global-send-state.js is not loaded with defer");
  assert.ok(position("app.js") > position("global-send-state.js"), "app.js loads before the state script");
});

test("every display of the global state reads the shared value, not a stale /api/me response", () => {
  const app = read("app.js");
  // Only the workspace load and the re-read take the value from a response.
  assert.equal(app.match(/me\.global_send_enabled/g)?.length, 2);
  const render = appFunction("renderGlobalSend");
  for (const part of ["delivery-title", "delivery-banner", "delivery-status", "renderGettingStarted(", "globalSendBadges"]) assert.ok(render.includes(part), `renderGlobalSend does not update ${part}`);
  const load = appFunction("loadWorkspace");
  assert.match(load, /renderGlobalSend\(\)/);
  assert.match(load, /globalSendBadge\(\(enabled\) => globalSendAccountBadge\(/);
  assert.match(load, /globalSendBadge\(\(enabled\) => globalSendRuleBadge\(/);
});

test("a re-read changes only the global state displays and keeps drafts and the session", () => {
  const reread = appFunction("rereadGlobalSend");
  // Only /api/me, with no token refresh and no session reset on a 401.
  assert.match(reread, /api\("\/api\/me", "GET", undefined, false, false, true\)/);
  assert.equal(reread.match(/\bapi\(/g)?.length, 1);
  // A response that arrives after a workspace reload, a session reset or a logout is ignored.
  assert.match(reread, /revision !== globalSendRevision \|\| workspaceSession !== workspaceGeneration \|\| generation !== segmentsGeneration/);
  for (const forbidden of ["loadWorkspace(", "resetSession(", "replaceChildren", "form.", "contacts", "segment", "notice(", "throw"]) {
    assert.ok(!reread.replace("generation !== segmentsGeneration", "").replace("generation = segmentsGeneration", "").includes(forbidden), `rereadGlobalSend uses ${forbidden}`);
  }
  for (const forbidden of ["replaceChildren", "form.", "contacts", "segment"]) assert.ok(!appFunction("renderGlobalSend").includes(forbidden), `renderGlobalSend uses ${forbidden}`);
  // The wrapper resets the session on a 401 unless the caller keeps it.
  const wrapper = appFunction("api");
  assert.equal(wrapper.match(/response\.status === 401 && !keepSessionOn401\) resetSession\(\)/g)?.length, 2);
  assert.doesNotMatch(wrapper, /response\.status === 401\) resetSession\(\)/);
});

test("the workspace load, a menu change, focus and a visible page trigger the re-read", () => {
  const app = read("app.js");
  const load = appFunction("loadWorkspace");
  // The load stamps its own read, so its showView call does not read /api/me twice, and retires older re-reads.
  assert.ok(load.indexOf("globalSendRevision++") < load.indexOf('api("/api/me")'));
  assert.ok(load.indexOf("globalSendReadAt = Date.now()") < load.indexOf("showView("));
  // The value is stored only beside the render: a load that throws after /api/me keeps the stored value equal to
  // the screen, so a later re-read still detects a change.
  const render = load.indexOf("renderGlobalSend()");
  for (const assignment of ["globalSendEnabled = ", "instagramConnectAvailable = ", "globalSendReadAt = "]) {
    assert.equal(load.split(assignment).length, 2, `loadWorkspace assigns ${assignment.trim()} more than once`);
    assert.ok(load.indexOf(assignment) > load.lastIndexOf("await ", render), `${assignment.trim()} is assigned before an await that can throw`);
    assert.ok(load.indexOf(assignment) < render, `${assignment.trim()} is assigned after the render`);
  }
  assert.match(appFunction("showView"), /void rereadGlobalSend\(\)/);
  assert.match(app, /addEventListener\("focus", \(\) => void rereadGlobalSend\(\)\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", \(\) => \{\n\s+if \(document\.visibilityState === "visible"\) void rereadGlobalSend\(\);/);
  assert.match(appFunction("resetSession"), /globalSendRevision\+\+;\n\s+globalSendReadAt = 0;/);
});

interface FakeElement {
  hidden: boolean;
  textContent: string;
  className: string;
  enabled: boolean;
  classList: { toggle(name: string, on: boolean): void };
}

// Runs the re-read, render and badge functions of app.js against a fake page whose only server is a pending /api/me.
function rereadHarness() {
  const touched = new Set<string>();
  const elements = new Map<string, FakeElement>();
  const element = (): FakeElement => {
    const self: FakeElement = {
      hidden: false,
      textContent: "",
      className: "",
      enabled: false,
      classList: {
        toggle: (name, on) => {
          if (name === "enabled") self.enabled = on;
        },
      },
    };
    return self;
  };
  const responses: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const steps: boolean[] = [];
  const clock = { now: 200_000 };
  const context = vm.createContext({
    globalSendEnabled: false,
    globalSendReadAt: 100_000,
    globalSendInFlight: false,
    globalSendRevision: 1,
    instagramConnectAvailable: true,
    workspaceRules: [],
    globalSendBadges: [],
    workspaceGeneration: 1,
    segmentsGeneration: 1,
    document: { visibilityState: "visible" },
    Date: { now: () => clock.now },
    byId: (id: string) => {
      touched.add(id);
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id)!;
    },
    badge: (text: string, tone = "") => ({ textContent: text, className: `badge ${tone}` }),
    renderGettingStarted: (_rules: unknown, enabled: boolean) => steps.push(enabled),
    api: (...args: unknown[]) => {
      assert.deepEqual(args, ["/api/me", "GET", undefined, false, false, true]);
      return new Promise((resolve, reject) => responses.push({ resolve, reject }));
    },
  });
  vm.runInContext(read("global-send-state.js"), context);
  vm.runInContext(["globalSendBadge", "renderGlobalSend", "rereadGlobalSend"].map(appFunction).join("\n"), context);
  const page = context as unknown as {
    globalSendEnabled: boolean;
    globalSendRevision: number;
    workspaceGeneration: number;
    globalSendBadge(label: (enabled: boolean) => [string, string]): { textContent: string; className: string };
    rereadGlobalSend(): Promise<void>;
  };
  const account = page.globalSendBadge((enabled) => state.globalSendAccountBadge(true, true, enabled));
  const rule = page.globalSendBadge((enabled) => state.globalSendRuleBadge(true, enabled));
  touched.clear();
  return { page, touched, elements, responses, steps, clock, account, rule };
}

test("a changed global state reaches the banner, the getting-started steps and the badges without a reload", async () => {
  const h = rereadHarness();
  assert.equal(h.account.textContent, "발송 설정 켜짐 · 전체 중지 중");
  assert.equal(h.rule.textContent, "활성 · 전체 중지 중");
  const pending = h.page.rereadGlobalSend();
  // A second trigger while the read is in flight does not send another request.
  void h.page.rereadGlobalSend();
  assert.equal(h.responses.length, 1);
  h.responses[0].resolve({ global_send_enabled: true });
  await pending;
  assert.equal(h.page.globalSendEnabled, true);
  assert.equal(h.elements.get("delivery-title")?.textContent, "자동 발송을 시작할 수 있습니다");
  assert.equal(h.elements.get("delivery-banner")?.enabled, true);
  assert.equal(h.elements.get("delivery-status")?.textContent, "계정별로 발송을 켜고 규칙을 활성화하면 자동화를 시작합니다.");
  assert.deepEqual(h.steps, [true]);
  assert.deepEqual([h.account.textContent, h.account.className], ["발송 설정 켜짐", "badge success"]);
  assert.deepEqual([h.rule.textContent, h.rule.className], ["활성", "badge success"]);
  // Only the workspace check and the global state displays are touched: no list, rule editor or contact element.
  assert.deepEqual([...h.touched].sort(), ["delivery-banner", "delivery-status", "delivery-title", "workspace"]);
  // A read within 30 seconds of the last one is skipped.
  h.clock.now += 29_999;
  await h.page.rereadGlobalSend();
  assert.equal(h.responses.length, 1);
});

test("an unchanged, failed or outdated re-read leaves the screen as it is", async () => {
  const h = rereadHarness();
  let pending = h.page.rereadGlobalSend();
  h.responses[0].resolve({ global_send_enabled: false });
  await pending;
  assert.deepEqual(h.steps, []);
  h.clock.now += 30_000;
  pending = h.page.rereadGlobalSend();
  h.responses[1].reject(Object.assign(new Error("expired"), { status: 401 }));
  await pending;
  h.clock.now += 30_000;
  pending = h.page.rereadGlobalSend();
  // A workspace reload starts while the read is in flight; its own /api/me result wins.
  h.page.globalSendRevision++;
  h.responses[2].resolve({ global_send_enabled: true });
  await pending;
  h.clock.now += 30_000;
  pending = h.page.rereadGlobalSend();
  // A logout or session reset retires the read too.
  h.page.workspaceGeneration++;
  h.responses[3].resolve({ global_send_enabled: true });
  await pending;
  assert.equal(h.page.globalSendEnabled, false);
  assert.deepEqual(h.steps, []);
  assert.deepEqual([...h.touched], ["workspace"]);
  assert.equal(h.account.textContent, "발송 설정 켜짐 · 전체 중지 중");
});
