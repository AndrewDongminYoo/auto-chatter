import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { instagramAdapter } from "./channel-adapter.ts";
import { messagingRecipientOptedOut, type ConsentQueryable } from "./channel-consent.ts";
import type { FollowSendContext } from "./follow-transport.ts";
import { PreSendVerificationError, rateLimitRetryDelaysSeconds } from "./reply-worker.ts";

// The DM flow delivery worker (#291, docs/specs/2026-11-08-instagram-dm-start-triggers.md): it claims one pending
// flow_dm_deliveries row of a connection, the first message of a run that a DM started, and sends it as one
// plain-text DM to the row's messaging sender ID. Every recorded condition is checked again immediately before the
// provider request. Only the Cloudflare queue consumer calls it; the Node worker never reads these rows. A DM flow
// delivery is a Send API DM, so no hourly budget applies to it (send-quotas spec); the connection pause does.

// A pending DM flow row of alias `d` that the claim may take now, also read by the wake and by operations health so
// the three agree: it is due, and its messaging sender ID is neither paused (instagram_dm_automation) nor in an
// active inbox handoff. Such a row stays pending until the pause or the handoff ends, as a paused comment sender's
// rows do. The connection pause is the caller's, because each reads the connection in its own way.
export function dmFlowDeliveryDueSql(d: string): string {
  return `${d}.status='pending' AND ${d}.next_attempt_at<=now()
    AND NOT EXISTS(SELECT 1 FROM instagram_dm_automation due_pause WHERE due_pause.workspace_id=${d}.workspace_id
      AND due_pause.connection_id=${d}.connection_id AND due_pause.recipient_id=${d}.recipient_id AND due_pause.paused)
    AND NOT EXISTS(SELECT 1 FROM instagram_inbox_handoffs due_handoff WHERE due_handoff.workspace_id=${d}.workspace_id
      AND due_handoff.connection_id=${d}.connection_id AND due_handoff.recipient_id=${d}.recipient_id
      AND due_handoff.active)`;
}

// The 24-hour messaging window, measured on the database clock. The anchor is the latest inbound text DM known for
// the row's messaging sender ID on its connection: every DM start event of that sender, the one of this run
// included, and every stored inbox text message from it. A stored postback (a button tap) is left out on purpose:
// the manual-reply window (docs/specs/2026-09-27-inbox-manual-replies.md) does not let a confirmation postback open
// it either, and campaigns read the same kind='text' anchor. Ingestion accepts a DM dated up to 60 s ahead, so each
// time is capped at the moment it was stored; a fresh DM therefore opens the window instead of reading as unverified.
const WINDOW_ANCHOR = `greatest(
     (SELECT max(least(start.message_at,start.created_at)) FROM instagram_dm_start_events start
      WHERE start.workspace_id=d.workspace_id AND start.connection_id=d.connection_id AND start.sender_id=d.recipient_id),
     (SELECT max(least(message.message_at,message.received_at)) FROM instagram_inbox_messages message
      WHERE message.workspace_id=d.workspace_id AND message.connection_id=d.connection_id
        AND message.recipient_id=d.recipient_id AND message.kind='text'))`;

// The final guard, from the database in one statement: the claim, the run and its flow, the connection, the window,
// the messaging-ID pause and the inbox handoff. A flow run keeps its pinned version, so a republish does not stop
// the row and disabling or archiving the flow does, as for a comment flow's private reply.
const GUARD_SQL = `WITH evaluation AS MATERIALIZED (SELECT statement_timestamp() AS as_of)
 SELECT d.recipient_id,run.status AS run_status,coalesce(f.enabled AND NOT f.archived,false) AS flow_on,
   coalesce(c.active AND c.send_enabled AND c.access_token_encrypted IS NOT NULL AND c.token_expires_at>evaluation.as_of,
     false) AS connection_sendable,
   c.access_token_encrypted IS DISTINCT FROM $5::text AS token_changed,
   coalesce(c.send_paused_until>evaluation.as_of,false) AS connection_paused,
   coalesce(evaluation.as_of<${WINDOW_ANCHOR}+interval '24 hours',false) AS window_open,
   EXISTS(SELECT 1 FROM instagram_dm_automation pause WHERE pause.workspace_id=d.workspace_id
     AND pause.connection_id=d.connection_id AND pause.recipient_id=d.recipient_id AND pause.paused) AS recipient_paused,
   EXISTS(SELECT 1 FROM instagram_inbox_handoffs handoff WHERE handoff.workspace_id=d.workspace_id
     AND handoff.connection_id=d.connection_id AND handoff.recipient_id=d.recipient_id AND handoff.active) AS handoff_active
 FROM flow_dm_deliveries d CROSS JOIN evaluation
 JOIN flow_runs run ON run.id=d.flow_run_id AND run.workspace_id=d.workspace_id AND run.connection_id=d.connection_id
 LEFT JOIN flows f ON f.id=run.flow_id AND f.workspace_id=run.workspace_id
 LEFT JOIN instagram_connections c ON c.workspace_id=d.workspace_id AND c.id=d.connection_id
 WHERE d.workspace_id=$1 AND d.id=$2 AND d.attempt_id=$3 AND d.status='sending' AND d.connection_id=$4`;

