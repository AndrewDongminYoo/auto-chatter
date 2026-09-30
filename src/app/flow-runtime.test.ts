import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowDocument } from "./flow-schema.ts";
import { flowExecutionErrors, matchesFlowTrigger, planFlowRun } from "./flow-runtime.ts";

const fieldId = "99999999-9999-4999-8999-999999999999";
const noFacts = { tags: new Set<string>(), fields: new Map<string, unknown>() };

function branching(): FlowDocument {
  return {
    schema_version: 1,
    nodes: [
      {
        id: "start",
        type: "instagram_comment",
        config: {
          connection_id: "55555555-5555-4555-8555-555555555555",
          media_id: "1789",
          keywords: ["link"],
          match_mode: "contains",
          excluded_keywords: ["spam"],
        },
      },
      { id: "vip", type: "has_tag", config: { tag: " VIP " } },
      { id: "city", type: "field_equals", config: { field_id: fieldId, field_operator: "eq", field_value: "Seoul" } },
      { id: "vip_reply", type: "instagram_message", config: { text: "VIP link" } },
      { id: "seoul_reply", type: "instagram_message", config: { text: "Seoul link" } },
    ],
    edges: [
      { from: "start", port: "next", to: "vip" },
      { from: "vip", port: "true", to: "vip_reply" },
      { from: "vip", port: "false", to: "city" },
      { from: "city", port: "true", to: "seoul_reply" },
    ],
  };
}

test("branches on normalized tags and typed field values and records the path", () => {
  assert.deepEqual(planFlowRun(branching(), { tags: new Set(["vip"]), fields: new Map() }), {
    status: "message",
    text: "VIP link",
    steps: [
      { node_id: "start", node_type: "instagram_comment", outcome: "next" },
      { node_id: "vip", node_type: "has_tag", outcome: "true" },
      { node_id: "vip_reply", node_type: "instagram_message", outcome: "queued" },
    ],
  });
  const seoul = planFlowRun(branching(), { tags: new Set(), fields: new Map([[fieldId, "Seoul"]]) });
  assert.equal(seoul.status, "message");
  assert.deepEqual(
    seoul.steps.map((step) => step.outcome),
    ["next", "false", "true", "queued"],
  );
});

test("an empty port ends the run without a message", () => {
  const plan = planFlowRun(branching(), { tags: new Set(), fields: new Map([[fieldId, "Busan"]]) });
  assert.deepEqual(plan, {
    status: "ended",
    steps: [
      { node_id: "start", node_type: "instagram_comment", outcome: "next" },
      { node_id: "vip", node_type: "has_tag", outcome: "false" },
      { node_id: "city", node_type: "field_equals", outcome: "false" },
    ],
  });
});

test("field operators treat a stored null as unset and compare values by type", () => {
  const document = branching();
  const city = document.nodes[2]!;
  city.config = { field_id: fieldId, field_operator: "is_set" };
  assert.equal(planFlowRun(document, { tags: new Set(), fields: new Map([[fieldId, null]]) }).status, "ended");
  assert.equal(planFlowRun(document, { tags: new Set(), fields: new Map([[fieldId, false]]) }).status, "message");
  city.config = { field_id: fieldId, field_operator: "is_unset" };
  assert.equal(planFlowRun(document, noFacts).status, "message");
  city.config = { field_id: fieldId, field_operator: "eq", field_value: 1 };
  assert.equal(planFlowRun(document, { tags: new Set(), fields: new Map([[fieldId, "1"]]) }).status, "ended");
  assert.equal(planFlowRun(document, { tags: new Set(), fields: new Map([[fieldId, 1]]) }).status, "message");
});

test("an unsupported node fails the run where it was reached instead of being skipped", () => {
  const document = branching();
  document.nodes.push({ id: "tag", type: "add_tag", config: { tag: "lead" } });
  document.edges.push({ from: "city", port: "false", to: "tag" });
  const plan = planFlowRun(document, noFacts);
  assert.equal(plan.status, "failed");
  assert.equal(plan.status === "failed" && plan.failure_code, "unsupported_node");
  assert.deepEqual(plan.steps.at(-1), { node_id: "tag", node_type: "add_tag", outcome: "unsupported_node" });
});

test("a message that uses variables, a button or a next node is not sent by this runtime", () => {
  for (const change of [
    (document: FlowDocument) => (document.nodes[3]!.config = { text: "Hi {{comment.text}}" }),
    (document: FlowDocument) => (document.nodes[3]!.config = { text: "Hi", button_title: "OK" }),
    (document: FlowDocument) => document.edges.push({ from: "vip_reply", port: "next", to: "city" }),
  ]) {
    const document = branching();
    change(document);
    const plan = planFlowRun(document, { tags: new Set(["vip"]), fields: new Map() });
    assert.equal(plan.status, "failed");
    assert.equal(flowExecutionErrors(document).length, 1);
  }
});

test("execution errors name every node or edge this runtime cannot run", () => {
  assert.deepEqual(flowExecutionErrors(branching()), []);
  const document = branching();
  document.nodes.push(
    { id: "follow", type: "follows_account", config: {} },
    { id: "tag", type: "add_tag", config: { tag: "lead" } },
  );
  document.edges.push({ from: "seoul_reply", port: "next", to: "follow" });
  assert.deepEqual(flowExecutionErrors(document), [
    { code: "unsupported_node", node_id: "follow", path: "nodes[5].type" },
    { code: "unsupported_node", node_id: "tag", path: "nodes[6].type" },
    { code: "unsupported_after_message", edge_index: 4, path: "edges[4]" },
  ]);
});

test("the trigger uses the legacy rule matcher, including exclusions and match-all", () => {
  const document = branching();
  assert.equal(matchesFlowTrigger(document, "Send the LINK please"), true);
  assert.equal(matchesFlowTrigger(document, "link spam"), false);
  assert.equal(matchesFlowTrigger(document, "hello"), false);
  document.nodes[0]!.config.match_mode = "all";
  document.nodes[0]!.config.keywords = [];
  assert.equal(matchesFlowTrigger(document, "hello"), true);
});
