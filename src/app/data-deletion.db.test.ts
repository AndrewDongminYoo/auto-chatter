import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { deliveryRecipientOptedOut } from "../instagram/channel-consent.ts";

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
const keptConnectionId = "66666666-6666-4666-8666-666666666666";
const foreignConnectionId = "77777777-7777-4777-8777-777777777777";
const fieldId = "99999999-9999-4999-8999-999999999999";
const otherFieldId = "99999999-9999-4999-8999-999999999998";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };
const connectionTables = [
  "instagram_comment_events",
  "private_reply_outbox",
  "instagram_follow_conversations",
  "instagram_message_receipts",
  "instagram_inbox_messages",
  "instagram_contact_automation",
  "instagram_contact_tags",
  "instagram_contact_field_values",
  "instagram_inbox_handoffs",
  "instagram_inbox_handoff_events",
  "instagram_manual_replies",
  "instagram_manual_reply_events",
];

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

async function seedConnection(connection: string, workspace: string, account: string) {
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,access_token_encrypted,username)
     VALUES($1,$2,$3,false,false,NULL,$3)`,
    [connection, workspace, account],
  );
  await pool.query(
    `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,keywords,private_reply_text,enabled)
     VALUES(gen_random_uuid(),$1,$2,'1789','link','{link}','reply text',false)`,
    [workspace, connection],
  );
  const rule = (await pool.query("SELECT id FROM instagram_comment_rules WHERE connection_id=$1", [connection])).rows[0]
    .id;
  const event = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,'1789','123','personal comment text') RETURNING id`,
      [workspace, connection, `comment-${connection}`],
    )
  ).rows[0].id;
  const reply = (
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text,recipient_id,status,provider_message_id,sent_at)
       VALUES($1,$2,$3,$4,$5,'1789','123','reply text','900','sent','mid-1',now()) RETURNING id`,
      [workspace, connection, event, rule, `comment-${connection}`],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text,status)
     VALUES($1,$2,'900','ok','yes','no','sent')`,
    [reply, connection],
  );
  await pool.query(
    "INSERT INTO instagram_message_receipts(connection_id,message_id,received_at) VALUES($1,'m-1',now())",
    [connection],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,'900','dm-1','personal dm text','text',now())`,
    [workspace, connection],
  );
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused,handoff_paused) VALUES($1,$2,'123',false,true)",
    [workspace, connection],
  );
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'123','{vip}')",
    [workspace, connection],
  );
  await pool.query(
    `INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,'123',$3,'"Seoul"')`,
    [workspace, connection, workspace === workspaceId ? fieldId : otherFieldId],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
     VALUES($1,$2,'900','123',$3,true,1,$4)`,
    [workspace, connection, reply, userId],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_handoff_events(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,actor_id,reason,manual_paused_before,handoff_paused_before,handoff_paused_after)
     VALUES($1,$2,'900','123',$3,true,1,$4,'handoff_started',false,false,true)`,
    [workspace, connection, reply, userId],
  );
  const manual = (
    await pool.query(
      `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,status)
       VALUES($1,$2,'900',gen_random_uuid(),$3,'manual text',1,'failed') RETURNING id`,
      [workspace, connection, userId],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,status,retry_of,retry_reason)
     VALUES($1,$2,'900',gen_random_uuid(),$3,'manual retry',1,'pending',$4,'retry')`,
    [workspace, connection, userId, manual],
  );
  await pool.query(
    `INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,actor_id,request_key)
     VALUES($1,$2,'900',$3,'queued',$4,gen_random_uuid())`,
    [workspace, connection, manual, userId],
  );
  for (const [key, identity, purpose, decision] of [
    ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "123", "marketing", "grant"],
    ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "456", "marketing", "grant"],
    ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "456", "marketing", "revoke"],
  ] as const) {
    const eventId = (
      await pool.query(
        `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
         VALUES($1::uuid,$2,$3,'instagram','comment_sender',$4,$5,$6,'explicit','ref',now(),$7) RETURNING id`,
        [
          key.slice(0, 34) + key.slice(-1) + connection.slice(-1),
          workspace,
          connection,
          identity,
          purpose,
          decision,
          userId,
        ],
      )
    ).rows[0];
    await pool.query(
      `INSERT INTO channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
       SELECT workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,id
       FROM channel_consent_events WHERE id=$1
       ON CONFLICT(workspace_id,connection_id,channel,identity_kind,identity_value,purpose)
       DO UPDATE SET decision=EXCLUDED.decision,evidence_kind=EXCLUDED.evidence_kind,occurred_at=EXCLUDED.occurred_at,recorded_at=EXCLUDED.recorded_at,last_event_id=EXCLUDED.last_event_id`,
      [eventId.id],
    );
  }
}

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
    "INSERT INTO instagram_contact_fields(id,workspace_id,name,type) VALUES($1,$2,'city','text'),($3,$4,'city','text')",
    [fieldId, workspaceId, otherFieldId, otherWorkspaceId],
  );
  await seedConnection(connectionId, workspaceId, "account-deleted");
  await seedConnection(keptConnectionId, workspaceId, "account-kept");
  await seedConnection(foreignConnectionId, otherWorkspaceId, "account-foreign");
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

