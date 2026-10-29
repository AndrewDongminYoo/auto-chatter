import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { parseCampaignDraft } from "./campaign-drafts.ts";
const input = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  snapshot_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Draft",
  body: "Hello",
};
test("draft text counts UTF-16 units while its normalized name counts code points", () => {
  const parsed = parseCampaignDraft({ ...input, name: "😀".repeat(60), body: "😀".repeat(500) });
  assert.equal(parsed.body.length, 1000);
  assert.throws(() => parseCampaignDraft({ ...input, body: "😀".repeat(501) }), /invalid_campaign_draft/);
  assert.throws(() => parseCampaignDraft({ ...input, name: "😀".repeat(61) }), /invalid_campaign_draft/);
  assert.equal(parseCampaignDraft({ ...input, name: " e\u0301 " }).name, "é");
});
test("campaign creation and editing require disjoint exact payloads", () => {
  const { id, ...fields } = input;
  for (const bad of [
    null,
    [],
    {},
    { ...input, extra: 1 },
    { ...input, id: undefined },
    { ...input, snapshot_id: "bad" },
    { ...input, name: "bad\nname" },
  ])
    assert.throws(() => parseCampaignDraft(bad), /invalid_campaign_draft/);
  assert.throws(() => parseCampaignDraft({ ...input, expected_version: 1 }, true), /invalid_campaign_draft/);
  for (const value of [0, -1, 1.5, "1", null, 2147483647])
    assert.throws(() => parseCampaignDraft({ ...fields, expected_version: value }, true), /invalid_campaign_draft/);
  assert.equal(parseCampaignDraft({ ...fields, expected_version: 1 }, true).expected_version, 1);
  assert.equal(parseCampaignDraft({ ...input, id: id.toUpperCase() }).id, id);
});

