import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// With `clock`, `new Date()` reads that instant and the real Intl formats the workspace zone; without it, every zone
// is unsupported so the manual-date fallback runs.
function harness(clock?: string) {
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
    constructor(value?: string | number | Date) {
      if (value === undefined) super(clock ?? Date.now());
      else super(value);
    }
    override toLocaleString(): string {
      throw new RangeError("Invalid time zone");
    }
  }
  const context = vm.createContext({
    document: { getElementById: (id: string) => (id === "manual-report-form" ? form : get(id)) },
    Option: class {},
    Date: UnsupportedDate,
    URLSearchParams,
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
        read: "0",
        read_unavailable: "0",
        failed: "0",
        unknown_unresolved: "0",
        unknown_resolved: "0",
        cancelled: "0",
      },
    }),
  });
  return { controller, listeners, get, from, before };
}

test("report remains usable when the browser cannot format a server-valid time zone", async () => {
  const { controller, listeners, get, from, before } = harness();
  assert.doesNotThrow(() => controller.configure("owner", "Factory", []));
  assert.equal(get("manual-reports-section").hidden, false);
  assert.equal(from.value, "");
  assert.match(get("manual-report-zone").textContent, /직접 입력/);
  from.value = "2026-10-01";
  before.value = "2026-10-02";
  await listeners.get("submit")!({ preventDefault() {} });
  const items = get("manual-report-counts").children as { children: { textContent: string }[] }[];
  assert.equal(items.length, 10);
  // The read counts sit beside the accepted count they are subsets of.
  assert.deepEqual(
    items.slice(3, 6).map((item) => item.children[0]!.textContent),
    ["Meta 접수", "읽음 확인", "읽음 확인 불가"],
  );
  assert.match(get("manual-report-summary").textContent, /2026-10-16T11:00:00.000Z \(UTC\)/);
  assert.equal(get("manual-report-download").disabled, false);
});

test("manual reply report defaults to the last seven days of the workspace calendar, not the browser's", () => {
  // The browser (UTC) date is 2026-03-01 in both cases: at 03:00Z Los Angeles is still on 2026-02-28, and at 12:00Z
  // Kiritimati (UTC+14) is already on 2026-03-02.
  const cases = [
    ["2026-03-01T03:00:00Z", "America/Los_Angeles", "2026-02-22", "2026-03-01"],
    ["2026-03-01T12:00:00Z", "Pacific/Kiritimati", "2026-02-24", "2026-03-03"],
  ] as const;
  for (const [clock, zone, from, before] of cases) {
    const h = harness(clock);
    h.controller.configure("owner", zone, []);
    assert.equal(h.from.value, from, zone);
    assert.equal(h.before.value, before, zone);
    assert.doesNotMatch(h.get("manual-report-zone").textContent, /직접 입력/);
  }
});
