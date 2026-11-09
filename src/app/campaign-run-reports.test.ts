import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { ApiError } from "./auth.ts";
import { parseCampaignRunReportQuery } from "./campaign-run-reports.ts";

const draft = "88888888-8888-4888-8888-888888888888";
const snapshot = {
  from: "2026-10-01",
  before: "2026-10-02",
  time_zone: "Factory",
  draft_id: null,
  period_from: "2026-10-01T00:00:00.000Z",
  period_before: "2026-10-02T00:00:00.000Z",
  checked_at: "2026-11-09T12:00:00.000Z",
  run_counts: { total: "4", running: "1", cancelled: "1", completed: "1", limit_not_started: "1" },
  start_counts: {
    original_member_count: "20",
    remaining_member_count: "18",
    connection_unavailable: "1",
    contact_paused: "1",
    no_dm_identity: "1",
    opted_out: "1",
    marketing_consent_required: "1",
    reply_window_closed: "1",
    candidate: "9",
    plan_limit_exceeded: "3",
  },
  delivery_counts: {
    total: "8",
    pending: "1",
    sending: "1",
    sent: "2",
    failed: "1",
    blocked: "1",
    unknown: "1",
    cancelled: "1",
  },
};

function rejects(query: string) {
  assert.throws(
    () => parseCampaignRunReportQuery(new URLSearchParams(query)),
    (error: unknown) => error instanceof ApiError && error.status === 400 && error.message === "invalid_report_query",
    query,
  );
}

test("campaign report query accepts exactly the known keys, a 1-366 day period, a zone and an optional draft UUID", () => {
  const base = "from=2026-10-01&before=2026-10-02&expected_time_zone=Asia%2FSeoul";
  assert.deepEqual(parseCampaignRunReportQuery(new URLSearchParams(base)), {
    from: "2026-10-01",
    before: "2026-10-02",
    zone: "Asia/Seoul",
    draft: null,
  });
  assert.equal(parseCampaignRunReportQuery(new URLSearchParams(`${base}&draft_id=${draft}`)).draft, draft);
  assert.equal(
    parseCampaignRunReportQuery(new URLSearchParams("from=2025-10-01&before=2026-10-02&expected_time_zone=UTC")).from,
    "2025-10-01",
    "366 days is allowed",
  );
  for (const query of [
    "",
    `${base}&extra=1`,
    `${base}&from=2026-10-01`,
    `${base}&draft_id=${draft}&draft_id=${draft}`,
    `${base}&connection_id=${draft}`,
    `${base}&draft_id=bad`,
    `${base}&draft_id=`,
    base.replace("2026-10-01", "2026-02-30"),
    base.replace("2026-10-01", "2026-10-1"),
    base.replace("2026-10-01", "0999-10-01"),
    base.replace("2026-10-02", "2026-10-01"),
    base.replace("2026-10-02", "2026-09-30"),
    "from=2025-09-30&before=2026-10-02&expected_time_zone=UTC",
    base.replace("&expected_time_zone=Asia%2FSeoul", ""),
    base.replace("Asia%2FSeoul", ""),
    base.replace("Asia%2FSeoul", "x".repeat(101)),
  ])
    rejects(query);
});

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
    children: [] as Element[],
    listeners: new Map<string, Listener>(),
    append(...items: Element[]) {
      this.children.push(...items);
    },
    replaceChildren(...items: Element[]) {
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
  const nodes = new Map<string, Element>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id)!;
  };
  const inputs = { from: element(), before: element(), draft_id: element() };
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
    document: { getElementById: (id: string) => (id === "campaign-report-form" ? form : get(id)), body: element() },
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
    BigInt,
    URL: {
      createObjectURL(value: Blob) {
        blob = value;
        return "blob:test";
      },
      revokeObjectURL() {},
    },
    setTimeout() {},
  });
  vm.runInContext(readFileSync(new URL("../../public/app/campaign-run-reports.js", import.meta.url), "utf8"), context);
  const controller = context.createCampaignRunReports({ api, node: (_tag: string, text = "") => element(text) });
  return { controller, form, inputs, get, blob: () => blob };
}

