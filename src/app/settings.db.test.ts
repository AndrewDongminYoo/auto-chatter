import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import {
  disconnectConnection,
  ensureWorkspace,
  listConnections,
  listRules,
  saveRule,
  updateConnection,
} from "./settings.ts";
import { ApiError } from "./auth.ts";
import {
  archiveContactSegment,
  createContactSegment,
  listContactSegments,
  listContacts,
  saveContactTags,
  updateContactSegment,
} from "./contacts.ts";
import { connectionMedia } from "./instagram-media.ts";
import { connectionHealth } from "./instagram-connection-health.ts";
import { sealSecret } from "./secrets.ts";
import { appApi } from "./api.ts";
import { ingestMessages } from "../instagram/follow-flow.ts";
import { parseMessageEvents } from "../instagram/message-events.ts";
import { recordChannelConsentEvent } from "../instagram/channel-consent.ts";

const url = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: url.toString() });
const a = { id: "11111111-1111-4111-8111-111111111111", email: "a@example.test" };
const b = { id: "22222222-2222-4222-8222-222222222222", email: "b@example.test" };
const connectionId = "33333333-3333-4333-8333-333333333333";
const input = {
  connection_id: connectionId,
  media_id: "12345",
  keywords: [" Link "],
  excluded_keywords: [],
  match_mode: "contains",
  private_reply_text: "Hello",
  enabled: true,
  follow_gate_enabled: false,
};

async function identityInbox(recipient = "456", connection = connectionId, account = "123") {
  await pool.query(
    "UPDATE instagram_connections SET inbox_enabled=true,inbox_enabled_at=now()-interval '1 hour' WHERE id=$1",
    [connection],
  );
  await ingestMessages(pool, [
    {
      accountId: account,
      senderId: recipient,
      messageId: `inbound-${connection}-${recipient}`,
      text: "private DM",
      timestamp: new Date(Date.now() - 1000),
    },
  ]);
}

async function identityReply(
  sender: string,
  media: string,
  options: { recipient?: string; status?: string; connection?: string; account?: string; user?: typeof a } = {},
) {
  const connection = options.connection ?? connectionId;
  await saveRule(pool, options.user ?? a, { ...input, connection_id: connection, media_id: media });
  const { ingestComments } = await import("../instagram/store.ts");
  await ingestComments(pool, [
    {
      accountId: options.account ?? "123",
      commentId: `identity-${connection}-${media}-${sender}`,
      postId: media,
      senderId: sender,
      text: "Link private comment",
    },
  ]);
  const result = await pool.query(
    `UPDATE private_reply_outbox SET status=$4,recipient_id=$3,provider_message_id='provider-'||id,sent_at=now()-interval '10 minutes'
     WHERE connection_id=$1 AND sender_id=$2 AND media_id=$5 RETURNING id::text`,
    [connection, sender, options.recipient ?? "456", options.status ?? "sent", media],
  );
  assert.equal(result.rowCount, 1, "identity fixture needs an actual queued reply");
  return result.rows[0].id as string;
}

const identityPath = (recipient = "456", connection = connectionId) =>
  `/api/connections/${connection}/inbox/${recipient}/context`;

test("inbox context derives a comment identity only from a successful provider bridge", async () => {
  await identityInbox();
  const evidence = await identityReply("888", "12345");
  const response = await fieldRequest("GET", identityPath());
  assert.equal(response.status, 200);
  const context = await response.json();
  assert.equal(context.mapping_status, "verified");
  assert.equal(context.comment_sender_id, "888");
  assert.equal(context.evidence_reply_id, evidence);
  assert.equal(context.automation_paused, false);
  assert.ok(context.last_message_at);
  assert.equal(JSON.stringify(context).includes("private"), false);
  assert.equal(JSON.stringify(context).includes("encrypted"), false);
});

test("inbox context never equates equal numeric comment and DM identities", async () => {
  await identityInbox();
  const workspace = await ensureWorkspace(pool, a);
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'same-numeric-id','12345','456','private comment')",
    [workspace, connectionId],
  );
  const response = await fieldRequest("GET", identityPath());
  assert.equal(response.status, 200);
  const context = await response.json();
  assert.equal(context.mapping_status, "unmapped");
  assert.equal(context.comment_sender_id, null);
  assert.equal(context.evidence_reply_id, null);
  assert.equal(context.automation_paused, null);
});

test("inbox context distinguishes old evidence and refuses conflicting senders", async () => {
  await identityInbox();
  await identityReply("888", "12345");
  await pool.query("UPDATE instagram_connections SET inbox_enabled_at=NULL WHERE id=$1", [connectionId]);
  assert.equal((await (await fieldRequest("GET", identityPath())).json()).mapping_status, "stale");
  await pool.query("UPDATE instagram_connections SET inbox_enabled_at=now()-interval '5 minutes' WHERE id=$1", [
    connectionId,
  ]);
  const stale = await fieldRequest("GET", identityPath());
  assert.equal(stale.status, 200);
  assert.equal((await stale.json()).mapping_status, "stale");
  await identityReply("999", "54321");
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '2 minutes' WHERE sender_id='999'");
  const context = await (await fieldRequest("GET", identityPath())).json();
  assert.equal(context.mapping_status, "ambiguous");
  assert.equal(context.comment_sender_id, null);
  assert.equal(context.evidence_reply_id, null);
  assert.equal(context.automation_paused, null);
});

test("inbox context deduplicates evidence and reads current pause without changing it", async () => {
  await identityInbox();
  await identityReply("888", "12345");
  const latest = await identityReply("888", "54321");
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '5 minutes' WHERE id=$1", [latest]);
  const first = await fieldRequest("GET", identityPath());
  assert.equal(first.status, 200);
  assert.equal((await first.json()).evidence_reply_id, latest);
  await fieldRequest("PUT", `/api/connections/${connectionId}/contacts/888/automation`, { paused: true });
  const context = await (await fieldRequest("GET", identityPath())).json();
  assert.equal(context.mapping_status, "verified");
  assert.equal(context.automation_paused, true);
  assert.equal(
    (await pool.query("SELECT paused FROM instagram_contact_automation WHERE sender_id='888'")).rows[0].paused,
    true,
  );
  assert.equal((await pool.query("SELECT count(*) FROM private_reply_outbox")).rows[0].count, "2");
});

test("inbox context rejects failed unknown future and mismatched original identities as evidence", async () => {
  await identityInbox();
  for (const [index, status] of ["pending", "failed", "unknown"].entries())
    await identityReply(`8${index}`, `1234${index}`, { status });
  const future = await identityReply("900", "90000");
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()+interval '1 hour' WHERE id=$1", [future]);
  const mismatch = await identityReply("901", "90001");
  await pool.query("UPDATE private_reply_outbox SET sender_id='forged' WHERE id=$1", [mismatch]);
  const missing = await identityReply("902", "90002");
  await pool.query("UPDATE private_reply_outbox SET provider_message_id=NULL WHERE id=$1", [missing]);
  const response = await fieldRequest("GET", identityPath());
  assert.equal(response.status, 200);
  const context = await response.json();
  assert.equal(context.mapping_status, "unmapped");
  assert.equal(context.comment_sender_id, null);
});

test("inbox context accepts provider identity when inbound arrives before local send completion", async () => {
  await identityInbox();
  const evidence = await identityReply("903", "90003");
  await pool.query(
    "UPDATE instagram_inbox_messages SET message_at=date_trunc('milliseconds',now()-interval '2 minutes')",
  );
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '1 minute' WHERE id=$1", [evidence]);
  const context = await (await fieldRequest("GET", identityPath())).json();
  assert.equal(context.mapping_status, "verified");
  assert.equal(context.evidence_reply_id, evidence);
  await pool.query(
    `UPDATE private_reply_outbox SET sent_at=(SELECT message_at+interval '500 microseconds' FROM instagram_inbox_messages LIMIT 1) WHERE id=$1`,
    [evidence],
  );
  assert.equal((await (await fieldRequest("GET", identityPath())).json()).mapping_status, "verified");
});

test("inbox context scopes identical recipients by account and workspace", async () => {
  await identityInbox();
  const other = "44444444-4444-4444-8444-444444444444";
  const workspace = await ensureWorkspace(pool, a);
  await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id,active) VALUES($1,$2,'999',true)", [
    other,
    workspace,
  ]);
  await identityInbox("456", other, "999");
  await identityReply("777", "54321", { connection: other, account: "999" });
  const response = await fieldRequest("GET", identityPath());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mapping_status, "unmapped");
  const foreign = await fieldRequest("GET", identityPath("456", other), undefined, b);
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), { error: "connection_not_found" });
});

test("inbox context refuses missing conversations malformed recipient IDs and query parameters", async () => {
  await identityInbox();
  assert.equal((await fieldRequest("GET", identityPath("999"))).status, 404);
  assert.equal((await fieldRequest("GET", identityPath("9".repeat(41)))).status, 400);
  assert.equal((await fieldRequest("GET", identityPath() + "?before=1")).status, 400);
  assert.equal((await fieldRequest("GET", identityPath(), undefined, b)).status, 404);
});

test("inbox opt-in gates body storage and owns settings and readers", async () => {
  const path = `/api/connections/${connectionId}/inbox`;
  const message = {
    accountId: "123",
    senderId: "456",
    messageId: "dm-1",
    text: "<script>private</script>",
    timestamp: new Date(),
  };
  assert.equal((await listConnections(pool, a))[0].inbox_enabled, false);
  await ingestMessages(pool, [message]);
  assert.equal((await fieldRequest("GET", "/api/inbox")).status, 200);
  assert.deepEqual((await (await fieldRequest("GET", "/api/inbox")).json()).conversations, []);
  for (const body of [{ enabled: "true" }, {}, { enabled: true, extra: true }])
    assert.equal((await fieldRequest("PUT", path, body)).status, 400);
  assert.equal((await fieldRequest("PUT", path, { enabled: true }, b)).status, 404);
  assert.equal((await fieldRequest("PUT", path, { enabled: true })).status, 200);
  await ingestMessages(pool, [message]); // occurred before activation
  assert.equal((await (await fieldRequest("GET", "/api/inbox")).json()).conversations.length, 0);
  message.timestamp = new Date(Date.now() + 1000);
  await ingestMessages(pool, [message, message]);
  const page = await (await fieldRequest("GET", "/api/inbox")).json();
  assert.equal(page.conversations.length, 1);
  assert.equal(page.conversations[0].recipient_id, "456");
  const messagesPath = `${path}/456`;
  const history = await (await fieldRequest("GET", messagesPath)).json();
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].text, message.text);
  assert.equal((await fieldRequest("GET", messagesPath, undefined, b)).status, 404);
  assert.deepEqual((await (await fieldRequest("GET", "/api/inbox", undefined, b)).json()).conversations, []);
  await ingestMessages(pool, [{ ...message, messageId: "dm-2", timestamp: new Date(Date.now() + 500) }]);
  const latest = await (await fieldRequest("GET", "/api/inbox")).json();
  assert.equal(latest.conversations[0].last_message_at, message.timestamp.toISOString());
  await fieldRequest("PUT", path, { enabled: false });
  await ingestMessages(pool, [{ ...message, messageId: "dm-3" }]);
  assert.equal((await (await fieldRequest("GET", messagesPath)).json()).messages.length, 2);
  assert.equal((await fieldRequest("GET", `${messagesPath}?before=invalid`)).status, 400);
  assert.equal((await fieldRequest("GET", "/api/inbox?after=invalid")).status, 400);
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connectionId]);
  assert.equal((await fieldRequest("PUT", path, { enabled: true })).status, 409);
});

test("inbox pagination preserves arrivals and settings activation cutoff", async () => {
  const migration = await readFile(new URL("../../db/migrations/012_instagram_inbox.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  const path = `/api/connections/${connectionId}/inbox`;
  await fieldRequest("PUT", path, { enabled: true });
  const cutoff = (await pool.query("SELECT inbox_enabled_at FROM instagram_connections WHERE id=$1", [connectionId]))
    .rows[0].inbox_enabled_at;
  await fieldRequest("PUT", path, { enabled: true });
  assert.equal(
    (
      await pool.query("SELECT inbox_enabled_at FROM instagram_connections WHERE id=$1", [connectionId])
    ).rows[0].inbox_enabled_at.getTime(),
    cutoff.getTime(),
  );
  const timestamp = new Date(Date.now() + 1000);
  const messages = Array.from({ length: 55 }, (_, i) => ({
    accountId: "123",
    senderId: "456",
    messageId: `paged-${i}`,
    text: `message ${i}`,
    timestamp,
  }));
  await ingestMessages(pool, messages);
  const first = await (await fieldRequest("GET", `${path}/456`)).json();
  assert.equal(first.messages.length, 50);
  assert.equal(first.messages[0].text, "message 54");
  const older = await (await fieldRequest("GET", `${path}/456?before=${first.before}`)).json();
  assert.equal(older.messages.length, 5);
  assert.equal(new Set([...first.messages, ...older.messages].map((row) => row.message_id)).size, 55);
  assert.equal(older.before, null);
  await ingestMessages(
    pool,
    Array.from({ length: 55 }, (_, i) => ({ ...messages[0]!, senderId: String(1000 + i), messageId: `contact-${i}` })),
  );
  const page = await (await fieldRequest("GET", "/api/inbox")).json();
  const next = await (await fieldRequest("GET", `/api/inbox?after=${page.after}`)).json();
  assert.equal(page.conversations.length, 50);
  assert.equal(next.conversations.length, 6);
  assert.equal(new Set([...page.conversations, ...next.conversations].map((row) => row.recipient_id)).size, 56);
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connectionId]);
  await ingestMessages(pool, [{ ...messages[0]!, messageId: "stopped" }]);
  assert.equal(
    (await pool.query("SELECT count(*) FROM instagram_inbox_messages WHERE message_id='stopped'")).rows[0].count,
    "0",
  );
});

test("inbox stores parsed postbacks without inventing confirmation eligibility", async () => {
  await fieldRequest("PUT", `/api/connections/${connectionId}/inbox`, { enabled: true });
  const payload = {
    object: "instagram",
    entry: [
      {
        id: "123",
        messaging: [
          {
            sender: { id: "456" },
            recipient: { id: "123" },
            timestamp: Date.now() + 1000,
            postback: { mid: "button-dm", title: "자료 받기", payload: "auto-chatter:confirm:1" },
          },
        ],
      },
    ],
  };
  const messages = parseMessageEvents(Buffer.from(JSON.stringify(payload)));
  assert.equal(messages.length, 1);
  await ingestMessages(pool, messages);
  const history = await (await fieldRequest("GET", `/api/connections/${connectionId}/inbox/456`)).json();
  assert.equal(history.messages[0].kind, "postback");
  assert.equal(history.messages[0].text, "자료 받기");
  assert.equal((await pool.query("SELECT count(*) FROM instagram_message_receipts")).rows[0].count, "0");
});

test("resuming receiving excludes delayed messages from the stopped interval and keeps stored history", async () => {
  await pool.query(
    "UPDATE instagram_connections SET inbox_enabled=true,inbox_enabled_at=now()-interval '2 hours' WHERE id=$1",
    [connectionId],
  );
  const message = {
    accountId: "123",
    senderId: "456",
    messageId: "before-stop",
    text: "stored",
    timestamp: new Date(Date.now() - 3600000),
  };
  await ingestMessages(pool, [message]);
  await updateConnection(pool, a, connectionId, { active: false, send_enabled: false });
  const stoppedAt = (await pool.query("SELECT clock_timestamp() AS stopped_at")).rows[0].stopped_at;
  await pool.query("SELECT pg_sleep(0.02)");
  await updateConnection(pool, a, connectionId, { active: true, send_enabled: false });
  const cutoff = (await pool.query("SELECT inbox_enabled_at FROM instagram_connections WHERE id=$1", [connectionId]))
    .rows[0].inbox_enabled_at;
  assert.ok(cutoff.getTime() > stoppedAt.getTime(), "resume advances the opt-in cutoff");
  await ingestMessages(pool, [
    { ...message, messageId: "delayed-stopped", timestamp: stoppedAt },
    { ...message, messageId: "after-resume", timestamp: new Date(cutoff.getTime() + 1000) },
  ]);
  const history = (await pool.query("SELECT message_id FROM instagram_inbox_messages ORDER BY id")).rows.map(
    (row) => row.message_id,
  );
  assert.deepEqual(history, ["before-stop", "after-resume"]);
  await updateConnection(pool, a, connectionId, { active: true, send_enabled: true });
  assert.equal(
    (
      await pool.query("SELECT inbox_enabled_at FROM instagram_connections WHERE id=$1", [connectionId])
    ).rows[0].inbox_enabled_at.getTime(),
    cutoff.getTime(),
  );
});

const handoffPath = (recipient = "456", connection = connectionId) =>
  `/api/connections/${connection}/inbox/${recipient}/handoff`;
const setHandoff = (active: boolean, expected_version: number, recipient = "456") =>
  fieldRequest("PUT", handoffPath(recipient), { active, expected_version });

async function readyHandoff() {
  await identityInbox();
  return identityReply("888", "12345");
}

test("handoff starts with owned provider evidence and retries without duplicate audit", async () => {
  const evidence = await readyHandoff();
  const initial = await fieldRequest("GET", handoffPath());
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { active: false, version: 0 });
  const start = await setHandoff(true, 0);
  assert.equal(start.status, 200);
  assert.deepEqual(await start.json(), { active: true, version: 1 });
  assert.deepEqual(await (await setHandoff(true, 0)).json(), { active: true, version: 1 });
  assert.equal((await (await fieldRequest("GET", identityPath())).json()).automation_paused, true);
  const current = (await pool.query("SELECT sender_id,evidence_reply_id::text FROM instagram_inbox_handoffs")).rows[0];
  assert.deepEqual(current, { sender_id: "888", evidence_reply_id: evidence });
  assert.equal((await pool.query("SELECT count(*) FROM instagram_inbox_handoff_events")).rows[0].count, "1");
});

test("handoff resume preserves manual pause and captured sender after evidence is lost", async () => {
  await readyHandoff();
  await fieldRequest("PUT", `/api/connections/${connectionId}/contacts/888/automation`, { paused: true });
  assert.equal((await setHandoff(true, 0)).status, 200);
  await pool.query("UPDATE private_reply_outbox SET status='unknown'");
  await pool.query("UPDATE instagram_connections SET inbox_enabled_at=now() WHERE id=$1", [connectionId]);
  const resume = await setHandoff(false, 1);
  assert.equal(resume.status, 200);
  assert.deepEqual(await resume.json(), { active: false, version: 2 });
  assert.deepEqual(await (await setHandoff(false, 1)).json(), { active: false, version: 2 });
  assert.deepEqual((await pool.query("SELECT paused,handoff_paused FROM instagram_contact_automation")).rows[0], {
    paused: true,
    handoff_paused: false,
  });
  assert.equal((await pool.query("SELECT status FROM private_reply_outbox")).rows[0].status, "unknown");
  assert.equal((await pool.query("SELECT count(*) FROM instagram_inbox_handoff_events")).rows[0].count, "2");
});

test("handoff refuses unverified identity foreign sessions and invalid request versions", async () => {
  await identityInbox();
  assert.equal((await setHandoff(true, 0)).status, 409);
  await identityReply("888", "12345");
  await pool.query("UPDATE instagram_connections SET inbox_enabled_at=now() WHERE id=$1", [connectionId]);
  assert.equal((await setHandoff(true, 0)).status, 409);
  await pool.query("UPDATE instagram_connections SET inbox_enabled_at=now()-interval '1 hour' WHERE id=$1", [
    connectionId,
  ]);
  await identityReply("999", "54321");
  assert.equal((await setHandoff(true, 0)).status, 409);
  assert.equal((await fieldRequest("GET", handoffPath(), undefined, b)).status, 404);
  assert.equal((await fieldRequest("PUT", handoffPath(), { active: true, expected_version: 0 }, b)).status, 404);
  for (const body of [
    { active: true },
    { active: true, expected_version: -1 },
    { active: true, expected_version: 0, extra: true },
  ])
    assert.equal((await fieldRequest("PUT", handoffPath(), body)).status, 400);
  assert.equal((await fieldRequest("GET", `${handoffPath()}?extra=1`)).status, 400);
});

test("handoff keeps another conversation's pause and forbids manual resume while active", async () => {
  await readyHandoff();
  await identityInbox("789");
  await identityReply("888", "54321", { recipient: "789" });
  assert.equal((await setHandoff(true, 0)).status, 200);
  assert.equal((await setHandoff(true, 0, "789")).status, 200);
  assert.equal((await setHandoff(false, 1)).status, 200);
  assert.equal((await (await fieldRequest("GET", identityPath())).json()).automation_paused, true);
  const manual = await fieldRequest("PUT", `/api/connections/${connectionId}/contacts/888/automation`, {
    paused: false,
  });
  assert.equal(manual.status, 409);
  assert.equal((await setHandoff(false, 1, "789")).status, 200);
  assert.equal((await (await fieldRequest("GET", identityPath())).json()).automation_paused, false);
});

test("handoff serializes duplicate starts and rejects stale opposite transitions", async () => {
  await readyHandoff();
  const starts = await Promise.all([setHandoff(true, 0), setHandoff(true, 0)]);
  assert.deepEqual(
    starts.map((response) => response.status),
    [200, 200],
  );
  assert.equal((await pool.query("SELECT count(*) FROM instagram_inbox_handoff_events")).rows[0].count, "1");
  assert.equal((await setHandoff(false, 0)).status, 409);
  assert.equal((await setHandoff(false, 1)).status, 200);
  assert.equal((await setHandoff(false, 1)).status, 200);
  const transitions = await Promise.all([setHandoff(true, 2), setHandoff(false, 1)]);
  assert.equal(transitions[0]!.status, 200);
  assert.ok([200, 409].includes(transitions[1]!.status));
  assert.deepEqual(await (await fieldRequest("GET", handoffPath())).json(), { active: true, version: 3 });
  assert.equal((await setHandoff(false, 1)).status, 409);
  assert.equal((await pool.query("SELECT count(*) FROM instagram_inbox_handoff_events")).rows[0].count, "3");
});

test("handoff migration replays with active state and resume survives deleted DM history", async () => {
  await pool.query(
    "DROP TABLE instagram_manual_reply_events,instagram_manual_replies,instagram_inbox_handoff_events,instagram_inbox_handoffs; DROP INDEX private_reply_outbox_identity_idx; ALTER TABLE instagram_contact_automation DROP COLUMN handoff_paused",
  );
  const migration = await readFile(new URL("../../db/migrations/013_inbox_handoffs.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(await readFile(new URL("../../db/migrations/014_manual_replies.sql", import.meta.url), "utf8"));
  await pool.query(
    await readFile(new URL("../../db/migrations/049_inbox_scheduled_replies.sql", import.meta.url), "utf8"),
  );
  await readyHandoff();
  assert.equal((await setHandoff(true, 0)).status, 200);
  await pool.query(migration);
  await pool.query(migration);
  assert.deepEqual(await (await fieldRequest("GET", handoffPath())).json(), { active: true, version: 1 });
  assert.equal(
    (await pool.query("SELECT handoff_paused FROM instagram_contact_automation")).rows[0].handoff_paused,
    true,
  );
  await pool.query("DELETE FROM instagram_inbox_messages");
  assert.equal((await fieldRequest("GET", identityPath())).status, 404);
  assert.equal((await setHandoff(false, 1)).status, 200);
  assert.deepEqual(await (await fieldRequest("GET", handoffPath())).json(), { active: false, version: 2 });
  assert.equal(
    (await pool.query("SELECT handoff_paused FROM instagram_contact_automation")).rows[0].handoff_paused,
    false,
  );
});

test("handoff audit failure rolls back state and contact pause together", async () => {
  await readyHandoff();
  await pool.query(`CREATE FUNCTION reject_handoff_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
    CREATE TRIGGER reject_handoff_audit BEFORE INSERT ON instagram_inbox_handoff_events FOR EACH ROW EXECUTE FUNCTION reject_handoff_audit()`);
  try {
    assert.equal((await setHandoff(true, 0)).status, 503);
    assert.equal((await pool.query("SELECT count(*) FROM instagram_inbox_handoffs")).rows[0].count, "0");
    assert.equal((await pool.query("SELECT count(*) FROM instagram_contact_automation")).rows[0].count, "0");
    assert.equal((await pool.query("SELECT count(*) FROM instagram_inbox_handoff_events")).rows[0].count, "0");
  } finally {
    await pool.query(
      "DROP TRIGGER reject_handoff_audit ON instagram_inbox_handoff_events; DROP FUNCTION reject_handoff_audit()",
    );
  }
  assert.equal((await setHandoff(true, 0)).status, 200);
});

test("handoff restart captures changed evidence without clearing a concurrent manual pause", async () => {
  await readyHandoff();
  const changes = await Promise.all([
    setHandoff(true, 0),
    fieldRequest("PUT", `/api/connections/${connectionId}/contacts/888/automation`, { paused: true }),
  ]);
  assert.deepEqual(
    changes.map((response) => response.status),
    [200, 200],
  );
  assert.equal((await setHandoff(false, 1)).status, 200);
  await pool.query("UPDATE private_reply_outbox SET status='failed'");
  const evidence = await identityReply("999", "54321");
  assert.equal((await setHandoff(true, 2)).status, 200);
  assert.deepEqual(
    (await pool.query("SELECT sender_id,paused,handoff_paused FROM instagram_contact_automation ORDER BY sender_id"))
      .rows,
    [
      { sender_id: "888", paused: true, handoff_paused: false },
      { sender_id: "999", paused: false, handoff_paused: true },
    ],
  );
  assert.equal(
    (await pool.query("SELECT evidence_reply_id::text FROM instagram_inbox_handoffs")).rows[0].evidence_reply_id,
    evidence,
  );
});

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/012_instagram_inbox.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/007_confirmation_button.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/004_workspace_settings.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  const workspace = await ensureWorkspace(pool, a);
  await ensureWorkspace(pool, b);
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at) VALUES($1,$2,'123',true,'encrypted-test',now()+interval '1 day')",
    [connectionId, workspace],
  );
});
after(async () => {
  await pool.end();
});

async function fieldRequest(
  method: string,
  path: string,
  body?: unknown,
  user = a,
  sendEnabled?: string,
  notifyReply?: (connectionId: string) => Promise<void>,
) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test", SEND_ENABLED: sendEnabled },
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () => Response.json({ ...user, email_confirmed_at: "2026-09-25" })) as typeof fetch,
    notifyReply,
  );
}
async function createField(name: string, type: string) {
  const response = await fieldRequest("POST", "/api/contact-fields", { name, type });
  assert.equal(response.status, 201);
  return response.json();
}
async function fieldContact() {
  const workspace = await ensureWorkspace(pool, a);
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'field-comment','media','sender','private')",
    [workspace, connectionId],
  );
}
const fieldValuePath = (id: string, sender = "sender", connection = connectionId) =>
  `/api/connections/${connection}/contacts/${encodeURIComponent(sender)}/fields/${id}`;

test("custom fields persist typed zero false and empty text separately from unset", async () => {
  await fieldContact();
  for (const [type, value] of [
    ["number", 0],
    ["boolean", false],
    ["text", ""],
    ["date", "2024-02-29"],
  ] as const) {
    const field = await createField(type, type);
    const saved = await fieldRequest("PUT", fieldValuePath(field.id), { value });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { value });
    assert.equal((await listContacts(pool, a)).contacts[0]!.fields[field.id], value);
    const query = new URLSearchParams({ field_id: field.id, field_operator: "eq", field_value: JSON.stringify(value) });
    assert.equal((await listContacts(pool, a, query)).contacts.length, 1);
    assert.equal(
      (await listContacts(pool, a, new URLSearchParams({ field_id: field.id, field_operator: "is_set" }))).contacts
        .length,
      1,
    );
    assert.equal((await fieldRequest("PUT", fieldValuePath(field.id), { value: null })).status, 200);
    assert.equal((await listContacts(pool, a, query)).contacts.length, 0);
    assert.equal(
      (await listContacts(pool, a, new URLSearchParams({ field_id: field.id, field_operator: "is_unset" }))).contacts
        .length,
      1,
    );
    assert.equal(Object.hasOwn((await listContacts(pool, a)).contacts[0]!.fields, field.id), false);
  }
});

