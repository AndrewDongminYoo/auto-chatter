import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { flowExecutionErrors, planFlowRun } from "./flow-runtime.ts";
import { validateFlowForPublish, type FlowDocument, type FlowError, type PublishContext } from "./flow-schema.ts";

type Doc = FlowDocument;
type Item =
  | { kind: "step"; id: string; branches: { port: string; items: Item[] }[] }
  | { kind: "link"; id: string; from: string; port: string }
  | { kind: "empty"; from: string; port: string };
interface FlowModel {
  flowTypes(): string[];
  flowPorts(type: string): string[];
  flowTypeLabel(type: string): string;
  flowPortLabel(port: string): string;
  flowConfig(type: string, values: Record<string, unknown>): Record<string, unknown>;
  flowTypedNumber(text: string): number | string;
  flowLines(text: string): string[];
  flowStoredList(value: unknown): unknown[];
  flowSlotTypes(document: Doc, from: string, port: string): string[];
  flowLinkTargets(document: Doc, from: string): string[];
  flowAddTrigger(document: Doc, config: Record<string, unknown>): { document: Doc; id: string };
  flowInsert(
    document: Doc,
    from: string,
    port: string,
    type: string,
    config: Record<string, unknown>,
  ): { document: Doc; id: string };
  flowConnect(document: Doc, from: string, port: string, to: string): Doc;
  flowDisconnect(document: Doc, from: string, port: string): Doc;
  flowRemove(document: Doc, id: string): Doc;
  flowChildCount(document: Doc, id: string): number;
  flowRemovable(document: Doc, id: string): boolean;
  flowOutline(document: Doc): { trigger: string | null; steps: Item[]; unreachable: Item[][] };
  flowStepNumbers(outline: unknown): Record<string, number>;
  flowLayout(document: Doc): {
    nodes: { id: string; layer: number; row: number; reachable: boolean; x: number; y: number }[];
    edges: { from: string; to: string; port: string; x1: number; y1: number; x2: number; y2: number }[];
    width: number;
    height: number;
  };
  flowSummary(
    node: Doc["nodes"][number],
    names: Record<"field" | "endpoint" | "connection", (id: string) => string | null>,
  ): string;
  flowErrorMessage(code: string): string;
  flowKnownError(code: string): boolean;
  flowPlaceErrors(
    document: Doc,
    errors: FlowError[],
  ): { placed: { node_id: string; code: string; message: string }[]; general: { code: string; message: string }[] };
  flowTestStatus(status: string): string;
  flowFailureMessage(code: string | null): string;
  flowOutcome(outcome: string): string;
  flowWaitText(wait: Record<string, unknown>): string;
  flowPathIds(steps: { node_id: string }[]): string[];
  flowPathEdges(steps: { node_id: string; node_type: string; outcome: string }[]): string[];
  flowSameDocument(left: unknown, right: unknown): boolean;
  flowStepLabels(document: Doc | null | undefined): (id: string) => string;
  flowErrorsElsewhere(
    document: Doc | null | undefined,
    errors: FlowError[],
    source: string,
  ): { code: string; message: string }[];
  flowFieldDefault(field: { type: string } | undefined): unknown;
  flowUnavailableFieldIds(ids: unknown[] | undefined, fields: { id: string }[]): string[];
  flowCheckedFieldIds(boxes: { value: string; checked: boolean }[]): string[];
}

// public/app/flow-editor-model.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/flow-editor-model.js", import.meta.url), "utf8"), context);
const model = context as unknown as FlowModel;
// Values built in the vm context have that realm's prototypes; a JSON round trip makes them comparable.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const connection = "11111111-1111-4111-8111-111111111111";
const textField = "22222222-2222-4222-8222-222222222222";
const numberField = "33333333-3333-4333-8333-333333333333";
const endpoint = "44444444-4444-4444-8444-444444444444";
const empty: Doc = { schema_version: 1, nodes: [], edges: [] };

function publishContext(): PublishContext {
  return {
    connection: { id: connection, active: true, oauth: true },
    fields: new Map([
      [textField, "text"],
      [numberField, "number"],
    ]),
    endpoints: new Set([endpoint]),
    replyFields: new Set(),
    webhookFields: new Set(),
    legacyRuleEnabled: false,
    otherFlowPublished: false,
  };
}

function triggerDoc(): { document: Doc; id: string } {
  return model.flowAddTrigger(
    empty,
    model.flowConfig("instagram_comment", {
      connection_id: connection,
      media_id: "1789",
      keywords: ["link"],
      match_mode: "contains",
      excluded_keywords: [],
    }),
  );
}

