import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { EXCLUDED_ITEMS, EXCLUDED_TABLES, EXPORTED_TABLES } from "./workspace-export.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const strangerId = "33333333-3333-4333-8333-333333333330";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const connectionId = "55555555-5555-4555-8555-555555555555";
const foreignConnectionId = "77777777-7777-4777-8777-777777777777";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };
// Columns whose names look secret but hold only timestamps.
const benignSecretLikeColumns = new Set(["token_expires_at", "token_obtained_at", "token_refresh_attempted_at"]);

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

async function seedWorkspace(workspace: string, user: string, connection: string, account: string) {
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [workspace]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2)", [workspace, user]);
  await pool.query(
    "INSERT INTO instagram_oauth_states(state_hash,user_id,workspace_id,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",
    [`state-hash-${account}`, user, workspace],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,access_token_encrypted,token_expires_at)
     VALUES($1,$2,$3,$3,$4,now()+interval '30 days')`,
    [connection, workspace, account, `SECRET-CIPHERTEXT-${account}`],
  );
  const rule = (
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,keywords,private_reply_text,enabled)
       VALUES(gen_random_uuid(),$1,$2,'1789','link','{link}','reply text',false) RETURNING id`,
      [workspace, connection],
    )
  ).rows[0].id;
  const event = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,'1789','123',$4) RETURNING id`,
      [workspace, connection, `comment-${account}`, `comment text ${account}`],
    )
  ).rows[0].id;
  const reply = (
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text,recipient_id,status,provider_message_id,sent_at)
       VALUES($1,$2,$3,$4,$5,'1789','123','reply text','900','sent','mid-1',now()) RETURNING id`,
      [workspace, connection, event, rule, `comment-${account}`],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text,status)
     VALUES($1,$2,'900','ok','yes','no','sent')`,
    [reply, connection],
  );
  await pool.query("INSERT INTO instagram_message_receipts(connection_id,message_id,received_at) VALUES($1,$2,now())", [
    connection,
    `m-${account}`,
  ]);
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,'900',$3,'dm text','text',now())`,
    [workspace, connection, `dm-${account}`],
  );
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,'123',true)",
    [workspace, connection],
  );
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'123','{vip}')",
    [workspace, connection],
  );
  await pool.query(
    "INSERT INTO instagram_contact_segments(workspace_id,name,connection_id,tag) VALUES($1,'vips',$2,'vip')",
    [workspace, connection],
  );
  const field = (
    await pool.query(
      "INSERT INTO instagram_contact_fields(workspace_id,name,type) VALUES($1,'city','text') RETURNING id",
      [workspace],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,'123',$3,'"Seoul"')`,
    [workspace, connection, field],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
     VALUES($1,$2,'900','123',$3,true,1,$4)`,
    [workspace, connection, reply, user],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_handoff_events(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,actor_id,reason,manual_paused_before,handoff_paused_before,handoff_paused_after)
     VALUES($1,$2,'900','123',$3,true,1,$4,'handoff_started',false,false,true)`,
    [workspace, connection, reply, user],
  );
  const manual = (
    await pool.query(
      `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,status)
       VALUES($1,$2,'900',gen_random_uuid(),$3,'manual text',1,'failed') RETURNING id`,
      [workspace, connection, user],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,actor_id,request_key)
     VALUES($1,$2,'900',$3,'queued',$4,gen_random_uuid())`,
    [workspace, connection, manual, user],
  );
  const consent = (
    await pool.query(
      `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
       VALUES(gen_random_uuid(),$1,$2,'instagram','comment_sender','123','marketing','revoke','explicit','ref',now(),$3) RETURNING id`,
      [workspace, connection, user],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
     SELECT workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,id
     FROM channel_consent_events WHERE id=$1`,
    [consent],
  );
  const flow = (
    await pool.query(
      `INSERT INTO flows(workspace_id,name,draft,draft_revision) VALUES($1,'welcome','{"nodes":[]}',1) RETURNING id`,
      [workspace],
    )
  ).rows[0].id;
  const version = (
    await pool.query(
      `INSERT INTO flow_versions(flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,published_by)
       VALUES($1,$2,1,1,'{"nodes":[]}',$3,'1789',$4) RETURNING id`,
      [flow, workspace, connection, user],
    )
  ).rows[0].id;
  const run = (
    await pool.query(
      `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,event_id,status)
       VALUES($1,$2,$3,$4,$5,'ended') RETURNING id`,
      [workspace, connection, flow, version, event],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO flow_step_runs(run_id,workspace_id,connection_id,seq,node_id,node_type,outcome)
     VALUES($1,$2,$3,0,'start','instagram_comment','next')`,
    [run, workspace, connection],
  );
  await pool.query(
    `INSERT INTO data_deletion_records(workspace_id,connection_id,requested_by,deleted_counts,retained_counts)
     VALUES($1,$2,$3,'{"instagram_comment_events":0}','{}')`,
    [workspace, connection, user],
  );
}

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await seedWorkspace(workspaceId, userId, connectionId, "account-own");
  await seedWorkspace(otherWorkspaceId, otherUserId, foreignConnectionId, "account-foreign");
});

