import { PreSendVerificationError, ProviderRateLimitedError, ProviderRejectedError } from "./reply-worker.ts";
import { randomUUID } from "node:crypto";
import type { FollowSendContext } from "./follow-transport.ts";
import type { Pool } from "pg";
export interface ManualReplyScope {
  workspace_id: string;
  connection_id: string;
  recipient_id: string;
  handoff_version: number;
}
export async function manualReplyEligibility(
  pool: Pick<Pool, "query">,
  row: ManualReplyScope,
  claim?: { id: string; attempt: string; encryptedToken: string | null },
): Promise<string | null> {
  return (await manualReplyStatus(pool, row, claim)).failure_code;
}
export async function manualReplyStatus(
  pool: Pick<Pool, "query">,
  row: Omit<ManualReplyScope, "handoff_version"> & { handoff_version?: number },
  claim?: { id: string; attempt: string; encryptedToken: string | null },
) {
  const found = await pool.query(
    `WITH candidates AS (
      SELECT r.sender_id,r.sent_at>=c.inbox_enabled_at AS fresh FROM private_reply_outbox r
      JOIN instagram_connections c ON c.id=r.connection_id AND c.workspace_id=r.workspace_id
      JOIN instagram_comment_events e ON e.id=r.event_id AND e.workspace_id=r.workspace_id AND e.connection_id=r.connection_id AND e.sender_id=r.sender_id
      WHERE r.workspace_id=$1 AND r.connection_id=$2 AND r.recipient_id=$3 AND r.status='sent'
        AND r.provider_message_id IS NOT NULL AND length(btrim(r.provider_message_id))>0 AND r.sent_at<=clock_timestamp()
    ) SELECT c.active AS connection_active,c.inbox_enabled,c.send_enabled,c.access_token_encrypted,c.token_expires_at>clock_timestamp() AS token_valid,c.send_paused_until>clock_timestamp() AS cooldown,c.account_id,h.active AS handoff_active,h.version,h.sender_id,a.handoff_paused,
    (SELECT count(DISTINCT sender_id)=1 AND bool_or(fresh) AND min(sender_id)=h.sender_id FROM candidates) AS identity_verified,
    (SELECT max(message_at) FROM instagram_inbox_messages m WHERE m.workspace_id=c.workspace_id AND m.connection_id=c.id AND m.recipient_id=$3 AND m.kind='text') AS last_inbound,
    clock_timestamp() AS checked_at,
    EXISTS(SELECT 1 FROM instagram_manual_replies unresolved WHERE unresolved.workspace_id=c.workspace_id AND unresolved.connection_id=c.id AND unresolved.recipient_id=$3 AND unresolved.status='unknown' AND unresolved.resolved_at IS NULL) AS blocked_by_unknown
    FROM instagram_connections c LEFT JOIN instagram_inbox_handoffs h ON h.workspace_id=c.workspace_id AND h.connection_id=c.id AND h.recipient_id=$3
    LEFT JOIN instagram_contact_automation a ON a.workspace_id=h.workspace_id AND a.connection_id=h.connection_id AND a.sender_id=h.sender_id
    WHERE c.workspace_id=$1 AND c.id=$2
      AND ($4::text IS NULL OR c.access_token_encrypted=$4)
      AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM instagram_manual_replies claim WHERE claim.id=$5 AND claim.attempt_id=$6 AND claim.status='sending' AND claim.workspace_id=c.workspace_id AND claim.connection_id=c.id AND claim.recipient_id=$3))`,
    [
      row.workspace_id,
      row.connection_id,
      row.recipient_id,
      claim?.encryptedToken ?? null,
      claim?.id ?? null,
      claim?.attempt ?? null,
    ],
  );
  const current = found.rows[0];
  const last = current?.last_inbound instanceof Date ? current.last_inbound.getTime() : NaN;
  const expiry = last + 24 * 60 * 60_000;
  const result = (failure_code: string | null) => ({
    failure_code,
    handoff_active: current?.handoff_active === true,
    handoff_version: current?.version ?? 0,
    checked_at: current?.checked_at?.toISOString() ?? null,
    window_expires_at: Number.isFinite(expiry) && Math.abs(expiry) <= 8.64e15 ? new Date(expiry).toISOString() : null,
    blocked_by_unknown: current?.blocked_by_unknown === true,
  });
  if (!current && claim) return result("delivery_changed");
  if (!current || !current.connection_active || !current.inbox_enabled || !current.send_enabled)
    return result("connection_disabled");
  if (!current.access_token_encrypted || !current.token_valid) return result("token_unavailable");
  if (current.cooldown) return result("connection_paused");
  if (
    !current.handoff_active ||
    current.version !== (row.handoff_version ?? current.version) ||
    !current.handoff_paused
  )
    return result("handoff_changed");
  if (current.account_id === row.recipient_id) return result("invalid_recipient");
  const now = current.checked_at.getTime();
  if (!Number.isFinite(last) || last > now || now - last >= 24 * 60 * 60_000) return result("reply_window_closed");
  if (!current.identity_verified) return result("handoff_identity_unverified");
  return result(null);
}
export interface ManualReplyTransport {
  verifyAccount(): Promise<boolean>;
  send(recipient: string, text: string, context: FollowSendContext): Promise<{ messageId: string }>;
}
export async function assertManualReplyAllowed(
  pool: Pick<Pool, "query">,
  id: string,
  attempt: string,
  connection: string,
  encryptedToken: string | null,
): Promise<void> {
  const result = await pool.query(
    `SELECT r.workspace_id,r.connection_id,r.recipient_id,r.handoff_version FROM instagram_manual_replies r JOIN instagram_connections c ON c.id=r.connection_id AND c.workspace_id=r.workspace_id
    WHERE r.id=$1 AND r.attempt_id=$2 AND r.status='sending' AND r.connection_id=$3 AND c.access_token_encrypted IS NOT DISTINCT FROM $4`,
    [id, attempt, connection, encryptedToken],
  );
  const row = result.rows[0];
  if (!row) throw new PreSendVerificationError("block", "delivery_changed");
  const failure = await manualReplyEligibility(pool, row, { id, attempt, encryptedToken });
  if (failure) throw new PreSendVerificationError("block", failure);
}
export async function processNextManualReply(
  pool: Pool,
  connection: string,
  transport: ManualReplyTransport | null,
  encryptedToken: string | null,
): Promise<boolean> {
  const client = await pool.connect();
  let row;
  const attempt = randomUUID();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT r.* FROM instagram_manual_replies r JOIN instagram_connections c ON c.id=r.connection_id AND c.workspace_id=r.workspace_id
      WHERE r.connection_id=$1 AND r.status='pending' AND r.next_attempt_at<=clock_timestamp()
        AND (c.send_paused_until IS NULL OR c.send_paused_until<=clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM instagram_manual_replies earlier WHERE earlier.workspace_id=r.workspace_id AND earlier.connection_id=r.connection_id AND earlier.recipient_id=r.recipient_id
          AND (earlier.created_at,earlier.id)<(r.created_at,r.id) AND (earlier.status IN ('pending','sending') OR (earlier.status='unknown' AND earlier.resolved_at IS NULL)))
      ORDER BY r.created_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`,
      [connection],
    );
    row = result.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      "UPDATE instagram_manual_replies SET status='sending',attempt_id=$2,attempt_started_at=clock_timestamp(),failure_code=NULL,safe_to_retry=false WHERE id=$1",
      [row.id, attempt],
    );
    await client.query(
      "INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,attempt_id) VALUES($1,$2,$3,$4,'sending',$5)",
      [row.workspace_id, connection, row.recipient_id, row.id, attempt],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const finish = async (
    status: string,
    code: string | null,
    safe: boolean,
    messageId: string | null = null,
    cooldown: number | null = null,
  ) => {
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      // Match API/handoff lock order without conflicting with child FK key-share locks.
      await writer.query("SELECT id FROM instagram_connections WHERE id=$1 FOR NO KEY UPDATE", [connection]);
      const changed = await writer.query(
        `UPDATE instagram_manual_replies SET status=$3,failure_code=$4,safe_to_retry=$5,provider_message_id=$6,
        sent_at=CASE WHEN $3='sent' THEN clock_timestamp() ELSE NULL END,
        next_attempt_at=CASE WHEN $3='pending' THEN clock_timestamp()+interval '1 minute' ELSE next_attempt_at END
        WHERE id=$1 AND status='sending' AND attempt_id=$2 RETURNING id`,
        [row.id, attempt, status, code, safe, messageId],
      );
      if (!changed.rowCount) throw new Error("Manual reply claim lost");
      if (cooldown !== null)
        await writer.query(
          "UPDATE instagram_connections SET send_paused_until=greatest(coalesce(send_paused_until,clock_timestamp()),clock_timestamp()+$2::int*interval '1 second') WHERE id=$1",
          [connection, cooldown],
        );
      await writer.query(
        "INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,attempt_id,failure_code) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          row.workspace_id,
          connection,
          row.recipient_id,
          row.id,
          status === "pending" ? "deferred" : status,
          attempt,
          code,
        ],
      );
      await writer.query("COMMIT");
    } catch (error) {
      await writer.query("ROLLBACK");
      throw error;
    } finally {
      writer.release();
    }
  };
  const guarded = async () => {
    try {
      await assertManualReplyAllowed(pool, row.id, attempt, connection, encryptedToken);
      return true;
    } catch (error) {
      if (error instanceof PreSendVerificationError) {
        await finish("failed", error.failureCode, true);
        return false;
      }
      await finish("pending", "verification_unavailable", false);
      return false;
    }
  };
  if (!(await guarded())) return true;
  if (!transport) {
    await finish("failed", "token_unavailable", true);
    return true;
  }
  // Verification reads cannot have sent a message. Their transient failures can be deferred.
  let verified: boolean;
  try {
    verified = await transport.verifyAccount();
  } catch {
    await finish("pending", "verification_unavailable", false);
    return true;
  }
  if (!verified) {
    await finish("failed", "authorization_unverified", true);
    return true;
  }
  if (!(await guarded())) return true;
  let status = "sent",
    code: string | null = null,
    safe = false,
    messageId: string | null = null,
    cooldown: number | null = null;
  try {
    const result = await transport.send(row.recipient_id, row.text, { replyId: row.id, attemptId: attempt });
    if (typeof result.messageId !== "string" || !result.messageId.trim())
      throw new Error("Invalid send acknowledgement");
    messageId = result.messageId;
  } catch (error) {
    if (error instanceof PreSendVerificationError) {
      status = error.disposition === "retry" ? "pending" : "failed";
      code = error.failureCode;
      safe = error.disposition !== "retry";
    } else if (error instanceof ProviderRateLimitedError) {
      status = "failed";
      code = error.failureCode;
      safe = true;
      cooldown = Math.max(900, error.retryAfterSeconds ?? 0);
    } else if (error instanceof ProviderRejectedError) {
      status = "failed";
      code = error.failureCode;
      safe = true;
    } else {
      status = "unknown";
      code = "send_outcome_unknown";
    }
  }
  await finish(status, code, safe, messageId, cooldown);
  return true;
}
export async function recoverStaleManualReplies(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(`WITH lost AS (
    UPDATE instagram_manual_replies SET status='unknown',failure_code='worker_interrupted',safe_to_retry=false
    WHERE status='sending' AND attempt_started_at<clock_timestamp()-interval '10 minutes'
    RETURNING workspace_id,connection_id,recipient_id,id,attempt_id
  ) INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,attempt_id,failure_code)
    SELECT workspace_id,connection_id,recipient_id,id,'unknown',attempt_id,'worker_interrupted' FROM lost`);
}
