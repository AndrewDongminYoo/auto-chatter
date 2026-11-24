import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { ingestComments } from "../instagram/store.ts";
import { ingestMessages } from "../instagram/follow-flow.ts";
import type { InstagramMessage } from "../instagram/message-events.ts";
import { verifiedDmRecipientsSql } from "./inbox-identity.ts";
import { activeContactUsage, workspaceEntitlements } from "./plans.ts";
import { seedWorkspace } from "./workspace-fixture.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const seoul = "11111111-1111-4111-8111-111111111111";
const angeles = "22222222-2222-4222-8222-222222222222";
const seoulConnection = "33333333-3333-4333-8333-333333333333";
const angelesConnection = "44444444-4444-4444-8444-444444444444";
const rule = "55555555-5555-4555-8555-555555555555";
const owner = "66666666-6666-4666-8666-666666666666";

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});
after(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces, workspace_deletion_records CASCADE");
  // The ledger has no foreign keys, so the cascade above leaves it alone.
  await pool.query("TRUNCATE active_contacts");
  await workspace(seoul, "Asia/Seoul", seoulConnection, "100");
  await workspace(angeles, "America/Los_Angeles", angelesConnection, "200");
});

async function workspace(id: string, timeZone: string, connection: string, account: string) {
  await pool.query("INSERT INTO workspaces(id,time_zone) VALUES($1,$2)", [id, timeZone]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,inbox_enabled,inbox_enabled_at)
     VALUES($1,$2,$3,true,true,true,'2026-09-01T00:00:00Z')`,
    [connection, id, account],
  );
}

// The ledger statement of ingestComments (recordActiveContactComments in src/instagram/store.ts) for stored comments.
async function recordComments(where = "TRUE") {
  await pool.query(
    `SELECT public.record_active_contacts(array_agg(e.workspace_id),array_agg(e.connection_id),array_agg('comment_sender'::text),
       array_agg(e.sender_id),array_agg(e.created_at),array_agg('comment'::text))
     FROM instagram_comment_events e JOIN instagram_connections c ON c.id=e.connection_id AND c.workspace_id=e.workspace_id
     WHERE (${where}) AND e.sender_id<>c.account_id AND e.sender_id IS DISTINCT FROM c.instagram_user_id`,
  );
}

// A stored comment with a chosen created_at, recorded as ingestComments records it.
async function comment(ws: string, connection: string, commentId: string, sender: string, at?: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at)
     VALUES($1,$2,$3,'1789',$4,'text',coalesce($5::timestamptz,now())) RETURNING id`,
    [ws, connection, commentId, sender, at ?? null],
  );
  const id = result.rows[0].id;
  await recordComments(`e.id=${Number(id)}`);
  return id;
}

async function ruleFor(ws: string, connection: string) {
  await pool.query(
    `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled)
     VALUES($1,$2,$3,'1789','link','reply',true) ON CONFLICT DO NOTHING`,
    [rule, ws, connection],
  );
}

async function queueReply(ws: string, connection: string, event: string, sender: string, commentId: string): Promise<string> {
  await ruleFor(ws, connection);
  const result = await pool.query(
    `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text)
     VALUES($1,$2,$3,$4,$5,'1789',$6,'reply') RETURNING id`,
    [ws, connection, event, rule, commentId, sender],
  );
  return result.rows[0].id;
}

async function sendReply(id: string, recipient: string, at?: string) {
  await pool.query(
    `UPDATE private_reply_outbox SET status='sent',provider_message_id='mid-'||id,recipient_id=$2,sent_at=coalesce($3::timestamptz,now())
     WHERE id=$1`,
    [id, recipient, at ?? null],
  );
}

const dm = (senderId: string, messageId: string, timestamp: Date, accountId = "100"): InstagramMessage => ({ accountId, senderId, messageId, text: "hello", timestamp });

interface LedgerRow {
  workspace_id: string;
  billing_month: string;
  connection_id: string;
  person_key_kind: string;
  person_key: string | null;
  activity_kind: string;
  first_activity_at: Date;
  time_zone: string;
}

async function ledger(): Promise<LedgerRow[]> {
  return (
    await pool.query<LedgerRow>(
      `SELECT workspace_id,billing_month::text,connection_id,person_key_kind,person_key,activity_kind,first_activity_at,time_zone
       FROM active_contacts ORDER BY workspace_id,billing_month,connection_id,person_key_kind,person_key COLLATE "C",first_activity_at`,
    )
  ).rows;
}

const keys = (rows: LedgerRow[]) => rows.map((row) => `${row.billing_month} ${row.person_key_kind}:${row.person_key ?? "-"}`);

async function monthCounts(): Promise<Record<string, number>> {
  const rows = (await pool.query<{ key: string; n: number }>("SELECT workspace_id||' '||billing_month AS key,count(*)::int AS n FROM active_contacts GROUP BY 1 ORDER BY 1")).rows;
  return Object.fromEntries(rows.map((row) => [row.key, row.n]));
}

// The recompute (#51): every source activity, written the same way as the triggers and the inbound DM path record
// them. Inbound DMs come only from the stored inbox messages and DM start events; an inbound DM that nothing stored
// has no source. A DM recipient's activity may be stored under a comment sender that a confirm event linked to it.
const SOURCE_ACTIVITY_SQL = `
  SELECT e.workspace_id,e.connection_id,'comment_sender' AS identity_kind,e.sender_id AS identity,e.created_at AS activity_at
  FROM instagram_comment_events e JOIN instagram_connections own ON own.id=e.connection_id AND own.workspace_id=e.workspace_id
  WHERE e.sender_id<>own.account_id AND e.sender_id IS DISTINCT FROM own.instagram_user_id
  UNION ALL SELECT workspace_id,connection_id,'comment_sender',sender_id,sent_at FROM private_reply_outbox WHERE status='sent'
  UNION ALL SELECT reply.workspace_id,reply.connection_id,'comment_sender',reply.sender_id,message.sent_at
    FROM instagram_follow_messages message JOIN instagram_follow_conversations flow ON flow.reply_id=message.reply_id
    JOIN private_reply_outbox reply ON reply.id=flow.reply_id WHERE message.sent_at IS NOT NULL
  UNION ALL SELECT workspace_id,connection_id,'dm_recipient',recipient_id,sent_at FROM instagram_manual_replies WHERE status='sent'
  UNION ALL SELECT workspace_id,connection_id,'dm_recipient',recipient_id,sent_at FROM campaign_deliveries WHERE status='sent'
  UNION ALL SELECT workspace_id,connection_id,'dm_recipient',recipient_id,sent_at FROM flow_dm_deliveries WHERE status='sent'
  UNION ALL SELECT workspace_id,connection_id,'dm_recipient',recipient_id,least(message_at,received_at) FROM instagram_inbox_messages
  UNION ALL SELECT workspace_id,connection_id,'dm_recipient',sender_id,least(message_at,created_at) FROM instagram_dm_start_events`;

