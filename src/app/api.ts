import { queueManualReply, listManualReplies, resolveManualReply, readManualReplyStatus } from "./manual-replies.ts";
import { inboxHandoff, saveInboxHandoff } from "./inbox-handoff.ts";
import type { Pool } from "pg";
import { ApiError, AuthClient, json, readJson, requireSameOrigin, type AuthEnv, type User } from "./auth.ts";
import { limitAuthRequest, type AuthRateLimitEnv } from "./auth-rate-limit.ts";
import {
  listActivity,
  disconnectConnection,
  ensureWorkspace,
  listConnections,
  listRules,
  membershipFor,
  saveRule,
  parseRule,
  updateConnection,
} from "./settings.ts";
import {
  acceptInvite,
  changeMemberRole,
  createInvite,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
} from "./workspace-members.ts";
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
import { connectionHealth } from "./instagram-connection-health.ts";
import { setInbox, listInbox, inboxMessages, inboxContext } from "./inbox.ts";
import { archiveContactField, createContactField, listContactFields, saveContactFieldValue } from "./contact-fields.ts";
import { recordConsentEvent } from "./channel-consent.ts";
import { deleteConnectionData, listDataDeletions } from "./data-deletion.ts";
import { exportWorkspace } from "./workspace-export.ts";
import {
  FLOW_REQUEST_BYTES,
  archiveFlow,
  createFlow,
  getFlow,
  getFlowVersion,
  listFlowRuns,
  listFlowVersions,
  listFlows,
  publishFlow,
  saveFlowDraft,
  setFlowEnabled,
} from "./flows.ts";

function instagramConnectAvailable(user: User, env: InstagramOAuthEnv): boolean {
  if (env.INSTAGRAM_PUBLIC_CONNECT_ENABLED === "true") return true;
  if (!user.email) return false;
  return (env.INSTAGRAM_INTERNAL_EMAILS ?? "")
    .split(",")
    .some((email) => email.trim() !== "" && email.trim().toLowerCase() === user.email.toLowerCase());
}

