import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { CAMPAIGN_RECIPIENT_STAGE_SQL, CONNECTION_SENDABLE, CONTACT_PAUSED } from "../app/campaign-drafts.ts";
import { instagramAdapter } from "./channel-adapter.ts";
import { deliveryRecipientOptedOut, type ConsentQueryable } from "./channel-consent.ts";
import type { FollowSendContext } from "./follow-transport.ts";
import { PreSendVerificationError } from "./reply-worker.ts";
import { campaignBudgetOpenSql } from "./send-quota.ts";

// The campaign delivery worker (#36, docs/specs/2026-10-27-campaign-runs.md): it claims one pending
// campaign_deliveries row of a connection and sends the approval's stored body to the row's stored DM recipient as
// one plain-text DM. Every recorded condition is checked again immediately before the provider request. Only the
// Cloudflare queue consumer calls it, after the connection's automations; the Node worker never sends campaigns.

// A pending campaign row of alias `d` that the claim may take now, also read by the wake and by operations health so
// the three agree: it is due, its run is running and its comment sender is not paused. The run is read, never locked:
// a cancel locks the run and then its rows, so a reader that holds a row must not wait on the run. The connection
// pause and the campaign budget are the caller's, because each reads the connection in its own way.
export function campaignDeliveryDueSql(d: string): string {
  return `${d}.status='pending' AND ${d}.next_attempt_at<=now()
    AND EXISTS(SELECT 1 FROM campaign_runs due_run WHERE due_run.workspace_id=${d}.workspace_id AND due_run.id=${d}.run_id
      AND due_run.status='running')
    AND NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=${d}.workspace_id
      AND automation.connection_id=${d}.connection_id AND automation.sender_id=${d}.sender_id
      AND (automation.paused OR automation.handoff_paused))`;
}

// The member-level part of the final guard, from the database in one statement: the claim, the run, the connection
// (with the preview's own connection and contact predicates), the approver's membership and the contact pause.
const GUARD_SQL = `WITH evaluation AS MATERIALIZED (SELECT statement_timestamp() AS as_of)
 SELECT d.sender_id,d.recipient_id,run.status AS run_status,${CONNECTION_SENDABLE} AS connection_sendable,
   c.access_token_encrypted IS DISTINCT FROM $5::text AS token_changed,
   coalesce(c.send_paused_until>evaluation.as_of,false) AS connection_paused,${CONTACT_PAUSED} AS contact_paused,
   EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=d.workspace_id
     AND member.user_id=approval.approved_by AND member.removed_at IS NULL AND member.role IN ('owner','admin'))
     AS approver_active
 FROM campaign_deliveries d CROSS JOIN evaluation
 JOIN campaign_runs run ON run.workspace_id=d.workspace_id AND run.id=d.run_id
 JOIN campaign_approvals approval ON approval.workspace_id=run.workspace_id AND approval.id=run.approval_id
 LEFT JOIN instagram_connections c ON c.workspace_id=d.workspace_id AND c.id=d.connection_id
 LEFT JOIN instagram_contact_automation a ON a.workspace_id=d.workspace_id AND a.connection_id=d.connection_id
   AND a.sender_id=d.sender_id
 WHERE d.workspace_id=$1 AND d.id=$2 AND d.attempt_id=$3 AND d.status='sending' AND d.connection_id=$4`;

export interface CampaignClaim {
  workspaceId: string;
  id: string;
  attempt: string;
  connectionId: string;
  encryptedToken: string | null;
  globalSendEnabled: boolean;
}

