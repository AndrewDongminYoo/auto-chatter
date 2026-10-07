import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { dueLocalSql, localDueSql } from "./inbox-reminders.ts";
import { EXCLUDED_TABLES, EXPORTED_TABLES } from "./workspace-export.ts";
import { ingestMessages } from "../instagram/follow-flow.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const owner = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const admin = { id: "22222222-2222-4222-8222-222222222222", email: "admin@example.test" };
const agent = { id: "33333333-3333-4333-8333-333333333333", email: "agent@example.test" };
const other = { id: "44444444-4444-4444-8444-444444444444", email: "other@example.test" };
const outsider = { id: "55555555-5555-4555-8555-555555555555", email: "outsider@example.test" };
const stranger = { id: "56565656-5656-4565-8565-565656565656", email: "stranger@example.test" };
const workspaceId = "66666666-6666-4666-8666-666666666666";
const otherWorkspaceId = "77777777-7777-4777-8777-777777777777";
const connectionId = "88888888-8888-4888-8888-888888888888";
const secondConnectionId = "99999999-9999-4999-8999-999999999999";
const foreignConnectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };

type Actor = { id: string; email: string };
type Reminder = {
  id: string;
  connection_id: string;
  recipient_id: string;
  due_at: string;
  due_local: string;
  time_zone: string;
  due: boolean;
  note: string | null;
  status: string;
  cancel_reason: string | null;
  version: number;
};
type ListedReminder = { id: string; due_at: string; due_local: string; due: boolean; version: number; note: string };
type Conversation = { connection_id: string; recipient_id: string; reminder: ListedReminder | null };
type InboxPage = { conversations: Conversation[]; after: string | null; due_reminder_count: number };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces, workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role,email)
     VALUES($1,$2,'owner',$3),($1,$4,'admin',$5),($1,$6,'agent',$7),($1,$8,'agent',$9),($10,$11,'owner',$12)`,
    [
      workspaceId,
      owner.id,
      owner.email,
      admin.id,
      admin.email,
      agent.id,
      agent.email,
      other.id,
      other.email,
      otherWorkspaceId,
      outsider.id,
      outsider.email,
    ],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,active,inbox_enabled,inbox_enabled_at)
     VALUES($1,$4,'123','shop',false,true,now()-interval '1 day'),($2,$4,'124','studio',false,true,now()-interval '1 day'),
       ($3,$5,'125','foreign',false,true,now()-interval '1 day')`,
    [connectionId, secondConnectionId, foreignConnectionId, workspaceId, otherWorkspaceId],
  );
});

after(async () => pool.end());

type Connect = () => Promise<unknown>;

