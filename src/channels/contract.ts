// These addresses are provider namespaces, not proof of workspace ownership or identity linking.
export interface ChannelAccountAddress {
  channel: string;
  accountId: string;
}
export interface OwnedChannelAccount extends ChannelAccountAddress {
  workspaceId: string;
  connectionId: string;
}
export interface ScopedChannelIdentity {
  workspaceId: string;
  connectionId: string;
  channel: string;
  identityKind: string;
  identityValue: string;
}
export function sameScopedIdentity(left: ScopedChannelIdentity, right: ScopedChannelIdentity): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.connectionId === right.connectionId &&
    left.channel === right.channel &&
    left.identityKind === right.identityKind &&
    left.identityValue === right.identityValue
  );
}
interface EventBase {
  account: ChannelAccountAddress;
  receipt: { family: "comment" | "message"; providerId: string };
  actor: { kind: string; value: string };
}
export type ChannelEvent =
  | (EventBase & { kind: "comment"; mediaId: string; parentId?: string; text: string; occurredAt: null })
  | (EventBase & { kind: "text_message"; text: string; occurredAt: Date })
  | (EventBase & { kind: "confirmation_postback"; title: string; replyBinding: string; occurredAt: Date });

// A receipt key is not an outgoing idempotency key. Database uniqueness remains authoritative.
export function eventReceiptKey(event: ChannelEvent): string {
  return JSON.stringify([
    event.account.channel,
    event.account.accountId,
    event.receipt.family,
    event.receipt.providerId,
  ]);
}
export const CONTENT_TYPES = ["text", "attachment", "provider_template"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export type ChannelOperation = "comment_private_reply" | "follow_reply" | "manual_reply" | "marketing";
// Advisory implementation metadata only. Every current eligibility/final-send guard still applies.
export interface ChannelCapabilities {
  readonly schema_version: 1;
  readonly channel: string;
  readonly operations: Readonly<
    Record<
      ChannelOperation,
      {
        readonly supported: boolean;
        readonly content_types: readonly ContentType[];
      }
    >
  >;
  readonly templates: { readonly confirmation_postback: boolean; readonly approved_message: boolean };
}
export function checkCapability(capabilities: ChannelCapabilities, operation: string, contentType: string): boolean {
  if (!Object.hasOwn(capabilities.operations, operation)) return false;
  const capability = capabilities.operations[operation as ChannelOperation];
  return capability.supported && capability.content_types.some((type) => type === contentType);
}
export type AcceptedOutcome = { kind: "accepted"; messageId: string; recipientId?: string };
export type FailedOutcome =
  | { kind: "not_attempted"; disposition: "retry" | "block"; code: string }
  | { kind: "refused"; refusal: "rate_limited" | "other"; code: string; retryAfterSeconds: number | null }
  | { kind: "unknown"; code: "send_outcome_unknown" };
// The adapter neither authorizes sending nor decides whether/how to retry an outcome.
export interface ChannelAdapter {
  readonly capabilities: ChannelCapabilities;
  decodeWebhook(body: Uint8Array): readonly ChannelEvent[];
  acceptSendResult(value: unknown): AcceptedOutcome;
  classifySendError(error: unknown): FailedOutcome;
}