test("field validation refuses coercion invalid dates controls and foreign identities", async () => {
  await fieldContact();
  for (const [type, bad] of [
    ["number", "0"],
    ["number", true],
    ["boolean", "false"],
    ["boolean", 0],
    ["date", "2025-02-29"],
    ["date", "2024-2-9"],
    ["text", "x".repeat(1001)],
    ["text", "a\u0000b"],
    ["text", "a\u0085b"],
    ["text", {}],
  ] as const) {
    const field = await createField(`${type}-${Math.random()}`, type);
    assert.equal((await fieldRequest("PUT", fieldValuePath(field.id), { value: bad })).status, 400);
    assert.equal((await fieldRequest("PUT", fieldValuePath(field.id), { value: null, extra: 1 })).status, 400);
    assert.equal((await fieldRequest("PUT", fieldValuePath(field.id, "missing"), { value: null })).status, 404);
    assert.equal((await fieldRequest("PUT", fieldValuePath(field.id), { value: null }, b)).status, 404);
    assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${field.id}`, undefined, b)).status, 404);
  }
  assert.deepEqual(await (await fieldRequest("GET", "/api/contact-fields", undefined, b)).json(), { fields: [] });
  for (const input of [
    { name: "", type: "text" },
    { name: "x", type: "object" },
    { name: "x", type: ["text"] },
    { name: "x\u0000", type: "text" },
  ])
    assert.equal((await fieldRequest("POST", "/api/contact-fields", input)).status, 400);
  await createField(" Cafe\u0301 ", "text");
  assert.equal((await fieldRequest("POST", "/api/contact-fields", { name: "Café", type: "number" })).status, 409);
});

test("field values and saved conditions remain account scoped and current", async () => {
  await fieldContact();
  const workspace = await ensureWorkspace(pool, a);
  const other = "77777777-7777-4777-8777-777777777777";
  await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,'other')", [
    other,
    workspace,
  ]);
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'other-field-comment','media','sender','private')",
    [workspace, other],
  );
  const field = await createField("Interest", "text");
  await fieldRequest("PUT", fieldValuePath(field.id), { value: "guide" });
  const query = new URLSearchParams({ field_id: field.id, field_operator: "eq", field_value: '"guide"' });
  const selected = await listContacts(pool, a, query);
  assert.deepEqual(
    selected.contacts.map((c) => c.connection_id),
    [connectionId],
  );
  const segmentResponse = await fieldRequest("POST", "/api/contact-segments", {
    name: "Guide",
    field_id: field.id,
    field_operator: "eq",
    field_value: "guide",
  });
  assert.equal(segmentResponse.status, 201);
  const segment = await segmentResponse.json();
  assert.equal((await listContacts(pool, a, new URLSearchParams({ segment_id: segment.id }))).contacts.length, 1);
  assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${field.id}`)).status, 409);
  await fieldRequest("PUT", fieldValuePath(field.id), { value: "other" });
  assert.equal((await listContacts(pool, a, new URLSearchParams({ segment_id: segment.id }))).contacts.length, 0);
  await archiveContactSegment(pool, a, segment.id);
  assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${field.id}`)).status, 200);
  assert.equal((await fieldRequest("PUT", fieldValuePath(field.id), { value: "guide" })).status, 404);
  assert.equal((await fieldRequest("GET", `/api/contacts?${query}`)).status, 404);
  assert.deepEqual((await listContacts(pool, a)).contacts[0]!.fields, {});
  assert.equal((await fieldRequest("POST", "/api/contact-fields", { name: "Interest", type: "text" })).status, 409);
});

test("field filters reject malformed mixed and foreign conditions", async () => {
  const field = await createField("Score", "number");
  for (const query of [
    "field_operator=is_set",
    `field_id=${field.id}`,
    `field_id=${field.id}&field_operator=eq&field_value=%220%22`,
    `field_id=${field.id}&field_operator=is_set&field_value=0`,
    `field_id=${field.id}&field_operator=sql`,
    `field_id=${field.id}&field_id=${field.id}&field_operator=is_set`,
  ])
    assert.equal((await fieldRequest("GET", `/api/contacts?${query}`)).status, 400);
  assert.equal(
    (await fieldRequest("GET", `/api/contacts?field_id=${field.id}&field_operator=is_set`, undefined, b)).status,
    404,
  );
  assert.equal(
    (
      await fieldRequest("POST", "/api/contact-segments", {
        name: "Invalid operator",
        field_id: field.id,
        field_operator: ["is_set"],
      })
    ).status,
    400,
  );
});

test("combined tag and field filters honor AND OR truth tables without widening account scope", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Combined score", "number");
  for (const [sender, value, tags] of [
    ["both", 0, ["lead"]],
    ["field-only", 10, []],
    ["neither", -1, []],
    ["tag-only", -1, ["lead"]],
    ["unset-bare", null, []],
    ["unset-tagged", null, ["lead"]],
  ] as const) {
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,$3,'media',$3,'private')",
      [workspace, connectionId, sender],
    );
    await fieldRequest("PUT", fieldValuePath(field.id, sender), { value });
    await saveContactTags(pool, a, connectionId, sender, { tags });
  }
  const other = "77777777-7777-4777-8777-777777777777";
  const foreign = "88888888-8888-4888-8888-888888888888";
  for (const [id, owner] of [
    [other, workspace],
    [foreign, await ensureWorkspace(pool, b)],
  ]) {
    await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,$1::uuid::text)", [
      id,
      owner,
    ]);
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'scope','media','both','private')",
      [owner, id],
    );
    await pool.query(
      "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'both','{lead}')",
      [owner, id],
    );
  }
  const query = new URLSearchParams({
    connection_id: connectionId,
    tag: " Lead ",
    field_id: field.id,
    field_operator: "gte",
    field_value: "0",
  });
  assert.deepEqual(
    (await listContacts(pool, a, query)).contacts.map((c) => c.sender_id),
    ["both"],
  );
  query.set("condition_operator", "and");
  assert.deepEqual(
    (await listContacts(pool, a, query)).contacts.map((c) => c.sender_id),
    ["both"],
  );
  query.set("condition_operator", "or");
  assert.deepEqual(
    (await listContacts(pool, a, query)).contacts.map((c) => c.sender_id),
    ["both", "field-only", "tag-only", "unset-tagged"],
  );
  query.set("field_operator", "is_unset");
  query.delete("field_value");
  assert.deepEqual(
    (await listContacts(pool, a, query)).contacts.map((c) => c.sender_id),
    ["both", "tag-only", "unset-bare", "unset-tagged"],
  );
  query.set("condition_operator", "and");
  assert.deepEqual(
    (await listContacts(pool, a, query)).contacts.map((c) => c.sender_id),
    ["unset-tagged"],
  );
  query.set("condition_operator", "or");
  query.delete("connection_id");
  assert.equal((await listContacts(pool, a, query)).contacts.filter((c) => c.connection_id === other).length, 1);
  assert.equal(
    (await listContacts(pool, a, query)).contacts.some((c) => c.connection_id === foreign),
    false,
  );
});

test("combined saved filters preserve OR and re-evaluate either current condition", async () => {
  await fieldContact();
  const field = await createField("Combined boolean", "boolean");
  await fieldRequest("PUT", fieldValuePath(field.id), { value: true });
  await saveContactTags(pool, a, connectionId, "sender", { tags: ["lead"] });
  const response = await fieldRequest("POST", "/api/contact-segments", {
    name: "Tag or false",
    connection_id: connectionId,
    tag: "lead",
    field_id: field.id,
    field_operator: "eq",
    field_value: false,
    condition_operator: "or",
  });
  assert.equal(response.status, 201);
  const segment = await response.json();
  assert.equal(segment.condition_operator, "or");
  assert.equal(segment.field_value, false);
  assert.deepEqual((await listContactSegments(pool, a))[0], segment);
  const query = new URLSearchParams({ segment_id: segment.id });
  assert.equal((await listContacts(pool, a, query)).contacts.length, 1);
  await saveContactTags(pool, a, connectionId, "sender", { tags: [] });
  assert.equal((await listContacts(pool, a, query)).contacts.length, 0);
  await fieldRequest("PUT", fieldValuePath(field.id), { value: false });
  assert.equal((await listContacts(pool, a, query)).contacts.length, 1);
  assert.equal((await fieldRequest("GET", `/api/contacts?${query}`, undefined, b)).status, 404);
  assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${field.id}`)).status, 409);
  assert.equal((await fieldRequest("GET", `/api/contacts?${query}&condition_operator=or`)).status, 400);
  await archiveContactSegment(pool, a, segment.id);
  assert.equal((await fieldRequest("GET", `/api/contacts?${query}`)).status, 404);
});

test("combined filters reject meaningless or malformed OR even when the tag matches", async () => {
  await fieldContact();
  await saveContactTags(pool, a, connectionId, "sender", { tags: ["lead"] });
  const field = await createField("Validated combination", "number");
  const base = { name: "Invalid combination", tag: "lead", field_id: field.id, field_operator: "gte", field_value: 0 };
  for (const condition_operator of ["and", "or"]) {
    const query = new URLSearchParams({
      tag: "lead",
      field_id: field.id,
      field_operator: "gte",
      field_value: "0",
      condition_operator,
    });
    assert.equal((await fieldRequest("GET", `/api/contacts?${query}`, undefined, b)).status, 404);
  }
  for (const condition_operator of [null, true, ["or"], "OR", "xor", "or OR true"]) {
    assert.equal((await fieldRequest("POST", "/api/contact-segments", { ...base, condition_operator })).status, 400);
  }
  for (const input of [
    { name: "Missing field", tag: "lead", condition_operator: "or" },
    { name: "Missing tag", field_id: field.id, field_operator: "is_set", condition_operator: "or" },
    { ...base, condition_operator: "or", field_value: "0" },
  ])
    assert.equal((await fieldRequest("POST", "/api/contact-segments", input)).status, 400);
  for (const query of [
    "tag=lead&condition_operator=or",
    `field_id=${field.id}&field_operator=is_set&condition_operator=or`,
    `tag=lead&field_id=${field.id}&field_operator=gte&field_value=%220%22&condition_operator=or`,
    `tag=lead&field_id=${field.id}&field_operator=is_set&condition_operator=or&condition_operator=and`,
  ])
    assert.equal((await fieldRequest("GET", `/api/contacts?${query}`)).status, 400);
  assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${field.id}`)).status, 200);
  assert.equal(
    (
      await fieldRequest(
        "GET",
        `/api/contacts?tag=lead&field_id=${field.id}&field_operator=is_set&condition_operator=or`,
      )
    ).status,
    404,
  );
});

test("combined OR contacts retain the stable cursor and never duplicate dual matches", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Combined page", "number");
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) SELECT $1,$2,'combined-'||n,'media',lpad(n::text,3,'0'),'private' FROM generate_series(1,55) n",
    [workspace, connectionId],
  );
  await pool.query(
    "INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) SELECT $1,$2,lpad(n::text,3,'0'),$3,to_jsonb(CASE WHEN n%2=0 THEN -1 ELSE 0 END) FROM generate_series(1,55) n",
    [workspace, connectionId, field.id],
  );
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) SELECT $1,$2,lpad(n::text,3,'0'),'{lead}' FROM generate_series(1,55) n WHERE n%2=0 OR n=1",
    [workspace, connectionId],
  );
  const query = new URLSearchParams({
    tag: "lead",
    field_id: field.id,
    field_operator: "gte",
    field_value: "0",
    condition_operator: "or",
  });
  const first = await listContacts(pool, a, query);
  assert.equal(first.contacts.length, 50);
  assert.ok(first.after);
  query.set("after", first.after);
  const second = await listContacts(pool, a, query);
  assert.equal(second.after, null);
  assert.deepEqual(
    [...first.contacts, ...second.contacts].map((c) => c.sender_id),
    Array.from({ length: 55 }, (_, n) => String(n + 1).padStart(3, "0")),
  );
});

test("contact preview counts all matches at zero and either side of the page boundary", async () => {
  const workspace = await ensureWorkspace(pool, a);
  let previous = 0;
  for (const count of [0, 1, 50, 51, 55]) {
    if (count > previous)
      await pool.query(
        "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) SELECT $1,$2,'preview-'||n,'media',lpad(n::text,3,'0'),'private' FROM generate_series($3::int,$4::int) n",
        [workspace, connectionId, previous + 1, count],
      );
    const response = await fieldRequest("GET", "/api/contacts?preview=true");
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.total, String(count));
    assert.equal(preview.evaluated, String(count));
    assert.deepEqual(preview.excluded, { tag: "0", field: "0", both: "0" });
    assert.equal(preview.contacts.length, Math.min(count, 50));
    assert.equal(Boolean(preview.after), count > 50);
    assert.equal(
      preview.contacts.some((contact: Record<string, unknown>) => "preview_total" in contact),
      false,
    );
    const ordinary = await (await fieldRequest("GET", "/api/contacts")).json();
    assert.equal(Object.hasOwn(ordinary, "total"), false);
    assert.deepEqual(preview.contacts, ordinary.contacts);
    if (preview.after)
      assert.equal((await fieldRequest("GET", `/api/contacts?preview=true&after=${preview.after}`)).status, 400);
    previous = count;
  }
});

test("contact preview counts grouped identities with current filters and workspace isolation", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const foreignWorkspace = await ensureWorkspace(pool, b);
  const field = await createField("Preview score", "number");
  for (const [sender, value, tags] of [
    ["both", 0, ["lead"]],
    ["field-only", 10, []],
    ["neither", -1, []],
    ["tag-only", -1, ["lead"]],
  ] as const) {
    // Repeated comments still describe one contact in this connection.
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) SELECT $1,$2,$3||n,'media',$3,'private' FROM generate_series(1,3) n",
      [workspace, connectionId, sender],
    );
    await fieldRequest("PUT", fieldValuePath(field.id, sender), { value });
    await saveContactTags(pool, a, connectionId, sender, { tags });
  }
  const other = "77777777-7777-4777-8777-777777777777";
  const foreign = "88888888-8888-4888-8888-888888888888";
  for (const [id, owner] of [
    [other, workspace],
    [foreign, foreignWorkspace],
  ]) {
    await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,$1::uuid::text)", [
      id,
      owner,
    ]);
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'preview-scope','media','both','private')",
      [owner, id],
    );
    await pool.query(
      "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'both','{lead}')",
      [owner, id],
    );
  }
  const query = new URLSearchParams({
    preview: "true",
    connection_id: connectionId,
    tag: "lead",
    field_id: field.id,
    field_operator: "gte",
    field_value: "0",
  });
  const preview = async (
    expected: string,
    evaluated: string,
    excluded: { tag: string; field: string; both: string },
  ) => {
    const response = await fieldRequest("GET", `/api/contacts?${query}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, expected);
    assert.equal(body.evaluated, evaluated);
    assert.deepEqual(body.excluded, excluded);
    assert.equal(body.contacts.length, Number(expected));
  };
  await preview("1", "4", { tag: "1", field: "1", both: "1" });
  query.set("condition_operator", "or");
  await preview("3", "4", { tag: "0", field: "0", both: "1" });
  query.delete("connection_id");
  await preview("4", "5", { tag: "0", field: "0", both: "1" });
  query.set("connection_id", foreign);
  await preview("0", "0", { tag: "0", field: "0", both: "0" });
  query.delete("connection_id");
  assert.equal((await fieldRequest("GET", `/api/contacts?${query}`, undefined, b)).status, 404);
  for (const [filters, expected] of [
    ["", { total: "5", evaluated: "5", excluded: { tag: "0", field: "0", both: "0" } }],
    ["&tag=lead", { total: "3", evaluated: "5", excluded: { tag: "2", field: "0", both: "0" } }],
    [
      `&field_id=${field.id}&field_operator=gte&field_value=0`,
      { total: "2", evaluated: "5", excluded: { tag: "0", field: "3", both: "0" } },
    ],
    [
      `&tag=absent&field_id=${field.id}&field_operator=gte&field_value=100`,
      { total: "0", evaluated: "5", excluded: { tag: "0", field: "0", both: "5" } },
    ],
  ] as const) {
    const response = await fieldRequest("GET", `/api/contacts?preview=true${filters}`);
    assert.equal(response.status, 200);
    const { contacts, after, ...summary } = await response.json();
    assert.deepEqual(summary, expected);
    assert.equal(contacts.length, Number(expected.total));
    assert.equal(after, null);
  }
  const segment = await createContactSegment(pool, a, {
    name: "Preview saved",
    tag: "lead",
    field_id: field.id,
    field_operator: "gte",
    field_value: 0,
    condition_operator: "or",
  });
  const savedPath = `/api/contacts?preview=true&segment_id=${segment.id}`;
  assert.equal((await (await fieldRequest("GET", savedPath)).json()).total, "4");
  await saveContactTags(pool, a, connectionId, "tag-only", { tags: [] });
  const changed = await (await fieldRequest("GET", savedPath)).json();
  assert.equal(changed.total, "3");
  assert.equal(changed.evaluated, "5");
  assert.deepEqual(changed.excluded, { tag: "0", field: "0", both: "2" });
  assert.equal((await fieldRequest("GET", savedPath, undefined, b)).status, 404);
  await archiveContactSegment(pool, a, segment.id);
  assert.equal((await fieldRequest("GET", savedPath)).status, 404);
});

