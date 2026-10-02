import { isRecord, isUuid } from "./auth.ts";
import { isValidFieldValue } from "./contact-fields.ts";

export type FlowNode = { id: string; type: string; config: Record<string, unknown> };
export type FlowEdge = { from: string; port: string; to: string };
export type FlowDocument = { schema_version: 1; nodes: FlowNode[]; edges: FlowEdge[] };
export type FlowError = { code: string; node_id?: string; edge_index?: number; path: string };
export type PublishContext = {
  connection: { id: string; active: boolean; oauth: boolean } | null;
  fields: Map<string, string>;
  // The workspace's active webhook endpoints among those the draft names.
  endpoints: ReadonlySet<string>;
  // Reply text never leaves through a webhook. Among the fields the draft names: those any published
  // version of the workspace saves a reply into, and those a webhook node of another flow's current
  // version sends.
  replyFields: ReadonlySet<string>;
  webhookFields: ReadonlySet<string>;
  legacyRuleEnabled: boolean;
  otherFlowPublished: boolean;
};

export const EMPTY_FLOW: FlowDocument = { schema_version: 1, nodes: [], edges: [] };
const MAX_NODES = 100;
const MAX_EDGES = 200;
const MAX_BYTES = 65536;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,40}$/;
const PORTS: Record<string, string[]> = {
  instagram_comment: ["next"],
  instagram_message: ["next"],
  follows_account: ["true", "false"],
  has_tag: ["true", "false"],
  field_equals: ["true", "false"],
  add_tag: ["next"],
  remove_tag: ["next"],
  set_field: ["next"],
  delay: ["next"],
  wait_until: ["next"],
  wait_for_reply: ["replied", "timeout"],
  webhook: ["next"],
};
// Own-property lookup, so names such as "constructor" are unknown types rather than prototype members.
function portsOf(type: string): string[] | undefined {
  return Object.hasOwn(PORTS, type) ? PORTS[type] : undefined;
}
// A cycle is allowed only through a node that waits for input. A delay or a time wait alone would
// repeat the same path on a timer, so neither counts, and a reply wait cannot close a cycle because it
// is reached only from a message and no message may follow it; the set stays empty.
const WAIT_TYPES = new Set<string>();
// A private reply must be sent within seven days of the comment (reply-policy.ts), and a delay
// starts when the webhook arrives, so the delays before a message leave an hour of that window for
// webhook, cron and retry latency (service policy, not a Meta limit).
const MAX_DELAY_MINUTES = 7 * 24 * 60 - 60;
// The longest a run waits for a reply to its private reply (operator decision, 7 days).
const MAX_REPLY_WAIT_MINUTES = 7 * 24 * 60;
// A time wait resumes at the next occurrence of a 24-hour local time, usually within a day. On a day
// the clocks go back it can last a day plus the shift: one hour in most zones and two in
// Antarctica/Troll (PostgreSQL 17.11 zone data, 2026-2027). It counts as a day plus that two-hour
// shift toward the reply window (operator decision, 2026-10-01), so the hour MAX_DELAY_MINUTES leaves
// for latency stays intact in every zone. A reply that still falls outside the seven days is blocked
// as comment_expired by reply-policy.ts before the send, never sent late.
const TIME_WAIT_MINUTES = 26 * 60;
const WALL_CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// The most custom fields one webhook node sends (service policy).
const MAX_WEBHOOK_FIELDS = 20;

function error(code: string, path: string, extra: { node_id?: string; edge_index?: number } = {}): FlowError {
  return { code, ...extra, path };
}

