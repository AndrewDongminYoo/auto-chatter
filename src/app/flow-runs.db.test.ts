import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { ingestComments } from "../instagram/store.ts";
import { lockContact } from "./contact-fields.ts";
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

function document(options: { connection?: string; vipText?: string; unsupported?: boolean } = {}) {
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
      ...(options.unsupported ? [{ id: "follow", type: "follows_account", config: {} }] : []),
    ],
    edges: [
      { from: "start", port: "next", to: "vip" },
      { from: "vip", port: "true", to: "vip_reply" },
      { from: "vip", port: "false", to: "city" },
      { from: "city", port: "true", to: "seoul_reply" },
      ...(options.unsupported ? [{ from: "city", port: "false", to: "follow" }] : []),
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

  const unsupported = await publishedFlow(document({ unsupported: true }));
  const refused = await request("POST", `/api/flows/${unsupported}/enable`);
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), {
    error: "flow_not_executable",
    errors: [{ code: "unsupported_node", node_id: "follow", path: "nodes[5].type" }],
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
  const refused = await republish(id, document({ unsupported: true }));
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

test("a run that read the flow before a disable committed keeps its actions, and its reply is blocked", async () => {
  const id = await enabledActionFlow("Thanks");
  const disabling = await pool.connect();
  try {
    // The statements setFlowEnabled runs to turn the flow off, left uncommitted.
    await disabling.query("BEGIN");
    await disabling.query("SELECT 1 FROM flows WHERE id=$1 FOR NO KEY UPDATE", [id]);
    await disabling.query("UPDATE flows SET enabled=false,updated_at=clock_timestamp() WHERE id=$1", [id]);
    const outcome = await Promise.race([
      comment("comment-1", "sender-1").then(() => "ingested"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 2000)),
    ]);
    assert.equal(outcome, "ingested");
    await disabling.query("COMMIT");
  } finally {
    await disabling.query("ROLLBACK");
    disabling.release();
  }
  // Serializable as the comment arriving just before the disable: the actions stay, the reply is not sent.
  assert.deepEqual(await contact("sender-1"), { tags: ["lead"], city: "Seoul" });
  assert.equal(await processNextPrivateReply(pool, sent, () => now, connectionId), true);
  assert.deepEqual(
    (await runs(id)).map((run) => [run.status, run.delivery_status, run.delivery_failure_code]),
    [["delivering", "blocked", "inactive_flow"]],
  );
});

test("disconnecting the trigger connection turns its flows off", async () => {
  const id = await enabledFlow();
  assert.equal((await request("DELETE", `/api/connections/${connectionId}`, undefined, otherUserId)).status, 404);
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

test("a disconnect does not wait for the foreign key locks an open ingestion holds on flows", async () => {
  const id = await publishedFlow();
  const ingesting = await pool.connect();
  try {
    await ingesting.query("BEGIN");
    await ingesting.query("SELECT 1 FROM flows WHERE id=$1 FOR KEY SHARE", [id]);
    const outcome = await Promise.race([
      request("DELETE", `/api/connections/${connectionId}`).then((response) => response.status),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 2000)),
    ]);
    assert.equal(outcome, 200);
  } finally {
    await ingesting.query("ROLLBACK");
    ingesting.release();
  }
});

// start -> add lead -> remove old -> set city -> reply, each on its "next" port.
function actionDocument(text = `Hi from {{field:${fieldId}}}: {{comment.text}}`) {
  const base = document();
  const nodes = [
    base.nodes[0]!,
    { id: "add", type: "add_tag", config: { tag: "Lead" } },
    { id: "drop", type: "remove_tag", config: { tag: "old" } },
    { id: "set", type: "set_field", config: { field_id: fieldId, value: "Seoul" } },
    { id: "reply", type: "instagram_message", config: { text } },
  ];
  return {
    ...base,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, port: "next", to: node.id })),
  };
}

async function enabledActionFlow(text?: string): Promise<string> {
  const id = await publishedFlow(actionDocument(text));
  assert.equal((await request("POST", `/api/flows/${id}/enable`)).status, 200);
  return id;
}

async function contact(senderId: string) {
  const tags = await pool.query("SELECT tags FROM instagram_contact_tags WHERE connection_id=$1 AND sender_id=$2", [
    connectionId,
    senderId,
  ]);
  const fields = await pool.query(
    "SELECT value FROM instagram_contact_field_values WHERE connection_id=$1 AND sender_id=$2 AND field_id=$3",
    [connectionId, senderId, fieldId],
  );
  return { tags: tags.rows[0]?.tags as string[] | undefined, city: fields.rows[0]?.value as unknown };
}

// Waits until another backend is blocked on a lock whose query matches the pattern.
async function lockWait(pattern: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1", [
      pattern,
    ]);
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`no backend waited on ${pattern}`);
}

