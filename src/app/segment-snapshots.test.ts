import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The dashboard's snapshot section (#233): with no saved segment selected it lists every snapshot of the workspace.
type Listener = () => unknown;
class Element {
  textContent = "";
  hidden = false;
  disabled = false;
  type = "";
  children: Element[] = [];
  listeners = new Map<string, Listener>();
  constructor(text = "") {
    this.textContent = text;
  }
  append(...items: Element[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: Element[]) {
    this.children = items;
  }
  addEventListener(name: string, callback: Listener) {
    this.listeners.set(name, callback);
  }
  async dispatch(name: string) {
    await this.listeners.get(name)?.();
  }
  setAttribute() {}
  removeAttribute() {}
}
const segmentA = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "VIP" };
const summary = (id: string, name: string, archived?: boolean) => ({
  id,
  segment_id: segmentA.id,
  segment_name: name,
  as_of: "2026-10-18T03:00:00.000000Z",
  counts: { total: "2", evaluated: "5", excluded: {} },
  member_count: 2,
  created_at: "2026-10-18T03:00:01.000Z",
  ...(archived === undefined ? {} : { segment_archived: archived }),
});
const workspaceList = {
  snapshots: [summary("s2", "VIP", false), summary("s1", "Old", true)],
  usage: { snapshots: 2, stored_members: 4, max_snapshots: 200, max_stored_members: 20_000 },
};

function harness(api: (path: string, method?: string) => Promise<unknown>) {
  const nodes = new Map<string, Element>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id)!;
  };
  const context = vm.createContext({ document: { getElementById: get } });
  vm.runInContext(readFileSync(new URL("../../public/app/segment-snapshots.js", import.meta.url), "utf8"), context);
  const controller = context.createSegmentSnapshots({
    api,
    node: (_tag: string, text = "") => new Element(text),
    connectionLabel: (id: string) => id,
  });
  const items = () => get("segment-snapshot-list").children.map((item) => item.children[0]!.textContent);
  return { controller, get, items };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("with no saved segment selected, admins see every workspace snapshot, archived ones marked, and the usage", async () => {
  const requests: string[] = [];
  const h = harness(async (path) => {
    requests.push(path);
    if (path === "/api/segment-snapshots") return workspaceList;
    if (path === "/api/segment-snapshots/s1")
      return { snapshot: { ...summary("s1", "Old"), stored_member_count: 2 }, members: [], after: null };
    throw new Error(`unexpected ${path}`);
  });
  h.controller.configure("admin", "UTC");
  await settle();
  assert.equal(h.get("segment-snapshots").hidden, false);
  assert.deepEqual(requests, ["/api/segment-snapshots"]);
  assert.equal(h.items().length, 2);
  assert.match(h.items()[0]!, /^"VIP" 필터 · 2026/);
  assert.match(h.items()[1]!, /^"Old" 필터 · 보관됨 · /);
  assert.match(h.items()[1]!, /대상 2명 · 검사한 연락처 5명/);
  assert.equal(h.get("segment-snapshot-usage").textContent, "고정한 대상 2/200개 · 저장한 명단 4/20,000행");
  assert.match(h.get("segment-snapshot-status").textContent, /고정한 대상 2개/);
  // Freezing needs a selected segment; viewing an archived segment's list does not.
  assert.equal(h.get("segment-snapshot-create").disabled, true);
  await h.get("segment-snapshot-list").children[1]!.children[1]!.dispatch("click");
  await settle();
  assert.equal(requests.at(-1), "/api/segment-snapshots/s1");
  assert.equal(h.get("segment-snapshot-detail").hidden, false);
  assert.equal(h.get("segment-snapshot-download").disabled, false);
});