async function counts(connection: string) {
  const result: Record<string, number> = {};
  for (const table of connectionTables)
    result[table] = Number(
      (await pool.query(`SELECT count(*) FROM ${table} WHERE connection_id=$1`, [connection])).rows[0].count,
    );
  return result;
}

function deleteData(connection = connectionId, confirm = "account-deleted", actor = userId) {
  return request("POST", `/api/connections/${connection}/data-deletion`, { confirm_account_id: confirm }, actor);
}

test("connection deletion removes personal data, keeps revokes and records evidence", async () => {
  const response = await deleteData();
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    id: string;
    deleted_counts: Record<string, number>;
    retained_counts: Record<string, number>;
  };
  assert.equal(body.deleted_counts.instagram_comment_events, 1);
  assert.equal(body.deleted_counts.instagram_manual_replies, 2);
  assert.equal(body.deleted_counts.channel_consent_events, 2);
  assert.deepEqual(body.retained_counts, {
    carried_comment_sender_revokes: 0,
    channel_consent_events: 1,
    channel_consent_state: 1,
  });
  assert.ok(Object.values(await counts(connectionId)).every((count) => count === 0));

  const consent = await pool.query(
    "SELECT identity_value,decision FROM channel_consent_state WHERE connection_id=$1 ORDER BY identity_value",
    [connectionId],
  );
  assert.deepEqual(consent.rows, [{ identity_value: "456", decision: "revoke" }]);
  assert.equal(
    (await pool.query("SELECT count(*) FROM channel_consent_events WHERE connection_id=$1", [connectionId])).rows[0]
      .count,
    "1",
  );
  const kept = await pool.query(
    `SELECT (SELECT count(*) FROM instagram_connections WHERE id=$1)::int AS connection,
            (SELECT count(*) FROM instagram_comment_rules WHERE connection_id=$1)::int AS rules,
            (SELECT count(*) FROM instagram_contact_fields WHERE workspace_id=$2)::int AS fields`,
    [connectionId, workspaceId],
  );
  assert.deepEqual(kept.rows[0], { connection: 1, rules: 1, fields: 1 });
  assert.ok(Object.values(await counts(keptConnectionId)).every((count) => count > 0));
  assert.ok(Object.values(await counts(foreignConnectionId)).every((count) => count > 0));

  const record = await pool.query("SELECT * FROM data_deletion_records");
  assert.equal(record.rowCount, 1);
  assert.equal(record.rows[0].requested_by, userId);
  assert.deepEqual(Object.keys(record.rows[0]).sort(), [
    "completed_at",
    "connection_id",
    "deleted_counts",
    "id",
    "requested_by",
    "retained_counts",
    "scope",
    "workspace_id",
  ]);
  assert.equal(record.rows[0].scope, "connection");

  const list = (await (await request("GET", `/api/connections/${connectionId}/data-deletions`)).json()) as {
    deletions: { id: string }[];
  };
  assert.deepEqual(
    list.deletions.map((deletion) => deletion.id),
    [body.id],
  );
});

