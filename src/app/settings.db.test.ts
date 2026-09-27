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
import { listContacts, saveContactTags } from "./contacts.ts";
import { connectionMedia } from "./instagram-media.ts";
import { sealSecret } from "./secrets.ts";

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

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
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
