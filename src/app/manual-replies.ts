import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";
import { manualReplyEligibility, manualReplyStatus } from "../instagram/manual-reply-worker.ts";

function validate(connection: string, recipient: string, query: URLSearchParams) {
  if (!isUuid(connection) || !/^\d{1,40}$/.test(recipient) || query.size)
    throw new ApiError(400, "invalid_manual_reply_request");
}
export async function readManualReplyStatus(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
  enabled: boolean,
) {
  validate(connection, recipient, query);
  const workspace = await workspaceFor(pool, user, "agent");
  const owned = await pool.query(
    "SELECT 1 FROM instagram_connections c WHERE c.id=$1 AND c.workspace_id=$2 AND EXISTS(SELECT 1 FROM instagram_inbox_messages m WHERE m.workspace_id=c.workspace_id AND m.connection_id=c.id AND m.recipient_id=$3)",
    [connection, workspace, recipient],
  );
  if (!owned.rowCount) throw new ApiError(404, "conversation_not_found");
  const status = await manualReplyStatus(pool, {
    workspace_id: workspace,
    connection_id: connection,
    recipient_id: recipient,
  });
  const failure_code = status.failure_code ?? (enabled ? null : "global_send_disabled");
  return { ...status, failure_code, allowed: failure_code === null };
}
function requestKey(input: unknown, fields: string[]) {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== fields.length ||
    !fields.every((key) => key in input) ||
    !isUuid(input.request_key)
  )
    throw new ApiError(400, "invalid_manual_reply_request");
  return input;
}
function version(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2147483647)
    throw new ApiError(400, "invalid_manual_reply_request");
  return Number(value);
}
function reason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500)
    throw new ApiError(400, "invalid_manual_reply_request");
  return value.trim();
}
const columns =
  "id,text,status,failure_code,safe_to_retry,handoff_version,retry_of,created_at,sent_at,provider_message_id,resolved_at";
