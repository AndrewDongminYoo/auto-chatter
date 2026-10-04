import { sameScopedIdentity } from "./contract.ts";

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

export interface ChannelConsentPolicyInput {
  scope: ChannelConsentScope;
  state: ChannelConsentState | null;
  serviceEvidence?: ServiceReplyEvidence;
}

export type ChannelConsentPolicyResult =
  | { eligible: true }
  | { eligible: false; reason: "recipient_opted_out" | "marketing_consent_required" | "service_reply_window_required" };

export function evaluateChannelConsent(input: ChannelConsentPolicyInput): ChannelConsentPolicyResult {
  const exactState =
    input.state !== null && sameScopedIdentity(input.scope, input.state) && input.scope.purpose === input.state.purpose
      ? input.state
      : null;
  if (exactState?.decision === "revoke") return { eligible: false, reason: "recipient_opted_out" };
  if (input.scope.purpose === "marketing") {
    if (exactState?.decision === "grant" && exactState.evidenceKind === "explicit") return { eligible: true };
    return { eligible: false, reason: "marketing_consent_required" };
  }
  if (input.serviceEvidence?.withinWindow && sameScopedIdentity(input.scope, input.serviceEvidence))
    return { eligible: true };
  return { eligible: false, reason: "service_reply_window_required" };
}

// Strict existing service windows: the boundary is closed; missing/future evidence grants nothing.
export function evaluateWindow(now: Date, anchor: Date | null, durationMs: number): "open" | "expired" | "unverified" {
  const time = now.getTime();
  const start = anchor?.getTime();
  if (
    start === undefined ||
    !Number.isFinite(start) ||
    !Number.isFinite(time) ||
    start > time ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  )
    return "unverified";
  return time - start >= durationMs ? "expired" : "open";
}
