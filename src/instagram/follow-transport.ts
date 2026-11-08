import { confirmationMessage } from "./confirmation-button.ts";
import { isRecord } from "../app/auth.ts";
import {
  classifyMetaGraphFailure,
  metaTokenRejected,
  reportIdentity,
  type IdentityObserver,
} from "./meta-graph-error.ts";
import { PreSendVerificationError } from "./reply-worker.ts";
// The identity read resolves to this, not null, when Meta definitely refused the GET, so that a refusal stays
// distinct from a 2xx body that happens to be null.
const REFUSED = Symbol("refused");
export interface FollowSendContext {
  replyId: string;
  attemptId: string;
  confirmationButtonTitle?: string;
}
export interface FollowTransport {
  followStatus(recipientId: string): Promise<boolean | null>;
  send(recipientId: string, text: string, context?: FollowSendContext): Promise<{ messageId: string }>;
}
export class InstagramFollowTransport implements FollowTransport {
  private readonly config: {
    accountId: string;
    accessToken: string;
    graphVersion: string;
    fetchImpl?: typeof fetch;
    beforeSend?: (context: FollowSendContext) => Promise<void>;
    // Told when the identity read accepts or rejects the token; it cannot change a verification result.
    onIdentity?: IdentityObserver;
  };
  constructor(config: InstagramFollowTransport["config"]) {
    if (!/^\d+$/.test(config.accountId) || !/^v\d+\.\d+$/.test(config.graphVersion) || !config.accessToken)
      throw new Error("Invalid Meta configuration");
    this.config = config;
  }
  private async request(path: string, body?: unknown, identity = false): Promise<unknown> {
    const method = body === undefined ? "GET" : "POST";
    const response = await (this.config.fetchImpl ?? fetch)(
      `https://graph.instagram.com/${this.config.graphVersion}/${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${this.config.accessToken}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) {
      if (identity && (await metaTokenRejected(response))) await reportIdentity(this.config.onIdentity, "rejected");
      const error = await classifyMetaGraphFailure(response, method, new Date());
      if (error) throw error;
      if (method === "GET") return identity ? REFUSED : null;
      throw new Error("Meta send outcome unknown");
    }
    return response.json();
  }
  // false only for a definite answer: Meta refused the GET (a non-transient 4xx) or named another numeric account.
  // A 2xx body without a numeric user_id is a read failure and throws, so the caller defers the row.
  async verifyAccount(): Promise<boolean> {
    const me = await this.request("me?fields=user_id", undefined, true);
    if (me === REFUSED) return false;
    const profile = isRecord(me) && Array.isArray(me.data) ? me.data[0] : me;
    const userId = isRecord(profile) ? profile.user_id : undefined;
    if (typeof userId !== "string" || !/^\d+$/.test(userId))
      throw new Error("Meta Graph account read returned no user_id");
    if (userId !== this.config.accountId) return false;
    await reportIdentity(this.config.onIdentity, "verified");
    return true;
  }
  async followStatus(recipientId: string): Promise<boolean | null> {
    if (!/^\d+$/.test(recipientId) || recipientId === this.config.accountId) return null;
    if (!(await this.verifyAccount())) return null;
    const result = await this.request(`${recipientId}?fields=is_user_follow_business`);
    return isRecord(result) && typeof result.is_user_follow_business === "boolean"
      ? result.is_user_follow_business
      : null;
  }
  async send(recipientId: string, text: string, context?: FollowSendContext): Promise<{ messageId: string }> {
    if (!/^\d+$/.test(recipientId) || recipientId === this.config.accountId || !text.trim() || text.length > 1000)
      throw new PreSendVerificationError("block", "invalid_request");
    const message = confirmationMessage(text, context?.confirmationButtonTitle, context?.replyId);
    if (this.config.beforeSend) {
      if (!context) throw new PreSendVerificationError("block", "missing_send_context");
      try {
        await this.config.beforeSend(context);
      } catch (error) {
        if (error instanceof PreSendVerificationError) throw error;
        throw new PreSendVerificationError("retry", "verification_unavailable");
      }
    }
    const result = await this.request(`${this.config.accountId}/messages`, {
      recipient: { id: recipientId },
      message,
    });
    if (!isRecord(result) || typeof result.message_id !== "string" || !result.message_id.trim())
      throw new Error("Meta send outcome unknown");
    return { messageId: result.message_id };
  }
}
