import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { openSecret } from "./secrets.ts";
import { deliverDueWebhooks, signingKeyContext } from "./webhook-delivery.ts";
import { MAX_ACTIVE_WEBHOOK_ENDPOINTS } from "./webhooks.ts";
import { ingestMessages } from "../instagram/follow-flow.ts";
import { processNextPrivateReply, type PrivateReplyTransport } from "../instagram/reply-worker.ts";
import { ingestComments, resumeDueFlowRuns } from "../instagram/store.ts";

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
const cityField = "88888888-8888-4888-8888-888888888888";
const tierField = "99999999-9999-4999-8999-999999999999";
const missingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const encryptionKey = Buffer.alloc(32, 5).toString("base64");
const apiEnv = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  TOKEN_ENCRYPTION_KEY: encryptionKey,
};
// Identifiers and text that must never reach a payload.
const mediaId = "178900000000424242";
const senderId = "990000000000777";
const recipientId = "880000000000555";
const accountId = "account-IG-SENTINEL";
const commentText = "COMMENT-TEXT-SENTINEL link";

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces, workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role)
     VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')`,
    [workspaceId, ownerId, adminId, agentId, otherWorkspaceId, outsiderId],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,active,access_token_encrypted)
     VALUES($1,$2,$3,'username-IG-SENTINEL',true,'token')`,
    [connectionId, workspaceId, accountId],
  );
  await pool.query(
    "INSERT INTO instagram_contact_fields(id,workspace_id,name,type) VALUES($1,$3,'city','text'),($2,$3,'tier','text')",
    [cityField, tierField, workspaceId],
  );
});

afterEach(() => mock.restoreAll());
after(async () => pool.end());

function request(
  actorId: string,
  method: string,
  path: string,
  body?: unknown,
  options: { origin?: string | null; env?: Omit<typeof apiEnv, "TOKEN_ENCRYPTION_KEY"> } = {},
) {
  const origin = options.origin === undefined ? "https://app.test" : options.origin;
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: {
        ...(origin === null ? {} : { origin }),
        cookie: "__Host-ac-access=test",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    options.env ?? apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () =>
      Response.json({ id: actorId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

async function errorOf(response: Response): Promise<string | undefined> {
  return ((await response.clone().json()) as { error?: string }).error;
}

type Created = { id: string; name: string; url: string; active: boolean; key: { id: string; secret: string } };

async function createEndpoint(name = "crm", url = "https://hooks.example.test/in", actor = adminId): Promise<Created> {
  const response = await request(actor, "POST", "/api/webhooks/endpoints", { name, url });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as Created;
}

const trigger = (media = mediaId) => ({
  id: "start",
  type: "instagram_comment",
  config: {
    connection_id: connectionId,
    media_id: media,
    keywords: ["link"],
    match_mode: "contains",
    excluded_keywords: [],
  },
});

function chain(nodes: { id: string; type: string; config: unknown }[], media = mediaId) {
  const all = [trigger(media), ...nodes];
  return {
    schema_version: 1,
    nodes: all,
    edges: all.slice(1).map((node, index) => ({ from: all[index]!.id, port: "next", to: node.id })),
  };
}

const hook = (id: string, endpointId: string, fieldIds: string[] = [], includeTags = true) => ({
  id,
  type: "webhook",
  config: { endpoint_id: endpointId, field_ids: fieldIds, include_tags: includeTags },
});

async function draftFlow(draft: unknown): Promise<string> {
  const created = await request(adminId, "POST", "/api/flows", { name: `Notify ${Math.random()}`, draft });
  assert.equal(created.status, 201, await created.clone().text());
  return ((await created.json()) as { id: string }).id;
}

async function enabledFlow(draft: unknown): Promise<string> {
  const id = await draftFlow(draft);
  const published = await request(adminId, "POST", `/api/flows/${id}/publish`, { expected_revision: 0 });
  assert.equal(published.status, 201, await published.clone().text());
  assert.equal((await request(adminId, "POST", `/api/flows/${id}/enable`)).status, 200);
  return id;
}

function comment(commentId: string, sender = senderId, media = mediaId) {
  return ingestComments(pool, [{ accountId, commentId, postId: media, senderId: sender, text: commentText }]);
}

async function contact(sender: string, tags: string[], city?: string) {
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,$4)",
    [workspaceId, connectionId, sender, tags],
  );
  if (city !== undefined)
    await pool.query(
      "INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,$3,$4,$5)",
      [workspaceId, connectionId, sender, cityField, JSON.stringify(city)],
    );
}

type Delivery = {
  event_id: string;
  node_id: string;
  status: string;
  attempt_count: number;
  failure_code: string | null;
  sender_id: string;
  flow_run_id: string;
  payload: Record<string, unknown> | null;
};

async function deliveries(): Promise<Delivery[]> {
  return (
    await pool.query<Delivery>(
      `SELECT event_id::text,node_id,status,attempt_count,failure_code,sender_id,flow_run_id::text,payload
       FROM webhook_deliveries ORDER BY created_at,event_id`,
    )
  ).rows;
}

async function stepsOf(flowId: string): Promise<string[][]> {
  const response = await request(adminId, "GET", `/api/flows/${flowId}/runs`);
  const { runs } = (await response.json()) as { runs: { steps: { node_id: string; outcome: string }[] }[] };
  return runs.map((run) => run.steps.map((step) => `${step.node_id}:${step.outcome}`));
}

const transport: PrivateReplyTransport = {
  verify: async () => ({ commentCreatedAt: new Date(), authorizationVerified: true, mediaOwned: true }),
  send: async (reply) => ({ messageId: `mid-${reply.commentId}`, recipientId }),
};

function deliver(fetchImpl: typeof fetch) {
  return deliverDueWebhooks(pool, encryptionKey, { fetchImpl, resolve: async () => ["93.184.216.34"] });
}

async function makeDead() {
  await pool.query("UPDATE webhook_deliveries SET status='dead',attempt_count=6,failure_code='http_error'");
}

test("agents are refused every webhook route, admins are not, and another workspace sees nothing", async () => {
  const endpoint = await createEndpoint();
  const flow = await enabledFlow(chain([hook("notify", endpoint.id)]));
  await comment("comment-1");
  await makeDead();
  const [delivery] = await deliveries();
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/webhooks/endpoints"],
    ["POST", "/api/webhooks/endpoints", { name: "second", url: "https://second.example.test/in" }],
    ["POST", `/api/webhooks/endpoints/${endpoint.id}/rotate`],
    ["POST", `/api/webhooks/endpoints/${endpoint.id}/retire`],
    ["POST", `/api/webhooks/endpoints/${endpoint.id}/disable`],
    ["POST", `/api/webhooks/endpoints/${endpoint.id}/enable`],
    ["GET", "/api/webhooks/deliveries"],
    ["POST", `/api/webhooks/deliveries/${delivery!.event_id}/redeliver`],
  ];
  for (const [method, path, body] of routes) {
    const denied = await request(agentId, method, path, body);
    assert.equal(denied.status, 403, `${method} ${path} as agent`);
    assert.equal(await errorOf(denied), "role_forbidden", `${method} ${path} as agent`);
  }
  // Nothing changed while the agent was refused.
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM webhook_endpoints")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM webhook_signing_keys")).rows[0].count, 1);
  assert.equal((await deliveries())[0]!.status, "dead");
  for (const [method, path, body] of routes) {
    const allowed = await request(adminId, method, path, body);
    assert.ok([200, 201].includes(allowed.status), `${method} ${path} as admin returned ${allowed.status}`);
  }
  // The other workspace's owner reaches none of these rows.
  for (const [method, path] of routes.filter(([, path]) => path.includes(endpoint.id) || path.includes("redeliver"))) {
    const foreign = await request(outsiderId, method, path);
    assert.equal(foreign.status, 404, `${method} ${path} from another workspace`);
  }
  const foreignEndpoints = (await (await request(outsiderId, "GET", "/api/webhooks/endpoints")).json()) as {
    endpoints: unknown[];
  };
  assert.deepEqual(foreignEndpoints.endpoints, []);
  const foreignDeliveries = (await (await request(outsiderId, "GET", "/api/webhooks/deliveries")).json()) as {
    deliveries: unknown[];
  };
  assert.deepEqual(foreignDeliveries.deliveries, []);
  assert.equal((await stepsOf(flow)).length, 1);
});

test("a webhook write from another origin or without one is refused", async () => {
  const body = { name: "crm", url: "https://hooks.example.test/in" };
  for (const origin of [null, "https://evil.example"]) {
    const response = await request(adminId, "POST", "/api/webhooks/endpoints", body, { origin });
    assert.equal(response.status, 403);
    assert.equal(await errorOf(response), "origin_rejected");
  }
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM webhook_endpoints")).rows[0].count, 0);
});

test("creating an endpoint returns its signing secret once and stores it sealed", async () => {
  const outbound = mock.method(globalThis, "fetch", async () => {
    throw new Error("creation must not resolve or request the address");
  });
  const created = await createEndpoint("  CRM  ", "https://hooks.example.test/in?token=abc");
  assert.equal(outbound.mock.callCount(), 0);
  assert.equal(created.name, "CRM");
  assert.equal(created.url, "https://hooks.example.test/in?token=abc");
  assert.equal(created.active, true);
  assert.match(created.key.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  const stored = (
    await pool.query(
      "SELECT id::text,secret_encrypted,slot,retired_at FROM webhook_signing_keys WHERE endpoint_id=$1",
      [created.id],
    )
  ).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, created.key.id);
  assert.ok(!stored[0].secret_encrypted.includes(created.key.secret));
  assert.equal(
    openSecret(stored[0].secret_encrypted, encryptionKey, signingKeyContext(workspaceId, created.id, created.key.id)),
    created.key.secret,
  );
  // The seal is bound to the workspace, the endpoint and the key.
  for (const context of [
    signingKeyContext(otherWorkspaceId, created.id, created.key.id),
    signingKeyContext(workspaceId, missingId, created.key.id),
    signingKeyContext(workspaceId, created.id, missingId),
  ])
    assert.throws(() => openSecret(stored[0].secret_encrypted, encryptionKey, context));

  const listed = await request(adminId, "GET", "/api/webhooks/endpoints");
  const text = await listed.clone().text();
  assert.ok(!text.includes(created.key.secret));
  assert.ok(!text.includes("secret"));
  const { endpoints } = (await listed.json()) as {
    endpoints: { id: string; name: string; url: string; active: boolean; keys: { id: string }[] }[];
  };
  assert.equal(endpoints.length, 1);
  assert.deepEqual(
    [endpoints[0]!.id, endpoints[0]!.name, endpoints[0]!.active, endpoints[0]!.keys.map((key) => key.id)],
    [created.id, "CRM", true, [created.key.id]],
  );
});

test("creation applies the delivery URL rules and rejects malformed input", async () => {
  for (const url of [
    "http://hooks.example.test/in",
    "https://hooks.example.test:8443/in",
    "https://user:secret@hooks.example.test/in",
    "https://127.0.0.1/in",
    "https://2130706433/in",
    "https://[::1]/in",
    "https://localhost/in",
    "https://app.localhost/in",
    "https://printer.local/in",
    "https://metadata.google.internal/in",
    "hooks.example.test",
    42,
  ]) {
    const response = await request(adminId, "POST", "/api/webhooks/endpoints", { name: "crm", url });
    assert.equal(response.status, 400, String(url));
    assert.equal(await errorOf(response), "invalid_webhook_url", String(url));
  }
  for (const body of [
    {},
    { url: "https://hooks.example.test/in" },
    { name: "", url: "https://hooks.example.test/in" },
    { name: "a".repeat(61), url: "https://hooks.example.test/in" },
    { name: "crm", url: "https://hooks.example.test/in", secret: "mine" },
  ]) {
    const response = await request(adminId, "POST", "/api/webhooks/endpoints", body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(await errorOf(response), "invalid_webhook_endpoint", JSON.stringify(body));
  }
  // Without the encryption key no endpoint is stored, because its secret could not be sealed.
  const { TOKEN_ENCRYPTION_KEY: _key, ...withoutKey } = apiEnv;
  const unavailable = await request(
    adminId,
    "POST",
    "/api/webhooks/endpoints",
    { name: "crm", url: "https://hooks.example.test/in" },
    { env: withoutKey },
  );
  assert.equal(unavailable.status, 503);
  assert.equal(await errorOf(unavailable), "webhooks_unavailable");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM webhook_endpoints")).rows[0].count, 0);
});

test("a workspace has a small limit of active endpoints", async () => {
  assert.equal(MAX_ACTIVE_WEBHOOK_ENDPOINTS, 5);
  const created: Created[] = [];
  for (let index = 0; index < 5; index++)
    created.push(await createEndpoint(`hook ${index}`, `https://hook${index}.example.test/in`));
  const over = await request(adminId, "POST", "/api/webhooks/endpoints", {
    name: "sixth",
    url: "https://sixth.example.test/in",
  });
  assert.equal(over.status, 409);
  assert.equal(await errorOf(over), "webhook_endpoint_limit_reached");
  // Another workspace has its own limit.
  await createEndpoint("theirs", "https://theirs.example.test/in", outsiderId);

  const disabled = await request(adminId, "POST", `/api/webhooks/endpoints/${created[0]!.id}/disable`);
  assert.deepEqual(await disabled.json(), { active: false });
  await createEndpoint("sixth", "https://sixth.example.test/in");
  const enable = await request(adminId, "POST", `/api/webhooks/endpoints/${created[0]!.id}/enable`);
  assert.equal(enable.status, 409);
  assert.equal(await errorOf(enable), "webhook_endpoint_limit_reached");
  // Enabling an endpoint that is already active is not counted against the limit.
  assert.equal((await request(adminId, "POST", `/api/webhooks/endpoints/${created[1]!.id}/enable`)).status, 200);
  assert.equal((await request(adminId, "POST", `/api/webhooks/endpoints/${missingId}/enable`)).status, 404);
  assert.equal((await request(adminId, "POST", `/api/webhooks/endpoints/${missingId}/disable`)).status, 404);
});