test("campaign report renders three partitions with run-screen labels and exports only the displayed snapshot", async () => {
  const requests: string[] = [];
  const h = harness(async (url) => {
    requests.push(url);
    return url === "/api/campaign-drafts"
      ? {
          drafts: [
            { id: draft, name: "=SECRET-CAMPAIGN", archived: false },
            { id: "99999999-9999-4999-8999-999999999999", name: "SECRET-ARCHIVED", archived: true },
          ],
        }
      : snapshot;
  });
  await h.controller.configure("admin", "Factory");
  assert.equal(h.get("campaign-reports-section").hidden, false);
  assert.equal(h.inputs.from.value, "");
  assert.match(h.get("campaign-report-zone").textContent, /직접 입력/);
  // The picker lists non-archived drafts only after "all campaigns", which includes archived ones.
  assert.deepEqual(
    h.inputs.draft_id.children.map((item) => item.value),
    ["", draft],
  );
  assert.match(h.inputs.draft_id.children[0]!.textContent, /보관 포함/);
  assert.equal(h.inputs.draft_id.disabled, false);
  h.inputs.from.value = "2026-10-01";
  h.inputs.before.value = "2026-10-02";
  h.inputs.draft_id.value = draft;
  await h.form.dispatch("submit");
  assert.equal(
    requests.at(-1),
    `/api/reports/campaign-runs?from=2026-10-01&before=2026-10-02&expected_time_zone=Factory&draft_id=${draft}`,
  );
  const runs = h.get("campaign-report-run-counts").children;
  const starts = h.get("campaign-report-start-counts").children;
  const deliveries = h.get("campaign-report-delivery-counts").children;
  assert.equal(runs.length, 5);
  assert.equal(starts.length, 10);
  assert.equal(deliveries.length, 8);
  const label = (items: typeof runs, index: number) => items[index]!.children[0]!.textContent;
  assert.equal(label(runs, 4), "시작하지 않음(월 발송 한도 초과)");
  assert.equal(label(starts, 8), "조건 통과");
  assert.equal(label(starts, 9), "월 발송 한도 초과");
  assert.equal(label(deliveries, 3), "보냄");
  assert.equal(starts[1]!.children[1]!.textContent, "18");
  assert.equal(
    starts.map((item) => item.children[0]!.textContent).some((text) => text.includes("발송 가능")),
    false,
  );
  assert.match(h.get("campaign-report-summary").textContent, /2026-11-09T12:00:00.000Z \(UTC\)/);
  const beforeDownload = requests.length;
  await h.get("campaign-report-download").dispatch("click");
  assert.equal(requests.length, beforeDownload, "the CSV uses the displayed response");
  const csv = await h.blob()!.text();
  assert.equal(csv.includes("SECRET"), false);
  const rows = csv
    .replace(/^﻿/, "")
    .trim()
    .split("\r\n")
    .map((line) => line.replace(/^"|"$/g, "").split('","'));
  assert.equal(rows.length, 24);
  assert.deepEqual(rows[0], [
    "group",
    "metric",
    "count",
    "from_date",
    "before_date_exclusive",
    "time_zone",
    "period_from_utc",
    "period_before_utc",
    "checked_at_utc",
    "draft_id",
  ]);
  for (const [group, values] of [
    ["run", snapshot.run_counts],
    ["start", snapshot.start_counts],
    ["delivery", snapshot.delivery_counts],
  ] as const)
    for (const [metric, count] of Object.entries(values)) {
      const row = rows.find((row) => row[0] === group && row[1] === metric);
      assert.equal(row?.[2], count, `${group}/${metric}`);
      assert.equal(row?.[3], snapshot.from);
      assert.equal(row?.[4], snapshot.before);
      assert.equal(row?.[5], snapshot.time_zone);
      assert.equal(row?.[8], snapshot.checked_at);
      assert.equal(row?.[9], "");
    }
  // A filter change invalidates the shown result and its CSV.
  await h.form.dispatch("change");
  assert.equal(h.get("campaign-report-run-counts").children.length, 0);
  assert.equal(h.get("campaign-report-download").disabled, true);
});

