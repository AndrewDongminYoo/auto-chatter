import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { ingestComments } from "../instagram/store.ts";
import { processNextPrivateReply, type PrivateReplyTransport } from "../instagram/reply-worker.ts";

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
const envConnectionId = "77777777-7777-4777-8777-777777777777";
const fieldId = "99999999-9999-4999-8999-999999999999";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };
const now = new Date("2026-09-25T00:00:00.000Z");

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
     VALUES($1,$2,'owned-account',true,'token'),($3,$2,'env-account',true,NULL)`,
    [connectionId, workspaceId, envConnectionId],
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

function document(options: { connection?: string; vipText?: string; extra?: "add_tag" } = {}) {
  return {
    schema_version: 1,
    nodes: [
      {
        id: "start",
        type: "instagram_comment",
        config: {
          connection_id: options.connection ?? connectionId,
          media_id: "1789",
          keywords: ["link"],
          match_mode: "contains",
          excluded_keywords: [],
        },
      },
      { id: "vip", type: "has_tag", config: { tag: "vip" } },
      { id: "city", type: "field_equals", config: { field_id: fieldId, field_operator: "eq", field_value: "Seoul" } },
      { id: "vip_reply", type: "instagram_message", config: { text: options.vipText ?? "VIP link" } },
      { id: "seoul_reply", type: "instagram_message", config: { text: "Seoul link" } },
      ...(options.extra ? [{ id: "tag", type: "add_tag", config: { tag: "lead" } }] : []),
    ],
    edges: [
      { from: "start", port: "next", to: "vip" },
      { from: "vip", port: "true", to: "vip_reply" },
      { from: "vip", port: "false", to: "city" },
      { from: "city", port: "true", to: "seoul_reply" },
      ...(options.extra ? [{ from: "city", port: "false", to: "tag" }] : []),
    ],
  };
}

async function publishedFlow(draft: unknown = document()): Promise<string> {
  const created = await request("POST", "/api/flows", { name: "Welcome", draft });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  assert.equal((await request("POST", `/api/flows/${id}/publish`, { expected_revision: 0 })).status, 201);
  return id;
}

async function enabledFlow(): Promise<string> {
  const id = await publishedFlow();
  const enabled = await request("POST", `/api/flows/${id}/enable`);
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { enabled: true });
  return id;
}

async function republish(id: string, draft: unknown) {
  const current = (await (await request("GET", `/api/flows/${id}`)).json()) as { draft_revision: number };
  const saved = await request("PUT", `/api/flows/${id}`, { expected_revision: current.draft_revision, draft });
  assert.equal(saved.status, 200);
  return request("POST", `/api/flows/${id}/publish`, { expected_revision: current.draft_revision + 1 });
}

function comment(commentId: string, senderId: string, text = "send the link") {
  return ingestComments(pool, [{ accountId: "owned-account", commentId, postId: "1789", senderId, text }]);
}

type Run = {
  id: string;
  version_no: number;
  status: string;
  failure_code: string | null;
  delivery_status: string | null;
  delivery_failure_code: string | null;
  steps: { node_id: string; node_type: string; outcome: string }[];
};

async function runs(id: string): Promise<Run[]> {
  const response = await request("GET", `/api/flows/${id}/runs`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { runs: Run[] }).runs;
}

const sent: PrivateReplyTransport = {
  verify: async () => ({
    commentCreatedAt: new Date("2026-09-24T00:00:00.000Z"),
    authorizationVerified: true,
    mediaOwned: true,
  }),
  send: async (reply) => ({ messageId: `mid-${reply.commentId}` }),
};

test("publishing alone never runs a flow, and enabling needs a runnable version on an OAuth connection", async () => {
  const created = await request("POST", "/api/flows", { name: "Draft", draft: document() });
  const { id: draftId } = (await created.json()) as { id: string };
  assert.equal((await request("POST", `/api/flows/${draftId}/enable`)).status, 409);

  const unsupported = await publishedFlow(document({ extra: "add_tag" }));
  const refused = await request("POST", `/api/flows/${unsupported}/enable`);
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), {
    error: "flow_not_executable",
    errors: [{ code: "unsupported_node", node_id: "tag", path: "nodes[5].type" }],
  });

  await pool.query("TRUNCATE flows CASCADE");
  const envFlow = await publishedFlow(document({ connection: envConnectionId }));
  const envRefused = await request("POST", `/api/flows/${envFlow}/enable`);
  assert.equal(envRefused.status, 422);
  assert.equal(((await envRefused.json()) as { errors: { code: string }[] }).errors[0]!.code, "login_mode_required");

  await pool.query("TRUNCATE flows CASCADE");
  const published = await publishedFlow();
  await comment("comment-before-enable", "sender-1");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM flow_runs")).rows[0].count, 0);
  assert.equal((await request("POST", `/api/flows/${published}/enable`)).status, 200);
  assert.equal(
    ((await (await request("GET", `/api/flows/${published}`)).json()) as { enabled: boolean }).enabled,
    true,
  );
  assert.equal((await request("POST", `/api/flows/${published}/enable`, undefined, otherUserId)).status, 404);
});

test("an enabled flow only publishes runnable versions, and archiving turns it off", async () => {
  const id = await enabledFlow();
  const refused = await republish(id, document({ extra: "add_tag" }));
  assert.equal(refused.status, 422);
  assert.equal(((await refused.json()) as { errors: { code: string }[] }).errors[0]!.code, "unsupported_node");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM flow_versions")).rows[0].count, 1);

  assert.deepEqual(await (await request("POST", `/api/flows/${id}/disable`)).json(), { enabled: false });
  const current = (await (await request("GET", `/api/flows/${id}`)).json()) as { draft_revision: number };
  assert.equal(
    (await request("POST", `/api/flows/${id}/publish`, { expected_revision: current.draft_revision })).status,
    201,
  );
  assert.equal((await request("POST", `/api/flows/${id}/enable`)).status, 422);

  const replacement = await republish(id, document());
  assert.equal(replacement.status, 201);
  assert.equal((await request("POST", `/api/flows/${id}/enable`)).status, 200);
  assert.equal((await request("DELETE", `/api/flows/${id}`)).status, 200);
  assert.equal((await pool.query("SELECT enabled FROM flows WHERE id=$1", [id])).rows[0].enabled, false);
  assert.equal((await request("POST", `/api/flows/${id}/enable`)).status, 409);
});

test("a comment starts one run pinned to its version and queues the branch's reply in the outbox", async () => {
  const id = await enabledFlow();
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'sender-vip','{vip}')",
    [workspaceId, connectionId],
  );
  await comment("comment-vip", "sender-vip");
  await comment("comment-vip", "sender-vip");
  await comment("comment-other-text", "sender-quiet", "hello there");

  const reply = (
    await pool.query("SELECT rule_id,flow_run_id,private_reply_text,follow_config,status FROM private_reply_outbox")
  ).rows;
  assert.equal(reply.length, 1);
  assert.equal(reply[0].rule_id, null);
  assert.equal(reply[0].private_reply_text, "VIP link");
  assert.equal(reply[0].follow_config, null);
  const [run] = await runs(id);
  assert.equal(run!.id, reply[0].flow_run_id);
  assert.equal(run!.version_no, 1);
  assert.equal(run!.status, "delivering");
  assert.equal(run!.delivery_status, "pending");
  assert.deepEqual(run!.steps, [
    { node_id: "start", node_type: "instagram_comment", outcome: "next" },
    { node_id: "vip", node_type: "has_tag", outcome: "true" },
    { node_id: "vip_reply", node_type: "instagram_message", outcome: "queued" },
  ]);

  assert.equal((await republish(id, document({ vipText: "New VIP link" }))).status, 201);
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'sender-new','{vip}')",
    [workspaceId, connectionId],
  );
  await comment("comment-new", "sender-new");
  const history = await runs(id);
  assert.deepEqual(
    history.map((entry) => entry.version_no),
    [2, 1],
  );
  assert.deepEqual(
    (await pool.query("SELECT private_reply_text FROM private_reply_outbox ORDER BY id")).rows.map(
      (row) => row.private_reply_text,
    ),
    ["VIP link", "New VIP link"],
  );
  const text = JSON.stringify(history);
  assert.doesNotMatch(text, /sender-|comment-|send the link/);
});

test("a path without a message ends, and a second comment from one sender is recorded as skipped", async () => {
  const id = await enabledFlow();
  await pool.query(
    "INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,'sender-seoul',$3,'\"Seoul\"')",
    [workspaceId, connectionId, fieldId],
  );
  await comment("comment-plain", "sender-plain");
  await comment("comment-seoul-1", "sender-seoul");
  await comment("comment-seoul-2", "sender-seoul");
  const history = await runs(id);
  assert.deepEqual(
    history.map((run) => [run.status, run.failure_code, run.delivery_status, run.steps.at(-1)!.outcome]),
    [
      ["skipped", "duplicate_recipient", null, "duplicate_recipient"],
      ["delivering", null, "pending", "queued"],
      ["ended", null, null, "false"],
    ],
  );
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM private_reply_outbox")).rows[0].count, 1);
});

test("the worker sends a flow reply while the flow is on, keeps it across a republish and blocks it once off", async () => {
  const id = await enabledFlow();
  await pool.query(
    `INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags)
     VALUES($1,$2,'sender-a','{vip}'),($1,$2,'sender-b','{vip}'),($1,$2,'sender-c','{vip}')`,
    [workspaceId, connectionId],
  );
  await comment("comment-a", "sender-a");
  assert.equal(await processNextPrivateReply(pool, sent, () => now, connectionId), true);

  await comment("comment-b", "sender-b");
  assert.equal((await republish(id, document({ vipText: "New VIP link" }))).status, 201);
  assert.equal(await processNextPrivateReply(pool, sent, () => now, connectionId), true);

  await comment("comment-c", "sender-c");
  assert.equal((await request("POST", `/api/flows/${id}/disable`)).status, 200);
  assert.equal(await processNextPrivateReply(pool, sent, () => now, connectionId), true);

  assert.deepEqual(
    (await runs(id)).map((run) => [run.version_no, run.delivery_status, run.delivery_failure_code]),
    [
      [2, "blocked", "inactive_flow"],
      [1, "sent", null],
      [1, "sent", null],
    ],
  );
  await comment("comment-d", "sender-d");
  assert.equal((await runs(id)).length, 3);
});

test("disconnecting the trigger connection turns its flows off", async () => {
  const id = await enabledFlow();
  assert.equal((await request("DELETE", `/api/connections/${connectionId}`, undefined, otherUserId)).status, 200);
  assert.equal((await pool.query("SELECT enabled FROM flows WHERE id=$1", [id])).rows[0].enabled, true);
  assert.equal((await request("DELETE", `/api/connections/${connectionId}`)).status, 200);
  assert.equal((await pool.query("SELECT enabled FROM flows WHERE id=$1", [id])).rows[0].enabled, false);
  await pool.query("UPDATE instagram_connections SET active=true,access_token_encrypted='token' WHERE id=$1", [
    connectionId,
  ]);
  await comment("comment-after-reconnect", "sender-1");
  assert.equal((await runs(id)).length, 0);
});

test("a disconnect waits for a concurrent enable and still turns the flow off", async () => {
  const id = await publishedFlow();
  const enabling = await pool.connect();
  try {
    // The same lock order as setFlowEnabled: the flow row first, then the connection row.
    await enabling.query("BEGIN");
    await enabling.query("SELECT 1 FROM flows WHERE id=$1 FOR UPDATE", [id]);
    await enabling.query("SELECT 1 FROM instagram_connections WHERE id=$1 FOR NO KEY UPDATE", [connectionId]);
    const disconnecting = request("DELETE", `/api/connections/${connectionId}`);
    for (let attempt = 0; attempt < 40; attempt++) {
      const waiting = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM flows WHERE workspace_id%'",
      );
      if (waiting.rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await enabling.query("UPDATE flows SET enabled=true WHERE id=$1", [id]);
    await enabling.query("COMMIT");
    assert.equal((await disconnecting).status, 200);
  } finally {
    enabling.release();
  }
  assert.equal((await pool.query("SELECT enabled FROM flows WHERE id=$1", [id])).rows[0].enabled, false);
});

test("run history is visible only to the flow's workspace", async () => {
  const id = await enabledFlow();
  assert.equal((await request("GET", `/api/flows/${id}/runs`, undefined, otherUserId)).status, 404);
});

test("connection and person deletion remove flow runs with the rows they point at", async () => {
  await enabledFlow();
  await pool.query(
    `INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags)
     VALUES($1,$2,'sender-a','{vip}')`,
    [workspaceId, connectionId],
  );
  await comment("comment-a", "sender-a");
  await comment("comment-b", "sender-b");
  const person = (
    await pool.query<{ result: { deleted_counts: Record<string, number> } }>(
      "SELECT public.delete_person_data($1,$2,$3,'comment_sender','sender-a') AS result",
      [workspaceId, connectionId, userId],
    )
  ).rows[0]!.result;
  assert.equal(person.deleted_counts.flow_runs, 1);
  assert.equal(person.deleted_counts.flow_step_runs, 3);
  assert.equal(person.deleted_counts.private_reply_outbox, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM flow_runs")).rows[0].count, 1);

  await pool.query("UPDATE instagram_connections SET active=false,access_token_encrypted=NULL WHERE id=$1", [
    connectionId,
  ]);
  const connection = (
    await pool.query<{ result: { deleted_counts: Record<string, number> } }>(
      "SELECT public.delete_connection_data($1,$2,$3,'owned-account') AS result",
      [workspaceId, connectionId, userId],
    )
  ).rows[0]!.result;
  assert.equal(connection.deleted_counts.flow_runs, 1);
  assert.equal(connection.deleted_counts.flow_step_runs, 3);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM flow_step_runs")).rows[0].count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM flow_versions")).rows[0].count, 1);
});

test("flow run migration replays and the schema keeps one reply source", async () => {
  const id = await enabledFlow();
  await comment("comment-plain", "sender-plain");
  const migration = await readFile(new URL("../../db/migrations/021_flow_runs.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  assert.equal((await pool.query("SELECT enabled FROM flows WHERE id=$1", [id])).rows[0].enabled, true);
  const run = (await pool.query("SELECT id,event_id FROM flow_runs")).rows[0];
  await assert.rejects(
    pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,comment_id,media_id,sender_id,private_reply_text)
       VALUES($1,$2,$3,'comment-plain','1789','sender-plain','x')`,
      [workspaceId, connectionId, run.event_id],
    ),
    { code: "23514" },
  );
  await assert.rejects(pool.query("UPDATE flows SET published_version_id=NULL WHERE id=$1", [id]), { code: "23514" });
  await assert.rejects(
    pool.query(
      `INSERT INTO flow_step_runs(run_id,workspace_id,connection_id,seq,node_id,node_type,outcome)
       VALUES($1,$2,$3,9,'x','has_tag','true')`,
      [run.id, otherWorkspaceId, connectionId],
    ),
    { code: "23503" },
  );
});
