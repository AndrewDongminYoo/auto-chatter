import type { Pool, PoolClient } from "pg";
import type { InstagramComment } from "./webhook.ts";
import { matchesCommentRule, type CommentRuleMatch } from "./comment-rule.ts";
import { parseFlowDocument } from "../app/flow-schema.ts";
import { matchesFlowTrigger, planFlowRun } from "../app/flow-runtime.ts";

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
      // An enabled rule and a published flow never share one media, so only one of them can answer.
      if (!rule) {
        await startFlowRun(client, connection, event.id, comment);
        continue;
      }
      if (!matchesCommentRule(comment.text, rule)) continue;

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

// Starts the enabled flow published for this media, inside the comment's ingestion transaction.
async function startFlowRun(
  client: PoolClient,
  connection: ConnectionRow,
  eventId: string,
  comment: InstagramComment,
): Promise<void> {
  const flows = await client.query<{ flow_id: string; version_id: string; definition: unknown }>(
    `SELECT f.id AS flow_id,v.id AS version_id,v.definition FROM flows f
     JOIN flow_versions v ON v.id=f.published_version_id AND v.flow_id=f.id
     WHERE f.workspace_id=$1 AND f.enabled AND NOT f.archived AND v.trigger_connection_id=$2 AND v.trigger_media_id=$3`,
    [connection.workspace_id, connection.id, comment.postId],
  );
  const flow = flows.rows[0];
  if (!flow) return;
  const parsed = parseFlowDocument(flow.definition);
  const document = "document" in parsed ? parsed.document : null;
  if (document && !matchesFlowTrigger(document, comment.text)) return;
  const tags = await client.query<{ tags: string[] }>(
    "SELECT tags FROM instagram_contact_tags WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3",
    [connection.workspace_id, connection.id, comment.senderId],
  );
  const fields = await client.query<{ field_id: string; value: unknown }>(
    `SELECT field_id::text,value FROM instagram_contact_field_values
     WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3`,
    [connection.workspace_id, connection.id, comment.senderId],
  );
  const plan = document
    ? planFlowRun(document, {
        tags: new Set(tags.rows[0]?.tags ?? []),
        fields: new Map(fields.rows.map((row) => [row.field_id, row.value])),
      })
    : ({ status: "failed", steps: [], failure_code: "invalid_definition" } as const);
  const runs = await client.query<{ id: string }>(
    `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,event_id,status,failure_code)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(flow_id,event_id) DO NOTHING RETURNING id`,
    [
      connection.workspace_id,
      connection.id,
      flow.flow_id,
      flow.version_id,
      eventId,
      plan.status === "message" ? "delivering" : plan.status,
      plan.status === "failed" ? plan.failure_code : null,
    ],
  );
  const run = runs.rows[0];
  if (!run) return;
  const steps = [...plan.steps];
  if (plan.status === "message") {
    // The outbox keeps one private reply per sender and media, whichever rule or flow queued it.
    const queued = await client.query(
      `INSERT INTO private_reply_outbox
        (workspace_id,connection_id,event_id,flow_run_id,comment_id,media_id,sender_id,private_reply_text)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
      [
        connection.workspace_id,
        connection.id,
        eventId,
        run.id,
        comment.commentId,
        comment.postId,
        comment.senderId,
        plan.text,
      ],
    );
    if (!queued.rowCount) {
      steps[steps.length - 1] = { ...steps[steps.length - 1]!, outcome: "duplicate_recipient" };
      await client.query("UPDATE flow_runs SET status='skipped',failure_code='duplicate_recipient' WHERE id=$1", [
        run.id,
      ]);
    }
  }
  await client.query(
    `INSERT INTO flow_step_runs(run_id,workspace_id,connection_id,seq,node_id,node_type,outcome)
     SELECT $1,$2,$3,step.seq-1,step.node_id,step.node_type,step.outcome
     FROM unnest($4::text[],$5::text[],$6::text[]) WITH ORDINALITY AS step(node_id,node_type,outcome,seq)`,
    [
      run.id,
      connection.workspace_id,
      connection.id,
      steps.map((step) => step.node_id),
      steps.map((step) => step.node_type),
      steps.map((step) => step.outcome),
    ],
  );
}
