import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";
import {
  clearExpiredUnmatchedReplies,
  processNextFollowReply,
  reconcileUnmatchedReplies,
  recoverStaleFollowReplies,
} from "./follow-flow.ts";
import type { FollowTransport } from "./follow-transport.ts";
import { deliveryRecipientOptedOut } from "./channel-consent.ts";
import { evaluatePrivateReply } from "./reply-policy.ts";
import { failureCode, logOperation } from "../app/operations-log.ts";

export interface PrivateReplyRequest {
  attemptId?: string;
  id: string;
  workspaceId: string;
  connectionId: string;
  accountId: string;
  commentId: string;
  mediaId: string;
  senderId: string;
  text: string;
  confirmationButtonTitle?: string;
}

export interface PrivateReplyTransport {
  readonly supportsFollowReplies?: boolean;
  // Read-only verification must check current Meta authorization, comment creation time, and media ownership.
  verify(request: PrivateReplyRequest): Promise<{
    commentCreatedAt: Date | null;
    authorizationVerified: boolean;
    mediaOwned: boolean;
    isOwnComment?: boolean;
  }>;
  // Throw PreSendVerificationError only before making a provider send request.
  send(request: PrivateReplyRequest): Promise<{ messageId: string; recipientId?: string }>;
}

export class PreSendVerificationError extends Error {
  readonly disposition: "retry" | "block";
  readonly failureCode: string;

  constructor(disposition: "retry" | "block" = "retry", failureCode = "verification_failed") {
    super("Private reply pre-send verification failed");
    this.name = "PreSendVerificationError";
    this.disposition = disposition;
    this.failureCode = failureCode;
  }
}

export class ProviderRejectedError extends Error {
  readonly failureCode: string;

  constructor(metaCode: number) {
    super("Meta Graph send rejected");
    this.name = "ProviderRejectedError";
    this.failureCode = `meta_error_${metaCode}`;
  }
}

// The transport treats a structured 4xx throttle response as a retryable refusal.
export class ProviderRateLimitedError extends Error {
  readonly failureCode: string;
  readonly retryAfterSeconds: number | null;