test("deletion refuses connected, confirmation-mismatched, in-flight and foreign connections", async () => {
  await pool.query("UPDATE instagram_connections SET active=true WHERE id=$1", [connectionId]);
  assert.deepEqual(await (await deleteData()).json(), { error: "connection_active" });
  await pool.query("UPDATE instagram_connections SET active=false,access_token_encrypted='token' WHERE id=$1", [
    connectionId,
  ]);
  const tokened = await deleteData();
  assert.equal(tokened.status, 409);
  assert.deepEqual(await tokened.json(), { error: "connection_active" });
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=NULL WHERE id=$1", [connectionId]);

  const mismatch = await deleteData(connectionId, "account-kept");
  assert.equal(mismatch.status, 409);
  assert.deepEqual(await mismatch.json(), { error: "confirmation_mismatch" });

  await pool.query(
    "UPDATE instagram_manual_replies SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE connection_id=$1 AND retry_of IS NOT NULL",
    [connectionId],
  );
  const sending = await deleteData();
  assert.equal(sending.status, 409);
  assert.deepEqual(await sending.json(), { error: "sending_in_progress" });

  const foreign = await deleteData(foreignConnectionId, "account-foreign");
  assert.equal(foreign.status, 404);
  assert.equal((await request("GET", `/api/connections/${foreignConnectionId}/data-deletions`)).status, 404);
  assert.equal((await pool.query("SELECT count(*) FROM data_deletion_records")).rows[0].count, "0");
  assert.ok(Object.values(await counts(connectionId)).every((count) => count > 0));
});

test("repeating a completed deletion succeeds with zero counts and a second record", async () => {
  assert.equal((await deleteData()).status, 200);
  const again = (await (await deleteData()).json()) as { deleted_counts: Record<string, number> };
  assert.ok(Object.values(again.deleted_counts).every((count) => count === 0));
  assert.equal((await pool.query("SELECT count(*) FROM data_deletion_records")).rows[0].count, "2");
});

test("invalid deletion requests are rejected before touching data", async () => {
  for (const body of [
    {},
    { confirm_account_id: "" },
    { confirm_account_id: 1 },
    { confirm_account_id: "x", extra: 1 },
  ]) {
    const response = await request("POST", `/api/connections/${connectionId}/data-deletion`, body);
    assert.equal(response.status, 400);
  }
  assert.equal((await pool.query("SELECT count(*) FROM data_deletion_records")).rows[0].count, "0");
});

test("deletion migration replays and the function stays owned outside server roles", async () => {
  // Replay every migration that (re)defines the function, in runner order, so later tests keep the current body.
  for (const file of ["018_connection_data_deletion.sql", "021_flow_runs.sql", "023_connection_deletion_locks.sql"]) {
    const migration = await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), "utf8");
    await pool.query(migration);
    await pool.query(migration);
  }
  const body = await pool.query(
    "SELECT pg_get_functiondef('public.delete_connection_data(uuid,uuid,uuid,text)'::regprocedure) AS body",
  );
  assert.match(body.rows[0].body, /ORDER BY id FOR UPDATE/);
  assert.match(body.rows[0].body, /flow_step_runs/);
  const definer = await pool.query(
    "SELECT prosecdef, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname='delete_connection_data'",
  );
  assert.equal(definer.rows[0].prosecdef, true);
  assert.equal((await deleteData()).status, 200);
});

