import type { Pool } from "pg";
import {
  ConsentConnectionNotFoundError,
  ConsentEventConflictError,
  recordChannelConsentEvent,
  type ConsentDecision,
  type ConsentEvidenceKind,
  type ConsentEventPurpose,
} from "../instagram/channel-consent.ts";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";

const fields = [
  "request_key",
  "identity_kind",
  "identity_value",
  "purpose",
  "decision",
  "evidence_kind",
  "evidence_reference",
  "occurred_at",
] as const;
const identityKinds = ["comment_sender", "dm_recipient"] as const;
const purposes: readonly ConsentEventPurpose[] = ["service_reply", "marketing", "all"];
const decisions: readonly ConsentDecision[] = ["grant", "revoke"];
const evidenceKinds: readonly ConsentEvidenceKind[] = ["comment", "inbound_dm", "explicit", "import"];
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalid(): never {
  throw new ApiError(400, "invalid_consent_event");
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid();
  return value as T;
}

export async function recordConsentEvent(pool: Pool, user: User, connectionId: string, input: unknown) {
  if (!isUuid(connectionId) || !isRecord(input)) invalid();
  const keys = Object.keys(input);
  if (keys.length !== fields.length || !fields.every((field) => field in input)) invalid();
  if (!isUuid(input.request_key)) invalid();
  const identityKind = oneOf(input.identity_kind, identityKinds);
  if (typeof input.identity_value !== "string" || !/^\d{1,40}$/.test(input.identity_value)) invalid();
  const purpose = oneOf(input.purpose, purposes);
  const decision = oneOf(input.decision, decisions);
  if (purpose === "all" && decision !== "revoke") invalid();
  const evidenceKind = oneOf(input.evidence_kind, evidenceKinds);
  if (purpose === "service_reply" && decision === "grant" && evidenceKind !== "explicit") invalid();
  if (
    typeof input.evidence_reference !== "string" ||
    !input.evidence_reference.trim() ||
    input.evidence_reference.length > 500
  )
    invalid();
  if (typeof input.occurred_at !== "string" || !isoTimestamp.test(input.occurred_at)) invalid();
  const occurredAt = new Date(input.occurred_at);
  if (!Number.isFinite(occurredAt.getTime()) || occurredAt.toISOString() !== input.occurred_at) invalid();

  const workspaceId = await workspaceFor(pool, user, "agent");
  try {
    const result = await recordChannelConsentEvent(pool, {
      requestKey: input.request_key,
      workspaceId,
      connectionId,
      channel: "instagram",
      identityKind,
      identityValue: input.identity_value,
      purpose,
      decision,
      evidenceKind,
      evidenceReference: input.evidence_reference,
      occurredAt,
      actorId: user.id,
    });
    return {
      event_id: result.eventId,
      applied: result.applied,
      states: result.states.map((state) => ({
        purpose: state.purpose,
        decision: state.decision,
        occurred_at: state.occurredAt.toISOString(),
      })),
    };
  } catch (error) {
    if (error instanceof ConsentEventConflictError) throw new ApiError(409, error.code);
    if (error instanceof ConsentConnectionNotFoundError) throw new ApiError(404, error.code);
    throw error;
  }
}
