import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dmTriggersOverlap,
  flowReferences,
  parseFlowDocument,
  validateFlowForPublish,
  type FlowNode,
  type PublishContext,
} from "./flow-schema.ts";
import { flowExecutionErrors, matchesFlowTrigger, planFlowRun } from "./flow-runtime.ts";
import { dmPlan } from "../instagram/dm-start-trigger.ts";

// Publish rules of DM start triggers (#33): trigger configs, the DM-flow node set, overlap with other enabled DM
// flows, and comment flows unchanged.
const connection = "11111111-1111-4111-8111-111111111111";
const field = "22222222-2222-4222-8222-222222222222";

function context(overrides: Partial<PublishContext> = {}): PublishContext {
  return {
    connection: { id: connection, active: true, oauth: true },
    fields: new Map([[field, "text"]]),
    endpoints: new Set(),
    replyFields: new Set(),
    webhookFields: new Set(),
    legacyRuleEnabled: false,
    otherFlowPublished: false,
    ...overrides,
  };
}

const keyword = (config: Record<string, unknown> = {}, id = "start"): FlowNode => ({
  id,
  type: "instagram_dm_keyword",
  config: { connection_id: connection, keywords: ["price"], match_mode: "contains", excluded_keywords: [], ...config },
});
const fallback = (id = "start"): FlowNode => ({
  id,
  type: "instagram_dm_default",
  config: { connection_id: connection },
});

function dmFlow(start: FlowNode, text = "Thanks for your message", extra: unknown[] = [], extraEdges: unknown[] = []) {
  return {
    schema_version: 1,
    nodes: [start, { id: "m", type: "instagram_message", config: { text } }, ...extra],
    edges: [{ from: "start", port: "next", to: "m" }, ...extraEdges],
  };
}

const codes = (input: unknown, ctx = context()) => validateFlowForPublish(input, ctx).map((error) => error.code);

test("a DM keyword or default-reply flow of the trigger and one message publishes", () => {
  assert.deepEqual(codes(dmFlow(keyword())), []);
  assert.deepEqual(codes(dmFlow(keyword({ match_mode: "exact", excluded_keywords: ["no"] }))), []);
  assert.deepEqual(codes(dmFlow(fallback())), []);
  assert.deepEqual(codes(dmFlow(keyword({ match_mode: "all", keywords: [], excluded_keywords: ["refund"] }))), []);
});

test("a DM keyword trigger needs keywords unless its mode is all; the default trigger names only its connection", () => {
  assert.deepEqual(codes(dmFlow(keyword({ match_mode: "any" }))), ["invalid_config"]);
  assert.deepEqual(codes(dmFlow(keyword({ keywords: [] }))), ["invalid_config"]);
  assert.deepEqual(codes(dmFlow(keyword({ match_mode: "exact", keywords: [] }))), ["invalid_config"]);
  assert.deepEqual(codes(dmFlow(keyword({ media_id: "1789" }))), ["invalid_config"]);
  assert.deepEqual(codes(dmFlow({ ...fallback(), config: { connection_id: connection, keywords: ["x"] } })), [
    "invalid_config",
  ]);
  assert.deepEqual(codes(dmFlow(fallback()), context({ connection: null })), ["connection_unavailable"]);
});

test("a DM flow refuses variables, waits, delays, contact steps and webhooks", () => {
  assert.deepEqual(codes(dmFlow(keyword(), "You said {{comment.text}}")), ["dm_trigger_unsupported_variable"]);
  assert.deepEqual(codes(dmFlow(keyword(), `Hi {{field:${field}}}`)), ["dm_trigger_unsupported_variable"]);
  const after = (node: unknown) => codes(dmFlow(keyword(), "Hi", [node], [{ from: "m", port: "next", to: "x" }]));
  assert.ok(
    after({ id: "x", type: "wait_for_reply", config: { timeout_minutes: 60 } }).includes("dm_trigger_unsupported_node"),
  );
  const before = (node: unknown) =>
    codes({
      schema_version: 1,
      nodes: [keyword(), node, { id: "m", type: "instagram_message", config: { text: "Hi" } }],
      edges: [
        { from: "start", port: "next", to: "x" },
        { from: "x", port: "next", to: "m" },
      ],
    });
  for (const node of [
    { id: "x", type: "delay", config: { minutes: 5 } },
    { id: "x", type: "wait_until", config: { time: "09:00" } },
    { id: "x", type: "add_tag", config: { tag: "lead" } },
    { id: "x", type: "set_field", config: { field_id: field, value: "a" } },
  ])
    assert.deepEqual(before(node), ["dm_trigger_unsupported_node"], node.type);
});

test("a flow has exactly one trigger of any type, and nothing leads into a DM trigger", () => {
  const both = dmFlow(keyword());
  both.nodes.push(fallback("other"));
  assert.ok(codes(both).includes("trigger_count"));
  const looped = dmFlow(keyword());
  looped.edges.push({ from: "m", port: "next", to: "start" });
  assert.ok(codes(looped).includes("trigger_has_incoming"));
});