test("a DM-recipient opt-out keeps blocking the bridged comment sender after deletion", async () => {
  const revoke = (
    await pool.query(
      `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
       VALUES(gen_random_uuid(),$1,$2,'instagram','dm_recipient','900','service_reply','revoke','inbound_dm','dm:stop',now(),$3) RETURNING id`,
      [workspaceId, connectionId, userId],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
     SELECT workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,id
     FROM channel_consent_events WHERE id=$1`,
    [revoke],
  );
  const scope = { workspaceId, connectionId, senderId: "123" };
  assert.equal(await deliveryRecipientOptedOut(pool, scope), true);
  const response = await deleteData();
  assert.equal(response.status, 200);
  const body = (await response.json()) as { retained_counts: Record<string, number> };
  assert.equal(body.retained_counts.carried_comment_sender_revokes, 1);
  assert.equal(
    (await pool.query("SELECT count(*) FROM private_reply_outbox WHERE connection_id=$1", [connectionId])).rows[0]
      .count,
    "0",
  );
  assert.equal(await deliveryRecipientOptedOut(pool, scope), true);
});

test("contact writes wait for an in-progress deletion and then find no contact", async () => {
  const deletion = await pool.connect();
  try {
    await deletion.query("BEGIN");
    await deletion.query("SELECT id FROM instagram_connections WHERE id=$1 FOR NO KEY UPDATE", [connectionId]);
    await deletion.query("DELETE FROM instagram_contact_tags WHERE connection_id=$1", [connectionId]);
    let settled = false;
    const pending = request("PATCH", `/api/connections/${connectionId}/contacts/123`, { tags: ["late"] }).finally(
      () => {
        settled = true;
      },
    );
    for (let attempt = 0; attempt < 100 && !settled; attempt += 1) {
      const waiting = await pool.query(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()",
      );
      if (waiting.rows[0].waiting > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The rest of the deletion, after its tag DELETE has already run.
    for (const table of [
      "instagram_manual_reply_events",
      "instagram_manual_replies",
      "instagram_inbox_handoff_events",
      "instagram_inbox_handoffs",
      "instagram_contact_automation",
      "instagram_contact_field_values",
      "instagram_follow_conversations",
      "private_reply_outbox",
      "instagram_comment_events",
    ])
      await deletion.query(`DELETE FROM ${table} WHERE connection_id=$1`, [connectionId]);
    await deletion.query("COMMIT");
    const response = await pending;
    assert.equal(response.status, 404);
  } finally {
    deletion.release();
  }
  assert.equal(
    (await pool.query("SELECT count(*) FROM instagram_contact_tags WHERE connection_id=$1", [connectionId])).rows[0]
      .count,
    "0",
  );
});

test("deletion waits for an uncommitted claim and refuses once it commits as sending", async () => {
  await pool.query("UPDATE private_reply_outbox SET status='pending' WHERE connection_id=$1", [connectionId]);
  const claim = await pool.connect();
  try {
    await claim.query("BEGIN");
    await claim.query(
      "UPDATE private_reply_outbox SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE connection_id=$1",
      [connectionId],
    );
    const outcome = pool
      .query("SELECT public.delete_connection_data($1,$2,$3,'account-deleted')", [workspaceId, connectionId, userId])
      .then(
        () => "deleted",
        (error: { code?: string }) => error.code,
      );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await claim.query("COMMIT");
    assert.equal(await outcome, "AC003");
  } finally {
    claim.release();
  }
  const kept = await pool.query("SELECT DISTINCT status FROM private_reply_outbox WHERE connection_id=$1", [
    connectionId,
  ]);
  assert.deepEqual(
    kept.rows.map((row) => row.status),
    ["sending"],
  );
});

test("deletion waits for a concurrently inserted delivery row and refuses once it commits as sending", async () => {
  const rule = (await pool.query("SELECT id FROM instagram_comment_rules WHERE connection_id=$1", [connectionId]))
    .rows[0].id;
  const event = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,'late-comment','1789','late-sender','late comment') RETURNING id`,
      [workspaceId, connectionId],
    )
  ).rows[0].id;
  const ingress = await pool.connect();
  try {
    await ingress.query("BEGIN");
    await ingress.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text,status,attempt_id,attempt_started_at)
       VALUES($1,$2,$3,$4,'late-comment','1789','late-sender','late reply','sending',gen_random_uuid(),now())`,
      [workspaceId, connectionId, event, rule],
    );
    const outcome = pool
      .query("SELECT public.delete_connection_data($1,$2,$3,'account-deleted')", [workspaceId, connectionId, userId])
      .then(
        () => "deleted",
        (error: { code?: string }) => error.code,
      );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await ingress.query("COMMIT");
    assert.equal(await outcome, "AC003");
  } finally {
    ingress.release();
  }
  const late = await pool.query("SELECT status FROM private_reply_outbox WHERE comment_id='late-comment'");
  assert.deepEqual(
    late.rows.map((row) => row.status),
    ["sending"],
  );
});
