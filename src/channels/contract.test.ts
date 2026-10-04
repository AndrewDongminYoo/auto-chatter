import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkCapability,
  eventReceiptKey,
  sameScopedIdentity,
  type ChannelAdapter,
  type ChannelEvent,
} from "./contract.ts";
import { evaluateChannelConsent, evaluateWindow } from "./policy.ts";

// No provider, registry entry or fetch: deliberately different opaque identities and support.
class FakeRefusal extends Error {}
const fake: ChannelAdapter = {
  capabilities: {
    schema_version: 1,
    channel: "test-only",
    operations: {
      comment_private_reply: { supported: false, content_types: [] },
      follow_reply: { supported: false, content_types: [] },
      manual_reply: { supported: true, content_types: ["text"] },
      marketing: { supported: false, content_types: [] },
    },
    templates: { confirmation_postback: false, approved_message: false },
  },
  decodeWebhook: () => [
    {
      account: { channel: "test-only", accountId: "shop:東京" },
      receipt: { family: "message", providerId: "receipt/a:b" },
      actor: { kind: "customer", value: "opaque:person" },
      kind: "text_message",
      text: "hello",
      occurredAt: new Date(1000),
    },
  ],
  acceptSendResult(value) {
    if (typeof value !== "string" || !value) throw new Error("missing receipt");
    return { kind: "accepted", messageId: value };
  },
  classifySendError: (error) =>
    error instanceof FakeRefusal
      ? { kind: "refused", refusal: "other", code: "fake_refusal", retryAfterSeconds: null }
      : { kind: "unknown", code: "send_outcome_unknown" },
};

test("test-only second adapter exercises capabilities without a production provider", () => {
  assert.equal(checkCapability(fake.capabilities, "manual_reply", "text"), true);
  for (const [operation, content] of [
    ["manual_reply", "attachment"],
    ["manual_reply", "provider_template"],
    ["marketing", "text"],
    ["comment_private_reply", "text"],
    ["constructor", "text"],
    ["manual_reply", "unknown"],
  ])
    assert.equal(checkCapability(fake.capabilities, operation!, content!), false);
  let calls = 0;
  if (checkCapability(fake.capabilities, "manual_reply", "attachment")) calls++;
  assert.equal(calls, 0);
  assert.deepEqual(fake.acceptSendResult("fake/receipt"), { kind: "accepted", messageId: "fake/receipt" });
  assert.equal(fake.classifySendError(new FakeRefusal()).kind, "refused");
  assert.equal(fake.classifySendError(new Error()).kind, "unknown");
  assert.equal(fake.decodeWebhook(new Uint8Array())[0]!.actor.value, "opaque:person");
});

test("event receipt keys preserve account channel and family without delimiter collisions", () => {
  const event = fake.decodeWebhook(new Uint8Array())[0]!;
  const key = eventReceiptKey(event);
  for (const variant of [
    { ...event, account: { ...event.account, channel: "instagram" } },
    { ...event, account: { ...event.account, accountId: "other" } },
    { ...event, receipt: { family: "comment" as const, providerId: event.receipt.providerId } },
    {
      ...event,
      account: { ...event.account, accountId: "shop" },
      receipt: { ...event.receipt, providerId: "東京:receipt/a:b" },
    },
  ])
    assert.notEqual(eventReceiptKey(variant), key);
  const postback: ChannelEvent = {
    ...event,
    kind: "confirmation_postback",
    title: "ok",
    replyBinding: "1",
    occurredAt: new Date(1000),
  };
  assert.equal(eventReceiptKey(postback), key, "text and postback share a provider receipt namespace");
});

const scope = {
  workspaceId: "workspace",
  connectionId: "connection",
  channel: "test-only",
  identityKind: "customer",
  identityValue: "opaque:person",
};
test("consent never transfers an equal string between identities accounts workspaces or channels", () => {
  const requested = { ...scope, purpose: "marketing" as const };
  const grant = { ...requested, decision: "grant" as const, evidenceKind: "explicit" as const };
  assert.deepEqual(evaluateChannelConsent({ scope: requested, state: grant }), { eligible: true });
  for (const property of Object.keys(scope) as (keyof typeof scope)[]) {
    const other = { ...grant, [property]: "different" };
    assert.equal(sameScopedIdentity(requested, other), false);
    assert.deepEqual(evaluateChannelConsent({ scope: requested, state: other }), {
      eligible: false,
      reason: "marketing_consent_required",
    });
  }
  assert.equal(
    evaluateChannelConsent({ scope: requested, state: { ...grant, evidenceKind: "import" } }).eligible,
    false,
  );
  const service = { ...scope, purpose: "service_reply" as const };
  assert.equal(
    evaluateChannelConsent({
      scope: service,
      state: null,
      serviceEvidence: { ...scope, kind: "inbound_dm", withinWindow: true },
    }).eligible,
    true,
  );
  assert.equal(
    evaluateChannelConsent({
      scope: service,
      state: null,
      serviceEvidence: { ...scope, channel: "instagram", kind: "inbound_dm", withinWindow: true },
    }).eligible,
    false,
  );
  assert.deepEqual(
    evaluateChannelConsent({ scope: service, state: { ...grant, purpose: "service_reply", decision: "revoke" } }),
    { eligible: false, reason: "recipient_opted_out" },
  );
});

test("window evaluation is strict at every boundary and rejects untrusted anchors", () => {
  const anchor = new Date(1000);
  for (const duration of [5000, 24 * 3600_000, 7 * 24 * 3600_000]) {
    assert.equal(evaluateWindow(new Date(1000 + duration - 1), anchor, duration), "open");
    assert.equal(evaluateWindow(new Date(1000 + duration), anchor, duration), "expired");
    assert.equal(evaluateWindow(new Date(1000 + duration + 1), anchor, duration), "expired");
    assert.equal(evaluateWindow(new Date(999), anchor, duration), "unverified");
    assert.equal(evaluateWindow(new Date(1000), null, duration), "unverified");
    assert.equal(evaluateWindow(new Date(NaN), anchor, duration), "unverified");
    assert.equal(evaluateWindow(new Date(1000), new Date(NaN), duration), "unverified");
  }
  for (const duration of [0, -1, NaN, Infinity])
    assert.equal(evaluateWindow(new Date(1000), anchor, duration), "unverified");
});
