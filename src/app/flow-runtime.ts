import { matchesCommentRule } from "../instagram/comment-rule.ts";
import { isValidFieldValue } from "./contact-fields.ts";
import { normalizeTag, replySaveFields, type FlowDocument, type FlowError, type FlowNode } from "./flow-schema.ts";

// What the runtime knows about the commenter when the comment arrives.
export type ContactFacts = { tags: ReadonlySet<string>; fields: ReadonlyMap<string, unknown> };
// The comment that started the run, the fields a set_field node or a reply wait may still write (not
// archived), the reply text when a reply resumes the run, and the fields that another published version
// of the workspace saves a reply into (a webhook node sends none of them).
export type RunInput = {
  commentText: string;
  writableFields: ReadonlySet<string>;
  replyText?: string;
  replyFields?: ReadonlySet<string>;
};
export type FlowStep = { node_id: string; node_type: string; outcome: string };
// Net changes against the facts: a tag maps to its new membership, a field to its new value.
export type FlowChanges = { tags: Map<string, boolean>; fields: Map<string, unknown> };
// What one webhook node sends: the contact facts when the walk reached it, after the actions before it.
// tags is present only when the node includes them; fields holds the chosen fields, null when unset. A
// field that a reply wait saves a reply into is left out, so reply text never leaves through a webhook.
export type FlowWebhook = { node_id: string; endpoint_id: string; tags?: string[]; fields: Record<string, unknown> };
// The body of one webhook delivery: the processing identifiers and what the node chose to send. A test
// run builds the same body with null in place of the identifiers that only a stored delivery has.
export function flowWebhookPayload(
  ids: {
    event_id: string | null;
    created_at: string | null;
    flow_id: string;
    flow_version: number | null;
    run_id: string | null;
  },
  webhook: FlowWebhook,
) {
  return {
    event_id: ids.event_id,
    type: "flow.webhook",
    created_at: ids.created_at,
    flow_id: ids.flow_id,
    flow_version: ids.flow_version,
    run_id: ids.run_id,
    node_id: webhook.node_id,
    ...(webhook.tags === undefined ? {} : { tags: webhook.tags }),
    fields: webhook.fields,
  };
}
// webhooks is present only when the walk reached a webhook node.
export type FlowPlan = { steps: FlowStep[]; changes: FlowChanges; webhooks?: FlowWebhook[] } & (
  | { status: "ended" }
  | { status: "message"; text: string; wait_node_id?: string }
  | { status: "failed"; failure_code: string }
  | { status: "waiting"; resume_node_id: string; delay_minutes: number }
  | { status: "waiting"; resume_node_id: string; until_time: string; delay_minutes?: undefined }
);