test("rotation adds a second valid key, is refused while two are valid, and retiring removes the older secret", async () => {
  const endpoint = await createEndpoint();
  const rotate = () => request(adminId, "POST", `/api/webhooks/endpoints/${endpoint.id}/rotate`);
  const retire = () => request(adminId, "POST", `/api/webhooks/endpoints/${endpoint.id}/retire`);
  // The only valid key cannot be retired.
  const early = await retire();
  assert.equal(early.status, 409);
  assert.equal(await errorOf(early), "webhook_key_required");

  const rotated = await rotate();
  assert.equal(rotated.status, 201);
  const second = ((await rotated.json()) as { key: { id: string; secret: string } }).key;
  assert.match(second.secret, /^whsec_/);
  assert.notEqual(second.secret, endpoint.key.secret);
  const refused = await rotate();
  assert.equal(refused.status, 409);
  assert.equal(await errorOf(refused), "webhook_rotation_in_progress");
  // The database allows no third valid key either.
  await assert.rejects(
    pool.query(
      "INSERT INTO webhook_signing_keys(id,workspace_id,endpoint_id,slot,secret_encrypted) VALUES(gen_random_uuid(),$1,$2,1,'x')",
      [workspaceId, endpoint.id],
    ),
    { code: "23505" },
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO webhook_signing_keys(id,workspace_id,endpoint_id,slot,secret_encrypted) VALUES(gen_random_uuid(),$1,$2,3,'x')",
      [workspaceId, endpoint.id],
    ),
    { code: "23514" },
  );

  const retired = await retire();
  assert.deepEqual(await retired.json(), { retired_key_id: endpoint.key.id, key_id: second.id });
  const keys = (
    await pool.query(
      "SELECT id::text,retired_at IS NOT NULL AS retired,secret_encrypted IS NULL AS removed FROM webhook_signing_keys ORDER BY created_at",
    )
  ).rows;
  assert.deepEqual(keys, [
    { id: endpoint.key.id, retired: true, removed: true },
    { id: second.id, retired: false, removed: false },
  ]);
  const listed = (await (await request(adminId, "GET", "/api/webhooks/endpoints")).json()) as {
    endpoints: { keys: { id: string }[] }[];
  };
  assert.deepEqual(
    listed.endpoints[0]!.keys.map((key) => key.id),
    [second.id],
  );
  // A later rotation works again and returns a new secret.
  const again = await rotate();
  assert.equal(again.status, 201);
  assert.equal((await request(adminId, "POST", `/api/webhooks/endpoints/${missingId}/rotate`)).status, 404);
});

