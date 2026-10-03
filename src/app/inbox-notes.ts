import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { membershipFor, workspaceFor } from "./settings.ts";

// Internal notes on an inbox conversation (#23-B): text members write for each other. A note is append-only (a
// correction is a new note) and is never sent, never read by a flow, a webhook or the DM search, and never listed
// as a message. Only the deletion functions remove notes.
export const NOTE_BODY_MAX = 2000;

const NOTE_COLUMNS = `note.id::text,note.body,note.created_at,note.author_id,author.email AS author_email`;
// The author's email comes from the same workspace's membership row, including a removed one.
const NOTE_JOINS = `LEFT JOIN workspace_members author ON author.user_id=note.author_id AND author.workspace_id=note.workspace_id`;

type NoteRow = { id: string; body: string; created_at: Date; author_id: string; author_email: string | null };

function noteResult({ author_id, author_email, ...note }: NoteRow) {
  return { ...note, author: { user_id: author_id, email: author_email } };
}

function conversationPath(connection: string, recipient: string): void {
  if (!isUuid(connection) || !/^\d{1,40}$/.test(recipient)) throw new ApiError(400, "invalid_note_request");
}

export async function addInboxNote(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
  input: unknown,
) {
  conversationPath(connection, recipient);
  if (query.size || !isRecord(input) || Object.keys(input).length !== 1 || typeof input.body !== "string")
    throw new ApiError(400, "invalid_note_request");
  const body = input.body.trim();
  if (!body || [...body].length > NOTE_BODY_MAX || body.includes("\u0000")) throw new ApiError(400, "invalid_note");
  const { workspace_id: workspace } = await membershipFor(pool, user, "agent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The lock order of the other conversation writes: the workspace row, the caller's membership row, then the
    // connection, so a note queues behind the deletion functions instead of outliving the conversation.
    await client.query("SELECT 1 FROM workspaces WHERE id=$1 FOR SHARE", [workspace]);
    const member = await client.query(
      "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND removed_at IS NULL FOR SHARE",
      [workspace, user.id],
    );
    if (!member.rowCount) throw new ApiError(403, "workspace_required");
    const owned = await client.query("SELECT 1 FROM instagram_connections WHERE id=$1 AND workspace_id=$2 FOR SHARE", [
      connection,
      workspace,
    ]);
    if (!owned.rowCount) throw new ApiError(404, "connection_not_found");
    const exists = await client.query(
      "SELECT 1 FROM instagram_inbox_messages WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 LIMIT 1",
      [workspace, connection, recipient],
    );
    if (!exists.rowCount) throw new ApiError(404, "conversation_not_found");
    const result = await client.query<NoteRow>(
      `WITH note AS (
         INSERT INTO instagram_inbox_notes(workspace_id,connection_id,recipient_id,author_id,body)
         VALUES($1,$2,$3,$4,$5) RETURNING *
       )
       SELECT ${NOTE_COLUMNS} FROM note ${NOTE_JOINS}`,
      [workspace, connection, recipient, user.id, body],
    );
    await client.query("COMMIT");
    return noteResult(result.rows[0]!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Newest first, 50 per page; `before` is the oldest note ID of the previous page.
export async function listInboxNotes(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
) {
  conversationPath(connection, recipient);
  if (
    [...query.keys()].some((key) => key !== "before" || query.getAll(key).length !== 1) ||
    (query.has("before") && !/^[1-9]\d{0,18}$/.test(query.get("before")!))
  )
    throw new ApiError(400, "invalid_note_request");
  const workspace = await workspaceFor(pool, user, "agent");
  const owned = await pool.query("SELECT 1 FROM instagram_connections WHERE id=$1 AND workspace_id=$2", [
    connection,
    workspace,
  ]);
  if (!owned.rowCount) throw new ApiError(404, "connection_not_found");
  const result = await pool.query<NoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM instagram_inbox_notes note ${NOTE_JOINS}
     WHERE note.workspace_id=$1 AND note.connection_id=$2 AND note.recipient_id=$3
       AND ($4::numeric IS NULL OR note.id<$4::numeric)
     ORDER BY note.id DESC LIMIT 51`,
    [workspace, connection, recipient, query.get("before")],
  );
  const notes = result.rows.slice(0, 50).map(noteResult);
  return { notes, before: result.rows.length > 50 ? notes.at(-1)!.id : null };
}
