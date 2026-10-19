import { contactDetails } from "./contact-details.ts";
import { exportContactCsv } from "./contact-csv.ts";
import { CONTACT_IMPORT_REQUEST_BYTES, previewContactCsv } from "./contact-csv-preview.ts";
import { CONTACT_IMPORT_APPLY_REQUEST_BYTES, applyContactCsv } from "./contact-csv-import.ts";
import {
  queueManualReply,
  listManualReplies,
  resolveManualReply,
  readManualReplyStatus,
  changeManualReplySchedule,
} from "./manual-replies.ts";
import { inboxHandoff, saveInboxHandoff } from "./inbox-handoff.ts";
import { listAssignees, saveConversationState } from "./inbox-conversations.ts";
import { markInboxRead } from "./inbox-read.ts";
import {
  archiveInboxLabel,
  createInboxLabel,
  listInboxLabels,
  renameInboxLabel,
  saveConversationLabels,
} from "./inbox-labels.ts";
import { addInboxNote, listInboxNotes } from "./inbox-notes.ts";
import {
  archiveReplyTemplate,
  createReplyTemplate,
  listReplyTemplates,
  previewReplyTemplate,
  updateReplyTemplate,
} from "./reply-templates.ts";
import { archiveLabelRule, createLabelRule, listLabelRules, updateLabelRule } from "./inbox-label-rules.ts";
import { changeReminder, closeReminder, createReminder, listReminders } from "./inbox-reminders.ts";
import type { Pool } from "pg";
import {
  ApiError,
  AuthClient,
  clearSession,
  isUuid,
  json,
  readJson,
  readOptionalJson,
  requireSameOrigin,
  type AuthEnv,
  type User,
} from "./auth.ts";
import { limitAuthRequest, type AuthRateLimitEnv, type RateLimitBinding } from "./auth-rate-limit.ts";
import {
  listActivity,
  currentWorkspace,
  disconnectConnection,
  ensureWorkspace,
  listConnections,
  listRules,
  saveRule,
  saveWorkspaceSettings,
  parseRule,
  updateConnection,
} from "./settings.ts";
import {
  acceptInvite,
  changeMemberRole,
  createInvite,
  listInvites,
  listMembers,
  memberEntitlements,
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
  SEGMENT_REQUEST_BYTES,
  updateContactSegment,
} from "./contacts.ts";
import { connectionMedia } from "./instagram-media.ts";
import { connectionHealth } from "./instagram-connection-health.ts";
import { setInbox, listInbox, inboxMessages, inboxContext } from "./inbox.ts";
import { archiveContactField, createContactField, listContactFields, saveContactFieldValue } from "./contact-fields.ts";
import { recordConsentEvent } from "./channel-consent.ts";
import { deleteConnectionData, listDataDeletions } from "./data-deletion.ts";
import { exportWorkspace } from "./workspace-export.ts";
import {
  createSegmentSnapshot,
  exportSegmentSnapshotCsv,
  getSegmentSnapshot,
  listSegmentSnapshots,
  listWorkspaceSegmentSnapshots,
} from "./segment-snapshots.ts";
import { failureCode, logOperation } from "./operations-log.ts";
import { operationsHealth } from "./operations-health.ts";
import { manualReplyReport } from "./manual-reply-reports.ts";
import { flowRunReport } from "./flow-run-reports.ts";
import { handoffReport } from "./handoff-reports.ts";
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
  testFlowRun,
} from "./flows.ts";
import {
  createWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  redeliverWebhook,
  retireWebhookKey,
  rotateWebhookKey,
  setWebhookEndpointActive,
} from "./webhooks.ts";

function instagramConnectAvailable(user: User, env: InstagramOAuthEnv): boolean {
  if (env.INSTAGRAM_PUBLIC_CONNECT_ENABLED === "true") return true;
  if (!user.email) return false;
  return (env.INSTAGRAM_INTERNAL_EMAILS ?? "")
    .split(",")
    .some((email) => email.trim() !== "" && email.trim().toLowerCase() === user.email.toLowerCase());
}

// Spends one request from a per-user allowance (#166). A missing binding or a limiter that does not answer fails
// closed with 503, so the route never runs unlimited.
async function spendUserAllowance(
  binding: RateLimitBinding | undefined,
  key: string,
  codes: { limited: string; unavailable: string },
): Promise<void> {
  if (!binding) throw new ApiError(503, codes.unavailable);
  let allowance: { success: boolean };
  try {
    allowance = await binding.limit({ key });
  } catch {
    throw new ApiError(503, codes.unavailable);
  }
  if (!allowance.success) throw new ApiError(429, codes.limited);
}

