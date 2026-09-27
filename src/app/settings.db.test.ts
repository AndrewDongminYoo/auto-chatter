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

async function fieldRequest(method: string, path: string, body?: unknown, user = a) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" },
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
