import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { InstagramMessage } from "./message-events.ts";
import type { FollowTransport } from "./follow-transport.ts";
import { lockInboxConversations, storeInboxMessage } from "./inbox.ts";
import { deliveryRecipientOptedOut } from "./channel-consent.ts";
import { PreSendVerificationError, ProviderRateLimitedError, ProviderRejectedError } from "./reply-worker.ts";
import { resumeRepliedFlowRun } from "./store.ts";

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
    await lockInboxConversations(client, messages, now);
    for (const message of messages) {
      await storeInboxMessage(client, message, now);
      if (
        message.timestamp.getTime() > now.getTime() + 60000 ||
        message.timestamp.getTime() <= now.getTime() - 24 * 3600000
      )
        continue;
      // Read (and lock the connection) before the lookups: a reply recorded as sent between them would
      // otherwise leave this DM neither matched nor kept.
      const keeper = await sendingConnection(client, message);
      if (!(await offerMessage(client, message, false)) && keeper) await keepUnmatched(client, keeper, message);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Offers one DM to the flow run waiting for this person's reply and to the follow confirmation, in the
// caller's transaction, and returns whether either one took it. Normally the private reply must have
// been sent no later than the DM; `early` (#108) instead accepts a DM dated from when the reply's last
// send attempt started, for a DM kept while that reply was being sent.
async function offerMessage(client: PoolClient, message: InstagramMessage, early: boolean): Promise<boolean> {
  // A typed DM (not a button postback) answers the flow run waiting for this person's reply.
  const replied = !message.confirmationReplyId && (await resumeRepliedFlowRun(client, message, early));
  // Most recent eligible first DM wins when more than one automation is awaiting the same person.
  const result = await client.query(
    `SELECT flow.reply_id,flow.confirmation_keyword,flow.last_message_at,flow.connection_id,
      NOT coalesce((automation.paused OR automation.handoff_paused),false) AS automation_active
    FROM instagram_follow_conversations flow
    JOIN private_reply_outbox reply ON reply.id=flow.reply_id
    JOIN instagram_connections c ON c.id=flow.connection_id
    JOIN instagram_comment_rules rule ON rule.id=reply.rule_id
    LEFT JOIN instagram_contact_automation automation ON automation.workspace_id=reply.workspace_id
      AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id
    WHERE c.account_id=$1 AND c.active AND c.send_enabled AND rule.enabled
      AND flow.recipient_id=$2 AND ($4::text IS NULL OR (flow.reply_id::text=$4 AND flow.confirmation_button_title<>'')) AND (flow.status='waiting' OR (automation.paused OR automation.handoff_paused)) AND reply.status='sent' AND ${early ? "reply.attempt_started_at" : "reply.sent_at"}<=$3
    ORDER BY reply.sent_at DESC,reply.id DESC LIMIT 1 FOR UPDATE OF flow`,
    [message.accountId, message.senderId, message.timestamp, message.confirmationReplyId ?? null],
  );
  const row = result.rows[0];
  if (
    !row ||
    (!message.confirmationReplyId && normalized(row.confirmation_keyword) !== normalized(message.text)) ||
    (row.last_message_at && message.timestamp <= row.last_message_at)
  )
    return replied;
  const receipt = await client.query(
    `INSERT INTO instagram_message_receipts(connection_id,message_id,received_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING message_id`,
    [row.connection_id, message.messageId, message.timestamp],
  );
  if (!receipt.rowCount || !row.automation_active) return true;
  await client.query(
    `UPDATE instagram_follow_conversations SET status='pending',confirmed_at=$2,last_message_at=$2,next_attempt_at=now(),failure_code=NULL,rate_limit_retries=0
         WHERE reply_id=$1 AND NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation
           JOIN private_reply_outbox reply ON reply.workspace_id=automation.workspace_id AND reply.connection_id=automation.connection_id AND reply.sender_id=automation.sender_id
           WHERE reply.id=$1 AND (automation.paused OR automation.handoff_paused))`,
    [row.reply_id, message.timestamp],
  );
  return true;
}

type Keeper = { id: string; workspace_id: string };

// The connection that may keep this DM (#108): one with a private reply in `sending` whose attempt
// started within the last 10 minutes and no later than the DM. A reply's recipient is recorded only
// after the send returns, so a DM answering it cannot be matched yet. Text with NUL cannot be stored.
// The connection is locked FOR SHARE until the DM is kept, like the other connection-scoped writes, so a
// disconnect and connection data deletion cannot commit between this read and the insert.
async function sendingConnection(client: PoolClient, message: InstagramMessage): Promise<Keeper | undefined> {
  if (message.text.includes("\u0000")) return undefined;
  const result = await client.query<Keeper>(
    `SELECT c.id::text,c.workspace_id::text FROM instagram_connections c
     WHERE c.account_id=$1 AND c.active AND EXISTS(SELECT 1 FROM private_reply_outbox reply
       WHERE reply.connection_id=c.id AND reply.status='sending'
         AND reply.attempt_started_at>now()-interval '10 minutes' AND reply.attempt_started_at<=$2)
     ORDER BY c.id LIMIT 1 FOR SHARE OF c`,
    [message.accountId, message.timestamp],
  );
  return result.rows[0];
}

// Keeps a DM that matched nothing while a reply was being sent, unless a follow confirmation or a reply
// wait already used this message ID (a redelivery).
async function keepUnmatched(client: PoolClient, keeper: Keeper, message: InstagramMessage): Promise<void> {
  await client.query(
    `INSERT INTO instagram_unmatched_replies(workspace_id,connection_id,sender_id,message_id,message_text,confirmation_reply_id,message_at)
     SELECT $1,$2,$3,$4,$5,$6,$7
     WHERE NOT EXISTS(SELECT 1 FROM instagram_message_receipts WHERE connection_id=$2 AND message_id=$4)
       AND NOT EXISTS(SELECT 1 FROM flow_runs WHERE connection_id=$2 AND reply_message_id=$4)
     ON CONFLICT(connection_id,message_id) DO NOTHING`,
    [
      keeper.workspace_id,
      keeper.id,
      message.senderId,
      message.messageId,
      message.text,
      message.confirmationReplyId ?? null,
      message.timestamp,
    ],
  );
}

// Offers each kept DM whose sender is now the recipient of a sent private reply, dated at or after that
// reply's last attempt start, to the reply wait and the follow confirmation (#108), oldest first. It runs
// right after a reply is recorded as sent (scope.replyId) and from the scheduled recovery. Both skip a DM
// while its connection still has a reply in `sending` that may be the one the DM answers (the condition
// that kept it), so an earlier sent reply to the same person cannot use it up. A confirmation button names
// its reply, so the post-send pass takes only one bound to its own reply, without that guard, and leaves
// one bound to another reply to that reply's own pass or the scheduled one. One transaction per DM: the
// connection is locked FOR SHARE before the kept row, the order the deletion functions use, and the row is
// claimed with SKIP LOCKED while unmatched, still holding its text and under 15 minutes old, so
// overlapping reconciles take it once and none links it past the retention boundary (read at the claim,
// not at BEGIN, since the connection lock can wait). It is marked matched whether or not it advanced
// anything; the follow receipts and flow_runs.reply_message_id keep a message from being used twice.
// Returns how many DMs were checked.
export async function reconcileUnmatchedReplies(
  pool: Pool,
  scope: { replyId?: string; connectionId?: string } = {},
  limit = 100,
): Promise<number> {
  const due = await pool.query<{ connection_id: string; message_id: string }>(
    `SELECT kept.connection_id::text,kept.message_id FROM instagram_unmatched_replies kept
     WHERE kept.matched_at IS NULL AND kept.message_text IS NOT NULL AND kept.received_at>now()-interval '15 minutes'
       AND ($2::uuid IS NULL OR kept.connection_id=$2)
       AND EXISTS(SELECT 1 FROM private_reply_outbox reply WHERE reply.connection_id=kept.connection_id
         AND reply.recipient_id=kept.sender_id AND reply.status='sent' AND reply.attempt_started_at<=kept.message_at
         AND ($1::bigint IS NULL OR reply.id=$1))
       AND ($1::bigint IS NULL OR kept.confirmation_reply_id IS NULL OR kept.confirmation_reply_id=$1::text)
       AND (($1::bigint IS NOT NULL AND kept.confirmation_reply_id IS NOT NULL)
         OR NOT EXISTS(SELECT 1 FROM private_reply_outbox pending
           WHERE pending.connection_id=kept.connection_id AND pending.status='sending'
           AND pending.attempt_started_at>now()-interval '10 minutes' AND pending.attempt_started_at<=kept.message_at))
     ORDER BY kept.message_at,kept.message_id LIMIT $3`,
    [scope.replyId ?? null, scope.connectionId ?? null, limit],
  );
  let checked = 0;
  let failed = 0;
  for (const candidate of due.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const connection = (
        await client.query<{ account_id: string }>(
          "SELECT account_id FROM instagram_connections WHERE id=$1 FOR SHARE",
          [candidate.connection_id],
        )
      ).rows[0];
      const kept = connection
        ? (
            await client.query<{
              sender_id: string;
              message_text: string;
              confirmation_reply_id: string | null;
              message_at: Date;
            }>(
              `SELECT sender_id,message_text,confirmation_reply_id,message_at FROM instagram_unmatched_replies
               WHERE connection_id=$1 AND message_id=$2 AND matched_at IS NULL AND message_text IS NOT NULL
                 AND received_at>statement_timestamp()-interval '15 minutes'
               FOR UPDATE SKIP LOCKED`,
              [candidate.connection_id, candidate.message_id],
            )
          ).rows[0]
        : undefined;
      if (connection && kept) {
        await offerMessage(
          client,
          {
            accountId: connection.account_id,
            senderId: kept.sender_id,
            messageId: candidate.message_id,
            text: kept.message_text,
            timestamp: kept.message_at,
            ...(kept.confirmation_reply_id === null ? {} : { confirmationReplyId: kept.confirmation_reply_id }),
          },
          true,
        );
        await client.query(
          "UPDATE instagram_unmatched_replies SET matched_at=now() WHERE connection_id=$1 AND message_id=$2",
          [candidate.connection_id, candidate.message_id],
        );
        checked++;
      }
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      failed++;
    } finally {
      client.release();
    }
  }
  if (failed) throw new Error(`Unmatched reply reconcile failed for ${failed} message(s)`);
  return checked;
}