test("contact activity uses the latest stored comment and partitions exclusions before tag-field filters", async () => {
  const workspace = await ensureWorkspace(pool, a),
    foreignWorkspace = await ensureWorkspace(pool, b);
  const field = await createField("Activity score", "number");
  const from = "2026-10-10T00:00:00.000Z",
    before = "2026-10-12T00:00:00.000Z";
  const rows = [
    ["both", from, 0, ["lead"]],
    ["field-only", "2026-10-11T23:59:59.999Z", 0, []],
    ["tag-only", "2026-10-11T00:00:00.000Z", -1, ["lead"]],
    ["neither", "2026-10-11T00:00:00.000Z", -1, []],
    ["before", "2026-10-09T23:59:59.999Z", 0, ["lead"]],
    ["end", before, 0, ["lead"]],
    ["after", "2026-10-13T00:00:00.000Z", -1, []],
    ["latest-outside", before, -1, []],
  ] as const;
  for (const [sender, time, value, tags] of rows) {
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) VALUES($1,$2,$3,'media',$3,'private',$4)",
      [workspace, connectionId, sender, time],
    );
    await fieldRequest("PUT", fieldValuePath(field.id, sender), { value });
    await saveContactTags(pool, a, connectionId, sender, { tags });
  }
  // An older in-range event must not admit latest-outside; an older out-of-range event must not exclude tag-only.
  for (const [sender, time] of [
    ["latest-outside", from],
    ["tag-only", "2026-10-01T00:00:00.000Z"],
  ])
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) VALUES($1,$2,$3||'-old','media',$3,'private',$4)",
      [workspace, connectionId, sender, time],
    );
  const other = "77777777-7777-4777-8777-777777777777",
    foreign = "88888888-8888-4888-8888-888888888888";
  for (const [id, owner] of [
    [other, workspace],
    [foreign, foreignWorkspace],
  ]) {
    await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,$1::uuid::text)", [
      id,
      owner,
    ]);
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) VALUES($1,$2,'other','media','both','private',$3)",
      [owner, id, from],
    );
  }
  const range = { last_comment_from: from, last_comment_before: before };
  const query = new URLSearchParams({ ...range, connection_id: connectionId });
  const ordinary = await fieldRequest("GET", `/api/contacts?${query}`);
  assert.equal(ordinary.status, 200);
  const page = await ordinary.json();
  assert.deepEqual(
    page.contacts.map((c: { sender_id: string }) => c.sender_id),
    ["both", "field-only", "neither", "tag-only"],
  );
  assert.equal(page.contacts.find((c: { sender_id: string }) => c.sender_id === "tag-only").comment_count, "2");
  assert.equal("excluded" in page, false);
  query.set("preview", "true");
  const check = async (total: string, evaluated: string, excluded: Record<string, string>) => {
    const response = await fieldRequest("GET", `/api/contacts?${query}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, total);
    assert.equal(body.evaluated, evaluated);
    assert.deepEqual(body.excluded, excluded);
    assert.equal(body.contacts.length, Number(total));
    return body;
  };
  assert.deepEqual((await check("4", "8", { activity: "4", tag: "0", field: "0", both: "0" })).contacts, page.contacts);
  query.delete("connection_id");
  await check("5", "9", { activity: "4", tag: "0", field: "0", both: "0" });
  query.set("connection_id", foreign);
  await check("0", "0", { activity: "0", tag: "0", field: "0", both: "0" });
  query.set("connection_id", connectionId);
  query.set("tag", "lead");
  query.set("field_id", field.id);
  query.set("field_operator", "gte");
  query.set("field_value", "0");
  await check("1", "8", { activity: "4", tag: "1", field: "1", both: "1" });
  query.set("condition_operator", "or");
  await check("3", "8", { activity: "4", tag: "0", field: "0", both: "1" });
  query.set("last_comment_from", "2025-01-01T00:00:00.000Z");
  query.set("last_comment_before", "2025-01-02T00:00:00.000Z");
  await check("0", "8", { activity: "8", tag: "0", field: "0", both: "0" });
  const saved = await createContactSegment(pool, a, {
    name: "Activity",
    connection_id: connectionId,
    tag: "lead",
    field_id: field.id,
    field_operator: "gte",
    field_value: 0,
    condition_operator: "or",
    ...range,
  });
  assert.equal(saved.last_comment_from, from);
  assert.equal(saved.last_comment_before, before);
  assert.deepEqual(
    (await listContactSegments(pool, a)).find((s) => s.id === saved.id),
    saved,
  );
  const savedPath = `/api/contacts?preview=true&segment_id=${saved.id}`;
  assert.equal((await (await fieldRequest("GET", savedPath)).json()).total, "3");
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) VALUES($1,$2,'later','media','both','private',$3)",
    [workspace, connectionId, before],
  );
  const updated = await (await fieldRequest("GET", savedPath)).json();
  assert.equal(updated.total, "2");
  assert.deepEqual(updated.excluded, { activity: "5", tag: "0", field: "0", both: "1" });
  assert.equal((await fieldRequest("GET", savedPath, undefined, b)).status, 404);
  await archiveContactSegment(pool, a, saved.id);
  assert.equal((await fieldRequest("GET", savedPath)).status, 404);
});

test("contact activity retains stable pagination and does not trim comment counts to the time window", async () => {
  const workspace = await ensureWorkspace(pool, a);
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) SELECT $1,$2,n::text||'-'||r,'media',lpad(n::text,3,'0'),'private',CASE WHEN r=1 THEN '2026-10-01T00:00:00Z'::timestamptz ELSE '2026-10-11T00:00:00Z'::timestamptz END FROM generate_series(1,55)n CROSS JOIN generate_series(1,2)r",
    [workspace, connectionId],
  );
  const query = new URLSearchParams({
    last_comment_from: "2026-10-10T00:00:00.000Z",
    last_comment_before: "2026-10-12T00:00:00.000Z",
  });
  const first = await listContacts(pool, a, query);
  assert.equal(first.contacts.length, 50);
  assert.ok(first.after);
  query.set("after", first.after);
  const second = await listContacts(pool, a, query);
  assert.equal(second.after, null);
  assert.deepEqual(
    [...first.contacts, ...second.contacts].map((c) => c.sender_id),
    Array.from({ length: 55 }, (_, i) => String(i + 1).padStart(3, "0")),
  );
  assert.ok([...first.contacts, ...second.contacts].every((c) => c.comment_count === "2"));
  assert.ok(
    [...first.contacts, ...second.contacts].every(
      (c) => c.first_comment_at.toISOString() === "2026-10-01T00:00:00.000Z",
    ),
  );
  query.delete("after");
  query.set("preview", "true");
  const preview = await listContacts(pool, a, query);
  assert.equal(preview.total, "55");
  assert.equal(preview.evaluated, "55");
  assert.deepEqual(preview.excluded, { activity: "0", tag: "0", field: "0", both: "0" });
});

test("saved activity ranges reject invalid bounds and preserve the shape of legacy segments", async () => {
  const legacy = await createContactSegment(pool, a, {
    name: "Legacy",
    last_comment_from: null,
    last_comment_before: null,
  });
  assert.equal("last_comment_from" in legacy, false);
  assert.equal("last_comment_before" in legacy, false);
  const before = "2026-10-12T00:00:00.000Z";
  for (const invalid of [
    { last_comment_from: before },
    { last_comment_before: before },
    { last_comment_from: 12, last_comment_before: before },
    { last_comment_from: "2026-02-30T00:00:00.000Z", last_comment_before: before },
    { last_comment_from: before, last_comment_before: before },
    { last_comment_from: "2027-01-01T00:00:00.000Z", last_comment_before: before },
  ])
    await assert.rejects(
      createContactSegment(pool, a, { name: "Invalid", ...invalid }),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  assert.equal((await listContactSegments(pool, a)).length, 1);
});

test("activity migration preserves legacy segments and enforces paired finite ordered timestamps on replay", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE instagram_contact_segments DROP COLUMN last_comment_from, DROP COLUMN last_comment_before",
    );
    await client.query("INSERT INTO instagram_contact_segments(workspace_id,name) VALUES($1,'Legacy')", [workspace]);
    const migration = await readFile(
      new URL("../../db/migrations/046_contact_segment_activity.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual(
      (await client.query("SELECT last_comment_from,last_comment_before FROM instagram_contact_segments")).rows,
      [{ last_comment_from: null, last_comment_before: null }],
    );
    await client.query(
      "UPDATE instagram_contact_segments SET last_comment_from='2026-10-10T00:00:00Z',last_comment_before='2026-10-12T00:00:00Z'",
    );
    await client.query(migration);
    assert.equal(
      (
        await client.query("SELECT last_comment_from FROM instagram_contact_segments")
      ).rows[0].last_comment_from.toISOString(),
      "2026-10-10T00:00:00.000Z",
    );
    for (const change of [
      "last_comment_from=NULL",
      "last_comment_before=NULL",
      "last_comment_before=last_comment_from",
      "last_comment_from='2026-10-13T00:00:00Z'",
      "last_comment_from='-infinity'",
      "last_comment_before='infinity'",
    ]) {
      await client.query("SAVEPOINT invalid_activity");
      await assert.rejects(
        client.query(`UPDATE instagram_contact_segments SET ${change}`),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514",
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_activity");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("contact consent filters keep identity scope and classify after activity before tag-field conditions", async () => {
  const workspace = await ensureWorkspace(pool, a),
    foreignWorkspace = await ensureWorkspace(pool, b);
  const field = await createField("Consent score", "number");
  const from = "2026-10-10T00:00:00.000Z",
    before = "2026-10-12T00:00:00.000Z";
  const rows = [
    ["grant-both", 0, ["lead"]],
    ["grant-field", 0, []],
    ["grant-tag", -1, ["lead"]],
    ["grant-neither", -1, []],
    ["revoked", 0, ["lead"]],
    ["none", 0, ["lead"]],
    ["dm-only", 0, ["lead"]],
    ["other-purpose", 0, ["lead"]],
    ["outside", -1, []],
  ] as const;
  for (const [sender, value, tags] of rows) {
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) VALUES($1,$2,$3,'media',$3,'private',$4)",
      [workspace, connectionId, sender, sender === "outside" ? before : from],
    );
    await fieldRequest("PUT", fieldValuePath(field.id, sender), { value });
    await saveContactTags(pool, a, connectionId, sender, { tags });
  }
  const consent = (
    sender: string,
    decision: "grant" | "revoke",
    purpose: "marketing" | "service_reply" | "all" = "marketing",
    kind: "comment_sender" | "dm_recipient" = "comment_sender",
    connection = connectionId,
    owner = workspace,
    occurredAt = new Date("2026-10-10T00:00:00Z"),
  ) =>
    recordChannelConsentEvent(pool, {
      requestKey: randomUUID(),
      workspaceId: owner,
      connectionId: connection,
      channel: "instagram",
      identityKind: kind,
      identityValue: sender,
      purpose,
      decision,
      evidenceKind: sender === "grant-field" ? "import" : "explicit",
      evidenceReference: "test evidence",
      occurredAt,
      actorId: a.id,
    });
  for (const sender of ["grant-both", "grant-field", "grant-tag", "grant-neither"]) await consent(sender, "grant");
  await consent("grant-both", "revoke", "service_reply");
  await consent("revoked", "revoke");
  await consent("outside", "revoke");
  await consent("dm-only", "grant", "marketing", "dm_recipient");
  await consent("other-purpose", "grant", "service_reply");
  const other = "77777777-7777-4777-8777-777777777777",
    foreign = "88888888-8888-4888-8888-888888888888";
  for (const [id, owner] of [
    [other, workspace],
    [foreign, foreignWorkspace],
  ]) {
    await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,$1::uuid::text)", [
      id,
      owner,
    ]);
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) VALUES($1,$2,'other','media','grant-both','private',$3)",
      [owner, id, from],
    );
    await consent("grant-both", id === other ? "revoke" : "grant", "marketing", "comment_sender", id, owner);
  }
  const query = new URLSearchParams({
    connection_id: connectionId,
    consent_purpose: "marketing",
    consent_state: "granted",
  });
  const ordinary = await listContacts(pool, a, query);
  assert.deepEqual(
    ordinary.contacts.map((c) => c.sender_id),
    ["grant-both", "grant-field", "grant-neither", "grant-tag"],
  );
  assert.equal("excluded" in ordinary, false);
  query.set("preview", "true");
  const check = async (total: string, evaluated: string, excluded: Record<string, string>) => {
    const page = await listContacts(pool, a, query);
    assert.equal(page.total, total);
    assert.equal(page.evaluated, evaluated);
    assert.deepEqual(page.excluded, excluded);
    assert.equal(page.contacts.length, Number(total));
    return page;
  };
  assert.deepEqual(
    (await check("4", "9", { consent: "5", tag: "0", field: "0", both: "0" })).contacts,
    ordinary.contacts,
  );
  query.delete("connection_id");
  await check("4", "10", { consent: "6", tag: "0", field: "0", both: "0" });
  query.set("connection_id", foreign);
  await check("0", "0", { consent: "0", tag: "0", field: "0", both: "0" });
  query.set("connection_id", connectionId);
  query.set("last_comment_from", from);
  query.set("last_comment_before", before);
  await check("4", "9", { activity: "1", consent: "4", tag: "0", field: "0", both: "0" });
  query.set("consent_state", "revoked");
  await check("1", "9", { activity: "1", consent: "7", tag: "0", field: "0", both: "0" });
  query.set("consent_state", "no_record");
  assert.deepEqual(
    (await check("3", "9", { activity: "1", consent: "5", tag: "0", field: "0", both: "0" })).contacts.map(
      (c) => c.sender_id,
    ),
    ["dm-only", "none", "other-purpose"],
  );
  query.set("consent_purpose", "service_reply");
  query.set("consent_state", "granted");
  assert.deepEqual(
    (await check("1", "9", { activity: "1", consent: "7", tag: "0", field: "0", both: "0" })).contacts.map(
      (c) => c.sender_id,
    ),
    ["other-purpose"],
  );
  query.set("consent_purpose", "marketing");
  query.set("tag", "lead");
  query.set("field_id", field.id);
  query.set("field_operator", "gte");
  query.set("field_value", "0");
  await check("1", "9", { activity: "1", consent: "4", tag: "1", field: "1", both: "1" });
  query.set("condition_operator", "or");
  await check("3", "9", { activity: "1", consent: "4", tag: "0", field: "0", both: "1" });
  query.set("tag", "absent");
  query.set("field_value", "99");
  await check("0", "9", { activity: "1", consent: "4", tag: "0", field: "0", both: "4" });
  const saved = await createContactSegment(pool, a, {
    name: "Consent",
    connection_id: connectionId,
    tag: "lead",
    field_id: field.id,
    field_operator: "gte",
    field_value: 0,
    condition_operator: "or",
    last_comment_from: from,
    last_comment_before: before,
    consent_purpose: "marketing",
    consent_state: "granted",
  });
  assert.equal(saved.consent_purpose, "marketing");
  assert.equal(saved.consent_state, "granted");
  assert.deepEqual(
    (await listContactSegments(pool, a)).find((s) => s.id === saved.id),
    saved,
  );
  const savedQuery = new URLSearchParams({ segment_id: saved.id, preview: "true" });
  assert.equal((await listContacts(pool, a, savedQuery)).total, "3");
  await consent("grant-both", "revoke", "all");
  assert.equal((await listContacts(pool, a, savedQuery)).total, "2");
  await consent(
    "grant-both",
    "grant",
    "marketing",
    "comment_sender",
    connectionId,
    workspace,
    new Date("2020-01-01T00:00:00Z"),
  );
  assert.equal((await listContacts(pool, a, savedQuery)).total, "3", "newest server projection wins over occurred_at");
  await assert.rejects(listContacts(pool, b, savedQuery), (e: unknown) => e instanceof ApiError && e.status === 404);
  const eventsBefore = (await pool.query("SELECT count(*)::text AS count FROM channel_consent_events")).rows[0].count;
  await listContacts(pool, a, savedQuery);
  assert.equal(
    (await pool.query("SELECT count(*)::text AS count FROM channel_consent_events")).rows[0].count,
    eventsBefore,
  );
  await archiveContactSegment(pool, a, saved.id);
  await assert.rejects(listContacts(pool, a, savedQuery), (e: unknown) => e instanceof ApiError && e.status === 404);
});

test("contact consent no-record filters retain stable pages for all matching contacts", async () => {
  const workspace = await ensureWorkspace(pool, a);
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) SELECT $1,$2,n::text||'-'||r,'media',lpad(n::text,3,'0'),'private' FROM generate_series(1,55)n CROSS JOIN generate_series(1,2)r",
    [workspace, connectionId],
  );
  const query = new URLSearchParams({ consent_purpose: "marketing", consent_state: "no_record" });
  const first = await listContacts(pool, a, query);
  assert.equal(first.contacts.length, 50);
  assert.ok(first.after);
  query.set("after", first.after);
  const second = await listContacts(pool, a, query);
  assert.equal(second.after, null);
  assert.deepEqual(
    [...first.contacts, ...second.contacts].map((c) => c.sender_id),
    Array.from({ length: 55 }, (_, i) => String(i + 1).padStart(3, "0")),
  );
  assert.ok([...first.contacts, ...second.contacts].every((c) => c.comment_count === "2"));
  query.delete("after");
  query.set("preview", "true");
  const page = await listContacts(pool, a, query);
  assert.equal(page.total, "55");
  assert.equal(page.evaluated, "55");
  assert.deepEqual(page.excluded, { consent: "0", tag: "0", field: "0", both: "0" });
});

test("saved consent filters reject invalid pairs and omit legacy response keys", async () => {
  const legacy = await createContactSegment(pool, a, {
    name: "Legacy consent",
    consent_purpose: null,
    consent_state: null,
  });
  assert.equal("consent_purpose" in legacy, false);
  assert.equal("consent_state" in legacy, false);
  for (const invalid of [
    { consent_purpose: "marketing" },
    { consent_state: "granted" },
    { consent_purpose: "", consent_state: "no_record" },
    { consent_purpose: "all", consent_state: "revoked" },
    { consent_purpose: "service_reply", consent_state: "eligible" },
    { consent_purpose: false, consent_state: "granted" },
  ])
    await assert.rejects(
      createContactSegment(pool, a, { name: "Invalid consent", ...invalid }),
      (e: unknown) => e instanceof ApiError && e.status === 400,
    );
  assert.equal((await listContactSegments(pool, a)).length, 1);
});

test("consent segment migration preserves legacy rows and validates paired enums on replay", async () => {
  const workspace = await ensureWorkspace(pool, a),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE instagram_contact_segments DROP COLUMN consent_purpose, DROP COLUMN consent_state");
    await client.query("INSERT INTO instagram_contact_segments(workspace_id,name) VALUES($1,'Legacy')", [workspace]);
    const migration = await readFile(
      new URL("../../db/migrations/047_contact_segment_consent.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual(
      (await client.query("SELECT consent_purpose,consent_state FROM instagram_contact_segments")).rows,
      [{ consent_purpose: null, consent_state: null }],
    );
    await client.query("UPDATE instagram_contact_segments SET consent_purpose='marketing',consent_state='no_record'");
    await client.query(migration);
    assert.deepEqual(
      (await client.query("SELECT consent_purpose,consent_state FROM instagram_contact_segments")).rows,
      [{ consent_purpose: "marketing", consent_state: "no_record" }],
    );
    for (const change of [
      "consent_purpose=NULL",
      "consent_state=NULL",
      "consent_purpose='all'",
      "consent_state='eligible'",
      "consent_purpose=''",
      "consent_state=''",
    ]) {
      await client.query("SAVEPOINT invalid_consent");
      await assert.rejects(
        client.query(`UPDATE instagram_contact_segments SET ${change}`),
        (e: unknown) => typeof e === "object" && e !== null && "code" in e && e.code === "23514",
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_consent");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("ordered field filters compare numbers numerically and dates at each boundary", async () => {
  await fieldContact();
  for (const [type, low, equal, high] of [
    ["number", -1.5, 0, 10],
    ["date", "2024-02-28", "2024-02-29", "2024-03-01"],
  ] as const) {
    const field = await createField(`Ordered ${type}`, type);
    for (const [operator, expected] of [
      ["gt", [false, false, true]],
      ["gte", [false, true, true]],
      ["lt", [true, false, false]],
      ["lte", [true, true, false]],
    ] as const) {
      const query = new URLSearchParams({
        field_id: field.id,
        field_operator: operator,
        field_value: JSON.stringify(equal),
      });
      for (const [index, value] of [low, equal, high, null].entries()) {
        assert.equal((await fieldRequest("PUT", fieldValuePath(field.id), { value })).status, 200);
        const response = await fieldRequest("GET", `/api/contacts?${query}`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).contacts.length, expected[index] ? 1 : 0);
      }
    }
  }
  // 2 is less than 10 numerically even though their JSON spellings sort the other way.
  const field = await createField("Numeric order", "number");
  await fieldRequest("PUT", fieldValuePath(field.id), { value: 2 });
  const query = new URLSearchParams({ field_id: field.id, field_operator: "lt", field_value: "10" });
  assert.equal((await listContacts(pool, a, query)).contacts.length, 1);
});

test("ordered saved segments preserve values and re-evaluate scoped current data", async () => {
  await fieldContact();
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Score threshold", "number");
  await fieldRequest("PUT", fieldValuePath(field.id), { value: 10 });
  const created = await fieldRequest("POST", "/api/contact-segments", {
    name: "Score at least 10",
    connection_id: connectionId,
    tag: "lead",
    field_id: field.id,
    field_operator: "gte",
    field_value: 10,
  });
  assert.equal(created.status, 201);
  const segment = await created.json();
  assert.equal(segment.field_operator, "gte");
  assert.equal(segment.field_value, 10);
  assert.deepEqual((await listContactSegments(pool, a))[0], segment);
  const query = new URLSearchParams({ segment_id: segment.id });
  assert.equal((await listContacts(pool, a, query)).contacts.length, 0);
  await saveContactTags(pool, a, connectionId, "sender", { tags: ["lead"] });
  assert.equal((await listContacts(pool, a, query)).contacts.length, 1);
  const other = "77777777-7777-4777-8777-777777777777";
  await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,'ordered-other')", [
    other,
    workspace,
  ]);
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'ordered-other','media','sender','private')",
    [workspace, other],
  );
  await fieldRequest("PUT", fieldValuePath(field.id, "sender", other), { value: 20 });
  await saveContactTags(pool, a, other, "sender", { tags: ["lead"] });
  assert.deepEqual(
    (await listContacts(pool, a, query)).contacts.map((contact) => contact.connection_id),
    [connectionId],
  );
  assert.equal((await fieldRequest("GET", `/api/contacts?${query}`, undefined, b)).status, 404);
  assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${field.id}`)).status, 409);
  await fieldRequest("PUT", fieldValuePath(field.id), { value: 9 });
  assert.equal((await listContacts(pool, a, query)).contacts.length, 0);
  await archiveContactSegment(pool, a, segment.id);
  assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${field.id}`)).status, 200);
});

test("ordered conditions reject unsupported types missing values and foreign fields", async () => {
  for (const [type, bad] of [
    ["number", "10"],
    ["number", true],
    ["date", "2025-02-29"],
    ["date", "2024-2-9"],
    ["text", "text"],
    ["boolean", false],
  ] as const) {
    const field = await createField(`Unsupported ${type}-${String(bad)}`, type);
    const body = { name: "Invalid ordered segment", field_id: field.id, field_operator: "gte", field_value: bad };
    const query = new URLSearchParams({ field_id: field.id, field_operator: "gte", field_value: JSON.stringify(bad) });
    assert.equal((await fieldRequest("GET", `/api/contacts?${query}`)).status, 400);
    assert.equal((await fieldRequest("POST", "/api/contact-segments", body)).status, 400);
  }
  const field = await createField("Required threshold", "number");
  for (const operator of ["gt", "gte", "lt", "lte"]) {
    assert.equal(
      (await fieldRequest("GET", `/api/contacts?field_id=${field.id}&field_operator=${operator}`)).status,
      400,
    );
    const query = new URLSearchParams({ field_id: field.id, field_operator: operator, field_value: "0" });
    assert.equal((await fieldRequest("GET", `/api/contacts?${query}`, undefined, b)).status, 404);
    assert.equal(
      (
        await fieldRequest(
          "POST",
          "/api/contact-segments",
          {
            name: `Foreign ${operator}`,
            field_id: field.id,
            field_operator: operator,
            field_value: 0,
          },
          b,
        )
      ).status,
      404,
    );
  }
});

test("ordered contact pages use the existing stable cursor without duplicates", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Page score", "number");
  await pool.query(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
    SELECT $1,$2,'page-'||n,'media',lpad(n::text,3,'0'),'private' FROM generate_series(1,55) n`,
    [workspace, connectionId],
  );
  await pool.query(
    `INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value)
    SELECT $1,$2,lpad(n::text,3,'0'),$3,to_jsonb(n) FROM generate_series(1,55) n`,
    [workspace, connectionId, field.id],
  );
  const query = new URLSearchParams({ field_id: field.id, field_operator: "gte", field_value: "1" });
  const first = await listContacts(pool, a, query);
  assert.equal(first.contacts.length, 50);
  assert.ok(first.after);
  query.set("after", first.after);
  const second = await listContacts(pool, a, query);
  assert.equal(second.after, null);
  assert.deepEqual(
    [...first.contacts, ...second.contacts].map((contact) => contact.sender_id),
    Array.from({ length: 55 }, (_, n) => String(n + 1).padStart(3, "0")),
  );
});

test("concurrent field creation enforces the active cap and field archive serializes segment creation", async () => {
  const workspace = await ensureWorkspace(pool, a);
  for (let n = 0; n < 49; n++) await createField(`field-${n}`, "text");
  const results = await Promise.all([
    fieldRequest("POST", "/api/contact-fields", { name: "A", type: "text" }),
    fieldRequest("POST", "/api/contact-fields", { name: "B", type: "text" }),
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  assert.deepEqual(await results.find((response) => response.status === 409)!.json(), { error: "field_limit_reached" });
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM instagram_contact_fields WHERE workspace_id=$1 AND NOT archived", [
        workspace,
      ])
    ).rows[0].count,
    "50",
  );
  const field = await results.find((response) => response.status === 201)!.json();
  const [archive, segment] = await Promise.all([
    fieldRequest("DELETE", `/api/contact-fields/${field.id}`),
    fieldRequest("POST", "/api/contact-segments", { name: "Race", field_id: field.id, field_operator: "is_set" }),
  ]);
  assert.ok((archive.status === 200 && segment.status === 404) || (archive.status === 409 && segment.status === 201));
});

test("parallel first login creates exactly one workspace per user", async () => {
  const user = { id: "44444444-4444-4444-8444-444444444444", email: "c@example.test" };
  const ids = await Promise.all([ensureWorkspace(pool, user), ensureWorkspace(pool, user)]);
  assert.equal(ids[0], ids[1]);
  assert.equal((await pool.query("SELECT count(*) FROM workspaces")).rows[0].count, "3");
});

test("connection listings omit credentials and cannot cross workspaces", async () => {
  const owned = await listConnections(pool, a);
  assert.equal(owned.length, 1);
  assert.equal(owned[0].token_registered, true);
  assert.equal(JSON.stringify(owned).includes("encrypted-test"), false);
  assert.deepEqual(await listConnections(pool, b), []);
});

test("media retrieval uses real workspace predicates before accessing an encrypted credential", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const key = Buffer.alloc(32, 2).toString("base64");
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=$1 WHERE id=$2", [
    sealSecret("media-test-token", key, `${workspace}:123`),
    connectionId,
  ]);
  const fetchImpl = (async (input: string | URL | Request) => {
    return Response.json(
      new URL(String(input)).pathname.endsWith("/me")
        ? { id: "999", user_id: "123" }
        : { data: [{ id: "12345", owner: { id: "999" }, media_type: "IMAGE", caption: "Owned post" }] },
    );
  }) as typeof fetch;
  const env = { TOKEN_ENCRYPTION_KEY: key, META_GRAPH_VERSION: "v26.0" };
  assert.equal((await connectionMedia(pool, a, connectionId, env, {}, fetchImpl)).media[0]?.caption, "Owned post");
  await assert.rejects(
    connectionMedia(pool, b, connectionId, env, {}, (async () => {
      throw new Error("Graph must not be reached");
    }) as typeof fetch),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  await pool.query("UPDATE instagram_connections SET token_expires_at=now()-interval '1 minute' WHERE id=$1", [
    connectionId,
  ]);
  await assert.rejects(
    connectionMedia(pool, a, connectionId, env, {}, fetchImpl),
    (error: unknown) => error instanceof ApiError && error.message === "media_reconnect_required",
  );
});

test("rules are created and updated only within the verified user's workspace", async () => {
  const first = await saveRule(pool, a, input);
  const second = await saveRule(pool, a, { ...input, private_reply_text: "Updated" });
  assert.equal(first.id, second.id);
  assert.equal((await listRules(pool, a))[0].private_reply_text, "Updated");
  assert.deepEqual((await listRules(pool, a))[0].keywords, ["link"]);
  await assert.rejects(saveRule(pool, b, { ...input, private_reply_text: "Hijacked" }), ApiError);
  assert.deepEqual(await listRules(pool, b), []);
  assert.equal((await listRules(pool, a))[0].private_reply_text, "Updated");
});

test("connection activation rejects another user's ID and unavailable tokens", async () => {
  await assert.rejects(updateConnection(pool, b, connectionId, { active: false, send_enabled: true }), ApiError);
  assert.equal((await listConnections(pool, a))[0].active, true);
  await pool.query("UPDATE instagram_connections SET token_expires_at=now()-interval '1 minute'");
  await assert.rejects(updateConnection(pool, a, connectionId, { active: true, send_enabled: true }), ApiError);
  await updateConnection(pool, a, connectionId, { active: false, send_enabled: false });
  assert.equal((await listConnections(pool, a))[0].active, false);
});

test("invalid keyword and follow settings are rejected without changing the stored rule", async () => {
  await saveRule(pool, a, input);
  const original = await listRules(pool, a);
  for (const changes of [
    { keywords: [] },
    { keywords: [""] },
    { keywords: Array(21).fill("a") },
    { follow_gate_enabled: true },
    { media_id: "../other" },
    { private_reply_text: " " },
  ]) {
    await assert.rejects(saveRule(pool, a, { ...input, ...changes }), ApiError);
    assert.deepEqual(await listRules(pool, a), original);
  }
  assert.equal((await listRules(pool, a)).length, 1);
});

test("editing a rule cannot silently change its identity or create another rule", async () => {
  const rule = await saveRule(pool, a, input);
  await assert.rejects(saveRule(pool, a, { ...input, id: rule.id, media_id: "98765" }), ApiError);
  await assert.rejects(saveRule(pool, b, { ...input, id: rule.id }), ApiError);
  await saveRule(pool, a, { ...input, id: rule.id, private_reply_text: "Edited" });
  const rules = await listRules(pool, a);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].private_reply_text, "Edited");
});

test("disconnect clears only owned credentials and disables its rules", async () => {
  await saveRule(pool, a, input);
  // Another workspace's or an unknown connection answers 404 like every other connection route.
  for (const [user, id] of [
    [b, connectionId],
    [a, "99999999-9999-4999-8999-999999999999"],
  ] as const)
    await assert.rejects(
      disconnectConnection(pool, user, id),
      (e: unknown) => e instanceof ApiError && e.status === 404 && e.message === "connection_not_found",
    );
  assert.equal((await listConnections(pool, a))[0].token_registered, true);
  assert.equal((await listRules(pool, a))[0].enabled, true);
  await disconnectConnection(pool, a, connectionId);
  const connection = (await listConnections(pool, a))[0];
  assert.equal(connection.active, false);
  assert.equal(connection.send_enabled, false);
  assert.equal(connection.token_registered, false);
  await assert.rejects(updateConnection(pool, a, connectionId, { active: true, send_enabled: false }), ApiError);
  assert.equal((await listRules(pool, a))[0].enabled, false);
});

test("connection list distinguishes valid, expired, and missing local credentials within one workspace", async () => {
  assert.equal((await listConnections(pool, a))[0].credential_status, "valid");
  assert.deepEqual(await listConnections(pool, b), []);
  await pool.query("UPDATE instagram_connections SET token_expires_at=now()-interval '1 second' WHERE id=$1", [
    connectionId,
  ]);
  assert.equal((await listConnections(pool, a))[0].credential_status, "expired");
  await pool.query("UPDATE instagram_connections SET token_expires_at=NULL WHERE id=$1", [connectionId]);
  assert.equal((await listConnections(pool, a))[0].credential_status, "expired");
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=NULL,token_expires_at=NULL WHERE id=$1", [
    connectionId,
  ]);
  assert.equal((await listConnections(pool, a))[0].credential_status, "missing");
});

test("connection health refuses a connection owned by another workspace before any provider request", async () => {
  let providerCalls = 0;
  await assert.rejects(
    connectionHealth(pool, b, connectionId, {}, (async () => {
      providerCalls++;
      throw new Error("provider must not be called");
    }) as typeof fetch),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  assert.equal(providerCalls, 0);
});

test("administrator ownership assignment requires confirmation and preserves existing owners", async () => {
  const client = await pool.connect();
  try {
    const script = await readFile(new URL("../../deploy/assign-workspace-owner.sql", import.meta.url), "utf8");
    const functionSql = script
      .slice(script.indexOf("CREATE FUNCTION"), script.indexOf("SELECT pg_temp.assign_workspace_owner"))
      .replace("auth.users", "pg_temp.verified_users");
    await client.query("CREATE TEMP TABLE verified_users(id uuid,email_confirmed_at timestamptz)");
    await client.query(functionSql);
    const legacy = "55555555-5555-4555-8555-555555555555";
    await client.query("INSERT INTO workspaces VALUES($1)", [legacy]);
    await assert.rejects(
      client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [b.id, legacy]),
      /Confirmed Supabase user/,
    );
    await client.query("INSERT INTO verified_users VALUES($1,now()),($2,now())", [a.id, b.id]);
    await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [a.id, legacy]), /not empty/);
    await client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [b.id, legacy]);
    await client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [b.id, legacy]);
    await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [a.id, legacy]), /already owned/);
    assert.equal(
      (await client.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1", [b.id])).rows[0].workspace_id,
      legacy,
    );
  } finally {
    await client.query("DROP TABLE IF EXISTS pg_temp.verified_users");
    client.release();
  }
});

test("administrator ownership assignment refuses to leave a workspace holding invites or settings", async () => {
  const client = await pool.connect();
  try {
    const script = await readFile(new URL("../../deploy/assign-workspace-owner.sql", import.meta.url), "utf8");
    const functionSql = script
      .slice(script.indexOf("CREATE FUNCTION"), script.indexOf("SELECT pg_temp.assign_workspace_owner"))
      .replace("auth.users", "pg_temp.verified_users")
      // The previous test may have left the temporary function on this pooled connection.
      .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
    await client.query("CREATE TEMP TABLE verified_users(id uuid,email_confirmed_at timestamptz)");
    await client.query(functionSql);
    const mover = "66666666-6666-4666-8666-666666666661";
    const own = "66666666-6666-4666-8666-666666666662";
    const target = "66666666-6666-4666-8666-666666666663";
    await client.query("INSERT INTO verified_users VALUES($1,now())", [mover]);
    await client.query("INSERT INTO workspaces VALUES($1),($2)", [own, target]);
    await client.query("INSERT INTO workspace_members(user_id,workspace_id,role) VALUES($1,$2,'owner')", [mover, own]);
    // A revoked invite still holds an invitee's email, so the workspace is not empty.
    await client.query(
      `INSERT INTO workspace_invites(workspace_id,email,role,token_hash,created_by,expires_at,revoked_at)
       VALUES($1,'old@example.test','agent',$2,$3,now()+interval '1 day',now())`,
      [own, "a".repeat(64), mover],
    );
    await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [mover, target]), /not empty/);
    await client.query("TRUNCATE workspace_invites");
    // An archived inbox label is still workspace data.
    await client.query(
      "INSERT INTO instagram_inbox_labels(workspace_id,name,archived,created_by) VALUES($1,'kept',true,$2)",
      [own, mover],
    );
    await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [mover, target]), /not empty/);
    // A keyword label rule is workspace data on its own too; its label is skipped here (replica mode skips foreign
    // key checks) so that the rule alone is left.
    await client.query("TRUNCATE instagram_inbox_labels CASCADE");
    await client.query("SET session_replication_role=replica");
    await client.query(
      `INSERT INTO instagram_inbox_label_rules(workspace_id,label_id,match_mode,keywords,created_by,updated_by)
       VALUES($1,gen_random_uuid(),'contains','{kept}',$2,$2)`,
      [own, mover],
    );
    await client.query("RESET session_replication_role");
    await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [mover, target]), /not empty/);
    await client.query("TRUNCATE instagram_inbox_label_rules CASCADE");
    // Even an inactive endpoint keeps workspace data (including its signing keys and delivery history).
    await client.query(
      "INSERT INTO webhook_endpoints(workspace_id,name,url) VALUES($1,'kept','https://hooks.example.test/in')",
      [own],
    );
    for (const active of [true, false]) {
      await client.query("UPDATE webhook_endpoints SET active=$2 WHERE workspace_id=$1", [own, active]);
      await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [mover, target]), /not empty/);
      assert.equal(
        (await client.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1", [mover])).rows[0]
          .workspace_id,
        own,
      );
    }
    await client.query("TRUNCATE webhook_endpoints CASCADE");
    await client.query("INSERT INTO flows(workspace_id,name,draft) VALUES($1,'kept','{}')", [own]);
    await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [mover, target]), /not empty/);
  } finally {
    await client.query("RESET session_replication_role");
    await client.query("DROP TABLE IF EXISTS pg_temp.verified_users");
    client.release();
  }
});

test("activity belongs to the verified workspace and excludes recipient content", async () => {
  const { ingestComments } = await import("../instagram/store.ts");
  const { listActivity } = await import("./settings.ts");
  await saveRule(pool, a, input);
  await ingestComments(pool, [{ accountId: "123", commentId: "777", postId: "12345", senderId: "888", text: "link" }]);
  const owned = await listActivity(pool, a);
  assert.equal(owned.length, 1);
  assert.equal(owned[0].first_reply_status, "pending");
  assert.equal("sender_id" in owned[0], false);
  assert.equal("private_reply_text" in owned[0], false);
  assert.deepEqual(await listActivity(pool, b), []);
});

test("confirmation button round trips within a workspace and invalid configurations cannot save", async () => {
  const config = {
    ...input,
    follow_gate_enabled: true,
    confirmation_button_title: "자료 받기",
    confirmation_keyword: "확인",
    follower_reply_text: "링크",
    non_follower_reply_text: "팔로우 후 눌러 주세요",
  };
  await saveRule(pool, a, config);
  assert.equal((await listRules(pool, a))[0].confirmation_button_title, "자료 받기");
  assert.deepEqual(await listRules(pool, b), []);
  for (const invalid of [
    { ...config, confirmation_button_title: "x".repeat(21) },
    { ...config, follow_gate_enabled: false },
    { ...config, private_reply_text: "x".repeat(641) },
    { ...config, non_follower_reply_text: "x".repeat(641) },
  ])
    await assert.rejects(saveRule(pool, a, invalid), ApiError);
  await saveRule(pool, a, { ...config, confirmation_button_title: "" });
  assert.equal((await listRules(pool, a))[0].confirmation_button_title, "");
});

