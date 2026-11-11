import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { ApiError, cookie, isRecord, json, type User } from "./auth.ts";
import { lockWorkspaceForMember, workspaceFor } from "./settings.ts";
import { normalizedUserId } from "./instagram-deauthorization.ts";
import { sealSecret } from "./secrets.ts";
import { requireConnectionSlot } from "./plans.ts";
import { logOperation } from "./operations-log.ts";

export interface InstagramOAuthEnv {
  APP_ORIGIN?: string;
  INSTAGRAM_OAUTH_APP_ID?: string;
  INSTAGRAM_OAUTH_APP_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  META_GRAPH_VERSION?: string;
  INSTAGRAM_PUBLIC_CONNECT_ENABLED?: string;
  INSTAGRAM_INTERNAL_EMAILS?: string;
}

const permissions = ["instagram_business_basic", "instagram_business_manage_comments", "instagram_business_manage_messages"];
const stateHash = (state: string) => createHash("sha256").update(state).digest("hex");

function config(env: InstagramOAuthEnv) {
  if (!env.APP_ORIGIN || !env.INSTAGRAM_OAUTH_APP_ID || !/^\d+$/.test(env.INSTAGRAM_OAUTH_APP_ID) || !env.INSTAGRAM_OAUTH_APP_SECRET || !env.TOKEN_ENCRYPTION_KEY || !env.META_GRAPH_VERSION || !/^v\d+\.\d+$/.test(env.META_GRAPH_VERSION))
    throw new ApiError(503, "instagram_not_configured");
  const origin = new URL(env.APP_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== env.APP_ORIGIN) throw new ApiError(503, "instagram_not_configured");
  // Validate key material before creating an authorization flow.
  sealSecret("key-check", env.TOKEN_ENCRYPTION_KEY, "config-check");
  return {
    origin: origin.origin,
    appId: env.INSTAGRAM_OAUTH_APP_ID,
    secret: env.INSTAGRAM_OAUTH_APP_SECRET,
    key: env.TOKEN_ENCRYPTION_KEY,
    version: env.META_GRAPH_VERSION,
    redirect: origin.origin + "/api/instagram/callback",
  };
}