export function parseFlowDocument(input: unknown): { document: FlowDocument } | { errors: FlowError[] } {
  if (!isRecord(input) || input.schema_version !== 1 || !Array.isArray(input.nodes) || !Array.isArray(input.edges))
    return { errors: [error("invalid_document", "")] };
  if (input.nodes.length > MAX_NODES) return { errors: [error("too_many_nodes", "nodes")] };
  if (input.edges.length > MAX_EDGES) return { errors: [error("too_many_edges", "edges")] };
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) return { errors: [error("document_too_large", "")] };
  const errors: FlowError[] = [];
  const ids = new Set<string>();
  input.nodes.forEach((node, index) => {
    if (
      !isRecord(node) ||
      typeof node.id !== "string" ||
      !IDENTIFIER.test(node.id) ||
      typeof node.type !== "string" ||
      !IDENTIFIER.test(node.type) ||
      !isRecord(node.config)
    )
      errors.push(error("invalid_node", `nodes[${index}]`));
    else if (ids.has(node.id)) errors.push(error("duplicate_node_id", `nodes[${index}].id`, { node_id: node.id }));
    else ids.add(node.id);
  });
  input.edges.forEach((edge, index) => {
    if (
      !isRecord(edge) ||
      [edge.from, edge.port, edge.to].some((value) => typeof value !== "string" || !IDENTIFIER.test(value))
    )
      errors.push(error("invalid_edge", `edges[${index}]`, { edge_index: index }));
  });
  if (errors.length) return { errors };
  return { document: { schema_version: 1, nodes: input.nodes as FlowNode[], edges: input.edges as FlowEdge[] } };
}

function exactKeys(config: Record<string, unknown>, required: string[], optional: string[] = []) {
  const keys = Object.keys(config);
  return (
    required.every((key) => Object.hasOwn(config, key)) && keys.every((key) => [...required, ...optional].includes(key))
  );
}