function request(
  actor: Actor,
  method: string,
  path: string,
  body?: unknown,
  connect: Connect = pool.connect.bind(pool),
  origin = "https://app.test",
) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin, cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect, end: async () => {} }) as unknown as Pool,
    (async () => Response.json({ id: actor.id, email: actor.email, email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

async function body<T>(response: Response, status: number): Promise<T> {
  const value = (await response.json()) as T;
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

async function errorCode(response: Response, status: number): Promise<string> {
  return (await body<{ error: string }>(response, status)).error;
}

async function seed(recipient: string, text = "hello", at = "2026-10-01T00:00:01Z", connection = connectionId) {
  const workspace = connection === foreignConnectionId ? otherWorkspaceId : workspaceId;
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,gen_random_uuid()::text,$4,'text',$5::timestamptz)`,
    [workspace, connection, recipient, text, at],
  );
}

// The wall-clock minute `offset` from now in a time zone, as the screen's datetime-local input sends it.
async function localIn(offset: string, zone = "Asia/Seoul"): Promise<string> {
  return (await pool.query(`SELECT ${dueLocalSql("now()+$1::interval", "$2::text")} AS local`, [offset, zone])).rows[0]
    .local;
}

const remindersPath = (recipient = "456", connection = connectionId) =>
  `/api/inbox/conversations/${connection}/${recipient}/reminders`;
const create = (actor: Actor, dueLocal: unknown, note?: unknown, recipient = "456", connection = connectionId) =>
  request(actor, "POST", remindersPath(recipient, connection), {
    due_local: dueLocal,
    ...(note === undefined ? {} : { note }),
  });
async function created(actor: Actor, recipient = "456", offset = "1 day", connection = connectionId) {
  return body<Reminder>(await create(actor, await localIn(offset), undefined, recipient, connection), 201);
}
const patch = (actor: Actor, id: string, input: unknown) =>
  request(actor, "PATCH", `/api/inbox/reminders/${id}`, input);
const finish = (actor: Actor, id: string, action: "complete" | "cancel", version: number) =>
  request(actor, "POST", `/api/inbox/reminders/${id}/${action}`, { expected_version: version });
const setState = (actor: Actor, input: unknown, recipient = "456") =>
  request(actor, "PUT", `/api/inbox/conversations/${connectionId}/${recipient}/state`, input);

async function reminderRows() {
  return (
    await pool.query(
      `SELECT recipient_id,creator_id,status,cancel_reason,version,note FROM instagram_inbox_reminders
       ORDER BY recipient_id,creator_id,created_at`,
    )
  ).rows;
}
async function eventRows() {
  return (
    await pool.query(
      `SELECT e.recipient_id,e.version,e.kind,e.reason,e.note,e.actor_id FROM instagram_inbox_reminder_events e
       JOIN instagram_inbox_reminders r ON r.id=e.reminder_id ORDER BY r.created_at,e.version`,
    )
  ).rows;
}

// Returns once `operation` either finished or `count` backends wait for a lock. The caller then lets the blocking
// transaction go on in both cases, so a missing lock fails a value assertion instead of a lock-wait timeout.
async function settledOrWaiting(operation: Promise<unknown>, count = 1) {
  let settled = false;
  void operation.finally(() => (settled = true)).catch(() => undefined);
  for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
    const waiting = await pool.query(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()",
    );
    if (waiting.rows[0].waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Runs a request through the real API and holds its transaction just before COMMIT, after its rows were written,
// until `release` is called.
function heldBeforeCommit(actor: Actor, method: string, path: string, payload: unknown) {
  let reached!: () => void;
  let release!: () => void;
  const atCommit = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const connect = async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (text: string, values?: unknown[]) => {
            if (text === "COMMIT") {
              reached();
              await released;
            }
            return target.query(text, values);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const response = request(actor, method, path, payload, connect);
  return { response, atCommit, release };
}

async function reachCommit(held: ReturnType<typeof heldBeforeCommit>) {
  await Promise.race([
    held.atCommit,
    held.response.then((response) => assert.fail(`the request finished before COMMIT with ${response.status}`)),
  ]);
}

const deletionSql = {
  connection: ["SELECT public.delete_connection_data($1,$2,$3,'123') AS result", [workspaceId, connectionId, owner.id]],
  person: [
    "SELECT public.delete_person_data($1,$2,$3,'dm_recipient','456') AS result",
    [workspaceId, connectionId, owner.id],
  ],
  workspace: ["SELECT public.delete_workspace_data($1,$2) AS result", [workspaceId, owner.id]],
} as const;
const runDeletion = (deletion: keyof typeof deletionSql) =>
  pool.query(deletionSql[deletion][0], [...deletionSql[deletion][1]]);

test("a member's reminder is private: other members neither see nor change it", async () => {
  await seed("456");
  const local = await localIn("1 day");
  const reminder = await body<Reminder>(await create(agent, local, "  배송 확인  "), 201);
  const expectedDue = (await pool.query(`SELECT ${localDueSql("$1", "'Asia/Seoul'")} AS due_at`, [`${local}:00`]))
    .rows[0].due_at as Date;
  assert.equal(reminder.due_at, expectedDue.toISOString());
  assert.equal(reminder.due_local, local);
  assert.equal(reminder.time_zone, "Asia/Seoul");
  assert.equal(reminder.due, false);
  assert.equal(reminder.note, "배송 확인");
  assert.equal(reminder.status, "pending");
  assert.equal(reminder.version, 1);
  assert.deepEqual(await eventRows(), [
    { recipient_id: "456", version: 1, kind: "created", reason: null, note: "배송 확인", actor_id: agent.id },
  ]);

  const mine = await body<InboxPage>(await request(agent, "GET", "/api/inbox"), 200);
  assert.deepEqual(mine.conversations[0]!.reminder, {
    id: reminder.id,
    due_at: reminder.due_at,
    due_local: local,
    due: false,
    version: 1,
    note: "배송 확인",
  });
  assert.equal(mine.due_reminder_count, 0);
  const theirs = await body<InboxPage>(await request(other, "GET", "/api/inbox"), 200);
  assert.equal(theirs.conversations[0]!.reminder, null);
  const thread = (actor: Actor) => request(actor, "GET", `/api/connections/${connectionId}/inbox/456`);
  assert.equal((await body<{ reminder: Reminder | null }>(await thread(agent), 200)).reminder?.id, reminder.id);
  assert.equal((await body<{ reminder: Reminder | null }>(await thread(other), 200)).reminder, null);
  const listed = await body<{ reminders: (Reminder & { username: string })[] }>(
    await request(agent, "GET", "/api/inbox/reminders"),
    200,
  );
  assert.deepEqual(
    listed.reminders.map((row) => [row.id, row.username]),
    [[reminder.id, "shop"]],
  );
  assert.deepEqual(
    (await body<{ reminders: Reminder[] }>(await request(other, "GET", "/api/inbox/reminders"), 200)).reminders,
    [],
  );

  // Another member, an admin, the owner and a member of another workspace are all answered as if it did not exist.
  for (const actor of [other, admin, owner, outsider]) {
    assert.equal(
      await errorCode(await patch(actor, reminder.id, { expected_version: 1, note: "x" }), 404),
      "reminder_not_found",
    );
    assert.equal(await errorCode(await finish(actor, reminder.id, "complete", 1), 404), "reminder_not_found");
    assert.equal(await errorCode(await finish(actor, reminder.id, "cancel", 1), 404), "reminder_not_found");
  }
  assert.deepEqual(
    (await reminderRows()).map((row) => [row.status, row.version]),
    [["pending", 1]],
  );
  // Each member keeps their own reminder on the same conversation.
  await created(other);
  assert.equal((await reminderRows()).length, 2);
});

test("local times convert with the workspace time zone; DST gaps and overlaps follow PostgreSQL's rule", async () => {
  const convert = async (local: string, zone: string) => {
    const row = (
      await pool.query(
        `SELECT due_at,${dueLocalSql("due_at", "$2::text")} AS shown
         FROM (SELECT ${localDueSql("$1", "$2::text")} AS due_at) converted`,
        [local, zone],
      )
    ).rows[0];
    return [(row.due_at as Date).toISOString(), row.shown];
  };
  // A time skipped by the spring-forward gap is read with the offset before the change, so it is stored one hour
  // later on the wall clock; a repeated time in the fall-back overlap is read as the later occurrence.
  assert.deepEqual(await convert("2026-03-08T02:30:00", "America/New_York"), [
    "2026-03-08T07:30:00.000Z",
    "2026-03-08T03:30",
  ]);
  assert.deepEqual(await convert("2026-11-01T01:30:00", "America/New_York"), [
    "2026-11-01T06:30:00.000Z",
    "2026-11-01T01:30",
  ]);
  assert.deepEqual(await convert("2027-03-28T02:30:00", "Europe/Berlin"), [
    "2027-03-28T01:30:00.000Z",
    "2027-03-28T03:30",
  ]);
  assert.deepEqual(await convert("2026-10-25T02:30:00", "Europe/Berlin"), [
    "2026-10-25T01:30:00.000Z",
    "2026-10-25T02:30",
  ]);

  // The API converts with the zone the workspace has when the reminder is written.
  await seed("456");
  await pool.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1", [workspaceId]);
  const local = await localIn("2 days", "America/New_York");
  const reminder = await body<Reminder>(await create(agent, local), 201);
  assert.equal(reminder.time_zone, "America/New_York");
  assert.equal(reminder.due_local, local);
  assert.equal(reminder.due_at, (await convert(`${local}:00`, "America/New_York"))[0]);
  // A later time zone change moves no stored reminder; it is only shown in the new zone.
  await pool.query("UPDATE workspaces SET time_zone='Asia/Seoul' WHERE id=$1", [workspaceId]);
  const reread = (
    await body<{ reminder: Reminder }>(await request(agent, "GET", `/api/connections/${connectionId}/inbox/456`), 200)
  ).reminder;
  assert.equal(reread.due_at, reminder.due_at);
  assert.equal(reread.time_zone, "Asia/Seoul");
  assert.equal(
    reread.due_local,
    (await pool.query(`SELECT ${dueLocalSql("$1::timestamptz", "'Asia/Seoul'")} AS shown`, [reminder.due_at])).rows[0]
      .shown,
  );
});

test("the due time must be 1 minute to 90 days ahead, and the request is validated", async () => {
  for (const recipient of ["456", "457", "458"]) await seed(recipient);
  assert.equal(await errorCode(await create(agent, await localIn("0 minutes")), 400), "reminder_due_out_of_range");
  assert.equal(await errorCode(await create(agent, await localIn("-1 day")), 400), "reminder_due_out_of_range");
  assert.equal(
    await errorCode(await create(agent, await localIn("2160 hours 2 minutes")), 400),
    "reminder_due_out_of_range",
  );
  await body<Reminder>(await create(agent, await localIn("2 minutes")), 201);
  await body<Reminder>(await create(agent, await localIn("2160 hours -1 minute"), undefined, "457"), 201);

  for (const value of ["2026-02-30T10:00", "2026-10-05 10:00", "2026-10-05T24:00", "1999-12-31T10:00", 10, null])
    assert.equal(
      await errorCode(await create(agent, value, undefined, "458"), 400),
      "invalid_reminder_due",
      String(value),
    );
  const local = await localIn("1 day");
  assert.equal(await errorCode(await create(agent, local, "가".repeat(201), "458"), 400), "invalid_reminder_note");
  assert.equal(await errorCode(await create(agent, local, 5, "458"), 400), "invalid_reminder_note");
  assert.equal(
    await errorCode(await request(agent, "POST", remindersPath("458"), { due_local: local, extra: 1 }), 400),
    "invalid_reminder_request",
  );
  assert.equal(
    await errorCode(await request(agent, "POST", `${remindersPath("458")}?x=1`, { due_local: local }), 400),
    "invalid_reminder_request",
  );
  assert.equal(await errorCode(await create(agent, local, undefined, "999"), 404), "conversation_not_found");
  assert.equal(
    await errorCode(await create(agent, local, undefined, "456", foreignConnectionId), 404),
    "connection_not_found",
  );
  // 200 code points after trimming fit (an emoji is one code point but two UTF-16 units); blank text is no note.
  const longest = await body<Reminder>(await create(agent, local, ` ${"😀".repeat(200)} `, "458"), 201);
  assert.equal([...longest.note!].length, 200);
  assert.equal(
    (await body<Reminder>(await patch(agent, longest.id, { expected_version: 1, note: "   " }), 200)).note,
    null,
  );
  for (const input of [
    { expected_version: 2 },
    { expected_version: 0, note: "x" },
    { expected_version: "2", note: "x" },
    { expected_version: 2, note: "x", status: "done" },
  ])
    assert.equal(
      await errorCode(await patch(agent, longest.id, input), 400),
      "invalid_reminder_request",
      JSON.stringify(input),
    );
  assert.equal(
    await errorCode(await request(agent, "POST", `/api/inbox/reminders/${longest.id}/complete`, {}), 400),
    "invalid_reminder_request",
  );
  assert.equal(
    await errorCode(await request(agent, "GET", "/api/inbox/reminders?due=yes"), 400),
    "invalid_reminder_request",
  );
  assert.equal(await errorCode(await request(agent, "GET", "/api/inbox?reminder=all"), 400), "invalid_inbox_query");
});

test("a member holds one pending reminder per conversation; a second create answers with it", async () => {
  await seed("456");
  await seed("457");
  const first = await created(agent);
  const again = await body<{ error: string; reminder: Reminder }>(await create(agent, await localIn("2 days")), 409);
  assert.equal(again.error, "reminder_exists");
  assert.equal(again.reminder.id, first.id);
  assert.equal((await reminderRows()).length, 1);
  const done = await body<Reminder>(await finish(agent, first.id, "complete", 1), 200);
  assert.deepEqual([done.status, done.version, done.due], ["done", 2, false]);
  const next = await created(agent);
  assert.notEqual(next.id, first.id);

  // Two creates at once: the second waits for the first and then answers with it.
  const held = heldBeforeCommit(agent, "POST", remindersPath("457"), { due_local: await localIn("1 day") });
  try {
    await reachCommit(held);
    const second = create(agent, await localIn("3 days"), undefined, "457");
    await settledOrWaiting(second);
    held.release();
    const winner = await body<Reminder>(await held.response, 201);
    const loser = await body<{ error: string; reminder: Reminder }>(await second, 409);
    assert.equal(loser.error, "reminder_exists");
    assert.equal(loser.reminder.id, winner.id);
  } finally {
    held.release();
  }
  assert.deepEqual(
    (await reminderRows()).map((row) => [row.recipient_id, row.status]),
    [
      ["456", "done"],
      ["456", "pending"],
      ["457", "pending"],
    ],
  );
});

test("changes need the expected version and write one audit row per version", async () => {
  await seed("456");
  const reminder = await created(agent);
  const later = await localIn("3 days");
  const changed = await body<Reminder>(
    await patch(agent, reminder.id, { expected_version: 1, due_local: later, note: "재고 확인" }),
    200,
  );
  assert.deepEqual([changed.version, changed.due_local, changed.note], [2, later, "재고 확인"]);
  // The same due time and note store nothing.
  const same = await body<Reminder>(
    await patch(agent, reminder.id, { expected_version: 2, due_local: later, note: " 재고 확인 " }),
    200,
  );
  assert.equal(same.version, 2);
  const stale = await body<{ error: string; reminder: Reminder }>(
    await patch(agent, reminder.id, { expected_version: 1, note: "old" }),
    409,
  );
  assert.equal(stale.error, "reminder_conflict");
  assert.equal(stale.reminder.version, 2);
  assert.equal(stale.reminder.note, "재고 확인");
  const cleared = await body<Reminder>(await patch(agent, reminder.id, { expected_version: 2, note: null }), 200);
  assert.deepEqual([cleared.version, cleared.note], [3, null]);
  const cancelled = await body<Reminder>(await finish(agent, reminder.id, "cancel", 3), 200);
  assert.deepEqual([cancelled.status, cancelled.cancel_reason, cancelled.version], ["cancelled", "manual", 4]);
  assert.equal(
    await errorCode(await patch(agent, reminder.id, { expected_version: 4, note: "x" }), 409),
    "reminder_not_pending",
  );
  assert.equal(await errorCode(await finish(agent, reminder.id, "complete", 4), 409), "reminder_not_pending");
  assert.equal(await errorCode(await finish(agent, reminder.id, "complete", 3), 409), "reminder_conflict");
  assert.deepEqual(
    (await eventRows()).map((row) => [row.version, row.kind, row.reason, row.note, row.actor_id]),
    [
      [1, "created", null, null, agent.id],
      [2, "changed", null, "재고 확인", agent.id],
      [3, "changed", null, null, agent.id],
      [4, "cancelled", "manual", null, agent.id],
    ],
  );
});

test("closing a conversation cancels every member's pending reminders; a reopen does not revive them", async () => {
  await seed("456");
  await seed("457");
  await created(agent);
  await created(other);
  await created(agent, "457");
  // An assignment alone cancels nothing.
  await body(await setState(admin, { expected_version: 0, assignee_user_id: agent.id }), 200);
  assert.ok((await reminderRows()).every((row) => row.status === "pending"));
  await body(await setState(admin, { expected_version: 1, status: "closed" }), 200);
  assert.deepEqual(
    (await reminderRows()).map((row) => [row.recipient_id, row.creator_id, row.status, row.cancel_reason, row.version]),
    [
      ["456", agent.id, "cancelled", "conversation_closed", 2],
      ["456", other.id, "cancelled", "conversation_closed", 2],
      ["457", agent.id, "pending", null, 1],
    ],
  );
  const closings = (await eventRows()).filter((row) => row.kind === "cancelled");
  assert.deepEqual(
    closings.map((row) => [row.recipient_id, row.reason, row.actor_id]),
    [
      ["456", "conversation_closed", null],
      ["456", "conversation_closed", null],
    ],
  );
  assert.equal(await errorCode(await create(agent, await localIn("1 day")), 409), "conversation_closed");

  // A manual reopen revives nothing; a new reminder can be made on the open conversation.
  await body(await setState(agent, { expected_version: 2, status: "open" }), 200);
  assert.equal((await reminderRows()).filter((row) => row.status === "pending").length, 1);
  await created(agent);
  await body(await setState(agent, { expected_version: 3, status: "closed" }), 200);
  // A new DM reopens the conversation (auto_reopen) and revives nothing either.
  await pool.query("UPDATE instagram_connections SET active=true WHERE id=$1", [connectionId]);
  await ingestMessages(pool, [
    { accountId: "123", senderId: "456", messageId: "reopen-1", text: "again", timestamp: new Date(Date.now() - 1000) },
  ]);
  const state = await pool.query(
    "SELECT status,version FROM instagram_inbox_conversations WHERE connection_id=$1 AND recipient_id='456'",
    [connectionId],
  );
  assert.deepEqual(state.rows[0], { status: "open", version: 5 });
  assert.deepEqual(
    (await reminderRows()).filter((row) => row.recipient_id === "456").map((row) => row.status),
    ["cancelled", "cancelled", "cancelled"],
  );
});

test("removing a member cancels only that member's pending reminders", async () => {
  await seed("456");
  await seed("457");
  const done = await created(agent, "457");
  await body(await finish(agent, done.id, "complete", 1), 200);
  await created(agent);
  await created(agent, "457");
  await created(other);
  const removed = await body<{ cancelled_reminders: number }>(
    await request(owner, "DELETE", `/api/workspace/members/${agent.id}`),
    200,
  );
  assert.equal(removed.cancelled_reminders, 2);
  assert.deepEqual(
    (await reminderRows()).map((row) => [row.recipient_id, row.creator_id, row.status, row.cancel_reason]),
    [
      ["456", agent.id, "cancelled", "member_removed"],
      ["456", other.id, "pending", null],
      ["457", agent.id, "done", null],
      ["457", agent.id, "cancelled", "member_removed"],
    ],
  );
  assert.deepEqual(
    (await eventRows()).filter((row) => row.reason === "member_removed").map((row) => row.actor_id),
    [null, null],
  );
  assert.equal(await errorCode(await create(agent, await localIn("1 day")), 403), "workspace_required");
  assert.equal(await errorCode(await request(agent, "GET", "/api/inbox/reminders"), 403), "workspace_required");
});

test("reminder writes need the same origin and a membership; every role can keep its own", async () => {
  await seed("456");
  const local = await localIn("1 day");
  const crossOrigin = await request(
    agent,
    "POST",
    remindersPath(),
    { due_local: local },
    pool.connect.bind(pool),
    "https://evil.test",
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(await errorCode(await create(stranger, local), 403), "workspace_required");
  assert.equal(await errorCode(await request(stranger, "GET", "/api/inbox/reminders"), 403), "workspace_required");
  for (const actor of [owner, admin, agent]) await created(actor);
  const reminder = (
    await body<{ reminder: Reminder }>(await request(agent, "GET", `/api/connections/${connectionId}/inbox/456`), 200)
  ).reminder;
  const crossPatch = await request(
    agent,
    "PATCH",
    `/api/inbox/reminders/${reminder.id}`,
    { expected_version: 1, note: "x" },
    pool.connect.bind(pool),
    "https://evil.test",
  );
  assert.equal(crossPatch.status, 403);
  assert.equal((await reminderRows()).length, 3);
});

test("reminder=due lists the caller's due reminders, pages with the cursor and combines with filters", async () => {
  // 54 conversations: 52 with a due reminder of the agent, 2 with a later one; the other agent has one due reminder.
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     SELECT $1,$2,(1000+n)::text,'m'||n,CASE WHEN n%2=0 THEN 'needle '||n ELSE 'hay '||n END,'text',
       '2026-10-01T00:00:00Z'::timestamptz+n*interval '1 second'
     FROM generate_series(0,53) n`,
    [workspaceId, connectionId],
  );
  await seed("2000", "second", "2026-10-02T00:00:00Z", secondConnectionId);
  await pool.query(
    `INSERT INTO instagram_inbox_reminders(workspace_id,connection_id,recipient_id,creator_id,due_at)
     SELECT $1,$2,(1000+n)::text,$3,CASE WHEN n<52 THEN now()-n*interval '1 minute' ELSE now()+interval '1 day' END
     FROM generate_series(0,53) n`,
    [workspaceId, connectionId, agent.id],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_reminders(workspace_id,connection_id,recipient_id,creator_id,due_at)
     VALUES($1,$2,'1053',$3,now()-interval '1 hour'),($1,$4,'2000',$5,now()-interval '1 hour')`,
    [workspaceId, connectionId, other.id, secondConnectionId, agent.id],
  );
  const page = (actor: Actor, query: string) => request(actor, "GET", `/api/inbox?${query}`);
  const first = await body<InboxPage>(await page(agent, "reminder=due"), 200);
  assert.equal(first.conversations.length, 50);
  assert.equal(first.due_reminder_count, 53);
  assert.ok(first.conversations.every((row) => row.reminder?.due === true));
  const second = await body<InboxPage>(
    await page(agent, `reminder=due&after=${encodeURIComponent(first.after!)}`),
    200,
  );
  assert.equal(second.after, null);
  const recipients = [...first.conversations, ...second.conversations].map((row) => row.recipient_id);
  assert.equal(new Set(recipients).size, 53);
  assert.deepEqual([...recipients].sort(), [...Array.from({ length: 52 }, (_, n) => String(1000 + n)), "2000"].sort());
  // Without the filter the later reminders are listed too, not due.
  const all = await body<InboxPage>(await page(agent, "connection_id=" + connectionId), 200);
  assert.deepEqual(
    all.conversations.filter((row) => row.reminder && !row.reminder.due).map((row) => row.recipient_id),
    ["1053", "1052"],
  );
  const combined = await body<InboxPage>(await page(agent, `reminder=due&q=needle&connection_id=${connectionId}`), 200);
  assert.equal(combined.conversations.length, 26);
  assert.ok(combined.conversations.every((row) => Number(row.recipient_id) % 2 === 0 && row.reminder?.due));
  assert.equal(combined.due_reminder_count, 53);
  const theirs = await body<InboxPage>(await page(other, "reminder=due"), 200);
  assert.deepEqual(
    theirs.conversations.map((row) => row.recipient_id),
    ["1053"],
  );
  assert.equal(theirs.due_reminder_count, 1);

  // The reminder list orders by due time and pages too; due=true leaves out the later ones.
  const listed = await body<{ reminders: Reminder[]; after: string | null }>(
    await request(agent, "GET", "/api/inbox/reminders?due=true"),
    200,
  );
  assert.equal(listed.reminders.length, 50);
  const rest = await body<{ reminders: Reminder[]; after: string | null }>(
    await request(agent, "GET", `/api/inbox/reminders?due=true&after=${encodeURIComponent(listed.after!)}`),
    200,
  );
  assert.equal(rest.reminders.length, 3);
  assert.equal(rest.after, null);
  const times = [...listed.reminders, ...rest.reminders].map((row) => Date.parse(row.due_at));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  assert.ok([...listed.reminders, ...rest.reminders].every((row) => row.due));
  assert.equal(
    (await body<{ reminders: Reminder[] }>(await request(agent, "GET", "/api/inbox/reminders"), 200)).reminders.length,
    50,
  );
});

test("the deletion functions remove reminders: person deletion only that DM recipient's", async () => {
  await seed("456");
  await seed("457");
  await seed("458", "three", "2026-10-01T00:00:03Z", secondConnectionId);
  for (const [recipient, connection] of [
    ["456", connectionId],
    ["457", connectionId],
    ["458", secondConnectionId],
  ] as const) {
    await created(agent, recipient, "1 day", connection);
    await created(other, recipient, "1 day", connection);
  }
  const person = (await runDeletion("person")).rows[0].result;
  assert.equal(person.deleted_counts.instagram_inbox_reminders, 2);
  assert.equal(person.deleted_counts.instagram_inbox_reminder_events, 2);
  assert.deepEqual([...new Set((await reminderRows()).map((row) => row.recipient_id))], ["457", "458"]);
  const connection = (await runDeletion("connection")).rows[0].result;
  assert.equal(connection.deleted_counts.instagram_inbox_reminders, 2);
  assert.equal(connection.deleted_counts.instagram_inbox_reminder_events, 2);
  assert.deepEqual([...new Set((await reminderRows()).map((row) => row.recipient_id))], ["458"]);
  const workspace = (await runDeletion("workspace")).rows[0].result;
  assert.equal(workspace.deleted_counts.instagram_inbox_reminders, 2);
  assert.equal(workspace.deleted_counts.instagram_inbox_reminder_events, 2);
  assert.deepEqual(await reminderRows(), []);
});

test("a reminder created before a close commits is cancelled by the close", async () => {
  await seed("456");
  const held = heldBeforeCommit(agent, "POST", remindersPath(), { due_local: await localIn("1 day") });
  try {
    await reachCommit(held);
    let settled = false;
    const close = setState(admin, { expected_version: 0, status: "closed" }).finally(() => (settled = true));
    await settledOrWaiting(close);
    const waited = !settled;
    held.release();
    await body(await held.response, 201);
    await body(await close, 200);
    assert.ok(waited, "the close did not wait for the reminder write");
  } finally {
    held.release();
  }
  assert.deepEqual(
    (await reminderRows()).map((row) => [row.status, row.cancel_reason]),
    [["cancelled", "conversation_closed"]],
  );
});

test("a reminder create that waits on an uncommitted close sees it and refuses", async () => {
  await seed("456");
  const held = heldBeforeCommit(admin, "PUT", `/api/inbox/conversations/${connectionId}/456/state`, {
    expected_version: 0,
    status: "closed",
  });
  try {
    await reachCommit(held);
    const pending = create(agent, await localIn("1 day"));
    await settledOrWaiting(pending);
    held.release();
    await body(await held.response, 200);
    assert.equal(await errorCode(await pending, 409), "conversation_closed");
  } finally {
    held.release();
  }
  assert.deepEqual(await reminderRows(), []);
});

test("a member removal waits for that member's reminder write and cancels it", async () => {
  await seed("456");
  const held = heldBeforeCommit(agent, "POST", remindersPath(), { due_local: await localIn("1 day") });
  try {
    await reachCommit(held);
    const removal = request(owner, "DELETE", `/api/workspace/members/${agent.id}`);
    await settledOrWaiting(removal);
    held.release();
    await body(await held.response, 201);
    assert.equal((await body<{ cancelled_reminders: number }>(await removal, 200)).cancelled_reminders, 1);
  } finally {
    held.release();
  }
  assert.deepEqual(
    (await reminderRows()).map((row) => [row.status, row.cancel_reason]),
    [["cancelled", "member_removed"]],
  );
});

for (const deletion of ["connection", "person"] as const) {
  test(`a reminder write and ${deletion} deletion serialize in both orders`, async () => {
    await seed("456");
    // The write first: the deletion waits and removes the new reminder.
    const held = heldBeforeCommit(agent, "POST", remindersPath(), { due_local: await localIn("1 day") });
    try {
      await reachCommit(held);
      const running = runDeletion(deletion);
      await settledOrWaiting(running);
      held.release();
      await body(await held.response, 201);
      assert.equal((await running).rows[0].result.deleted_counts.instagram_inbox_reminders, 1);
    } finally {
      held.release();
    }
    assert.deepEqual(await reminderRows(), []);
    // The deletion first: the write waits and then finds no conversation.
    await seed("456");
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(deletionSql[deletion][0], [...deletionSql[deletion][1]]);
      const pending = create(agent, await localIn("1 day"));
      await settledOrWaiting(pending);
      await holder.query("COMMIT");
      assert.equal(await errorCode(await pending, 404), "conversation_not_found");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    assert.deepEqual(await reminderRows(), []);
  });
}

// delete_workspace_data locks the workspace row, then the connections, and deletes the members last. A reminder write
// that took the member row before the workspace row would hold it while waiting for a connection, and deadlock.
test("a reminder write and workspace deletion queue on the workspace row instead of deadlocking", async () => {
  await seed("456");
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM workspace_members WHERE user_id=$1 FOR UPDATE", [agent.id]);
    const pending = create(agent, await localIn("1 day"));
    await settledOrWaiting(pending);
    const deletion = runDeletion("workspace").then(
      (result) => result.rows[0].result,
      (error: unknown) => error,
    );
    await settledOrWaiting(deletion, 2);
    await holder.query("ROLLBACK");
    await body(await pending, 201);
    const result = await deletion;
    assert.ok(!(result instanceof Error), String(result));
    assert.equal(result.deleted_counts.instagram_inbox_reminders, 1);
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
  assert.deepEqual(await reminderRows(), []);
});

test("migration 034 replays (with 035 after it), every deletion function removes reminders, and the export leaves the tables out", async () => {
  const functions = async () =>
    (
      await pool.query(
        `SELECT proname,pg_get_functiondef(oid) AS body FROM pg_proc
         WHERE pronamespace='public'::regnamespace AND proname IN ('delete_connection_data','delete_person_data','delete_workspace_data')
         ORDER BY proname`,
      )
    ).rows;
  // Other test files replay older migrations, so the current bodies are loaded first.
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  const current = await functions();
  assert.equal(current.length, 3);
  for (const { proname, body: text } of current) {
    assert.match(text, /DELETE FROM public\.instagram_inbox_reminder_events\b/, proname);
    assert.match(text, /DELETE FROM public\.instagram_inbox_reminders\b/, proname);
  }
  const migration = await readFile(new URL("../../db/migrations/034_inbox_reminders.sql", import.meta.url), "utf8");
  // Migration 035 redefines delete_workspace_data after 034, in the order deploy/migrate-multi-user.sql runs them.
  const later = await readFile(new URL("../../db/migrations/035_inbox_label_rules.sql", import.meta.url), "utf8");
  for (let run = 0; run < 2; run++) {
    await pool.query(migration);
    await pool.query(later);
  }
  assert.deepEqual(await functions(), current);
  // Reminders are private to their creator, so the admin export leaves both tables out.
  for (const table of ["instagram_inbox_reminders", "instagram_inbox_reminder_events"]) {
    assert.equal(EXPORTED_TABLES[table], undefined, table);
    assert.ok(EXCLUDED_TABLES.includes(table), table);
  }
  // Both tables reference the connection, so the workspace move check (an existing connection) already covers them.
  const foreignKeys = await pool.query(
    `SELECT conrelid::regclass::text AS table_name FROM pg_constraint
     WHERE contype='f' AND confrelid='instagram_connections'::regclass
       AND conrelid IN ('instagram_inbox_reminders'::regclass,'instagram_inbox_reminder_events'::regclass)
     ORDER BY 1`,
  );
  assert.deepEqual(
    foreignKeys.rows.map((row) => row.table_name),
    ["instagram_inbox_reminder_events", "instagram_inbox_reminders"],
  );
  await seed("456");
  const insert = (columns: string, values: string) =>
    pool.query(
      `INSERT INTO instagram_inbox_reminders(workspace_id,connection_id,recipient_id,creator_id,due_at${columns})
       VALUES($1,$2,'456',$3,now()+interval '1 day'${values})`,
      [workspaceId, connectionId, agent.id],
    );
  await assert.rejects(insert(",note", ",'   '"), { code: "23514" });
  await assert.rejects(insert(",note", `,'${"x".repeat(201)}'`), { code: "23514" });
  await assert.rejects(insert(",status", ",'cancelled'"), { code: "23514" });
  await assert.rejects(insert(",cancel_reason", ",'manual'"), { code: "23514" });
  await insert("", "");
  // One pending reminder per member and conversation.
  await assert.rejects(insert("", ""), { code: "23505" });
  await insert(",status", ",'done'");
  const id = (await pool.query("SELECT id FROM instagram_inbox_reminders WHERE status='pending'")).rows[0].id;
  const event = (kind: string, reason: string | null, actor: string | null) =>
    pool.query(
      `INSERT INTO instagram_inbox_reminder_events(reminder_id,workspace_id,connection_id,recipient_id,version,kind,reason,due_at,actor_id)
       VALUES($1,$2,$3,'456',2,$4,$5,now(),$6)`,
      [id, workspaceId, connectionId, kind, reason, actor],
    );
  // A system cancellation has no actor, and everything else names one.
  await assert.rejects(event("cancelled", "conversation_closed", agent.id), { code: "23514" });
  await assert.rejects(event("cancelled", "manual", null), { code: "23514" });
  await assert.rejects(event("changed", null, null), { code: "23514" });
  await assert.rejects(event("changed", "manual", agent.id), { code: "23514" });
  await event("cancelled", "member_removed", null);
});
