import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { resetTestSchema } from "../test-schema.ts";
import { appApi } from "./api.ts";
import { ensureWorkspace, listRules, saveRule } from "./settings.ts";
import { ingestComments } from "../instagram/store.ts";
import { processNextPrivateReply, type PrivateReplyTransport } from "../instagram/reply-worker.ts";

const url = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: url.toString() });
const a = { id: "11111111-1111-4111-8111-111111111111", email: "a@example.test" };
const b = { id: "22222222-2222-4222-8222-222222222222", email: "b@example.test" };
const connectionId = "33333333-3333-4333-8333-333333333333";
const missingId = "99999999-9999-4999-8999-999999999999";
const input = {
  connection_id: connectionId,
  media_id: "12345",
  keywords: ["link"],
  excluded_keywords: [],
  match_mode: "contains",
  private_reply_text: "Hello",
  enabled: true,
  follow_gate_enabled: false,
};

async function request(method: string, path: string, body?: unknown, user = a) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" },
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () => Response.json({ ...user, email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

const archive = (id: string, user = a) => request("DELETE", `/api/rules/${id}`, undefined, user);

async function stored(id: string) {
  return (await pool.query<{ enabled: boolean; archived_at: Date | null; private_reply_text: string }>("SELECT enabled,archived_at,private_reply_text FROM instagram_comment_rules WHERE id=$1", [id])).rows[0];
}

async function comment(commentId: string) {
  await ingestComments(pool, [{ accountId: "123", commentId, postId: input.media_id, senderId: "456", text: "link please" }]);
}

const outbox = async () => (await pool.query<{ rule_id: string; status: string; failure_code: string | null }>("SELECT rule_id,status,failure_code FROM private_reply_outbox ORDER BY id")).rows;

before(async () => {
  await resetTestSchema(pool);
  // The migration replays on a database that already has the column and the constraint.
  await pool.query(await readFile(new URL("../../db/migrations/073_comment_rule_archive.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  const workspace = await ensureWorkspace(pool, a);
  await ensureWorkspace(pool, b);
  await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at) VALUES($1,$2,'123',true,'encrypted-test',now()+interval '1 day')", [connectionId, workspace]);
});
after(async () => {
  await pool.end();
});

test("archiving turns a rule off, hides it, and repeats with the same result", async () => {
  const { id } = await saveRule(pool, a, input);
  const first = await archive(id);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.id, id);
  assert.ok(body.archived_at);
  const row = await stored(id);
  assert.equal(row?.enabled, false);
  assert.ok(row?.archived_at);
  assert.deepEqual(await listRules(pool, a), []);

  const second = await archive(id);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), body);
  assert.equal((await stored(id))?.archived_at?.getTime(), row?.archived_at?.getTime());
});

test("archiving another workspace's or an unknown rule answers 404 rule_not_found and changes nothing", async () => {
  const { id } = await saveRule(pool, a, input);
  for (const [ruleId, user] of [
    [id, b],
    [missingId, a],
  ] as const) {
    const response = await archive(ruleId, user);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "rule_not_found");
  }
  const malformed = await archive("not-a-uuid");
  assert.equal(malformed.status, 404, "the route pattern refuses a non-hex ID");
  const invalid = await archive("1234");
  assert.equal(invalid.status, 400);
  assert.equal((await stored(id))?.archived_at, null);
  assert.equal((await stored(id))?.enabled, true);
  assert.equal((await listRules(pool, a)).length, 1);
});