function oneOf(value: unknown, allowed: string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

function text(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length <= max && value.trim().length > 0;
}

export function normalizeTag(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const result = value.trim().normalize("NFC").toLowerCase();
  return result && result.length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(result) ? result : null;
}

function keywords(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 20 && value.every((keyword) => text(keyword, 100));
}

function validConfig(node: FlowNode): boolean {
  const config = node.config;
  switch (node.type) {
    case "instagram_comment":
      return (
        exactKeys(config, ["connection_id", "media_id", "keywords", "match_mode", "excluded_keywords"]) &&
        isUuid(config.connection_id) &&
        typeof config.media_id === "string" &&
        /^\d{1,40}$/.test(config.media_id) &&
        oneOf(config.match_mode, ["contains", "exact", "all"]) &&
        keywords(config.keywords) &&
        keywords(config.excluded_keywords) &&
        (config.match_mode === "all" || (config.keywords as unknown[]).length > 0)
      );
    case "instagram_message":
      return (
        exactKeys(config, ["text"], ["button_title"]) &&
        text(config.text, 1000) &&
        (config.button_title === undefined || (text(config.button_title, 20) && String(config.text).length <= 640))
      );
    case "follows_account":
      return exactKeys(config, []);
    case "has_tag":
    case "add_tag":
    case "remove_tag":
      return exactKeys(config, ["tag"]) && normalizeTag(config.tag) !== null;
    case "field_equals":
      return (
        exactKeys(config, ["field_id", "field_operator"], ["field_value"]) &&
        isUuid(config.field_id) &&
        (config.field_operator === "eq"
          ? config.field_value !== undefined && config.field_value !== null
          : oneOf(config.field_operator, ["is_set", "is_unset"]) && config.field_value === undefined)
      );
    case "set_field":
      return exactKeys(config, ["field_id", "value"]) && isUuid(config.field_id) && config.value !== null;
    case "delay":
      return (
        exactKeys(config, ["minutes"]) &&
        Number.isInteger(config.minutes) &&
        (config.minutes as number) >= 1 &&
        (config.minutes as number) <= MAX_DELAY_MINUTES
      );
    case "wait_until":
      return exactKeys(config, ["time"]) && typeof config.time === "string" && WALL_CLOCK_TIME.test(config.time);
    case "wait_for_reply":
      return (
        exactKeys(config, ["timeout_minutes"], ["save_field_id"]) &&
        Number.isInteger(config.timeout_minutes) &&
        (config.timeout_minutes as number) >= 1 &&
        (config.timeout_minutes as number) <= MAX_REPLY_WAIT_MINUTES &&
        (config.save_field_id === undefined || isUuid(config.save_field_id))
      );
    case "webhook":
      return (
        exactKeys(config, ["endpoint_id", "field_ids", "include_tags"]) &&
        isUuid(config.endpoint_id) &&
        typeof config.include_tags === "boolean" &&
        Array.isArray(config.field_ids) &&
        config.field_ids.length <= MAX_WEBHOOK_FIELDS &&
        config.field_ids.every(isUuid) &&
        new Set(config.field_ids.map((id: string) => id.toLowerCase())).size === config.field_ids.length
      );
    default:
      return false;
  }
}

function variableErrors(value: string, fields: Map<string, string>, path: string, node_id: string): FlowError[] {
  const errors: FlowError[] = [];
  const rest = value.replace(/\{\{([^{}]*)\}\}/g, (_, name: string) => {
    const field = /^field:(.+)$/.exec(name);
    if (field && isUuid(field[1])) {
      if (!fields.has(field[1].toLowerCase())) errors.push(error("unknown_field", path, { node_id }));
    } else if (name !== "comment.text") errors.push(error("invalid_variable", path, { node_id }));
    return "";
  });
  if (rest.includes("{{") || rest.includes("}}")) errors.push(error("invalid_variable", path, { node_id }));
  return errors;
}

function fieldErrors(node: FlowNode, fields: Map<string, string>, path: string): FlowError[] {
  const id = node.config.field_id;
  if (typeof id !== "string") return [];
  const type = fields.get(id.toLowerCase());
  if (!type) return [error("unknown_field", path, { node_id: node.id })];
  const value = node.type === "set_field" ? node.config.value : node.config.field_value;
  if (value !== undefined && !isValidFieldValue(type, value))
    return [error("invalid_field_value", path, { node_id: node.id })];
  return [];
}

// The fields the reply waits of a document save the reply DM into, in lower case.
export function replySaveFields(document: Pick<FlowDocument, "nodes">): Set<string> {
  return new Set(
    document.nodes.flatMap((node) =>
      node.type === "wait_for_reply" && typeof node.config.save_field_id === "string"
        ? [node.config.save_field_id.toLowerCase()]
        : [],
    ),
  );
}

// The fields a run of a document may write: set_field targets and the fields its reply waits save into.
// A run and a test run both keep only the unarchived ones.
export function fieldWriteTargets(document: Pick<FlowDocument, "nodes">): string[] {
  return document.nodes.flatMap((node) =>
    node.type === "set_field" && typeof node.config.field_id === "string"
      ? [node.config.field_id]
      : node.type === "wait_for_reply" && typeof node.config.save_field_id === "string"
        ? [node.config.save_field_id]
        : [],
  );
}

// The fields the webhook nodes of a document name, as written; replySavedFields picks the ones a reply
// wait saves into (#117).
export function webhookFieldIds(document: Pick<FlowDocument, "nodes">): unknown[] {
  return document.nodes.flatMap((node) =>
    node.type === "webhook" && Array.isArray(node.config.field_ids) ? (node.config.field_ids as unknown[]) : [],
  );
}

// A reply is saved as text, so the field it goes into must be an active text field, and not one that
// another flow's webhook node sends.
function saveFieldErrors(node: FlowNode, context: PublishContext, path: string): FlowError[] {
  const id = node.config.save_field_id;
  if (typeof id !== "string") return [];
  const type = context.fields.get(id.toLowerCase());
  if (!type) return [error("unknown_field", path, { node_id: node.id })];
  if (type !== "text") return [error("invalid_field_type", path, { node_id: node.id })];
  if (context.webhookFields.has(id.toLowerCase()))
    return [error("reply_field_not_sendable", path, { node_id: node.id })];
  return [];
}

// A webhook node sends to one of the workspace's active endpoints, and only fields that are not archived.
// It sends no field that this draft or a published version saves a reply into (replyFields).
function webhookErrors(
  node: FlowNode,
  context: PublishContext,
  replyFields: ReadonlySet<string>,
  path: string,
): FlowError[] {
  const errors: FlowError[] = [];
  const ids = (node.config.field_ids as string[]).map((id) => id.toLowerCase());
  if (!context.endpoints.has(String(node.config.endpoint_id).toLowerCase()))
    errors.push(error("endpoint_unavailable", `${path}.endpoint_id`, { node_id: node.id }));
  if (ids.some((id) => !context.fields.has(id)))
    errors.push(error("unknown_field", `${path}.field_ids`, { node_id: node.id }));
  if (ids.some((id) => replyFields.has(id)))
    errors.push(error("reply_field_not_sendable", `${path}.field_ids`, { node_id: node.id }));
  return errors;
}

// The longest total delay on any path into each node, including the node's own delay or time wait.
// It assumes the edges have no cycle.
function delayTotals(nodes: FlowNode[], edges: FlowEdge[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  const totals = new Map<string, number>();
  const total = (id: string): number => {
    const known = totals.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id);
    const own =
      node?.type === "delay" && Number.isInteger(node.config.minutes)
        ? (node.config.minutes as number)
        : node?.type === "wait_until"
          ? TIME_WAIT_MINUTES
          : 0;
    const value = Math.max(0, ...(incoming.get(id) ?? []).map(total)) + own;
    totals.set(id, value);
    return value;
  };
  for (const node of nodes) total(node.id);
  return totals;
}

function hasCycle(nodes: FlowNode[], edges: FlowEdge[]): boolean {
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const waits = new Set(nodes.filter((node) => WAIT_TYPES.has(node.type)).map((node) => node.id));
  const state = new Map<string, "open" | "done">();
  const visit = (id: string): boolean => {
    if (waits.has(id) || state.get(id) === "done") return false;
    if (state.get(id) === "open") return true;
    state.set(id, "open");
    const found = (next.get(id) ?? []).some(visit);
    state.set(id, "done");
    return found;
  };
  return nodes.some((node) => visit(node.id));
}

export function validateFlowForPublish(input: unknown, context: PublishContext): FlowError[] {
  const parsed = parseFlowDocument(input);
  if ("errors" in parsed) return parsed.errors;
  const { nodes, edges } = parsed.document;
  const errors: FlowError[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const configValid = new Map<string, boolean>();
  const replyFields = new Set([...context.replyFields, ...replySaveFields(parsed.document)]);
  nodes.forEach((node, index) => {
    const path = `nodes[${index}].config`;
    if (!portsOf(node.type)) {
      errors.push(error("unknown_node_type", `nodes[${index}].type`, { node_id: node.id }));
      return;
    }
    const valid = validConfig(node);
    configValid.set(node.id, valid);
    if (!valid) {
      errors.push(error("invalid_config", path, { node_id: node.id }));
      return;
    }
    if (node.type === "set_field" || node.type === "field_equals")
      errors.push(...fieldErrors(node, context.fields, path));
    if (node.type === "wait_for_reply") errors.push(...saveFieldErrors(node, context, path));
    if (node.type === "webhook") errors.push(...webhookErrors(node, context, replyFields, path));
    if (node.type === "instagram_message")
      errors.push(...variableErrors(String(node.config.text), context.fields, `${path}.text`, node.id));
  });
  const triggers = nodes.filter((node) => node.type === "instagram_comment");
  if (triggers.length !== 1) errors.push(error("trigger_count", "nodes"));
  const valid: FlowEdge[] = [];
  const used = new Set<string>();
  edges.forEach((edge, index) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from) errors.push(error("missing_reference", `edges[${index}].from`, { edge_index: index }));
    if (!to) errors.push(error("missing_reference", `edges[${index}].to`, { edge_index: index }));
    if (!from || !to) return;
    const ports = portsOf(from.type);
    if (ports && !ports.includes(edge.port)) {
      errors.push(error("invalid_port", `edges[${index}].port`, { edge_index: index }));
      return;
    }
    const key = `${edge.from}\u0000${edge.port}`;
    if (used.has(key)) {
      errors.push(error("duplicate_port", `edges[${index}].port`, { edge_index: index }));
      return;
    }
    used.add(key);
    if (to.type === "instagram_comment")
      errors.push(error("trigger_has_incoming", `edges[${index}].to`, { edge_index: index }));
    // A reply wait listens for an answer to the private reply sent just before it.
    if (to.type === "wait_for_reply" && from.type !== "instagram_message")
      errors.push(error("wait_requires_message", `edges[${index}].from`, { edge_index: index }));
    valid.push(edge);
  });
  if (triggers.length !== 1) return errors;
  const [trigger] = triggers;
  const reached = new Set([trigger.id]);
  const queue = [trigger.id];
  while (queue.length) {
    const id = queue.shift() as string;
    for (const edge of valid)
      if (edge.from === id && !reached.has(edge.to)) {
        reached.add(edge.to);
        queue.push(edge.to);
      }
  }
  nodes.forEach((node, index) => {
    if (!reached.has(node.id)) errors.push(error("unreachable_node", `nodes[${index}]`, { node_id: node.id }));
  });
  // Nothing is sent after a reply wait in this version: the conversation it opened carries no
  // further private reply, so no message may be reachable from it.
  const afterWait = new Set<string>();
  const pending = nodes.filter((node) => node.type === "wait_for_reply").map((node) => node.id);
  while (pending.length) {
    const id = pending.shift() as string;
    for (const edge of valid)
      if (edge.from === id && !afterWait.has(edge.to)) {
        afterWait.add(edge.to);
        pending.push(edge.to);
      }
  }
  nodes.forEach((node, index) => {
    if (node.type === "instagram_message" && afterWait.has(node.id))
      errors.push(error("message_after_wait", `nodes[${index}]`, { node_id: node.id }));
  });
  if (hasCycle(nodes, valid)) errors.push(error("immediate_cycle", "edges"));
  else {
    const totals = delayTotals(nodes, valid);
    nodes.forEach((node, index) => {
      if (node.type === "instagram_message" && (totals.get(node.id) ?? 0) > MAX_DELAY_MINUTES)
        errors.push(error("delay_exceeds_reply_window", `nodes[${index}]`, { node_id: node.id }));
    });
  }
  if (!configValid.get(trigger.id)) return errors;
  const triggerPath = `nodes[${nodes.indexOf(trigger)}].config`;
  const connection = context.connection;
  if (!connection || connection.id !== String(trigger.config.connection_id).toLowerCase() || !connection.active)
    errors.push(error("connection_unavailable", `${triggerPath}.connection_id`, { node_id: trigger.id }));
  else
    nodes.forEach((node, index) => {
      if (node.type === "follows_account" && !connection.oauth)
        errors.push(error("login_mode_required", `nodes[${index}]`, { node_id: node.id }));
    });
  if (context.legacyRuleEnabled)
    errors.push(error("legacy_rule_conflict", `${triggerPath}.media_id`, { node_id: trigger.id }));
  if (context.otherFlowPublished)
    errors.push(error("flow_trigger_conflict", `${triggerPath}.media_id`, { node_id: trigger.id }));
  return errors;
}