export async function appApi(
  request: Request,
  env: AuthEnv & AuthRateLimitEnv & InstagramOAuthEnv & { SEND_ENABLED?: string },
  openPool: () => Pool,
  fetchImpl: typeof fetch = fetch,
  notifyReply?: (connectionId: string) => Promise<void>,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method !== "GET") requireSameOrigin(request);
    const auth = new AuthClient(env, fetchImpl);
    if (request.method === "POST") {
      if (
        ["/api/auth/login", "/api/auth/signup", "/api/auth/recover", "/api/auth/resend-confirmation"].includes(
          url.pathname,
        )
      ) {
        const input = await readJson(request);
        await limitAuthRequest(request, url.pathname, input, env);
        if (url.pathname === "/api/auth/login") return await auth.login(input);
        if (url.pathname === "/api/auth/signup") return await auth.signup(input);
        if (url.pathname === "/api/auth/recover") return await auth.recover(input);
        return await auth.resendConfirmation(input);
      }
      if (url.pathname === "/api/auth/reset-password") return await auth.resetPassword(await readJson(request));
      if (url.pathname === "/api/auth/refresh") return await auth.refresh(request);
      if (url.pathname === "/api/auth/logout") return await auth.logout(request);
    }
    const user = await auth.user(request);
    if (url.pathname === "/api/me" && request.method === "GET")
      return json({
        user,
        global_send_enabled: env.SEND_ENABLED === "true",
        instagram_connect_available: instagramConnectAvailable(user, env),
      });
    if (
      ((url.pathname === "/api/instagram/connect" && request.method === "POST") ||
        (url.pathname === "/api/instagram/callback" && request.method === "GET")) &&
      !instagramConnectAvailable(user, env)
    )
      throw new ApiError(403, "instagram_public_access_restricted");
    const pool = openPool();
    try {
      if (url.pathname === "/api/instagram/connect" && request.method === "POST")
        return await beginInstagramOAuth(pool, user, env);
      if (url.pathname === "/api/instagram/callback" && request.method === "GET")
        return await finishInstagramOAuth(pool, user, request, env, fetchImpl);
      if (url.pathname === "/api/workspace" && request.method === "POST") {
        await ensureWorkspace(pool, user);
        return json(await membershipFor(pool, user, "agent"));
      }
      if (url.pathname === "/api/invites/accept" && request.method === "POST")
        return json(await acceptInvite(pool, user, await readJson(request)));
      if (url.pathname === "/api/workspace/members" && request.method === "GET")
        return json({ members: await listMembers(pool, user) });
      const member = /^\/api\/workspace\/members\/([a-f0-9-]+)$/.exec(url.pathname);
      if (member && request.method === "PATCH")
        return json(await changeMemberRole(pool, user, member[1]!, await readJson(request)));
      if (member && request.method === "DELETE") return json(await removeMember(pool, user, member[1]!));
      if (url.pathname === "/api/workspace/invites" && request.method === "GET")
        return json({ invites: await listInvites(pool, user) });
      if (url.pathname === "/api/workspace/invites" && request.method === "POST")
        return json(await createInvite(pool, user, await readJson(request), env.APP_ORIGIN ?? url.origin), 201);
      const invite = /^\/api\/workspace\/invites\/([a-f0-9-]+)$/.exec(url.pathname);
      if (invite && request.method === "DELETE") return json(await revokeInvite(pool, user, invite[1]!));
      if (url.pathname === "/api/workspace/export" && request.method === "GET") {
        const exported = await exportWorkspace(pool, user);
        return new Response(exported.body, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": `attachment; filename="auto-chatter-export-${exported.exportedAt.slice(0, 10)}.json"`,
          },
        });
      }
      if (url.pathname === "/api/connections" && request.method === "GET")
        return json({ connections: await listConnections(pool, user) });
      const consentEvent = /^\/api\/connections\/([^/]+)\/channel-consent-events$/.exec(url.pathname);
      if (consentEvent && request.method === "POST") {
        const result = await recordConsentEvent(pool, user, consentEvent[1]!, await readJson(request));
        return json(result, result.applied ? 201 : 200);
      }
      const health = /^\/api\/connections\/([a-f0-9-]+)\/health$/.exec(url.pathname);
      if (health && request.method === "GET") {
        if (!env.AUTH_IP_LIMIT) throw new ApiError(503, "health_unavailable");
        const allowance = await env.AUTH_IP_LIMIT.limit({ key: `connection-health:${user.id}` });
        if (!allowance.success) throw new ApiError(429, "health_rate_limited");
        return json(await connectionHealth(pool, user, health[1]!, env, fetchImpl));
      }
      if (url.pathname === "/api/inbox" && request.method === "GET")
        return json(await listInbox(pool, user, url.searchParams));
      const replyStatus = /^\/api\/connections\/([a-f0-9-]+)\/inbox\/(\d+)\/reply-status$/.exec(url.pathname);
      if (replyStatus && request.method === "GET")
        return json(
          await readManualReplyStatus(
            pool,
            user,
            replyStatus[1]!,
            replyStatus[2]!,
            url.searchParams,
            env.SEND_ENABLED === "true",
          ),
        );
      const manual =
        /^\/api\/connections\/([a-f0-9-]+)\/inbox\/(\d+)\/replies(?:\/([a-f0-9-]+)\/(retry|resolution))?$/.exec(
          url.pathname,
        );
      if (manual && request.method === "GET" && !manual[3])
        return json(await listManualReplies(pool, user, manual[1]!, manual[2]!, url.searchParams));
      if (manual && request.method === "POST") {
        const body = await readJson(request);
        if (manual[4] === "resolution") {
          const resolution = await resolveManualReply(
            pool,
            user,
            manual[1]!,
            manual[2]!,
            manual[3]!,
            url.searchParams,
            body,
          );
          try {
            await notifyReply?.(manual[1]!);
          } catch {
            console.error("Manual reply notification failed; scheduled recovery required");
          }
          return json(resolution);
        }
        const reply = await queueManualReply(
          pool,
          user,
          manual[1]!,
          manual[2]!,
          url.searchParams,
          body,
          env.SEND_ENABLED === "true",
          manual[3],
        );
        try {
          await notifyReply?.(manual[1]!);
        } catch {
          console.error("Manual reply notification failed; scheduled recovery required");
        }
        return json(reply, 202);
      }
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
      if (url.pathname === "/api/flows" && request.method === "GET")
        return json({ flows: await listFlows(pool, user) });
      if (url.pathname === "/api/flows" && request.method === "POST")
        return json(await createFlow(pool, user, await readJson(request, FLOW_REQUEST_BYTES)), 201);
      const flow = /^\/api\/flows\/([a-f0-9-]+)(?:\/(publish|versions|enable|disable|runs)(?:\/(\d{1,9}))?)?$/.exec(
        url.pathname,
      );
      if (flow && !flow[2] && request.method === "GET") return json(await getFlow(pool, user, flow[1]!));
      if (flow && !flow[2] && request.method === "PUT")
        return json(await saveFlowDraft(pool, user, flow[1]!, await readJson(request, FLOW_REQUEST_BYTES)));
      if (flow && !flow[2] && request.method === "DELETE") return json(await archiveFlow(pool, user, flow[1]!));
      if (flow?.[2] === "publish" && !flow[3] && request.method === "POST") {
        const published = await publishFlow(pool, user, flow[1]!, await readJson(request));
        return "errors" in published
          ? json({ error: "flow_invalid", errors: published.errors }, 422)
          : json(published, published.replayed ? 200 : 201);
      }
      if (flow?.[2] === "versions" && !flow[3] && request.method === "GET")
        return json({ versions: await listFlowVersions(pool, user, flow[1]!) });
      if (flow?.[2] === "versions" && flow[3] && request.method === "GET")
        return json(await getFlowVersion(pool, user, flow[1]!, flow[3]));
      if ((flow?.[2] === "enable" || flow?.[2] === "disable") && !flow[3] && request.method === "POST") {
        const switched = await setFlowEnabled(pool, user, flow[1]!, flow[2] === "enable");
        return "errors" in switched
          ? json({ error: "flow_not_executable", errors: switched.errors }, 422)
          : json(switched);
      }
      if (flow?.[2] === "runs" && !flow[3] && request.method === "GET")
        return json({ runs: await listFlowRuns(pool, user, flow[1]!) });
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
      const deletion = /^\/api\/connections\/([a-f0-9-]+)\/(data-deletion|data-deletions)$/.exec(url.pathname);
      if (deletion?.[2] === "data-deletion" && request.method === "POST")
        return json(await deleteConnectionData(pool, user, deletion[1]!, await readJson(request)));
      if (deletion?.[2] === "data-deletions" && request.method === "GET")
        return json({ deletions: await listDataDeletions(pool, user, deletion[1]!) });
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
    if (
      error instanceof ApiError &&
      request.method === "GET" &&
      new URL(request.url).pathname === "/api/instagram/callback" &&
      ["instagram_authorization_denied", "instagram_permissions_required"].includes(error.message)
    ) {
      const response = new Response(null, {
        status: 303,
        headers: {
          Location: new URL(`/app/?instagram=${error.message}`, request.url).toString(),
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
      response.headers.append("Set-Cookie", "__Host-ac-oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
      return response;
    }
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    // SQL/provider errors can contain submitted content or credentials.
    return json({ error: "service_unavailable" }, 503);
  }
}
