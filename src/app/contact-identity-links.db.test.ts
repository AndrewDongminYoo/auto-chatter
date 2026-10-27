import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool, type PoolClient } from "pg";
import { appApi } from "./api.ts";
import { deliveryRecipientOptedOut, recordChannelConsentEvent } from "../instagram/channel-consent.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl });
const workspace = "11111111-1111-4111-8111-111111111111";
const foreignWorkspace = "22222222-2222-4222-8222-222222222222";
const connection = "33333333-3333-4333-8333-333333333333";
const foreignConnection = "44444444-4444-4444-8444-444444444444";
const owner = "55555555-5555-4555-8555-555555555555";
const agent = "66666666-6666-4666-8666-666666666666";
const outsider = "77777777-7777-4777-8777-777777777777";
const sender = "12345678901234567890";
let sequence = 0;
let inspect: ((client: PoolClient, sql: string) => Promise<void>) | undefined;
let evidence: string;
before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  inspect = undefined;
  await pool.query("TRUNCATE workspaces,workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspace, foreignWorkspace]);
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')",
    [workspace, owner, agent, foreignWorkspace, outsider],
  );
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,inbox_enabled,inbox_enabled_at) VALUES($1,$2,'100',true,now()-interval '1 day'),($3,$4,'101',true,now()-interval '1 day')",
    [connection, workspace, foreignConnection, foreignWorkspace],
  );
  evidence = await bridge("200");
  await message("200");
});
after(async () => pool.end());
function linkPath(id = sender, conn = connection) {
  return `/api/connections/${conn}/contacts/${id}/identity-links`;
}
function confirm(version = 0, reply = evidence) {
  return { action: "confirm", request_key: randomUUID(), expected_version: version, evidence_reply_id: reply };
}
function detach(version = 1) {
  return { action: "detach", request_key: randomUUID(), expected_version: version };
}
async function request(body?: unknown, actor = owner, path = linkPath() + (body === undefined ? "" : "/200")) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: "__Host-ac-access=test", origin: "https://app.test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      API_WRITE_USER_LIMIT: { limit: async () => ({ success: true }) },
      API_WRITE_WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
    },
    () =>
      ({
        query: pool.query.bind(pool),
        connect: async () => {
          const client = await pool.connect();
          return {
            query: async (sql: string, values?: unknown[]) => {
              const result = await client.query(sql, values);
              await inspect?.(client, sql);
              return result;
            },
            release: () => client.release(),
          };
        },
        end: async () => {},
      }) as unknown as Pool,
    (async () =>
      Response.json({ id: actor, email: "member@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}
async function ok(body?: unknown) {
  const response = await request(body);
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return value;
}
async function comment(id: string, conn = connection, ws = workspace) {
  sequence++;
  return (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     VALUES($1,$2,$3,$3,$4,'PRIVATE COMMENT BODY') RETURNING id::text,comment_id,media_id`,
      [ws, conn, `comment-${sequence}`, id],
    )
  ).rows[0];
}
async function bridge(
  recipient: string,
  options: {
    sender?: string;
    source?: string;
    status?: string;
    provider?: string | null;
    age?: string;
    connection?: string;
    workspace?: string;
  } = {},
) {
  const conn = options.connection ?? connection;
  const ws = options.workspace ?? workspace;
  const from = options.sender ?? sender;
  const event = await comment(options.source ?? from, conn, ws);
  const rule = (
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text)
     VALUES(gen_random_uuid(),$1,$2,$3,'hello','PRIVATE SEND BODY') RETURNING id`,
      [ws, conn, event.media_id],
    )
  ).rows[0].id;
  return (
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,
       private_reply_text,recipient_id,status,provider_message_id,sent_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'PRIVATE SEND BODY',$8,$9,$10,now()+$11::interval) RETURNING id::text`,
      [
        ws,
        conn,
        event.id,
        rule,
        event.comment_id,
        event.media_id,
        from,
        recipient,
        options.status ?? "sent",
        options.provider === undefined ? "acknowledged" : options.provider,
        options.age ?? "-1 hour",
      ],
    )
  ).rows[0].id as string;
}
async function message(recipient: string, conn = connection, ws = workspace) {
  sequence++;
  return (
    await pool.query(
      `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,$4,'PRIVATE DM BODY','text',now()) RETURNING id::text`,
      [ws, conn, recipient, `dm-${sequence}`],
    )
  ).rows[0].id as string;
}
async function consent(
  identityKind: "comment_sender" | "dm_recipient",
  identityValue: string,
  purpose: "service_reply" | "marketing" | "all",
  decision: "grant" | "revoke",
  conn = connection,
  ws = workspace,
) {
  return recordChannelConsentEvent(pool, {
    requestKey: randomUUID(),
    workspaceId: ws,
    connectionId: conn,
    channel: "instagram",
    identityKind,
    identityValue,
    purpose,
    decision,
    evidenceKind: "explicit",
    evidenceReference: "PRIVATE CONSENT EVIDENCE",
    occurredAt: new Date(),
    actorId: owner,
  });
}

test("identity confirmation and detachment preserve original conversations and exact consent state", async () => {
  await consent("comment_sender", sender, "service_reply", "revoke");
  await consent("dm_recipient", "200", "marketing", "grant");
  const beforeConsent = (
    await pool.query("SELECT to_jsonb(s) AS row FROM channel_consent_state s ORDER BY identity_kind,purpose")
  ).rows;
  const first = await ok(confirm());
  assert.equal(first.current.state, "confirmed");
  assert.equal(first.current.version, 1);
  assert.equal(first.event.version, 1);
  const read = await ok();
  assert.equal(read.links.length, 1);
  assert.equal(read.links[0].evidence_valid, true);
  const second = await ok(detach());
  assert.equal(second.current.state, "detached");
  assert.equal(second.current.version, 2);
  assert.deepEqual(
    (await pool.query("SELECT to_jsonb(s) AS row FROM channel_consent_state s ORDER BY identity_kind,purpose")).rows,
    beforeConsent,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM private_reply_outbox WHERE status='sent'")).rows[0].n,
    1,
  );
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_inbox_messages")).rows[0].n, 1);
});
test("identity requests are idempotent without reverting a later version", async () => {
  const input = confirm();
  const first = await ok(input);
  const replay = await ok(input);
  assert.equal(replay.event.id, first.event.id);
  assert.equal(replay.replayed, true);
  await ok(detach());
  const late = await ok(input);
  assert.equal(late.event.version, 1);
  assert.equal(late.current.version, 2);
  assert.equal(late.current.state, "detached");
  assert.equal((await request({ ...input, expected_version: 2 })).status, 409);
  assert.equal((await request(detach(1))).status, 409);
  assert.equal((await request(detach(2))).status, 409);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM instagram_contact_identity_link_events")).rows[0].n,
    2,
  );
});
test("identity writes require admin ownership and reject unknown or malformed targets and bodies", async () => {
  assert.equal((await request(confirm(), agent)).status, 403);
  assert.equal((await request(confirm(), outsider)).status, 404);
  assert.equal((await request(confirm(), owner, linkPath(sender, foreignConnection) + "/200")).status, 404);
  assert.equal((await request(confirm(), owner, linkPath("999") + "/200")).status, 404);
  assert.equal((await request(undefined, agent)).status, 200);
  assert.equal((await (await request(undefined, agent)).json()).can_edit, false);
  assert.equal((await ok()).can_edit, true);
  for (const body of [
    null,
    {},
    { ...confirm(), unexpected: true },
    { ...confirm(), expected_version: -1 },
    { ...confirm(), expected_version: 1.5 },
    { ...confirm(), evidence_reply_id: "9223372036854775808" },
    { ...detach(), evidence_reply_id: evidence },
  ])
    assert.equal((await request(body)).status, 400, JSON.stringify(body));
  for (const suffix of ["?extra=1", "?after=bad", "?after=1&after=2"])
    assert.equal((await request(undefined, owner, linkPath() + suffix)).status, 400);
  assert.equal((await request(confirm(), owner, linkPath() + "/200?extra=1")).status, 400);
});
test("confirmation rechecks current unique fresh evidence rather than numeric identity or operator input", async () => {
  assert.equal((await request(confirm(0, "1"))).status, 409);
  await message(sender);
  assert.equal((await request(confirm(), owner, linkPath() + "/" + sender)).status, 409);
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '2 days'");
  assert.equal((await request(confirm())).status, 409);
  await pool.query("UPDATE private_reply_outbox SET sent_at=now()-interval '1 hour'");
  await bridge("200", { sender: "999", age: "-2 days" });
  assert.equal((await request(confirm())).status, 409);
});
test("lost evidence invalidates a confirmed link but does not prevent detaching or replaying", async () => {
  const input = confirm();
  await ok(input);
  await pool.query("DELETE FROM private_reply_outbox");
  assert.equal((await ok()).links[0].evidence_valid, false);
  assert.equal((await ok(input)).replayed, true);
  await pool.query("DELETE FROM instagram_inbox_messages");
  assert.equal((await ok(detach())).current.state, "detached");
});
test("same-version concurrent confirmations produce one event and one conflict", async () => {
  const responses = await Promise.all([request(confirm()), request(confirm())]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM instagram_contact_identity_link_events")).rows[0].n,
    1,
  );
});
test("failure after inserting the event rolls back the entire change", async () => {
  inspect = async (_client, sql) => {
    if (sql.includes("INSERT INTO instagram_contact_identity_link_events")) throw new Error("synthetic rollback");
  };
  assert.equal((await request(confirm())).status, 503);
  inspect = undefined;
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM instagram_contact_identity_link_events")).rows[0].n,
    0,
  );
  assert.equal((await ok()).links[0].state, null);
});
test("personal deletion removes confirmation history without expanding the deletion identity set", async () => {
  await ok(confirm());
  await ok(detach());
  // Remove provider evidence so the manual record alone must not expand deletion to the DM.
  await pool.query("DELETE FROM private_reply_outbox");
  const result = (
    await pool.query("SELECT * FROM delete_person_data($1,$2,$3,'comment_sender',$4)", [
      workspace,
      connection,
      owner,
      sender,
    ])
  ).rows[0];
  assert.ok(result);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_contact_identity_links")).rows[0].n, 0);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM instagram_contact_identity_link_events")).rows[0].n,
    0,
  );
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_inbox_messages")).rows[0].n, 1);
});

test("all original product rows stay unchanged by confirmation and detachment", async () => {
  await consent("comment_sender", sender, "all", "revoke");
  await consent("dm_recipient", "200", "marketing", "grant");
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused,handoff_paused) VALUES($1,$2,$3,true,true)",
    [workspace, connection, sender],
  );
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,ARRAY['vip'])",
    [workspace, connection, sender],
  );
  await bridge("300", { status: "pending", provider: null });
  const segment = (
    await pool.query(
      "INSERT INTO instagram_contact_segments(workspace_id,name,tag) VALUES($1,'VIP','vip') RETURNING id",
      [workspace],
    )
  ).rows[0].id;
  const snapshotId = (
    await pool.query(
      `INSERT INTO instagram_segment_snapshots(workspace_id,segment_id,created_by,as_of,definition,segment_name,counts,member_count) VALUES($1,$2,$3,now(),'{}','VIP','{"total":"1"}',1) RETURNING id`,
      [workspace, segment, owner],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO instagram_segment_snapshot_members(snapshot_id,workspace_id,connection_id,sender_id) VALUES($1,$2,$3,$4)",
    [snapshotId, workspace, connection, sender],
  );
  assert.equal(
    await deliveryRecipientOptedOut(pool, { workspaceId: workspace, connectionId: connection, senderId: sender }),
    true,
  );
  const tables = (
    await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('instagram_contact_identity_links','instagram_contact_identity_link_events') ORDER BY tablename",
    )
  ).rows;
  const snapshot = () =>
    Promise.all(
      tables.map(
        async ({ tablename }) =>
          (
            await pool.query(
              `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM "${tablename}" t`,
            )
          ).rows[0].rows,
      ),
    );
  const original = await snapshot();
  await ok(confirm());
  await ok(detach());
  assert.deepEqual(await snapshot(), original);
  assert.equal(
    await deliveryRecipientOptedOut(pool, { workspaceId: workspace, connectionId: connection, senderId: sender }),
    true,
  );
});
test("candidate pagination is scoped and a reassigned detached link keeps its actual version", async () => {
  await ok(confirm());
  await ok(detach());
  await pool.query("DELETE FROM private_reply_outbox");
  const nextEvidence = await bridge("200", { sender: "999" });
  const response = await request(undefined, owner, linkPath("999"));
  assert.equal(response.status, 200);
  const candidate = (await response.json()).links[0];
  assert.equal(candidate.version, 2);
  assert.equal(candidate.state, null);
  assert.doesNotMatch(JSON.stringify(candidate), new RegExp(sender));
  assert.equal((await request(confirm(2, nextEvidence), owner, linkPath("999") + "/200")).status, 200);
  // A former sender's personal deletion also removes an event that names it as the prior sender.
  await pool.query("SELECT delete_person_data($1,$2,$3,'comment_sender',$4)", [workspace, connection, owner, sender]);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM instagram_contact_identity_link_events")).rows[0].n,
    0,
  );
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_contact_identity_links")).rows[0].n, 0);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM instagram_comment_events WHERE sender_id='999'")).rows[0].n,
    1,
  );
  for (let n = 0; n < 51; n++) {
    await bridge(String(400 + n));
    await message(String(400 + n));
  }
  const first = await ok();
  assert.equal(first.links.length, 50);
  assert.ok(first.after);
  const second = await request(undefined, owner, linkPath() + `?after=${first.after}`);
  const page = await second.json();
  assert.equal(page.links.length, 1);
  assert.equal(page.after, null);
  assert.equal(new Set([...first.links, ...page.links].map((x) => x.recipient_id)).size, 51);
  assert.equal((await request(undefined, owner, linkPath("999") + `?after=${first.after}`)).status, 400);
});
async function waitForLock(fragment: string) {
  for (let n = 0; n < 300; n++) {
    const result = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 in query)>0",
      [fragment],
    );
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("expected database lock wait was not observed");
}
test("a confirmation waiting behind personal deletion rereads the missing original", async () => {
  const deleting = await pool.connect();
  await deleting.query("BEGIN");
  let pending: Promise<Response> | undefined;
  try {
    await deleting.query("SELECT delete_person_data($1,$2,$3,'comment_sender',$4)", [
      workspace,
      connection,
      owner,
      sender,
    ]);
    pending = request(confirm());
    await waitForLock("FOR NO KEY UPDATE");
    await deleting.query("COMMIT");
    assert.equal((await pending).status, 404);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_contact_identity_links")).rows[0].n, 0);
  } finally {
    await deleting.query("ROLLBACK");
    deleting.release();
    await pending;
  }
});
test("personal deletion waits for confirmation and then removes its new records", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  inspect = async (_client, sql) => {
    if (sql.includes("INSERT INTO instagram_contact_identity_links(")) {
      entered();
      await held;
    }
  };
  const pending = request(confirm());
  await reached;
  const deletion = pool.query("SELECT delete_person_data($1,$2,$3,'comment_sender',$4)", [
    workspace,
    connection,
    owner,
    sender,
  ]);
  try {
    await waitForLock("SELECT delete_person_data");
  } finally {
    release();
  }
  assert.equal((await pending).status, 200);
  await deletion;
  inspect = undefined;
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM instagram_contact_identity_links")).rows[0].n, 0);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM instagram_contact_identity_link_events")).rows[0].n,
    0,
  );
});
test("latest migration reproduces canonical deletion functions and can replay", async () => {
  const definitions = async () =>
    (
      await pool.query(
        "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('delete_person_data','delete_connection_data','delete_workspace_data') ORDER BY proname",
      )
    ).rows;
  const canonical = await definitions();
  const migration = await readFile(
    new URL("../../db/migrations/062_contact_identity_links.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);
  await pool.query(await readFile(new URL("../../db/migrations/063_campaign_drafts.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/064_campaign_approvals.sql", import.meta.url), "utf8"));
  assert.deepEqual(await definitions(), canonical);
  await ok(confirm());
  const result = (
    await pool.query("SELECT delete_connection_data($1,$2,$3,'100') AS result", [workspace, connection, owner])
  ).rows[0].result;
  assert.equal(result.deleted_counts.instagram_contact_identity_links, 1);
  assert.equal(result.deleted_counts.instagram_contact_identity_link_events, 1);
});