async function lockConnection(client: PoolClient, workspace: string, connection: string) {
  if (
    !(
      await client.query("SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE", [
        connection,
        workspace,
      ])
    ).rowCount
  )
    throw new ApiError(404, "connection_not_found");
}
export async function queueManualReply(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
  input: unknown,
  enabled: boolean,
  retryOf?: string,
) {
  validate(connection, recipient, query);
  if (retryOf && !isUuid(retryOf)) throw new ApiError(400, "invalid_manual_reply_request");
  const body = requestKey(
    input,
    retryOf
      ? ["request_key", "expected_handoff_version", "reason"]
      : ["request_key", "expected_handoff_version", "text"],
  );
  const handoffVersion = version(body.expected_handoff_version);
  if (!retryOf && (typeof body.text !== "string" || !body.text.trim() || body.text.length > 1000))
    throw new ApiError(400, "invalid_manual_reply_request");
  const retryReason = retryOf ? reason(body.reason) : null;
  const workspace = await workspaceFor(pool, user, "agent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockConnection(client, workspace, connection);
    const old = (
      await client.query(
        `SELECT ${columns},created_by,retry_reason FROM instagram_manual_replies WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND request_key=$4`,
        [workspace, connection, recipient, body.request_key],
      )
    ).rows[0];
    if (old) {
      if (
        old.created_by !== user.id ||
        old.handoff_version !== handoffVersion ||
        old.retry_of !== (retryOf ?? null) ||
        old.retry_reason !== retryReason ||
        (!retryOf && old.text !== body.text)
      )
        throw new ApiError(409, "idempotency_conflict");
      await client.query("COMMIT");
      const { created_by: _actor, retry_reason: _reason, ...result } = old;
      return result;
    }
    let text = body.text;
    if (retryOf) {
      const original = (
        await client.query(
          "SELECT status,safe_to_retry,text FROM instagram_manual_replies WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND id=$4 FOR UPDATE",
          [workspace, connection, recipient, retryOf],
        )
      ).rows[0];
      if (!original) throw new ApiError(404, "reply_not_found");
      if (
        original.status !== "failed" ||
        !original.safe_to_retry ||
        (await client.query("SELECT 1 FROM instagram_manual_replies WHERE retry_of=$1", [retryOf])).rowCount
      )
        throw new ApiError(409, "reply_not_retryable");
      text = original.text;
    }
    const failure = await manualReplyEligibility(client, {
      workspace_id: workspace,
      connection_id: connection,
      recipient_id: recipient,
      handoff_version: handoffVersion,
    });
    if (failure) throw new ApiError(409, failure);
    if (!enabled) throw new ApiError(409, "global_send_disabled");
    const result = await client.query(
      `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,retry_of,retry_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${columns}`,
      [workspace, connection, recipient, body.request_key, user.id, text, handoffVersion, retryOf ?? null, retryReason],
    );
    const reply = result.rows[0];
    await client.query(
      "INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [workspace, connection, recipient, reply.id, retryOf ? "retry_requested" : "queued", user.id, retryReason],
    );
    await client.query("COMMIT");
    return reply;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function resolveManualReply(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  reply: string,
  query: URLSearchParams,
  input: unknown,
) {
  validate(connection, recipient, query);
  if (!isUuid(reply)) throw new ApiError(400, "invalid_manual_reply_request");
  const body = requestKey(input, ["request_key", "decision", "reason"]);
  if (body.decision !== "no_retry") throw new ApiError(400, "invalid_manual_reply_request");
  const note = reason(body.reason),
    workspace = await workspaceFor(pool, user, "agent"),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockConnection(client, workspace, connection);
    const existing = (
      await client.query(
        "SELECT reply_id,reason,actor_id FROM instagram_manual_reply_events WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND request_key=$4",
        [workspace, connection, recipient, body.request_key],
      )
    ).rows[0];
    if (existing) {
      if (existing.reply_id !== reply || existing.reason !== note || existing.actor_id !== user.id)
        throw new ApiError(409, "idempotency_conflict");
    } else {
      const found = (
        await client.query(
          "SELECT status,resolved_at FROM instagram_manual_replies WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND id=$4 FOR UPDATE",
          [workspace, connection, recipient, reply],
        )
      ).rows[0];
      if (!found) throw new ApiError(404, "reply_not_found");
      if (found.status !== "unknown" || found.resolved_at) throw new ApiError(409, "reply_not_unresolved");
      await client.query("UPDATE instagram_manual_replies SET resolved_at=clock_timestamp() WHERE id=$1", [reply]);
      await client.query(
        "INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,actor_id,request_key,reason) VALUES($1,$2,$3,$4,'no_retry',$5,$6,$7)",
        [workspace, connection, recipient, reply, user.id, body.request_key, note],
      );
    }
    await client.query("COMMIT");
    return { id: reply, status: "unknown", decision: "no_retry" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function listManualReplies(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
) {
  if ([...query.keys()].some((key) => key !== "before" || query.getAll(key).length !== 1))
    throw new ApiError(400, "invalid_manual_reply_query");
  validate(connection, recipient, new URLSearchParams());
  let cursor: { created_at: string; id: string } | null = null;
  if (query.has("before")) {
    try {
      const value: unknown = JSON.parse(Buffer.from(query.get("before")!, "base64url").toString());
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 2 ||
        !isUuid(value.id) ||
        typeof value.created_at !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.created_at) ||
        !Number.isFinite(Date.parse(value.created_at))
      )
        throw new Error("cursor");
      cursor = { id: value.id, created_at: value.created_at };
    } catch {
      throw new ApiError(400, "invalid_manual_reply_query");
    }
  }
  const workspace = await workspaceFor(pool, user, "agent");
  if (
    !(await pool.query("SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2", [connection, workspace]))
      .rowCount
  )
    throw new ApiError(404, "connection_not_found");
  const result = await pool.query(
    `SELECT ${columns},to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM instagram_manual_replies WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,
    [workspace, connection, recipient, cursor?.created_at ?? null, cursor?.id ?? null],
  );
  const rows = result.rows.slice(0, 50);
  const events = rows.length
    ? (
        await pool.query(
          "SELECT event.reply_id,event.kind,event.attempt_id,event.actor_id,event.reason,event.failure_code,event.created_at FROM unnest($4::uuid[]) selected(reply_id) CROSS JOIN LATERAL (SELECT reply_id,kind,attempt_id,actor_id,reason,failure_code,created_at,id FROM instagram_manual_reply_events WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND reply_id=selected.reply_id ORDER BY created_at DESC,id DESC LIMIT 50) event ORDER BY event.created_at,event.id",
          [workspace, connection, recipient, rows.map((row) => row.id)],
        )
      ).rows
    : [];
  const last = rows.at(-1);
  return {
    replies: rows.map(({ cursor_time: _time, ...row }) => ({
      ...row,
      events: events.filter((event) => event.reply_id === row.id),
    })),
    before:
      result.rows.length > 50
        ? Buffer.from(JSON.stringify({ created_at: last.cursor_time, id: last.id })).toString("base64url")
        : null,
  };
}
