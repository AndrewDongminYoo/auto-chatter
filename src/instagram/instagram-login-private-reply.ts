import {
  PreSendVerificationError,
  ProviderRejectedError,
  type PrivateReplyRequest,
  type PrivateReplyTransport,
} from "./reply-worker.ts";
import { evaluatePrivateReply } from "./reply-policy.ts";
import { readMetaGraphError } from "./meta-graph-error.ts";

export interface InstagramLoginPrivateReplyConfig {
  graphVersion: string;
  accessToken: string;
  accountId: string;
  connectionId?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

type AccountInspection = { verified: true } | { verified: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validConnectionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class InstagramLoginPrivateReplyTransport implements PrivateReplyTransport {
  private readonly config: InstagramLoginPrivateReplyConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(config: InstagramLoginPrivateReplyConfig) {
    if (!/^v\d+\.\d+$/.test(config.graphVersion)) throw new Error("Invalid Meta Graph version");
    if (!/^\d+$/.test(config.accountId)) throw new Error("Invalid Instagram account ID");
    if (config.connectionId !== undefined && !validConnectionId(config.connectionId))
      throw new Error("Invalid Instagram connection ID");
    if (!config.accessToken) throw new Error("Instagram access token is required");
    const timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid Meta request timeout");
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
    this.now = config.now ?? (() => new Date());
  }

  private graphUrl(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(`https://graph.instagram.com/${this.config.graphVersion}/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private async graphRequest(url: URL, method = "GET", body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new Error("Meta Graph request failed");
    }
    if (response.status === 429 || response.status >= 500) throw new Error(`Meta Graph HTTP ${response.status}`);
    if (!response.ok) {
      const error = await readMetaGraphError(response);
      if (error?.transient)
        throw new Error(`Meta Graph transient error${error.code === null ? "" : ` code ${error.code}`}`);
      if (method === "POST" && error?.code !== null && error?.code !== undefined)
        throw new ProviderRejectedError(error.code);
      return null;
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error("Meta Graph response was invalid");
    }
  }

  async inspectAccount(): Promise<AccountInspection> {
    const result = await this.graphRequest(this.graphUrl("me", { fields: "user_id,username" }));
    const profile = isRecord(result) && Array.isArray(result.data) ? result.data[0] : result;
    if (!isRecord(profile) || typeof profile.user_id !== "string") {
      return { verified: false, reason: "account_unverified" };
    }
    if (profile.user_id !== this.config.accountId) return { verified: false, reason: "account_mismatch" };
    return { verified: true };
  }

  private matchesConnection(request: PrivateReplyRequest): boolean {
    return request.connectionId === this.config.connectionId && request.accountId === this.config.accountId;
  }

  async verify(request: PrivateReplyRequest): ReturnType<PrivateReplyTransport["verify"]> {
    const denied = { commentCreatedAt: null, authorizationVerified: false, mediaOwned: false };
    if (!this.matchesConnection(request)) return denied;
    const account = await this.inspectAccount();
    if (!account.verified) return denied;

    const comment = await this.graphRequest(
      this.graphUrl(encodeURIComponent(request.commentId), { fields: "id,from,media,timestamp" }),
    );
    if (!isRecord(comment) || comment.id !== request.commentId) return denied;
    const createdAt = typeof comment.timestamp === "string" ? new Date(comment.timestamp) : null;
    const commentMatches =
      isRecord(comment.from) &&
      comment.from.id === request.senderId &&
      isRecord(comment.media) &&
      comment.media.id === request.mediaId;
    if (!commentMatches) return { commentCreatedAt: createdAt, authorizationVerified: true, mediaOwned: false };

    const media = await this.graphRequest(this.graphUrl(encodeURIComponent(request.mediaId), { fields: "id,owner" }));
    const mediaOwned =
      isRecord(media) && media.id === request.mediaId && isRecord(media.owner) && media.owner.id === request.accountId;
    return { commentCreatedAt: createdAt, authorizationVerified: true, mediaOwned };
  }

  async send(request: PrivateReplyRequest): ReturnType<PrivateReplyTransport["send"]> {
    if (!this.matchesConnection(request) || !request.text.trim())
      throw new PreSendVerificationError("block", "invalid_request");
    let verification;
    try {
      verification = await this.verify(request);
    } catch {
      throw new PreSendVerificationError();
    }
    const policy = evaluatePrivateReply({
      now: this.now(),
      commentCreatedAt: verification.commentCreatedAt,
      connectionActive: true,
      authorizationVerified: verification.authorizationVerified,
      mediaOwned: verification.mediaOwned,
      isOwnComment: request.senderId === request.accountId,
    });
    if (!policy.eligible) throw new PreSendVerificationError("block", policy.reason);

    const result = await this.graphRequest(this.graphUrl(`${this.config.accountId}/messages`), "POST", {
      recipient: { comment_id: request.commentId },
      message: { text: request.text },
    });
    if (!isRecord(result) || typeof result.message_id !== "string" || !result.message_id.trim()) {
      throw new Error("Meta private reply outcome is unknown");
    }
    return { messageId: result.message_id };
  }
}
