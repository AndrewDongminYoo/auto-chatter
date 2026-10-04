import { evaluateWindow } from "../channels/policy.ts";

export interface PrivateReplyPolicyInput {
  now: Date;
  commentCreatedAt: Date | null;
  connectionActive: boolean;
  authorizationVerified: boolean;
  mediaOwned: boolean;
  isOwnComment: boolean;
}

export type PrivateReplyPolicyResult =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | "inactive_connection"
        | "authorization_unverified"
        | "media_unverified"
        | "own_comment"
        | "comment_time_unverified"
        | "comment_expired";
    };

const replyWindowMs = 7 * 24 * 60 * 60 * 1000;

export function evaluatePrivateReply(input: PrivateReplyPolicyInput): PrivateReplyPolicyResult {
  if (!input.connectionActive) return { eligible: false, reason: "inactive_connection" };
  if (!input.authorizationVerified) return { eligible: false, reason: "authorization_unverified" };
  if (!input.mediaOwned) return { eligible: false, reason: "media_unverified" };
  if (input.isOwnComment) return { eligible: false, reason: "own_comment" };

  const window = evaluateWindow(input.now, input.commentCreatedAt, replyWindowMs);
  if (window === "unverified") return { eligible: false, reason: "comment_time_unverified" };
  if (window === "expired") return { eligible: false, reason: "comment_expired" };
  return { eligible: true };
}
