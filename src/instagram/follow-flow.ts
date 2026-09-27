import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { InstagramMessage } from "./message-events.ts";
import type { FollowTransport } from "./follow-transport.ts";
import { PreSendVerificationError, ProviderRateLimitedError, ProviderRejectedError } from "./reply-worker.ts";

const normalized = (text: string) => text.normalize("NFC").trim().toLowerCase();
export async function ingestMessages(
  pool: Pool,
  messages: readonly InstagramMessage[],
  now = new Date(),
): Promise<void> {
  if (!messages.length) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const message of messages) {
      if (
        message.timestamp.getTime() > now.getTime() + 60000 ||
        message.timestamp.getTime() <= now.getTime() - 24 * 3600000
      )
        continue;
      // Most recent eligible first DM wins when more than one automation is awaiting the same person.
      const result = await client.query(
        `SELECT flow.reply_id,flow.confirmation_keyword,flow.last_message_at,flow.connection_id,
      NOT coalesce(automation.paused,false) AS automation_active
    FROM instagram_follow_conversations flow
    JOIN private_reply_outbox reply ON reply.id=flow.reply_id
    JOIN instagram_connections c ON c.id=flow.connection_id
    JOIN instagram_comment_rules rule ON rule.id=reply.rule_id
    LEFT JOIN instagram_contact_automation automation ON automation.workspace_id=reply.workspace_id
      AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id
    WHERE c.account_id=$1 AND c.active AND c.send_enabled AND rule.enabled
      AND flow.recipient_id=$2 AND ($4::text IS NULL OR (flow.reply_id::text=$4 AND flow.confirmation_button_title<>'')) AND (flow.status='waiting' OR automation.paused) AND reply.status='sent' AND reply.sent_at<=$3
    ORDER BY reply.sent_at DESC,reply.id DESC LIMIT 1 FOR UPDATE OF flow`,
        [message.accountId, message.senderId, message.timestamp, message.confirmationReplyId ?? null],
      );
      const row = result.rows[0];
      if (
        !row ||
        (!message.confirmationReplyId && normalized(row.confirmation_keyword) !== normalized(message.text)) ||
        (row.last_message_at && message.timestamp <= row.last_message_at)
      )
        continue;
      const receipt = await client.query(
        `INSERT INTO instagram_message_receipts(connection_id,message_id,received_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING message_id`,
        [row.connection_id, message.messageId, message.timestamp],
      );
      if (!receipt.rowCount || !row.automation_active) continue;
      await client.query(
        `UPDATE instagram_follow_conversations SET status='pending',confirmed_at=$2,last_message_at=$2,next_attempt_at=now(),failure_code=NULL,rate_limit_retries=0
         WHERE reply_id=$1 AND NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation
           JOIN private_reply_outbox reply ON reply.workspace_id=automation.workspace_id AND reply.connection_id=automation.connection_id AND reply.sender_id=automation.sender_id
           WHERE reply.id=$1 AND automation.paused)`,
        [row.reply_id, message.timestamp],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function processNextFollowReply(
  pool: Pool,
  connectionId: string,
  transport: FollowTransport,
  now: () => Date = () => new Date(),
  environmentAccountId?: string,
): Promise<boolean> {
  if (environmentAccountId !== undefined && !/^\d+$/.test(environmentAccountId))
    throw new Error("Invalid Instagram account ID");
  const attempt = randomUUID();
  const claimed = await pool.query(
    `WITH candidate AS (
  SELECT flow.reply_id FROM instagram_follow_conversations flow JOIN instagram_connections c ON c.id=flow.connection_id
  JOIN private_reply_outbox reply ON reply.id=flow.reply_id
  WHERE flow.connection_id=$1 AND flow.status='pending' AND flow.next_attempt_at<=now()
    AND (c.send_paused_until IS NULL OR c.send_paused_until<=now())
    AND NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
      AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND automation.paused)
  ORDER BY flow.next_attempt_at,flow.reply_id LIMIT 1 FOR UPDATE OF flow SKIP LOCKED
 ) UPDATE instagram_follow_conversations flow SET status='sending',attempt_id=$2,attempt_started_at=now()
 FROM candidate WHERE flow.reply_id=candidate.reply_id RETURNING flow.*`,
    [connectionId, attempt],
  );
  const row = claimed.rows[0];
  if (!row) return false;
  const update = async (
    status: string,
    code: string | null,
    delay = 0,
    followStatus = "unknown",
    messageId: string | null = null,
  ) => {
    const result = await pool.query(
      `UPDATE instagram_follow_conversations SET status=$3,failure_code=$4,next_attempt_at=now()+make_interval(secs=>$5),
    follow_status=$6,provider_message_id=COALESCE($7,provider_message_id),attempt_id=NULL,attempt_started_at=NULL
    WHERE reply_id=$1 AND status='sending' AND attempt_id=$2`,
      [row.reply_id, attempt, status, code, delay, followStatus, messageId],
    );
    if (result.rowCount !== 1) throw new Error("Follow reply claim was lost");
  };
  const permitted = async () => {
    if (!(row.confirmed_at instanceof Date) || now().getTime() - row.confirmed_at.getTime() >= 24 * 3600000)
      return "denied";
    const result = await pool.query(
      `SELECT NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
     AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND automation.paused) AS automation_active
    FROM instagram_follow_conversations flow
   JOIN private_reply_outbox reply ON reply.id=flow.reply_id
   JOIN instagram_connections c ON c.id=flow.connection_id
   JOIN instagram_comment_rules rule ON rule.id=reply.rule_id
   WHERE flow.reply_id=$1 AND flow.status='sending' AND flow.attempt_id=$2 AND reply.status='sent'
     AND c.active AND c.send_enabled
     AND (($3::text IS NULL AND c.access_token_encrypted IS NOT NULL AND c.token_expires_at>now())
       OR ($3::text IS NOT NULL AND c.account_id=$3 AND c.access_token_encrypted IS NULL))
     AND rule.enabled`,
      [row.reply_id, attempt, environmentAccountId ?? null],
    );
    return !result.rows[0] ? "denied" : result.rows[0].automation_active ? "allowed" : "paused";
  };
  const checkPermission = async () => {
    const permission = await permitted();
    if (permission === "allowed") return true;
    await update(
      permission === "paused" ? "pending" : "blocked",
      permission === "paused" ? "contact_paused" : "delivery_not_permitted",
      permission === "paused" ? 60 : 0,
    );
    return false;
  };
  if (now().getTime() - row.confirmed_at?.getTime() >= 24 * 3600000) {
    await update("waiting", "response_window_expired");
    return true;
  }
  if (!(await checkPermission())) return true;
  let follows: boolean | null;
  try {
    follows = await transport.followStatus(row.recipient_id);
  } catch {
    follows = null;
  }
  if (follows === null) {
    await update("pending", "follow_status_unavailable", 60);
    return true;
  }
  if (now().getTime() - row.confirmed_at?.getTime() >= 24 * 3600000) {
    await update("waiting", "response_window_expired");
    return true;
  }
  if (!(await checkPermission())) return true;
  const pause = await pool.query(
    "SELECT send_paused_until FROM instagram_connections WHERE id=$1 AND send_paused_until>now()",
    [connectionId],
  );
  if (pause.rows[0]) {
    await update(
      "pending",
      "connection_paused",
      Math.max(1, Math.ceil((pause.rows[0].send_paused_until.getTime() - now().getTime()) / 1000)),
    );
    return true;
  }
  const followStatus = follows ? "following" : "not_following";
  let messageId: string;
  try {
    const sent = await transport.send(
      row.recipient_id,
      follows ? row.follower_reply_text : row.non_follower_reply_text,
      {
        replyId: row.reply_id,
        attemptId: attempt,
        ...(!follows && row.confirmation_button_title
          ? { confirmationButtonTitle: row.confirmation_button_title }
          : {}),
      },
    );
    if (typeof sent.messageId !== "string" || !sent.messageId.trim()) throw new Error("Missing message ID");
    messageId = sent.messageId;
  } catch (error) {
    if (error instanceof ProviderRateLimitedError) {
      const delays = [900, 3600, 14400];
      const delay = Math.max(delays[Math.min(row.rate_limit_retries, 2)]!, error.retryAfterSeconds ?? 0);
      const result = await pool.query(
        `WITH retried AS (
    UPDATE instagram_follow_conversations SET status=$3,failure_code=$4,rate_limit_retries=rate_limit_retries+1,
    next_attempt_at=now()+make_interval(secs=>$5),attempt_id=NULL,attempt_started_at=NULL
    WHERE reply_id=$1 AND status='sending' AND attempt_id=$2 RETURNING connection_id
   ) UPDATE instagram_connections SET send_paused_until=GREATEST(send_paused_until,now()+make_interval(secs=>$5)) WHERE id IN(SELECT connection_id FROM retried)`,
        [row.reply_id, attempt, row.rate_limit_retries < 3 ? "pending" : "failed", error.failureCode, delay],
      );
      if (result.rowCount !== 1) throw new Error("Follow reply claim was lost");
    } else if (error instanceof PreSendVerificationError) {
      if (now().getTime() - row.confirmed_at.getTime() >= 24 * 3600000)
        await update("waiting", "response_window_expired");
      else await update(error.disposition === "retry" ? "pending" : "blocked", error.failureCode, 60, followStatus);
    } else if (error instanceof ProviderRejectedError) await update("failed", error.failureCode, 0, followStatus);
    else await update("unknown", "send_outcome_unknown", 0, followStatus);
    return true;
  }
  await update(follows ? "sent" : "waiting", null, 0, followStatus, messageId);
  return true;
}

export async function recoverStaleFollowReplies(pool: Pool, olderThan: Date, connectionId?: string): Promise<void> {
  await pool.query(
    "UPDATE instagram_follow_conversations SET status='unknown',failure_code='worker_interrupted' WHERE status='sending' AND attempt_started_at<$1 AND ($2::uuid IS NULL OR connection_id=$2)",
    [olderThan, connectionId ?? null],
  );
}