test("the offered types are the executable types with the ports of the schema", () => {
  const runtime = source("./flow-runtime.ts");
  const executable = /const EXECUTABLE_TYPES = new Set\(\[([^\]]*)\]\)/.exec(runtime)![1]!;
  const types = [...executable.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(plain(model.flowTypes()).sort(), [...types].sort());
  assert.ok(!model.flowTypes().includes("follows_account"));
  const ports = /const PORTS: Record<string, string\[\]> = \{([^}]*)\}/.exec(source("./flow-schema.ts"))![1]!;
  // Every schema type, offered or not, so a saved follows_account node keeps both branches in the outline.
  const schemaTypes = [...ports.matchAll(/(\w+): \[([^\]]*)\]/g)];
  assert.ok(schemaTypes.length >= 12, `found ${schemaTypes.length} schema types`);
  for (const [, type, list] of schemaTypes)
    assert.deepEqual(
      plain(model.flowPorts(type!)),
      [...list!.matchAll(/"(\w+)"/g)].map((match) => match[1]),
      type,
    );
  for (const type of model.flowTypes()) assert.doesNotMatch(model.flowTypeLabel(type), /[a-z_]/, type);
  for (const port of ["next", "true", "false", "replied", "timeout"])
    assert.doesNotMatch(model.flowPortLabel(port), /[a-z_]/, port);
});

test("a document built with the editor operations passes the publish and execution checks", () => {
  let { document, id: trigger } = triggerDoc();
  const add = (from: string, port: string, type: string, values: Record<string, unknown>) => {
    assert.ok(model.flowSlotTypes(document, from, port).includes(type), `${type} after ${from}.${port}`);
    const added = model.flowInsert(document, from, port, type, model.flowConfig(type, values));
    document = added.document;
    return added.id;
  };
  const condition = add(trigger, "next", "has_tag", { tag: "VIP" });
  const tagged = add(condition, "true", "add_tag", { tag: "flow" });
  const untagged = add(tagged, "next", "remove_tag", { tag: "old" });
  const stored = add(untagged, "next", "set_field", { field_id: numberField, value: 3 });
  const compare = add(stored, "next", "field_equals", { field_id: numberField, field_operator: "eq", field_value: 3 });
  const unset = add(compare, "false", "field_equals", { field_id: textField, field_operator: "is_unset" });
  const delay = add(compare, "true", "delay", { minutes: 30 });
  const until = add(delay, "next", "wait_until", { time: "09:30" });
  const webhook = add(until, "next", "webhook", {
    endpoint_id: endpoint,
    field_ids: [numberField],
    include_tags: true,
  });
  const message = add(webhook, "next", "instagram_message", {
    text: "안녕하세요 {{comment.text}} {{field:" + numberField + "}}",
  });
  const wait = add(message, "next", "wait_for_reply", { timeout_minutes: 60, save_field_id: textField });
  add(wait, "timeout", "add_tag", { tag: "no reply" });
  add(condition, "false", "instagram_message", { text: "다음에 만나요" });
  document = plain(document);
  assert.deepEqual(validateFlowForPublish(document, publishContext()), []);
  assert.deepEqual(flowExecutionErrors(document, publishContext().fields), []);
  // Optional keys are left out rather than stored empty.
  assert.deepEqual(plain(model.flowConfig("wait_for_reply", { timeout_minutes: 5, save_field_id: "" })), {
    timeout_minutes: 5,
  });
  assert.deepEqual(plain(model.flowConfig("field_equals", { field_id: textField, field_operator: "is_set" })), {
    field_id: textField,
    field_operator: "is_set",
  });
  assert.ok(!Object.hasOwn(model.flowConfig("instagram_message", { text: "x" }), "button_title"));
  assert.deepEqual(plain(model.flowLines(" a \n\n b\n")), ["a", "b"]);
  assert.equal(unset.length > 0, true);
});

test("the picker offers only types the publish and execution checks accept on that slot", () => {
  let { document, id: trigger } = triggerDoc();
  const atStart = model.flowSlotTypes(document, trigger, "next");
  assert.ok(atStart.includes("instagram_message"));
  assert.ok(!atStart.includes("wait_for_reply"));
  assert.ok(!atStart.includes("instagram_comment"));
  const message = model.flowInsert(document, trigger, "next", "instagram_message", { text: "hi" });
  document = message.document;
  assert.deepEqual(plain(model.flowSlotTypes(document, message.id, "next")), ["wait_for_reply"]);
  const wait = model.flowInsert(document, message.id, "next", "wait_for_reply", { timeout_minutes: 5 });
  document = wait.document;
  for (const port of ["replied", "timeout"]) {
    const types = model.flowSlotTypes(document, wait.id, port);
    assert.ok(!types.includes("instagram_message"), port);
    assert.ok(!types.includes("wait_for_reply"), port);
    assert.ok(types.includes("add_tag"), port);
  }
  const tag = model.flowInsert(document, wait.id, "replied", "add_tag", { tag: "a" });
  document = tag.document;
  assert.ok(!model.flowSlotTypes(document, tag.id, "next").includes("instagram_message"));
  // Between the trigger and the message, a new step must not be a message, which would then lead to a
  // second message rather than to a reply wait.
  const before = model.flowSlotTypes(document, trigger, "next");
  assert.ok(!before.includes("instagram_message"));
  assert.ok(before.includes("delay"));
  // Between a message and its reply wait nothing fits.
  assert.deepEqual(plain(model.flowSlotTypes(document, message.id, "next")), []);
});

