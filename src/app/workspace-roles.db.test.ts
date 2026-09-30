import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const ownerId = "11111111-1111-4111-8111-111111111111";
const adminId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const outsiderId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "55555555-5555-4555-8555-555555555555";
const otherWorkspaceId = "66666666-6666-4666-8666-666666666666";
const connectionId = "77777777-7777-4777-8777-777777777777";
const fieldId = "88888888-8888-4888-8888-888888888888";
const ruleId = "99999999-9999-4999-8999-999999999999";
const missingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role)
     VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')`,
    [workspaceId, ownerId, adminId, agentId, otherWorkspaceId, outsiderId],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted)
     VALUES($1,$2,'account-own',true,'token')`,
    [connectionId, workspaceId],
  );
  await pool.query("INSERT INTO instagram_contact_fields(id,workspace_id,name,type) VALUES($1,$2,'city','text')", [
    fieldId,
    workspaceId,
  ]);
  await pool.query(
    `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,keywords,private_reply_text,enabled)
     VALUES($1,$2,$3,'1789','link','{link}','reply',false)`,
    [ruleId, workspaceId, connectionId],
  );
});

after(async () => pool.end());

function request(actorId: string, method: string, path: string, body?: unknown) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () =>
      Response.json({ id: actorId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

async function flow(name: string): Promise<string> {
  const created = await request(ownerId, "POST", "/api/flows", { name });
  assert.equal(created.status, 201);
  return ((await created.json()) as { id: string }).id;
}

async function errorOf(response: Response): Promise<string | undefined> {
  return ((await response.clone().json()) as { error?: string }).error;
}

test("agents are refused every administrative route that admins can reach", async () => {
  const draft = await flow("draft");
  const archived = await flow("archived");
  const routes: [string, string, unknown?][] = [
    ["PATCH", `/api/connections/${connectionId}`, { active: true, send_enabled: false }],
    ["PUT", `/api/connections/${connectionId}/inbox`, { enabled: false }],
    ["POST", `/api/connections/${connectionId}/data-deletion`, { confirm_account_id: "account-own" }],
    ["GET", `/api/connections/${connectionId}/data-deletions`],
    [
      "PUT",
      "/api/rules",
      {
        id: ruleId,
        connection_id: connectionId,
        media_id: "1789",
        keyword: "link",
        keywords: ["link"],
        match_mode: "contains",
        excluded_keywords: [],
        private_reply_text: "reply",
        enabled: false,
        follow_gate_enabled: false,
      },
    ],
    ["POST", "/api/contact-fields", { name: "tier", type: "text" }],
    ["DELETE", `/api/contact-fields/${fieldId}`],
    ["POST", "/api/contact-segments", { name: "vips", connection_id: connectionId }],
    ["DELETE", `/api/contact-segments/${missingId}`],
    ["POST", "/api/flows", { name: "new" }],
    ["PUT", `/api/flows/${draft}`, { expected_revision: 0, draft: { schema_version: 1, nodes: [], edges: [] } }],
    ["POST", `/api/flows/${draft}/publish`, { expected_revision: 1 }],
    ["POST", `/api/flows/${draft}/enable`],
    ["POST", `/api/flows/${draft}/disable`],
    ["DELETE", `/api/flows/${archived}`],
    ["GET", "/api/workspace/export"],
    ["DELETE", `/api/connections/${connectionId}`],
  ];
  for (const [method, path, body] of routes) {
    const denied = await request(agentId, method, path, body);
    assert.equal(denied.status, 403, `${method} ${path} as agent`);
    assert.equal(await errorOf(denied), "role_forbidden", `${method} ${path} as agent`);
    const allowed = await request(adminId, method, path, body);
    assert.notEqual(allowed.status, 403, `${method} ${path} as admin`);
    assert.ok(allowed.status < 500, `${method} ${path} as admin returned ${allowed.status}`);
  }
  assert.equal(
    (await pool.query("SELECT active FROM instagram_connections WHERE id=$1", [connectionId])).rows[0].active,
    false,
  );
});

test("agents keep conversation, contact and read-only settings access", async () => {
  const id = await flow("visible");
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/connections"],
    ["GET", "/api/inbox"],
    ["GET", "/api/contacts"],
    ["GET", "/api/contact-fields"],
    ["GET", "/api/contact-segments"],
    ["GET", "/api/rules"],
    ["GET", "/api/activity"],
    ["GET", "/api/flows"],
    ["GET", `/api/flows/${id}`],
    ["GET", `/api/flows/${id}/versions`],
    ["GET", `/api/flows/${id}/runs`],
    ["PATCH", `/api/connections/${connectionId}/contacts/123`, { tags: ["vip"] }],
    ["PUT", `/api/connections/${connectionId}/contacts/123/automation`, { paused: true }],
    ["PUT", `/api/connections/${connectionId}/contacts/123/fields/${fieldId}`, { value: "Seoul" }],
  ];
  for (const [method, path, body] of routes) {
    const response = await request(agentId, method, path, body);
    assert.notEqual(response.status, 403, `${method} ${path} as agent`);
    assert.ok(response.status < 500, `${method} ${path} as agent returned ${response.status}`);
  }
});

test("a downgrade or removal applies to the next request", async () => {
  assert.equal((await request(adminId, "POST", "/api/flows", { name: "before" })).status, 201);
  await pool.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [adminId]);
  const downgraded = await request(adminId, "POST", "/api/flows", { name: "after" });
  assert.equal(downgraded.status, 403);
  assert.equal(await errorOf(downgraded), "role_forbidden");
  assert.equal((await request(adminId, "GET", "/api/flows")).status, 200);

  await pool.query("DELETE FROM workspace_members WHERE user_id=$1", [agentId]);
  const removed = await request(agentId, "GET", "/api/flows");
  assert.equal(removed.status, 403);
  assert.equal(await errorOf(removed), "workspace_required");
});

test("members of one workspace cannot read or change another workspace", async () => {
  const id = await flow("private");
  assert.equal((await request(outsiderId, "GET", `/api/flows/${id}`)).status, 404);
  assert.equal((await request(outsiderId, "POST", `/api/flows/${id}/disable`)).status, 404);
  const contacts = await request(outsiderId, "PATCH", `/api/connections/${connectionId}/contacts/123`, {
    tags: ["vip"],
  });
  assert.equal(contacts.status, 404);
  assert.deepEqual(((await (await request(outsiderId, "GET", "/api/flows")).json()) as { flows: unknown[] }).flows, []);
});

test("the role migration replays, keeps one owner per workspace and lets members share a workspace", async () => {
  const migration = await readFile(new URL("../../db/migrations/022_workspace_roles.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id=$1", [workspaceId]))
      .rows[0].count,
    3,
  );
  await assert.rejects(pool.query("UPDATE workspace_members SET role='owner' WHERE user_id=$1", [adminId]), {
    code: "23505",
  });
  await assert.rejects(pool.query("UPDATE workspace_members SET role='viewer' WHERE user_id=$1", [agentId]), {
    code: "23514",
  });
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [missingId]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,gen_random_uuid())", [missingId]);
  assert.equal(
    (await pool.query("SELECT role FROM workspace_members WHERE workspace_id=$1", [missingId])).rows[0].role,
    "owner",
  );
});
