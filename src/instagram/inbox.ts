import type { PoolClient } from "pg";
import type { InstagramMessage } from "./message-events.ts";

export async function storeInboxMessage(client: PoolClient, message: InstagramMessage, now: Date): Promise<void> {
  if (message.timestamp.getTime() > now.getTime() + 60000 || message.text.includes("\u0000")) return;
  await client.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     SELECT workspace_id,id,$2,$3,$4,$5,$6 FROM instagram_connections
     WHERE account_id=$1 AND active AND inbox_enabled AND inbox_enabled_at<=$6
     ON CONFLICT(connection_id,message_id) DO NOTHING`,
    [
      message.accountId,
      message.senderId,
      message.messageId,
      message.text,
      message.confirmationReplyId ? "postback" : "text",
      message.timestamp,
    ],
  );
}