test("button migration upgrades existing rows with no button and is repeatable", async () => {
  await saveRule(pool, a, input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE instagram_comment_rules DROP COLUMN confirmation_button_title");
    await client.query("ALTER TABLE instagram_follow_conversations DROP COLUMN confirmation_button_title");
    const migration = await readFile(
      new URL("../../db/migrations/007_confirmation_button.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    assert.equal(
      (await client.query("SELECT confirmation_button_title FROM instagram_comment_rules")).rows[0]
        .confirmation_button_title,
      "",
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

async function contactEvents() {
  const { ingestComments } = await import("../instagram/store.ts");
  await ingestComments(pool, [
    { accountId: "123", commentId: "c1", postId: "12345", senderId: "888", text: "private comment text" },
    { accountId: "123", commentId: "c2", postId: "54321", senderId: "888", text: "private comment text" },
  ]);
}
test("contacts deduplicate comments and return no content or credentials across workspaces", async () => {
  await contactEvents();
  const page = await listContacts(pool, a);
  assert.equal(page.contacts.length, 1);
  assert.equal(page.contacts[0].sender_id, "888");
  assert.equal(page.contacts[0].comment_count, "2");
  assert.deepEqual(page.contacts[0].tags, []);
  assert.equal(JSON.stringify(page).includes("private comment text"), false);
  assert.equal(JSON.stringify(page).includes("encrypted-test"), false);
  assert.deepEqual((await listContacts(pool, b)).contacts, []);
});
test("contact tags normalize, filter, clear and cannot target foreign or nonexistent contacts", async () => {
  await contactEvents();
  await saveContactTags(pool, a, connectionId, "888", { tags: [" Lead ", "lead", "관심"] });
  assert.deepEqual((await listContacts(pool, a)).contacts[0].tags, ["lead", "관심"]);
  assert.equal((await listContacts(pool, a, new URLSearchParams({ tag: " LEAD " }))).contacts.length, 1);
  assert.equal((await listContacts(pool, a, new URLSearchParams({ tag: "customer" }))).contacts.length, 0);
  await assert.rejects(
    saveContactTags(pool, b, connectionId, "888", { tags: ["foreign"] }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  await assert.rejects(
    saveContactTags(pool, a, connectionId, "999", { tags: ["new"] }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  for (const tags of [[""], ["x".repeat(41)], Array(21).fill("tag"), [null], "lead"])
    await assert.rejects(
      saveContactTags(pool, a, connectionId, "888", { tags }),
      (e: unknown) => e instanceof ApiError && e.status === 400,
    );
  assert.deepEqual((await listContacts(pool, a)).contacts[0].tags, ["lead", "관심"]);
  await saveContactTags(pool, a, connectionId, "888", { tags: [] });
  assert.deepEqual((await listContacts(pool, a)).contacts[0].tags, []);
});

test("contact identity and tag filters stay separate for each account", async () => {
  await contactEvents();
  const wa = await ensureWorkspace(pool, a),
    wb = await ensureWorkspace(pool, b);
  const other = "44444444-4444-4444-8444-444444444444",
    foreign = "55555555-5555-4555-8555-555555555555";
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active) VALUES($1,$2,'124',true),($3,$4,'125',true)",
    [other, wa, foreign, wb],
  );
  const { ingestComments } = await import("../instagram/store.ts");
  await ingestComments(pool, [
    { accountId: "124", commentId: "other", postId: "12345", senderId: "888", text: "other account" },
    { accountId: "125", commentId: "foreign", postId: "12345", senderId: "888", text: "foreign" },
  ]);
  await saveContactTags(pool, a, connectionId, "888", { tags: ["lead"] });
  assert.equal((await listContacts(pool, a)).contacts.length, 2);
  const own = (await listContacts(pool, a, new URLSearchParams({ connection_id: other }))).contacts;
  assert.equal(own.length, 1);
  assert.deepEqual(own[0].tags, []);
  assert.equal((await listContacts(pool, a, new URLSearchParams({ connection_id: foreign }))).contacts.length, 0);
  assert.equal((await listContacts(pool, b, new URLSearchParams({ tag: "lead" }))).contacts.length, 0);
});
test("contact keyset pages visit every stable identity once and reject malformed requests", async () => {
  const workspace = await ensureWorkspace(pool, a);
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) SELECT $1,$2,'page-'||n,'12345',(900000+n)::text,'private' FROM generate_series(1,51) n",
    [workspace, connectionId],
  );
  const first = await listContacts(pool, a);
  assert.equal(first.contacts.length, 50);
  assert.ok(first.after);
  const second = await listContacts(pool, a, new URLSearchParams({ after: first.after }));
  assert.equal(second.contacts.length, 1);
  assert.equal(second.after, null);
  assert.equal(new Set([...first.contacts, ...second.contacts].map((c) => c.sender_id)).size, 51);
  for (const query of [
    "after=broken",
    "after=https://evil.test",
    "tag=",
    // tag may repeat up to five times since the multi-tag condition; a sixth value is refused.
    "tag=a&tag=b&tag=c&tag=d&tag=e&tag=f",
    "connection_id=wrong",
    "extra=1",
  ])
    await assert.rejects(
      listContacts(pool, a, new URLSearchParams(query)),
      (e: unknown) => e instanceof ApiError && e.status === 400,
    );
});
test("contact migration is repeatable and creates a table when upgrading", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP TABLE instagram_contact_tags");
    await client.query("DROP INDEX IF EXISTS instagram_comment_events_contact_lookup_idx");
    const migration = await readFile(
      new URL("../../db/migrations/008_instagram_contact_tags.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    await client.query(
      "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id) SELECT workspace_id,id,'888' FROM instagram_connections WHERE id=$1",
      [connectionId],
    );
    assert.deepEqual((await client.query("SELECT tags FROM instagram_contact_tags")).rows[0].tags, []);
    assert.equal(
      (await client.query("SELECT to_regclass('instagram_comment_events_contact_lookup_idx')::text AS name")).rows[0]
        .name,
      "instagram_comment_events_contact_lookup_idx",
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("contact existence lookups can use the workspace/account/sender index", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Prove index eligibility, not a planner choice or production latency bound.
    await client.query("SET LOCAL enable_seqscan=off");
    const result = await client.query(
      "EXPLAIN (FORMAT JSON) SELECT 1 FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3",
      [workspace, connectionId, "sender-1"],
    );
    assert.ok(JSON.stringify(result.rows).includes("instagram_comment_events_contact_lookup_idx"));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("existing string sender identities can be tagged and used at a page boundary", async () => {
  const workspace = await ensureWorkspace(pool, a);
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) SELECT $1,$2,'string-'||n,'12345','sender-'||lpad(n::text,3,'0'),'private' FROM generate_series(1,51) n",
    [workspace, connectionId],
  );
  const page = await listContacts(pool, a);
  assert.equal(page.contacts.length, 50);
  assert.ok(page.after);
  const next = await listContacts(pool, a, new URLSearchParams({ after: page.after }));
  assert.equal(next.contacts.length, 1);
  assert.equal(next.contacts[0].sender_id, "sender-051");
  await saveContactTags(pool, a, connectionId, "sender-050", { tags: ["lead"] });
});

test("saved segments isolate workspace and evaluate current tags", async () => {
  const workspace = await ensureWorkspace(pool, a);
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'segment-comment','media','sender','private')",
    [workspace, connectionId],
  );
  const segment = await createContactSegment(pool, a, { name: " Leads ", connection_id: connectionId, tag: " Lead " });
  assert.deepEqual(segment, { id: segment.id, name: "Leads", connection_id: connectionId, tag: "lead", version: 1 });
  assert.equal((await listContactSegments(pool, a)).length, 1);
  assert.deepEqual(await listContactSegments(pool, b), []);
  const query = new URLSearchParams({ segment_id: segment.id });
  assert.equal((await listContacts(pool, a, query)).contacts.length, 0);
  await saveContactTags(pool, a, connectionId, "sender", { tags: ["lead"] });
  assert.equal((await listContacts(pool, a, query)).contacts[0]?.sender_id, "sender");
  await saveContactTags(pool, a, connectionId, "sender", { tags: [] });
  assert.equal((await listContacts(pool, a, query)).contacts.length, 0);
  for (const action of [
    () => createContactSegment(pool, b, { name: "Foreign", connection_id: connectionId }),
    () => listContacts(pool, b, query),
    () => archiveContactSegment(pool, b, segment.id),
  ])
    await assert.rejects(action, (e: unknown) => e instanceof ApiError && e.status === 404);
  await archiveContactSegment(pool, a, segment.id);
  await archiveContactSegment(pool, a, segment.id);
  assert.deepEqual(await listContactSegments(pool, a), []);
  await assert.rejects(listContacts(pool, a, query), (e: unknown) => e instanceof ApiError && e.status === 404);
  assert.equal((await pool.query("SELECT count(*) FROM instagram_comment_events")).rows[0].count, "1");
  assert.ok((await createContactSegment(pool, a, { name: "Leads" })).id);
});

test("segments reject invalid names, duplicate normalized names and mixed filters", async () => {
  for (const input of [
    { name: " " },
    { name: "x".repeat(61) },
    { name: "bad\nname" },
    { name: "Lead", extra: true },
    { name: "Lead", connection_id: "bad" },
    { name: "Lead", tag: "x".repeat(41) },
  ]) {
    await assert.rejects(
      createContactSegment(pool, a, input),
      (e: unknown) => e instanceof ApiError && e.status === 400,
    );
  }
  const segment = await createContactSegment(pool, a, { name: " Cafe\u0301 " });
  await assert.rejects(
    createContactSegment(pool, a, { name: "Café" }),
    (e: unknown) => e instanceof ApiError && e.status === 409,
  );
  for (const query of [
    `segment_id=${segment.id}&tag=lead`,
    `segment_id=${segment.id}&connection_id=${connectionId}`,
    "segment_id=bad",
    `segment_id=${segment.id}&segment_id=${segment.id}`,
  ])
    await assert.rejects(
      listContacts(pool, a, new URLSearchParams(query)),
      (e: unknown) => e instanceof ApiError && e.status === 400,
    );
});

test("concurrent segment creations cannot exceed fifty active records", async () => {
  const workspace = await ensureWorkspace(pool, a);
  await pool.query(
    "INSERT INTO instagram_contact_segments(workspace_id,name) SELECT $1,'segment-'||n FROM generate_series(1,49) n",
    [workspace],
  );
  const results = await Promise.allSettled([
    createContactSegment(pool, a, { name: "one" }),
    createContactSegment(pool, a, { name: "two" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" &&
      rejected.reason instanceof ApiError &&
      rejected.reason.message === "segment_limit_reached",
  );
  assert.equal((await listContactSegments(pool, a)).length, 50);
  const [first] = await listContactSegments(pool, a);
  await archiveContactSegment(pool, a, first.id);
  assert.ok((await createContactSegment(pool, a, { name: "replacement" })).id);
  assert.equal((await listContactSegments(pool, a)).length, 50);
});

const segmentPath = (id: string) => `/api/contact-segments/${id}`;
async function segmentRows() {
  return (await pool.query("SELECT to_jsonb(s) AS row FROM instagram_contact_segments s ORDER BY id")).rows;
}
// Waits until `count` sessions of this database wait on a lock, or until `settled` says the awaited request ended.
async function lockWaiters(count: number, settled: () => boolean = () => false) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const waiting = Number(
      (
        await pool.query(
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
        )
      ).rows[0].count,
    );
    if (waiting >= count || settled()) return;
    if (Date.now() > deadline) throw new Error(`expected ${count} lock waiters, saw ${waiting}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("segment edits replace the whole definition, increment the version and change what the segment evaluates", async () => {
  await fieldContact();
  const field = await createField("Edit score", "number");
  await fieldRequest("PUT", fieldValuePath(field.id), { value: 10 });
  const created = await createContactSegment(pool, a, { name: "Leads", connection_id: connectionId, tag: "lead" });
  assert.equal(created.version, 1);
  assert.deepEqual(await listContactSegments(pool, a), [created]);
  const query = new URLSearchParams({ segment_id: created.id });
  assert.equal((await listContacts(pool, a, query)).contacts.length, 0);
  const steps: [Record<string, unknown>, Record<string, unknown>][] = [
    [
      {
        name: " Scored ",
        connection_id: connectionId,
        tag: " Lead ",
        field_id: field.id,
        field_operator: "gte",
        field_value: 5,
        condition_operator: "or",
        last_comment_days: 30,
        consent_purpose: "marketing",
        consent_state: "no_record",
      },
      {
        name: "Scored",
        connection_id: connectionId,
        tag: "lead",
        field_id: field.id,
        field_operator: "gte",
        field_value: 5,
        condition_operator: "or",
        last_comment_days: 30,
        consent_purpose: "marketing",
        consent_state: "no_record",
      },
    ],
    [
      {
        name: "Window",
        field_id: field.id,
        field_operator: "is_set",
        last_comment_from: "2000-01-01T00:00:00.000Z",
        last_comment_before: "2100-01-01T00:00:00.000Z",
      },
      {
        name: "Window",
        connection_id: null,
        tag: null,
        field_id: field.id,
        field_operator: "is_set",
        last_comment_from: "2000-01-01T00:00:00.000Z",
        last_comment_before: "2100-01-01T00:00:00.000Z",
      },
    ],
    // Omitted optional keys remove those conditions.
    [{ name: "Everyone" }, { name: "Everyone", connection_id: null, tag: null }],
  ];
  let version = 1;
  for (const [body, expected] of steps) {
    const response = await fieldRequest("PUT", segmentPath(created.id), { ...body, expected_version: version });
    assert.equal(response.status, 200);
    version++;
    const saved = await response.json();
    assert.deepEqual(saved, { id: created.id, ...expected, version });
    assert.deepEqual(await listContactSegments(pool, a), [saved]);
    // The next contact read uses the stored definition.
    assert.equal((await listContacts(pool, a, query)).contacts.length, 1);
  }
  const stored = (
    await pool.query(
      "SELECT connection_id,tag,field_id,field_operator,field_value,condition_operator,last_comment_from,last_comment_before,last_comment_days,consent_purpose,consent_state,version,archived FROM instagram_contact_segments",
    )
  ).rows;
  assert.deepEqual(stored, [
    {
      connection_id: null,
      tag: null,
      field_id: null,
      field_operator: null,
      field_value: null,
      condition_operator: "and",
      last_comment_from: null,
      last_comment_before: null,
      last_comment_days: null,
      consent_purpose: null,
      consent_state: null,
      version: 4,
      archived: false,
    },
  ]);
  // An unchanged definition, even in another spelling, writes nothing and keeps the version.
  const renamed = await fieldRequest("PUT", segmentPath(created.id), {
    name: "Scored",
    connection_id: connectionId,
    tag: "lead",
    expected_version: 4,
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).version, 5);
  const before = await segmentRows();
  const unchanged = await fieldRequest("PUT", segmentPath(created.id), {
    name: " Scored ",
    connection_id: connectionId,
    tag: " LEAD ",
    condition_operator: "and",
    last_comment_days: null,
    expected_version: 5,
  });
  assert.equal(unchanged.status, 200);
  assert.deepEqual(await unchanged.json(), {
    id: created.id,
    name: "Scored",
    connection_id: connectionId,
    tag: "lead",
    version: 5,
  });
  assert.deepEqual(await segmentRows(), before);
  assert.equal((await listContacts(pool, a, query)).contacts.length, 0);
  await saveContactTags(pool, a, connectionId, "sender", { tags: ["lead"] });
  assert.equal((await listContacts(pool, a, query)).contacts.length, 1);
  // The jsonb value, the timestamps and the day count compare as unchanged too, not only the text columns.
  let current = 5;
  for (const definition of [
    {
      name: "Full",
      connection_id: connectionId,
      tag: "lead",
      field_id: field.id,
      field_operator: "gte",
      field_value: 5,
      condition_operator: "or",
      last_comment_days: 30,
      consent_purpose: "marketing",
      consent_state: "granted",
    },
    {
      name: "Fixed",
      field_id: field.id,
      field_operator: "eq",
      field_value: 10,
      last_comment_from: "2000-01-01T00:00:00.000Z",
      last_comment_before: "2100-01-01T00:00:00.000Z",
    },
  ]) {
    const changed = await fieldRequest("PUT", segmentPath(created.id), { ...definition, expected_version: current });
    assert.equal(changed.status, 200);
    current++;
    assert.equal((await changed.json()).version, current);
    const rows = await segmentRows();
    const same = await fieldRequest("PUT", segmentPath(created.id), { ...definition, expected_version: current });
    assert.equal(same.status, 200);
    assert.equal((await same.json()).version, current);
    assert.deepEqual(await segmentRows(), rows);
  }
});

test("stale, archived, missing and foreign segment edits write nothing", async () => {
  const segment = await createContactSegment(pool, a, { name: "Original" });
  const edited = await (
    await fieldRequest("PUT", segmentPath(segment.id), { name: "Edited", tag: "vip", expected_version: 1 })
  ).json();
  assert.equal(edited.version, 2);
  const before = await segmentRows();
  const stale = await fieldRequest("PUT", segmentPath(segment.id), { name: "Overwrite", expected_version: 1 });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "segment_conflict", segment: edited });
  const foreign = await fieldRequest("PUT", segmentPath(segment.id), { name: "Foreign", expected_version: 2 }, b);
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), { error: "segment_not_found" });
  const missing = await fieldRequest("PUT", segmentPath(randomUUID()), { name: "Missing", expected_version: 1 });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "segment_not_found" });
  assert.deepEqual(await segmentRows(), before);
  await archiveContactSegment(pool, a, segment.id);
  const archivedRows = await segmentRows();
  const archived = await fieldRequest("PUT", segmentPath(segment.id), { name: "Revived", expected_version: 2 });
  assert.equal(archived.status, 404);
  assert.deepEqual(await archived.json(), { error: "segment_not_found" });
  assert.deepEqual(await segmentRows(), archivedRows);
});

test("segment edits keep active names unique, need an active admin and refuse foreign references", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const first = await createContactSegment(pool, a, { name: "First" });
  const second = await createContactSegment(pool, a, { name: "Second" });
  const old = await createContactSegment(pool, a, { name: "Old" });
  await archiveContactSegment(pool, a, old.id);
  const taken = await fieldRequest("PUT", segmentPath(second.id), { name: " First ", expected_version: 1 });
  assert.equal(taken.status, 409);
  assert.deepEqual(await taken.json(), { error: "segment_name_exists" });
  const reused = await fieldRequest("PUT", segmentPath(second.id), { name: "Old", expected_version: 1 });
  assert.equal(reused.status, 200);
  assert.equal((await reused.json()).name, "Old");
  const agent = { id: "55555555-5555-4555-8555-555555555555", email: "agent@example.test" };
  const removed = { id: "66666666-6666-4666-8666-666666666666", email: "removed@example.test" };
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role,removed_at,removed_by) VALUES($1,$2,'agent',NULL,NULL),($1,$3,'admin',now(),$4)",
    [workspace, agent.id, removed.id, a.id],
  );
  const before = await segmentRows();
  for (const [user, code] of [
    [agent, "role_forbidden"],
    [removed, "workspace_required"],
  ] as const) {
    const response = await fieldRequest("PUT", segmentPath(first.id), { name: "Takeover", expected_version: 1 }, user);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: code });
  }
  const archivedField = await createField("Archived edit field", "text");
  assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${archivedField.id}`)).status, 200);
  const foreignField = await createField("Foreign edit field", "text").then(async (field) => {
    await pool.query("UPDATE instagram_contact_fields SET workspace_id=$1 WHERE id=$2", [
      await ensureWorkspace(pool, b),
      field.id,
    ]);
    return field;
  });
  const foreignConnection = "88888888-8888-4888-8888-888888888888";
  await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,'foreign-edit')", [
    foreignConnection,
    await ensureWorkspace(pool, b),
  ]);
  for (const [body, code] of [
    [{ field_id: archivedField.id, field_operator: "is_set" }, "field_not_found"],
    [{ field_id: foreignField.id, field_operator: "is_set" }, "field_not_found"],
    [{ connection_id: foreignConnection }, "connection_not_found"],
  ] as const) {
    const response = await fieldRequest("PUT", segmentPath(first.id), { name: "First", ...body, expected_version: 1 });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: code });
  }
  assert.deepEqual(await segmentRows(), before);
});

test("an edit that adds a field holds it, so a concurrent field archive waits and answers field_in_use", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Race edit field", "text");
  const segment = await createContactSegment(pool, a, { name: "Race edit" });
  const other = "99999999-9999-4999-8999-999999999999";
  await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,'race-edit')", [
    other,
    workspace,
  ]);
  // The blocker holds the new connection, so the edit's foreign-key check waits after it locked the field.
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM instagram_connections WHERE id=$1 FOR UPDATE", [other]);
    const edit = fieldRequest("PUT", segmentPath(segment.id), {
      name: "Race edit",
      connection_id: other,
      field_id: field.id,
      field_operator: "is_set",
      expected_version: 1,
    });
    await lockWaiters(1);
    let archiveSettled = false;
    const archive = fieldRequest("DELETE", `/api/contact-fields/${field.id}`).finally(() => {
      archiveSettled = true;
    });
    await lockWaiters(2, () => archiveSettled);
    await blocker.query("COMMIT");
    const [edited, archived] = await Promise.all([edit, archive]);
    assert.equal(edited.status, 200);
    assert.equal(archived.status, 409);
    assert.deepEqual(await archived.json(), { error: "field_in_use" });
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  assert.equal(
    (await pool.query("SELECT archived FROM instagram_contact_fields WHERE id=$1", [field.id])).rows[0].archived,
    false,
  );
  assert.equal((await listContactSegments(pool, a))[0]?.field_id, field.id);
});

