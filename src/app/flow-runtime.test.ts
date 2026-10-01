import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowDocument } from "./flow-schema.ts";
import { flowExecutionErrors, matchesFlowTrigger, planFlowRun, type ContactFacts } from "./flow-runtime.ts";

const fieldId = "99999999-9999-4999-8999-999999999999";
const textField = "88888888-8888-4888-8888-888888888888";
const flagField = "77777777-7777-4777-8777-777777777777";
const dateField = "66666666-6666-4666-8666-666666666666";
const noFacts = { tags: new Set<string>(), fields: new Map<string, unknown>() };
const types = new Map([
  [fieldId, "text"],
  [textField, "text"],
  [flagField, "boolean"],
  [dateField, "date"],
]);
const input = { commentText: "link please", writableFields: new Set([fieldId, textField, flagField, dateField]) };

function plan(document: FlowDocument, facts: ContactFacts = noFacts, overrides: Partial<typeof input> = {}) {
  return planFlowRun(document, facts, { ...input, ...overrides });
}

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

// start -> nodes in order -> reply, each on its "next" port.
function chain(nodes: FlowDocument["nodes"], text = "Thanks"): FlowDocument {
  const document = branching();
  document.nodes = [document.nodes[0]!, ...nodes, { id: "reply", type: "instagram_message", config: { text } }];
  document.edges = document.nodes
    .slice(1)
    .map((node, index) => ({ from: document.nodes[index]!.id, port: "next", to: node.id }));
  return document;
}

test("branches on normalized tags and typed field values and records the path", () => {
  assert.deepEqual(plan(branching(), { tags: new Set(["vip"]), fields: new Map() }), {
    status: "message",
    text: "VIP link",
    steps: [
      { node_id: "start", node_type: "instagram_comment", outcome: "next" },
      { node_id: "vip", node_type: "has_tag", outcome: "true" },
      { node_id: "vip_reply", node_type: "instagram_message", outcome: "queued" },
    ],
    changes: { tags: new Map(), fields: new Map() },
  });
  const seoul = plan(branching(), { tags: new Set(), fields: new Map([[fieldId, "Seoul"]]) });
  assert.equal(seoul.status, "message");
  assert.deepEqual(
    seoul.steps.map((step) => step.outcome),
    ["next", "false", "true", "queued"],
  );
});

test("an empty port ends the run without a message", () => {
  assert.deepEqual(plan(branching(), { tags: new Set(), fields: new Map([[fieldId, "Busan"]]) }), {
    status: "ended",
    steps: [
      { node_id: "start", node_type: "instagram_comment", outcome: "next" },
      { node_id: "vip", node_type: "has_tag", outcome: "false" },
      { node_id: "city", node_type: "field_equals", outcome: "false" },
    ],
    changes: { tags: new Map(), fields: new Map() },
  });
});

test("field operators treat a stored null as unset and compare values by type", () => {
  const document = branching();
  const city = document.nodes[2]!;
  city.config = { field_id: fieldId, field_operator: "is_set" };
  assert.equal(plan(document, { tags: new Set(), fields: new Map([[fieldId, null]]) }).status, "ended");
  assert.equal(plan(document, { tags: new Set(), fields: new Map([[fieldId, false]]) }).status, "message");
  city.config = { field_id: fieldId, field_operator: "is_unset" };
  assert.equal(plan(document).status, "message");
  city.config = { field_id: fieldId, field_operator: "eq", field_value: 1 };
  assert.equal(plan(document, { tags: new Set(), fields: new Map([[fieldId, "1"]]) }).status, "ended");
  assert.equal(plan(document, { tags: new Set(), fields: new Map([[fieldId, 1]]) }).status, "message");
});

test("an unsupported node fails the run where it was reached instead of being skipped", () => {
  const document = branching();
  document.nodes.push({ id: "follow", type: "follows_account", config: {} });
  document.edges.push({ from: "city", port: "false", to: "follow" });
  const result = plan(document);
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.failure_code, "unsupported_node");
  assert.deepEqual(result.steps.at(-1), {
    node_id: "follow",
    node_type: "follows_account",
    outcome: "unsupported_node",
  });
});