// Rebuilds the ledger from the source activity with each stored row's own time zone and person key, and compares it
// with the stored rows that still have a person key. It returns the source activities that no stored row records,
// the stored rows that no source explains (allowed only for an inbound DM, which may have no stored source), and the
// stored rows whose first_activity_at is not the time of one of their source activities.
async function recompute() {
  const result = await pool.query<{ rebuilt: string[] | null; stored: string[] | null; missing: string[] | null; unexplained: string[] | null; bad_first: string[] | null }>(
    `WITH activity AS (${SOURCE_ACTIVITY_SQL}),
     candidate AS (
       SELECT activity.*,activity.identity_kind AS key_kind,activity.identity AS key FROM activity
       UNION ALL
       SELECT activity.*,'comment_sender',link.sender_id FROM activity
       JOIN instagram_contact_identity_link_events link ON link.workspace_id=activity.workspace_id
         AND link.connection_id=activity.connection_id AND link.recipient_id=activity.identity AND link.action='confirm'
       WHERE activity.identity_kind='dm_recipient'
     ),
     matched AS (
       SELECT DISTINCT candidate.workspace_id,candidate.connection_id,candidate.identity_kind,candidate.identity,
         candidate.activity_at,stored.id AS row_id
       FROM candidate JOIN active_contacts stored ON stored.workspace_id=candidate.workspace_id
         AND stored.connection_id=candidate.connection_id AND stored.person_key_kind=candidate.key_kind
         AND stored.person_key=candidate.key
         AND stored.billing_month=date_trunc('month',candidate.activity_at AT TIME ZONE stored.time_zone)::date
     ),
     label AS (
       SELECT id,format('%s %s %s %s:%s',workspace_id,billing_month,connection_id,person_key_kind,person_key) AS text,
         activity_kind,first_activity_at
       FROM active_contacts WHERE person_key IS NOT NULL
     )
     SELECT
       (SELECT array_agg(DISTINCT label.text ORDER BY label.text) FROM matched JOIN label ON label.id=matched.row_id) AS rebuilt,
       (SELECT array_agg(label.text ORDER BY label.text) FROM label
         WHERE label.activity_kind<>'dm_received' OR EXISTS(SELECT 1 FROM matched WHERE matched.row_id=label.id)) AS stored,
       (SELECT array_agg(format('%s %s:%s %s',a.workspace_id,a.identity_kind,a.identity,a.activity_at)) FROM activity a
         WHERE NOT EXISTS(SELECT 1 FROM matched m WHERE m.workspace_id=a.workspace_id AND m.connection_id=a.connection_id
           AND m.identity_kind=a.identity_kind AND m.identity=a.identity AND m.activity_at=a.activity_at)) AS missing,
       (SELECT array_agg(label.text ORDER BY label.text) FROM label
         WHERE NOT EXISTS(SELECT 1 FROM matched WHERE matched.row_id=label.id)) AS unexplained,
       (SELECT array_agg(label.text ORDER BY label.text) FROM label
         WHERE label.activity_kind<>'dm_received' AND NOT EXISTS(SELECT 1 FROM matched
           WHERE matched.row_id=label.id AND matched.activity_at=label.first_activity_at)) AS bad_first`,
  );
  const row = result.rows[0]!;
  return { rebuilt: row.rebuilt ?? [], stored: row.stored ?? [], missing: row.missing ?? [], unexplained: row.unexplained ?? [], badFirst: row.bad_first ?? [] };
}

// Asserts that the stored ledger equals the recompute; unstoredDms is the number of stored inbound DM rows that no
// source explains (DMs of an inbox-disabled account).
async function assertRecomputes(unstoredDms = 0) {
  const result = await recompute();
  assert.deepEqual(result.missing, [], "every source activity has its ledger row");
  assert.deepEqual(result.rebuilt, result.stored, "the rebuilt rows equal the stored rows");
  assert.deepEqual(result.badFirst, [], "first_activity_at is the time of a recorded activity");
  assert.equal(result.unexplained.length, unstoredDms);
}