// These tests run the shipped controller; only DOM primitives and HTTP are substituted.
class DraftElement {
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  type = "";
  children: DraftElement[] = [];
  listeners = new Map<string, (event: { preventDefault(): void }) => unknown>();
  attributes = new Map<string, string>();
  tagName: string;
  constructor(text = "", tagName = "") {
    this.textContent = text;
    this.tagName = tagName;
  }
  append(...items: DraftElement[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: DraftElement[]) {
    this.children = items;
  }
  addEventListener(name: string, callback: (event: { preventDefault(): void }) => unknown) {
    this.listeners.set(name, callback);
  }
  async dispatch(name: string) {
    await this.listeners.get(name)?.({ preventDefault() {} });
  }
  querySelectorAll(selector: string): DraftElement[] {
    return this.children.flatMap((child) => [
      ...(selector === "button" && child.type === "button" ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  // Every text node below this element, as a reader of the rendered card would meet it.
  allText(): string {
    return [this.textContent, ...this.children.map((child) => child.allText())].join(" ");
  }
  focused = false;
  focus() {
    this.focused = true;
  }
}
const savedDraft = {
  id: input.id,
  snapshot_id: input.snapshot_id,
  name: "Saved draft",
  body: "Saved message",
  version: 3,
  archived: false,
  original_member_count: 4,
  stored_member_count: 2,
  created_at: "2026-10-21T03:00:00Z",
  updated_at: "2026-10-21T03:00:00Z",
};
// The preview API's real shape; counts are decimal strings and as_of carries microseconds.
const previewResponse = {
  draft_id: input.id,
  draft_version: 3,
  snapshot_id: input.snapshot_id,
  archived: false,
  as_of: "2026-10-21T03:00:00.123456Z",
  original_member_count: "4",
  remaining_member_count: "9007199254741014",
  counts: {
    connection_unavailable: "1",
    contact_paused: "2",
    no_dm_identity: "3",
    opted_out: "4",
    marketing_consent_required: "5",
    reply_window_closed: "6",
    candidate: "9007199254740993",
  },
  candidate_meaning: "passed_recorded_conditions_at_as_of",
  sendability_claimed: false,
  estimated_provider_calls: "9007199254740993",
  plan_broadcast_limit: null as string | null,
  channel_marketing_supported: false,
  global_send_enabled: false,
};
// The approval list row shape (src/app/campaign-approvals.ts shape()): a scheduled approval stored in another zone.
const approvalId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const storedApproval = {
  id: approvalId,
  draft_id: input.id,
  draft_version: 3,
  snapshot_id: input.snapshot_id,
  name: "Saved draft",
  schedule_kind: "scheduled",
  scheduled_at: "2026-10-28T10:30:00.000000Z" as string | null,
  schedule_time_zone: "America/New_York" as string | null,
  schedule_local: "2026-10-28T06:30" as string | null,
  status: "approved",
  version: 1,
  approved_by: "user-me",
  approved_at: "2026-10-27T03:00:00.000Z",
  cancelled_by: null as string | null,
  cancelled_at: null as string | null,
  updated_at: "2026-10-27T03:00:00.000Z",
  preview: {
    as_of: "2026-10-27T03:00:00.123456Z",
    original_member_count: "4",
    remaining_member_count: "9007199254741014",
    counts: previewResponse.counts,
  },
  delivery_available: true,
  run_id: null as string | null,
  run_status: null as string | null,
};
type Approval = typeof storedApproval;
// The run API's real shape (src/app/campaign-runs.ts detail()): decimal-string counts, no recipient identifiers.
const runId = "99999999-9999-4999-8999-999999999999";
const storedRun = {
  id: runId,
  approval_id: approvalId,
  draft_id: input.id,
  draft_version: 3,
  snapshot_id: input.snapshot_id,
  started_at: "2026-10-28T10:30:00.123456Z",
  status: "running",
  version: 1,
  cancelled_by: null as string | null,
  cancelled_at: null as string | null,
  updated_at: "2026-10-28T10:30:00.123456Z",
  start: {
    as_of: "2026-10-28T10:30:00.123456Z",
    original_member_count: "4",
    remaining_member_count: "9007199254741014",
    counts: previewResponse.counts,
  },
  delivery_counts: {
    pending: "11",
    sending: "12",
    sent: "13",
    failed: "14",
    blocked: "15",
    unknown: "16",
    cancelled: "9007199254740993",
  } as Record<string, string>,
  delivery_available: true,
};
type Run = typeof storedRun;
const executedApproval: Approval = { ...storedApproval, status: "executed", run_id: runId, run_status: "running" };
type DraftApi = (path: string, method?: string, body?: Record<string, unknown>) => Promise<unknown>;
function draftHarness(override?: DraftApi, initialApprovals: Approval[] = []) {
  const nodes = new Map<string, DraftElement>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new DraftElement());
    return nodes.get(id)!;
  };
  const fields = { name: new DraftElement(), body: new DraftElement(), snapshot_id: new DraftElement() };
  // A native select cannot retain a value that has no option.
  let selectedSnapshot = "";
  Object.defineProperty(fields.snapshot_id, "value", {
    get: () => selectedSnapshot,
    set: (value: string) => {
      selectedSnapshot = fields.snapshot_id.children.some((option) => option.value === value) ? value : "";
    },
  });
  const form = Object.assign(get("campaign-draft-form"), {
    elements: fields,
    reportValidity: () => true,
    reset() {
      for (const field of Object.values(fields)) field.value = "";
    },
  });
  const writes: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let allowDiscard = true;
  const api: DraftApi = async (path, method = "GET", body) => {
    if (method !== "GET") writes.push({ path, method, body: structuredClone(body!) });
    if (override) {
      const result = await override(path, method, body);
      if (result !== undefined) return result;
    }
    if (path === "/api/segment-snapshots")
      return {
        snapshots: [
          {
            id: input.snapshot_id,
            segment_name: "VIP",
            segment_archived: true,
            member_count: 4,
            as_of: "2026-10-21T03:00:00Z",
          },
        ],
      };
    if (path === "/api/campaign-drafts" && method === "GET") return { drafts: [savedDraft] };
    if (path.endsWith("/preview")) return structuredClone(previewResponse);
    // A small stateful stand-in for the approval API, newest first like the server's list.
    if (path === "/api/campaign-approvals") return { approvals: structuredClone(approvals) };
    if (path.endsWith("/approvals") && method === "POST") {
      const scheduled = body!.schedule_local !== null;
      const created: Approval = {
        ...storedApproval,
        id: String(body!.id),
        draft_version: Number(body!.expected_version),
        schedule_kind: scheduled ? "scheduled" : "immediate",
        scheduled_at: scheduled ? "2026-10-28T10:30:00.000000Z" : null,
        schedule_time_zone: scheduled ? String(body!.expected_time_zone) : null,
        schedule_local: scheduled ? String(body!.schedule_local) : null,
      };
      approvals.unshift(created);
      return structuredClone(created);
    }
    const change = /^\/api\/campaign-approvals\/([^/]+)\/(schedule|cancel)$/.exec(path);
    if (change) {
      const index = approvals.findIndex((item) => item.id === change[1]);
      const next: Approval = { ...approvals[index]!, version: approvals[index]!.version + 1 };
      if (change[2] === "cancel")
        Object.assign(next, { status: "cancelled", cancelled_by: "user-other", cancelled_at: "2026-10-27T04:00:00Z" });
      else
        Object.assign(next, {
          schedule_kind: body!.schedule_local === null ? "immediate" : "scheduled",
          schedule_local: body!.schedule_local,
          schedule_time_zone: body!.schedule_local === null ? null : body!.expected_time_zone,
          scheduled_at: body!.schedule_local === null ? null : "2026-10-29T10:30:00.000000Z",
        });
      approvals[index] = next;
      return structuredClone(next);
    }
    // A small stateful stand-in for the run API: the read, and the cancel with its 409 refusals.
    const runPath = /^\/api\/campaign-runs\/([^/]+)(\/cancel)?$/.exec(path);
    if (runPath) {
      const current = runs.get(runPath[1]!);
      if (!current) throw { status: 404, code: "campaign_run_not_found" };
      if (!runPath[2]) return structuredClone(current);
      const refusal =
        current.status === "cancelled"
          ? "campaign_run_cancelled"
          : current.status === "completed"
            ? "campaign_run_completed"
            : current.version !== body!.expected_version
              ? "campaign_run_conflict"
              : null;
      if (refusal) throw { status: 409, code: refusal, run: structuredClone(current) };
      const cancelled = current.delivery_counts.pending!;
      const next: Run = {
        ...current,
        status: "cancelled",
        version: current.version + 1,
        cancelled_by: "user-me",
        cancelled_at: "2026-10-28T11:00:00.000000Z",
        delivery_counts: {
          ...current.delivery_counts,
          pending: "0",
          cancelled: String(BigInt(current.delivery_counts.cancelled!) + BigInt(cancelled)),
        },
      };
      runs.set(next.id, next);
      return { ...structuredClone(next), cancelled_delivery_count: cancelled, sending_recalled: false };
    }
    if (method === "GET") return savedDraft;
    return { ...savedDraft, ...body, version: 4, archived: path.endsWith("/archive") };
  };
  const approvals = structuredClone(initialApprovals);
  const runs = new Map<string, Run>([[runId, structuredClone(storedRun)]]);
  let uuidCount = 0;
  const context = vm.createContext({
    document: { getElementById: get },
    confirm: () => allowDiscard,
    crypto: { randomUUID: () => (uuidCount++ === 0 ? input.id : "dddddddd-dddd-4ddd-8ddd-dddddddddddd") },
  });
  const script = new URL("../../public/app/campaign-drafts.js", import.meta.url);
  vm.runInContext(existsSync(script) ? readFileSync(script, "utf8") : "", context);
  assert.equal(typeof context.createCampaignDrafts, "function", "campaign draft controller is missing");
  const requests: string[] = [];
  const controller = context.createCampaignDrafts({
    api: (path: string, method?: string, body?: Record<string, unknown>) => {
      requests.push(path);
      return api(path, method, body);
    },
    node: (tag: string, text = "") => new DraftElement(text, tag),
    userId: () => "user-me",
  });
  return {
    controller,
    get,
    fields,
    form,
    writes,
    requests,
    approvals,
    runs,
    refuseDiscard: () => {
      allowDiscard = false;
    },
  };
}
const draftSettle = () => new Promise((resolve) => setImmediate(resolve));
async function adminDraft(override?: DraftApi, approvals: Approval[] = [], zone = "Asia/Seoul") {
  const h = draftHarness(override, approvals);
  h.controller.configure("admin", "workspace-a", zone);
  await draftSettle();
  return h;
}
async function openSaved(h: Awaited<ReturnType<typeof adminDraft>>) {
  await h.get("campaign-draft-list").children[0]!.children[1]!.dispatch("click");
}
function fillNew(h: ReturnType<typeof draftHarness>) {
  h.fields.snapshot_id.value = input.snapshot_id;
  h.fields.name.value = "New draft";
  h.fields.body.value = "New message";
}

test("campaign screen hides from agents without requesting workspace data", async () => {
  let requests = 0;
  const h = draftHarness(async () => {
    requests++;
  });
  h.controller.configure("agent", "workspace-a", "UTC");
  await draftSettle();
  assert.equal(requests, 0);
  assert.equal(h.get("campaign-drafts-section").hidden, true);
});

test("campaign screen creates a plain-text draft against an archived segment snapshot without sending", async () => {
  const h = await adminDraft();
  assert.equal(h.get("campaign-drafts-section").hidden, false);
  assert.match(h.fields.snapshot_id.children[1]!.textContent, /VIP.*보관/);
  fillNew(h);
  await h.form.dispatch("submit");
  assert.deepEqual(h.writes, [
    {
      path: "/api/campaign-drafts",
      method: "POST",
      body: {
        id: input.id,
        snapshot_id: input.snapshot_id,
        name: "New draft",
        body: "New message",
      },
    },
  ]);
  assert.match(h.get("campaign-draft-summary").textContent, /원래 4명.*현재 2명/);
});

test("campaign edits use the loaded version and archive makes the detail read-only", async () => {
  const h = await adminDraft();
  await openSaved(h);
  assert.equal(
    h.get("campaign-draft-editor-title").focused,
    true,
    "opening a draft must move keyboard focus to its editor",
  );
  h.fields.body.value = "Updated message";
  await h.form.dispatch("submit");
  assert.deepEqual(h.writes[0], {
    path: `/api/campaign-drafts/${input.id}`,
    method: "PUT",
    body: {
      expected_version: 3,
      snapshot_id: input.snapshot_id,
      name: "Saved draft",
      body: "Updated message",
    },
  });
  await h.get("campaign-draft-archive").dispatch("click");
  assert.deepEqual(h.writes[1], {
    path: `/api/campaign-drafts/${input.id}/archive`,
    method: "POST",
    body: { expected_version: 4 },
  });
  assert.equal(h.fields.body.disabled, true);
  assert.equal(h.get("campaign-draft-save").disabled, true);
});

test("a lost create response locks its payload and retries the identical id and content", async () => {
  let attempts = 0;
  const h = await adminDraft(async (_path, method) => {
    if (method === "POST" && ++attempts === 1) throw new Error("network lost");
  });
  fillNew(h);
  await h.form.dispatch("submit");
  assert.equal(h.fields.body.disabled, true);
  assert.equal(h.controller.hasChanges(), true);
  assert.match(h.get("campaign-draft-status").textContent, /같은 요청/);
  // The request object stays stable even if a script changes a disabled input.
  h.fields.body.value = "Not the accepted payload";
  await h.form.dispatch("submit");
  assert.deepEqual(h.writes[1], h.writes[0]);
  assert.equal(h.fields.body.value, "New message");
});

test("a conflict preserves edits and refuses more writes until an explicit confirmed reload", async () => {
  const h = await adminDraft(async (_path, method) => {
    if (method === "PUT") throw { code: "campaign_draft_conflict", status: 409 };
  });
  await openSaved(h);
  h.fields.body.value = "Unsaved local message";
  await h.form.dispatch("submit");
  assert.equal(h.fields.body.value, "Unsaved local message");
  assert.equal(h.get("campaign-draft-save").disabled, true);
  await h.form.dispatch("submit");
  assert.equal(h.writes.length, 1, "conflicts must never automatically overwrite the newer version");
  await h.get("campaign-draft-reload").dispatch("click");
  assert.equal(h.fields.body.value, "Saved message");
});

test("discard refusal protects edits when opening another draft or starting a new one", async () => {
  const h = await adminDraft();
  await openSaved(h);
  h.fields.body.value = "Keep this";
  h.refuseDiscard();
  await h.get("campaign-draft-new").dispatch("click");
  await openSaved(h);
  assert.equal(h.fields.body.value, "Keep this");
});

test("a failed detail read clears the old message and prevents saving a stale version", async () => {
  let refuse = false;
  const h = await adminDraft(async (path, method) => {
    if (refuse && method === "GET" && path.endsWith(input.id)) throw { code: "campaign_draft_not_found", status: 404 };
  });
  await openSaved(h);
  refuse = true;
  await h.get("campaign-draft-reload").dispatch("click");
  assert.equal(h.fields.body.value, "");
  assert.equal(h.get("campaign-draft-save").disabled, true);
});

test("late detail and write responses cannot disclose a previous workspace after reset", async () => {
  let release!: (value: unknown) => void;
  const h = await adminDraft(async (path, method) => {
    if (method === "GET" && path.endsWith(input.id))
      return new Promise((resolve) => {
        release = resolve;
      });
  });
  const pending = openSaved(h);
  h.controller.reset();
  release(savedDraft);
  await pending;
  assert.equal(h.fields.body.value, "");
  assert.equal(h.get("campaign-drafts-section").hidden, true);
  h.controller.configure("admin", "workspace-a", "UTC");
  await draftSettle();
  fillNew(h);
  let finish!: (value: unknown) => void;
  // A second controller isolates the write wait from the detail wait above.
  const write = await adminDraft(async (_path, method) => {
    if (method === "POST")
      return new Promise((resolve) => {
        finish = resolve;
      });
  });
  fillNew(write);
  const saving = write.form.dispatch("submit");
  write.controller.configure("agent", "workspace-b", "UTC");
  finish(savedDraft);
  await saving;
  assert.equal(write.fields.body.value, "");
  assert.equal(write.get("campaign-drafts-section").hidden, true);
});

test("role revocation clears protected campaign data and disables writes", async () => {
  const h = await adminDraft(async (_path, method) => {
    if (method === "PUT") throw { code: "role_forbidden", status: 403 };
  });
  await openSaved(h);
  h.fields.body.value = "Edited";
  await h.form.dispatch("submit");
  assert.equal(h.get("campaign-drafts-section").hidden, true);
  assert.equal(h.fields.body.value, "");
  assert.equal(h.get("campaign-draft-list").children.length, 0);
});

test("draft capacity includes archived entries and a limit rejection preserves the text", async () => {
  const h = await adminDraft(async (_path, method) => {
    if (method === "POST") throw { code: "campaign_draft_limit_reached", status: 409 };
  });
  fillNew(h);
  await h.form.dispatch("submit");
  assert.equal(h.fields.body.value, "New message");
  assert.match(h.get("campaign-draft-status").textContent, /100개/);
  assert.match(h.get("campaign-draft-status").textContent, /보관.*한도/);
  assert.equal(h.fields.body.disabled, false);
});

test("the UI rejects unresolved template syntax and counts emoji as UTF-16 units before a write", async () => {
  const h = await adminDraft();
  fillNew(h);
  for (const invalid of ["Hello {{name}}", "😀".repeat(501), "   ", "bad\u0000text"]) {
    h.fields.body.value = invalid;
    await h.form.dispatch("submit");
  }
  assert.equal(h.writes.length, 0);
  h.fields.body.value = "😀".repeat(500);
  await h.form.dispatch("submit");
  assert.equal(h.writes.length, 1);
});

test("a draft referencing a snapshot created after the list loaded keeps that reference without a false dirty state", async () => {
  const newerSnapshot = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const h = await adminDraft(async (path, method) => {
    if (method === "GET" && path.endsWith(input.id)) return { ...savedDraft, snapshot_id: newerSnapshot };
  });
  await openSaved(h);
  assert.equal(h.fields.snapshot_id.value, newerSnapshot);
  assert.equal(h.controller.hasChanges(), false);
  h.fields.body.value = "Text-only edit";
  await h.form.dispatch("submit");
  assert.equal(h.writes[0]!.body.snapshot_id, newerSnapshot);
});

test("a rate-limited retry cannot forget the id of an earlier ambiguous create", async () => {
  let attempts = 0;
  const h = await adminDraft(async (_path, method) => {
    if (method !== "POST") return;
    attempts++;
    if (attempts === 1) throw new Error("accepted response lost");
    if (attempts === 2) throw { status: 429, code: "rate_limited" };
  });
  fillNew(h);
  await h.form.dispatch("submit");
  await h.form.dispatch("submit");
  assert.equal(h.fields.body.disabled, true, "the original acceptance is unresolved after a throttled retry");
  await h.form.dispatch("submit");
  assert.deepEqual(
    h.writes.map((write) => write.body.id),
    [input.id, input.id, input.id],
  );
  assert.equal(h.fields.body.disabled, false);
});

test("session invalidation prevents a pending workspace bootstrap from reconfiguring campaign data", async () => {
  const source = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function loadWorkspace() {");
  const end = source.indexOf("\n}\n", start);
  const invalidationStart = source.indexOf("const invalidateContactSession = () => {");
  const invalidationEnd = source.indexOf("\n};", invalidationStart);
  assert.ok(start >= 0 && end > start && invalidationStart >= 0 && invalidationEnd > invalidationStart);
  for (const pausedAt of ["/api/me", "/api/workspace"]) {
    let release!: (value: unknown) => void;
    let configurations = 0;
    const elements = new Map<string, { hidden: boolean; elements: { time_zone: { value: string } } }>();
    const noOp = () => {};
    const controller = { reset: noOp, configure: noOp };
    const context = vm.createContext({
      segmentsGeneration: 0,
      workspaceGeneration: 0,
      editingSegment: null,
      pendingInvite: null,
      currentUserId: undefined,
      currentRole: undefined,
      workspaceTimeZone: undefined,
      workspacePlan: undefined,
      contactCsvPreview: controller,
      segmentSnapshots: controller,
      manualReports: controller,
      flowReports: controller,
      handoffReports: controller,
      campaignDrafts: {
        reset: noOp,
        configure: () => {
          configurations++;
        },
      },
      segmentControls: noOp,
      invalidateContactExport: noOp,
      planControls: noOp,
      timeZoneControls: noOp,
      loadOperations: noOp,
      loadWebhooks: noOp,
      clearContactResults: noOp,
      notice: noOp,
      contactsSaving: false,
      byId: (id: string) => {
        if (!elements.has(id)) elements.set(id, { hidden: false, elements: { time_zone: { value: "" } } });
        return elements.get(id)!;
      },
      api: async (path: string) => {
        if (path === pausedAt)
          return new Promise((resolve) => {
            release = resolve;
          });
        if (path === "/api/me") return { user: { id: "old-user" } };
        if (path === "/api/workspace") return { role: "admin", workspace_id: "old-workspace", time_zone: "UTC" };
        // The unwanted configure sink occurs before these unrelated later reads.
        throw new Error("fixture stops after campaign configuration");
      },
    });
    vm.runInContext(
      source.slice(start, end + 3) +
        "\n" +
        source.slice(invalidationStart, invalidationEnd + 3) +
        "\nglobalThis.invalidate = invalidateContactSession;",
      context,
    );
    const pending = context.loadWorkspace().catch((error: Error) => {
      if (error.message !== "fixture stops after campaign configuration") throw error;
    });
    await draftSettle();
    context.invalidate();
    release(
      pausedAt === "/api/me"
        ? { user: { id: "old-user" } }
        : { role: "admin", workspace_id: "old-workspace", time_zone: "UTC" },
    );
    await pending;
    assert.equal(configurations, 0, `${pausedAt} response from before invalidation must not restore campaign data`);
  }
});

// Preview UI (#35 follow-up): an explicit read that never claims anyone can be sent to.
const previewIds = [
  "campaign-draft-preview",
  "campaign-draft-preview-warnings",
  "campaign-draft-preview-status",
  "campaign-draft-preview-summary",
  "campaign-draft-preview-rows",
];
const previewText = (h: ReturnType<typeof draftHarness>) =>
  previewIds.map((id) => h.get(id).allText()).join(" ") + h.get("campaign-draft-preview-run").textContent;
const previewRequests = (h: ReturnType<typeof draftHarness>) =>
  h.requests.filter((path) => path.endsWith("/preview")).length;
const runPreview = (h: ReturnType<typeof draftHarness>) => h.get("campaign-draft-preview-run").dispatch("click");
const rendered = (h: ReturnType<typeof draftHarness>) =>
  !h.get("campaign-draft-preview-result").hidden && h.get("campaign-draft-preview-rows").children.length > 0;

test("the preview is fetched only by its button, once per click, and renders warnings, reasons and decimal counts", async () => {
  const h = await adminDraft();
  assert.equal(h.get("campaign-draft-preview").hidden, true, "a new draft has no stored conditions to preview");
  await openSaved(h);
  assert.equal(h.get("campaign-draft-preview").hidden, false);
  assert.equal(previewRequests(h), 0, "opening a draft must not fetch the preview");
  await runPreview(h);
  assert.deepEqual(
    h.requests.filter((path) => path.endsWith("/preview")),
    [`/api/campaign-drafts/${input.id}/preview`],
  );
  assert.deepEqual(
    h.get("campaign-draft-preview-warnings").children.map((child) => child.textContent),
    ["Instagram 마케팅 발송은 아직 지원하지 않습니다.", "서비스 전체 발송이 꺼져 있습니다."],
  );
  const rows = h.get("campaign-draft-preview-rows").children;
  assert.deepEqual(
    rows.map((row) => row.children.map((cell) => [cell.tagName, cell.textContent])),
    [
      ["연결 발송 불가", "1"],
      ["자동화 중지", "2"],
      ["확인된 DM 대화 없음", "3"],
      ["수신 거부", "4"],
      ["마케팅 동의 없음", "5"],
      ["24시간 응답 창 닫힘", "6"],
      ["조건 통과", "9,007,199,254,740,993"],
    ].map(([label, count]) => [
      ["th", label],
      ["td", `${count}명`],
    ]),
  );
  for (const row of rows) {
    assert.equal(row.tagName, "tr");
    assert.equal(row.children[0]!.getAttribute("scope"), "row");
  }
  const summary = h.get("campaign-draft-preview-summary").allText();
  assert.match(summary, /원래 인원\s+4명/);
  assert.match(summary, /현재 남은 인원\s+9,007,199,254,741,014명/, "counts beyond 2^53 must not round");
  assert.match(summary, /예상 공급자 호출 수\s+9,007,199,254,740,993회/);
  assert.match(summary, /요금제 일괄 발송 한도\s+정해지지 않음/);
  // The day-period word (오후 or PM) comes from the runtime's ICU data, so build the expected text with the same formatter.
  const asOf = new Date(previewResponse.as_of);
  const seoulAsOf = asOf.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  assert.ok(summary.includes(`${seoulAsOf} (Asia/Seoul)`), "as_of uses the workspace time zone");
  assert.match(seoulAsOf, /12:00:00/, "03:00Z is 12:00 in Asia/Seoul");
  assert.notEqual(seoulAsOf, asOf.toLocaleString("ko-KR", { timeZone: "UTC" }));
  assert.doesNotMatch(previewText(h), /Invalid|NaN|undefined|null/);
  assert.doesNotMatch(previewText(h), /발송\s*가능/);
  await runPreview(h);
  assert.equal(previewRequests(h), 2, "each click reads the preview again");
});

test("the preview hides warnings that do not apply and shows a defined plan limit as given", async () => {
  const h = await adminDraft(async (path) => {
    if (path.endsWith("/preview"))
      return {
        ...previewResponse,
        channel_marketing_supported: true,
        global_send_enabled: true,
        plan_broadcast_limit: "12345678901234567890",
      };
  });
  await openSaved(h);
  await runPreview(h);
  assert.equal(h.get("campaign-draft-preview-warnings").children.length, 0);
  assert.match(
    h.get("campaign-draft-preview-summary").allText(),
    /요금제 일괄 발송 한도\s+12,345,678,901,234,567,890명/,
  );
  assert.doesNotMatch(previewText(h), /발송\s*가능/);
});

test("the preview button reports a busy state while its read is pending", async () => {
  let release!: (value: unknown) => void;
  const h = await adminDraft(async (path) => {
    if (path.endsWith("/preview"))
      return new Promise((resolve) => {
        release = resolve;
      });
  });
  await openSaved(h);
  const button = h.get("campaign-draft-preview-run");
  assert.equal(button.disabled, false);
  const pending = runPreview(h);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-busy"), "true");
  release(structuredClone(previewResponse));
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-busy"), "false");
  assert.equal(rendered(h), true);
});

test("an unsaved edit disables the preview because it reads only the stored draft", async () => {
  const h = await adminDraft();
  await openSaved(h);
  h.fields.body.value = "Unsaved";
  await h.form.dispatch("input");
  assert.equal(h.get("campaign-draft-preview-run").disabled, true);
  await runPreview(h);
  assert.equal(previewRequests(h), 0);
});

test("an archived draft can be previewed", async () => {
  const h = await adminDraft(async (path) => {
    if (path.endsWith("/preview")) return { ...previewResponse, draft_version: 4, archived: true };
  });
  await openSaved(h);
  await h.get("campaign-draft-archive").dispatch("click");
  assert.equal(h.fields.body.disabled, true);
  assert.equal(h.get("campaign-draft-preview-run").disabled, false);
  await runPreview(h);
  assert.equal(rendered(h), true);
});

type PreviewHarness = Awaited<ReturnType<typeof adminDraft>>;
// Each entry carries the version of the draft that is open after the invalidation (the harness's writes return
// version 4), so the late response matches the open draft and only the invalidation itself can discard it.
const invalidations: [string, (h: PreviewHarness) => Promise<unknown> | void, number][] = [
  ["no invalidation (control)", () => {}, 3],
  [
    "an input change",
    (h) => {
      h.fields.body.value = "Edited";
      return h.form.dispatch("input");
    },
    3,
  ],
  ["a save", (h) => h.form.dispatch("submit"), 4],
  ["an archive", (h) => h.get("campaign-draft-archive").dispatch("click"), 4],
  ["opening another draft", (h) => openSaved(h), 3],
  ["starting a new draft", (h) => h.get("campaign-draft-new").dispatch("click"), 3],
  ["a session reset", (h) => h.controller.reset(), 3],
  ["a workspace change", (h) => h.controller.configure("admin", "workspace-b", "UTC"), 3],
  ["a time zone change on reload", (h) => h.controller.configure("admin", "workspace-a", "UTC"), 3],
  ["a saved time zone change", (h) => h.controller.timeZoneChanged("UTC"), 3],
];
for (const [name, invalidate, version] of invalidations)
  test(`a preview response that arrives after ${name} ${name.startsWith("no ") ? "renders" : "is discarded"}`, async () => {
    let release!: (value: unknown) => void;
    let pause = true;
    const h = await adminDraft(async (path) => {
      if (path.endsWith("/preview") && pause)
        return new Promise((resolve) => {
          release = resolve;
        });
    });
    await openSaved(h);
    const pending = runPreview(h);
    pause = false;
    await invalidate(h);
    release({ ...structuredClone(previewResponse), draft_version: version });
    await pending;
    await draftSettle();
    const control = name.startsWith("no ");
    assert.equal(rendered(h), control);
    assert.equal(h.get("campaign-draft-preview-warnings").children.length, control ? 2 : 0);
    // A discarded response leaves no trace; the mismatch notice would mean only the version check stopped it.
    assert.equal(h.get("campaign-draft-preview-status").textContent, "");
  });

for (const [name, invalidate] of invalidations.slice(1))
  test(`a preview already on screen is cleared by ${name}`, async () => {
    const h = await adminDraft();
    await openSaved(h);
    await runPreview(h);
    assert.equal(rendered(h), true);
    await invalidate(h);
    await draftSettle();
    assert.equal(rendered(h), false);
    assert.equal(h.get("campaign-draft-preview-warnings").children.length, 0);
    assert.equal(h.get("campaign-draft-preview-summary").children.length, 0);
  });

for (const [name, button] of [
  ["a save", "submit"],
  ["an archive", "campaign-draft-archive"],
] as const)
  test(`a preview response that arrives while ${name} is pending is discarded`, async () => {
    let releasePreview!: (value: unknown) => void;
    let releaseWrite!: (value: unknown) => void;
    const h = await adminDraft(async (path, method) => {
      if (path.endsWith("/preview"))
        return new Promise((resolve) => {
          releasePreview = resolve;
        });
      if (method !== "GET")
        return new Promise((resolve) => {
          releaseWrite = resolve;
        });
    });
    await openSaved(h);
    const pendingPreview = runPreview(h);
    const pendingWrite =
      button === "submit" ? h.form.dispatch("submit") : h.get("campaign-draft-archive").dispatch("click");
    // The open draft still has version 3 here, so only the write's invalidation can discard this response.
    releasePreview(structuredClone(previewResponse));
    await pendingPreview;
    assert.equal(rendered(h), false);
    assert.equal(h.get("campaign-draft-preview-status").textContent, "");
    releaseWrite({ ...savedDraft, version: 4, archived: button !== "submit" });
    await pendingWrite;
    await draftSettle();
    assert.equal(rendered(h), false);
  });

test("the app's other-tab session signal and BFCache restoration reset the campaign controller", () => {
  // Those triggers reach the preview only through campaignDrafts.reset(), which the tests above exercise.
  const source = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  const start = source.indexOf("const invalidateContactSession = () => {");
  const body = source.slice(start, source.indexOf("\n};", start));
  assert.match(body, /campaignDrafts\.reset\(\)/);
  assert.match(source, /addEventListener\("message"[\s\S]{0,120}invalidateContactSession\(\)/);
  assert.match(source, /addEventListener\("pageshow"[\s\S]{0,80}event\.persisted\) invalidateContactSession\(\)/);
});

test("a saved time zone change renders later previews and snapshot dates in the new zone without reloading", async () => {
  const h = await adminDraft();
  await openSaved(h);
  // Only the approval state is read again: its times were shown in the old zone.
  const draftReads = () => h.requests.filter((path) => path !== "/api/campaign-approvals").length;
  const before = draftReads();
  h.controller.timeZoneChanged("UTC");
  await draftSettle();
  assert.equal(draftReads(), before, "a zone change must not reload the draft list");
  assert.equal(h.fields.snapshot_id.value, input.snapshot_id, "the selected snapshot survives the option rebuild");
  assert.equal(h.controller.hasChanges(), false);
  const snapshotDate = new Date("2026-10-21T03:00:00Z").toLocaleString("ko-KR", { timeZone: "UTC" });
  assert.ok(h.fields.snapshot_id.children[1]!.textContent.includes(snapshotDate), "snapshot dates use the new zone");
  await runPreview(h);
  const utcAsOf = new Date(previewResponse.as_of).toLocaleString("ko-KR", { timeZone: "UTC" });
  const summary = h.get("campaign-draft-preview-summary").allText();
  assert.ok(summary.includes(`${utcAsOf} (UTC)`), "as_of uses the saved workspace time zone");
  assert.doesNotMatch(summary, /Asia\/Seoul/);
});

test("the time zone save handler updates the campaign controller", () => {
  const source = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  const start = source.indexOf('byId("time-zone-form").addEventListener("submit"');
  const block = source.slice(source.indexOf("if (changed) {", start), source.indexOf("notice(", start));
  assert.ok(start >= 0 && block.length > 0);
  assert.match(block, /campaignDrafts\.timeZoneChanged\(workspaceTimeZone\)/);
});

test("a preview of another draft or another version never renders", async () => {
  for (const mismatch of [{ draft_version: 2 }, { draft_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }]) {
    const h = await adminDraft(async (path) => {
      if (path.endsWith("/preview")) return { ...previewResponse, ...mismatch };
    });
    await openSaved(h);
    await runPreview(h);
    assert.equal(rendered(h), false);
    assert.equal(h.get("campaign-draft-preview-warnings").children.length, 0);
    assert.match(h.get("campaign-draft-preview-status").textContent, /다시 불러온/);
    assert.equal(h.get("campaign-draft-preview-run").disabled, false);
  }
});

test("preview errors use the campaign messages and leave another click available", async () => {
  for (const [failure, expected] of [
    [{ code: "campaign_draft_not_found", status: 404 }, /초안을 찾을 수 없습니다/],
    [{ code: "rate_limited", status: 429 }, /요청이 많습니다/],
    [new Error("network lost"), /불러오지 못했습니다/],
    [{ ...previewResponse, counts: { ...previewResponse.counts, candidate: 7 } }, /불러오지 못했습니다/],
  ] as const) {
    let fail = true;
    const h = await adminDraft(async (path) => {
      if (!path.endsWith("/preview") || !fail) return;
      if ("draft_id" in failure) return failure;
      throw failure;
    });
    await openSaved(h);
    await runPreview(h);
    assert.match(h.get("campaign-draft-preview-status").textContent, expected);
    assert.equal(rendered(h), false);
    assert.equal(h.get("campaign-draft-preview-run").disabled, false, "a read failure must not lock the button");
    assert.equal(h.fields.body.disabled, false, "a read failure must not lock the editor");
    fail = false;
    await runPreview(h);
    assert.equal(rendered(h), true);
    assert.equal(h.get("campaign-draft-preview-status").textContent, "");
  }
});

test("a new click clears the previous result before its own read finishes", async () => {
  let release!: (value: unknown) => void;
  let pause = false;
  const h = await adminDraft(async (path) => {
    if (path.endsWith("/preview") && pause)
      return new Promise((resolve) => {
        release = resolve;
      });
  });
  await openSaved(h);
  await runPreview(h);
  assert.equal(rendered(h), true);
  pause = true;
  const pending = runPreview(h);
  assert.equal(rendered(h), false, "a stale result must not stay beside the loading state");
  release(Promise.reject({ code: "rate_limited", status: 429 }));
  await pending;
  assert.equal(rendered(h), false);
  assert.match(h.get("campaign-draft-preview-status").textContent, /요청이 많습니다/);
});

test("a preview refused by role clears protected campaign data", async () => {
  const h = await adminDraft(async (path) => {
    if (path.endsWith("/preview")) throw { code: "role_forbidden", status: 403 };
  });
  await openSaved(h);
  await runPreview(h);
  assert.equal(h.get("campaign-drafts-section").hidden, true);
  assert.equal(h.fields.body.value, "");
  assert.equal(rendered(h), false);
});

// Execution approval UI (#35 follow-up): records an approval through the existing API and never claims a send.
type ApprovalHarness = Awaited<ReturnType<typeof adminDraft>>;
const approvalTextIds = [
  "campaign-approval-warnings",
  "campaign-approval-status",
  "campaign-approval-current-title",
  "campaign-approval-summary",
  "campaign-approval-rows",
  "campaign-approval-confirm-summary",
  "campaign-approval-schedule-help",
  "campaign-approval-start",
  "campaign-approval-submit",
  "campaign-approval-reschedule",
  "campaign-approval-cancel",
  "campaign-draft-status",
];
const approvalText = (h: ApprovalHarness) => approvalTextIds.map((id) => h.get(id).allText()).join(" ");
const approvalWrites = (h: ApprovalHarness) => h.writes.filter((write) => /approval/.test(write.path));
const approvalReads = (h: ApprovalHarness) => h.requests.filter((path) => path === "/api/campaign-approvals").length;
const click = (h: ApprovalHarness, id: string) => h.get(id).dispatch("click");
const approvalShown = (h: ApprovalHarness) =>
  !h.get("campaign-approval-current").hidden && h.get("campaign-approval-rows").children.length > 0;
async function chooseSchedule(h: ApprovalHarness, value: string | null) {
  h.get("campaign-approval-timing").value = value === null ? "now" : "later";
  await h.get("campaign-approval-timing").dispatch("change");
  if (value === null) return;
  h.get("campaign-approval-schedule").value = value;
  await h.get("campaign-approval-schedule").dispatch("input");
}
async function approveNow(h: ApprovalHarness) {
  await click(h, "campaign-approval-start");
  await click(h, "campaign-approval-submit");
}
function assertDraftLocked(h: ApprovalHarness, locked: boolean) {
  for (const key of ["name", "body", "snapshot_id"] as const) assert.equal(h.fields[key].disabled, locked, key);
  assert.equal(h.get("campaign-draft-save").disabled, locked);
  assert.equal(h.get("campaign-draft-archive").disabled, locked);
  assert.equal(h.get("campaign-draft-approval-lock").hidden, !locked);
}

test("the approve control is offered only for a stored, unchanged, unarchived draft with no approval in force", async () => {
  const h = await adminDraft();
  assert.equal(h.get("campaign-approval").hidden, true, "a new draft has nothing stored to approve");
  await openSaved(h);
  const start = h.get("campaign-approval-start");
  assert.equal(h.get("campaign-approval").hidden, false);
  assert.equal(start.disabled, false);
  h.fields.body.value = "Unsaved";
  await h.form.dispatch("input");
  assert.equal(start.disabled, true, "unsaved draft changes are not what the server would approve");
  await click(h, "campaign-approval-start");
  assert.equal(h.get("campaign-approval-confirm").hidden, true);
  h.fields.body.value = savedDraft.body;
  await h.form.dispatch("input");
  assert.equal(start.disabled, false);
  await chooseSchedule(h, "");
  assert.equal(h.get("campaign-approval-schedule-fields").hidden, false);
  assert.equal(start.disabled, true, "a scheduled approval needs a date and time");
  await chooseSchedule(h, "2026-11-01T09:00");
  assert.equal(start.disabled, false);
  await h.get("campaign-draft-archive").dispatch("click");
  assert.equal(start.disabled, true, "an archived draft cannot be approved");
  assert.equal(approvalWrites(h).length, 0);
});

test("the approve control waits for the approval read and stays off when it fails", async () => {
  let release!: (value: unknown) => void;
  let fail = false;
  const h = await adminDraft(async (path) => {
    if (path !== "/api/campaign-approvals") return;
    if (fail) throw new Error("network lost");
    if (!release)
      return new Promise((resolve) => {
        release = resolve;
      });
  });
  const opening = openSaved(h);
  await draftSettle();
  assert.equal(h.get("campaign-approval-start").disabled, true, "the approval state is unknown");
  assert.equal(h.fields.body.disabled, true, "an approval in force may still be found");
  release({ approvals: [] });
  await opening;
  assert.equal(h.get("campaign-approval-start").disabled, false);
  assert.equal(h.fields.body.disabled, false);
  fail = true;
  await click(h, "campaign-approval-refresh");
  assert.equal(h.get("campaign-approval-start").disabled, true);
  assert.match(h.get("campaign-approval-status").textContent, /승인 상태를 확인하지 못해/);
  // Saving stays possible; the server answers approval_active if an approval is in force.
  assert.equal(h.fields.body.disabled, false);
  fail = false;
  await click(h, "campaign-approval-refresh");
  assert.equal(h.get("campaign-approval-start").disabled, false);
});

test("an unresolved draft save keeps the approve control off", async () => {
  let attempts = 0;
  const h = await adminDraft(async (_path, method) => {
    if (method === "PUT" && ++attempts === 1) throw new Error("network lost");
  });
  await openSaved(h);
  h.fields.body.value = "Edited";
  await h.form.dispatch("submit");
  assert.equal(h.get("campaign-approval-start").disabled, true);
});

test("approval passes through a confirmation step that freezes the version, target and schedule it sends", async () => {
  const h = await adminDraft(undefined, [], "America/New_York");
  await openSaved(h);
  await chooseSchedule(h, "2026-11-01T09:00");
  await click(h, "campaign-approval-start");
  assert.equal(approvalWrites(h).length, 0, "the first click only opens the confirmation");
  assert.equal(h.get("campaign-approval-confirm").hidden, false);
  assert.equal(h.get("campaign-approval-start").hidden, true);
  assert.equal(h.get("campaign-approval-confirm-title").focused, true);
  const summary = h.get("campaign-approval-confirm-summary").allText();
  assert.match(summary, /Saved draft · 버전 3/);
  assert.match(summary, /고정 대상\s+VIP/);
  assert.match(summary, /2026-11-01 09:00 \(America\/New_York\)/);
  assert.equal(h.get("campaign-approval-schedule").disabled, true, "the confirmed schedule cannot change");
  await click(h, "campaign-approval-back");
  assert.equal(h.get("campaign-approval-confirm").hidden, true);
  assert.equal(approvalWrites(h).length, 0);
  await click(h, "campaign-approval-submit");
  assert.equal(approvalWrites(h).length, 0, "a closed confirmation sends nothing");
  await click(h, "campaign-approval-start");
  await click(h, "campaign-approval-submit");
  assert.deepEqual(approvalWrites(h), [
    {
      path: `/api/campaign-drafts/${input.id}/approvals`,
      method: "POST",
      body: {
        id: input.id,
        expected_version: 3,
        schedule_local: "2026-11-01T09:00",
        expected_time_zone: "America/New_York",
      },
    },
  ]);
  assert.match(h.get("campaign-approval-status").textContent, /기록했습니다.*전송되지 않았습니다/);
  assert.equal(h.get("campaign-approval-confirm").hidden, true);
  assert.equal(h.get("campaign-approval-current-title").focused, true, "focus leaves the hidden confirmation");
  assert.equal(approvalShown(h), true);
});

for (const [name, act, archived] of [
  ["save", (h: ApprovalHarness) => h.form.dispatch("submit"), false],
  ["archive", (h: ApprovalHarness) => click(h, "campaign-draft-archive"), true],
] as const) {
  test(`a successful ${name} closes an open confirmation that froze the older version`, async () => {
    const h = await adminDraft();
    await openSaved(h);
    await click(h, "campaign-approval-start");
    assert.match(h.get("campaign-approval-confirm-summary").allText(), /버전 3/);
    await act(h);
    assert.equal(h.get("campaign-approval-confirm").hidden, true, "the confirmation showed version 3");
    assert.equal(h.get("campaign-approval-confirm-summary").allText(), "");
    await click(h, "campaign-approval-submit");
    assert.equal(approvalWrites(h).length, 0, "a closed confirmation sends nothing");
    if (archived) return;
    await approveNow(h);
    assert.equal(approvalWrites(h)[0]!.body!.expected_version, 4, "a new confirmation uses the saved version");
  });
}

test("an immediate approval sends null as its schedule and the zone the screen knows", async () => {
  const h = await adminDraft();
  await openSaved(h);
  await click(h, "campaign-approval-start");
  assert.match(h.get("campaign-approval-confirm-summary").allText(), /실행 시점\s+즉시/);
  await click(h, "campaign-approval-submit");
  assert.deepEqual(approvalWrites(h)[0]!.body, {
    id: input.id,
    expected_version: 3,
    schedule_local: null,
    expected_time_zone: "Asia/Seoul",
  });
  assert.match(h.get("campaign-approval-summary").allText(), /실행 시점\s+즉시/);
});

test("an approval in force shows its stored counts and schedule zone and locks the draft", async () => {
  const h = await adminDraft(undefined, [storedApproval]);
  await openSaved(h);
  assert.equal(approvalShown(h), true);
  assert.equal(h.get("campaign-approval-current-title").textContent, "유효한 승인");
  const rows = h.get("campaign-approval-rows").children;
  assert.deepEqual(
    rows.map((row) => row.children.map((cell) => [cell.tagName, cell.textContent])),
    [
      ["연결 발송 불가", "1"],
      ["자동화 중지", "2"],
      ["확인된 DM 대화 없음", "3"],
      ["수신 거부", "4"],
      ["마케팅 동의 없음", "5"],
      ["24시간 응답 창 닫힘", "6"],
      ["조건 통과", "9,007,199,254,740,993"],
    ].map(([label, count]) => [
      ["th", label],
      ["td", `${count}명`],
    ]),
  );
  for (const row of rows) assert.equal(row.children[0]!.getAttribute("scope"), "row");
  const summary = h.get("campaign-approval-summary").allText();
  // The schedule renders in the zone the approval stored, not the workspace's Asia/Seoul.
  const newYork = new Date(storedApproval.scheduled_at!).toLocaleString("ko-KR", { timeZone: "America/New_York" });
  assert.ok(summary.includes(`실행 시점 ${newYork} (America/New_York)`), summary);
  assert.match(newYork, /6:30:00/);
  const approvedAt = new Date(storedApproval.approved_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  assert.ok(summary.includes(`${approvedAt} (Asia/Seoul) · 나`));
  assert.match(summary, /승인 시점 남은 인원\s+9,007,199,254,741,014명/);
  assert.deepEqual(
    h.get("campaign-approval-warnings").children.map((child) => child.textContent),
    [
      "실행 시점이 되면 서비스 전체 발송이 켜져 있을 때만 실행이 시작됩니다. 보내기 직전마다 모든 조건을 다시 확인하며, 조건을 통과하지 못한 사람에게는 보내지 않습니다.",
    ],
  );
  assertDraftLocked(h, true);
  assert.equal(h.get("campaign-approval-start").hidden, true);
  assert.equal(h.get("campaign-approval-reschedule").hidden, false);
  assert.equal(h.get("campaign-approval-cancel").hidden, false);
  // A time stored in another zone is not offered as this zone's wall clock.
  assert.equal(h.get("campaign-approval-timing").value, "later");
  assert.equal(h.get("campaign-approval-schedule").value, "");
  await h.form.dispatch("submit");
  await h.get("campaign-draft-archive").dispatch("click");
  assert.equal(h.writes.length, 0, "a locked draft sends no save or archive");
  assert.doesNotMatch(approvalText(h), /발송\s*가능/);
  assert.doesNotMatch(approvalText(h), /Invalid|NaN|undefined|null/);
});

test("schedule change and cancel send the displayed version, and cancel unlocks the draft", async () => {
  const h = await adminDraft(undefined, [storedApproval], "America/New_York");
  await openSaved(h);
  assert.equal(h.get("campaign-approval-schedule").value, "2026-10-28T06:30", "the same zone prefills its time");
  assert.equal(h.get("campaign-approval-reschedule").disabled, true, "an unchanged schedule is not sent");
  await chooseSchedule(h, "2026-10-29T06:30");
  await click(h, "campaign-approval-reschedule");
  assert.deepEqual(approvalWrites(h)[0], {
    path: `/api/campaign-approvals/${approvalId}/schedule`,
    method: "PUT",
    body: { expected_version: 1, schedule_local: "2026-10-29T06:30", expected_time_zone: "America/New_York" },
  });
  assert.match(h.get("campaign-approval-status").textContent, /예약을 변경했습니다/);
  await chooseSchedule(h, null);
  await click(h, "campaign-approval-reschedule");
  assert.deepEqual(approvalWrites(h)[1]!.body, {
    expected_version: 2,
    schedule_local: null,
    expected_time_zone: "America/New_York",
  });
  assert.equal(h.get("campaign-approval-current-title").focused, false, "a schedule change keeps its button");
  await click(h, "campaign-approval-cancel");
  assert.deepEqual(approvalWrites(h)[2], {
    path: `/api/campaign-approvals/${approvalId}/cancel`,
    method: "POST",
    body: { expected_version: 3 },
  });
  assert.equal(h.get("campaign-approval-current-title").textContent, "최근 승인 · 취소됨");
  assert.equal(h.get("campaign-approval-current-title").focused, true, "focus leaves the hidden cancel button");
  assert.match(h.get("campaign-approval-summary").allText(), /취소\s+.*다른 멤버 \(user-oth\)/);
  assert.equal(h.get("campaign-approval-warnings").children.length, 0);
  assertDraftLocked(h, false);
  assert.equal(h.get("campaign-approval-reschedule").hidden, true);
  assert.equal(h.get("campaign-approval-start").hidden, false);
  assert.equal(h.get("campaign-approval-start").disabled, false, "a cancelled approval allows a new one");
});

test("a refused cancel confirmation sends nothing", async () => {
  const h = await adminDraft(undefined, [storedApproval]);
  await openSaved(h);
  h.refuseDiscard();
  await click(h, "campaign-approval-cancel");
  assert.equal(approvalWrites(h).length, 0);
  assertDraftLocked(h, true);
});

test("a version conflict re-renders the current approval and the next change uses its version", async () => {
  const newer = {
    ...storedApproval,
    version: 5,
    schedule_local: "2026-10-30T06:30",
    scheduled_at: "2026-10-30T10:30:00.000000Z",
  };
  const h = await adminDraft(
    async (path) => {
      if (path.endsWith("/schedule")) throw { status: 409, code: "campaign_approval_conflict", approval: newer };
    },
    [storedApproval],
    "America/New_York",
  );
  await openSaved(h);
  await chooseSchedule(h, "2026-10-29T06:30");
  await click(h, "campaign-approval-reschedule");
  assert.match(h.get("campaign-approval-status").textContent, /다른 곳에서 승인이 변경/);
  assert.equal(h.get("campaign-approval-schedule").value, "2026-10-30T06:30");
  assert.equal(approvalWrites(h).length, 1, "a conflict never retries by itself");
  await click(h, "campaign-approval-cancel");
  assert.deepEqual(approvalWrites(h)[1]!.body, { expected_version: 5 });
});

test("a cancelled conflict shows the cancelled approval and unlocks the draft", async () => {
  const cancelled = {
    ...storedApproval,
    status: "cancelled",
    version: 2,
    cancelled_by: "user-me",
    cancelled_at: "2026-10-27T04:00:00Z",
  };
  const h = await adminDraft(
    async (path) => {
      if (path.endsWith("/cancel")) throw { status: 409, code: "campaign_approval_cancelled", approval: cancelled };
    },
    [storedApproval],
  );
  await openSaved(h);
  await click(h, "campaign-approval-cancel");
  assert.equal(h.get("campaign-approval-current-title").textContent, "최근 승인 · 취소됨");
  assert.match(h.get("campaign-approval-status").textContent, /이미 취소된 승인/);
  assertDraftLocked(h, false);
});

test("an executed conflict shows the executed approval, unlocks the draft and allows a new approval", async () => {
  const executed = { ...storedApproval, status: "executed", run_id: "run-1", run_status: "running" };
  const h = await adminDraft(
    async (path) => {
      if (path.endsWith("/cancel")) throw { status: 409, code: "campaign_approval_executed", approval: executed };
    },
    [storedApproval],
  );
  await openSaved(h);
  await click(h, "campaign-approval-cancel");
  assert.equal(h.get("campaign-approval-current-title").textContent, "최근 승인 · 실행 시작됨");
  assert.match(h.get("campaign-approval-summary").allText(), /실행 시작됨 · 보내기 직전에 조건을 다시 확인해 발송/);
  assert.doesNotMatch(h.get("campaign-approval-summary").allText(), /취소\s/);
  assert.match(h.get("campaign-approval-status").textContent, /이미 실행이 시작된 승인/);
  assert.equal(h.get("campaign-approval-warnings").children.length, 0);
  assertDraftLocked(h, false);
  assert.equal(h.get("campaign-approval-start").disabled, false);
});

test("an approval that already exists elsewhere is shown and locks the draft", async () => {
  const h = await adminDraft(async (path, method) => {
    if (path.endsWith("/approvals") && method === "POST")
      throw { status: 409, code: "approval_exists", approval: storedApproval };
  });
  await openSaved(h);
  await approveNow(h);
  assert.equal(approvalShown(h), true);
  assert.match(h.get("campaign-approval-status").textContent, /먼저 기록/);
  assertDraftLocked(h, true);
  assert.equal(approvalWrites(h).length, 1);
});

test("an executed draft version is refused with the executed approval and leaves the draft editable", async () => {
  const executed = { ...storedApproval, status: "executed", run_id: "run-1", run_status: "completed" };
  const h = await adminDraft(async (path, method) => {
    if (path.endsWith("/approvals") && method === "POST")
      throw { status: 409, code: "campaign_version_executed", approval: executed };
  });
  await openSaved(h);
  await approveNow(h);
  assert.equal(h.get("campaign-approval-current-title").textContent, "최근 승인 · 실행 시작됨");
  assert.match(h.get("campaign-approval-status").textContent, /이미 실행되었습니다.*초안을 수정해 저장한 뒤 승인/);
  assert.equal(h.get("campaign-approval-warnings").children.length, 0);
  assertDraftLocked(h, false);
  assert.equal(approvalWrites(h).length, 1);
});

test("a draft conflict on approval shows the current draft, reads the approval again and approves that version", async () => {
  let conflicted = false;
  const h = await adminDraft(async (path, method) => {
    if (path.endsWith("/approvals") && method === "POST" && !conflicted) {
      conflicted = true;
      throw {
        status: 409,
        code: "campaign_draft_conflict",
        draft: { ...savedDraft, version: 4, body: "Changed elsewhere" },
      };
    }
  });
  await openSaved(h);
  const reads = approvalReads(h);
  await approveNow(h);
  assert.equal(h.fields.body.value, "Changed elsewhere");
  assert.match(h.get("campaign-draft-summary").textContent, /버전 4/);
  assert.equal(approvalReads(h), reads + 1);
  assert.match(h.get("campaign-approval-status").textContent, /다른 곳에서 초안이 변경/);
  assert.equal(approvalWrites(h).length, 1);
  await approveNow(h);
  assert.equal(approvalWrites(h)[1]!.body.expected_version, 4);
});

test("a draft conflict on approval clears the preview of the older draft version", async () => {
  const h = await adminDraft(async (path, method) => {
    if (path.endsWith("/approvals") && method === "POST")
      throw { status: 409, code: "campaign_draft_conflict", draft: { ...savedDraft, version: 4 } };
  });
  await openSaved(h);
  await runPreview(h);
  assert.equal(rendered(h), true);
  await approveNow(h);
  assert.match(h.get("campaign-draft-summary").textContent, /버전 4/);
  assert.equal(rendered(h), false, "the preview counts were read for version 3");
});

test("a draft created on this screen reads its approval state and can then be approved", async () => {
  const h = await adminDraft();
  fillNew(h);
  const reads = approvalReads(h);
  await h.form.dispatch("submit");
  assert.equal(h.get("campaign-approval").hidden, false);
  assert.equal(approvalReads(h), reads + 1, "the saved draft's approval state must be read");
  assert.equal(h.get("campaign-approval-start").disabled, false);
  await approveNow(h);
  assert.equal(approvalWrites(h).length, 1);
  assert.equal(approvalWrites(h)[0]!.body.expected_version, 4);
});

test("a retried create that succeeds reads the approval state and finds one recorded elsewhere", async () => {
  let attempts = 0;
  const h = await adminDraft(async (path, method) => {
    if (path === "/api/campaign-drafts" && method === "POST" && ++attempts === 1) throw new Error("network lost");
  });
  fillNew(h);
  await h.form.dispatch("submit");
  // Another tab opens the accepted draft and approves it before this tab retries.
  h.approvals.unshift({ ...storedApproval, draft_version: 4 });
  await h.form.dispatch("submit");
  assert.equal(approvalShown(h), true);
  assert.equal(h.get("campaign-approval-start").hidden, true);
  assertDraftLocked(h, true);
});

test("a time zone mismatch asks for a reload and drops the request", async () => {
  const h = await adminDraft(async (path, method) => {
    if (path.endsWith("/approvals") && method === "POST")
      throw { status: 409, code: "campaign_schedule_timezone_changed" };
  });
  await openSaved(h);
  await approveNow(h);
  assert.match(h.get("campaign-approval-status").textContent, /시간대.*새로고침/);
  assert.equal(h.get("campaign-approval-confirm").hidden, true);
  assert.equal(h.controller.hasChanges(), false);
  assert.equal(approvalWrites(h).length, 1);
});

test("a lost approval response keeps the same id and request for an explicit retry only", async () => {
  let attempts = 0;
  const h = await adminDraft(async (path, method) => {
    if (path.endsWith("/approvals") && method === "POST" && ++attempts === 1) throw new Error("network lost");
  });
  await openSaved(h);
  await approveNow(h);
  assert.match(h.get("campaign-approval-status").textContent, /같은 요청 재시도/);
  assert.equal(h.get("campaign-approval-submit").textContent, "같은 요청 재시도");
  assert.equal(h.get("campaign-approval-back").hidden, true, "an unresolved request cannot be abandoned");
  assert.equal(h.get("campaign-approval-confirm").hidden, false);
  assert.equal(h.controller.hasChanges(), true);
  assert.equal(h.get("campaign-draft-new").disabled, true);
  assert.equal(h.fields.body.disabled, true);
  // Neither a draft switch nor changed inputs can drop or alter the pending request.
  await openSaved(h);
  await h.get("campaign-draft-new").dispatch("click");
  h.get("campaign-approval-timing").value = "later";
  h.get("campaign-approval-schedule").value = "2026-11-01T09:00";
  await click(h, "campaign-approval-submit");
  assert.deepEqual(approvalWrites(h)[1], approvalWrites(h)[0]);
  assert.equal(approvalWrites(h)[0]!.body.schedule_local, null);
  assert.equal(approvalShown(h), true);
  assertDraftLocked(h, true);
  assert.equal(h.controller.hasChanges(), false);
});

for (const [name, change] of [
  ["a saved time zone change", (h: ApprovalHarness) => h.controller.timeZoneChanged("UTC")],
  ["a time zone change on reload", (h: ApprovalHarness) => h.controller.configure("admin", "workspace-a", "UTC")],
  [
    "a draft input event",
    (h: ApprovalHarness) => {
      h.fields.body.value = "Not the approved text";
      return h.form.dispatch("input");
    },
  ],
] as const)
  test(`an unresolved approval keeps its retry summary and request across ${name}`, async () => {
    let attempts = 0;
    const h = await adminDraft(async (path, method) => {
      if (path.endsWith("/approvals") && method === "POST" && ++attempts === 1) throw new Error("network lost");
    });
    await openSaved(h);
    await approveNow(h);
    await change(h);
    await draftSettle();
    assert.equal(h.get("campaign-approval-confirm").hidden, false);
    assert.equal(h.get("campaign-approval-submit").textContent, "같은 요청 재시도");
    assert.match(
      h.get("campaign-approval-confirm-summary").allText(),
      /Saved draft · 버전 3.*VIP.*즉시/,
      "the retry must still show what it sends",
    );
    await click(h, "campaign-approval-submit");
    assert.deepEqual(approvalWrites(h)[1], approvalWrites(h)[0]);
    assert.equal(approvalWrites(h)[1]!.body.expected_time_zone, "Asia/Seoul");
  });

test("a throttled approval retry keeps the earlier request", async () => {
  let attempts = 0;
  const h = await adminDraft(async (path, method) => {
    if (!(path.endsWith("/approvals") && method === "POST")) return;
    attempts++;
    if (attempts === 1) throw { status: 429, code: "rate_limited" };
    if (attempts === 2) throw new Error("accepted response lost");
    if (attempts === 3) throw { status: 429, code: "rate_limited" };
  });
  await openSaved(h);
  await approveNow(h);
  assert.match(h.get("campaign-approval-status").textContent, /요청이 많습니다/);
  assert.equal(h.get("campaign-approval-submit").textContent, "같은 요청 재시도");
  await click(h, "campaign-approval-submit");
  await click(h, "campaign-approval-submit");
  assert.match(h.get("campaign-approval-status").textContent, /요청이 많습니다/);
  await click(h, "campaign-approval-submit");
  assert.deepEqual(
    approvalWrites(h).map((write) => write.body.id),
    [input.id, input.id, input.id, input.id],
  );
  assert.equal(approvalShown(h), true);
});

test("a lost schedule change or cancel allows only the same request again", async () => {
  let fail = true;
  const h = await adminDraft(
    async (path) => {
      if (fail && (path.endsWith("/schedule") || path.endsWith("/cancel"))) throw new Error("network lost");
    },
    [storedApproval],
    "America/New_York",
  );
  await openSaved(h);
  await chooseSchedule(h, "2026-10-29T06:30");
  await click(h, "campaign-approval-reschedule");
  assert.equal(h.get("campaign-approval-reschedule").textContent, "같은 요청 재시도");
  assert.equal(h.get("campaign-approval-cancel").disabled, true);
  assert.equal(h.get("campaign-approval-schedule").disabled, true);
  await click(h, "campaign-approval-cancel");
  assert.equal(approvalWrites(h).length, 1, "another request waits for the unresolved one");
  fail = false;
  await click(h, "campaign-approval-reschedule");
  assert.deepEqual(approvalWrites(h)[1], approvalWrites(h)[0]);
  fail = true;
  await click(h, "campaign-approval-cancel");
  assert.equal(h.get("campaign-approval-cancel").textContent, "같은 요청 재시도");
  h.refuseDiscard();
  fail = false;
  await click(h, "campaign-approval-cancel");
  assert.deepEqual(approvalWrites(h)[3], approvalWrites(h)[2], "the retry needs no second confirmation");
  assert.deepEqual(approvalWrites(h)[2]!.body, { expected_version: 2 });
  assertDraftLocked(h, false);
});

test("approve, schedule and cancel buttons report a busy state while their write is pending", async () => {
  let release!: (value: unknown) => void;
  const h = await adminDraft(async (path, method) => {
    if (path.endsWith("/approvals") && method === "POST")
      return new Promise((resolve) => {
        release = resolve;
      });
  });
  await openSaved(h);
  await click(h, "campaign-approval-start");
  const pending = click(h, "campaign-approval-submit");
  const submit = h.get("campaign-approval-submit");
  assert.equal(submit.disabled, true);
  assert.equal(submit.getAttribute("aria-busy"), "true");
  assert.equal(h.get("campaign-approval").getAttribute("aria-busy"), "true");
  release({ ...storedApproval, id: input.id });
  await pending;
  assert.equal(submit.getAttribute("aria-busy"), "false");
  assert.equal(h.get("campaign-approval").getAttribute("aria-busy"), "false");
});

test("a draft save refused with approval_active keeps the edits and shows the approval from another tab", async () => {
  let approved = false;
  const h = await adminDraft(async (path, method) => {
    if (path === "/api/campaign-approvals" && approved) return { approvals: [storedApproval] };
    if (method === "PUT") {
      approved = true;
      throw { status: 409, code: "approval_active" };
    }
  });
  await openSaved(h);
  h.fields.body.value = "Edited";
  await h.form.dispatch("submit");
  assert.match(h.get("campaign-draft-status").textContent, /실행 승인이 기록되었습니다.*승인을 취소/);
  assert.equal(h.fields.body.value, "Edited");
  assert.equal(approvalShown(h), true);
  assertDraftLocked(h, true);
  assert.equal(h.writes.length, 1);
});

const approvalInvalidations: [string, (h: ApprovalHarness) => Promise<unknown> | void][] = [
  ["no invalidation (control)", () => {}],
  ["opening another draft", (h) => openSaved(h)],
  ["starting a new draft", (h) => h.get("campaign-draft-new").dispatch("click")],
  ["a session reset", (h) => h.controller.reset()],
  ["a workspace change", (h) => h.controller.configure("admin", "workspace-b", "UTC")],
  ["a time zone change on reload", (h) => h.controller.configure("admin", "workspace-a", "UTC")],
  ["a saved time zone change", (h) => h.controller.timeZoneChanged("UTC")],
];
for (const [name, invalidate] of approvalInvalidations)
  test(`an approval read that arrives after ${name} ${name.startsWith("no ") ? "renders" : "is discarded"}`, async () => {
    let release!: (value: unknown) => void;
    let pause = true;
    const h = await adminDraft(async (path) => {
      if (path === "/api/campaign-approvals" && pause) {
        pause = false;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    });
    const opening = openSaved(h);
    await draftSettle();
    await invalidate(h);
    release({ approvals: [storedApproval] });
    await opening;
    await draftSettle();
    const control = name.startsWith("no ");
    assert.equal(approvalShown(h), control);
    assert.equal(h.get("campaign-approval-warnings").children.length, control ? 1 : 0);
  });

for (const [name, invalidate] of approvalInvalidations.slice(1))
  test(`an approval already on screen is cleared by ${name}`, async () => {
    // Later reads return no approval, so only a retained old state could still show one.
    const h = await adminDraft(undefined, [storedApproval]);
    await openSaved(h);
    assert.equal(approvalShown(h), true);
    h.approvals.length = 0;
    await invalidate(h);
    await draftSettle();
    assert.equal(approvalShown(h), false);
    assert.equal(h.get("campaign-approval-summary").children.length, 0);
  });

test("an approval write that completes after a session reset is discarded", async () => {
  let finish!: (value: unknown) => void;
  const h = await adminDraft(async (path, method) => {
    if (path.endsWith("/approvals") && method === "POST")
      return new Promise((resolve) => {
        finish = resolve;
      });
  });
  await openSaved(h);
  await click(h, "campaign-approval-start");
  const pending = click(h, "campaign-approval-submit");
  h.controller.reset();
  finish({ ...storedApproval, id: input.id });
  await pending;
  assert.equal(approvalShown(h), false);
  assert.equal(h.get("campaign-drafts-section").hidden, true);
  assert.equal(h.controller.hasChanges(), false);
});

test("an approval refused by role clears protected campaign data", async () => {
  const h = await adminDraft(async (path, method) => {
    if (path.endsWith("/approvals") && method === "POST") throw { status: 403, code: "role_forbidden" };
  });
  await openSaved(h);
  await approveNow(h);
  assert.equal(h.get("campaign-drafts-section").hidden, true);
  assert.equal(approvalShown(h), false);
  assert.equal(h.fields.body.value, "");
});

test("a malformed approval row renders nothing and leaves approval off", async () => {
  const h = await adminDraft(undefined, [
    {
      ...storedApproval,
      preview: { ...storedApproval.preview, counts: { ...previewResponse.counts, candidate: 7 as unknown as string } },
    },
  ]);
  await openSaved(h);
  assert.equal(approvalShown(h), false);
  assert.equal(h.get("campaign-approval-start").disabled, true);
  assert.match(h.get("campaign-approval-status").textContent, /불러오지 못했습니다/);
});

test("the shared api wrapper forwards a refused campaign write's current approval, draft and run", async () => {
  const source = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function api(path");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start);
  for (const payload of [
    { error: "approval_exists", approval: { id: approvalId } },
    { error: "campaign_draft_conflict", draft: { id: input.id, version: 4 } },
    { error: "campaign_run_conflict", run: { id: runId, version: 2 } },
  ] as { error: string; approval?: object; draft?: object; run?: object }[]) {
    const context = vm.createContext({
      workspaceGeneration: 0,
      acceptedAuthRevision: "ready:a",
      authSessionRevision: () => "ready:a",
      errors: {},
      refreshPromise: undefined,
      resetSession: () => {},
      fetch: async () => ({ status: 409, ok: false, json: async () => payload }),
    });
    vm.runInContext(source.slice(start, end + 3), context);
    const error = await context.api(`/api/campaign-drafts/${input.id}/approvals`, "POST", {}).then(
      () => assert.fail("a 409 must throw"),
      (thrown: { status: number; code: string; approval?: object; draft?: object; run?: object }) => thrown,
    );
    assert.equal(error.status, 409);
    assert.equal(error.code, payload.error);
    assert.equal(error.approval, payload.approval);
    assert.equal(error.draft, payload.draft);
    assert.equal(error.run, payload.run);
  }
});

test("the approval markup labels its inputs, keeps its messages in live regions and never says sendable", () => {
  const html = readFileSync(new URL("../../public/app/index.html", import.meta.url), "utf8");
  const start = html.indexOf('id="campaign-approval"');
  const section = html.slice(start, html.indexOf("</section>", start));
  assert.ok(start >= 0 && section.length > 0);
  assert.match(section, /<label\s*>실행 시점<select id="campaign-approval-timing"/);
  assert.match(section, /<label\s*>예약 시각<input\s+id="campaign-approval-schedule"\s+type="datetime-local"/);
  assert.doesNotMatch(section, /\sstep=/, "the server accepts minutes only");
  for (const id of ["campaign-approval-status", "campaign-approval-warnings"])
    assert.match(section, new RegExp(`id="${id}"[^>]*role="status"`));
  assert.match(section, /<th scope="col">조건<\/th>/);
  // The formatter may break these sentences at any space.
  assert.match(section, /서비스\s+전체\s+발송이\s+켜져\s+있을\s+때만\s+실행이\s+시작되고/);
  assert.match(section, /보내기\s+직전마다\s+모든\s+조건을\s+다시\s+확인하며/);
  assert.doesNotMatch(section, /아직 지원하지 않습니다/);
  assert.doesNotMatch(section, /발송\s*가능/);
});

test("the draft notice says an approved draft runs only while service-wide sending is on", () => {
  const html = readFileSync(new URL("../../public/app/index.html", import.meta.url), "utf8");
  const start = html.indexOf('id="campaign-draft-help"');
  const notice = html.slice(start, html.indexOf("</p>", start));
  assert.ok(start >= 0 && notice.length > 0);
  // The formatter may break these sentences at any space.
  assert.match(notice, /승인한\s+초안은\s+서비스\s+전체\s+발송이\s+켜져\s+있을\s+때만\s+실행됩니다/);
  assert.doesNotMatch(notice, /아직\s+제공하지\s+않습니다/);
});

// Campaign run panel (#36 PR ③): reads only on approval load and explicit refresh, cancels with a frozen version.
const runTextIds = [
  "campaign-run-status",
  "campaign-run-summary",
  "campaign-run-rows",
  "campaign-run-deliveries",
  "campaign-run-confirm-summary",
  "campaign-run-cancel",
  "campaign-run-cancel-submit",
];
const runText = (h: ApprovalHarness) => runTextIds.map((id) => h.get(id).allText()).join(" ");
const runReads = (h: ApprovalHarness, id = runId) =>
  h.requests.filter((path) => path === `/api/campaign-runs/${id}`).length;
const runWrites = (h: ApprovalHarness) => h.writes.filter((write) => write.path.startsWith("/api/campaign-runs/"));
const runShown = (h: ApprovalHarness) =>
  !h.get("campaign-run-current").hidden && h.get("campaign-run-deliveries").children.length > 0;
// The dt/dd pairs of a definition list, in order.
const pairs = (element: DraftElement) =>
  element.children.map((item) => [item.children[0]!.textContent, item.children[1]!.textContent]);
async function openExecuted(override?: DraftApi, approvals: Approval[] = [executedApproval]) {
  const h = await adminDraft(override, approvals);
  await openSaved(h);
  return h;
}
async function cancelThroughConfirmation(h: ApprovalHarness) {
  await click(h, "campaign-run-cancel");
  await click(h, "campaign-run-cancel-submit");
}
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("an executed approval shows its run's status, start counts and every delivery status from one read", async () => {
  const h = await openExecuted();
  assert.equal(runReads(h), 1);
  assert.equal(h.get("campaign-run").hidden, false);
  assert.equal(runShown(h), true);
  assert.match(h.get("campaign-approval-summary").allText(), /실행 시작됨 · 보내기 직전에 조건을 다시 확인해 발송/);
  const startedAt = new Date(storedRun.start.as_of).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  assert.deepEqual(pairs(h.get("campaign-run-summary")), [
    ["상태", "진행 중"],
    ["시작 시각", `${startedAt} (Asia/Seoul)`],
    ["시작 시점 원래 인원", "4명"],
    ["시작 시점 남은 인원", "9,007,199,254,741,014명"],
  ]);
  assert.deepEqual(
    h.get("campaign-run-rows").children.map((row) => row.children.map((cell) => cell.textContent)),
    [
      ["연결 발송 불가", "1명"],
      ["자동화 중지", "2명"],
      ["확인된 DM 대화 없음", "3명"],
      ["수신 거부", "4명"],
      ["마케팅 동의 없음", "5명"],
      ["24시간 응답 창 닫힘", "6명"],
      ["조건 통과", "9,007,199,254,740,993명"],
    ],
  );
  assert.deepEqual(pairs(h.get("campaign-run-deliveries")), [
    ["대기", "11건"],
    ["보내는 중", "12건"],
    ["보냄", "13건"],
    ["실패", "14건"],
    ["차단", "15건"],
    ["결과 불명", "16건"],
    ["취소", "9,007,199,254,740,993건"],
  ]);
  assert.equal(h.get("campaign-run-cancel").hidden, false);
  assert.equal(h.get("campaign-run-cancel").disabled, false);
  assert.equal(h.get("campaign-run-confirm").hidden, true);
  assert.doesNotMatch(runText(h), /발송\s*가능/);
  assert.doesNotMatch(runText(h), /user-|99999999/, "no member or run identifier is shown");
});

test("a cancelled run shows when it was cancelled and offers no cancel; a completed run offers none either", async () => {
  for (const [status, label] of [
    ["cancelled", "취소됨"],
    ["completed", "완료"],
  ] as const) {
    const h = await adminDraft(undefined, [executedApproval]);
    h.runs.set(runId, {
      ...storedRun,
      status,
      version: 2,
      cancelled_by: status === "cancelled" ? "user-other" : null,
      cancelled_at: status === "cancelled" ? "2026-10-28T11:00:00.000000Z" : null,
    });
    await openSaved(h);
    const shown = pairs(h.get("campaign-run-summary"));
    assert.deepEqual(shown[0], ["상태", label]);
    const cancelledAt = new Date("2026-10-28T11:00:00Z").toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    if (status === "cancelled") assert.deepEqual(shown[1], ["취소 시각", `${cancelledAt} (Asia/Seoul)`]);
    else assert.equal(shown[1]![0], "시작 시각");
    assert.equal(h.get("campaign-run-cancel").hidden, true);
  }
});

test("no run is read for a draft without an approval, an approval in force or a cancelled approval", async () => {
  for (const approvals of [[], [storedApproval], [{ ...storedApproval, status: "cancelled" }]]) {
    const h = await openExecuted(undefined, approvals);
    assert.equal(h.requests.filter((path) => path.startsWith("/api/campaign-runs/")).length, 0);
    assert.equal(h.get("campaign-run").hidden, true);
  }
});

test("the run is read again only by its refresh button, once per click, with no timer", async () => {
  const h = await openExecuted();
  assert.equal(runReads(h), 1);
  await draftSettle();
  await draftSettle();
  assert.equal(runReads(h), 1, "nothing polls");
  h.runs.set(runId, { ...storedRun, delivery_counts: { ...storedRun.delivery_counts, sent: "20" } });
  await click(h, "campaign-run-refresh");
  assert.equal(runReads(h), 2);
  assert.deepEqual(pairs(h.get("campaign-run-deliveries"))[2], ["보냄", "20건"]);
  await click(h, "campaign-run-refresh");
  assert.equal(runReads(h), 3);
  assert.equal(runWrites(h).length, 0);
});

test("cancel goes through a confirmation that freezes the displayed version and sends it", async () => {
  const h = await openExecuted();
  await click(h, "campaign-run-cancel");
  assert.equal(runWrites(h).length, 0, "opening the confirmation sends nothing");
  assert.equal(h.get("campaign-run-confirm").hidden, false);
  assert.equal(h.get("campaign-run-cancel").hidden, true);
  assert.equal(h.get("campaign-run-confirm-title").focused, true);
  assert.deepEqual(pairs(h.get("campaign-run-confirm-summary")).slice(1), [
    ["표시된 대기 행", "11건"],
    ["표시된 보내는 중 행", "12건"],
  ]);
  // Going back sends nothing and closes the confirmation.
  await click(h, "campaign-run-cancel-back");
  assert.equal(h.get("campaign-run-confirm").hidden, true);
  assert.equal(runWrites(h).length, 0);
  // A version that moved on the server after the confirmation opened is not reread.
  await click(h, "campaign-run-cancel");
  h.runs.set(runId, { ...storedRun, version: 7 });
  await click(h, "campaign-run-cancel-submit");
  assert.deepEqual(runWrites(h), [
    { path: `/api/campaign-runs/${runId}/cancel`, method: "POST", body: { expected_version: 1 } },
  ]);
  assert.equal(approvalWrites(h).length, 0);
});

test("a successful cancel shows the cancelled count, notes unrecallable sending rows and re-renders the run", async () => {
  const h = await openExecuted();
  await cancelThroughConfirmation(h);
  assert.equal(runReads(h), 1, "the cancel response is rendered without another read");
  assert.equal(
    h.get("campaign-run-status").textContent,
    "실행을 취소했습니다. 대기 중이던 11건을 취소했습니다. 이미 보내는 중이던 12건은 되돌릴 수 없습니다.",
  );
  assert.deepEqual(pairs(h.get("campaign-run-summary"))[0], ["상태", "취소됨"]);
  assert.deepEqual(pairs(h.get("campaign-run-deliveries"))[0], ["대기", "0건"]);
  assert.equal(h.get("campaign-run-cancel").hidden, true);
  assert.equal(h.get("campaign-run-confirm").hidden, true);
  assert.equal(h.get("campaign-run-title").focused, true);
  assert.equal(h.controller.hasChanges(), false);

  const quiet = await adminDraft(undefined, [executedApproval]);
  quiet.runs.set(runId, { ...storedRun, delivery_counts: { ...storedRun.delivery_counts, sending: "0" } });
  await openSaved(quiet);
  await cancelThroughConfirmation(quiet);
  assert.equal(quiet.get("campaign-run-status").textContent, "실행을 취소했습니다. 대기 중이던 11건을 취소했습니다.");
});

for (const [code, status, pattern] of [
  ["campaign_run_conflict", "running", /다른 곳에서 실행 상태가 바뀌었습니다/],
  ["campaign_run_cancelled", "cancelled", /이미 취소된 실행/],
  ["campaign_run_completed", "completed", /이미 완료된 실행/],
] as const)
  test(`a ${code} refusal re-renders from the run it carries`, async () => {
    const h = await openExecuted();
    h.runs.set(runId, {
      ...storedRun,
      status,
      version: 2,
      cancelled_at: status === "cancelled" ? "2026-10-28T11:00:00.000000Z" : null,
      delivery_counts: { ...storedRun.delivery_counts, failed: "40" },
    });
    await cancelThroughConfirmation(h);
    assert.equal(runReads(h), 1, "the carried run is rendered without another read");
    assert.match(h.get("campaign-run-status").textContent, pattern);
    assert.deepEqual(pairs(h.get("campaign-run-deliveries"))[3], ["실패", "40건"]);
    assert.equal(h.get("campaign-run-confirm").hidden, true);
    assert.equal(h.get("campaign-run-title").focused, true, "focus leaves the hidden confirmation");
    assert.equal(h.get("campaign-run-cancel").hidden, status !== "running");
    assert.equal(h.controller.hasChanges(), false);
    if (status === "running") {
      // The next cancel uses the version the conflict carried.
      await cancelThroughConfirmation(h);
      assert.deepEqual(runWrites(h)[1]!.body, { expected_version: 2 });
      assert.deepEqual(pairs(h.get("campaign-run-summary"))[0], ["상태", "취소됨"]);
    }
  });

test("a refusal without a usable run reads the run again", async () => {
  const h = await openExecuted(async (path) => {
    if (path.endsWith("/cancel")) throw { status: 409, code: "campaign_run_conflict" };
  });
  await cancelThroughConfirmation(h);
  assert.equal(runReads(h), 2);
  assert.equal(runShown(h), true);
  assert.equal(h.get("campaign-run-title").focused, true, "focus leaves the hidden confirmation");
  assert.match(h.get("campaign-run-status").textContent, /다른 곳에서 실행 상태가 바뀌었습니다/);
});

test("a refusal notice is not restored over a newer run read started by an approval reload", async () => {
  const gate = deferred();
  let reads = 0;
  const h = await openExecuted(async (path) => {
    if (path.endsWith("/cancel")) throw { status: 409, code: "campaign_run_conflict" };
    if (path === `/api/campaign-runs/${runId}` && ++reads === 2) return gate.promise;
  });
  await click(h, "campaign-run-cancel");
  const pending = click(h, "campaign-run-cancel-submit");
  await draftSettle();
  assert.equal(runReads(h), 2, "the fallback read is pending");
  assert.equal(h.get("campaign-approval-refresh").disabled, false);
  await click(h, "campaign-approval-refresh");
  await draftSettle();
  assert.equal(runReads(h), 3);
  assert.equal(h.get("campaign-run-status").textContent, "", "the newer read rendered the current run");
  gate.resolve({ ...storedRun });
  await pending;
  await draftSettle();
  assert.equal(h.get("campaign-run-status").textContent, "", "the stale fallback does not restore its notice");
  assert.equal(runShown(h), true);
});

test("an unknown or throttled cancel allows only the same request again and blocks leaving the draft", async () => {
  let attempt = 0;
  const h = await openExecuted(async (path) => {
    if (!path.endsWith("/cancel")) return;
    attempt++;
    if (attempt === 1) throw new Error("network lost");
    if (attempt === 2) throw { status: 503, code: "unavailable" };
    if (attempt === 3) throw { status: 429, code: "rate_limited" };
  });
  await cancelThroughConfirmation(h);
  assert.match(h.get("campaign-run-status").textContent, /같은 요청 재시도/);
  assert.equal(h.get("campaign-run-cancel-submit").textContent, "같은 요청 재시도");
  assert.equal(h.get("campaign-run-cancel-back").hidden, true, "an unresolved request cannot be abandoned");
  assert.equal(h.get("campaign-run-confirm").hidden, false);
  assert.match(h.get("campaign-run-confirm-summary").allText(), /11건/, "the retry still shows what it sends");
  assert.equal(h.controller.hasChanges(), true);
  assert.equal(h.get("campaign-draft-new").disabled, true);
  assert.equal(h.get("campaign-approval-refresh").disabled, true);
  // Neither a draft switch, a new draft, an approval reload nor a zone change can drop or alter the request.
  const requests = h.requests.length;
  await openSaved(h);
  await h.get("campaign-draft-new").dispatch("click");
  await click(h, "campaign-approval-refresh");
  h.controller.timeZoneChanged("UTC");
  await draftSettle();
  assert.equal(h.requests.length, requests);
  assert.equal(h.get("campaign-run-cancel-submit").textContent, "같은 요청 재시도");
  // A refresh shows the current server state, here a newer version, but keeps the frozen request and its version.
  h.runs.set(runId, { ...storedRun, version: 5 });
  await click(h, "campaign-run-refresh");
  assert.equal(runShown(h), true);
  assert.equal(h.get("campaign-run-cancel-submit").textContent, "같은 요청 재시도");
  await click(h, "campaign-run-cancel-submit");
  assert.match(h.get("campaign-run-status").textContent, /같은 요청 재시도/);
  await click(h, "campaign-run-cancel-submit");
  assert.match(h.get("campaign-run-status").textContent, /요청이 많습니다/);
  await click(h, "campaign-run-cancel-submit");
  const writes = runWrites(h);
  assert.equal(writes.length, 4);
  for (const write of writes) assert.deepEqual(write, writes[0]);
  assert.deepEqual(writes[0]!.body, { expected_version: 1 });
  // The retry resolves as a conflict that carries the newer run; only a new confirmation can use its version.
  assert.match(h.get("campaign-run-status").textContent, /다른 곳에서 실행 상태가 바뀌었습니다/);
  assert.equal(h.controller.hasChanges(), false);
  assert.equal(h.get("campaign-draft-new").disabled, false);
  await cancelThroughConfirmation(h);
  assert.deepEqual(runWrites(h)[4]!.body, { expected_version: 5 });
  assert.deepEqual(pairs(h.get("campaign-run-summary"))[0], ["상태", "취소됨"]);
});

test("a malformed cancel response stays an unknown outcome with the same retry", async () => {
  let attempt = 0;
  const h = await openExecuted(async (path) => {
    if (path.endsWith("/cancel") && ++attempt === 1) return { id: runId, status: "cancelled" };
  });
  await cancelThroughConfirmation(h);
  assert.equal(h.get("campaign-run-cancel-submit").textContent, "같은 요청 재시도");
  assert.deepEqual(pairs(h.get("campaign-run-summary"))[0], ["상태", "진행 중"], "nothing partial is rendered");
  await click(h, "campaign-run-cancel-submit");
  assert.deepEqual(runWrites(h)[1], runWrites(h)[0]);
  assert.deepEqual(pairs(h.get("campaign-run-summary"))[0], ["상태", "취소됨"]);
});

test("a cancel success whose run is not cancelled stays an unknown outcome with the same retry", async () => {
  let attempt = 0;
  const h = await openExecuted(async (path) => {
    if (path.endsWith("/cancel") && ++attempt === 1)
      return { ...structuredClone(storedRun), cancelled_delivery_count: "0", sending_recalled: false };
  });
  await cancelThroughConfirmation(h);
  assert.equal(h.get("campaign-run-cancel-submit").textContent, "같은 요청 재시도");
  assert.doesNotMatch(h.get("campaign-run-status").textContent, /실행을 취소했습니다/);
  await click(h, "campaign-run-cancel-submit");
  assert.deepEqual(runWrites(h)[1], runWrites(h)[0]);
  assert.deepEqual(pairs(h.get("campaign-run-summary"))[0], ["상태", "취소됨"]);
});

test("a late run read is discarded after a new draft, a draft switch, an approval reload, a reset or a workspace change", async () => {
  for (const leave of ["new draft", "draft switch", "newer read", "reset", "workspace change"] as const) {
    const gate = deferred();
    let reads = 0;
    const h = await adminDraft(
      async (path) => {
        if (path === `/api/campaign-runs/${runId}` && ++reads === 2) return gate.promise;
      },
      [executedApproval],
    );
    await openSaved(h);
    const pending = click(h, "campaign-run-refresh");
    if (leave === "new draft") await h.get("campaign-draft-new").dispatch("click");
    else if (leave === "draft switch") await openSaved(h);
    else if (leave === "newer read") {
      // The run refresh stays disabled while its read is pending; reading the approval again starts a newer run read.
      assert.equal(h.get("campaign-run-refresh").disabled, true);
      h.runs.set(runId, { ...storedRun, delivery_counts: { ...storedRun.delivery_counts, sent: "99" } });
      await click(h, "campaign-approval-refresh");
      assert.equal(runReads(h), 3);
    } else if (leave === "reset") h.controller.reset();
    else h.controller.configure("admin", "workspace-b", "Asia/Seoul");
    gate.resolve({ ...storedRun, delivery_counts: { ...storedRun.delivery_counts, sent: "1234" } });
    await pending;
    await draftSettle();
    assert.doesNotMatch(runText(h), /1,234건/, leave);
    if (leave === "newer read" || leave === "draft switch") assert.equal(runShown(h), true, leave);
    if (leave === "newer read") assert.deepEqual(pairs(h.get("campaign-run-deliveries"))[2], ["보냄", "99건"]);
    if (leave === "new draft" || leave === "reset" || leave === "workspace change") {
      assert.equal(h.get("campaign-run").hidden, true, leave);
      assert.equal(runShown(h), false, leave);
    }
  }
});

test("a run response for another run id is discarded", async () => {
  const h = await openExecuted(async (path) => {
    if (path === `/api/campaign-runs/${runId}`) return { ...storedRun, id: "88888888-8888-4888-8888-888888888888" };
  });
  assert.equal(runShown(h), false);
  assert.match(h.get("campaign-run-status").textContent, /다른 실행의 응답/);
  assert.equal(h.get("campaign-run-cancel").hidden, true);
});

test("a cancel that completes after a session reset is discarded", async () => {
  const gate = deferred();
  const h = await openExecuted(async (path) => {
    if (path.endsWith("/cancel")) return gate.promise;
  });
  await click(h, "campaign-run-cancel");
  const pending = click(h, "campaign-run-cancel-submit");
  assert.equal(h.get("campaign-run-cancel-submit").getAttribute("aria-busy"), "true");
  assert.equal(h.get("campaign-draft-new").disabled, true, "a cancel in flight keeps the draft open");
  h.controller.reset();
  gate.resolve({ ...storedRun, status: "cancelled", version: 2, cancelled_delivery_count: "11" });
  await pending;
  assert.equal(runShown(h), false);
  assert.equal(h.get("campaign-run-status").textContent, "");
  assert.equal(h.get("campaign-drafts-section").hidden, true);
  assert.equal(h.controller.hasChanges(), false);
});

test("a failed run read says so, offers the refresh and no cancel", async () => {
  let fail = true;
  const h = await openExecuted(async (path) => {
    if (fail && path === `/api/campaign-runs/${runId}`) throw { status: 500, code: "internal" };
  });
  assert.equal(runShown(h), false);
  assert.match(h.get("campaign-run-status").textContent, /실행 현황을 불러오지 못했습니다/);
  assert.equal(h.get("campaign-run-cancel").hidden, true);
  assert.equal(h.get("campaign-run-refresh").disabled, false);
  fail = false;
  await click(h, "campaign-run-refresh");
  assert.equal(runShown(h), true);
  assert.equal(h.get("campaign-run-status").textContent, "");
});

test("a run read or cancel refused by role clears protected campaign data", async () => {
  for (const target of ["read", "cancel"] as const) {
    const h = await adminDraft(
      async (path) => {
        if (target === "read" ? path === `/api/campaign-runs/${runId}` : path.endsWith("/cancel"))
          throw { status: 403, code: "role_forbidden" };
      },
      [executedApproval],
    );
    await openSaved(h);
    if (target === "cancel") await cancelThroughConfirmation(h);
    assert.equal(h.get("campaign-drafts-section").hidden, true, target);
    assert.equal(runShown(h), false, target);
  }
});

test("an executed approval carried by a refused approval write reads its run", async () => {
  const h = await adminDraft(
    async (path) => {
      if (path === `/api/campaign-approvals/${approvalId}/cancel`)
        throw { status: 409, code: "campaign_approval_executed", approval: executedApproval };
    },
    [storedApproval],
  );
  await openSaved(h);
  assert.equal(runReads(h), 0);
  await click(h, "campaign-approval-cancel");
  assert.equal(runReads(h), 1);
  assert.equal(runShown(h), true);
});

test("the run panel markup sits inside the approval area, keeps its status live and never says sendable", () => {
  const html = readFileSync(new URL("../../public/app/index.html", import.meta.url), "utf8");
  const area = html.indexOf('id="campaign-approval"');
  const start = html.indexOf('id="campaign-run"');
  assert.ok(area >= 0 && start > area && start < html.indexOf("</section>", area), "the panel is in the approval area");
  const panel = html.slice(start, html.indexOf('class="campaign-approval-schedule"', start));
  assert.match(panel, /id="campaign-run-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(panel, /<dl id="campaign-run-deliveries"/);
  for (const id of [
    "campaign-run-refresh",
    "campaign-run-cancel",
    "campaign-run-cancel-submit",
    "campaign-run-cancel-back",
  ])
    assert.match(panel, new RegExp(`<button id="${id}" type="button"`));
  // The formatter may break these sentences at any space.
  assert.match(panel, /모든\s+행은\s+보내기\s+직전에\s+조건을\s+다시\s+확인하며/);
  assert.match(panel, /서비스\s+전체\s+발송이\s+켜져\s+있을\s+때만/);
  assert.match(panel, /보냄은\s+Meta가\s+요청을\s+받았다는\s+뜻일\s+뿐\s+상대가\s+읽었다는\s+뜻은\s+아닙니다/);
  assert.match(panel, /결과\s+불명은[^.]*자동으로\s+다시\s+보내지\s+않습니다/);
  assert.match(panel, /대기\s+중인\s+행은\s+모두\s+취소/);
  assert.match(panel, /이미\s+보내는\s+중인\s+행은\s+되돌릴\s+수\s+없/);
  assert.doesNotMatch(panel, /발송\s*가능/);
  const script = readFileSync(new URL("../../public/app/campaign-drafts.js", import.meta.url), "utf8");
  assert.doesNotMatch(script, /setInterval|setTimeout/, "the run is never polled");
});
