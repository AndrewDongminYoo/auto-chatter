import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { membershipFor, roleAllows, workspaceFor, type WorkspaceRole } from "./settings.ts";

// Conversation status and assignment (#22). A conversation without a state row is open and unassigned at
// version 0. Neither value changes the handoff or the automation pause; the two are independent.
export type ConversationState = {
  status: "open" | "closed";
  assignee: { user_id: string; email: string | null } | null;
  version: number;
  updated_by: { user_id: string; email: string | null } | null;
  updated_at: Date | null;
};

type StateRow = {
  status: "open" | "closed" | null;
  assignee_user_id: string | null;
  assignee_email: string | null;
  version: number | null;
  updated_by: string | null;
  updated_by_email: string | null;
  updated_at: Date | null;
};

// The joins read emails from the same workspace's membership rows, including removed ones, so an audit
// actor who left is still named.
export const STATE_COLUMNS = `state.status,state.assignee_user_id,assignee.email AS assignee_email,state.version,
  state.updated_by,updater.email AS updated_by_email,state.updated_at`;
const STATE_JOINS = `LEFT JOIN workspace_members assignee ON assignee.user_id=state.assignee_user_id
    AND assignee.workspace_id=state.workspace_id
  LEFT JOIN workspace_members updater ON updater.user_id=state.updated_by AND updater.workspace_id=state.workspace_id`;

export function conversationState(row: StateRow): ConversationState {
  const version = row.version ?? 0;
  return {
    status: row.status ?? "open",
    assignee: row.assignee_user_id ? { user_id: row.assignee_user_id, email: row.assignee_email } : null,
    version,
    updated_by: row.updated_by ? { user_id: row.updated_by, email: row.updated_by_email } : null,
    updated_at: version > 0 ? row.updated_at : null,
  };
}

export async function readConversationState(
  db: Pick<Pool, "query">,
  workspace: string,
  connection: string,
  recipient: string,
): Promise<ConversationState> {
  const result = await db.query<StateRow>(
    `SELECT ${STATE_COLUMNS} FROM (SELECT $1::uuid AS workspace_id,$2::uuid AS connection_id,$3::text AS recipient_id) target
     LEFT JOIN instagram_inbox_conversations state ON state.workspace_id=target.workspace_id
       AND state.connection_id=target.connection_id AND state.recipient_id=target.recipient_id
     ${STATE_JOINS}`,
    [workspace, connection, recipient],
  );
  return conversationState(result.rows[0]!);
}

// Joins and grouping listInbox adds to its query over instagram_inbox_messages m.
export const INBOX_STATE_JOINS = `LEFT JOIN instagram_inbox_conversations state ON state.workspace_id=m.workspace_id
    AND state.connection_id=m.connection_id AND state.recipient_id=m.recipient_id
  ${STATE_JOINS}`;
export const INBOX_STATE_GROUP = `state.status,state.assignee_user_id,assignee.email,state.version,state.updated_by,
  updater.email,state.updated_at`;

// Active members an admin can assign. Agents only claim or release, so they do not need the list.
export async function listAssignees(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user, "admin");
  return (
    await pool.query(
      `SELECT user_id,email,role FROM workspace_members WHERE workspace_id=$1 AND removed_at IS NULL
       ORDER BY email NULLS LAST,user_id`,
      [workspace],
    )
  ).rows;
}

function parse(connection: string, recipient: string, query: URLSearchParams, input: unknown) {
  if (!isUuid(connection) || !/^\d{1,40}$/.test(recipient) || query.size || !isRecord(input))
    throw new ApiError(400, "invalid_conversation_request");
  const keys = Object.keys(input);
  if (
    keys.some((key) => !["expected_version", "status", "assignee_user_id"].includes(key)) ||
    keys.length < 2 ||
    !Number.isInteger(input.expected_version) ||
    Number(input.expected_version) < 0 ||
    Number(input.expected_version) >= 2147483647 ||
    ("status" in input && input.status !== "open" && input.status !== "closed") ||
    ("assignee_user_id" in input && input.assignee_user_id !== null && !isUuid(input.assignee_user_id))
  )
    throw new ApiError(400, "invalid_conversation_request");
  return {
    expected: Number(input.expected_version),
    status: input.status as "open" | "closed" | undefined,
    assignee: "assignee_user_id" in input ? (input.assignee_user_id as string | null) : undefined,
  };
}

// An agent may claim an unassigned conversation or release their own; admins and the owner may assign any
// active member or unassign anyone.
function assignmentAllowed(role: WorkspaceRole, user: User, from: string | null, to: string | null): boolean {
  if (roleAllows(role, "admin")) return true;
  return (from === null && to === user.id) || (from === user.id && to === null);
}

export type SaveConversationResult = { conflict: boolean; state: ConversationState };

