import type { Pool } from "pg";
import { ApiError, json, readJson } from "./auth.ts";
import { spendApiAllowance, type AuthRateLimitEnv, type RateLimitBinding } from "./auth-rate-limit.ts";
import { clientIp, findActiveApiKey, recordApiKeyUse } from "./api-keys.ts";
import { failureCode, logOperation } from "./operations-log.ts";
import { isPlanKey, PLANS } from "./plans.ts";
import { CONTACT_WRITE_REQUEST_BYTES, checkContactWriteFields, listWorkspaceFields, parseContactWrite, parseContactWriteBody, parseContactWriteTarget, writeContact } from "./public-contact-writes.ts";
import { contactJson, contactsPageJson, parseContactsQuery, readContactsPage } from "./public-contacts.ts";

// The external API under /v1/ (#48), for servers that hold a workspace API key. It is separate from /api/*: no
// session, no same-origin check and no CORS headers. The key is accepted only as `Authorization: Bearer <key>`.
// Every refusal of the key is the same 401, so a caller cannot tell a malformed, unknown, revoked or expired key apart.

// Every path and method the external API serves, with OpenAPI path templates. docs/api/openapi-v1.json describes the
// same list, and a unit test compares the two. A template parameter matches one path segment.
export const PUBLIC_API_ROUTES = {
  "/v1/contacts": ["GET"],
  "/v1/contacts/{connection_id}/{sender_id}": ["PATCH"],
  "/v1/fields": ["GET"],
  "/v1/key": ["GET"],
} as const satisfies Record<string, readonly string[]>;
type PublicApiPath = keyof typeof PUBLIC_API_ROUTES;
const ROUTE_PATTERNS = (Object.keys(PUBLIC_API_ROUTES) as PublicApiPath[]).map((path) => ({ path, pattern: new RegExp(`^${path.replace(/\{[a-z_]+\}/g, "([^/]+)")}$`) }));

// The route of a request path and the raw (still percent-encoded) values of its template parameters.
export function matchPublicApiRoute(pathname: string): { path: PublicApiPath; params: string[] } | undefined {
  for (const { path, pattern } of ROUTE_PATTERNS) {
    const match = pattern.exec(pathname);
    if (match) return { path, params: match.slice(1) };
  }
  return undefined;
}

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

// The body of a contact write. A body that is not JSON is 400 invalid_request like any other malformed body; a
// missing JSON content type stays 415 json_required and a body over 16 KiB 413 request_too_large. A number that
// JavaScript cannot hold exactly is read as a value parseContactWrite refuses, and a key named twice in one object is
// 400 invalid_request (parseContactWriteBody).
async function readWriteBody(request: Request): Promise<unknown> {
  try {
    return await readJson(request, CONTACT_WRITE_REQUEST_BYTES, parseContactWriteBody);
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) throw new ApiError(400, "invalid_request");
    throw error;
  }
}

// A contact write spends the workspace write limit the dashboard writes spend: the same key (the workspace ID) and
// the plan's hourly count, so both share one window. Like the dashboard's, it fails open: a missing or failing limiter
// lets the write through and logs one fixed code.
async function spendWorkspaceWrite(binding: RateLimitBinding | undefined, pool: Pick<Pool, "query">, workspaceId: string, correlationId: string): Promise<void> {
  let spent: "ok" | "unavailable" = "unavailable";
  if (binding) {
    const plan = (await pool.query<{ plan: unknown }>("SELECT plan FROM workspaces WHERE id=$1", [workspaceId])).rows[0]?.plan;
    spent = await spendApiAllowance(binding, workspaceId, isPlanKey(plan) ? PLANS[plan].api_writes_per_hour : undefined);
  }
  if (spent === "unavailable") logOperation({ event: "rate_limit_unavailable", code: "api_limit_unavailable", correlation_id: correlationId }, "warn");
}

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function publicApi(request: Request, env: Pick<AuthRateLimitEnv, "API_IP_LIMIT" | "API_KEY_LIMIT" | "API_WRITE_WORKSPACE_LIMIT">, openPool: (correlationId: string) => Pick<Pool, "query" | "connect" | "end">, correlationId: string): Promise<Response> {
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
      const route = matchPublicApiRoute(url.pathname);
      if (!route) return json({ error: "not_found" }, 404);
      const methods: readonly string[] = PUBLIC_API_ROUTES[route.path];
      if (!methods.includes(request.method)) {
        const response = json({ error: "method_not_allowed" }, 405);
        response.headers.set("Allow", methods.join(", "));
        return response;
      }
      // Only a successful authenticated request is recorded as the key's last use.
      if (route.path === "/v1/key") {
        await recordApiKeyUse(pool, key.id, ip);
        return json({ id: key.id, name: key.name, scopes: key.scopes, workspace_id: key.workspace_id, expires_at: key.expires_at });
      }
      if (!key.scopes.includes("contacts:read")) return json({ error: "insufficient_scope" }, 403);
      if (route.path === "/v1/fields") {
        if (url.searchParams.size) return json({ error: "invalid_request" }, 400);
        const fields = await listWorkspaceFields(pool, key.workspace_id);
        await recordApiKeyUse(pool, key.id, ip);
        return json({ fields });
      }
      if (route.path === "/v1/contacts/{connection_id}/{sender_id}") {
        // Every refusal before the workspace limit (403, 400, 413, 415 and the unlocked field check's 404) spends
        // nothing of it, so a read-only key or a malformed request cannot use up the dashboard's write allowance.
        if (!key.scopes.includes("contacts:write")) return json({ error: "insufficient_scope" }, 403);
        if (url.searchParams.size) return json({ error: "invalid_request" }, 400);
        const target = parseContactWriteTarget(route.params[0]!, route.params[1]!);
        const write = parseContactWrite(await readWriteBody(request));
        await checkContactWriteFields(pool, key.workspace_id, write.fields);
        await spendWorkspaceWrite(env.API_WRITE_WORKSPACE_LIMIT, pool, key.workspace_id, correlationId);
        const contact = await writeContact(pool, key.workspace_id, target, write);
        // The write is committed, so a failure to record the key's last use must not turn it into an error response
        // that a client would retry over a later agent edit. It logs one fixed code instead.
        try {
          await recordApiKeyUse(pool, key.id, ip);
        } catch (error) {
          logOperation({ event: "api_key_use_unrecorded", code: failureCode(error), correlation_id: correlationId }, "warn");
        }
        return new Response(contactJson(contact), { headers: JSON_HEADERS });
      }
      const page = await readContactsPage(pool, key.workspace_id, parseContactsQuery(url.searchParams));
      if (!page.found) return json({ error: "connection_not_found" }, 404);
      await recordApiKeyUse(pool, key.id, ip);
      return new Response(contactsPageJson(page), { headers: JSON_HEADERS });
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