test("insert, connect, disconnect and remove keep the edges consistent", () => {
  let { document, id: trigger } = triggerDoc();
  const first = model.flowInsert(document, trigger, "next", "add_tag", { tag: "a" });
  document = first.document;
  const inserted = model.flowInsert(document, trigger, "next", "has_tag", { tag: "b" });
  document = inserted.document;
  assert.deepEqual(plain(document.edges), [
    { from: trigger, port: "next", to: inserted.id },
    { from: inserted.id, port: "true", to: first.id },
  ]);
  assert.ok(!model.flowLinkTargets(document, first.id).includes(inserted.id), "a link must not close a cycle");
  assert.ok(!model.flowLinkTargets(document, inserted.id).includes(trigger));
  assert.ok(!model.flowLinkTargets(document, inserted.id).includes(inserted.id));
  assert.deepEqual(plain(model.flowLinkTargets(document, inserted.id)), [first.id]);
  document = model.flowConnect(document, inserted.id, "false", first.id);
  assert.equal(model.flowChildCount(document, inserted.id), 1);
  document = model.flowDisconnect(document, inserted.id, "false");
  assert.equal(document.edges.length, 2);
  document = model.flowRemove(document, inserted.id);
  assert.deepEqual(plain(document.edges), []);
  assert.deepEqual(
    plain(document.nodes.map((node) => node.id)),
    [trigger, first.id],
    "the steps after a removed node stay, unconnected",
  );
  assert.equal(model.flowChildCount(document, trigger), 0);
  assert.equal(model.flowRemovable(document, first.id), true);
  assert.equal(model.flowRemovable(document, trigger), false, "the only trigger stays");
  assert.equal(model.flowRemovable(document, "missing"), false);
  // New IDs follow the highest s<number>, so a gap left by a deleted step in the middle is not reused.
  const gap: Doc = {
    schema_version: 1,
    nodes: [
      { id: "s1", type: "instagram_comment", config: {} },
      { id: "s7", type: "add_tag", config: {} },
    ],
    edges: [],
  };
  assert.equal(model.flowInsert(gap, "s1", "next", "delay", { minutes: 5 }).id, "s8");
});

test("a saved draft with two comment triggers can be repaired by deleting either one", () => {
  const { document: single } = triggerDoc();
  const [trigger] = single.nodes;
  // A draft save checks only shape, so the API stores a second trigger; publish reports trigger_count.
  const document: Doc = plain({
    ...single,
    nodes: [trigger, { ...trigger, id: "extra" }, { id: "tag", type: "add_tag", config: { tag: "a" } }],
    edges: [{ from: "extra", port: "next", to: "tag" }],
  });
  assert.ok(
    validateFlowForPublish(document, publishContext())
      .map((error) => error.code)
      .includes("trigger_count"),
  );
  assert.equal(model.flowOutline(document).trigger, trigger!.id);
  assert.equal(model.flowRemovable(document, trigger!.id), true);
  assert.equal(model.flowRemovable(document, "extra"), true);
  // Deleting the extra trigger leaves its steps unconnected; deleting the first makes the other the trigger.
  const kept = model.flowRemove(document, "extra");
  assert.equal(model.flowRemovable(kept, trigger!.id), false);
  assert.ok(!validateFlowForPublish(plain(kept), publishContext()).some((error) => error.code === "trigger_count"));
  const swapped = model.flowRemove(document, trigger!.id);
  assert.equal(model.flowOutline(swapped).trigger, "extra");
  assert.equal(model.flowRemovable(swapped, "extra"), false);
});

