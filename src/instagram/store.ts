import type { Pool, PoolClient } from "pg";
import type { InstagramComment } from "./webhook.ts";
import { matchesCommentRule, type CommentRuleMatch } from "./comment-rule.ts";
import { parseFlowDocument, type FlowDocument } from "../app/flow-schema.ts";
import { matchesFlowTrigger, planFlowRun, type FlowChanges, type FlowPlan } from "../app/flow-runtime.ts";
import { lockContact } from "../app/contact-fields.ts";

const ACTION_TYPES = new Set(["add_tag", "remove_tag", "set_field"]);

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
  if (document && hasActions(document)) {
    // A run that changes contact data takes the contact-write connection lock (see
    // lockContactConnection), so it serializes with data deletion and sees a disconnect.
    const locked = await client.query(
      "SELECT 1 FROM instagram_connections WHERE id=$1 AND workspace_id=$2 AND active FOR SHARE",
      [connection.id, connection.workspace_id],
    );
    if (!locked.rowCount) return;
  }
  const writableFields = document
    ? await lockRunContact(client, connection, document, comment.senderId)
    : new Set<string>();
  const facts = await readContact(client, connection, comment.senderId);
  const plan: FlowPlan = document
    ? planFlowRun(document, facts, { commentText: comment.text, writableFields })
    : {
        status: "failed",
        steps: [],
        failure_code: "invalid_definition",
        changes: { tags: new Map(), fields: new Map() },
      };
  const runs = await client.query<{ id: string }>(
    `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,event_id,status,failure_code,resume_at,resume_node_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+make_interval(mins=>$8),$9) ON CONFLICT(flow_id,event_id) DO NOTHING RETURNING id`,
    [
      connection.workspace_id,
      connection.id,
      flow.flow_id,
      flow.version_id,
      eventId,
      runStatus(plan),
      plan.status === "failed" ? plan.failure_code : null,
      plan.status === "waiting" ? plan.delay_minutes : null,
      plan.status === "waiting" ? plan.resume_node_id : null,
    ],
  );
  const run = runs.rows[0];
  if (!run) return;
  await recordPlan(client, connection, run.id, { eventId, ...comment }, facts.stored, plan, 0);
}

function hasActions(document: FlowDocument): boolean {
  return document.nodes.some((node) => ACTION_TYPES.has(node.type));
}

function runStatus(plan: FlowPlan): string {
  return plan.status === "message" ? "delivering" : plan.status;
}

// Locks what a run with actions writes and returns the fields it may still set. The share lock keeps
// a field from being archived before this transaction writes its value, and the contact lock is held
// until commit, so another run or a manual edit cannot change this contact's tags or field values
// between this run's read and its write: every recorded outcome is what was stored.
async function lockRunContact(
  client: PoolClient,
  connection: ConnectionRow,
  document: FlowDocument,
  senderId: string,
): Promise<Set<string>> {
  if (!hasActions(document)) return new Set();
  const targets = document.nodes.flatMap((node) =>
    node.type === "set_field" && typeof node.config.field_id === "string" ? [node.config.field_id] : [],
  );
  const writable = await client.query<{ id: string }>(
    "SELECT id::text FROM instagram_contact_fields WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND NOT archived FOR SHARE",
    [connection.workspace_id, targets],
  );
  await lockContact(client, connection.id, senderId);
  return new Set(writable.rows.map((row) => row.id));
}

async function readContact(client: PoolClient, connection: ConnectionRow, senderId: string) {
  const tags = await client.query<{ tags: string[] }>(
    "SELECT tags FROM instagram_contact_tags WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3",
    [connection.workspace_id, connection.id, senderId],
  );
  const fields = await client.query<{ field_id: string; value: unknown }>(
    `SELECT field_id::text,value FROM instagram_contact_field_values
     WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3`,
    [connection.workspace_id, connection.id, senderId],
  );
  const stored = tags.rows[0]?.tags ?? [];
  return { stored, tags: new Set(stored), fields: new Map(fields.rows.map((row) => [row.field_id, row.value])) };
}

