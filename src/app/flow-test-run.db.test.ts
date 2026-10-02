import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { ingestComments, resumeDueFlowRuns } from "../instagram/store.ts";
import { ingestMessages } from "../instagram/follow-flow.ts";
import { processNextPrivateReply, type PrivateReplyTransport } from "../instagram/reply-worker.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const userId = "11111111-1111-4111-8111-111111111111";
const agentId = "12121212-1212-4212-8212-121212121212";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const connectionId = "55555555-5555-4555-8555-555555555555";
const cityField = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const countField = "77777777-7777-4777-8777-777777777777";
const sizeField = "88888888-8888-4888-8888-888888888888";
const flagField = "99999999-9999-4999-8999-999999999999";
const archivedField = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const endpointId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')",
    [workspaceId, userId, agentId, otherWorkspaceId, otherUserId],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted)
     VALUES($1,$2,'owned-account',true,'token')`,
    [connectionId, workspaceId],
  );
  await pool.query(
    `INSERT INTO instagram_contact_fields(id,workspace_id,name,type,archived) VALUES
     ($1,$6,'city','text',false),($2,$6,'count','number',false),($3,$6,'size','text',false),
     ($4,$6,'flag','boolean',false),($5,$6,'old','text',true)`,
    [cityField, countField, sizeField, flagField, archivedField, workspaceId],
  );
  await pool.query(
    "INSERT INTO webhook_endpoints(id,workspace_id,name,url) VALUES($1,$2,'crm','https://hooks.test/a')",
    [endpointId, workspaceId],
  );
});

after(async () => pool.end());

// Calls the API and records every fetch the auth client makes and every queue notification.
async function call(
  method: string,
  path: string,
  body?: unknown,
  options: { actor?: string; origin?: string } = {},
): Promise<{ response: Response; fetched: string[]; notified: string[] }> {
  const fetched: string[] = [];
  const notified: string[] = [];
  const response = await appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: {
        origin: options.origin ?? "https://app.test",
        cookie: "__Host-ac-access=test",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return Response.json({ id: options.actor ?? userId, email: "a@example.test", email_confirmed_at: "2026-09-25" });
    }) as typeof fetch,
    async (connection) => {
      notified.push(connection);
    },
  );
  return { response, fetched, notified };
}

async function request(method: string, path: string, body?: unknown) {
  return (await call(method, path, body)).response;
}

// Row count and content digest of every public table, so an INSERT, UPDATE or DELETE anywhere shows.
async function snapshot(): Promise<Record<string, string>> {
  const tables = (
    await pool.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`,
    )
  ).rows;
  const result: Record<string, string> = {};
  for (const { name } of tables) {
    const row = (
      await pool.query(
        `SELECT count(*)::text AS n,md5(coalesce(string_agg(t::text,',' ORDER BY t::text),'')) AS h FROM "${name}" t`,
      )
    ).rows[0];
    result[name] = `${row.n}:${row.h}`;
  }
  return result;
}

type TestRun = {
  source: string;
  version_no: number | null;
  status: string;
  failure_code: string | null;
  steps: { node_id: string; node_type: string; outcome: string }[];
  messages: { node_id: string; text: string }[];
  waits: { node_id: string; node_type: string; port: string; delay_minutes?: number; until_time?: string }[];
  changes: { tags: Record<string, boolean>; fields: Record<string, unknown> };
  webhooks: { node_id: string; endpoint_id: string; payload: Record<string, unknown> }[];
  error?: string;
  errors?: { code: string }[];
};

// Runs a test run and checks that it wrote nothing, made no request beyond the session check and
// queued no notification.
async function testRun(id: string, body: unknown, options: { actor?: string; origin?: string } = {}) {
  const before = await snapshot();
  const original = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => {
    outbound++;
    throw new Error("no outbound request is allowed");
  }) as typeof fetch;
  let result: Awaited<ReturnType<typeof call>>;
  try {
    result = await call("POST", `/api/flows/${id}/test-run`, body, options);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(outbound, 0);
  assert.ok(
    result.fetched.every((url) => url === `${apiEnv.SUPABASE_URL}/auth/v1/user`),
    String(result.fetched),
  );
  assert.deepEqual(result.notified, []);
  assert.deepEqual(await snapshot(), before);
  return { status: result.response.status, body: (await result.response.json()) as TestRun };
}

