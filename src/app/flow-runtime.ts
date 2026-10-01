import { matchesCommentRule } from "../instagram/comment-rule.ts";
import { normalizeTag, type FlowDocument, type FlowError, type FlowNode } from "./flow-schema.ts";

// What the runtime knows about the commenter when the comment arrives.
export type ContactFacts = { tags: ReadonlySet<string>; fields: ReadonlyMap<string, unknown> };
// The comment that started the run and the fields a set_field node may still write (not archived).
export type RunInput = { commentText: string; writableFields: ReadonlySet<string> };
export type FlowStep = { node_id: string; node_type: string; outcome: string };
// Net changes against the facts: a tag maps to its new membership, a field to its new value.
export type FlowChanges = { tags: Map<string, boolean>; fields: Map<string, unknown> };
export type FlowPlan = { steps: FlowStep[]; changes: FlowChanges } & (
  | { status: "ended" }
  | { status: "message"; text: string }
  | { status: "failed"; failure_code: string }
  | { status: "waiting"; resume_node_id: string; delay_minutes: number }
);

// Reply waits (#32), follow checks and message buttons are refused when a flow is enabled rather
// than skipped at run time.
const EXECUTABLE_TYPES = new Set([
  "instagram_comment",
  "has_tag",
  "field_equals",
  "instagram_message",
  "add_tag",
  "remove_tag",
  "set_field",
  "delay",
]);
const MAX_TAGS = 20;
const MAX_MESSAGE = 1000;
const VARIABLE = /\{\{([^{}]*)\}\}/g;

function trigger(document: FlowDocument): FlowNode | undefined {
  return document.nodes.find((node) => node.type === "instagram_comment");
}

function variableFieldIds(text: string): string[] {
  return [...text.matchAll(VARIABLE)].flatMap((match) => {
    const field = /^field:(.+)$/.exec(match[1]!);
    return field ? [field[1]!.toLowerCase()] : [];
  });
}

export function flowExecutionErrors(document: FlowDocument, fieldTypes: ReadonlyMap<string, string>): FlowError[] {
  const errors: FlowError[] = [];
  document.nodes.forEach((node, index) => {
    if (!EXECUTABLE_TYPES.has(node.type))
      errors.push({ code: "unsupported_node", node_id: node.id, path: `nodes[${index}].type` });
    else if (node.type === "instagram_message" && node.config.button_title !== undefined)
      errors.push({ code: "unsupported_message", node_id: node.id, path: `nodes[${index}].config` });
    else if (
      node.type === "instagram_message" &&
      variableFieldIds(String(node.config.text)).some((id) => fieldTypes.get(id) === "boolean")
    )
      errors.push({ code: "unsupported_variable", node_id: node.id, path: `nodes[${index}].config.text` });
  });
  const messages = new Set(document.nodes.filter((node) => node.type === "instagram_message").map((node) => node.id));
  document.edges.forEach((edge, index) => {
    if (messages.has(edge.from))
      errors.push({ code: "unsupported_after_message", edge_index: index, path: `edges[${index}]` });
  });
  return errors;
}

export function matchesFlowTrigger(document: FlowDocument, text: string): boolean {
  const config = trigger(document)?.config;
  if (!config) return false;
  return matchesCommentRule(text, {
    keyword: "",
    keywords: config.keywords as string[],
    match_mode: config.match_mode as "contains" | "exact" | "all",
    excluded_keywords: config.excluded_keywords as string[],
  });
}

function fieldMatches(node: FlowNode, fields: ReadonlyMap<string, unknown>): boolean {
  const value = fields.get(String(node.config.field_id).toLowerCase());
  const set = value !== undefined && value !== null;
  if (node.config.field_operator === "is_set") return set;
  if (node.config.field_operator === "is_unset") return !set;
  return set && value === node.config.field_value;
}

// Substitutes every variable in one pass; substituted values are never scanned again, so comment
// text and stored field values cannot introduce variables of their own.
function render(
  text: string,
  fields: ReadonlyMap<string, unknown>,
  input: RunInput,
): { text: string } | { error: string } {
  let error: string | null = null;
  const rendered = text.replace(VARIABLE, (_, name: string) => {
    if (name === "comment.text") return input.commentText;
    const value = fields.get(name.slice("field:".length).toLowerCase());
    if (value === undefined || value === null) error ??= "variable_missing";
    else if (typeof value === "boolean") error ??= "unsupported_variable";
    return String(value ?? "");
  });
  if (error) return { error };
  if (!rendered.trim()) return { error: "message_empty" };
  if (rendered.length > MAX_MESSAGE) return { error: "message_too_long" };
  return { text: rendered };
}

