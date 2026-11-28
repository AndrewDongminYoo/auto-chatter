import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { EXCLUDED_TABLES, EXPORTED_TABLES } from "./workspace-export.ts";
import { exceedActiveContactLimit } from "./workspace-fixture.ts";
import { publicApi } from "./public-api.ts";
import { resetTestSchema } from "../test-schema.ts";
import { recordChannelConsentEvent } from "../instagram/channel-consent.ts";
import { assertDmFlowDeliveryAllowed, processNextDmFlowDelivery } from "../instagram/dm-flow-delivery-worker.ts";
import { InstagramFollowTransport } from "../instagram/follow-transport.ts";
import { DM_START_HOURLY_LIMIT, dmStartSkipCodeSql } from "../instagram/send-quota.ts";

// POST /v1/flows/{flow_id}/starts and GET /v1/flows against the schema (#48,
// docs/specs/2026-11-28-public-flow-start-design.md). Graph is mocked through fetchImpl; nothing here reaches Meta.

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const W = "11111111-1111-4111-8111-111111111111";
const OTHER_W = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const SECOND_C = "44444444-4444-4444-8444-444444444444";
const FOREIGN_C = "55555555-5555-4555-8555-555555555555";
const admin = "66666666-6666-4666-8666-666666666666";
const outsider = "77777777-7777-4777-8777-777777777777";
const TOKEN = "CIPHERTEXT";
const SENDER = "sender/1 %";
const RECIPIENT = "9001";
const allow = { limit: async () => ({ success: true }) };
const keys = { starter: `ac_live_${"s".repeat(43)}`, writer: `ac_live_${"w".repeat(43)}`, foreign: `ac_live_${"f".repeat(43)}` };
let sequence = 0;
let wakes: string[] = [];

