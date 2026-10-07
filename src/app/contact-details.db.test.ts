import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool, type PoolClient } from "pg";
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
const connection = "33333333-3333-4333-8333-333333333333";
const foreignConnection = "44444444-4444-4444-8444-444444444444";
const owner = "55555555-5555-4555-8555-555555555555";
const agent = "66666666-6666-4666-8666-666666666666";
const outsider = "77777777-7777-4777-8777-777777777777";
const missingMember = "88888888-8888-4888-8888-888888888888";
const sender = "12345678901234567890";
let sequence = 0;
let notifications = 0;
let inspect: ((client: PoolClient, sql: string) => Promise<void>) | undefined;

type Consent = { purpose: string; decision: string; last_event_id: string; evidence_kind: string };
type Detail = {
  connection_id: string;
  sender_id: string;
  comment_count: string;
  tags: string[];
  fields: { id: string; name: string; type: string; value: unknown }[];
  automation: { paused: boolean; manual_paused: boolean; handoff_paused: boolean };
  consent: Consent[];
  conversations: {
    recipient_id: string;
    evidence_reply_id: string;
    message_count: string;
    last_message_id: string;
    state: string;
    handoff_active: boolean;
    consent: Consent[];
  }[];
  after: string | null;
};

before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  inspect = undefined;
  notifications = 0;
  await pool.query("TRUNCATE workspaces,workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspace, foreignWorkspace]);
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')`,
    [workspace, owner, agent, foreignWorkspace, outsider],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,inbox_enabled,inbox_enabled_at)
     VALUES($1,$2,'100','shop',true,now()-interval '1 day'),($3,$4,'101','shop',true,now()-interval '1 day')`,
    [connection, workspace, foreignConnection, foreignWorkspace],
  );
  await comment(sender);
});
after(async () => pool.end());

async function request(path = detailPath(), actor = owner) {
  return appApi(
    new Request(`https://app.test${path}`, { headers: { cookie: "__Host-ac-access=test" } }),
    { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" },
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
    async () => {
      notifications++;
    },
  );
}
function detailPath(id = sender, conn = connection) {
  return `/api/connections/${conn}/contacts/${id}`;
}
async function detail(path = detailPath(), actor = owner): Promise<Detail> {
  const response = await request(path, actor);
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return value as Detail;
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

// Removing ownership or membership filtering must fail these status assertions; this also proves the GET is wired.
test("contact detail is an owned agent-readable no-store GET and rejects missing contacts and memberships", async () => {
  const own = await detail();
  assert.equal(own.sender_id, sender);
  assert.equal(own.connection_id, connection);
  assert.equal(own.comment_count, "1");
  assert.deepEqual((await detail(detailPath(), agent)).automation, {
    paused: false,
    manual_paused: false,
    handoff_paused: false,
  });
  await comment(sender, foreignConnection, foreignWorkspace);
  for (const [path, actor, status, code] of [
    [detailPath(), outsider, 404, "contact_not_found"],
    [detailPath(sender, foreignConnection), owner, 404, "contact_not_found"],
    [detailPath("999"), owner, 404, "contact_not_found"],
    [detailPath(), missingMember, 403, "workspace_required"],
  ] as const) {
    const response = await request(path, actor);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  }
  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [agent, owner]);
  assert.equal((await request(detailPath(), agent)).status, 403);
});

test("detail rejects malformed identifiers, duplicate/unknown queries and unscoped cursors", async () => {
  for (const path of [
    detailPath("abc"),
    detailPath("1".repeat(41)),
    detailPath("%20"),
    detailPath("%2F"),
    detailPath("%GG"),
    detailPath(sender, "bad"),
    `${detailPath()}?extra=1`,
    `${detailPath()}?after=1&after=2`,
    `${detailPath()}?after=`,
    `${detailPath()}?after=abc`,
    `${detailPath()}?after=${Buffer.from(JSON.stringify({ recipient_id: "123" })).toString("base64url")}`,
  ]) {
    const response = await request(path);
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: "invalid_contact_request" });
  }
});

