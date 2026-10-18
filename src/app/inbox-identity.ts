// Both directions of the advisory inbox/contact read use exactly this evidence policy.
// The caller supplies an `owned` connection CTE; group ALL candidates for each recipient before
// filtering by comment sender. Old evidence from a different sender still makes a bridge ambiguous.
export const inboxIdentityCandidatesSql = `
 SELECT reply.id,reply.sender_id,reply.recipient_id,reply.sent_at,reply.sent_at>=owned.inbox_enabled_at AS fresh,
   reply.workspace_id,reply.connection_id
 FROM private_reply_outbox reply JOIN owned ON reply.connection_id=owned.id AND reply.workspace_id=owned.workspace_id
 JOIN instagram_comment_events event ON event.id=reply.event_id AND event.connection_id=reply.connection_id
   AND event.workspace_id=reply.workspace_id AND event.sender_id=reply.sender_id
 WHERE reply.status='sent' AND length(btrim(reply.provider_message_id))>0 AND reply.sent_at<=now()`;

// The verified DM recipients of the connections that `owned` (a condition over instagram_connections) selects,
// one row per connection and recipient with its one comment sender. The contact detail lists a sender's rows as
// its conversations, and the segment DM consent filter evaluates them; both use this text. A recipient is
// verified when every candidate of it, in its own connection, names one sender, at least one candidate is
// fresh, its ID is numeric and at least one inbox message of it is stored. It never compares across connections
// or workspaces. This is advisory, not the delivery guard.
export function verifiedDmRecipientsSql(owned: string) {
  return `WITH owned AS (
   SELECT id,workspace_id,inbox_enabled_at FROM instagram_connections WHERE ${owned}
 ), candidates AS (${inboxIdentityCandidatesSql})
 SELECT workspace_id,connection_id,recipient_id,min(sender_id) AS sender_id,
   (array_agg(id::text ORDER BY sent_at DESC,id DESC) FILTER (WHERE fresh))[1] AS evidence_reply_id
 FROM candidates GROUP BY workspace_id,connection_id,recipient_id
 HAVING count(DISTINCT sender_id)=1 AND bool_or(fresh) AND recipient_id ~ '^[0-9]{1,40}$'
   AND EXISTS(SELECT 1 FROM instagram_inbox_messages message WHERE message.workspace_id=candidates.workspace_id
     AND message.connection_id=candidates.connection_id AND message.recipient_id=candidates.recipient_id)`;
}
