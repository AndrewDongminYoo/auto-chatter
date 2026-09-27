import type { Pool } from "pg";
import { ApiError, AuthClient, json, readJson, requireSameOrigin, type AuthEnv } from "./auth.ts";
import {
  listActivity,
  disconnectConnection,
  ensureWorkspace,
  listConnections,
  listRules,
  saveRule,
  parseRule,
  updateConnection,
} from "./settings.ts";
import { beginInstagramOAuth, finishInstagramOAuth, type InstagramOAuthEnv } from "./instagram-oauth.ts";
import { listContacts, saveContactTags } from "./contacts.ts";
import { connectionMedia } from "./instagram-media.ts";

export async function appApi(
  request: Request,
  env: AuthEnv & InstagramOAuthEnv & { SEND_ENABLED?: string },
  openPool: () => Pool,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method !== "GET") requireSameOrigin(request);
    const auth = new AuthClient(env, fetchImpl);
    if (request.method === "POST") {
      if (url.pathname === "/api/auth/login") return await auth.login(await readJson(request));
      if (url.pathname === "/api/auth/signup") return await auth.signup(await readJson(request));
      if (url.pathname === "/api/auth/refresh") return await auth.refresh(request);
      if (url.pathname === "/api/auth/logout") return await auth.logout(request);
    }
    const user = await auth.user(request);
    if (url.pathname === "/api/me" && request.method === "GET")
      return json({ user, global_send_enabled: env.SEND_ENABLED === "true" });
    const pool = openPool();
    try {
      if (url.pathname === "/api/instagram/connect" && request.method === "POST")
        return await beginInstagramOAuth(pool, user, env);
      if (url.pathname === "/api/instagram/callback" && request.method === "GET")
        return await finishInstagramOAuth(pool, user, request, env, fetchImpl);
      if (url.pathname === "/api/workspace" && request.method === "POST")
        return json({ workspace_id: await ensureWorkspace(pool, user) });
      if (url.pathname === "/api/connections" && request.method === "GET")
        return json({ connections: await listConnections(pool, user) });
      if (url.pathname === "/api/contacts" && request.method === "GET")
        return json(await listContacts(pool, user, url.searchParams));
      const contact = /^\/api\/connections\/([a-f0-9-]+)\/contacts\/([^/]+)$/.exec(url.pathname);
      if (contact && request.method === "PATCH") {
        let senderId: string;
        try {
          senderId = decodeURIComponent(contact[2]!);
        } catch {
          throw new ApiError(400, "invalid_contact_request");
        }
        return json(await saveContactTags(pool, user, contact[1]!, senderId, await readJson(request)));
      }
      if (url.pathname === "/api/activity" && request.method === "GET")
        return json({ activity: await listActivity(pool, user) });
      if (url.pathname === "/api/rules" && request.method === "GET")
        return json({ rules: await listRules(pool, user) });
      if (url.pathname === "/api/rules" && request.method === "PUT") {
        const input = await readJson(request);
        const rule = parseRule(input);
        if (!rule.id) await connectionMedia(pool, user, rule.connection_id, env, { mediaId: rule.media_id }, fetchImpl);
        return json(await saveRule(pool, user, input));
      }
      const media = /^\/api\/connections\/([a-f0-9-]+)\/media(?:\/(\d{1,40}))?$/.exec(url.pathname);
      if (media && request.method === "GET") {
        if (url.searchParams.getAll("after").length > 1) throw new ApiError(400, "invalid_media_request");
        return json(
          await connectionMedia(
            pool,
            user,
            media[1]!,
            env,
            {
              ...(url.searchParams.has("after") ? { after: url.searchParams.get("after")! } : {}),
              ...(media[2] ? { mediaId: media[2] } : {}),
            },
            fetchImpl,
          ),
        );
      }
      const connection = /^\/api\/connections\/([a-f0-9-]+)$/.exec(url.pathname);
      if (connection && request.method === "DELETE")
        return json(await disconnectConnection(pool, user, connection[1]!));
      if (connection && request.method === "PATCH")
        return json(await updateConnection(pool, user, connection[1]!, await readJson(request)));
      return json({ error: "not_found" }, 404);
    } finally {
      await pool.end();
    }
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    // SQL/provider errors can contain submitted content or credentials.
    return json({ error: "service_unavailable" }, 503);
  }
}
