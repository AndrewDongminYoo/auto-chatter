import type { Pool } from "pg";
import { ApiError, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";
import {
  checkInstagramSubscription,
  recordSubscriptionAttempt,
  recordSubscriptionCheck,
  validGraphVersion,
  type SubscriptionCheckStatus,
} from "./instagram-subscription-check.ts";

type HealthStatus = "missing" | "expired" | "reconnect_required" | "fields_missing" | "fields_present" | "unverified";

// The manual response keeps its statuses: a Meta rejection and an account mismatch are both reconnect_required,
// and a token that does not decrypt is unverified. Only the shared record tells them apart.
const HEALTH_STATUS: Record<SubscriptionCheckStatus, HealthStatus> = {
  fields_present: "fields_present",
  fields_missing: "fields_missing",
  token_rejected: "reconnect_required",
  account_mismatch: "reconnect_required",
  unverified: "unverified",
  undecryptable: "unverified",
};

// The manual status check. It writes the same record as the cron step subscription_check; a failed record write
// is logged with a fixed code and never changes the response.
export async function connectionHealth(
  pool: Pool,
  user: User,
  connectionId: string,
  env: { TOKEN_ENCRYPTION_KEY?: string; META_GRAPH_VERSION?: string },
  fetchImpl: typeof fetch = fetch,
  correlationId?: string,
): Promise<{ status: HealthStatus; checked_at: string }> {
  if (!isUuid(connectionId)) throw new ApiError(400, "invalid_connection");
  const workspaceId = await workspaceFor(pool, user, "agent");
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
  if (!env.TOKEN_ENCRYPTION_KEY || !validGraphVersion(env.META_GRAPH_VERSION))
    throw new ApiError(503, "instagram_not_configured");
  const encryptedToken = connection.access_token_encrypted;
  await recordSubscriptionAttempt(pool, connectionId, encryptedToken, correlationId);
  const check = await checkInstagramSubscription(
    { workspaceId, accountId: connection.account_id, encryptedToken },
    env.TOKEN_ENCRYPTION_KEY,
    env.META_GRAPH_VERSION,
    fetchImpl,
  );
  await recordSubscriptionCheck(pool, connectionId, encryptedToken, check, correlationId);
  return { status: HEALTH_STATUS[check.status], checked_at };
}