// start -> vip? (true -> buyer tag -> count=3 -> notify -> pause 5 min -> 09:00 -> city is Seoul?
// (true -> ask -> wait (replied -> answered tag -> report, timeout -> remove vip))).
function fullDocument(options: { save?: boolean } = {}) {
  return {
    schema_version: 1,
    nodes: [
      {
        id: "start",
        type: "instagram_comment",
        config: {
          connection_id: connectionId,
          media_id: "1789",
          keywords: ["size"],
          match_mode: "contains",
          excluded_keywords: [],
        },
      },
      { id: "vip", type: "has_tag", config: { tag: "VIP" } },
      { id: "buyer", type: "add_tag", config: { tag: "buyer" } },
      { id: "count", type: "set_field", config: { field_id: countField, value: 3 } },
      {
        id: "notify",
        type: "webhook",
        config: { endpoint_id: endpointId, field_ids: [cityField, countField], include_tags: true },
      },
      { id: "pause", type: "delay", config: { minutes: 5 } },
      { id: "morning", type: "wait_until", config: { time: "09:00" } },
      { id: "city", type: "field_equals", config: { field_id: cityField, field_operator: "eq", field_value: "Seoul" } },
      { id: "ask", type: "instagram_message", config: { text: `Hi {{field:${cityField}}}: {{comment.text}}` } },
      {
        id: "wait",
        type: "wait_for_reply",
        config: { timeout_minutes: 60, ...(options.save === false ? {} : { save_field_id: sizeField }) },
      },
      { id: "answered", type: "add_tag", config: { tag: "answered" } },
      {
        id: "report",
        type: "webhook",
        config: { endpoint_id: endpointId, field_ids: [countField], include_tags: false },
      },
      { id: "silent", type: "remove_tag", config: { tag: "vip" } },
    ],
    edges: [
      { from: "start", port: "next", to: "vip" },
      { from: "vip", port: "true", to: "buyer" },
      { from: "buyer", port: "next", to: "count" },
      { from: "count", port: "next", to: "notify" },
      { from: "notify", port: "next", to: "pause" },
      { from: "pause", port: "next", to: "morning" },
      { from: "morning", port: "next", to: "city" },
      { from: "city", port: "true", to: "ask" },
      { from: "ask", port: "next", to: "wait" },
      { from: "wait", port: "replied", to: "answered" },
      { from: "answered", port: "next", to: "report" },
      { from: "wait", port: "timeout", to: "silent" },
    ],
  };
}

async function createdFlow(draft: unknown, name = `Flow ${Math.random()}`): Promise<string> {
  const created = await request("POST", "/api/flows", { name, draft });
  assert.equal(created.status, 201);
  return ((await created.json()) as { id: string }).id;
}

async function published(draft: unknown): Promise<string> {
  const id = await createdFlow(draft);
  const response = await request("POST", `/api/flows/${id}/publish`, { expected_revision: 0 });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return id;
}

const contact = { tags: ["vip"], fields: { [cityField]: "Seoul" } };

function outcomes(steps: { node_id: string; outcome: string }[]) {
  return steps.map((step) => `${step.node_id}:${step.outcome}`);
}