test("the outline shows a step reached twice once, ends cycles and lists unreachable steps", () => {
  const document: Doc = {
    schema_version: 1,
    nodes: [
      { id: "t", type: "instagram_comment", config: {} },
      { id: "c", type: "has_tag", config: { tag: "x" } },
      { id: "a", type: "add_tag", config: { tag: "a" } },
      { id: "b", type: "remove_tag", config: { tag: "b" } },
      { id: "lost", type: "delay", config: { minutes: 1 } },
      { id: "after", type: "add_tag", config: { tag: "z" } },
    ],
    edges: [
      { from: "t", port: "next", to: "c" },
      { from: "c", port: "true", to: "a" },
      { from: "c", port: "false", to: "a" },
      { from: "a", port: "next", to: "b" },
      { from: "b", port: "next", to: "c" },
      { from: "lost", port: "next", to: "after" },
    ],
  };
  const outline = plain(model.flowOutline(document));
  assert.deepEqual(outline.steps, [
    { kind: "step", id: "t", branches: [] },
    {
      kind: "step",
      id: "c",
      branches: [
        {
          port: "true",
          items: [
            { kind: "step", id: "a", branches: [] },
            { kind: "step", id: "b", branches: [] },
            { kind: "link", id: "c", from: "b", port: "next" },
          ],
        },
        { port: "false", items: [{ kind: "link", id: "a", from: "c", port: "false" }] },
      ],
    },
  ]);
  assert.deepEqual(outline.unreachable, [
    [
      { kind: "step", id: "lost", branches: [] },
      { kind: "step", id: "after", branches: [] },
      { kind: "empty", from: "after", port: "next" },
    ],
  ]);
  assert.deepEqual(plain(model.flowStepNumbers(outline)), { t: 1, c: 2, a: 3, b: 4, lost: 5, after: 6 });
  assert.deepEqual(plain(model.flowOutline(empty)), { trigger: null, steps: [], unreachable: [] });
});

test("a long next chain stays one flat sequence", () => {
  let { document, id: last } = triggerDoc();
  for (let index = 0; index < 60; index++) {
    const added = model.flowInsert(document, last, "next", "add_tag", { tag: `t${index}` });
    document = added.document;
    last = added.id;
  }
  const outline = plain(model.flowOutline(document));
  assert.equal(outline.steps.length, 62);
  assert.ok(outline.steps.slice(0, 61).every((item) => item.kind === "step" && item.branches.length === 0));
  assert.deepEqual(outline.steps.at(-1), { kind: "empty", from: last, port: "next" });
});

test("the layout places steps by depth from the trigger and unreachable steps after the last layer", () => {
  const document: Doc = {
    schema_version: 1,
    nodes: [
      { id: "lost", type: "delay", config: {} },
      { id: "t", type: "instagram_comment", config: {} },
      { id: "c", type: "has_tag", config: {} },
      { id: "a", type: "add_tag", config: {} },
      { id: "b", type: "add_tag", config: {} },
    ],
    edges: [
      { from: "t", port: "next", to: "c" },
      { from: "c", port: "true", to: "a" },
      { from: "c", port: "false", to: "b" },
      { from: "b", port: "next", to: "missing" },
    ],
  };
  const layout = plain(model.flowLayout(document));
  const at = Object.fromEntries(layout.nodes.map((node) => [node.id, [node.layer, node.row, node.reachable]]));
  assert.deepEqual(at, {
    lost: [3, 0, false],
    t: [0, 0, true],
    c: [1, 0, true],
    a: [2, 0, true],
    b: [2, 1, true],
  });
  assert.equal(layout.edges.length, 3, "an edge to a missing step is not drawn");
  const edge = layout.edges.find((candidate) => candidate.to === "b")!;
  const from = layout.nodes.find((node) => node.id === "c")!;
  const to = layout.nodes.find((node) => node.id === "b")!;
  assert.equal(edge.x1 > from.x && edge.x2 === to.x && edge.y2 > to.y, true);
  assert.equal(layout.width, 16 * 2 + 4 * 168 + 3 * 56);
  assert.equal(layout.height, 16 * 2 + 2 * 56 + 24);
  assert.deepEqual(plain(model.flowLayout(empty)), {
    nodes: [],
    edges: [],
    nodeWidth: 168,
    nodeHeight: 56,
    width: 0,
    height: 0,
  });
});

