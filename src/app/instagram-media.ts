import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";
import { openSecret } from "./secrets.ts";
import type { InstagramOAuthEnv } from "./instagram-oauth.ts";

const fields = "id,owner,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp";
const validCursor = (value: string) => /^[A-Za-z0-9_+/=-]{1,2048}$/.test(value);
function publicUrl(value: unknown, image: boolean): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const host = url.hostname;
    const allowed = image
      ? host.endsWith(".cdninstagram.com") || host.endsWith(".fbcdn.net")
      : ["www.instagram.com", "instagram.com"].includes(host) && /^\/(p|reel)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
    if (
      !allowed ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      [...url.searchParams.keys()].some((key) =>
        /^(access_token|client_secret|authorization|token|password)$/i.test(key),
      )
    )
      return null;
    url.hash = "";
    return image ? url.href : url.origin + url.pathname;
  } catch {
    return null;
  }
}
function displayMedia(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^\d{1,40}$/.test(value.id) ||
    !["IMAGE", "VIDEO", "CAROUSEL_ALBUM"].includes(String(value.media_type))
  )
    throw new ApiError(502, "media_unavailable");
  if (value.media_product_type !== undefined && !["FEED", "REELS"].includes(String(value.media_product_type)))
    throw new ApiError(400, "media_unsupported");
  return {
    id: value.id,
    caption: typeof value.caption === "string" ? value.caption.slice(0, 2200) : "",
    media_type: value.media_type,
    image_url: publicUrl(value.media_type === "VIDEO" ? value.thumbnail_url : value.media_url, true),
    permalink: publicUrl(value.permalink, false),
    timestamp:
      typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp)) ? value.timestamp : null,
  };
}

export async function connectionMedia(
  pool: Pool,
  user: User,
  connectionId: string,
  env: InstagramOAuthEnv,
  options: { after?: string; mediaId?: string } = {},
  fetchImpl: typeof fetch = fetch,
) {
  if (
    !isUuid(connectionId) ||
    (options.after !== undefined && !validCursor(options.after)) ||
    (options.mediaId !== undefined && !/^\d{1,40}$/.test(options.mediaId))
  )
    throw new ApiError(400, "invalid_media_request");
  const workspaceId = await workspaceFor(pool, user, "agent");
  const result = await pool.query<{
    account_id: string;
    access_token_encrypted: string | null;
    token_expires_at: Date | null;
  }>(
    "SELECT account_id,access_token_encrypted,token_expires_at FROM instagram_connections WHERE id=$1 AND workspace_id=$2",
    [connectionId, workspaceId],
  );
  const connection = result.rows[0];
  if (!connection) throw new ApiError(404, "connection_not_found");
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : NaN;
  if (!connection.access_token_encrypted || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
    throw new ApiError(409, "media_reconnect_required");
  if (
    !env.TOKEN_ENCRYPTION_KEY ||
    !env.META_GRAPH_VERSION ||
    !/^v\d+\.\d+$/.test(env.META_GRAPH_VERSION) ||
    !/^\d{1,40}$/.test(connection.account_id)
  )
    throw new ApiError(503, "instagram_not_configured");
  let token: string;
  try {
    token = openSecret(
      connection.access_token_encrypted,
      env.TOKEN_ENCRYPTION_KEY,
      `${workspaceId}:${connection.account_id}`,
    );
  } catch {
    throw new ApiError(409, "media_reconnect_required");
  }
  async function graph(resource: string, params: Record<string, string>) {
    const url = new URL(`https://graph.instagram.com/${env.META_GRAPH_VERSION}/${resource}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
    } catch {
      throw new ApiError(502, "media_unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(502, "media_unavailable");
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ApiError(502, "media_unavailable");
    }
  }
  const identity = await graph("me", { fields: "id,user_id" });
  const profile = isRecord(identity) && Array.isArray(identity.data) ? identity.data[0] : identity;
  if (!isRecord(profile) || profile.user_id !== connection.account_id)
    throw new ApiError(409, "media_reconnect_required");
  const owned = (value: unknown) =>
    isRecord(value) &&
    isRecord(value.owner) &&
    (value.owner.id === connection.account_id ||
      (typeof profile.id === "string" && /^\d+$/.test(profile.id) && value.owner.id === profile.id));
  if (options.mediaId) {
    const media = await graph(options.mediaId, { fields });
    if (!owned(media)) throw new ApiError(400, "media_not_owned");
    const item = displayMedia(media);
    if (item.id !== options.mediaId) throw new ApiError(502, "media_unavailable");
    return { media: [item], after: null };
  }
  const page = await graph(`${connection.account_id}/media`, {
    fields,
    limit: "12",
    ...(options.after ? { after: options.after } : {}),
  });
  if (!isRecord(page) || !Array.isArray(page.data) || page.data.length > 12)
    throw new ApiError(502, "media_unavailable");
  const media = page.data
    .filter((value) => {
      if (!owned(value)) throw new ApiError(502, "media_unavailable");
      return (
        isRecord(value) &&
        (value.media_product_type === undefined || ["FEED", "REELS"].includes(String(value.media_product_type)))
      );
    })
    .map(displayMedia);
  const paging = isRecord(page.paging) ? page.paging : null;
  const cursor = paging && isRecord(paging.cursors) ? paging.cursors.after : null;
  return {
    media,
    after:
      paging?.next && typeof cursor === "string" && validCursor(cursor) && cursor !== options.after ? cursor : null,
  };
}