test("detail preserves active field types and empty values and distinguishes pause reasons", async () => {
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,ARRAY['vip'])",
    [workspace, connection, sender],
  );
  const expected = [];
  for (const [name, type, value, archived] of [
    ["zero", "number", 0, false],
    ["false", "boolean", false, false],
    ["empty", "text", "", false],
    ["unset", "date", null, false],
    ["archived", "text", "SECRET ARCHIVED", true],
  ] as const) {
    const id = (
      await pool.query(
        "INSERT INTO instagram_contact_fields(workspace_id,name,type,archived) VALUES($1,$2,$3,$4) RETURNING id",
        [workspace, name, type, archived],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,$3,$4,$5::jsonb)",
      [workspace, connection, sender, id, value === null ? null : JSON.stringify(value)],
    );
    if (!archived) expected.push({ id, name, type, value });
  }
  const result = await detail();
  assert.deepEqual(result.tags, ["vip"]);
  assert.deepEqual(
    result.fields,
    expected.sort((a, b) => a.name.localeCompare(b.name)),
  );
  for (const [manual, handoff] of [
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ]) {
    await pool.query(
      `INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused,handoff_paused) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET paused=$4,handoff_paused=$5`,
      [workspace, connection, sender, manual, handoff],
    );
    assert.deepEqual((await detail()).automation, {
      paused: manual || handoff,
      manual_paused: manual,
      handoff_paused: handoff,
    });
  }
});

test("detail returns only fresh unique provider-acknowledged same-source stored DM associations", async () => {
  await pool.query("ALTER TABLE private_reply_outbox ALTER COLUMN id RESTART WITH 9007199254741001");
  await pool.query("ALTER TABLE instagram_inbox_messages ALTER COLUMN id RESTART WITH 9007199254742001");
  const reply = await bridge("200");
  const dm = await message("200");
  await pool.query("UPDATE instagram_connections SET access_token_encrypted='PRIVATE TOKEN' WHERE id=$1", [connection]);
  await pool.query(
    "INSERT INTO instagram_inbox_notes(workspace_id,connection_id,recipient_id,author_id,body) VALUES($1,$2,'200',$3,'PRIVATE NOTE')",
    [workspace, connection, agent],
  );
  await pool.query(
    "INSERT INTO instagram_inbox_reminders(workspace_id,connection_id,recipient_id,creator_id,due_at,note) VALUES($1,$2,'200',$3,now(),'PRIVATE REMINDER')",
    [workspace, connection, agent],
  );
  await bridge("200"); // Same sender across posts remains one identity.
  await bridge("201", { age: "-2 days" });
  await message("201");
  await bridge("202");
  await bridge("202", { sender: "other-comment-id", age: "-2 days" });
  await message("202");
  await bridge("203", { provider: null });
  await message("203");
  await bridge("204", { source: "another-comment-id" });
  await message("204");
  await bridge("205", { status: "unknown" });
  await message("205");
  await bridge("206", { age: "1 hour" });
  await message("206");
  await bridge("207", { provider: "   " });
  await message("207");
  await bridge("208"); // No stored inbox conversation.
  await message(sender); // Same numeric identity does not establish a bridge.
  await bridge("209", { connection: foreignConnection, workspace: foreignWorkspace });
  await message("209", foreignConnection, foreignWorkspace);
  const result = await detail();
  assert.deepEqual(
    result.conversations.map((x) => x.recipient_id),
    ["200"],
  );
  assert.ok(BigInt(result.conversations[0]!.evidence_reply_id) > BigInt(reply));
  assert.equal(result.conversations[0]!.last_message_id, dm);
  assert.equal(result.conversations[0]!.message_count, "1");
  assert.equal(result.conversations[0]!.state, "open");
  assert.equal(result.conversations[0]!.handoff_active, false);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE|other-comment-id|another-comment-id|reminder|credential|assignee/,
  );
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,handoff_paused) VALUES($1,$2,$3,true)",
    [workspace, connection, sender],
  );
  await pool.query(
    "INSERT INTO instagram_inbox_handoffs(workspace_id,connection_id,recipient_id,sender_id,evidence_reply_id,active,version,updated_by) VALUES($1,$2,'200',$3,$4,true,1,$5)",
    [workspace, connection, sender, reply, owner],
  );
  await pool.query(
    "INSERT INTO instagram_inbox_conversations(workspace_id,connection_id,recipient_id,status,assignee_user_id) VALUES($1,$2,'200','closed',$3)",
    [workspace, connection, agent],
  );
  const changed = await detail();
  assert.equal(changed.conversations[0]!.state, "closed");
  assert.equal(changed.conversations[0]!.handoff_active, true);
  assert.equal(changed.automation.handoff_paused, true);
  await pool.query("UPDATE instagram_connections SET inbox_enabled_at=NULL,inbox_enabled=false WHERE id=$1", [
    connection,
  ]);
  assert.deepEqual((await detail()).conversations, []);
});

