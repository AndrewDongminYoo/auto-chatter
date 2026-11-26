import { isRecord } from "../app/auth.ts";

// The attachment types the Instagram webhook documentation lists (#20). Any other type string is stored as "other".
export const ATTACHMENT_TYPES = ["audio", "file", "image", "share", "story_mention", "video", "ig_reel", "reel", "ig_post", "story", "ig_story", "ephemeral", "other"] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_TITLE = 200;
// Only the type and an optional title are kept. Media URLs, reel, sticker and story IDs are never read (#20).
export type InstagramAttachment = { type: AttachmentType; title?: string };

export interface InstagramMessage {
  accountId: string;
  // Empty only for a deleted event whose envelope has no sender.
  senderId: string;
  messageId: string;
  // Empty for an attachment-only, unsupported or deleted event.
  text: string;
  timestamp: Date;
  confirmationReplyId?: string;
  // Absent for a typed DM or a confirmation postback, which keep their existing paths. The other kinds are stored in
  // the inbox and never reach a keyword trigger, a label rule, a reply wait, the follow confirmation or the kept DMs.
  content?: "attachment" | "unsupported" | "deleted";
  // Set on a typed DM that carries attachments and on an attachment-only DM.
  attachments?: InstagramAttachment[];
}

// A DM that opens the 24-hour window and counts as an inbound DM: a typed DM, an attachment and an unsupported
// message. A confirmation postback and a deleted event do not.
export const opensWindow = (message: InstagramMessage): boolean => !message.confirmationReplyId && message.content !== "deleted";
// A DM that the reply wait, the follow confirmation, the kept DMs and the DM triggers may take.
export const reachesAutomation = (message: InstagramMessage): boolean => message.content === undefined;

const digits = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
const validMid = (mid: unknown): mid is string => typeof mid === "string" && mid.length > 0 && mid.length <= 512 && !mid.includes("\u0000");

const utf8Encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8");

function readAttachments(value: unknown): InstagramAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: InstagramAttachment[] = [];
  for (const item of value) {
    if (attachments.length === MAX_ATTACHMENTS) break;
    if (!isRecord(item) || typeof item.type !== "string") continue;
    const type = (ATTACHMENT_TYPES as readonly string[]).includes(item.type) ? (item.type as AttachmentType) : "other";
    const title = isRecord(item.payload) ? item.payload.title : undefined;
    // jsonb refuses NUL and an unpaired surrogate escape, which would roll back the whole webhook batch, so such a title
    // is dropped and the attachment kind is kept. An unpaired surrogate becomes U+FFFD in UTF-8, so it fails the round trip.
    const keep = typeof title === "string" && title.length > 0 && [...title].length <= MAX_ATTACHMENT_TITLE && !title.includes("\u0000") && utf8.decode(utf8Encoder.encode(title)) === title;
    attachments.push(keep ? { type, title } : { type });
  }
  return attachments;
}

export function parseMessageEvents(body: Uint8Array): InstagramMessage[] {
  const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if (!isRecord(payload) || payload.object !== "instagram" || !Array.isArray(payload.entry)) throw new Error("Invalid Instagram webhook payload");
  const messages: InstagramMessage[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !Array.isArray(entry.messaging)) continue;
    for (const event of entry.messaging) {
      if (!isRecord(event) || event.is_self === true || typeof event.timestamp !== "number" || !Number.isSafeInteger(event.timestamp) || event.timestamp <= 0) continue;
      const timestamp = new Date(event.timestamp);
      if (!Number.isFinite(timestamp.getTime())) continue;
      // A deleted event (#20) may name only the message. When the envelope names the people, they must still be the
      // sender and this account, so a forged envelope cannot name another account as the sender.
      if (isRecord(event.message) && event.message.is_deleted === true) {
        const sender = isRecord(event.sender) ? event.sender.id : undefined;
        const recipient = isRecord(event.recipient) ? event.recipient.id : undefined;
        if (event.message.is_echo === true || !validMid(event.message.mid)) continue;
        if (sender !== undefined && (!digits(sender) || sender === entry.id)) continue;
        if (recipient !== undefined && recipient !== entry.id) continue;
        messages.push({ accountId: entry.id, senderId: sender ?? "", messageId: event.message.mid, text: "", timestamp, content: "deleted" });
        continue;
      }
      if (!isRecord(event.sender) || !isRecord(event.recipient)) continue;
      const postback = isRecord(event.postback) ? event.postback : null;
      const binding = postback && typeof postback.payload === "string" ? /^auto-chatter:confirm:([1-9][0-9]{0,18})$/.exec(postback.payload) : null;
      if (postback && !binding) continue;
      const message = postback ? { mid: postback.mid, text: postback.title } : event.message;
      if (!isRecord(message)) continue;
      if (!digits(event.sender.id) || event.sender.id === entry.id || event.recipient.id !== entry.id || message.is_echo === true || !validMid(message.mid)) continue;
      const base = { accountId: entry.id, senderId: event.sender.id, messageId: message.mid, timestamp };
      if (typeof message.text === "string") {
        if (message.text.length > 10000) continue;
        const attachments = postback ? [] : readAttachments(message.attachments);
        messages.push({
          ...base,
          text: message.text,
          ...(binding ? { confirmationReplyId: binding[1]! } : {}),
          ...(attachments.length ? { attachments } : {}),
        });
        continue;
      }
      // A message with a non-string text, or a postback without a title, stays dropped.
      if (postback || message.text !== undefined) continue;
      const attachments = readAttachments(message.attachments);
      if (attachments.length) messages.push({ ...base, text: "", content: "attachment", attachments });
      else if (message.is_unsupported === true) messages.push({ ...base, text: "", content: "unsupported" });
    }
  }
  return messages;
}