test("a field archive that commits before the edit reads the field makes the edit answer field_not_found", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Archived first", "text");
  const segment = await createContactSegment(pool, a, { name: "Archive first" });
  const before = await segmentRows();
  // The blocker holds the workspace row, so the edit waits at its first lock while the archive commits.
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspace]);
    const edit = fieldRequest("PUT", segmentPath(segment.id), {
      name: "Archive first",
      field_id: field.id,
      field_operator: "is_set",
      expected_version: 1,
    });
    await lockWaiters(1);
    assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${field.id}`)).status, 200);
    await blocker.query("COMMIT");
    const edited = await edit;
    assert.equal(edited.status, 404);
    assert.deepEqual(await edited.json(), { error: "field_not_found" });
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  assert.deepEqual(await segmentRows(), before);
});

test("two edits of the same version store exactly one and refuse the other with the current segment", async () => {
  const segment = await createContactSegment(pool, a, { name: "Contested" });
  const responses = await Promise.all(
    ["One", "Two"].map((name) => fieldRequest("PUT", segmentPath(segment.id), { name, expected_version: 1 })),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const winner = await responses.find((response) => response.status === 200)!.json();
  assert.equal(winner.version, 2);
  assert.deepEqual(await responses.find((response) => response.status === 409)!.json(), {
    error: "segment_conflict",
    segment: winner,
  });
  assert.deepEqual(await listContactSegments(pool, a), [winner]);
  // The function returns the conflict instead of throwing, for the route to answer 409.
  const direct = await updateContactSegment(pool, a, segment.id, { name: "Three", expected_version: 1 });
  assert.deepEqual(direct, { conflict: true, segment: winner });
});

test("segment version migration starts existing rows at 1 and enforces a positive version on replay", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE instagram_contact_segments DROP COLUMN version");
    await client.query("INSERT INTO instagram_contact_segments(workspace_id,name) VALUES($1,'Legacy')", [workspace]);
    const migration = await readFile(new URL("../../db/migrations/054_segment_version.sql", import.meta.url), "utf8");
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual((await client.query("SELECT name,version FROM instagram_contact_segments")).rows, [
      { name: "Legacy", version: 1 },
    ]);
    await client.query("UPDATE instagram_contact_segments SET version=3");
    await client.query(migration);
    assert.equal((await client.query("SELECT version FROM instagram_contact_segments")).rows[0].version, 3);
    for (const change of ["version=0", "version=NULL"]) {
      await client.query("SAVEPOINT invalid_version");
      await assert.rejects(
        client.query(`UPDATE instagram_contact_segments SET ${change}`),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          ["23514", "23502"].includes(String(error.code)),
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_version");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("tag field operator migration defaults existing filters to AND and preserves OR on replay", async () => {
  const field = await createField("Migration score", "number");
  const workspace = await ensureWorkspace(pool, a);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE instagram_contact_segments DROP COLUMN condition_operator");
    await client.query(
      "INSERT INTO instagram_contact_segments(workspace_id,name,tag,field_id,field_operator,field_value) VALUES($1,'Legacy','lead',$2,'gte','0'::jsonb)",
      [workspace, field.id],
    );
    const migration = await readFile(
      new URL("../../db/migrations/037_tag_field_condition_operator.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual(
      (await client.query("SELECT name,tag,field_value,condition_operator FROM instagram_contact_segments")).rows,
      [{ name: "Legacy", tag: "lead", field_value: 0, condition_operator: "and" }],
    );
    await client.query("UPDATE instagram_contact_segments SET condition_operator='or'");
    await client.query(migration);
    assert.equal(
      (await client.query("SELECT condition_operator FROM instagram_contact_segments")).rows[0].condition_operator,
      "or",
    );
    for (const change of [
      "condition_operator='xor'",
      "tag=NULL",
      "field_id=NULL,field_operator=NULL,field_value=NULL",
    ]) {
      await client.query("SAVEPOINT invalid_operator");
      await assert.rejects(
        client.query(`UPDATE instagram_contact_segments SET ${change}`),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514",
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_operator");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("segment migration upgrades and replays while retaining saved filters", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Snapshots (061) and campaign drafts (063) depend on segments; remove them only in this rolled-back migration fixture.
    await client.query(
      "DROP TABLE campaign_drafts,instagram_segment_snapshot_members,instagram_segment_snapshots,instagram_contact_segments",
    );
    const migration = await readFile(new URL("../../db/migrations/009_contact_segments.sql", import.meta.url), "utf8");
    await client.query(migration);
    await client.query(
      "INSERT INTO instagram_contact_segments(workspace_id,name,tag) SELECT workspace_id,'saved','lead' FROM instagram_connections WHERE id=$1",
      [connectionId],
    );
    await client.query(migration);
    assert.deepEqual((await client.query("SELECT name,tag,archived FROM instagram_contact_segments")).rows, [
      { name: "saved", tag: "lead", archived: false },
    ]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("field migration upgrades and replays without losing typed values and conditions", async () => {
  await pool.query("DROP TABLE instagram_contact_field_values,instagram_contact_fields CASCADE");
  const migration = await readFile(new URL("../../db/migrations/010_contact_fields.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await fieldContact();
  const field = await createField("Migrated", "boolean");
  await fieldRequest("PUT", fieldValuePath(field.id), { value: false });
  const segment = await (
    await fieldRequest("POST", "/api/contact-segments", {
      name: "Migration",
      field_id: field.id,
      field_operator: "eq",
      field_value: false,
    })
  ).json();
  await pool.query(migration);
  await pool.query(migration);
  assert.equal(
    (await listContacts(pool, a, new URLSearchParams({ segment_id: segment.id }))).contacts[0]!.fields[field.id],
    false,
  );
});

test("typed field conditions retain keyset pagination across fifty matching contacts", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Confirmed", "boolean");
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) SELECT $1,$2,'field-'||n,'media','field-sender-'||lpad(n::text,3,'0'),'private' FROM generate_series(1,51) n",
    [workspace, connectionId],
  );
  await pool.query(
    "INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) SELECT workspace_id,connection_id,sender_id,$3,'false'::jsonb FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=$2",
    [workspace, connectionId, field.id],
  );
  const query = new URLSearchParams({ field_id: field.id, field_operator: "eq", field_value: "false" });
  const first = await listContacts(pool, a, query);
  assert.equal(first.contacts.length, 50);
  assert.ok(first.after);
  query.set("after", first.after!);
  const second = await listContacts(pool, a, query);
  assert.equal(second.contacts.length, 1);
  assert.equal(second.contacts[0]!.sender_id, "field-sender-051");
  assert.equal(second.contacts[0]!.fields[field.id], false);
  assert.equal(second.after, null);
});

test("contact automation API stores only exact booleans for existing owned contacts", async () => {
  const workspace = (await pool.query("SELECT workspace_id FROM instagram_connections WHERE id=$1", [connectionId]))
    .rows[0].workspace_id;
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'automation-comment','media','sender/one% test','hello')",
    [workspace, connectionId],
  );
  const path = `/api/connections/${connectionId}/contacts/${encodeURIComponent("sender/one% test")}/automation`;
  const paused = await fieldRequest("PUT", path, { paused: true });
  assert.equal(paused.status, 200);
  assert.deepEqual(await paused.json(), { automation_paused: true });
  assert.equal((await listContacts(pool, a)).contacts[0]!.automation_paused, true);
  for (const body of [{ paused: "true" }, { paused: 1 }, { paused: null }, {}, { paused: false, extra: 1 }, []]) {
    assert.equal((await fieldRequest("PUT", path, body)).status, 400);
  }
  assert.equal((await fieldRequest("PUT", path, { paused: false }, b)).status, 404);
  assert.equal(
    (await fieldRequest("PUT", `/api/connections/${connectionId}/contacts/missing/automation`, { paused: true }))
      .status,
    404,
  );
  const resumed = await fieldRequest("PUT", path, { paused: false });
  assert.equal(resumed.status, 200);
  assert.deepEqual(await resumed.json(), { automation_paused: false });
  assert.equal((await listContacts(pool, a)).contacts[0]!.automation_paused, false);
  const migration = await readFile(new URL("../../db/migrations/011_contact_automation.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  assert.equal((await listContacts(pool, a)).contacts[0]!.automation_paused, false);
});

const manualPath = (suffix = "", recipient = "456", connection = connectionId) =>
  `/api/connections/${connection}/inbox/${recipient}/replies${suffix}`;
const manualBody = {
  request_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  text: "Manual answer",
  expected_handoff_version: 1,
};
const manualRequest = (method: string, suffix = "", body?: unknown, user = a, sendEnabled = "true") =>
  fieldRequest(method, manualPath(suffix), body, user, sendEnabled);
async function readyManual() {
  await readyHandoff();
  assert.equal((await setHandoff(true, 0)).status, 200);
  await pool.query("UPDATE instagram_connections SET send_enabled=true WHERE id=$1", [connectionId]);
}

async function scheduleLocal(minutes = 60) {
  return (
    await pool.query(
      `SELECT to_char((clock_timestamp()+$2::int*interval '1 minute') AT TIME ZONE w.time_zone,'YYYY-MM-DD"T"HH24:MI') AS local
       FROM workspaces w JOIN instagram_connections c ON c.workspace_id=w.id WHERE c.id=$1`,
      [connectionId, minutes],
    )
  ).rows[0].local as string;
}

test("scheduled manual reply preserves its instant and does not block a later immediate reply", async () => {
  const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  const body = { ...manualBody, expected_time_zone: "Asia/Seoul", schedule_local: await scheduleLocal() };
  const responses = await Promise.all([manualRequest("POST", "", body), manualRequest("POST", "", body)]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [202, 202],
  );
  const [first, duplicate] = await Promise.all(responses.map((r) => r.json()));
  assert.equal(first.id, duplicate.id);
  assert.equal(first.schedule_time_zone, "Asia/Seoul");
  assert.equal(first.schedule_version, 1);
  assert.ok(Date.parse(first.scheduled_at) > Date.now());
  await pool.query(
    "UPDATE workspaces SET time_zone='America/New_York' WHERE id=(SELECT workspace_id FROM instagram_connections WHERE id=$1)",
    [connectionId],
  );
  assert.equal((await (await manualRequest("POST", "", body)).json()).scheduled_at, first.scheduled_at);
  const changedZone = await manualRequest("POST", "", { ...body, request_key: randomUUID() });
  assert.equal(changedZone.status, 409);
  assert.equal((await changedZone.json()).error, "reply_schedule_timezone_changed");
  const sent: string[] = [];
  const transport = {
    verifyAccount: async () => true,
    send: async (_r: string, text: string) => {
      sent.push(text);
      return { messageId: "scheduled-test" };
    },
  };
  assert.equal(await processNextManualReply(pool, connectionId, transport, "encrypted-test"), false);
  assert.equal(
    (await manualRequest("POST", "", { ...manualBody, request_key: randomUUID(), text: "Immediate" })).status,
    202,
  );
  assert.equal(await processNextManualReply(pool, connectionId, transport, "encrypted-test"), true);
  assert.deepEqual(sent, ["Immediate"]);
  await pool.query("UPDATE instagram_manual_replies SET next_attempt_at=now()-interval '1 minute' WHERE id=$1", [
    first.id,
  ]);
  assert.equal(
    await processNextManualReply(pool, connectionId, transport, "encrypted-test"),
    false,
    "retry time cannot bypass the scheduled instant",
  );
  await pool.query("UPDATE instagram_manual_replies SET scheduled_at=now()-interval '1 minute' WHERE id=$1", [
    first.id,
  ]);
  assert.equal(await processNextManualReply(pool, connectionId, transport, "encrypted-test"), true);
  assert.deepEqual(sent, ["Immediate", manualBody.text]);
});

test("scheduled manual reply waits for a later bypassing unknown reply to be resolved", async () => {
  const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  const scheduled = await (
    await manualRequest("POST", "", {
      ...manualBody,
      expected_time_zone: "Asia/Seoul",
      schedule_local: await scheduleLocal(),
    })
  ).json();
  const immediate = await (
    await manualRequest("POST", "", { ...manualBody, request_key: randomUUID(), text: "Immediate" })
  ).json();
  const attempted: string[] = [];
  const transport = {
    verifyAccount: async () => true,
    send: async (_recipient: string, text: string) => {
      attempted.push(text);
      if (text === "Immediate") throw new Error("ambiguous provider response");
      return { messageId: "scheduled-after-resolution" };
    },
  };
  assert.equal(await processNextManualReply(pool, connectionId, transport, "encrypted-test"), true);
  assert.equal(
    (await pool.query("SELECT status FROM instagram_manual_replies WHERE id=$1", [immediate.id])).rows[0].status,
    "unknown",
  );
  await pool.query(
    "UPDATE instagram_manual_replies SET scheduled_at=now()-interval '1 minute',next_attempt_at=now()-interval '1 minute' WHERE id=$1",
    [scheduled.id],
  );
  assert.equal(await processNextManualReply(pool, connectionId, transport, "encrypted-test"), false);
  assert.deepEqual(attempted, ["Immediate"]);
  assert.equal(
    (
      await manualRequest("POST", `/${immediate.id}/resolution`, {
        request_key: randomUUID(),
        decision: "no_retry",
        reason: "Reviewed the ambiguous immediate send",
      })
    ).status,
    200,
  );
  assert.equal(await processNextManualReply(pool, connectionId, transport, "encrypted-test"), true);
  assert.deepEqual(attempted, ["Immediate", manualBody.text]);
});

test("scheduled manual reply rejects invalid wall times and times outside the current reply window", async () => {
  await readyManual();
  for (const schedule_local of [
    null,
    42,
    "",
    "2026-02-30T12:00",
    "2026-10-16T24:00",
    "2026-10-16T12:00Z",
    await scheduleLocal(0),
    await scheduleLocal(1441),
  ]) {
    assert.equal(
      (await manualRequest("POST", "", { ...manualBody, schedule_local, expected_time_zone: "Asia/Seoul" })).status,
      400,
      String(schedule_local),
    );
  }
  assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_replies")).rows[0].count, "0");
  const body = { ...manualBody, expected_time_zone: "Asia/Seoul", schedule_local: await scheduleLocal() };
  assert.equal((await manualRequest("POST", "", body, b)).status, 404);
  assert.equal((await manualRequest("POST", "", body, a, "false")).status, 409);
  await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '25 hours'");
  assert.equal((await manualRequest("POST", "", body)).status, 409);
});

test("scheduled manual reply changes are versioned idempotent scoped and cancelled without a send", async () => {
  const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  const reply = await (
    await manualRequest("POST", "", {
      ...manualBody,
      expected_time_zone: "Asia/Seoul",
      schedule_local: await scheduleLocal(),
    })
  ).json();
  const edit = {
    request_key: randomUUID(),
    expected_version: 1,
    text: "Revised",
    expected_time_zone: "Asia/Seoul",
    schedule_local: await scheduleLocal(90),
  };
  const agent = { id: "44444444-4444-4444-8444-444444444444", email: "agent@example.test" };
  await pool.query(
    "INSERT INTO workspace_members(user_id,workspace_id,role) SELECT $1,workspace_id,'agent' FROM instagram_connections WHERE id=$2",
    [agent.id, connectionId],
  );
  assert.equal((await manualRequest("PATCH", `/${reply.id}/schedule`, edit, agent)).status, 403);
  assert.equal((await manualRequest("PATCH", `/${reply.id}/schedule`, edit, b)).status, 404);
  const edited = await manualRequest("PATCH", `/${reply.id}/schedule`, edit);
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).schedule_version, 2);
  assert.equal((await manualRequest("PATCH", `/${reply.id}/schedule`, edit)).status, 200);
  assert.equal((await manualRequest("PATCH", `/${reply.id}/schedule`, { ...edit, text: "Key reuse" })).status, 409);
  assert.equal(
    (await manualRequest("PATCH", `/${reply.id}/schedule`, { ...edit, request_key: randomUUID() })).status,
    409,
  );
  const cancel = { request_key: randomUUID(), expected_version: 2 };
  await pool.query("UPDATE instagram_connections SET send_enabled=false WHERE id=$1", [connectionId]);
  const cancelled = await manualRequest("POST", `/${reply.id}/cancel`, cancel, a, "false");
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, "cancelled");
  assert.equal((await manualRequest("POST", `/${reply.id}/cancel`, cancel)).status, 200);
  assert.equal(
    (await manualRequest("PATCH", `/${reply.id}/schedule`, { ...edit, request_key: randomUUID(), expected_version: 3 }))
      .status,
    409,
  );
  assert.deepEqual(
    (await pool.query("SELECT kind FROM instagram_manual_reply_events ORDER BY created_at,id")).rows.map((r) => r.kind),
    ["queued", "rescheduled", "cancelled"],
  );
  assert.equal(
    await processNextManualReply(
      pool,
      connectionId,
      {
        verifyAccount: async () => {
          assert.fail("cancelled row verified");
        },
        send: async () => {
          assert.fail("cancelled row sent");
        },
      },
      "encrypted-test",
    ),
    false,
  );
  const history = await (await manualRequest("GET")).json();
  assert.equal(history.replies[0].schedule_version, 3);
  assert.equal(history.replies[0].events.at(-1).kind, "cancelled");
});

test("scheduled manual reply creation replay survives a later edit and cancellation", async () => {
  await readyManual();
  const original = { ...manualBody, schedule_local: await scheduleLocal(), expected_time_zone: "Asia/Seoul" };
  const created = await (await manualRequest("POST", "", original)).json();
  assert.equal(
    (
      await manualRequest("PATCH", `/${created.id}/schedule`, {
        request_key: randomUUID(),
        expected_version: 1,
        text: "Changed after acceptance",
        schedule_local: await scheduleLocal(10),
        expected_time_zone: "Asia/Seoul",
      })
    ).status,
    200,
  );
  const replay = await manualRequest("POST", "", original);
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).text, "Changed after acceptance");
  assert.equal((await manualRequest("POST", "", { ...original, text: "Changed after acceptance" })).status, 409);
  assert.equal(
    (await manualRequest("POST", `/${created.id}/cancel`, { request_key: randomUUID(), expected_version: 2 })).status,
    200,
  );
  await pool.query(
    "UPDATE workspaces SET time_zone='UTC' WHERE id=(SELECT workspace_id FROM instagram_connections WHERE id=$1)",
    [connectionId],
  );
  const cancelledReplay = await manualRequest("POST", "", original);
  assert.equal(cancelledReplay.status, 202);
  assert.equal((await cancelledReplay.json()).status, "cancelled");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_manual_replies")).rows[0].count, 1);
});

test("scheduled manual reply rechecks removed creators at the final provider guard", async () => {
  const { processNextManualReply, assertManualReplyAllowed } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  const creator = { id: "44444444-4444-4444-8444-444444444444", email: "creator@example.test" };
  await pool.query(
    "INSERT INTO workspace_members(user_id,workspace_id,role) SELECT $1,workspace_id,'agent' FROM instagram_connections WHERE id=$2",
    [creator.id, connectionId],
  );
  const response = await manualRequest(
    "POST",
    "",
    { ...manualBody, expected_time_zone: "Asia/Seoul", schedule_local: await scheduleLocal() },
    creator,
  );
  assert.equal(response.status, 202);
  const reply = await response.json();
  await pool.query(
    "UPDATE instagram_manual_replies SET scheduled_at=now()-interval '1 minute',next_attempt_at=now()-interval '1 minute' WHERE id=$1",
    [reply.id],
  );
  let posts = 0;
  assert.equal(
    await processNextManualReply(
      pool,
      connectionId,
      {
        verifyAccount: async () => true,
        async send(_recipient, _text, context) {
          await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [
            creator.id,
            a.id,
          ]);
          await assertManualReplyAllowed(pool, context!.replyId, context!.attemptId, connectionId, "encrypted-test");
          posts++;
          return { messageId: "must-not-send" };
        },
      },
      "encrypted-test",
    ),
    true,
  );
  assert.equal(posts, 0);
  assert.deepEqual(
    (await pool.query("SELECT status,failure_code FROM instagram_manual_replies WHERE id=$1", [reply.id])).rows[0],
    { status: "failed", failure_code: "scheduled_actor_unavailable" },
  );
  assert.equal(await processNextManualReply(pool, connectionId, null, "encrypted-test"), false);
});

test("scheduled manual reply claim prevents edit or cancellation while provider verification is in flight", async () => {
  const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  const reply = await (
    await manualRequest("POST", "", {
      ...manualBody,
      expected_time_zone: "Asia/Seoul",
      schedule_local: await scheduleLocal(),
    })
  ).json();
  await pool.query(
    "UPDATE instagram_manual_replies SET scheduled_at=now()-interval '1 minute',next_attempt_at=now()-interval '1 minute' WHERE id=$1",
    [reply.id],
  );
  let entered!: () => void, release!: () => void;
  const admission = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  const worker = processNextManualReply(
    pool,
    connectionId,
    {
      async verifyAccount() {
        entered();
        await gate;
        return true;
      },
      async send() {
        posts++;
        return { messageId: "already-claimed" };
      },
    },
    "encrypted-test",
  );
  try {
    assert.equal(await Promise.race([admission.then(() => true), worker.then(() => false)]), true);
    assert.equal(
      (await manualRequest("POST", `/${reply.id}/cancel`, { request_key: randomUUID(), expected_version: 1 })).status,
      409,
    );
    assert.equal(
      (
        await manualRequest("PATCH", `/${reply.id}/schedule`, {
          request_key: randomUUID(),
          expected_version: 1,
          text: "Changed",
          expected_time_zone: "Asia/Seoul",
          schedule_local: await scheduleLocal(),
        })
      ).status,
      409,
    );
  } finally {
    release();
    await worker;
  }
  assert.equal(posts, 1);
  assert.equal(
    (await pool.query("SELECT text FROM instagram_manual_replies WHERE id=$1", [reply.id])).rows[0].text,
    manualBody.text,
  );
});

for (const failureCode of ["reply_window_closed", "handoff_changed", "recipient_opted_out"]) {
  test(`scheduled manual reply blocks ${failureCode} after verification without a provider POST`, async () => {
    const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
    await readyManual();
    const response = await manualRequest("POST", "", {
      ...manualBody,
      expected_time_zone: "Asia/Seoul",
      schedule_local: await scheduleLocal(),
    });
    assert.equal(response.status, 202);
    const reply = await response.json();
    await pool.query(
      "UPDATE instagram_manual_replies SET scheduled_at=now()-interval '1 minute',next_attempt_at=now()-interval '1 minute' WHERE id=$1",
      [reply.id],
    );
    let posts = 0;
    await processNextManualReply(
      pool,
      connectionId,
      {
        async verifyAccount() {
          if (failureCode === "reply_window_closed")
            await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '25 hours'");
          else if (failureCode === "handoff_changed") assert.equal((await setHandoff(false, 1)).status, 200);
          else
            await recordChannelConsentEvent(pool, {
              requestKey: randomUUID(),
              workspaceId: await ensureWorkspace(pool, a),
              connectionId,
              channel: "instagram",
              identityKind: "dm_recipient",
              identityValue: "456",
              purpose: "service_reply",
              decision: "revoke",
              evidenceKind: "explicit",
              evidenceReference: "scheduled test opt-out",
              occurredAt: new Date(),
              actorId: a.id,
            });
          return true;
        },
        async send() {
          posts++;
          return { messageId: "must-not-send" };
        },
      },
      "encrypted-test",
    );
    assert.equal(posts, 0);
    assert.deepEqual(
      (await pool.query("SELECT status,failure_code FROM instagram_manual_replies WHERE id=$1", [reply.id])).rows[0],
      { status: "failed", failure_code: failureCode },
    );
    assert.equal(await processNextManualReply(pool, connectionId, null, "encrypted-test"), false);
  });
}

test("scheduled manual reply permits its creator and administrators and keeps valid agent permission", async () => {
  const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  const creator = { id: "44444444-4444-4444-8444-444444444444", email: "creator@example.test" };
  await pool.query(
    "INSERT INTO workspace_members(user_id,workspace_id,role) SELECT $1,workspace_id,'admin' FROM instagram_connections WHERE id=$2",
    [creator.id, connectionId],
  );
  const reply = await (
    await manualRequest(
      "POST",
      "",
      { ...manualBody, expected_time_zone: "Asia/Seoul", schedule_local: await scheduleLocal() },
      creator,
    )
  ).json();
  const body = {
    request_key: randomUUID(),
    expected_version: 1,
    text: "Creator edit",
    expected_time_zone: "Asia/Seoul",
    schedule_local: await scheduleLocal(90),
  };
  assert.equal((await manualRequest("PATCH", `/${reply.id}/schedule`, body, creator)).status, 200);
  assert.equal(
    (
      await manualRequest("PATCH", `/${reply.id}/schedule`, {
        ...body,
        request_key: randomUUID(),
        expected_version: 2,
        text: "Admin edit",
      })
    ).status,
    200,
  );
  await pool.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [creator.id]);
  await pool.query(
    "UPDATE instagram_manual_replies SET scheduled_at=now()-interval '1 minute',next_attempt_at=now()-interval '1 minute' WHERE id=$1",
    [reply.id],
  );
  let posts = 0;
  assert.equal(
    await processNextManualReply(
      pool,
      connectionId,
      {
        verifyAccount: async () => true,
        send: async (_recipient, text) => {
          posts++;
          assert.equal(text, "Admin edit");
          return { messageId: "agent-still-authorized" };
        },
      },
      "encrypted-test",
    ),
    true,
  );
  assert.equal(posts, 1);
});

test("scheduled manual reply edit and cancel race has one version winner", async () => {
  await readyManual();
  const reply = await (
    await manualRequest("POST", "", {
      ...manualBody,
      expected_time_zone: "Asia/Seoul",
      schedule_local: await scheduleLocal(),
    })
  ).json();
  const edit = {
    request_key: randomUUID(),
    expected_version: 1,
    text: "Concurrent edit",
    expected_time_zone: "Asia/Seoul",
    schedule_local: await scheduleLocal(90),
  };
  const results = await Promise.all([
    manualRequest("PATCH", `/${reply.id}/schedule`, edit),
    manualRequest("POST", `/${reply.id}/cancel`, { request_key: randomUUID(), expected_version: 1 }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await pool.query("SELECT schedule_version FROM instagram_manual_replies WHERE id=$1", [reply.id])).rows[0]
      .schedule_version,
    2,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM instagram_manual_reply_events WHERE reply_id=$1", [reply.id]))
      .rows[0].count,
    2,
  );
});

test("scheduled manual reply migration export and workspace deletion preserve the complete lifecycle", async () => {
  const { exportWorkspace } = await import("./workspace-export.ts");
  await readyManual();
  const reply = await (
    await manualRequest("POST", "", {
      ...manualBody,
      expected_time_zone: "Asia/Seoul",
      schedule_local: await scheduleLocal(),
    })
  ).json();
  assert.equal(
    (await manualRequest("POST", `/${reply.id}/cancel`, { request_key: randomUUID(), expected_version: 1 })).status,
    200,
  );
  const before = (await pool.query("SELECT * FROM instagram_manual_replies WHERE id=$1", [reply.id])).rows[0];
  const migration = await readFile(
    new URL("../../db/migrations/049_inbox_scheduled_replies.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);
  assert.deepEqual(
    (await pool.query("SELECT * FROM instagram_manual_replies WHERE id=$1", [reply.id])).rows[0],
    before,
  );
  const exported = JSON.parse((await exportWorkspace(pool, a)).body);
  assert.equal(exported.tables.instagram_manual_replies[0].status, "cancelled");
  assert.equal(exported.tables.instagram_manual_replies[0].schedule_time_zone, "Asia/Seoul");
  assert.ok(
    exported.tables.instagram_manual_reply_events.some((event: { kind: string }) => event.kind === "cancelled"),
  );
  const workspace = await ensureWorkspace(pool, a);
  await pool.query(
    "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
    [connectionId],
  );
  const deleted = (await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspace, a.id])).rows[0]
    .result;
  assert.equal(deleted.deleted_counts.instagram_manual_replies, 1);
  assert.equal(
    (
      await pool.query("SELECT count(*)::int AS count FROM instagram_manual_reply_events WHERE workspace_id=$1", [
        workspace,
      ])
    ).rows[0].count,
    0,
  );
});

test("manual reply capabilities describe support without overriding current eligibility", async () => {
  await readyManual();
  const path = `/api/connections/${connectionId}/inbox/456/reply-status`;
  for (const send of ["true", "false"]) {
    const result = await (await fieldRequest("GET", path, undefined, a, send)).json();
    assert.equal(result.channel, "instagram");
    assert.deepEqual(result.capabilities.operations.manual_reply, { supported: true, content_types: ["text"] });
    assert.equal(result.capabilities.templates.approved_message, false);
    assert.equal(result.allowed, send === "true");
  }
  await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '24 hours'");
  const expired = await (await fieldRequest("GET", path, undefined, a, "true")).json();
  assert.equal(expired.capabilities.operations.manual_reply.supported, true);
  assert.equal(expired.allowed, false);
  assert.equal(expired.failure_code, "reply_window_closed");
});

test("manual reply rejects unsupported content without enqueueing or accepting extra fields", async () => {
  await readyManual();
  let notifications = 0;
  const notify = async () => {
    notifications++;
  };
  for (const content_type of ["attachment", "provider_template"]) {
    const response = await fieldRequest("POST", manualPath(), { ...manualBody, content_type }, a, "true", notify);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, "channel_capability_unsupported");
    assert.equal((await manualRequest("POST", "", { ...manualBody, content_type }, b)).status, 404);
  }
  for (const extra of [
    { attachment_url: "https://example.test/image" },
    { content_type: "text", attachment_url: "https://example.test/image" },
    { content_type: "attachment", attachment_url: "https://example.test/image" },
    { content_type: "unknown" },
    { content_type: null },
    { content_type: 1 },
  ])
    assert.equal((await manualRequest("POST", "", { ...manualBody, ...extra })).status, 400);
  assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_replies")).rows[0].count, "0");
  assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_reply_events")).rows[0].count, "0");
  assert.equal(notifications, 0);
});

test("explicit text content is the same idempotent manual request as the old text shape", async () => {
  await readyManual();
  const first = await manualRequest("POST", "", { ...manualBody, content_type: "text" });
  assert.equal(first.status, 202);
  const reply = await first.json();
  const oldShape = await manualRequest("POST", "", manualBody);
  assert.equal(oldShape.status, 202);
  assert.equal((await oldShape.json()).id, reply.id);
  await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '25 hours'");
  const confirmed = await manualRequest("POST", "", { ...manualBody, content_type: "text" });
  assert.equal(confirmed.status, 202);
  assert.equal((await confirmed.json()).id, reply.id);
  assert.equal((await manualRequest("POST", "", { ...manualBody, content_type: "text", text: "changed" })).status, 409);
  assert.equal((await manualRequest("POST", "", { ...manualBody, content_type: "attachment" })).status, 422);
  assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_replies")).rows[0].count, "1");
  assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_reply_events")).rows[0].count, "1");
});

test("manual reply status reports the server window and current handoff without credentials", async () => {
  await readyManual();
  const path = `/api/connections/${connectionId}/inbox/456/reply-status`;
  const response = await fieldRequest("GET", path, undefined, a, "true");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.allowed, true);
  assert.equal(result.failure_code, null);
  assert.equal(result.handoff_active, true);
  assert.equal(result.handoff_version, 1);
  assert.ok(Date.parse(result.window_expires_at) > Date.parse(result.checked_at));
  assert.equal(JSON.stringify(result).includes("access_token"), false);
  assert.equal((await fieldRequest("GET", path, undefined, b)).status, 404);
  assert.equal((await fieldRequest("GET", `${path}?extra=1`)).status, 400);
  assert.equal((await fieldRequest("GET", path.replace("/456/", "/999/"))).status, 404);
});

test("manual reply status rejects disabled sending and expired windows without mutating delivery", async () => {
  await readyManual();
  const path = `/api/connections/${connectionId}/inbox/456/reply-status`;
  assert.equal(
    (await (await fieldRequest("GET", path, undefined, a, "false")).json()).failure_code,
    "global_send_disabled",
  );
  await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '24 hours'");
  const result = await (await fieldRequest("GET", path)).json();
  assert.equal(result.allowed, false);
  assert.equal(result.failure_code, "reply_window_closed");
  assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_replies")).rows[0].count, "0");
});

test("manual reply status reports the latest handoff version for the composer", async () => {
  await readyManual();
  assert.equal((await setHandoff(false, 1)).status, 200);
  const result = await (await fieldRequest("GET", `/api/connections/${connectionId}/inbox/456/reply-status`)).json();
  assert.equal(result.allowed, false);
  assert.equal(result.handoff_active, false);
  assert.equal(result.handoff_version, 2);
  assert.equal(result.failure_code, "handoff_changed");
});

test("manual reply status distinguishes an unresolved unknown from policy eligibility", async () => {
  await readyManual();
  const queued = await (await manualRequest("POST", "", manualBody)).json();
  await pool.query("UPDATE instagram_manual_replies SET status='unknown' WHERE id=$1", [queued.id]);
  const path = `/api/connections/${connectionId}/inbox/456/reply-status`;
  let status = await (await fieldRequest("GET", path, undefined, a, "true")).json();
  assert.equal(status.allowed, true);
  assert.equal(status.blocked_by_unknown, true);
  await manualRequest("POST", `/${queued.id}/resolution`, {
    request_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    decision: "no_retry",
    reason: "Verified in Instagram",
  });
  status = await (await fieldRequest("GET", path, undefined, a, "true")).json();
  assert.equal(status.blocked_by_unknown, false);
});

test("manual reply queues once for concurrent identical requests and rejects key payload reuse", async () => {
  await readyManual();
  const responses = await Promise.all([manualRequest("POST", "", manualBody), manualRequest("POST", "", manualBody)]);
  for (const response of responses) assert.equal(response.status, 202);
  const [first, second] = await Promise.all(responses.map((r) => r.json()));
  assert.equal(first.id, second.id);
  assert.equal(first.status, "pending");
  assert.equal((await manualRequest("POST", "", { ...manualBody, text: "Other" })).status, 409);
  await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '25 hours'");
  assert.equal((await manualRequest("POST", "", manualBody)).status, 202, "idempotent read survives expired window");
  assert.equal((await manualRequest("GET")).status, 200);
  assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_replies")).rows[0].count, "1");
  assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_reply_events")).rows[0].count, "1");
});

test("manual reply requires owned conversation current handoff and fresh inbound window", async () => {
  await readyManual();
  assert.equal((await manualRequest("POST", "", manualBody, b)).status, 404);
  assert.equal((await manualRequest("GET", "", undefined, b)).status, 404);
  assert.equal((await manualRequest("POST", "", manualBody, a, "false")).status, 409);
  assert.equal((await manualRequest("POST", "", { ...manualBody, expected_handoff_version: 3 })).status, 409);
  await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '24 hours'");
  assert.equal((await manualRequest("POST", "", manualBody)).status, 409);
  await pool.query("UPDATE instagram_inbox_messages SET message_at=now()+interval '1 hour'");
  assert.equal((await manualRequest("POST", "", manualBody)).status, 409);
  await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '1 second'");
  assert.equal((await setHandoff(false, 1)).status, 200);
  assert.equal((await manualRequest("POST", "", manualBody)).status, 409);
});

test("manual reply rejects invalid text keys extra fields and query parameters", async () => {
  await readyManual();
  for (const body of [
    { ...manualBody, text: " " },
    { ...manualBody, text: "x".repeat(1001) },
    { ...manualBody, request_key: "bad" },
    { ...manualBody, extra: 1 },
    { ...manualBody, expected_handoff_version: 0 },
  ])
    assert.equal((await manualRequest("POST", "", body)).status, 400);
  assert.equal((await manualRequest("POST", "?extra=1", manualBody)).status, 400);
  assert.equal((await manualRequest("GET", "?before=bad")).status, 400);
});

test("manual reply retry is explicit audited idempotent and forbids unknown outcomes", async () => {
  await readyManual();
  const initial = await manualRequest("POST", "", manualBody);
  assert.equal(initial.status, 202);
  const reply = await initial.json();
  await pool.query(
    "UPDATE instagram_manual_replies SET status='unknown',failure_code='worker_interrupted' WHERE id=$1",
    [reply.id],
  );
  const retry = {
    request_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    expected_handoff_version: 1,
    reason: "Retry definite rejection",
  };
  assert.equal((await manualRequest("POST", `/${reply.id}/retry`, retry)).status, 409);
  const decision = {
    request_key: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    decision: "no_retry",
    reason: "Provider result unavailable",
  };
  assert.equal((await manualRequest("POST", `/${reply.id}/resolution`, decision)).status, 200);
  assert.equal((await manualRequest("POST", `/${reply.id}/resolution`, decision)).status, 200);
  await pool.query(
    "UPDATE instagram_manual_replies SET status='failed',safe_to_retry=true,resolved_at=NULL,failure_code='meta_error_10' WHERE id=$1",
    [reply.id],
  );
  const responses = await Promise.all([
    manualRequest("POST", `/${reply.id}/retry`, retry),
    manualRequest("POST", `/${reply.id}/retry`, retry),
  ]);
  for (const response of responses) assert.equal(response.status, 202);
  const rows = await Promise.all(responses.map((r) => r.json()));
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(
    (
      await manualRequest("POST", `/${reply.id}/retry`, {
        ...retry,
        request_key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      })
    ).status,
    409,
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM instagram_manual_reply_events WHERE kind='no_retry'")).rows[0].count,
    "1",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM instagram_manual_reply_events WHERE kind='retry_requested'")).rows[0].count,
    "1",
  );
});

test("another workspace cannot retry, resolve or read the delivery state of a manual reply", async () => {
  await readyManual();
  const reply = await (await manualRequest("POST", "", manualBody)).json();
  const retry = {
    request_key: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    expected_handoff_version: 1,
    reason: "Foreign retry",
  };
  const decision = {
    request_key: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    decision: "no_retry",
    reason: "Foreign resolution",
  };
  await pool.query(
    "UPDATE instagram_manual_replies SET status='failed',safe_to_retry=true,failure_code='meta_error_10' WHERE id=$1",
    [reply.id],
  );
  assert.equal((await manualRequest("POST", `/${reply.id}/retry`, retry, b)).status, 404);
  await pool.query("UPDATE instagram_manual_replies SET status='unknown',safe_to_retry=false WHERE id=$1", [reply.id]);
  assert.equal((await manualRequest("POST", `/${reply.id}/resolution`, decision, b)).status, 404);
  assert.equal(
    (await fieldRequest("GET", `/api/connections/${connectionId}/inbox/456/reply-status`, undefined, b)).status,
    404,
  );
  const rows = await pool.query("SELECT status, resolved_at FROM instagram_manual_replies ORDER BY created_at");
  assert.deepEqual(rows.rows, [{ status: "unknown", resolved_at: null }]);
  assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_reply_events")).rows[0].count, "1");
});

test("manual reply worker serializes a conversation and preserves ambiguous outcomes until resolution", async () => {
  const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  for (const request_key of [manualBody.request_key, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])
    assert.equal((await manualRequest("POST", "", { ...manualBody, request_key })).status, 202);
  let entered!: () => void, release!: () => void;
  const admission = new Promise<void>((r) => (entered = r)),
    finish = new Promise<void>((r) => (release = r));
  let sends = 0;
  const transport = {
    async verifyAccount() {
      return true;
    },
    async send() {
      sends++;
      entered();
      await finish;
      throw new Error("ambiguous provider response");
    },
  };
  const first = processNextManualReply(pool, connectionId, transport, "encrypted-test");
  // A stub worker must fail before this wait, rather than hanging the red test.
  const admitted = await Promise.race([admission.then(() => true), first.then(() => false)]);
  assert.equal(admitted, true, "worker must admit oldest queued reply");
  assert.equal(await processNextManualReply(pool, connectionId, transport, "encrypted-test"), false);
  release();
  assert.equal(await first, true);
  assert.equal(sends, 1);
  assert.equal(await processNextManualReply(pool, connectionId, transport, "encrypted-test"), false);
  const unknown = (await pool.query("SELECT id,status FROM instagram_manual_replies ORDER BY created_at,id")).rows[0];
  assert.equal(unknown.status, "unknown");
  await manualRequest("POST", `/${unknown.id}/resolution`, {
    request_key: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    decision: "no_retry",
    reason: "Reviewed; no resend",
  });
  const { assertManualReplyAllowed } = await import("../instagram/manual-reply-worker.ts");
  assert.equal(
    await processNextManualReply(
      pool,
      connectionId,
      {
        async verifyAccount() {
          return true;
        },
        async send(_recipient, text, context) {
          await assertManualReplyAllowed(pool, context!.replyId, context!.attemptId, connectionId, "encrypted-test");
          assert.equal(text, "Manual answer");
          return { messageId: "manual-provider" };
        },
      },
      "encrypted-test",
    ),
    true,
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM instagram_manual_replies WHERE status='sent'")).rows[0].count,
    "1",
  );
});

test("manual reply worker records definite refusals safely and interrupted sends as unknown", async () => {
  const { processNextManualReply, recoverStaleManualReplies } = await import("../instagram/manual-reply-worker.ts");
  const { ProviderRejectedError } = await import("../instagram/reply-worker.ts");
  await readyManual();
  const response = await manualRequest("POST", "", manualBody);
  assert.equal(response.status, 202);
  const reply = await response.json();
  assert.equal(
    await processNextManualReply(
      pool,
      connectionId,
      {
        async verifyAccount() {
          return true;
        },
        async send() {
          throw new ProviderRejectedError(10);
        },
      },
      "encrypted-test",
    ),
    true,
  );
  let row = (
    await pool.query("SELECT status,safe_to_retry,failure_code FROM instagram_manual_replies WHERE id=$1", [reply.id])
  ).rows[0];
  assert.deepEqual(row, { status: "failed", safe_to_retry: true, failure_code: "meta_error_10" });
  await pool.query(
    "UPDATE instagram_manual_replies SET status='sending',safe_to_retry=false,attempt_id=gen_random_uuid(),attempt_started_at=now()-interval '11 minutes' WHERE id=$1",
    [reply.id],
  );
  await recoverStaleManualReplies(pool);
  row = (
    await pool.query("SELECT status,safe_to_retry,failure_code FROM instagram_manual_replies WHERE id=$1", [reply.id])
  ).rows[0];
  assert.deepEqual(row, { status: "unknown", safe_to_retry: false, failure_code: "worker_interrupted" });
});

test("manual reply final guard refuses handoff resume token change expired window and changed bridge before POST", async () => {
  const { processNextManualReply, assertManualReplyAllowed } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  for (const [index, change] of [
    async () => {
      await setHandoff(false, 1);
    },
    async () => {
      await pool.query("UPDATE instagram_connections SET access_token_encrypted='rotated' WHERE id=$1", [connectionId]);
    },
    async () => {
      await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '25 hours'");
    },
    async () => {
      await identityReply("999", "99999");
    },
  ].entries()) {
    if (index) {
      await pool.query(
        "TRUNCATE instagram_manual_reply_events,instagram_manual_replies; UPDATE instagram_connections SET access_token_encrypted='encrypted-test' WHERE id='33333333-3333-4333-8333-333333333333'; UPDATE instagram_inbox_messages SET message_at=now()-interval '1 second'; UPDATE private_reply_outbox SET status='failed' WHERE sender_id='999'",
      );
      if (index === 1) assert.equal((await setHandoff(true, 2)).status, 200);
    }
    const queued = await manualRequest("POST", "", { ...manualBody, expected_handoff_version: index ? 3 : 1 });
    assert.equal(queued.status, 202);
    let posts = 0;
    assert.equal(
      await processNextManualReply(
        pool,
        connectionId,
        {
          async verifyAccount() {
            return true;
          },
          async send(_r, _t, context) {
            await change();
            await assertManualReplyAllowed(pool, context!.replyId, context!.attemptId, connectionId, "encrypted-test");
            posts++;
            return { messageId: "must-not-send" };
          },
        },
        "encrypted-test",
      ),
      true,
    );
    assert.equal(posts, 0);
    assert.deepEqual(
      (await pool.query("SELECT status,safe_to_retry,failure_code FROM instagram_manual_replies")).rows[0],
      index === 1
        ? { status: "pending", safe_to_retry: false, failure_code: "token_rotated" }
        : {
            status: "failed",
            safe_to_retry: true,
            failure_code:
              index === 0 ? "handoff_changed" : index === 2 ? "reply_window_closed" : "handoff_identity_unverified",
          },
    );
  }
});

test("manual reply audit failure rolls back queue and delivery outcome together", async () => {
  await readyManual();
  await pool.query(
    `CREATE FUNCTION reject_manual_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_manual_audit BEFORE INSERT ON instagram_manual_reply_events FOR EACH ROW EXECUTE FUNCTION reject_manual_audit()`,
  );
  try {
    assert.equal((await manualRequest("POST", "", manualBody)).status, 503);
    assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_replies")).rows[0].count, "0");
  } finally {
    await pool.query(
      "DROP TRIGGER reject_manual_audit ON instagram_manual_reply_events; DROP FUNCTION reject_manual_audit()",
    );
  }
});

test("manual reply history keeps microsecond cursor boundaries and migration replay preserves audit", async () => {
  await readyManual();
  const created = await manualRequest("POST", "", manualBody);
  assert.equal(created.status, 202);
  const first = await created.json();
  await pool.query(
    `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,created_at)
    SELECT workspace_id,connection_id,recipient_id,gen_random_uuid(),created_by,'page',handoff_version,created_at+n*interval '1 microsecond' FROM instagram_manual_replies CROSS JOIN generate_series(1,51) n WHERE id=$1`,
    [first.id],
  );
  const page = await (await manualRequest("GET")).json();
  assert.equal(page.replies.length, 50);
  assert.ok(page.before);
  const next = await (await manualRequest("GET", `?before=${page.before}`)).json();
  assert.equal(next.replies.length, 2);
  assert.equal(new Set([...page.replies, ...next.replies].map((row) => row.id)).size, 52);
  const migration = await readFile(new URL("../../db/migrations/014_manual_replies.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_reply_events")).rows[0].count, "1");
});

test("manual reply verification failure defers without POST and nonfinite inbound is rejected", async () => {
  const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  await pool.query("UPDATE instagram_inbox_messages SET message_at='infinity'");
  assert.equal((await manualRequest("POST", "", manualBody)).status, 409);
  await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '1 second'");
  assert.equal((await manualRequest("POST", "", manualBody)).status, 202);
  let sends = 0;
  assert.equal(
    await processNextManualReply(
      pool,
      connectionId,
      {
        async verifyAccount() {
          throw new Error("temporary read failure");
        },
        async send() {
          sends++;
          return { messageId: "forbidden" };
        },
      },
      "encrypted-test",
    ),
    true,
  );
  assert.equal(sends, 0);
  const row = (
    await pool.query("SELECT status,failure_code,next_attempt_at>now() AS delayed FROM instagram_manual_replies")
  ).rows[0];
  assert.deepEqual(row, { status: "pending", failure_code: "verification_unavailable", delayed: true });
});

test("manual reply sent audit failure preserves claim for unknown recovery instead of resending", async () => {
  const { processNextManualReply, recoverStaleManualReplies } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  assert.equal((await manualRequest("POST", "", manualBody)).status, 202);
  await pool.query(
    `CREATE FUNCTION reject_sent_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$; CREATE TRIGGER reject_sent_audit BEFORE INSERT ON instagram_manual_reply_events FOR EACH ROW WHEN (NEW.kind='sent') EXECUTE FUNCTION reject_sent_audit()`,
  );
  let sends = 0;
  try {
    await assert.rejects(
      processNextManualReply(
        pool,
        connectionId,
        {
          async verifyAccount() {
            return true;
          },
          async send() {
            sends++;
            return { messageId: "acknowledged" };
          },
        },
        "encrypted-test",
      ),
      /audit unavailable/,
    );
    assert.equal((await pool.query("SELECT status FROM instagram_manual_replies")).rows[0].status, "sending");
    assert.equal(
      await processNextManualReply(
        pool,
        connectionId,
        {
          async verifyAccount() {
            return true;
          },
          async send() {
            sends++;
            return { messageId: "duplicate" };
          },
        },
        "encrypted-test",
      ),
      false,
    );
    assert.equal(sends, 1);
    await pool.query("UPDATE instagram_manual_replies SET attempt_started_at=now()-interval '11 minutes'");
    await recoverStaleManualReplies(pool);
    assert.equal((await pool.query("SELECT status FROM instagram_manual_replies")).rows[0].status, "unknown");
  } finally {
    await pool.query(
      "DROP TRIGGER reject_sent_audit ON instagram_manual_reply_events; DROP FUNCTION reject_sent_audit()",
    );
  }
});

test("manual reply skips a locked oldest row without claiming the next conversation row", async () => {
  const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  for (const request_key of [manualBody.request_key, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])
    assert.equal((await manualRequest("POST", "", { ...manualBody, request_key })).status, 202);
  const locker = await pool.connect();
  let sends = 0;
  try {
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM instagram_manual_replies ORDER BY created_at,id LIMIT 1 FOR UPDATE");
    assert.equal(
      await processNextManualReply(
        pool,
        connectionId,
        {
          async verifyAccount() {
            return true;
          },
          async send() {
            sends++;
            return { messageId: "forbidden" };
          },
        },
        "encrypted-test",
      ),
      false,
    );
    assert.equal(sends, 0);
  } finally {
    await locker.query("ROLLBACK");
    locker.release();
  }
});

test("manual reply policy expires before a failing verification read can defer the job", async () => {
  const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  assert.equal((await manualRequest("POST", "", manualBody)).status, 202);
  await pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '25 hours'");
  let reads = 0;
  await processNextManualReply(
    pool,
    connectionId,
    {
      async verifyAccount() {
        reads++;
        throw new Error("unavailable");
      },
      async send() {
        throw new Error("forbidden");
      },
    },
    "encrypted-test",
  );
  assert.equal(reads, 0);
  assert.equal((await pool.query("SELECT status FROM instagram_manual_replies")).rows[0].status, "failed");
});

test("manual reply defers a transient final guard refusal with no provider POST", async () => {
  const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
  const { PreSendVerificationError } = await import("../instagram/reply-worker.ts");
  await readyManual();
  assert.equal((await manualRequest("POST", "", manualBody)).status, 202);
  await processNextManualReply(
    pool,
    connectionId,
    {
      async verifyAccount() {
        return true;
      },
      async send() {
        throw new PreSendVerificationError("retry", "verification_unavailable");
      },
    },
    "encrypted-test",
  );
  assert.deepEqual(
    (await pool.query("SELECT status,failure_code,next_attempt_at>now() AS delayed FROM instagram_manual_replies"))
      .rows[0],
    { status: "pending", failure_code: "verification_unavailable", delayed: true },
  );
});

test("manual reply transient DB guard failure defers before even verifying the account", async () => {
  const { processNextManualReply } = await import("../instagram/manual-reply-worker.ts");
  await readyManual();
  assert.equal((await manualRequest("POST", "", manualBody)).status, 202);
  let once = true,
    reads = 0,
    sends = 0;
  const intermittent = {
    connect: pool.connect.bind(pool),
    query: async (sql: string, values?: unknown[]) => {
      if (once && sql.startsWith("SELECT r.workspace_id")) {
        once = false;
        throw new Error("database temporarily unavailable");
      }
      return pool.query(sql, values);
    },
  } as unknown as Pool;
  assert.equal(
    await processNextManualReply(
      intermittent,
      connectionId,
      {
        async verifyAccount() {
          reads++;
          return true;
        },
        async send() {
          sends++;
          return { messageId: "forbidden" };
        },
      },
      "encrypted-test",
    ),
    true,
  );
  assert.equal(reads, 0);
  assert.equal(sends, 0);
  assert.deepEqual(
    (await pool.query("SELECT status,failure_code,next_attempt_at>now() AS delayed FROM instagram_manual_replies"))
      .rows[0],
    { status: "pending", failure_code: "verification_unavailable", delayed: true },
  );
});

// Freeze only the database clock in the real aggregate for exact microsecond boundaries.
function relativeClock(asOf: string, source = pool): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("statement_timestamp()")) {
        assert.equal(sql.match(/statement_timestamp\(\)/g)?.length, 1, "one evaluation clock per lookup");
        return source.query(sql.replace("statement_timestamp()", `$${values.length + 1}::timestamptz`), [
          ...values,
          asOf,
        ]);
      }
      return source.query(sql, values);
    },
  } as unknown as Pool;
}

test("relative comment activity uses one half-open 24-hour window for counts, samples and latest-event semantics", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const asOf = "2026-03-09T04:00:00.000000Z";
  const rows = [
    ["cutoff", "2026-03-08T04:00:00.000000Z"],
    ["before", "2026-03-08T03:59:59.999999Z"],
    ["last", "2026-03-09T03:59:59.999999Z"],
    ["end", asOf],
    ["future", "2026-03-09T04:00:00.000001Z"],
    ["latest-outside", asOf],
    ["latest-outside", "2026-03-08T12:00:00.000000Z"],
  ];
  for (const [i, [sender, at]] of rows.entries())
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) VALUES($1,$2,$3,'media',$4,'private',$5)",
      [workspace, connectionId, `relative-${i}`, sender, at],
    );
  const q = new URLSearchParams({ last_comment_days: "1", preview: "true" });
  const clock = relativeClock(asOf);
  const result = await listContacts(clock, a, q);
  assert.equal(result.total, "2");
  assert.equal(result.evaluated, "6");
  assert.deepEqual(result.excluded, { activity: "4", tag: "0", field: "0", both: "0" });
  assert.deepEqual(
    result.contacts.map((c) => c.sender_id),
    ["cutoff", "last"],
  );
  assert.deepEqual((result as unknown as { activity_window: unknown }).activity_window, {
    from: "2026-03-08T04:00:00.000000Z",
    before: asOf,
  });
  q.delete("preview");
  assert.deepEqual((await listContacts(clock, a, q)).contacts, result.contacts);
  const later = await listContacts(relativeClock("2026-03-10T04:00:00.000002Z"), a, q);
  assert.equal(later.contacts.length, 0);
  assert.ok((later as unknown as { activity_window: unknown }).activity_window);
  const foreign = await listContacts(clock, b, new URLSearchParams({ last_comment_days: "1", preview: "true" }));
  assert.equal(foreign.evaluated, "0");
  assert.equal(foreign.total, "0");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'America/New_York'");
    const dst = await listContacts(relativeClock(asOf, { query: client.query.bind(client) } as unknown as Pool), a, q);
    assert.deepEqual(dst.contacts, result.contacts);
    assert.deepEqual(
      (dst as unknown as { activity_window: unknown }).activity_window,
      (result as unknown as { activity_window: unknown }).activity_window,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("relative comment activity saves days, preserves old shapes, validates input and enforces database constraints", async () => {
  const created = await fieldRequest("POST", "/api/contact-segments", { name: "Recent", last_comment_days: 7 });
  assert.equal(created.status, 201);
  const saved = await created.json();
  assert.equal(saved.last_comment_days, 7);
  assert.equal("last_comment_from" in saved, false);
  assert.deepEqual(
    (await listContactSegments(pool, a)).find((s) => s.id === saved.id),
    saved,
  );
  const liveBefore = Date.now();
  const response = await fieldRequest("GET", `/api/contacts?preview=true&segment_id=${saved.id}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, "0");
  assert.match(body.activity_window.before, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  assert.ok(
    Date.parse(body.activity_window.before) >= liveBefore && Date.parse(body.activity_window.before) <= Date.now(),
  );
  assert.equal(Date.parse(body.activity_window.before) - Date.parse(body.activity_window.from), 7 * 86400000);
  const next = await (await fieldRequest("GET", `/api/contacts?segment_id=${saved.id}`)).json();
  assert.ok(next.activity_window.before > body.activity_window.before, "each request evaluates a new clock");
  assert.equal(Date.parse(next.activity_window.before) - Date.parse(next.activity_window.from), 7 * 86400000);
  assert.equal((await fieldRequest("GET", `/api/contacts?segment_id=${saved.id}&last_comment_days=7`)).status, 400);
  assert.equal((await fieldRequest("GET", `/api/contacts?segment_id=${saved.id}`, undefined, b)).status, 404);
  for (const days of [0, -1, 367, 1.5, "7", true, {}, []])
    assert.equal(
      (await fieldRequest("POST", "/api/contact-segments", { name: "Bad", last_comment_days: days })).status,
      400,
    );
  for (const days of ["", "0", "-1", "367", "1.5", "1e1", "01", " 1", "NaN", "true"])
    assert.equal(
      (await fieldRequest("GET", `/api/contacts?last_comment_days=${encodeURIComponent(days)}`)).status,
      400,
    );
  const fixed = { last_comment_from: "2026-10-01T00:00:00.000Z", last_comment_before: "2026-10-02T00:00:00.000Z" };
  assert.equal(
    (await fieldRequest("POST", "/api/contact-segments", { name: "Mixed", last_comment_days: 7, ...fixed })).status,
    400,
  );
  assert.equal(
    (await fieldRequest("GET", `/api/contacts?${new URLSearchParams({ last_comment_days: "7", ...fixed })}`)).status,
    400,
  );
  assert.equal((await fieldRequest("GET", "/api/contacts?last_comment_days=7&last_comment_days=8")).status, 400);
  const legacy = await createContactSegment(pool, a, { name: "Legacy", last_comment_days: null });
  assert.equal("last_comment_days" in legacy, false);
  const ordinary = await listContacts(pool, a);
  assert.equal("activity_window" in ordinary, false);
  const bounded = await createContactSegment(pool, a, { name: "Fixed", ...fixed });
  assert.equal("last_comment_days" in bounded, false);
  for (const value of ["0", "367", "-1"])
    await assert.rejects(
      pool.query(`UPDATE instagram_contact_segments SET last_comment_days=${value} WHERE id=$1`, [saved.id]),
      { code: "23514" },
    );
  await assert.rejects(
    pool.query(
      "UPDATE instagram_contact_segments SET last_comment_from=now(),last_comment_before=now()+interval '1 hour' WHERE id=$1",
      [saved.id],
    ),
    { code: "23514" },
  );
  await archiveContactSegment(pool, a, saved.id);
  assert.equal((await fieldRequest("GET", `/api/contacts?segment_id=${saved.id}`)).status, 404);
});