test("a draft saves any webhook config and publishing checks the endpoint and the fields", async () => {
  const endpoint = await createEndpoint();
  const foreign = await createEndpoint("theirs", "https://theirs.example.test/in", outsiderId);
  const publish = async (config: unknown) => {
    const id = await draftFlow(chain([{ id: "notify", type: "webhook", config }]));
    return request(adminId, "POST", `/api/flows/${id}/publish`, { expected_revision: 0 });
  };
  const codes = async (response: Response) =>
    ((await response.json()) as { errors: { code: string }[] }).errors.map((error) => error.code);

  // Shape only at draft save: this config would not publish.
  await draftFlow(chain([{ id: "notify", type: "webhook", config: { endpoint_id: "later" } }]));
  const invalid = await publish({ endpoint_id: "later" });
  assert.equal(invalid.status, 422);
  assert.deepEqual(await codes(invalid), ["invalid_config"]);

  const ok = { endpoint_id: endpoint.id, field_ids: [cityField], include_tags: true };
  assert.deepEqual(await codes(await publish({ ...ok, endpoint_id: missingId })), ["endpoint_unavailable"]);
  assert.deepEqual(await codes(await publish({ ...ok, endpoint_id: foreign.id })), ["endpoint_unavailable"]);
  assert.deepEqual(await codes(await publish({ ...ok, field_ids: [cityField, missingId] })), ["unknown_field"]);

  await pool.query("UPDATE webhook_endpoints SET active=false WHERE id=$1", [endpoint.id]);
  assert.deepEqual(await codes(await publish(ok)), ["endpoint_unavailable"]);
  await pool.query("UPDATE webhook_endpoints SET active=true WHERE id=$1", [endpoint.id]);
  await pool.query("UPDATE instagram_contact_fields SET archived=true WHERE id=$1", [tierField]);
  assert.deepEqual(await codes(await publish({ ...ok, field_ids: [tierField] })), ["unknown_field"]);

  assert.equal((await publish(ok)).status, 201);
  assert.deepEqual((await pool.query("SELECT field_ids::text[] AS field_ids FROM flow_versions")).rows, [
    { field_ids: [cityField] },
  ]);
});

test("a field that a published webhook node sends cannot be archived", async () => {
  const endpoint = await createEndpoint();
  const flow = await enabledFlow(chain([hook("notify", endpoint.id, [cityField])]));
  const blocked = await request(adminId, "DELETE", `/api/contact-fields/${cityField}`);
  assert.equal(blocked.status, 409);
  assert.equal(await errorOf(blocked), "field_in_use");
  // A field no webhook node names is not held.
  assert.equal((await request(adminId, "DELETE", `/api/contact-fields/${tierField}`)).status, 200);
  assert.equal((await request(adminId, "DELETE", `/api/flows/${flow}`)).status, 200);
  assert.equal((await request(adminId, "DELETE", `/api/contact-fields/${cityField}`)).status, 200);
});

