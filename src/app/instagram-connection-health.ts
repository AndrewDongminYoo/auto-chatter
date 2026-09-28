import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { openSecret } from "./secrets.ts";
import { workspaceFor } from "./settings.ts";

type HealthStatus = "missing" | "expired" | "reconnect_required" | "fields_missing" | "fields_present" | "unverified";
type ProviderResult = { status: "ok"; value: unknown } | { status: "reconnect_required" | "unverified" };

async function providerGet(fetchImpl: typeof fetch, url: string, token: string): Promise<ProviderResult> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      let code: unknown;
      if (response.status === 400 || response.status === 403) {
        try {
          const body: unknown = await response.json();
          code = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
        } catch {
          code = undefined;
        }
      } else {
        await response.body?.cancel();
      }
      return { status: response.status === 401 || code === 190 ? "reconnect_required" : "unverified" };
    }
    return { status: "ok", value: await response.json() };
  } catch {
    return { status: "unverified" };
  }
}

export async function connectionHealth(
  pool: Pool,
  user: User,
  connectionId: string,
  env: { TOKEN_ENCRYPTION_KEY?: string; META_GRAPH_VERSION?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: HealthStatus; checked_at: string }> {
  if (!isUuid(connectionId)) throw new ApiError(400, "invalid_connection");
  const workspaceId = await workspaceFor(pool, user);
  const result = await pool.query<{
    account_id: string;
    access_token_encrypted: string | null;
    token_expires_at: Date | string | null;
  }>(
    `SELECT account_id,access_token_encrypted,token_expires_at FROM instagram_connections
     WHERE id=$1 AND workspace_id=$2`,
    [connectionId, workspaceId],
  );
  const connection = result.rows[0];
  if (!connection) throw new ApiError(404, "connection_not_found");
  const checked_at = new Date().toISOString();
  if (!connection.access_token_encrypted) return { status: "missing", checked_at };
  const expiresAt = new Date(connection.token_expires_at ?? "").getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return { status: "expired", checked_at };
  if (!env.TOKEN_ENCRYPTION_KEY || !env.META_GRAPH_VERSION || !/^v\d+\.\d+$/.test(env.META_GRAPH_VERSION))
    throw new ApiError(503, "instagram_not_configured");
  let token: string;
  try {
    token = openSecret(
      connection.access_token_encrypted,
      env.TOKEN_ENCRYPTION_KEY,
      `${workspaceId}:${connection.account_id}`,
    );
  } catch {
    return { status: "unverified", checked_at };
  }
  const base = `https://graph.instagram.com/${env.META_GRAPH_VERSION}`;
  const identity = await providerGet(fetchImpl, `${base}/me?fields=user_id`, token);
  if (identity.status !== "ok") return { status: identity.status, checked_at };
  const account =
    isRecord(identity.value) && Array.isArray(identity.value.data) ? identity.value.data[0] : identity.value;
  if (!isRecord(account) || typeof account.user_id !== "string") return { status: "unverified", checked_at };
  if (account.user_id !== connection.account_id) return { status: "reconnect_required", checked_at };
  const subscription = await providerGet(
    fetchImpl,
    `${base}/${encodeURIComponent(connection.account_id)}/subscribed_apps`,
    token,
  );
  if (subscription.status !== "ok") return { status: subscription.status, checked_at };
  if (!isRecord(subscription.value) || !Array.isArray(subscription.value.data))
    return { status: "unverified", checked_at };
  const entries: unknown[] = subscription.value.data;
  if (entries.some((entry) => !isRecord(entry) || !Array.isArray(entry.subscribed_fields)))
    return { status: "unverified", checked_at };
  const required = ["comments", "messages", "messaging_postbacks"];
  if (
    entries.some((entry) => {
      if (!isRecord(entry)) return false;
      const fields = entry.subscribed_fields;
      return Array.isArray(fields) && required.every((field) => fields.includes(field));
    })
  )
    return { status: "fields_present", checked_at };
  if (isRecord(subscription.value.paging) && subscription.value.paging.next)
    return { status: "unverified", checked_at };
  return {
    status: "fields_missing",
    checked_at,
  };
}
