import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { recordChannelConsentEvent } from "../instagram/channel-consent.ts";
import { appApi } from "./api.ts";
import { PLANS, workspaceEntitlements } from "./plans.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
type Actor = { id: string; email: string };
const owner: Actor = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const outsider: Actor = { id: "55555555-5555-4555-8555-555555555555", email: "outsider@example.test" };
const workspaceId = "66666666-6666-4666-8666-666666666666";
const otherWorkspaceId = "77777777-7777-4777-8777-777777777777";
const connectionId = "88888888-8888-4888-8888-888888888888";
const secondConnectionId = "99999999-9999-4999-8999-999999999999";
const foreignConnectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recipient = "4001";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };
const freeLimit = PLANS.free.user_records_per_workspace;

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE channel_consent_state,channel_consent_events,workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,email) VALUES($1,$2,'owner',$3),($4,$5,'owner',$6)", [workspaceId, owner.id, owner.email, otherWorkspaceId, outsider.id, outsider.email]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,inbox_enabled,inbox_enabled_at)
     VALUES($1,$4,'123',false,true,now()-interval '1 day'),($2,$4,'124',false,true,now()-interval '1 day'),($3,$5,'125',false,true,now()-interval '1 day')`,
    [connectionId, secondConnectionId, foreignConnectionId, workspaceId, otherWorkspaceId],
  );
  for (const [workspace, connection] of [
    [workspaceId, connectionId],
    [workspaceId, secondConnectionId],
    [otherWorkspaceId, foreignConnectionId],
  ])
    await pool.query(
      `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
       VALUES($1,$2,$3,gen_random_uuid()::text,'hello','text',now())`,
      [workspace, connection, recipient],
    );
});

after(async () => pool.end());

function request(actor: Actor, method: string, path: string, body?: unknown) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () => Response.json({ id: actor.id, email: actor.email, email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

const addNote = (connection = connectionId, actor = owner) => request(actor, "POST", `/api/inbox/conversations/${connection}/${recipient}/notes`, { body: "note" });

function consent(decision: "grant" | "revoke", requestKey = crypto.randomUUID(), connection = connectionId) {
  return {
    request_key: requestKey,
    identity_kind: "comment_sender",
    identity_value: "123456",
    purpose: "marketing",
    decision,
    evidence_kind: "comment",
    evidence_reference: "evidence",
    occurred_at: "2026-11-27T01:02:03.000Z",
    connection,
  };
}

function recordConsent(input: ReturnType<typeof consent>) {
  const { connection, ...body } = input;
  return request(owner, "POST", `/api/connections/${connection}/channel-consent-events`, body);
}

// `count` stored rows of each kind in the workspace, written directly like rows from before the limit.
async function seedNotes(count: number, workspace = workspaceId, connection = connectionId) {
  await pool.query(
    `INSERT INTO instagram_inbox_notes(workspace_id,connection_id,recipient_id,author_id,body)
     SELECT $1,$2,$3,$4,'seeded '||g FROM generate_series(1,$5) g`,
    [workspace, connection, recipient, owner.id, count],
  );
}

async function seedConsent(count: number, workspace = workspaceId, connection = connectionId) {
  await pool.query(
    `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
     SELECT gen_random_uuid(),$1,$2,'instagram','comment_sender',g::text,'marketing','grant','comment','seeded',now(),$3 FROM generate_series(1,$4) g`,
    [workspace, connection, owner.id, count],
  );
}

async function counts(workspace = workspaceId) {
  return (
    await pool.query<{ notes: number; events: number; states: number }>(
      `SELECT (SELECT count(*)::int FROM instagram_inbox_notes WHERE workspace_id=$1) AS notes,
         (SELECT count(*)::int FROM channel_consent_events WHERE workspace_id=$1) AS events,
         (SELECT count(*)::int FROM channel_consent_state WHERE workspace_id=$1) AS states`,
      [workspace],
    )
  ).rows[0]!;
}

async function errorCode(response: Response, status: number): Promise<string> {
  const value = (await response.json()) as { error: string };
  assert.equal(response.status, status, JSON.stringify(value));
  return value.error;
}

// Waits until `count` sessions wait on a lock, so a missing lock fails a value assertion below instead of a timeout.
async function lockWaiters(count: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()");
    if (waiting.rows[0]!.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fewer than ${count} lock waiters`);
}

test("the catalog holds the agreed per-kind stored record limit of every plan", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(PLANS).map(([key, limits]) => [key, limits.user_records_per_workspace])), { free: 1000, essential: 10000, pro: 50000, business: 150000, advanced: 500000 });
});

