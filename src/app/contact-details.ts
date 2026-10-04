import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { membershipFor } from "./settings.ts";
import { inboxIdentityCandidatesSql } from "./inbox-identity.ts";

type After = { workspace_id: string; connection_id: string; sender_id: string; recipient_id: string };
function parseAfter(query: URLSearchParams, connection: string, sender: string): After | null {
  if (!isUuid(connection) || !/^\d{1,40}$/.test(sender)) throw new ApiError(400, "invalid_contact_request");
  for (const key of query.keys())
    if (key !== "after" || query.getAll(key).length !== 1) throw new ApiError(400, "invalid_contact_request");
  if (!query.has("after")) return null;
  try {
    const encoded = query.get("after")!;
    if (encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 4 ||
      !isUuid(value.workspace_id) ||
      value.connection_id !== connection ||
      value.sender_id !== sender ||
      typeof value.recipient_id !== "string" ||
      !/^\d{1,40}$/.test(value.recipient_id)
    )
      throw new Error();
    return value as After;
  } catch {
    throw new ApiError(400, "invalid_contact_request");
  }
}

type Consent = {
  identity_kind: string;
  identity_value: string;
  purpose: string;
  decision: string;
  evidence_kind: string;
  occurred_at: Date;
  recorded_at: Date;
  last_event_id: string;
};

// An advisory read only: membership and every returned fact share one snapshot. No row/advisory locks,
// read-position changes, provider requests, queue notifications or derived consent grants.
export async function contactDetails(
  pool: Pool,
  user: User,
  connection: string,
  sender: string,
  query: URLSearchParams,
) {
  const after = parseAfter(query, connection, sender);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { workspace_id: workspace } = await membershipFor(client, user, "agent");
    if (after && after.workspace_id !== workspace) throw new ApiError(400, "invalid_contact_request");
    const result = await client.query(
      `SELECT c.id AS connection_id,$3::text AS sender_id,c.username,comments.first_comment_at,comments.last_comment_at,
         comments.comment_count,coalesce(tags.tags,'{}'::text[]) AS tags,
         coalesce(automation.paused,false) AS manual_paused,coalesce(automation.handoff_paused,false) AS handoff_paused
       FROM instagram_connections c
       JOIN LATERAL (
         SELECT min(created_at) AS first_comment_at,max(created_at) AS last_comment_at,count(*)::text AS comment_count
         FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=c.id AND sender_id=$3
         HAVING count(*)>0
       ) comments ON true
       LEFT JOIN instagram_contact_tags tags ON tags.workspace_id=c.workspace_id AND tags.connection_id=c.id AND tags.sender_id=$3
       LEFT JOIN instagram_contact_automation automation ON automation.workspace_id=c.workspace_id AND automation.connection_id=c.id AND automation.sender_id=$3
       WHERE c.workspace_id=$1 AND c.id=$2`,
      [workspace, connection, sender],
    );
    const contact = result.rows[0];
    if (!contact) throw new ApiError(404, "contact_not_found");
    const fields = (
      await client.query(
        `SELECT f.id,f.name,f.type,v.value FROM instagram_contact_fields f
       LEFT JOIN instagram_contact_field_values v ON v.workspace_id=f.workspace_id AND v.field_id=f.id
         AND v.connection_id=$2 AND v.sender_id=$3
       WHERE f.workspace_id=$1 AND NOT f.archived ORDER BY f.name,f.id`,
        [workspace, connection, sender],
      )
    ).rows;
    const related = await client.query<{
      recipient_id: string;
      evidence_reply_id: string;
      message_count: string;
      last_message_id: string;
      first_message_at: Date;
      last_message_at: Date;
      state: string;
      handoff_active: boolean;
    }>(
      `WITH owned AS (
         SELECT id,workspace_id,inbox_enabled_at FROM instagram_connections WHERE workspace_id=$1 AND id=$2
       ), candidates AS (${inboxIdentityCandidatesSql}), verified AS (
         SELECT recipient_id,(array_agg(id::text ORDER BY sent_at DESC,id DESC) FILTER (WHERE fresh))[1] AS evidence_reply_id
         FROM candidates GROUP BY recipient_id
         HAVING count(DISTINCT sender_id)=1 AND min(sender_id)=$3 AND bool_or(fresh)
       )
       SELECT verified.recipient_id,verified.evidence_reply_id,m.message_count,m.last_message_id,m.first_message_at,m.last_message_at,
         coalesce(state.status,'open') AS state,coalesce(handoff.active,false) AS handoff_active
       FROM verified
       JOIN LATERAL (
         SELECT count(*)::text AS message_count,max(id)::text AS last_message_id,min(message_at) AS first_message_at,max(message_at) AS last_message_at
         FROM instagram_inbox_messages WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=verified.recipient_id
         HAVING count(*)>0
       ) m ON true
       LEFT JOIN instagram_inbox_conversations state ON state.workspace_id=$1 AND state.connection_id=$2 AND state.recipient_id=verified.recipient_id
       LEFT JOIN instagram_inbox_handoffs handoff ON handoff.workspace_id=$1 AND handoff.connection_id=$2 AND handoff.recipient_id=verified.recipient_id
       WHERE verified.recipient_id ~ '^[0-9]{1,40}$' AND ($4::text IS NULL OR verified.recipient_id>$4)
       ORDER BY verified.recipient_id LIMIT 51`,
      [workspace, connection, sender, after?.recipient_id ?? null],
    );
    const conversations = related.rows.slice(0, 50);
    const states = (
      await client.query<Consent>(
        `SELECT identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id::text
       FROM channel_consent_state WHERE workspace_id=$1 AND connection_id=$2 AND channel='instagram'
         AND ((identity_kind='comment_sender' AND identity_value=$3)
           OR (identity_kind='dm_recipient' AND identity_value=ANY($4::text[]))) ORDER BY purpose`,
        [workspace, connection, sender, conversations.map((row) => row.recipient_id)],
      )
    ).rows;
    const consentFor = (kind: string, value: string) =>
      states
        .filter((row) => row.identity_kind === kind && row.identity_value === value)
        .map(({ identity_kind: _kind, identity_value: _value, ...state }) => state);
    const { manual_paused, handoff_paused, ...facts } = contact;
    const last = conversations.at(-1);
    const detail = {
      ...facts,
      fields,
      automation: { paused: manual_paused || handoff_paused, manual_paused, handoff_paused },
      consent: consentFor("comment_sender", sender),
      conversations: conversations.map((row) => ({ ...row, consent: consentFor("dm_recipient", row.recipient_id) })),
      after:
        related.rows.length > 50 && last
          ? Buffer.from(
              JSON.stringify({
                workspace_id: workspace,
                connection_id: connection,
                sender_id: sender,
                recipient_id: last.recipient_id,
              }),
            ).toString("base64url")
          : null,
    };
    await client.query("COMMIT");
    return detail;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
