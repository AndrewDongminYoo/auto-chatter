import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
const workspace = "11111111-1111-4111-8111-111111111111";
const foreignWorkspace = "22222222-2222-4222-8222-222222222222";
const owner = "55555555-5555-4555-8555-555555555555";
const agent = "66666666-6666-4666-8666-666666666666";
const outsider = "77777777-7777-4777-8777-777777777777";
let snapshot: string;
let foreignSnapshot: string;
before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces,workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspace, foreignWorkspace]);
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')",
    [workspace, owner, agent, foreignWorkspace, outsider],
  );
  snapshot = await seedSnapshot(workspace, owner);
  foreignSnapshot = await seedSnapshot(foreignWorkspace, outsider);
});
after(async () => pool.end());
async function seedSnapshot(ws: string, actor: string) {
  const segment = (
    await pool.query("INSERT INTO instagram_contact_segments(workspace_id,name) VALUES($1,'Audience') RETURNING id", [
      ws,
    ])
  ).rows[0]!.id;
  return (
    await pool.query(
      `INSERT INTO instagram_segment_snapshots(workspace_id,segment_id,created_by,as_of,definition,segment_name,counts,member_count)
    VALUES($1,$2,$3,now(),'{}','Audience','{}',0) RETURNING id`,
      [ws, segment, actor],
    )
  ).rows[0]!.id as string;
}
function draft() {
  return { id: randomUUID(), snapshot_id: snapshot, name: "Campaign", body: "Hello" };
}
async function request(method = "GET", path = "/api/campaign-drafts", body?: unknown, actor = owner) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { cookie: "__Host-ac-access=test", origin: "https://app.test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      API_WRITE_USER_LIMIT: { limit: async () => ({ success: true }) },
      API_WRITE_WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
    },
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () =>
      Response.json({ id: actor, email: "member@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}
async function expect(response: Response, status = 200) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body;
}
test("campaign creation replay preserves edited current state and rejects a different original payload", async () => {
  const input = draft();
  const created = await expect(await request("POST", "/api/campaign-drafts", input), 201);
  assert.equal(created.version, 1);
  const url = `/api/campaign-drafts/${input.id}`;
  await expect(
    await request("PUT", url, { snapshot_id: snapshot, name: "Edited", body: "Changed", expected_version: 1 }),
  );
  const replay = await expect(await request("POST", "/api/campaign-drafts", input));
  assert.equal(replay.name, "Edited");
  assert.equal(replay.version, 2);
  await expect(await request("POST", "/api/campaign-drafts", { ...input, body: "Different" }), 409);
  const listed = await expect(await request());
  assert.equal(listed.drafts.length, 1);
  assert.equal("body" in listed.drafts[0], false);
  assert.equal("create_request_hash" in replay, false);
});
test("campaign writes reject agents, foreign snapshots and stale versions", async () => {
  const input = draft();
  await expect(await request("POST", "/api/campaign-drafts", input, agent), 403);
  await expect(await request("POST", "/api/campaign-drafts", { ...input, snapshot_id: foreignSnapshot }), 404);
  await expect(await request("POST", "/api/campaign-drafts", input), 201);
  await expect(await request("GET", `/api/campaign-drafts/${input.id}`, undefined, outsider), 404);
  const update = { snapshot_id: snapshot, name: "Changed", body: "Hello", expected_version: 1 };
  const outcomes = await Promise.all([
    request("PUT", `/api/campaign-drafts/${input.id}`, update),
    request("PUT", `/api/campaign-drafts/${input.id}`, { ...update, name: "Concurrent" }),
  ]);
  assert.deepEqual(outcomes.map((x) => x.status).sort(), [200, 409]);
  const archived = await expect(
    await request("POST", `/api/campaign-drafts/${input.id}/archive`, { expected_version: 2 }),
  );
  assert.equal(archived.archived, true);
  assert.equal(archived.version, 3);
  await expect(await request("PUT", `/api/campaign-drafts/${input.id}`, { ...update, expected_version: 3 }), 409);
});
test("campaign request validation rejects unresolved templates and malformed inputs", async () => {
  for (const body of ["", " ", "{{name}}", "a}}", "\u0000", "x".repeat(1001)])
    await expect(await request("POST", "/api/campaign-drafts", { ...draft(), body }), 400);
  await expect(await request("POST", "/api/campaign-drafts", { ...draft(), extra: true }), 400);
  await expect(await request("GET", "/api/campaign-drafts?unknown=true"), 400);
});
test("a draft alone blocks both workspace move paths", async () => {
  const mover = randomUUID(),
    own = randomUUID(),
    target = randomUUID();
  await pool.query("UPDATE workspaces SET plan='advanced' WHERE id=$1", [workspace]);
  const client = await pool.connect();
  try {
    await client.query("INSERT INTO workspaces(id) VALUES($1),($2)", [own, target]);
    await client.query("INSERT INTO workspace_members(user_id,workspace_id,role) VALUES($1,$2,'owner')", [mover, own]);
    await client.query("SET session_replication_role=replica");
    await client.query(
      `INSERT INTO campaign_drafts(id,workspace_id,snapshot_id,name,body,create_request_hash,created_by,updated_by)
      VALUES(gen_random_uuid(),$1,gen_random_uuid(),'Kept','Hello',repeat('0',64),$2,$2)`,
      [own, mover],
    );
    await client.query("RESET session_replication_role");
    const invite = await expect(
      await request("POST", "/api/workspace/invites", { email: "member@example.test", role: "agent" }),
      201,
    );
    await expect(await request("POST", "/api/invites/accept", { token: invite.link.split("#invite=")[1] }, mover), 409);
    const script = await readFile(new URL("../../deploy/assign-workspace-owner.sql", import.meta.url), "utf8");
    await client.query("CREATE TEMP TABLE verified_users(id uuid,email_confirmed_at timestamptz)");
    await client.query(
      script
        .slice(script.indexOf("CREATE FUNCTION"), script.indexOf("SELECT pg_temp.assign_workspace_owner"))
        .replace("auth.users", "pg_temp.verified_users")
        .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"),
    );
    await client.query("INSERT INTO verified_users VALUES($1,now())", [mover]);
    await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [mover, target]), /not empty/);
  } finally {
    await client.query("RESET session_replication_role");
    client.release();
  }
});
test("the total draft limit includes archived rows and serializes concurrent creation", async () => {
  await pool.query(
    `INSERT INTO campaign_drafts(id,workspace_id,snapshot_id,name,body,create_request_hash,created_by,updated_by,archived)
    SELECT gen_random_uuid(),$1,$2,'Archived','Hello',repeat('0',64),$3,$3,true FROM generate_series(1,99)`,
    [workspace, snapshot, owner],
  );
  const a = draft(),
    b = draft();
  const results = await Promise.all([
    request("POST", "/api/campaign-drafts", a),
    request("POST", "/api/campaign-drafts", b),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [201, 409]);
  const saved = results[0]!.status === 201 ? a : b;
  await expect(await request("POST", "/api/campaign-drafts", saved));
  const list = await expect(await request());
  assert.equal(list.drafts.length, 100);
});
test("concurrent identical creation has one 201 and one replay, with normalized UUID and name hashing", async () => {
  const input = { ...draft(), name: "  e\u0301  " };
  const equivalent = { ...input, id: input.id.toUpperCase(), snapshot_id: input.snapshot_id.toUpperCase(), name: "é" };
  const responses = await Promise.all([
    request("POST", "/api/campaign-drafts", input),
    request("POST", "/api/campaign-drafts", equivalent),
  ]);
  assert.deepEqual(responses.map((x) => x.status).sort(), [200, 201]);
  assert.equal((await expect(await request())).drafts.length, 1);
  for (const response of responses) assert.equal((await response.json()).name, "é");
});
test("drafts preserve product rows and retain original counts after person and connection deletion", async () => {
  const { seedWorkspace } = await import("./workspace-fixture.ts");
  for (const deletion of ["person", "connection"]) {
    const ws = randomUUID(),
      actor = randomUUID(),
      conn = randomUUID();
    await seedWorkspace(pool, ws, actor, conn, `campaign-${deletion}`);
    const snap = (await pool.query("SELECT id FROM instagram_segment_snapshots WHERE workspace_id=$1", [ws])).rows[0]!
      .id;
    const unchanged = async () => {
      const result: Record<string, unknown> = {};
      for (const table of [
        "private_reply_outbox",
        "channel_consent_events",
        "channel_consent_state",
        "instagram_segment_snapshots",
        "instagram_segment_snapshot_members",
        "instagram_contact_tags",
        "instagram_contact_automation",
      ]) {
        const rows = (await pool.query(`SELECT * FROM ${table} WHERE workspace_id=$1`, [ws])).rows;
        assert.ok(rows.length > 0, `${table} fixture must contain data`);
        result[table] = rows;
      }
      return result;
    };
    const before = await unchanged();
    const input = { ...draft(), snapshot_id: snap };
    await expect(await request("POST", "/api/campaign-drafts", input, actor), 201);
    const url = `/api/campaign-drafts/${input.id}`;
    const summary = await expect(await request("GET", url, undefined, actor));
    assert.equal(summary.original_member_count, 1);
    assert.equal(summary.stored_member_count, 1);
    await expect(
      await request("PUT", url, { snapshot_id: snap, name: "Revised", body: "A new plan", expected_version: 1 }, actor),
    );
    await expect(await request("POST", url + "/archive", { expected_version: 2 }, actor));
    assert.deepEqual(await unchanged(), before);
    if (deletion === "person")
      await pool.query("SELECT delete_person_data($1,$2,$3,'comment_sender','123')", [ws, conn, actor]);
    else {
      await pool.query(
        "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
        [conn],
      );
      await pool.query("SELECT delete_connection_data($1,$2,$3,$4)", [ws, conn, actor, `campaign-${deletion}`]);
    }
    const after = await expect(await request("GET", url, undefined, actor));
    assert.equal(after.original_member_count, 1);
    assert.equal(after.stored_member_count, 0);
    assert.equal(after.archived, true);
  }
});
test("migration 063 replays and preserves drafts while matching the canonical workspace deletion function", async () => {
  const input = draft();
  await expect(await request("POST", "/api/campaign-drafts", input), 201);
  const definition = async () =>
    (await pool.query("SELECT pg_get_functiondef('delete_workspace_data(uuid,uuid)'::regprocedure) AS body")).rows[0]!
      .body;
  const canonical = await definition();
  const sql = await readFile(new URL("../../db/migrations/063_campaign_drafts.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  // 064 and 065 redefine the function after 063, so the runner's order reproduces the canonical one.
  await pool.query(await readFile(new URL("../../db/migrations/064_campaign_approvals.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/065_campaign_runs.sql", import.meta.url), "utf8"));
  assert.equal(await definition(), canonical);
  assert.equal((await expect(await request("GET", `/api/campaign-drafts/${input.id}`))).version, 1);
});