test("relative comment activity combines with tag OR field and consent, and paginates without trimming history", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Score", "number");
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) SELECT $1,$2,n::text||'-'||r,'media',lpad(n::text,3,'0'),'private',CASE WHEN r=1 THEN '2020-01-01T00:00:00Z'::timestamptz ELSE '2026-10-15T12:00:00Z'::timestamptz END FROM generate_series(1,55)n CROSS JOIN generate_series(1,2)r",
    [workspace, connectionId],
  );
  const clock = relativeClock("2026-10-16T00:00:00.000000Z");
  const q = new URLSearchParams({ last_comment_days: "1" });
  const first = await listContacts(clock, a, q);
  assert.equal(first.contacts.length, 50);
  assert.ok(first.after);
  q.set("after", first.after);
  const second = await listContacts(clock, a, q);
  assert.equal(second.contacts.length, 5);
  assert.equal(second.after, null);
  assert.equal(new Set([...first.contacts, ...second.contacts].map((c) => c.sender_id)).size, 55);
  assert.ok(
    [...first.contacts, ...second.contacts].every(
      (c) => c.comment_count === "2" && c.first_comment_at.toISOString() === "2020-01-01T00:00:00.000Z",
    ),
  );
  await saveContactTags(pool, a, connectionId, "001", { tags: ["lead"] });
  await fieldRequest("PUT", fieldValuePath(field.id, "002"), { value: 1 });
  q.delete("after");
  q.set("preview", "true");
  q.set("tag", "lead");
  q.set("field_id", field.id);
  q.set("field_operator", "eq");
  q.set("field_value", "1");
  q.set("condition_operator", "or");
  q.set("consent_purpose", "marketing");
  q.set("consent_state", "no_record");
  const result = await listContacts(clock, a, q);
  assert.equal(result.total, "2");
  assert.equal(result.evaluated, "55");
  assert.deepEqual(result.excluded, { activity: "0", consent: "0", tag: "0", field: "0", both: "53" });
  q.set("consent_state", "granted");
  const excluded = await listContacts(clock, a, q);
  assert.equal(excluded.total, "0");
  assert.deepEqual(excluded.excluded, { activity: "0", consent: "55", tag: "0", field: "0", both: "0" });
});

