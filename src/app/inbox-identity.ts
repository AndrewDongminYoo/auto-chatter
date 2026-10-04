// Both directions of the advisory inbox/contact read use exactly this evidence policy.
// The caller supplies an `owned` connection CTE; group ALL candidates for each recipient before
// filtering by comment sender. Old evidence from a different sender still makes a bridge ambiguous.
export const inboxIdentityCandidatesSql = `
 SELECT reply.id,reply.sender_id,reply.recipient_id,reply.sent_at,reply.sent_at>=owned.inbox_enabled_at AS fresh
 FROM private_reply_outbox reply JOIN owned ON reply.connection_id=owned.id AND reply.workspace_id=owned.workspace_id
 JOIN instagram_comment_events event ON event.id=reply.event_id AND event.connection_id=reply.connection_id
   AND event.workspace_id=reply.workspace_id AND event.sender_id=reply.sender_id
 WHERE reply.status='sent' AND length(btrim(reply.provider_message_id))>0 AND reply.sent_at<=now()`;
