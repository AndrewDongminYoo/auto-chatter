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
const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const connectionId = "55555555-5555-4555-8555-555555555555";
const foreignConnectionId = "66666666-6666-4666-8666-666666666666";
const envConnectionId = "77777777-7777-4777-8777-777777777777";
const ruleId = "88888888-8888-4888-8888-888888888888";
const fieldId = "99999999-9999-4999-8999-999999999999";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2),($3,$4)", [
    workspaceId,
    userId,
    otherWorkspaceId,
    otherUserId,
  ]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted)
     VALUES($1,$2,'owned-account',true,'token'),($3,$4,'foreign-account',true,'token'),($5,$2,'env-account',true,NULL)`,
    [connectionId, workspaceId, foreignConnectionId, otherWorkspaceId, envConnectionId],
  );
  await pool.query(
    `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,keywords,private_reply_text,enabled)
     VALUES($1,$2,$3,'1789','link','{link}','legacy reply',false)`,
    [ruleId, workspaceId, connectionId],
  );
  await pool.query("INSERT INTO instagram_contact_fields(id,workspace_id,name,type) VALUES($1,$2,'city','text')", [
    fieldId,
    workspaceId,
  ]);
});

after(async () => pool.end());

function request(method: string, path: string, body?: unknown, actorId = userId) {
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

function document(options: { connection?: string; media?: string; text?: string; follow?: boolean } = {}) {
  const message = { id: "m", type: "instagram_message", config: { text: options.text ?? "Thanks" } };
  return {
    schema_version: 1,
    nodes: [
      {
        id: "start",
        type: "instagram_comment",
        config: {
          connection_id: options.connection ?? connectionId,
          media_id: options.media ?? "1789",
          keywords: ["link"],
          match_mode: "contains",
          excluded_keywords: [],
        },
      },
      ...(options.follow ? [{ id: "f", type: "follows_account", config: {} }] : []),
      message,
    ],
    edges: options.follow
      ? [
          { from: "start", port: "next", to: "f" },
          { from: "f", port: "true", to: "m" },
        ]
      : [{ from: "start", port: "next", to: "m" }],
  };
}

async function createdFlow(draft: unknown = document(), name = "Welcome") {
  const response = await request("POST", "/api/flows", { name, draft });
  assert.equal(response.status, 201);
  return (await response.json()) as { id: string; draft_revision: number };
}

async function publish(id: string, expected_revision = 0) {
  return request("POST", `/api/flows/${id}/publish`, { expected_revision });
}

function enableRule(enabled = true) {
  return request("PUT", "/api/rules", {
    id: ruleId,
    connection_id: connectionId,
    media_id: "1789",
    keywords: ["link"],
    excluded_keywords: [],
    match_mode: "contains",
    private_reply_text: "legacy reply",
    enabled,
    follow_gate_enabled: false,
  });
}

test("drafts save with revision checks and published versions stay fixed", async () => {
  const flow = await createdFlow({ schema_version: 1, nodes: [], edges: [] });
  const invalid = await publish(flow.id);
  assert.equal(invalid.status, 422);
  assert.deepEqual(await invalid.json(), { error: "flow_invalid", errors: [{ code: "trigger_count", path: "nodes" }] });
  assert.equal((await pool.query("SELECT count(*) FROM flow_versions")).rows[0].count, "0");

  const saved = await request("PUT", `/api/flows/${flow.id}`, { expected_revision: 0, draft: document() });
  assert.deepEqual(await saved.json(), { draft_revision: 1 });
  const stale = await request("PUT", `/api/flows/${flow.id}`, { expected_revision: 0, draft: document() });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "revision_conflict" });
  assert.equal((await publish(flow.id, 0)).status, 409);

  const first = await publish(flow.id, 1);
  assert.equal(first.status, 201);
  assert.equal(((await first.json()) as { version_no: number }).version_no, 1);
  await request("PUT", `/api/flows/${flow.id}`, { expected_revision: 1, draft: document({ text: "Changed" }) });
  const second = await publish(flow.id, 2);
  assert.equal(((await second.json()) as { version_no: number }).version_no, 2);
  const replay = await publish(flow.id, 2);
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { version_no: number }).version_no, 2);
  assert.equal((await pool.query("SELECT count(*) FROM flow_versions")).rows[0].count, "2");

  const v1 = (await (await request("GET", `/api/flows/${flow.id}/versions/1`)).json()) as {
    definition: { nodes: { config: { text?: string } }[] };
  };
  assert.equal(v1.definition.nodes[1]!.config.text, "Thanks");
  const versions = (await (await request("GET", `/api/flows/${flow.id}/versions`)).json()) as {
    versions: { version_no: number; current: boolean }[];
  };
  assert.deepEqual(
    versions.versions.map((version) => [version.version_no, version.current]),
    [
      [2, true],
      [1, false],
    ],
  );
  const current = (await (await request("GET", `/api/flows/${flow.id}`)).json()) as {
    published_version_no: number;
    draft_revision: number;
  };
  assert.equal(current.published_version_no, 2);
  assert.equal(current.draft_revision, 2);
});

test("documents up to the flow size limit pass the HTTP body limit", async () => {
  const large = document();
  const nodes = Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`,
    type: "instagram_message",
    config: { text: "x".repeat(900) },
  }));
  large.nodes = [large.nodes[0]!, ...nodes] as typeof large.nodes;
  large.edges = nodes.map((node, i) => ({ from: i === 0 ? "start" : `m${i - 1}`, port: "next", to: node.id }));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 36_000);
  const flow = await createdFlow(large);
  assert.equal((await publish(flow.id)).status, 201);
  const saved = await request("PUT", `/api/flows/${flow.id}`, { expected_revision: 0, draft: large });
  assert.equal(saved.status, 200);
});

