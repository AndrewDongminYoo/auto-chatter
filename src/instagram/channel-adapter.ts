import type { ChannelAdapter, ChannelCapabilities, ChannelEvent, ContentType } from "../channels/contract.ts";
import { parseCommentEvents, type InstagramComment } from "./webhook.ts";
import { parseMessageEvents, type InstagramMessage } from "./message-events.ts";
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
      marketing: operation(false),
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
      })),
      ...messages.map((message): ChannelEvent => ({
        account: { channel: "instagram", accountId: message.accountId },
        receipt: { family: "message", providerId: message.messageId },
        actor: { kind: "dm_recipient", value: message.senderId },
        occurredAt: message.timestamp,
        ...(message.confirmationReplyId === undefined
          ? { kind: "text_message", text: message.text }
          : { kind: "confirmation_postback", title: message.text, replyBinding: message.confirmationReplyId }),
      })),
    ];
  },
  acceptSendResult(value) {
    if (
      !value ||
      typeof value !== "object" ||
      !("messageId" in value) ||
      typeof value.messageId !== "string" ||
      !value.messageId.trim()
    )
      throw new Error("Invalid send acknowledgement");
    return { kind: "accepted", messageId: value.messageId };
  },
  classifySendError(error) {
    if (error instanceof PreSendVerificationError)
      return { kind: "not_attempted", disposition: error.disposition, code: error.failureCode };
    if (error instanceof ProviderRateLimitedError)
      return {
        kind: "refused",
        refusal: "rate_limited",
        code: error.failureCode,
        retryAfterSeconds: error.retryAfterSeconds,
      };
    if (error instanceof ProviderRejectedError)
      return { kind: "refused", refusal: "other", code: error.failureCode, retryAfterSeconds: null };
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
    if (
      event.account.channel !== "instagram" ||
      event.receipt.family !== (comment ? "comment" : "message") ||
      event.actor.kind !== (comment ? "comment_sender" : "dm_recipient")
    )
      throw new Error("Invalid Instagram channel event");
    if (event.kind === "comment")
      comments.push({
        accountId: event.account.accountId,
        commentId: event.receipt.providerId,
        postId: event.mediaId,
        senderId: event.actor.value,
        text: event.text,
        ...(event.parentId === undefined ? {} : { parentId: event.parentId }),
      });
    else
      messages.push({
        accountId: event.account.accountId,
        messageId: event.receipt.providerId,
        senderId: event.actor.value,
        text: event.kind === "text_message" ? event.text : event.title,
        timestamp: event.occurredAt,
        ...(event.kind === "confirmation_postback" ? { confirmationReplyId: event.replyBinding } : {}),
      });
  }
  return { comments, messages };
}
