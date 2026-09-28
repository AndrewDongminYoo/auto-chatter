import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { ApiError, cookie, isRecord, json, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";
import { sealSecret } from "./secrets.ts";

export interface InstagramOAuthEnv {
  APP_ORIGIN?: string;
  INSTAGRAM_OAUTH_APP_ID?: string;
  INSTAGRAM_OAUTH_APP_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  META_GRAPH_VERSION?: string;
}

const permissions = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
];
const stateHash = (state: string) => createHash("sha256").update(state).digest("hex");

function config(env: InstagramOAuthEnv) {
  if (
    !env.APP_ORIGIN ||
    !env.INSTAGRAM_OAUTH_APP_ID ||
    !/^\d+$/.test(env.INSTAGRAM_OAUTH_APP_ID) ||
    !env.INSTAGRAM_OAUTH_APP_SECRET ||
    !env.TOKEN_ENCRYPTION_KEY ||
    !env.META_GRAPH_VERSION ||
    !/^v\d+\.\d+$/.test(env.META_GRAPH_VERSION)
  )
    throw new ApiError(503, "instagram_not_configured");
  const origin = new URL(env.APP_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== env.APP_ORIGIN)
    throw new ApiError(503, "instagram_not_configured");
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
  const workspaceId = await workspaceFor(pool, user);
  const state = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO instagram_oauth_states(state_hash,user_id,workspace_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
    [stateHash(state), user.id, workspaceId],
  );
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
  response.headers.append(
    "Set-Cookie",
    `__Host-ac-oauth=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  );
  return response;
}

async function providerJson(fetchImpl: typeof fetch, url: URL | string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "manual" });
  } catch {
    throw new ApiError(502, "instagram_connection_failed");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(502, "instagram_connection_failed");
  }
  try {
    return await response.json();
  } catch {
    throw new ApiError(502, "instagram_connection_failed");
  }
}

export async function finishInstagramOAuth(
  pool: Pool,
  user: User,
  request: Request,
  env: InstagramOAuthEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const settings = config(env);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const browserState = cookie(request, "__Host-ac-oauth");
  if (
    !state ||
    !browserState ||
    url.searchParams.getAll("state").length !== 1 ||
    !/^[a-f0-9]{64}$/.test(state) ||
    !/^[a-f0-9]{64}$/.test(browserState) ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(browserState))
  )
    throw new ApiError(400, "invalid_oauth_state");
  const workspaceId = await workspaceFor(pool, user);
  const consumed = await pool.query(
    "UPDATE instagram_oauth_states SET consumed_at=now() WHERE state_hash=$1 AND user_id=$2 AND workspace_id=$3 AND consumed_at IS NULL AND expires_at>now() RETURNING state_hash",
    [stateHash(state), user.id, workspaceId],
  );
  if (consumed.rowCount !== 1) throw new ApiError(400, "invalid_oauth_state");
  const code = url.searchParams.get("code");
  if (url.searchParams.has("error") || !code || code.length > 4096 || url.searchParams.getAll("code").length !== 1)
    throw new ApiError(400, "instagram_authorization_denied");
  const short = await providerJson(fetchImpl, "https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: settings.appId,
      client_secret: settings.secret,
      grant_type: "authorization_code",
      redirect_uri: settings.redirect,
      code,
    }).toString(),
  });
  const entry = isRecord(short) && Array.isArray(short.data) ? short.data[0] : short;
  if (!isRecord(entry) || typeof entry.access_token !== "string" || !entry.access_token)
    throw new ApiError(502, "instagram_connection_failed");
  const granted = Array.isArray(entry.permissions)
    ? entry.permissions
    : typeof entry.permissions === "string"
      ? entry.permissions.split(",")
      : [];
  if (!permissions.every((permission) => granted.includes(permission)))
    throw new ApiError(400, "instagram_permissions_required");
  // Instagram's documented long-lived token exchange requires these server-only query parameters.
  const exchange = new URL("https://graph.instagram.com/access_token");
  exchange.searchParams.set("grant_type", "ig_exchange_token");
  exchange.searchParams.set("client_secret", settings.secret);
  exchange.searchParams.set("access_token", entry.access_token);
  const long = await providerJson(fetchImpl, exchange, { method: "GET" });
  if (
    !isRecord(long) ||
    typeof long.access_token !== "string" ||
    !long.access_token ||
    typeof long.expires_in !== "number" ||
    !Number.isFinite(long.expires_in) ||
    long.expires_in <= 86400 ||
    long.expires_in > 90 * 86400
  )
    throw new ApiError(502, "instagram_connection_failed");
  const profile = await providerJson(
    fetchImpl,
    `https://graph.instagram.com/${settings.version}/me?fields=user_id,username`,
    { method: "GET", headers: { Authorization: `Bearer ${long.access_token}` } },
  );
  const account = isRecord(profile) && Array.isArray(profile.data) ? profile.data[0] : profile;
  if (
    !isRecord(account) ||
    typeof account.user_id !== "string" ||
    !/^\d+$/.test(account.user_id) ||
    typeof account.username !== "string"
  )
    throw new ApiError(502, "instagram_account_unverified");
  const encrypted = sealSecret(long.access_token, settings.key, `${workspaceId}:${account.user_id}`);
  const saved = await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,active,send_enabled,access_token_encrypted,token_expires_at)
     VALUES($1,$2,$3,$4,false,false,$5,now()+make_interval(secs=>$6))
     ON CONFLICT(account_id) DO UPDATE SET username=EXCLUDED.username,active=false,send_enabled=false,
       access_token_encrypted=EXCLUDED.access_token_encrypted,token_expires_at=EXCLUDED.token_expires_at,
       token_obtained_at=now(),
       token_refresh_attempted_at=NULL
     WHERE instagram_connections.workspace_id=$2 RETURNING id`,
    [randomUUID(), workspaceId, account.user_id, account.username, encrypted, Math.floor(long.expires_in)],
  );
  if (saved.rowCount !== 1) throw new ApiError(409, "instagram_account_already_connected");
  const subscribed = await providerJson(
    fetchImpl,
    `https://graph.instagram.com/${settings.version}/${account.user_id}/subscribed_apps`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${long.access_token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ subscribed_fields: "comments,messages,messaging_postbacks" }).toString(),
    },
  );
  if (!isRecord(subscribed) || subscribed.success !== true) throw new ApiError(502, "instagram_subscription_failed");
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