after(async () => pool.end());

function request(actorId = userId) {
  return appApi(
    new Request("https://app.test/api/workspace/export", {
      method: "GET",
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test" },
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () =>
      Response.json({ id: actorId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

test("exports every table of the caller's workspace and nothing from another workspace", async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment; filename="auto-chatter-export-\d{4}-\d{2}-\d{2}\.json"$/,
  );
  const body = await response.json();
  assert.equal(body.format, "auto-chatter-workspace-export");
  assert.equal(body.version, 1);
  assert.equal(body.workspace_id, workspaceId);
  assert.deepEqual(body.excluded, EXCLUDED_ITEMS);
  assert.ok(body.excluded.includes("instagram_connections.access_token_encrypted"));
  assert.deepEqual(Object.keys(body.tables).sort(), Object.keys(EXPORTED_TABLES).sort());
  for (const [table, rows] of Object.entries(body.tables as Record<string, Record<string, unknown>[]>)) {
    assert.ok(rows.length > 0, `${table} was seeded but exported no rows`);
    for (const row of rows) {
      if ("workspace_id" in row) assert.equal(row.workspace_id, workspaceId, table);
      if ("connection_id" in row) assert.equal(row.connection_id, connectionId, table);
    }
  }
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /SECRET-CIPHERTEXT/);
  assert.doesNotMatch(text, /state-hash-/);
  assert.doesNotMatch(text, /account-foreign/);
  assert.ok(text.includes("comment text account-own"));
  assert.equal(body.tables.instagram_connections[0].access_token_encrypted, undefined);
  assert.ok(body.tables.instagram_connections[0].token_expires_at);
});

test("every public table is exported or explicitly excluded, and secret-like columns are omitted", async () => {
  const tables = (
    await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
    )
  ).rows.map((row) => row.table_name);
  const classified = new Set([...Object.keys(EXPORTED_TABLES), ...EXCLUDED_TABLES]);
  assert.deepEqual(
    tables.filter((table) => !classified.has(table)),
    [],
    "a new table must be added to EXPORTED_TABLES or EXCLUDED_TABLES",
  );
  const columns = (
    await pool.query<{ table_name: string; column_name: string }>(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'",
    )
  ).rows;
  for (const { table_name: table, column_name: column } of columns) {
    const config = EXPORTED_TABLES[table];
    if (!config || benignSecretLikeColumns.has(column) || !/token|secret|encrypt|password|hash/i.test(column)) continue;
    assert.ok(config.omit?.includes(column), `${table}.${column} looks secret and must be omitted from the export`);
  }
});

test("bigint identifiers above 2^53 are exported exactly", async () => {
  await pool.query(
    `INSERT INTO instagram_comment_events(id,workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     OVERRIDING SYSTEM VALUE VALUES(9007199254740993,$1,$2,'comment-big','1789','123','big id')`,
    [workspaceId, connectionId],
  );
  const text = await (await request()).text();
  assert.ok(text.includes('"id": 9007199254740993') || text.includes('"id":9007199254740993'), "bigint id was rounded");
});

test("a signed-in user without a workspace cannot export", async () => {
  const response = await request(strangerId);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "workspace_required");
});