export async function saveConversationState(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
  input: unknown,
): Promise<SaveConversationResult> {
  const change = parse(connection, recipient, query, input);
  const { workspace_id: workspace } = await membershipFor(pool, user, "agent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await apply(client, user, workspace, connection, recipient, change);
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
  change: ReturnType<typeof parse>,
): Promise<SaveConversationResult> {
  // Lock order: the workspace row, membership rows, the connection, then the conversation row.
  // delete_workspace_data locks the workspace row first and deletes the members last, so taking the workspace
  // row first here makes the two queue instead of deadlocking. removeMember locks the removed member's row
  // before unassigning, so an assignment to that member either commits first (and is unassigned by the
  // removal) or sees removed_at here and is refused. The connection FOR SHARE serializes with the other
  // deletion functions (like contact writes), so no state row is written after a deletion removed the DMs.
  await client.query("SELECT 1 FROM workspaces WHERE id=$1 FOR SHARE", [workspace]);
  const ids = [...new Set([user.id, ...(change.assignee ? [change.assignee] : [])])];
  const members = (
    await client.query<{ user_id: string; role: WorkspaceRole }>(
      `SELECT user_id,role FROM workspace_members WHERE workspace_id=$1 AND user_id=ANY($2::uuid[]) AND removed_at IS NULL
       ORDER BY user_id FOR SHARE`,
      [workspace, ids],
    )
  ).rows;
  const caller = members.find((member) => member.user_id === user.id);
  if (!caller) throw new ApiError(403, "workspace_required");
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
  // A version 0 row means the same as no row; inserting it gives concurrent first changes a row to queue on.
  await client.query(
    `INSERT INTO instagram_inbox_conversations(workspace_id,connection_id,recipient_id) VALUES($1,$2,$3)
     ON CONFLICT(workspace_id,connection_id,recipient_id) DO NOTHING`,
    [workspace, connection, recipient],
  );
  const current = (
    await client.query<{ status: "open" | "closed"; assignee_user_id: string | null; version: number }>(
      `SELECT status,assignee_user_id,version FROM instagram_inbox_conversations
       WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 FOR UPDATE`,
      [workspace, connection, recipient],
    )
  ).rows[0]!;
  if (current.version !== change.expected)
    return { conflict: true, state: await readConversationState(client, workspace, connection, recipient) };
  const status = change.status ?? current.status;
  const assignee = change.assignee === undefined ? current.assignee_user_id : change.assignee;
  if (assignee !== current.assignee_user_id) {
    if (!assignmentAllowed(caller.role, user, current.assignee_user_id, assignee))
      throw new ApiError(403, "role_forbidden");
    if (assignee && !members.some((member) => member.user_id === assignee))
      throw new ApiError(409, "assignee_unavailable");
  }
  if (status !== current.status || assignee !== current.assignee_user_id) {
    const version = current.version + 1;
    await client.query(
      `UPDATE instagram_inbox_conversations SET status=$4,assignee_user_id=$5,version=$6,updated_by=$7,updated_at=now()
       WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3`,
      [workspace, connection, recipient, status, assignee, version, user.id],
    );
    await client.query(
      `INSERT INTO instagram_inbox_conversation_events(workspace_id,connection_id,recipient_id,version,reason,from_status,to_status,from_assignee,to_assignee,actor_id)
       VALUES($1,$2,$3,$4,'manual',$5,$6,$7,$8,$9)`,
      [workspace, connection, recipient, version, current.status, status, current.assignee_user_id, assignee, user.id],
    );
  }
  return { conflict: false, state: await readConversationState(client, workspace, connection, recipient) };
}

// Called inside removeMember's transaction after it locked the workspace row and then the member row (the
// same order as saveConversationState and delete_workspace_data): every conversation assigned to
// the removed member becomes unassigned, with one audit row each. Status is kept.
export async function unassignRemovedMember(
  client: PoolClient,
  workspace: string,
  memberId: string,
  actor: string,
): Promise<number> {
  // Connections first, in ID order, as the state change does, so a concurrent data deletion queues.
  await client.query(
    `SELECT 1 FROM instagram_connections WHERE workspace_id=$1 AND id IN (
       SELECT connection_id FROM instagram_inbox_conversations WHERE workspace_id=$1 AND assignee_user_id=$2
     ) ORDER BY id FOR SHARE`,
    [workspace, memberId],
  );
  await client.query(
    `SELECT 1 FROM instagram_inbox_conversations WHERE workspace_id=$1 AND assignee_user_id=$2
     ORDER BY connection_id,recipient_id FOR UPDATE`,
    [workspace, memberId],
  );
  const result = await client.query(
    `WITH changed AS (
       UPDATE instagram_inbox_conversations SET assignee_user_id=NULL,version=version+1,updated_by=$3,updated_at=now()
       WHERE workspace_id=$1 AND assignee_user_id=$2 RETURNING connection_id,recipient_id,version,status
     )
     INSERT INTO instagram_inbox_conversation_events(workspace_id,connection_id,recipient_id,version,reason,from_status,to_status,from_assignee,to_assignee,actor_id)
     SELECT $1,connection_id,recipient_id,version,'member_removed',status,status,$2,NULL,$3 FROM changed`,
    [workspace, memberId, actor],
  );
  return result.rowCount ?? 0;
}
