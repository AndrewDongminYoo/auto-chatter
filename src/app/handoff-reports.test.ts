import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const snapshot = {
  from: "2026-10-01",
  before: "2026-10-02",
  time_zone: "Factory",
  connection_id: null,
  period_from: "2026-10-01T00:00:00.000Z",
  period_before: "2026-10-02T00:00:00.000Z",
  checked_at: "2026-10-16T14:00:00.000Z",
  counts: { total: "4", started: "2", cleared: "2", conversations: "2" },
};
// With `clock`, `new Date()` reads that instant and the real Intl formats the workspace zone; without it, every zone
// is unsupported so the manual-date fallback runs.
function harness(api: (url: string) => Promise<unknown>, clock?: string) {
  type Listener = (event: { preventDefault(): void }) => unknown;
  interface Element {
    textContent: string;
    value: string;
    disabled: boolean;
    hidden: boolean;
    children: Element[];
    listeners: Map<string, Listener>;
    selectedOptions: Element[];
    append(...items: Element[]): void;
    replaceChildren(...items: Element[]): void;
    addEventListener(name: string, callback: Listener): void;
    dispatch(name: string): Promise<void>;
    click(): void;
    remove(): void;
    href: string;
    download: string;
  }
  const element = (text = "", value = ""): Element => ({
    textContent: text,
    value,
    disabled: false,
    hidden: false,
    children: [] as ReturnType<typeof element>[],
    listeners: new Map<string, Listener>(),
    append(...items: ReturnType<typeof element>[]) {
      this.children.push(...items);
    },
    replaceChildren(...items: ReturnType<typeof element>[]) {
      this.children = items;
    },
    addEventListener(name: string, callback: Listener) {
      this.listeners.set(name, callback);
    },
    async dispatch(name: string) {
      await this.listeners.get(name)?.({ preventDefault() {} });
    },
    get selectedOptions() {
      return this.children.filter((item) => item.value === this.value).slice(0, 1);
    },
    click() {},
    remove() {},
    href: "",
    download: "",
  });
  const nodes = new Map<string, ReturnType<typeof element>>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id)!;
  };
  const inputs = { from: element(), before: element(), connection_id: element() };
  const submit = element();
  const form = {
    ...element(),
    elements: inputs,
    querySelector: () => submit,
    reportValidity: () => true,
    reset() {
      for (const input of Object.values(inputs)) input.value = "";
    },
  };
  let blob: Blob | undefined;
  class UnsupportedDate extends Date {
    constructor(value?: string | number | Date) {
      if (value === undefined) super(clock ?? Date.now());
      else super(value);
    }
    override toLocaleString(): string {
      throw new RangeError("Invalid time zone");
    }
  }
  const context = vm.createContext({
    document: { getElementById: (id: string) => (id === "handoff-report-form" ? form : get(id)), body: element() },
    Option: function (label: string, value: string) {
      return element(label, value);
    },
    Date: UnsupportedDate,
    Intl:
      clock === undefined
        ? {
            DateTimeFormat: class {
              constructor() {
                throw new RangeError("Invalid time zone");
              }
            },
          }
        : Intl,
    URLSearchParams,
    Blob,
    URL: {
      createObjectURL(value: Blob) {
        blob = value;
        return "blob:test";
      },
      revokeObjectURL() {},
    },
    setTimeout() {},
  });
  vm.runInContext(readFileSync(new URL("../../public/app/handoff-reports.js", import.meta.url), "utf8"), context);
  const controller = context.createHandoffReports({ api, node: (_tag: string, text = "") => element(text) });
  return { controller, form, inputs, get, blob: () => blob };
}

test("handoff report shows event metrics and exports the displayed snapshot with unsupported Intl fallback", async () => {
  const requests: string[] = [];
  const h = harness(async (url) => {
    requests.push(url);
    return snapshot;
  });
  h.controller.configure("admin", "Factory", [{ id: "55555555-5555-4555-8555-555555555555", username: "=SECRET-ACCOUNT" }]);
  assert.equal(h.get("handoff-reports-section").hidden, false);
  assert.match(h.get("handoff-report-zone").textContent, /직접 입력/);
  assert.equal(h.inputs.from.value, "");
  h.inputs.from.value = "2026-10-01";
  h.inputs.before.value = "2026-10-02";
  await h.form.dispatch("submit");
  assert.equal(h.get("handoff-report-counts").children.length, 4);
  assert.deepEqual(
    h.get("handoff-report-counts").children.map((x) => x.children[1]!.textContent),
    ["4", "2", "2", "2"],
  );
  assert.match(h.get("handoff-report-summary").textContent, /2026-10-16T14:00:00.000Z \(UTC\)/);
  assert.equal(h.get("handoff-report-download").disabled, false);
  await h.get("handoff-report-download").dispatch("click");
  const bytes = new Uint8Array(await h.blob()!.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [239, 187, 191]);
  const csv = await h.blob()!.text();
  assert.equal(requests.length, 1);
  assert.match(requests[0]!, /^\/api\/reports\/handoffs\?/);
  assert.equal(csv.trim().split("\r\n").length, 5);
  assert.match(csv, /"cleared","2"/);
  assert.equal(csv.includes("SECRET"), false);
});

test("handoff report ignores late responses after input and session changes and denies agents", async () => {
  let resolveReport!: (value: unknown) => void;
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return new Promise((resolve) => (resolveReport = resolve));
  });
  h.controller.configure("owner", "Asia/Seoul", []);
  h.inputs.from.value = "2026-10-01";
  h.inputs.before.value = "2026-10-02";
  const first = h.form.dispatch("submit");
  await h.form.dispatch("input");
  resolveReport(snapshot);
  await first;
  assert.equal(h.get("handoff-report-counts").children.length, 0);
  assert.equal(h.get("handoff-report-download").disabled, true);
  const second = h.form.dispatch("submit");
  h.controller.reset();
  resolveReport(snapshot);
  await second;
  assert.equal(h.get("handoff-reports-section").hidden, true);
  assert.equal(h.get("handoff-report-counts").children.length, 0);
  assert.equal(h.get("handoff-report-download").disabled, true);
  h.controller.configure("agent", "Asia/Seoul", []);
  await h.form.dispatch("submit");
  assert.equal(calls, 2);
  assert.equal(h.get("handoff-reports-section").hidden, true);
});

test("handoff report defaults to the last seven days of the workspace calendar, not the browser's", () => {
  // The browser (UTC) date is 2026-03-01 in both cases: at 03:00Z Los Angeles is still on 2026-02-28, and at 12:00Z
  // Kiritimati (UTC+14) is already on 2026-03-02.
  const cases = [
    ["2026-03-01T03:00:00Z", "America/Los_Angeles", "2026-02-22", "2026-03-01"],
    ["2026-03-01T12:00:00Z", "Pacific/Kiritimati", "2026-02-24", "2026-03-03"],
  ] as const;
  for (const [clock, zone, from, before] of cases) {
    const h = harness(async () => snapshot, clock);
    h.controller.configure("owner", zone, []);
    assert.equal(h.inputs.from.value, from, zone);
    assert.equal(h.inputs.before.value, before, zone);
    assert.doesNotMatch(h.get("handoff-report-zone").textContent, /직접 입력/);
  }
});
