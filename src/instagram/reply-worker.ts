import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";
import { evaluatePrivateReply } from "./reply-policy.ts";

export interface PrivateReplyRequest {
  id: string;
  workspaceId: string;
  connectionId: string;
  accountId: string;
  commentId: string;
  mediaId: string;
  senderId: string;
  text: string;
}

export interface PrivateReplyTransport {
  // Read-only verification must check current Meta authorization, comment creation time, and media ownership.
  verify(request: PrivateReplyRequest): Promise<{
    commentCreatedAt: Date | null;
    authorizationVerified: boolean;
    mediaOwned: boolean;
  }>;
  send(request: PrivateReplyRequest): Promise<{ messageId: string }>;
}

interface ClaimedRow {
  id: string;
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

export async function processNextPrivateReply(
  pool: Pool,
  transport: PrivateReplyTransport,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const attemptId = randomUUID();
  const claimed = await pool.query<ClaimedRow>(
    `WITH candidate AS (
       SELECT id FROM private_reply_outbox
       WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE private_reply_outbox AS reply
     SET status = 'sending', attempt_id = $1, attempt_started_at = now(), failure_code = NULL
     FROM candidate
     WHERE reply.id = candidate.id
     RETURNING reply.id, reply.workspace_id, reply.connection_id, reply.comment_id,
       reply.media_id, reply.sender_id, reply.private_reply_text`,
    [attemptId],
  );
  const row = claimed.rows[0];
  if (!row) return false;

  const connectionResult = await pool.query<ConnectionRow>(
    "SELECT account_id, active FROM instagram_connections WHERE id = $1 AND workspace_id = $2",
    [row.connection_id, row.workspace_id],
  );
  const connection = connectionResult.rows[0];
  if (!connection) throw new Error("Claimed reply has no connection");
  const request: PrivateReplyRequest = {
    id: row.id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    accountId: connection.account_id,
    commentId: row.comment_id,
    mediaId: row.media_id,
    senderId: row.sender_id,
    text: row.private_reply_text,
  };

  if (!connection.active) {
    await updateClaim(pool,
      "UPDATE private_reply_outbox SET status = 'blocked', failure_code = 'inactive_connection' WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
      [row.id, attemptId]);
    return true;
  }

  let verification;
  try {
    verification = await transport.verify(request);
  } catch {
    await updateClaim(pool,
      "UPDATE private_reply_outbox SET status = 'pending', attempt_id = NULL, attempt_started_at = NULL, next_attempt_at = now() + interval '1 minute', failure_code = 'verification_failed' WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
      [row.id, attemptId]);
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
    isOwnComment: request.senderId === request.accountId,
  });
  if (!policy.eligible) {
    await updateClaim(pool,
      "UPDATE private_reply_outbox SET status = 'blocked', failure_code = $3 WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
      [row.id, attemptId, policy.reason]);
    return true;
  }

  let messageId: string;
  try {
    const sent = await transport.send(request);
    if (typeof sent.messageId !== "string" || !sent.messageId.trim()) throw new Error("Provider message ID missing");
    messageId = sent.messageId;
  } catch {
    await updateClaim(pool,
      "UPDATE private_reply_outbox SET status = 'unknown', failure_code = 'send_outcome_unknown' WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
      [row.id, attemptId]);
    return true;
  }

  await updateClaim(pool,
    "UPDATE private_reply_outbox SET status = 'sent', provider_message_id = $3, sent_at = now(), failure_code = NULL WHERE id = $1 AND status = 'sending' AND attempt_id = $2",
    [row.id, attemptId, messageId]);
  return true;
}

export async function recoverStalePrivateReplies(pool: Pool, olderThan: Date): Promise<number> {
  const result = await pool.query(
    "UPDATE private_reply_outbox SET status = 'unknown', failure_code = 'worker_interrupted' WHERE status = 'sending' AND attempt_started_at < $1",
    [olderThan],
  );
  return result.rowCount ?? 0;
}

export async function runPrivateReplyWorker(
  pool: Pool,
  transport: PrivateReplyTransport,
  signal: AbortSignal,
  pollIntervalMs = 1000,
): Promise<void> {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error("pollIntervalMs must be a positive integer");
  await recoverStalePrivateReplies(pool, new Date(Date.now() - 10 * 60_000));
  while (!signal.aborted) {
    if (await processNextPrivateReply(pool, transport)) continue;
    try {
      await sleep(pollIntervalMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