export interface DmFlowClaim {
  workspaceId: string;
  id: string;
  attempt: string;
  connectionId: string;
  encryptedToken: string | null;
  globalSendEnabled: boolean;
}

// Throws PreSendVerificationError unless the claimed row may be sent now. Any block reason wins over any retry
// reason, so a row whose window closed ends instead of retrying for as long as a pause lasts. Within each kind the
// first reason in this order is reported.
export async function assertDmFlowDeliveryAllowed(pool: ConsentQueryable, claim: DmFlowClaim): Promise<void> {
  const row = (
    await pool.query(GUARD_SQL, [claim.workspaceId, claim.id, claim.attempt, claim.connectionId, claim.encryptedToken])
  ).rows[0];
  if (!row) throw new PreSendVerificationError("block", "delivery_changed");
  const blocks: string[] = [];
  const retries: string[] = [];
  if (!claim.globalSendEnabled) retries.push("global_send_disabled");
  if (row.run_status !== "delivering") blocks.push("run_cancelled");
  if (!row.flow_on) blocks.push("inactive_flow");
  if (!row.connection_sendable) blocks.push("connection_unavailable");
  else if (row.token_changed) retries.push("token_rotated");
  if (row.connection_paused) retries.push("connection_paused");
  if (!row.window_open) blocks.push("reply_window_closed");
  if (row.recipient_paused) retries.push("contact_paused");
  if (row.handoff_active) retries.push("handoff_active");
  try {
    if (
      await messagingRecipientOptedOut(pool, {
        workspaceId: claim.workspaceId,
        connectionId: claim.connectionId,
        recipientId: row.recipient_id,
      })
    )
      blocks.push("recipient_opted_out");
  } catch {
    retries.push("consent_unavailable");
  }
  if (blocks.length) throw new PreSendVerificationError("block", blocks[0]);
  if (retries.length) throw new PreSendVerificationError("retry", retries[0]);
}

export interface DmFlowDeliveryTransport {
  verifyAccount(): Promise<boolean>;
  // Throws PreSendVerificationError only before the provider request; see CLAUDE.md for the other errors.
  send(recipient: string, text: string, context: FollowSendContext): Promise<{ messageId: string }>;
}

// A row still sending after 10 minutes may have reached Meta; it becomes unknown and is never retried.
export async function recoverStaleDmFlowDeliveries(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(
    `UPDATE flow_dm_deliveries SET status='unknown',failure_code='worker_interrupted',updated_at=clock_timestamp()
     WHERE status='sending' AND attempt_started_at<clock_timestamp()-interval '10 minutes'`,
  );
}

type Outcome = "pending" | "sent" | "failed" | "blocked" | "unknown";