// Throws PreSendVerificationError unless the claimed row may be sent now. A run that is no longer running answers
// retry/run_cancelled, which the finish lands as cancelled. Otherwise any block reason wins over any retry reason,
// so a row whose window closed or whose consent is missing ends instead of retrying for as long as a pause lasts.
// Within each kind the first reason in the preview's order is reported.
export async function assertCampaignDeliveryAllowed(pool: ConsentQueryable, claim: CampaignClaim): Promise<void> {
  const row = (
    await pool.query(GUARD_SQL, [claim.workspaceId, claim.id, claim.attempt, claim.connectionId, claim.encryptedToken])
  ).rows[0];
  if (!row) throw new PreSendVerificationError("block", "delivery_changed");
  if (row.run_status !== "running") throw new PreSendVerificationError("retry", "run_cancelled");
  const blocks: string[] = [];
  const retries: string[] = [];
  if (!claim.globalSendEnabled) retries.push("global_send_disabled");
  if (!row.connection_sendable) blocks.push("connection_unavailable");
  else if (row.token_changed) retries.push("token_rotated");
  if (row.connection_paused) retries.push("connection_paused");
  if (!row.approver_active) blocks.push("approver_unavailable");
  if (row.contact_paused) retries.push("contact_paused");
  // The stored recipient's stage with the preview's predicates; undefined when the read failed.
  let stage: number | null | undefined;
  try {
    stage =
      (
        await pool.query<{ stage: number }>(CAMPAIGN_RECIPIENT_STAGE_SQL, [
          claim.workspaceId,
          claim.connectionId,
          row.sender_id,
          row.recipient_id,
        ])
      ).rows[0]?.stage ?? null;
  } catch {
    retries.push("consent_unavailable");
  }
  if (stage === null) blocks.push("no_dm_identity");
  else if (stage === 4) blocks.push("recipient_opted_out");
  else if (stage !== undefined) {
    // The other workers' opt-out guard: the comment sender and every DM recipient bridged to it.
    try {
      if (
        await deliveryRecipientOptedOut(pool, {
          workspaceId: claim.workspaceId,
          connectionId: claim.connectionId,
          senderId: row.sender_id,
        })
      )
        blocks.push("recipient_opted_out");
    } catch {
      retries.push("consent_unavailable");
    }
    if (stage === 5) blocks.push("marketing_consent_required");
    else if (stage === 6) blocks.push("reply_window_closed");
  }
  if (blocks.length) throw new PreSendVerificationError("block", blocks[0]);
  if (retries.length) throw new PreSendVerificationError("retry", retries[0]);
}

export interface CampaignDeliveryTransport {
  verifyAccount(): Promise<boolean>;
  // Throws PreSendVerificationError only before the provider request; see CLAUDE.md for the other errors.
  send(recipient: string, text: string, context: FollowSendContext): Promise<{ messageId: string }>;
}

// Marks the run completed when it is running and none of its rows is pending or sending. A row that left those
// states never returns to them, so a run seen empty stays empty. It locks only run rows, skips one another
// transaction holds (a cancel, or a finish that holds the run FOR SHARE; that finish completes the run itself),
// and is never called while a delivery row is held. Without `run` it completes every such run (the cron).
export async function completeCampaignRuns(
  pool: Pick<Pool, "query">,
  run: { workspaceId: string; runId: string } | null = null,
): Promise<number> {
  const result = await pool.query(
    `UPDATE campaign_runs SET status='completed',version=version+1,updated_at=clock_timestamp()
     WHERE status='running' AND (workspace_id,id) IN (
       SELECT r.workspace_id,r.id FROM campaign_runs r
       WHERE r.status='running' AND ($1::uuid IS NULL OR (r.workspace_id=$1 AND r.id=$2::uuid))
         AND NOT EXISTS(SELECT 1 FROM campaign_deliveries d WHERE d.workspace_id=r.workspace_id AND d.run_id=r.id
           AND d.status IN ('pending','sending'))
       ORDER BY r.workspace_id,r.id FOR NO KEY UPDATE SKIP LOCKED)`,
    [run?.workspaceId ?? null, run?.runId ?? null],
  );
  return result.rowCount ?? 0;
}

// A row still sending after 10 minutes may have reached Meta; it becomes unknown and is never retried.
export async function recoverStaleCampaignDeliveries(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(
    `UPDATE campaign_deliveries SET status='unknown',failure_code='worker_interrupted',updated_at=clock_timestamp()
     WHERE status='sending' AND attempt_started_at<clock_timestamp()-interval '10 minutes'`,
  );
}

