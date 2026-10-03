import type { PoolClient } from "pg";
import type { InstagramMessage } from "./message-events.ts";

// Serializes the state changes of one inbox conversation (connection and DM recipient) for the rest of the
// transaction. A row lock cannot do this alone: the first close inserts the state row, which a concurrent
// reopen cannot see or wait for until the close commits. The state API and DM ingestion
// (lockInboxConversations) take it exclusive, so DMs of one conversation are serialized with each other and
// with state changes, while DMs of different conversations never wait on each other. Callers take it after
// the connection FOR SHARE.
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

// A DM dated more than a minute ahead, or with text PostgreSQL cannot store, is never stored.
const storable = (message: InstagramMessage, now: Date) =>
  message.timestamp.getTime() <= now.getTime() + 60000 && !message.text.includes("\u0000");

// Takes, before any DM of the batch is stored, the conversation lock exclusive for every conversation the batch
// can store a DM into (#127). The read position is an ID watermark (`m.id > last_read_message_id`), so the DMs of
// one conversation must commit in the order of their IDs: holding the lock from before the INSERT that allocates
// the ID until COMMIT makes a second DM of the conversation take its ID only after the first one committed.
// The connections of the batch's accounts are locked FOR SHARE first, in ID order like the deletion functions,
// and only then is the storage predicate of storeInboxMessage evaluated, so the INSERT sees the connection state
// read here. The conversations are then locked in (connection, recipient) order, so batches with their senders
// in opposite orders queue instead of deadlocking.
export async function lockInboxConversations(
  client: PoolClient,
  messages: readonly InstagramMessage[],
  now: Date,
): Promise<void> {
  const batch = messages.filter((message) => storable(message, now));
  if (!batch.length) return;
  await client.query("SELECT 1 FROM instagram_connections WHERE account_id=ANY($1::text[]) ORDER BY id FOR SHARE", [
    [...new Set(batch.map((message) => message.accountId))],
  ]);
  const conversations = await client.query<{ connection_id: string; recipient_id: string }>(
    `SELECT DISTINCT c.id AS connection_id,m.recipient_id
     FROM unnest($1::text[],$2::text[],$3::timestamptz[]) AS m(account_id,recipient_id,message_at)
     JOIN instagram_connections c ON c.account_id=m.account_id AND c.active AND c.inbox_enabled AND c.inbox_enabled_at<=m.message_at
     ORDER BY c.id,m.recipient_id`,
    [
      batch.map((message) => message.accountId),
      batch.map((message) => message.senderId),
      batch.map((message) => message.timestamp),
    ],
  );
  for (const row of conversations.rows)
    await lockConversation(client, row.connection_id, row.recipient_id, "exclusive");
}

// A newly stored DM reopens its closed conversation (#22), with an audit row and no actor. A redelivered
// message inserts nothing and reopens nothing; a conversation without a state row is already open. The
// assignee and the handoff stay as they are.
export async function storeInboxMessage(client: PoolClient, message: InstagramMessage, now: Date): Promise<void> {
  if (!storable(message, now)) return;
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
    // INSERT above would still show the conversation as open. ingestMessages, the only production caller,
    // already holds both locks (the conversation one exclusive, from lockInboxConversations), so for it they are
    // re-acquisitions that never wait; they keep the reopen correct for a caller that did not take them first.
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
