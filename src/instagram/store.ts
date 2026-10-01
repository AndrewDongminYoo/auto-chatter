import type { Pool, PoolClient } from "pg";
import type { InstagramComment } from "./webhook.ts";
import { matchesCommentRule, type CommentRuleMatch } from "./comment-rule.ts";
import { parseFlowDocument, type FlowDocument } from "../app/flow-schema.ts";
import {
  matchesFlowTrigger,
  planFlowRun,
  type FlowChanges,
  type FlowPlan,
  type ResumeEntry,
} from "../app/flow-runtime.ts";
import { lockContact, replySavedFields } from "../app/contact-fields.ts";

const ACTION_TYPES = new Set(["add_tag", "remove_tag", "set_field"]);
// When a reply wait ends: the time its private reply was sent plus the timeout of the wait node in
// the run's pinned version. Used where flow_runs is `run`, its reply `reply` and its version `v`.
const REPLY_DEADLINE = `reply.sent_at+make_interval(mins=>jsonb_path_query_first(v.definition,
  'lax $.nodes[*] ? (@.id == $id && @.type == "wait_for_reply").config.timeout_minutes',
  jsonb_build_object('id',run.resume_node_id))::int)`;
// A typed DM kept while the run's reply was being sent (#108) that the reconcile has not linked yet and
// that may still answer the wait: from the reply's recipient, dated from its last attempt start to
// before the wait ends, still holding its text and under 15 minutes old. A wait does not time out
// while one exists, so a reconcile that was skipped, failed or ran out of rows links it first; the
// 15-minute boundary limits the delay. Same aliases as REPLY_DEADLINE.
const UNLINKED_KEPT_ANSWER = `EXISTS(SELECT 1 FROM instagram_unmatched_replies kept
  WHERE kept.connection_id=run.connection_id AND kept.sender_id=reply.recipient_id AND kept.matched_at IS NULL
    AND kept.message_text IS NOT NULL AND kept.received_at>now()-interval '15 minutes'
    AND kept.confirmation_reply_id IS NULL AND kept.message_at>=reply.attempt_started_at
    AND kept.message_at<${REPLY_DEADLINE})`;

// The first instant strictly after `at` at which the wall clock in `zone` reads `time` (#32): today's
// occurrence in that zone if it is still ahead, otherwise tomorrow's. `at` is read once (the input row
// is the outer side of every lateral join), so all candidates compare against the same instant. The
// local day comes from `at AT TIME ZONE zone`, never from the session time zone, and the offsets come
// from PostgreSQL's zone data. A time skipped when clocks go forward is PostgreSQL's reading, with the
// offset before the change (02:30 becomes 03:30). A time that occurs twice when clocks go back has one
// instant per offset in force within three hours of PostgreSQL's reading, and the earliest one still
// ahead is used, so the first 01:30 comes before the second. Every interval is under a day, so no
// arithmetic depends on the session time zone. Exported so tests run the same text with fixed instants.
export function nextWallClockSql(at: string, zone: string, time: string): string {
  return `(SELECT min(c)
    FROM (SELECT (${at})::timestamptz AS a,(${zone})::text AS z,(${time})::time AS t) wall_input
    CROSS JOIN LATERAL (SELECT (a AT TIME ZONE z)::date+d+t AS l FROM generate_series(-1,1) d) wall_day
    CROSS JOIN LATERAL (SELECT l AT TIME ZONE z AS fold) wall_fold
    CROSS JOIN LATERAL (SELECT fold AS c UNION ALL
      SELECT (l AT TIME ZONE 'UTC')-((p AT TIME ZONE z)-(p AT TIME ZONE 'UTC'))
      FROM unnest(ARRAY[fold-interval '3 hours',fold+interval '3 hours']) p) wall_candidate
    WHERE c>a AND (c=fold OR c AT TIME ZONE z=l))`;
}

