import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { ingestMessages } from "./follow-flow.ts";
import { parseMessageEvents, type InstagramMessage } from "./message-events.ts";
import { manualReplyStatus } from "./manual-reply-worker.ts";
import { inboxMessages, listInbox } from "../app/inbox.ts";
import { latestTextSql } from "../app/campaign-drafts.ts";
import { resetTestSchema } from "../test-schema.ts";

// Received attachments, unsupported messages and withdrawals in the inbox (#20).
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const W = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const OFF = "33333333-3333-4333-8333-333333333333";
const user = { id: "44444444-4444-4444-8444-444444444444", email: "owner@example.test" };
const account = "100";

before(async () => {
  await resetTestSchema(pool);
});
after(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces, workspace_deletion_records, active_contacts CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [W]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2)", [W, user.id]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,inbox_enabled,inbox_enabled_at)
     VALUES($1,$2,$3,true,true,true,now()-interval '1 day'),($4,$2,'200',true,true,false,NULL)`,
    [C, W, account, OFF],
  );
});

const at = () => new Date(Date.now() - 1000);
const body = (messaging: unknown[], entry = account) => Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: entry, messaging }] }));
const envelope = (sender: string, message: Record<string, unknown>, entry = account) => ({ sender: { id: sender }, recipient: { id: entry }, timestamp: Date.now() - 1000, message });

async function stored(recipient?: string) {
  return (
    await pool.query(
      `SELECT recipient_id,message_id,text,kind,attachments,deleted_at IS NOT NULL AS deleted FROM instagram_inbox_messages
       WHERE ($1::text IS NULL OR recipient_id=$1) ORDER BY id`,
      [recipient ?? null],
    )
  ).rows;
}

test("attachments, a typed DM with an attachment and an unsupported message are stored without their media", async () => {
  await ingestMessages(
    pool,
    parseMessageEvents(
      body([
        envelope("901", {
          mid: "a1",
          attachments: [
            { type: "image", payload: { url: "https://cdn.example/a.jpg" } },
            { type: "ig_reel", payload: { url: "https://cdn.example/r", title: "릴스", reel_video_id: "77" } },
          ],
        }),
        envelope("901", { mid: "t1", text: "사진 보내요", attachments: [{ type: "video", payload: { url: "https://cdn.example/v.mp4" } }] }),
        envelope("902", { mid: "u1", is_unsupported: true }),
      ]),
    ),
  );
  assert.deepEqual(await stored(), [
    { recipient_id: "901", message_id: "a1", text: "", kind: "attachment", attachments: [{ type: "image" }, { type: "ig_reel", title: "릴스" }], deleted: false },
    { recipient_id: "901", message_id: "t1", text: "사진 보내요", kind: "text", attachments: [{ type: "video" }], deleted: false },
    { recipient_id: "902", message_id: "u1", text: "", kind: "unsupported", attachments: null, deleted: false },
  ]);
  const dump = await pool.query("SELECT row_to_json(m)::text AS row FROM instagram_inbox_messages m");
  for (const row of dump.rows) assert.doesNotMatch(row.row, /cdn\.example|reel_video_id|"77"/);
  // A redelivery stores nothing new.
  await ingestMessages(pool, parseMessageEvents(body([envelope("901", { mid: "a1", attachments: [{ type: "file" }] })])));
  assert.equal((await stored("901")).length, 2);

  const list = await listInbox(pool, user, new URLSearchParams());
  assert.deepEqual(list.conversations.map((row) => [row.recipient_id, row.last_message_kind, row.last_message_preview]).sort(), [
    ["901", "text", "사진 보내요"],
    ["902", "unsupported", ""],
  ]);
  const messages = await inboxMessages(pool, user, C, "901", new URLSearchParams());
  assert.deepEqual(
    messages.messages.map((row) => [row.kind, row.attachments, row.deleted_at]),
    [
      ["text", [{ type: "video" }], null],
      ["attachment", [{ type: "image" }, { type: "ig_reel", title: "릴스" }], null],
    ],
  );
});

test("a withdrawal clears the stored text and attachments once and keeps the row and its time", async () => {
  await ingestMessages(pool, parseMessageEvents(body([envelope("901", { mid: "t1", text: "secret words" }), envelope("901", { mid: "a1", attachments: [{ type: "image" }] })])));
  const before = await pool.query("SELECT id,message_at FROM instagram_inbox_messages WHERE message_id='t1'");
  await ingestMessages(pool, parseMessageEvents(body([envelope("901", { mid: "t1", is_deleted: true }), envelope("901", { mid: "a1", is_deleted: true })])));
  assert.deepEqual(await stored(), [
    { recipient_id: "901", message_id: "t1", text: "", kind: "text", attachments: null, deleted: true },
    { recipient_id: "901", message_id: "a1", text: "", kind: "attachment", attachments: null, deleted: true },
  ]);
  const first = await pool.query("SELECT id,message_at,deleted_at FROM instagram_inbox_messages WHERE message_id='t1'");
  assert.deepEqual([first.rows[0].id, first.rows[0].message_at], [before.rows[0].id, before.rows[0].message_at]);
  await ingestMessages(pool, parseMessageEvents(body([envelope("901", { mid: "t1", is_deleted: true })])));
  const again = await pool.query("SELECT deleted_at FROM instagram_inbox_messages WHERE message_id='t1'");
  assert.deepEqual(again.rows[0].deleted_at, first.rows[0].deleted_at);
  // Search no longer finds the text, and the list names the newest message as withdrawn.
  assert.equal((await listInbox(pool, user, new URLSearchParams({ q: "secret" }))).conversations.length, 0);
  assert.equal((await listInbox(pool, user, new URLSearchParams())).conversations[0]?.last_message_kind, "deleted");
  // A withdrawn text keeps the window it opened: the sender did send it at that time.
  const status = await manualReplyStatus(pool, { workspace_id: W, connection_id: C, recipient_id: "901" });
  assert.notEqual(status.window_expires_at, null);
});

test("the conversation response names its newest message as the list does, whatever the arrival order", async () => {
  // The newest DM by time arrived first, so it has the lower ID; a page ordered by ID would show the other one first.
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,'901','newest','latest words','text',now()-interval '1 minute'),($1,$2,'901','older','older words','text',now()-interval '1 hour')`,
    [W, C],
  );
  const read = async () => (await inboxMessages(pool, user, C, "901", new URLSearchParams())).latest;
  assert.deepEqual(await read(), { last_message_preview: "latest words", last_message_kind: "text" });
  await ingestMessages(pool, parseMessageEvents(body([envelope("901", { mid: "newest", is_deleted: true })])));
  assert.deepEqual(await read(), { last_message_preview: "", last_message_kind: "deleted" });
  assert.equal((await listInbox(pool, user, new URLSearchParams())).conversations[0]?.last_message_kind, "deleted");
  assert.equal((await inboxMessages(pool, user, C, "902", new URLSearchParams())).latest, null);
});