// Claims and processes at most one row of the connection; returns whether a row was claimed.
export async function processNextCampaignDelivery(
  pool: Pool,
  connection: string,
  transport: CampaignDeliveryTransport,
  encryptedToken: string | null,
  options: { globalSendEnabled: boolean },
): Promise<boolean> {
  const attempt = randomUUID();
  const client = await pool.connect();
  let row: { id: string; workspace_id: string; run_id: string; recipient_id: string; body: string } | undefined;
  try {
    await client.query("BEGIN");
    row = (
      await client.query(
        `SELECT d.id,d.workspace_id,d.run_id,d.recipient_id,approval.body FROM campaign_deliveries d
         JOIN campaign_runs run ON run.workspace_id=d.workspace_id AND run.id=d.run_id
         JOIN campaign_approvals approval ON approval.workspace_id=run.workspace_id AND approval.id=run.approval_id
         WHERE d.connection_id=$1 AND ${campaignDeliveryDueSql("d")}
           AND NOT EXISTS(SELECT 1 FROM instagram_connections c WHERE c.id=$1 AND c.send_paused_until>now())
           AND ${campaignBudgetOpenSql("$1")}
         ORDER BY d.next_attempt_at,d.created_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1`,
        [connection],
      )
    ).rows[0];
    if (row)
      await client.query(
        `UPDATE campaign_deliveries SET status='sending',attempt_id=$2,attempt_started_at=clock_timestamp(),
           failure_code=NULL,updated_at=clock_timestamp() WHERE id=$1`,
        [row.id, attempt],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (!row) return false;
  const claimed = row;
  const claim: CampaignClaim = {
    workspaceId: claimed.workspace_id,
    id: claimed.id,
    attempt,
    connectionId: connection,
    encryptedToken,
    globalSendEnabled: options.globalSendEnabled,
  };

  // Lands the attempt. The run is locked FOR SHARE before the row, which is a cancel's order (run, then rows), so a
  // cancel waits for this transaction and then cancels a row that went back to pending; a row that would go back to
  // pending in a run that is no longer running is cancelled here instead. A rate limit pauses the connection (locked
  // before the row, as the other workers do) and defers the row to the pause end.
  const finish = async (
    status: "pending" | "sent" | "failed" | "blocked" | "unknown",
    code: string | null,
    messageId: string | null = null,
    cooldown: number | null = null,
  ): Promise<void> => {
    let landed: string = status;
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      const run = (
        await writer.query("SELECT status FROM campaign_runs WHERE workspace_id=$1 AND id=$2 FOR SHARE", [
          claimed.workspace_id,
          claimed.run_id,
        ])
      ).rows[0];
      if (status === "pending" && run?.status !== "running") {
        landed = "cancelled";
        code = "run_cancelled";
      }
      // Text, because a JavaScript Date would drop the microseconds of the pause end.
      let pausedUntil: string | null = null;
      if (cooldown !== null) {
        await writer.query("SELECT id FROM instagram_connections WHERE id=$1 FOR NO KEY UPDATE", [connection]);
        pausedUntil =
          (
            await writer.query<{ paused_until: string }>(
              `UPDATE instagram_connections SET send_paused_until=greatest(coalesce(send_paused_until,clock_timestamp()),
                 clock_timestamp()+$2::int*interval '1 second') WHERE id=$1 RETURNING send_paused_until::text AS paused_until`,
              [connection, cooldown],
            )
          ).rows[0]?.paused_until ?? null;
      }
      const changed = await writer.query(
        `UPDATE campaign_deliveries SET status=$4::text,failure_code=$5,provider_message_id=$6,
           sent_at=CASE WHEN $4::text='sent' THEN clock_timestamp() END,
           attempt_id=CASE WHEN $4::text='pending' THEN NULL ELSE attempt_id END,
           attempt_started_at=CASE WHEN $4::text='pending' THEN NULL ELSE attempt_started_at END,
           next_attempt_at=CASE WHEN $4::text='pending'
             THEN coalesce($7::timestamptz,clock_timestamp()+interval '1 minute') ELSE next_attempt_at END,
           updated_at=clock_timestamp()
         WHERE workspace_id=$1 AND id=$2 AND status='sending' AND attempt_id=$3 RETURNING id`,
        [claimed.workspace_id, claimed.id, attempt, landed, code, messageId, pausedUntil],
      );
      if (!changed.rowCount) throw new Error("Campaign delivery claim lost");
      await writer.query("COMMIT");
    } catch (error) {
      await writer.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      writer.release();
    }
    // A separate statement after the row lock is released.
    if (landed !== "pending")
      await completeCampaignRuns(pool, { workspaceId: claimed.workspace_id, runId: claimed.run_id });
  };
  const guarded = async (): Promise<boolean> => {
    try {
      await assertCampaignDeliveryAllowed(pool, claim);
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
  // Counted before the request, so a request that never left counts a call. The count is per row, so a rate-limited
  // row retried inside the hour overwrites its stamp and its two POSTs count once; that retry already paused the
  // connection for at least 900 s, and the private reply budget accepts the same error (campaign-runs spec, 예산).
  const stamped = await pool.query(
    `UPDATE campaign_deliveries SET provider_called_at=clock_timestamp()
     WHERE workspace_id=$1 AND id=$2 AND status='sending' AND attempt_id=$3`,
    [claimed.workspace_id, claimed.id, attempt],
  );
  if (stamped.rowCount !== 1) throw new Error("Campaign delivery claim lost");
  let status: "pending" | "sent" | "failed" | "blocked" | "unknown" = "sent";
  let code: string | null = null;
  let messageId: string | null = null;
  let cooldown: number | null = null;
  try {
    const result = await transport.send(claimed.recipient_id, claimed.body, {
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
      cooldown = Math.max(900, outcome.retryAfterSeconds ?? 0);
    } else if (outcome.kind === "refused") status = "failed";
    else status = "unknown";
  }
  await finish(status, code, messageId, cooldown);
  return true;
}
