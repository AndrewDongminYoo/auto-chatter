import type { PoolClient } from "pg";
import type { InstagramMessage } from "./message-events.ts";
import { matchesCommentRule } from "./comment-rule.ts";
import { CONVERSATION_LABEL_LIMIT } from "../app/inbox-labels.ts";

// Serializes the state changes of one inbox conversation (connection and DM recipient) for the rest of the
// transaction. A row lock cannot do this alone: the first close inserts the state row, which a concurrent
// reopen cannot see or wait for until the close commits. The state API and DM ingestion
// (lockInboxConversations) take it exclusive, so DMs of one conversation are serialized with each other and
// with state changes, while DMs of different conversations never wait on each other. Callers take it after
// the connection FOR SHARE.
export async function lockConversation(
  client: PoolClient,
  connectionId: string,
  recipientId: string,
  mode: "shared" | "exclusive",
) {
  const lock = mode === "shared" ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock";
  await client.query(`SELECT ${lock}(hashtextextended('inbox-conversation:' || $1::uuid::text || ':' || $2, 0))`, [
    connectionId,
    recipientId,
  ]);
}

// A DM dated more than a minute ahead, or with text PostgreSQL cannot store, is never stored.
const storable = (message: InstagramMessage, now: Date) =>
  message.timestamp.getTime() <= now.getTime() + 60000 && !message.text.includes("\u0000");

// Takes, before any DM of the batch is stored, the conversation lock exclusive for every conversation the batch
// can store a DM into (#127). The read position is an ID watermark (`m.id > last_read_message_id`), so the DMs of
// one conversation must commit in the order of their IDs: holding the lock from before the INSERT that allocates
// the ID until COMMIT makes a second DM of the conversation take its ID only after the first one committed.
// The connections of the batch's accounts are locked FOR SHARE first, in ID order like the deletion functions,
// and only then is the storage predicate of storeInboxMessage evaluated, so the INSERT sees the connection state
// read here. The conversations are then locked in (connection, recipient) order, so batches with their senders
// in opposite orders queue instead of deadlocking.
export async function lockInboxConversations(
  client: PoolClient,
  messages: readonly InstagramMessage[],
  now: Date,
): Promise<void> {
  const batch = messages.filter((message) => storable(message, now));
  if (!batch.length) return;
  await client.query("SELECT 1 FROM instagram_connections WHERE account_id=ANY($1::text[]) ORDER BY id FOR SHARE", [
    [...new Set(batch.map((message) => message.accountId))],
  ]);
  const conversations = await client.query<{ connection_id: string; recipient_id: string }>(
    `SELECT DISTINCT c.id AS connection_id,m.recipient_id
     FROM unnest($1::text[],$2::text[],$3::timestamptz[]) AS m(account_id,recipient_id,message_at)
     JOIN instagram_connections c ON c.account_id=m.account_id AND c.active AND c.inbox_enabled AND c.inbox_enabled_at<=m.message_at
     ORDER BY c.id,m.recipient_id`,
    [
      batch.map((message) => message.accountId),
      batch.map((message) => message.senderId),
      batch.map((message) => message.timestamp),
    ],
  );
  for (const row of conversations.rows)
    await lockConversation(client, row.connection_id, row.recipient_id, "exclusive");
}

