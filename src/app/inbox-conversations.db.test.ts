import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { ingestMessages } from "../instagram/follow-flow.ts";
import { ingestComments } from "../instagram/store.ts";
import { processNextPrivateReply, type PrivateReplyTransport } from "../instagram/reply-worker.ts";
import { processNextManualReply } from "../instagram/manual-reply-worker.ts";
import { storeInboxMessage } from "../instagram/inbox.ts";
import type { InstagramMessage } from "../instagram/message-events.ts";

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
const workspaceId = "66666666-6666-4666-8666-666666666666";
const otherWorkspaceId = "77777777-7777-4777-8777-777777777777";
const connectionId = "88888888-8888-4888-8888-888888888888";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };

type Actor = { id: string; email: string };
type State = {
  status: string;
  assignee: { user_id: string; email: string | null } | null;
  version: number;
  updated_by: { user_id: string; email: string | null } | null;
};

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
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
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,active,access_token_encrypted,inbox_enabled,inbox_enabled_at)
     VALUES($1,$2,'123','shop',true,'token',true,now()-interval '1 hour')`,
    [connectionId, workspaceId],
  );
  await dm("456", "first");
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

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const message = (recipient: string, messageId: string, text = "hello"): InstagramMessage => ({
  accountId: "123",
  senderId: recipient,
  messageId,
  text,
  timestamp: new Date(Date.now() - 1000),
});

function dm(recipient: string, messageId: string, text = "hello") {
  return ingestMessages(pool, [message(recipient, messageId, text)]);
}

// Runs one ingestion batch whose transaction stops before the first query that `pause` picks, until `release`.
function ingestHeld(messages: InstagramMessage[], pause: (text: string) => boolean) {
  let reached!: () => void;
  let release!: () => void;
  const atPause = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let paused = false;
  const connect = async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (text: string, values?: unknown[]) => {
            if (!paused && pause(text)) {
              paused = true;
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
  const done = ingestMessages({ connect } as unknown as Pool, messages);
  return { done, atPause, release };
}

// Returns true once `operation` finished without any backend waiting for a lock, false once one waits.
async function finishedWithoutWaiting(operation: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void operation.finally(() => (settled = true)).catch(() => undefined);
  for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
    const waiting = await pool.query(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()",
    );
    if (waiting.rows[0].waiting >= 1) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return settled;
}

const statePath = (recipient = "456") => `/api/inbox/conversations/${connectionId}/${recipient}/state`;
const save = (actor: Actor, change: Record<string, unknown>, recipient = "456") =>
  request(actor, "PUT", statePath(recipient), change);

async function saved(actor: Actor, change: Record<string, unknown>, recipient = "456"): Promise<State> {
  const response = await save(actor, change, recipient);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  return body<State>(response);
}

async function detail(actor: Actor = owner, recipient = "456"): Promise<State> {
  const response = await request(actor, "GET", `/api/connections/${connectionId}/inbox/${recipient}`);
  assert.equal(response.status, 200);
  return (await body<{ state: State }>(response)).state;
}

async function listed(actor: Actor, query = ""): Promise<{ recipient_id: string; state: State }[]> {
  const response = await request(actor, "GET", `/api/inbox${query}`);
  assert.equal(response.status, 200);
  return (await body<{ conversations: { recipient_id: string; state: State }[] }>(response)).conversations;
}

async function events() {
  return (
    await pool.query(
      `SELECT recipient_id,version,reason,from_status,to_status,from_assignee,to_assignee,actor_id
       FROM instagram_inbox_conversation_events ORDER BY recipient_id,version`,
    )
  ).rows;
}

async function waitForLockWaiters(count: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await pool.query(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()",
    );
    if (waiting.rows[0].waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`expected ${count} requests waiting for a lock`);
}

// Runs a state change through the real API and holds its transaction just before COMMIT, after the
// conversation row was written, until `release` is called.
function saveHeldBeforeCommit(actor: Actor, change: Record<string, unknown>, recipient = "456") {
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
  const response = request(actor, "PUT", statePath(recipient), change, connect);
  return { response, atCommit, release };
}

// Stores a DM while a close is held before COMMIT, then lets the close commit. Returns once both finished.
async function dmDuringClose(change: Record<string, unknown>, messageId: string) {
  const close = saveHeldBeforeCommit(agent, change);
  try {
    await Promise.race([
      close.atCommit,
      close.response.then((response) => assert.fail(`the close finished before COMMIT with ${response.status}`)),
    ]);
    let settled = false;
    const ingestion = dm("456", messageId).finally(() => (settled = true));
    // The DM either finishes without waiting or waits for the close; release the close in both cases so a
    // failure comes from the state assertions, not from a lock-wait timeout.
    for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
      const waiting = await pool.query(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()",
      );
      if (waiting.rows[0].waiting >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    close.release();
    assert.equal((await close.response).status, 200);
    await ingestion;
  } finally {
    close.release();
  }
}

test("a conversation without a state row is open and unassigned at version 0 in the list and the detail", async () => {
  const [row] = await listed(agent);
  assert.deepEqual(row!.state, { status: "open", assignee: null, version: 0, updated_by: null, updated_at: null });
  assert.deepEqual(await detail(agent), row!.state);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_conversations")).rows[0].count, 0);
  for (const query of ["?status=done", "?assignee=someone", "?status=open&status=closed", "?unknown=1"])
    assert.equal((await request(agent, "GET", `/api/inbox${query}`)).status, 400, query);
});

test("status and assignment changes are audited, filtered and answered with the new state", async () => {
  await dm("789", "second");
  const claimed = await saved(agent, { expected_version: 0, assignee_user_id: agent.id });
  assert.deepEqual(claimed.assignee, { user_id: agent.id, email: agent.email });
  assert.equal(claimed.version, 1);
  assert.deepEqual(claimed.updated_by, { user_id: agent.id, email: agent.email });
  const closed = await saved(agent, { expected_version: 1, status: "closed" });
  assert.equal(closed.status, "closed");
  assert.equal(closed.version, 2);
  // A request that changes nothing keeps the version and writes no audit.
  assert.equal((await saved(agent, { expected_version: 2, status: "closed" })).version, 2);

  assert.deepEqual(
    (await listed(agent, "?assignee=me")).map((row) => row.recipient_id),
    ["456"],
  );
  assert.deepEqual(
    (await listed(admin, "?assignee=me")).map((row) => row.recipient_id),
    [],
  );
  assert.deepEqual(
    (await listed(agent, "?assignee=none&status=open")).map((row) => row.recipient_id),
    ["789"],
  );
  assert.deepEqual(
    (await listed(agent, "?status=closed")).map((row) => row.recipient_id),
    ["456"],
  );

  const reopened = await saved(admin, { expected_version: 2, status: "open", assignee_user_id: null });
  assert.equal(reopened.status, "open");
  assert.equal(reopened.assignee, null);
  assert.deepEqual(await events(), [
    {
      recipient_id: "456",
      version: 1,
      reason: "manual",
      from_status: "open",
      to_status: "open",
      from_assignee: null,
      to_assignee: agent.id,
      actor_id: agent.id,
    },
    {
      recipient_id: "456",
      version: 2,
      reason: "manual",
      from_status: "open",
      to_status: "closed",
      from_assignee: agent.id,
      to_assignee: agent.id,
      actor_id: agent.id,
    },
    {
      recipient_id: "456",
      version: 3,
      reason: "manual",
      from_status: "closed",
      to_status: "open",
      from_assignee: agent.id,
      to_assignee: null,
      actor_id: admin.id,
    },
  ]);
});

test("agents only claim unassigned conversations or release their own; admins assign active members", async () => {
  // An agent cannot assign someone else, even from unassigned.
  const forbidden = await save(agent, { expected_version: 0, assignee_user_id: other.id });
  assert.equal(forbidden.status, 403);
  assert.equal((await body<{ error: string }>(forbidden)).error, "role_forbidden");
  await saved(other, { expected_version: 0, assignee_user_id: other.id });
  // Taking over or releasing another agent's conversation is for admins.
  for (const assignee of [agent.id, null]) {
    const denied = await save(agent, { expected_version: 1, assignee_user_id: assignee });
    assert.equal(denied.status, 403, String(assignee));
  }
  // Status is open to every role while the assignee stays.
  assert.equal((await saved(agent, { expected_version: 1, status: "closed" })).assignee?.user_id, other.id);
  assert.equal((await saved(admin, { expected_version: 2, assignee_user_id: agent.id })).assignee?.user_id, agent.id);
  assert.equal((await saved(owner, { expected_version: 3, assignee_user_id: owner.id })).assignee?.user_id, owner.id);
  assert.equal((await saved(owner, { expected_version: 4, assignee_user_id: null })).assignee, null);

  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [
    other.id,
    owner.id,
  ]);
  for (const assignee of [other.id, outsider.id, "99999999-9999-4999-8999-999999999999"]) {
    const refused = await save(admin, { expected_version: 5, assignee_user_id: assignee });
    assert.equal(refused.status, 409, assignee);
    assert.equal((await body<{ error: string }>(refused)).error, "assignee_unavailable");
  }
  // A removed member and a member of another workspace cannot reach the conversation at all.
  assert.equal((await save(other, { expected_version: 5, status: "closed" })).status, 403);
  assert.equal((await save(outsider, { expected_version: 5, status: "closed" })).status, 404);
  assert.equal((await request(outsider, "GET", `/api/connections/${connectionId}/inbox/456`)).status, 404);

  const assignees = await request(admin, "GET", "/api/inbox/assignees");
  assert.equal(assignees.status, 200);
  assert.deepEqual(
    (await body<{ assignees: { email: string }[] }>(assignees)).assignees.map((member) => member.email),
    [admin.email, agent.email, owner.email],
  );
  assert.equal((await request(agent, "GET", "/api/inbox/assignees")).status, 403);
});

test("requests are validated before any change", async () => {
  for (const change of [
    {},
    { expected_version: 0 },
    { status: "closed" },
    { expected_version: -1, status: "closed" },
    { expected_version: 0, status: "archived" },
    { expected_version: 0, assignee_user_id: "not-a-uuid" },
    { expected_version: 0, status: "closed", extra: true },
  ])
    assert.equal((await save(agent, change)).status, 400, JSON.stringify(change));
  assert.equal(
    (await request(agent, "PUT", `${statePath()}?x=1`, { expected_version: 0, status: "closed" })).status,
    400,
  );
  const missing = await save(agent, { expected_version: 0, status: "closed" }, "999");
  assert.equal(missing.status, 404);
  assert.equal((await body<{ error: string }>(missing)).error, "conversation_not_found");
  const crossOrigin = await appApi(
    new Request(`https://app.test${statePath()}`, {
      method: "PUT",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ expected_version: 0, status: "closed" }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
  );
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await events(), []);
});