// Spends one request from a default API limit (#167). Unlike spendUserAllowance, a missing binding or a limiter
// that does not answer lets the request through and reports "unavailable": these limits bound growth, and a
// limiter outage must not stop every dashboard write. The caller logs the outage once per request.
async function spendApiAllowance(binding: RateLimitBinding | undefined, key: string): Promise<"ok" | "unavailable"> {
  if (!binding) return "unavailable";
  let allowance: { success: boolean };
  try {
    allowance = await binding.limit({ key });
  } catch {
    return "unavailable";
  }
  if (!allowance.success) throw new ApiError(429, "rate_limited");
  return "ok";
}

// The reply is stored; the cron repairs the missing queue notification.
function logManualNotificationFailure(correlationId: string, connectionId: string): void {
  logOperation({
    event: "queue_publish_failed",
    code: "manual_reply_notification_failed",
    correlation_id: correlationId,
    connection_id: connectionId,
  });
}

export async function appApi(
  request: Request,
  env: AuthEnv & AuthRateLimitEnv & InstagramOAuthEnv & { SEND_ENABLED?: string },
  openPool: (correlationId: string) => Pool,
  fetchImpl: typeof fetch = fetch,
  notifyReply?: (connectionId: string) => Promise<void>,
  // The Worker passes the ID it already chose; otherwise cf-ray, or a fresh UUID when that header is missing.
  correlationId: string = request.headers.get("cf-ray") ?? crypto.randomUUID(),
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method !== "GET") requireSameOrigin(request);
    const auth = new AuthClient(env, fetchImpl, request.headers.get("CF-Connecting-IP"));
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
      if (url.pathname === "/api/auth/refresh" || url.pathname === "/api/auth/logout") {
        // Both call Supabase's /token, whose per-IP budget a forged refresh cookie would otherwise spend freely (#164).
        try {
          await limitAuthRequest(request, url.pathname, undefined, env);
        } catch (error) {
          // A refused logout still clears the browser session, as a remote logout failure does.
          if (url.pathname === "/api/auth/logout" && error instanceof ApiError)
            return clearSession(json({ error: error.message }, error.status));
          throw error;
        }
        return url.pathname === "/api/auth/refresh" ? await auth.refresh(request) : await auth.logout(request);
      }
    }
    const user = await auth.user(request);
    // Default request limits (#167). An unavailable limiter is logged once per request with a fixed code only.
    let limitUnavailableLogged = false;
    const spendApiLimit = async (binding: RateLimitBinding | undefined, key: string) => {
      if ((await spendApiAllowance(binding, key)) === "ok" || limitUnavailableLogged) return;
      limitUnavailableLogged = true;
      logOperation(
        { event: "rate_limit_unavailable", code: "api_limit_unavailable", correlation_id: correlationId },
        "warn",
      );
    };
    // Every signed-in write spends the per-user limit before the database is opened, so a refused write reads and
    // writes nothing. POST /api/workspace is the dashboard's bootstrap: for a member it reads the membership (and at
    // most refreshes the stored email), so it is counted, per user only, when it creates the first workspace, below.
    const write = request.method !== "GET" && request.method !== "HEAD" && !url.pathname.startsWith("/api/auth/");
    const bootstrap = url.pathname === "/api/workspace" && request.method === "POST";
    // Member removal skips the shared workspace limit, so an owner can still remove the member who spent it.
    const memberRemoval = request.method === "DELETE" && /^\/api\/workspace\/members\/[a-f0-9-]+$/.test(url.pathname);
    if (write && !bootstrap) await spendApiLimit(env.API_WRITE_USER_LIMIT, user.id);
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
    if (url.pathname === "/api/contacts/export.csv" && request.method === "GET") {
      // No query exports every contact; the only accepted key is one segment_id holding a UUID.
      if (url.searchParams.size && (url.searchParams.size !== 1 || !isUuid(url.searchParams.get("segment_id"))))
        throw new ApiError(400, "invalid_contact_export_request");
      await spendUserAllowance(env.CONTACT_EXPORT_LIMIT, user.id, {
        limited: "contact_export_rate_limited",
        unavailable: "contact_export_unavailable",
      });
    }
    const snapshotCsv = /^\/api\/segment-snapshots\/([a-f0-9-]+)\/members\.csv$/.exec(url.pathname);
    if (snapshotCsv && request.method === "GET") {
      if (url.searchParams.size) throw new ApiError(400, "invalid_snapshot_request");
      // The same per-user allowance as the contact CSV export.
      await spendUserAllowance(env.CONTACT_EXPORT_LIMIT, user.id, {
        limited: "contact_export_rate_limited",
        unavailable: "contact_export_unavailable",
      });
    }
    const pool = openPool(correlationId);
    try {
      // The workspace write limit reads only the caller's membership, before any route handler and before the #166
      // OAuth start allowance. A user without a workspace has only the user limit.
      // A missing binding is logged as unavailable without reading the membership.
      const membership = async () =>
        (
          await pool.query<{ workspace_id: string }>(
            "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND removed_at IS NULL",
            [user.id],
          )
        ).rows[0]?.workspace_id;
      if (bootstrap) {
        if (!(await membership())) await spendApiLimit(env.API_WRITE_USER_LIMIT, user.id);
      } else if (write && !memberRemoval) {
        if (!env.API_WRITE_WORKSPACE_LIMIT) await spendApiLimit(undefined, "");
        else {
          const workspace = await membership();
          if (workspace) await spendApiLimit(env.API_WRITE_WORKSPACE_LIMIT, workspace);
        }
      }
      if (url.pathname === "/api/instagram/connect" && request.method === "POST") {
        // Each start stores an OAuth state row that only workspace deletion removes.
        await spendUserAllowance(env.INSTAGRAM_CONNECT_LIMIT, user.id, {
          limited: "instagram_connect_rate_limited",
          unavailable: "instagram_connect_unavailable",
        });
        return await beginInstagramOAuth(pool, user, env);
      }
      if (url.pathname === "/api/instagram/callback" && request.method === "GET")
        return await finishInstagramOAuth(pool, user, request, env, fetchImpl);
      if (url.pathname === "/api/workspace" && request.method === "POST") {
        await ensureWorkspace(pool, user);
        return json(await currentWorkspace(pool, user));
      }
      if (url.pathname === "/api/workspace/settings" && request.method === "PUT")
        return json(await saveWorkspaceSettings(pool, user, await readJson(request)));
      if (url.pathname === "/api/invites/accept" && request.method === "POST")
        return json(await acceptInvite(pool, user, await readJson(request)));
      if (url.pathname === "/api/workspace/members" && request.method === "GET")
        return json({ members: await listMembers(pool, user), ...(await memberEntitlements(pool, user)) });
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
        await spendUserAllowance(env.WORKSPACE_EXPORT_LIMIT, user.id, {
          limited: "workspace_export_rate_limited",
          unavailable: "workspace_export_unavailable",
        });
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
      if (url.pathname === "/api/workspace/health" && request.method === "GET")
        return json(await operationsHealth(pool, user, env.SEND_ENABLED === "true"));
      if (url.pathname === "/api/reports/manual-replies" && request.method === "GET")
        return json(await manualReplyReport(pool, user, url.searchParams));
      if (url.pathname === "/api/reports/flow-runs" && request.method === "GET")
        return json(await flowRunReport(pool, user, url.searchParams));
      if (url.pathname === "/api/reports/handoffs" && request.method === "GET")
        return json(await handoffReport(pool, user, url.searchParams));
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
        return json(await connectionHealth(pool, user, health[1]!, env, fetchImpl, correlationId));
      }
      if (url.pathname === "/api/inbox" && request.method === "GET") {
        // Every list request scans all of the workspace's DMs.
        await spendApiLimit(env.INBOX_LIST_LIMIT, user.id);
        return json(await listInbox(pool, user, url.searchParams));
      }
      if (url.pathname === "/api/inbox/assignees" && request.method === "GET")
        return json({ assignees: await listAssignees(pool, user) });
      const conversationState = /^\/api\/inbox\/conversations\/([a-f0-9-]+)\/(\d+)\/state$/.exec(url.pathname);
      if (conversationState && request.method === "PUT") {
        const saved = await saveConversationState(
          pool,
          user,
          conversationState[1]!,
          conversationState[2]!,
          url.searchParams,
          await readJson(request),
        );
        // A stale expected_version answers with the current state, so the screen can show who changed it.
        return saved.conflict ? json({ error: "conversation_conflict", state: saved.state }, 409) : json(saved.state);
      }
      if (url.pathname === "/api/inbox/labels" && request.method === "GET")
        return json({ labels: await listInboxLabels(pool, user) });
      if (url.pathname === "/api/inbox/labels" && request.method === "POST")
        return json(await createInboxLabel(pool, user, await readJson(request)), 201);
      const inboxLabel = /^\/api\/inbox\/labels\/([a-f0-9-]+)$/.exec(url.pathname);
      if (inboxLabel && request.method === "PATCH")
        return json(await renameInboxLabel(pool, user, inboxLabel[1]!, await readJson(request)));
      if (inboxLabel && request.method === "DELETE") return json(await archiveInboxLabel(pool, user, inboxLabel[1]!));
      if (url.pathname === "/api/inbox/reply-templates" && request.method === "GET")
        return json({ templates: await listReplyTemplates(pool, user) });
      if (url.pathname === "/api/inbox/reply-templates" && request.method === "POST")
        return json(await createReplyTemplate(pool, user, await readJson(request)), 201);
      const replyTemplate = /^\/api\/inbox\/reply-templates\/([a-f0-9-]+)$/.exec(url.pathname);
      if (replyTemplate && request.method === "PATCH")
        return json(await updateReplyTemplate(pool, user, replyTemplate[1]!, await readJson(request)));
      if (replyTemplate && request.method === "DELETE")
        return json(await archiveReplyTemplate(pool, user, replyTemplate[1]!));
      const templatePreview = /^\/api\/inbox\/reply-templates\/([a-f0-9-]+)\/preview$/.exec(url.pathname);
      if (templatePreview && request.method === "POST")
        return json(await previewReplyTemplate(pool, user, templatePreview[1]!, await readJson(request)));
      if (url.pathname === "/api/inbox/label-rules" && request.method === "GET")
        return json({ rules: await listLabelRules(pool, user) });
      if (url.pathname === "/api/inbox/label-rules" && request.method === "POST")
        return json(await createLabelRule(pool, user, await readJson(request)), 201);
      const labelRule = /^\/api\/inbox\/label-rules\/([a-f0-9-]+)$/.exec(url.pathname);
      if (labelRule && request.method === "PATCH") {
        const saved = await updateLabelRule(pool, user, labelRule[1]!, await readJson(request));
        // A stale expected_version answers with the current rule, like the label set.
        return saved.conflict ? json({ error: "label_rule_conflict", rule: saved.rule }, 409) : json(saved.rule);
      }
      if (labelRule && request.method === "DELETE") return json(await archiveLabelRule(pool, user, labelRule[1]!));
      const conversationLabels = /^\/api\/inbox\/conversations\/([a-f0-9-]+)\/(\d+)\/labels$/.exec(url.pathname);
      if (conversationLabels && request.method === "PUT") {
        const saved = await saveConversationLabels(
          pool,
          user,
          conversationLabels[1]!,
          conversationLabels[2]!,
          url.searchParams,
          await readJson(request),
        );
        // A stale expected_version answers with the current label set, like the conversation state.
        return saved.conflict
          ? json({ error: "label_conflict", label_set: saved.label_set }, 409)
          : json(saved.label_set);
      }
      const conversationNotes = /^\/api\/inbox\/conversations\/([a-f0-9-]+)\/(\d+)\/notes$/.exec(url.pathname);
      if (conversationNotes && request.method === "GET")
        return json(await listInboxNotes(pool, user, conversationNotes[1]!, conversationNotes[2]!, url.searchParams));
      if (conversationNotes && request.method === "POST")
        return json(
          await addInboxNote(
            pool,
            user,
            conversationNotes[1]!,
            conversationNotes[2]!,
            url.searchParams,
            await readJson(request),
          ),
          201,
        );
      const conversationReminders = /^\/api\/inbox\/conversations\/([a-f0-9-]+)\/(\d+)\/reminders$/.exec(url.pathname);
      if (conversationReminders && request.method === "POST") {
        const created = await createReminder(
          pool,
          user,
          conversationReminders[1]!,
          conversationReminders[2]!,
          url.searchParams,
          await readJson(request),
        );
        // A pending reminder of the caller already exists: answer with it, so the screen changes that one instead.
        return created.conflict
          ? json({ error: "reminder_exists", reminder: created.reminder }, 409)
          : json(created.reminder, 201);
      }
      if (url.pathname === "/api/inbox/reminders" && request.method === "GET")
        return json(await listReminders(pool, user, url.searchParams));
      const reminder = /^\/api\/inbox\/reminders\/([a-f0-9-]+)(?:\/(complete|cancel))?$/.exec(url.pathname);
      if (
        reminder &&
        ((!reminder[2] && request.method === "PATCH") || (reminder[2] !== undefined && request.method === "POST"))
      ) {
        const input = await readJson(request);
        const saved = reminder[2]
          ? await closeReminder(pool, user, reminder[1]!, reminder[2] as "complete" | "cancel", url.searchParams, input)
          : await changeReminder(pool, user, reminder[1]!, url.searchParams, input);
        // A stale expected_version answers with the current reminder, like the conversation state.
        return saved.conflict
          ? json({ error: "reminder_conflict", reminder: saved.reminder }, 409)
          : json(saved.reminder);
      }
      const conversationRead = /^\/api\/inbox\/conversations\/([a-f0-9-]+)\/(\d+)\/read$/.exec(url.pathname);
      if (conversationRead && request.method === "POST")
        return json(
          await markInboxRead(
            pool,
            user,
            conversationRead[1]!,
            conversationRead[2]!,
            url.searchParams,
            await readJson(request),
          ),
        );
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
      const schedule =
        /^\/api\/connections\/([a-f0-9-]+)\/inbox\/(\d+)\/replies\/([a-f0-9-]+)\/(schedule|cancel)$/.exec(url.pathname);
      if (
        schedule &&
        ((schedule[4] === "schedule" && request.method === "PATCH") ||
          (schedule[4] === "cancel" && request.method === "POST"))
      ) {
        const reply = await changeManualReplySchedule(
          pool,
          user,
          schedule[1]!,
          schedule[2]!,
          schedule[3]!,
          url.searchParams,
          await readJson(request),
          env.SEND_ENABLED === "true",
          schedule[4] === "cancel",
        );
        try {
          await notifyReply?.(schedule[1]!);
        } catch {
          logManualNotificationFailure(correlationId, schedule[1]!);
        }
        return json(reply);
      }
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
            logManualNotificationFailure(correlationId, manual[1]!);
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
          logManualNotificationFailure(correlationId, manual[1]!);
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
      if (url.pathname === "/api/contacts/export.csv" && request.method === "GET") {
        const exported = await exportContactCsv(pool, user, {}, url.searchParams.get("segment_id"));
        // The file name carries the segment ID, never its name.
        const scope = exported.segmentId === null ? "" : `segment-${exported.segmentId}-`;
        return new Response(exported.body, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": `attachment; filename="auto-chatter-contacts-v1-${scope}${exported.exportedAt.slice(0, 10)}.csv"`,
          },
        });
      }
      if (url.pathname === "/api/contacts/import-preview" && request.method === "POST") {
        if (url.searchParams.size) throw new ApiError(400, "invalid_contact_import_request");
        return json(await previewContactCsv(pool, user, await readJson(request, CONTACT_IMPORT_REQUEST_BYTES)));
      }
      if (url.pathname === "/api/contacts/import" && request.method === "POST") {
        if (url.searchParams.size) throw new ApiError(400, "invalid_contact_import_request");
        // A rejected or stale file answers with the fresh per-row result, as a stale expected_version answers with the current state.
        const outcome = await applyContactCsv(pool, user, await readJson(request, CONTACT_IMPORT_APPLY_REQUEST_BYTES));
        return json(outcome.body, outcome.status);
      }
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
        return json(await createContactSegment(pool, user, await readJson(request, SEGMENT_REQUEST_BYTES)), 201);
      const segment = /^\/api\/contact-segments\/([a-f0-9-]+)$/.exec(url.pathname);
      if (segment && request.method === "DELETE") return json(await archiveContactSegment(pool, user, segment[1]!));
      if (segment && request.method === "PUT") {
        const saved = await updateContactSegment(
          pool,
          user,
          segment[1]!,
          await readJson(request, SEGMENT_REQUEST_BYTES),
        );
        // A stale expected_version answers with the current segment, like the label rule.
        return saved.conflict ? json({ error: "segment_conflict", segment: saved.segment }, 409) : json(saved.segment);
      }
      const segmentSnapshots = /^\/api\/contact-segments\/([a-f0-9-]+)\/snapshots$/.exec(url.pathname);
      if (segmentSnapshots && request.method === "GET")
        return json({ snapshots: await listSegmentSnapshots(pool, user, segmentSnapshots[1]!) });
      if (segmentSnapshots && request.method === "POST") {
        // The dashboard sends no body; a zero-length body needs no Content-Type, and any other body must be exactly {}.
        const input = await readOptionalJson(request, 1024);
        return json(await createSegmentSnapshot(pool, user, segmentSnapshots[1]!, input), 201);
      }
      if (snapshotCsv && request.method === "GET") {
        const exported = await exportSegmentSnapshotCsv(pool, user, snapshotCsv[1]!);
        return new Response(exported.body, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": `attachment; filename="auto-chatter-segment-snapshot-${exported.snapshotId}-${exported.asOf.slice(0, 10)}.csv"`,
          },
        });
      }
      // Every snapshot of the workspace, archived segments' included, with the usage the freeze limits count.
      if (url.pathname === "/api/segment-snapshots" && request.method === "GET")
        return json(await listWorkspaceSegmentSnapshots(pool, user, url.searchParams));
      const segmentSnapshot = /^\/api\/segment-snapshots\/([a-f0-9-]+)$/.exec(url.pathname);
      if (segmentSnapshot && request.method === "GET")
        return json(await getSegmentSnapshot(pool, user, segmentSnapshot[1]!, url.searchParams));
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
      if (contact && ["GET", "PATCH"].includes(request.method)) {
        let senderId: string;
        try {
          senderId = decodeURIComponent(contact[2]!);
        } catch {
          throw new ApiError(400, "invalid_contact_request");
        }
        if (request.method === "GET")
          return json(await contactDetails(pool, user, contact[1]!, senderId, url.searchParams));
        return json(await saveContactTags(pool, user, contact[1]!, senderId, await readJson(request)));
      }
      if (url.pathname === "/api/flows" && request.method === "GET")
        return json({ flows: await listFlows(pool, user) });
      if (url.pathname === "/api/flows" && request.method === "POST")
        return json(await createFlow(pool, user, await readJson(request, FLOW_REQUEST_BYTES)), 201);
      const flow =
        /^\/api\/flows\/([a-f0-9-]+)(?:\/(publish|versions|enable|disable|runs|test-run)(?:\/(\d{1,9}))?)?$/.exec(
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
      if (flow?.[2] === "test-run" && !flow[3] && request.method === "POST") {
        const tested = await testFlowRun(pool, user, flow[1]!, await readJson(request, FLOW_REQUEST_BYTES));
        return json(tested, "errors" in tested ? 422 : 200);
      }
      if (url.pathname === "/api/webhooks/endpoints" && request.method === "GET")
        return json({ endpoints: await listWebhookEndpoints(pool, user) });
      if (url.pathname === "/api/webhooks/endpoints" && request.method === "POST")
        return json(await createWebhookEndpoint(pool, user, await readJson(request), env), 201);
      const webhookEndpoint = /^\/api\/webhooks\/endpoints\/([a-f0-9-]+)\/(rotate|retire|enable|disable)$/.exec(
        url.pathname,
      );
      if (webhookEndpoint && request.method === "POST") {
        if (webhookEndpoint[2] === "rotate")
          return json(await rotateWebhookKey(pool, user, webhookEndpoint[1]!, env), 201);
        if (webhookEndpoint[2] === "retire") return json(await retireWebhookKey(pool, user, webhookEndpoint[1]!));
        return json(await setWebhookEndpointActive(pool, user, webhookEndpoint[1]!, webhookEndpoint[2] === "enable"));
      }
      if (url.pathname === "/api/webhooks/deliveries" && request.method === "GET")
        return json({ deliveries: await listWebhookDeliveries(pool, user) });
      const redelivery = /^\/api\/webhooks\/deliveries\/([a-f0-9-]+)\/redeliver$/.exec(url.pathname);
      if (redelivery && request.method === "POST") return json(await redeliverWebhook(pool, user, redelivery[1]!));
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
        // Every request reads Instagram Graph. The rule list looks up each visible rule's post, so single-post
        // lookups have their own allowance; the lookup on rule save above is not counted.
        await spendUserAllowance(
          env.AUTH_IP_LIMIT,
          media[2] ? `connection-media-item:${user.id}` : `connection-media:${user.id}`,
          { limited: "media_rate_limited", unavailable: "media_unavailable" },
        );
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
      ["instagram_authorization_denied", "instagram_permissions_required", "connection_limit_reached"].includes(
        error.message,
      )
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
    // SQL/provider errors can contain submitted content or credentials, so only a fixed code is logged.
    logOperation({
      event: "request_failed",
      code: failureCode(error),
      correlation_id: correlationId,
    });
    return json({ error: "service_unavailable" }, 503);
  }
}
