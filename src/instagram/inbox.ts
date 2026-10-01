import type { PoolClient } from "pg";
import type { InstagramMessage } from "./message-events.ts";

// A newly stored DM reopens its closed conversation (#22), with an audit row and no actor. A redelivered
// message inserts nothing and reopens nothing; a conversation without a state row is already open. The
// assignee and the handoff stay as they are.
export async function storeInboxMessage(client: PoolClient, message: InstagramMessage, now: Date): Promise<void> {
  if (message.timestamp.getTime() > now.getTime() + 60000 || message.text.includes("\u0000")) return;
  const stored = await client.query<{ workspace_id: string; connection_id: string; closed: boolean }>(
    `INSERT INTO instagram_inbox_messages AS stored(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     SELECT workspace_id,id,$2,$3,$4,$5,$6 FROM instagram_connections
     WHERE account_id=$1 AND active AND inbox_enabled AND inbox_enabled_at<=$6
     ON CONFLICT(connection_id,message_id) DO NOTHING
     RETURNING stored.workspace_id::text,stored.connection_id::text,EXISTS(SELECT 1 FROM instagram_inbox_conversations state
       WHERE state.workspace_id=stored.workspace_id AND state.connection_id=stored.connection_id
         AND state.recipient_id=stored.recipient_id AND state.status='closed') AS closed`,
    [
      message.accountId,
      message.senderId,
      message.messageId,
      message.text,
      message.confirmationReplyId ? "postback" : "text",
      message.timestamp,
    ],
  );
  const closed = stored.rows.filter((row) => row.closed).sort((a, b) => a.connection_id.localeCompare(b.connection_id));
  for (const row of closed) {
    // The connection FOR SHARE comes before the conversation row, the order of the state API and the deletion
    // functions. The deletion functions lock the connection and then delete the conversation row, so taking the
    // conversation row first would deadlock with them once this batch reaches a later connection lock
    // (sendingConnection, the reply wait). Only a reopen takes this lock.
    await client.query("SELECT 1 FROM instagram_connections WHERE id=$1 FOR SHARE", [row.connection_id]);
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