test("every publish and execution error code has a Korean message", () => {
  const codes = new Set([
    ...[...source("./flow-schema.ts").matchAll(/error\("([a-z_]+)"/g)].map((match) => match[1]!),
    ...[...source("./flow-runtime.ts").matchAll(/\bcode: "([a-z_]+)"/g)].map((match) => match[1]!),
    ...[...source("./flows.ts").matchAll(/\bcode: "([a-z_]+)"/g)].map((match) => match[1]!),
  ]);
  assert.ok(codes.size >= 30, `found ${codes.size} codes`);
  for (const code of codes) {
    assert.ok(model.flowKnownError(code), code);
    assert.ok(!model.flowErrorMessage(code).includes(code), code);
  }
  assert.equal(model.flowErrorMessage("new_code"), "확인이 필요한 문제가 있습니다(new_code).");
});

test("every test-run status, failure code and step outcome has a Korean label", () => {
  for (const status of ["not_matched", "ended", "delivering", "failed"])
    assert.doesNotMatch(model.flowTestStatus(status), /[a-z_]/, status);
  const runtime = source("./flow-runtime.ts");
  const failures = new Set([
    ...[...runtime.matchAll(/fail\(node, "([a-z_]+)"\)/g)].map((match) => match[1]!),
    ...[...runtime.matchAll(/failure_code: "([a-z_]+)"/g)].map((match) => match[1]!),
    ...[...runtime.matchAll(/error \?\?= "([a-z_]+)"/g)].map((match) => match[1]!),
    ...[...runtime.matchAll(/\{ error: "([a-z_]+)" \}/g)].map((match) => match[1]!),
    ...[...source("./flows.ts").matchAll(/failure_code = "([a-z_]+)"/g)].map((match) => match[1]!),
  ]);
  assert.ok(failures.size >= 9, `found ${failures.size} failure codes`);
  for (const code of failures) assert.doesNotMatch(model.flowFailureMessage(code), /[a-z_]/, code);
  // Outcomes are literals, String(boolean) of a condition, or the port a reply wait resumes on.
  const outcomes = new Set([
    ...[...runtime.matchAll(/outcome(?: =|:) ([^;,}]*)/g)].flatMap((line) =>
      [...line[1]!.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!),
    ),
    "true",
    "false",
    "replied",
    "timeout",
    ...failures,
  ]);
  assert.ok(outcomes.size >= 20, `found ${outcomes.size} outcomes`);
  for (const outcome of outcomes) assert.doesNotMatch(model.flowOutcome(outcome), /[a-z_]/, outcome);
  assert.equal(model.flowOutcome("new_outcome"), "기타 결과(new_outcome)");
  assert.equal(model.flowFailureMessage(null), "");
  assert.equal(model.flowFailureMessage("new_code"), "기타 실패(new_code)");
});

test("errors are placed on the step they name, edge errors on the edge's end, the rest at the top", () => {
  const document: Doc = {
    schema_version: 1,
    nodes: [
      { id: "t", type: "instagram_comment", config: {} },
      { id: "m", type: "instagram_message", config: {} },
      { id: "w", type: "wait_for_reply", config: {} },
    ],
    edges: [
      { from: "t", port: "next", to: "w" },
      { from: "m", port: "next", to: "gone" },
    ],
  };
  const placed = plain(
    model.flowPlaceErrors(document, [
      { code: "invalid_config", node_id: "m", path: "nodes[1].config" },
      { code: "wait_requires_message", edge_index: 0, path: "edges[0].from" },
      { code: "trigger_has_incoming", edge_index: 0, path: "edges[0].to" },
      { code: "missing_reference", edge_index: 1, path: "edges[1].to" },
      { code: "invalid_node", path: "nodes[2]" },
      { code: "trigger_count", path: "nodes" },
      { code: "immediate_cycle", path: "edges" },
      { code: "connection_unavailable", node_id: "other", path: "nodes" },
    ]),
  );
  assert.deepEqual(
    placed.placed.map((error) => [error.node_id, error.code]),
    [
      ["m", "invalid_config"],
      ["t", "wait_requires_message"],
      ["w", "trigger_has_incoming"],
      ["m", "missing_reference"],
      ["w", "invalid_node"],
    ],
  );
  assert.deepEqual(
    placed.general.map((error) => error.code),
    ["trigger_count", "immediate_cycle", "connection_unavailable"],
  );
  assert.equal(placed.placed[0]!.message, model.flowErrorMessage("invalid_config"));
});