test("a note at the limit is refused and writes nothing; the last free slot and another workspace still write", async () => {
  await seedNotes(freeLimit - 1);
  assert.equal((await addNote()).status, 201);
  assert.equal(await errorCode(await addNote(), 409), "user_record_limit_reached");
  assert.equal(await errorCode(await addNote(secondConnectionId), 409), "user_record_limit_reached");
  assert.equal((await counts()).notes, freeLimit);
  // Consent rows are a separate kind and another workspace has its own count.
  assert.equal((await recordConsent(consent("grant"))).status, 201);
  assert.equal((await addNote(foreignConnectionId, outsider)).status, 201);
});

test("a consent grant at the limit is refused and writes nothing; a revoke and a replay are never refused", async () => {
  const replayed = consent("grant");
  assert.equal((await recordConsent(replayed)).status, 201);
  await seedConsent(freeLimit - 1);
  const before = await counts();
  assert.equal(await errorCode(await recordConsent(consent("grant")), 409), "user_record_limit_reached");
  assert.deepEqual(await counts(), before);
  // A replay of a stored key writes nothing and answers as before; a changed body under that key is still a conflict.
  const replay = await recordConsent(replayed);
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { applied: boolean }).applied, false);
  assert.equal(await errorCode(await recordConsent({ ...replayed, evidence_reference: "changed" }), 409), "consent_request_conflict");
  // A revoke is recorded at and over the limit.
  assert.equal((await recordConsent(consent("revoke"))).status, 201);
  assert.equal((await recordConsent({ ...consent("revoke"), purpose: "all" })).status, 201);
  assert.equal((await counts()).events, freeLimit + 2);
  assert.equal(await errorCode(await recordConsent(consent("grant", undefined, secondConnectionId)), 409), "user_record_limit_reached");
  // Notes are a separate kind.
  assert.equal((await addNote()).status, 201);
});

test("consent recording outside the dashboard API is never refused by the limit", async () => {
  await seedConsent(freeLimit);
  const result = await recordChannelConsentEvent(pool, {
    requestKey: crypto.randomUUID(),
    workspaceId,
    connectionId,
    channel: "instagram",
    identityKind: "comment_sender",
    identityValue: "123456",
    purpose: "marketing",
    decision: "grant",
    evidenceKind: "comment",
    evidenceReference: "automatic",
    occurredAt: new Date(),
    actorId: owner.id,
  });
  assert.equal(result.applied, true);
  assert.equal((await counts()).events, freeLimit + 1);
});

// Each blocked writer waits at its connection lock, so without the workspace lock both would count limit - 1 and insert.
for (const kind of ["note", "consent"] as const)
  test(`two ${kind} writes on different connections at one below the limit admit exactly one`, async () => {
    if (kind === "note") await seedNotes(freeLimit - 1);
    else await seedConsent(freeLimit - 1);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM instagram_connections WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [[connectionId, secondConnectionId]]);
      const write = (connection: string) => (kind === "note" ? addNote(connection) : recordConsent(consent("grant", undefined, connection)));
      const writes = [write(connectionId), write(secondConnectionId)];
      await lockWaiters(2);
      await blocker.query("COMMIT");
      const statuses = (await Promise.all(writes)).map((response) => response.status).sort();
      assert.deepEqual(statuses, [201, 409]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    const stored = await counts();
    assert.equal(kind === "note" ? stored.notes : stored.events, freeLimit);
  });

test("a downgrade keeps every stored record, refuses new ones, and the usage shows the counts against the limit", async () => {
  await pool.query("UPDATE workspaces SET plan='essential' WHERE id=$1", [workspaceId]);
  await seedNotes(freeLimit + 200);
  await seedConsent(freeLimit + 100);
  assert.equal((await addNote()).status, 201);
  await pool.query("UPDATE workspaces SET plan='free' WHERE id=$1", [workspaceId]);
  assert.equal(await errorCode(await addNote(), 409), "user_record_limit_reached");
  assert.equal(await errorCode(await recordConsent(consent("grant")), 409), "user_record_limit_reached");
  assert.deepEqual(await counts(), { notes: freeLimit + 201, events: freeLimit + 100, states: 0 });
  // Another workspace's rows never count.
  await seedNotes(7, otherWorkspaceId, foreignConnectionId);
  const entitlements = await workspaceEntitlements(pool, workspaceId);
  assert.equal(entitlements.limits.user_records_per_workspace, freeLimit);
  assert.deepEqual(entitlements.usage.user_records, { inbox_notes: freeLimit + 201, consent_events: freeLimit + 100 });
  const workspace = (await (await request(owner, "POST", "/api/workspace")).json()) as { usage: { user_records: unknown } };
  assert.deepEqual(workspace.usage.user_records, { inbox_notes: freeLimit + 201, consent_events: freeLimit + 100 });
  const members = (await (await request(owner, "GET", "/api/workspace/members")).json()) as { usage: { user_records: unknown } };
  assert.deepEqual(members.usage.user_records, workspace.usage.user_records);
  assert.deepEqual((await workspaceEntitlements(pool, otherWorkspaceId)).usage.user_records, { inbox_notes: 7, consent_events: 0 });
});