test("a run queues one delivery per webhook node with the facts at that node and continues without waiting", async () => {
  const endpoint = await createEndpoint();
  const flow = await enabledFlow(
    chain([
      hook("before", endpoint.id, [cityField], true),
      { id: "lead", type: "add_tag", config: { tag: "lead" } },
      { id: "move", type: "set_field", config: { field_id: cityField, value: "Busan" } },
      hook("after", endpoint.id, [cityField, tierField], false),
      { id: "reply", type: "instagram_message", config: { text: "Thanks" } },
    ]),
  );
  await contact(senderId, ["vip"], "Seoul");
  await comment("comment-IG-SENTINEL");
  // The whole path ran in the ingestion transaction; no delivery was attempted yet.
  assert.deepEqual(await stepsOf(flow), [
    ["start:next", "before:queued", "lead:added", "move:set", "after:queued", "reply:queued"],
  ]);
  assert.deepEqual((await pool.query("SELECT status FROM private_reply_outbox")).rows, [{ status: "pending" }]);
  const queued = await deliveries();
  assert.deepEqual(
    queued.map((delivery) => [delivery.node_id, delivery.status, delivery.attempt_count, delivery.sender_id]),
    [
      ["before", "pending", 0, senderId],
      ["after", "pending", 0, senderId],
    ],
  );
  const run = (await pool.query("SELECT id::text,flow_id::text FROM flow_runs")).rows[0];
  const [before, afterActions] = queued.map((delivery) => delivery.payload!);
  assert.deepEqual(Object.keys(before!).sort(), [
    "created_at",
    "event_id",
    "fields",
    "flow_id",
    "flow_version",
    "node_id",
    "run_id",
    "tags",
    "type",
  ]);
  const { created_at: createdAt, ...identifiers } = before!;
  assert.ok(Math.abs(Date.parse(String(createdAt)) - Date.now()) < 60_000, String(createdAt));
  assert.deepEqual(identifiers, {
    event_id: queued[0]!.event_id,
    type: "flow.webhook",
    flow_id: flow,
    flow_version: 1,
    run_id: run.id,
    node_id: "before",
    tags: ["vip"],
    fields: { [cityField]: "Seoul" },
  });
  // The second node sees the actions before it, sends no tags, and an unset field is null.
  assert.equal("tags" in afterActions!, false);
  assert.deepEqual(afterActions!.fields, { [cityField]: "Busan", [tierField]: null });
  assert.equal(afterActions!.event_id, queued[1]!.event_id);
  assert.notEqual(queued[0]!.event_id, queued[1]!.event_id);

  // No comment text, DM text, username or Instagram identifier is in any payload.
  const text = JSON.stringify(queued.map((delivery) => delivery.payload));
  for (const forbidden of [
    "COMMENT-TEXT-SENTINEL",
    commentText,
    "comment-IG-SENTINEL",
    senderId,
    accountId,
    "username-IG-SENTINEL",
    mediaId,
    connectionId,
    workspaceId,
    "Thanks",
  ])
    assert.ok(!text.includes(forbidden), forbidden);

  // One delivery per run and node, also in the database.
  await assert.rejects(
    pool.query(
      `INSERT INTO webhook_deliveries(event_id,workspace_id,endpoint_id,connection_id,flow_id,flow_run_id,node_id,sender_id,payload)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,'before',$6,'{}')`,
      [workspaceId, endpoint.id, connectionId, flow, run.id, senderId],
    ),
    { code: "23505" },
  );
  // A replayed comment starts no second run and queues nothing more.
  await comment("comment-IG-SENTINEL");
  assert.equal((await deliveries()).length, 2);
});

test("a webhook node of a version that names another workspace's endpoint queues nothing and the run goes on", async () => {
  const endpoint = await createEndpoint();
  const foreign = await createEndpoint("theirs", "https://theirs.example.test/in", outsiderId);
  const flow = await enabledFlow(
    chain([hook("notify", endpoint.id), { id: "reply", type: "instagram_message", config: { text: "Thanks" } }]),
  );
  // Publishing refuses this; a stored version is changed directly to prove the insert is workspace-scoped.
  await pool.query("UPDATE flow_versions SET definition=replace(definition::text,$1,$2)::jsonb WHERE flow_id=$3", [
    endpoint.id,
    foreign.id,
    flow,
  ]);
  await comment("comment-1");
  assert.deepEqual(await deliveries(), []);
  assert.deepEqual(await stepsOf(flow), [["start:next", "notify:not_queued", "reply:queued"]]);
  assert.equal((await pool.query("SELECT status FROM flow_runs")).rows[0].status, "delivering");
});

test("a webhook node works after a delay, after a time wait and after a reply wait", async () => {
  const endpoint = await createEndpoint();
  const delayed = await enabledFlow(
    chain([{ id: "pause", type: "delay", config: { minutes: 5 } }, hook("notify", endpoint.id)], "1001"),
  );
  const timed = await enabledFlow(
    chain([{ id: "until", type: "wait_until", config: { time: "09:30" } }, hook("notify", endpoint.id)], "1002"),
  );
  await comment("comment-delay", "sender-delay", "1001");
  await comment("comment-until", "sender-until", "1002");
  assert.deepEqual(await deliveries(), []);
  await contact("sender-delay", ["late"]);
  await pool.query("UPDATE flow_runs SET resume_at=now()-interval '1 second' WHERE status='waiting'");
  assert.equal(await resumeDueFlowRuns(pool), 2);
  assert.deepEqual(await stepsOf(delayed), [["start:next", "pause:waiting", "notify:queued"]]);
  assert.deepEqual(await stepsOf(timed), [["start:next", "until:waiting", "notify:queued"]]);
  const resumed = await deliveries();
  assert.deepEqual(resumed.map((delivery) => [delivery.sender_id, delivery.payload!.tags]).sort(), [
    ["sender-delay", ["late"]],
    ["sender-until", []],
  ]);

  // start -> ask -> wait -(replied)-> answered tag -> webhook
  const asked = await enabledFlow({
    schema_version: 1,
    nodes: [
      trigger("1003"),
      { id: "ask", type: "instagram_message", config: { text: "Which size?" } },
      { id: "wait", type: "wait_for_reply", config: { timeout_minutes: 60 } },
      { id: "answered", type: "add_tag", config: { tag: "answered" } },
      hook("notify", endpoint.id),
    ],
    edges: [
      { from: "start", port: "next", to: "ask" },
      { from: "ask", port: "next", to: "wait" },
      { from: "wait", port: "replied", to: "answered" },
      { from: "answered", port: "next", to: "notify" },
    ],
  });
  await comment("comment-ask", "sender-ask", "1003");
  while (await processNextPrivateReply(pool, transport, () => new Date(), connectionId));
  assert.equal((await deliveries()).length, 2);
  await ingestMessages(pool, [
    {
      accountId,
      senderId: recipientId,
      messageId: "in-1",
      text: "DM-TEXT-SENTINEL",
      timestamp: new Date(Date.now() + 1000),
    },
  ]);
  assert.deepEqual(await stepsOf(asked), [
    ["start:next", "ask:queued", "wait:replied", "answered:added", "notify:queued"],
  ]);
  const answered = (await deliveries()).find((delivery) => delivery.sender_id === "sender-ask")!;
  assert.deepEqual(answered.payload!.tags, ["answered"]);
  const text = JSON.stringify(answered.payload);
  for (const forbidden of ["DM-TEXT-SENTINEL", recipientId, "sender-ask", "Which size?"])
    assert.ok(!text.includes(forbidden), forbidden);
});

