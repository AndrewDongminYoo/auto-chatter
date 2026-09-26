import { confirmationMessage } from "./confirmation-button.ts";
import { isRecord } from "../app/auth.ts";
import { classifyMetaGraphFailure } from "./meta-graph-error.ts";
import { PreSendVerificationError } from "./reply-worker.ts";
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
  };
  constructor(config: InstagramFollowTransport["config"]) {
    if (!/^\d+$/.test(config.accountId) || !/^v\d+\.\d+$/.test(config.graphVersion) || !config.accessToken)
      throw new Error("Invalid Meta configuration");
    this.config = config;
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
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
      const error = await classifyMetaGraphFailure(response, method, new Date());
      if (error) throw error;
      if (method === "GET") return null;
      throw new Error("Meta send outcome unknown");
    }
    return response.json();
  }
  async followStatus(recipientId: string): Promise<boolean | null> {
    if (!/^\d+$/.test(recipientId) || recipientId === this.config.accountId) return null;
    const me = await this.request("me?fields=user_id");
    const profile = isRecord(me) && Array.isArray(me.data) ? me.data[0] : me;
    if (!isRecord(profile) || profile.user_id !== this.config.accountId) return null;
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
      await this.config.beforeSend(context);
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
