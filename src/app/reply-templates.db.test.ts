import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import { Pool, type Pool as PoolType } from "pg";
import { appApi } from "./api.ts";
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const url = new URL(databaseUrl);
if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl });
const workspace = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const owner = { id: "33333333-3333-4333-8333-333333333333", email: "owner@example.test" },
  agent = { id: "44444444-4444-4444-8444-444444444444", email: "agent@example.test" },
  foreign = { id: "55555555-5555-4555-8555-555555555555", email: "foreign@example.test" };
const prefix = "/api/inbox/reply-templates";
type Actor = typeof owner;
type Template = { id: string; name: string; body: string; variables: string[]; version: number; archived: boolean };
before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces,workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id,plan) VALUES($1,'advanced'),($2,'advanced')", [workspace, other]);
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role,email) VALUES($1,$2,'owner',$3),($1,$4,'agent',$5),($6,$7,'owner',$8)",
    [workspace, owner.id, owner.email, agent.id, agent.email, other, foreign.id, foreign.email],
  );
});
after(async () => {
  await pool.end();
});
function request(actor: Actor, method: string, path: string, body?: unknown, origin = "https://app.test") {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin, cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      WORKSPACE_EXPORT_LIMIT: { limit: async () => ({ success: true }) },
      API_WRITE_USER_LIMIT: { limit: async () => ({ success: true }) },
      API_WRITE_WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
    },
    () =>
      ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as PoolType,
    (async () => Response.json({ ...actor, email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}
async function body<T>(r: Response, status: number): Promise<T> {
  const b = await r.json();
  assert.equal(r.status, status, JSON.stringify(b));
  return b as T;
}
async function create(name = "안내", text = "안녕하세요 {{name}}님. {{name}}님을 도와드리겠습니다.", actor = owner) {
  return body<Template>(await request(actor, "POST", prefix, { name, body: text }), 201);
}

test("reply templates preserve workspace ownership, roles, optimistic edits and archive", async () => {
  const t = await create();
  assert.deepEqual(t.variables, ["name"]);
  assert.equal(t.version, 1);
  assert.equal((await body<{ templates: Template[] }>(await request(agent, "GET", prefix), 200)).templates.length, 1);
  assert.equal((await body<{ templates: Template[] }>(await request(foreign, "GET", prefix), 200)).templates.length, 0);
  for (const [method, path, input] of [
    ["POST", prefix, { name: "denied", body: "text" }],
    ["PATCH", `${prefix}/${t.id}`, { name: "denied", body: "text", expected_version: 1 }],
    ["DELETE", `${prefix}/${t.id}`, undefined],
  ] as const)
    assert.equal((await request(agent, method, path, input)).status, 403);
  for (const method of ["PATCH", "DELETE"])
    assert.equal(
      (
        await request(
          foreign,
          method,
          `${prefix}/${t.id}`,
          method === "PATCH" ? { name: "foreign", body: "text", expected_version: 1 } : undefined,
        )
      ).status,
      404,
    );
  const updated = await body<Template>(
    await request(owner, "PATCH", `${prefix}/${t.id}`, { name: "새 안내", body: "Hi {{name}}", expected_version: 1 }),
    200,
  );
  assert.equal(updated.version, 2);
  assert.equal(
    (await request(owner, "PATCH", `${prefix}/${t.id}`, { name: "stale", body: "stale", expected_version: 1 })).status,
    409,
  );
  assert.equal((await body<Template>(await request(owner, "DELETE", `${prefix}/${t.id}`), 200)).archived, true);
  assert.equal((await body<Template>(await request(owner, "DELETE", `${prefix}/${t.id}`), 200)).version, 3);
  assert.equal((await body<{ templates: Template[] }>(await request(agent, "GET", prefix), 200)).templates.length, 0);
  assert.equal(
    (await request(owner, "PATCH", `${prefix}/${t.id}`, { name: "archived", body: "text", expected_version: 3 }))
      .status,
    409,
  );
});

test("reply template preview renders once without customer lookup or delivery writes", async () => {
  const t = await create("Preview", "{{name}} / {{value}} / {{name}}");
  const before = await pool.query(
    "SELECT (SELECT count(*) FROM instagram_manual_replies)::text AS replies,(SELECT count(*) FROM channel_consent_events)::text AS events",
  );
  const preview = await body<{ text: string; version: number }>(
    await request(agent, "POST", `${prefix}/${t.id}/preview`, {
      expected_version: 1,
      values: { name: "<img src=x onerror=alert(1)>", value: "{{name}}" },
    }),
    200,
  );
  assert.equal(preview.text, "<img src=x onerror=alert(1)> / {{name}} / <img src=x onerror=alert(1)>");
  assert.equal(preview.version, 1);
  assert.equal(
    (
      await request(foreign, "POST", `${prefix}/${t.id}/preview`, {
        expected_version: 1,
        values: { name: "A", value: "B" },
      })
    ).status,
    404,
  );
  for (const values of [
    { name: "A" },
    { name: " ", value: "0" },
    { name: 0, value: "false" },
    { name: "A", value: "B", extra: "C" },
    { name: "A", value: "a".repeat(1000) },
  ])
    assert.equal(
      (await request(agent, "POST", `${prefix}/${t.id}/preview`, { expected_version: 1, values })).status,
      400,
    );
  const valid = await body<{ text: string }>(
    await request(agent, "POST", `${prefix}/${t.id}/preview`, {
      expected_version: 1,
      values: { name: "0", value: "false" },
    }),
    200,
  );
  assert.equal(valid.text, "0 / false / 0");
  await body(
    await request(owner, "PATCH", `${prefix}/${t.id}`, { name: t.name, body: "changed", expected_version: 1 }),
    200,
  );
  assert.equal(
    (
      await request(agent, "POST", `${prefix}/${t.id}/preview`, {
        expected_version: 1,
        values: { name: "A", value: "B" },
      })
    ).status,
    409,
  );
  await request(owner, "DELETE", `${prefix}/${t.id}`);
  assert.equal(
    (await request(agent, "POST", `${prefix}/${t.id}/preview`, { expected_version: 3, values: {} })).status,
    404,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT (SELECT count(*) FROM instagram_manual_replies)::text AS replies,(SELECT count(*) FROM channel_consent_events)::text AS events",
      )
    ).rows,
    before.rows,
  );
});

