import assert from "node:assert/strict";
import { test } from "node:test";
import { flowReferences, parseFlowDocument, validateFlowForPublish, type PublishContext } from "./flow-schema.ts";

const connection = "11111111-1111-4111-8111-111111111111";
const field = "22222222-2222-4222-8222-222222222222";
const numberField = "33333333-3333-4333-8333-333333333333";

function context(overrides: Partial<PublishContext> = {}): PublishContext {
  return {
    connection: { id: connection, active: true, oauth: true },
    fields: new Map([
      [field, "text"],
      [numberField, "number"],
    ]),
    legacyRuleEnabled: false,
    otherFlowPublished: false,
    ...overrides,
  };
}

function trigger(config: Record<string, unknown> = {}) {
  return {
    id: "start",
    type: "instagram_comment",
    config: {
      connection_id: connection,
      media_id: "1789",
      keywords: ["link"],
      match_mode: "contains",
      excluded_keywords: [],
      ...config,
    },
  };
}

function flow(nodes: unknown[], edges: unknown[]) {
  return { schema_version: 1, nodes: [trigger(), ...nodes], edges };
}

function codes(input: unknown, ctx = context()) {
  return validateFlowForPublish(input, ctx).map((error) => error.code);
}

const branching = flow(
  [
    { id: "follow", type: "follows_account", config: {} },
    { id: "yes", type: "instagram_message", config: { text: "Thanks {{comment.text}}", button_title: "OK" } },
    { id: "no", type: "instagram_message", config: { text: "Follow first, {{field:" + field + "}}" } },
    { id: "tag", type: "add_tag", config: { tag: " Lead " } },
    { id: "check", type: "field_equals", config: { field_id: numberField, field_operator: "eq", field_value: 3 } },
    { id: "set", type: "set_field", config: { field_id: numberField, value: 4 } },
    { id: "has", type: "has_tag", config: { tag: "vip" } },
    { id: "drop", type: "remove_tag", config: { tag: "cold" } },
    { id: "later", type: "delay", config: { minutes: 60 } },
  ],
  [
    { from: "start", port: "next", to: "follow" },
    { from: "follow", port: "true", to: "yes" },
    { from: "follow", port: "false", to: "no" },
    { from: "yes", port: "next", to: "tag" },
    { from: "tag", port: "next", to: "check" },
    { from: "check", port: "true", to: "set" },
    { from: "check", port: "false", to: "has" },
    { from: "has", port: "true", to: "drop" },
    { from: "drop", port: "next", to: "later" },
  ],
);

test("a flow using every node type and port publishes without errors", () => {
  assert.deepEqual(validateFlowForPublish(branching, context()), []);
});

test("draft parsing accepts incomplete graphs but rejects malformed documents and limits", () => {
  assert.ok("document" in parseFlowDocument({ schema_version: 1, nodes: [], edges: [] }));
  assert.ok(
    "document" in parseFlowDocument({ schema_version: 1, nodes: [{ id: "x", type: "later", config: {} }], edges: [] }),
  );
  const shape = (input: unknown) => {
    const result = parseFlowDocument(input);
    return "errors" in result ? result.errors.map((error) => error.code) : [];
  };
  assert.deepEqual(shape(null), ["invalid_document"]);
  assert.deepEqual(shape({ schema_version: 2, nodes: [], edges: [] }), ["invalid_document"]);
  assert.deepEqual(shape({ schema_version: 1, nodes: [{ id: "bad id!", type: "x", config: {} }], edges: [] }), [
    "invalid_node",
  ]);
  assert.deepEqual(shape({ schema_version: 1, nodes: [], edges: [{ from: "a", to: "b" }] }), ["invalid_edge"]);
  const many = Array.from({ length: 101 }, (_, i) => ({ id: `n${i}`, type: "add_tag", config: { tag: "x" } }));
  assert.deepEqual(shape({ schema_version: 1, nodes: many, edges: [] }), ["too_many_nodes"]);
  const edges = Array.from({ length: 201 }, () => ({ from: "a", port: "next", to: "b" }));
  assert.deepEqual(shape({ schema_version: 1, nodes: [], edges }), ["too_many_edges"]);
  const big = {
    schema_version: 1,
    nodes: [{ id: "m", type: "instagram_message", config: { text: "x".repeat(70000) } }],
    edges: [],
  };
  assert.deepEqual(shape(big), ["document_too_large"]);
  assert.deepEqual(
    shape({
      schema_version: 1,
      nodes: [
        { id: "a", type: "x", config: {} },
        { id: "a", type: "x", config: {} },
      ],
      edges: [],
    }),
    ["duplicate_node_id"],
  );
});