test("a withdrawal that arrives first keeps the late original out, and one without a sender clears only stored copies", async () => {
  await ingestMessages(pool, parseMessageEvents(body([envelope("901", { mid: "t1", is_deleted: true })])));
  assert.deepEqual(await stored(), [{ recipient_id: "901", message_id: "t1", text: "", kind: "deleted", attachments: null, deleted: true }]);
  await ingestMessages(pool, parseMessageEvents(body([envelope("901", { mid: "t1", text: "late original" })])));
  assert.deepEqual(await stored(), [{ recipient_id: "901", message_id: "t1", text: "", kind: "deleted", attachments: null, deleted: true }]);

  await ingestMessages(pool, parseMessageEvents(body([envelope("902", { mid: "t2", text: "kept" })])));
  const bare = (mid: string) => ({ timestamp: Date.now() - 1000, message: { mid, is_deleted: true } });
  await ingestMessages(pool, parseMessageEvents(body([bare("t2"), bare("never-stored")])));
  assert.deepEqual(await stored("902"), [{ recipient_id: "902", message_id: "t2", text: "", kind: "text", attachments: null, deleted: true }]);
  assert.equal((await stored()).length, 2);
});

test("a withdrawal-first row needs inbox storage, and it neither reopens a closed conversation nor opens a window", async () => {
  await ingestMessages(pool, parseMessageEvents(body([envelope("901", { mid: "off-1", is_deleted: true }, "200"), envelope("901", { mid: "off-2", attachments: [{ type: "image" }] }, "200")], "200")));
  assert.deepEqual(await stored(), []);
  // The attachment still opened the window of the connection whose inbox is off (#300).
  const inbound = await pool.query("SELECT connection_id::text FROM instagram_dm_last_inbound");
  assert.deepEqual(
    inbound.rows.map((row) => row.connection_id),
    [OFF],
  );

  await pool.query("INSERT INTO instagram_inbox_conversations(workspace_id,connection_id,recipient_id,status,version) VALUES($1,$2,'901','closed',1)", [W, C]);
  await ingestMessages(pool, parseMessageEvents(body([envelope("901", { mid: "d1", is_deleted: true })])));
  assert.equal((await pool.query("SELECT status FROM instagram_inbox_conversations WHERE recipient_id='901'")).rows[0].status, "closed");
  const closed = await manualReplyStatus(pool, { workspace_id: W, connection_id: C, recipient_id: "901" });
  assert.equal(closed.window_expires_at, null);
  await ingestMessages(pool, parseMessageEvents(body([envelope("901", { mid: "a1", attachments: [{ type: "audio" }] })])));
  assert.equal((await pool.query("SELECT status FROM instagram_inbox_conversations WHERE recipient_id='901'")).rows[0].status, "open");
  const opened = await manualReplyStatus(pool, { workspace_id: W, connection_id: C, recipient_id: "901" });
  assert.notEqual(opened.window_expires_at, null);
});