test("the connected account's own comments are stored but not counted, also by the backfill", async () => {
  await pool.query("UPDATE instagram_connections SET instagram_user_id='555' WHERE id=$1", [seoulConnection]);
  const delivery = { accountId: "100", commentId: "own-1", postId: "1789", senderId: "100", text: "thanks" };
  await ingestComments(pool, [delivery, { ...delivery, commentId: "own-2", senderId: "555" }, { ...delivery, commentId: "c-1", senderId: "7001" }]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_comment_events")).rows[0].n, 3);
  assert.deepEqual(keys(await ledger()), [`${await currentMonth("Asia/Seoul")} comment_sender:7001`]);
  await pool.query("TRUNCATE active_contacts");
  await runBackfill();
  assert.deepEqual(keys(await ledger()), [`${await currentMonth("Asia/Seoul")} comment_sender:7001`]);
  await assertRecomputes();
});

test("a comment counts once per sender and month; a redelivered comment adds nothing", async () => {
  const delivery = { accountId: "100", commentId: "c-1", postId: "1789", senderId: "7001", text: "hello" };
  await ingestComments(pool, [delivery]);
  await ingestComments(pool, [delivery]);
  await ingestComments(pool, [{ ...delivery, commentId: "c-2" }]);
  assert.deepEqual(keys(await ledger()), [`${await currentMonth("Asia/Seoul")} comment_sender:7001`]);
  await ingestComments(pool, [{ ...delivery, commentId: "c-3", senderId: "7002" }]);
  assert.equal((await ledger()).length, 2);
  assert.ok((await ledger()).every((row) => row.activity_kind === "comment" && row.time_zone === "Asia/Seoul"));
  await assertRecomputes();
});

async function currentMonth(timeZone: string): Promise<string> {
  return (await pool.query<{ month: string }>("SELECT date_trunc('month',now() AT TIME ZONE $1)::date::text AS month", [timeZone])).rows[0]!.month;
}

test("the billing month is the calendar month in the workspace time zone at write time", async () => {
  const instants = ["2026-10-31T14:59:59.999Z", "2026-10-31T15:00:00Z", "2026-11-01T06:59:59.999Z", "2026-11-01T07:00:00Z"];
  for (const [index, at] of instants.entries()) {
    await comment(seoul, seoulConnection, `s-${index}`, `80${index}`, at);
    await comment(angeles, angelesConnection, `a-${index}`, `80${index}`, at);
  }
  const months = (rows: LedgerRow[], ws: string) => rows.filter((row) => row.workspace_id === ws).map((row) => `${row.person_key}:${row.billing_month}`);
  const rows = await ledger();
  // Asia/Seoul is UTC+9: midnight of November 1 is 2026-10-31T15:00Z.
  assert.deepEqual(months(rows, seoul), ["800:2026-10-01", "801:2026-11-01", "802:2026-11-01", "803:2026-11-01"]);
  // America/Los_Angeles is UTC-7 until 2026-11-01 09:00Z: midnight of November 1 is 2026-11-01T07:00Z.
  assert.deepEqual(months(rows, angeles), ["800:2026-10-01", "801:2026-10-01", "802:2026-10-01", "803:2026-11-01"]);

  // Inbound DMs follow the same boundary.
  await ingestMessages(pool, [dm("901", "m-1", new Date("2026-10-31T14:59:59.999Z")), dm("902", "m-2", new Date("2026-10-31T15:00:00Z"))]);
  assert.deepEqual(
    (await ledger()).filter((row) => row.activity_kind === "dm_received").map((row) => `${row.person_key}:${row.billing_month}`),
    ["901:2026-10-01", "902:2026-11-01"],
  );

  // A later time zone change moves no stored row; the next write uses the new zone.
  await pool.query("UPDATE workspaces SET time_zone='UTC' WHERE id=$1", [seoul]);
  assert.deepEqual(months(await ledger(), seoul), ["800:2026-10-01", "901:2026-10-01", "801:2026-11-01", "802:2026-11-01", "803:2026-11-01", "902:2026-11-01"]);
  await comment(seoul, seoulConnection, "s-late", "804", "2026-10-31T15:00:00Z");
  const late = (await ledger()).find((row) => row.person_key === "804")!;
  assert.equal(late.billing_month, "2026-10-01");
  assert.equal(late.time_zone, "UTC");
  await assertRecomputes();
});

test("the usage counts this and last billing month by the stored month label in the workspace's current time zone", async () => {
  // Seoul (UTC+9): two October rows and two November rows. Los Angeles (UTC-7): one row each in September, October
  // and November. The same sender twice in one month is one row.
  await comment(seoul, seoulConnection, "s-1", "801", "2026-10-15T00:00:00Z");
  await comment(seoul, seoulConnection, "s-2", "802", "2026-10-31T14:59:59.999Z");
  await comment(seoul, seoulConnection, "s-3", "803", "2026-10-31T15:00:00Z");
  await comment(seoul, seoulConnection, "s-4", "801", "2026-11-02T00:00:00Z");
  await comment(seoul, seoulConnection, "s-5", "801", "2026-11-03T00:00:00Z");
  await comment(angeles, angelesConnection, "a-1", "901", "2026-09-30T12:00:00Z");
  await comment(angeles, angelesConnection, "a-2", "902", "2026-10-31T15:00:00Z");
  await comment(angeles, angelesConnection, "a-3", "903", "2026-11-01T07:00:00Z");
  const at = (ws: string, reference: string) => activeContactUsage(pool, ws, reference);

  // The same instant is November in Seoul and October in Los Angeles.
  assert.deepEqual(await at(seoul, "2026-10-31T15:00:00Z"), { time_zone: "Asia/Seoul", month: "2026-11", count: 2, previous_month: "2026-10", previous_count: 2 });
  assert.deepEqual(await at(angeles, "2026-10-31T15:00:00Z"), { time_zone: "America/Los_Angeles", month: "2026-10", count: 1, previous_month: "2026-09", previous_count: 1 });
  // One millisecond earlier the Seoul month changes back; Los Angeles changes at its own midnight.
  assert.deepEqual(await at(seoul, "2026-10-31T14:59:59.999Z"), { time_zone: "Asia/Seoul", month: "2026-10", count: 2, previous_month: "2026-09", previous_count: 0 });
  assert.equal((await at(angeles, "2026-11-01T06:59:59.999Z")).month, "2026-10");
  assert.deepEqual(await at(angeles, "2026-11-01T07:00:00Z"), { time_zone: "America/Los_Angeles", month: "2026-11", count: 1, previous_month: "2026-10", previous_count: 1 });
  // The previous month of January is December of the year before.
  assert.deepEqual(await at(seoul, "2027-01-05T00:00:00Z"), { time_zone: "Asia/Seoul", month: "2027-01", count: 0, previous_month: "2026-12", previous_count: 0 });

  // A cleared person key still counts.
  await pool.query("UPDATE active_contacts SET person_key=NULL WHERE workspace_id=$1 AND person_key='803'", [seoul]);
  assert.equal((await at(seoul, "2026-10-31T15:00:00Z")).count, 2);

  // A time zone change picks the months by the new zone but moves no stored row: at 2026-11-01T00:00Z Seoul is in
  // November, and after the change to Los Angeles the same instant is October, which reads the two October rows.
  assert.equal((await at(seoul, "2026-11-01T00:00:00Z")).month, "2026-11");
  await pool.query("UPDATE workspaces SET time_zone='America/Los_Angeles' WHERE id=$1", [seoul]);
  assert.deepEqual(await at(seoul, "2026-11-01T00:00:00Z"), { time_zone: "America/Los_Angeles", month: "2026-10", count: 2, previous_month: "2026-09", previous_count: 0 });

  // The dashboard reads the current month of the statement clock.
  await pool.query("UPDATE workspaces SET time_zone='Asia/Seoul' WHERE id=$1", [seoul]);
  await comment(seoul, seoulConnection, "s-now", "804");
  const current = (await workspaceEntitlements(pool, seoul)).usage.active_contacts;
  // Compared with the stored rows of the month the response itself reports, so a midnight between the comment, the
  // entitlement read and this check cannot make it fail.
  const stored = (await pool.query("SELECT count(*)::int AS n FROM active_contacts WHERE workspace_id=$1 AND billing_month=($2||'-01')::date", [seoul, current.month])).rows[0].n;
  assert.equal(current.time_zone, "Asia/Seoul");
  assert.equal(current.count, stored);
  await assert.rejects(activeContactUsage(pool, "99999999-9999-4999-8999-999999999999"), { message: "workspace_required", status: 403 });
});

test("redelivered and reverse-order DMs count once; the row keeps the activity that created it", async () => {
  const later = new Date("2026-10-15T01:00:00Z");
  const earlier = new Date("2026-10-15T00:00:00Z");
  await ingestMessages(pool, [dm("901", "m-later", later)]);
  await ingestMessages(pool, [dm("901", "m-earlier", earlier)]);
  await ingestMessages(pool, [dm("901", "m-later", later)]);
  const rows = await ledger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.first_activity_at.getTime(), later.getTime());
  // One batch with both keeps the earlier one.
  await ingestMessages(pool, [dm("902", "n-later", later), dm("902", "n-earlier", earlier)]);
  assert.equal((await ledger()).find((row) => row.person_key === "902")!.first_activity_at.getTime(), earlier.getTime());
  await assertRecomputes();
});