test("tag and field actions write the contact and the reply renders the variables once", async () => {
  const id = await enabledActionFlow();
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'sender-1','{old,keep}')",
    [workspaceId, connectionId],
  );
  await comment("comment-1", "sender-1", `link {{field:${fieldId}}}`);
  assert.deepEqual(await contact("sender-1"), { tags: ["keep", "lead"], city: "Seoul" });
  const reply = (await pool.query("SELECT private_reply_text FROM private_reply_outbox")).rows;
  assert.deepEqual(
    reply.map((row) => row.private_reply_text),
    [`Hi from Seoul: link {{field:${fieldId}}}`],
  );
  const [run] = await runs(id);
  assert.equal(run!.status, "delivering");
  assert.deepEqual(
    run!.steps.map((step) => step.outcome),
    ["next", "added", "removed", "set", "queued"],
  );

  // A contact without stored tags gets a row, and a redelivered comment changes nothing twice.
  await comment("comment-2", "sender-2");
  await comment("comment-2", "sender-2");
  assert.deepEqual(await contact("sender-2"), { tags: ["lead"], city: "Seoul" });
  assert.equal((await runs(id)).length, 2);
});

test("a paused contact still gets the actions while its reply waits for the pause", async () => {
  await enabledActionFlow();
  await pool.query(
    `INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused,handoff_paused)
     VALUES($1,$2,'sender-paused',true,true)`,
    [workspaceId, connectionId],
  );
  await comment("comment-paused", "sender-paused");
  assert.deepEqual(await contact("sender-paused"), { tags: ["lead"], city: "Seoul" });
  assert.equal((await pool.query("SELECT status FROM private_reply_outbox")).rows[0].status, "pending");
});

test("a missing variable fails the run after the actions before it, and queues no reply", async () => {
  const other = "12121212-1212-4121-8121-121212121212";
  await pool.query("INSERT INTO instagram_contact_fields(id,workspace_id,name,type) VALUES($1,$2,'plan','text')", [
    other,
    workspaceId,
  ]);
  const id = await enabledActionFlow(`Your plan: {{field:${other}}}`);
  await comment("comment-1", "sender-1");
  const [run] = await runs(id);
  assert.deepEqual(
    [run!.status, run!.failure_code, run!.steps.at(-1)!.outcome],
    ["failed", "variable_missing", "variable_missing"],
  );
  assert.deepEqual(await contact("sender-1"), { tags: ["lead"], city: "Seoul" });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM private_reply_outbox")).rows[0].count, 0);
});

test("a field archived under a published version fails the run at its set_field node", async () => {
  const id = await enabledActionFlow("Thanks");
  await pool.query("UPDATE instagram_contact_fields SET archived=true WHERE id=$1", [fieldId]);
  await comment("comment-1", "sender-1");
  const [run] = await runs(id);
  assert.deepEqual([run!.status, run!.failure_code], ["failed", "field_unavailable"]);
  assert.deepEqual(await contact("sender-1"), { tags: ["lead"], city: undefined });
});

// Holds a manual edit open on sender-1 under the contact lock, as the contact APIs take it, while
// a comment arrives; then commits it.
async function withOpenContactEdit(sql: string, values: unknown[]) {
  const other = await pool.connect();
  try {
    await other.query("BEGIN");
    await lockContact(other, connectionId, "sender-1");
    await other.query(sql, values);
    const ingesting = comment("comment-1", "sender-1");
    await lockWait("%");
    await other.query("COMMIT");
    await ingesting;
  } finally {
    await other.query("ROLLBACK");
    other.release();
  }
}

// Pauses a run after it read the contact (its flow_runs insert checks the version row held here),
// then starts a manual edit through the API and checks that the edit waits for the run.
async function withRunPausedAfterRead(id: string, commentId: string, edit: () => Promise<Response>) {
  const pausing = await pool.connect();
  try {
    await pausing.query("BEGIN");
    await pausing.query("SELECT 1 FROM flow_versions WHERE flow_id=$1 FOR UPDATE", [id]);
    const ingesting = comment(commentId, "sender-1");
    await lockWait("%INSERT INTO flow_runs%");
    const editing = edit();
    await lockWait("%pg_advisory_xact_lock%");
    await pausing.query("COMMIT");
    await ingesting;
    assert.equal((await editing).status, 200);
  } finally {
    await pausing.query("ROLLBACK");
    pausing.release();
  }
}

test("a run waits for an open manual tag edit and plans from the committed tags", async () => {
  await enabledActionFlow("Thanks");
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'sender-1','{old}')",
    [workspaceId, connectionId],
  );
  await withOpenContactEdit("UPDATE instagram_contact_tags SET tags='{old,manual}' WHERE sender_id='sender-1'", []);
  assert.deepEqual((await contact("sender-1")).tags, ["manual", "lead"]);
});