test("the campaign window reads stored text, attachment and unsupported DMs, not postbacks or withdrawal-first rows", async () => {
  const latest = async (recipient: string) =>
    (
      await pool.query(
        `SELECT latest.message_at FROM (SELECT $2::uuid AS connection_id,$3::text AS recipient_id) v
         CROSS JOIN LATERAL ${latestTextSql("$1")}`,
        [W, C, recipient],
      )
    ).rows[0].message_at;
  const insert = (recipient: string, kind: string, extra: { attachments?: string; deleted?: boolean } = {}) =>
    pool.query(
      `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at,attachments,deleted_at)
       VALUES($1,$2,$3,$4,$5,$6,now(),$7::jsonb,$8)`,
      [W, C, recipient, `${recipient}-${kind}`, kind === "postback" ? "button" : "", kind, extra.attachments ?? null, extra.deleted ? new Date() : null],
    );
  await insert("801", "attachment", { attachments: '[{"type":"image"}]' });
  await insert("802", "unsupported");
  await insert("803", "postback");
  await insert("804", "deleted", { deleted: true });
  assert.notEqual(await latest("801"), null);
  assert.notEqual(await latest("802"), null);
  assert.equal(await latest("803"), null);
  assert.equal(await latest("804"), null);
});

test("the content CHECK refuses text on content-only kinds, a deleted row with text and more than ten attachments", async () => {
  const insert = (kind: string, text: string, attachments: string | null, deleted = false) =>
    pool.query(
      `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at,attachments,deleted_at)
       VALUES($1,$2,'901',gen_random_uuid()::text,$3,$4,now(),$5::jsonb,$6)`,
      [W, C, text, kind, attachments, deleted ? new Date() : null],
    );
  const eleven = JSON.stringify(Array.from({ length: 11 }, () => ({ type: "image" })));
  for (const [kind, text, attachments, deleted] of [
    ["attachment", "text", '[{"type":"image"}]', false],
    ["attachment", "", null, false],
    ["unsupported", "text", null, false],
    ["deleted", "", null, false],
    ["text", "still here", null, true],
    ["text", "", '[{"type":"image"}]', true],
    ["postback", "button", '[{"type":"image"}]', false],
    ["text", "hi", "[]", false],
    ["text", "hi", eleven, false],
    ["text", "hi", '{"type":"image"}', false],
  ] as const)
    await assert.rejects(insert(kind, text, attachments, deleted), /instagram_inbox_messages_content/, `${kind} ${text} ${attachments} ${deleted}`);
  await insert("text", "hi", '[{"type":"image"}]');
  await insert("attachment", "", null, true);
});

// The parser output is the only producer; this keeps a hand-built withdrawal without a sender from inserting a row.
test("a withdrawal with an empty sender never inserts a row", async () => {
  const withdrawal: InstagramMessage = { accountId: account, senderId: "", messageId: "x1", text: "", timestamp: at(), content: "deleted" };
  await ingestMessages(pool, [withdrawal]);
  assert.deepEqual(await stored(), []);
});
