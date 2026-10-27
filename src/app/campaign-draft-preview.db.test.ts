import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool, type QueryConfig } from "pg";
import { appApi } from "./api.ts";
import { recordChannelConsentEvent } from "../instagram/channel-consent.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl });
const workspace = "11111111-1111-4111-8111-111111111111";
const foreignWorkspace = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const OFF = "44444444-4444-4444-8444-444444444444";
const FC = "88888888-8888-4888-8888-888888888888";
const owner = "55555555-5555-4555-8555-555555555555";
const agent = "66666666-6666-4666-8666-666666666666";
const outsider = "77777777-7777-4777-8777-777777777777";
const REASONS = [
  "connection_unavailable",
  "contact_paused",
  "no_dm_identity",
  "opted_out",
  "marketing_consent_required",
  "reply_window_closed",
  "candidate",
];
let sequence = 0;
let pinnedAsOf: string | null = null;
before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  pinnedAsOf = null;
  await pool.query("TRUNCATE workspaces,workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspace, foreignWorkspace]);
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')",
    [workspace, owner, agent, foreignWorkspace, outsider],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,inbox_enabled,inbox_enabled_at,active,send_enabled,access_token_encrypted,token_expires_at)
     VALUES($1,$3,'100',true,now()-interval '1 day',true,true,'CIPHERTEXT',now()+interval '30 days'),
       ($2,$3,'101',true,now()-interval '1 day',true,false,'CIPHERTEXT',now()+interval '30 days'),
       ($4,$5,'102',true,now()-interval '1 day',true,true,'CIPHERTEXT',now()+interval '30 days')`,
    [C, OFF, workspace, FC, foreignWorkspace],
  );
});
after(async () => pool.end());

// Pins the preview's one evaluation clock; the verified bridge keeps reading the real clock (now()).
function clockedPool(): Pool {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (input: string | QueryConfig, values?: unknown[]) => {
          const query = typeof input === "string" ? { text: input, values } : input;
          if (query.text.includes("statement_timestamp()")) {
            assert.equal(query.text.match(/statement_timestamp\(\)/g)?.length, 1, "one evaluation clock");
            if (pinnedAsOf)
              return client.query({
                ...query,
                text: query.text.replace("statement_timestamp()", `'${pinnedAsOf}'::timestamptz`),
              });
          }
          return client.query(query);
        },
        release: (destroy?: boolean | Error) => client.release(destroy),
      };
    },
    end: async () => {},
  } as unknown as Pool;
}
async function request(path: string, actor = owner, sendEnabled = "false") {
  return appApi(
    new Request(`https://app.test${path}`, {
      method: "GET",
      headers: { cookie: "__Host-ac-access=test", origin: "https://app.test" },
    }),
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      SEND_ENABLED: sendEnabled,
      API_WRITE_USER_LIMIT: { limit: async () => ({ success: true }) },
      API_WRITE_WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
    },
    clockedPool,
    (async () =>
      Response.json({ id: actor, email: "member@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}
async function preview(draft: string, status = 200, actor = owner, sendEnabled = "false") {
  const response = await request(`/api/campaign-drafts/${draft}/preview`, actor, sendEnabled);
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body;
}
async function comment(sender: string, conn = C, ws = workspace) {
  sequence++;
  return (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,$3,$4,'PRIVATE COMMENT BODY') RETURNING id::text,comment_id,media_id`,
      [ws, conn, `comment-${sequence}`, sender],
    )
  ).rows[0];
}
// A provider-acknowledged private reply from the sender's comment to the recipient, sent an hour ago (fresh).
async function bridge(sender: string, recipient: string, conn = C, ws = workspace) {
  const event = await comment(sender, conn, ws);
  const rule = (
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text)
       VALUES(gen_random_uuid(),$1,$2,$3,'hello','PRIVATE SEND BODY') RETURNING id`,
      [ws, conn, event.media_id],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,
       private_reply_text,recipient_id,status,provider_message_id,sent_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'PRIVATE SEND BODY',$8,'sent','acknowledged',now()-interval '1 hour')`,
    [ws, conn, event.id, rule, event.comment_id, event.media_id, sender, recipient],
  );
}
async function message(recipient: string, at: string, kind = "text", conn = C, ws = workspace) {
  sequence++;
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,$4,'PRIVATE DM BODY',$5,$6::timestamptz)`,
    [ws, conn, recipient, `dm-${sequence}`, kind, at],
  );
}
const ago = async (interval: string) =>
  (await pool.query("SELECT (now()-$1::interval)::text AS at", [interval])).rows[0].at as string;
async function consent(
  identityKind: "comment_sender" | "dm_recipient",
  identityValue: string,
  purpose: "service_reply" | "marketing" | "all",
  decision: "grant" | "revoke",
  evidenceKind: "explicit" | "import" = "explicit",
  conn = C,
) {
  await recordChannelConsentEvent(pool, {
    requestKey: randomUUID(),
    workspaceId: workspace,
    connectionId: conn,
    channel: "instagram",
    identityKind,
    identityValue,
    purpose,
    decision,
    evidenceKind,
    evidenceReference: "test",
    occurredAt: new Date(),
    actorId: owner,
  });
}
// A recipient that passes every recipient-level check: explicit marketing grant and a text DM an hour ago.
async function qualifying(sender: string, recipient: string, conn = C) {
  await bridge(sender, recipient, conn);
  await message(recipient, await ago("1 hour"), "text", conn);
  await consent("dm_recipient", recipient, "marketing", "grant", "explicit", conn);
}
async function paused(sender: string, conn = C, column = "paused") {
  await pool.query(
    `INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,${column}) VALUES($1,$2,$3,true)`,
    [workspace, conn, sender],
  );
}
// Freezes the given members into a snapshot and returns a draft that references it.
async function draftFor(members: Array<[string, string]>, ws = workspace, actor = owner, archived = false) {
  const segment = (
    await pool.query("INSERT INTO instagram_contact_segments(workspace_id,name) VALUES($1,$2) RETURNING id", [
      ws,
      `Audience ${++sequence}`,
    ])
  ).rows[0]!.id;
  const snapshot = (
    await pool.query(
      `INSERT INTO instagram_segment_snapshots(workspace_id,segment_id,created_by,as_of,definition,segment_name,counts,member_count)
       VALUES($1,$2,$3,now(),'{}','Audience','{}',$4) RETURNING id`,
      [ws, segment, actor, members.length],
    )
  ).rows[0]!.id as string;
  for (const [conn, sender] of members)
    await pool.query(
      "INSERT INTO instagram_segment_snapshot_members(snapshot_id,workspace_id,connection_id,sender_id) VALUES($1,$2,$3,$4)",
      [snapshot, ws, conn, sender],
    );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO campaign_drafts(id,workspace_id,snapshot_id,name,body,create_request_hash,created_by,updated_by,archived)
     VALUES($1,$2,$3,'Campaign','Hello',repeat('0',64),$4,$4,$5)`,
    [id, ws, snapshot, actor, archived],
  );
  return id;
}
function assertCounts(body: Record<string, any>, expected: Partial<Record<string, number>>) {
  const counts = Object.fromEntries(REASONS.map((reason) => [reason, String(expected[reason] ?? 0)]));
  assert.deepEqual(body.counts, counts);
  const sum = Object.values(body.counts as Record<string, string>).reduce((total, value) => total + Number(value), 0);
  assert.equal(String(sum), body.remaining_member_count);
}

test("each member gets exactly one reason, and the first applicable reason wins", async () => {
  // connection_unavailable: the send switch is off, even though the contact is also paused and qualifying.
  await qualifying("1001", "2001", OFF);
  await paused("1001", OFF);
  // contact_paused: manual pause, and a derived handoff pause, both before the missing identity of 1003.
  await qualifying("1002", "2002");
  await paused("1002");
  await paused("1003", C, "handoff_paused");
  // no_dm_identity: no bridge at all; and a recipient bridged from two senders is ambiguous for both.
  await bridge("1004", "2004");
  await bridge("9999", "2004");
  await message("2004", await ago("1 hour"));
  await consent("dm_recipient", "2004", "marketing", "grant");
  await comment("1005");
  // opted_out: a recipient-level marketing revoke, and a comment-sender service revoke over a qualifying recipient.
  await bridge("1006", "2006");
  await message("2006", await ago("1 hour"));
  await consent("dm_recipient", "2006", "marketing", "revoke");
  await qualifying("1007", "2007");
  await consent("comment_sender", "1007", "service_reply", "revoke");
  // An all-purpose revoke is projected onto both purposes.
  await qualifying("1008", "2008");
  await consent("dm_recipient", "2008", "all", "revoke");
  // marketing_consent_required: no grant; an imported grant is not explicit; a comment-sender grant is not the scope.
  await bridge("1009", "2009");
  await message("2009", await ago("1 hour"));
  await bridge("1010", "2010");
  await message("2010", await ago("1 hour"));
  await consent("dm_recipient", "2010", "marketing", "grant", "import");
  await bridge("1011", "2011");
  await message("2011", await ago("1 hour"));
  await consent("comment_sender", "1011", "marketing", "grant");
  // reply_window_closed: the last text DM is 25 hours old; a recent postback does not open the window.
  await bridge("1012", "2012");
  await message("2012", await ago("25 hours"));
  await message("2012", await ago("1 minute"), "postback");
  await consent("dm_recipient", "2012", "marketing", "grant");
  // candidate.
  await qualifying("1013", "2013");
  const draft = await draftFor(
    ["1001"]
      .map((sender) => [OFF, sender] as [string, string])
      .concat(
        ["1002", "1003", "1004", "1005", "1006", "1007", "1008", "1009", "1010", "1011", "1012", "1013"].map(
          (sender) => [C, sender] as [string, string],
        ),
      ),
  );
  const body = await preview(draft);
  assertCounts(body, {
    connection_unavailable: 1,
    contact_paused: 2,
    no_dm_identity: 2,
    opted_out: 3,
    marketing_consent_required: 3,
    reply_window_closed: 1,
    candidate: 1,
  });
  assert.equal(body.draft_id, draft);
  assert.equal(body.draft_version, 1);
  assert.equal(body.archived, false);
  assert.equal(body.original_member_count, "13");
  assert.equal(body.remaining_member_count, "13");
  assert.match(body.as_of, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  assert.equal(body.estimated_provider_calls, "1");
  assert.equal(body.plan_broadcast_limit, null);
  assert.equal(body.channel_marketing_supported, true);
  assert.equal(body.global_send_enabled, false);
  assert.equal(body.candidate_meaning, "passed_recorded_conditions_at_as_of");
  assert.equal(body.sendability_claimed, false);
  assert.equal((await preview(draft, 200, owner, "true")).global_send_enabled, true);
});

test("each connection condition alone makes a member's connection unavailable", async () => {
  const members: Array<[string, string]> = [];
  for (const [index, change] of [
    "active=false",
    "access_token_encrypted=NULL",
    "token_expires_at=now()-interval '1 second'",
    "token_expires_at=NULL",
  ].entries()) {
    const conn = randomUUID();
    await pool.query(
      `INSERT INTO instagram_connections(id,workspace_id,account_id,inbox_enabled,inbox_enabled_at,active,send_enabled,access_token_encrypted,token_expires_at)
       VALUES($1,$2,$3,true,now()-interval '1 day',true,true,'CIPHERTEXT',now()+interval '30 days')`,
      [conn, workspace, String(200 + index)],
    );
    await qualifying("3001", "4001", conn);
    await pool.query(`UPDATE instagram_connections SET ${change} WHERE id=$1`, [conn]);
    members.push([conn, "3001"]);
  }
  assertCounts(await preview(await draftFor(members)), { connection_unavailable: 4 });
});

test("the reply window is open just inside 24 hours and closed at exactly 24 hours", async () => {
  const asOf = (await pool.query("SELECT now()::text AS at")).rows[0].at as string;
  pinnedAsOf = asOf;
  const at = async (offset: string) =>
    (await pool.query("SELECT ($1::timestamptz+$2::interval)::text AS at", [asOf, offset])).rows[0].at as string;
  for (const [sender, recipient, offset] of [
    ["5001", "6001", "-24 hours"],
    ["5002", "6002", "-24 hours -1 microsecond"],
    ["5003", "6003", "-24 hours 1 microsecond"],
    ["5004", "6004", "1 microsecond"],
  ] as const) {
    await bridge(sender, recipient);
    await message(recipient, await at(offset));
    await consent("dm_recipient", recipient, "marketing", "grant");
  }
  const body = await preview(
    await draftFor([
      [C, "5001"],
      [C, "5002"],
      [C, "5003"],
      [C, "5004"],
    ]),
  );
  // Exactly 24 hours and older are closed, just inside is open, and a future DM opens nothing.
  assertCounts(body, { reply_window_closed: 3, candidate: 1 });
  assert.equal(new Date(body.as_of).getTime(), new Date(asOf).getTime());
});

test("a sender's reason is the furthest stage its best verified recipient reaches", async () => {
  // Two recipients, only one qualifies: candidate.
  await bridge("7001", "8001");
  await message("8001", await ago("1 hour"));
  await qualifying("7001", "8002");
  // One opted out, one granted but outside the window: the window recipient is further, so reply_window_closed.
  await bridge("7002", "8003");
  await message("8003", await ago("1 hour"));
  await consent("dm_recipient", "8003", "service_reply", "revoke");
  await bridge("7002", "8004");
  await message("8004", await ago("2 days"));
  await consent("dm_recipient", "8004", "marketing", "grant");
  // One opted out, one without a grant: marketing_consent_required.
  await bridge("7003", "8005");
  await message("8005", await ago("1 hour"));
  await consent("dm_recipient", "8005", "marketing", "revoke");
  await bridge("7003", "8006");
  await message("8006", await ago("1 hour"));
  // Every recipient opted out: opted_out.
  await bridge("7004", "8007");
  await message("8007", await ago("1 hour"));
  await consent("dm_recipient", "8007", "marketing", "revoke");
  await bridge("7004", "8008");
  await message("8008", await ago("1 hour"));
  await consent("dm_recipient", "8008", "service_reply", "revoke");
  // An ambiguous recipient beside a qualifying one does not remove the qualifying one.
  await qualifying("7005", "8009");
  await bridge("7005", "8010");
  await bridge("7999", "8010");
  await message("8010", await ago("1 hour"));
  const body = await preview(
    await draftFor([
      [C, "7001"],
      [C, "7002"],
      [C, "7003"],
      [C, "7004"],
      [C, "7005"],
    ]),
  );
  assertCounts(body, { candidate: 2, reply_window_closed: 1, marketing_consent_required: 1, opted_out: 1 });
});

test("only active admins of the draft's workspace preview it, archived drafts included", async () => {
  await qualifying("1013", "2013");
  const draft = await draftFor([[C, "1013"]]);
  assert.equal((await preview(draft, 403, agent)).error, "role_forbidden");
  const foreign = await draftFor([[FC, "1"]], foreignWorkspace, outsider);
  for (const id of [foreign, randomUUID(), "not-a-uuid"])
    assert.equal((await preview(id, 404)).error, "campaign_draft_not_found");
  assert.equal((await preview(draft, 404, outsider)).error, "campaign_draft_not_found");
  // An agent gets 403 before the ID is looked at, so a malformed ID reveals nothing either.
  assert.equal((await preview("not-a-uuid", 403, agent)).error, "role_forbidden");
  const query = await request(`/api/campaign-drafts/${draft}/preview?x=1`);
  assert.equal(query.status, 400);
  assert.equal(query.headers.get("cache-control"), "no-store");
  const posted = await appApi(
    new Request(`https://app.test/api/campaign-drafts/${draft}/preview`, {
      method: "POST",
      headers: { cookie: "__Host-ac-access=test", origin: "https://app.test", "content-type": "application/json" },
      body: "{}",
    }),
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      API_WRITE_USER_LIMIT: { limit: async () => ({ success: true }) },
      API_WRITE_WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
    },
    clockedPool,
    (async () =>
      Response.json({ id: owner, email: "member@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
  assert.equal(posted.status, 404);
  assert.equal(posted.headers.get("cache-control"), "no-store");
  const archived = await draftFor([[C, "1013"]], workspace, owner, true);
  const body = await preview(archived.toUpperCase());
  assert.equal(body.archived, true);
  assert.equal(body.draft_id, archived);
  assertCounts(body, { candidate: 1 });
});

test("counts sum to the remaining members after a person deletion, and the preview writes nothing", async () => {
  await qualifying("1013", "2013");
  await qualifying("1014", "2014");
  await bridge("1015", "2015");
  await message("2015", await ago("1 hour"));
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,'1015',false)",
    [workspace, C],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by)
     SELECT $1,$2,'2015','1015',id,false,1,$3 FROM private_reply_outbox WHERE workspace_id=$1 AND sender_id='1015'`,
    [workspace, C, owner],
  );
  await pool.query(
    `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,status)
     VALUES($1,$2,'2015',gen_random_uuid(),$3,'manual text',1,'failed')`,
    [workspace, C, owner],
  );
  const draft = await draftFor([
    [C, "1013"],
    [C, "1014"],
    [C, "1015"],
  ]);
  const tables = [
    "private_reply_outbox",
    "instagram_manual_replies",
    "channel_consent_events",
    "channel_consent_state",
    "instagram_segment_snapshot_members",
    "campaign_drafts",
  ];
  const state = async () => {
    const result: Record<string, unknown> = {};
    for (const table of tables) {
      const row = (
        await pool.query(
          `SELECT count(*)::int AS rows,md5(coalesce(string_agg(t::text,',' ORDER BY t::text),'')) AS hash
           FROM ${table} t WHERE t.workspace_id=$1`,
          [workspace],
        )
      ).rows[0];
      assert.ok(row.rows > 0, `${table} fixture must contain data`);
      result[table] = row;
    }
    return result;
  };
  const before = await state();
  assertCounts(await preview(draft), { candidate: 2, marketing_consent_required: 1 });
  assert.deepEqual(await state(), before);
  await pool.query("SELECT delete_person_data($1,$2,$3,'comment_sender','1013')", [workspace, C, owner]);
  const body = await preview(draft);
  assert.equal(body.original_member_count, "3");
  assert.equal(body.remaining_member_count, "2");
  assertCounts(body, { candidate: 1, marketing_consent_required: 1 });
});