test("a draft test run walks the whole path through delays, time waits and a saved reply", async () => {
  const id = await createdFlow(fullDocument());
  const { status, body } = await testRun(id, {
    source: "draft",
    comment_text: "size please",
    ...contact,
    reply_text: "XL",
    reply_branch: "replied",
  });
  assert.equal(status, 200);
  assert.deepEqual(outcomes(body.steps), [
    "start:next",
    "vip:true",
    "buyer:added",
    "count:set",
    "notify:queued",
    "pause:waiting",
    "morning:waiting",
    "city:true",
    "ask:queued",
    "wait:replied",
    "wait:set",
    "answered:added",
    "report:queued",
  ]);
  assert.deepEqual([body.source, body.version_no, body.status, body.failure_code], ["draft", null, "ended", null]);
  assert.deepEqual(body.messages, [{ node_id: "ask", text: "Hi Seoul: size please" }]);
  assert.deepEqual(body.waits, [
    { node_id: "pause", node_type: "delay", port: "next", delay_minutes: 5 },
    { node_id: "morning", node_type: "wait_until", port: "next", until_time: "09:00" },
    { node_id: "wait", node_type: "wait_for_reply", port: "replied" },
  ]);
  assert.deepEqual(body.changes, {
    tags: { buyer: true, answered: true },
    fields: { [countField]: 3, [sizeField]: "XL" },
  });
  // The same body a run queues, without the identifiers only a stored delivery has.
  assert.deepEqual(body.webhooks, [
    {
      node_id: "notify",
      endpoint_id: endpointId,
      payload: {
        event_id: null,
        type: "flow.webhook",
        created_at: null,
        flow_id: id,
        flow_version: null,
        run_id: null,
        node_id: "notify",
        tags: ["vip", "buyer"],
        fields: { [cityField]: "Seoul", [countField]: 3 },
      },
    },
    {
      node_id: "report",
      endpoint_id: endpointId,
      payload: {
        event_id: null,
        type: "flow.webhook",
        created_at: null,
        flow_id: id,
        flow_version: null,
        run_id: null,
        node_id: "report",
        fields: { [countField]: 3 },
      },
    },
  ]);
});

test("conditions, the reply branch and the save field each change the path", async () => {
  const saving = await createdFlow(fullDocument());
  const plain = await createdFlow(fullDocument({ save: false }));
  const base = { source: "draft", comment_text: "size please", reply_text: "XL" };

  const notVip = (await testRun(saving, { ...base, fields: contact.fields })).body;
  assert.deepEqual(outcomes(notVip.steps), ["start:next", "vip:false"]);
  assert.deepEqual([notVip.status, notVip.messages, notVip.waits], ["ended", [], []]);

  const elsewhere = (await testRun(saving, { ...base, tags: ["vip"], fields: { [cityField]: "Busan" } })).body;
  assert.deepEqual(outcomes(elsewhere.steps).slice(-1), ["city:false"]);
  assert.equal(elsewhere.status, "ended");

  const timeout = (await testRun(saving, { ...base, ...contact, reply_branch: "timeout" })).body;
  assert.deepEqual(outcomes(timeout.steps).slice(-3), ["ask:queued", "wait:timeout", "silent:removed"]);
  assert.deepEqual(timeout.changes, { tags: { vip: false, buyer: true }, fields: { [countField]: 3 } });

  const replied = (await testRun(plain, { ...base, ...contact })).body;
  assert.deepEqual(outcomes(replied.steps).slice(-4), [
    "ask:queued",
    "wait:replied",
    "answered:added",
    "report:queued",
  ]);
  assert.equal(replied.changes.fields[sizeField], undefined);

  const plainTimeout = (await testRun(plain, { ...base, ...contact, reply_branch: "timeout" })).body;
  assert.deepEqual(outcomes(plainTimeout.steps).slice(-2), ["wait:timeout", "silent:removed"]);

  // Facts the walk already holds: the stored value and tag are reported as unchanged.
  const same = (
    await testRun(saving, { ...base, tags: ["vip", "buyer"], fields: { ...contact.fields, [countField]: 3 } })
  ).body;
  assert.deepEqual(outcomes(same.steps).slice(2, 4), ["buyer:already_present", "count:unchanged"]);

  const unmatched = (await testRun(saving, { ...base, comment_text: "hello" })).body;
  assert.deepEqual([unmatched.status, unmatched.steps, unmatched.messages], ["not_matched", [], []]);
});