// start -> ask -> wait -(replied)-> the given nodes in order
function asking(media: string, wait: Record<string, unknown>, after: { id: string; type: string; config: unknown }[]) {
  return {
    schema_version: 1,
    nodes: [
      trigger(media),
      { id: "ask", type: "instagram_message", config: { text: "Which size?" } },
      { id: "wait", type: "wait_for_reply", config: wait },
      ...after,
    ],
    edges: [
      { from: "start", port: "next", to: "ask" },
      { from: "ask", port: "next", to: "wait" },
      ...after.map((node, index) =>
        index
          ? { from: after[index - 1]!.id, port: "next", to: node.id }
          : { from: "wait", port: "replied", to: node.id },
      ),
    ],
  };
}

test("publishing refuses to send a field that a reply wait saves a reply into", async () => {
  const endpoint = await createEndpoint();
  const publish = async (draft: unknown) => {
    const id = await draftFlow(draft);
    const response = await request(adminId, "POST", `/api/flows/${id}/publish`, { expected_revision: 0 });
    const body = (await response.json()) as { errors?: { code: string; node_id?: string }[] };
    return {
      id,
      status: response.status,
      errors: (body.errors ?? []).map((error) => `${error.node_id}:${error.code}`),
    };
  };
  const saving = (field: string) => ({ timeout_minutes: 60, save_field_id: field });
  // In one draft.
  const same = await publish(asking("1001", saving(cityField), [hook("notify", endpoint.id, [cityField])]));
  assert.deepEqual([same.status, same.errors], [422, ["notify:reply_field_not_sendable"]]);
  // Across flows: one flow saves the reply, and another may not send that field.
  const saver = await publish(asking("1002", saving(cityField), []));
  assert.equal(saver.status, 201);
  const sender = await publish(chain([hook("notify", endpoint.id, [tierField, cityField])], "1003"));
  assert.deepEqual([sender.status, sender.errors], [422, ["notify:reply_field_not_sendable"]]);
  // The replies it stored stay in the field after the saving flow is archived, so the field is still refused.
  assert.equal((await request(adminId, "DELETE", `/api/flows/${saver.id}`)).status, 200);
  const later = await publish(chain([hook("notify", endpoint.id, [cityField])], "1003"));
  assert.deepEqual([later.status, later.errors], [422, ["notify:reply_field_not_sendable"]]);
  // The other direction: a field that a published webhook node sends cannot become a reply field.
  assert.equal((await publish(chain([hook("notify", endpoint.id, [tierField])], "1004"))).status, 201);
  const reverse = await publish(asking("1005", saving(tierField), []));
  assert.deepEqual([reverse.status, reverse.errors], [422, ["wait:reply_field_not_sendable"]]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM flow_versions")).rows[0].count, 2);
});

test("a stored version that names a reply field sends its payload without that field", async () => {
  const endpoint = await createEndpoint();
  const fieldsOf = async (sender: string, node = "notify") =>
    (await deliveries())
      .filter((delivery) => delivery.sender_id === sender && delivery.node_id === node)
      .map((delivery) => delivery.payload!.fields);
  // Publishing refuses these shapes, so the stored versions are changed directly, which is what two
  // publishes that passed the check at the same time leave behind.
  const asked = await enabledFlow(
    asking("1001", { timeout_minutes: 60 }, [hook("notify", endpoint.id, [cityField, tierField], false)]),
  );
  await pool.query(
    "UPDATE flow_versions SET definition=jsonb_set(definition,'{nodes,2,config,save_field_id}',to_jsonb($2::text)) WHERE flow_id=$1",
    [asked, cityField],
  );
  await comment("comment-ask", "sender-ask", "1001");
  while (await processNextPrivateReply(pool, transport, () => new Date(), connectionId));
  await ingestMessages(pool, [
    {
      accountId,
      senderId: recipientId,
      messageId: "in-1",
      text: "DM-TEXT-SENTINEL",
      timestamp: new Date(Date.now() + 1000),
    },
  ]);
  assert.deepEqual(await stepsOf(asked), [["start:next", "ask:queued", "wait:replied", "wait:set", "notify:queued"]]);
  // The reply is stored in the field, and the node right after the wait sends everything but that field.
  assert.deepEqual(
    (await pool.query("SELECT sender_id,value FROM instagram_contact_field_values WHERE field_id=$1", [cityField]))
      .rows,
    [{ sender_id: "sender-ask", value: "DM-TEXT-SENTINEL" }],
  );
  assert.deepEqual(await fieldsOf("sender-ask"), [{ [tierField]: null }]);

  // Other flows' versions name the field the first flow saved the reply into: at the start of a run and
  // after a delay.
  const other = await enabledFlow(chain([hook("other", endpoint.id, [tierField], false)], "1002"));
  const delayed = await enabledFlow(
    chain(
      [{ id: "pause", type: "delay", config: { minutes: 5 } }, hook("late", endpoint.id, [tierField], false)],
      "1003",
    ),
  );
  await pool.query(
    "UPDATE flow_versions SET definition=replace(definition::text,$2,$3)::jsonb,field_ids=ARRAY[$3::uuid] WHERE flow_id=ANY($1::uuid[])",
    [[other, delayed], tierField, cityField],
  );
  await comment("comment-other", "sender-ask", "1002");
  assert.deepEqual(await fieldsOf("sender-ask", "other"), [{}]);
  await comment("comment-late", "sender-ask", "1003");
  await pool.query("UPDATE flow_runs SET resume_at=now()-interval '1 second' WHERE status='waiting'");
  assert.equal(await resumeDueFlowRuns(pool), 1);
  assert.deepEqual(await fieldsOf("sender-ask", "late"), [{}]);
  // Archiving the saving flow keeps its versions and the stored reply, so the field is still left out.
  assert.equal((await request(adminId, "DELETE", `/api/flows/${asked}`)).status, 200);
  await comment("comment-other-2", "sender-ask", "1002");
  assert.deepEqual(await fieldsOf("sender-ask", "other"), [{}, {}]);
  assert.equal((await deliveries()).length, 4);
  assert.ok(!JSON.stringify(await deliveries()).includes("DM-TEXT-SENTINEL"));
  // A field no reply wait saves into is sent as before.
  await pool.query(
    "UPDATE flow_versions SET definition=replace(definition::text,$2,$3)::jsonb,field_ids=ARRAY[$3::uuid] WHERE flow_id=$1",
    [other, cityField, tierField],
  );
  await comment("comment-other-3", "sender-ask", "1002");
  assert.deepEqual((await fieldsOf("sender-ask", "other"))[2], { [tierField]: null });
});

test("without the encryption key an admin gets 503 for a new secret and an agent is still refused by role", async () => {
  const endpoint = await createEndpoint();
  const { TOKEN_ENCRYPTION_KEY: _key, ...withoutKey } = apiEnv;
  const routes: [string, unknown?][] = [
    ["/api/webhooks/endpoints", { name: "second", url: "https://second.example.test/in" }],
    [`/api/webhooks/endpoints/${endpoint.id}/rotate`],
  ];
  for (const [path, body] of routes) {
    const admin = await request(adminId, "POST", path, body, { env: withoutKey });
    assert.equal(admin.status, 503, path);
    assert.equal(await errorOf(admin), "webhooks_unavailable", path);
    // The role is checked before the key, so an agent learns nothing about the configuration.
    const agent = await request(agentId, "POST", path, body, { env: withoutKey });
    assert.equal(agent.status, 403, path);
    assert.equal(await errorOf(agent), "role_forbidden", path);
  }
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM webhook_endpoints")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM webhook_signing_keys")).rows[0].count, 1);
});

