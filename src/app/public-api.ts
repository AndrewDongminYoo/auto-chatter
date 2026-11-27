import type { Pool } from "pg";
import { ApiError, json } from "./auth.ts";
import type { AuthRateLimitEnv, RateLimitBinding } from "./auth-rate-limit.ts";
import { clientIp, findActiveApiKey, recordApiKeyUse } from "./api-keys.ts";
import { failureCode, logOperation } from "./operations-log.ts";

// The external API under /v1/ (#48), for servers that hold a workspace API key. It is separate from /api/*: no
// session, no same-origin check and no CORS headers. The key is accepted only as `Authorization: Bearer <key>`.
// Every refusal of the key is the same 401, so a caller cannot tell a malformed, unknown, revoked or expired key apart.

// The scheme name is case-insensitive (RFC 9110 section 11.1); the key itself is not.
const BEARER = /^Bearer (\S+)$/i;

function invalidKey(): Response {
  const response = json({ error: "invalid_api_key" }, 401);
  response.headers.set("WWW-Authenticate", 'Bearer realm="auto-chatter"');
  return response;
}

// Both limits fail closed: a missing binding or a limiter that does not answer refuses the request with 503.
async function spend(binding: RateLimitBinding | undefined, key: string): Promise<void> {
  if (!binding) throw new ApiError(503, "api_key_limit_unavailable");
  let allowance: { success: boolean };
  try {
    allowance = await binding.limit({ key });
  } catch {
    throw new ApiError(503, "api_key_limit_unavailable");
  }
  if (!allowance.success) throw new ApiError(429, "rate_limited");
}

export async function publicApi(request: Request, env: Pick<AuthRateLimitEnv, "API_IP_LIMIT" | "API_KEY_LIMIT">, openPool: (correlationId: string) => Pick<Pool, "query" | "end">, correlationId: string): Promise<Response> {
  try {
    const url = new URL(request.url);
    const ip = clientIp(request.headers.get("CF-Connecting-IP"));
    // Counted before the key is read, refused requests included, so failing keys cannot query the database freely.
    await spend(env.API_IP_LIMIT, ip ?? "unattributed");
    const presented = BEARER.exec(request.headers.get("Authorization") ?? "")?.[1];
    if (!presented) return invalidKey();
    const pool = openPool(correlationId);
    try {
      const key = await findActiveApiKey(pool, presented);
      if (!key) return invalidKey();
      await spend(env.API_KEY_LIMIT, key.id);
      if (url.pathname === "/v1/key") {
        if (request.method !== "GET") {
          const response = json({ error: "method_not_allowed" }, 405);
          response.headers.set("Allow", "GET");
          return response;
        }
        // Only a successful authenticated request is recorded as the key's last use.
        await recordApiKeyUse(pool, key.id, ip);
        return json({ id: key.id, name: key.name, scopes: key.scopes, workspace_id: key.workspace_id, expires_at: key.expires_at });
      }
      return json({ error: "not_found" }, 404);
    } finally {
      await pool.end();
    }
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    // Only a fixed code is logged: never the Authorization header or a key.
    logOperation({ event: "request_failed", code: failureCode(error), correlation_id: correlationId });
    return json({ error: "service_unavailable" }, 503);
  }
}