test("a tag named __proto__ is reported in the changes like any other tag", async () => {
  const flow = (type: string) =>
    createdFlow({
      schema_version: 1,
      nodes: [fullDocument().nodes[0], { id: "tag", type, config: { tag: "__proto__" } }],
      edges: [{ from: "start", port: "next", to: "tag" }],
    });
  const added = (await testRun(await flow("add_tag"), { source: "draft", comment_text: "size" })).body;
  assert.deepEqual(outcomes(added.steps), ["start:next", "tag:added"]);
  assert.deepEqual(added.changes.tags, Object.fromEntries([["__proto__", true]]));
  const removed = (
    await testRun(await flow("remove_tag"), { source: "draft", comment_text: "size", tags: ["__proto__"] })
  ).body;
  assert.deepEqual(outcomes(removed.steps), ["start:next", "tag:removed"]);
  assert.deepEqual(removed.changes.tags, Object.fromEntries([["__proto__", false]]));
});

test("a message that cannot render fails the run with its code and no message", async () => {
  const direct = await createdFlow({
    schema_version: 1,
    nodes: [
      fullDocument().nodes[0],
      { id: "ask", type: "instagram_message", config: { text: `Hi {{field:${cityField}}}` } },
    ],
    edges: [{ from: "start", port: "next", to: "ask" }],
  });
  const missing = (await testRun(direct, { source: "draft", comment_text: "size" })).body;
  assert.deepEqual([missing.status, missing.failure_code, missing.messages], ["failed", "variable_missing", []]);
  assert.deepEqual(outcomes(missing.steps), ["start:next", "ask:variable_missing"]);
  const sent = (await testRun(direct, { source: "draft", comment_text: "size", fields: contact.fields })).body;
  assert.deepEqual([sent.status, sent.messages], ["delivering", [{ node_id: "ask", text: "Hi Seoul" }]]);
});

for (const branch of ["replied", "timeout"] as const)
  test(`a published test run records the same steps, changes and payloads as a real ${branch} run`, async () => {
    const id = await published(fullDocument());
    assert.equal((await request("POST", `/api/flows/${id}/enable`)).status, 200);
    await pool.query(
      "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'sender-1','{vip}')",
      [workspaceId, connectionId],
    );
    await pool.query(
      `INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value)
       VALUES($1,$2,'sender-1',$3,'"Seoul"')`,
      [workspaceId, connectionId, cityField],
    );
    await ingestComments(pool, [
      { accountId: "owned-account", commentId: "comment-1", postId: "1789", senderId: "sender-1", text: "size please" },
    ]);
    for (let resumes = 0; resumes < 2; resumes++) {
      await pool.query("UPDATE flow_runs SET resume_at=now()-interval '1 second' WHERE status='waiting'");
      assert.equal(await resumeDueFlowRuns(pool), 1);
    }
    const transport: PrivateReplyTransport = {
      verify: async () => ({ commentCreatedAt: new Date(), authorizationVerified: true, mediaOwned: true }),
      send: async () => ({ messageId: "mid-1", recipientId: "9001" }),
    };
    assert.ok(await processNextPrivateReply(pool, transport, () => new Date(), connectionId));
    if (branch === "replied")
      await ingestMessages(pool, [
        {
          accountId: "owned-account",
          senderId: "9001",
          messageId: "in-1",
          text: "XL",
          timestamp: new Date(Date.now() + 1000),
        },
      ]);
    else {
      await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '61 minutes' WHERE status='sent'");
      assert.equal(await resumeDueFlowRuns(pool), 1);
    }
    const [run] = (
      (await (await request("GET", `/api/flows/${id}/runs`)).json()) as {
        runs: { status: string; steps: TestRun["steps"] }[];
      }
    ).runs;
    assert.equal(run!.status, "ended");

    const { body } = await testRun(id, {
      source: "published",
      comment_text: "size please",
      ...contact,
      reply_text: "XL",
      reply_branch: branch,
    });
    assert.deepEqual([body.source, body.version_no, body.status], ["published", 1, "ended"]);
    assert.deepEqual(body.steps, run!.steps);
    assert.deepEqual(
      body.messages.map((message) => message.text),
      [(await pool.query("SELECT private_reply_text FROM private_reply_outbox")).rows[0].private_reply_text],
    );
    const stored = await pool.query(
      `SELECT (SELECT tags FROM instagram_contact_tags WHERE sender_id='sender-1') AS tags,
         (SELECT jsonb_object_agg(field_id::text,value) FROM instagram_contact_field_values WHERE sender_id='sender-1') AS fields`,
    );
    const finalTags = new Set<string>(stored.rows[0].tags);
    for (const tag of new Set([...contact.tags, ...finalTags]))
      assert.equal(
        body.changes.tags[tag],
        contact.tags.includes(tag) === finalTags.has(tag) ? undefined : finalTags.has(tag),
      );
    assert.deepEqual({ ...contact.fields, ...body.changes.fields }, stored.rows[0].fields);
    const deliveries = (
      await pool.query("SELECT node_id,endpoint_id::text,payload FROM webhook_deliveries ORDER BY created_at,node_id")
    ).rows;
    assert.ok(deliveries.length);
    assert.deepEqual(
      body.webhooks,
      deliveries.map((delivery) => ({
        node_id: delivery.node_id,
        endpoint_id: delivery.endpoint_id,
        payload: { ...delivery.payload, event_id: null, created_at: null, run_id: null },
      })),
    );
  });

