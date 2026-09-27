import type { Pool } from "pg";
import { InstagramFollowTransport } from "./follow-transport.ts";
import { PreSendVerificationError, type PrivateReplyRequest } from "./reply-worker.ts";

// Environment credentials belong to one explicitly configured, non-OAuth connection.
export function createNodeFollowTransport(
  pool: Pool,
  config: {
    accountId: string;
    connectionId: string;
    accessToken: string;
    graphVersion: string;
    fetchImpl?: typeof fetch;
  },
): InstagramFollowTransport {
  return new InstagramFollowTransport({
    ...config,
    beforeSend: async (context) => {
      const permitted = await pool
        .query(
          `SELECT NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
           AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND (automation.paused OR automation.handoff_paused)) AS automation_active
         FROM instagram_follow_conversations flow
         JOIN private_reply_outbox reply ON reply.id=flow.reply_id
         JOIN instagram_comment_rules rule ON rule.id=reply.rule_id
         JOIN instagram_connections c ON c.id=flow.connection_id
         WHERE flow.reply_id=$1 AND flow.attempt_id=$2 AND flow.status='sending'
           AND flow.confirmed_at>now()-interval '24 hours' AND reply.status='sent'
           AND rule.enabled AND c.id=$3 AND c.account_id=$4 AND c.active AND c.send_enabled
           AND c.access_token_encrypted IS NULL
           AND (c.send_paused_until IS NULL OR c.send_paused_until<=now())`,
          [context.replyId, context.attemptId, config.connectionId, config.accountId],
        )
        .catch(() => {
          throw new PreSendVerificationError("retry");
        });
      if (permitted.rows[0]?.automation_active === false) throw new PreSendVerificationError("retry", "contact_paused");
      if (!permitted.rowCount) throw new PreSendVerificationError("block", "delivery_not_permitted");
    },
  });
}

export async function assertNodePrivateReplyAllowed(
  pool: Pool,
  config: { connectionId: string; accountId: string },
  request: PrivateReplyRequest,
): Promise<void> {
  const permitted = await pool
    .query(
      `SELECT NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
       AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND (automation.paused OR automation.handoff_paused)) AS automation_active
     FROM private_reply_outbox reply
     JOIN instagram_comment_rules rule ON rule.id=reply.rule_id
     JOIN instagram_connections c ON c.id=reply.connection_id
     WHERE reply.id=$1 AND reply.attempt_id=$2 AND reply.status='sending'
       AND rule.enabled AND c.id=$3 AND c.account_id=$4 AND c.active AND c.send_enabled
       AND c.access_token_encrypted IS NULL
       AND (c.send_paused_until IS NULL OR c.send_paused_until<=now())`,
      [request.id, request.attemptId ?? null, config.connectionId, config.accountId],
    )
    .catch(() => {
      throw new PreSendVerificationError("retry");
    });
  if (permitted.rows[0]?.automation_active === false) throw new PreSendVerificationError("retry", "contact_paused");
  if (!permitted.rowCount) throw new PreSendVerificationError("block", "delivery_not_permitted");
}