type RunComment = { eventId: string; commentId: string; postId: string; senderId: string };

// Stores what one walk of a run produced: contact changes, the queued reply and the steps, numbered
// from firstSeq so a resumed run continues its path.
async function recordPlan(
  client: PoolClient,
  connection: ConnectionRow,
  runId: string,
  comment: RunComment,
  stored: readonly string[],
  plan: FlowPlan,
  firstSeq: number,
): Promise<void> {
  await applyContactChanges(client, connection, comment.senderId, stored, plan.changes);
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
        comment.eventId,
        runId,
        comment.commentId,
        comment.postId,
        comment.senderId,
        plan.text,
      ],
    );
    if (!queued.rowCount) {
      steps[steps.length - 1] = { ...steps[steps.length - 1]!, outcome: "duplicate_recipient" };
      await client.query("UPDATE flow_runs SET status='skipped',failure_code='duplicate_recipient' WHERE id=$1", [
        runId,
      ]);
    }
  }
  await client.query(
    `INSERT INTO flow_step_runs(run_id,workspace_id,connection_id,seq,node_id,node_type,outcome)
     SELECT $1,$2,$3,$7+step.seq-1,step.node_id,step.node_type,step.outcome
     FROM unnest($4::text[],$5::text[],$6::text[]) WITH ORDINALITY AS step(node_id,node_type,outcome,seq)`,
    [
      runId,
      connection.workspace_id,
      connection.id,
      steps.map((step) => step.node_id),
      steps.map((step) => step.node_type),
      steps.map((step) => step.outcome),
      firstSeq,
    ],
  );
}

// Advances waiting runs whose delay has passed (#32), one transaction per run so one failing run
// does not hold back the others. The connection is locked FOR SHARE before the run row, the same
// order as the data deletion functions (connection, then its rows), so the two never deadlock; the
// run is then claimed with SKIP LOCKED and must still be waiting, so overlapping resumers, a
// redeploy or a lost notification advance it once. Returns how many runs were advanced.
export async function resumeDueFlowRuns(pool: Pool, limit = 50): Promise<number> {
  let advanced = 0;
  let failed = 0;
  const passed: string[] = [];
  while (advanced + passed.length < limit) {
    const due = await pool.query<{ id: string; connection_id: string }>(
      `SELECT id::text,connection_id::text FROM flow_runs
       WHERE status='waiting' AND resume_at<=now() AND NOT id=ANY($1::uuid[]) ORDER BY resume_at,id LIMIT 1`,
      [passed],
    );
    const candidate = due.rows[0];
    if (!candidate) break;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const done = await resumeFlowRun(client, candidate.id, candidate.connection_id);
      await client.query("COMMIT");
      if (done) advanced++;
      else passed.push(candidate.id);
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      passed.push(candidate.id);
      failed++;
    } finally {
      client.release();
    }
  }
  if (failed) throw new Error(`Flow run resume failed for ${failed} run(s)`);
  return advanced;
}

