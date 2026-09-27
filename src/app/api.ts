import { inboxHandoff, saveInboxHandoff } from "./inbox-handoff.ts";
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
import {
  archiveContactSegment,
  createContactSegment,
  listContactSegments,
  listContacts,
  saveContactTags,
  saveContactAutomation,
} from "./contacts.ts";
import { connectionMedia } from "./instagram-media.ts";
import { setInbox, listInbox, inboxMessages, inboxContext } from "./inbox.ts";
import { archiveContactField, createContactField, listContactFields, saveContactFieldValue } from "./contact-fields.ts";

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
      if (url.pathname === "/api/inbox" && request.method === "GET")
        return json(await listInbox(pool, user, url.searchParams));
      const handoff = /^\/api\/connections\/([a-f0-9-]+)\/inbox\/(\d+)\/handoff$/.exec(url.pathname);
      if (handoff && request.method === "GET")
        return json(await inboxHandoff(pool, user, handoff[1]!, handoff[2]!, url.searchParams));
      if (handoff && request.method === "PUT")
        return json(
          await saveInboxHandoff(pool, user, handoff[1]!, handoff[2]!, url.searchParams, await readJson(request)),
        );
      const context = /^\/api\/connections\/([a-f0-9-]+)\/inbox\/(\d+)\/context$/.exec(url.pathname);
      if (context && request.method === "GET")
        return json(await inboxContext(pool, user, context[1]!, context[2]!, url.searchParams));
      const inbox = /^\/api\/connections\/([a-f0-9-]+)\/inbox(?:\/(\d+))?$/.exec(url.pathname);
      if (inbox && !inbox[2] && request.method === "PUT")
        return json(await setInbox(pool, user, inbox[1]!, await readJson(request)));
      if (inbox?.[2] && request.method === "GET")
        return json(await inboxMessages(pool, user, inbox[1]!, inbox[2], url.searchParams));
      if (url.pathname === "/api/contacts" && request.method === "GET")
        return json(await listContacts(pool, user, url.searchParams));
      if (url.pathname === "/api/contact-fields" && request.method === "GET")
        return json({ fields: await listContactFields(pool, user) });
      if (url.pathname === "/api/contact-fields" && request.method === "POST")
        return json(await createContactField(pool, user, await readJson(request)), 201);
      const field = /^\/api\/contact-fields\/([a-f0-9-]+)$/.exec(url.pathname);
      if (field && request.method === "DELETE") return json(await archiveContactField(pool, user, field[1]!));
      const fieldValue = /^\/api\/connections\/([a-f0-9-]+)\/contacts\/([^/]+)\/fields\/([a-f0-9-]+)$/.exec(
        url.pathname,
      );
      if (fieldValue && request.method === "PUT") {
        let senderId: string;
        try {
          senderId = decodeURIComponent(fieldValue[2]!);
        } catch {
          throw new ApiError(400, "invalid_contact_request");
        }
        return json(
          await saveContactFieldValue(pool, user, fieldValue[1]!, senderId, fieldValue[3]!, await readJson(request)),
        );
      }
      if (url.pathname === "/api/contact-segments" && request.method === "GET")
        return json({ segments: await listContactSegments(pool, user) });
      if (url.pathname === "/api/contact-segments" && request.method === "POST")
        return json(await createContactSegment(pool, user, await readJson(request)), 201);
      const segment = /^\/api\/contact-segments\/([a-f0-9-]+)$/.exec(url.pathname);
      if (segment && request.method === "DELETE") return json(await archiveContactSegment(pool, user, segment[1]!));
      const automation = /^\/api\/connections\/([a-f0-9-]+)\/contacts\/([^/]+)\/automation$/.exec(url.pathname);
      if (automation && request.method === "PUT") {
        let senderId: string;
        try {
          senderId = decodeURIComponent(automation[2]!);
        } catch {
          throw new ApiError(400, "invalid_contact_request");
        }
        return json(await saveContactAutomation(pool, user, automation[1]!, senderId, await readJson(request)));
      }
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