export function flowReferences(document: FlowDocument): {
  connection_id: string | null;
  media_id: string | null;
  field_ids: string[];
  endpoint_ids: string[];
} {
  const trigger = document.nodes.find((node) => node.type === "instagram_comment");
  const fields = new Set<string>();
  const endpoints = new Set<string>();
  for (const node of document.nodes) {
    if (node.type === "webhook") {
      if (isUuid(node.config.endpoint_id)) endpoints.add(node.config.endpoint_id.toLowerCase());
      if (Array.isArray(node.config.field_ids))
        for (const id of node.config.field_ids) if (isUuid(id)) fields.add(id.toLowerCase());
    }
    if ((node.type === "set_field" || node.type === "field_equals") && isUuid(node.config.field_id))
      fields.add(node.config.field_id.toLowerCase());
    if (node.type === "wait_for_reply" && isUuid(node.config.save_field_id))
      fields.add(node.config.save_field_id.toLowerCase());
    if (node.type === "instagram_message" && typeof node.config.text === "string")
      for (const match of node.config.text.matchAll(/\{\{field:([^{}]+)\}\}/g))
        if (isUuid(match[1])) fields.add(match[1].toLowerCase());
  }
  return {
    connection_id: isUuid(trigger?.config.connection_id) ? trigger.config.connection_id.toLowerCase() : null,
    media_id: typeof trigger?.config.media_id === "string" ? trigger.config.media_id : null,
    field_ids: [...fields].sort(),
    endpoint_ids: [...endpoints].sort(),
  };
}