test("publish rejects missing references, bad ports, duplicate ports and unreachable nodes", () => {
  assert.deepEqual(codes(flow([], [{ from: "start", port: "next", to: "ghost" }])), ["missing_reference"]);
  assert.deepEqual(
    codes(
      flow(
        [{ id: "m", type: "instagram_message", config: { text: "hi" } }],
        [{ from: "start", port: "true", to: "m" }],
      ),
    ),
    ["invalid_port", "unreachable_node"],
  );
  assert.deepEqual(
    codes(
      flow(
        [
          { id: "a", type: "instagram_message", config: { text: "a" } },
          { id: "b", type: "instagram_message", config: { text: "b" } },
        ],
        [
          { from: "start", port: "next", to: "a" },
          { from: "start", port: "next", to: "b" },
        ],
      ),
    ),
    ["duplicate_port", "unreachable_node"],
  );
  assert.deepEqual(codes(flow([{ id: "lost", type: "instagram_message", config: { text: "x" } }], [])), [
    "unreachable_node",
  ]);
});

test("publish requires exactly one trigger with no incoming edge and known node types", () => {
  assert.deepEqual(codes({ schema_version: 1, nodes: [], edges: [] }), ["trigger_count"]);
  assert.deepEqual(codes(flow([{ ...trigger(), id: "second" }], [])), ["trigger_count"]);
  assert.deepEqual(
    codes(
      flow(
        [{ id: "m", type: "instagram_message", config: { text: "x" } }],
        [
          { from: "start", port: "next", to: "m" },
          { from: "m", port: "next", to: "start" },
        ],
      ),
    ),
    ["trigger_has_incoming", "immediate_cycle"],
  );
  assert.deepEqual(codes(flow([{ id: "w", type: "wait", config: {} }], [{ from: "start", port: "next", to: "w" }])), [
    "unknown_node_type",
  ]);
});

test("publish rejects every cycle because no wait node exists yet", () => {
  const cyclic = flow(
    [
      { id: "a", type: "add_tag", config: { tag: "a" } },
      { id: "b", type: "has_tag", config: { tag: "a" } },
    ],
    [
      { from: "start", port: "next", to: "a" },
      { from: "a", port: "next", to: "b" },
      { from: "b", port: "true", to: "a" },
    ],
  );
  assert.deepEqual(codes(cyclic), ["immediate_cycle"]);
  const self = flow(
    [{ id: "a", type: "add_tag", config: { tag: "a" } }],
    [
      { from: "start", port: "next", to: "a" },
      { from: "a", port: "next", to: "a" },
    ],
  );
  assert.deepEqual(codes(self), ["immediate_cycle"]);
});

test("a cycle through a delay is still rejected until a node waits for input", () => {
  const looped = flow(
    [
      { id: "wait", type: "delay", config: { minutes: 5 } },
      { id: "b", type: "has_tag", config: { tag: "a" } },
    ],
    [
      { from: "start", port: "next", to: "wait" },
      { from: "wait", port: "next", to: "b" },
      { from: "b", port: "true", to: "wait" },
    ],
  );
  assert.deepEqual(codes(looped), ["immediate_cycle"]);
});

test("a delay waits a whole number of minutes, leaving an hour of the 7-day reply window", () => {
  const one = (config: unknown) =>
    codes(flow([{ id: "d", type: "delay", config }], [{ from: "start", port: "next", to: "d" }]));
  assert.deepEqual(one({ minutes: 1 }), []);
  assert.deepEqual(one({ minutes: 10020 }), []);
  for (const config of [
    { minutes: 0 },
    { minutes: 10021 },
    { minutes: 10080 },
    { minutes: 1.5 },
    { minutes: "60" },
    {},
    { minutes: 60, unit: "hours" },
  ])
    assert.deepEqual(one(config), ["invalid_config"], JSON.stringify(config));
});