test("selecting a segment shows its own list, and clearing the selection, as an archive does, returns to the workspace list", async () => {
  const requests: string[] = [];
  const h = harness(async (path) => {
    requests.push(path);
    if (path === "/api/segment-snapshots") return workspaceList;
    if (path === `/api/contact-segments/${segmentA.id}/snapshots`) return { snapshots: [summary("s2", "VIP")] };
    throw new Error(`unexpected ${path}`);
  });
  h.controller.configure("owner", "UTC");
  await settle();
  h.controller.sync(segmentA, false);
  assert.equal(h.get("segment-snapshot-usage").textContent, "");
  await settle();
  assert.equal(requests.at(-1), `/api/contact-segments/${segmentA.id}/snapshots`);
  assert.equal(h.items().length, 1);
  assert.doesNotMatch(h.items()[0]!, /필터/);
  assert.equal(h.get("segment-snapshot-usage").textContent, "");
  h.controller.sync(null, false);
  await settle();
  assert.equal(requests.at(-1), "/api/segment-snapshots");
  assert.equal(h.items().length, 2);
  assert.match(h.items()[1]!, /보관됨/);
});

test("a late workspace list never replaces the list of a segment selected after it was requested", async () => {
  let release!: (value: unknown) => void;
  const h = harness(async (path) => {
    if (path === "/api/segment-snapshots") return new Promise((resolve) => (release = resolve));
    return { snapshots: [summary("s2", "VIP")] };
  });
  h.controller.configure("admin", "UTC");
  h.controller.sync(segmentA, false);
  await settle();
  release(workspaceList);
  await settle();
  assert.equal(h.items().length, 1);
  assert.doesNotMatch(h.items()[0]!, /필터/);
  assert.equal(h.get("segment-snapshot-usage").textContent, "");
  // A session reset clears the list and hides the section.
  h.controller.reset();
  assert.equal(h.items().length, 0);
  assert.equal(h.get("segment-snapshots").hidden, true);
});

test("agents get no request; a freeze shows the usage, and a limit refusal says why and how capacity frees up", async () => {
  const requests: string[] = [];
  let refuse: string | null = null;
  const h = harness(async (path, method) => {
    requests.push(`${method ?? "GET"} ${path}`);
    if (method === "POST") {
      if (refuse) throw Object.assign(new Error("refused"), { code: refuse });
      return summary("s3", "VIP");
    }
    if (path === "/api/segment-snapshots") return workspaceList;
    return { snapshots: [summary("s3", "VIP")] };
  });
  h.controller.configure("agent", "UTC");
  await settle();
  assert.deepEqual(requests, []);
  assert.equal(h.get("segment-snapshots").hidden, true);
  h.controller.configure("admin", "UTC");
  h.controller.sync(segmentA, false);
  await settle();
  requests.length = 0;
  await h.get("segment-snapshot-create").dispatch("click");
  assert.deepEqual(requests.sort(), [
    "GET /api/contact-segments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/snapshots",
    "GET /api/segment-snapshots",
    "POST /api/contact-segments/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/snapshots",
  ]);
  assert.match(h.get("segment-snapshot-status").textContent, /2명을 고정했습니다/);
  assert.equal(h.get("segment-snapshot-usage").textContent, "고정한 대상 2/200개 · 저장한 명단 4/20,000행");
  refuse = "snapshot_members_limit_reached";
  await h.get("segment-snapshot-create").dispatch("click");
  const message = h.get("segment-snapshot-status").textContent;
  assert.match(message, /20,000행/);
  assert.match(message, /데이터 내보내기/);
  assert.match(message, /계정·이용자·작업 공간 데이터를 삭제할 때만 지워집니다/);
  assert.equal(h.get("segment-snapshot-usage").textContent, "고정한 대상 2/200개 · 저장한 명단 4/20,000행");
  // Connection and person deletion remove member rows only, so the snapshot count frees up only with the workspace.
  refuse = "snapshot_limit_reached";
  await h.get("segment-snapshot-create").dispatch("click");
  const countMessage = h.get("segment-snapshot-status").textContent;
  assert.match(countMessage, /200개/);
  assert.match(countMessage, /데이터 내보내기/);
  assert.match(countMessage, /작업 공간 데이터를 삭제할 때만 지워집니다/);
  assert.doesNotMatch(countMessage, /계정·이용자/);
});