// When a stopped run resumes: a delay counts its minutes from now, a time wait goes to the next
// occurrence of its local time in the workspace's current time zone, and any other state has no
// resume time. clock_timestamp(), not the transaction's now(), so time spent waiting for locks is not
// taken out of the wait. `workspace` is SQL naming the run's workspace ID.
function resumeAtSql(workspace: string, minutes: string, until: string): string {
  return `CASE WHEN ${until}::text IS NULL THEN clock_timestamp()+make_interval(mins=>${minutes})
    ELSE ${nextWallClockSql("clock_timestamp()", `SELECT time_zone FROM workspaces WHERE id=${workspace}`, `${until}::text`)} END`;
}

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
  const flows = await client.query<{ flow_id: string; version_id: string; version_no: number; definition: unknown }>(
    `SELECT f.id AS flow_id,v.id AS version_id,v.version_no,v.definition FROM flows f
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
    ? planFlowRun(document, facts, {
        commentText: comment.text,
        writableFields,
        replyFields: await webhookReplyFields(client, connection, document),
      })
    : {
        status: "failed",
        steps: [],
        failure_code: "invalid_definition",
        changes: { tags: new Map(), fields: new Map() },
      };
  const state = runState(plan);
  const runs = await client.query<{ id: string }>(
    `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,event_id,status,failure_code,resume_at,resume_node_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,${resumeAtSql("$1", "$8", "$10")},$9) ON CONFLICT(flow_id,event_id) DO NOTHING RETURNING id`,
    [
      connection.workspace_id,
      connection.id,
      flow.flow_id,
      flow.version_id,
      eventId,
      state.status,
      state.failureCode,
      state.delayMinutes,
      state.resumeNodeId,
      state.untilTime,
    ],
  );
  const run = runs.rows[0];
  if (!run) return;
  await recordPlan(
    client,
    connection,
    { id: run.id, flowId: flow.flow_id, versionNo: flow.version_no },
    { eventId, ...comment },
    facts.stored,
    plan,
    0,
  );
}

// Whether a run of this version may change contact data: an action, or a reply wait that saves the
// reply into a field.
function hasActions(document: FlowDocument): boolean {
  return document.nodes.some(
    (node) =>
      ACTION_TYPES.has(node.type) || (node.type === "wait_for_reply" && node.config.save_field_id !== undefined),
  );
}

// How a run is stored after a walk. A queued message followed by a reply wait leaves the run
// awaiting a reply at that wait, with no resume time: the wait counts from when the reply is sent.
function runState(plan: FlowPlan): {
  status: string;
  failureCode: string | null;
  delayMinutes: number | null;
  untilTime: string | null;
  resumeNodeId: string | null;
} {
  const none = { failureCode: null, delayMinutes: null, untilTime: null };
  if (plan.status === "message")
    return plan.wait_node_id === undefined
      ? { ...none, status: "delivering", resumeNodeId: null }
      : { ...none, status: "awaiting_reply", resumeNodeId: plan.wait_node_id };
  if (plan.status === "waiting")
    return {
      ...none,
      status: "waiting",
      ...("until_time" in plan ? { untilTime: plan.until_time } : { delayMinutes: plan.delay_minutes }),
      resumeNodeId: plan.resume_node_id,
    };
  return {
    ...none,
    status: plan.status,
    failureCode: plan.status === "failed" ? plan.failure_code : null,
    resumeNodeId: null,
  };
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
    node.type === "set_field" && typeof node.config.field_id === "string"
      ? [node.config.field_id]
      : node.type === "wait_for_reply" && typeof node.config.save_field_id === "string"
        ? [node.config.save_field_id]
        : [],
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

// The fields this version's webhook nodes name that a published version of the workspace saves a reply
// into (#47); the walk leaves them out of every payload. Read after the contact facts: a version is
// published before any reply it saves, so a stored reply is never read without its version being seen here.
async function webhookReplyFields(
  client: PoolClient,
  connection: ConnectionRow,
  document: FlowDocument,
): Promise<Set<string>> {
  const named = document.nodes.flatMap((node) =>
    node.type === "webhook" && Array.isArray(node.config.field_ids) ? node.config.field_ids : [],
  );
  return replySavedFields(client, connection.workspace_id, named);
}

type RunComment = { eventId: string; commentId: string; postId: string; senderId: string };
type RunIdentity = { id: string; flowId: string; versionNo: number };

// Queues one outbound delivery per webhook node the walk reached (#47), in the run's transaction. The
// payload is the whole request body: the tags and field values the node chose and processing identifiers.
// It never holds comment or DM text (the walk leaves out every field a reply wait saves a reply into), a
// username or an Instagram identifier; the comment sender is stored
// beside it only so person deletion finds the row. One delivery exists per run and node, and an endpoint
// outside the workspace queues nothing; either case is recorded on the node's step as not_queued.
async function queueWebhooks(
  client: PoolClient,
  connection: ConnectionRow,
  run: RunIdentity,
  senderId: string,
  plan: FlowPlan,
  steps: FlowPlan["steps"],
): Promise<void> {
  for (const webhook of plan.webhooks ?? []) {
    const eventId = crypto.randomUUID();
    const queued = await client.query(
      `INSERT INTO webhook_deliveries(event_id,workspace_id,endpoint_id,connection_id,flow_id,flow_run_id,node_id,sender_id,payload)
       SELECT $1,$2,endpoint.id,$4,$5,$6,$7,$8,$9::jsonb FROM webhook_endpoints endpoint
       WHERE endpoint.id=$3 AND endpoint.workspace_id=$2
       ON CONFLICT(flow_run_id,node_id) DO NOTHING RETURNING event_id`,
      [
        eventId,
        connection.workspace_id,
        webhook.endpoint_id,
        connection.id,
        run.flowId,
        run.id,
        webhook.node_id,
        senderId,
        JSON.stringify({
          event_id: eventId,
          type: "flow.webhook",
          created_at: new Date().toISOString(),
          flow_id: run.flowId,
          flow_version: run.versionNo,
          run_id: run.id,
          node_id: webhook.node_id,
          ...(webhook.tags === undefined ? {} : { tags: webhook.tags }),
          fields: webhook.fields,
        }),
      ],
    );
    if (queued.rowCount) continue;
    const index = steps.findIndex((step) => step.node_id === webhook.node_id && step.node_type === "webhook");
    if (index >= 0) steps[index] = { ...steps[index]!, outcome: "not_queued" };
  }
}

// Stores what one walk of a run produced: contact changes, the queued webhook deliveries and reply, and
// the steps, numbered from firstSeq so a resumed run continues its path.
async function recordPlan(
  client: PoolClient,
  connection: ConnectionRow,
  run: RunIdentity,
  comment: RunComment,
  stored: readonly string[],
  plan: FlowPlan,
  firstSeq: number,
): Promise<void> {
  const runId = run.id;
  await applyContactChanges(client, connection, comment.senderId, stored, plan.changes);
  const steps = [...plan.steps];
  await queueWebhooks(client, connection, run, comment.senderId, plan, steps);
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
      await client.query(
        "UPDATE flow_runs SET status='skipped',failure_code='duplicate_recipient',resume_at=NULL,resume_node_id=NULL WHERE id=$1",
        [runId],
      );
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

// Advances waiting runs whose delay has passed and runs whose reply wait timed out (#32), one
// transaction per run so one failing run does not hold back the others. A reply wait times out only
// once its private reply is sent; a reply that is blocked, failed, unknown or still queued keeps the
// run waiting, and so does a kept DM that may still answer it (UNLINKED_KEPT_ANSWER). The connection is
// locked FOR SHARE before the run row, the same order as the data
// deletion functions (connection, then its rows), so the two never deadlock; the run is then claimed
// with SKIP LOCKED and must still be due, so overlapping resumers, a redeploy or a lost notification
// advance it once. Returns how many runs were advanced.
export async function resumeDueFlowRuns(pool: Pool, limit = 50): Promise<number> {
  let advanced = 0;
  let failed = 0;
  const passed: string[] = [];
  while (advanced + passed.length < limit) {
    const due = await pool.query<{ id: string; connection_id: string }>(
      `SELECT id::text,connection_id::text FROM (
         SELECT run.id,run.connection_id,run.resume_at AS due FROM flow_runs run
         WHERE run.status='waiting' AND run.resume_at<=now()
         UNION ALL
         SELECT run.id,run.connection_id,${REPLY_DEADLINE} AS due FROM flow_runs run
         JOIN private_reply_outbox reply ON reply.flow_run_id=run.id JOIN flow_versions v ON v.id=run.flow_version_id
         WHERE run.status='awaiting_reply' AND reply.status='sent' AND ${REPLY_DEADLINE}<=now()
           AND NOT ${UNLINKED_KEPT_ANSWER}
       ) due_runs WHERE NOT id=ANY($1::uuid[]) ORDER BY due,id LIMIT 1`,
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

type ClaimedRun = {
  status: string;
  resume_node_id: string;
  flow_on: boolean;
  definition: unknown;
  event_id: string;
  comment_id: string;
  media_id: string;
  sender_id: string;
  comment_text: string;
  flow_id: string;
  version_no: number;
};

const CLAIMED_RUN = `SELECT run.status,run.resume_node_id,f.enabled AND NOT f.archived AS flow_on,v.definition,
    run.event_id::text,e.comment_id,e.media_id,e.sender_id,e.comment_text,run.flow_id::text,v.version_no
  FROM flow_runs run JOIN flows f ON f.id=run.flow_id JOIN flow_versions v ON v.id=run.flow_version_id
  JOIN instagram_comment_events e ON e.id=run.event_id
  LEFT JOIN private_reply_outbox reply ON reply.flow_run_id=run.id`;

async function lockRunConnection(client: PoolClient, connectionId: string) {
  return (
    await client.query<{ workspace_id: string; active: boolean }>(
      "SELECT workspace_id::text,active FROM instagram_connections WHERE id=$1 FOR SHARE",
      [connectionId],
    )
  ).rows[0];
}

async function resumeFlowRun(client: PoolClient, runId: string, connectionId: string): Promise<boolean> {
  const connection = await lockRunConnection(client, connectionId);
  if (!connection) return false;
  const claimed = await client.query<ClaimedRun>(
    `${CLAIMED_RUN}
     WHERE run.id=$1 AND run.connection_id=$2 AND ((run.status='waiting' AND run.resume_at<=now())
       OR (run.status='awaiting_reply' AND reply.status='sent' AND ${REPLY_DEADLINE}<=now()
         AND NOT ${UNLINKED_KEPT_ANSWER}))
     FOR UPDATE OF run SKIP LOCKED`,
    [runId, connectionId],
  );
  const run = claimed.rows[0];
  if (!run) return false;
  const port = run.status === "waiting" ? "next" : "timeout";
  await continueFlowRun(client, runId, connectionId, connection, run, { node_id: run.resume_node_id, port });
  return true;
}

// Advances the run awaiting a reply to the private reply this DM answers (#32), inside the message
// ingestion transaction. The run's reply must be sent to this sender, sent no later than the message
// and still within its wait; the most recent reply wins when several runs wait for the same person.
// `early` is the reconcile of a DM kept while its reply was being sent (#108): the reply's last send
// attempt, not its sent_at, must have started no later than the message. The wait still ends at sent_at
// plus its timeout.
// The connection is locked FOR SHARE before the run row, as in resumeDueFlowRuns, and the run is
// claimed FOR UPDATE without SKIP LOCKED: a concurrent timeout or another message either finishes
// first, and the claim then sees the run is no longer awaiting a reply, or waits for this transaction.
// A lost claim moves on to the next most recent candidate, so two different messages arriving together
// advance two runs, as they would one after the other. Each lookup and claim is a new statement and
// sees what committed meanwhile. The run keeps the message ID it ended on, so a redelivered message,
// even one delivered concurrently, advances neither that run again nor another run waiting on the
// same person.
export async function resumeRepliedFlowRun(
  client: PoolClient,
  message: { accountId: string; senderId: string; messageId: string; text: string; timestamp: Date },
  early = false,
): Promise<boolean> {
  const since = early ? "reply.attempt_started_at" : "reply.sent_at";
  const unanswered = `NOT EXISTS(SELECT 1 FROM flow_runs answered WHERE answered.connection_id=run.connection_id
    AND answered.reply_message_id=$4)`;
  const lost: string[] = [];
  for (;;) {
    const candidates = await client.query<{ id: string; connection_id: string }>(
      `SELECT run.id::text,run.connection_id::text FROM flow_runs run
       JOIN private_reply_outbox reply ON reply.flow_run_id=run.id JOIN flow_versions v ON v.id=run.flow_version_id
       JOIN instagram_connections c ON c.id=run.connection_id
       WHERE run.status='awaiting_reply' AND c.account_id=$1 AND reply.status='sent' AND reply.recipient_id=$2
         AND ${since}<=$3 AND $3<${REPLY_DEADLINE} AND ${unanswered} AND run.id<>ALL($5::uuid[])
       ORDER BY reply.sent_at DESC,reply.id DESC LIMIT 1`,
      [message.accountId, message.senderId, message.timestamp, message.messageId, lost],
    );
    const candidate = candidates.rows[0];
    if (!candidate) return false;
    lost.push(candidate.id);
    const connection = await lockRunConnection(client, candidate.connection_id);
    if (!connection) continue;
    const claimed = await client.query<ClaimedRun>(
      `${CLAIMED_RUN}
       WHERE run.id=$1 AND run.connection_id=$2 AND run.status='awaiting_reply' AND reply.status='sent'
         AND reply.recipient_id=$3 AND ${since}<=$5 AND $5<${REPLY_DEADLINE} AND ${unanswered}
       FOR UPDATE OF run`,
      [candidate.id, candidate.connection_id, message.senderId, message.messageId, message.timestamp],
    );
    const run = claimed.rows[0];
    if (!run) continue;
    await continueFlowRun(
      client,
      candidate.id,
      candidate.connection_id,
      connection,
      run,
      { node_id: run.resume_node_id, port: "replied" },
      { text: message.text, messageId: message.messageId },
    );
    return true;
  }
}

// Continues a claimed run from where it stopped, under the connection lock its caller holds.
async function continueFlowRun(
  client: PoolClient,
  runId: string,
  connectionId: string,
  connection: { workspace_id: string; active: boolean },
  run: ClaimedRun,
  entry: ResumeEntry,
  reply?: { text: string; messageId: string },
): Promise<void> {
  // A delay or a time wait counts from when the run reaches it (resumeAtSql), and a time wait reads
  // the workspace time zone at that moment. A reply is recorded on the run even when it only cancels
  // it, because the message was still used up by this run.
  const finish = (state: ReturnType<typeof runState>) =>
    client.query(
      `UPDATE flow_runs SET status=$2,failure_code=$3,resume_at=${resumeAtSql("flow_runs.workspace_id", "$4", "$8")},
         resume_node_id=$5,reply_message_id=coalesce($7,reply_message_id)
       WHERE id=$1 AND status=$6`,
      [
        runId,
        state.status,
        state.failureCode,
        state.delayMinutes,
        state.resumeNodeId,
        run.status,
        reply?.messageId ?? null,
        state.untilTime,
      ],
    );
  const cancelled = (failureCode: string) =>
    finish({ status: "cancelled", failureCode, delayMinutes: null, untilTime: null, resumeNodeId: null });
  // Turning the flow off or losing the connection during a delay or a reply wait ends the run before
  // any node after it runs; turning it back on does not revive it.
  if (!connection.active) {
    await cancelled("connection_unavailable");
    return;
  }
  if (!run.flow_on) {
    await cancelled("inactive_flow");
    return;
  }
  const owner: ConnectionRow = { id: connectionId, workspace_id: connection.workspace_id };
  const parsed = parseFlowDocument(run.definition);
  const document = "document" in parsed ? parsed.document : null;
  const writableFields = document ? await lockRunContact(client, owner, document, run.sender_id) : new Set<string>();
  const facts = await readContact(client, owner, run.sender_id);
  const plan: FlowPlan = document
    ? planFlowRun(
        document,
        facts,
        {
          commentText: run.comment_text,
          writableFields,
          replyFields: await webhookReplyFields(client, owner, document),
          ...(reply === undefined ? {} : { replyText: reply.text }),
        },
        entry,
      )
    : {
        status: "failed",
        steps: [],
        failure_code: "invalid_definition",
        changes: { tags: new Map(), fields: new Map() },
      };
  await finish(runState(plan));
  const next = await client.query<{ seq: number }>(
    "SELECT coalesce(max(seq),-1)+1 AS seq FROM flow_step_runs WHERE run_id=$1",
    [runId],
  );
  await recordPlan(
    client,
    owner,
    { id: runId, flowId: run.flow_id, versionNo: run.version_no },
    { eventId: run.event_id, commentId: run.comment_id, postId: run.media_id, senderId: run.sender_id },
    facts.stored,
    plan,
    next.rows[0]!.seq,
  );
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
