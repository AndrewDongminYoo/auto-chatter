import type { PoolClient } from "pg";
import type { InstagramMessage } from "./message-events.ts";

// Serializes the state changes of one inbox conversation (connection and DM recipient) for the rest of the
// transaction. A row lock cannot do this alone: the first close inserts the state row, which a concurrent
// reopen cannot see or wait for until the close commits. The state API takes it exclusive; DM ingestion takes
// it shared, so it waits for a state change but two DMs (or two webhook batches with their senders in
// opposite orders) never wait on each other. Callers take it after the connection FOR SHARE.
export async function lockConversation(
  client: PoolClient,
  connectionId: string,
  recipientId: string,
  mode: "shared" | "exclusive",
) {
  const lock = mode === "shared" ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock";
  await client.query(`SELECT ${lock}(hashtextextended('inbox-conversation:' || $1::uuid::text || ':' || $2, 0))`, [
    connectionId,
    recipientId,
  ]);
}

// A newly stored DM reopens its closed conversation (#22), with an audit row and no actor. A redelivered
// message inserts nothing and reopens nothing; a conversation without a state row is already open. The
// assignee and the handoff stay as they are.
export async function storeInboxMessage(client: PoolClient, message: InstagramMessage, now: Date): Promise<void> {
  if (message.timestamp.getTime() > now.getTime() + 60000 || message.text.includes("\u0000")) return;
  const stored = await client.query<{ workspace_id: string; connection_id: string }>(
    `INSERT INTO instagram_inbox_messages AS stored(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     SELECT workspace_id,id,$2,$3,$4,$5,$6 FROM instagram_connections
     WHERE account_id=$1 AND active AND inbox_enabled AND inbox_enabled_at<=$6
     ON CONFLICT(connection_id,message_id) DO NOTHING
     RETURNING stored.workspace_id::text,stored.connection_id::text`,
    [
      message.accountId,
      message.senderId,
      message.messageId,
      message.text,
      message.confirmationReplyId ? "postback" : "text",
      message.timestamp,
    ],
  );
  const inserted = stored.rows.sort((a, b) => a.connection_id.localeCompare(b.connection_id));
  for (const row of inserted) {
    // The connection FOR SHARE comes before the conversation, the order of the state API and the deletion
    // functions. The deletion functions lock the connection and then delete the conversation row, so taking the
    // conversation first would deadlock with them once this batch reaches a later connection lock
    // (sendingConnection, the reply wait). The conversation lock then waits for a close that is not yet
    // committed, so the UPDATE below (a new statement, with a new snapshot) sees it; the status read by the
    // INSERT above would still show the conversation as open.
    await client.query("SELECT 1 FROM instagram_connections WHERE id=$1 FOR SHARE", [row.connection_id]);
    await lockConversation(client, row.connection_id, message.senderId, "shared");
    await client.query(
      `WITH reopened AS (
         UPDATE instagram_inbox_conversations SET status='open',version=version+1,updated_by=NULL,updated_at=now()
         WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND status='closed'
         RETURNING version,assignee_user_id
       )
       INSERT INTO instagram_inbox_conversation_events(workspace_id,connection_id,recipient_id,version,reason,from_status,to_status,from_assignee,to_assignee,actor_id)
       SELECT $1,$2,$3,version,'auto_reopen','closed','open',assignee_user_id,assignee_user_id,NULL FROM reopened`,
      [row.workspace_id, row.connection_id, message.senderId],
    );
  }
}
