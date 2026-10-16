import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const snapshot = {
  from: "2026-10-01",
  before: "2026-10-02",
  time_zone: "Factory",
  connection_id: null,
  flow_id: null,
  period_from: "2026-10-01T00:00:00.000Z",
  period_before: "2026-10-02T00:00:00.000Z",
  checked_at: "2026-10-16T12:00:00.000Z",
  run_counts: {
    total: "9",
    delivering: "3",
    ended: "1",
    skipped: "1",
    failed: "1",
    waiting: "1",
    awaiting_reply: "1",
    cancelled: "1",
  },
  reply_counts: { absent: "3", pending: "1", sending: "1", sent: "1", blocked: "1", failed: "1", unknown: "1" },
};

function harness(api: (url: string) => Promise<unknown>) {
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
  const inputs = { from: element(), before: element(), connection_id: element(), flow_id: element() };
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
    override toLocaleString(): string {
      throw new RangeError("Invalid time zone");
    }
  }
  const context = vm.createContext({
    document: { getElementById: (id: string) => (id === "flow-report-form" ? form : get(id)), body: element() },
    Option: function (label: string, value: string) {
      return element(label, value);
    },
    Date: UnsupportedDate,
    Intl: {
      DateTimeFormat: class {
        constructor() {
          throw new RangeError("Invalid time zone");
        }
      },
    },
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
  vm.runInContext(readFileSync(new URL("../../public/app/flow-run-reports.js", import.meta.url), "utf8"), context);
  const controller = context.createFlowRunReports({ api, node: (_tag: string, text = "") => element(text) });
  return { controller, form, inputs, get, blob: () => blob };
}

test("flow report renders separate partitions and exports only the displayed snapshot with Intl fallback", async () => {
  const requests: string[] = [];
  const h = harness(async (url) => {
    requests.push(url);
    return url === "/api/flows"
      ? { flows: [{ id: "88888888-8888-4888-8888-888888888888", name: "=SECRET-FLOW" }] }
      : snapshot;
  });
  await h.controller.configure("admin", "Factory", [
    { id: "55555555-5555-4555-8555-555555555555", username: "=SECRET-ACCOUNT" },
  ]);
  assert.equal(h.get("flow-reports-section").hidden, false);
  assert.equal(h.inputs.from.value, "");
  assert.match(h.get("flow-report-zone").textContent, /직접 입력/);
  h.inputs.from.value = "2026-10-01";
  h.inputs.before.value = "2026-10-02";
  await h.form.dispatch("submit");
  assert.equal(h.get("flow-report-run-counts").children.length, 8);
  assert.equal(h.get("flow-report-reply-counts").children.length, 7);
  assert.equal(h.get("flow-report-run-counts").children[0]!.children[1]!.textContent, "9");
  assert.match(h.get("flow-report-summary").textContent, /2026-10-16T12:00:00.000Z \(UTC\)/);
  const beforeDownload = requests.length;
  await h.get("flow-report-download").dispatch("click");
  assert.equal(requests.length, beforeDownload);
  const csv = await h.blob()!.text();
  assert.equal(csv.includes("SECRET"), false);
  const rows = csv
    .trim()
    .split("\r\n")
    .map((line) => line.replace(/^"|"$/g, "").split('\",\"'));
  assert.equal(rows.length, 16);
  for (const [group, values] of [
    ["run", snapshot.run_counts],
    ["reply", snapshot.reply_counts],
  ] as const)
    for (const [metric, count] of Object.entries(values)) {
      const row = rows.find((row) => row[0] === group && row[1] === metric);
      assert.equal(row?.[2], count, `${group}/${metric}`);
      assert.equal(row?.[3], snapshot.from);
      assert.equal(row?.[4], snapshot.before);
      assert.equal(row?.[8], snapshot.checked_at);
    }
});

test("flow report clears results on edits and ignores late report and flow-list responses after reset", async () => {
  let resolveReport!: (value: unknown) => void;
  const h = harness(async (url) =>
    url === "/api/flows"
      ? { flows: [] }
      : new Promise((resolve) => {
          resolveReport = resolve;
        }),
  );
  await h.controller.configure("owner", "Asia/Seoul", []);
  const pending = h.form.dispatch("submit");
  await h.form.dispatch("input");
  resolveReport(snapshot);
  await pending;
  assert.equal(h.get("flow-report-run-counts").children.length, 0);
  assert.equal(h.get("flow-report-download").disabled, true);

  let resolveFlows!: (value: unknown) => void;
  const late = harness(
    async () =>
      new Promise((resolve) => {
        resolveFlows = resolve;
      }),
  );
  const configuring = late.controller.configure("owner", "Asia/Seoul", []);
  late.controller.reset();
  resolveFlows({ flows: [{ id: "88888888-8888-4888-8888-888888888888", name: "late" }] });
  await configuring;
  assert.equal(late.get("flow-reports-section").hidden, true);
  assert.equal(late.inputs.flow_id.children.length, 1);
  assert.equal(late.get("flow-report-download").disabled, true);
  await late.controller.configure("agent", "Asia/Seoul", []);
  assert.equal(late.get("flow-reports-section").hidden, true);
});