  constructor(metaCode: number, retryAfterSeconds: number | null = null) {
    super("Meta Graph send rate limited");
    this.name = "ProviderRateLimitedError";
    this.failureCode = `meta_error_${metaCode}`;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// One entry per allowed retry after a rate-limited send; the reply fails once these are used up.
const rateLimitRetryDelaysSeconds = [15 * 60, 60 * 60, 4 * 60 * 60] as const;

interface ClaimedRow {
  follow_config: unknown;
  id: string;
  rate_limit_retries: number;
  workspace_id: string;
  connection_id: string;
  comment_id: string;
  media_id: string;
  sender_id: string;
  private_reply_text: string;
}

interface ConnectionRow {
  account_id: string;
  active: boolean;
}

async function updateClaim(pool: Pool, sql: string, parameters: readonly unknown[]): Promise<void> {
  const result = await pool.query(sql, [...parameters]);
  if (result.rowCount !== 1) throw new Error("Private reply claim was lost");
}

async function privateReplyRecipientOptedOut(pool: Pool, row: ClaimedRow): Promise<boolean> {
  return deliveryRecipientOptedOut(pool, {
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    senderId: row.sender_id,
  });
}

export async function processNextPrivateReply(
  pool: Pool,
  transport: PrivateReplyTransport,
  now: () => Date = () => new Date(),
  connectionId: string,
  correlationId?: string,
): Promise<boolean> {
  if (!connectionId) throw new Error("Instagram connection ID is required");
  const attemptId = randomUUID();
  const claimed = await pool.query<ClaimedRow>(
    `WITH candidate AS (
       SELECT id FROM private_reply_outbox AS candidate_reply
       WHERE status = 'pending' AND next_attempt_at <= now()
         AND connection_id = $2
         AND NOT EXISTS (SELECT 1 FROM instagram_contact_automation automation
           WHERE automation.workspace_id=candidate_reply.workspace_id AND automation.connection_id=candidate_reply.connection_id
             AND automation.sender_id=candidate_reply.sender_id AND (automation.paused OR automation.handoff_paused))
         AND NOT EXISTS (
           SELECT 1 FROM instagram_connections AS connection
           WHERE connection.id = $2 AND connection.send_paused_until > now()
         )
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE private_reply_outbox AS reply
     SET status = 'sending', attempt_id = $1, attempt_started_at = now(), failure_code = NULL
     FROM candidate
     WHERE reply.id = candidate.id
     RETURNING reply.id, reply.workspace_id, reply.connection_id, reply.comment_id,
       reply.media_id, reply.sender_id, reply.private_reply_text, reply.rate_limit_retries, reply.follow_config`,
    [attemptId, connectionId],
  );
  const row = claimed.rows[0];
  if (!row) return false;
  const stopForConsent = async (): Promise<boolean> => {
    let optedOut: boolean;
    try {
      optedOut = await privateReplyRecipientOptedOut(pool, row);
    } catch {
      await updateClaim(
        pool,
        "UPDATE private_reply_outbox SET status='pending',attempt_id=NULL,attempt_started_at=NULL,next_attempt_at=now()+interval '1 minute',failure_code='consent_unavailable' WHERE id=$1 AND status='sending' AND attempt_id=$2",
        [row.id, attemptId],
      );
      return true;
    }
    if (!optedOut) return false;
    await updateClaim(
      pool,
      "UPDATE private_reply_outbox SET status='blocked',failure_code='recipient_opted_out' WHERE id=$1 AND status='sending' AND attempt_id=$2",
      [row.id, attemptId],
    );
    return true;
  };
  if (await stopForConsent()) return true;
  if (row.follow_config && transport.supportsFollowReplies === false) {
    await updateClaim(
      pool,
      "UPDATE private_reply_outbox SET status='blocked',failure_code='follow_requires_instagram_login' WHERE id=$1 AND status='sending' AND attempt_id=$2",
      [row.id, attemptId],
    );
    return true;
  }

  const connectionResult = await pool.query<ConnectionRow>(
    "SELECT account_id, active FROM instagram_connections WHERE id = $1 AND workspace_id = $2",
    [row.connection_id, row.workspace_id],
  );
  const connection = connectionResult.rows[0];
  if (!connection) throw new Error("Claimed reply has no connection");
  const request: PrivateReplyRequest = {
    attemptId,
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    accountId: connection.account_id,
    commentId: row.comment_id,
    mediaId: row.media_id,
    senderId: row.sender_id,
    text: row.private_reply_text,
    ...(row.follow_config &&
    typeof row.follow_config === "object" &&
    "confirmation_button_title" in row.follow_config &&
    typeof row.follow_config.confirmation_button_title === "string"
      ? { confirmationButtonTitle: row.follow_config.confirmation_button_title }
      : {}),
  };

  if (!connection.active) {
    await updateClaim(
      pool,
      "UPDATE private_reply_outbox SET status = 'blocked', failure_code = 'inactive_connection' WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
      [row.id, attemptId],
    );
    return true;
  }

  let verification;
  try {
    verification = await transport.verify(request);
  } catch {
    await updateClaim(
      pool,
      "UPDATE private_reply_outbox SET status = 'pending', attempt_id = NULL, attempt_started_at = NULL, next_attempt_at = now() + interval '1 minute', failure_code = 'verification_failed' WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
      [row.id, attemptId],
    );
    return true;
  }

  const currentConnection = await pool.query<{ active: boolean }>(
    "SELECT active FROM instagram_connections WHERE id = $1 AND workspace_id = $2",
    [row.connection_id, row.workspace_id],
  );
  const policy = evaluatePrivateReply({
    now: now(),
    commentCreatedAt: verification.commentCreatedAt,
    connectionActive: currentConnection.rows[0]?.active === true,
    authorizationVerified: verification.authorizationVerified,
    mediaOwned: verification.mediaOwned,
    isOwnComment: verification.isOwnComment === true || request.senderId === request.accountId,
  });
  if (!policy.eligible) {
    await updateClaim(
      pool,
      "UPDATE private_reply_outbox SET status = 'blocked', failure_code = $3 WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
      [row.id, attemptId, policy.reason],
    );
    return true;
  }

  if (await stopForConsent()) return true;

  const contactDeferred = await pool.query(
    `UPDATE private_reply_outbox reply SET status='pending',attempt_id=NULL,attempt_started_at=NULL,
       next_attempt_at=now()+interval '1 minute',failure_code='contact_paused'
     WHERE reply.id=$1 AND reply.status='sending' AND reply.attempt_id=$2
       AND EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
         AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND (automation.paused OR automation.handoff_paused))`,
    [row.id, attemptId],
  );
  if (contactDeferred.rowCount === 1) return true;

  // Another worker may have paused this connection while this reply was being verified.
  // Defer work that has not entered send(); requests already in progress cannot be recalled.
  const deferred = await pool.query(
    `UPDATE private_reply_outbox AS reply
     SET status = 'pending', attempt_id = NULL, attempt_started_at = NULL,
       next_attempt_at = GREATEST(reply.next_attempt_at, connection.send_paused_until),
       failure_code = 'connection_paused'
     FROM instagram_connections AS connection
     WHERE reply.id = $1 AND reply.status = 'sending' AND reply.attempt_id = $2
       AND connection.id = reply.connection_id AND connection.workspace_id = reply.workspace_id
       AND connection.send_paused_until > now()`,
    [row.id, attemptId],
  );
  if (deferred.rowCount === 1) return true;

  // A reply comes from a legacy rule or a flow run; either source must still be switched on.
  // A flow run keeps its pinned version, so republishing does not stop it and disabling does.
  const source = await pool.query<{ enabled: boolean | null; from_flow: boolean }>(
    `SELECT coalesce(rule.enabled,flow.enabled) AS enabled,reply.flow_run_id IS NOT NULL AS from_flow
     FROM private_reply_outbox reply
     LEFT JOIN instagram_comment_rules rule ON rule.id=reply.rule_id
     LEFT JOIN flow_runs run ON run.id=reply.flow_run_id
     LEFT JOIN flows flow ON flow.id=run.flow_id
     WHERE reply.id=$1`,
    [row.id],
  );
  if (source.rows[0]?.enabled !== true) {
    await updateClaim(
      pool,
      "UPDATE private_reply_outbox SET status='blocked',failure_code=$3 WHERE id=$1 AND status='sending' AND attempt_id=$2",
      [row.id, attemptId, source.rows[0]?.from_flow ? "inactive_flow" : "inactive_rule"],
    );
    return true;
  }
  let messageId: string;
  let recipientId: string | null = null;
  try {
    const sent = await transport.send(request);
    if (typeof sent.messageId !== "string" || !sent.messageId.trim()) throw new Error("Provider message ID missing");
    messageId = sent.messageId;
    if (typeof sent.recipientId === "string" && /^\d+$/.test(sent.recipientId)) recipientId = sent.recipientId;
  } catch (error) {
    if (error instanceof PreSendVerificationError) {
      if (error.disposition === "retry") {
        await updateClaim(
          pool,
          "UPDATE private_reply_outbox SET status = 'pending', attempt_id = NULL, attempt_started_at = NULL, next_attempt_at = now() + interval '1 minute', failure_code = $3 WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
          [row.id, attemptId, error.failureCode],
        );
      } else {
        await updateClaim(
          pool,
          "UPDATE private_reply_outbox SET status = 'blocked', failure_code = $3 WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
          [row.id, attemptId, error.failureCode],
        );
      }
      return true;
    }
    if (error instanceof ProviderRateLimitedError) {
      const retries = row.rate_limit_retries;
      const tier = rateLimitRetryDelaysSeconds[Math.min(retries, rateLimitRetryDelaysSeconds.length - 1)]!;
      const delaySeconds = Math.max(tier, error.retryAfterSeconds ?? 0);
      const replyUpdate =
        retries < rateLimitRetryDelaysSeconds.length
          ? "UPDATE private_reply_outbox SET status = 'pending', attempt_id = NULL, attempt_started_at = NULL, next_attempt_at = now() + make_interval(secs => $4), rate_limit_retries = rate_limit_retries + 1, failure_code = $3"
          : "UPDATE private_reply_outbox SET status = 'failed', failure_code = $3";
      // The limit applies to the connection, so hold its other replies instead of letting each spend its own retries.
      // One statement keeps the reply state and the connection pause atomic.
      await updateClaim(
        pool,
        `WITH reply AS (
           ${replyUpdate} WHERE id = $1 AND status = 'sending' AND attempt_id = $2 RETURNING connection_id
         ), paused AS (
           UPDATE instagram_connections SET send_paused_until = GREATEST(send_paused_until, now() + make_interval(secs => $4))
           WHERE id IN (SELECT connection_id FROM reply)
         )
         SELECT 1 FROM reply`,
        [row.id, attemptId, error.failureCode, delaySeconds],
      );
      return true;
    }
    if (error instanceof ProviderRejectedError) {
      await updateClaim(
        pool,
        "UPDATE private_reply_outbox SET status = 'failed', failure_code = $3 WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
        [row.id, attemptId, error.failureCode],
      );
      return true;
    }
    await updateClaim(
      pool,
      "UPDATE private_reply_outbox SET status = 'unknown', failure_code = 'send_outcome_unknown' WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
      [row.id, attemptId],
    );
    return true;
  }

  await updateClaim(
    pool,
    `WITH sent AS (
      UPDATE private_reply_outbox SET status='sent',provider_message_id=$3,recipient_id=$4,sent_at=now(),failure_code=CASE WHEN follow_config IS NOT NULL AND $4::text IS NULL THEN 'follow_recipient_unavailable' ELSE NULL END
      WHERE id=$1 AND status='sending' AND attempt_id=$2 RETURNING *
    ), conversations AS (
      INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text,confirmation_button_title)
      SELECT id,connection_id,recipient_id,follow_config->>'confirmation_keyword',follow_config->>'follower_reply_text',follow_config->>'non_follower_reply_text',COALESCE(follow_config->>'confirmation_button_title','')
      FROM sent WHERE follow_config IS NOT NULL AND recipient_id IS NOT NULL
      ON CONFLICT DO NOTHING
    ) SELECT id FROM sent`,
    [row.id, attemptId, messageId, recipientId],
  );
  // A DM answering this reply may have arrived while it was being sent (#108). The sent state above is
  // already committed, so a failure here only leaves the DM to the scheduled reconcile.
  if (recipientId) {
    try {
      await reconcileUnmatchedReplies(pool, { replyId: row.id });
    } catch (error) {
      // Scheduled recovery retries it.
      logOperation({
        event: "early_reply_reconcile_failed",
        code: failureCode(error),
        correlation_id: correlationId,
        connection_id: row.connection_id,
      });
    }
  }
  return true;
}

export async function recoverStalePrivateReplies(pool: Pool, olderThan: Date, connectionId: string): Promise<number> {
  if (!connectionId) throw new Error("Instagram connection ID is required");
  const result = await pool.query(
    "UPDATE private_reply_outbox SET status = 'unknown', failure_code = 'worker_interrupted' WHERE status = 'sending' AND attempt_started_at < $1 AND connection_id = $2",
    [olderThan, connectionId],
  );
  return result.rowCount ?? 0;
}

export async function runPrivateReplyWorker(
  pool: Pool,
  transport: PrivateReplyTransport,
  signal: AbortSignal,
  pollIntervalMs = 1000,
  connectionId: string,
  options: {
    recoveryIntervalMs?: number;
    now?: () => Date;
    follow?: { accountId: string; transport: FollowTransport };
  } = {},
): Promise<void> {
  if (!connectionId) throw new Error("Instagram connection ID is required");
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1)
    throw new Error("pollIntervalMs must be a positive integer");
  const recoveryIntervalMs = options.recoveryIntervalMs ?? 60_000;
  if (!Number.isInteger(recoveryIntervalMs) || recoveryIntervalMs < 1)
    throw new Error("recoveryIntervalMs must be a positive integer");
  const now = options.now ?? (() => new Date());
  const recover = async (at: Date) => {
    const correlationId = randomUUID();
    await recoverStalePrivateReplies(pool, at, connectionId);
    if (options.follow) await recoverStaleFollowReplies(pool, at, connectionId);
    // This loop is the Node deployment's only schedule, so it also links and expires the DMs kept while
    // this connection's replies were being sent (#108).
    try {
      await reconcileUnmatchedReplies(pool, { connectionId });
    } catch (error) {
      // The next recovery retries it.
      logOperation({
        event: "early_reply_reconcile_failed",
        code: failureCode(error),
        correlation_id: correlationId,
        connection_id: connectionId,
        step: "early_reply_reconcile",
      });
    }
    await clearExpiredUnmatchedReplies(pool, connectionId);
  };
  await recover(new Date(now().getTime() - 10 * 60_000));
  let nextRecoveryAt = now().getTime() + recoveryIntervalMs;
  while (!signal.aborted) {
    const currentTime = now().getTime();
    if (currentTime >= nextRecoveryAt) {
      await recover(new Date(currentTime - 10 * 60_000));
      nextRecoveryAt = currentTime + recoveryIntervalMs;
    }
    const followed = options.follow
      ? await processNextFollowReply(pool, connectionId, options.follow.transport, now, options.follow.accountId)
      : false;
    if (signal.aborted) break;
    const replied = await processNextPrivateReply(pool, transport, now, connectionId);
    if (followed || replied) continue;
    try {
      await sleep(pollIntervalMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