async function resumeFlowRun(client: PoolClient, runId: string, connectionId: string): Promise<boolean> {
  const connections = await client.query<{ workspace_id: string; active: boolean }>(
    "SELECT workspace_id::text,active FROM instagram_connections WHERE id=$1 FOR SHARE",
    [connectionId],
  );
  const connection = connections.rows[0];
  if (!connection) return false;
  const claimed = await client.query<{
    resume_node_id: string;
    flow_on: boolean;
    definition: unknown;
    event_id: string;
    comment_id: string;
    media_id: string;
    sender_id: string;
    comment_text: string;
  }>(
    `SELECT run.resume_node_id,f.enabled AND NOT f.archived AS flow_on,v.definition,run.event_id::text,
            e.comment_id,e.media_id,e.sender_id,e.comment_text
     FROM flow_runs run JOIN flows f ON f.id=run.flow_id JOIN flow_versions v ON v.id=run.flow_version_id
     JOIN instagram_comment_events e ON e.id=run.event_id
     WHERE run.id=$1 AND run.connection_id=$2 AND run.status='waiting' AND run.resume_at<=now()
     FOR UPDATE OF run SKIP LOCKED`,
    [runId, connectionId],
  );
  const run = claimed.rows[0];
  if (!run) return false;
  // A delay counts from when the run reaches it: clock_timestamp(), not the transaction's now(), so
  // time spent waiting for locks is not taken out of the next wait.
  const finish = (status: string, failureCode: string | null, delayMinutes: number | null, resumeNode: string | null) =>
    client.query(
      `UPDATE flow_runs SET status=$2,failure_code=$3,resume_at=clock_timestamp()+make_interval(mins=>$4),resume_node_id=$5
       WHERE id=$1 AND status='waiting'`,
      [runId, status, failureCode, delayMinutes, resumeNode],
    );
  // Turning the flow off or losing the connection during the delay ends the run before any node
  // after the delay runs; turning it back on does not revive it.
  if (!connection.active) {
    await finish("cancelled", "connection_unavailable", null, null);
    return true;
  }
  if (!run.flow_on) {
    await finish("cancelled", "inactive_flow", null, null);
    return true;
  }
  const owner: ConnectionRow = { id: connectionId, workspace_id: connection.workspace_id };
  const parsed = parseFlowDocument(run.definition);
  const document = "document" in parsed ? parsed.document : null;
  const writableFields = document ? await lockRunContact(client, owner, document, run.sender_id) : new Set<string>();
  const facts = await readContact(client, owner, run.sender_id);
  const plan: FlowPlan = document
    ? planFlowRun(document, facts, { commentText: run.comment_text, writableFields }, run.resume_node_id)
    : {
        status: "failed",
        steps: [],
        failure_code: "invalid_definition",
        changes: { tags: new Map(), fields: new Map() },
      };
  await finish(
    runStatus(plan),
    plan.status === "failed" ? plan.failure_code : null,
    plan.status === "waiting" ? plan.delay_minutes : null,
    plan.status === "waiting" ? plan.resume_node_id : null,
  );
  const next = await client.query<{ seq: number }>(
    "SELECT coalesce(max(seq),-1)+1 AS seq FROM flow_step_runs WHERE run_id=$1",
    [runId],
  );
  await recordPlan(
    client,
    owner,
    runId,
    { eventId: run.event_id, commentId: run.comment_id, postId: run.media_id, senderId: run.sender_id },
    facts.stored,
    plan,
    next.rows[0]!.seq,
  );
  return true;
}

// Writes a run's net tag and field changes under the contact lock taken in startFlowRun.
async function applyContactChanges(
  client: PoolClient,
  connection: ConnectionRow,
  senderId: string,
  stored: readonly string[],
  changes: FlowChanges,
): Promise<void> {
  const key = [connection.workspace_id, connection.id, senderId];
  if (changes.tags.size)
    await client.query(
      `INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,$4::text[])
       ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET tags=EXCLUDED.tags`,
      [
        ...key,
        [
          ...stored.filter((tag) => changes.tags.get(tag) !== false),
          ...[...changes.tags].filter(([, member]) => member).map(([tag]) => tag),
        ],
      ],
    );
  if (changes.fields.size)
    await client.query(
      `INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value)
       SELECT $1,$2,$3,item.field_id,item.value::jsonb FROM unnest($4::uuid[],$5::text[]) AS item(field_id,value)
       ON CONFLICT(workspace_id,connection_id,sender_id,field_id) DO UPDATE SET value=EXCLUDED.value`,
      [...key, [...changes.fields.keys()], [...changes.fields.values()].map((value) => JSON.stringify(value))],
    );
}
