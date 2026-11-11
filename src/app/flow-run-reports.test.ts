import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import type { Pool } from "pg";
import { ApiError } from "./auth.ts";
import { flowRunReport } from "./flow-run-reports.ts";

const snapshot = {
  from: "2026-10-01",
  before: "2026-10-02",
  time_zone: "Factory",
  connection_id: null,
  flow_id: null,
  group_by: null,
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
  reply_counts: {
    absent: "3",
    pending: "1",
    sending: "1",
    sent: "1",
    read: "1",
    read_unavailable: "0",
    blocked: "1",
    failed: "1",
    unknown: "1",
  },
  reply_wait_counts: { reached: "2", replied: "1", not_replied: "1" },
};
const connectionKey = "55555555-5555-4555-8555-555555555555";
const unlistedKey = "77777777-7777-4777-8777-777777777777";
const groupCounts = (total: string, replied: string) => ({
  run_counts: { ...snapshot.run_counts, total, delivering: String(Number(total) - 6) },
  reply_counts: { ...snapshot.reply_counts, absent: String(Number(total) - 6) },
  reply_wait_counts: { reached: replied, replied, not_replied: "0" },
});
const grouped = {
  ...snapshot,
  group_by: "connection",
  groups: [
    { key: connectionKey, ...groupCounts("7", "1") },
    { key: unlistedKey, ...groupCounts("2", "0") },
  ],
};

// The handler with a pool that answers the membership read and returns `row` for the report statement.
async function serverReport(query: string, row: Record<string, unknown> = {}) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      statements.push({ sql, values });
      if (sql.startsWith("SELECT workspace_id,role")) return { rows: [{ workspace_id: "w", role: "owner" }] };
      return {
        rows: [
          {
            time_zone: "Asia/Seoul",
            period_from: new Date("2026-09-30T15:00:00Z"),
            period_before: new Date("2026-10-01T15:00:00Z"),
            checked_at: new Date("2026-10-16T12:00:00Z"),
            connection_exists: true,
            flow_exists: true,
            run_counts: snapshot.run_counts,
            reply_counts: snapshot.reply_counts,
            reply_wait_counts: snapshot.reply_wait_counts,
            groups: null,
            ...row,
          },
        ],
      };
    },
  } as unknown as Pool;
  const body = await flowRunReport(pool, { id: "u", email: "u@example.test" }, new URLSearchParams(`from=2026-10-01&before=2026-10-02&expected_time_zone=Asia%2FSeoul${query}`));
  return { body, statements };
}

