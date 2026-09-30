import { matchesCommentRule } from "../instagram/comment-rule.ts";
import { normalizeTag, type FlowDocument, type FlowError, type FlowNode } from "./flow-schema.ts";

// What the runtime knows about the commenter when the comment arrives.
export type ContactFacts = { tags: ReadonlySet<string>; fields: ReadonlyMap<string, unknown> };
export type FlowStep = { node_id: string; node_type: string; outcome: string };
export type FlowPlan =
  | { status: "ended"; steps: FlowStep[] }
  | { status: "message"; steps: FlowStep[]; text: string }
  | { status: "failed"; steps: FlowStep[]; failure_code: string };

// This slice executes branching and one first message; tag/field actions (#31), waits (#32)
// and follow checks are refused when a flow is enabled rather than skipped at run time.
const EXECUTABLE_TYPES = new Set(["instagram_comment", "has_tag", "field_equals", "instagram_message"]);

function trigger(document: FlowDocument): FlowNode | undefined {
  return document.nodes.find((node) => node.type === "instagram_comment");
}

function messageSupported(node: FlowNode): boolean {
  return node.config.button_title === undefined && !String(node.config.text).includes("{{");
}

export function flowExecutionErrors(document: FlowDocument): FlowError[] {
  const errors: FlowError[] = [];
  document.nodes.forEach((node, index) => {
    if (!EXECUTABLE_TYPES.has(node.type))
      errors.push({ code: "unsupported_node", node_id: node.id, path: `nodes[${index}].type` });
    else if (node.type === "instagram_message" && !messageSupported(node))
      errors.push({ code: "unsupported_message", node_id: node.id, path: `nodes[${index}].config` });
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

function fieldMatches(node: FlowNode, facts: ContactFacts): boolean {
  const value = facts.fields.get(String(node.config.field_id).toLowerCase());
  const set = value !== undefined && value !== null;
  if (node.config.field_operator === "is_set") return set;
  if (node.config.field_operator === "is_unset") return !set;
  return set && value === node.config.field_value;
}

// Walks one published document from its trigger. The result depends only on the document and
// the facts, so a run records exactly the path that produced its message.
export function planFlowRun(document: FlowDocument, facts: ContactFacts): FlowPlan {
  const start = trigger(document);
  if (!start) return { status: "failed", steps: [], failure_code: "invalid_definition" };
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const steps: FlowStep[] = [{ node_id: start.id, node_type: start.type, outcome: "next" }];
  let current = start;
  let port = "next";
  while (steps.length <= document.nodes.length) {
    const edge = document.edges.find((candidate) => candidate.from === current.id && candidate.port === port);
    if (!edge) return { status: "ended", steps };
    const node = byId.get(edge.to);
    if (!node) return { status: "failed", steps, failure_code: "invalid_definition" };
    current = node;
    if (node.type === "has_tag" || node.type === "field_equals") {
      const tag = node.type === "has_tag" ? normalizeTag(node.config.tag) : null;
      port = String(node.type === "has_tag" ? tag !== null && facts.tags.has(tag) : fieldMatches(node, facts));
      steps.push({ node_id: node.id, node_type: node.type, outcome: port });
    } else if (
      node.type === "instagram_message" &&
      messageSupported(node) &&
      !document.edges.some((candidate) => candidate.from === node.id)
    ) {
      steps.push({ node_id: node.id, node_type: node.type, outcome: "queued" });
      return { status: "message", steps, text: String(node.config.text) };
    } else {
      steps.push({ node_id: node.id, node_type: node.type, outcome: "unsupported_node" });
      return { status: "failed", steps, failure_code: "unsupported_node" };
    }
  }
  return { status: "failed", steps, failure_code: "step_limit" };
}