test("the delays before a message add up to no more than the reply window allows", () => {
  const delayed = (first: number, second: number, message: boolean) =>
    flow(
      [
        { id: "a", type: "delay", config: { minutes: first } },
        { id: "b", type: "delay", config: { minutes: second } },
        ...(message ? [{ id: "m", type: "instagram_message", config: { text: "Hi" } }] : []),
      ],
      [
        { from: "start", port: "next", to: "a" },
        { from: "a", port: "next", to: "b" },
        ...(message ? [{ from: "b", port: "next", to: "m" }] : []),
      ],
    );
  assert.deepEqual(codes(delayed(5000, 5020, true)), []);
  assert.deepEqual(validateFlowForPublish(delayed(5000, 5021, true), context()), [
    { code: "delay_exceeds_reply_window", node_id: "m", path: "nodes[3]" },
  ]);
  // Nothing is sent after the delays, so the window does not apply.
  assert.deepEqual(codes(delayed(5000, 5021, false)), []);
  // The longest of two branches into one message counts.
  const branches = flow(
    [
      { id: "has", type: "has_tag", config: { tag: "vip" } },
      { id: "long", type: "delay", config: { minutes: 10020 } },
      { id: "short", type: "delay", config: { minutes: 1 } },
      { id: "m", type: "instagram_message", config: { text: "Hi" } },
    ],
    [
      { from: "start", port: "next", to: "short" },
      { from: "short", port: "next", to: "has" },
      { from: "has", port: "true", to: "long" },
      { from: "has", port: "false", to: "m" },
      { from: "long", port: "next", to: "m" },
    ],
  );
  assert.deepEqual(codes(branches), ["delay_exceeds_reply_window"]);
});

test("node configs follow the existing rule, tag, field and button limits", () => {
  const one = (node: unknown) =>
    codes(flow([node], [{ from: "start", port: "next", to: (node as { id: string }).id }]));
  assert.deepEqual(one({ id: "m", type: "instagram_message", config: { text: " " } }), ["invalid_config"]);
  assert.deepEqual(one({ id: "m", type: "instagram_message", config: { text: "x".repeat(1001) } }), ["invalid_config"]);
  assert.deepEqual(one({ id: "m", type: "instagram_message", config: { text: "x".repeat(641), button_title: "OK" } }), [
    "invalid_config",
  ]);
  assert.deepEqual(one({ id: "m", type: "instagram_message", config: { text: "x", button_title: "x".repeat(21) } }), [
    "invalid_config",
  ]);
  assert.deepEqual(one({ id: "t", type: "add_tag", config: { tag: "x".repeat(41) } }), ["invalid_config"]);
  assert.deepEqual(one({ id: "t", type: "follows_account", config: { extra: true } }), ["invalid_config"]);
  assert.deepEqual(one({ id: "s", type: "set_field", config: { field_id: numberField, value: "four" } }), [
    "invalid_field_value",
  ]);
  assert.deepEqual(
    one({ id: "s", type: "set_field", config: { field_id: "44444444-4444-4444-8444-444444444444", value: 1 } }),
    ["unknown_field"],
  );
  assert.deepEqual(
    one({ id: "c", type: "field_equals", config: { field_id: field, field_operator: "is_set", field_value: 1 } }),
    ["invalid_config"],
  );
  assert.deepEqual(codes({ ...branching, nodes: [trigger({ keywords: [] }), ...branching.nodes.slice(1)] }), [
    "invalid_config",
  ]);
  assert.deepEqual(codes({ ...branching, nodes: [trigger({ media_id: "abc" }), ...branching.nodes.slice(1)] }), [
    "invalid_config",
  ]);
});