test("a stale version returns 409 with the current state and who changed it", async () => {
  await saved(other, { expected_version: 0, assignee_user_id: other.id });
  const conflict = await save(agent, { expected_version: 0, assignee_user_id: agent.id });
  assert.equal(conflict.status, 409);
  const answer = await body<{ error: string; state: State }>(conflict);
  assert.equal(answer.error, "conversation_conflict");
  assert.equal(answer.state.version, 1);
  assert.deepEqual(answer.state.assignee, { user_id: other.id, email: other.email });
  assert.deepEqual(answer.state.updated_by, { user_id: other.id, email: other.email });
  assert.equal((await events()).length, 1);
});

test("concurrent claims of the same version serialize on the conversation row: one wins, one conflicts", async () => {
  await pool.query(
    "INSERT INTO instagram_inbox_conversations(workspace_id,connection_id,recipient_id) VALUES($1,$2,'456')",
    [workspaceId, connectionId],
  );
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT 1 FROM instagram_inbox_conversations WHERE connection_id=$1 AND recipient_id='456' FOR UPDATE",
      [connectionId],
    );
    const first = save(agent, { expected_version: 0, assignee_user_id: agent.id });
    const second = save(other, { expected_version: 0, assignee_user_id: other.id });
    await waitForLockWaiters(2);
    await holder.query("ROLLBACK");
    const statuses = (await Promise.all([first, second])).map((response) => response.status).sort();
    assert.deepEqual(statuses, [200, 409]);
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
  const current = await detail();
  assert.equal(current.version, 1);
  assert.equal((await events()).length, 1);
  assert.equal((await events())[0].to_assignee, current.assignee?.user_id);
});