test("relative comment activity migration preserves legacy windows and can be applied repeatedly", async () => {
  const fixed = await createContactSegment(pool, a, {
    name: "Fixed migration",
    last_comment_from: "2026-10-01T00:00:00.000Z",
    last_comment_before: "2026-10-02T00:00:00.000Z",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE instagram_contact_segments DROP COLUMN last_comment_days");
    const migration = await readFile(
      new URL("../../db/migrations/053_segment_relative_activity.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    assert.equal(
      (await client.query("SELECT last_comment_days FROM instagram_contact_segments WHERE id=$1", [fixed.id])).rows[0]
        .last_comment_days,
      null,
    );
    await client.query(
      "UPDATE instagram_contact_segments SET last_comment_from=NULL,last_comment_before=NULL,last_comment_days=366 WHERE id=$1",
      [fixed.id],
    );
    await client.query(migration);
    assert.equal(
      (await client.query("SELECT last_comment_days FROM instagram_contact_segments WHERE id=$1", [fixed.id])).rows[0]
        .last_comment_days,
      366,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

type CalendarWindow = { from: string; before: string; time_zone: string };
const calendarWindowOf = (result: unknown) => (result as { activity_window?: CalendarWindow }).activity_window;
async function replaceComments(workspace: string, rows: [string, string][], connection = connectionId) {
  await pool.query("DELETE FROM instagram_comment_events WHERE workspace_id=$1", [workspace]);
  for (const [i, [sender, at]] of rows.entries())
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) VALUES($1,$2,$3,'media',$4,'private',$5)",
      [workspace, connection, `calendar-${i}`, sender, at],
    );
}
// The microsecond before an exact UTC instant written as YYYY-MM-DDTHH:MM:SS.000000Z.
function microBefore(at: string) {
  const ms = Date.parse(at.slice(0, -4) + "Z") - 1;
  return new Date(ms).toISOString().slice(0, -1) + "999Z";
}
// Checks the four edge contacts of one period: at from and just before before are in; just before from and at before are out.
async function assertCalendarEdges(
  workspace: string,
  asOf: string,
  period: string,
  expected: CalendarWindow,
  db: Pool = pool,
) {
  await replaceComments(workspace, [
    ["a-from", expected.from],
    ["b-before-from", microBefore(expected.from)],
    ["c-last", microBefore(expected.before)],
    ["d-at-before", expected.before],
  ]);
  const q = new URLSearchParams({ last_comment_period: period, preview: "true" });
  const preview = await listContacts(relativeClock(asOf, db), a, q);
  assert.equal(preview.total, "2", period);
  assert.equal(preview.evaluated, "4", period);
  assert.deepEqual(preview.excluded, { activity: "2", tag: "0", field: "0", both: "0" }, period);
  assert.deepEqual(
    preview.contacts.map((c) => c.sender_id),
    ["a-from", "c-last"],
    period,
  );
  assert.deepEqual(calendarWindowOf(preview), expected, period);
  q.delete("preview");
  const list = await listContacts(relativeClock(asOf, db), a, q);
  assert.deepEqual(list.contacts, preview.contacts, period);
  assert.deepEqual(calendarWindowOf(list), expected, period);
}

test("calendar comment activity uses half-open periods of the workspace time zone from one statement clock", async () => {
  const workspace = await ensureWorkspace(pool, a);
  // 12:00 on 2026-10-17 in Asia/Seoul, the default workspace time zone.
  const asOf = "2026-10-17T03:00:00.000000Z";
  const periods: [string, string, string][] = [
    ["today", "2026-10-16T15:00:00.000000Z", "2026-10-17T15:00:00.000000Z"],
    ["yesterday", "2026-10-15T15:00:00.000000Z", "2026-10-16T15:00:00.000000Z"],
    ["this_month", "2026-09-30T15:00:00.000000Z", "2026-10-31T15:00:00.000000Z"],
    ["last_month", "2026-08-31T15:00:00.000000Z", "2026-09-30T15:00:00.000000Z"],
  ];
  for (const [period, from, before] of periods)
    await assertCalendarEdges(workspace, asOf, period, { from, before, time_zone: "Asia/Seoul" });
  // The session time zone takes no part: the local date comes from the workspace time zone only.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'America/New_York'");
    const session = { query: client.query.bind(client) } as unknown as Pool;
    for (const [period, from, before] of periods)
      await assertCalendarEdges(workspace, asOf, period, { from, before, time_zone: "Asia/Seoul" }, session);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  // Empty results keep the window, and the other workspace evaluates nothing of this one.
  await replaceComments(workspace, []);
  const empty = await listContacts(relativeClock(asOf), a, new URLSearchParams({ last_comment_period: "today" }));
  assert.deepEqual(empty.contacts, []);
  assert.deepEqual(calendarWindowOf(empty), {
    from: periods[0]![1],
    before: periods[0]![2],
    time_zone: "Asia/Seoul",
  });
  await replaceComments(workspace, [["sender", "2026-10-17T01:00:00.000000Z"]]);
  const foreign = await listContacts(
    relativeClock(asOf),
    b,
    new URLSearchParams({ last_comment_period: "today", preview: "true" }),
  );
  assert.equal(foreign.evaluated, "0");
  assert.equal(foreign.total, "0");
  // An agent of the workspace reads the same result.
  const agent = { id: randomUUID(), email: "agent@example.test" };
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'agent')", [
    workspace,
    agent.id,
  ]);
  const read = await listContacts(
    relativeClock(asOf),
    agent,
    new URLSearchParams({ last_comment_period: "today", preview: "true" }),
  );
  assert.equal(read.total, "1");
  assert.deepEqual(
    read.contacts.map((c) => c.sender_id),
    ["sender"],
  );
  // Requests without a calendar period keep their old response shape.
  assert.equal("activity_window" in (await listContacts(relativeClock(asOf), a)), false);
  const days = await listContacts(relativeClock(asOf), a, new URLSearchParams({ last_comment_days: "1" }));
  assert.deepEqual(calendarWindowOf(days), { from: "2026-10-16T03:00:00.000000Z", before: asOf });
});

test("calendar comment activity follows the workspace time zone, including a later change", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const asOf = "2026-10-17T03:00:00.000000Z";
  // 08:00Z on 10-16 is 17:00 in Seoul (yesterday there) and 01:00 in Los Angeles (today there);
  // 08:00Z on 10-17 is 17:00 in Seoul (today there) and 01:00 on 10-17 in Los Angeles, after its as_of date.
  await replaceComments(workspace, [
    ["la-today", "2026-10-16T08:00:00.000000Z"],
    ["seoul-today", "2026-10-17T08:00:00.000000Z"],
  ]);
  const q = new URLSearchParams({ last_comment_period: "today", preview: "true" });
  const seoul = await listContacts(relativeClock(asOf), a, q);
  assert.deepEqual(
    seoul.contacts.map((c) => c.sender_id),
    ["seoul-today"],
  );
  assert.deepEqual(calendarWindowOf(seoul), {
    from: "2026-10-16T15:00:00.000000Z",
    before: "2026-10-17T15:00:00.000000Z",
    time_zone: "Asia/Seoul",
  });
  await pool.query("UPDATE workspaces SET time_zone='America/Los_Angeles' WHERE id=$1", [workspace]);
  const la = await listContacts(relativeClock(asOf), a, q);
  assert.deepEqual(
    la.contacts.map((c) => c.sender_id),
    ["la-today"],
  );
  assert.deepEqual(calendarWindowOf(la), {
    from: "2026-10-16T07:00:00.000000Z",
    before: "2026-10-17T07:00:00.000000Z",
    time_zone: "America/Los_Angeles",
  });
  assert.deepEqual(la.excluded, { activity: "1", tag: "0", field: "0", both: "0" });
});

test("calendar comment activity crosses month and year ends", async () => {
  const workspace = await ensureWorkspace(pool, a);
  // 09:30 on 2027-01-01 in Seoul: this month is January and last month is December of the previous year.
  await assertCalendarEdges(workspace, "2027-01-01T00:30:00.000000Z", "this_month", {
    from: "2026-12-31T15:00:00.000000Z",
    before: "2027-01-31T15:00:00.000000Z",
    time_zone: "Asia/Seoul",
  });
  await assertCalendarEdges(workspace, "2027-01-01T00:30:00.000000Z", "last_month", {
    from: "2026-11-30T15:00:00.000000Z",
    before: "2026-12-31T15:00:00.000000Z",
    time_zone: "Asia/Seoul",
  });
  await assertCalendarEdges(workspace, "2027-01-01T00:30:00.000000Z", "yesterday", {
    from: "2026-12-30T15:00:00.000000Z",
    before: "2026-12-31T15:00:00.000000Z",
    time_zone: "Asia/Seoul",
  });
  // The last microsecond of 2026 in Seoul is still December.
  await assertCalendarEdges(workspace, "2026-12-31T14:59:59.999999Z", "this_month", {
    from: "2026-11-30T15:00:00.000000Z",
    before: "2026-12-31T15:00:00.000000Z",
    time_zone: "Asia/Seoul",
  });
  await assertCalendarEdges(workspace, "2026-12-31T14:59:59.999999Z", "today", {
    from: "2026-12-30T15:00:00.000000Z",
    before: "2026-12-31T15:00:00.000000Z",
    time_zone: "Asia/Seoul",
  });
  await pool.query("UPDATE workspaces SET time_zone='UTC' WHERE id=$1", [workspace]);
  await assertCalendarEdges(workspace, "2026-03-01T00:00:00.000000Z", "last_month", {
    from: "2026-02-01T00:00:00.000000Z",
    before: "2026-03-01T00:00:00.000000Z",
    time_zone: "UTC",
  });
  await assertCalendarEdges(workspace, "2026-03-01T00:00:00.000000Z", "yesterday", {
    from: "2026-02-28T00:00:00.000000Z",
    before: "2026-03-01T00:00:00.000000Z",
    time_zone: "UTC",
  });
});

test("calendar comment activity takes PostgreSQL's daylight-saving rule for a missing midnight and a 25-hour day", async () => {
  const workspace = await ensureWorkspace(pool, a);
  // America/Santiago moves from -04 to -03 at local midnight on 2026-09-06, so 00:00 does not exist that day.
  // PostgreSQL gives a nonexistent local time the offset before the change: 00:00 reads as 00:00-04, 04:00Z,
  // which is the day's first instant (01:00-03). The day has 23 hours.
  await pool.query("UPDATE workspaces SET time_zone='America/Santiago' WHERE id=$1", [workspace]);
  const santiago = "2026-09-06T12:00:00.000000Z";
  await assertCalendarEdges(workspace, santiago, "today", {
    from: "2026-09-06T04:00:00.000000Z",
    before: "2026-09-07T03:00:00.000000Z",
    time_zone: "America/Santiago",
  });
  await assertCalendarEdges(workspace, santiago, "yesterday", {
    from: "2026-09-05T04:00:00.000000Z",
    before: "2026-09-06T04:00:00.000000Z",
    time_zone: "America/Santiago",
  });
  await assertCalendarEdges(workspace, santiago, "this_month", {
    from: "2026-09-01T04:00:00.000000Z",
    before: "2026-10-01T03:00:00.000000Z",
    time_zone: "America/Santiago",
  });
  // America/Los_Angeles repeats 01:00-02:00 on 2026-11-01; midnight is unambiguous and the day has 25 hours.
  await pool.query("UPDATE workspaces SET time_zone='America/Los_Angeles' WHERE id=$1", [workspace]);
  await assertCalendarEdges(workspace, "2026-11-01T20:00:00.000000Z", "today", {
    from: "2026-11-01T07:00:00.000000Z",
    before: "2026-11-02T08:00:00.000000Z",
    time_zone: "America/Los_Angeles",
  });
});

test("calendar comment activity judges the latest stored comment and keeps the exclusion order", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const asOf = "2026-10-17T03:00:00.000000Z";
  await replaceComments(workspace, [
    // An older comment inside today with a newer one after it does not match.
    ["a-latest-outside", "2026-10-17T01:00:00.000000Z"],
    ["a-latest-outside", "2026-10-17T15:00:00.000000Z"],
    // An older comment before today with a newer one inside it matches.
    ["b-latest-inside", "2026-10-01T00:00:00.000000Z"],
    ["b-latest-inside", "2026-10-17T02:00:00.000000Z"],
    ["c-inside", "2026-10-17T02:30:00.000000Z"],
  ]);
  await saveContactTags(pool, a, connectionId, "b-latest-inside", { tags: ["lead"] });
  const q = new URLSearchParams({ last_comment_period: "today", preview: "true", tag: "lead" });
  const result = await listContacts(relativeClock(asOf), a, q);
  assert.equal(result.total, "1");
  assert.equal(result.evaluated, "3");
  assert.deepEqual(result.excluded, { activity: "1", tag: "1", field: "0", both: "0" });
  assert.deepEqual(
    result.contacts.map((c) => [c.sender_id, c.comment_count, c.first_comment_at.toISOString()]),
    [["b-latest-inside", "2", "2026-10-01T00:00:00.000Z"]],
  );
  q.set("consent_purpose", "marketing");
  q.set("consent_state", "granted");
  const consent = await listContacts(relativeClock(asOf), a, q);
  assert.equal(consent.total, "0");
  assert.deepEqual(consent.excluded, { activity: "1", consent: "2", tag: "0", field: "0", both: "0" });
});

test("calendar comment activity saves, edits and evaluates segments and enforces one activity form in the database", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const created = await fieldRequest("POST", "/api/contact-segments", { name: "Today", last_comment_period: "today" });
  assert.equal(created.status, 201);
  const saved = await created.json();
  assert.deepEqual(saved, {
    id: saved.id,
    name: "Today",
    connection_id: null,
    tag: null,
    last_comment_period: "today",
    version: 1,
  });
  assert.deepEqual(
    (await listContactSegments(pool, a)).find((s) => s.id === saved.id),
    saved,
  );
  const commented = new Date();
  await replaceComments(workspace, [["sender", commented.toISOString()]]);
  const path = `/api/contacts?preview=true&segment_id=${saved.id}`;
  const liveBefore = Date.now();
  const live = await (await fieldRequest("GET", path)).json();
  const liveAfter = Date.now();
  // Near Seoul midnight the comment can fall into the previous day; the count follows the returned window.
  const inside =
    commented.getTime() >= Date.parse(live.activity_window.from) &&
    commented.getTime() < Date.parse(live.activity_window.before);
  assert.equal(live.total, inside ? "1" : "0");
  assert.equal(live.activity_window.time_zone, "Asia/Seoul");
  assert.match(live.activity_window.from, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  // A Seoul day starts at 15:00Z, lasts 24 hours and contains an instant of the request.
  assert.match(live.activity_window.from, /T15:00:00\.000000Z$/);
  assert.equal(Date.parse(live.activity_window.before) - Date.parse(live.activity_window.from), 86400000);
  assert.ok(Date.parse(live.activity_window.from) <= liveAfter && Date.parse(live.activity_window.before) > liveBefore);
  // A later time zone change applies to the next evaluation of the saved period.
  await pool.query("UPDATE workspaces SET time_zone='America/Los_Angeles' WHERE id=$1", [workspace]);
  const moved = await (await fieldRequest("GET", `/api/contacts?segment_id=${saved.id}`)).json();
  assert.equal(moved.activity_window.time_zone, "America/Los_Angeles");
  await pool.query("UPDATE workspaces SET time_zone='Asia/Seoul' WHERE id=$1", [workspace]);
  assert.equal((await fieldRequest("GET", `${path}&last_comment_period=today`)).status, 400);
  assert.equal((await fieldRequest("GET", path, undefined, b)).status, 404);
  // Edit replaces the period, keeps it on an unchanged definition, and removes it when omitted.
  const edited = await fieldRequest("PUT", segmentPath(saved.id), {
    name: "Last month",
    last_comment_period: "last_month",
    expected_version: 1,
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(await edited.json(), {
    id: saved.id,
    name: "Last month",
    connection_id: null,
    tag: null,
    last_comment_period: "last_month",
    version: 2,
  });
  const same = await fieldRequest("PUT", segmentPath(saved.id), {
    name: "Last month",
    last_comment_period: "last_month",
    expected_version: 2,
  });
  assert.equal((await same.json()).version, 2);
  const lastMonth = await (await fieldRequest("GET", path)).json();
  assert.equal(lastMonth.total, "0");
  assert.deepEqual(lastMonth.excluded, { activity: "1", tag: "0", field: "0", both: "0" });
  const relative = await fieldRequest("PUT", segmentPath(saved.id), {
    name: "Last month",
    last_comment_days: 7,
    expected_version: 2,
  });
  const relativeSaved = await relative.json();
  assert.equal(relativeSaved.last_comment_days, 7);
  assert.equal("last_comment_period" in relativeSaved, false);
  assert.equal("time_zone" in (await (await fieldRequest("GET", path)).json()).activity_window, false);
  const back = await fieldRequest("PUT", segmentPath(saved.id), {
    name: "Last month",
    last_comment_period: "yesterday",
    expected_version: 3,
  });
  assert.equal((await back.json()).last_comment_period, "yesterday");
  const fixed = { last_comment_from: "2026-10-01T00:00:00.000Z", last_comment_before: "2026-10-02T00:00:00.000Z" };
  for (const body of [
    { name: "Mixed", last_comment_period: "today", last_comment_days: 7 },
    { name: "Mixed", last_comment_period: "today", ...fixed },
    { name: "Mixed", last_comment_period: "this_week" },
  ])
    assert.equal((await fieldRequest("POST", "/api/contact-segments", body)).status, 400);
  // Legacy segments and the other forms omit the key.
  const legacy = await createContactSegment(pool, a, { name: "Legacy", last_comment_period: null });
  assert.equal("last_comment_period" in legacy, false);
  const bounded = await createContactSegment(pool, a, { name: "Fixed", ...fixed });
  assert.equal("last_comment_period" in bounded, false);
  // The CHECK allows no form or exactly one of the three.
  for (const sql of [
    "UPDATE instagram_contact_segments SET last_comment_period='this_week' WHERE id=$1",
    "UPDATE instagram_contact_segments SET last_comment_days=7 WHERE id=$1",
    "UPDATE instagram_contact_segments SET last_comment_from=now(),last_comment_before=now()+interval '1 hour' WHERE id=$1",
  ])
    await assert.rejects(pool.query(sql, [saved.id]), { code: "23514", constraint: "contact_segment_calendar_period" });
  await assert.rejects(
    pool.query("UPDATE instagram_contact_segments SET last_comment_period='today' WHERE id=$1", [bounded.id]),
    { code: "23514", constraint: "contact_segment_calendar_period" },
  );
  await archiveContactSegment(pool, a, saved.id);
  assert.equal((await fieldRequest("GET", path)).status, 404);
});

test("calendar period migration adds the column and its check and can be applied repeatedly", async () => {
  const relative = await createContactSegment(pool, a, { name: "Relative migration", last_comment_days: 7 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE instagram_contact_segments DROP COLUMN last_comment_period");
    const migration = await readFile(
      new URL("../../db/migrations/055_segment_calendar_period.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    assert.equal(
      (await client.query("SELECT last_comment_period FROM instagram_contact_segments WHERE id=$1", [relative.id]))
        .rows[0].last_comment_period,
      null,
    );
    await client.query(
      "UPDATE instagram_contact_segments SET last_comment_days=NULL,last_comment_period='last_month' WHERE id=$1",
      [relative.id],
    );
    await client.query(migration);
    assert.equal(
      (await client.query("SELECT last_comment_period FROM instagram_contact_segments WHERE id=$1", [relative.id]))
        .rows[0].last_comment_period,
      "last_month",
    );
    await assert.rejects(
      client.query("UPDATE instagram_contact_segments SET last_comment_days=1 WHERE id=$1", [relative.id]),
      { code: "23514", constraint: "contact_segment_calendar_period" },
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

// Contacts for the tag-set tests: no tag row, an empty tag row, and none, one, some or all of a, b and c.
async function multiTagContacts() {
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Multi tag score", "number");
  for (const [sender, tags, value] of [
    ["all", ["a", "b", "c"], 10],
    ["empty", [], -1],
    ["none", null, 10],
    ["one", ["a"], 10],
    ["other", ["x"], null],
    ["some", ["b", "c"], -1],
  ] as const) {
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,$3,'media',$3,'private')",
      [workspace, connectionId, sender],
    );
    if (tags) await saveContactTags(pool, a, connectionId, sender, { tags });
    if (value !== null)
      assert.equal((await fieldRequest("PUT", fieldValuePath(field.id, sender), { value })).status, 200);
  }
  assert.equal(
    (await pool.query("SELECT count(*) FROM instagram_contact_tags WHERE sender_id='none'")).rows[0].count,
    "0",
  );
  return { workspace, field };
}
// The list and the preview of one query select the same contacts, and the preview partitions the rest.
async function assertTagSet(
  query: URLSearchParams,
  expected: string[],
  excluded: { tag: string; field: string; both: string },
  user = a,
) {
  const label = query.toString();
  const list = await listContacts(pool, user, query);
  assert.deepEqual(
    list.contacts.map((c) => c.sender_id),
    expected,
    label,
  );
  const preview = await listContacts(pool, user, new URLSearchParams([...query, ["preview", "true"]]));
  assert.deepEqual(
    preview.contacts.map((c) => c.sender_id),
    expected,
    label,
  );
  assert.equal(preview.total, String(expected.length), label);
  assert.equal(preview.evaluated, "6", label);
  assert.deepEqual(preview.excluded, excluded, label);
}

test("tag sets match all or any of their tags, alone and on either side of a field AND/OR", async () => {
  const { field } = await multiTagContacts();
  const tags = (mode: string | null, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams([["tag", "C"], ["tag", " a "], ["tag", "b"], ...Object.entries(extra)]);
    if (mode) query.set("tag_mode", mode);
    return query;
  };
  // A contact without a tag row and one with an empty row both have no tags.
  await assertTagSet(tags(null), ["all"], { tag: "5", field: "0", both: "0" });
  await assertTagSet(tags("all"), ["all"], { tag: "5", field: "0", both: "0" });
  await assertTagSet(tags("any"), ["all", "one", "some"], { tag: "3", field: "0", both: "0" });
  // A set that collapses to one tag is the single-tag condition, whatever the mode.
  const collapsed = new URLSearchParams([
    ["tag", "A"],
    ["tag", "a"],
    ["tag_mode", "any"],
  ]);
  await assertTagSet(collapsed, ["all", "one"], { tag: "4", field: "0", both: "0" });
  await assertTagSet(new URLSearchParams({ tag: "a" }), ["all", "one"], { tag: "4", field: "0", both: "0" });
  const scored = { field_id: field.id, field_operator: "gte", field_value: "0" };
  // Field matches: all, none, one.
  await assertTagSet(tags("all", scored), ["all"], { tag: "2", field: "0", both: "3" });
  await assertTagSet(tags("all", { ...scored, condition_operator: "or" }), ["all", "none", "one"], {
    tag: "0",
    field: "0",
    both: "3",
  });
  await assertTagSet(tags("any", scored), ["all", "one"], { tag: "1", field: "1", both: "2" });
  await assertTagSet(tags("any", { ...scored, condition_operator: "or" }), ["all", "none", "one", "some"], {
    tag: "0",
    field: "0",
    both: "2",
  });
  // The other workspace evaluates none of these contacts.
  const foreign = await listContacts(pool, b, new URLSearchParams([...tags("any"), ["preview", "true"]]));
  assert.equal(foreign.evaluated, "0");
  assert.deepEqual(foreign.contacts, []);
  // The HTTP route reads the repeated key the same way and refuses a sixth tag.
  const response = await fieldRequest("GET", `/api/contacts?${tags("any")}`);
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).contacts.map((c: { sender_id: string }) => c.sender_id),
    ["all", "one", "some"],
  );
  const six = await fieldRequest("GET", "/api/contacts?tag=a&tag=b&tag=c&tag=d&tag=e&tag=f");
  assert.equal(six.status, 400);
  assert.deepEqual(await six.json(), { error: "invalid_contact_tags" });
});

test("multi-tag segments store sorted sets, keep legacy single tags and evaluate like the matching query", async () => {
  const { field } = await multiTagContacts();
  const created = await fieldRequest("POST", "/api/contact-segments", {
    name: "Any of three",
    tags: ["C", " b", "a", "A"],
    tag_mode: "any",
  });
  assert.equal(created.status, 201);
  const segment = await created.json();
  assert.deepEqual(segment, {
    id: segment.id,
    name: "Any of three",
    connection_id: null,
    tags: ["a", "b", "c"],
    tag_mode: "any",
    version: 1,
  });
  assert.deepEqual(
    (await listContactSegments(pool, a)).find((s) => s.id === segment.id),
    segment,
  );
  assert.deepEqual(
    (await pool.query("SELECT tag,tags,tag_mode FROM instagram_contact_segments WHERE id=$1", [segment.id])).rows[0],
    { tag: null, tags: ["a", "b", "c"], tag_mode: "any" },
  );
  const bySegment = new URLSearchParams({ segment_id: segment.id });
  await assertTagSet(bySegment, ["all", "one", "some"], { tag: "3", field: "0", both: "0" });
  for (const mixed of ["tag=a", "tag_mode=any", "tag=a&tag=b"])
    assert.equal((await fieldRequest("GET", `/api/contacts?${bySegment}&${mixed}`)).status, 400, mixed);
  assert.equal((await fieldRequest("GET", `/api/contacts?${bySegment}`, undefined, b)).status, 404);
  // The same set in another order and spelling is an unchanged definition and keeps the version.
  const same = await updateContactSegment(pool, a, segment.id, {
    name: "Any of three",
    tags: ["b", "a", "C"],
    tag_mode: "any",
    expected_version: 1,
  });
  assert.deepEqual(same, { conflict: false, segment });
  // Changing only the mode is a change.
  const allOf = await updateContactSegment(pool, a, segment.id, {
    name: "Any of three",
    tags: ["a", "b", "c"],
    tag_mode: "all",
    expected_version: 1,
  });
  assert.deepEqual(allOf.segment, { ...segment, tag_mode: "all", version: 2 });
  await assertTagSet(bySegment, ["all"], { tag: "5", field: "0", both: "0" });
  // A set that collapses to one tag is stored and returned as the legacy tag.
  const single = await updateContactSegment(pool, a, segment.id, {
    name: "Any of three",
    tags: ["A", "a"],
    tag_mode: "any",
    expected_version: 2,
  });
  assert.deepEqual(single.segment, {
    id: segment.id,
    name: "Any of three",
    connection_id: null,
    tag: "a",
    version: 3,
  });
  assert.deepEqual(
    (await pool.query("SELECT tag,tags,tag_mode FROM instagram_contact_segments WHERE id=$1", [segment.id])).rows[0],
    { tag: "a", tags: null, tag_mode: null },
  );
  // The legacy tag form of the same single tag is unchanged too.
  const legacySame = await updateContactSegment(pool, a, segment.id, {
    name: "Any of three",
    tag: "A",
    expected_version: 3,
  });
  assert.equal(legacySame.segment.version, 3);
  // A multi-tag OR with a field condition passes the updated condition_operator CHECK.
  const either = await updateContactSegment(pool, a, segment.id, {
    name: "Any of three",
    tags: ["b", "c"],
    tag_mode: "all",
    field_id: field.id,
    field_operator: "gte",
    field_value: 0,
    condition_operator: "or",
    expected_version: 3,
  });
  assert.deepEqual(either.segment, {
    id: segment.id,
    name: "Any of three",
    connection_id: null,
    tags: ["b", "c"],
    tag_mode: "all",
    condition_operator: "or",
    field_id: field.id,
    field_operator: "gte",
    field_value: 0,
    version: 4,
  });
  await assertTagSet(bySegment, ["all", "none", "one", "some"], { tag: "0", field: "0", both: "2" });
  // Legacy one-tag segments keep their shape.
  const legacy = await createContactSegment(pool, a, { name: "Legacy", tag: " A " });
  assert.deepEqual(legacy, { id: legacy.id, name: "Legacy", connection_id: null, tag: "a", version: 1 });
  const collapsed = await createContactSegment(pool, a, { name: "Collapsed", tags: ["a", "A"], tag_mode: "any" });
  assert.deepEqual(collapsed, { id: collapsed.id, name: "Collapsed", connection_id: null, tag: "a", version: 1 });
  assert.equal(
    (await fieldRequest("POST", "/api/contact-segments", { name: "Both", tag: "a", tags: ["b", "c"] })).status,
    400,
  );
  // The other workspace can neither read nor edit the segment.
  await assert.rejects(
    updateContactSegment(pool, b, segment.id, { name: "Foreign", tags: ["a", "b"], expected_version: 4 }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  assert.equal(
    (await listContactSegments(pool, b)).some((s) => s.id === segment.id),
    false,
  );
  await archiveContactSegment(pool, a, segment.id);
  assert.equal((await fieldRequest("GET", `/api/contacts?${bySegment}`)).status, 404);
});

test("the multi-tag CHECK refuses malformed sets written directly", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Check score", "number");
  const insert = (columns: string) =>
    pool.query(
      `INSERT INTO instagram_contact_segments(workspace_id,name,tag,tags,tag_mode) SELECT $1,'Direct',${columns}`,
      [workspace],
    );
  const valid = await insert("NULL,ARRAY['a','b','c','d','e'],'any' RETURNING id");
  await pool.query("UPDATE instagram_contact_segments SET archived=true WHERE id=$1", [valid.rows[0].id]);
  for (const columns of [
    "NULL,ARRAY['a'],'all'",
    "NULL,ARRAY['a','b','c','d','e','f'],'all'",
    "NULL,ARRAY['a',NULL],'all'",
    "NULL,ARRAY['a',''],'all'",
    `NULL,ARRAY['a','${"x".repeat(41)}'],'all'`,
    "NULL,ARRAY['a','b'],'none'",
    "NULL,ARRAY['a','b'],NULL",
    "NULL,NULL,'all'",
    "'a',ARRAY['b','c'],'all'",
    "NULL,'{}'::text[],'all'",
    "NULL,ARRAY[['a','b'],['c','d']],'all'",
    "NULL,'[0:1]={a,b}'::text[],'all'",
  ])
    await assert.rejects(insert(columns), { code: "23514", constraint: "contact_segment_multi_tag" }, columns);
  // OR still needs a tag condition and a field condition, and a tag set counts as one.
  await assert.rejects(
    pool.query(
      "INSERT INTO instagram_contact_segments(workspace_id,name,field_id,field_operator,condition_operator) VALUES($1,'No tag','" +
        field.id +
        "','is_set','or')",
      [workspace],
    ),
    { code: "23514", constraint: "contact_segment_condition_operator" },
  );
  await pool.query(
    "INSERT INTO instagram_contact_segments(workspace_id,name,tags,tag_mode,field_id,field_operator,condition_operator) VALUES($1,'Set or field',ARRAY['a','b'],'any',$2,'is_set','or')",
    [workspace, field.id],
  );
});

test("multi-tag migration adds the columns and checks, keeps legacy rows and can be applied repeatedly", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Migration multi tag", "number");
  const legacy = await createContactSegment(pool, a, {
    name: "Legacy or",
    tag: "lead",
    field_id: field.id,
    field_operator: "is_set",
    condition_operator: "or",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE instagram_contact_segments DROP COLUMN tags, DROP COLUMN tag_mode");
    // Dropping tags also dropped the condition_operator CHECK that reads it; the migration restores both.
    assert.deepEqual(
      (
        await client.query(
          "SELECT conname FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname IN ('contact_segment_multi_tag','contact_segment_condition_operator')",
        )
      ).rows,
      [],
    );
    const migration = await readFile(new URL("../../db/migrations/056_segment_multi_tag.sql", import.meta.url), "utf8");
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual(
      (
        await client.query(
          "SELECT conname FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname IN ('contact_segment_multi_tag','contact_segment_condition_operator') ORDER BY conname",
        )
      ).rows.map((row) => row.conname),
      ["contact_segment_condition_operator", "contact_segment_multi_tag"],
    );
    assert.deepEqual(
      (
        await client.query("SELECT tag,tags,tag_mode,condition_operator FROM instagram_contact_segments WHERE id=$1", [
          legacy.id,
        ])
      ).rows[0],
      { tag: "lead", tags: null, tag_mode: null, condition_operator: "or" },
    );
    await client.query(
      "UPDATE instagram_contact_segments SET tag=NULL,tags=ARRAY['a','b'],tag_mode='all' WHERE id=$1",
      [legacy.id],
    );
    await client.query(migration);
    assert.deepEqual(
      (await client.query("SELECT tag,tags,tag_mode FROM instagram_contact_segments WHERE id=$1", [legacy.id])).rows[0],
      { tag: null, tags: ["a", "b"], tag_mode: "all" },
    );
    for (const [change, constraint] of [
      ["tags=ARRAY['a']", "contact_segment_multi_tag"],
      ["tag='lead'", "contact_segment_multi_tag"],
      ["tags=NULL,tag_mode=NULL", "contact_segment_condition_operator"],
    ]) {
      await client.query("SAVEPOINT invalid_multi_tag");
      await assert.rejects(client.query(`UPDATE instagram_contact_segments SET ${change} WHERE id=$1`, [legacy.id]), {
        code: "23514",
        constraint,
      });
      await client.query("ROLLBACK TO SAVEPOINT invalid_multi_tag");
    }
    assert.ok(workspace);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

// Contacts for the field-set tests, with text, number, date and boolean fields and none, some or all values set.
async function multiFieldContacts() {
  const workspace = await ensureWorkspace(pool, a);
  const plan = await createField("Set plan", "text");
  const score = await createField("Set score", "number");
  const joined = await createField("Set joined", "date");
  const vip = await createField("Set vip", "boolean");
  for (const [sender, tags, values] of [
    ["all", ["lead"], { [plan.id]: "pro", [score.id]: 10, [joined.id]: "2026-01-01", [vip.id]: true }],
    ["empty", ["lead", "x"], {}],
    ["none", null, { [plan.id]: "free", [score.id]: 1, [joined.id]: "2026-12-31" }],
    ["some", ["vip"], { [plan.id]: "pro", [score.id]: 1, [vip.id]: false }],
  ] as const) {
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,$3,'media',$3,'private')",
      [workspace, connectionId, sender],
    );
    if (tags) await saveContactTags(pool, a, connectionId, sender, { tags });
    for (const [id, value] of Object.entries(values))
      assert.equal((await fieldRequest("PUT", fieldValuePath(id, sender), { value })).status, 200);
  }
  // T: all, some. N: all. D: all. B: all. S: all, none. U: none, empty.
  const conditions = {
    T: { field_id: plan.id, field_operator: "eq", field_value: "pro" },
    N: { field_id: score.id, field_operator: "gt", field_value: 5 },
    D: { field_id: joined.id, field_operator: "lte", field_value: "2026-06-30" },
    B: { field_id: vip.id, field_operator: "eq", field_value: true },
    S: { field_id: joined.id, field_operator: "is_set" },
    U: { field_id: vip.id, field_operator: "is_unset" },
  };
  return { workspace, fields: { plan, score, joined, vip }, conditions };
}
const fieldSetQuery = (conditions: object[], mode: string | null, extra: [string, string][] = []) => {
  const query = new URLSearchParams([["field_conditions", JSON.stringify(conditions)], ...extra]);
  if (mode) query.set("field_mode", mode);
  return query;
};
// The list and the preview of one query select the same contacts, and the preview partitions the other four.
async function assertFieldSet(
  query: URLSearchParams,
  expected: string[],
  excluded: { tag: string; field: string; both: string },
) {
  const label = query.toString();
  const list = await listContacts(pool, a, query);
  assert.deepEqual(
    list.contacts.map((c) => c.sender_id),
    expected,
    label,
  );
  const preview = await listContacts(pool, a, new URLSearchParams([...query, ["preview", "true"]]));
  assert.deepEqual(
    preview.contacts.map((c) => c.sender_id),
    expected,
    label,
  );
  assert.equal(preview.total, String(expected.length), label);
  assert.equal(preview.evaluated, "4", label);
  assert.deepEqual(preview.excluded, excluded, label);
}
const onlyField = (matched: number) => ({ tag: "0", field: String(4 - matched), both: "0" });

test("field sets match all or any of two or three conditions of every type", async () => {
  const { conditions: c } = await multiFieldContacts();
  for (const [set, mode, expected] of [
    [[c.T, c.N], "all", ["all"]],
    [[c.N, c.T], null, ["all"]],
    [[c.T, c.N], "any", ["all", "some"]],
    [[c.T, c.D, c.B], "all", ["all"]],
    [[c.N, c.D, c.B], "any", ["all"]],
    [[c.S, c.U], "all", ["none"]],
    [[c.S, c.U], "any", ["all", "empty", "none"]],
    [[c.T, c.U], "all", []],
    [[c.T, c.U], "any", ["all", "empty", "none", "some"]],
    [[c.N, c.U], "all", []],
    [[c.D, c.U, c.T], "any", ["all", "empty", "none", "some"]],
    [[c.B, c.S], "any", ["all", "none"]],
    [[c.B, c.S, c.T], "all", ["all"]],
  ] as const)
    await assertFieldSet(fieldSetQuery([...set], mode), [...expected], onlyField(expected.length));
  // A set of one is the legacy condition for every operator.
  for (const condition of Object.values(c)) {
    const legacy = new URLSearchParams({ field_id: condition.field_id, field_operator: condition.field_operator });
    if ("field_value" in condition) legacy.set("field_value", JSON.stringify(condition.field_value));
    const single = await listContacts(pool, a, fieldSetQuery([condition], "any"));
    assert.deepEqual(single, await listContacts(pool, a, legacy), JSON.stringify(condition));
  }
  // The other workspace evaluates none of these contacts and cannot use these fields.
  const foreign = await fieldRequest("GET", `/api/contacts?${fieldSetQuery([c.T, c.N], "any")}`, undefined, b);
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), { error: "field_not_found" });
  // The HTTP route reads the JSON key the same way and refuses a fourth condition or a repeated field.
  const response = await fieldRequest("GET", `/api/contacts?${fieldSetQuery([c.T, c.N], "any")}`);
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).contacts.map((contact: { sender_id: string }) => contact.sender_id),
    ["all", "some"],
  );
  for (const set of [
    [c.T, c.N, c.D, c.U],
    [c.S, c.D],
  ]) {
    const refused = await fieldRequest("GET", `/api/contacts?${fieldSetQuery(set, null)}`);
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: "invalid_field_condition" });
  }
  // validateFieldCondition still checks each condition against its field type.
  const ordered = await fieldRequest(
    "GET",
    `/api/contacts?${fieldSetQuery([c.N, { ...c.T, field_operator: "gt" }], null)}`,
  );
  assert.equal(ordered.status, 400);
  assert.deepEqual(await ordered.json(), { error: "invalid_field_condition" });
  const typed = await fieldRequest("GET", `/api/contacts?${fieldSetQuery([c.T, { ...c.N, field_value: "5" }], null)}`);
  assert.equal(typed.status, 400);
  assert.deepEqual(await typed.json(), { error: "invalid_field_value" });
});