test("message variables allow only comment text and active fields with balanced braces", () => {
  const text = (value: string) =>
    codes(
      flow(
        [{ id: "m", type: "instagram_message", config: { text: value } }],
        [{ from: "start", port: "next", to: "m" }],
      ),
    );
  assert.deepEqual(text("Hi {{comment.text}} {{field:" + field + "}}"), []);
  assert.deepEqual(text("Hi {{contact.name}}"), ["invalid_variable"]);
  assert.deepEqual(text("Hi {{comment.text}"), ["invalid_variable"]);
  assert.deepEqual(text("Hi }}"), ["invalid_variable"]);
  assert.deepEqual(text("Hi {{field:44444444-4444-4444-8444-444444444444}}"), ["unknown_field"]);
  assert.deepEqual(text("Braces { } alone are text"), []);
});

test("publish checks the trigger connection, login mode and legacy rule overlap", () => {
  assert.deepEqual(codes(branching, context({ connection: null })), ["connection_unavailable"]);
  assert.deepEqual(codes(branching, context({ connection: { id: connection, active: false, oauth: true } })), [
    "connection_unavailable",
  ]);
  assert.deepEqual(codes(branching, context({ connection: { id: connection, active: true, oauth: false } })), [
    "login_mode_required",
  ]);
  assert.deepEqual(codes(branching, context({ legacyRuleEnabled: true })), ["legacy_rule_conflict"]);
  assert.deepEqual(codes(branching, context({ otherFlowPublished: true })), ["flow_trigger_conflict"]);
  const noFollow = flow(
    [{ id: "m", type: "instagram_message", config: { text: "x" } }],
    [{ from: "start", port: "next", to: "m" }],
  );
  assert.deepEqual(codes(noFollow, context({ connection: { id: connection, active: true, oauth: false } })), []);
});

test("enumerated config values must be strings, not coercible objects", () => {
  for (const match_mode of [["contains"], { toString: null }]) {
    const input = { ...branching, nodes: [trigger({ match_mode }), ...branching.nodes.slice(1)] };
    assert.deepEqual(codes(input), ["invalid_config"]);
  }
  for (const field_operator of [["is_set"], { toString: null }]) {
    const input = flow(
      [{ id: "c", type: "field_equals", config: { field_id: field, field_operator } }],
      [{ from: "start", port: "next", to: "c" }],
    );
    assert.deepEqual(codes(input), ["invalid_config"]);
  }
});

test("inherited object property names are unknown node types, not crashes", () => {
  for (const type of ["constructor", "toString", "__proto__"]) {
    const input = flow(
      [
        { id: "u", type, config: {} },
        { id: "m", type: "instagram_message", config: { text: "hi" } },
      ],
      [
        { from: "start", port: "next", to: "u" },
        { from: "u", port: "next", to: "m" },
      ],
    );
    assert.deepEqual(codes(input), ["unknown_node_type"]);
  }
});

test("uppercase connection ids match the lowercase id PostgreSQL returns", () => {
  const lower = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const upper = {
    ...branching,
    nodes: [trigger({ connection_id: lower.toUpperCase() }), ...branching.nodes.slice(1)],
  };
  assert.deepEqual(codes(upper, context({ connection: { id: lower, active: true, oauth: true } })), []);
  const parsed = parseFlowDocument(upper);
  assert.ok("document" in parsed);
  assert.equal(flowReferences(parsed.document).connection_id, lower);
});

test("errors identify the node, edge and path they belong to", () => {
  const errors = validateFlowForPublish(flow([], [{ from: "start", port: "next", to: "ghost" }]), context());
  assert.deepEqual(errors, [{ code: "missing_reference", edge_index: 0, path: "edges[0].to" }]);
  const [config] = validateFlowForPublish(
    flow([{ id: "m", type: "instagram_message", config: { text: "" } }], [{ from: "start", port: "next", to: "m" }]),
    context(),
  );
  assert.deepEqual(config, { code: "invalid_config", node_id: "m", path: "nodes[1].config" });
});

test("references expose the trigger and every field id used by configs and variables", () => {
  const parsed = parseFlowDocument(branching);
  assert.ok("document" in parsed);
  assert.deepEqual(flowReferences(parsed.document), {
    connection_id: connection,
    media_id: "1789",
    field_ids: [field, numberField].sort(),
  });
});