test("a message with a button or a next node is not sent by this runtime", () => {
  for (const change of [
    (document: FlowDocument) => (document.nodes[3]!.config = { text: "Hi", button_title: "OK" }),
    (document: FlowDocument) => document.edges.push({ from: "vip_reply", port: "next", to: "city" }),
  ]) {
    const document = branching();
    change(document);
    assert.equal(plan(document, { tags: new Set(["vip"]), fields: new Map() }).status, "failed");
    assert.equal(flowExecutionErrors(document, types).length, 1);
  }
});

test("execution errors name every node, edge or variable this runtime cannot run", () => {
  assert.deepEqual(flowExecutionErrors(branching(), types), []);
  const document = branching();
  document.nodes.push(
    { id: "follow", type: "follows_account", config: {} },
    { id: "tag", type: "add_tag", config: { tag: "lead" } },
    { id: "flag", type: "instagram_message", config: { text: "Opted in: {{field:" + flagField.toUpperCase() + "}}" } },
  );
  document.edges.push({ from: "seoul_reply", port: "next", to: "follow" });
  assert.deepEqual(flowExecutionErrors(document, types), [
    { code: "unsupported_node", node_id: "follow", path: "nodes[5].type" },
    { code: "unsupported_variable", node_id: "flag", path: "nodes[7].config.text" },
    { code: "unsupported_after_message", edge_index: 4, path: "edges[4]" },
  ]);
});

test("tag and field actions change the facts that later conditions read, in path order", () => {
  const document = chain([
    { id: "add", type: "add_tag", config: { tag: " Lead " } },
    { id: "again", type: "add_tag", config: { tag: "lead" } },
    { id: "drop", type: "remove_tag", config: { tag: "old" } },
    { id: "gone", type: "remove_tag", config: { tag: "never" } },
    { id: "set", type: "set_field", config: { field_id: fieldId.toUpperCase(), value: "Seoul" } },
    { id: "same", type: "set_field", config: { field_id: textField, value: "kept" } },
    { id: "is_lead", type: "has_tag", config: { tag: "LEAD" } },
  ]);
  document.edges.at(-1)!.port = "true";
  const result = plan(document, { tags: new Set(["old"]), fields: new Map([[textField, "kept"]]) });
  assert.equal(result.status, "message");
  assert.deepEqual(
    result.steps.map((step) => step.outcome),
    ["next", "added", "already_present", "removed", "absent", "set", "unchanged", "true", "queued"],
  );
  assert.deepEqual(result.changes, {
    tags: new Map([
      ["lead", true],
      ["old", false],
    ]),
    fields: new Map([[fieldId, "Seoul"]]),
  });
});

test("a tag added and removed again on one path leaves no change", () => {
  const document = chain([
    { id: "add", type: "add_tag", config: { tag: "trial" } },
    { id: "drop", type: "remove_tag", config: { tag: "trial" } },
  ]);
  assert.deepEqual(plan(document).changes, { tags: new Map(), fields: new Map() });
});

test("a contact with 20 tags records tag_limit and the run continues", () => {
  const full = new Set(Array.from({ length: 20 }, (_, index) => `t${index}`));
  const result = plan(chain([{ id: "add", type: "add_tag", config: { tag: "lead" } }]), {
    tags: full,
    fields: new Map(),
  });
  assert.equal(result.status, "message");
  assert.equal(result.steps[1]!.outcome, "tag_limit");
  assert.deepEqual(result.changes.tags, new Map());
});

test("setting an archived or otherwise unwritable field fails the run at that node", () => {
  const document = chain([
    { id: "add", type: "add_tag", config: { tag: "lead" } },
    { id: "set", type: "set_field", config: { field_id: fieldId, value: "Seoul" } },
  ]);
  const result = plan(document, noFacts, { writableFields: new Set() });
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.failure_code, "field_unavailable");
  assert.deepEqual(result.steps.at(-1), { node_id: "set", node_type: "set_field", outcome: "field_unavailable" });
  // Actions before the failing node already ran.
  assert.deepEqual(result.changes.tags, new Map([["lead", true]]));
});

