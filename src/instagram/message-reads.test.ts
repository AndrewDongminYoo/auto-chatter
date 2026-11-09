import assert from "node:assert/strict";
import { test } from "node:test";
import { instagramAdapter, partitionInstagramEvents } from "./channel-adapter.ts";
import { parseMessageEvents } from "./message-events.ts";
import { parseMessageReadEvents } from "./message-reads.ts";
import { parseCommentEvents } from "./webhook.ts";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
// The messaging_seen payload of Meta's webhook examples, with numeric IDs in place of the placeholders.
const seen = {
  sender: { id: "900" },
  recipient: { id: "123" },
  timestamp: 1569262485349,
  read: { mid: "aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjE3ODQx" },
};
const body = (...events: unknown[]) =>
  bytes({ object: "instagram", entry: [{ id: "123", time: 1569262486134, messaging: events }] });

test("a messaging_seen event becomes one read of one message", () => {
  assert.deepEqual(parseMessageReadEvents(body(seen)), [
    {
      accountId: "123",
      readerId: "900",
      messageId: "aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjE3ODQx",
      readAt: new Date(1569262485349),
    },
  ]);
});

test("malformed read events are skipped without failing the body", () => {
  const malformed = [
    { ...seen, read: undefined },
    { ...seen, read: "mid" },
    { ...seen, read: {} },
    { ...seen, read: { mid: "" } },
    { ...seen, read: { mid: "   " } },
    { ...seen, read: { mid: 42 } },
    { ...seen, read: { mid: "m".repeat(513) } },
    { ...seen, read: { mid: "m\u0000" } },
    { ...seen, sender: { id: "reader" } },
    { ...seen, sender: { id: "9".repeat(41) } },
    { ...seen, sender: { id: 900 } },
    { ...seen, sender: { id: "123" } },
    { ...seen, sender: undefined },
    { ...seen, recipient: { id: "124" } },
    { ...seen, recipient: undefined },
    { ...seen, timestamp: "1569262485349" },
    { ...seen, timestamp: 1569262485349.5 },
    { ...seen, timestamp: 0 },
    { ...seen, timestamp: -1 },
    { ...seen, timestamp: Number.MAX_SAFE_INTEGER + 1 },
    { ...seen, timestamp: 9e15 },
    { ...seen, timestamp: 253402300800000 },
    { ...seen, is_self: true },
    { ...seen, message: { mid: "m1", text: "hello" } },
    { ...seen, postback: { mid: "p1", title: "ok", payload: "auto-chatter:confirm:1" } },
    null,
    "read",
  ];
  assert.deepEqual(parseMessageReadEvents(body(...malformed)), []);
  assert.equal(parseMessageReadEvents(body(...malformed, seen)).length, 1);
  assert.deepEqual(parseMessageReadEvents(bytes({ object: "instagram", entry: [{ id: "123" }, null] })), []);
  assert.equal(parseMessageReadEvents(body({ ...seen, read: { mid: "m".repeat(512) } })).length, 1);
  assert.deepEqual(
    parseMessageReadEvents(body({ ...seen, timestamp: 253402300799999 }))[0]?.readAt,
    new Date(253402300799999),
  );
  for (const invalid of [bytes({ object: "page", entry: [] }), bytes({ object: "instagram" }), bytes(null)])
    assert.throws(() => parseMessageReadEvents(invalid));
});

test("a read event is never an inbound message, postback or comment", () => {
  const reads = body(seen);
  assert.deepEqual(parseMessageEvents(reads), []);
  assert.deepEqual(parseCommentEvents(reads), []);
  // Every DM path (inbox, reply wait, follow confirmation, DM start trigger, kept DM) starts from these messages.
  assert.deepEqual(instagramAdapter.decodeWebhook(reads), []);
  assert.deepEqual(partitionInstagramEvents(instagramAdapter.decodeWebhook(reads)), { comments: [], messages: [] });
  // In a mixed body each parser takes only its own events.
  const mixed = body(seen, { ...seen, read: undefined, message: { mid: "m1", text: "hello" } });
  assert.deepEqual(
    parseMessageEvents(mixed).map((message) => message.messageId),
    ["m1"],
  );
  assert.deepEqual(
    parseMessageReadEvents(mixed).map((read) => read.messageId),
    [seen.read.mid],
  );
});