test("a failing endpoint changes no private, follow or manual reply row and no later node of the run", async () => {
  const endpoint = await createEndpoint();
  const flow = await enabledFlow(
    chain([
      hook("notify", endpoint.id),
      { id: "lead", type: "add_tag", config: { tag: "lead" } },
      { id: "reply", type: "instagram_message", config: { text: "Thanks" } },
    ]),
  );
  await comment("comment-1");
  const reply = (await pool.query("SELECT id FROM private_reply_outbox")).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text,status)
     VALUES($1,$2,$3,'ok','yes','no','waiting')`,
    [reply, connectionId, recipientId],
  );
  // A manual reply needs a handoff row; this one has ended, so the contact is not paused.
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused,handoff_paused) VALUES($1,$2,$3,false,false)",
    [workspaceId, connectionId, senderId],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
     VALUES($1,$2,$3,$4,$5,false,2,$6)`,
    [workspaceId, connectionId, recipientId, senderId, reply, adminId],
  );
  await pool.query(
    `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,status)
     VALUES($1,$2,$3,gen_random_uuid(),$4,'manual text',1,'pending')`,
    [workspaceId, connectionId, recipientId, adminId],
  );
  const snapshot = async () =>
    (
      await pool.query(
        `SELECT
           (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM private_reply_outbox t) AS replies,
           (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.reply_id) FROM instagram_follow_conversations t) AS follows,
           (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM instagram_manual_replies t) AS manual,
           (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM flow_runs t) AS runs,
           (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.run_id,t.seq) FROM flow_step_runs t) AS steps,
           (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.sender_id) FROM instagram_contact_tags t) AS tags`,
      )
    ).rows[0];
  const before = await snapshot();
  assert.equal(before.replies.length + before.follows.length + before.manual.length, 3);
  // The run had already passed the webhook node and finished its later nodes.
  assert.deepEqual(await stepsOf(flow), [["start:next", "notify:queued", "lead:added", "reply:queued"]]);

  let requests = 0;
  const failing = (async () => {
    requests++;
    throw new Error("connection refused");
  }) as typeof fetch;
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.deepEqual(await deliver(failing), { attempted: 1, sent: 0 });
    await pool.query("UPDATE webhook_deliveries SET next_attempt_at=now()-interval '1 second' WHERE status='retry'");
  }
  assert.equal(requests, 6);
  const [dead] = await deliveries();
  assert.deepEqual([dead!.status, dead!.failure_code, dead!.attempt_count], ["dead", "request_failed", 6]);
  assert.deepEqual(await snapshot(), before);

  // The private reply is still sent as usual, and sending it attempts no webhook.
  assert.equal(await processNextPrivateReply(pool, transport, () => new Date(), connectionId), true);
  assert.equal((await pool.query("SELECT status FROM private_reply_outbox")).rows[0].status, "sent");
  assert.equal(requests, 6);
});

