import type { Pool } from "pg";
import { isRecord } from "../app/auth.ts";

// A `messaging_seen` webhook event (#312): one person read one message of the account's conversation with them.
// Meta sends it only with Instagram Login and names exactly one message (`read.mid`); there is no watermark.
export interface InstagramMessageRead {
  accountId: string;
  readerId: string;
  messageId: string;
  readAt: Date;
}

// 9999-12-31T23:59:59.999Z, the last time whose ISO text PostgreSQL accepts as timestamptz input.
const LATEST_READ_TIME = 253402300799999;

// Reads the `messaging_seen` events of a signed webhook body. A malformed event is skipped, like a malformed DM, so
// one bad event never makes Meta redeliver the whole body; the limits match the DB CHECKs of instagram_message_reads.
// A read event has no `message` or `postback`, so parseMessageEvents never sees it as an inbound DM.
export function parseMessageReadEvents(body: Uint8Array): InstagramMessageRead[] {
  const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if (!isRecord(payload) || payload.object !== "instagram" || !Array.isArray(payload.entry)) throw new Error("Invalid Instagram webhook payload");
  const reads: InstagramMessageRead[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !Array.isArray(entry.messaging)) continue;
    for (const event of entry.messaging) {
      if (!isRecord(event) || event.is_self === true || !isRecord(event.sender) || !isRecord(event.recipient)) continue;
      if (!isRecord(event.read) || isRecord(event.message) || isRecord(event.postback)) continue;
      const mid = event.read.mid;
      if (
        typeof event.sender.id !== "string" ||
        !/^[0-9]{1,40}$/.test(event.sender.id) ||
        event.sender.id === entry.id ||
        event.recipient.id !== entry.id ||
        typeof mid !== "string" ||
        !mid.trim() ||
        mid.length > 512 ||
        mid.includes("\u0000") ||
        typeof event.timestamp !== "number" ||
        !Number.isSafeInteger(event.timestamp) ||
        event.timestamp <= 0 ||
        // PostgreSQL rejects the ISO text of a year after 9999, which would fail the whole body.
        event.timestamp > LATEST_READ_TIME
      )
        continue;
      const readAt = new Date(event.timestamp);
      reads.push({ accountId: entry.id, readerId: event.sender.id, messageId: mid, readAt });
    }
  }
  return reads;
}

// Stores the reads of messages the service sent: the account must be an active connection and `read.mid` must be a
// provider_message_id stored for that connection by one of the send tables. Any other read (a message a person sent
// from the Instagram app, another connection's message) leaves no row. The first stored read_at of a
// (connection, message, reader) stays: a redelivered or repeated event inserts nothing. Follow replies match through
// instagram_follow_messages (every reply's ID, #321) and through the follow row's latest ID, which also covers a
// reply sent by a worker that ran before migration 071.
export async function ingestMessageReads(pool: Pool, reads: readonly InstagramMessageRead[]): Promise<void> {
  if (!reads.length) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the active connections first, in their own statement, like contact writes: a connection deletion locks the
    // row FOR UPDATE, so it either finishes first (the row is then inactive and skipped here) or waits for this
    // transaction. The INSERT below then takes a fresh snapshot that sees every send row the deletion left.
    const connections = await client.query<{ id: string }>("SELECT id FROM instagram_connections WHERE account_id=ANY($1::text[]) AND active ORDER BY id FOR SHARE", [[...new Set(reads.map((read) => read.accountId))]]);
    if (connections.rows.length) {
      await client.query(
        `INSERT INTO instagram_message_reads(workspace_id,connection_id,recipient_id,message_id,read_at)
         SELECT c.workspace_id,c.id,r.reader_id,r.message_id,r.read_at
         FROM unnest($1::text[],$2::text[],$3::text[],$4::timestamptz[]) WITH ORDINALITY
           AS r(account_id,reader_id,message_id,read_at,position)
         JOIN instagram_connections c ON c.account_id=r.account_id AND c.id=ANY($5::uuid[])
         WHERE EXISTS(SELECT 1 FROM private_reply_outbox s WHERE s.connection_id=c.id AND s.provider_message_id=r.message_id)
           OR EXISTS(SELECT 1 FROM instagram_follow_messages s
             WHERE s.connection_id=c.id AND s.provider_message_id=r.message_id)
           OR EXISTS(SELECT 1 FROM instagram_follow_conversations s
             WHERE s.connection_id=c.id AND s.provider_message_id=r.message_id)
           OR EXISTS(SELECT 1 FROM instagram_manual_replies s
             WHERE s.connection_id=c.id AND s.provider_message_id=r.message_id)
           OR EXISTS(SELECT 1 FROM flow_dm_deliveries s WHERE s.connection_id=c.id AND s.provider_message_id=r.message_id)
           OR EXISTS(SELECT 1 FROM campaign_deliveries s WHERE s.connection_id=c.id AND s.provider_message_id=r.message_id)
         ORDER BY r.position
         ON CONFLICT(connection_id,message_id,recipient_id) DO NOTHING`,
        [reads.map((read) => read.accountId), reads.map((read) => read.readerId), reads.map((read) => read.messageId), reads.map((read) => read.readAt.toISOString()), connections.rows.map((row) => row.id)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