test("inbound DMs of an inbox-disabled account and confirmation postbacks count; future and malformed IDs do not", async () => {
  await pool.query("UPDATE instagram_connections SET inbox_enabled=false,inbox_enabled_at=NULL WHERE id=$1", [seoulConnection]);
  const now = new Date();
  await ingestMessages(pool, [dm("501", "m-1", now), { ...dm("502", "m-2", now), confirmationReplyId: "1" }, dm("abc", "m-3", now), dm("1".repeat(41), "m-4", now), dm("503", "m-5", new Date(now.getTime() + 600_000)), dm("504", "m-6", now, "999")]);
  const rows = await ledger();
  assert.deepEqual(
    rows.map((row) => `${row.person_key_kind}:${row.person_key}:${row.activity_kind}`),
    ["dm_recipient:501:dm_received", "dm_recipient:502:dm_received"],
  );
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_inbox_messages")).rows[0].n, 0);
  // Nothing stored the DMs, so the two rows have no source to recompute from.
  await assertRecomputes(2);
});

test("a send counts only when it becomes sent", async () => {
  const event = await comment(seoul, seoulConnection, "c-1", "7001", "2026-09-10T00:00:00Z");
  const failed = await queueReply(seoul, seoulConnection, event, "7001", "c-1");
  const before = keys(await ledger());
  assert.deepEqual(before, ["2026-09-01 comment_sender:7001"]);
  for (const status of ["sending", "failed", "blocked", "unknown", "pending"]) {
    await pool.query("UPDATE private_reply_outbox SET status=$2,attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE id=$1", [failed, status]);
    assert.deepEqual(keys(await ledger()), before, status);
  }
  await sendReply(failed, "8001");
  const month = await currentMonth("Asia/Seoul");
  assert.deepEqual(keys(await ledger()), [...before, `${month} comment_sender:7001`]);
  assert.equal((await ledger())[1]!.activity_kind, "private_reply");
  // Another update of a sent row records nothing new.
  await pool.query("TRUNCATE active_contacts");
  await pool.query("UPDATE private_reply_outbox SET failure_code=NULL WHERE id=$1", [failed]);
  assert.deepEqual(await ledger(), []);

  // A follow reply counts for the comment sender of its private reply.
  await pool.query("INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text) VALUES($1,$2,'8001','ok','yes','no')", [failed, seoulConnection]);
  await pool.query("INSERT INTO instagram_follow_messages(connection_id,reply_id,provider_message_id,follow_status,sent_at) VALUES($1,$2,'follow-1','following',now())", [seoulConnection, failed]);
  await pool.query("INSERT INTO instagram_follow_messages(connection_id,reply_id,provider_message_id,follow_status,sent_at) VALUES($1,$2,'follow-0','following',NULL)", [seoulConnection, failed]);
  assert.deepEqual(
    (await ledger()).map((row) => `${row.person_key_kind}:${row.person_key}:${row.activity_kind}`),
    ["comment_sender:7001:follow_message"],
  );
});

test("manual replies, campaign deliveries and DM flow deliveries count only when sent", async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await seedWorkspace(pool, seoul, owner, seoulConnection, "100");
  await pool.query("TRUNCATE active_contacts");
  const count = async () => (await ledger()).length;
  // Not sent: a failed or unknown manual reply, a cancelled campaign row, a blocked DM flow row.
  await pool.query("UPDATE instagram_manual_replies SET status='unknown'");
  await pool.query("UPDATE campaign_deliveries SET status='cancelled'");
  await pool.query("UPDATE flow_dm_deliveries SET status='blocked',attempt_id=gen_random_uuid(),attempt_started_at=now(),failure_code='recipient_opted_out'");
  assert.equal(await count(), 0);
  await pool.query("UPDATE campaign_deliveries SET status='sent',attempt_id=gen_random_uuid(),attempt_started_at=now(),provider_message_id='c-mid',sent_at=now()");
  await pool.query("UPDATE flow_dm_deliveries SET status='sent',failure_code=NULL,provider_message_id='f-mid',sent_at=now()");
  assert.deepEqual(
    (await ledger()).map((row) => `${row.person_key_kind}:${row.person_key}:${row.activity_kind}`),
    ["dm_recipient:900:campaign", "dm_recipient:901:flow_dm"],
  );
  // The manual reply goes to 900 in the same month, so it adds no row.
  await pool.query("UPDATE instagram_manual_replies SET status='sent',provider_message_id='m-mid',sent_at=now()");
  assert.equal(await count(), 2);
  await pool.query("UPDATE instagram_manual_replies SET status='sent',provider_message_id='m-mid',sent_at=now()-interval '62 days'");
  assert.equal(await count(), 2, "a sent row that stays sent fires nothing");
});

