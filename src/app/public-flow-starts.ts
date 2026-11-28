import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid } from "./auth.ts";
import { CONNECTION_SENDABLE, latestTextSql, recipientStageSql } from "./campaign-drafts.ts";
import { DM_TRIGGER_TYPES, parseFlowDocument } from "./flow-schema.ts";
import { verifiedDmRecipientsSql } from "./inbox-identity.ts";
import { ACTIVE_CONTACT_LIMIT, activeContactLimitBlocks } from "./plans.ts";
import { hasDuplicateJsonKey } from "./public-contact-writes.ts";
import { dmWindowAnchorSql } from "../instagram/dm-flow-delivery-worker.ts";
import { dmPlan, messagingSenderBusySql } from "../instagram/dm-start-trigger.ts";
import { dmStartSkipCodeSql } from "../instagram/send-quota.ts";

// POST /v1/flows/{flow_id}/starts and GET /v1/flows (#48, docs/specs/2026-11-28-public-flow-start-design.md). An
// external system starts one published DM flow for one existing comment contact. The run is pinned to the published
// version and planned with dmPlan, as a DM trigger run is, and a version whose plan sends no message is refused; its
// first message is a flow_dm_deliveries row, which the
// DM flow delivery worker sends after its own final guard. Accepting a start never sends and never promises a send.
// No stored contact, tag or field proves messaging consent or delivery eligibility: the request reads the consent
// state, the 24-hour window, the pauses and the limits, and the delivery guard reads them again before the POST.

export const FLOW_START_REQUEST_BYTES = 4096;
export const FLOW_LIST_LIMIT = 100;
const BODY_KEYS = ["connection_id", "request_key", "sender_id"];

export type FlowStartRequest = { flowId: string; requestKey: string; connectionId: string; senderId: string; hash: string };
export type FlowStart = { start_id: string; run_id: string; status: "queued" };

function invalid(): ApiError {
  return new ApiError(400, "invalid_request");
}

// The request body text: JSON refused (400 invalid_request through the caller) when an object names a key twice.
export function parseFlowStartBody(text: string): unknown {
  const value: unknown = JSON.parse(text);
  if (hasDuplicateJsonKey(text)) throw invalid();
  return value;
}

// The SHA-256 hex of what a start asks for: the lowercase flow and connection IDs and the exact sender ID, in this
// fixed order. The request key is not part of it, because the key names the request.
export function flowStartRequestHash(flowId: string, connectionId: string, senderId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([flowId, connectionId, senderId]))
    .digest("hex");
}

// The path's flow ID and the body { request_key, connection_id, sender_id }. A flow ID, request key or connection ID
// that is not a UUID, a sender ID that is not a non-empty string or contains NUL (which PostgreSQL text cannot hold),
// and a missing or unknown key are 400 invalid_request.
export function parseFlowStart(flow: string, input: unknown): FlowStartRequest {
  if (!isUuid(flow) || !isRecord(input)) throw invalid();
  const keys = Object.keys(input).sort();
  if (keys.length !== BODY_KEYS.length || keys.some((key, index) => key !== BODY_KEYS[index])) throw invalid();
  if (!isUuid(input.request_key) || !isUuid(input.connection_id)) throw invalid();
  if (typeof input.sender_id !== "string" || !input.sender_id.trim() || input.sender_id.includes("\0")) throw invalid();
  const flowId = flow.toLowerCase();
  const connectionId = input.connection_id.toLowerCase();
  return { flowId, requestKey: input.request_key.toLowerCase(), connectionId, senderId: input.sender_id, hash: flowStartRequestHash(flowId, connectionId, input.sender_id) };
}

