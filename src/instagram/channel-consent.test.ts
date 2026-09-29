import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateChannelConsent, type ChannelConsentPolicyInput, type ChannelConsentState } from "./channel-consent.ts";

const requested = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  connectionId: "22222222-2222-4222-8222-222222222222",
  channel: "instagram",
  identityKind: "comment_sender",
  identityValue: "recipient-1",
  purpose: "marketing",
} as const;

function state(overrides: Partial<ChannelConsentState> = {}): ChannelConsentState {
  return {
    ...requested,
    decision: "grant",
    evidenceKind: "explicit",
    ...overrides,
  };
}

function evaluate(overrides: Partial<ChannelConsentPolicyInput> = {}) {
  return evaluateChannelConsent({ scope: requested, state: state(), ...overrides });
}

test("marketing consent is exact-channel and import-safe", () => {
  assert.deepEqual(evaluate(), { eligible: true });

  for (const mismatched of [
    state({ channel: "sms" }),
    state({ identityValue: "recipient-2" }),
    state({ workspaceId: "33333333-3333-4333-8333-333333333333" }),
    state({ connectionId: "44444444-4444-4444-8444-444444444444" }),
    state({ identityKind: "dm_recipient" }),
    state({ purpose: "service_reply" }),
    state({ evidenceKind: "comment" }),
    state({ evidenceKind: "inbound_dm" }),
    state({ evidenceKind: "import" }),
  ]) {
    assert.deepEqual(evaluate({ state: mismatched }), {
      eligible: false,
      reason: "marketing_consent_required",
    });
  }
  assert.deepEqual(evaluate({ state: null }), {
    eligible: false,
    reason: "marketing_consent_required",
  });
  assert.deepEqual(evaluate({ state: state({ decision: "revoke" }) }), {
    eligible: false,
    reason: "recipient_opted_out",
  });

  assert.deepEqual(
    evaluate({
      state: state({ purpose: "service_reply", evidenceKind: "comment" }),
      serviceEvidence: {
        workspaceId: requested.workspaceId,
        connectionId: requested.connectionId,
        channel: requested.channel,
        identityKind: requested.identityKind,
        identityValue: requested.identityValue,
        kind: "comment",
        withinWindow: true,
      },
    }),
    { eligible: false, reason: "marketing_consent_required" },
  );
});

test("service replies require exact current initiation evidence and honor revocation", () => {
  const serviceScope = { ...requested, purpose: "service_reply" as const };
  const serviceEvidence = {
    workspaceId: serviceScope.workspaceId,
    connectionId: serviceScope.connectionId,
    channel: serviceScope.channel,
    identityKind: serviceScope.identityKind,
    identityValue: serviceScope.identityValue,
    kind: "inbound_dm" as const,
    withinWindow: true,
  };

  assert.deepEqual(evaluateChannelConsent({ scope: serviceScope, state: null, serviceEvidence }), {
    eligible: true,
  });
  assert.deepEqual(
    evaluateChannelConsent({
      scope: serviceScope,
      state: state({ purpose: "service_reply", decision: "revoke" }),
      serviceEvidence,
    }),
    { eligible: false, reason: "recipient_opted_out" },
  );
  assert.deepEqual(
    evaluateChannelConsent({
      scope: serviceScope,
      state: null,
      serviceEvidence: { ...serviceEvidence, withinWindow: false },
    }),
    { eligible: false, reason: "service_reply_window_required" },
  );
  assert.deepEqual(
    evaluateChannelConsent({
      scope: serviceScope,
      state: null,
      serviceEvidence: { ...serviceEvidence, identityValue: "recipient-2" },
    }),
    { eligible: false, reason: "service_reply_window_required" },
  );
});