async function linkedSender(recipient: string): Promise<string | null> {
  return (await pool.query<{ sender: string | null }>("SELECT public.active_contact_linked_sender($1,$2,$3) AS sender", [seoul, seoulConnection, recipient])).rows[0]!.sender;
}

// The inbox's own reading of the same link: confirmed, and its evidence is the current verified evidence.
async function inboxLinkedSender(recipient: string): Promise<string | null> {
  const rows = (
    await pool.query<{ sender_id: string }>(
      `WITH verified AS (${verifiedDmRecipientsSql("workspace_id=$1 AND id=$2")})
       SELECT link.sender_id FROM instagram_contact_identity_links link
       JOIN verified ON verified.recipient_id=link.recipient_id AND verified.sender_id=link.sender_id
         AND verified.evidence_reply_id=link.evidence_reply_id::text
       WHERE link.workspace_id=$1 AND link.connection_id=$2 AND link.recipient_id=$3 AND link.state='confirmed'`,
      [seoul, seoulConnection, recipient],
    )
  ).rows;
  return rows[0]?.sender_id ?? null;
}

async function confirmLink(recipient: string, sender: string, evidence: string, state: "confirmed" | "detached" = "confirmed") {
  const event = (
    await pool.query(
      `INSERT INTO instagram_contact_identity_link_events(workspace_id,connection_id,recipient_id,sender_id,action,version,evidence_reply_id,request_key,actor_id)
       VALUES($1,$2,$3,$4,'confirm',1,$5,gen_random_uuid(),$6) RETURNING id`,
      [seoul, seoulConnection, recipient, sender, evidence, owner],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_contact_identity_links(workspace_id,connection_id,recipient_id,sender_id,state,version,evidence_reply_id,last_event_id)
     VALUES($1,$2,$3,$4,$5,1,$6,$7)
     ON CONFLICT(workspace_id,connection_id,recipient_id) DO UPDATE SET sender_id=excluded.sender_id,state=excluded.state,
       evidence_reply_id=excluded.evidence_reply_id,last_event_id=excluded.last_event_id`,
    [seoul, seoulConnection, recipient, sender, state, state === "confirmed" ? evidence : null, event],
  );
}

async function storeInbox(recipient: string, messageId: string) {
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,$4,'hello','text',now()-interval '1 hour')`,
    [seoul, seoulConnection, recipient, messageId],
  );
}

test("the linked comment sender follows the inbox's current-validity rule", async () => {
  const assertBoth = async (recipient: string, expected: string | null, label: string) => {
    assert.equal(await linkedSender(recipient), expected, label);
    assert.equal(await inboxLinkedSender(recipient), expected, `inbox: ${label}`);
  };
  const event = await comment(seoul, seoulConnection, "c-1", "7001", "2026-09-10T00:00:00Z");
  const reply = await queueReply(seoul, seoulConnection, event, "7001", "c-1");
  await sendReply(reply, "8001", "2026-09-10T01:00:00Z");
  await assertBoth("8001", null, "no link");
  await confirmLink("8001", "7001", reply);
  await assertBoth("8001", null, "no stored inbox message");
  await storeInbox("8001", "in-1");
  await assertBoth("8001", "7001", "valid");
  // Not fresh: the reply was sent before the inbox was enabled.
  await pool.query("UPDATE instagram_connections SET inbox_enabled_at='2026-09-11T00:00:00Z' WHERE id=$1", [seoulConnection]);
  await assertBoth("8001", null, "not fresh");
  await pool.query("UPDATE instagram_connections SET inbox_enabled_at='2026-09-01T00:00:00Z' WHERE id=$1", [seoulConnection]);
  // A newer fresh reply replaces the evidence.
  const second = await comment(seoul, seoulConnection, "c-2", "7001", "2026-09-12T00:00:00Z");
  await pool.query("UPDATE instagram_comment_events SET media_id='1790' WHERE id=$1", [second]);
  await ruleFor(seoul, seoulConnection);
  const newer = (
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text)
       VALUES($1,$2,$3,$4,'c-2','1790','7001','reply') RETURNING id`,
      [seoul, seoulConnection, second, rule],
    )
  ).rows[0].id;
  await sendReply(newer, "8001", "2026-09-12T01:00:00Z");
  await assertBoth("8001", null, "evidence replaced");
  await confirmLink("8001", "7001", newer);
  await assertBoth("8001", "7001", "valid again");
  // A reply from another comment sender to the same recipient makes the bridge ambiguous.
  const other = await comment(seoul, seoulConnection, "c-3", "7002", "2026-09-13T00:00:00Z");
  const ambiguous = await queueReply(seoul, seoulConnection, other, "7002", "c-3");
  await sendReply(ambiguous, "8001", "2026-09-13T01:00:00Z");
  await assertBoth("8001", null, "ambiguous");
  await pool.query("UPDATE private_reply_outbox SET recipient_id='8002' WHERE id=$1", [ambiguous]);
  await assertBoth("8001", "7001", "unambiguous again");
  await confirmLink("8001", "7001", newer, "detached");
  await assertBoth("8001", null, "detached");
});

test("an identity link changes the person key of later writes only", async () => {
  const event = await comment(seoul, seoulConnection, "c-1", "7001", "2026-09-10T00:00:00Z");
  const reply = await queueReply(seoul, seoulConnection, event, "7001", "c-1");
  await sendReply(reply, "8001", "2026-09-10T01:00:00Z");
  await ingestMessages(pool, [dm("8001", "m-1", new Date("2026-09-20T00:00:00Z"))]);
  const month = "2026-10-01";
  await ingestMessages(pool, [dm("8001", "m-2", new Date("2026-10-15T00:00:00Z"))]);
  const unlinked = keys(await ledger());
  assert.deepEqual(unlinked, ["2026-09-01 comment_sender:7001", "2026-09-01 dm_recipient:8001", `${month} dm_recipient:8001`]);

  await confirmLink("8001", "7001", reply);
  assert.equal(await linkedSender("8001"), "7001");
  await ingestMessages(pool, [dm("8001", "m-3", new Date("2026-10-15T01:00:00Z"))]);
  // The September rows and October's earlier DM row stay; the later DM is the comment sender's October row.
  assert.deepEqual(keys(await ledger()), [...unlinked.slice(0, 2), `${month} comment_sender:7001`, unlinked[2]]);
  await assertRecomputes();

  // Detaching changes no stored row either.
  await confirmLink("8001", "7001", reply, "detached");
  const linked = await ledger();
  await ingestMessages(pool, [dm("8001", "m-4", new Date("2026-10-15T02:00:00Z"))]);
  assert.deepEqual(await ledger(), linked);
});

// Settles within `ms` or rejects, so a write that waits on a lock without a bound fails the test instead of hanging.
function within<T>(promise: Promise<T>, ms = 6000): Promise<T> {
  return Promise.race([promise, delay(ms, undefined, { ref: false }).then(() => Promise.reject(new Error(`not settled within ${ms} ms`)))]);
}

test("a ledger write that waits on another transaction's key gives up after lock_timeout; the source write commits", async () => {
  const month = await currentMonth("Asia/Seoul");
  const event = await comment(seoul, seoulConnection, "c-old", "7002", "2026-09-10T00:00:00Z");
  const reply = await queueReply(seoul, seoulConnection, event, "7002", "c-old");
  // Another transaction holds this month's keys of three people, uncommitted.
  const holder = await pool.connect();
  const warnings: string[] = [];
  const warn = console.warn;
  try {
    await holder.query("BEGIN");
    await holder.query(
      `INSERT INTO active_contacts(workspace_id,billing_month,connection_id,person_key_kind,person_key,first_activity_at,activity_kind,time_zone)
       SELECT $1,$2::date,$3,kind,key,now(),'comment','Asia/Seoul' FROM (VALUES('comment_sender','7001'),('comment_sender','7002'),('dm_recipient','8001')) AS held(kind,key)`,
      [seoul, month, seoulConnection],
    );
    console.warn = (line: string) => warnings.push(line);
    const started = Date.now();
    await within(ingestComments(pool, [{ accountId: "100", commentId: "c-1", postId: "1789", senderId: "7001", text: "hello" }]));
    await within(sendReply(reply, "8002"));
    await within(ingestMessages(pool, [dm("8001", "m-1", new Date())]));
    // Three waits of about 2 s each, never the holder's whole transaction.
    assert.ok(Date.now() - started < 9000);
  } finally {
    console.warn = warn;
    await holder.query("ROLLBACK");
    holder.release();
  }
  assert.deepEqual(
    warnings.map((line) => JSON.parse(line)),
    [
      { event: "active_contact_ledger_failed", code: "comment_record_failed" },
      { event: "active_contact_ledger_failed", code: "inbound_dm_record_failed" },
    ],
  );
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_comment_events WHERE comment_id='c-1'")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT status FROM private_reply_outbox WHERE id=$1", [reply])).rows[0].status, "sent");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_inbox_messages WHERE message_id='m-1'")).rows[0].n, 1);
  // The three skipped writes left no row of this month; the holder rolled its rows back.
  assert.deepEqual(keys(await ledger()), ["2026-09-01 comment_sender:7002"]);
});

test("a workspace whose time zone AT TIME ZONE rejects is skipped without dropping the other workspaces' rows", async () => {
  await pool.query("UPDATE workspaces SET time_zone='Invalid/Zone' WHERE id=$1", [seoul]);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (line: string) => warnings.push(line);
  try {
    // One batch, one ledger statement, two workspaces.
    await ingestComments(pool, [
      { accountId: "100", commentId: "c-1", postId: "1789", senderId: "7001", text: "hello" },
      { accountId: "200", commentId: "c-2", postId: "1789", senderId: "7001", text: "hello" },
    ]);
    await ingestMessages(pool, [dm("8001", "m-1", new Date()), dm("8001", "m-2", new Date(), "200")]);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    (await ledger()).map((row) => `${row.workspace_id === angeles ? "angeles" : "seoul"} ${row.person_key_kind}:${row.person_key}`),
    ["angeles comment_sender:7001", "angeles dm_recipient:8001"],
  );
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_comment_events")).rows[0].n, 2);
  assert.equal((await pool.query("SELECT public.active_contact_time_zone_valid('Asia/Seoul') AND NOT public.active_contact_time_zone_valid('Invalid/Zone') AS ok")).rows[0].ok, true);
});

// Waits until the backend with this application name waits on a lock, or until `done` reports that it finished.
async function waitForLock(applicationName: string, done: () => boolean = () => false) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (done()) return;
    const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [applicationName]);
    if (waiting.rowCount) return;
    await delay(25);
  }
  throw new Error(`${applicationName} never waited on a lock`);
}

test("a comment and the send finalize of the same sender's queued reply both commit", async () => {
  // 7001 commented last month, so neither transaction finds a ledger row of this month; its reply is being sent.
  const event = await comment(seoul, seoulConnection, "c-1", "7001", "2026-09-10T00:00:00Z");
  const reply = await queueReply(seoul, seoulConnection, event, "7001", "c-1");
  await pool.query("UPDATE private_reply_outbox SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE id=$1", [reply]);
  // The ingestion keeps the default deadlock_timeout and the finalize a longer one, so if the two formed a cycle the
  // ingestion would be the transaction that PostgreSQL aborts.
  const ingest = new Pool({ connectionString: databaseUrl, application_name: "ledger-race-ingest", max: 1 });
  const send = new Pool({ connectionString: databaseUrl, application_name: "ledger-race-send", max: 1, options: "-c deadlock_timeout=10s" });
  const pause = await pool.connect();
  try {
    // Holding the rule table pauses the ingestion after its comment insert, at its rule read, before the reply insert.
    await pause.query("BEGIN");
    await pause.query("LOCK TABLE instagram_comment_rules IN ACCESS EXCLUSIVE MODE");
    const ingestion = ingestComments(ingest, [{ accountId: "100", commentId: "c-2", postId: "1789", senderId: "7001", text: "link" }]).then(
      () => "committed",
      (error: { code?: string }) => error.code ?? "error",
    );
    await waitForLock("ledger-race-ingest");
    let finalized = false;
    // The private reply worker's sent update, while the ingestion is paused.
    const finalize = send
      .query("UPDATE private_reply_outbox SET status='sent',provider_message_id='mid-race',recipient_id='8001',sent_at=now() WHERE id=$1 AND status='sending'", [reply])
      .then(
        () => "committed",
        (error: { code?: string }) => error.code ?? "error",
      )
      .finally(() => {
        finalized = true;
      });
    await waitForLock("ledger-race-send", () => finalized);
    await pause.query("COMMIT");
    assert.deepEqual(await Promise.all([ingestion, finalize]), ["committed", "committed"]);
  } finally {
    await pause.query("ROLLBACK").catch(() => undefined);
    pause.release();
    await ingest.end();
    await send.end();
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_comment_events WHERE sender_id='7001'")).rows[0].n, 2);
  assert.equal((await pool.query("SELECT status FROM private_reply_outbox WHERE id=$1", [reply])).rows[0].status, "sent");
  const month = await currentMonth("Asia/Seoul");
  assert.deepEqual(keys(await ledger()), ["2026-09-01 comment_sender:7001", `${month} comment_sender:7001`]);
  await assertRecomputes();
});

async function seedActivity() {
  await pool.query("TRUNCATE workspaces CASCADE");
  await seedWorkspace(pool, seoul, owner, seoulConnection, "100");
  await pool.query("UPDATE instagram_connections SET active=true WHERE id=$1", [seoulConnection]);
  await workspace(angeles, "America/Los_Angeles", angelesConnection, "200");
  await recordComments();
  await pool.query("UPDATE campaign_deliveries SET status='sent',attempt_id=gen_random_uuid(),attempt_started_at=now(),provider_message_id='c-mid',sent_at=now()");
  await pool.query("UPDATE flow_dm_deliveries SET status='sent',attempt_id=gen_random_uuid(),attempt_started_at=now(),provider_message_id='f-mid',sent_at=now()");
  await comment(seoul, seoulConnection, "other-1", "7777");
  await ingestMessages(pool, [dm("8888", "m-other", new Date(Date.now() - 60_000)), dm("900", "m-900", new Date(Date.now() - 60_000))]);
}

async function keyedRows(where: string): Promise<number> {
  return (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM active_contacts WHERE person_key IS NOT NULL AND ${where}`)).rows[0]!.n;
}

