import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { EXPORTED_TABLES } from "./workspace-export.ts";

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
// Two connections of the same workspace; the second sorts after the first, so ties on time order by it.
const connectionId = "88888888-8888-4888-8888-888888888888";
const secondConnectionId = "99999999-9999-4999-8999-999999999999";
const foreignConnectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };

type Actor = { id: string; email: string };
type Row = {
  connection_id: string;
  recipient_id: string;
  message_count: number;
  unread_count: number;
  last_message_at: string;
  state: { status: string; assignee: { user_id: string } | null; version: number };
};
type Position = { last_read_message_id: string | null; read_at: string | null; unread_count: number };

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

function request(actor: Actor, method: string, path: string, body?: unknown, connect = pool.connect.bind(pool)) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect, end: async () => {} }) as unknown as Pool,
    (async () => Response.json({ id: actor.id, email: actor.email, email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

// Stores one inbound DM at an exact time (microseconds kept) and returns its inbox message ID.
async function seed(recipient: string, text: string, at: string, connection = connectionId): Promise<string> {
  const workspace = connection === foreignConnectionId ? otherWorkspaceId : workspaceId;
  return (
    await pool.query(
      `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
       VALUES($1,$2,$3,gen_random_uuid()::text,$4,'text',$5::timestamptz) RETURNING id::text`,
      [workspace, connection, recipient, text, at],
    )
  ).rows[0].id;
}

async function page(actor: Actor, query = ""): Promise<{ conversations: Row[]; after: string | null }> {
  const response = await request(actor, "GET", `/api/inbox${query}`);
  assert.equal(response.status, 200, `${query}: ${JSON.stringify(await response.clone().json())}`);
  return (await response.json()) as { conversations: Row[]; after: string | null };
}

async function recipients(actor: Actor, query = "") {
  return (await page(actor, query)).conversations.map((row) => row.recipient_id);
}

const readPath = (recipient = "456", connection = connectionId) =>
  `/api/inbox/conversations/${connection}/${recipient}/read`;
const markRead = (actor: Actor, messageId: unknown, recipient = "456", connection = connectionId) =>
  request(actor, "POST", readPath(recipient, connection), { message_id: messageId });

async function marked(actor: Actor, messageId: string, recipient = "456"): Promise<Position> {
  const response = await markRead(actor, messageId, recipient);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  return (await response.json()) as Position;
}

async function readRows() {
  return (
    await pool.query(
      "SELECT connection_id,recipient_id,user_id,last_read_message_id::text FROM instagram_inbox_read_state ORDER BY recipient_id,user_id",
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

// Runs a read mark through the real API and holds its transaction just before COMMIT, after the read row was
// written, until `release` is called.
function markHeldBeforeCommit(actor: Actor, messageId: string, recipient = "456") {
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
  const response = request(actor, "POST", readPath(recipient), { message_id: messageId }, connect);
  return { response, atCommit, release };
}

const deletions = {
  connection: () =>
    pool.query("SELECT public.delete_connection_data($1,$2,$3,'123') AS result", [workspaceId, connectionId, owner.id]),
  person: () =>
    pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','456') AS result", [
      workspaceId,
      connectionId,
      owner.id,
    ]),
  workspace: () => pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspaceId, owner.id]),
} as const;
const deletionSql = {
  connection: ["SELECT public.delete_connection_data($1,$2,$3,'123')", [workspaceId, connectionId, owner.id]],
  person: ["SELECT public.delete_person_data($1,$2,$3,'dm_recipient','456')", [workspaceId, connectionId, owner.id]],
  workspace: ["SELECT public.delete_workspace_data($1,$2)", [workspaceId, owner.id]],
} as const;

test("conversations are listed newest first and pages stay stable when last-message times tie", async () => {
  // 53 conversations. Rows 48 to 51 tie on one time across the page boundary (two on each connection), and
  // the rows just before and after differ from it by one microsecond inside the same millisecond.
  const tie = "2026-10-01T00:00:00.000500Z";
  const expected: string[] = [];
  for (let index = 0; index < 47; index += 1) {
    const recipient = String(1000 + index);
    await seed(
      recipient,
      `message ${index}`,
      new Date(Date.parse("2026-10-01T01:00:00Z") - index * 1000).toISOString(),
    );
    expected.push(recipient);
  }
  await seed("1047", "just after the tie", "2026-10-01T00:00:00.000501Z");
  expected.push("1047");
  await seed("1049", "tie", tie, secondConnectionId);
  await seed("1048", "tie", tie, secondConnectionId);
  await seed("1051", "tie", tie);
  await seed("1050", "tie", tie);
  // Same time: connection first, then recipient, both ascending.
  expected.push("1050", "1051", "1048", "1049");
  await seed("1052", "just before the tie", "2026-10-01T00:00:00.000499Z");
  expected.push("1052");
  // A conversation's older messages do not move it: only its latest message counts.
  await seed("1052", "older message of the last conversation", "2026-09-01T00:00:00Z");

  const first = await page(agent);
  assert.equal(first.conversations.length, 50);
  assert.ok(first.after);
  const second = await page(agent, `?after=${first.after}`);
  assert.equal(second.after, null);
  assert.deepEqual(
    [...first.conversations, ...second.conversations].map((row) => row.recipient_id),
    expected,
  );
  assert.equal(second.conversations.at(-1)!.message_count, 2);
  assert.equal(second.conversations.at(-1)!.last_message_at, "2026-10-01T00:00:00.000Z");
  // The cursor is opaque and carries only the keyset values, never message text.
  assert.doesNotMatch(Buffer.from(first.after, "base64url").toString(), /tie|message/);

  // A new message moves its conversation to the top.
  await seed("1052", "new", "2026-10-01T02:00:00Z");
  assert.equal((await recipients(agent))[0], "1052");
  // The cursor format of the previous key order is refused.
  const legacy = Buffer.from(JSON.stringify({ connection_id: connectionId, recipient_id: "1000" })).toString(
    "base64url",
  );
  assert.equal((await request(agent, "GET", `/api/inbox?after=${legacy}`)).status, 400);
});

test("account, status, assignee, unread and search filters combine", async () => {
  const shipping = await seed("456", "배송은 언제 오나요?", "2026-10-01T00:00:05Z");
  await seed("457", "가격 문의", "2026-10-01T00:00:04Z");
  await seed("458", "배송지 변경", "2026-10-01T00:00:03Z");
  await seed("459", "배송 문의", "2026-10-01T00:00:02Z", secondConnectionId);
  await seed("460", "배송 문의", "2026-10-01T00:00:01Z", foreignConnectionId);
  const put = async (actor: Actor, recipient: string, change: Record<string, unknown>, connection = connectionId) =>
    assert.equal(
      (await request(actor, "PUT", `/api/inbox/conversations/${connection}/${recipient}/state`, change)).status,
      200,
    );
  await put(agent, "456", { expected_version: 0, assignee_user_id: agent.id });
  await put(admin, "458", { expected_version: 0, assignee_user_id: other.id, status: "closed" });
  await put(other, "459", { expected_version: 0, assignee_user_id: other.id }, secondConnectionId);
  await marked(agent, shipping);

  assert.deepEqual(await recipients(agent), ["456", "457", "458", "459"]);
  assert.deepEqual(await recipients(agent, `?connection_id=${secondConnectionId}`), ["459"]);
  assert.deepEqual(await recipients(agent, "?assignee=me"), ["456"]);
  assert.deepEqual(await recipients(agent, "?assignee=none"), ["457"]);
  assert.deepEqual(await recipients(agent, `?assignee=${other.id}`), ["458", "459"]);
  assert.deepEqual(await recipients(agent, `?assignee=${other.id}&status=open`), ["459"]);
  assert.deepEqual(await recipients(agent, `?assignee=${other.id}&connection_id=${connectionId}`), ["458"]);
  assert.deepEqual(await recipients(agent, `?assignee=${outsider.id}`), []);
  assert.deepEqual(await recipients(agent, "?status=closed"), ["458"]);
  assert.deepEqual(await recipients(agent, "?q=배송"), ["456", "458", "459"]);
  assert.deepEqual(await recipients(agent, "?q=배송&status=open"), ["456", "459"]);
  assert.deepEqual(await recipients(agent, `?q=배송&connection_id=${connectionId}&assignee=none`), []);
  assert.deepEqual(await recipients(agent, "?unread=true"), ["457", "458", "459"]);
  assert.deepEqual(await recipients(agent, "?unread=true&q=배송&status=open"), ["459"]);
  // Read state is the caller's own: the same filter shows another member every conversation.
  assert.deepEqual(await recipients(other, "?unread=true"), ["456", "457", "458", "459"]);
  assert.deepEqual(await recipients(outsider), ["460"]);
});

test("search matches stored DM text literally and case-insensitively, and the counts cover every message", async () => {
  await seed("456", "100% 할인인가요?", "2026-10-01T00:00:06Z");
  await seed("456", "그냥 인사", "2026-10-01T00:00:07Z");
  await seed("457", "a_b 모델", "2026-10-01T00:00:05Z");
  await seed("458", "C:\\path 파일", "2026-10-01T00:00:04Z");
  await seed("459", "Hello WORLD", "2026-10-01T00:00:03Z");
  await seed("460", "100 하고 ab", "2026-10-01T00:00:02Z");
  const search = (q: string) => recipients(agent, `?q=${encodeURIComponent(q)}`);
  assert.deepEqual(await search("%"), ["456"]);
  assert.deepEqual(await search("_"), ["457"]);
  assert.deepEqual(await search("\\"), ["458"]);
  assert.deepEqual(await search("a_b"), ["457"]);
  assert.deepEqual(await search("100%"), ["456"]);
  assert.deepEqual(await search("hello world"), ["459"]);
  assert.deepEqual(await search("가격"), []);
  // The match picks the conversation; its count and last message time still cover all of its messages.
  const [row] = (await page(agent, `?q=${encodeURIComponent("100%")}`)).conversations;
  assert.equal(row!.message_count, 2);
  assert.equal(row!.unread_count, 2);
  assert.equal(row!.last_message_at, "2026-10-01T00:00:07.000Z");

  assert.deepEqual(await search("가".repeat(100)), []);
  for (const query of [
    "?q=",
    `?q=${"a".repeat(101)}`,
    `?q=${encodeURIComponent("가".repeat(101))}`,
    "?q=%00",
    "?q=a&q=b",
    "?unread=1",
    "?unread=false",
    "?assignee=someone",
    "?assignee=me&assignee=none",
    "?status=done",
    "?connection_id=shop",
    "?after=invalid",
    "?label=vip",
  ])
    assert.equal((await request(agent, "GET", `/api/inbox${query}`)).status, 400, query);
});

test("a read position is per member, only moves forward and drives the unread count", async () => {
  const first = await seed("456", "one", "2026-10-01T00:00:01Z");
  const second = await seed("456", "two", "2026-10-01T00:00:02Z");
  const third = await seed("456", "three", "2026-10-01T00:00:03Z");
  const elsewhere = await seed("457", "other conversation", "2026-10-01T00:00:04Z");
  const unread = async (actor: Actor) =>
    Object.fromEntries((await page(actor)).conversations.map((row) => [row.recipient_id, row.unread_count]));
  assert.deepEqual(await unread(agent), { "456": 3, "457": 1 });

  const advanced = await marked(agent, second);
  assert.equal(advanced.last_read_message_id, second);
  assert.equal(advanced.unread_count, 1);
  assert.ok(advanced.read_at);
  // A lower or equal ID is a no-op that answers with the current position and keeps its time.
  for (const id of [first, second]) assert.deepEqual(await marked(agent, id), advanced);
  assert.deepEqual(await unread(agent), { "456": 1, "457": 1 });
  // Another member's position is separate.
  assert.deepEqual(await unread(other), { "456": 3, "457": 1 });
  const done = await marked(agent, third);
  assert.equal(done.unread_count, 0);
  assert.notEqual(done.read_at, advanced.read_at);
  assert.deepEqual(await recipients(agent, "?unread=true"), ["457"]);
  assert.deepEqual(await recipients(other, "?unread=true"), ["457", "456"]);
  // A new message is unread again.
  await seed("456", "four", "2026-10-01T00:00:05Z");
  assert.deepEqual(await unread(agent), { "456": 1, "457": 1 });

  // The ID must belong to that conversation in the caller's workspace.
  for (const [id, recipient, connection, status, error] of [
    [elsewhere, "456", connectionId, 404, "message_not_found"],
    [third, "457", connectionId, 404, "message_not_found"],
    ["999999", "456", connectionId, 404, "message_not_found"],
    [third, "456", secondConnectionId, 404, "message_not_found"],
    [third, "456", foreignConnectionId, 404, "connection_not_found"],
  ] as const) {
    const response = await markRead(agent, id, recipient, connection);
    assert.equal(response.status, status, `${id} ${recipient} ${connection}`);
    assert.equal(((await response.json()) as { error: string }).error, error);
  }
  const foreignMessage = await seed("460", "foreign", "2026-10-01T00:00:01Z", foreignConnectionId);
  assert.equal((await markRead(outsider, third, "456")).status, 404);
  assert.equal((await markRead(agent, foreignMessage, "460", foreignConnectionId)).status, 404);
  assert.deepEqual(
    (await readRows()).map((row) => [row.recipient_id, row.user_id, row.last_read_message_id]),
    [["456", agent.id, third]],
  );
});

test("read requests are validated, need a membership and must be same-origin", async () => {
  const id = await seed("456", "one", "2026-10-01T00:00:01Z");
  for (const body of [
    {},
    { message_id: Number(id) },
    { message_id: "0" },
    { message_id: "01" },
    { message_id: "abc" },
    { message_id: "9223372036854775808" },
    { message_id: id, extra: true },
  ]) {
    const response = await request(agent, "POST", readPath(), body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(((await response.json()) as { error: string }).error, "invalid_read_request");
  }
  assert.equal((await request(agent, "POST", `${readPath()}?x=1`, { message_id: id })).status, 400);
  assert.equal(
    (await request(agent, "POST", "/api/inbox/conversations/not-a-uuid/456/read", { message_id: id })).status,
    404,
  );
  assert.equal((await request(agent, "GET", readPath())).status, 404);
  // Every role of the workspace may mark its own reading; a user without a workspace may not.
  for (const actor of [owner, admin, agent]) assert.equal((await markRead(actor, id)).status, 200);
  const outside = await markRead(stranger, id);
  assert.equal(outside.status, 403);
  assert.equal(((await outside.json()) as { error: string }).error, "workspace_required");
  const crossOrigin = await appApi(
    new Request(`https://app.test${readPath()}`, {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ message_id: id }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal((await readRows()).length, 3);
});

test("a removed member can neither list nor mark read, and their read rows stay until a deletion", async () => {
  const id = await seed("456", "one", "2026-10-01T00:00:01Z");
  await marked(other, id);
  const removed = await request(owner, "DELETE", `/api/workspace/members/${other.id}`);
  assert.equal(removed.status, 200);
  assert.equal((await request(other, "GET", "/api/inbox")).status, 403);
  assert.equal((await markRead(other, id)).status, 403);
  assert.deepEqual(
    (await readRows()).map((row) => row.user_id),
    [other.id],
  );
});

test("a read mark that waits on a member's removal is refused once the removal commits", async () => {
  const id = await seed("456", "one", "2026-10-01T00:00:01Z");
  const removal = await pool.connect();
  try {
    await removal.query("BEGIN");
    await removal.query("SELECT 1 FROM workspaces WHERE id=$1 FOR SHARE", [workspaceId]);
    await removal.query("SELECT 1 FROM workspace_members WHERE user_id=$1 FOR UPDATE", [agent.id]);
    await removal.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [
      agent.id,
      owner.id,
    ]);
    const pending = markRead(agent, id);
    await settledOrWaiting(pending);
    await removal.query("COMMIT");
    const refused = await pending;
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as { error: string }).error, "workspace_required");
  } finally {
    await removal.query("ROLLBACK").catch(() => undefined);
    removal.release();
  }
  assert.deepEqual(await readRows(), []);
});

for (const deletion of ["connection", "person", "workspace"] as const) {
  test(`a read mark waiting on ${deletion} deletion leaves no read row behind`, async () => {
    const id = await seed("456", "one", "2026-10-01T00:00:01Z");
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(deletionSql[deletion][0], [...deletionSql[deletion][1]]);
      const pending = markRead(agent, id);
      await settledOrWaiting(pending);
      await holder.query("COMMIT");
      const response = await pending;
      assert.equal(response.status, deletion === "workspace" ? 403 : 404, JSON.stringify(await response.json()));
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    assert.deepEqual(await readRows(), []);
  });

  test(`${deletion} deletion started while a read mark is uncommitted waits for it and removes its row`, async () => {
    const id = await seed("456", "one", "2026-10-01T00:00:01Z");
    const mark = markHeldBeforeCommit(agent, id);
    try {
      await Promise.race([
        mark.atCommit,
        mark.response.then((response) => assert.fail(`the read mark finished before COMMIT with ${response.status}`)),
      ]);
      let settled = false;
      const removal = deletions[deletion]()
        .then(
          (result) => result.rows[0].result,
          (error: unknown) => error,
        )
        .finally(() => (settled = true));
      await settledOrWaiting(removal);
      const waited = !settled;
      mark.release();
      assert.equal((await mark.response).status, 200);
      const result = await removal;
      assert.ok(!(result instanceof Error), String(result));
      assert.equal(result.deleted_counts.instagram_inbox_read_state, 1);
      assert.ok(waited, "the deletion did not wait for the uncommitted read mark");
    } finally {
      mark.release();
    }
    assert.deepEqual(await readRows(), []);
  });
}

// delete_workspace_data locks the workspace row, then the connections, and deletes the members last. A read mark
// that took the member row before the workspace row would hold it while waiting for a connection, and deadlock.
test("a read mark and workspace deletion queue on the workspace row instead of deadlocking", async () => {
  const id = await seed("456", "one", "2026-10-01T00:00:01Z");
  const holder = await pool.connect();
  try {
    // Hold the agent's member row so the read mark stops at it, then let the deletion run up to its waits.
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM workspace_members WHERE user_id=$1 FOR UPDATE", [agent.id]);
    const pending = markRead(agent, id);
    await settledOrWaiting(pending);
    const deletion = deletions.workspace().then(
      (result) => result.rows[0].result,
      (error: unknown) => error,
    );
    await settledOrWaiting(deletion, 2);
    await holder.query("ROLLBACK");
    const response = await pending;
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const result = await deletion;
    assert.ok(!(result instanceof Error), String(result));
    assert.equal(result.deleted_counts.instagram_inbox_read_state, 1);
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
  assert.deepEqual(await readRows(), []);
});

test("person deletion removes only that DM recipient's read rows, for every member", async () => {
  const first = await seed("456", "one", "2026-10-01T00:00:01Z");
  const second = await seed("457", "two", "2026-10-01T00:00:02Z");
  const third = await seed("458", "three", "2026-10-01T00:00:03Z", secondConnectionId);
  await marked(agent, first);
  await marked(other, first);
  await marked(agent, second, "457");
  assert.equal((await request(agent, "POST", readPath("458", secondConnectionId), { message_id: third })).status, 200);
  const result = (await deletions.person()).rows[0].result;
  assert.equal(result.deleted_counts.instagram_inbox_read_state, 2);
  assert.deepEqual(
    (await readRows()).map((row) => [row.connection_id, row.recipient_id]),
    [
      [connectionId, "457"],
      [secondConnectionId, "458"],
    ],
  );
  const connection = (await deletions.connection()).rows[0].result;
  assert.equal(connection.deleted_counts.instagram_inbox_read_state, 1);
  assert.deepEqual(
    (await readRows()).map((row) => row.recipient_id),
    ["458"],
  );
  const workspace = (await deletions.workspace()).rows[0].result;
  assert.equal(workspace.deleted_counts.instagram_inbox_read_state, 1);
  assert.deepEqual(await readRows(), []);
});

test("migration 032 replays, every deletion function removes read rows, and the export lists the table", async () => {
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
  for (const { proname, body } of current)
    assert.match(body, /DELETE FROM public\.instagram_inbox_read_state\b/, proname);
  const migration = await readFile(new URL("../../db/migrations/032_inbox_read_state.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  assert.deepEqual(await functions(), current);
  assert.deepEqual(EXPORTED_TABLES.instagram_inbox_read_state, { scope: "workspace" });
  const foreignKeys = await pool.query(
    "SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid='instagram_inbox_read_state'::regclass AND contype='f'",
  );
  assert.deepEqual(
    foreignKeys.rows.map((row) => row.target),
    ["instagram_connections"],
  );
});