// Claims and processes at most one row of the connection; returns whether a row was claimed. The run stays
// delivering whatever the outcome, as a comment run does after its private reply: the row's status is the run's
// delivery state (listFlowRuns, flowRunReport).
export async function processNextDmFlowDelivery(
  pool: Pool,
  connection: string,
  transport: DmFlowDeliveryTransport,
  encryptedToken: string | null,
  options: { globalSendEnabled: boolean },
): Promise<boolean> {
  const attempt = randomUUID();
  const claimed = (
    await pool.query<{
      id: string;
      workspace_id: string;
      recipient_id: string;
      message_text: string;
      rate_limit_retries: number;
    }>(
      `WITH candidate AS (
         SELECT d.id FROM flow_dm_deliveries d
         WHERE d.connection_id=$1 AND ${dmFlowDeliveryDueSql("d")}
           AND NOT EXISTS(SELECT 1 FROM instagram_connections c WHERE c.id=$1 AND c.send_paused_until>now())
         ORDER BY d.next_attempt_at,d.created_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1
       )
       UPDATE flow_dm_deliveries d SET status='sending',attempt_id=$2,attempt_started_at=clock_timestamp(),
         failure_code=NULL,updated_at=clock_timestamp()
       FROM candidate WHERE d.id=candidate.id
       RETURNING d.id::text,d.workspace_id::text,d.recipient_id,d.message_text,d.rate_limit_retries`,
      [connection, attempt],
    )
  ).rows[0];
  if (!claimed) return false;
  const claim: DmFlowClaim = {
    workspaceId: claimed.workspace_id,
    id: claimed.id,
    attempt,
    connectionId: connection,
    encryptedToken,
    globalSendEnabled: options.globalSendEnabled,
  };

  // Lands the attempt; throws when the claim was lost. A rate limit pauses the connection (locked before the row, as
  // the other workers do) and defers the row to the pause end, or fails it once the retry tiers are used up.
  const finish = async (
    status: Outcome,
    code: string | null,
    messageId: string | null = null,
    rateLimit: { retryAfterSeconds: number | null } | null = null,
  ): Promise<void> => {
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      // Text, because a JavaScript Date would drop the microseconds of the pause end.
      let pausedUntil: string | null = null;
      let retried = false;
      if (rateLimit) {
        const retries = claimed.rate_limit_retries;
        const tier = rateLimitRetryDelaysSeconds[Math.min(retries, rateLimitRetryDelaysSeconds.length - 1)]!;
        const delay = Math.max(tier, rateLimit.retryAfterSeconds ?? 0);
        retried = retries < rateLimitRetryDelaysSeconds.length;
        if (!retried) status = "failed";
        await writer.query("SELECT id FROM instagram_connections WHERE id=$1 FOR NO KEY UPDATE", [connection]);
        pausedUntil =
          (
            await writer.query<{ paused_until: string }>(
              `UPDATE instagram_connections SET send_paused_until=greatest(coalesce(send_paused_until,clock_timestamp()),
                 clock_timestamp()+$2::int*interval '1 second') WHERE id=$1 RETURNING send_paused_until::text AS paused_until`,
              [connection, delay],
            )
          ).rows[0]?.paused_until ?? null;
      }
      const changed = await writer.query(
        `UPDATE flow_dm_deliveries SET status=$4::text,failure_code=$5,provider_message_id=$6,
           sent_at=CASE WHEN $4::text='sent' THEN clock_timestamp() END,
           attempt_id=CASE WHEN $4::text='pending' THEN NULL ELSE attempt_id END,
           attempt_started_at=CASE WHEN $4::text='pending' THEN NULL ELSE attempt_started_at END,
           next_attempt_at=CASE WHEN $4::text='pending'
             THEN coalesce($7::timestamptz,clock_timestamp()+interval '1 minute') ELSE next_attempt_at END,
           rate_limit_retries=rate_limit_retries+CASE WHEN $8::boolean THEN 1 ELSE 0 END,
           updated_at=clock_timestamp()
         WHERE workspace_id=$1 AND id=$2 AND status='sending' AND attempt_id=$3 RETURNING id`,
        [claimed.workspace_id, claimed.id, attempt, status, code, messageId, pausedUntil, retried],
      );
      if (!changed.rowCount) throw new Error("DM flow delivery claim lost");
      await writer.query("COMMIT");
    } catch (error) {
      await writer.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      writer.release();
    }
  };
  const guarded = async (): Promise<boolean> => {
    try {
      await assertDmFlowDeliveryAllowed(pool, claim);
      return true;
    } catch (error) {
      if (error instanceof PreSendVerificationError)
        await finish(error.disposition === "retry" ? "pending" : "blocked", error.failureCode);
      else await finish("pending", "verification_unavailable");
      return false;
    }
  };
  if (!(await guarded())) return true;
  // Account verification reads cannot have sent a message, so their transient failures are deferred.
  let verified: boolean;
  try {
    verified = await transport.verifyAccount();
  } catch {
    await finish("pending", "verification_unavailable");
    return true;
  }
  if (!verified) {
    await finish("blocked", "authorization_unverified");
    return true;
  }
  if (!(await guarded())) return true;
  const stamped = await pool.query(
    `UPDATE flow_dm_deliveries SET provider_called_at=clock_timestamp()
     WHERE workspace_id=$1 AND id=$2 AND status='sending' AND attempt_id=$3`,
    [claimed.workspace_id, claimed.id, attempt],
  );
  if (stamped.rowCount !== 1) throw new Error("DM flow delivery claim lost");
  let status: Outcome = "sent";
  let code: string | null = null;
  let messageId: string | null = null;
  let rateLimit: { retryAfterSeconds: number | null } | null = null;
  try {
    const result = await transport.send(claimed.recipient_id, claimed.message_text, {
      replyId: claimed.id,
      attemptId: attempt,
    });
    messageId = instagramAdapter.acceptSendResult(result).messageId;
  } catch (error) {
    const outcome = instagramAdapter.classifySendError(error);
    code = outcome.code;
    if (outcome.kind === "not_attempted") status = outcome.disposition === "retry" ? "pending" : "blocked";
    else if (outcome.kind === "refused" && outcome.refusal === "rate_limited") {
      status = "pending";
      rateLimit = { retryAfterSeconds: outcome.retryAfterSeconds };
    } else if (outcome.kind === "refused") status = "failed";
    else status = "unknown";
  }
  await finish(status, code, messageId, rateLimit);
  return true;
}
