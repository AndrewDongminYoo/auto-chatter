import type { ChannelAdapter, ChannelCapabilities, ChannelEvent, ContentType } from "../channels/contract.ts";
import { parseCommentEvents, type InstagramComment } from "./webhook.ts";
import { parseMessageEvents, type InstagramAttachment, type InstagramMessage } from "./message-events.ts";
import { PreSendVerificationError, ProviderRateLimitedError, ProviderRejectedError } from "./reply-worker.ts";

type Surface = "cloudflare_oauth" | "node_instagram" | "node_facebook";
const operation = (supported: boolean) =>
  Object.freeze({
    supported,
    content_types: Object.freeze(supported ? ["text" as ContentType] : []),
  });
const capabilities = (surface: Surface): ChannelCapabilities =>
  Object.freeze({
    schema_version: 1,
    channel: "instagram",
    operations: Object.freeze({
      comment_private_reply: operation(true),
      follow_reply: operation(surface !== "node_facebook"),
      manual_reply: operation(surface === "cloudflare_oauth"),
      // Promotional text inside the 24-hour standard messaging window is allowed on the Instagram API with
      // Instagram Login (Meta messaging policy, docs/specs/2026-10-27-campaign-runs.md). Only the Cloudflare OAuth
      // surface sends campaigns; message tags, Sponsored Messages and One-Time Notifications are not used.
      marketing: operation(surface === "cloudflare_oauth"),
    }),
    templates: Object.freeze({ confirmation_postback: surface !== "node_facebook", approved_message: false }),
  });
const surfaces = Object.freeze({
  cloudflare_oauth: capabilities("cloudflare_oauth"),
  node_instagram: capabilities("node_instagram"),
  node_facebook: capabilities("node_facebook"),
});
export function instagramCapabilities(surface: Surface): ChannelCapabilities {
  return surfaces[surface];
}

export const instagramAdapter: ChannelAdapter = {
  capabilities: surfaces.cloudflare_oauth,
  // Call only after raw-body signature verification. Both parsers must succeed before ingestion begins.
  decodeWebhook(body) {
    const comments = parseCommentEvents(body);
    const messages = parseMessageEvents(body);
    return [
      ...comments.map((comment): ChannelEvent => ({
        account: { channel: "instagram", accountId: comment.accountId },
        receipt: { family: "comment", providerId: comment.commentId },
        actor: { kind: "comment_sender", value: comment.senderId },
        kind: "comment",
        mediaId: comment.postId,
        text: comment.text,
        occurredAt: null,
        ...(comment.parentId === undefined ? {} : { parentId: comment.parentId }),
        ...(comment.senderUsername === undefined ? {} : { actorName: comment.senderUsername }),
      })),
      ...messages.map((message): ChannelEvent => {
        const base = {
          account: { channel: "instagram", accountId: message.accountId },
          receipt: { family: "message" as const, providerId: message.messageId },
          actor: { kind: "dm_recipient", value: message.senderId },
          occurredAt: message.timestamp,
        };
        if (message.content === "attachment") return { ...base, kind: "attachment_message", attachments: message.attachments ?? [] };
        if (message.content === "unsupported") return { ...base, kind: "unsupported_message" };
        if (message.content === "deleted") return { ...base, kind: "message_deleted" };
        if (message.confirmationReplyId !== undefined) return { ...base, kind: "confirmation_postback", title: message.text, replyBinding: message.confirmationReplyId };
        return { ...base, kind: "text_message", text: message.text, ...(message.attachments ? { attachments: message.attachments } : {}) };
      }),
    ];
  },
  acceptSendResult(value) {
    if (!value || typeof value !== "object" || !("messageId" in value) || typeof value.messageId !== "string" || !value.messageId.trim()) throw new Error("Invalid send acknowledgement");
    return { kind: "accepted", messageId: value.messageId };
  },
  classifySendError(error) {
    if (error instanceof PreSendVerificationError) return { kind: "not_attempted", disposition: error.disposition, code: error.failureCode };
    if (error instanceof ProviderRateLimitedError)
      return {
        kind: "refused",
        refusal: "rate_limited",
        code: error.failureCode,
        retryAfterSeconds: error.retryAfterSeconds,
      };
    if (error instanceof ProviderRejectedError) return { kind: "refused", refusal: "other", code: error.failureCode, retryAfterSeconds: null };
    return { kind: "unknown", code: "send_outcome_unknown" };
  },
};

// Keep Instagram storage and its transaction/lock/retention policies behind the adapter seam.
export function partitionInstagramEvents(events: readonly ChannelEvent[]): {
  comments: InstagramComment[];
  messages: InstagramMessage[];
} {
  const comments: InstagramComment[] = [],
    messages: InstagramMessage[] = [];
  for (const event of events) {
    const comment = event.kind === "comment";
    if (event.account.channel !== "instagram" || event.receipt.family !== (comment ? "comment" : "message") || event.actor.kind !== (comment ? "comment_sender" : "dm_recipient")) throw new Error("Invalid Instagram channel event");
    if (event.kind === "comment")
      comments.push({
        accountId: event.account.accountId,
        commentId: event.receipt.providerId,
        postId: event.mediaId,
        senderId: event.actor.value,
        ...(event.actorName === undefined ? {} : { senderUsername: event.actorName }),
        text: event.text,
        ...(event.parentId === undefined ? {} : { parentId: event.parentId }),
      });
    else {
      const base = { accountId: event.account.accountId, messageId: event.receipt.providerId, senderId: event.actor.value, timestamp: event.occurredAt };
      // The adapter produced these attachments from parseMessageEvents, so their types are the parser's types.
      const attachments = (value: readonly { type: string; title?: string }[]) => value as InstagramAttachment[];
      if (event.kind === "attachment_message") messages.push({ ...base, text: "", content: "attachment", attachments: attachments(event.attachments) });
      else if (event.kind === "unsupported_message") messages.push({ ...base, text: "", content: "unsupported" });
      else if (event.kind === "message_deleted") messages.push({ ...base, text: "", content: "deleted" });
      else if (event.kind === "confirmation_postback") messages.push({ ...base, text: event.title, confirmationReplyId: event.replyBinding });
      else messages.push({ ...base, text: event.text, ...(event.attachments ? { attachments: attachments(event.attachments) } : {}) });
    }
  }
  return { comments, messages };
}