// Security audit #62, fifth pass: the role table in workspace-roles.db.test.ts sends an unknown ID; this one archives a
// rule that exists, so a role check that ran after the archiving UPDATE would also be caught: the row would be archived.
test("an agent or a removed administrator cannot archive an existing rule", async () => {
  const { id } = await saveRule(pool, a, input);
  const workspace = (await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1", [a.id])).rows[0].workspace_id;
  await pool.query("UPDATE workspace_members SET workspace_id=$2,role='agent' WHERE user_id=$1", [b.id, workspace]);
  const agent = await archive(id, b);
  assert.equal(agent.status, 403);
  assert.equal((await agent.json()).error, "role_forbidden");
  await pool.query("UPDATE workspace_members SET role='admin',removed_at=now(),removed_by=$2 WHERE user_id=$1", [b.id, a.id]);
  const removed = await archive(id, b);
  assert.equal(removed.status, 403);
  assert.equal((await removed.json()).error, "workspace_required");
  assert.equal((await stored(id))?.archived_at, null);
  assert.equal((await stored(id))?.enabled, true);
  assert.equal((await listRules(pool, a)).length, 1);
});

test("archiving requires the same origin", async () => {
  const { id } = await saveRule(pool, a, input);
  const response = await appApi(
    new Request(`https://app.test/api/rules/${id}`, { method: "DELETE", headers: { origin: "https://evil.test", cookie: "__Host-ac-access=test" } }),
    { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" },
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () => Response.json({ ...a, email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
  assert.equal(response.status, 403);
  assert.equal((await stored(id))?.archived_at, null);
});

test("an edit by ID of an archived rule answers 409 rule_archived", async () => {
  const { id } = await saveRule(pool, a, input);
  assert.equal((await archive(id)).status, 200);
  for (const enabled of [true, false]) {
    const response = await request("PUT", "/api/rules", { ...input, id, enabled, private_reply_text: "Edited" });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "rule_archived");
  }
  const row = await stored(id);
  assert.equal(row?.private_reply_text, "Hello");
  assert.equal(row?.enabled, false);
  assert.ok(row?.archived_at);
  // Another workspace's ID keeps the earlier answer.
  await assert.rejects(saveRule(pool, b, { ...input, id }), (error: unknown) => error instanceof Error && error.message === "connection_not_found");
});

const neverSends = () => {
  const transport: PrivateReplyTransport & { sends: number } = {
    sends: 0,
    verify: async () => ({ commentCreatedAt: new Date(), authorizationVerified: true, mediaOwned: true }),
    send: async () => {
      transport.sends++;
      return { messageId: "unexpected" };
    },
  };
  return transport;
};

test("saving without an ID on the media of an archived rule inserts a new active rule and leaves the archived row final", async () => {
  const { id } = await saveRule(pool, a, input);
  assert.equal((await archive(id)).status, 200);
  const saved = await saveRule(pool, a, { ...input, private_reply_text: "Back again" });
  assert.notEqual(saved.id, id, "a new row, not the archived one");
  const archived = await stored(id);
  assert.equal(archived?.enabled, false);
  assert.ok(archived?.archived_at);
  assert.equal(archived?.private_reply_text, "Hello");
  assert.deepEqual(
    (await listRules(pool, a)).map((rule) => [rule.id, rule.private_reply_text, rule.enabled]),
    [[saved.id, "Back again", true]],
  );
  // A second save without an ID updates the new active row instead of inserting a third one.
  const again = await saveRule(pool, a, { ...input, private_reply_text: "Third text" });
  assert.equal(again.id, saved.id);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_comment_rules")).rows[0].count, 2);
});

test("an archived rule queues no reply for a new comment, and a new rule on the media replies with its own text", async () => {
  const { id } = await saveRule(pool, a, input);
  assert.equal((await archive(id)).status, 200);
  await comment("while-archived");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_comment_events WHERE comment_id='while-archived'")).rows[0].count, 1, "the comment event is still stored");
  assert.deepEqual(await outbox(), []);

  const saved = await saveRule(pool, a, { ...input, private_reply_text: "New text" });
  await ingestComments(pool, [{ accountId: "123", commentId: "after-new-rule", postId: input.media_id, senderId: "789", text: "link please" }]);
  const rows = (await pool.query<{ rule_id: string; private_reply_text: string }>("SELECT rule_id,private_reply_text FROM private_reply_outbox ORDER BY id")).rows;
  assert.deepEqual(rows, [{ rule_id: saved.id, private_reply_text: "New text" }]);
});

test("a reply queued under an archived rule is blocked at the send recheck, also after a new rule exists on its media", async () => {
  const { id } = await saveRule(pool, a, input);
  await comment("queued-before-archive");
  assert.deepEqual(await outbox(), [{ rule_id: id, status: "pending", failure_code: null }], "the fixture queues a reply while the rule is on");
  assert.equal((await archive(id)).status, 200);
  await saveRule(pool, a, { ...input, private_reply_text: "New text" });
  const transport = neverSends();
  while (await processNextPrivateReply(pool, transport, () => new Date(), connectionId));
  assert.equal(transport.sends, 0);
  assert.deepEqual(await outbox(), [{ rule_id: id, status: "blocked", failure_code: "inactive_rule" }]);
});

test("a reply claimed before the archive is blocked by the pre-send recheck", async () => {
  const { id } = await saveRule(pool, a, input);
  await comment("queued");
  let sends = 0;
  const transport: PrivateReplyTransport = {
    // The archive lands after the worker claimed the row; the recheck before the POST reads the disabled rule.
    verify: async () => {
      assert.equal((await archive(id)).status, 200);
      return { commentCreatedAt: new Date(), authorizationVerified: true, mediaOwned: true };
    },
    send: async () => {
      sends++;
      return { messageId: "unexpected" };
    },
  };
  assert.equal(await processNextPrivateReply(pool, transport, () => new Date(), connectionId), true);
  assert.equal(sends, 0);
  assert.deepEqual(await outbox(), [{ rule_id: id, status: "blocked", failure_code: "inactive_rule" }]);
});

test("concurrent archives of one rule both answer the stored archive time", async () => {
  const { id } = await saveRule(pool, a, input);
  const [first, second] = await Promise.all([archive(id), archive(id)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), await second.json());
});

test("the migration reapplies on a database that already has the column, the constraint and the index", async () => {
  await pool.query(await readFile(new URL("../../db/migrations/073_comment_rule_archive.sql", import.meta.url), "utf8"));
  const unique = await pool.query("SELECT 1 FROM pg_constraint WHERE conrelid='instagram_comment_rules'::regclass AND conname='instagram_comment_rules_connection_id_media_id_key'");
  assert.equal(unique.rowCount, 0, "the full (connection_id, media_id) constraint is gone");
  const index = await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname='instagram_comment_rules_active_media'");
  assert.match(index.rows[0]?.indexdef ?? "", /WHERE \(archived_at IS NULL\)/);
});

test("the schema refuses an enabled archived rule", async () => {
  const { id } = await saveRule(pool, a, input);
  assert.equal((await archive(id)).status, 200);
  await assert.rejects(pool.query("UPDATE instagram_comment_rules SET enabled=true WHERE id=$1", [id]), /instagram_comment_rules_archived_disabled/);
});