test("recent deliveries are listed without payload or sender, and only a dead one is redelivered", async () => {
  const endpoint = await createEndpoint();
  await enabledFlow(chain([hook("notify", endpoint.id, [cityField])]));
  await contact(senderId, ["vip"], "Seoul");
  await comment("comment-1");
  const [queued] = await deliveries();
  const list = async () =>
    (
      (await (await request(adminId, "GET", "/api/webhooks/deliveries")).json()) as {
        deliveries: Record<string, unknown>[];
      }
    ).deliveries;
  const listed = await list();
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]!).sort(), [
    "attempt_count",
    "created_at",
    "endpoint_id",
    "event_id",
    "failure_code",
    "flow_id",
    "flow_run_id",
    "last_status_code",
    "next_attempt_at",
    "node_id",
    "sent_at",
    "status",
  ]);
  const listedText = JSON.stringify(listed);
  for (const forbidden of ["Seoul", "vip", senderId, "payload"]) assert.ok(!listedText.includes(forbidden), forbidden);

  const redeliver = (id = queued!.event_id, actor = adminId) =>
    request(actor, "POST", `/api/webhooks/deliveries/${id}/redeliver`);
  const pending = await redeliver();
  assert.equal(pending.status, 409);
  assert.equal(await errorOf(pending), "webhook_delivery_not_dead");
  assert.equal((await redeliver(missingId)).status, 404);

  // Six failed attempts end the delivery as dead.
  const headers: (string | null)[] = [];
  const bodies: string[] = [];
  let status = 500;
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    headers.push(new Headers(init?.headers).get("x-autochatter-event-id"));
    bodies.push(String(init?.body));
    return new Response(null, { status });
  }) as typeof fetch;
  for (let attempt = 0; attempt < 6; attempt++) {
    await deliver(fetchImpl);
    await pool.query("UPDATE webhook_deliveries SET next_attempt_at=now()-interval '1 second' WHERE status='retry'");
  }
  assert.deepEqual([(await deliveries())[0]!.status, (await deliveries())[0]!.attempt_count], ["dead", 6]);

  // A disabled endpoint refuses the redelivery and writes no audit row.
  await request(adminId, "POST", `/api/webhooks/endpoints/${endpoint.id}/disable`);
  const inactive = await redeliver();
  assert.equal(inactive.status, 409);
  assert.equal(await errorOf(inactive), "webhook_endpoint_inactive");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM webhook_redelivery_events")).rows[0].count, 0);
  await request(adminId, "POST", `/api/webhooks/endpoints/${endpoint.id}/enable`);

  const accepted = await redeliver();
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { event_id: queued!.event_id, status: "pending" });
  const reset = (
    await pool.query(
      `SELECT event_id::text,status,attempt_count,failure_code,last_status_code,next_attempt_at<=now() AS due,payload
       FROM webhook_deliveries`,
    )
  ).rows;
  assert.deepEqual(reset, [
    {
      event_id: queued!.event_id,
      status: "pending",
      attempt_count: 0,
      failure_code: null,
      last_status_code: null,
      due: true,
      payload: queued!.payload,
    },
  ]);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT workspace_id::text,connection_id::text,delivery_event_id::text,actor_id::text FROM webhook_redelivery_events",
      )
    ).rows,
    [
      {
        workspace_id: workspaceId,
        connection_id: connectionId,
        delivery_event_id: queued!.event_id,
        actor_id: adminId,
      },
    ],
  );
  // The redelivery is a pending delivery again, so a second request is refused until it is dead again.
  assert.equal((await redeliver()).status, 409);

  status = 200;
  assert.deepEqual(await deliver(fetchImpl), { attempted: 1, sent: 1 });
  // Every attempt, before and after the manual redelivery, carried the same event ID and body.
  assert.deepEqual([...new Set(headers)], [queued!.event_id]);
  assert.equal(headers.length, 7);
  assert.deepEqual(
    [...new Set(bodies)].map((body) => JSON.parse(body)),
    [queued!.payload],
  );
  const sent = await deliveries();
  assert.deepEqual([sent[0]!.status, sent[0]!.payload, sent[0]!.attempt_count], ["sent", null, 1]);
  const done = await redeliver();
  assert.equal(done.status, 409);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM webhook_redelivery_events")).rows[0].count, 1);
});

// Two commenters with one delivery each, the first redelivered once so it has an audit row.
async function deliveredPeople() {
  const endpoint = await createEndpoint();
  await enabledFlow(chain([hook("notify", endpoint.id)]));
  await comment("comment-a", "sender-a");
  await comment("comment-b", "sender-b");
  await pool.query("UPDATE webhook_deliveries SET status='dead',attempt_count=6,failure_code='http_error'");
  const first = (await deliveries()).find((delivery) => delivery.sender_id === "sender-a")!;
  assert.equal((await request(adminId, "POST", `/api/webhooks/deliveries/${first.event_id}/redeliver`)).status, 200);
  return { endpoint, first };
}

function sending(sender: string) {
  return pool.query(
    "UPDATE webhook_deliveries SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE sender_id=$1",
    [sender],
  );
}

async function webhookCounts() {
  return (
    await pool.query(
      `SELECT (SELECT count(*)::int FROM webhook_endpoints WHERE workspace_id=$1) AS endpoints,
         (SELECT count(*)::int FROM webhook_signing_keys WHERE workspace_id=$1) AS keys,
         (SELECT count(*)::int FROM webhook_deliveries WHERE workspace_id=$1) AS deliveries,
         (SELECT count(*)::int FROM webhook_redelivery_events WHERE workspace_id=$1) AS audit`,
      [workspaceId],
    )
  ).rows[0];
}

test("person deletion removes that person's deliveries and their audit, and refuses while one is sending", async () => {
  await deliveredPeople();
  const deletePerson = (sender: string) =>
    pool.query<{ result: { deleted_counts: Record<string, number> } }>(
      "SELECT public.delete_person_data($1,$2,$3,'comment_sender',$4) AS result",
      [workspaceId, connectionId, ownerId, sender],
    );
  await sending("sender-a");
  await assert.rejects(deletePerson("sender-a"), { code: "AC003" });
  assert.deepEqual(await webhookCounts(), { endpoints: 1, keys: 1, deliveries: 2, audit: 1 });
  // Another person's deletion is not held by it.
  const other = (await deletePerson("sender-b")).rows[0]!.result;
  assert.equal(other.deleted_counts.webhook_deliveries, 1);
  assert.equal(other.deleted_counts.webhook_redelivery_events, 0);
  assert.equal(other.deleted_counts.flow_runs, 1);
  assert.deepEqual(await webhookCounts(), { endpoints: 1, keys: 1, deliveries: 1, audit: 1 });

  await pool.query("UPDATE webhook_deliveries SET status='retry',attempt_id=NULL WHERE sender_id='sender-a'");
  const { result } = (await deletePerson("sender-a")).rows[0]!;
  assert.equal(result.deleted_counts.webhook_deliveries, 1);
  assert.equal(result.deleted_counts.webhook_redelivery_events, 1);
  assert.equal(result.deleted_counts.flow_runs, 1);
  assert.equal(result.deleted_counts.instagram_comment_events, 1);
  assert.deepEqual(await webhookCounts(), { endpoints: 1, keys: 1, deliveries: 0, audit: 0 });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM flow_runs")).rows[0].count, 0);
});

