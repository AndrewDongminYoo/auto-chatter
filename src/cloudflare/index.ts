import {
  processNextManualReply,
  assertManualReplyAllowed,
  recoverStaleManualReplies,
} from "../instagram/manual-reply-worker.ts";
import { instagramAdapter, partitionInstagramEvents } from "../instagram/channel-adapter.ts";
import {
  clearExpiredUnmatchedReplies,
  ingestMessages,
  processNextFollowReply,
  reconcileUnmatchedReplies,
  recoverStaleFollowReplies,
} from "../instagram/follow-flow.ts";
import { readMetaGraphError } from "../instagram/meta-graph-error.ts";
import { refreshDueInstagramTokensWithFailures } from "../app/instagram-token-refresh.ts";
import { deliveryRecipientOptedOut } from "../instagram/channel-consent.ts";
export interface Env extends AuthEnv, InstagramOAuthEnv {
  AUTH_IP_LIMIT: { limit(input: { key: string }): Promise<{ success: boolean }> };
  AUTH_EMAIL_LIMIT: { limit(input: { key: string }): Promise<{ success: boolean }> };
  HYPERDRIVE: { connectionString: string };
  REPLY_QUEUE: { send(body: { connectionId: string }): Promise<void> };
  INSTAGRAM_APP_SECRET: string;
  INSTAGRAM_VERIFY_TOKEN: string;
  META_INSTAGRAM_CONNECTION_ID: string;
  META_INSTAGRAM_ACCOUNT_ID: string;
  META_GRAPH_VERSION: string;
  META_INSTAGRAM_ACCESS_TOKEN: string;
  SEND_ENABLED: string;
}

export interface ReplyBatch {
  messages: readonly { body: unknown; ack(): void; retry(options: { delaySeconds: number }): void }[];
}