test("reply template validation rejects unsupported variables and retains literal text boundaries", async () => {
  for (const text of [
    "",
    " ",
    "a".repeat(1001),
    "😀".repeat(501),
    "a\u0000b",
    "{{name}",
    "{{{name}}}",
    "{{Name}}",
    "{{field:id}}",
    "{{ name }}",
    "{{name}} }}",
    Array.from({ length: 11 }, (_, i) => `{{v${i}}}`).join(""),
  ])
    assert.equal((await request(owner, "POST", prefix, { name: "invalid", body: text })).status, 400, text);
  for (const input of [
    { name: "", body: "a" },
    { name: "x".repeat(61), body: "a" },
    { name: "a\n", body: "a", extra: 1 },
  ])
    assert.equal((await request(owner, "POST", prefix, input)).status, 400);
  await create("Same", "literal {braces} and 😀");
  assert.equal((await request(owner, "POST", prefix, { name: " same ", body: "duplicate" })).status, 409);
  const t = await create("Length", "😀".repeat(500));
  assert.equal(
    (
      await body<{ text: string }>(
        await request(agent, "POST", `${prefix}/${t.id}/preview`, { expected_version: 1, values: {} }),
        200,
      )
    ).text.length,
    1000,
  );
  assert.equal(
    (await request(owner, "POST", prefix, { name: "cross origin", body: "text" }, "https://other.test")).status,
    403,
  );
});

test("reply template active limit serializes concurrent creation and archive releases one slot", async () => {
  for (let i = 0; i < 49; i++) await create(`Template ${i}`, "text");
  const results = await Promise.all([
    request(owner, "POST", prefix, { name: "last A", body: "text" }),
    request(owner, "POST", prefix, { name: "last B", body: "text" }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const list = await body<{ templates: Template[] }>(await request(owner, "GET", prefix), 200);
  assert.equal(list.templates.length, 50);
  await request(owner, "DELETE", `${prefix}/${list.templates[0]!.id}`);
  await create("replacement", "text");
});

test("reply templates are exported and removed only by whole workspace deletion", async () => {
  const t = await create("Owned", "text");
  const foreignTemplate = await create("Foreign", "text", foreign);
  const exported = await body<{ tables: Record<string, unknown[]> }>(
    await request(owner, "GET", "/api/workspace/export"),
    200,
  );
  assert.ok(JSON.stringify(exported).includes(t.id));
  assert.ok(!JSON.stringify(exported).includes(foreignTemplate.id));
  const deleted = await pool.query<{ result: { deleted_counts: Record<string, number> } }>(
    "SELECT public.delete_workspace_data($1,$2) AS result",
    [workspace, owner.id],
  );
  assert.equal(deleted.rows[0]!.result.deleted_counts.workspace_reply_templates, 1);
  assert.equal((await pool.query("SELECT id FROM workspace_reply_templates")).rows[0]!.id, foreignTemplate.id);
});

test("reply template migration can be repeated without changing a saved row", async () => {
  const t = await create();
  const sql = await readFile(new URL("../../db/migrations/048_workspace_reply_templates.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  const list = await body<{ templates: Template[] }>(await request(owner, "GET", prefix), 200);
  assert.equal(list.templates[0]!.id, t.id);
  assert.equal(list.templates[0]!.version, 1);
});
