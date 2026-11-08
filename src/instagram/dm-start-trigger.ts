import type { PoolClient } from "pg";
import type { InstagramMessage } from "./message-events.ts";
import { messagingRecipientOptedOut } from "./channel-consent.ts";
import { REPLY_DEADLINE } from "./store.ts";
import { DM_TRIGGER_TYPES, parseFlowDocument, type FlowDocument } from "../app/flow-schema.ts";
import { matchesFlowTrigger, planFlowRun, type FlowPlan } from "../app/flow-runtime.ts";

// The sender IDs the DM trigger tables store; a longer one starts nothing instead of failing the batch.
const SENDER = /^[0-9]{1,40}$/;

type Connection = { id: string; workspace_id: string };
type Candidate = { flow_id: string; version_id: string; trigger_type: string; definition: unknown };

// Starts at most one published DM trigger flow for a typed DM (#33), in the message ingestion transaction, after the
// reply wait and the follow confirmation have had their turn and did not take it. A keyword trigger beats the
// default-reply trigger, and among matching keyword flows the oldest flow wins. The start event, the run and the run's
// first message (flow_dm_deliveries) are written together; nothing is sent and no outbox row is written. Nothing
// here throws on data: a value the new tables cannot store or a definition that does not parse starts nothing, so
// the batch's inbox rows and confirmations are never rolled back by it. Flow and version rows are read without a
// lock: publish and enable lock the flow and then the connection, so a flow lock here could deadlock with them.
export async function startDmTriggerFlow(client: PoolClient, message: InstagramMessage): Promise<boolean> {
  if (
    message.confirmationReplyId !== undefined ||
    !SENDER.test(message.senderId) ||
    message.messageId.length > 512 ||
    message.text.includes("\u0000")
  )
    return false;
  // FOR SHARE like the other connection-scoped writes of ingestion, so a disconnect or a data deletion cannot
  // commit between these reads and the inserts.
  const connection = (
    await client.query<Connection>(
      `SELECT id::text,workspace_id::text FROM instagram_connections WHERE account_id=$1 AND active
       ORDER BY id LIMIT 1 FOR SHARE`,
      [message.accountId],
    )
  ).rows[0];
  if (!connection) return false;
  const candidates = await client.query<Candidate>(
    `SELECT f.id::text AS flow_id,v.id::text AS version_id,v.trigger_type,v.definition FROM flows f
     JOIN flow_versions v ON v.id=f.published_version_id AND v.flow_id=f.id
     WHERE f.workspace_id=$1 AND f.enabled AND NOT f.archived AND v.trigger_connection_id=$2
       AND v.trigger_type=ANY($3::text[])
     ORDER BY v.trigger_type='instagram_dm_default',f.created_at,f.id`,
    [connection.workspace_id, connection.id, [...DM_TRIGGER_TYPES]],
  );
  let chosen: (Candidate & { document: FlowDocument }) | undefined;
  for (const candidate of candidates.rows) {
    const parsed = parseFlowDocument(candidate.definition);
    if ("document" in parsed && matchesFlowTrigger(parsed.document, message.text)) {
      chosen = { ...candidate, document: parsed.document };
      break;
    }
  }
  if (!chosen || (await startBlocked(client, connection, message))) return false;
  const started = await client.query<{ id: string }>(
    `INSERT INTO instagram_dm_start_events(workspace_id,connection_id,message_id,sender_id,flow_id,flow_version_id,trigger_type,message_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(connection_id,message_id) DO NOTHING RETURNING id::text`,
    [
      connection.workspace_id,
      connection.id,
      message.messageId,
      message.senderId,
      chosen.flow_id,
      chosen.version_id,
      chosen.trigger_type,
      message.timestamp,
    ],
  );
  const startEvent = started.rows[0];
  if (!startEvent) return false;
  const plan = dmPlan(chosen.document);
  const status = plan.status === "message" ? "delivering" : plan.status;
  const runs = await client.query<{ id: string }>(
    `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,dm_start_event_id,status,failure_code)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(flow_id,dm_start_event_id) DO NOTHING RETURNING id::text`,
    [
      connection.workspace_id,
      connection.id,
      chosen.flow_id,
      chosen.version_id,
      startEvent.id,
      status,
      plan.status === "failed" ? plan.failure_code : null,
    ],
  );
  const run = runs.rows[0];
  if (!run) return false;
  if (plan.status === "message")
    await client.query(
      `INSERT INTO flow_dm_deliveries(workspace_id,connection_id,flow_run_id,recipient_id,message_text)
       VALUES($1,$2,$3,$4,$5)`,
      [connection.workspace_id, connection.id, run.id, message.senderId, plan.text],
    );
  await client.query(
    `INSERT INTO flow_step_runs(run_id,workspace_id,connection_id,seq,node_id,node_type,outcome)
     SELECT $1,$2,$3,step.seq-1,step.node_id,step.node_type,step.outcome
     FROM unnest($4::text[],$5::text[],$6::text[]) WITH ORDINALITY AS step(node_id,node_type,outcome,seq)`,
    [
      run.id,
      connection.workspace_id,
      connection.id,
      plan.steps.map((step) => step.node_id),
      plan.steps.map((step) => step.node_type),
      plan.steps.map((step) => step.outcome),
    ],
  );
  return true;
}