test("flow report accepts each breakdown, rejects any other or repeated one and adds groups only when asked", async () => {
  const plain = await serverReport("");
  assert.equal(plain.body.group_by, null);
  assert.equal("groups" in plain.body, false);
  assert.deepEqual(plain.body.reply_wait_counts, snapshot.reply_wait_counts);
  assert.equal(plain.statements.at(-1)!.values[7], null);
  for (const dimension of ["day", "connection", "flow"]) {
    const { body, statements } = await serverReport(`&group_by=${dimension}`, { groups: [] });
    assert.equal(body.group_by, dimension);
    assert.deepEqual(body.groups, []);
    assert.equal(statements.at(-1)!.values[7], dimension);
  }
  for (const query of ["&group_by=", "&group_by=week", "&group_by=Day", "&group_by=day&group_by=day", "&group_by=day&group_by=flow"])
    await assert.rejects(serverReport(query), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.equal(error.message, "invalid_report_query");
      return true;
    });
});

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
    attributes: Map<string, string>;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  }
  const element = (text = "", value = ""): Element => ({
    textContent: text,
    value,
    disabled: false,
    hidden: false,
    children: [] as ReturnType<typeof element>[],
    listeners: new Map<string, Listener>(),
    attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    removeAttribute(name: string) {
      this.attributes.delete(name);
    },
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
  const inputs = {
    from: element(),
    before: element(),
    connection_id: element(),
    flow_id: element(),
    group_by: element(),
  };
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
    document: { getElementById: (id: string) => (id === "flow-report-form" ? form : get(id)), body: element() },
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
  vm.runInContext(readFileSync(new URL("../../public/app/send-status-labels.js", import.meta.url), "utf8"), context);
  vm.runInContext(readFileSync(new URL("../../public/app/flow-run-reports.js", import.meta.url), "utf8"), context);
  const controller = context.createFlowRunReports({ api, node: (_tag: string, text = "") => element(text) });
  return { controller, form, inputs, get, blob: () => blob };
}

test("flow report renders separate partitions and exports only the displayed snapshot with Intl fallback", async () => {
  const requests: string[] = [];
  const h = harness(async (url) => {
    requests.push(url);
    return url === "/api/flows" ? { flows: [{ id: "88888888-8888-4888-8888-888888888888", name: "=SECRET-FLOW" }] } : snapshot;
  });
  await h.controller.configure("admin", "Factory", [{ id: "55555555-5555-4555-8555-555555555555", username: "=SECRET-ACCOUNT" }]);
  assert.equal(h.get("flow-reports-section").hidden, false);
  assert.equal(h.inputs.from.value, "");
  assert.match(h.get("flow-report-zone").textContent, /직접 입력/);
  h.inputs.from.value = "2026-10-01";
  h.inputs.before.value = "2026-10-02";
  await h.form.dispatch("submit");
  assert.equal(h.get("flow-report-run-counts").children.length, 8);
  assert.equal(h.get("flow-report-reply-counts").children.length, 9);
  // The read counts sit beside the accepted count they are subsets of.
  assert.deepEqual(
    h
      .get("flow-report-reply-counts")
      .children.slice(3, 6)
      .map((item) => item.children[0]!.textContent),
    ["Meta 접수", "읽음 확인", "읽음 확인 불가"],
  );
  assert.deepEqual(
    h.get("flow-report-wait-counts").children.map((item) => item.children.map((part) => part.textContent)),
    [
      ["답장 대기 도달", "2"],
      ["답장 받음", "1"],
      ["답장 없음", "1"],
    ],
  );
  assert.equal(h.get("flow-report-groups").children.length, 0);
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
  assert.equal(rows.length, 21);
  assert.ok(rows.slice(1).every((row) => row[11] === "" && row[12] === ""));
  for (const [group, values] of [
    ["run", snapshot.run_counts],
    ["reply", snapshot.reply_counts],
    ["reply_wait", snapshot.reply_wait_counts],
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

test("flow report renders a breakdown table with loaded labels and exports group rows without names", async () => {
  const requests: string[] = [];
  const h = harness(async (url) => {
    requests.push(url);
    return url === "/api/flows" ? { flows: [] } : grouped;
  });
  await h.controller.configure("admin", "Asia/Seoul", [{ id: connectionKey, username: "=SECRET-ACCOUNT" }]);
  h.inputs.from.value = "2026-10-01";
  h.inputs.before.value = "2026-10-02";
  h.inputs.group_by.value = "connection";
  await h.form.dispatch("submit");
  assert.match(requests.at(-1)!, /group_by=connection/);
  assert.match(h.get("flow-report-summary").textContent, /계정별/);
  const [table] = h.get("flow-report-groups").children;
  const [caption, thead, tbody] = table!.children;
  assert.match(caption!.textContent, /계정별/);
  // Safari never focuses a scroller by itself, so the table's container is a named tab stop.
  assert.deepEqual(Object.fromEntries(h.get("flow-report-groups").attributes), {
    role: "region",
    tabindex: "0",
    "aria-label": `${caption!.textContent} 표`,
  });
  // The first header row names each area over its columns, so '응답 대기' and '답장 대기 도달' stay apart.
  const [areaRow, metricRow] = thead!.children;
  const areas = areaRow!.children as unknown as { textContent: string; colSpan?: number; rowSpan?: number }[];
  assert.deepEqual(
    areas.map((cell) => [cell.textContent, cell.colSpan ?? cell.rowSpan]),
    [
      ["계정", 2],
      ["실행 상태", 8],
      ["첫 답장 상태", 9],
      ["받는이 답장", 3],
    ],
  );
  const header = metricRow!.children.map((cell) => cell.textContent);
  assert.equal(header.length, 20);
  assert.equal(header[0], "실행 합계");
  assert.equal(header[6], "응답 대기");
  assert.deepEqual(header.slice(-3), ["답장 대기 도달", "답장 받음", "답장 없음"]);
  const rows = tbody!.children.map((row) => row.children.map((cell) => cell.textContent));
  // A listed account shows its name on screen; one the lists do not hold falls back to a short ID.
  assert.deepEqual(
    rows.map((row) => [row[0], row[1], row.at(-2)]),
    [
      ["@=SECRET-ACCOUNT", "7", "1"],
      ["77777777…", "2", "0"],
    ],
  );

  await h.get("flow-report-download").dispatch("click");
  const csv = await h.blob()!.text();
  assert.equal(csv.includes("SECRET"), false);
  const lines = csv
    .trim()
    .split("\r\n")
    .map((line) => line.replace(/^"|"$/g, "").split('","'));
  assert.deepEqual(lines[0]!.slice(-2), ["group_by", "group_key"]);
  assert.equal(lines.length, 1 + 20 * 3);
  for (const group of grouped.groups) {
    const own = lines.filter((line) => line[12] === group.key);
    assert.equal(own.length, 20);
    assert.ok(own.every((line) => line[11] === "connection"));
    assert.equal(own.find((line) => line[0] === "run" && line[1] === "total")![2], group.run_counts.total);
    assert.equal(own.find((line) => line[0] === "reply_wait" && line[1] === "replied")![2], group.reply_wait_counts.replied);
  }
  assert.equal(lines.filter((line) => line[12] === "" && line[11] === "").length, 20);

  // Changing the breakdown clears the table and the CSV like any other input.
  h.inputs.group_by.value = "day";
  await h.form.dispatch("change");
  assert.equal(h.get("flow-report-groups").children.length, 0);
  assert.equal(h.get("flow-report-groups").attributes.size, 0);
  assert.equal(h.get("flow-report-wait-counts").children.length, 0);
  assert.equal(h.get("flow-report-download").disabled, true);
});

test("flow report shows an empty breakdown and never lets a late grouped response overwrite newer input", async () => {
  let reports = 0;
  const h = harness(async (url) => (url === "/api/flows" ? { flows: [] } : { ...grouped, group_by: "day", groups: reports++ === 0 ? grouped.groups : [] }));
  await h.controller.configure("owner", "Asia/Seoul", []);
  h.inputs.group_by.value = "day";
  await h.form.dispatch("submit");
  assert.equal(h.get("flow-report-groups").attributes.get("tabindex"), "0");
  // A later empty cohort leaves only a hint, so the container stops being a tab stop.
  await h.form.dispatch("submit");
  assert.match(h.get("flow-report-groups").children[0]!.textContent, /실행이 없습니다/);
  assert.equal(h.get("flow-report-groups").attributes.size, 0);

  let resolveReport!: (value: unknown) => void;
  const late = harness(async (url) =>
    url === "/api/flows"
      ? { flows: [] }
      : new Promise((resolve) => {
          resolveReport = resolve;
        }),
  );
  await late.controller.configure("owner", "Asia/Seoul", [{ id: connectionKey, username: "shop" }]);
  late.inputs.group_by.value = "connection";
  const pending = late.form.dispatch("submit");
  late.inputs.group_by.value = "flow";
  await late.form.dispatch("change");
  resolveReport(grouped);
  await pending;
  assert.equal(late.get("flow-report-groups").children.length, 0);
  assert.equal(late.get("flow-report-download").disabled, true);
  late.controller.reset();
  assert.equal(late.inputs.group_by.value, "");
});

test("flow report defaults to the last seven days of the workspace calendar, not the browser's", async () => {
  // The browser (UTC) date is 2026-03-01 in both cases: at 03:00Z Los Angeles is still on 2026-02-28, and at 12:00Z
  // Kiritimati (UTC+14) is already on 2026-03-02.
  const cases = [
    ["2026-03-01T03:00:00Z", "America/Los_Angeles", "2026-02-22", "2026-03-01"],
    ["2026-03-01T12:00:00Z", "Pacific/Kiritimati", "2026-02-24", "2026-03-03"],
  ] as const;
  for (const [clock, zone, from, before] of cases) {
    const h = harness(async () => ({ flows: [] }), clock);
    await h.controller.configure("owner", zone, []);
    assert.equal(h.inputs.from.value, from, zone);
    assert.equal(h.inputs.before.value, before, zone);
    assert.doesNotMatch(h.get("flow-report-zone").textContent, /직접 입력/);
  }
});