test("an assignment that waits on a member's removal is refused once the removal commits", async () => {
  const removal = await pool.connect();
  try {
    await removal.query("BEGIN");
    await removal.query("SELECT 1 FROM workspace_members WHERE user_id=$1 FOR UPDATE", [agent.id]);
    await removal.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [
      agent.id,
      owner.id,
    ]);
    const pending = save(admin, { expected_version: 0, assignee_user_id: agent.id });
    await waitForLockWaiters(1);
    await removal.query("COMMIT");
    const refused = await pending;
    assert.equal(refused.status, 409);
    assert.equal((await body<{ error: string }>(refused)).error, "assignee_unavailable");
  } finally {
    await removal.query("ROLLBACK").catch(() => undefined);
    removal.release();
  }
  assert.equal((await detail()).assignee, null);
});

test("removing a member unassigns their conversations with audit and keeps status, handoff and queued replies", async () => {
  await dm("789", "second");
  await dm("790", "third");
  await saved(agent, { expected_version: 0, assignee_user_id: agent.id });
  await saved(agent, { expected_version: 1, status: "closed" });
  await saved(agent, { expected_version: 0, assignee_user_id: agent.id }, "789");
  await saved(other, { expected_version: 0, assignee_user_id: other.id }, "790");
  await handoffReady("789");
  await queueManualReply(agent, "789");

  const removed = await request(owner, "DELETE", `/api/workspace/members/${agent.id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(await body(removed), { user_id: agent.id, removed: true, unassigned_conversations: 2 });

  const first = await detail();
  assert.equal(first.assignee, null);
  assert.equal(first.status, "closed");
  assert.equal(first.version, 3);
  assert.deepEqual(first.updated_by, { user_id: owner.id, email: owner.email });
  assert.equal((await detail(owner, "789")).assignee, null);
  assert.equal((await detail(owner, "790")).assignee?.user_id, other.id);
  const removals = (await events()).filter((event) => event.reason === "member_removed");
  assert.deepEqual(
    removals.map((event) => [
      event.recipient_id,
      event.from_status,
      event.to_status,
      event.from_assignee,
      event.actor_id,
    ]),
    [
      ["456", "closed", "closed", agent.id, owner.id],
      ["789", "open", "open", agent.id, owner.id],
    ],
  );
  // Removal does not cancel a reply the member already queued or end the handoff they started.
  assert.equal((await pool.query("SELECT status FROM instagram_manual_replies")).rows[0].status, "pending");
  assert.equal((await pool.query("SELECT active FROM instagram_inbox_handoffs")).rows[0].active, true);
  // The removed member can no longer change the conversation.
  assert.equal((await save(agent, { expected_version: 1, assignee_user_id: agent.id }, "789")).status, 403);
});

test("a new DM reopens a closed conversation once and keeps its assignee; a redelivery does not", async () => {
  await saved(agent, { expected_version: 0, assignee_user_id: agent.id });
  await saved(agent, { expected_version: 1, status: "closed" });
  await dm("456", "first");
  assert.equal((await detail()).status, "closed", "a redelivered message changes nothing");
  await dm("456", "follow-up");
  const reopened = await detail();
  assert.equal(reopened.status, "open");
  assert.equal(reopened.version, 3);
  assert.equal(reopened.updated_by, null);
  assert.deepEqual(reopened.assignee, { user_id: agent.id, email: agent.email });
  await dm("456", "another");
  assert.equal((await detail()).version, 3, "an open conversation stays at its version");
  const automatic = (await events()).filter((event) => event.reason === "auto_reopen");
  assert.deepEqual(automatic, [
    {
      recipient_id: "456",
      version: 3,
      reason: "auto_reopen",
      from_status: "closed",
      to_status: "open",
      from_assignee: agent.id,
      to_assignee: agent.id,
      actor_id: null,
    },
  ]);
  // A message for a conversation without a state row creates none.
  await dm("791", "new-person");
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_conversations WHERE recipient_id='791'"))
      .rows[0].count,
    0,
  );
});

// A sent private reply bridges comment sender 888 to DM recipient, which lets a handoff start.
async function handoffReady(recipient = "456") {
  await pool.query(
    `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,keywords,private_reply_text,enabled)
     VALUES(gen_random_uuid(),$1,$2,'1001','link','{link}','first reply',true),
       (gen_random_uuid(),$1,$2,'1002','link','{link}','second reply',true),
       (gen_random_uuid(),$1,$2,'1003','link','{link}','third reply',true)
     ON CONFLICT DO NOTHING`,
    [workspaceId, connectionId],
  );
  await ingestComments(pool, [
    { accountId: "123", commentId: `bridge-${recipient}`, postId: "1001", senderId: "888", text: "link please" },
  ]);
  const reply = (
    await pool.query(
      `UPDATE private_reply_outbox SET status='sent',recipient_id=$2,provider_message_id='mid-bridge',sent_at=now()-interval '10 minutes'
       WHERE comment_id=$1 RETURNING id::text`,
      [`bridge-${recipient}`, recipient],
    )
  ).rows[0].id as string;
  return { reply };
}

async function startHandoff(actor: Actor, recipient = "456", expected = 0) {
  return request(actor, "PUT", `/api/connections/${connectionId}/inbox/${recipient}/handoff`, {
    active: true,
    expected_version: expected,
  });
}

async function queueManualReply(actor: Actor, recipient: string) {
  const started = await startHandoff(actor, recipient);
  assert.equal(started.status, 200);
  await pool.query(
    `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version)
     VALUES($1,$2,$3,gen_random_uuid(),$4,'manual text',1)`,
    [workspaceId, connectionId, recipient, actor.id],
  );
}

test("a DM stored while a close of an existing state row is uncommitted reopens it after the close", async () => {
  await saved(agent, { expected_version: 0, assignee_user_id: agent.id });
  await dmDuringClose({ expected_version: 1, status: "closed" }, "during-close");
  const state = await detail();
  assert.equal(state.status, "open");
  assert.equal(state.version, 3);
  assert.deepEqual(
    (await events()).map((event) => [event.version, event.reason, event.to_status]),
    [
      [1, "manual", "open"],
      [2, "manual", "closed"],
      [3, "auto_reopen", "open"],
    ],
  );
});

test("a DM stored while the first close of a conversation is uncommitted reopens it after the close", async () => {
  await dmDuringClose({ expected_version: 0, status: "closed" }, "during-first-close");
  const state = await detail();
  assert.equal(state.status, "open");
  assert.equal(state.version, 2);
  assert.deepEqual(
    (await events()).map((event) => [event.version, event.reason, event.to_status]),
    [
      [1, "manual", "closed"],
      [2, "auto_reopen", "open"],
    ],
  );
});

// #127: the read position is an ID watermark, so the DMs of one conversation must commit in ID order. A DM that
// took a higher ID and committed before a lower one would let a read mark on it count the lower one as read.
test("a DM of one conversation waits for an uncommitted earlier DM, so a read mark never skips it", async () => {
  const held = ingestHeld([message("456", "earlier")], (text) => text === "COMMIT");
  let waited = false;
  let later: Promise<void> | undefined;
  try {
    await Promise.race([
      held.atPause,
      held.done.then(() => assert.fail("the earlier DM committed without reaching COMMIT")),
    ]);
    later = dm("456", "later");
    waited = !(await finishedWithoutWaiting(later));
    // The reader marks the newest message it can see while the earlier DM is still uncommitted.
    const newest = (
      await pool.query("SELECT max(id)::text AS id FROM instagram_inbox_messages WHERE recipient_id='456'")
    ).rows[0].id as string;
    const mark = await request(agent, "POST", `/api/inbox/conversations/${connectionId}/456/read`, {
      message_id: newest,
    });
    assert.equal(mark.status, 200, JSON.stringify(await mark.clone().json()));
  } finally {
    held.release();
  }
  await held.done;
  await later;
  const [row] = (
    await body<{ conversations: { recipient_id: string; message_count: number; unread_count: number }[] }>(
      await request(agent, "GET", "/api/inbox"),
    )
  ).conversations;
  assert.deepEqual([row!.message_count, row!.unread_count], [3, 2], "both DMs stored after the read mark are unread");
  assert.ok(waited, "the later DM did not wait for the earlier one");
});

test("two DM batches with their senders in opposite orders both complete", async () => {
  // Batch A stops after its first conversation lock, before its second.
  let locks = 0;
  const first = ingestHeld(
    [message("456", "batch-a-1"), message("789", "batch-a-2")],
    (text) => text.includes("pg_advisory_xact_lock(") && ++locks === 2,
  );
  const settle = (promise: Promise<void>) =>
    promise.then(
      () => null,
      (error: { code?: string }) => error.code ?? String(error),
    );
  let second: Promise<string | null> | undefined;
  try {
    await Promise.race([first.atPause, first.done]);
    second = settle(ingestMessages(pool, [message("789", "batch-b-1"), message("456", "batch-b-2")]));
    await waitForLockWaiters(1);
  } finally {
    first.release();
  }
  assert.deepEqual(await Promise.all([settle(first.done), second]), [null, null]);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_messages WHERE message_id LIKE 'batch-%'"))
      .rows[0].count,
    4,
  );
});

test("DMs of different conversations do not wait on each other", async () => {
  const held = ingestHeld([message("456", "held")], (text) => text === "COMMIT");
  try {
    await Promise.race([
      held.atPause,
      held.done.then(() => assert.fail("the held DM committed without reaching COMMIT")),
    ]);
    assert.equal(await finishedWithoutWaiting(dm("789", "elsewhere")), true);
  } finally {
    held.release();
  }
  await held.done;
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_messages")).rows[0].count, 3);
});

test("status and assignment never change the handoff or the automation pause", async () => {
  await handoffReady();
  assert.equal((await startHandoff(agent)).status, 200);
  const before = (
    await pool.query(
      `SELECT handoff.active,handoff.version,automation.paused,automation.handoff_paused
       FROM instagram_inbox_handoffs handoff JOIN instagram_contact_automation automation USING(workspace_id,connection_id,sender_id)`,
    )
  ).rows[0];
  await saved(agent, { expected_version: 0, assignee_user_id: agent.id });
  await saved(admin, { expected_version: 1, assignee_user_id: other.id, status: "closed" });
  await saved(other, { expected_version: 2, assignee_user_id: null, status: "open" });
  const afterChanges = (
    await pool.query(
      `SELECT handoff.active,handoff.version,automation.paused,automation.handoff_paused
       FROM instagram_inbox_handoffs handoff JOIN instagram_contact_automation automation USING(workspace_id,connection_id,sender_id)`,
    )
  ).rows[0];
  assert.deepEqual(afterChanges, before);
  assert.deepEqual(before, { active: true, version: 1, paused: false, handoff_paused: true });
  // Handoff changes leave status and assignment alone too.
  const resumed = await request(agent, "PUT", `/api/connections/${connectionId}/inbox/456/handoff`, {
    active: false,
    expected_version: 1,
  });
  assert.equal(resumed.status, 200);
  assert.equal((await detail()).version, 3);
});

test("a handoff started while a private reply is already in send() cannot recall that send", async () => {
  await handoffReady();
  // A second comment from the same person queues another automated reply.
  await ingestComments(pool, [
    { accountId: "123", commentId: "in-flight", postId: "1002", senderId: "888", text: "link again" },
  ]);
  await ingestComments(pool, [
    { accountId: "123", commentId: "after-handoff", postId: "1003", senderId: "888", text: "link third" },
  ]);
  let handoffStatus = 0;
  const transport: PrivateReplyTransport = {
    verify: async () => ({ commentCreatedAt: new Date(), authorizationVerified: true, mediaOwned: true }),
    // The handoff commits after every pre-send check passed and the provider request is under way.
    send: async (reply) => {
      handoffStatus = (await startHandoff(agent)).status;
      return { messageId: `mid-${reply.commentId}` };
    },
  };
  assert.equal(await processNextPrivateReply(pool, transport, () => new Date(), connectionId), true);
  assert.equal(handoffStatus, 200);
  const rows = (
    await pool.query("SELECT comment_id,status FROM private_reply_outbox WHERE comment_id<>'bridge-456' ORDER BY id")
  ).rows;
  assert.deepEqual(rows, [
    { comment_id: "in-flight", status: "sent" },
    { comment_id: "after-handoff", status: "pending" },
  ]);
  // The next automated reply for the same person is held by the handoff pause.
  assert.equal(await processNextPrivateReply(pool, transport, () => new Date(), connectionId), false);
  assert.equal(
    (await pool.query("SELECT status FROM private_reply_outbox WHERE comment_id='after-handoff'")).rows[0].status,
    "pending",
  );
});

test("member removal, reassignment and closing during a manual send() recall neither it nor the queued replies", async () => {
  await handoffReady();
  await pool.query(
    "UPDATE instagram_connections SET send_enabled=true,token_expires_at=now()+interval '30 days' WHERE id=$1",
    [connectionId],
  );
  await saved(agent, { expected_version: 0, assignee_user_id: agent.id });
  assert.equal((await startHandoff(agent)).status, 200);
  // The agent queued two manual replies; the first is sent below, the second waits behind it.
  await pool.query(
    `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,created_at)
     VALUES($1,$2,'456',gen_random_uuid(),$3,'in flight',1,clock_timestamp()-interval '1 minute'),
       ($1,$2,'456',gen_random_uuid(),$3,'queued',1,clock_timestamp())`,
    [workspaceId, connectionId, agent.id],
  );
  // An automated reply for the same person is queued and held by the handoff pause.
  await ingestComments(pool, [
    { accountId: "123", commentId: "held", postId: "1002", senderId: "888", text: "link again" },
  ]);
  const heldBefore = (
    await pool.query("SELECT status,attempt_id,next_attempt_at FROM private_reply_outbox WHERE comment_id='held'")
  ).rows[0];
  assert.equal(heldBefore.status, "pending");

  const statuses: number[] = [];
  let sendingDuringChanges: string[] = [];
  const transport = {
    verifyAccount: async () => true,
    // Every change commits after the pre-send checks passed and the provider request is under way.
    send: async (_recipient: string, text: string) => {
      if (text === "in flight") {
        statuses.push((await request(owner, "DELETE", `/api/workspace/members/${agent.id}`)).status);
        statuses.push((await save(admin, { expected_version: 2, assignee_user_id: other.id })).status);
        statuses.push((await save(other, { expected_version: 3, status: "closed" })).status);
        sendingDuringChanges = (
          await pool.query("SELECT status FROM instagram_manual_replies ORDER BY created_at,id")
        ).rows.map((row) => row.status);
      }
      return { messageId: `mid-${text.replace(" ", "-")}` };
    },
  };
  assert.equal(await processNextManualReply(pool, connectionId, transport, "token"), true);
  assert.deepEqual(statuses, [200, 200, 200]);
  assert.deepEqual(sendingDuringChanges, ["sending", "pending"]);
  const state = await detail();
  assert.equal(state.status, "closed");
  assert.equal(state.assignee?.user_id, other.id);
  assert.deepEqual(
    (await events()).map((event) => [event.version, event.reason, event.to_assignee, event.to_status]),
    [
      [1, "manual", agent.id, "open"],
      [2, "member_removed", null, "open"],
      [3, "manual", other.id, "open"],
      [4, "manual", other.id, "closed"],
    ],
  );
  // The in-flight send finished, the handoff is still active, and the held automated reply is unchanged.
  assert.deepEqual((await pool.query("SELECT text,status FROM instagram_manual_replies ORDER BY created_at,id")).rows, [
    { text: "in flight", status: "sent" },
    { text: "queued", status: "pending" },
  ]);
  assert.equal((await pool.query("SELECT active FROM instagram_inbox_handoffs")).rows[0].active, true);
  assert.deepEqual(
    (await pool.query("SELECT status,attempt_id,next_attempt_at FROM private_reply_outbox WHERE comment_id='held'"))
      .rows[0],
    heldBefore,
  );
  // The removed member's queued reply is still delivered after the removal and the reassignment.
  assert.equal(await processNextManualReply(pool, connectionId, transport, "token"), true);
  assert.equal(
    (await pool.query("SELECT status FROM instagram_manual_replies WHERE text='queued'")).rows[0].status,
    "sent",
  );
});

test("a DM that reopens a closed conversation queues behind person deletion instead of deadlocking", async () => {
  await saved(agent, { expected_version: 0, assignee_user_id: agent.id });
  await saved(agent, { expected_version: 1, status: "closed" });
  const ingestion = await pool.connect();
  try {
    await ingestion.query("BEGIN");
    await storeInboxMessage(
      ingestion,
      { accountId: "123", senderId: "456", messageId: "reopen", text: "again", timestamp: new Date(Date.now() - 1000) },
      new Date(),
    );
    const deletion = pool
      .query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','456') AS result", [
        workspaceId,
        connectionId,
        owner.id,
      ])
      .then(
        (result) => result.rows[0].result,
        (error: unknown) => error,
      );
    await waitForLockWaiters(1);
    // Later in the same batch, ingestion takes the connection FOR SHARE (sendingConnection, the reply wait).
    await ingestion.query("SELECT 1 FROM instagram_connections WHERE id=$1 FOR SHARE", [connectionId]);
    await ingestion.query("COMMIT");
    const result = await deletion;
    assert.ok(!(result instanceof Error), String(result));
    assert.equal(result.deleted_counts.instagram_inbox_conversations, 1);
    assert.equal(result.deleted_counts.instagram_inbox_conversation_events, 3);
  } finally {
    await ingestion.query("ROLLBACK").catch(() => undefined);
    ingestion.release();
  }
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_messages")).rows[0].count, 0);
  assert.deepEqual(await events(), []);
});

test("person deletion removes only the deleted DM recipient's conversation state and audit", async () => {
  await dm("789", "second");
  await saved(agent, { expected_version: 0, assignee_user_id: agent.id });
  await saved(agent, { expected_version: 1, status: "closed" });
  await saved(agent, { expected_version: 0, assignee_user_id: agent.id }, "789");
  const result = (
    await pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','456') AS result", [
      workspaceId,
      connectionId,
      owner.id,
    ])
  ).rows[0].result;
  assert.equal(result.deleted_counts.instagram_inbox_conversations, 1);
  assert.equal(result.deleted_counts.instagram_inbox_conversation_events, 2);
  assert.deepEqual(
    (await pool.query("SELECT recipient_id FROM instagram_inbox_conversations")).rows.map((row) => row.recipient_id),
    ["789"],
  );
  assert.deepEqual(
    (await events()).map((event) => event.recipient_id),
    ["789"],
  );
});

for (const deletion of ["connection", "person"] as const)
  test(`a state change waiting on ${deletion} data deletion leaves no conversation rows behind`, async () => {
    await pool.query(
      "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
      [connectionId],
    );
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        deletion === "connection"
          ? "SELECT public.delete_connection_data($1,$2,$3,'123')"
          : "SELECT public.delete_person_data($1,$2,$3,'dm_recipient','456')",
        [workspaceId, connectionId, owner.id],
      );
      const pending = save(agent, { expected_version: 0, status: "closed" });
      await waitForLockWaiters(1);
      await holder.query("COMMIT");
      const response = await pending;
      assert.equal(response.status, 404);
      assert.equal((await body<{ error: string }>(response)).error, "conversation_not_found");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_conversations")).rows[0].count,
      0,
    );
    assert.deepEqual(await events(), []);
  });

// delete_workspace_data locks the workspace row, then the connections, and deletes the members last. A
// state change or a member removal that took a member row before the connection would deadlock with it.
for (const operation of ["state change", "member removal"] as const)
  test(`a ${operation} and workspace deletion queue on the workspace row instead of deadlocking`, async () => {
    await saved(agent, { expected_version: 0, assignee_user_id: agent.id });
    await pool.query(
      "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
      [connectionId],
    );
    const holder = await pool.connect();
    try {
      // Hold the agent's member row so the operation stops at it, then let the deletion run up to its waits.
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM workspace_members WHERE user_id=$1 FOR UPDATE", [agent.id]);
      const pending =
        operation === "state change"
          ? save(agent, { expected_version: 1, status: "closed" })
          : request(owner, "DELETE", `/api/workspace/members/${agent.id}`);
      await waitForLockWaiters(1);
      const deletion = pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspaceId, owner.id]).then(
        (result) => result.rows[0].result,
        (error: unknown) => error,
      );
      await waitForLockWaiters(2);
      await holder.query("ROLLBACK");
      const response = await pending;
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      const result = await deletion;
      assert.ok(!(result instanceof Error), String(result));
      assert.equal(result.deleted_counts.instagram_inbox_conversations, 1);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM workspaces WHERE id=$1", [workspaceId])).rows[0].count,
      0,
    );
  });

test("migration 029 replays and every deletion function removes conversation state", async () => {
  const migration = await readFile(
    new URL("../../db/migrations/029_conversation_assignment.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);
  for (const name of ["delete_connection_data", "delete_person_data", "delete_workspace_data"])
    assert.match(
      (await pool.query("SELECT prosrc FROM pg_proc WHERE proname=$1", [name])).rows[0].prosrc,
      /DELETE FROM public\.instagram_inbox_conversations\b/,
      name,
    );
});