// Walks one published document from its trigger, or from the delay a waiting run stopped at. The
// result depends only on the document, the facts and the input, so a run records exactly the path
// that produced its message. Actions change the facts that later nodes read; a failure keeps the
// changes of the actions before it. A delay ends this walk as waiting; resuming records only the
// nodes after it, so the run's steps read as one path.
export function planFlowRun(
  document: FlowDocument,
  facts: ContactFacts,
  input: RunInput,
  resumeFrom?: string,
): FlowPlan {
  const tags = new Set(facts.tags);
  const fields = new Map(facts.fields);
  const changes = (): FlowChanges => ({
    tags: new Map(
      [...new Set([...facts.tags, ...tags])]
        .filter((tag) => facts.tags.has(tag) !== tags.has(tag))
        .map((tag) => [tag, tags.has(tag)]),
    ),
    fields: new Map([...fields].filter(([id, value]) => facts.fields.get(id) !== value)),
  });
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const start = resumeFrom === undefined ? trigger(document) : byId.get(resumeFrom);
  if (!start || (resumeFrom !== undefined && start.type !== "delay"))
    return { status: "failed", steps: [], failure_code: "invalid_definition", changes: changes() };
  const steps: FlowStep[] =
    resumeFrom === undefined ? [{ node_id: start.id, node_type: start.type, outcome: "next" }] : [];
  const fail = (node: FlowNode, code: string): FlowPlan => {
    steps.push({ node_id: node.id, node_type: node.type, outcome: code });
    return { status: "failed", steps, failure_code: code, changes: changes() };
  };
  let current = start;
  let port = "next";
  while (steps.length <= document.nodes.length) {
    const edge = document.edges.find((candidate) => candidate.from === current.id && candidate.port === port);
    if (!edge) return { status: "ended", steps, changes: changes() };
    const node = byId.get(edge.to);
    if (!node) return { status: "failed", steps, failure_code: "invalid_definition", changes: changes() };
    current = node;
    let outcome: string;
    port = "next";
    if (node.type === "has_tag" || node.type === "field_equals") {
      const tag = node.type === "has_tag" ? normalizeTag(node.config.tag) : null;
      port = String(node.type === "has_tag" ? tag !== null && tags.has(tag) : fieldMatches(node, fields));
      outcome = port;
    } else if (node.type === "add_tag" || node.type === "remove_tag") {
      const tag = normalizeTag(node.config.tag);
      if (tag === null) return fail(node, "invalid_definition");
      if (node.type === "remove_tag") outcome = tags.delete(tag) ? "removed" : "absent";
      else if (tags.has(tag)) outcome = "already_present";
      else if (tags.size >= MAX_TAGS) outcome = "tag_limit";
      else {
        tags.add(tag);
        outcome = "added";
      }
    } else if (node.type === "set_field") {
      const id = String(node.config.field_id).toLowerCase();
      if (!input.writableFields.has(id)) return fail(node, "field_unavailable");
      if (fields.get(id) === node.config.value) outcome = "unchanged";
      else {
        fields.set(id, node.config.value);
        outcome = "set";
      }
    } else if (node.type === "delay") {
      steps.push({ node_id: node.id, node_type: node.type, outcome: "waiting" });
      return {
        status: "waiting",
        steps,
        resume_node_id: node.id,
        delay_minutes: node.config.minutes as number,
        changes: changes(),
      };
    } else if (
      node.type === "instagram_message" &&
      node.config.button_title === undefined &&
      !document.edges.some((candidate) => candidate.from === node.id)
    ) {
      const rendered = render(String(node.config.text), fields, input);
      if ("error" in rendered) return fail(node, rendered.error);
      steps.push({ node_id: node.id, node_type: node.type, outcome: "queued" });
      return { status: "message", steps, text: rendered.text, changes: changes() };
    } else return fail(node, "unsupported_node");
    steps.push({ node_id: node.id, node_type: node.type, outcome });
  }
  return { status: "failed", steps, failure_code: "step_limit", changes: changes() };
}