test("detail keeps consent in each exact identity scope without transferring grants or evidence text", async () => {
  await bridge("300");
  await message("300");
  await bridge("301", { age: "-2 days" });
  await message("301");
  await pool.query("ALTER TABLE channel_consent_events ALTER COLUMN id RESTART WITH 9007199254743001");
  const grant = await consent("dm_recipient", "300", "marketing", "grant");
  await consent("comment_sender", sender, "service_reply", "revoke");
  await consent("dm_recipient", sender, "marketing", "grant");
  await consent("dm_recipient", "301", "marketing", "grant");
  await consent("comment_sender", sender, "marketing", "grant", foreignConnection, foreignWorkspace);
  const result = await detail();
  assert.deepEqual(
    result.consent.map((x) => [x.purpose, x.decision]),
    [["service_reply", "revoke"]],
  );
  assert.deepEqual(
    result.conversations[0]!.consent.map((x) => [x.purpose, x.decision, x.last_event_id]),
    [["marketing", "grant", grant.eventId]],
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|evidence_reference|eligible|actor_id/);
  await consent("dm_recipient", "300", "all", "revoke");
  assert.deepEqual(
    (await detail()).conversations[0]!.consent.map((x) => [x.purpose, x.decision]),
    [
      ["marketing", "revoke"],
      ["service_reply", "revoke"],
    ],
  );
});

test("verified conversations paginate without duplicates and cursors cannot cross scope", async () => {
  for (let n = 0; n < 52; n++) {
    await bridge(String(400 + n));
    await message(String(400 + n));
  }
  const first = await detail();
  assert.equal(first.conversations.length, 50);
  assert.ok(first.after);
  const second = await detail(`${detailPath()}?after=${first.after}`);
  assert.deepEqual(
    second.conversations.map((x) => x.recipient_id),
    ["450", "451"],
  );
  assert.equal(second.after, null);
  assert.equal(new Set([...first.conversations, ...second.conversations].map((x) => x.recipient_id)).size, 52);
  await comment("999");
  for (const path of [detailPath("999"), detailPath(sender, foreignConnection)]) {
    assert.equal((await request(`${path}?after=${first.after}`)).status, 400);
  }
  const cursor = JSON.parse(Buffer.from(first.after, "base64url").toString("utf8"));
  cursor.workspace_id = foreignWorkspace;
  assert.equal(
    (await request(`${detailPath()}?after=${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`)).status,
    400,
  );
});

test("all detail facts share a read-only snapshot and reading changes no product rows or queue", async () => {
  await bridge("500");
  await message("500");
  await consent("comment_sender", sender, "service_reply", "revoke");
  const tables = (
    await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  ).rows.map((x) => x.tablename as string);
  const snapshot = async () =>
    Promise.all(
      tables.map(
        async (table) =>
          (
            await pool.query(
              `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM "${table}" t`,
            )
          ).rows[0].rows,
      ),
    );
  const beforeRows = await snapshot();
  let readOnly = false;
  inspect = async (client, sql) => {
    if (sql.startsWith("BEGIN")) {
      assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
      assert.equal((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "repeatable read");
      readOnly = true;
    }
  };
  await detail();
  assert.ok(readOnly);
  assert.deepEqual(await snapshot(), beforeRows);
  assert.equal(notifications, 0);
  let changed = false;
  inspect = async (_client, sql) => {
    if (!changed && sql.includes("instagram_comment_events")) {
      changed = true;
      await pool.query(
        "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES($1,$2,$3,true)",
        [workspace, connection, sender],
      );
      await bridge("500", { sender: "conflict-created-during-read" });
      await consent("comment_sender", sender, "service_reply", "grant");
    }
  };
  const coherent = await detail();
  assert.ok(changed);
  assert.equal(coherent.automation.paused, false);
  assert.equal(coherent.conversations.length, 1);
  assert.equal(coherent.consent[0]!.decision, "revoke");
  inspect = undefined;
  const current = await detail();
  assert.equal(current.automation.paused, true);
  assert.equal(current.conversations.length, 0);
  assert.equal(current.consent[0]!.decision, "grant");
});
