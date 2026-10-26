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
type DraftApi = (path: string, method?: string, body?: Record<string, unknown>) => Promise<unknown>;
function draftHarness(override?: DraftApi) {
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
    if (method === "GET") return savedDraft;
    return { ...savedDraft, ...body, version: 4, archived: path.endsWith("/archive") };
  };
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
  });
  return {
    controller,
    get,
    fields,
    form,
    writes,
    requests,
    refuseDiscard: () => {
      allowDiscard = false;
    },
  };
}
const draftSettle = () => new Promise((resolve) => setImmediate(resolve));
async function adminDraft(override?: DraftApi) {
  const h = draftHarness(override);
  h.controller.configure("admin", "workspace-a", "Asia/Seoul");
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
  const before = h.requests.length;
  h.controller.timeZoneChanged("UTC");
  await draftSettle();
  assert.equal(h.requests.length, before, "a zone change must not reload the draft list");
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