test("campaign report keeps a malformed count off screen and parses counts beyond Number precision", async () => {
  const big = { ...snapshot, delivery_counts: { ...snapshot.delivery_counts, total: "9007199254740993" } };
  const h = harness(async (url) => (url === "/api/campaign-drafts" ? { drafts: [] } : big));
  await h.controller.configure("owner", "Factory");
  await h.form.dispatch("submit");
  assert.equal(h.get("campaign-report-delivery-counts").children[0]!.children[1]!.textContent, "9,007,199,254,740,993");
  const broken = harness(async (url) =>
    url === "/api/campaign-drafts"
      ? { drafts: [] }
      : { ...snapshot, start_counts: { ...snapshot.start_counts, candidate: "1.5" } },
  );
  await broken.controller.configure("owner", "Factory");
  await broken.form.dispatch("submit");
  assert.equal(broken.get("campaign-report-run-counts").children.length, 0);
  assert.equal(broken.get("campaign-report-download").disabled, true);
});

test("campaign report clears results on edits and ignores late report and picker responses after reset", async () => {
  let resolveReport!: (value: unknown) => void;
  const h = harness(async (url) =>
    url === "/api/campaign-drafts"
      ? { drafts: [] }
      : new Promise((resolve) => {
          resolveReport = resolve;
        }),
  );
  await h.controller.configure("owner", "Asia/Seoul");
  const pending = h.form.dispatch("submit");
  await h.form.dispatch("input");
  resolveReport(snapshot);
  await pending;
  assert.equal(h.get("campaign-report-run-counts").children.length, 0);
  assert.equal(h.get("campaign-report-download").disabled, true);

  let resolveReset!: (value: unknown) => void;
  const reset = harness(async (url) =>
    url === "/api/campaign-drafts"
      ? { drafts: [] }
      : new Promise((resolve) => {
          resolveReset = resolve;
        }),
  );
  await reset.controller.configure("owner", "Asia/Seoul");
  const resetPending = reset.form.dispatch("submit");
  reset.controller.reset();
  resolveReset(snapshot);
  await resetPending;
  assert.equal(reset.get("campaign-report-run-counts").children.length, 0);
  assert.equal(reset.get("campaign-report-download").disabled, true);

  let resolveDrafts!: (value: unknown) => void;
  const late = harness(
    async () =>
      new Promise((resolve) => {
        resolveDrafts = resolve;
      }),
  );
  const configuring = late.controller.configure("owner", "Asia/Seoul");
  late.controller.reset();
  resolveDrafts({ drafts: [{ id: draft, name: "late", archived: false }] });
  await configuring;
  assert.equal(late.get("campaign-reports-section").hidden, true);
  assert.equal(late.inputs.draft_id.children.length, 1);
  assert.equal(late.get("campaign-report-download").disabled, true);
  await late.controller.configure("agent", "Asia/Seoul");
  assert.equal(late.get("campaign-reports-section").hidden, true);
});

test("the app's other-tab session signal and BFCache restoration reset every report controller", () => {
  // The controllers' reset() behavior is exercised above; this runs the app's invalidation path with spies.
  const source = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  const start = source.indexOf("const invalidateContactSession = () => {");
  const end = source.indexOf("\n};", start);
  assert.ok(start >= 0 && end > start);
  const resets: string[] = [];
  const spy = (name: string) => ({
    reset: () => {
      resets.push(name);
    },
  });
  const context = vm.createContext({
    workspaceGeneration: 0,
    contactsSaving: false,
    campaignDrafts: spy("campaignDrafts"),
    manualReports: spy("manualReports"),
    flowReports: spy("flowReports"),
    handoffReports: spy("handoffReports"),
    campaignReports: spy("campaignReports"),
    clearContactResults: () => {},
    notice: () => {},
    byId: () => ({ hidden: true }),
  });
  vm.runInContext(`${source.slice(start, end + 3)}\nglobalThis.invalidate = invalidateContactSession;`, context);
  context.invalidate();
  for (const name of ["manualReports", "flowReports", "handoffReports", "campaignReports"])
    assert.ok(resets.includes(name), `${name}.reset() must run on session invalidation`);
});