test("a published test run leaves out a field that another version saves a reply into", async () => {
  const id = await published({
    schema_version: 1,
    nodes: [
      fullDocument().nodes[0],
      {
        id: "notify",
        type: "webhook",
        config: { endpoint_id: endpointId, field_ids: [cityField, countField], include_tags: false },
      },
    ],
    edges: [{ from: "start", port: "next", to: "notify" }],
  });
  // Two concurrent publishes can both pass their checks; this version stands for the other one.
  const other = (
    await pool.query("INSERT INTO flows(workspace_id,name,draft) VALUES($1,'ask','{}') RETURNING id", [workspaceId])
  ).rows[0].id;
  await pool.query(
    `INSERT INTO flow_versions(flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,field_ids,published_by)
     VALUES($1,$2,1,0,$3::jsonb,$4,'2001',$5::uuid[],$6)`,
    [
      other,
      workspaceId,
      JSON.stringify({
        schema_version: 1,
        nodes: [{ id: "wait", type: "wait_for_reply", config: { timeout_minutes: 60, save_field_id: cityField } }],
        edges: [],
      }),
      connectionId,
      [cityField],
      userId,
    ],
  );
  const { body } = await testRun(id, { source: "published", comment_text: "size", fields: contact.fields });
  assert.deepEqual(outcomes(body.steps), ["start:next", "notify:queued"]);
  assert.deepEqual(body.webhooks[0]!.payload.fields, { [countField]: null });
});

test("unpublishable and unexecutable drafts return only their errors", async () => {
  const empty = await createdFlow({ schema_version: 1, nodes: [], edges: [] });
  const invalid = await testRun(empty, { source: "draft", comment_text: "size" });
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body, { error: "flow_invalid", errors: [{ code: "trigger_count", path: "nodes" }] });

  const follow = await createdFlow({
    schema_version: 1,
    nodes: [fullDocument().nodes[0], { id: "f", type: "follows_account", config: {} }],
    edges: [{ from: "start", port: "next", to: "f" }],
  });
  const unexecutable = await testRun(follow, { source: "draft", comment_text: "size" });
  assert.equal(unexecutable.status, 422);
  assert.deepEqual(unexecutable.body, {
    error: "flow_not_executable",
    errors: [{ code: "unsupported_node", node_id: "f", path: "nodes[1].type" }],
  });

  const unpublished = await testRun(follow, { source: "published", comment_text: "size" });
  assert.deepEqual([unpublished.status, unpublished.body.error], [409, "flow_not_published"]);
  assert.equal((await request("DELETE", `/api/flows/${follow}`)).status, 200);
  const archived = await testRun(follow, { source: "draft", comment_text: "size" });
  assert.deepEqual([archived.status, archived.body.error], [409, "flow_archived"]);
});