// A newly stored DM reopens its closed conversation (#22), with an audit row and no actor. A redelivered
// message inserts nothing and reopens nothing; a conversation without a state row is already open. The
// assignee and the handoff stay as they are.
export async function storeInboxMessage(client: PoolClient, message: InstagramMessage, now: Date): Promise<void> {
  if (!storable(message, now)) return;
  const stored = await client.query<{ workspace_id: string; connection_id: string }>(
    `INSERT INTO instagram_inbox_messages AS stored(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     SELECT workspace_id,id,$2,$3,$4,$5,$6 FROM instagram_connections
     WHERE account_id=$1 AND active AND inbox_enabled AND inbox_enabled_at<=$6
     ON CONFLICT(connection_id,message_id) DO NOTHING
     RETURNING stored.workspace_id::text,stored.connection_id::text`,
    [
      message.accountId,
      message.senderId,
      message.messageId,
      message.text,
      message.confirmationReplyId ? "postback" : "text",
      message.timestamp,
    ],
  );
  const inserted = stored.rows.sort((a, b) => a.connection_id.localeCompare(b.connection_id));
  for (const row of inserted) {
    // The connection FOR SHARE comes before the conversation, the order of the state API and the deletion
    // functions. The deletion functions lock the connection and then delete the conversation row, so taking the
    // conversation first would deadlock with them once this batch reaches a later connection lock
    // (sendingConnection, the reply wait). The conversation lock then waits for a close that is not yet
    // committed, so the UPDATE below (a new statement, with a new snapshot) sees it; the status read by the
    // INSERT above would still show the conversation as open. ingestMessages, the only production caller,
    // already holds both locks (the conversation one exclusive, from lockInboxConversations), so for it they are
    // re-acquisitions that never wait; they keep the reopen correct for a caller that did not take them first.
    await client.query("SELECT 1 FROM instagram_connections WHERE id=$1 FOR SHARE", [row.connection_id]);
    await lockConversation(client, row.connection_id, message.senderId, "shared");
    await client.query(
      `WITH reopened AS (
         UPDATE instagram_inbox_conversations SET status='open',version=version+1,updated_by=NULL,updated_at=now()
         WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND status='closed'
         RETURNING version,assignee_user_id
       )
       INSERT INTO instagram_inbox_conversation_events(workspace_id,connection_id,recipient_id,version,reason,from_status,to_status,from_assignee,to_assignee,actor_id)
       SELECT $1,$2,$3,version,'auto_reopen','closed','open',assignee_user_id,assignee_user_id,NULL FROM reopened`,
      [row.workspace_id, row.connection_id, message.senderId],
    );
    // A button postback is never matched against keyword rules; only a typed DM is.
    if (!message.confirmationReplyId)
      await applyLabelRules(client, row.workspace_id, row.connection_id, message.senderId, message.text);
  }
}

type LabelRule = {
  id: string;
  label_id: string;
  match_mode: "contains" | "exact";
  keywords: string[];
  excluded_keywords: string[];
};

// The labels the matching rules add, in rule order: only active labels that the conversation does not have and that
// no member ever removed from it, and only as many as fit in the set.
function labelsToAdd(
  candidates: readonly string[],
  current: readonly string[],
  active: readonly string[],
  removed: readonly string[],
): string[] {
  const room = CONVERSATION_LABEL_LIMIT - current.length;
  if (room <= 0) return [];
  return candidates
    .filter((id) => active.includes(id) && !current.includes(id) && !removed.includes(id))
    .slice(0, room);
}

