import { isRecord } from "../app/auth.ts";
export interface InstagramMessage {
  accountId: string;
  senderId: string;
  messageId: string;
  text: string;
  timestamp: Date;
  confirmationReplyId?: string;
}
export function parseMessageEvents(body: Uint8Array): InstagramMessage[] {
  const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if (!isRecord(payload) || payload.object !== "instagram" || !Array.isArray(payload.entry))
    throw new Error("Invalid Instagram webhook payload");
  const messages: InstagramMessage[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !Array.isArray(entry.messaging)) continue;
    for (const event of entry.messaging) {
      if (!isRecord(event) || event.is_self === true || !isRecord(event.sender) || !isRecord(event.recipient)) continue;
      const postback = isRecord(event.postback) ? event.postback : null;
      const binding =
        postback && typeof postback.payload === "string"
          ? /^auto-chatter:confirm:([1-9][0-9]{0,18})$/.exec(postback.payload)
          : null;
      if (postback && !binding) continue;
      const message = postback ? { mid: postback.mid, text: postback.title } : event.message;
      if (!isRecord(message)) continue;
      if (
        typeof event.sender.id !== "string" ||
        !/^\d+$/.test(event.sender.id) ||
        event.sender.id === entry.id ||
        event.recipient.id !== entry.id ||
        message.is_echo === true ||
        message.is_deleted === true ||
        typeof message.mid !== "string" ||
        !message.mid ||
        message.mid.length > 512 ||
        typeof message.text !== "string" ||
        message.text.length > 10000 ||
        typeof event.timestamp !== "number" ||
        !Number.isSafeInteger(event.timestamp) ||
        event.timestamp <= 0
      )
        continue;
      const timestamp = new Date(event.timestamp);
      if (!Number.isFinite(timestamp.getTime())) continue;
      messages.push({
        accountId: entry.id,
        senderId: event.sender.id,
        messageId: message.mid,
        text: message.text,
        timestamp,
        ...(binding ? { confirmationReplyId: binding[1]! } : {}),
      });
    }
  }
  return messages;
}
