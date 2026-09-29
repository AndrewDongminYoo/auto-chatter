import type { Pool, PoolClient } from "pg";

export type ConsentPurpose = "service_reply" | "marketing";
export type ConsentEventPurpose = ConsentPurpose | "all";
export type ConsentDecision = "grant" | "revoke";
export type ConsentEvidenceKind = "comment" | "inbound_dm" | "explicit" | "import";

export interface ChannelConsentScope {
  workspaceId: string;
  connectionId: string;
  channel: string;
  identityKind: string;
  identityValue: string;
  purpose: ConsentPurpose;
}

export interface ChannelConsentState extends ChannelConsentScope {
  decision: ConsentDecision;
  evidenceKind: ConsentEvidenceKind;
}

export interface ServiceReplyEvidence extends Omit<ChannelConsentScope, "purpose"> {
  kind: "comment" | "inbound_dm";
  withinWindow: boolean;
}

export type ChannelConsentIdentityScope = Omit<ChannelConsentScope, "purpose">;

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

export interface ChannelConsentPolicyInput {
  scope: ChannelConsentScope;
  state: ChannelConsentState | null;
  serviceEvidence?: ServiceReplyEvidence;
}

export type ChannelConsentPolicyResult =
  | { eligible: true }
  | { eligible: false; reason: "recipient_opted_out" | "marketing_consent_required" | "service_reply_window_required" };

function sameIdentity(
  left: Omit<ChannelConsentScope, "purpose">,
  right: Omit<ChannelConsentScope, "purpose">,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.connectionId === right.connectionId &&
    left.channel === right.channel &&
    left.identityKind === right.identityKind &&
    left.identityValue === right.identityValue
  );
}

export function evaluateChannelConsent(input: ChannelConsentPolicyInput): ChannelConsentPolicyResult {
  const exactState =
    input.state !== null && sameIdentity(input.scope, input.state) && input.scope.purpose === input.state.purpose
      ? input.state
      : null;
  if (exactState?.decision === "revoke") return { eligible: false, reason: "recipient_opted_out" };
  if (input.scope.purpose === "marketing") {
    if (exactState?.decision === "grant" && exactState.evidenceKind === "explicit") return { eligible: true };
    return { eligible: false, reason: "marketing_consent_required" };
  }
  if (input.serviceEvidence?.withinWindow && sameIdentity(input.scope, input.serviceEvidence))
    return { eligible: true };
  return { eligible: false, reason: "service_reply_window_required" };
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