function openPool(env: Env, correlationId?: string): Pool {
  // Connections belong to one invocation; Hyperdrive owns the upstream pool.
  const pool = new Pool({
    connectionString: env.HYPERDRIVE.connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
  pool.on("error", () =>
    logOperation({ event: "database_connection_error", code: "database_unavailable", correlation_id: correlationId }),
  );
  return pool;
}

async function tokenRotated(pool: Pool, connectionId: string, encryptedToken: string): Promise<boolean> {
  const current = await pool.query<{ rotated: boolean }>(
    `SELECT access_token_encrypted IS DISTINCT FROM $2 AS rotated FROM instagram_connections
     WHERE id=$1 AND active AND send_enabled AND token_expires_at>now()
       AND (send_paused_until IS NULL OR send_paused_until<=now())`,
    [connectionId, encryptedToken],
  );
  return current.rows[0]?.rotated === true;
}

async function wakeDueReplies(
  pool: Pool,
  env: Env,
  scope?: { connectionId: string } | { accountIds: string[] },
): Promise<void> {
  if (env.SEND_ENABLED !== "true") return;
  const due = await pool.query<{ id: string }>(
    `SELECT c.id FROM instagram_connections c
     WHERE ($1::uuid IS NULL OR c.id=$1) AND ($2::text[] IS NULL OR c.account_id=ANY($2))
       AND (c.send_paused_until IS NULL OR c.send_paused_until<=now())
       AND (EXISTS(SELECT 1 FROM instagram_manual_replies manual WHERE manual.connection_id=c.id AND manual.status='pending' AND manual.next_attempt_at<=now()
         AND NOT EXISTS(SELECT 1 FROM instagram_manual_replies earlier WHERE earlier.workspace_id=manual.workspace_id AND earlier.connection_id=manual.connection_id AND earlier.recipient_id=manual.recipient_id
           AND (earlier.created_at,earlier.id)<(manual.created_at,manual.id) AND (earlier.status IN ('pending','sending') OR (earlier.status='unknown' AND earlier.resolved_at IS NULL))))
       OR (c.send_enabled AND c.access_token_encrypted IS NOT NULL AND c.token_expires_at>now()
       AND (EXISTS(SELECT 1 FROM private_reply_outbox reply WHERE reply.connection_id=c.id AND reply.status='pending' AND reply.next_attempt_at<=now()
         AND NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
           AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND (automation.paused OR automation.handoff_paused)))
       OR EXISTS(SELECT 1 FROM instagram_follow_conversations flow JOIN private_reply_outbox reply ON reply.id=flow.reply_id
         WHERE flow.connection_id=c.id AND flow.status='pending' AND flow.next_attempt_at<=now()
         AND NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
           AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND (automation.paused OR automation.handoff_paused))))))
     ORDER BY c.id LIMIT 100`,
    [
      scope && "connectionId" in scope ? scope.connectionId : null,
      scope && "accountIds" in scope ? scope.accountIds : null,
    ],
  );
  for (const row of due.rows) await env.REPLY_QUEUE.send({ connectionId: row.id });
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function receive(request: Request, env: Env, correlationId: string): Promise<Response> {
  const page = publicPage(request);
  if (page) return page;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/"))
    return appApi(
      request,
      env,
      (poolCorrelationId) => openPool(env, poolCorrelationId),
      fetch,
      async (connectionId) => {
        if (env.SEND_ENABLED === "true") await env.REPLY_QUEUE.send({ connectionId });
      },
      correlationId,
    );
  if (url.pathname !== "/webhooks/instagram") return new Response(null, { status: 404 });
  if (!env.INSTAGRAM_APP_SECRET || !env.INSTAGRAM_VERIFY_TOKEN) throw new ConfigurationError("Webhook secrets missing");
  if (request.method === "GET") {
    const challenge = verifySubscription(url.searchParams, env.INSTAGRAM_VERIFY_TOKEN);
    return new Response(challenge, { status: challenge === null ? 403 : 200 });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  const body = await readBody(request);
  if (body === null) return new Response(null, { status: 413 });
  if (!verifySignature(body, request.headers.get("x-hub-signature-256"), env.INSTAGRAM_APP_SECRET))
    return new Response(null, { status: 403 });
  let comments;
  let messages;
  try {
    ({ comments, messages } = partitionInstagramEvents(instagramAdapter.decodeWebhook(body)));
  } catch {
    return new Response(null, { status: 400 });
  }
  const pool = openPool(env, correlationId);
  try {
    await ingestComments(pool, comments);
    await ingestMessages(pool, messages);
    try {
      await wakeDueReplies(pool, env, {
        accountIds: [...new Set([...comments, ...messages].map((event) => event.accountId))],
      });
    } catch {
      // The commit is durable. Cron repairs the DB-to-Queue publication gap.
      logOperation({ event: "queue_publish_failed", code: "reply_notification_failed", correlation_id: correlationId });
    }
    return new Response(null, { status: 200 });
  } finally {
    await pool.end();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Cloudflare's request ID, so a log line can be matched to the invocation in Workers Logs.
    const correlationId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    try {
      return await receive(request, env, correlationId);
    } catch (error) {
      logOperation({ event: "request_failed", code: failureCode(error), correlation_id: correlationId });
      return new Response(null, { status: 503 });
    }
  },
  async queue(batch: ReplyBatch, env: Env): Promise<void> {
    const correlationId = crypto.randomUUID();
    for (const message of batch.messages) {
      if (env.SEND_ENABLED !== "true" || !isRecord(message.body) || !isUuid(message.body.connectionId)) {
        message.ack();
        continue;
      }
      try {
        const connectionId = (message.body as { connectionId: string }).connectionId;
        const pool = openPool(env, correlationId);
        try {
          const result = await pool.query(
            "SELECT id,workspace_id,account_id,access_token_encrypted,send_enabled,token_expires_at>now() AS token_valid FROM instagram_connections WHERE id=$1",
            [connectionId],
          );
          const connection = result.rows[0];
          if (
            connection &&
            (!connection.send_enabled || !connection.token_valid || !connection.access_token_encrypted)
          ) {
            await processNextManualReply(pool, connectionId, null, connection.access_token_encrypted);
          } else if (connection) {
            if (!env.TOKEN_ENCRYPTION_KEY) throw new ConfigurationError("Token encryption not configured");
            const accessToken = openSecret(
              connection.access_token_encrypted,
              env.TOKEN_ENCRYPTION_KEY,
              `${connection.workspace_id}:${connection.account_id}`,
            );
            const rawGraphFetch: typeof fetch = async (input, init) => {
              const response = await fetch(input, { ...init, redirect: "manual" });
              if (response.status >= 300 && response.status < 400) {
                await response.body?.cancel();
                throw new Error("Meta Graph redirect refused");
              }
              return response;
            };
            const graphFetch: typeof fetch = async (input, init) => {
              if (init?.method === "POST") {
                const current = await pool.query(
                  "SELECT 1 FROM instagram_connections WHERE id=$1 AND active AND send_enabled AND token_expires_at>now() AND access_token_encrypted=$2 AND (send_paused_until IS NULL OR send_paused_until<=now())",
                  [connectionId, connection.access_token_encrypted],
                );
                if (!current.rowCount)
                  throw (await tokenRotated(pool, connectionId, connection.access_token_encrypted))
                    ? new PreSendVerificationError("retry", "token_rotated")
                    : new PreSendVerificationError("block", "connection_changed");
                const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
                if (body?.recipient?.comment_id) {
                  // The reply's rule or flow must still be on; a flow run keeps its pinned version.
                  const rule = await pool.query(
                    `SELECT reply.workspace_id::text,reply.sender_id,reply.recipient_id,
                      coalesce(rule.enabled,flow.enabled) AS source_enabled,reply.flow_run_id IS NOT NULL AS from_flow,
                      NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
                      AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND (automation.paused OR automation.handoff_paused)) AS automation_active
                     FROM private_reply_outbox reply LEFT JOIN instagram_comment_rules rule ON rule.id=reply.rule_id
                     LEFT JOIN flow_runs run ON run.id=reply.flow_run_id LEFT JOIN flows flow ON flow.id=run.flow_id
                    WHERE reply.connection_id=$1 AND reply.comment_id=$2 AND reply.status='sending'`,
                    [connectionId, body.recipient.comment_id],
                  );
                  if (!rule.rowCount) throw new PreSendVerificationError("block", "inactive_rule");
                  if (rule.rows[0].source_enabled !== true)
                    throw new PreSendVerificationError(
                      "block",
                      rule.rows[0].from_flow ? "inactive_flow" : "inactive_rule",
                    );
                  if (rule.rows[0].automation_active === false)
                    throw new PreSendVerificationError("retry", "contact_paused");
                  const reply = rule.rows[0];
                  try {
                    if (
                      await deliveryRecipientOptedOut(pool, {
                        workspaceId: reply.workspace_id,
                        connectionId,
                        senderId: reply.sender_id,
                      })
                    )
                      throw new PreSendVerificationError("block", "recipient_opted_out");
                  } catch (error) {
                    if (error instanceof PreSendVerificationError) throw error;
                    throw new PreSendVerificationError("retry", "consent_unavailable");
                  }
                }
              }
              const response = await rawGraphFetch(input, init);
              const postError =
                init?.method === "POST" && response.status >= 400 && response.status < 500
                  ? await readMetaGraphError(response.clone())
                  : null;
              const definitePostRejection = postError?.code != null && !postError.transient;
              if (
                !response.ok &&
                (init?.method !== "POST" || definitePostRejection) &&
                (await tokenRotated(pool, connectionId, connection.access_token_encrypted))
              ) {
                await response.body?.cancel();
                throw new PreSendVerificationError("retry", "token_rotated");
              }
              return response;
            };
            const config = {
              graphVersion: env.META_GRAPH_VERSION,
              accessToken,
              accountId: connection.account_id,
              connectionId,
              fetchImpl: graphFetch,
            };
            // Manual replies own active handoff conversations and share the normal DM window.
            const manualProcessed = await processNextManualReply(
              pool,
              connectionId,
              new InstagramFollowTransport({
                ...config,
                fetchImpl: graphFetch,
                beforeSend: async (context) => {
                  if (env.SEND_ENABLED !== "true") throw new PreSendVerificationError("block", "global_send_disabled");
                  await assertManualReplyAllowed(
                    pool,
                    context.replyId,
                    context.attemptId,
                    connectionId,
                    connection.access_token_encrypted,
                  );
                },
              }),
              connection.access_token_encrypted,
            );
            // Follow confirmations have a shorter delivery window than comment private replies.
            if (
              !manualProcessed &&
              !(await processNextFollowReply(
                pool,
                connectionId,
                new InstagramFollowTransport({
                  ...config,
                  fetchImpl: graphFetch,
                  beforeSend: async (context) => {
                    const permitted = await pool.query(
                      `SELECT reply.workspace_id::text,reply.sender_id,flow.recipient_id,
                        NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
                  AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND (automation.paused OR automation.handoff_paused)) AS automation_active
                FROM instagram_follow_conversations flow
                JOIN private_reply_outbox reply ON reply.id=flow.reply_id JOIN instagram_comment_rules rule ON rule.id=reply.rule_id
                JOIN instagram_connections c ON c.id=flow.connection_id
                WHERE flow.reply_id=$1 AND flow.attempt_id=$2 AND flow.status='sending' AND flow.confirmed_at>now()-interval '24 hours'
                  AND rule.enabled AND c.id=$3 AND c.active AND c.send_enabled AND c.token_expires_at>now() AND c.access_token_encrypted=$4
                  AND (c.send_paused_until IS NULL OR c.send_paused_until<=now())`,
                      [context.replyId, context.attemptId, connectionId, connection.access_token_encrypted],
                    );
                    if (permitted.rows[0]?.automation_active === false)
                      throw new PreSendVerificationError("retry", "contact_paused");
                    if (!permitted.rowCount)
                      throw (await tokenRotated(pool, connectionId, connection.access_token_encrypted))
                        ? new PreSendVerificationError("retry", "token_rotated")
                        : new PreSendVerificationError("block", "delivery_not_permitted");
                    const reply = permitted.rows[0];
                    try {
                      if (
                        await deliveryRecipientOptedOut(pool, {
                          workspaceId: reply.workspace_id,
                          connectionId,
                          senderId: reply.sender_id,
                        })
                      )
                        throw new PreSendVerificationError("block", "recipient_opted_out");
                    } catch (error) {
                      if (error instanceof PreSendVerificationError) throw error;
                      throw new PreSendVerificationError("retry", "consent_unavailable");
                    }
                  },
                }),
              ))
            )
              await processNextPrivateReply(
                pool,
                new InstagramLoginPrivateReplyTransport(config),
                () => new Date(),
                connectionId,
                correlationId,
              );
          }
          await wakeDueReplies(pool, env, { connectionId });
        } finally {
          await pool.end();
        }
        message.ack();
      } catch (error) {
        logOperation({
          event: "queue_message_failed",
          code: failureCode(error),
          correlation_id: correlationId,
          connection_id: (message.body as { connectionId: string }).connectionId,
        });
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const correlationId = crypto.randomUUID();
    let failed: boolean;
    try {
      failed = await runScheduledSteps(env, correlationId);
    } catch (error) {
      // Only opening or closing the pool reaches here; its raw message stays out of the logs and the error.
      failed = true;
      logOperation({ event: "cron_run_failed", code: failureCode(error), correlation_id: correlationId });
    }
    if (failed) throw new Error("Cloudflare scheduled recovery failed");
  },
};

// Each step records its outcome in scheduled_steps and a failure never stops the later steps; the run still
// fails at the end so Cloudflare reports it. A failed record write is logged and fails the run too, because the
// stored outcome is then stale. Returns whether any step or record write failed.
async function runScheduledSteps(env: Env, correlationId: string): Promise<boolean> {
  const pool = openPool(env, correlationId);
  let failed = false;
  // Every fetch of this invocation goes through one counter, so webhook delivery claims only what the
  // subrequests left after token refresh can carry. A call is counted before it starts, also when it fails.
  let subrequests = 0;
  const countedFetch: typeof fetch = (input, init) => {
    subrequests++;
    return fetch(input, init);
  };
  const step = async (name: OperationStep, run: () => Promise<unknown>): Promise<void> => {
    let failure: string | null = null;
    try {
      await run();
    } catch (error) {
      failed = true;
      failure = failureCode(error);
      logOperation({ event: "cron_step_failed", code: failure, correlation_id: correlationId, step: name });
    }
    try {
      await recordStep(pool, name, failure);
    } catch (error) {
      failed = true;
      logOperation({
        event: "cron_step_record_failed",
        code: failureCode(error),
        correlation_id: correlationId,
        step: name,
      });
    }
  };
  try {
    // The text of a DM kept while its reply was being sent (#108) is removed after 15 minutes. This
    // runs first and needs no other configuration.
    await step("kept_reply_cleanup", () => clearExpiredUnmatchedReplies(pool));
    await step("token_refresh", async () => {
      if (!env.TOKEN_ENCRYPTION_KEY) throw new ConfigurationError("Token encryption not configured");
      // A connection is attempted at most once a day, so a failure fails only the run that attempted it.
      const { failed: refreshFailures } = await refreshDueInstagramTokensWithFailures(
        pool,
        env.TOKEN_ENCRYPTION_KEY,
        countedFetch,
        new Date(),
        env.META_GRAPH_VERSION,
      );
      if (refreshFailures > 0) throw new TokenRefreshFailedError();
    });
    // Linking a kept DM to its now-sent reply and resuming a delayed flow run only change state or
    // queue a reply, so they run while sending is off too. The link runs first: a DM that answered a reply
    // wait in time must reach the run before the resume times that wait out, and the resume holds a wait
    // for up to 15 minutes while a kept DM that may answer it is still unlinked.
    await step("early_reply_reconcile", () => reconcileUnmatchedReplies(pool));
    await step("flow_resume", () => resumeDueFlowRuns(pool));
    // With sending off, stale recovery, wake and webhook delivery do not run and keep their last recorded times.
    if (env.SEND_ENABLED === "true") {
      await step("stale_recovery", async () => {
        await pool.query(
          "UPDATE private_reply_outbox SET status='unknown',failure_code='worker_interrupted' WHERE status='sending' AND attempt_started_at<now()-interval '10 minutes'",
        );
        await recoverStaleManualReplies(pool);
        await recoverStaleFollowReplies(pool, new Date(Date.now() - 10 * 60_000));
      });
      await step("wake", () => wakeDueReplies(pool, env));
      // Outbound flow webhooks (#47) are delivered after every message step, so a slow or failing endpoint
      // cannot stop or delay a reply. They share the global send switch: with sending off nothing leaves.
      await step("webhook_delivery", async () => {
        if (!env.TOKEN_ENCRYPTION_KEY) throw new ConfigurationError("Token encryption not configured");
        await deliverDueWebhooks(pool, env.TOKEN_ENCRYPTION_KEY, {
          fetchImpl: countedFetch,
          correlationId,
          subrequestsLeft: () => CRON_SUBREQUEST_BUDGET - subrequests,
        });
      });
    }
    // The alerts step runs before the 'cron' row is written, so that row counts its failure too; a run whose
    // earlier steps all succeeded clears cron_stale in the same run.
    const succeeded = !failed;
    await step("alerts", () => evaluateAlerts(pool, env.SEND_ENABLED === "true", correlationId, succeeded));
    try {
      await recordStep(pool, "cron", failed ? "step_failed" : null);
    } catch (error) {
      failed = true;
      logOperation({ event: "cron_record_failed", code: failureCode(error), correlation_id: correlationId });
    }
  } finally {
    await pool.end();
  }
  return failed;
}
import { Pool } from "pg";
import { ingestComments, resumeDueFlowRuns } from "../instagram/store.ts";
import { verifySignature, verifySubscription } from "../instagram/webhook.ts";
import { processNextPrivateReply, PreSendVerificationError } from "../instagram/reply-worker.ts";
import { InstagramLoginPrivateReplyTransport } from "../instagram/instagram-login-private-reply.ts";
import { publicPage } from "./public-pages.ts";
import { appApi } from "../app/api.ts";
import type { AuthEnv } from "../app/auth.ts";
import type { InstagramOAuthEnv } from "../app/instagram-oauth.ts";

import { openSecret } from "../app/secrets.ts";
import { isRecord, isUuid } from "../app/auth.ts";
import { InstagramFollowTransport } from "../instagram/follow-transport.ts";
import {
  ConfigurationError,
  failureCode,
  logOperation,
  TokenRefreshFailedError,
  type OperationStep,
} from "../app/operations-log.ts";
import { evaluateAlerts, recordStep } from "../app/operations-health.ts";
import { CRON_SUBREQUEST_BUDGET, deliverDueWebhooks } from "../app/webhook-delivery.ts";