test("draft shape errors are rejected on save while incomplete graphs are accepted", async () => {
  const flow = await createdFlow({ schema_version: 1, nodes: [{ id: "later", type: "wait", config: {} }], edges: [] });
  const bad = await request("PUT", `/api/flows/${flow.id}`, { expected_revision: 0, draft: { schema_version: 2 } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "invalid_document" });
  const unknownKey = await request("PUT", `/api/flows/${flow.id}`, { expected_revision: 0, draft: document(), x: 1 });
  assert.equal(unknownKey.status, 400);
});

test("a legacy rule and a published flow cannot both claim one media", async () => {
  assert.equal((await enableRule()).status, 200);
  const flow = await createdFlow();
  const blocked = await publish(flow.id);
  assert.equal(blocked.status, 422);
  assert.equal(((await blocked.json()) as { errors: { code: string }[] }).errors[0]!.code, "legacy_rule_conflict");

  assert.equal((await enableRule(false)).status, 200);
  assert.equal((await publish(flow.id)).status, 201);
  const enabling = await enableRule();
  assert.equal(enabling.status, 409);
  assert.deepEqual(await enabling.json(), { error: "flow_trigger_conflict" });
  assert.equal((await pool.query("SELECT enabled FROM instagram_comment_rules")).rows[0].enabled, false);

  const other = await createdFlow(document(), "Second");
  const duplicate = await publish(other.id);
  assert.equal(((await duplicate.json()) as { errors: { code: string }[] }).errors[0]!.code, "flow_trigger_conflict");

  assert.equal((await request("DELETE", `/api/flows/${flow.id}`)).status, 200);
  const archivedVersions = (await (await request("GET", `/api/flows/${flow.id}/versions`)).json()) as {
    versions: { current: boolean }[];
  };
  assert.deepEqual(
    archivedVersions.versions.map((version) => version.current),
    [false],
  );
  assert.equal((await enableRule()).status, 200);
  assert.equal(
    (await request("PUT", `/api/flows/${flow.id}`, { expected_revision: 0, draft: document() })).status,
    409,
  );
});

