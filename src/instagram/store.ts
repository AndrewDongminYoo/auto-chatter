import type { Pool } from "pg";
import type { InstagramComment } from "./webhook.ts";
import { matchesCommentRule, type CommentRuleMatch } from "./comment-rule.ts";

interface ConnectionRow {
  id: string;
  workspace_id: string;
}

interface EventRow {
  id: string;
}

interface RuleRow extends CommentRuleMatch {
  id: string;
  keyword: string;
  private_reply_text: string;
  follow_gate_enabled: boolean;
  confirmation_keyword: string;
  confirmation_button_title: string;
  follower_reply_text: string;
  non_follower_reply_text: string;
}

export async function ingestComments(pool: Pool, comments: readonly InstagramComment[]): Promise<void> {
  if (comments.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const comment of comments) {
      const connections = await client.query<ConnectionRow>(
        "SELECT id, workspace_id FROM instagram_connections WHERE account_id = $1 AND active = true",
        [comment.accountId],
      );
      const connection = connections.rows[0];
      if (!connection) continue;

      const events = await client.query<EventRow>(
        `INSERT INTO instagram_comment_events
          (workspace_id, connection_id, comment_id, media_id, sender_id, comment_text)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (connection_id, comment_id) DO NOTHING
         RETURNING id`,
        [connection.workspace_id, connection.id, comment.commentId, comment.postId, comment.senderId, comment.text],
      );
      const event = events.rows[0];
      if (!event) continue;

      const rules = await client.query<RuleRow>(
        `SELECT id, keyword, keywords, match_mode, excluded_keywords, private_reply_text, follow_gate_enabled, confirmation_keyword, confirmation_button_title, follower_reply_text, non_follower_reply_text FROM instagram_comment_rules
         WHERE workspace_id = $1 AND connection_id = $2 AND media_id = $3 AND enabled = true`,
        [connection.workspace_id, connection.id, comment.postId],
      );
      const rule = rules.rows[0];
      if (!rule || !matchesCommentRule(comment.text, rule)) continue;

      await client.query(
        `INSERT INTO private_reply_outbox
          (workspace_id, connection_id, event_id, rule_id, comment_id, media_id, sender_id, private_reply_text, follow_config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [
          connection.workspace_id,
          connection.id,
          event.id,
          rule.id,
          comment.commentId,
          comment.postId,
          comment.senderId,
          rule.private_reply_text,
          rule.follow_gate_enabled
            ? JSON.stringify({
                confirmation_keyword: rule.confirmation_keyword,
                confirmation_button_title: rule.confirmation_button_title,
                follower_reply_text: rule.follower_reply_text,
                non_follower_reply_text: rule.non_follower_reply_text,
              })
            : null,
        ],
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