test("field sets are one side of the tag set AND/OR and the preview partitions like the list", async () => {
  const { conditions: c } = await multiFieldContacts();
  // Tag set any(lead, vip): all, empty, some.
  const tags = (operator?: string): [string, string][] => [
    ["tag", "lead"],
    ["tag", "vip"],
    ["tag_mode", "any"],
    ...(operator ? [["condition_operator", operator] as [string, string]] : []),
  ];
  await assertFieldSet(fieldSetQuery([c.T, c.U], "any", tags()), ["all", "empty", "some"], {
    tag: "1",
    field: "0",
    both: "0",
  });
  await assertFieldSet(fieldSetQuery([c.T, c.N], "all", tags()), ["all"], { tag: "0", field: "2", both: "1" });
  await assertFieldSet(fieldSetQuery([c.T, c.N], "all", tags("or")), ["all", "empty", "some"], {
    tag: "0",
    field: "0",
    both: "1",
  });
  await assertFieldSet(fieldSetQuery([c.S, c.U], "any", tags("or")), ["all", "empty", "none", "some"], {
    tag: "0",
    field: "0",
    both: "0",
  });
  // Tag set all(lead, vip) matches nobody, so OR leaves the field set alone.
  const allTags: [string, string][] = [
    ["tag", "lead"],
    ["tag", "vip"],
    ["tag_mode", "all"],
    ["condition_operator", "or"],
  ];
  await assertFieldSet(fieldSetQuery([c.S, c.U], "any", allTags), ["all", "empty", "none"], {
    tag: "0",
    field: "0",
    both: "1",
  });
  await assertFieldSet(fieldSetQuery([c.S, c.U], "all", allTags.slice(0, 3)), [], {
    tag: "1",
    field: "0",
    both: "3",
  });
});

test("multi-field segments store sorted sets, keep legacy single conditions and evaluate like the matching query", async () => {
  const { workspace, fields, conditions: c } = await multiFieldContacts();
  const created = await fieldRequest("POST", "/api/contact-segments", {
    name: "Pro or scored",
    field_conditions: [c.N, { ...c.T, field_id: c.T.field_id.toUpperCase() }],
    field_mode: "any",
  });
  assert.equal(created.status, 201);
  const segment = await created.json();
  const sorted = [c.T, c.N].sort((x, y) => (x.field_id < y.field_id ? -1 : 1));
  assert.deepEqual(segment, {
    id: segment.id,
    name: "Pro or scored",
    connection_id: null,
    tag: null,
    field_conditions: sorted,
    field_mode: "any",
    version: 1,
  });
  assert.deepEqual(
    (await listContactSegments(pool, a)).find((s) => s.id === segment.id),
    segment,
  );
  const row = async () =>
    (
      await pool.query(
        "SELECT field_id,field_operator,field_value,field_conditions,field_mode FROM instagram_contact_segments WHERE id=$1",
        [segment.id],
      )
    ).rows[0];
  assert.deepEqual(await row(), {
    field_id: null,
    field_operator: null,
    field_value: null,
    field_conditions: sorted,
    field_mode: "any",
  });
  const bySegment = new URLSearchParams({ segment_id: segment.id });
  await assertFieldSet(bySegment, ["all", "some"], onlyField(2));
  for (const mixed of [`field_conditions=${encodeURIComponent(JSON.stringify([c.T]))}`, "field_mode=any"])
    assert.equal((await fieldRequest("GET", `/api/contacts?${bySegment}&${mixed}`)).status, 400, mixed);
  assert.equal((await fieldRequest("GET", `/api/contacts?${bySegment}`, undefined, b)).status, 404);
  // A field referenced only inside field_conditions cannot be archived.
  for (const id of [fields.plan.id, fields.score.id]) {
    const archived = await fieldRequest("DELETE", `/api/contact-fields/${id}`);
    assert.equal(archived.status, 409);
    assert.deepEqual(await archived.json(), { error: "field_in_use" });
  }
  // The same set in another order and spelling is an unchanged definition and keeps the version.
  const same = await updateContactSegment(pool, a, segment.id, {
    name: "Pro or scored",
    field_conditions: [c.T, c.N],
    field_mode: "any",
    expected_version: 1,
  });
  assert.deepEqual(same, { conflict: false, segment });
  // Changing only the mode is a change.
  const allOf = await updateContactSegment(pool, a, segment.id, {
    name: "Pro or scored",
    field_conditions: [c.N, c.T],
    field_mode: "all",
    expected_version: 1,
  });
  assert.deepEqual(allOf.segment, { ...segment, field_mode: "all", version: 2 });
  await assertFieldSet(bySegment, ["all"], onlyField(1));
  // Three conditions, with is_unset, then a set of one that is stored and returned as the legacy condition.
  const three = await updateContactSegment(pool, a, segment.id, {
    name: "Pro or scored",
    field_conditions: [c.U, c.T, c.D],
    field_mode: "any",
    expected_version: 2,
  });
  assert.equal(three.segment.version, 3);
  assert.equal((three.segment as { field_conditions: unknown[] }).field_conditions.length, 3);
  await assertFieldSet(bySegment, ["all", "empty", "none", "some"], onlyField(4));
  const single = await updateContactSegment(pool, a, segment.id, {
    name: "Pro or scored",
    field_conditions: [c.N],
    field_mode: "any",
    expected_version: 3,
  });
  assert.deepEqual(single.segment, {
    id: segment.id,
    name: "Pro or scored",
    connection_id: null,
    tag: null,
    ...c.N,
    version: 4,
  });
  assert.deepEqual(await row(), {
    field_id: c.N.field_id,
    field_operator: "gt",
    field_value: 5,
    field_conditions: null,
    field_mode: null,
  });
  // The legacy key form of the same single condition is unchanged too.
  const legacySame = await updateContactSegment(pool, a, segment.id, {
    name: "Pro or scored",
    ...c.N,
    expected_version: 4,
  });
  assert.equal(legacySame.segment.version, 4);
  // A field set OR a tag set passes the updated condition_operator CHECK.
  const either = await updateContactSegment(pool, a, segment.id, {
    name: "Pro or scored",
    tags: ["lead", "vip"],
    tag_mode: "all",
    field_conditions: [c.T, c.N],
    field_mode: "all",
    condition_operator: "or",
    expected_version: 4,
  });
  assert.deepEqual(either.segment, {
    id: segment.id,
    name: "Pro or scored",
    connection_id: null,
    tags: ["lead", "vip"],
    tag_mode: "all",
    condition_operator: "or",
    field_conditions: sorted,
    field_mode: "all",
    version: 5,
  });
  await assertFieldSet(bySegment, ["all"], { tag: "0", field: "0", both: "3" });
  // Legacy single-field segments keep their shape.
  const legacy = await createContactSegment(pool, a, { name: "Legacy", ...c.S });
  assert.deepEqual(legacy, { id: legacy.id, name: "Legacy", connection_id: null, tag: null, ...c.S, version: 1 });
  const collapsed = await createContactSegment(pool, a, {
    name: "Collapsed",
    field_conditions: [c.S],
    field_mode: "any",
  });
  assert.deepEqual(collapsed, { ...legacy, id: collapsed.id, name: "Collapsed" });
  const both = await fieldRequest("POST", "/api/contact-segments", {
    name: "Both",
    ...c.S,
    field_conditions: [c.T, c.N],
  });
  assert.equal(both.status, 400);
  assert.deepEqual(await both.json(), { error: "invalid_field_condition" });
  // An archived field or another workspace's field is refused on create and on edit, and nothing is written.
  const archivedField = await createField("Set archived", "text");
  assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${archivedField.id}`)).status, 200);
  const foreignResponse = await fieldRequest("POST", "/api/contact-fields", { name: "Foreign", type: "number" }, b);
  assert.equal(foreignResponse.status, 201);
  const foreignField = await foreignResponse.json();
  const before = await segmentRows();
  for (const reference of [
    { field_id: archivedField.id, field_operator: "is_set" },
    { field_id: foreignField.id, field_operator: "is_set" },
  ]) {
    const create = await fieldRequest("POST", "/api/contact-segments", {
      name: "Refused",
      field_conditions: [c.T, reference],
    });
    assert.equal(create.status, 404);
    assert.deepEqual(await create.json(), { error: "field_not_found" });
    const edit = await fieldRequest("PUT", segmentPath(segment.id), {
      name: "Pro or scored",
      field_conditions: [reference, c.N],
      expected_version: 5,
    });
    assert.equal(edit.status, 404);
    assert.deepEqual(await edit.json(), { error: "field_not_found" });
  }
  assert.deepEqual(await segmentRows(), before);
  // The other workspace can neither read nor edit the segment.
  await assert.rejects(
    updateContactSegment(pool, b, segment.id, { name: "Foreign", field_conditions: [c.T, c.N], expected_version: 5 }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  assert.equal(
    (await listContactSegments(pool, b)).some((s) => s.id === segment.id),
    false,
  );
  await archiveContactSegment(pool, a, segment.id);
  assert.equal((await fieldRequest("GET", `/api/contacts?${bySegment}`)).status, 404);
  // An archived segment no longer holds its fields.
  await archiveContactSegment(pool, a, legacy.id);
  await archiveContactSegment(pool, a, collapsed.id);
  assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${fields.plan.id}`)).status, 200);
  assert.ok(workspace);
});

test("a multi-field segment write holds every field, so a concurrent archive waits and answers field_in_use", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const first = await createField("Race set first", "text");
  const second = await createField("Race set second", "number");
  const other = "99999999-9999-4999-8999-999999999998";
  await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,'race-set')", [
    other,
    workspace,
  ]);
  // The archived field is the one that sorts last, so it is held only by the field_conditions lock loop.
  const [, last] = [first, second].sort((x, y) => (x.id < y.id ? -1 : 1));
  // The blocker holds the new connection, so the create's foreign-key check waits after it locked the fields.
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM instagram_connections WHERE id=$1 FOR UPDATE", [other]);
    const create = fieldRequest("POST", "/api/contact-segments", {
      name: "Race set",
      connection_id: other,
      field_conditions: [
        { field_id: first.id, field_operator: "is_set" },
        { field_id: second.id, field_operator: "is_unset" },
      ],
      field_mode: "any",
    });
    await lockWaiters(1);
    let archiveSettled = false;
    const archive = fieldRequest("DELETE", `/api/contact-fields/${last.id}`).finally(() => {
      archiveSettled = true;
    });
    await lockWaiters(2, () => archiveSettled);
    await blocker.query("COMMIT");
    const [saved, archived] = await Promise.all([create, archive]);
    assert.equal(saved.status, 201);
    assert.equal(archived.status, 409);
    assert.deepEqual(await archived.json(), { error: "field_in_use" });
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  assert.equal(
    (await pool.query("SELECT archived FROM instagram_contact_fields WHERE id=$1", [last.id])).rows[0].archived,
    false,
  );
});

test("a field archive that commits before a multi-field edit reads the field makes the edit answer field_not_found", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const kept = await createField("Set kept", "text");
  const field = await createField("Set archived first", "text");
  const segment = await createContactSegment(pool, a, { name: "Set archive first" });
  const before = await segmentRows();
  // The blocker holds the workspace row, so the edit waits at its first lock while the archive commits.
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspace]);
    const edit = fieldRequest("PUT", segmentPath(segment.id), {
      name: "Set archive first",
      field_conditions: [
        { field_id: kept.id, field_operator: "is_set" },
        { field_id: field.id, field_operator: "is_set" },
      ],
      expected_version: 1,
    });
    await lockWaiters(1);
    assert.equal((await fieldRequest("DELETE", `/api/contact-fields/${field.id}`)).status, 200);
    await blocker.query("COMMIT");
    const edited = await edit;
    assert.equal(edited.status, 404);
    assert.deepEqual(await edited.json(), { error: "field_not_found" });
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  assert.deepEqual(await segmentRows(), before);
});

test("the multi-field CHECK refuses malformed sets written directly", async () => {
  const workspace = await ensureWorkspace(pool, a);
  const field = await createField("Set check", "number");
  const [x, y, z, w] = [
    "a1111111-1111-4111-8111-111111111111",
    "b2222222-2222-4222-8222-222222222222",
    "c3333333-3333-4333-8333-333333333333",
    "d4444444-4444-4444-8444-444444444444",
  ];
  const set = (...items: unknown[]) => `'${JSON.stringify(items)}'::jsonb`;
  const isSet = (id: string) => ({ field_id: id, field_operator: "is_set" });
  const insert = (columns: string) =>
    pool.query(
      `INSERT INTO instagram_contact_segments(workspace_id,name,field_id,field_operator,field_conditions,field_mode) SELECT $1,'Direct',${columns}`,
      [workspace],
    );
  for (const columns of [
    `NULL,NULL,${set(isSet(x), { field_id: y, field_operator: "eq", field_value: true })},'all' RETURNING id`,
    `NULL,NULL,${set(isSet(x), { field_id: y, field_operator: "gt", field_value: 1 }, { field_id: z, field_operator: "lte", field_value: "2026-01-01" })},'any' RETURNING id`,
  ]) {
    const valid = await insert(columns);
    await pool.query("UPDATE instagram_contact_segments SET archived=true WHERE id=$1", [valid.rows[0].id]);
  }
  for (const columns of [
    `NULL,NULL,${set(isSet(x))},'all'`,
    `NULL,NULL,${set(isSet(x), isSet(y), isSet(z), isSet(w))},'all'`,
    `NULL,NULL,'{}'::jsonb,'all'`,
    `NULL,NULL,'"x"'::jsonb,'all'`,
    `NULL,NULL,'[]'::jsonb,'all'`,
    `NULL,NULL,${set(isSet(x), isSet(y))},'none'`,
    `NULL,NULL,${set(isSet(x), isSet(y))},NULL`,
    `NULL,NULL,NULL,'all'`,
    `'${field.id}','is_set',${set(isSet(x), isSet(y))},'all'`,
    `NULL,NULL,${set(isSet(x), "y")},'all'`,
    `NULL,NULL,${set(isSet(x), { ...isSet(y), extra: 1 })},'all'`,
    `NULL,NULL,${set(isSet(x), { field_id: y, field_operator: "eq" })},'all'`,
    `NULL,NULL,${set(isSet(x), { ...isSet(y), field_value: 1 })},'all'`,
    `NULL,NULL,${set(isSet(x), { field_id: y, field_operator: "gt", field_value: true })},'all'`,
    `NULL,NULL,${set(isSet(x), { field_id: y, field_operator: "contains", field_value: "a" })},'all'`,
    `NULL,NULL,${set(isSet(x), { field_operator: "is_set" })},'all'`,
    `NULL,NULL,${set(isSet(x), { field_id: 1, field_operator: "is_set" })},'all'`,
    `NULL,NULL,${set(isSet(x), isSet(y.toUpperCase()))},'all'`,
    `NULL,NULL,${set(isSet(y), isSet(x))},'all'`,
    `NULL,NULL,${set(isSet(x), isSet(x))},'all'`,
    `NULL,NULL,${set(isSet(x), isSet(z), isSet(y))},'all'`,
  ])
    await assert.rejects(insert(columns), { code: "23514", constraint: "contact_segment_multi_field" }, columns);
  // OR still needs a tag condition and a field condition, and a field set counts as one.
  await assert.rejects(
    pool.query(
      `INSERT INTO instagram_contact_segments(workspace_id,name,field_conditions,field_mode,condition_operator) VALUES($1,'No tag',${set(isSet(x), isSet(y))},'any','or')`,
      [workspace],
    ),
    { code: "23514", constraint: "contact_segment_condition_operator" },
  );
  await pool.query(
    `INSERT INTO instagram_contact_segments(workspace_id,name,tag,field_conditions,field_mode,condition_operator) VALUES($1,'Tag or set','lead',${set(isSet(x), isSet(y))},'any','or')`,
    [workspace],
  );
});

test("multi-field migration adds the columns and checks, keeps legacy rows and can be applied repeatedly", async () => {
  const field = await createField("Migration multi field", "number");
  const legacy = await createContactSegment(pool, a, {
    name: "Legacy or",
    tag: "lead",
    field_id: field.id,
    field_operator: "is_set",
    condition_operator: "or",
  });
  const constraints = (client: { query: typeof pool.query }) =>
    client
      .query(
        "SELECT conname FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname IN ('contact_segment_multi_field','contact_segment_condition_operator') ORDER BY conname",
      )
      .then((result) => result.rows.map((row) => row.conname));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE instagram_contact_segments DROP COLUMN field_conditions, DROP COLUMN field_mode");
    // Dropping field_conditions also dropped the condition_operator CHECK that reads it; the migration restores both.
    assert.deepEqual(await constraints(client), []);
    const migration = await readFile(
      new URL("../../db/migrations/057_segment_multi_field.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual(await constraints(client), ["contact_segment_condition_operator", "contact_segment_multi_field"]);
    const read = async () =>
      (
        await client.query(
          "SELECT tag,field_id,field_operator,field_conditions,field_mode,condition_operator FROM instagram_contact_segments WHERE id=$1",
          [legacy.id],
        )
      ).rows[0];
    assert.deepEqual(await read(), {
      tag: "lead",
      field_id: field.id,
      field_operator: "is_set",
      field_conditions: null,
      field_mode: null,
      condition_operator: "or",
    });
    const set = [
      { field_id: "a1111111-1111-4111-8111-111111111111", field_operator: "is_set" },
      { field_id: "b2222222-2222-4222-8222-222222222222", field_operator: "is_unset" },
    ];
    await client.query(
      "UPDATE instagram_contact_segments SET field_id=NULL,field_operator=NULL,field_conditions=$2::jsonb,field_mode='any' WHERE id=$1",
      [legacy.id, JSON.stringify(set)],
    );
    await client.query(migration);
    assert.deepEqual(await read(), {
      tag: "lead",
      field_id: null,
      field_operator: null,
      field_conditions: set,
      field_mode: "any",
      condition_operator: "or",
    });
    for (const [change, constraint] of [
      [`field_conditions='${JSON.stringify(set.slice(0, 1))}'::jsonb`, "contact_segment_multi_field"],
      [`field_id='${field.id}',field_operator='is_set'`, "contact_segment_multi_field"],
      ["field_conditions=NULL,field_mode=NULL", "contact_segment_condition_operator"],
    ]) {
      await client.query("SAVEPOINT invalid_multi_field");
      await assert.rejects(client.query(`UPDATE instagram_contact_segments SET ${change} WHERE id=$1`, [legacy.id]), {
        code: "23514",
        constraint,
      });
      await client.query("ROLLBACK TO SAVEPOINT invalid_multi_field");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("re-running migrations 056 and 057 and the schema keeps OR segments that use a field set", async () => {
  const first = await createField("Rerun first", "number");
  const second = await createField("Rerun second", "text");
  const field_conditions = [
    { field_id: first.id, field_operator: "is_set" },
    { field_id: second.id, field_operator: "is_unset" },
  ];
  const withTag = await createContactSegment(pool, a, {
    name: "Tag or field set",
    tag: "lead",
    field_conditions,
    field_mode: "any",
    condition_operator: "or",
  });
  const withTags = await createContactSegment(pool, a, {
    name: "Tags or field set",
    tags: ["lead", "vip"],
    tag_mode: "all",
    field_conditions,
    field_mode: "all",
    condition_operator: "or",
  });
  const read = (client: { query: typeof pool.query }) =>
    client
      .query(
        "SELECT id,tag,tags,field_id,field_conditions,field_mode,condition_operator FROM instagram_contact_segments WHERE id=ANY($1::uuid[]) ORDER BY name",
        [[withTag.id, withTags.id]],
      )
      .then((result) => result.rows);
  const rule = (client: { query: typeof pool.query }) =>
    client
      .query(
        "SELECT pg_get_constraintdef(oid) AS rule FROM pg_constraint WHERE conrelid='instagram_contact_segments'::regclass AND conname='contact_segment_condition_operator'",
      )
      .then((result) => result.rows[0]?.rule as string | undefined);
  const before = await read(pool);
  assert.equal(before.length, 2);
  const file = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const [multiTag, multiField, schema] = await Promise.all([
    file("../../db/migrations/056_segment_multi_tag.sql"),
    file("../../db/migrations/057_segment_multi_field.sql"),
    file("../../db/schema.sql"),
  ]);
  const client = await pool.connect();
  try {
    // deploy/migrate-multi-user.sql runs 056 and then 057 in one transaction on a database that already has both.
    await client.query("BEGIN");
    await client.query(multiTag);
    await client.query(multiField);
    await client.query(multiTag);
    await client.query(multiField);
    assert.deepEqual(await read(client), before);
    assert.match((await rule(client)) ?? "", /field_conditions/);
    await client.query("ROLLBACK");
    // The DB tests apply db/schema.sql to a database that may still hold rows.
    await client.query("BEGIN");
    await client.query(schema);
    assert.deepEqual(await read(client), before);
    assert.match((await rule(client)) ?? "", /field_conditions/);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
