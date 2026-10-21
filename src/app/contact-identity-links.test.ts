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
function harness(api: (path: string, method?: string, body?: unknown) => Promise<unknown>, edit = true) {
  const context = vm.createContext({ crypto: { randomUUID: () => "request-1" }, confirm: () => true });
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
    isCurrent: () => current,
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
      links: [
        { ...candidate, state: confirmed ? "confirmed" : null, version: confirmed ? 1 : 0, evidence_valid: confirmed },
      ],
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
  assert.ok(h.all().some((x) => x.textContent.includes("운영자 확인됨")));
  h.button("확인 해제");
  const agent = harness(api, false);
  await settle();
  assert.ok(!agent.all().some((x) => x.textContent === "확인 해제"));
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
  const block = source.match(
    /\/\/ Invalidate contact disclosures on cross-tab sessions and BFCache restoration\.[\s\S]*?\/\/ End contact session listeners\./,
  )?.[0];
  assert.ok(block, "dashboard must wire contact session invalidation");
  let channelListener!: () => void;
  let pageListener!: (event: { persisted: boolean }) => void;
  let invalidations = 0;
  class Channel {
    constructor(name: string) {
      assert.equal(name, "auto-chatter-session");
    }
    addEventListener(_name: string, cb: () => void) {
      channelListener = cb;
    }
  }
  const runtime = {
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
  channelListener();
  pageListener({ persisted: false });
  assert.equal(invalidations, 1);
  pageListener({ persisted: true });
  assert.equal(invalidations, 2);
  assert.equal(runtime.contactsSaving, false, "session invalidation releases stale saves");
});

test("identity UI uses the freshly read server permission after a different account signs in", async () => {
  const h = harness(async () => ({ links: [candidate], after: null, can_edit: false }));
  await settle();
  assert.ok(!h.all().some((x) => x.textContent === "연결 확인"));
});