async function assertNoInstagramId(where: string) {
  const left = (await pool.query(`SELECT person_key FROM active_contacts WHERE person_key IS NOT NULL AND ${where}`)).rows;
  assert.deepEqual(left, []);
}

test("person deletion keeps the month count and clears the person's keys", async () => {
  await seedActivity();
  const counts = await monthCounts();
  const people = keys(await ledger());
  assert.ok(people.some((key) => key.endsWith("comment_sender:123")) && people.some((key) => key.endsWith("dm_recipient:900")));
  const keyed = await keyedRows(`connection_id='${seoulConnection}' AND person_key IN ('123','900')`);
  assert.ok(keyed > 1);
  const record = (await pool.query("SELECT public.delete_person_data($1,$2,$3,'comment_sender','123') AS result", [seoul, seoulConnection, owner])).rows[0].result;
  // The deletion record counts the ledger rows whose key it cleared.
  assert.equal(record.retained_counts.active_contacts, keyed);
  assert.equal(record.deleted_counts.active_contacts, undefined, "no ledger row is deleted");
  assert.deepEqual(await monthCounts(), counts);
  // The reply bridge ties 123 to 900, so both keys are cleared; the others stay.
  await assertNoInstagramId("person_key IN ('123','900')");
  assert.deepEqual(
    (await ledger()).filter((row) => row.person_key).map((row) => row.person_key),
    ["124", "7777", "8888", "901"],
  );
  // The same person active again later in the month is a new row.
  await comment(seoul, seoulConnection, "back-1", "123");
  assert.equal(
    Object.values(await monthCounts()).reduce((a, b) => a + b),
    Object.values(counts).reduce((a, b) => a + b) + 1,
  );
  await assertRecomputes(1);
});