test("summaries, waits and paths read as Korean text", () => {
  const names = {
    field: (id: string) => (id === textField ? "관심사" : null),
    endpoint: (id: string) => (id === endpoint ? "CRM" : null),
    connection: (id: string) => (id === connection ? "shop" : null),
  };
  const summary = (type: string, config: Record<string, unknown>) =>
    model.flowSummary({ id: "x", type, config }, names);
  assert.equal(
    summary("instagram_comment", {
      connection_id: connection,
      media_id: "1789",
      keywords: ["가격", "링크"],
      match_mode: "contains",
      excluded_keywords: ["광고"],
    }),
    "shop · 게시물 1789 · 키워드 포함: 가격, 링크 · 제외 광고",
  );
  assert.equal(summary("instagram_comment", { match_mode: "all" }), "계정 미선택 · 게시물 미입력 · 모든 댓글");
  assert.equal(
    summary("field_equals", { field_id: textField, field_operator: "eq", field_value: "" }),
    "관심사 = 빈 텍스트",
  );
  assert.equal(
    summary("field_equals", { field_id: numberField, field_operator: "is_set" }),
    "사용할 수 없는 필드 값이 있는지",
  );
  assert.equal(summary("set_field", { field_id: textField, value: false }), "관심사에 아니오 저장");
  assert.equal(summary("delay", { minutes: 1500 }), "1일 1시간 기다림");
  assert.equal(summary("delay", { minutes: null }), "시간 미입력 기다림");
  assert.equal(summary("delay", { minutes: "" }), "시간 미입력 기다림");
  for (const minutes of [0, -3, 1.5, "abc"])
    assert.equal(summary("delay", { minutes }), "잘못된 시간 기다림", String(minutes));
  assert.equal(summary("wait_for_reply", { timeout_minutes: 0 }), "잘못된 시간 동안 응답을 기다림");
  assert.equal(
    summary("wait_for_reply", { timeout_minutes: 60, save_field_id: textField }),
    "1시간 동안 응답을 기다림 · 응답을 관심사에 저장",
  );
  assert.equal(
    summary("webhook", { endpoint_id: endpoint, field_ids: [textField], include_tags: true }),
    "CRM로 태그, 관심사 전송",
  );
  assert.equal(
    summary("webhook", { endpoint_id: "x", field_ids: [], include_tags: false }),
    "등록한 주소로 처리 정보만 전송",
  );
  assert.equal(summary("instagram_message", { text: " " }), "메시지 미입력");
  assert.equal(
    model.flowWaitText({ node_type: "delay", delay_minutes: 90 }),
    "1시간 30분 지난 것으로 보고 다음으로 이어 갔습니다.",
  );
  assert.equal(
    model.flowWaitText({ node_type: "wait_until", until_time: "09:00" }),
    "09:00이 된 것으로 보고 다음으로 이어 갔습니다.",
  );
  assert.equal(model.flowWaitText({ node_type: "wait_for_reply", port: "timeout" }), "시간 초과 가지로 이어 갔습니다.");
  assert.deepEqual(plain(model.flowPathIds([{ node_id: "a" }, { node_id: "w" }, { node_id: "w" }, { node_id: "b" }])), [
    "a",
    "w",
    "b",
  ]);
});

test("a test-run path marks the branch it took, not another branch that meets it", () => {
  const { document: start, id: trigger } = triggerDoc();
  let document = start;
  const add = (from: string, port: string, type: string, config: Record<string, unknown>) => {
    const added = model.flowInsert(document, from, port, type, model.flowConfig(type, config));
    document = added.document;
    return added.id;
  };
  // Both branches of the condition and of the reply wait end on the same step.
  const condition = add(trigger, "next", "has_tag", { tag: "vip" });
  const tagged = add(condition, "true", "add_tag", { tag: "flow" });
  const message = add(tagged, "next", "instagram_message", { text: "안녕하세요" });
  const wait = add(message, "next", "wait_for_reply", { timeout_minutes: 60, save_field_id: textField });
  const after = add(wait, "replied", "remove_tag", { tag: "old" });
  document = model.flowConnect(document, wait, "timeout", after);
  document = plain(model.flowConnect(document, condition, "false", message));
  assert.deepEqual(flowExecutionErrors(document, publishContext().fields), []);
  const facts = { tags: new Set(["vip"]), fields: new Map() };
  const input = { commentText: "link", writableFields: new Set([textField]), replyText: "네" };
  // The test-run API runs to the message, then resumes at the reply wait, and joins the steps.
  const first = planFlowRun(document, facts, input);
  assert.equal(first.status, "message");
  const resumed = planFlowRun(document, facts, input, { node_id: wait, port: "replied" });
  const steps = [...first.steps, ...resumed.steps];
  assert.deepEqual(
    steps.map((step) => step.outcome),
    ["next", "true", "added", "queued", "replied", "set", "absent"],
  );
  const edges = plain(model.flowPathEdges(steps));
  assert.deepEqual(edges, [
    `${trigger}:next:${condition}`,
    `${condition}:true:${tagged}`,
    `${tagged}:next:${message}`,
    `${message}:next:${wait}`,
    `${wait}:replied:${after}`,
  ]);
  // Every key names an edge the graph draws, and the branches that did not run stay unmarked.
  const drawn = model.flowLayout(document).edges.map((edge) => `${edge.from}:${edge.port}:${edge.to}`);
  assert.deepEqual(
    drawn.filter((key) => edges.includes(key)),
    edges,
  );
  // Both ends of these branches are on the path, yet the run did not take them.
  const visited = new Set(model.flowPathIds(steps));
  for (const skipped of [`${condition}:false:${message}`, `${wait}:timeout:${after}`]) {
    const [from, , to] = skipped.split(":");
    assert.ok(drawn.includes(skipped) && visited.has(from!) && visited.has(to!), skipped);
    assert.ok(!edges.includes(skipped), skipped);
  }
  // A step with several ports that recorded none of them (a failure) leads nowhere on the path.
  assert.deepEqual(
    plain(
      model.flowPathEdges([
        { node_id: "c", node_type: "has_tag", outcome: "invalid_definition" },
        { node_id: "d", node_type: "add_tag", outcome: "added" },
      ]),
    ),
    [],
  );
});