before(async () => resetTestSchema(pool));
beforeEach(async () => {
  sequence = 0;
  wakes = [];
  // The ledger has no foreign keys, so the workspace cascade leaves it alone.
  await pool.query("TRUNCATE workspaces,workspace_deletion_records,active_contacts CASCADE");
  await pool.query("INSERT INTO workspaces(id,time_zone,plan) VALUES($1,'UTC','advanced'),($2,'UTC','advanced')", [W, OTHER_W]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [W, admin, OTHER_W, outsider]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,inbox_enabled,inbox_enabled_at,active,send_enabled,access_token_encrypted,token_expires_at)
     VALUES($1,$4,'100',true,now()-interval '1 day',true,true,$6,now()+interval '30 days'),
       ($2,$4,'200',true,now()-interval '1 day',true,true,$6,now()+interval '30 days'),
       ($3,$5,'300',true,now()-interval '1 day',true,true,$6,now()+interval '30 days')`,
    [C, SECOND_C, FOREIGN_C, W, OTHER_W, TOKEN],
  );
  for (const [workspace, name, key, scopes, creator] of [
    [W, "starter", keys.starter, ["contacts:read", "flows:start"], admin],
    [W, "writer", keys.writer, ["contacts:read", "contacts:write"], admin],
    [OTHER_W, "foreign", keys.foreign, ["contacts:read", "contacts:write", "flows:start"], outsider],
  ] as const)
    await pool.query(
      `INSERT INTO api_keys(workspace_id,name,key_prefix,key_hash,scopes,created_by,expires_at)
       VALUES($1,$2,$3,$4,$5::text[],$6,now()+interval '30 days')`,
      [workspace, name, key.slice(0, 12), createHash("sha256").update(key).digest("hex"), scopes, creator],
    );
});
after(async () => pool.end());

function dmDocument(connection: string, trigger = "instagram_dm_default", text = "Thanks for your order") {
  return {
    schema_version: 1,
    nodes: [
      { id: "start", type: trigger, config: trigger === "instagram_dm_default" ? { connection_id: connection } : { connection_id: connection, keywords: ["order"], match_mode: "contains", excluded_keywords: [] } },
      { id: "reply", type: "instagram_message", config: { text } },
    ],
    edges: [{ from: "start", port: "next", to: "reply" }],
  };
}

// One flow with a published version, enabled unless told otherwise.
async function flow(options: { workspace?: string; connection?: string; trigger?: string; enabled?: boolean; definition?: unknown; name?: string } = {}): Promise<string> {
  const workspace = options.workspace ?? W;
  const connection = options.connection ?? C;
  const trigger = options.trigger ?? "instagram_dm_default";
  const id = (await pool.query("INSERT INTO flows(workspace_id,name,draft) VALUES($1,$2,'{}') RETURNING id::text", [workspace, options.name ?? `Flow ${++sequence}`])).rows[0].id;
  const version = (
    await pool.query(
      `INSERT INTO flow_versions(flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_type,trigger_media_id,published_by)
       VALUES($1,$2,1,0,$3::jsonb,$4,$5,$6,$7) RETURNING id::text`,
      [id, workspace, JSON.stringify(options.definition ?? dmDocument(connection, trigger)), connection, trigger, trigger === "instagram_comment" ? "1789" : null, workspace === W ? admin : outsider],
    )
  ).rows[0].id;
  await pool.query("UPDATE flows SET published_version_id=$2,enabled=$3 WHERE id=$1", [id, version, options.enabled ?? true]);
  return id;
}

async function consent(kind: "comment_sender" | "dm_recipient", value: string, purpose: "marketing" | "service_reply", decision: "grant" | "revoke", connection = C) {
  await recordChannelConsentEvent(pool, {
    requestKey: randomUUID(),
    workspaceId: W,
    connectionId: connection,
    channel: "instagram",
    identityKind: kind,
    identityValue: value,
    purpose,
    decision,
    evidenceKind: "explicit",
    evidenceReference: "test",
    occurredAt: new Date(),
    actorId: admin,
  });
}

// A comment of `sender` and a provider-acknowledged private reply to it that reached `recipient`: the verified bridge.
async function bridge(sender: string, recipient: string, connection = C) {
  sequence++;
  const event = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,$3,$4,'COMMENT') RETURNING id::text,comment_id,media_id`,
      [W, connection, `comment-${sequence}`, sender],
    )
  ).rows[0];
  const rule = (
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text)
       VALUES(gen_random_uuid(),$1,$2,$3,'hello','REPLY') RETURNING id`,
      [W, connection, event.media_id],
    )
  ).rows[0].id;
  return (
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,
         private_reply_text,recipient_id,status,provider_message_id,sent_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'REPLY',$8,'sent','acknowledged',now()-interval '2 hours') RETURNING id::text`,
      [W, connection, event.id, rule, event.comment_id, event.media_id, sender, recipient],
    )
  ).rows[0].id as string;
}
async function inboxDm(recipient: string, age = "1 hour", connection = C) {
  sequence++;
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at,received_at)
     VALUES($1,$2,$3,$4,'DM','text',now()-$5::interval,now()-$5::interval)`,
    [W, connection, recipient, `dm-${sequence}`, age],
  );
}
// A bridged recipient with a text DM an hour ago and an explicit marketing grant: it passes every recipient check.
async function qualifying(sender = SENDER, recipient = RECIPIENT, age = "1 hour") {
  await bridge(sender, recipient);
  await inboxDm(recipient, age);
  await consent("dm_recipient", recipient, "marketing", "grant");
}

type StartBody = { request_key: string; connection_id: string; sender_id: string };
function startBody(overrides: Partial<StartBody> = {}): StartBody {
  return { request_key: randomUUID(), connection_id: C, sender_id: SENDER, ...overrides };
}
const sharedPool = () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool;
function start(flowId: string, body: unknown, options: { key?: string; enabled?: boolean; workspaceLimit?: { limit: () => Promise<{ success: boolean }> } } = {}) {
  return publicApi(
    new Request(`https://app.test/v1/flows/${flowId}/starts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.key ?? keys.starter}`, "CF-Connecting-IP": "203.0.113.7", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { API_IP_LIMIT: allow, API_KEY_LIMIT: allow, API_WRITE_WORKSPACE_LIMIT: options.workspaceLimit ?? allow },
    sharedPool,
    "corr-flow",
    {
      enabled: options.enabled ?? true,
      wake: async (connection) => {
        wakes.push(connection);
      },
    },
  );
}
async function accepted(flowId: string, body: unknown, options: Parameters<typeof start>[2] = {}) {
  const response = await start(flowId, body, options);
  const text = await response.text();
  assert.equal(response.status, 202, text);
  return JSON.parse(text) as { start_id: string; run_id: string; status: string };
}
async function refused(flowId: string, body: unknown, status: number, code: string, options: Parameters<typeof start>[2] = {}) {
  const response = await start(flowId, body, options);
  assert.equal(response.status, status, `${code}: ${await response.clone().text()}`);
  assert.deepEqual(await response.json(), { error: code });
}
const count = async (table: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
async function written() {
  return { keys: await count("flow_api_start_keys"), starts: await count("flow_api_starts"), runs: await count("flow_runs WHERE api_start_id IS NOT NULL"), deliveries: await count("flow_dm_deliveries"), steps: await count("flow_step_runs") };
}
const nothing = { keys: 0, starts: 0, runs: 0, deliveries: 0, steps: 0 };

test("a start writes the key, the start, a delivering run pinned to the version, its first message and its step, and wakes the connection", async () => {
  const flowId = await flow();
  await qualifying();
  const body = startBody();
  const result = await accepted(flowId, body);
  assert.equal(result.status, "queued");
  assert.deepEqual(Object.keys(result), ["start_id", "run_id", "status"]);
  const stored = (
    await pool.query(
      `SELECT s.id::text AS start_id,s.sender_id,s.recipient_id,s.request_key::text,s.api_key_id=k.id AS by_key,
         run.id::text AS run_id,run.status,run.flow_version_id=f.published_version_id AS pinned,d.recipient_id AS delivery_recipient,
         d.message_text,d.status AS delivery_status,
         (SELECT count(*)::int FROM flow_step_runs step WHERE step.run_id=run.id) AS steps
       FROM flow_api_starts s JOIN api_keys k ON k.name='starter' JOIN flows f ON f.id=s.flow_id
       JOIN flow_runs run ON run.api_start_id=s.id JOIN flow_dm_deliveries d ON d.flow_run_id=run.id`,
    )
  ).rows;
  assert.deepEqual(stored, [
    {
      start_id: result.start_id,
      sender_id: SENDER,
      recipient_id: RECIPIENT,
      request_key: body.request_key,
      by_key: true,
      run_id: result.run_id,
      status: "delivering",
      pinned: true,
      delivery_recipient: RECIPIENT,
      message_text: "Thanks for your order",
      delivery_status: "pending",
      steps: 2,
    },
  ]);
  assert.deepEqual(wakes, [C]);
  assert.ok((await pool.query("SELECT last_used_at FROM api_keys WHERE name='starter'")).rows[0].last_used_at);
  // A version whose plan sends no first message (here unsupported_node, because it would change contact data) is
  // refused, and nothing is written for it.
  const tagging = await flow({
    definition: {
      schema_version: 1,
      nodes: [
        { id: "start", type: "instagram_dm_default", config: { connection_id: C } },
        { id: "tag", type: "add_tag", config: { tag: "vip" } },
        { id: "reply", type: "instagram_message", config: { text: "Hi" } },
      ],
      edges: [
        { from: "start", port: "next", to: "tag" },
        { from: "tag", port: "next", to: "reply" },
      ],
    },
    connection: SECOND_C,
  });
  await bridge("second-sender", "9002", SECOND_C);
  await inboxDm("9002", "1 hour", SECOND_C);
  await consent("dm_recipient", "9002", "marketing", "grant", SECOND_C);
  const before = await written();
  await refused(tagging, startBody({ connection_id: SECOND_C, sender_id: "second-sender" }), 409, "flow_unavailable");
  // A published DM version with no message node ends without one and is refused too.
  const silent = await flow({ connection: SECOND_C, definition: { schema_version: 1, nodes: [{ id: "start", type: "instagram_dm_default", config: { connection_id: SECOND_C } }], edges: [] } });
  await refused(silent, startBody({ connection_id: SECOND_C, sender_id: "second-sender" }), 409, "flow_unavailable");
  assert.deepEqual(await written(), before);
});

test("the same key and body again returns the stored start and writes nothing new, also after sending was switched off", async () => {
  const flowId = await flow();
  await qualifying();
  const body = startBody();
  const first = await accepted(flowId, body);
  const before = await written();
  wakes = [];
  // Upper-case UUIDs are the same request.
  assert.deepEqual(await accepted(flowId.toUpperCase(), { ...body, request_key: body.request_key.toUpperCase(), connection_id: C.toUpperCase() }), first);
  assert.deepEqual(await accepted(flowId, body, { enabled: false }), first);
  await pool.query("UPDATE instagram_connections SET send_enabled=false WHERE id=$1", [C]);
  assert.deepEqual(await accepted(flowId, body), first);
  assert.deepEqual(await written(), before);
  assert.deepEqual(wakes, []);
});

test("the same key with another flow, connection or contact is 409 idempotency_conflict and writes nothing", async () => {
  const flowId = await flow();
  const secondFlow = await flow();
  await qualifying();
  const body = startBody();
  await accepted(flowId, body);
  const before = await written();
  await refused(secondFlow, body, 409, "idempotency_conflict");
  await refused(flowId, { ...body, sender_id: "other" }, 409, "idempotency_conflict");
  await refused(flowId, { ...body, connection_id: SECOND_C }, 409, "idempotency_conflict");
  // A request key is scoped to its workspace: another workspace's key with the same request key is a new request.
  const foreignFlow = await flow({ workspace: OTHER_W, connection: FOREIGN_C });
  await refused(foreignFlow, { ...body, connection_id: FOREIGN_C }, 404, "contact_not_found", { key: keys.foreign });
  assert.deepEqual(await written(), before);
});

test("concurrent requests with one key create one start and one run, and every one answers the same start", async () => {
  const flowId = await flow();
  await qualifying();
  const body = startBody();
  const results = await Promise.all(Array.from({ length: 6 }, () => accepted(flowId, body)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.deepEqual(await written(), { keys: 1, starts: 1, runs: 1, deliveries: 1, steps: 2 });
  // Concurrent starts with different keys for one recipient: the dm-start-sender lock lets one through and the
  // second sees its pending first message.
  for (const table of ["flow_dm_deliveries", "flow_step_runs", "flow_runs", "flow_api_starts", "flow_api_start_keys"]) await pool.query(`DELETE FROM ${table}`);
  const responses = await Promise.all([start(flowId, startBody()), start(flowId, startBody())]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
  assert.deepEqual(await responses.find((response) => response.status === 409)!.json(), { error: "contact_busy" });
  assert.equal(await count("flow_api_starts"), 1);
});

test("each refusal code of the table writes nothing, and a refused key can start once the cause is fixed", async () => {
  const flowId = await flow();
  const cases: [string, number, string, () => Promise<unknown>, Partial<StartBody>?, Parameters<typeof start>[2]?][] = [
    ["global switch off", 409, "sending_disabled", qualifying, {}, { enabled: false }],
    ["connection send off", 409, "sending_disabled", async () => (await qualifying(), pool.query("UPDATE instagram_connections SET send_enabled=false WHERE id=$1", [C]))],
    ["token expired", 409, "sending_disabled", async () => (await qualifying(), pool.query("UPDATE instagram_connections SET token_expires_at=now()-interval '1 minute' WHERE id=$1", [C]))],
    ["no comment", 404, "contact_not_found", async () => undefined],
    ["comment on another connection only", 404, "contact_not_found", () => bridge(SENDER, RECIPIENT, SECOND_C)],
    ["no bridge", 409, "no_dm_identity", () => pool.query("INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'c-only','m',$3,'hi')", [W, C, SENDER])],
    ["recipient revoked marketing", 409, "recipient_opted_out", async () => (await qualifying(), consent("dm_recipient", RECIPIENT, "marketing", "revoke"))],
    ["comment sender revoked service replies", 409, "recipient_opted_out", async () => (await qualifying(), consent("comment_sender", SENDER, "service_reply", "revoke"))],
    ["no marketing grant", 409, "marketing_consent_required", async () => (await bridge(SENDER, RECIPIENT), inboxDm(RECIPIENT))],
    ["implied marketing grant only", 409, "marketing_consent_required", async () => (await bridge(SENDER, RECIPIENT), await inboxDm(RECIPIENT), consent("comment_sender", SENDER, "marketing", "grant"))],
    ["window closed", 409, "reply_window_closed", () => qualifying(SENDER, RECIPIENT, "25 hours")],
    ["comment contact paused", 409, "contact_paused", async () => (await qualifying(), pool.query("INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,$3,true)", [W, C, SENDER]))],
    ["recipient paused", 409, "contact_paused", async () => (await qualifying(), pool.query("INSERT INTO instagram_dm_automation(workspace_id,connection_id,recipient_id,paused) VALUES($1,$2,$3,true)", [W, C, RECIPIENT]))],
    [
      "active handoff",
      409,
      "contact_busy",
      async () => {
        await qualifying();
        const evidence = (await pool.query("SELECT id FROM private_reply_outbox WHERE recipient_id=$1", [RECIPIENT])).rows[0].id;
        // The handoff's contact row without a pause, so the busy check, not the pause check, refuses it.
        await pool.query("INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id) VALUES($1,$2,$3)", [W, C, SENDER]);
        await pool.query("INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by) VALUES($1,$2,$3,$4,$5,true,1,$6)", [W, C, RECIPIENT, SENDER, evidence, admin]);
      },
    ],
    ["active contact limit", 409, "active_contact_limit", async () => (await qualifying(), exceedActiveContactLimit(pool, W, C))],
    [
      "recipient started by a DM within 10 minutes",
      429,
      "rate_limited",
      async () => {
        await qualifying();
        const version = (await pool.query("SELECT published_version_id FROM flows WHERE id=$1", [flowId])).rows[0].published_version_id;
        await pool.query(
          `INSERT INTO instagram_dm_start_events(workspace_id,connection_id,message_id,sender_id,flow_id,flow_version_id,trigger_type,message_at)
           VALUES($1,$2,'dm-start-1',$3,$4,$5,'instagram_dm_default',now())`,
          [W, C, RECIPIENT, flowId, version],
        );
      },
    ],
    [
      "connection hourly limit",
      429,
      "rate_limited",
      async () => {
        await qualifying();
        const version = (await pool.query("SELECT published_version_id FROM flows WHERE id=$1", [flowId])).rows[0].published_version_id;
        await pool.query(
          `INSERT INTO instagram_dm_start_events(workspace_id,connection_id,message_id,sender_id,flow_id,flow_version_id,trigger_type,message_at)
           SELECT $1,$2,'hour-'||n,(10000+n)::text,$3,$4,'instagram_dm_default',now() FROM generate_series(1,$5::int) n`,
          [W, C, flowId, version, DM_START_HOURLY_LIMIT],
        );
      },
    ],
  ];
  for (const [name, status, code, arrange, overrides, options] of cases) {
    await pool.query("TRUNCATE instagram_comment_events,channel_consent_events,channel_consent_state,instagram_inbox_messages,instagram_contact_automation,instagram_dm_automation,instagram_inbox_handoffs,instagram_dm_start_events,active_contacts CASCADE");
    await pool.query("UPDATE instagram_connections SET send_enabled=true,token_expires_at=now()+interval '30 days' WHERE workspace_id=$1", [W]);
    await arrange();
    await refused(flowId, startBody(overrides), status, code, options);
    assert.deepEqual(await written(), nothing, name);
  }
  // A key refused for a missing consent starts once the consent is recorded.
  await pool.query("TRUNCATE instagram_comment_events,channel_consent_events,channel_consent_state,instagram_inbox_messages,instagram_dm_start_events,active_contacts CASCADE");
  await bridge(SENDER, RECIPIENT);
  await inboxDm(RECIPIENT);
  const body = startBody();
  await refused(flowId, body, 409, "marketing_consent_required");
  await consent("dm_recipient", RECIPIENT, "marketing", "grant");
  await accepted(flowId, body);
});

test("the flow must be this workspace's, on, published with a DM trigger on the named connection", async () => {
  await qualifying();
  const foreignFlow = await flow({ workspace: OTHER_W, connection: FOREIGN_C });
  await refused(randomUUID(), startBody(), 404, "flow_not_found");
  await refused(foreignFlow, startBody(), 404, "flow_not_found");
  await refused(await flow({ enabled: false }), startBody(), 409, "flow_unavailable");
  const archived = await flow({ enabled: false });
  await pool.query("UPDATE flows SET archived=true,published_version_id=NULL WHERE id=$1", [archived]);
  await refused(archived, startBody(), 409, "flow_unavailable");
  const unpublished = (await pool.query("INSERT INTO flows(workspace_id,name,draft) VALUES($1,'Draft','{}') RETURNING id::text", [W])).rows[0].id;
  await refused(unpublished, startBody(), 409, "flow_unavailable");
  await refused(await flow({ trigger: "instagram_comment", definition: { schema_version: 1, nodes: [], edges: [] } }), startBody(), 409, "flow_unavailable");
  await refused(await flow({ connection: SECOND_C }), startBody(), 409, "flow_unavailable");
  // Another workspace's connection or contact cannot be named through this workspace's flow.
  const keyword = await flow({ trigger: "instagram_dm_keyword" });
  await refused(keyword, startBody({ connection_id: FOREIGN_C }), 409, "flow_unavailable");
  // The other workspace's key cannot start this workspace's flow, even with this workspace's contact.
  await refused(keyword, startBody(), 404, "flow_not_found", { key: keys.foreign });
  // A key without flows:start is refused before anything.
  await refused(keyword, startBody(), 403, "insufficient_scope", { key: keys.writer });
  assert.deepEqual(await written(), nothing);
  // The keyword flow starts: the trigger keywords are not matched against anything.
  await accepted(keyword, startBody());
});

test("among several verified recipients the start takes the most recent one that passes, else refuses with the most recent one's code", async () => {
  const flowId = await flow();
  // 9101 has the newest DM but no marketing grant; 9102 passes; 9103 passes with an older DM.
  await bridge(SENDER, "9101");
  await inboxDm("9101", "10 minutes");
  await bridge(SENDER, "9102");
  await inboxDm("9102", "1 hour");
  await consent("dm_recipient", "9102", "marketing", "grant");
  await bridge(SENDER, "9103");
  await inboxDm("9103", "2 hours");
  await consent("dm_recipient", "9103", "marketing", "grant");
  await accepted(flowId, startBody());
  assert.deepEqual((await pool.query("SELECT s.recipient_id AS start,d.recipient_id AS delivery FROM flow_api_starts s JOIN flow_runs r ON r.api_start_id=s.id JOIN flow_dm_deliveries d ON d.flow_run_id=r.id")).rows, [{ start: "9102", delivery: "9102" }]);
  // Another contact whose recipients all fail: the newest one decides the code.
  await bridge("other", "9201");
  await inboxDm("9201", "30 hours");
  await consent("dm_recipient", "9201", "marketing", "grant");
  await bridge("other", "9202");
  await inboxDm("9202", "1 hour");
  await consent("dm_recipient", "9202", "marketing", "revoke");
  await refused(flowId, startBody({ sender_id: "other" }), 409, "recipient_opted_out");
});

test("DM starts and external starts share the 10-minute recipient cooldown and the connection's hourly limit", async () => {
  const flowId = await flow();
  await qualifying();
  await accepted(flowId, startBody());
  const skip = async (recipient: string) => (await pool.query(`SELECT ${dmStartSkipCodeSql("$1::uuid", "$2::text", "decision.decided_at")} AS code FROM (SELECT clock_timestamp() AS decided_at) decision`, [C, recipient])).rows[0].code;
  // A DM trigger start of the same recipient is now in its cooldown, and another recipient is not.
  assert.equal(await skip(RECIPIENT), "sender_cooldown");
  assert.equal(await skip("9999"), null);
  // Once the first message is sent and 10 minutes pass, the recipient may start again.
  await pool.query("UPDATE flow_dm_deliveries SET status='sent',provider_message_id='m',sent_at=now(),attempt_id=gen_random_uuid(),attempt_started_at=now(),provider_called_at=now()");
  await pool.query("UPDATE flow_api_starts SET created_at=now()-interval '11 minutes'");
  assert.equal(await skip(RECIPIENT), null);
  await accepted(flowId, startBody());
  // The external starts count toward the hourly limit with the DM starts.
  const version = (await pool.query("SELECT published_version_id FROM flows WHERE id=$1", [flowId])).rows[0].published_version_id;
  await pool.query(
    `INSERT INTO instagram_dm_start_events(workspace_id,connection_id,message_id,sender_id,flow_id,flow_version_id,trigger_type,message_at)
     SELECT $1,$2,'hour-'||n,(10000+n)::text,$3,$4,'instagram_dm_default',now() FROM generate_series(1,$5::int) n`,
    [W, C, flowId, version, DM_START_HOURLY_LIMIT - 3],
  );
  assert.equal(await skip("9999"), null);
  await pool.query(
    `INSERT INTO instagram_dm_start_events(workspace_id,connection_id,message_id,sender_id,flow_id,flow_version_id,trigger_type,message_at)
     VALUES($1,$2,'hour-last','19999',$3,$4,'instagram_dm_default',now())`,
    [W, C, flowId, version],
  );
  assert.equal(await skip("9999"), "connection_hourly_limit");
});

test("a start's request key survives person and connection deletion, and a replay then sends nothing", async () => {
  const flowId = await flow();
  await qualifying();
  const body = startBody();
  await accepted(flowId, body);
  const person = (await pool.query("SELECT public.delete_person_data($1,$2,$3,'comment_sender',$4) AS result", [W, C, admin, SENDER])).rows[0].result;
  assert.equal(person.deleted_counts.flow_api_starts, 1);
  assert.equal(person.deleted_counts.flow_dm_deliveries, 1);
  // The kept key no longer holds the hash of the person's request.
  const unlinked = "0".repeat(64);
  const hashOf = async (key: string) => (await pool.query("SELECT request_hash FROM flow_api_start_keys WHERE request_key=$1", [key])).rows[0].request_hash;
  assert.equal(await hashOf(body.request_key), unlinked);
  assert.deepEqual({ ...(await written()), keys: await count("flow_api_start_keys") }, { ...nothing, keys: 1 });
  await refused(flowId, body, 409, "idempotency_conflict");
  assert.deepEqual({ ...(await written()) }, { ...nothing, keys: 1 });
  // A replay after the person is back still sends nothing.
  await qualifying();
  await refused(flowId, body, 409, "idempotency_conflict");
  assert.equal(await count("flow_dm_deliveries"), 0);
  await pool.query("TRUNCATE instagram_comment_events,channel_consent_events,channel_consent_state,instagram_inbox_messages CASCADE");
  // A start found from the DM recipient side goes too.
  await qualifying();
  await accepted(flowId, startBody());
  const byRecipient = (await pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient',$4) AS result", [W, C, admin, RECIPIENT])).rows[0].result;
  assert.equal(byRecipient.deleted_counts.flow_api_starts, 1);
  // A key of a start that stays keeps its hash: the second start's key changed only now.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM flow_api_start_keys WHERE request_hash=$1", [unlinked])).rows[0].n, 2);
  // Connection deletion.
  await qualifying();
  const third = startBody();
  await accepted(flowId, third);
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE id=$1", [C]);
  const connection = (await pool.query("SELECT public.delete_connection_data($1,$2,$3,'100') AS result", [W, C, admin])).rows[0].result;
  assert.equal(connection.deleted_counts.flow_api_starts, 1);
  assert.equal(await hashOf(third.request_key), unlinked);
  // Every key whose start was deleted, by either function, is unlinked.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM flow_api_start_keys WHERE request_hash<>$1", [unlinked])).rows[0].n, 0);
  assert.deepEqual({ ...(await written()) }, { ...nothing, keys: 3 });
  await pool.query("UPDATE instagram_connections SET active=true,send_enabled=true,access_token_encrypted=$2 WHERE id=$1", [C, TOKEN]);
  await qualifying();
  await refused(flowId, third, 409, "idempotency_conflict");
  assert.equal(await count("flow_dm_deliveries"), 0);
  // Workspace deletion removes the starts and the keys.
  await accepted(flowId, startBody());
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL WHERE workspace_id=$1", [W]);
  const workspace = (await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [W, admin])).rows[0].result;
  assert.equal(workspace.deleted_counts.flow_api_starts, 1);
  assert.equal(workspace.deleted_counts.flow_api_start_keys, 4);
  assert.equal(await count("flow_api_start_keys"), 0);
});

interface Graph {
  posts: { recipient: string }[];
}
function deliver(seen: Graph, globalSendEnabled = true) {
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "graph.instagram.com");
    if (init?.method === "POST") {
      seen.posts.push({ recipient: (JSON.parse(String(init.body)) as { recipient: { id: string } }).recipient.id });
      return Response.json({ message_id: `dm-message-${seen.posts.length}` });
    }
    return Response.json({ user_id: "100" });
  }) as typeof fetch;
  const transport = new InstagramFollowTransport({
    accountId: "100",
    accessToken: "synthetic",
    graphVersion: "v24.0",
    fetchImpl,
    beforeSend: (context) => assertDmFlowDeliveryAllowed(pool, { workspaceId: W, id: context.replyId, attempt: context.attemptId, connectionId: C, encryptedToken: TOKEN, globalSendEnabled }),
  });
  return processNextDmFlowDelivery(pool, C, transport, TOKEN, { globalSendEnabled });
}
const delivery = async () => (await pool.query("SELECT status,failure_code FROM flow_dm_deliveries")).rows[0];

test("the delivery guard ends an external start's message on a later marketing revoke, comment contact pause or closed window, and holds it while sending is off", async () => {
  const flowId = await flow();
  const cases: [string, () => Promise<unknown>, { status: string; failure_code: string | null }][] = [
    ["marketing revoke", () => consent("dm_recipient", RECIPIENT, "marketing", "revoke"), { status: "blocked", failure_code: "recipient_opted_out" }],
    ["comment sender revoke", () => consent("comment_sender", SENDER, "marketing", "revoke"), { status: "blocked", failure_code: "recipient_opted_out" }],
    ["marketing grant withdrawn by deletion", () => pool.query("DELETE FROM channel_consent_state WHERE purpose='marketing'"), { status: "blocked", failure_code: "marketing_consent_required" }],
    ["comment contact pause", () => pool.query("INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,$3,true)", [W, C, SENDER]), { status: "blocked", failure_code: "contact_paused" }],
    ["comment contact handoff pause", () => pool.query("INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,handoff_paused) VALUES($1,$2,$3,true)", [W, C, SENDER]), { status: "blocked", failure_code: "contact_paused" }],
    ["window closed", () => pool.query("UPDATE instagram_inbox_messages SET message_at=now()-interval '25 hours',received_at=now()-interval '25 hours'"), { status: "blocked", failure_code: "reply_window_closed" }],
    ["connection send switch off", () => pool.query("UPDATE instagram_connections SET send_enabled=false WHERE id=$1", [C]), { status: "blocked", failure_code: "connection_unavailable" }],
    ["flow disabled", () => pool.query("UPDATE flows SET enabled=false WHERE id=$1", [flowId]), { status: "blocked", failure_code: "inactive_flow" }],
  ];
  for (const [name, change, expected] of cases) {
    await pool.query("TRUNCATE instagram_comment_events,channel_consent_events,channel_consent_state,instagram_inbox_messages,instagram_contact_automation,flow_dm_deliveries,flow_step_runs,flow_runs,flow_api_starts,flow_api_start_keys CASCADE");
    await pool.query("UPDATE instagram_connections SET send_enabled=true WHERE id=$1", [C]);
    await pool.query("UPDATE flows SET enabled=true WHERE id=$1", [flowId]);
    await qualifying();
    await accepted(flowId, startBody());
    await change();
    const seen: Graph = { posts: [] };
    assert.equal(await deliver(seen), true, name);
    assert.deepEqual(await delivery(), expected, name);
    assert.deepEqual(seen.posts, [], name);
  }
  // The global switch off defers the row without sending it.
  await pool.query("TRUNCATE instagram_comment_events,channel_consent_events,channel_consent_state,instagram_inbox_messages,instagram_contact_automation,flow_dm_deliveries,flow_step_runs,flow_runs,flow_api_starts,flow_api_start_keys CASCADE");
  await pool.query("UPDATE flows SET enabled=true WHERE id=$1", [flowId]);
  await qualifying();
  await accepted(flowId, startBody());
  const held: Graph = { posts: [] };
  await deliver(held, false);
  assert.deepEqual(await delivery(), { status: "pending", failure_code: "global_send_disabled" });
  assert.deepEqual(held.posts, []);
  // A paused recipient or an active handoff is not claimed: the row waits, as for a DM trigger run.
  await pool.query("UPDATE flow_dm_deliveries SET next_attempt_at=now()");
  await pool.query("INSERT INTO instagram_dm_automation(workspace_id,connection_id,recipient_id,paused) VALUES($1,$2,$3,true)", [W, C, RECIPIENT]);
  assert.equal(await deliver(held), false);
  await pool.query("UPDATE instagram_dm_automation SET paused=false");
  const evidence = (await pool.query("SELECT id FROM private_reply_outbox WHERE recipient_id=$1", [RECIPIENT])).rows[0].id;
  await pool.query("INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id) VALUES($1,$2,$3)", [W, C, SENDER]);
  await pool.query("INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by) VALUES($1,$2,$3,$4,$5,true,1,$6)", [W, C, RECIPIENT, SENDER, evidence, admin]);
  assert.equal(await deliver(held), false);
  assert.deepEqual(held.posts, []);
  // Once the handoff ends the message is sent to the chosen recipient and the active contact ledger records it.
  await pool.query("UPDATE instagram_inbox_handoffs SET active=false");
  await deliver(held);
  assert.deepEqual(await delivery(), { status: "sent", failure_code: null });
  assert.deepEqual(held.posts, [{ recipient: RECIPIENT }]);
  assert.equal(await count("active_contacts WHERE activity_kind='flow_dm'"), 1);
});

test("GET /v1/flows lists only this workspace's enabled DM flows with their connection, and an external start run is in the flow run report", async () => {
  const listed = await flow({ name: "Paid order" });
  await flow({ enabled: false });
  await flow({ trigger: "instagram_comment", definition: { schema_version: 1, nodes: [], edges: [] } });
  await flow({ workspace: OTHER_W, connection: FOREIGN_C });
  const second = await flow({ connection: SECOND_C, trigger: "instagram_dm_keyword", name: "Keyword" });
  const list = (key: string) => publicApi(new Request("https://app.test/v1/flows", { headers: { Authorization: `Bearer ${key}` } }), { API_IP_LIMIT: allow, API_KEY_LIMIT: allow }, sharedPool, "corr-list");
  const response = await list(keys.starter);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    flows: [
      { id: listed, name: "Paid order", connection_id: C },
      { id: second, name: "Keyword", connection_id: SECOND_C },
    ],
  });
  assert.equal((await list(keys.writer)).status, 403);
  await qualifying();
  await accepted(listed, startBody());
  const day = new Date().toISOString().slice(0, 10);
  const next = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const report = await appApi(
    new Request(`https://app.test/api/reports/flow-runs?from=${day}&before=${next}&expected_time_zone=UTC`, { headers: { cookie: "__Host-ac-access=test" } }),
    { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" },
    sharedPool,
    (async () => Response.json({ id: admin, email: "owner@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
  const body = await report.json();
  assert.equal(report.status, 200, JSON.stringify(body));
  assert.equal(body.run_counts.total, "1");
});

test("both tables are registered for export, the key table for the workspace move checks, and migration 082 replays", async () => {
  assert.deepEqual(EXPORTED_TABLES.flow_api_starts, { scope: "workspace", omit: ["request_hash"] });
  assert.deepEqual(EXPORTED_TABLES.flow_api_start_keys, { scope: "workspace", omit: ["request_hash"] });
  assert.ok(!EXCLUDED_TABLES.includes("flow_api_starts"));
  for (const file of ["src/app/workspace-members.ts", "deploy/assign-workspace-owner.sql"]) assert.match(await readFile(new URL(`../../${file}`, import.meta.url), "utf8"), /FROM flow_api_start_keys WHERE workspace_id=/, file);
  const functions = async () =>
    (
      await pool.query(
        `SELECT p.proname,pg_get_functiondef(p.oid) AS body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname LIKE 'delete_%' ORDER BY 1`,
      )
    ).rows;
  const constraints = async () => (await pool.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('flow_runs'::regclass,'api_keys'::regclass,'flow_api_starts'::regclass) ORDER BY 1")).rows;
  const current = await functions();
  const named = await constraints();
  const flowId = await flow();
  await qualifying();
  await accepted(flowId, startBody());
  // The runner replays 081 before 082 on every rollout; with a flows:start key stored, 081 must not fail.
  const contactWrites = await readFile(new URL("../../db/migrations/081_api_key_contact_writes.sql", import.meta.url), "utf8");
  const migration = await readFile(new URL("../../db/migrations/082_flow_api_starts.sql", import.meta.url), "utf8");
  assert.ok((await pool.query("SELECT 1 FROM api_keys WHERE 'flows:start'=ANY(scopes)")).rowCount);
  for (let run = 0; run < 2; run++) {
    await pool.query(contactWrites);
    await pool.query(migration);
  }
  assert.deepEqual(await functions(), current);
  assert.deepEqual(await constraints(), named);
  // A run has exactly one source.
  const run = (await pool.query("SELECT id FROM flow_runs WHERE api_start_id IS NOT NULL")).rows[0].id;
  await assert.rejects(pool.query("UPDATE flow_runs SET dm_start_event_id=(SELECT id FROM instagram_dm_start_events LIMIT 1),api_start_id=NULL WHERE id=$1", [run]), /flow_runs_source|violates/);
  const event = (await pool.query("SELECT id FROM instagram_comment_events LIMIT 1")).rows[0].id;
  await assert.rejects(pool.query("UPDATE flow_runs SET event_id=$2 WHERE id=$1", [run, event]), /flow_runs_source/);
  // The scopes CHECK admits the four arrays in order and nothing else.
  for (const [scopes, ok] of [
    [["contacts:read", "flows:start"], true],
    [["contacts:read", "contacts:write", "flows:start"], true],
    [["flows:start", "contacts:read"], false],
    [["flows:start"], false],
  ] as const) {
    const attempt = pool.query("UPDATE api_keys SET scopes=$1::text[] WHERE name='writer'", [scopes]);
    if (ok) await attempt;
    else await assert.rejects(attempt, /api_keys_scopes_check/);
  }
});
