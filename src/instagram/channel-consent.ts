import type { Pool, PoolClient } from "pg";

// Preserve existing imports while the pure policy is shared with other channel adapters.
export * from "../channels/policy.ts";
import type {
  ChannelConsentIdentityScope,
  ChannelConsentState,
  ConsentPurpose,
  ConsentEventPurpose,
  ConsentDecision,
  ConsentEvidenceKind,
} from "../channels/policy.ts";

export type ConsentQueryable = Pool | PoolClient;

export async function recipientOptedOut(
  queryable: ConsentQueryable,
  scopes: readonly ChannelConsentIdentityScope[],
): Promise<boolean> {
  if (scopes.length === 0) return false;
  const requested = scopes.map((scope) => ({
    workspace_id: scope.workspaceId,
    connection_id: scope.connectionId,
    channel: scope.channel,
    identity_kind: scope.identityKind,
    identity_value: scope.identityValue,
  }));
  const result = await queryable.query(
    `SELECT EXISTS(
       SELECT 1 FROM channel_consent_state state
       JOIN jsonb_to_recordset($1::jsonb) AS requested(
         workspace_id uuid,connection_id uuid,channel text,identity_kind text,identity_value text
       ) ON state.workspace_id=requested.workspace_id
         AND state.connection_id=requested.connection_id
         AND state.channel=requested.channel
         AND state.identity_kind=requested.identity_kind
         AND state.identity_value=requested.identity_value
       WHERE state.purpose='service_reply' AND state.decision='revoke'
     ) AS opted_out`,
    [JSON.stringify(requested)],
  );
  return result.rows[0]?.opted_out === true;
}

export async function deliveryRecipientOptedOut(
  queryable: ConsentQueryable,
  input: { workspaceId: string; connectionId: string; senderId: string },
): Promise<boolean> {
  const result = await queryable.query<{ opted_out: boolean }>(
    `WITH verified_identities(identity_kind,identity_value) AS (
       VALUES ('comment_sender'::text,$3::text)
       UNION
       SELECT 'dm_recipient'::text,reply.recipient_id
       FROM private_reply_outbox reply
       JOIN instagram_comment_events event ON event.id=reply.event_id
         AND event.workspace_id=reply.workspace_id AND event.connection_id=reply.connection_id
         AND event.sender_id=reply.sender_id
       WHERE reply.workspace_id=$1 AND reply.connection_id=$2 AND reply.sender_id=$3
         AND reply.status='sent' AND reply.recipient_id IS NOT NULL
         AND reply.provider_message_id IS NOT NULL AND length(btrim(reply.provider_message_id))>0
     )
     SELECT EXISTS(
       SELECT 1 FROM channel_consent_state state
       JOIN verified_identities identity ON state.identity_kind=identity.identity_kind
         AND state.identity_value=identity.identity_value
       WHERE state.workspace_id=$1 AND state.connection_id=$2 AND state.channel='instagram'
         AND state.purpose='service_reply' AND state.decision='revoke'
     ) AS opted_out`,
    [input.workspaceId, input.connectionId, input.senderId],
  );
  return result.rows[0]?.opted_out === true;
}

export interface RecordChannelConsentEventInput {
  requestKey: string;
  workspaceId: string;
  connectionId: string;
  channel: "instagram";
  identityKind: "comment_sender" | "dm_recipient";
  identityValue: string;
  purpose: ConsentEventPurpose;
  decision: ConsentDecision;
  evidenceKind: ConsentEvidenceKind;
  evidenceReference: string;
  occurredAt: Date;
  actorId: string;
}

export interface RecordChannelConsentEventResult {
  eventId: string;
  applied: boolean;
  states: Array<ChannelConsentState & { occurredAt: Date }>;
}

export class ConsentEventConflictError extends Error {
  readonly code = "consent_request_conflict";

  constructor() {
    super("consent_request_conflict");
  }
}

export class ConsentConnectionNotFoundError extends Error {
  readonly code = "connection_not_found";

  constructor() {
    super("connection_not_found");
  }
}

