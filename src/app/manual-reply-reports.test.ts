import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("report remains usable when the browser cannot format a server-valid time zone", async () => {
  const listeners = new Map<string, (event: { preventDefault(): void }) => Promise<void>>();
  const element = () => ({
    textContent: "",
    value: "",
    disabled: false,
    hidden: false,
    children: [] as unknown[],
    append(...items: unknown[]) {
      this.children.push(...items);
    },
    replaceChildren(...items: unknown[]) {
      this.children = items;
    },
    addEventListener() {},
    selectedOptions: [{ textContent: "모든 계정" }],
  });
  const nodes = new Map<string, ReturnType<typeof element>>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id)!;
  };
  const from = element(),
    before = element(),
    connection = element(),
    submit = element();
  const form = {
    elements: { from, before, connection_id: connection },
    querySelector: () => submit,
    reportValidity: () => true,
    reset() {
      from.value = "";
      before.value = "";
      connection.value = "";
    },
    addEventListener(name: string, callback: (event: { preventDefault(): void }) => Promise<void>) {
      listeners.set(name, callback);
    },
  };
  // Exercise an Intl engine that cannot format a PostgreSQL-accepted name; Factory is valid in our local PG.
  class UnsupportedDate extends Date {
    override toLocaleString(): string {
      throw new RangeError("Invalid time zone");
    }
  }
  const context = vm.createContext({
    document: { getElementById: (id: string) => (id === "manual-report-form" ? form : get(id)) },
    Option: class {},
    Date: UnsupportedDate,
    URLSearchParams,
    Intl: {
      DateTimeFormat: class {
        constructor() {
          throw new RangeError("Invalid time zone");
        }
      },
    },
  });
  vm.runInContext(readFileSync(new URL("../../public/app/manual-reply-reports.js", import.meta.url), "utf8"), context);
  const controller = context.createManualReplyReports({
    node: (_tag: string, text = "") => ({ ...element(), textContent: text }),
    api: async () => ({
      from: "2026-10-01",
      before: "2026-10-02",
      time_zone: "Factory",
      connection_id: null,
      period_from: "2026-10-01T00:00:00.000Z",
      period_before: "2026-10-02T00:00:00.000Z",
      checked_at: "2026-10-16T11:00:00.000Z",
      counts: {
        total: "0",
        pending: "0",
        sending: "0",
        sent: "0",
        failed: "0",
        unknown_unresolved: "0",
        unknown_resolved: "0",
        cancelled: "0",
      },
    }),
  });
  assert.doesNotThrow(() => controller.configure("owner", "Factory", []));
  assert.equal(get("manual-reports-section").hidden, false);
  assert.equal(from.value, "");
  assert.match(get("manual-report-zone").textContent, /직접 입력/);
  from.value = "2026-10-01";
  before.value = "2026-10-02";
  await listeners.get("submit")!({ preventDefault() {} });
  assert.equal(get("manual-report-counts").children.length, 8);
  assert.match(get("manual-report-summary").textContent, /2026-10-16T11:00:00.000Z \(UTC\)/);
  assert.equal(get("manual-report-download").disabled, false);
});