test("a published version that differs from the draft keeps its own step names and errors", () => {
  const { document: start, id: trigger } = triggerDoc();
  const published = plain(model.flowInsert(start, trigger, "next", "add_tag", { tag: "vip" }).document);
  // Deleting the highest step frees its ID, so the next step the draft adds takes it again.
  const removed = model.flowRemove(published, "s2");
  const draft = model.flowInsert(removed, trigger, "next", "remove_tag", { tag: "vip" });
  assert.equal(draft.id, "s2");
  assert.equal(model.flowSameDocument(published, draft.document), false);
  assert.equal(model.flowStepLabels(published)("s2"), "2. 태그 추가");
  assert.equal(model.flowStepLabels(draft.document)("s2"), "2. 태그 제거");
  assert.equal(model.flowStepLabels(published)("s9"), "없는 단계");
  assert.equal(model.flowStepLabels(null)("s2"), "단계 s2");
  assert.deepEqual(
    plain(
      model.flowErrorsElsewhere(
        published,
        [
          { code: "invalid_config", node_id: "s2", path: "nodes[1].config" },
          { code: "trigger_has_incoming", edge_index: 0, path: "edges[0].to" },
          { code: "trigger_count", path: "nodes" },
        ],
        "발행 버전 v1",
      ),
    ),
    [
      { code: "trigger_count", message: `발행 버전 v1: ${model.flowErrorMessage("trigger_count")}` },
      { code: "invalid_config", message: `발행 버전 v1의 2. 태그 추가: ${model.flowErrorMessage("invalid_config")}` },
      {
        code: "trigger_has_incoming",
        message: `발행 버전 v1의 2. 태그 추가: ${model.flowErrorMessage("trigger_has_incoming")}`,
      },
    ],
  );
  // Without the published document nothing is placed and the step is named by its ID.
  assert.deepEqual(
    plain(
      model.flowErrorsElsewhere(
        null,
        [{ code: "invalid_config", node_id: "s2", path: "nodes[1].config" }],
        "발행 버전",
      ),
    ),
    [{ code: "invalid_config", message: `발행 버전: ${model.flowErrorMessage("invalid_config")}` }],
  );
});

test("documents compare by content whatever the key order the server returns", () => {
  const { document } = triggerDoc();
  const local = model.flowInsert(document, "s1", "next", "add_tag", { tag: "vip" }).document;
  // jsonb orders object keys by length, then bytes; the editor keeps insertion order.
  const reorder = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.length - right.length || (left < right ? -1 : 1))
              .map(([key, item]) => [key, reorder(item)]),
          )
        : value;
  const stored = reorder(plain(local)) as Doc;
  assert.notEqual(JSON.stringify(stored), JSON.stringify(plain(local)));
  assert.equal(model.flowSameDocument(stored, local), true);
  assert.equal(model.flowSameDocument({ ...stored, nodes: [...stored.nodes].reverse() }, local), false);
  assert.equal(model.flowSameDocument(null, local), false);
});

test("a new set-field step stores the value its control shows", () => {
  const booleanField = "55555555-5555-4555-8555-555555555555";
  assert.equal(model.flowFieldDefault({ type: "boolean" }), true);
  assert.equal(model.flowFieldDefault({ type: "number" }), "");
  assert.equal(model.flowFieldDefault(undefined), "");
  const { document, id: trigger } = triggerDoc();
  const added = model.flowInsert(
    document,
    trigger,
    "next",
    "set_field",
    model.flowConfig("set_field", { field_id: booleanField, value: model.flowFieldDefault({ type: "boolean" }) }),
  );
  const context = { ...publishContext(), fields: new Map([[booleanField, "boolean"]]) };
  assert.deepEqual(validateFlowForPublish(plain(added.document), context), []);
  // The value it replaces: an empty text for a yes/no field fails publish.
  const empty = model.flowInsert(document, trigger, "next", "set_field", { field_id: booleanField, value: "" });
  assert.deepEqual(
    validateFlowForPublish(plain(empty.document), context).map((error) => error.code),
    ["invalid_field_value"],
  );
});