test("connection deletion removes its deliveries and their audit, keeps the endpoints, and refuses while one is sending", async () => {
  await deliveredPeople();
  await pool.query(
    "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
    [connectionId],
  );
  const deleteConnection = () =>
    request(adminId, "POST", `/api/connections/${connectionId}/data-deletion`, { confirm_account_id: accountId });
  await sending("sender-b");
  const refused = await deleteConnection();
  assert.equal(refused.status, 409);
  assert.equal(await errorOf(refused), "sending_in_progress");
  assert.deepEqual(await webhookCounts(), { endpoints: 1, keys: 1, deliveries: 2, audit: 1 });

  await pool.query("UPDATE webhook_deliveries SET status='retry',attempt_id=NULL WHERE sender_id='sender-b'");
  const deleted = await deleteConnection();
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const { deleted_counts: counts } = (await deleted.json()) as { deleted_counts: Record<string, number> };
  assert.equal(counts.webhook_deliveries, 2);
  assert.equal(counts.webhook_redelivery_events, 1);
  assert.equal(counts.flow_runs, 2);
  // The endpoint and its key are workspace configuration and stay.
  assert.deepEqual(await webhookCounts(), { endpoints: 1, keys: 1, deliveries: 0, audit: 0 });
});

test("workspace deletion removes endpoints, keys, deliveries and audit, and refuses while a delivery is sending", async () => {
  await deliveredPeople();
  const theirs = await createEndpoint("theirs", "https://theirs.example.test/in", outsiderId);
  await pool.query(
    "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
    [connectionId],
  );
  const deleteWorkspace = () =>
    pool.query<{ result: { deleted_counts: Record<string, number> } }>(
      "SELECT public.delete_workspace_data($1,$2) AS result",
      [workspaceId, ownerId],
    );
  await sending("sender-a");
  await assert.rejects(deleteWorkspace(), { code: "AC003" });
  assert.deepEqual(await webhookCounts(), { endpoints: 1, keys: 1, deliveries: 2, audit: 1 });

  await pool.query("UPDATE webhook_deliveries SET status='retry',attempt_id=NULL WHERE sender_id='sender-a'");
  const { result } = (await deleteWorkspace()).rows[0]!;
  assert.equal(result.deleted_counts.webhook_endpoints, 1);
  assert.equal(result.deleted_counts.webhook_signing_keys, 1);
  assert.equal(result.deleted_counts.webhook_deliveries, 2);
  assert.equal(result.deleted_counts.webhook_redelivery_events, 1);
  assert.deepEqual(await webhookCounts(), { endpoints: 0, keys: 0, deliveries: 0, audit: 0 });
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM workspaces WHERE id=$1", [workspaceId])).rows[0].count,
    0,
  );
  // The other workspace keeps its endpoint and key.
  assert.deepEqual(
    (
      await pool.query(
        `SELECT (SELECT count(*)::int FROM webhook_endpoints WHERE id=$1) AS endpoints,
           (SELECT count(*)::int FROM webhook_signing_keys WHERE endpoint_id=$1) AS keys`,
        [theirs.id],
      )
    ).rows[0],
    { endpoints: 1, keys: 1 },
  );
});

test("a deletion waits for an uncommitted webhook claim and refuses once it commits as sending", async () => {
  await deliveredPeople();
  await pool.query(
    "UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1",
    [connectionId],
  );
  const claim = await pool.connect();
  try {
    await claim.query("BEGIN");
    await claim.query(
      "UPDATE webhook_deliveries SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE sender_id='sender-a'",
    );
    // The row is held by the claim, so the connection and workspace deletions refuse instead of waiting.
    const connection = await request(adminId, "POST", `/api/connections/${connectionId}/data-deletion`, {
      confirm_account_id: accountId,
    });
    assert.equal(await errorOf(connection), "sending_in_progress");
    await assert.rejects(pool.query("SELECT public.delete_workspace_data($1,$2)", [workspaceId, ownerId]), {
      code: "AC003",
    });
    // Person deletion waits for the claim and then sees it as sending.
    const person = pool
      .query("SELECT public.delete_person_data($1,$2,$3,'comment_sender','sender-a')", [
        workspaceId,
        connectionId,
        ownerId,
      ])
      .then(
        () => "deleted",
        (error: { code?: string }) => error.code,
      );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await claim.query("COMMIT");
    assert.equal(await person, "AC003");
  } finally {
    claim.release();
  }
  assert.deepEqual(await webhookCounts(), { endpoints: 1, keys: 1, deliveries: 2, audit: 1 });
});

test("migration 031 replays and, with the later migrations, leaves the deletion functions as the current schema defines them", async () => {
  const functions = async () =>
    (
      await pool.query(
        `SELECT proname,pg_get_functiondef(oid) AS body,prosecdef FROM pg_proc
         WHERE pronamespace='public'::regnamespace AND proname IN ('delete_connection_data','delete_person_data','delete_workspace_data')
         ORDER BY proname`,
      )
    ).rows;
  // Other test files replay older migrations, so the current bodies are loaded first.
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  const current = await functions();
  assert.equal(current.length, 3);
  for (const { proname, body } of current) assert.match(body, /webhook_deliveries/, proname);
  const migration = await readFile(new URL("../../db/migrations/031_flow_webhooks.sql", import.meta.url), "utf8");
  // Migrations 032 to 035 redefine the same functions after 031, in the order deploy/migrate-multi-user.sql runs them.
  const later = await Promise.all(
    [
      "032_inbox_read_state.sql",
      "033_inbox_labels_notes.sql",
      "034_inbox_reminders.sql",
      "035_inbox_label_rules.sql",
    ].map((file) => readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8")),
  );
  await deliveredPeople();
  for (let run = 0; run < 2; run++) {
    await pool.query(migration);
    for (const sql of later) await pool.query(sql);
  }
  assert.deepEqual(await functions(), current);
  assert.deepEqual(await webhookCounts(), { endpoints: 1, keys: 1, deliveries: 2, audit: 1 });

  // The delivery states the migration allows.
  const invalid = [
    "status='waiting'",
    "status='sent'",
    "payload=NULL",
    "status='sending'",
    "failure_code='Not A Code'",
    "last_status_code=42",
    "node_id='not a node'",
  ];
  for (const change of invalid)
    await assert.rejects(pool.query(`UPDATE webhook_deliveries SET ${change}`), { code: "23514" }, change);
  await assert.rejects(pool.query("UPDATE webhook_endpoints SET url='http://hooks.example.test/in'"), {
    code: "23514",
  });
  await assert.rejects(pool.query("UPDATE webhook_signing_keys SET secret_encrypted=NULL"), { code: "23514" });
  // A delivery cannot point at another workspace's endpoint.
  const theirs = await createEndpoint("theirs", "https://theirs.example.test/in", outsiderId);
  await assert.rejects(pool.query("UPDATE webhook_deliveries SET endpoint_id=$1", [theirs.id]), { code: "23503" });
});
