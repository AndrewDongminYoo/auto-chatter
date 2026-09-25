import type { PrivateReplyRequest, PrivateReplyTransport } from "./reply-worker.ts";
import { evaluatePrivateReply } from "./reply-policy.ts";

const requiredPermissions = [
  "pages_show_list",
  "instagram_basic",
  "instagram_manage_comments",
  "pages_read_engagement",
  "pages_messaging",
] as const;
const supportedSurfaces = new Set(["AD", "FEED", "REELS"]);

export interface FacebookPrivateReplyConfig {
  graphVersion: string;
  appId: string;
  appAccessToken: string;
  userAccessToken: string;
  pageId: string;
  accountId: string;
  connectionId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export type PermissionInspection =
  | { verified: true }
  | { verified: false; reason: string; missingPermissions?: string[] };

type PageAccess =
  | { verified: true; accessToken: string }
  | { verified: false; reason: string; missingPermissions?: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function validConnectionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class FacebookPrivateReplyTransport implements PrivateReplyTransport {
  private readonly config: FacebookPrivateReplyConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(config: FacebookPrivateReplyConfig) {
    if (!/^v\d+\.\d+$/.test(config.graphVersion)) throw new Error("Invalid Meta Graph version");
    if (![config.appId, config.pageId, config.accountId].every((id) => /^\d+$/.test(id))) throw new Error("Invalid Meta account ID");
    if (!validConnectionId(config.connectionId)) throw new Error("Invalid Instagram connection ID");
    if (!config.appAccessToken || !config.userAccessToken) throw new Error("Meta access tokens are required");
    const timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid Meta request timeout");
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = timeoutMs;
    this.now = config.now ?? (() => new Date());
  }

  private graphUrl(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(`https://graph.facebook.com/${this.config.graphVersion}/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private async graphRequest(url: URL, token: string, method = "GET", body?: unknown): Promise<{ status: number; data: unknown }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
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
    if (!response.ok) return { status: response.status, data: null };
    try {
      return { status: response.status, data: await response.json() as unknown };
    } catch {
      throw new Error("Meta Graph response was invalid");
    }
  }

  private async pageAccess(): Promise<PageAccess> {
    const debug = await this.graphRequest(
      this.graphUrl("debug_token", { input_token: this.config.userAccessToken }),
      this.config.appAccessToken,
    );
    const details = isRecord(debug.data) ? debug.data.data : null;
    if (!isRecord(details) || details.is_valid !== true || details.app_id !== this.config.appId) {
      return { verified: false, reason: "user_token_unverified" };
    }
    if (typeof details.expires_at === "number" && details.expires_at > 0 && details.expires_at * 1000 <= Date.now()) {
      return { verified: false, reason: "user_token_expired" };
    }
    if (typeof details.data_access_expires_at === "number" && details.data_access_expires_at > 0
      && details.data_access_expires_at * 1000 <= Date.now()) {
      return { verified: false, reason: "data_access_expired" };
    }
    const scopes = Array.isArray(details.scopes) ? details.scopes : [];
    const missingPermissions = requiredPermissions.filter((permission) => !scopes.includes(permission));
    if (missingPermissions.length > 0) return { verified: false, reason: "missing_permissions", missingPermissions };

    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const pages = await this.graphRequest(
        this.graphUrl("me/accounts", {
          fields: "id,access_token,tasks,instagram_business_account",
          limit: "100",
          ...(cursor === undefined ? {} : { after: cursor }),
        }),
        this.config.userAccessToken,
      );
      if (!isRecord(pages.data) || !Array.isArray(pages.data.data)) {
        return { verified: false, reason: "page_access_unverified" };
      }
      for (const item of pages.data.data) {
        if (!isRecord(item) || item.id !== this.config.pageId) continue;
        if (!isRecord(item.instagram_business_account) || item.instagram_business_account.id !== this.config.accountId) {
          return { verified: false, reason: "page_not_linked_to_account" };
        }
        if (!Array.isArray(item.tasks) || !item.tasks.includes("MESSAGING")) {
          return { verified: false, reason: "messaging_task_missing" };
        }
        if (typeof item.access_token !== "string" || !item.access_token) {
          return { verified: false, reason: "page_token_unavailable" };
        }
        return { verified: true, accessToken: item.access_token };
      }
      const paging = isRecord(pages.data.paging) ? pages.data.paging : null;
      if (!paging || typeof paging.next !== "string") return { verified: false, reason: "page_not_found" };
      const cursors = isRecord(paging.cursors) ? paging.cursors : null;
      if (!cursors || typeof cursors.after !== "string" || seenCursors.has(cursors.after)) {
        return { verified: false, reason: "page_list_incomplete" };
      }
      cursor = cursors.after;
      seenCursors.add(cursor);
    }
    return { verified: false, reason: "page_list_incomplete" };
  }

  async inspectPermissions(): Promise<PermissionInspection> {
    const page = await this.pageAccess();
    if (!page.verified) return page;
    return { verified: true };
  }

  private matchesConnection(request: PrivateReplyRequest): boolean {
    return request.connectionId === this.config.connectionId && request.accountId === this.config.accountId;
  }

  async verify(request: PrivateReplyRequest): ReturnType<PrivateReplyTransport["verify"]> {
    const denied = { commentCreatedAt: null, authorizationVerified: false, mediaOwned: false };
    if (!this.matchesConnection(request)) return denied;
    const page = await this.pageAccess();
    if (!page.verified) return denied;

    const comment = await this.graphRequest(
      this.graphUrl(encodeURIComponent(request.commentId), { fields: "id,from,media,timestamp" }),
      this.config.userAccessToken,
    );
    if (!isRecord(comment.data) || comment.data.id !== request.commentId) return denied;
    const createdAt = typeof comment.data.timestamp === "string" ? new Date(comment.data.timestamp) : null;
    const commentMatches = isRecord(comment.data.from) && comment.data.from.id === request.senderId
      && isRecord(comment.data.media) && comment.data.media.id === request.mediaId;
    if (!commentMatches) return { commentCreatedAt: createdAt, authorizationVerified: true, mediaOwned: false };

    const media = await this.graphRequest(
      this.graphUrl(encodeURIComponent(request.mediaId), { fields: "id,owner,media_product_type" }),
      this.config.userAccessToken,
    );
    const mediaOwned = isRecord(media.data) && media.data.id === request.mediaId
      && isRecord(media.data.owner) && recordId(media.data.owner.id) === request.accountId
      && supportedSurfaces.has(media.data.media_product_type as string);
    return { commentCreatedAt: createdAt, authorizationVerified: true, mediaOwned };
  }

  async send(request: PrivateReplyRequest): ReturnType<PrivateReplyTransport["send"]> {
    if (!this.matchesConnection(request) || !request.text.trim()) throw new Error("Private reply connection or text is invalid");
    const verification = await this.verify(request);
    const policy = evaluatePrivateReply({
      now: this.now(),
      commentCreatedAt: verification.commentCreatedAt,
      connectionActive: true,
      authorizationVerified: verification.authorizationVerified,
      mediaOwned: verification.mediaOwned,
      isOwnComment: request.senderId === request.accountId,
    });
    if (!policy.eligible) throw new Error(`Private reply blocked: ${policy.reason}`);
    const page = await this.pageAccess();
    if (!page.verified) throw new Error(`Meta permissions unavailable: ${page.reason}`);
    const result = await this.graphRequest(
      this.graphUrl(`${this.config.pageId}/messages`),
      page.accessToken,
      "POST",
      { recipient: { comment_id: request.commentId }, message: { text: request.text } },
    );
    if (!isRecord(result.data) || typeof result.data.message_id !== "string" || !result.data.message_id.trim()) {
      throw new Error("Meta private reply outcome is unknown");
    }
    return { messageId: result.data.message_id };
  }
}
