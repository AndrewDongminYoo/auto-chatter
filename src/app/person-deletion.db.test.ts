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
const operatorId = "12121212-1212-4121-8121-121212121212";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const connectionId = "55555555-5555-4555-8555-555555555555";
const fieldId = "99999999-9999-4999-8999-999999999999";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

async function consent(kind: string, identity: string, purpose: string, decision: string) {
  const event = (
    await pool.query(
      `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
       VALUES(gen_random_uuid(),$1,$2,'instagram',$3,$4,$5,$6,'explicit','ref',now(),$7) RETURNING id`,
      [workspaceId, connectionId, kind, identity, purpose, decision, userId],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
     SELECT workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,id
     FROM channel_consent_events WHERE id=$1
     ON CONFLICT(workspace_id,connection_id,channel,identity_kind,identity_value,purpose)
     DO UPDATE SET decision=EXCLUDED.decision,evidence_kind=EXCLUDED.evidence_kind,occurred_at=EXCLUDED.occurred_at,recorded_at=EXCLUDED.recorded_at,last_event_id=EXCLUDED.last_event_id`,
    [event],
  );
}

async function seedCommenter(sender: string, recipient: string, rule: string, full: boolean) {
  const event = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,'1789',$4,'personal comment') RETURNING id`,
      [workspaceId, connectionId, `comment-${sender}`, sender],
    )
  ).rows[0].id;
  const reply = (
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text,recipient_id,status,provider_message_id,sent_at)
       VALUES($1,$2,$3,$4,$5,'1789',$6,'reply','${recipient}','sent','mid-${sender}',now()) RETURNING id`,
      [workspaceId, connectionId, event, rule, `comment-${sender}`, sender],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,$4,'personal dm','text',now())`,
    [workspaceId, connectionId, recipient, `dm-${recipient}`],
  );
  await pool.query(
    `INSERT INTO instagram_unmatched_replies(workspace_id,connection_id,sender_id,message_id,message_text,message_at)
     VALUES($1,$2,$3,$4,'kept dm',now())`,
    [workspaceId, connectionId, recipient, `kept-${recipient}`],
  );
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,'{vip}')",
    [workspaceId, connectionId, sender],
  );
  if (!full) return;
  await pool.query(
    `INSERT INTO instagram_follow_conversations(reply_id,connection_id,recipient_id,confirmation_keyword,follower_reply_text,non_follower_reply_text,status)
     VALUES($1,$2,$3,'ok','yes','no','sent')`,
    [reply, connectionId, recipient],
  );
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused,handoff_paused) VALUES($1,$2,$3,false,true)",
    [workspaceId, connectionId, sender],
  );
  await pool.query(
    `INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,$3,$4,'"Seoul"')`,
    [workspaceId, connectionId, sender, fieldId],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
     VALUES($1,$2,$3,$4,$5,true,1,$6)`,
    [workspaceId, connectionId, recipient, sender, reply, userId],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_handoff_events(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,actor_id,reason,manual_paused_before,handoff_paused_before,handoff_paused_after)
     VALUES($1,$2,$3,$4,$5,true,1,$6,'handoff_started',false,false,true)`,
    [workspaceId, connectionId, recipient, sender, reply, userId],
  );
  const manual = (
    await pool.query(
      `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,status)
       VALUES($1,$2,$3,gen_random_uuid(),$4,'manual text',1,'failed') RETURNING id`,
      [workspaceId, connectionId, recipient, userId],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,actor_id,request_key)
     VALUES($1,$2,$3,$4,'queued',$5,gen_random_uuid())`,
    [workspaceId, connectionId, recipient, manual, userId],
  );
}

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2)", [workspaceId, userId]);
  await pool.query("INSERT INTO instagram_contact_fields(id,workspace_id,name,type) VALUES($1,$2,'city','text')", [
    fieldId,
    workspaceId,
  ]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,send_enabled,access_token_encrypted)
     VALUES($1,$2,'person-account',true,true,'token')`,
    [connectionId, workspaceId],
  );
  const rule = (
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,keywords,private_reply_text,enabled)
       VALUES(gen_random_uuid(),$1,$2,'1789','link','{link}','reply',true) RETURNING id`,
      [workspaceId, connectionId],
    )
  ).rows[0].id;
  await seedCommenter("123", "900", rule, true);
  await seedCommenter("456", "901", rule, false);
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,'902','dm-902','dm only person','text',now())`,
    [workspaceId, connectionId],
  );
  // A commenter who never received a reply must survive every other person's deletion.
  await pool.query(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     VALUES($1,$2,'comment-789','1789','789','unanswered comment')`,
    [workspaceId, connectionId],
  );
  await consent("comment_sender", "123", "marketing", "grant");
  await consent("dm_recipient", "900", "service_reply", "revoke");
  await consent("comment_sender", "456", "marketing", "grant");
  await consent("dm_recipient", "902", "marketing", "grant");
});

after(async () => pool.end());

function deletePerson(kind: string, identity: string, workspace = workspaceId, connection = connectionId) {
  return pool.query<{
    result: { id: string; deleted_counts: Record<string, number>; retained_counts: Record<string, number> };
  }>("SELECT public.delete_person_data($1,$2,$3,$4,$5) AS result", [workspace, connection, operatorId, kind, identity]);
}

async function personRows(sender: string, recipient: string) {
  const result = await pool.query(
    `SELECT
      (SELECT count(*) FROM instagram_comment_events WHERE connection_id=$1 AND sender_id=$2)::int
      +(SELECT count(*) FROM private_reply_outbox WHERE connection_id=$1 AND sender_id=$2)::int
      +(SELECT count(*) FROM instagram_contact_tags WHERE connection_id=$1 AND sender_id=$2)::int
      +(SELECT count(*) FROM instagram_contact_automation WHERE connection_id=$1 AND sender_id=$2)::int
      +(SELECT count(*) FROM instagram_contact_field_values WHERE connection_id=$1 AND sender_id=$2)::int
      +(SELECT count(*) FROM instagram_follow_conversations WHERE connection_id=$1 AND recipient_id=$3)::int
      +(SELECT count(*) FROM instagram_inbox_messages WHERE connection_id=$1 AND recipient_id=$3)::int
      +(SELECT count(*) FROM instagram_unmatched_replies WHERE connection_id=$1 AND sender_id=$3)::int
      +(SELECT count(*) FROM instagram_inbox_handoffs WHERE connection_id=$1 AND recipient_id=$3)::int
      +(SELECT count(*) FROM instagram_inbox_handoff_events WHERE connection_id=$1 AND recipient_id=$3)::int
      +(SELECT count(*) FROM instagram_manual_replies WHERE connection_id=$1 AND recipient_id=$3)::int
      +(SELECT count(*) FROM instagram_manual_reply_events WHERE connection_id=$1 AND recipient_id=$3)::int AS rows`,
    [connectionId, sender, recipient],
  );
  return result.rows[0].rows as number;
}

for (const [kind, identity] of [
  ["comment_sender", "123"],
  ["dm_recipient", "900"],
] as const)
  test(`deleting by ${kind} removes the bridged person and keeps everyone else`, async () => {
    assert.ok((await personRows("123", "900")) > 0);
    const before456 = await personRows("456", "901");
    const { result } = (await deletePerson(kind, identity)).rows[0]!;
    assert.equal(await personRows("123", "900"), 0);
    assert.equal(await personRows("456", "901"), before456);
    assert.equal(
      (await pool.query("SELECT count(*) FROM instagram_comment_events WHERE sender_id='789'")).rows[0].count,
      "1",
    );
    assert.equal(
      (await pool.query("SELECT count(*) FROM instagram_inbox_messages WHERE recipient_id='902'")).rows[0].count,
      "1",
    );
    assert.equal(result.deleted_counts.instagram_comment_events, 1);
    assert.equal(result.deleted_counts.instagram_unmatched_replies, 1);
    assert.equal(result.deleted_counts.channel_consent_state, 1);
    assert.equal(result.retained_counts.carried_comment_sender_revokes, 1);

    const states = await pool.query(
      "SELECT identity_kind,identity_value,decision FROM channel_consent_state WHERE connection_id=$1 ORDER BY identity_kind,identity_value",
      [connectionId],
    );
    assert.deepEqual(states.rows, [
      { identity_kind: "comment_sender", identity_value: "123", decision: "revoke" },
      { identity_kind: "comment_sender", identity_value: "456", decision: "grant" },
      { identity_kind: "dm_recipient", identity_value: "900", decision: "revoke" },
      { identity_kind: "dm_recipient", identity_value: "902", decision: "grant" },
    ]);
    assert.equal(await deliveryRecipientOptedOut(pool, { workspaceId, connectionId, senderId: "123" }), true);
    const record = await pool.query("SELECT scope,requested_by,connection_id FROM data_deletion_records");
    assert.deepEqual(record.rows, [{ scope: "person", requested_by: operatorId, connection_id: connectionId }]);
    const connection = await pool.query("SELECT active,send_enabled FROM instagram_connections WHERE id=$1", [
      connectionId,
    ]);
    assert.deepEqual(connection.rows[0], { active: true, send_enabled: true });
  });

test("a commenter bridged only by an acknowledged reply loses their DM records too", async () => {
  await deletePerson("comment_sender", "456");
  assert.equal(await personRows("456", "901"), 0);
  assert.ok((await personRows("123", "900")) > 0);
  assert.equal(
    (await pool.query("SELECT count(*) FROM instagram_comment_events WHERE sender_id='789'")).rows[0].count,
    "1",
  );
});

test("every acknowledged recipient of the person keeps blocking the comment sender", async () => {
  const rule = (await pool.query("SELECT id FROM instagram_comment_rules LIMIT 1")).rows[0].id;
  const event = (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,'comment-123-b','1790','123','second comment') RETURNING id`,
      [workspaceId, connectionId],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,private_reply_text,recipient_id,status,provider_message_id,sent_at)
     VALUES($1,$2,$3,$4,'comment-123-b','1790','123','reply','905','sent','mid-123-b',now())`,
    [workspaceId, connectionId, event, rule],
  );
  await consent("dm_recipient", "905", "marketing", "revoke");
  const { result } = (await deletePerson("dm_recipient", "900")).rows[0]!;
  assert.equal(result.retained_counts.carried_comment_sender_revokes, 2);
  const carried = await pool.query(
    "SELECT purpose FROM channel_consent_state WHERE identity_kind='comment_sender' AND identity_value='123' AND decision='revoke' ORDER BY purpose",
  );
  assert.deepEqual(
    carried.rows.map((row) => row.purpose),
    ["marketing", "service_reply"],
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM private_reply_outbox WHERE sender_id='123'")).rows[0].count,
    "0",
  );
});

test("a send claimed while the deletion waits is refused instead of deleted", async () => {
  await pool.query(
    "UPDATE private_reply_outbox SET status='pending',provider_message_id=NULL,sent_at=NULL WHERE sender_id='456'",
  );
  const worker = await pool.connect();
  try {
    await worker.query("BEGIN");
    await worker.query("SELECT id FROM private_reply_outbox WHERE sender_id='456' FOR UPDATE");
    await worker.query(
      "UPDATE private_reply_outbox SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE sender_id='456'",
    );
    let settled = false;
    const deletion = deletePerson("comment_sender", "456").then(
      () => {
        settled = true;
        return "deleted";
      },
      (error: { code?: string }) => {
        settled = true;
        return error.code;
      },
    );
    for (let attempt = 0; attempt < 100 && !settled; attempt += 1) {
      const waiting = await pool.query(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()",
      );
      if (waiting.rows[0].waiting > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await worker.query("COMMIT");
    assert.equal(await deletion, "AC003");
  } finally {
    worker.release();
  }
  assert.equal(
    (await pool.query("SELECT status FROM private_reply_outbox WHERE sender_id='456'")).rows[0].status,
    "sending",
  );
  assert.equal((await pool.query("SELECT count(*) FROM data_deletion_records")).rows[0].count, "0");
});

test("a reply confirmed while the deletion waits joins the person before deletion", async () => {
  await pool.query(
    "UPDATE private_reply_outbox SET status='sending',recipient_id=NULL,provider_message_id=NULL,sent_at=NULL,attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE sender_id='456'",
  );
  await consent("dm_recipient", "901", "marketing", "revoke");
  const worker = await pool.connect();
  try {
    await worker.query("BEGIN");
    await worker.query("SELECT id FROM private_reply_outbox WHERE sender_id='456' FOR UPDATE");
    await worker.query(
      "UPDATE private_reply_outbox SET status='sent',recipient_id='901',provider_message_id='mid-late',sent_at=now(),attempt_id=NULL,attempt_started_at=NULL WHERE sender_id='456'",
    );
    let settled = false;
    const deletion = deletePerson("comment_sender", "456").finally(() => {
      settled = true;
    });
    for (let attempt = 0; attempt < 100 && !settled; attempt += 1) {
      const waiting = await pool.query(
        "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()",
      );
      if (waiting.rows[0].waiting > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await worker.query("COMMIT");
    const { result } = (await deletion).rows[0]!;
    assert.equal(result.retained_counts.carried_comment_sender_revokes, 1);
  } finally {
    worker.release();
  }
  assert.equal(
    (await pool.query("SELECT count(*) FROM instagram_inbox_messages WHERE recipient_id='901'")).rows[0].count,
    "0",
  );
  assert.equal(await deliveryRecipientOptedOut(pool, { workspaceId, connectionId, senderId: "456" }), false);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM channel_consent_state WHERE identity_kind='comment_sender' AND identity_value='456' AND decision='revoke'",
      )
    ).rows[0].count,
    "1",
  );
});

test("a DM-only person without a reply bridge loses only their DM records and grants", async () => {
  const { result } = (await deletePerson("dm_recipient", "902")).rows[0]!;
  assert.equal(result.deleted_counts.instagram_inbox_messages, 1);
  assert.equal(result.deleted_counts.channel_consent_state, 1);
  assert.equal(result.deleted_counts.instagram_comment_events, 0);
  assert.equal(result.retained_counts.carried_comment_sender_revokes, 0);
  assert.ok((await personRows("123", "900")) > 0);
  assert.ok((await personRows("456", "901")) > 0);
});

test("person deletion refuses in-flight sends, foreign workspaces and unknown identity kinds", async () => {
  await pool.query(
    "UPDATE instagram_manual_replies SET status='sending',attempt_id=gen_random_uuid(),attempt_started_at=now() WHERE recipient_id='900'",
  );
  await assert.rejects(deletePerson("comment_sender", "123"), { code: "AC003" });
  await pool.query("UPDATE instagram_manual_replies SET status='failed' WHERE recipient_id='900'");
  await assert.rejects(deletePerson("comment_sender", "123", otherWorkspaceId), { code: "AC001" });
  await assert.rejects(deletePerson("follower", "123"), { code: "AC005" });
  await assert.rejects(deletePerson("comment_sender", " "), { code: "AC005" });
  assert.equal((await pool.query("SELECT count(*) FROM data_deletion_records")).rows[0].count, "0");
  assert.ok((await personRows("123", "900")) > 0);
});

test("repeating a person deletion records zero counts", async () => {
  await deletePerson("comment_sender", "123");
  const { result } = (await deletePerson("comment_sender", "123")).rows[0]!;
  assert.ok(Object.values(result.deleted_counts).every((count) => count === 0));
  assert.equal(
    (await pool.query("SELECT count(*) FROM data_deletion_records WHERE scope='person'")).rows[0].count,
    "2",
  );
});

test("the deletion list shows the scope of each record without identifiers", async () => {
  await deletePerson("comment_sender", "456");
  const response = await appApi(
    new Request(`https://app.test/api/connections/${connectionId}/data-deletions`, {
      headers: { cookie: "__Host-ac-access=test" },
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () =>
      Response.json({
        id: userId,
        email: "a@example.test",
        email_confirmed_at: "2026-09-25",
      })) as unknown as typeof fetch,
  );
  const body = (await response.json()) as { deletions: Record<string, unknown>[] };
  assert.equal(body.deletions.length, 1);
  assert.equal(body.deletions[0]!.scope, "person");
  assert.doesNotMatch(JSON.stringify(body), /"456"|"901"/);
});

test("person deletion migration replays and the function is not a security definer", async () => {
  const migration = await readFile(
    new URL("../../db/migrations/019_person_data_deletion.sql", import.meta.url),
    "utf8",
  );
  // Replay in runner order: 021 redefines the function, so replaying 019 alone would leave the older body
  // (without flow run deletes) in place for any test that runs after this one.
  const flowRuns = await readFile(new URL("../../db/migrations/021_flow_runs.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(flowRuns);
  await pool.query(migration);
  await pool.query(flowRuns);
  const fn = await pool.query("SELECT prosecdef, prosrc FROM pg_proc WHERE proname='delete_person_data'");
  assert.equal(fn.rows[0].prosecdef, false);
  assert.match(fn.rows[0].prosrc, /flow_step_runs/);
  assert.equal((await pool.query("SELECT count(*) FROM data_deletion_records WHERE scope IS NULL")).rows[0].count, "0");
});