async function transaction<T>(pool: Pick<Pool, "connect">, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// The flows this key can start: enabled, not archived, with a published DM trigger version. The definition and the
// message text are not returned.
export async function listFlowsToStart(pool: Pick<Pool, "query">, workspaceId: string): Promise<{ id: string; name: string; connection_id: string }[]> {
  return (
    await pool.query<{ id: string; name: string; connection_id: string }>(
      `SELECT f.id::text AS id,f.name,v.trigger_connection_id::text AS connection_id FROM flows f
       JOIN flow_versions v ON v.id=f.published_version_id AND v.flow_id=f.id
       WHERE f.workspace_id=$1 AND f.enabled AND NOT f.archived AND v.trigger_type=ANY($2::text[])
       ORDER BY f.created_at,f.id LIMIT $3`,
      [workspaceId, [...DM_TRIGGER_TYPES], FLOW_LIST_LIMIT],
    )
  ).rows;
}

// The verified DM recipients of the comment contact with their stage, most recent stored text, attachment or
// unsupported DM first: 4 and 5 are the campaign's recipient stages (recipientStageSql: a marketing or service reply
// revoke of the recipient or the comment sender, and no exact explicit marketing grant), 6 is a closed 24-hour window
// measured as the DM flow delivery guard measures it (dmWindowAnchorSql), and 7 passes. $1 is the workspace, $2 the
// connection and $3 the comment sender.
const RECIPIENTS_SQL = `WITH evaluation AS MATERIALIZED (SELECT statement_timestamp() AS as_of),
 verified AS MATERIALIZED (${verifiedDmRecipientsSql("workspace_id=$1 AND id=$2")})
 SELECT v.recipient_id,CASE WHEN consent.stage IN (4,5) THEN consent.stage
     WHEN coalesce(evaluation.as_of<${dmWindowAnchorSql("v")}+interval '24 hours',false) THEN 7 ELSE 6 END AS stage
 FROM verified v CROSS JOIN evaluation CROSS JOIN LATERAL ${latestTextSql("$1")}
 CROSS JOIN LATERAL (SELECT ${recipientStageSql("$1")} AS stage) consent
 WHERE v.connection_id=$2 AND v.sender_id=$3
 ORDER BY latest.message_at DESC NULLS LAST,v.recipient_id`;

const STAGE_CODES: Record<number, string> = { 4: "recipient_opted_out", 5: "marketing_consent_required", 6: "reply_window_closed" };

// A same request again: the stored result when the key's request hash is the same and its start still exists.
// Another request under the key, or a start that a data deletion removed, is 409 idempotency_conflict.
async function replay(client: PoolClient, workspaceId: string, request: FlowStartRequest): Promise<FlowStart & { connection_id: string; created: false }> {
  const stored = (
    await client.query<{ request_hash: string; start_id: string | null; run_id: string | null; connection_id: string | null }>(
      `SELECT k.request_hash,s.id::text AS start_id,run.id::text AS run_id,s.connection_id::text AS connection_id
       FROM flow_api_start_keys k
       LEFT JOIN flow_api_starts s ON s.workspace_id=k.workspace_id AND s.request_key=k.request_key
       LEFT JOIN flow_runs run ON run.api_start_id=s.id AND run.workspace_id=s.workspace_id
       WHERE k.workspace_id=$1 AND k.request_key=$2`,
      [workspaceId, request.requestKey],
    )
  ).rows[0];
  if (!stored || stored.request_hash !== request.hash || !stored.start_id || !stored.run_id) throw new ApiError(409, "idempotency_conflict");
  return { start_id: stored.start_id, run_id: stored.run_id, status: "queued", connection_id: stored.connection_id!, created: false };
}

// Accepts one start in one transaction, or refuses it with the first code of the spec's table and writes nothing.
// Lock order: the workspace FOR KEY SHARE (as writeContact, before a workspace deletion's FOR UPDATE), the request
// key row, the flow FOR SHARE and then the connection FOR SHARE (the order publish and enable lock them), then the
// messaging sender's dm-start-sender advisory lock, the key that DM trigger starts take, so a DM start and an
// external start of one recipient see each other's start for the cooldown. The request key row is inserted first:
// a concurrent request with the same key waits on its unique index and then reads the stored result, or proceeds
// when the first one rolled back.
export async function startFlow(pool: Pick<Pool, "connect">, apiKey: { id: string; workspace_id: string }, request: FlowStartRequest, globalSendEnabled: boolean): Promise<FlowStart & { connection_id: string; created: boolean }> {
  const workspaceId = apiKey.workspace_id;
  return transaction(pool, async (client) => {
    await client.query("SELECT 1 FROM workspaces WHERE id=$1 FOR KEY SHARE", [workspaceId]);
    const claimed = await client.query(
      `INSERT INTO flow_api_start_keys(workspace_id,request_key,request_hash) VALUES($1,$2,$3)
       ON CONFLICT(workspace_id,request_key) DO NOTHING RETURNING request_key`,
      [workspaceId, request.requestKey, request.hash],
    );
    if (!claimed.rowCount) return replay(client, workspaceId, request);
    const flow = (
      await client.query<{ available: boolean; version_id: string | null; definition: unknown }>(
        `SELECT coalesce(f.enabled AND NOT f.archived AND v.trigger_type=ANY($3::text[]) AND v.trigger_connection_id=$4,false) AS available,
           v.id::text AS version_id,v.definition
         FROM flows f LEFT JOIN flow_versions v ON v.id=f.published_version_id AND v.flow_id=f.id
         WHERE f.workspace_id=$1 AND f.id=$2 FOR SHARE OF f`,
        [workspaceId, request.flowId, [...DM_TRIGGER_TYPES], request.connectionId],
      )
    ).rows[0];
    if (!flow) throw new ApiError(404, "flow_not_found");
    const parsed = flow.available ? parseFlowDocument(flow.definition) : null;
    if (!parsed || !("document" in parsed)) throw new ApiError(409, "flow_unavailable");
    // A version whose walk sends no first message (dmPlan ends, or fails such as unsupported_node) is refused: an
    // external start exists to send that message, so accepting it would answer 202 for a start that cannot send.
    const plan = dmPlan(parsed.document);
    if (plan.status !== "message") throw new ApiError(409, "flow_unavailable");
    const connection = (
      await client.query<{ account_id: string; sendable: boolean }>(
        `WITH evaluation AS MATERIALIZED (SELECT statement_timestamp() AS as_of)
         SELECT c.account_id,${CONNECTION_SENDABLE} AS sendable FROM instagram_connections c CROSS JOIN evaluation
         WHERE c.id=$1 AND c.workspace_id=$2 FOR SHARE OF c`,
        [request.connectionId, workspaceId],
      )
    ).rows[0];
    if (!connection) throw new ApiError(409, "flow_unavailable");
    if (!globalSendEnabled || !connection.sendable) throw new ApiError(409, "sending_disabled");
    const contact = await client.query("SELECT 1 FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3 LIMIT 1", [workspaceId, request.connectionId, request.senderId]);
    if (!contact.rowCount) throw new ApiError(404, "contact_not_found");
    const recipients = (await client.query<{ recipient_id: string; stage: number }>(RECIPIENTS_SQL, [workspaceId, request.connectionId, request.senderId])).rows;
    if (!recipients.length) throw new ApiError(409, "no_dm_identity");
    const chosen = recipients.find((row) => row.stage === 7);
    if (!chosen) throw new ApiError(409, STAGE_CODES[recipients[0]!.stage]!);
    const recipient = chosen.recipient_id;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('dm-start-sender:' || $1::text || ':' || $2::text, 0))", [connection.account_id, recipient]);
    const state = (
      await client.query<{ paused: boolean; busy: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM instagram_contact_automation a WHERE a.workspace_id=$1 AND a.connection_id=$2
             AND a.sender_id=$3 AND (a.paused OR a.handoff_paused))
           OR EXISTS(SELECT 1 FROM instagram_dm_automation p WHERE p.workspace_id=$1 AND p.connection_id=$2
             AND p.recipient_id=$4 AND p.paused) AS paused,
           ${messagingSenderBusySql("$2::uuid", "$4::text", "$1::uuid")}
           OR EXISTS(SELECT 1 FROM flow_dm_deliveries d WHERE d.connection_id=$2 AND d.recipient_id=$4
             AND d.status IN ('pending','sending')) AS busy`,
        [workspaceId, request.connectionId, request.senderId, recipient],
      )
    ).rows[0]!;
    if (state.paused) throw new ApiError(409, "contact_paused");
    if (state.busy) throw new ApiError(409, "contact_busy");
    if (await activeContactLimitBlocks(client, workspaceId, request.connectionId, { kind: "dm_recipient", id: recipient })) throw new ApiError(409, ACTIVE_CONTACT_LIMIT);
    // The start limits count the committed starts and this transaction's own: the advisory lock above serializes the
    // starts of one recipient for the cooldown, and the connection-wide hourly limit takes no lock, as for DM starts.
    const limited = (await client.query<{ code: string | null }>(`SELECT ${dmStartSkipCodeSql("$1::uuid", "$2::text", "decision.decided_at")} AS code FROM (SELECT clock_timestamp() AS decided_at) decision`, [request.connectionId, recipient])).rows[0]!;
    if (limited.code !== null) throw new ApiError(429, "rate_limited");
    const start = (
      await client.query<{ id: string }>(
        `INSERT INTO flow_api_starts(workspace_id,connection_id,sender_id,recipient_id,flow_id,flow_version_id,api_key_id,request_key,request_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text`,
        [workspaceId, request.connectionId, request.senderId, recipient, request.flowId, flow.version_id, apiKey.id, request.requestKey, request.hash],
      )
    ).rows[0]!;
    const run = (
      await client.query<{ id: string }>(
        `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,api_start_id,status,failure_code)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
        [workspaceId, request.connectionId, request.flowId, flow.version_id, start.id, "delivering", null],
      )
    ).rows[0]!;
    await client.query(
      `INSERT INTO flow_dm_deliveries(workspace_id,connection_id,flow_run_id,recipient_id,message_text)
         VALUES($1,$2,$3,$4,$5)`,
      [workspaceId, request.connectionId, run.id, recipient, plan.text],
    );
    await client.query(
      `INSERT INTO flow_step_runs(run_id,workspace_id,connection_id,seq,node_id,node_type,outcome)
       SELECT $1,$2,$3,step.seq-1,step.node_id,step.node_type,step.outcome
       FROM unnest($4::text[],$5::text[],$6::text[]) WITH ORDINALITY AS step(node_id,node_type,outcome,seq)`,
      [run.id, workspaceId, request.connectionId, plan.steps.map((step) => step.node_id), plan.steps.map((step) => step.node_type), plan.steps.map((step) => step.outcome)],
    );
    return { start_id: start.id, run_id: run.id, status: "queued", connection_id: request.connectionId, created: true };
  });
}
