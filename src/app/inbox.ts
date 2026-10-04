import { inboxIdentityCandidatesSql } from "./inbox-identity.ts";
import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";
import { INBOX_STATE_JOINS, STATE_COLUMNS, conversationState, readConversationState } from "./inbox-conversations.ts";
import { labelsJson, readConversationLabels } from "./inbox-labels.ts";
import { dueLocalSql, readCallerReminder } from "./inbox-reminders.ts";

export async function setInbox(pool: Pool, user: User, id: string, input: unknown) {
  if (!isUuid(id) || !isRecord(input) || Object.keys(input).length !== 1 || typeof input.enabled !== "boolean")
    throw new ApiError(400, "invalid_inbox_setting");
  const workspace = await workspaceFor(pool, user, "admin");
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
const INBOX_QUERY_KEYS = ["connection_id", "after", "status", "assignee", "unread", "q", "label", "reminder"];

// Conversations newest first (#23). The keyset is (last message time DESC, connection, recipient); the time
// travels in the cursor as integer microseconds, the precision PostgreSQL stores, so rows that tie on the
// millisecond a JavaScript Date keeps are neither skipped nor repeated at a page boundary.
export async function listInbox(pool: Pool, user: User, query: URLSearchParams) {
  const workspace = await workspaceFor(pool, user, "agent");
  if ([...query.keys()].some((key) => !INBOX_QUERY_KEYS.includes(key) || query.getAll(key).length !== 1))
    throw new ApiError(400, "invalid_inbox_query");
  const connection = query.get("connection_id"),
    status = query.get("status"),
    assignee = query.get("assignee"),
    unread = query.get("unread"),
    search = query.get("q"),
    label = query.get("label"),
    reminder = query.get("reminder");
  // status=open|closed and assignee=me|none|<member> filter on the conversation state, where no row means open
  // and unassigned. q is matched literally against stored DM text, so % _ and \ have no special meaning; internal
  // notes are never searched. label=<label ID> lists the conversations whose label set has that label.
  // reminder=due lists the conversations where the caller's own pending reminder is due.
  if (
    (connection !== null && !isUuid(connection)) ||
    (status !== null && !["open", "closed"].includes(status)) ||
    (assignee !== null && !["me", "none"].includes(assignee) && !isUuid(assignee)) ||
    (unread !== null && unread !== "true") ||
    (label !== null && !isUuid(label)) ||
    (reminder !== null && reminder !== "due") ||
    (search !== null && ([...search].length < 1 || [...search].length > 100 || search.includes("\u0000")))
  )
    throw new ApiError(400, "invalid_inbox_query");
  let after: { at: string; connection_id: string; recipient_id: string } | null = null;
  if (query.has("after")) {
    try {
      const value: unknown = JSON.parse(Buffer.from(query.get("after")!, "base64url").toString());
      if (
        !isRecord(value) ||
        typeof value.at !== "string" ||
        !/^-?\d{1,18}$/.test(value.at) ||
        !isUuid(value.connection_id) ||
        typeof value.recipient_id !== "string" ||
        !/^\d{1,40}$/.test(value.recipient_id)
      )
        throw new Error();
      after = { at: value.at, connection_id: value.connection_id, recipient_id: value.recipient_id };
    } catch {
      throw new ApiError(400, "invalid_inbox_query");
    }
  }
  // The counts, the last message time and the order cover every message of a conversation; q and unread only
  // decide which conversations are listed. Every request scans the workspace's stored DMs (no search index).
  // last_read_message_id is the caller's read position the unread count was taken against, so a client can tell
  // whether this snapshot came before or after a read mark it applied.
  const result = await pool.query(
    `WITH conversations AS (
       SELECT m.workspace_id,m.connection_id,m.recipient_id,count(*)::integer AS message_count,
         max(m.message_at) AS last_message_at,
         (extract(epoch FROM max(m.message_at))*1000000)::bigint AS last_message_us,
         count(*) FILTER (WHERE m.id>coalesce(reads.last_read_message_id,0))::integer AS unread_count,
         max(reads.last_read_message_id) AS last_read_message_id,
         $9::text IS NOT NULL AND bool_or(strpos(lower(m.text),lower($9::text))>0) AS matched
       FROM instagram_inbox_messages m
       LEFT JOIN instagram_inbox_read_state reads ON reads.workspace_id=m.workspace_id
         AND reads.connection_id=m.connection_id AND reads.recipient_id=m.recipient_id AND reads.user_id=$7::uuid
       WHERE m.workspace_id=$1 AND ($2::uuid IS NULL OR m.connection_id=$2)
       GROUP BY m.workspace_id,m.connection_id,m.recipient_id
     )
     SELECT m.connection_id,m.recipient_id,c.username,m.message_count,m.last_message_at,m.unread_count,
       m.last_read_message_id::text AS last_read_message_id,m.last_message_us::text AS last_message_us,${STATE_COLUMNS},
       jsonb_build_object('version',coalesce(sets.version,0),
         'labels',${labelsJson("m.workspace_id", "coalesce(sets.label_ids,'{}')")}) AS label_set,
       rem.id AS reminder_id,rem.due_at AS reminder_due_at,rem.version AS reminder_version,rem.note AS reminder_note,
       ${dueLocalSql("rem.due_at", "w.time_zone")} AS reminder_due_local,
       rem.due_at<=now() AS reminder_due
     FROM conversations m JOIN instagram_connections c ON c.id=m.connection_id AND c.workspace_id=m.workspace_id
     JOIN workspaces w ON w.id=m.workspace_id
     ${INBOX_STATE_JOINS}
     LEFT JOIN instagram_inbox_conversation_labels sets ON sets.workspace_id=m.workspace_id
       AND sets.connection_id=m.connection_id AND sets.recipient_id=m.recipient_id
     -- The partial unique index on pending reminders keeps this join at one row per conversation.
     LEFT JOIN instagram_inbox_reminders rem ON rem.workspace_id=m.workspace_id AND rem.connection_id=m.connection_id
       AND rem.recipient_id=m.recipient_id AND rem.creator_id=$7::uuid AND rem.status='pending'
     WHERE ($3::bigint IS NULL OR m.last_message_us<$3::bigint
         OR (m.last_message_us=$3::bigint AND (m.connection_id,m.recipient_id)>($4::uuid,$5::text)))
       AND ($6::text IS NULL OR coalesce(state.status,'open')=$6)
       AND ($8::uuid IS NULL OR state.assignee_user_id=$8::uuid)
       AND (NOT $11::boolean OR state.assignee_user_id IS NULL)
       AND ($9::text IS NULL OR m.matched)
       AND (NOT $10::boolean OR m.unread_count>0)
       AND ($12::uuid IS NULL OR $12::uuid=ANY(sets.label_ids))
       AND (NOT $13::boolean OR rem.due_at<=now())
     ORDER BY m.last_message_us DESC,m.connection_id,m.recipient_id LIMIT 51`,
    [
      workspace,
      connection,
      after?.at ?? null,
      after?.connection_id ?? null,
      after?.recipient_id ?? null,
      status,
      user.id,
      assignee === "me" ? user.id : assignee === "none" ? null : assignee,
      search,
      unread === "true",
      assignee === "none",
      label,
      reminder === "due",
    ],
  );
  // The badge: every due pending reminder of the caller in the workspace, whatever the filters, and the server time
  // the screen measures due_at against until the next list load.
  const reminders = await pool.query<{ due_reminder_count: number; checked_at: Date }>(
    `SELECT count(*)::integer AS due_reminder_count,now() AS checked_at FROM instagram_inbox_reminders
     WHERE workspace_id=$1 AND creator_id=$2 AND status='pending' AND due_at<=now()`,
    [workspace, user.id],
  );
  const conversations = result.rows.slice(0, 50).map((row) => {
      const {
        status: _status,
        assignee_user_id: _assignee,
        assignee_email: _email,
        version: _version,
        updated_by: _by,
        updated_by_email: _byEmail,
        updated_at: _at,
        last_message_us: _us,
        reminder_id,
        reminder_due_at,
        reminder_version,
        reminder_note,
        reminder_due_local,
        reminder_due,
        ...conversation
      } = row;
      return {
        ...conversation,
        state: conversationState(row),
        reminder: reminder_id
          ? {
              id: reminder_id,
              due_at: reminder_due_at,
              due_local: reminder_due_local,
              due: reminder_due,
              version: reminder_version,
              note: reminder_note,
            }
          : null,
      };
    }),
    last = result.rows[49];
  return {
    conversations,
    due_reminder_count: reminders.rows[0]!.due_reminder_count,
    checked_at: reminders.rows[0]!.checked_at,
    after:
      result.rows.length > 50
        ? Buffer.from(
            JSON.stringify({
              at: last.last_message_us,
              connection_id: last.connection_id,
              recipient_id: last.recipient_id,
            }),
          ).toString("base64url")
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
  const workspace = await workspaceFor(pool, user, "agent");
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
  return {
    messages,
    before: result.rows.length > 50 ? messages.at(-1)!.id : null,
    state: await readConversationState(pool, workspace, connection, recipient),
    label_set: await readConversationLabels(pool, workspace, connection, recipient),
    reminder: await readCallerReminder(pool, workspace, user.id, connection, recipient),
  };
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
  const workspace = await workspaceFor(pool, user, "agent");
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
       ${inboxIdentityCandidatesSql} AND reply.recipient_id=$3
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
