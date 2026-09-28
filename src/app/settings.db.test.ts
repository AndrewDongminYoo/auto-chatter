import assert from "node:assert/strict";
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
} from "./contacts.ts";
import { connectionMedia } from "./instagram-media.ts";
import { sealSecret } from "./secrets.ts";
import { appApi } from "./api.ts";
import { ingestMessages } from "../instagram/follow-flow.ts";
import { parseMessageEvents } from "../instagram/message-events.ts";

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

async function fieldRequest(method: string, path: string, body?: unknown, user = a, sendEnabled?: string) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test", SEND_ENABLED: sendEnabled },
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () => Response.json({ ...user, email_confirmed_at: "2026-09-25" })) as typeof fetch,
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
  await disconnectConnection(pool, b, connectionId);
  assert.equal((await listConnections(pool, a))[0].token_registered, true);
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
    "tag=x&tag=y",
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
  assert.deepEqual(segment, { id: segment.id, name: "Leads", connection_id: connectionId, tag: "lead" });
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

test("segment migration upgrades and replays while retaining saved filters", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP TABLE instagram_contact_segments");
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