test("an inactive trigger connection fails the draft's publish validation but not the published version", async () => {
  const id = await published({ schema_version: 1, nodes: [fullDocument().nodes[0]], edges: [] });
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connectionId]);
  const draft = await testRun(id, { source: "draft", comment_text: "size please" });
  assert.equal(draft.status, 422);
  assert.equal(draft.body.error, "flow_invalid");
  assert.deepEqual(
    draft.body.errors!.map((error) => error.code),
    ["connection_unavailable"],
  );
  const version = await testRun(id, { source: "published", comment_text: "size please" });
  assert.deepEqual([version.status, version.body.status], [200, "ended"]);
});

test("synthetic input is validated against the workspace's fields with fixed codes", async () => {
  const id = await createdFlow(fullDocument());
  const cases: [unknown, number, string][] = [
    [{ source: "live", comment_text: "size" }, 400, "invalid_test_run"],
    [{ source: "draft" }, 400, "invalid_test_run"],
    [{ source: "draft", comment_text: "size", sender_id: "123" }, 400, "invalid_test_run"],
    [{ source: "draft", comment_text: "x".repeat(2001) }, 400, "invalid_test_run"],
    [{ source: "draft", comment_text: "size", reply_branch: "later" }, 400, "invalid_test_run"],
    [{ source: "draft", comment_text: "size", tags: ["\u0000"] }, 400, "invalid_contact_tags"],
    [
      { source: "draft", comment_text: "size", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      400,
      "invalid_test_run",
    ],
    [{ source: "draft", comment_text: "size", fields: { city: "Seoul" } }, 400, "invalid_test_run"],
    [
      { source: "draft", comment_text: "size", fields: { [cityField]: "a", [cityField.toUpperCase()]: "b" } },
      400,
      "invalid_test_run",
    ],
    [{ source: "draft", comment_text: "size", fields: { [endpointId]: "x" } }, 400, "unknown_field"],
    [{ source: "draft", comment_text: "size", fields: { [archivedField]: "x" } }, 400, "unknown_field"],
    [{ source: "draft", comment_text: "size", fields: { [countField]: "3" } }, 400, "invalid_field_value"],
    [{ source: "draft", comment_text: "size", fields: { [flagField]: null } }, 400, "invalid_field_value"],
  ];
  for (const [body, status, error] of cases) {
    const result = await testRun(id, body);
    assert.deepEqual([result.status, result.body.error], [status, error], JSON.stringify(body));
  }
  // Field IDs in any case name the same stored field.
  const upper = (
    await testRun(id, {
      source: "draft",
      comment_text: "size",
      tags: ["VIP"],
      fields: { [cityField.toUpperCase()]: "Seoul" },
    })
  ).body;
  assert.deepEqual(upper.messages, [{ node_id: "ask", text: "Hi Seoul: size" }]);
});

test("only an admin of the flow's workspace may test it, from the app origin", async () => {
  const id = await createdFlow(fullDocument());
  const body = { source: "draft", comment_text: "size" };
  const agent = await testRun(id, body, { actor: agentId });
  assert.deepEqual([agent.status, agent.body.error], [403, "role_forbidden"]);
  const outsider = await testRun(id, body, { actor: otherUserId });
  assert.deepEqual([outsider.status, outsider.body.error], [404, "flow_not_found"]);
  const foreign = await testRun(id, body, { origin: "https://evil.test" });
  assert.deepEqual([foreign.status, foreign.body.error], [403, "origin_rejected"]);
  assert.equal((await testRun(id, body)).status, 200);
});