// Removes the text of kept DMs once they are 15 minutes old (service policy, #108), at the first scheduled
// run after that; the reconcile stops using them at the same boundary. The rows stay, as server roles
// cannot delete; only the deletion functions remove them.
export async function clearExpiredUnmatchedReplies(pool: Pool, connectionId?: string): Promise<number> {
  const result = await pool.query(
    `UPDATE instagram_unmatched_replies SET message_text=NULL,text_cleared_at=now()
     WHERE message_text IS NOT NULL AND received_at<=now()-interval '15 minutes' AND ($1::uuid IS NULL OR connection_id=$1)`,
    [connectionId ?? null],
  );
  return result.rowCount ?? 0;
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
      AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND (automation.paused OR automation.handoff_paused))
  ORDER BY flow.next_attempt_at,flow.reply_id LIMIT 1 FOR UPDATE OF flow SKIP LOCKED
 ) UPDATE instagram_follow_conversations flow SET status='sending',attempt_id=$2,attempt_started_at=now()
 FROM candidate WHERE flow.reply_id=candidate.reply_id RETURNING flow.*`,
    [connectionId, attempt],
  );
  const row = claimed.rows[0];
  if (!row) return false;
  const replyScope = (
    await pool.query("SELECT workspace_id::text,sender_id FROM private_reply_outbox WHERE id=$1 AND connection_id=$2", [
      row.reply_id,
      connectionId,
    ])
  ).rows[0];
  if (!replyScope) throw new Error("Claimed follow reply has no private reply");
  const optedOut = () =>
    deliveryRecipientOptedOut(pool, {
      workspaceId: replyScope.workspace_id,
      connectionId,
      senderId: replyScope.sender_id,
    });
  // Like the private outbox, a row keeps its last claim time unless it goes back to pending, so an outcome
  // is dated by its attempt in the 24-hour operations counts (#59).
  const update = async (
    status: string,
    code: string | null,
    delay = 0,
    followStatus = "unknown",
    messageId: string | null = null,
  ) => {
    const result = await pool.query(
      `UPDATE instagram_follow_conversations SET status=$3,failure_code=$4,next_attempt_at=now()+make_interval(secs=>$5),
    follow_status=$6,provider_message_id=COALESCE($7,provider_message_id),attempt_id=NULL,
    attempt_started_at=CASE WHEN $3='pending' THEN NULL ELSE attempt_started_at END
    WHERE reply_id=$1 AND status='sending' AND attempt_id=$2`,
      [row.reply_id, attempt, status, code, delay, followStatus, messageId],
    );
    if (result.rowCount !== 1) throw new Error("Follow reply claim was lost");
  };
  const permitted = async () => {
    if (!(row.confirmed_at instanceof Date) || now().getTime() - row.confirmed_at.getTime() >= 24 * 3600000)
      return "denied";
    try {
      if (await optedOut()) return "opted_out";
    } catch {
      return "consent_unavailable";
    }
    const result = await pool.query(
      `SELECT NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
     AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND (automation.paused OR automation.handoff_paused)) AS automation_active
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
      permission === "paused" || permission === "consent_unavailable" ? "pending" : "blocked",
      permission === "paused"
        ? "contact_paused"
        : permission === "consent_unavailable"
          ? "consent_unavailable"
          : permission === "opted_out"
            ? "recipient_opted_out"
            : "delivery_not_permitted",
      permission === "paused" || permission === "consent_unavailable" ? 60 : 0,
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
      // The connection is locked before the follow row, the order of DM ingestion (which holds the connection
      // FOR SHARE and then locks the follow row) and of the deletion functions, so the two cannot deadlock (#130).
      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT 1 FROM instagram_connections WHERE id=$1 FOR NO KEY UPDATE", [connectionId]);
        const result = await writer.query(
          `WITH retried AS (
    UPDATE instagram_follow_conversations SET status=$3,failure_code=$4,rate_limit_retries=rate_limit_retries+1,
    next_attempt_at=now()+make_interval(secs=>$5),attempt_id=NULL,
    attempt_started_at=CASE WHEN $3='pending' THEN NULL ELSE attempt_started_at END
    WHERE reply_id=$1 AND status='sending' AND attempt_id=$2 RETURNING connection_id
   ) UPDATE instagram_connections SET send_paused_until=GREATEST(send_paused_until,now()+make_interval(secs=>$5)) WHERE id IN(SELECT connection_id FROM retried)`,
          [row.reply_id, attempt, row.rate_limit_retries < 3 ? "pending" : "failed", error.failureCode, delay],
        );
        if (result.rowCount !== 1) throw new Error("Follow reply claim was lost");
        await writer.query("COMMIT");
      } catch (failure) {
        await writer.query("ROLLBACK").catch(() => undefined);
        throw failure;
      } finally {
        writer.release();
      }
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