// Follow checks and message buttons are refused when a flow is enabled rather than skipped at run
// time.
const EXECUTABLE_TYPES = new Set([
  "instagram_comment",
  "has_tag",
  "field_equals",
  "instagram_message",
  "add_tag",
  "remove_tag",
  "set_field",
  "delay",
  "wait_until",
  "wait_for_reply",
  "webhook",
]);
// Where a stopped run continues: a delay or a time wait on next, a reply wait on replied or timeout.
export type ResumeEntry = { node_id: string; port: string };
const RESUME_PORTS: Record<string, string[]> = {
  delay: ["next"],
  wait_until: ["next"],
  wait_for_reply: ["replied", "timeout"],
};
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
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  // The only node after a message is a reply wait; anything else would send or act after the reply.
  document.edges.forEach((edge, index) => {
    if (byId.get(edge.from)?.type === "instagram_message" && !leadsToWait(document, edge))
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

function leadsToWait(document: FlowDocument, edge: FlowDocument["edges"][number]): boolean {
  return edge.port === "next" && document.nodes.some((node) => node.id === edge.to && node.type === "wait_for_reply");
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

// Walks one published document from its trigger, or from the delay or reply wait a run stopped at.
// The result depends only on the document, the facts and the input, so a run records exactly the
// path that produced its message. Actions change the facts that later nodes read; a failure keeps
// the changes of the actions before it, and the webhooks reached before it are still queued. A webhook
// node only records what to send and the walk continues. A delay or a time wait ends this walk as waiting, and a
// message followed by a reply wait names the wait. Resuming after either records only the nodes after
// it; resuming at
// a reply wait first records the port taken and, when the wait saves the reply, the save outcome, so
// the run's steps read as one path.
export function planFlowRun(
  document: FlowDocument,
  facts: ContactFacts,
  input: RunInput,
  resume?: ResumeEntry,
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
  const webhooks: FlowWebhook[] = [];
  // Publishing refuses a webhook node that names such a field; a version that names one anyway (another
  // flow made it a reply field later) sends the rest.
  const replyFields = new Set([...(input.replyFields ?? []), ...replySaveFields(document)]);
  // What every result of this walk carries besides its status and steps.
  const effects = (): { changes: FlowChanges; webhooks?: FlowWebhook[] } => ({
    changes: changes(),
    ...(webhooks.length ? { webhooks } : {}),
  });
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const start = resume === undefined ? trigger(document) : byId.get(resume.node_id);
  if (
    !start ||
    (resume !== undefined &&
      !(Object.hasOwn(RESUME_PORTS, start.type) && RESUME_PORTS[start.type]!.includes(resume.port)))
  )
    return { status: "failed", steps: [], failure_code: "invalid_definition", ...effects() };
  const steps: FlowStep[] = [];
  const afterWait = start.type === "wait_for_reply";
  if (resume === undefined) steps.push({ node_id: start.id, node_type: start.type, outcome: "next" });
  else if (afterWait) {
    steps.push({ node_id: start.id, node_type: start.type, outcome: resume.port });
    const target = start.config.save_field_id;
    if (resume.port === "replied" && typeof target === "string") {
      // A reply that cannot be stored is recorded on the wait and the run still takes replied.
      const id = target.toLowerCase();
      let outcome: string;
      if (!input.writableFields.has(id)) outcome = "field_unavailable";
      else if (!isValidFieldValue("text", input.replyText)) outcome = "reply_invalid";
      else if (fields.get(id) === input.replyText) outcome = "unchanged";
      else {
        fields.set(id, input.replyText);
        outcome = "set";
      }
      steps.push({ node_id: start.id, node_type: start.type, outcome });
    }
  }
  const fail = (node: FlowNode, code: string): FlowPlan => {
    steps.push({ node_id: node.id, node_type: node.type, outcome: code });
    return { status: "failed", steps, failure_code: code, ...effects() };
  };
  let current = start;
  let port = resume?.port ?? "next";
  while (steps.length <= document.nodes.length) {
    const edge = document.edges.find((candidate) => candidate.from === current.id && candidate.port === port);
    if (!edge) return { status: "ended", steps, ...effects() };
    const node = byId.get(edge.to);
    if (!node) return { status: "failed", steps, failure_code: "invalid_definition", ...effects() };
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
    } else if (node.type === "webhook") {
      // The store queues the delivery in the run's transaction; the walk goes on without waiting.
      const fieldIds = node.config.field_ids;
      if (
        typeof node.config.endpoint_id !== "string" ||
        !Array.isArray(fieldIds) ||
        fieldIds.some((id) => typeof id !== "string")
      )
        return fail(node, "invalid_definition");
      webhooks.push({
        node_id: node.id,
        endpoint_id: node.config.endpoint_id.toLowerCase(),
        ...(node.config.include_tags === true ? { tags: [...tags] } : {}),
        fields: Object.fromEntries(
          (fieldIds as string[])
            .map((id) => id.toLowerCase())
            .filter((id) => !replyFields.has(id))
            .map((id) => [id, fields.get(id) ?? null]),
        ),
      });
      outcome = "queued";
    } else if (node.type === "delay") {
      steps.push({ node_id: node.id, node_type: node.type, outcome: "waiting" });
      return {
        status: "waiting",
        steps,
        resume_node_id: node.id,
        delay_minutes: node.config.minutes as number,
        ...effects(),
      };
    } else if (node.type === "wait_until") {
      // The resume time depends on the workspace time zone, so the store computes it.
      steps.push({ node_id: node.id, node_type: node.type, outcome: "waiting" });
      return {
        status: "waiting",
        steps,
        resume_node_id: node.id,
        until_time: String(node.config.time),
        ...effects(),
      };
    } else if (node.type === "instagram_message" && node.config.button_title === undefined && !afterWait) {
      const outgoing = document.edges.filter((candidate) => candidate.from === node.id);
      if (outgoing.some((candidate) => !leadsToWait(document, candidate))) return fail(node, "unsupported_node");
      const rendered = render(String(node.config.text), fields, input);
      if ("error" in rendered) return fail(node, rendered.error);
      steps.push({ node_id: node.id, node_type: node.type, outcome: "queued" });
      const wait = outgoing[0]?.to;
      return {
        status: "message",
        steps,
        text: rendered.text,
        ...(wait === undefined ? {} : { wait_node_id: wait }),
        ...effects(),
      };
    } else return fail(node, "unsupported_node");
    steps.push({ node_id: node.id, node_type: node.type, outcome });
  }
  return { status: "failed", steps, failure_code: "step_limit", ...effects() };
}