test("message variables render once, so comment text is never read as a template", () => {
  const document = chain(
    [{ id: "set", type: "set_field", config: { field_id: fieldId, value: 7 } }],
    "You said {{comment.text}} ({{field:" + fieldId + "}}, {{field:" + dateField + "}})",
  );
  const facts = { tags: new Set<string>(), fields: new Map<string, unknown>([[dateField, "2026-10-01"]]) };
  const result = plan(document, facts, { commentText: "<b>{{field:" + dateField + "}}</b>" });
  assert.equal(result.status === "message" && result.text, `You said <b>{{field:${dateField}}}</b> (7, 2026-10-01)`);
});

test("a missing, boolean, oversized or empty rendered message fails the run", () => {
  const cases: [string, ContactFacts, string, string][] = [
    ["Hi {{field:" + textField + "}}", noFacts, "link", "variable_missing"],
    [
      "Hi {{field:" + textField + "}}",
      { tags: new Set(), fields: new Map([[textField, null]]) },
      "x",
      "variable_missing",
    ],
    [
      "Hi {{field:" + flagField + "}}",
      { tags: new Set(), fields: new Map([[flagField, true]]) },
      "x",
      "unsupported_variable",
    ],
    ["{{comment.text}}", noFacts, "a".repeat(1001), "message_too_long"],
    ["{{comment.text}}", noFacts, "   ", "message_empty"],
  ];
  for (const [text, facts, commentText, code] of cases) {
    const result = plan(chain([], text), facts, { commentText });
    assert.equal(result.status === "failed" && result.failure_code, code, `${text} -> ${code}`);
    assert.deepEqual(result.steps.at(-1), { node_id: "reply", node_type: "instagram_message", outcome: code });
  }
  const exact = plan(chain([], "{{comment.text}}"), noFacts, { commentText: "a".repeat(1000) });
  assert.equal(exact.status, "message");
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

test("a delay stops the run as waiting and keeps the actions taken before it", () => {
  const document = chain([
    { id: "tag", type: "add_tag", config: { tag: "lead" } },
    { id: "wait", type: "delay", config: { minutes: 30 } },
  ]);
  assert.deepEqual(flowExecutionErrors(document, types), []);
  assert.deepEqual(plan(document), {
    status: "waiting",
    resume_node_id: "wait",
    delay_minutes: 30,
    steps: [
      { node_id: "start", node_type: "instagram_comment", outcome: "next" },
      { node_id: "tag", node_type: "add_tag", outcome: "added" },
      { node_id: "wait", node_type: "delay", outcome: "waiting" },
    ],
    changes: { tags: new Map([["lead", true]]), fields: new Map() },
  });
});

test("a resumed run continues after its delay with the facts read at resume time", () => {
  const document = chain([
    { id: "wait", type: "delay", config: { minutes: 30 } },
    { id: "vip", type: "has_tag", config: { tag: "vip" } },
  ]);
  // The reply hangs off vip's "true" port, so only a contact tagged after the comment gets it.
  document.edges = document.edges.map((edge) => (edge.from === "vip" ? { ...edge, port: "true" } : edge));
  assert.equal(planFlowRun(document, noFacts, input, { node_id: "wait", port: "next" }).status, "ended");
  assert.deepEqual(
    planFlowRun(document, { tags: new Set(["vip"]), fields: new Map() }, input, { node_id: "wait", port: "next" }),
    {
      status: "message",
      text: "Thanks",
      steps: [
        { node_id: "vip", node_type: "has_tag", outcome: "true" },
        { node_id: "reply", node_type: "instagram_message", outcome: "queued" },
      ],
      changes: { tags: new Map(), fields: new Map() },
    },
  );
});

test("a resumed run stops again at the next delay", () => {
  const document = chain([
    { id: "first", type: "delay", config: { minutes: 5 } },
    { id: "second", type: "delay", config: { minutes: 10020 } },
  ]);
  const resumed = planFlowRun(document, noFacts, input, { node_id: "first", port: "next" });
  assert.equal(resumed.status, "waiting");
  assert.equal(resumed.status === "waiting" && resumed.resume_node_id, "second");
  assert.equal(resumed.status === "waiting" && resumed.delay_minutes, 10020);
  assert.deepEqual(resumed.steps, [{ node_id: "second", node_type: "delay", outcome: "waiting" }]);
});

test("resuming from a missing node or a node that is not a delay fails the run", () => {
  const document = chain([{ id: "wait", type: "delay", config: { minutes: 1 } }]);
  for (const from of ["gone", "reply", "start"]) {
    const result = planFlowRun(document, noFacts, input, { node_id: from, port: "next" });
    assert.equal(result.status, "failed", from);
    assert.equal(result.status === "failed" && result.failure_code, "invalid_definition");
    assert.deepEqual(result.steps, []);
  }
});

// start -> reply -> wait (replied -> answered tag, timeout -> silent tag), with optional extra nodes.
function waiting(config: Record<string, unknown> = { timeout_minutes: 60 }): FlowDocument {
  const document = chain([], "What size do you need?");
  document.nodes.push(
    { id: "wait", type: "wait_for_reply", config },
    { id: "answered", type: "add_tag", config: { tag: "answered" } },
    { id: "silent", type: "add_tag", config: { tag: "silent" } },
  );
  document.edges.push(
    { from: "reply", port: "next", to: "wait" },
    { from: "wait", port: "replied", to: "answered" },
    { from: "wait", port: "timeout", to: "silent" },
  );
  return document;
}

test("a message followed by a reply wait queues the message and names the wait", () => {
  const document = waiting();
  assert.deepEqual(flowExecutionErrors(document, types), []);
  assert.deepEqual(plan(document), {
    status: "message",
    text: "What size do you need?",
    wait_node_id: "wait",
    steps: [
      { node_id: "start", node_type: "instagram_comment", outcome: "next" },
      { node_id: "reply", node_type: "instagram_message", outcome: "queued" },
    ],
    changes: { tags: new Map(), fields: new Map() },
  });
});

test("the enable check allows a message only to lead into a reply wait", () => {
  const document = waiting();
  document.nodes.push({ id: "tag", type: "add_tag", config: { tag: "x" } });
  document.edges[document.edges.findIndex((edge) => edge.from === "reply")] = {
    from: "reply",
    port: "next",
    to: "tag",
  };
  assert.deepEqual(flowExecutionErrors(document, types), [
    { code: "unsupported_after_message", edge_index: 1, path: "edges[1]" },
  ]);
  assert.equal(plan(document).status, "failed");
});

test("a reply resumes on the replied port and saves the reply text into the field", () => {
  const document = waiting({ timeout_minutes: 60, save_field_id: textField.toUpperCase() });
  document.nodes.push({
    id: "check",
    type: "field_equals",
    config: { field_id: textField, field_operator: "eq", field_value: "XL" },
  });
  document.edges = document.edges.map((edge) => (edge.port === "replied" ? { ...edge, to: "check" } : edge));
  document.edges.push({ from: "check", port: "true", to: "answered" });
  const resumed = planFlowRun(document, noFacts, { ...input, replyText: "XL" }, { node_id: "wait", port: "replied" });
  assert.deepEqual(resumed, {
    status: "ended",
    steps: [
      { node_id: "wait", node_type: "wait_for_reply", outcome: "replied" },
      { node_id: "wait", node_type: "wait_for_reply", outcome: "set" },
      { node_id: "check", node_type: "field_equals", outcome: "true" },
      { node_id: "answered", node_type: "add_tag", outcome: "added" },
    ],
    changes: { tags: new Map([["answered", true]]), fields: new Map([[textField, "XL"]]) },
  });
  const same = planFlowRun(
    document,
    { tags: new Set(), fields: new Map([[textField, "XL"]]) },
    { ...input, replyText: "XL" },
    { node_id: "wait", port: "replied" },
  );
  assert.deepEqual(same.steps[1], { node_id: "wait", node_type: "wait_for_reply", outcome: "unchanged" });
});

test("a reply that cannot be saved is recorded and the run continues on replied", () => {
  const document = waiting({ timeout_minutes: 60, save_field_id: textField });
  const cases: [Partial<typeof input> & { replyText: string }, string][] = [
    [{ replyText: "x".repeat(1001) }, "reply_invalid"],
    [{ replyText: "bad\u0000byte" }, "reply_invalid"],
    [{ replyText: "XL", writableFields: new Set() }, "field_unavailable"],
  ];
  for (const [overrides, outcome] of cases) {
    const resumed = planFlowRun(document, noFacts, { ...input, ...overrides }, { node_id: "wait", port: "replied" });
    assert.equal(resumed.status, "ended", outcome);
    assert.deepEqual(resumed.steps, [
      { node_id: "wait", node_type: "wait_for_reply", outcome: "replied" },
      { node_id: "wait", node_type: "wait_for_reply", outcome },
      { node_id: "answered", node_type: "add_tag", outcome: "added" },
    ]);
    assert.deepEqual(resumed.changes.fields, new Map());
  }
  const multiline = planFlowRun(
    document,
    noFacts,
    { ...input, replyText: "line one\nline two" },
    { node_id: "wait", port: "replied" },
  );
  assert.equal(multiline.steps[1]!.outcome, "set");
});

test("a timeout resumes on the timeout port without saving anything", () => {
  const document = waiting({ timeout_minutes: 60, save_field_id: textField });
  assert.deepEqual(planFlowRun(document, noFacts, input, { node_id: "wait", port: "timeout" }), {
    status: "ended",
    steps: [
      { node_id: "wait", node_type: "wait_for_reply", outcome: "timeout" },
      { node_id: "silent", node_type: "add_tag", outcome: "added" },
    ],
    changes: { tags: new Map([["silent", true]]), fields: new Map() },
  });
});

test("after a reply wait a delay waits again, and a message is never queued", () => {
  const document = waiting();
  document.nodes.push(
    { id: "later", type: "delay", config: { minutes: 30 } },
    { id: "again", type: "instagram_message", config: { text: "Still there?" } },
  );
  document.edges = document.edges.map((edge) => (edge.port === "timeout" ? { ...edge, to: "later" } : edge));
  const timedOut = planFlowRun(document, noFacts, input, { node_id: "wait", port: "timeout" });
  assert.equal(timedOut.status, "waiting");
  assert.equal(timedOut.status === "waiting" && timedOut.resume_node_id, "later");
  // Publish rejects a message after a wait; the runtime still refuses one reached on the same walk.
  document.edges = document.edges.map((edge) => (edge.port === "replied" ? { ...edge, to: "again" } : edge));
  const replied = planFlowRun(document, noFacts, input, { node_id: "wait", port: "replied" });
  assert.equal(replied.status === "failed" && replied.failure_code, "unsupported_node");
});

test("a resume entry must name a delay's next port or a reply wait's replied or timeout port", () => {
  const document = waiting();
  document.nodes.push({ id: "pause", type: "delay", config: { minutes: 5 } });
  for (const entry of [
    { node_id: "wait", port: "next" },
    { node_id: "pause", port: "replied" },
    { node_id: "pause", port: "timeout" },
    { node_id: "reply", port: "next" },
  ]) {
    const result = planFlowRun(document, noFacts, input, entry);
    assert.equal(result.status === "failed" && result.failure_code, "invalid_definition", JSON.stringify(entry));
    assert.deepEqual(result.steps, []);
  }
});

test("a time wait stops the run as waiting until a wall-clock time and resumes on next", () => {
  const document = chain([
    { id: "tag", type: "add_tag", config: { tag: "lead" } },
    { id: "morning", type: "wait_until", config: { time: "09:30" } },
  ]);
  assert.deepEqual(flowExecutionErrors(document, types), []);
  assert.deepEqual(plan(document), {
    status: "waiting",
    resume_node_id: "morning",
    until_time: "09:30",
    steps: [
      { node_id: "start", node_type: "instagram_comment", outcome: "next" },
      { node_id: "tag", node_type: "add_tag", outcome: "added" },
      { node_id: "morning", node_type: "wait_until", outcome: "waiting" },
    ],
    changes: { tags: new Map([["lead", true]]), fields: new Map() },
  });
  assert.deepEqual(planFlowRun(document, noFacts, input, { node_id: "morning", port: "next" }), {
    status: "message",
    text: "Thanks",
    steps: [{ node_id: "reply", node_type: "instagram_message", outcome: "queued" }],
    changes: { tags: new Map(), fields: new Map() },
  });
  for (const port of ["replied", "timeout"]) {
    const result = planFlowRun(document, noFacts, input, { node_id: "morning", port });
    assert.equal(result.status === "failed" && result.failure_code, "invalid_definition", port);
  }
});
