import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { lockWorkspaceForMember, membershipFor, workspaceFor } from "./settings.ts";
import { lockConversation } from "../instagram/inbox.ts";

// Inbox conversation labels (#23-B). A label belongs to the workspace and is archived, never deleted; a
// conversation (connection and DM recipient) holds a set of up to 10 labels with a version, and each change of
// the set writes one append-only event. Labels are not contact tags: they never touch comment participants.
export const LABEL_NAME_MAX = 30;
export const ACTIVE_LABEL_LIMIT = 50;
export const CONVERSATION_LABEL_LIMIT = 10;

export type InboxLabel = { id: string; name: string; archived: boolean };
export type LabelSet = { version: number; labels: InboxLabel[] };

// The labels of a stored set as JSON, ordered by name. workspace and ids are SQL expressions of the caller's
// query; only the same workspace's labels are joined, archived ones included.
export function labelsJson(workspace: string, ids: string): string {
  return `coalesce((SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'archived',l.archived) ORDER BY lower(l.name),l.id)
    FROM instagram_inbox_labels l WHERE l.workspace_id=${workspace} AND l.id=ANY(${ids})),'[]'::jsonb)`;
}

function labelName(input: unknown): string {
  if (typeof input !== "string" || input.length > 300) throw new ApiError(400, "invalid_label");
  const name = input.trim().normalize("NFC");
  if (!name || [...name].length > LABEL_NAME_MAX || /[\p{Cc}\p{Cf}]/u.test(name))
    throw new ApiError(400, "invalid_label");
  return name;
}

const LABEL_COLUMNS = "id,name,archived,created_at,updated_at";

// Every role reads the labels, archived ones flagged, so agents can edit a conversation's set and filter by it.
export async function listInboxLabels(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user, "agent");
  return (
    await pool.query(
      `SELECT ${LABEL_COLUMNS} FROM instagram_inbox_labels WHERE workspace_id=$1 ORDER BY archived,lower(name),id`,
      [workspace],
    )
  ).rows;
}

export async function createInboxLabel(pool: Pool, user: User, input: unknown) {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "name")) throw new ApiError(400, "invalid_label");
  const name = labelName(input.name);
  const workspace = await workspaceFor(pool, user, "admin");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The workspace row lock serializes creations, so concurrent requests cannot pass the active-label limit.
    await lockWorkspaceForMember(client, workspace, user, "admin");
    const result = await client.query(
      `INSERT INTO instagram_inbox_labels(workspace_id,name,created_by)
       SELECT $1,$2,$3 WHERE (SELECT count(*) FROM instagram_inbox_labels WHERE workspace_id=$1 AND NOT archived)<$4
       RETURNING ${LABEL_COLUMNS}`,
      [workspace, name, user.id, ACTIVE_LABEL_LIMIT],
    );
    if (!result.rows[0]) throw new ApiError(409, "label_limit_reached");
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isRecord(error) && error.code === "23505") throw new ApiError(409, "label_name_exists");
    throw error;
  } finally {
    client.release();
  }
}

async function missingOrArchived(pool: Pool, workspace: string, id: string): Promise<never> {
  const found = await pool.query("SELECT archived FROM instagram_inbox_labels WHERE workspace_id=$1 AND id=$2", [
    workspace,
    id,
  ]);
  if (!found.rows[0]) throw new ApiError(404, "label_not_found");
  throw new ApiError(409, "label_archived");
}

// Renaming keeps the label's ID, so every conversation that has it shows the new name. An archived label cannot
// be renamed.
export async function renameInboxLabel(pool: Pool, user: User, id: string, input: unknown) {
  if (!isUuid(id) || !isRecord(input) || Object.keys(input).length !== 1 || !("name" in input))
    throw new ApiError(400, "invalid_label");
  const name = labelName(input.name);
  const workspace = await workspaceFor(pool, user, "admin");
  let result;
  try {
    result = await pool.query(
      `UPDATE instagram_inbox_labels SET name=$3,updated_at=clock_timestamp()
       WHERE workspace_id=$1 AND id=$2 AND NOT archived RETURNING ${LABEL_COLUMNS}`,
      [workspace, id, name],
    );
  } catch (error) {
    if (isRecord(error) && error.code === "23505") throw new ApiError(409, "label_name_exists");
    throw error;
  }
  return result.rows[0] ?? missingOrArchived(pool, workspace, id);
}

// Archiving frees the name and stops the label from being added; conversations that have it keep it.
export async function archiveInboxLabel(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_label");
  const workspace = await workspaceFor(pool, user, "admin");
  const result = await pool.query(
    `UPDATE instagram_inbox_labels SET archived=true,updated_at=CASE WHEN archived THEN updated_at ELSE clock_timestamp() END
     WHERE workspace_id=$1 AND id=$2 RETURNING ${LABEL_COLUMNS}`,
    [workspace, id],
  );
  if (!result.rows[0]) throw new ApiError(404, "label_not_found");
  return result.rows[0];
}

