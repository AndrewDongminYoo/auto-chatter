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
  constructor(text = "") {
    this.textContent = text;
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
  setAttribute() {}
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
  const controller = context.createCampaignDrafts({ api, node: (_tag: string, text = "") => new DraftElement(text) });
  return {
    controller,
    get,
    fields,
    form,
    writes,
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