export async function recordChannelConsentEvent(
  pool: Pool,
  input: RecordChannelConsentEventInput,
): Promise<RecordChannelConsentEventResult> {
  if (input.purpose === "all" && input.decision !== "revoke") throw new RangeError("all_consent_must_revoke");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const connection = await client.query(
      "SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
      [input.connectionId, input.workspaceId],
    );
    if (!connection.rows[0]) throw new ConsentConnectionNotFoundError();

    const inserted = await client.query(
      `INSERT INTO channel_consent_events(
         request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,
         evidence_kind,evidence_reference,occurred_at,actor_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(workspace_id,request_key) DO NOTHING
       RETURNING id::text`,
      [
        input.requestKey,
        input.workspaceId,
        input.connectionId,
        input.channel,
        input.identityKind,
        input.identityValue,
        input.purpose,
        input.decision,
        input.evidenceKind,
        input.evidenceReference,
        input.occurredAt,
        input.actorId,
      ],
    );
    let eventId: string;
    let applied = true;
    if (inserted.rows[0]) {
      eventId = inserted.rows[0].id;
    } else {
      applied = false;
      const existing = (
        await client.query(
          `SELECT id::text,connection_id::text,channel,identity_kind,identity_value,purpose,decision,evidence_kind,
             evidence_reference,occurred_at,actor_id::text
           FROM channel_consent_events WHERE workspace_id=$1 AND request_key=$2`,
          [input.workspaceId, input.requestKey],
        )
      ).rows[0];
      const matches =
        existing?.connection_id === input.connectionId &&
        existing.channel === input.channel &&
        existing.identity_kind === input.identityKind &&
        existing.identity_value === input.identityValue &&
        existing.purpose === input.purpose &&
        existing.decision === input.decision &&
        existing.evidence_kind === input.evidenceKind &&
        existing.evidence_reference === input.evidenceReference &&
        existing.occurred_at.getTime() === input.occurredAt.getTime() &&
        existing.actor_id === input.actorId;
      if (!matches) throw new ConsentEventConflictError();
      eventId = existing.id;
    }

    const purposes: ConsentPurpose[] = input.purpose === "all" ? ["service_reply", "marketing"] : [input.purpose];
    if (applied) {
      await client.query(
        `INSERT INTO channel_consent_state(
           workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,
           occurred_at,recorded_at,last_event_id
         )
         SELECT event.workspace_id,event.connection_id,event.channel,event.identity_kind,event.identity_value,
           requested_purpose.purpose,event.decision,event.evidence_kind,event.occurred_at,event.recorded_at,event.id
         FROM channel_consent_events event
         CROSS JOIN unnest($2::text[]) AS requested_purpose(purpose)
         WHERE event.id=$1::bigint
         ON CONFLICT(workspace_id,connection_id,channel,identity_kind,identity_value,purpose) DO UPDATE SET
           decision=EXCLUDED.decision,
           evidence_kind=EXCLUDED.evidence_kind,
           occurred_at=EXCLUDED.occurred_at,
           recorded_at=EXCLUDED.recorded_at,
           last_event_id=EXCLUDED.last_event_id
         WHERE channel_consent_state.last_event_id < EXCLUDED.last_event_id`,
        [eventId, purposes],
      );
    }
    const stateRows = (
      await client.query(
        `SELECT workspace_id::text,connection_id::text,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at
         FROM channel_consent_state
         WHERE workspace_id=$1 AND connection_id=$2 AND channel=$3 AND identity_kind=$4 AND identity_value=$5
           AND purpose=ANY($6::text[])
         ORDER BY purpose`,
        [input.workspaceId, input.connectionId, input.channel, input.identityKind, input.identityValue, purposes],
      )
    ).rows;
    await client.query("COMMIT");
    return {
      eventId,
      applied,
      states: stateRows.map((row) => ({
        workspaceId: row.workspace_id,
        connectionId: row.connection_id,
        channel: row.channel,
        identityKind: row.identity_kind,
        identityValue: row.identity_value,
        purpose: row.purpose,
        decision: row.decision,
        evidenceKind: row.evidence_kind,
        occurredAt: row.occurred_at,
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