test("connection deletion keeps the month count and leaves no Instagram ID of the connection", async () => {
  await seedActivity();
  await comment(angeles, angelesConnection, "a-1", "123");
  const counts = await monthCounts();
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1", [seoulConnection]);
  // A key that an earlier person deletion cleared is not counted again.
  await pool.query("UPDATE active_contacts SET person_key=NULL WHERE connection_id=$1 AND person_key='124'", [seoulConnection]);
  const keyed = await keyedRows(`connection_id='${seoulConnection}'`);
  assert.ok(keyed > 1);
  const record = (await pool.query("SELECT public.delete_connection_data($1,$2,$3,'100') AS result", [seoul, seoulConnection, owner])).rows[0].result;
  assert.equal(record.retained_counts.active_contacts, keyed);
  assert.equal(record.deleted_counts.active_contacts, undefined, "no ledger row is deleted");
  assert.deepEqual(await monthCounts(), counts);
  await assertNoInstagramId(`connection_id='${seoulConnection}'`);
  assert.equal((await ledger()).filter((row) => row.person_key).length, 1, "the other workspace keeps its key");
});

test("workspace deletion keeps the month count and leaves no Instagram ID of the workspace", async () => {
  await seedActivity();
  await comment(angeles, angelesConnection, "a-1", "123");
  const counts = await monthCounts();
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE workspace_id=$1", [seoul]);
  const record = (await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [seoul, owner])).rows[0].result;
  // The workspace deletion record holds only deleted counts, and the ledger rows are not deleted.
  assert.equal(record.deleted_counts.active_contacts, undefined);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM workspaces WHERE id=$1", [seoul])).rows[0].n, 0);
  assert.deepEqual(await monthCounts(), counts);
  await assertNoInstagramId(`workspace_id='${seoul}'`);
  assert.equal((await ledger()).filter((row) => row.person_key).length, 1, "the other workspace keeps its key");
});

// Runs deploy/backfill-active-contacts.sql as psql -f would, minus its psql meta-commands (\\set ON_ERROR_STOP), which
// are not SQL.
async function runBackfill(): Promise<void> {
  const script = await readFile(new URL("../../deploy/backfill-active-contacts.sql", import.meta.url), "utf8");
  assert.match(script, /^\\set ON_ERROR_STOP on$/m);
  await pool.query(script.replace(/^\\.*$/gm, ""));
}