// The walk of a DM-triggered version: no contact facts (the messaging sender is not a comment contact) and no
// comment. Publishing allows only the trigger and messages without variables, so the walk ends, fails or reaches
// one message with nothing after it. A version that would change contact data, queue a webhook or stop at a wait
// fails as unsupported_node rather than writing anything keyed by the wrong identity, and so does a message with a
// variable, which publishing refuses too (dm_trigger_unsupported_variable): the walk has no comment, so
// {{comment.text}} would render empty instead of failing.
export function dmPlan(document: FlowDocument): Extract<FlowPlan, { status: "message" | "ended" | "failed" }> {
  const changes = { tags: new Map<string, boolean>(), fields: new Map<string, unknown>() };
  if (document.nodes.some((node) => node.type === "instagram_message" && /\{\{|\}\}/.test(String(node.config.text))))
    return { status: "failed", steps: [], failure_code: "unsupported_node", changes };
  const plan = planFlowRun(
    document,
    { tags: new Set(), fields: new Map() },
    { commentText: "", writableFields: new Set() },
  );
  const unsupported =
    plan.status === "waiting" ||
    (plan.status === "message" && plan.wait_node_id !== undefined) ||
    plan.webhooks !== undefined ||
    plan.changes.tags.size > 0 ||
    plan.changes.fields.size > 0;
  if (unsupported) return { status: "failed", steps: [], failure_code: "unsupported_node", changes };
  return plan as Extract<FlowPlan, { status: "message" | "ended" | "failed" }>;
}

// Whether this DM may not start a DM trigger (#33). Existing consumers win: a message ID that a follow confirmation,
// a reply wait or the kept-DM store already used (a redelivery), and any sender who has an active run that this
// sender can still resume, a pending follow confirmation, or a kept DM still inside its 15-minute window (the
// reconcile may still link it to a waiting run). An opted-out messaging identity (its own revoke or one reached
// through a provider-acknowledged reply bridge, messagingRecipientOptedOut) and a handed-off conversation are
// refused as well. The pause of a messaging ID is #291's, together with the send-time recheck.
async function startBlocked(client: PoolClient, connection: Connection, message: InstagramMessage): Promise<boolean> {
  const blocked = await client.query<{ blocked: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM instagram_message_receipts WHERE connection_id=$1 AND message_id=$3)
       OR EXISTS(SELECT 1 FROM flow_runs WHERE connection_id=$1 AND reply_message_id=$3)
       OR EXISTS(SELECT 1 FROM instagram_unmatched_replies WHERE connection_id=$1 AND message_id=$3)
       OR EXISTS(SELECT 1 FROM instagram_unmatched_replies kept
         WHERE kept.connection_id=$1 AND kept.sender_id=$2 AND kept.matched_at IS NULL
           AND kept.message_text IS NOT NULL AND kept.received_at>now()-interval '15 minutes')
       OR EXISTS(SELECT 1 FROM instagram_follow_conversations flow
         JOIN private_reply_outbox reply ON reply.id=flow.reply_id
         JOIN instagram_comment_rules rule ON rule.id=reply.rule_id
         WHERE flow.connection_id=$1 AND flow.recipient_id=$2 AND flow.status IN ('waiting','pending','sending')
           AND rule.enabled)
       OR EXISTS(SELECT 1 FROM flow_runs run
         JOIN private_reply_outbox reply ON reply.flow_run_id=run.id JOIN flow_versions v ON v.id=run.flow_version_id
         WHERE run.connection_id=$1 AND run.status='awaiting_reply' AND reply.status='sent' AND reply.recipient_id=$2
           AND now()<${REPLY_DEADLINE})
       OR EXISTS(SELECT 1 FROM flow_runs run JOIN instagram_dm_start_events start ON start.id=run.dm_start_event_id
         WHERE run.connection_id=$1 AND start.sender_id=$2 AND run.status IN ('waiting','awaiting_reply'))
       OR EXISTS(SELECT 1 FROM instagram_inbox_handoffs
         WHERE workspace_id=$4 AND connection_id=$1 AND recipient_id=$2 AND active)
       AS blocked`,
    [connection.id, message.senderId, message.messageId, connection.workspace_id],
  );
  if (blocked.rows[0]?.blocked) return true;
  return messagingRecipientOptedOut(client, {
    workspaceId: connection.workspace_id,
    connectionId: connection.id,
    recipientId: message.senderId,
  });
}