test("concurrent publishes and rule enables on one media leave a single owner", async () => {
  const flows = await Promise.all([createdFlow(document(), "A"), createdFlow(document(), "B")]);
  const results = await Promise.all([publish(flows[0]!.id), publish(flows[1]!.id), enableRule()]);
  assert.equal(results.filter((response) => [200, 201].includes(response.status)).length, 1);
  const owners = await pool.query(
    `SELECT (SELECT count(*) FROM flows WHERE published_version_id IS NOT NULL)::int AS flows,
            (SELECT count(*) FROM instagram_comment_rules WHERE enabled)::int AS rules`,
  );
  assert.equal(owners.rows[0].flows + owners.rows[0].rules, 1);
});

test("published field references block archiving the field until the flow is archived", async () => {
  const flow = await createdFlow(document({ text: `Hi {{field:${fieldId}}}` }));
  assert.equal((await publish(flow.id)).status, 201);
  const archive = await request("DELETE", `/api/contact-fields/${fieldId}`);
  assert.equal(archive.status, 409);
  assert.deepEqual(await archive.json(), { error: "field_in_use" });
  assert.equal((await request("DELETE", `/api/flows/${flow.id}`)).status, 200);
  assert.equal((await request("DELETE", `/api/contact-fields/${fieldId}`)).status, 200);

  const later = await createdFlow(document({ text: `Hi {{field:${fieldId}}}` }), "Later");
  const unknown = await publish(later.id);
  assert.equal(((await unknown.json()) as { errors: { code: string }[] }).errors[0]!.code, "unknown_field");
});

test("publish checks connection ownership, activity and login mode", async () => {
  const foreign = await createdFlow(document({ connection: foreignConnectionId }));
  const denied = await publish(foreign.id);
  assert.equal(((await denied.json()) as { errors: { code: string }[] }).errors[0]!.code, "connection_unavailable");

  const followEnv = await createdFlow(document({ connection: envConnectionId, follow: true }), "Env follow");
  const login = await publish(followEnv.id);
  assert.equal(((await login.json()) as { errors: { code: string }[] }).errors[0]!.code, "login_mode_required");

  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connectionId]);
  const inactive = await createdFlow();
  const unavailable = await publish(inactive.id);
  assert.equal(
    ((await unavailable.json()) as { errors: { code: string }[] }).errors[0]!.code,
    "connection_unavailable",
  );
});

test("flows are invisible across workspaces", async () => {
  const flow = await createdFlow();
  assert.equal((await request("GET", `/api/flows/${flow.id}`, undefined, otherUserId)).status, 404);
  assert.equal((await publish(flow.id)).status, 201);
  for (const [method, path, body] of [
    ["PUT", `/api/flows/${flow.id}`, { expected_revision: 0, draft: document() }],
    ["POST", `/api/flows/${flow.id}/publish`, { expected_revision: 0 }],
    ["DELETE", `/api/flows/${flow.id}`, undefined],
    ["GET", `/api/flows/${flow.id}/versions`, undefined],
    ["GET", `/api/flows/${flow.id}/versions/1`, undefined],
  ] as const)
    assert.equal((await request(method, path, body, otherUserId)).status, 404);
  const list = (await (await request("GET", "/api/flows", undefined, otherUserId)).json()) as { flows: unknown[] };
  assert.deepEqual(list.flows, []);
});

test("flow migration replays without changing published data", async () => {
  const flow = await createdFlow();
  assert.equal((await publish(flow.id)).status, 201);
  const migration = await readFile(new URL("../../db/migrations/017_flow_versions.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  assert.equal((await pool.query("SELECT count(*) FROM flow_versions")).rows[0].count, "1");
  await assert.rejects(pool.query("UPDATE flows SET published_version_id=gen_random_uuid() WHERE id=$1", [flow.id]), {
    code: "23503",
  });
  await assert.rejects(pool.query("UPDATE flows SET archived=true WHERE id=$1", [flow.id]), { code: "23514" });
});