test("a tag slot taken by an open manual edit is recorded as tag_limit, not as added", async () => {
  const id = await enabledActionFlow("Thanks");
  const nineteen = Array.from({ length: 19 }, (_, index) => `t${index}`);
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'sender-1',$3)",
    [workspaceId, connectionId, nineteen],
  );
  await withOpenContactEdit("UPDATE instagram_contact_tags SET tags=$1 WHERE sender_id='sender-1'", [
    [...nineteen, "manual"],
  ]);
  assert.deepEqual((await contact("sender-1")).tags, [...nineteen, "manual"]);
  assert.deepEqual(
    (await runs(id))[0]!.steps.map((step) => step.outcome),
    ["next", "tag_limit", "absent", "set", "queued"],
  );
});

test("a run waits for an open manual field edit and plans from the committed value", async () => {
  const id = await enabledActionFlow("Thanks");
  await withOpenContactEdit(
    `INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value)
     VALUES($1,$2,'sender-1',$3,'"Seoul"')`,
    [workspaceId, connectionId, fieldId],
  );
  assert.equal((await runs(id))[0]!.steps[3]!.outcome, "unchanged");
});

test("manual tag and field edits that start after a run read the contact wait for that run", async () => {
  const id = await enabledActionFlow("Thanks");
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'sender-1','{old}')",
    [workspaceId, connectionId],
  );
  await withRunPausedAfterRead(id, "comment-1", () =>
    request("PATCH", `/api/connections/${connectionId}/contacts/sender-1`, { tags: ["old", "manual"] }),
  );
  // The edit ran after the run, so it replaced the run's result instead of being overwritten by it.
  assert.deepEqual((await contact("sender-1")).tags, ["manual", "old"]);
  assert.deepEqual(
    (await runs(id))[0]!.steps.map((step) => step.outcome),
    ["next", "added", "removed", "set", "queued"],
  );

  await withRunPausedAfterRead(id, "comment-2", () =>
    request("PUT", `/api/connections/${connectionId}/contacts/sender-1/fields/${fieldId}`, { value: "Busan" }),
  );
  assert.equal((await contact("sender-1")).city, "Busan");
});

test("a comment batch never deadlocks with a publish or enable that holds a flow row", async () => {
  const actions = await enabledActionFlow("Thanks");
  const other = document();
  other.nodes[0]!.config.media_id = "1790";
  const second = await publishedFlow(other);
  assert.equal((await request("POST", `/api/flows/${second}/enable`)).status, 200);
  const enabling = await pool.connect();
  try {
    // The lock modes of publishFlow and setFlowEnabled: the flow row, then the connection row.
    await enabling.query("BEGIN");
    await enabling.query("SELECT 1 FROM flows WHERE id=$1 FOR NO KEY UPDATE", [second]);
    // The first comment's run holds the connection lock while the second checks the held flow row.
    const ingesting = ingestComments(pool, [
      { accountId: "owned-account", commentId: "c-1", postId: "1789", senderId: "sender-1", text: "link" },
      { accountId: "owned-account", commentId: "c-2", postId: "1790", senderId: "sender-2", text: "link" },
    ]);
    await Promise.race([ingesting, lockWait("%INSERT INTO flow_runs%").catch(() => undefined)]);
    await enabling.query("SELECT 1 FROM instagram_connections WHERE id=$1 FOR NO KEY UPDATE", [connectionId]);
    await enabling.query("COMMIT");
    await ingesting;
  } finally {
    await enabling.query("ROLLBACK");
    enabling.release();
  }
  assert.equal((await runs(actions)).length, 1);
  assert.equal((await runs(second)).length, 1);
});

test("a run that changes contact data waits for a concurrent disconnect and then starts nothing", async () => {
  const id = await enabledActionFlow("Thanks");
  const disconnecting = await pool.connect();
  try {
    await disconnecting.query("BEGIN");
    await disconnecting.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connectionId]);
    const ingesting = comment("comment-1", "sender-1");
    await lockWait("%FROM instagram_connections WHERE id=$1 AND workspace_id=$2%FOR SHARE%");
    await disconnecting.query("COMMIT");
    await ingesting;
  } finally {
    disconnecting.release();
  }
  assert.equal((await runs(id)).length, 0);
  assert.deepEqual(await contact("sender-1"), { tags: undefined, city: undefined });
});

test("enabling refuses a boolean field used as a message variable", async () => {
  const flag = "13131313-1313-4131-8131-131313131313";
  await pool.query("INSERT INTO instagram_contact_fields(id,workspace_id,name,type) VALUES($1,$2,'vip','boolean')", [
    flag,
    workspaceId,
  ]);
  const id = await publishedFlow(actionDocument(`VIP: {{field:${flag}}}`));
  const refused = await request("POST", `/api/flows/${id}/enable`);
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), {
    error: "flow_not_executable",
    errors: [{ code: "unsupported_variable", node_id: "reply", path: "nodes[4].config.text" }],
  });

  await pool.query("TRUNCATE flows CASCADE");
  const enabled = await enabledActionFlow("Thanks");
  const republished = await republish(enabled, actionDocument(`VIP: {{field:${flag}}}`));
  assert.equal(republished.status, 422);
  assert.equal(((await republished.json()) as { errors: { code: string }[] }).errors[0]!.code, "unsupported_variable");
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
