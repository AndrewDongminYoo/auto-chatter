import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";
import { readInboxContext } from "./inbox.ts";

function validate(connection: string, recipient: string, query: URLSearchParams) {
  if (!isUuid(connection) || !/^\d{1,40}$/.test(recipient) || query.size)
    throw new ApiError(400, "invalid_handoff_request");
}

export async function inboxHandoff(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
) {
  validate(connection, recipient, query);
  const workspace = await workspaceFor(pool, user, "agent");
  const result = await pool.query(
    `SELECT handoff.active,handoff.version,
      EXISTS(SELECT 1 FROM instagram_inbox_messages WHERE workspace_id=$2 AND connection_id=$1 AND recipient_id=$3) AS conversation
     FROM instagram_connections connection LEFT JOIN instagram_inbox_handoffs handoff
       ON handoff.workspace_id=connection.workspace_id AND handoff.connection_id=connection.id AND handoff.recipient_id=$3
     WHERE connection.id=$1 AND connection.workspace_id=$2`,
    [connection, workspace, recipient],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "connection_not_found");
  if (row.version === null && !row.conversation) throw new ApiError(404, "conversation_not_found");
  return { active: row.active ?? false, version: row.version ?? 0 };
}

async function refreshPause(client: PoolClient, workspace: string, connection: string, sender: string) {
  const result = await client.query(
    `UPDATE instagram_contact_automation automation SET handoff_paused=EXISTS(
       SELECT 1 FROM instagram_inbox_handoffs handoff WHERE handoff.workspace_id=automation.workspace_id
         AND handoff.connection_id=automation.connection_id AND handoff.sender_id=automation.sender_id AND handoff.active
     ),updated_at=now() WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3 RETURNING handoff_paused`,
    [workspace, connection, sender],
  );
  if (result.rowCount !== 1) throw new Error("Handoff contact state missing");
  return result.rows[0].handoff_paused as boolean;
}

export async function saveInboxHandoff(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
  input: unknown,
) {
  validate(connection, recipient, query);
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 2 ||
    typeof input.active !== "boolean" ||
    !Number.isInteger(input.expected_version) ||
    Number(input.expected_version) < 0 ||
    Number(input.expected_version) >= 2147483647
  )
    throw new ApiError(400, "invalid_handoff_request");
  const workspace = await workspaceFor(pool, user, "agent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query(
      "SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE",
      [connection, workspace],
    );
    if (!owned.rowCount) throw new ApiError(404, "connection_not_found");
    const found = await client.query(
      "SELECT active,version,updated_by,sender_id,evidence_reply_id::text FROM instagram_inbox_handoffs WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 FOR UPDATE",
      [workspace, connection, recipient],
    );
    const current = found.rows[0];
    const version = current?.version ?? 0;
    if (input.expected_version !== version) {
      if (
        current &&
        current.version === Number(input.expected_version) + 1 &&
        current.active === input.active &&
        current.updated_by === user.id
      ) {
        await client.query("COMMIT");
        return { active: current.active as boolean, version: current.version as number };
      }
      throw new ApiError(409, "handoff_conflict");
    }
    if (!current) await readInboxContext(client, workspace, connection, recipient);
    if (input.active === (current?.active ?? false)) {
      await client.query("COMMIT");
      return { active: input.active, version };
    }
    let sender: string = current?.sender_id;
    let evidence: string = current?.evidence_reply_id;
    if (input.active) {
      const context = await readInboxContext(client, workspace, connection, recipient);
      if (context.mapping_status !== "verified" || !context.comment_sender_id || !context.evidence_reply_id)
        throw new ApiError(409, "handoff_identity_unverified");
      sender = context.comment_sender_id;
      evidence = context.evidence_reply_id;
    }
    await client.query(
      `INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id,connection_id,sender_id) DO NOTHING`,
      [workspace, connection, sender],
    );
    const before = (
      await client.query(
        "SELECT paused,handoff_paused FROM instagram_contact_automation WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3 FOR UPDATE",
        [workspace, connection, sender],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,connection_id,recipient_id) DO UPDATE
      SET sender_id=EXCLUDED.sender_id,evidence_reply_id=EXCLUDED.evidence_reply_id,active=EXCLUDED.active,
        version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [workspace, connection, recipient, sender, evidence, input.active, version + 1, user.id],
    );
    const after = await refreshPause(client, workspace, connection, sender);
    if (current && current.sender_id !== sender) await refreshPause(client, workspace, connection, current.sender_id);
    await client.query(
      `INSERT INTO instagram_inbox_handoff_events(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,actor_id,reason,manual_paused_before,handoff_paused_before,handoff_paused_after)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        workspace,
        connection,
        recipient,
        sender,
        evidence,
        input.active,
        version + 1,
        user.id,
        input.active ? "handoff_started" : "handoff_resumed",
        before.paused,
        before.handoff_paused,
        after,
      ],
    );
    await client.query("COMMIT");
    return { active: input.active, version: version + 1 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