export async function readConversationLabels(
  db: Pick<Pool, "query">,
  workspace: string,
  connection: string,
  recipient: string,
): Promise<LabelSet> {
  const result = await db.query<LabelSet>(
    `SELECT coalesce(sets.version,0) AS version,${labelsJson("target.workspace_id", "coalesce(sets.label_ids,'{}')")} AS labels
     FROM (SELECT $1::uuid AS workspace_id,$2::uuid AS connection_id,$3::text AS recipient_id) target
     LEFT JOIN instagram_inbox_conversation_labels sets ON sets.workspace_id=target.workspace_id
       AND sets.connection_id=target.connection_id AND sets.recipient_id=target.recipient_id`,
    [workspace, connection, recipient],
  );
  return result.rows[0]!;
}

function parseLabelSet(connection: string, recipient: string, query: URLSearchParams, input: unknown) {
  if (!isUuid(connection) || !/^\d{1,40}$/.test(recipient) || query.size || !isRecord(input))
    throw new ApiError(400, "invalid_label_request");
  const keys = Object.keys(input);
  if (
    keys.length !== 2 ||
    !keys.includes("expected_version") ||
    !keys.includes("label_ids") ||
    !Number.isInteger(input.expected_version) ||
    Number(input.expected_version) < 0 ||
    Number(input.expected_version) >= 2147483647 ||
    !Array.isArray(input.label_ids) ||
    input.label_ids.length > CONVERSATION_LABEL_LIMIT ||
    !input.label_ids.every(isUuid)
  )
    throw new ApiError(400, "invalid_label_request");
  const ids = (input.label_ids as string[]).map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new ApiError(400, "invalid_label_request");
  return { expected: Number(input.expected_version), ids: ids.sort() };
}

export type SaveLabelsResult = { conflict: boolean; label_set: LabelSet };

export async function saveConversationLabels(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
  input: unknown,
): Promise<SaveLabelsResult> {
  const change = parseLabelSet(connection, recipient, query, input);
  const { workspace_id: workspace } = await membershipFor(pool, user, "agent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { wrote, ...result } = await applyLabels(client, user, workspace, connection, recipient, change);
    // A conflict or an unchanged set rolls back the version 0 placeholder, so it stores nothing.
    await client.query(wrote ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function applyLabels(
  client: PoolClient,
  user: User,
  workspace: string,
  connection: string,
  recipient: string,
  change: ReturnType<typeof parseLabelSet>,
): Promise<SaveLabelsResult & { wrote: boolean }> {
  // The lock order of the conversation state change (saveConversationState): the workspace row, the caller's
  // membership row, the connection, the conversation (lockConversation), then the label-set row. The workspace
  // row first queues behind delete_workspace_data, the member row sees a committed removal, and the connection
  // FOR SHARE serializes with the connection and person deletion functions, so no label row is written after a
  // deletion removed the conversation.
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
  await lockConversation(client, connection, recipient, "exclusive");
  // A version 0 row means the same as no row; inserting it gives concurrent first changes a row to queue on.
  await client.query(
    `INSERT INTO instagram_inbox_conversation_labels(workspace_id,connection_id,recipient_id) VALUES($1,$2,$3)
     ON CONFLICT(workspace_id,connection_id,recipient_id) DO NOTHING`,
    [workspace, connection, recipient],
  );
  const current = (
    await client.query<{ label_ids: string[]; version: number }>(
      `SELECT label_ids,version FROM instagram_inbox_conversation_labels
       WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 FOR UPDATE`,
      [workspace, connection, recipient],
    )
  ).rows[0]!;
  if (current.version !== change.expected)
    return {
      conflict: true,
      wrote: false,
      label_set: await readConversationLabels(client, workspace, connection, recipient),
    };
  const added = change.ids.filter((id) => !current.label_ids.includes(id));
  const removed = current.label_ids.filter((id) => !change.ids.includes(id)).sort();
  if (added.length) {
    // FOR SHARE holds the added labels until this commits, so an archive cannot commit between this check and
    // the write; a label archived before stays on conversations that already have it but cannot be added.
    const labels = (
      await client.query<{ id: string; archived: boolean }>(
        "SELECT id,archived FROM instagram_inbox_labels WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE",
        [workspace, added],
      )
    ).rows;
    if (labels.length !== added.length) throw new ApiError(404, "label_not_found");
    if (labels.some((label) => label.archived)) throw new ApiError(409, "label_archived");
  }
  const wrote = added.length > 0 || removed.length > 0;
  if (wrote) {
    const version = current.version + 1;
    await client.query(
      `UPDATE instagram_inbox_conversation_labels SET label_ids=$4::uuid[],version=$5,updated_by=$6,updated_at=clock_timestamp()
       WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3`,
      [workspace, connection, recipient, change.ids, version, user.id],
    );
    await client.query(
      `INSERT INTO instagram_inbox_label_events(workspace_id,connection_id,recipient_id,version,added,removed,actor_id)
       VALUES($1,$2,$3,$4,$5::uuid[],$6::uuid[],$7)`,
      [workspace, connection, recipient, version, added, removed, user.id],
    );
  }
  return {
    conflict: false,
    wrote,
    label_set: await readConversationLabels(client, workspace, connection, recipient),
  };
}