// Keyword label rules (#132), for a text DM this ingestion stored. The caller holds the connection FOR SHARE and the
// conversation lock, and nothing here locks a rule or the workspace, so a rule write never queues ingestion.
// A rule must never make ingestion throw, because that would roll back the stored DM and the confirmations of the
// same batch: every label that would make the write fail (archived, already on the conversation, over the set limit)
// is skipped, and so is a label that a member removed from this conversation, which no rule adds back. A sender ID
// that the label tables cannot store (more than 40 digits) skips the rules altogether. One DM writes at most one
// label-set version and one audit row, attributed to the first matching rule by (created_at, id), even when that
// rule's own label was skipped. Labelling sends nothing, so paused and handed-off contacts are labelled too.
async function applyLabelRules(
  client: PoolClient,
  workspace: string,
  connection: string,
  recipient: string,
  text: string,
): Promise<void> {
  // The recipient_id CHECK of the label tables would raise, and the stored DM would roll back with it.
  if (!/^[0-9]{1,40}$/.test(recipient)) return;
  // Read without a lock: a rule change that is not committed yet applies from the next DM.
  const rules = (
    await client.query<LabelRule>(
      `SELECT id::text,label_id::text,match_mode,keywords,excluded_keywords FROM instagram_inbox_label_rules
       WHERE workspace_id=$1 AND NOT archived ORDER BY created_at,id`,
      [workspace],
    )
  ).rows;
  // The labels of the matching rules in rule order, and the first matching rule, which the audit row names.
  const candidates: string[] = [];
  let firstRule: string | undefined;
  for (const rule of rules)
    if (matchesCommentRule(text, { keyword: "", ...rule })) {
      firstRule ??= rule.id;
      if (!candidates.includes(rule.label_id)) candidates.push(rule.label_id);
    }
  if (!firstRule) return;
  const conversation = [workspace, connection, recipient];
  // Only a member's removal counts (actor_id set); a rule never removes a label.
  const removedByMember = async () =>
    (
      await client.query<{ id: string }>(
        `SELECT DISTINCT removed.id::text FROM instagram_inbox_label_events e, unnest(e.removed) AS removed(id)
         WHERE e.workspace_id=$1 AND e.connection_id=$2 AND e.recipient_id=$3 AND e.actor_id IS NOT NULL
           AND removed.id=ANY($4::uuid[])`,
        [...conversation, candidates],
      )
    ).rows.map((row) => row.id);
  const activeLabels = async (lock: string) =>
    (
      await client.query<{ id: string }>(
        `SELECT id::text FROM instagram_inbox_labels WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND NOT archived
         ORDER BY id ${lock}`,
        [workspace, candidates],
      )
    ).rows.map((row) => row.id);
  // Decide before writing anything, so a DM whose labels are all skipped leaves no version 0 row behind. The labels
  // are locked FOR SHARE here already, so no archive commits between this decision and the write; a label whose
  // archive was not committed yet is read again once the lock is granted and is skipped. The set and the member
  // removals cannot change either, because every writer of them takes the conversation lock this ingestion holds.
  const existing = await client.query<{ label_ids: string[] }>(
    `SELECT label_ids::text[] AS label_ids FROM instagram_inbox_conversation_labels
     WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3`,
    conversation,
  );
  if (
    !labelsToAdd(
      candidates,
      existing.rows[0]?.label_ids ?? [],
      await activeLabels("FOR SHARE"),
      await removedByMember(),
    ).length
  )
    return;
  // Then the manual path's order: the version 0 placeholder (the same as no row) gives concurrent writers a row to
  // queue on, the label-set row FOR UPDATE, and the labels FOR SHARE by ID, which this transaction already holds.
  await client.query(
    `INSERT INTO instagram_inbox_conversation_labels(workspace_id,connection_id,recipient_id) VALUES($1,$2,$3)
     ON CONFLICT(workspace_id,connection_id,recipient_id) DO NOTHING`,
    conversation,
  );
  const current = (
    await client.query<{ label_ids: string[] }>(
      `SELECT label_ids::text[] AS label_ids FROM instagram_inbox_conversation_labels
       WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 FOR UPDATE`,
      conversation,
    )
  ).rows[0]!.label_ids;
  const added = labelsToAdd(candidates, current, await activeLabels("FOR SHARE"), await removedByMember());
  // The same inputs under the same locks as the decision above, so this is never empty.
  if (!added.length) return;
  const saved = await client.query<{ version: number }>(
    `UPDATE instagram_inbox_conversation_labels SET label_ids=label_ids||$4::uuid[],version=version+1,updated_by=NULL,
       updated_at=clock_timestamp()
     WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 RETURNING version`,
    [...conversation, added],
  );
  await client.query(
    `INSERT INTO instagram_inbox_label_events(workspace_id,connection_id,recipient_id,version,added,removed,actor_id,rule_id)
     VALUES($1,$2,$3,$4,$5::uuid[],'{}',NULL,$6)`,
    [...conversation, saved.rows[0]!.version, added, firstRule],
  );
}