test("a cleared or wrong duration is stored as typed and publish names its step", () => {
  assert.equal(model.flowTypedNumber(""), "");
  assert.equal(model.flowTypedNumber("  "), "  ");
  assert.equal(model.flowTypedNumber(" 30 "), 30);
  assert.equal(model.flowTypedNumber("1.5"), 1.5);
  assert.equal(model.flowTypedNumber("-3"), -3);
  assert.equal(model.flowTypedNumber("abc"), "abc");
  // Only a new step, whose values have no duration yet, gets the default.
  assert.deepEqual(plain(model.flowConfig("delay", {})), { minutes: 60 });
  assert.deepEqual(plain(model.flowConfig("wait_for_reply", {})), { timeout_minutes: 1440 });
  assert.deepEqual(plain(model.flowConfig("delay", { minutes: model.flowTypedNumber("") })), { minutes: "" });
  assert.deepEqual(
    plain(model.flowConfig("wait_for_reply", { timeout_minutes: model.flowTypedNumber("0"), save_field_id: "" })),
    { timeout_minutes: 0 },
  );
  const { document: start, id: trigger } = triggerDoc();
  for (const typed of ["", "0", "1.5", "-3"]) {
    const delay = model.flowInsert(
      start,
      trigger,
      "next",
      "delay",
      model.flowConfig("delay", { minutes: model.flowTypedNumber(typed) }),
    );
    const message = model.flowInsert(delay.document, delay.id, "next", "instagram_message", { text: "안녕하세요" });
    const wait = model.flowInsert(
      message.document,
      message.id,
      "next",
      "wait_for_reply",
      model.flowConfig("wait_for_reply", { timeout_minutes: model.flowTypedNumber(typed) }),
    );
    const document = plain(wait.document);
    const errors = validateFlowForPublish(document, publishContext());
    assert.deepEqual(
      errors.map((error) => [error.code, error.node_id]),
      [
        ["invalid_config", delay.id],
        ["invalid_config", wait.id],
      ],
      `typed ${JSON.stringify(typed)}`,
    );
    const { placed, general } = model.flowPlaceErrors(document, errors);
    assert.deepEqual(
      plain(placed).map((error) => error.node_id),
      [delay.id, wait.id],
    );
    assert.deepEqual(plain(general), []);
  }
});

test("a webhook step that names an archived field can be repaired by unchecking it", () => {
  const archived = "66666666-6666-4666-8666-66666666666A";
  const listed = [{ id: textField }, { id: numberField }];
  // Stored spelling and order are kept, listed fields and repeats are left out.
  assert.deepEqual(
    plain(model.flowUnavailableFieldIds([archived, textField.toUpperCase(), archived.toLowerCase()], listed)),
    [archived],
  );
  assert.deepEqual(plain(model.flowUnavailableFieldIds(undefined, listed)), []);
  const { document, id: trigger } = triggerDoc();
  const step = (fieldIds: string[]) =>
    plain(
      model.flowInsert(document, trigger, "next", "webhook", {
        endpoint_id: endpoint,
        field_ids: fieldIds,
        include_tags: false,
      }).document,
    );
  const stored = [archived, textField];
  assert.deepEqual(
    validateFlowForPublish(step(stored), publishContext()).map((error) => error.code),
    ["unknown_field"],
  );
  // The editor's boxes: the unavailable field first, then the listed fields.
  const boxes = (uncheck: string[]) => [
    ...model.flowUnavailableFieldIds(stored, listed).map((value) => ({ value, checked: !uncheck.includes(value) })),
    ...listed.map(({ id }) => ({ value: id, checked: stored.includes(id) })),
  ];
  // Left checked, the field stays and publish still names the step.
  assert.deepEqual(plain(model.flowCheckedFieldIds(boxes([]))), stored);
  // Unchecked, it is gone and the step publishes.
  const repaired = plain(model.flowCheckedFieldIds(boxes([archived])));
  assert.deepEqual(repaired, [textField]);
  assert.deepEqual(validateFlowForPublish(step(repaired), publishContext()), []);
});

test("a saved draft whose list values are not arrays still renders and publish names its step", () => {
  // A draft save checks only the document shape, so these values reach the editor as stored.
  assert.deepEqual(plain(model.flowStoredList(["a", "b"])), ["a", "b"]);
  assert.deepEqual(plain(model.flowStoredList("hello")), ["hello"]);
  assert.deepEqual(plain(model.flowStoredList(5)), [5]);
  for (const value of [undefined, null, true, { a: 1 }]) assert.deepEqual(plain(model.flowStoredList(value)), []);
  const names = { field: () => null, endpoint: () => null, connection: () => "shop" };
  const trigger = {
    id: "n1",
    type: "instagram_comment",
    config: {
      connection_id: connection,
      media_id: "1789",
      keywords: "hello",
      match_mode: "contains",
      excluded_keywords: { spam: true },
    },
  } as unknown as Doc["nodes"][number];
  assert.equal(model.flowSummary(trigger, names), "shop · 게시물 1789 · 키워드 포함: hello");
  // A webhook step that stores one field ID as a string shows it as an unavailable, checked field.
  const archived = "66666666-6666-4666-8666-66666666666A";
  assert.deepEqual(plain(model.flowUnavailableFieldIds(archived as unknown as unknown[], [{ id: textField }])), [
    archived,
  ]);
  assert.deepEqual(plain(model.flowUnavailableFieldIds({} as unknown as unknown[], [{ id: textField }])), []);
  const document: Doc = { schema_version: 1, nodes: [trigger], edges: [] };
  assert.ok(
    validateFlowForPublish(document, publishContext()).some((error) => error.node_id === "n1"),
    "publish names the step that stores a wrong list",
  );
});