test("the one-off backfill records only each workspace's current billing month and skips an unknown zone", async () => {
  await seedActivity();
  await comment(seoul, seoulConnection, "old-1", "6001", "2026-09-10T00:00:00Z");
  await pool.query("UPDATE workspaces SET time_zone='Invalid/Zone' WHERE id=$1", [angeles]);
  await pool.query("INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'a-1','1789','123','text')", [angeles, angelesConnection]);
  const recorded = keys((await ledger()).filter((row) => row.billing_month !== "2026-09-01" && row.workspace_id === seoul && row.activity_kind !== "dm_received"));
  await pool.query("TRUNCATE active_contacts");

  await runBackfill();
  const backfilled = await ledger();
  const month = await currentMonth("Asia/Seoul");
  assert.ok(backfilled.length > 0);
  // Earlier months stay empty, and the workspace with an unknown zone is skipped.
  assert.ok(backfilled.every((row) => row.workspace_id === seoul && row.billing_month === month));
  for (const key of recorded) assert.ok(keys(backfilled).includes(key), key);
  // The inbound DM of 8888 is found through the inbox, the DM start events or the latest inbound time.
  assert.ok(keys(backfilled).some((key) => key.endsWith("dm_recipient:8888")));
  // The script holds no session setting after it commits.
  assert.notEqual((await pool.query("SHOW lock_timeout")).rows[0].lock_timeout, "2s");
});

test("the one-off backfill does not count again a person that a live write recorded before an identity link", async () => {
  // A DM of 8001 this month is recorded live under 8001; a link to 7001 is confirmed afterwards.
  const event = await comment(seoul, seoulConnection, "c-1", "7001", "2026-09-10T00:00:00Z");
  const reply = await queueReply(seoul, seoulConnection, event, "7001", "c-1");
  await sendReply(reply, "8001", "2026-09-10T01:00:00Z");
  await ingestMessages(pool, [dm("8001", "m-1", new Date(Date.now() - 60_000))]);
  await confirmLink("8001", "7001", reply);
  assert.equal(await linkedSender("8001"), "7001");
  const stored = await ledger();
  assert.ok(keys(stored).some((key) => key.endsWith("dm_recipient:8001")));

  // The backfill resolves the same DM to comment_sender:7001, but the month already has 8001's row.
  await runBackfill();
  assert.deepEqual(await ledger(), stored);
});

test("the one-off backfill does not count again a person that a live write recorded before the link was detached", async () => {
  // While 8001 → 7001 is valid, a live DM of 8001 this month is recorded under 7001; the link is detached afterwards.
  const event = await comment(seoul, seoulConnection, "c-1", "7001", "2026-09-10T00:00:00Z");
  const reply = await queueReply(seoul, seoulConnection, event, "7001", "c-1");
  await sendReply(reply, "8001", "2026-09-10T01:00:00Z");
  await storeInbox("8001", "m-0");
  await confirmLink("8001", "7001", reply);
  assert.equal(await linkedSender("8001"), "7001");
  await ingestMessages(pool, [dm("8001", "m-1", new Date(Date.now() - 60_000))]);
  await confirmLink("8001", "7001", reply, "detached");
  assert.equal(await linkedSender("8001"), null);
  const stored = await ledger();
  assert.ok(keys(stored).some((key) => key.endsWith("comment_sender:7001")));
  const month = await currentMonth("Asia/Seoul");
  assert.ok(!keys(stored).some((key) => key.startsWith(`${month} dm_recipient:8001`)));

  // The backfill resolves the same DM to dm_recipient:8001 now, but a confirm event links it to 7001's row.
  await runBackfill();
  assert.deepEqual(await ledger(), stored);
});

test("re-running migration 077 writes no ledger row, even after an identity link changed, and keeps the canonical objects", async () => {
  const definitions = async () =>
    (
      await pool.query(
        `SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc
         WHERE proname IN ('delete_person_data','delete_connection_data','delete_workspace_data','active_contact_linked_sender',
           'active_contact_time_zone_valid','record_active_contacts','record_active_contact_activity') ORDER BY proname`,
      )
    ).rows;
  const triggers = async () => (await pool.query("SELECT tgrelid::regclass::text AS relation,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname='record_active_contact' ORDER BY 1")).rows;
  const canonical = await definitions();
  const canonicalTriggers = await triggers();
  assert.equal(canonical.length, 7);
  assert.equal(canonicalTriggers.length, 5);

  // A DM of 8001 this month is recorded under 8001; a link to 7001 is confirmed afterwards.
  const event = await comment(seoul, seoulConnection, "c-1", "7001", "2026-09-10T00:00:00Z");
  const reply = await queueReply(seoul, seoulConnection, event, "7001", "c-1");
  await sendReply(reply, "8001", "2026-09-10T01:00:00Z");
  await ingestMessages(pool, [dm("8001", "m-1", new Date(Date.now() - 60_000))]);
  await confirmLink("8001", "7001", reply);
  assert.equal(await linkedSender("8001"), "7001");
  const stored = await ledger();

  // The runner replays 077 on every rollout; a backfill in it would now record this month's DM under 7001 too. 078
  // redefines the connection and person deletion functions after it, as the runner does.
  const migration = await readFile(new URL("../../db/migrations/077_active_contacts.sql", import.meta.url), "utf8");
  const counts = await readFile(new URL("../../db/migrations/078_active_contact_deletion_counts.sql", import.meta.url), "utf8");
  for (let run = 0; run < 2; run++) {
    await pool.query(migration);
    await pool.query(counts);
  }
  assert.deepEqual(await ledger(), stored);
  assert.deepEqual(await definitions(), canonical);
  assert.deepEqual(await triggers(), canonicalTriggers);
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(runner.indexOf("077_active_contacts.sql") > runner.indexOf("076_instagram_dm_profiles.sql") && runner.indexOf("077_active_contacts.sql") < runner.indexOf("supabase-access.sql"));
  assert.ok(runner.indexOf("078_active_contact_deletion_counts.sql") > runner.indexOf("077_active_contacts.sql") && runner.indexOf("078_active_contact_deletion_counts.sql") < runner.indexOf("supabase-access.sql"));
  assert.ok(!runner.includes("backfill-active-contacts"), "the one-off backfill is not part of the runner");
});
