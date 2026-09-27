import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";

export async function setInbox(pool: Pool, user: User, id: string, input: unknown) {
  if (!isUuid(id) || !isRecord(input) || Object.keys(input).length !== 1 || typeof input.enabled !== "boolean")
    throw new ApiError(400, "invalid_inbox_setting");
  const workspace = await workspaceFor(pool, user);
  const found = await pool.query("SELECT active FROM instagram_connections WHERE id=$1 AND workspace_id=$2", [
    id,
    workspace,
  ]);
  if (!found.rows[0]) throw new ApiError(404, "connection_not_found");
  const result = await pool.query(
    `UPDATE instagram_connections SET inbox_enabled=$3,
    inbox_enabled_at=CASE WHEN $3 AND NOT inbox_enabled THEN clock_timestamp() ELSE inbox_enabled_at END
    WHERE id=$1 AND workspace_id=$2 AND (NOT $3 OR active) RETURNING inbox_enabled`,
    [id, workspace, input.enabled],
  );
  if (!result.rows[0]) throw new ApiError(409, "connection_unavailable");
  return { enabled: result.rows[0].inbox_enabled };
}
export async function listInbox(pool: Pool, user: User, query: URLSearchParams) {
  const workspace = await workspaceFor(pool, user);
  let after: { connection_id: string; recipient_id: string } | null = null;
  const connection = query.get("connection_id");
  if (connection && !isUuid(connection)) throw new ApiError(400, "invalid_inbox_query");
  if ([...query.keys()].some((key) => !["connection_id", "after"].includes(key) || query.getAll(key).length !== 1))
    throw new ApiError(400, "invalid_inbox_query");
  if (query.has("after")) {
    try {
      const value: unknown = JSON.parse(Buffer.from(query.get("after")!, "base64url").toString());
      if (
        !isRecord(value) ||
        !isUuid(value.connection_id) ||
        typeof value.recipient_id !== "string" ||
        !/^\d+$/.test(value.recipient_id)
      )
        throw new Error();
      after = { connection_id: value.connection_id, recipient_id: value.recipient_id };
    } catch {
      throw new ApiError(400, "invalid_inbox_query");
    }
  }
  const result = await pool.query(
    `SELECT m.connection_id,m.recipient_id,c.username,count(*)::integer AS message_count,max(m.message_at) AS last_message_at
    FROM instagram_inbox_messages m JOIN instagram_connections c ON c.id=m.connection_id AND c.workspace_id=m.workspace_id
    WHERE m.workspace_id=$1 AND ($2::uuid IS NULL OR m.connection_id=$2)
      AND ($3::uuid IS NULL OR (m.connection_id,m.recipient_id)>($3::uuid,$4::text))
    GROUP BY m.connection_id,m.recipient_id,c.username ORDER BY m.connection_id,m.recipient_id LIMIT 51`,
    [workspace, connection || null, after?.connection_id ?? null, after?.recipient_id ?? null],
  );
  const conversations = result.rows.slice(0, 50),
    last = conversations.at(-1);
  return {
    conversations,
    after:
      result.rows.length > 50
        ? Buffer.from(JSON.stringify({ connection_id: last.connection_id, recipient_id: last.recipient_id })).toString(
            "base64url",
          )
        : null,
  };
}
export async function inboxMessages(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
) {
  if (
    !isUuid(connection) ||
    !/^\d{1,40}$/.test(recipient) ||
    [...query.keys()].some((key) => key !== "before" || query.getAll(key).length !== 1) ||
    (query.has("before") && !/^[1-9]\d{0,18}$/.test(query.get("before")!))
  )
    throw new ApiError(400, "invalid_inbox_query");
  const workspace = await workspaceFor(pool, user);
  const owned = await pool.query("SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2", [
    connection,
    workspace,
  ]);
  if (!owned.rowCount) throw new ApiError(404, "connection_not_found");
  const result = await pool.query(
    `SELECT id::text,message_id,text,kind,message_at,received_at FROM instagram_inbox_messages
    WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND ($4::numeric IS NULL OR id<$4::numeric)
    ORDER BY instagram_inbox_messages.id DESC LIMIT 51`,
    [workspace, connection, recipient, query.get("before")],
  );
  const messages = result.rows.slice(0, 50);
  return { messages, before: result.rows.length > 50 ? messages.at(-1)!.id : null };
}

export async function inboxContext(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
) {
  if (!isUuid(connection) || !/^\d{1,40}$/.test(recipient) || query.size)
    throw new ApiError(400, "invalid_inbox_query");
  const workspace = await workspaceFor(pool, user);
  return readInboxContext(pool, workspace, connection, recipient);
}

export async function readInboxContext(
  pool: Pick<Pool, "query">,
  workspace: string,
  connection: string,
  recipient: string,
) {
  const result = await pool.query(
    `WITH owned AS (
       SELECT id,workspace_id,inbox_enabled_at FROM instagram_connections WHERE id=$1 AND workspace_id=$2
     ), conversation AS (
       SELECT max(message_at) AS last_message_at FROM instagram_inbox_messages
       WHERE connection_id=$1 AND workspace_id=$2 AND recipient_id=$3
     ), candidates AS (
       SELECT reply.id,reply.sender_id,reply.sent_at,reply.sent_at>=owned.inbox_enabled_at AS fresh
       FROM private_reply_outbox reply JOIN owned ON reply.connection_id=owned.id AND reply.workspace_id=owned.workspace_id
       JOIN instagram_comment_events event ON event.id=reply.event_id AND event.connection_id=reply.connection_id
         AND event.workspace_id=reply.workspace_id AND event.sender_id=reply.sender_id
       WHERE reply.recipient_id=$3 AND reply.status='sent' AND length(btrim(reply.provider_message_id))>0
         AND reply.sent_at<=now()
     ), identity AS (
       SELECT count(DISTINCT sender_id)::integer AS sender_count,min(sender_id) AS sender_id,bool_or(fresh) AS fresh
       FROM candidates
     )
     SELECT conversation.last_message_at,identity.sender_count,identity.sender_id,identity.fresh,
       (SELECT id::text FROM candidates WHERE fresh ORDER BY sent_at DESC,id DESC LIMIT 1) AS evidence_reply_id,
       coalesce((automation.paused OR automation.handoff_paused),false) AS automation_paused
     FROM owned CROSS JOIN conversation CROSS JOIN identity
     LEFT JOIN instagram_contact_automation automation ON automation.workspace_id=owned.workspace_id
       AND automation.connection_id=owned.id AND automation.sender_id=identity.sender_id`,
    [connection, workspace, recipient],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "connection_not_found");
  if (!row.last_message_at) throw new ApiError(404, "conversation_not_found");
  const status =
    row.sender_count === 0 ? "unmapped" : row.sender_count > 1 ? "ambiguous" : row.fresh ? "verified" : "stale";
  return {
    mapping_status: status,
    comment_sender_id: status === "verified" ? row.sender_id : null,
    evidence_reply_id: status === "verified" ? row.evidence_reply_id : null,
    automation_paused: status === "verified" ? row.automation_paused : null,
    last_message_at: row.last_message_at,
  };
}