test("overlap: two default triggers, equal exact keywords, and contained keywords", () => {
  assert.equal(dmTriggersOverlap(fallback(), fallback("b")), true);
  assert.equal(dmTriggersOverlap(fallback(), keyword()), false);
  const exact = (keywords: string[]) => keyword({ match_mode: "exact", keywords }, "b");
  const contains = (keywords: string[]) => keyword({ keywords }, "b");
  assert.equal(dmTriggersOverlap(exact(["Price"]), exact([" price "])), true);
  assert.equal(dmTriggersOverlap(exact(["price"]), exact(["prices"])), false);
  assert.equal(dmTriggersOverlap(exact(["price list"]), contains(["price"])), true);
  assert.equal(dmTriggersOverlap(contains(["price"]), exact(["price list"])), true);
  assert.equal(dmTriggersOverlap(exact(["pri"]), contains(["price"])), false);
  assert.equal(dmTriggersOverlap(contains(["price"]), contains(["PRICES"])), true);
  assert.equal(dmTriggersOverlap(contains(["price"]), contains(["shipping"])), false);
  // Excluded keywords do not separate two triggers.
  assert.equal(
    dmTriggersOverlap(contains(["price"]), keyword({ keywords: ["price"], excluded_keywords: ["x"] })),
    true,
  );
  // An all trigger, even with no keywords and with exclusions, overlaps every keyword trigger but no default one.
  const all = keyword({ match_mode: "all", keywords: [], excluded_keywords: ["shipping"] });
  assert.equal(dmTriggersOverlap(all, contains(["shipping"])), true);
  assert.equal(dmTriggersOverlap(exact(["price"]), all), true);
  assert.equal(dmTriggersOverlap(all, keyword({ match_mode: "all", keywords: [] }, "b")), true);
  assert.equal(dmTriggersOverlap(all, fallback("b")), false);
});

test("an all DM trigger matches every DM except its excluded keywords", () => {
  const parsed = parseFlowDocument(dmFlow(keyword({ match_mode: "all", keywords: [], excluded_keywords: ["refund"] })));
  assert.ok("document" in parsed);
  assert.equal(matchesFlowTrigger(parsed.document, "hello"), true);
  assert.equal(matchesFlowTrigger(parsed.document, "I want a REFUND"), false);
});

test("publish refuses a trigger that overlaps another enabled DM flow on the connection", () => {
  const errors = (start: FlowNode, others: FlowNode[]) =>
    validateFlowForPublish(dmFlow(start), context({ dmTriggers: others }));
  assert.deepEqual(errors(fallback(), [fallback("b")]), [
    { code: "dm_default_conflict", node_id: "start", path: "nodes[0].config" },
  ]);
  assert.deepEqual(errors(keyword(), [keyword({ keywords: ["price"] }, "b")]), [
    { code: "dm_keyword_conflict", node_id: "start", path: "nodes[0].config.keywords" },
  ]);
  assert.deepEqual(errors(keyword(), [fallback("b"), keyword({ keywords: ["shipping"] }, "c")]), []);
  assert.deepEqual(errors(fallback(), [keyword({}, "b")]), []);
});

test("DM triggers run: references, matching and the walk to one message", () => {
  const parsed = parseFlowDocument(dmFlow(keyword({ keywords: ["price"], excluded_keywords: ["refund"] })));
  assert.ok("document" in parsed);
  assert.deepEqual(flowReferences(parsed.document), {
    trigger_type: "instagram_dm_keyword",
    connection_id: connection,
    media_id: null,
    field_ids: [],
    endpoint_ids: [],
  });
  assert.deepEqual(flowExecutionErrors(parsed.document, new Map()), []);
  assert.equal(matchesFlowTrigger(parsed.document, "What is the PRICE?"), true);
  assert.equal(matchesFlowTrigger(parsed.document, "price refund"), false);
  assert.equal(matchesFlowTrigger(parsed.document, "hello"), false);
  const plan = planFlowRun(
    parsed.document,
    { tags: new Set(), fields: new Map() },
    { commentText: "", writableFields: new Set() },
  );
  assert.equal(plan.status, "message");
  assert.deepEqual(plan.steps, [
    { node_id: "start", node_type: "instagram_dm_keyword", outcome: "next" },
    { node_id: "m", node_type: "instagram_message", outcome: "queued" },
  ]);
  const fallbackFlow = parseFlowDocument(dmFlow(fallback()));
  assert.ok("document" in fallbackFlow);
  assert.equal(matchesFlowTrigger(fallbackFlow.document, "anything at all"), true);
});

test("a stored DM version with a message variable fails at execution instead of rendering it empty", () => {
  const plain = parseFlowDocument(dmFlow(keyword()));
  assert.ok("document" in plain);
  assert.equal(dmPlan(plain.document).status, "message");
  for (const text of ["Echo: {{comment.text}}", `Hi {{field:${field}}}`, "Hi }}"]) {
    const parsed = parseFlowDocument(dmFlow(keyword(), text));
    assert.ok("document" in parsed, text);
    const plan = dmPlan(parsed.document);
    assert.equal(plan.status, "failed", text);
    assert.equal(plan.status === "failed" && plan.failure_code, "unsupported_node", text);
    assert.deepEqual(plan.steps, [], text);
  }
});

test("comment flows keep their references, validation and conflicts", () => {
  const comment = {
    schema_version: 1,
    nodes: [
      {
        id: "start",
        type: "instagram_comment",
        config: {
          connection_id: connection,
          media_id: "1789",
          keywords: ["link"],
          match_mode: "contains",
          excluded_keywords: [],
        },
      },
      { id: "m", type: "instagram_message", config: { text: "Hi {{comment.text}}" } },
      { id: "w", type: "delay", config: { minutes: 5 } },
    ],
    edges: [
      { from: "start", port: "next", to: "w" },
      { from: "w", port: "next", to: "m" },
    ],
  };
  assert.deepEqual(codes(comment), []);
  // Enabled DM flows on the same connection never conflict with a comment flow.
  assert.deepEqual(codes(comment, context({ dmTriggers: [fallback("b"), keyword({}, "c")] })), []);
  assert.deepEqual(codes(comment, context({ otherFlowPublished: true })), ["flow_trigger_conflict"]);
  const parsed = parseFlowDocument(comment);
  assert.ok("document" in parsed);
  assert.equal(flowReferences(parsed.document).media_id, "1789");
  assert.equal(flowReferences(parsed.document).trigger_type, "instagram_comment");
});
