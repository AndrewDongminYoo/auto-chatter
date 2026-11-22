import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
class Element {
  textContent = "";
  disabled = false;
  hidden = false;
  type = "";
  children: Element[] = [];
  listeners = new Map<string, () => unknown>();
  constructor(text = "") {
    this.textContent = text;
  }
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  setAttribute() {}
  removeAttribute() {}
  addEventListener(name: string, cb: () => unknown) {
    this.listeners.set(name, cb);
  }
  async click() {
    if (!this.disabled) await this.listeners.get("click")?.();
  }
}
const file = new URL("../../public/app/contact-identity-links.js", import.meta.url);
function harness(api: (path: string, method?: string, body?: unknown) => Promise<unknown>, edit = true, footers = new Map<string, Element>(), record: Element | null = null, extra: Record<string, unknown> = {}) {
  const context = vm.createContext({ crypto: { randomUUID: () => "request-1" }, confirm: () => true });
  // Mocked api errors come from this realm, and errorMessage passes through only plain Errors of the script's realm.
  context.Error = Error;
  vm.runInContext(readFileSync(new URL("../../public/app/display-values.js", import.meta.url), "utf8"), context);
  if (existsSync(file)) vm.runInContext(readFileSync(file, "utf8"), context);
  assert.equal(typeof context.createContactIdentityLinks, "function", "contact identity controller must exist");
  let current = true;
  const section = context.createContactIdentityLinks({
    api: async (path: string, method?: string, body?: unknown) => {
      const result = await api(path, method, body);
      return method === "POST" ? result : { can_edit: edit, ...(result as object) };
    },
    node: (_tag: string, text = "") => new Element(text),
    contact: { connection_id: "c1", sender_id: "123" },
    footers,
    record,
    isCurrent: () => current,
    ...extra,
  });
  const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
  const button = (text: string) => {
    const found = all(section).find((x) => x.textContent === text);
    assert.ok(found, `missing ${text}`);
    return found;
  };
  return {
    section,
    all: () => all(section),
    button,
    invalidate: () => {
      current = false;
    },
  };
}
const candidate = {
  recipient_id: "200",
  state: null,
  version: 0,
  current_evidence_reply_id: "91",
  evidence_valid: false,
  blocked: false,
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
test("identity UI confirms exact displayed version and refreshes, while agents cannot write", async () => {
  let confirmed = false;
  const writes: unknown[] = [];
  const api = async (_path: string, method?: string, body?: unknown) => {
    if (method === "POST") {
      writes.push(body);
      confirmed = true;
      return {};
    }
    return {
      links: [{ ...candidate, state: confirmed ? "confirmed" : null, version: confirmed ? 1 : 0, evidence_valid: confirmed }],
      after: null,
    };
  };
  const h = harness(api);
  await settle();
  await h.button("연결 확인").click();
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0])), {
    action: "confirm",
    request_key: "request-1",
    expected_version: 0,
    evidence_reply_id: "91",
  });
  assert.ok(h.all().some((x) => x.textContent === "확인됨"));
  h.button("확인 해제");
  const agent = harness(api, false);
  await settle();
  assert.ok(!agent.all().some((x) => x.textContent === "확인 해제"));
});
test("identity UI shows a confirmation with invalid evidence only as a past confirmation", async () => {
  const h = harness(async () => ({ links: [{ ...candidate, state: "confirmed", version: 1, evidence_valid: false }], after: null }));
  await settle();
  assert.ok(h.all().some((x) => x.textContent === "이전 확인"));
  assert.ok(!h.all().some((x) => x.textContent === "확인됨"), "a stale confirmation does not look like a current link");
});
test("identity UI drops late responses after its contact or session becomes stale", async () => {
  let resolve!: (value: unknown) => void;
  const h = harness(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  h.invalidate();
  resolve({ links: [candidate], after: null });
  await settle();
  assert.ok(!h.all().some((x) => x.textContent === "연결 확인"));
});
test("identity UI clears a conflicting result and never retries the write at a newer version", async () => {
  let writes = 0;
  const h = harness(async (_path, method) => {
    if (method === "POST") {
      writes++;
      throw { status: 409, message: "conflict" };
    }
    return { links: [candidate], after: null };
  });
  await settle();
  await h.button("연결 확인").click();
  assert.equal(writes, 1);
  assert.ok(h.all().some((x) => x.textContent.includes("변경")));
});
test("identity UI retains the request key for an uncertain failed write", async () => {
  const bodies: unknown[] = [];
  const h = harness(async (_path, method, body) => {
    if (method === "POST") {
      bodies.push(body);
      throw new Error("network");
    }
    return { links: [candidate], after: null };
  });
  await settle();
  await h.button("연결 확인").click();
  await h.button("연결 확인").click();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("actual dashboard session listeners invalidate contacts on cross-tab changes and BFCache restore", () => {
  const source = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  const block = source.match(/\/\/ Invalidate contact disclosures on cross-tab sessions and BFCache restoration\.[\s\S]*?\/\/ End contact session listeners\./)?.[0];
  assert.ok(block, "dashboard must wire contact session invalidation");
  let channelListener!: (event: { data: unknown }) => void;
  let pageListener!: (event: { persisted: boolean }) => void;
  let invalidations = 0;
  let campaignInvalidations = 0;
  const retryLoad = { hidden: true };
  class Channel {
    constructor(name: string) {
      assert.equal(name, "auto-chatter-session");
    }
    addEventListener(_name: string, cb: (event: { data: unknown }) => void) {
      channelListener = cb;
    }
  }
  const runtime = {
    startupRequest: 0,
    resetSession() {
      runtime.workspaceGeneration++;
      runtime.segmentsGeneration++;
      runtime.contactsSaving = false;
      runtime.clearContactResults();
      runtime.campaignDrafts.reset();
    },
    segmentsGeneration: 0,
    workspaceGeneration: 0,
    contactSessionSource: "current-tab",
    campaignDrafts: { reset: () => campaignInvalidations++ },
    manualReports: { reset: () => {} },
    flowReports: { reset: () => {} },
    handoffReports: { reset: () => {} },
    campaignReports: { reset: () => {} },
    notice: () => {},
    byId: (id: string) => (id === "workspace" ? { hidden: false } : retryLoad),
    contactsSaving: true,
    BroadcastChannel: Channel,
    window: {
      addEventListener: (_name: string, cb: typeof pageListener) => {
        pageListener = cb;
      },
    },
    clearContactResults: () => {
      invalidations++;
    },
  };
  vm.runInNewContext(block, runtime);
  channelListener({ data: { source: "current-tab" } });
  assert.equal(invalidations, 0, "same-document login broadcasts must not cancel its new bootstrap");
  channelListener({ data: { source: "another-tab" } });
  pageListener({ persisted: false });
  assert.equal(invalidations, 1);
  pageListener({ persisted: true });
  assert.equal(invalidations, 2);
  assert.equal(campaignInvalidations, 2, "session events clear campaign messages too");
  assert.equal(runtime.workspaceGeneration, 2, "session events invalidate pending workspace loads");
  assert.equal(runtime.segmentsGeneration, 2, "session reset retires pending filter operations");
  assert.equal(retryLoad.hidden, false, "a cleared campaign screen must offer a fresh workspace load");
  assert.equal(runtime.contactsSaving, false, "session invalidation releases stale saves");
});

test("identity UI uses the freshly read server permission after a different account signs in", async () => {
  const h = harness(async () => ({ links: [candidate], after: null, can_edit: false }));
  await settle();
  assert.ok(!h.all().some((x) => x.textContent === "연결 확인"));
});

test("identity UI puts each link in its conversation card footer and gives other recipients their own card", async () => {
  let confirmed = false;
  const footer = new Element();
  const api = async (_path: string, method?: string) => {
    if (method === "POST") {
      confirmed = true;
      return {};
    }
    return {
      links: [
        { ...candidate, state: confirmed ? "confirmed" : null, version: confirmed ? 1 : 0, evidence_valid: confirmed },
        { ...candidate, recipient_id: "300", state: "detached", version: 2, current_evidence_reply_id: null },
      ],
      after: null,
    };
  };
  const h = harness(api, true, new Map([["200", footer]]));
  await settle();
  const texts = (node: Element): string[] => [node.textContent, ...node.children.flatMap(texts)];
  assert.ok(texts(footer).includes("확인 없음"), "the card footer shows the recipient's state");
  assert.ok(texts(footer).includes("연결 확인"), "the card footer holds the action");
  assert.ok(!texts(footer).includes("DM 상대 300"));
  assert.ok(
    h.all().some((x) => x.textContent === "DM 상대 300"),
    "a recipient without a conversation card gets its own card",
  );
  assert.ok(h.all().some((x) => x.textContent === "확인 해제됨"));
  const confirmButton = all(footer).find((x) => x.textContent === "연결 확인");
  await confirmButton!.click();
  assert.equal(texts(footer).filter((x) => x === "확인됨").length, 1, "a reload replaces the footer instead of adding a second row");
  assert.ok(!texts(footer).includes("연결 확인"));
  assert.equal(h.all().filter((x) => x.textContent === "DM 상대 300").length, 1);
});
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];

test("identity UI lists each link's reply evidence in the record and never leaves a card waiting after a load", async () => {
  const footer = new Element();
  const other = new Element();
  const record = new Element();
  let page: "first" | "second" | "empty" = "first";
  const api = async (path: string) => {
    if (page === "empty") return { links: [], after: null };
    if (page === "second" || path.includes("after=")) return { links: [{ ...candidate, recipient_id: "400", current_evidence_reply_id: null }], after: null };
    return { links: [candidate], after: "next" };
  };
  const h = harness(
    api,
    false,
    new Map([
      ["200", footer],
      ["300", other],
    ]),
    record,
  );
  await settle();
  const texts = (node: Element): string[] => [node.textContent, ...node.children.flatMap(texts)];
  assert.ok(texts(record).includes("이 사람에게 보낸 답장 기록 91"), "the current reply evidence ID stays visible in the record");
  assert.ok(texts(other).includes("이 연결 페이지에는 없습니다."), "a card absent from a paged link list says so");
  await h.button("다음 연결 보기").click();
  assert.ok(texts(footer).includes("이 연결 페이지에는 없습니다."), "the first page's card is not left at the pre-load state");
  assert.ok(texts(record).includes("지금 확인된 답장 기록 없음"));
  assert.ok(!texts(record).includes("이 사람에게 보낸 답장 기록 91"), "a reload replaces the record entries");
  assert.ok(!h.all().some((x) => x.textContent === "연결 상태 확인 전"));
  page = "empty";
  await (h.section as unknown as { reload: () => Promise<void> }).reload();
  assert.ok(texts(footer).includes("연결 기록 없음"));
  assert.ok(!h.all().some((x) => x.textContent === "연결 상태 새로고침"), "the detail panel owns the only refresh");
});

test("identity UI reports a write as busy until its reload ends and refuses one while another save runs", async () => {
  const events: string[] = [];
  let blocked = true;
  let posts = 0;
  const api = async (_path: string, method?: string) => {
    if (method === "POST") {
      posts++;
      return {};
    }
    events.push("read");
    return { links: [candidate], after: null };
  };
  const h = harness(api, true, new Map(), null, {
    canStart: () => !blocked,
    onBusy: (busy: boolean) => events.push(busy ? "busy" : "idle"),
  });
  await settle();
  await h.button("연결 확인").click();
  assert.equal(posts, 0, "a write waits for the other contact save");
  blocked = false;
  await h.button("연결 확인").click();
  assert.equal(posts, 1);
  assert.deepEqual(events, ["read", "busy", "read", "idle"], "the page stays busy through the reload after the write");
});
