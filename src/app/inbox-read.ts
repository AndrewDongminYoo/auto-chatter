import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { membershipFor } from "./settings.ts";

// Per-member read position of an inbox conversation (#23). It is the highest inbox message ID the member
// marked read and never moves backward; unread counts are the conversation's messages above it.
export type ReadPosition = { last_read_message_id: string | null; read_at: Date | null; unread_count: number };

const MAX_BIGINT = 9223372036854775807n;

function parse(connection: string, recipient: string, query: URLSearchParams, input: unknown): string {
  if (
    !isUuid(connection) ||
    !/^\d{1,40}$/.test(recipient) ||
    query.size ||
    !isRecord(input) ||
    Object.keys(input).length !== 1 ||
    typeof input.message_id !== "string" ||
    !/^[1-9]\d{0,18}$/.test(input.message_id) ||
    BigInt(input.message_id) > MAX_BIGINT
  )
    throw new ApiError(400, "invalid_read_request");
  return input.message_id;
}

export async function markInboxRead(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
  input: unknown,
): Promise<ReadPosition> {
  const messageId = parse(connection, recipient, query, input);
  const { workspace_id: workspace } = await membershipFor(pool, user, "agent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await apply(client, user, workspace, connection, recipient, messageId);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function apply(
  client: PoolClient,
  user: User,
  workspace: string,
  connection: string,
  recipient: string,
  messageId: string,
): Promise<ReadPosition> {
  // The lock order of the conversation state change (saveConversationState): the workspace row, the caller's
  // membership row, then the connection. delete_workspace_data takes the workspace row FOR UPDATE first and
  // removeMember takes it FOR SHARE before the member row, so the three queue instead of deadlocking; a removal
  // that commits first is seen here under the member lock and refuses the write. The connection FOR SHARE
  // serializes with the connection and person deletion functions, so no read row is written after they
  // removed the conversation's messages.
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
  const message = await client.query(
    `SELECT 1 FROM instagram_inbox_messages
     WHERE id=$4::bigint AND workspace_id=$1 AND connection_id=$2 AND recipient_id=$3`,
    [workspace, connection, recipient, messageId],
  );
  if (!message.rowCount) throw new ApiError(404, "message_not_found");
  // A lower or equal ID changes nothing, so the position never moves backward and read_at keeps the time it
  // last advanced.
  await client.query(
    `INSERT INTO instagram_inbox_read_state AS reads(workspace_id,connection_id,recipient_id,user_id,last_read_message_id)
     VALUES($1,$2,$3,$4,$5::bigint)
     ON CONFLICT(workspace_id,connection_id,recipient_id,user_id) DO UPDATE
       SET last_read_message_id=EXCLUDED.last_read_message_id,read_at=clock_timestamp()
       WHERE reads.last_read_message_id<EXCLUDED.last_read_message_id`,
    [workspace, connection, recipient, user.id, messageId],
  );
  return readPosition(client, workspace, connection, recipient, user.id);
}

async function readPosition(
  db: Pick<Pool, "query">,
  workspace: string,
  connection: string,
  recipient: string,
  userId: string,
): Promise<ReadPosition> {
  const result = await db.query<{ last_read_message_id: string | null; read_at: Date | null; unread_count: number }>(
    `SELECT reads.last_read_message_id::text,reads.read_at,
       (SELECT count(*)::integer FROM instagram_inbox_messages m
        WHERE m.workspace_id=$1 AND m.connection_id=$2 AND m.recipient_id=$3
          AND m.id>coalesce(reads.last_read_message_id,0)) AS unread_count
     FROM (SELECT 1) target
     LEFT JOIN instagram_inbox_read_state reads ON reads.workspace_id=$1 AND reads.connection_id=$2
       AND reads.recipient_id=$3 AND reads.user_id=$4`,
    [workspace, connection, recipient, userId],
  );
  return result.rows[0]!;
}