export async function beginInstagramOAuth(pool: Pool, user: User, env: InstagramOAuthEnv): Promise<Response> {
  const settings = config(env);
  const workspaceId = await workspaceFor(pool, user, "admin");
  const state = randomBytes(32).toString("hex");
  // An unconsumed state keeps an empty workspace from being left through an invite, so store it only while the
  // workspace is locked and the caller is still an admin there (see lockWorkspaceForMember).
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockWorkspaceForMember(client, workspaceId, user, "admin");
    await client.query("INSERT INTO instagram_oauth_states(state_hash,user_id,workspace_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')", [stateHash(state), user.id, workspaceId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const url = new URL("https://www.instagram.com/oauth/authorize");
  for (const [key, value] of Object.entries({
    client_id: settings.appId,
    redirect_uri: settings.redirect,
    response_type: "code",
    scope: permissions.join(","),
    state,
    force_authentication: "1",
    enable_fb_login: "0",
  }))
    url.searchParams.set(key, value);
  const response = json({ url: url.toString() });
  response.headers.append("Set-Cookie", `__Host-ac-oauth=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return response;
}

// Removes one batch of expired states through the administrator-owned function (server roles have no table
// DELETE) and returns how many were removed. Completion already ignores an expired state (#173).
export async function deleteExpiredOAuthStates(pool: Pool): Promise<number> {
  const result = await pool.query<{ deleted: number }>("SELECT public.delete_expired_oauth_states() AS deleted");
  return result.rows[0]!.deleted;
}

// The provider calls of one OAuth completion, named in the instagram_oauth_provider_failed log line.
export type OAuthProviderStep = "code_exchange" | "long_lived_exchange" | "profile" | "subscribe";

const errorBodyLimit = 16 * 1024;
const providerTypeLength = 24;

function providerNumber(value: unknown): string | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}

function providerType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const type = value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, providerTypeLength);
  return type || undefined;
}

// Reads only the fixed error fields of a provider error body, and only when they have a strict shape: the Graph
// shape { error: { type, code, error_subcode? } } first, then the documented Instagram code-exchange shape
// { error_type, code }. Messages, trace IDs and every other field are never read.
export function providerErrorParts(body: unknown): string[] {
  if (!isRecord(body)) return [];
  if (isRecord(body.error)) {
    const type = providerType(body.error.type);
    const code = providerNumber(body.error.code);
    const subcode = body.error.error_subcode === undefined ? null : providerNumber(body.error.error_subcode);
    if (type && code && subcode !== undefined) return subcode === null ? [type, code] : [type, code, subcode];
  }
  const type = providerType(body.error_type);
  const code = providerNumber(body.code);
  return type && code ? [type, code] : [];
}

// Composes the log code `<step>_<failure>[_<type>[_<code>[_<subcode>]]]`, dropping optional parts from the end
// so the result always fits logOperation's 64-character name rule.
export function oauthProviderFailureCode(step: OAuthProviderStep, failure: string, parts: readonly string[] = []) {
  let code = `${step}_${failure}`;
  for (const part of parts) {
    if (code.length + 1 + part.length > 64) break;
    code += `_${part}`;
  }
  return code;
}

function providerFailure(step: OAuthProviderStep, failure: string, correlationId: string | undefined, parts: readonly string[] = [], error = "instagram_connection_failed"): ApiError {
  logOperation(
    {
      event: "instagram_oauth_provider_failed",
      code: oauthProviderFailureCode(step, failure, parts),
      correlation_id: correlationId,
    },
    "warn",
  );
  return new ApiError(502, error);
}

// Reads at most errorBodyLimit bytes of an error body as JSON; a larger, unreadable or non-JSON body gives undefined.
async function readErrorBody(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (declared > errorBodyLimit) throw new Error("too large");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > errorBodyLimit) throw new Error("too large");
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

async function providerJson(fetchImpl: typeof fetch, step: OAuthProviderStep, url: URL | string, init: RequestInit, correlationId: string | undefined): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "manual" });
  } catch {
    throw providerFailure(step, "network", correlationId);
  }
  if (!response.ok) throw providerFailure(step, `http_${response.status}`, correlationId, providerErrorParts(await readErrorBody(response)));
  try {
    return await response.json();
  } catch {
    throw providerFailure(step, "invalid_json", correlationId);
  }
}

export async function finishInstagramOAuth(
  pool: Pool,
  user: User,
  request: Request,
  env: InstagramOAuthEnv,
  fetchImpl: typeof fetch = fetch,
  // appApi passes the request's correlation ID so a provider failure line matches the response's cf-ray.
  correlationId?: string,
): Promise<Response> {
  const settings = config(env);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const browserState = cookie(request, "__Host-ac-oauth");
  if (!state || !browserState || url.searchParams.getAll("state").length !== 1 || !/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(browserState) || !timingSafeEqual(Buffer.from(state), Buffer.from(browserState))) throw new ApiError(400, "invalid_oauth_state");
  const workspaceId = await workspaceFor(pool, user, "admin");
  const consumed = await pool.query("UPDATE instagram_oauth_states SET consumed_at=now() WHERE state_hash=$1 AND user_id=$2 AND workspace_id=$3 AND consumed_at IS NULL AND expires_at>now() RETURNING state_hash", [stateHash(state), user.id, workspaceId]);
  if (consumed.rowCount !== 1) throw new ApiError(400, "invalid_oauth_state");
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || !code || code.length > 4096 || url.searchParams.getAll("code").length !== 1) throw new ApiError(400, "instagram_authorization_denied");
  const short = await providerJson(
    fetchImpl,
    "code_exchange",
    "https://api.instagram.com/oauth/access_token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: settings.appId,
        client_secret: settings.secret,
        grant_type: "authorization_code",
        redirect_uri: settings.redirect,
        code,
      }).toString(),
    },
    correlationId,
  );
  const entry = isRecord(short) && Array.isArray(short.data) ? short.data[0] : short;
  if (!isRecord(entry) || typeof entry.access_token !== "string" || !entry.access_token) throw providerFailure("code_exchange", "invalid_shape", correlationId);
  const granted = Array.isArray(entry.permissions) ? entry.permissions : typeof entry.permissions === "string" ? entry.permissions.split(",") : [];
  if (!permissions.every((permission) => granted.includes(permission))) throw new ApiError(400, "instagram_permissions_required");
  // The app-scoped user ID that the deauthorize callback may carry. A missing or malformed value does not fail
  // the connection.
  const instagramUserId = normalizedUserId(entry.user_id);
  // Instagram's documented long-lived token exchange requires these server-only query parameters.
  const exchange = new URL("https://graph.instagram.com/access_token");
  exchange.searchParams.set("grant_type", "ig_exchange_token");
  exchange.searchParams.set("client_secret", settings.secret);
  exchange.searchParams.set("access_token", entry.access_token);
  const long = await providerJson(fetchImpl, "long_lived_exchange", exchange, { method: "GET" }, correlationId);
  if (!isRecord(long) || typeof long.access_token !== "string" || !long.access_token) throw providerFailure("long_lived_exchange", "invalid_shape_missing_token", correlationId);
  if (typeof long.expires_in !== "number" || !Number.isFinite(long.expires_in)) throw providerFailure("long_lived_exchange", "invalid_shape_expires_in_type", correlationId);
  if (long.expires_in <= 86400 || long.expires_in > 90 * 86400) throw providerFailure("long_lived_exchange", "invalid_shape_expires_in_range", correlationId);
  const profile = await providerJson(fetchImpl, "profile", `https://graph.instagram.com/${settings.version}/me?fields=user_id,username`, { method: "GET", headers: { Authorization: `Bearer ${long.access_token}` } }, correlationId);
  const account = isRecord(profile) && Array.isArray(profile.data) ? profile.data[0] : profile;
  if (!isRecord(account) || typeof account.user_id !== "string" || !/^\d+$/.test(account.user_id) || typeof account.username !== "string") throw providerFailure("profile", "invalid_shape", correlationId, [], "instagram_account_unverified");
  const encrypted = sealSecret(long.access_token, settings.key, `${workspaceId}:${account.user_id}`);
  // The provider calls above take seconds, and accepting an invite can move the user out of this workspace
  // meanwhile. acceptInvite holds the old workspace row FOR UPDATE while it checks that the workspace is empty,
  // so re-check the membership under a lock on the same row and store the connection in that transaction.
  // NO KEY UPDATE also serializes two completions in one workspace, so both cannot pass the connection limit;
  // foreign key checks (KEY SHARE) from ingestion still go through. Only here is the account known, so the limit
  // cannot be checked before the provider calls without refusing a re-authorization.
  const client = await pool.connect();
  let saved;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE", [workspaceId]);
    const member = await client.query("SELECT 1 FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 AND removed_at IS NULL AND role IN ('owner','admin')", [user.id, workspaceId]);
    if (member.rowCount !== 1) throw new ApiError(403, "workspace_required");
    // An account held by another workspace is refused here, not by the INSERT below: that row is not locked, and
    // if its deletion committed before the INSERT, the INSERT would add a connection that skipped the limit.
    const holder = await client.query<{ workspace_id: string }>("SELECT workspace_id FROM instagram_connections WHERE account_id=$1", [account.user_id]);
    if ((holder.rows[0]?.workspace_id ?? workspaceId) !== workspaceId) throw new ApiError(409, "instagram_account_already_connected");
    await requireConnectionSlot(client, workspaceId, account.user_id);
    saved = await client.query(
      `INSERT INTO instagram_connections(id,workspace_id,account_id,username,active,send_enabled,access_token_encrypted,token_expires_at,instagram_user_id,deauthorized_at)
       VALUES($1,$2,$3,$4,false,false,$5,now()+make_interval(secs=>$6),$7,NULL)
       ON CONFLICT(account_id) DO UPDATE SET username=EXCLUDED.username,active=false,send_enabled=false,
         access_token_encrypted=EXCLUDED.access_token_encrypted,token_expires_at=EXCLUDED.token_expires_at,
         token_obtained_at=now(),
         token_refresh_attempted_at=NULL,
         reauth_required_at=NULL,reauth_reason=NULL,reauth_token_obtained_at=NULL,
         subscription_check_attempted_at=NULL,subscription_checked_at=NULL,subscription_missing_at=NULL,
         subscription_token_obtained_at=NULL,
         instagram_user_id=EXCLUDED.instagram_user_id,deauthorized_at=NULL
       WHERE instagram_connections.workspace_id=$2 RETURNING id`,
      [randomUUID(), workspaceId, account.user_id, account.username, encrypted, Math.floor(long.expires_in), instagramUserId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (saved.rowCount !== 1) throw new ApiError(409, "instagram_account_already_connected");
  const subscribed = await providerJson(
    fetchImpl,
    "subscribe",
    `https://graph.instagram.com/${settings.version}/${account.user_id}/subscribed_apps`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${long.access_token}`, "Content-Type": "application/x-www-form-urlencoded" },
      // messaging_seen (#312) stores reads of messages the service sent. It is not a required field of the
      // subscription check, so a connection subscribed before it was added does not count as missing a field.
      body: new URLSearchParams({
        subscribed_fields: "comments,messages,messaging_postbacks,messaging_seen",
      }).toString(),
    },
    correlationId,
  );
  if (!isRecord(subscribed) || subscribed.success !== true) throw providerFailure("subscribe", "not_success", correlationId, [], "instagram_subscription_failed");
  const activated = await pool.query(
    `UPDATE instagram_connections SET active=true,
     inbox_enabled_at=CASE WHEN NOT active AND inbox_enabled THEN clock_timestamp() ELSE inbox_enabled_at END
     WHERE id=$1 AND workspace_id=$2 AND access_token_encrypted=$3`,
    [saved.rows[0].id, workspaceId, encrypted],
  );
  if (activated.rowCount !== 1) throw new ApiError(409, "instagram_connection_changed");
  const response = new Response(null, {
    status: 303,
    headers: {
      Location: settings.origin + "/app/?instagram=connected",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
  response.headers.append("Set-Cookie", "__Host-ac-oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  return response;
}
