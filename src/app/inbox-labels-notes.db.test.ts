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
const connectionId = "88888888-8888-4888-8888-888888888888";
const secondConnectionId = "99999999-9999-4999-8999-999999999999";
const foreignConnectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };

type Actor = { id: string; email: string };
type Label = { id: string; name: string; archived: boolean };
type LabelSet = { version: number; labels: Label[] };
type Note = { id: string; body: string; author: { user_id: string; email: string | null }; created_at: string };

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
) {
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

async function body<T>(response: Response, status: number): Promise<T> {
  const value = (await response.json()) as T;
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

async function errorCode(response: Response, status: number): Promise<string> {
  return (await body<{ error: string }>(response, status)).error;
}

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

const createLabel = (actor: Actor, name: string) => request(actor, "POST", "/api/inbox/labels", { name });
async function label(name: string, actor: Actor = admin): Promise<Label> {
  return body<Label>(await createLabel(actor, name), 201);
}

const labelsPath = (recipient = "456", connection = connectionId) =>
  `/api/inbox/conversations/${connection}/${recipient}/labels`;
const putLabels = (actor: Actor, ids: string[], expected: number, recipient = "456", connection = connectionId) =>
  request(actor, "PUT", labelsPath(recipient, connection), { expected_version: expected, label_ids: ids });
const notesPath = (recipient = "456", connection = connectionId) =>
  `/api/inbox/conversations/${connection}/${recipient}/notes`;
const addNote = (actor: Actor, text: unknown, recipient = "456", connection = connectionId) =>
  request(actor, "POST", notesPath(recipient, connection), { body: text });

async function labelRows() {
  return (
    await pool.query(
      "SELECT connection_id,recipient_id,label_ids::text[] AS label_ids,version FROM instagram_inbox_conversation_labels ORDER BY recipient_id",
    )
  ).rows;
}
async function eventRows() {
  return (
    await pool.query(
      `SELECT recipient_id,version,added::text[] AS added,removed::text[] AS removed,actor_id
       FROM instagram_inbox_label_events ORDER BY recipient_id,version`,
    )
  ).rows;
}
async function noteCount(): Promise<number> {
  return (await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_notes")).rows[0].count;
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

test("admins manage labels; every role lists them with archived ones flagged", async () => {
  const vip = await label("  VIP 고객  ");
  assert.equal(vip.name, "VIP 고객");
  assert.equal(vip.archived, false);
  const refund = await label("환불 문의", owner);
  for (const name of ["", "   ", "a".repeat(31), "탭\u0007", "zero​width", 7])
    assert.equal(await errorCode(await createLabel(admin, name as string), 400), "invalid_label", String(name));
  assert.equal((await createLabel(admin, "가".repeat(30))).status, 201);
  assert.equal(
    await errorCode(await request(admin, "POST", "/api/inbox/labels", { name: "x", color: "red" }), 400),
    "invalid_label",
  );
  // Agents read labels but cannot change them.
  assert.equal(await errorCode(await createLabel(agent, "agent label"), 403), "role_forbidden");
  assert.equal(
    await errorCode(await request(agent, "PATCH", `/api/inbox/labels/${vip.id}`, { name: "x" }), 403),
    "role_forbidden",
  );
  assert.equal(await errorCode(await request(agent, "DELETE", `/api/inbox/labels/${vip.id}`), 403), "role_forbidden");
  assert.equal(await errorCode(await request(stranger, "GET", "/api/inbox/labels"), 403), "workspace_required");

  // Names are unique among active labels, ignoring case; archiving frees the name.
  assert.equal(await errorCode(await createLabel(admin, "vip 고객"), 409), "label_name_exists");
  const renamed = await body<Label>(
    await request(admin, "PATCH", `/api/inbox/labels/${refund.id}`, { name: " 환불 " }),
    200,
  );
  assert.equal(renamed.name, "환불");
  assert.equal(
    await errorCode(await request(admin, "PATCH", `/api/inbox/labels/${refund.id}`, { name: "VIP 고객" }), 409),
    "label_name_exists",
  );
  const archived = await body<Label>(await request(admin, "DELETE", `/api/inbox/labels/${vip.id}`), 200);
  assert.equal(archived.archived, true);
  assert.equal((await request(admin, "DELETE", `/api/inbox/labels/${vip.id}`)).status, 200);
  assert.equal(
    await errorCode(await request(admin, "PATCH", `/api/inbox/labels/${vip.id}`, { name: "new" }), 409),
    "label_archived",
  );
  const again = await label("vip 고객");
  assert.notEqual(again.id, vip.id);

  const listed = await body<{ labels: Label[] }>(await request(agent, "GET", "/api/inbox/labels"), 200);
  // Active labels first, by name in the database collation, then the archived ones.
  assert.deepEqual(
    listed.labels.map((row) => row.archived),
    [false, false, false, true],
  );
  assert.deepEqual(
    listed.labels
      .slice(0, 3)
      .map((row) => row.name)
      .sort(),
    ["vip 고객", "가".repeat(30), "환불"].sort(),
  );
  assert.equal(listed.labels[3]!.id, vip.id);
  // Another workspace's label is not found, and its list is separate.
  const foreign = await label("foreign", outsider);
  assert.equal(
    await errorCode(await request(admin, "PATCH", `/api/inbox/labels/${foreign.id}`, { name: "mine" }), 404),
    "label_not_found",
  );
  assert.equal(
    await errorCode(await request(admin, "DELETE", `/api/inbox/labels/${foreign.id}`), 404),
    "label_not_found",
  );
  assert.equal(
    (await body<{ labels: Label[] }>(await request(outsider, "GET", "/api/inbox/labels"), 200)).labels.length,
    1,
  );
  assert.equal(await errorCode(await request(admin, "DELETE", "/api/inbox/labels/abc-123"), 400), "invalid_label");
  const crossOrigin = await appApi(
    new Request("https://app.test/api/inbox/labels", {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ name: "evil" }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
  );
  assert.equal(crossOrigin.status, 403);
});

test("a workspace has at most 50 active labels; archived labels do not count", async () => {
  for (let index = 0; index < 50; index += 1) await label(`label ${index}`);
  assert.equal(await errorCode(await createLabel(admin, "label 50"), 409), "label_limit_reached");
  const first = (await body<{ labels: Label[] }>(await request(admin, "GET", "/api/inbox/labels"), 200)).labels[0]!;
  await body(await request(admin, "DELETE", `/api/inbox/labels/${first.id}`), 200);
  await label("label 50");
  assert.equal(await errorCode(await createLabel(admin, "label 51"), 409), "label_limit_reached");
});

test("concurrent creations at the limit queue on the workspace row, so only one passes", async () => {
  for (let index = 0; index < 49; index += 1)
    await pool.query("INSERT INTO instagram_inbox_labels(workspace_id,name,created_by) VALUES($1,$2,$3)", [
      workspaceId,
      `label ${index}`,
      admin.id,
    ]);
  const held = heldBeforeCommit(admin, "POST", "/api/inbox/labels", { name: "first" });
  try {
    await reachCommit(held);
    let settled = false;
    const second = createLabel(owner, "second").finally(() => (settled = true));
    await settledOrWaiting(second);
    const waited = !settled;
    held.release();
    assert.equal((await held.response).status, 201);
    assert.equal(await errorCode(await second, 409), "label_limit_reached");
    assert.ok(waited, "the second creation did not wait for the first");
  } finally {
    held.release();
  }
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_labels WHERE NOT archived")).rows[0].count,
    50,
  );
});

test("a label set changes at its expected version and writes one audit row per version", async () => {
  await seed("456", "hello", "2026-10-01T00:00:01Z");
  const vip = await label("vip");
  const refund = await label("refund");
  const empty = await body<LabelSet>(await request(agent, "GET", `/api/connections/${connectionId}/inbox/456`), 200);
  assert.deepEqual((empty as unknown as { label_set: LabelSet }).label_set, { version: 0, labels: [] });
  // An unchanged set and a stale version store nothing, not even a version 0 row.
  assert.deepEqual(await body<LabelSet>(await putLabels(agent, [], 0), 200), { version: 0, labels: [] });
  assert.equal(await errorCode(await putLabels(agent, [vip.id], 3), 409), "label_conflict");
  assert.deepEqual(await labelRows(), []);

  const first = await body<LabelSet>(await putLabels(agent, [vip.id, refund.id], 0), 200);
  assert.deepEqual(first, {
    version: 1,
    labels: [
      { id: refund.id, name: "refund", archived: false },
      { id: vip.id, name: "vip", archived: false },
    ],
  });
  // The same set in another order changes nothing and writes no audit row.
  assert.deepEqual(await body<LabelSet>(await putLabels(agent, [refund.id, vip.id], 1), 200), first);
  const second = await body<LabelSet>(await putLabels(admin, [vip.id], 1), 200);
  assert.equal(second.version, 2);
  // A stale version answers 409 with the current set and changes nothing.
  const conflict = await body<{ error: string; label_set: LabelSet }>(await putLabels(owner, [], 1), 409);
  assert.equal(conflict.error, "label_conflict");
  assert.deepEqual(conflict.label_set, second);
  assert.deepEqual(await body<LabelSet>(await putLabels(owner, [], 2), 200), { version: 3, labels: [] });
  assert.deepEqual(await eventRows(), [
    { recipient_id: "456", version: 1, added: [refund.id, vip.id].sort(), removed: [], actor_id: agent.id },
    { recipient_id: "456", version: 2, added: [], removed: [refund.id], actor_id: admin.id },
    { recipient_id: "456", version: 3, added: [], removed: [vip.id], actor_id: owner.id },
  ]);
  const opened = (await body<{ label_set: LabelSet }>(
    await request(agent, "GET", `/api/connections/${connectionId}/inbox/456`),
    200,
  )) as { label_set: LabelSet };
  assert.deepEqual(opened.label_set, { version: 3, labels: [] });
});

test("an archived label stays on a conversation that has it but cannot be added", async () => {
  await seed("456", "hello", "2026-10-01T00:00:01Z");
  await seed("457", "hi", "2026-10-01T00:00:02Z");
  const vip = await label("vip");
  const refund = await label("refund");
  await body(await putLabels(agent, [vip.id], 0), 200);
  await body(await request(admin, "DELETE", `/api/inbox/labels/${vip.id}`), 200);
  assert.equal(await errorCode(await putLabels(agent, [vip.id], 0, "457"), 409), "label_archived");
  // Keeping the archived label while adding another is allowed, and it is shown as archived.
  const kept = await body<LabelSet>(await putLabels(agent, [vip.id, refund.id], 1), 200);
  assert.deepEqual(kept.labels, [
    { id: refund.id, name: "refund", archived: false },
    { id: vip.id, name: "vip", archived: true },
  ]);
  const listed = await body<{ conversations: { recipient_id: string; label_set: LabelSet }[] }>(
    await request(agent, "GET", "/api/inbox"),
    200,
  );
  assert.deepEqual(
    listed.conversations.map((row) => [row.recipient_id, row.label_set.labels.map((item) => item.archived)]),
    [
      ["457", []],
      ["456", [false, true]],
    ],
  );
  // Removing it is allowed; adding it back is not.
  await body(await putLabels(agent, [refund.id], 2), 200);
  assert.equal(await errorCode(await putLabels(agent, [refund.id, vip.id], 3), 409), "label_archived");
});

test("label set requests are validated, scoped to the workspace and refused to non-members", async () => {
  await seed("456", "hello", "2026-10-01T00:00:01Z");
  await seed("700", "foreign", "2026-10-01T00:00:01Z", foreignConnectionId);
  const vip = await label("vip");
  const foreign = await label("foreign", outsider);
  const many = [];
  for (let index = 0; index < 11; index += 1) many.push((await label(`many ${index}`)).id);
  for (const payload of [
    {},
    { expected_version: 0 },
    { label_ids: [] },
    { expected_version: -1, label_ids: [] },
    { expected_version: 0.5, label_ids: [] },
    { expected_version: "0", label_ids: [] },
    { expected_version: 0, label_ids: "x" },
    { expected_version: 0, label_ids: ["not-a-uuid"] },
    { expected_version: 0, label_ids: [vip.id, vip.id] },
    { expected_version: 0, label_ids: [vip.id, vip.id.toUpperCase()] },
    { expected_version: 0, label_ids: many },
    { expected_version: 0, label_ids: [], extra: true },
  ])
    assert.equal(
      await errorCode(await request(agent, "PUT", labelsPath(), payload), 400),
      "invalid_label_request",
      JSON.stringify(payload),
    );
  // Ten labels is the most a conversation holds.
  assert.equal((await putLabels(agent, many.slice(0, 10), 0)).status, 200);
  assert.equal(
    await errorCode(await request(agent, "PUT", `${labelsPath()}?x=1`, { expected_version: 0, label_ids: [] }), 400),
    "invalid_label_request",
  );
  assert.equal(await errorCode(await putLabels(agent, [foreign.id], 1), 404), "label_not_found");
  assert.equal(await errorCode(await putLabels(agent, [vip.id], 0, "999"), 404), "conversation_not_found");
  assert.equal(
    await errorCode(await putLabels(agent, [vip.id], 0, "700", foreignConnectionId), 404),
    "connection_not_found",
  );
  assert.equal(await errorCode(await putLabels(stranger, [], 0), 403), "workspace_required");
  const crossOrigin = await appApi(
    new Request(`https://app.test${labelsPath()}`, {
      method: "PUT",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ expected_version: 1, label_ids: [] }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
  );
  assert.equal(crossOrigin.status, 403);
  // A removed member is refused.
  assert.equal((await request(owner, "DELETE", `/api/workspace/members/${other.id}`)).status, 200);
  assert.equal(await errorCode(await putLabels(other, [], 1), 403), "workspace_required");
  assert.equal((await labelRows())[0].version, 1);
});

test("an archive that starts after a label was checked waits for the label write", async () => {
  await seed("456", "hello", "2026-10-01T00:00:01Z");
  const vip = await label("vip");
  const held = heldBeforeCommit(agent, "PUT", labelsPath(), { expected_version: 0, label_ids: [vip.id] });
  try {
    await reachCommit(held);
    let settled = false;
    const archive = request(admin, "DELETE", `/api/inbox/labels/${vip.id}`).finally(() => (settled = true));
    await settledOrWaiting(archive);
    const waited = !settled;
    held.release();
    assert.equal((await held.response).status, 200);
    assert.equal((await archive).status, 200);
    assert.ok(waited, "the archive did not wait for the label write that checked the label");
  } finally {
    held.release();
  }
  assert.deepEqual(
    (await labelRows()).map((row) => row.label_ids),
    [[vip.id]],
  );
});

test("a label write that waits on an uncommitted archive sees the archive and refuses", async () => {
  await seed("456", "hello", "2026-10-01T00:00:01Z");
  const vip = await label("vip");
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("UPDATE instagram_inbox_labels SET archived=true WHERE id=$1", [vip.id]);
    const pending = putLabels(agent, [vip.id], 0);
    await settledOrWaiting(pending);
    await holder.query("COMMIT");
    assert.equal(await errorCode(await pending, 409), "label_archived");
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
  assert.deepEqual(await eventRows(), []);
});

test("notes are append-only text listed newest first, never as messages and never searched", async () => {
  await seed("456", "hello there", "2026-10-01T00:00:01Z");
  const first = await body<Note>(await addNote(agent, "  환불 요청 확인 중  "), 201);
  assert.equal(first.body, "환불 요청 확인 중");
  assert.deepEqual(first.author, { user_id: agent.id, email: agent.email });
  await body<Note>(await addNote(owner, "가".repeat(2000)), 201);
  for (const text of ["", "   ", "가".repeat(2001), "nul\u0000"])
    assert.equal(await errorCode(await addNote(agent, text), 400), "invalid_note", text.slice(0, 5));
  for (const payload of [{}, { body: 7 }, { body: "x", extra: true }])
    assert.equal(
      await errorCode(await request(agent, "POST", notesPath(), payload), 400),
      "invalid_note_request",
      JSON.stringify(payload),
    );
  assert.equal(await errorCode(await addNote(agent, "x", "999"), 404), "conversation_not_found");
  assert.equal(await errorCode(await addNote(agent, "x", "456", foreignConnectionId), 404), "connection_not_found");
  assert.equal(await errorCode(await addNote(stranger, "x"), 403), "workspace_required");
  assert.equal(await errorCode(await request(agent, "PATCH", `${notesPath()}`, { body: "x" }), 404), "not_found");
  for (let index = 0; index < 49; index += 1) await body(await addNote(admin, `note ${index}`), 201);
  const page = await body<{ notes: Note[]; before: string | null }>(await request(agent, "GET", notesPath()), 200);
  assert.equal(page.notes.length, 50);
  assert.equal(page.notes[0]!.body, "note 48");
  assert.ok(page.before);
  const rest = await body<{ notes: Note[]; before: string | null }>(
    await request(agent, "GET", `${notesPath()}?before=${page.before}`),
    200,
  );
  assert.deepEqual(
    rest.notes.map((note) => note.id),
    [first.id],
  );
  assert.equal(rest.before, null);
  assert.equal(await errorCode(await request(agent, "GET", `${notesPath()}?before=0`), 400), "invalid_note_request");
  // A note is not a message and is not found by the DM search.
  const messages = await body<{ messages: { text: string }[] }>(
    await request(agent, "GET", `/api/connections/${connectionId}/inbox/456`),
    200,
  );
  assert.deepEqual(
    messages.messages.map((message) => message.text),
    ["hello there"],
  );
  const searched = await body<{ conversations: unknown[] }>(
    await request(agent, "GET", `/api/inbox?q=${encodeURIComponent("환불")}`),
    200,
  );
  assert.deepEqual(searched.conversations, []);
  // Every note above is stored; access.db.test.ts checks that server roles cannot update or delete one.
  assert.equal(await noteCount(), 51);
});

test("the label filter combines with the other filters and pages with the cursor", async () => {
  const vip = await label("vip");
  const other = await label("other");
  for (let index = 0; index < 53; index += 1) {
    const recipient = String(1000 + index);
    await seed(
      recipient,
      `message ${index}`,
      new Date(Date.parse("2026-10-01T01:00:00Z") - index * 1000).toISOString(),
    );
    // Every recipient but 1001 and 1002 gets vip; 1002 gets the other label.
    if (index === 1) continue;
    await body(await putLabels(admin, index === 2 ? [other.id] : [vip.id], 0, recipient), 200);
  }
  const first = await body<{ conversations: { recipient_id: string; label_set: LabelSet }[]; after: string | null }>(
    await request(agent, "GET", `/api/inbox?label=${vip.id}`),
    200,
  );
  assert.equal(first.conversations.length, 50);
  assert.ok(first.conversations.every((row) => row.label_set.labels.some((item) => item.id === vip.id)));
  assert.ok(first.after);
  const second = await body<{ conversations: { recipient_id: string }[]; after: string | null }>(
    await request(agent, "GET", `/api/inbox?label=${vip.id}&after=${first.after}`),
    200,
  );
  assert.deepEqual(
    second.conversations.map((row) => row.recipient_id),
    ["1052"],
  );
  assert.equal(second.after, null);
  const all = [...first.conversations, ...second.conversations].map((row) => row.recipient_id);
  assert.equal(new Set(all).size, 51);
  assert.ok(!all.includes("1001") && !all.includes("1002"));
  // Combined with a status filter and a search.
  await body(
    await request(admin, "PUT", `/api/inbox/conversations/${connectionId}/1003/state`, {
      expected_version: 0,
      status: "closed",
    }),
    200,
  );
  const closed = await body<{ conversations: { recipient_id: string }[] }>(
    await request(agent, "GET", `/api/inbox?label=${vip.id}&status=closed`),
    200,
  );
  assert.deepEqual(
    closed.conversations.map((row) => row.recipient_id),
    ["1003"],
  );
  const searched = await body<{ conversations: { recipient_id: string }[] }>(
    await request(agent, "GET", `/api/inbox?label=${other.id}&q=message%202`),
    200,
  );
  assert.deepEqual(
    searched.conversations.map((row) => row.recipient_id),
    ["1002"],
  );
  assert.equal(await errorCode(await request(agent, "GET", "/api/inbox?label=not-a-uuid"), 400), "invalid_inbox_query");
  // A label of another workspace matches nothing.
  const foreign = await label("foreign", outsider);
  assert.deepEqual(
    (await body<{ conversations: unknown[] }>(await request(agent, "GET", `/api/inbox?label=${foreign.id}`), 200))
      .conversations,
    [],
  );
});

for (const deletion of ["connection", "person", "workspace"] as const) {
  test(`label and note writes waiting on ${deletion} deletion leave no row behind`, async () => {
    await seed("456", "one", "2026-10-01T00:00:01Z");
    const vip = await label("vip");
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(deletionSql[deletion][0], [...deletionSql[deletion][1]]);
      const labels = putLabels(agent, [vip.id], 0);
      const note = addNote(agent, "memo");
      await settledOrWaiting(Promise.all([labels, note]), 2);
      await holder.query("COMMIT");
      const expected = deletion === "workspace" ? 403 : 404;
      assert.equal((await labels).status, expected);
      assert.equal((await note).status, expected);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    assert.deepEqual(await labelRows(), []);
    assert.equal(await noteCount(), 0);
  });

  test(`${deletion} deletion started while a label write is uncommitted waits for it and removes its rows`, async () => {
    await seed("456", "one", "2026-10-01T00:00:01Z");
    const vip = await label("vip");
    const held = heldBeforeCommit(agent, "PUT", labelsPath(), { expected_version: 0, label_ids: [vip.id] });
    try {
      await reachCommit(held);
      let settled = false;
      const removal = runDeletion(deletion)
        .then(
          (result) => result.rows[0].result,
          (error: unknown) => error,
        )
        .finally(() => (settled = true));
      await settledOrWaiting(removal);
      const waited = !settled;
      held.release();
      assert.equal((await held.response).status, 200);
      const result = await removal;
      assert.ok(!(result instanceof Error), String(result));
      assert.equal(result.deleted_counts.instagram_inbox_conversation_labels, 1);
      assert.equal(result.deleted_counts.instagram_inbox_label_events, 1);
      assert.ok(waited, "the deletion did not wait for the uncommitted label write");
    } finally {
      held.release();
    }
    assert.deepEqual(await labelRows(), []);
    assert.deepEqual(await eventRows(), []);
  });

  test(`${deletion} deletion started while a note is uncommitted waits for it and removes it`, async () => {
    await seed("456", "one", "2026-10-01T00:00:01Z");
    const held = heldBeforeCommit(agent, "POST", notesPath(), { body: "memo" });
    try {
      await reachCommit(held);
      let settled = false;
      const removal = runDeletion(deletion)
        .then(
          (result) => result.rows[0].result,
          (error: unknown) => error,
        )
        .finally(() => (settled = true));
      await settledOrWaiting(removal);
      const waited = !settled;
      held.release();
      assert.equal((await held.response).status, 201);
      const result = await removal;
      assert.ok(!(result instanceof Error), String(result));
      assert.equal(result.deleted_counts.instagram_inbox_notes, 1);
      assert.ok(waited, "the deletion did not wait for the uncommitted note");
    } finally {
      held.release();
    }
    assert.equal(await noteCount(), 0);
  });
}

// delete_workspace_data locks the workspace row, then the connections, and deletes the members last. A label write
// that took the member row before the workspace row would hold it while waiting for a connection, and deadlock.
test("a label write and workspace deletion queue on the workspace row instead of deadlocking", async () => {
  await seed("456", "one", "2026-10-01T00:00:01Z");
  const vip = await label("vip");
  const holder = await pool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM workspace_members WHERE user_id=$1 FOR UPDATE", [agent.id]);
    const pending = putLabels(agent, [vip.id], 0);
    await settledOrWaiting(pending);
    const deletion = runDeletion("workspace").then(
      (result) => result.rows[0].result,
      (error: unknown) => error,
    );
    await settledOrWaiting(deletion, 2);
    await holder.query("ROLLBACK");
    assert.equal((await pending).status, 200);
    const result = await deletion;
    assert.ok(!(result instanceof Error), String(result));
    assert.equal(result.deleted_counts.instagram_inbox_conversation_labels, 1);
    assert.equal(result.deleted_counts.instagram_inbox_labels, 1);
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
  assert.deepEqual(await labelRows(), []);
});

test("person deletion removes only that DM recipient's label sets, audit and notes", async () => {
  await seed("456", "one", "2026-10-01T00:00:01Z");
  await seed("457", "two", "2026-10-01T00:00:02Z");
  await seed("458", "three", "2026-10-01T00:00:03Z", secondConnectionId);
  const vip = await label("vip");
  for (const [recipient, connection] of [
    ["456", connectionId],
    ["457", connectionId],
    ["458", secondConnectionId],
  ] as const) {
    await body(await putLabels(agent, [vip.id], 0, recipient, connection), 200);
    await body(await addNote(agent, `note ${recipient}`, recipient, connection), 201);
  }
  const person = (await runDeletion("person")).rows[0].result;
  assert.equal(person.deleted_counts.instagram_inbox_conversation_labels, 1);
  assert.equal(person.deleted_counts.instagram_inbox_label_events, 1);
  assert.equal(person.deleted_counts.instagram_inbox_notes, 1);
  assert.deepEqual(
    (await labelRows()).map((row) => row.recipient_id),
    ["457", "458"],
  );
  assert.deepEqual(
    (await pool.query("SELECT recipient_id FROM instagram_inbox_notes ORDER BY recipient_id")).rows.map(
      (row) => row.recipient_id,
    ),
    ["457", "458"],
  );
  const connection = (await runDeletion("connection")).rows[0].result;
  assert.equal(connection.deleted_counts.instagram_inbox_notes, 1);
  assert.equal(connection.deleted_counts.instagram_inbox_conversation_labels, 1);
  // The workspace's label definitions stay until the workspace is deleted.
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_labels")).rows[0].count, 1);
  const workspace = (await runDeletion("workspace")).rows[0].result;
  assert.equal(workspace.deleted_counts.instagram_inbox_notes, 1);
  assert.equal(workspace.deleted_counts.instagram_inbox_labels, 1);
  assert.deepEqual(await labelRows(), []);
  assert.equal(await noteCount(), 0);
});

test("migration 033 replays (with 034 after it), every deletion function removes label and note rows, and the export lists the tables", async () => {
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
    assert.match(text, /DELETE FROM public\.instagram_inbox_conversation_labels\b/, proname);
    assert.match(text, /DELETE FROM public\.instagram_inbox_label_events\b/, proname);
    assert.match(text, /DELETE FROM public\.instagram_inbox_notes\b/, proname);
  }
  const migration = await readFile(new URL("../../db/migrations/033_inbox_labels_notes.sql", import.meta.url), "utf8");
  // Migration 034 redefines the same functions after 033, in the order deploy/migrate-multi-user.sql runs them.
  const later = await readFile(new URL("../../db/migrations/034_inbox_reminders.sql", import.meta.url), "utf8");
  for (let run = 0; run < 2; run++) {
    await pool.query(migration);
    await pool.query(later);
  }
  assert.deepEqual(await functions(), current);
  for (const table of [
    "instagram_inbox_labels",
    "instagram_inbox_conversation_labels",
    "instagram_inbox_label_events",
    "instagram_inbox_notes",
  ])
    assert.deepEqual(EXPORTED_TABLES[table], { scope: "workspace" }, table);
  // The set holds at most 10 labels, without NULL or a repeat, and an event records a real change.
  await seed("456", "one", "2026-10-01T00:00:01Z");
  const insertSet = (ids: string) =>
    pool.query(
      `INSERT INTO instagram_inbox_conversation_labels(workspace_id,connection_id,recipient_id,label_ids) VALUES($1,$2,'456',${ids})`,
      [workspaceId, connectionId],
    );
  await assert.rejects(insertSet("ARRAY[NULL]::uuid[]"), { code: "23514" });
  await assert.rejects(
    insertSet(
      "ARRAY[gen_random_uuid(),gen_random_uuid()]||'{00000000-0000-4000-8000-000000000000,00000000-0000-4000-8000-000000000000}'::uuid[]",
    ),
    { code: "23514" },
  );
  await assert.rejects(insertSet("ARRAY(SELECT gen_random_uuid() FROM generate_series(1,11))"), { code: "23514" });
  await insertSet("'{}'");
  await assert.rejects(
    pool.query(
      `INSERT INTO instagram_inbox_label_events(workspace_id,connection_id,recipient_id,version,added,removed,actor_id)
       VALUES($1,$2,'456',1,'{}','{}',$3)`,
      [workspaceId, connectionId, agent.id],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO instagram_inbox_notes(workspace_id,connection_id,recipient_id,author_id,body) VALUES($1,$2,'456',$3,'   ')",
      [workspaceId, connectionId, agent.id],
    ),
    { code: "23514" },
  );
});
