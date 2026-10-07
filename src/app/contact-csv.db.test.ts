import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { appApi } from "./api.ts";
import * as csv from "./contact-csv.ts";
import { decodeContactScalar, parseContactCsv } from "./contact-csv-test-utils.ts";
import { seedWorkspace } from "./workspace-fixture.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const local = new URL(databaseUrl);
if (local.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(local.hostname))
  throw new Error("Database tests require local automations_test");
const pool = new Pool({ connectionString: databaseUrl });
const workspace = "11111111-1111-4111-8111-111111111111",
  foreign = "22222222-2222-4222-8222-222222222222";
const connection = "33333333-3333-4333-8333-333333333333",
  second = "44444444-4444-4444-8444-444444444444";
const owner = "55555555-5555-4555-8555-555555555555",
  admin = "66666666-6666-4666-8666-666666666666",
  agent = "77777777-7777-4777-8777-777777777777";
const user = { id: owner, email: "owner@example.test" };
let notifications = 0;
const statements: string[] = [];
const releases: (boolean | Error | undefined)[] = [];
let afterQuery: ((client: PoolClient, sql: string) => Promise<void>) | undefined;
let changeQuery: ((query: QueryConfig) => QueryConfig) | undefined;
const tracked = () =>
  ({
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (input: string | QueryConfig, values?: unknown[]) => {
          const query = typeof input === "string" ? { text: input, values } : input;
          statements.push(query.text);
          const result = await client.query(changeQuery?.(query) ?? query);
          await afterQuery?.(client, query.text);
          return result;
        },
        release: (destroy?: boolean | Error) => {
          releases.push(destroy);
          client.release(destroy);
        },
      };
    },
    query: pool.query.bind(pool),
    end: async () => {},
  }) as unknown as Pool;
before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  afterQuery = undefined;
  changeQuery = undefined;
  statements.length = 0;
  releases.length = 0;
  notifications = 0;
  await pool.query("TRUNCATE workspaces,workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspace, foreign]);
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent')",
    [workspace, owner, admin, agent],
  );
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,username,active) VALUES($1,$2,'123','shop',true),($3,$2,'124',NULL,false)",
    [connection, workspace, second],
  );
});
after(async () => pool.end());
async function request(actor = owner, suffix = "") {
  return appApi(
    new Request(`https://app.test/api/contacts/export.csv${suffix}`, { headers: { cookie: "__Host-ac-access=test" } }),
    { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" },
    tracked,
    (async (input) => {
      assert.equal(new URL(String(input)).hostname, "project.supabase.co");
      return Response.json({ id: actor, email: "member@example.test", email_confirmed_at: "2026-10-04" });
    }) as typeof fetch,
    async () => {
      notifications++;
    },
  );
}
async function add(sender: string, conn = connection, ws = workspace) {
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) VALUES($1,$2,$3,'media',$4,'RAW COMMENT SECRET','2026-10-04T12:34:56.123456Z')",
    [ws, conn, randomUUID(), sender],
  );
}
async function field(name: string, type: string, json: string | null, archived = false, sender = "00123") {
  const id = (
    await pool.query(
      "INSERT INTO instagram_contact_fields(workspace_id,name,type,archived) VALUES($1,$2,$3,$4) RETURNING id",
      [workspace, name, type, archived],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,$3,$4,$5::jsonb)",
    [workspace, connection, sender, id, json],
  );
  return id as string;
}
const records = (body: string) =>
  parseContactCsv(body)
    .slice(1)
    .map((row) => Object.fromEntries(csv.CONTACT_CSV_HEADER.map((name, i) => [name, row[i]!])));

test("CSV GET returns fixed download headers and owner/admin empty files, never agent or missing/removed membership", async () => {
  for (const actor of [owner, admin]) {
    const response = await request(actor);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment; filename="auto-chatter-contacts-v1-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
    assert.deepEqual(parseContactCsv(bytes.toString()), [Array.from(csv.CONTACT_CSV_HEADER)]);
  }
  for (const [actor, error] of [
    [agent, "role_forbidden"],
    [randomUUID(), "workspace_required"],
  ]) {
    const response = await request(actor);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error });
    assert.equal(response.headers.has("content-disposition"), false);
  }
  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [admin, owner]);
  assert.equal((await request(admin)).status, 403);
});

test("CSV GET rejects every query parameter including duplicates", async () => {
  for (const query of ["?tag=vip", "?connection_id=" + connection, "?after=1", "?x=1&x=2"]) {
    const response = await request(owner, query);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_contact_export_request" });
    assert.equal(response.headers.has("content-disposition"), false);
  }
});

test("CSV deduplicates comments per connection, includes disconnected connections and preserves exact typed source values", async () => {
  await add("00123");
  await add("00123");
  await add("90071992547409931234567890");
  await add("00123", second);
  await pool.query("UPDATE instagram_connections SET username=$2 WHERE id=$1", [connection, " \u200b＝SUM(1,2)"]);
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'00123',ARRAY['한글','" +
      '"' +
      ";=next','alpha'])",
    [workspace, connection],
  );
  await pool.query(
    "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused,handoff_paused) VALUES($1,$2,'00123',false,true)",
    [workspace, connection],
  );
  const ids = {
    zero: await field("zero", "number", "0"),
    no: await field("no", "boolean", "false"),
    empty: await field("empty", "text", '""'),
    date: await field("date", "date", '"2026-10-04"'),
    big: await field("big", "number", "9007199254740993.123456789"),
    reply: await field("saved reply", "text", '"COLLECTED REPLY TEXT"'),
  };
  const archived = await field("archived", "text", '"ARCHIVED SECRET"', true);
  const unset = await field("unset", "text", null);
  const exported = await csv.exportContactCsv(tracked(), user, { batchSize: 1 });
  const rows = records(exported.body);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((x) => [x.connection_id, x.sender_id]),
    [
      [connection, "'00123"],
      [connection, "'90071992547409931234567890"],
      [second, "'00123"],
    ],
  );
  assert.equal(rows[0]!.comment_count, "2");
  assert.equal(rows[0]!.automation_paused, "true");
  assert.equal(rows[2]!.automation_paused, "false");
  assert.equal(decodeContactScalar(rows[0]!.connection_username), " \u200b＝SUM(1,2)");
  assert.equal(rows[2]!.connection_username, "");
  assert.equal(rows[0]!.first_comment_recorded_at, "2026-10-04T12:34:56.123456Z");
  assert.equal(rows[0]!.last_comment_recorded_at, "2026-10-04T12:34:56.123456Z");
  assert.equal(new Set(rows.map((x) => x.exported_at)).size, 1);
  assert.match(exported.exportedAt, /\.\d{6}Z$/);
  assert.deepEqual(JSON.parse(rows[0]!.tags_json), ['";=next', "alpha", "한글"]);
  const fields = JSON.parse(rows[0]!.fields_json);
  assert.deepEqual(fields[ids.zero], { name: "zero", type: "number", value: 0 });
  assert.equal(fields[ids.no].value, false);
  assert.equal(fields[ids.empty].value, "");
  assert.equal(fields[ids.date].value, "2026-10-04");
  assert.equal(fields[archived], undefined);
  assert.equal(fields[unset], undefined);
  assert.match(rows[0]!.fields_json, /9007199254740993\.123456789/);
  assert.ok(rows[0]!.fields_json.includes("COLLECTED REPLY TEXT"));
  assert.deepEqual(Object.keys(fields), Object.keys(fields).sort());
  assert.equal(rows[0]!.identity_kind, "comment_sender");
  assert.equal(rows[0]!.channel, "instagram");
  assert.equal(rows[0]!.workspace_id, workspace);
});

test("CSV excludes other workspaces and raw message/credential/evidence/private-note tables without changing rows or notifying", async () => {
  const foreignConnection = randomUUID(),
    foreignUser = randomUUID();
  await pool.query("DELETE FROM workspaces WHERE id=$1", [foreign]);
  await seedWorkspace(pool, foreign, foreignUser, foreignConnection, "foreign-secret");
  await add("00123");
  await field("allowed text", "text", '"stored custom value"');
  await pool.query("UPDATE instagram_connections SET access_token_encrypted='TOKEN-SECRET' WHERE id=$1", [connection]);
  await pool.query(
    "INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at) VALUES($1,$2,'987','dm','RAW-DM-SECRET','text',now())",
    [workspace, connection],
  );
  await pool.query(
    "INSERT INTO instagram_inbox_reminders(workspace_id,connection_id,recipient_id,creator_id,due_at,note) VALUES($1,$2,'987',$3,now(),'REMINDER-SECRET')",
    [workspace, connection, agent],
  );
  const tables = (
    await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  ).rows.map((x) => x.tablename as string);
  const snapshot = async () =>
    Promise.all(
      tables.map(
        async (name) =>
          (
            await pool.query(
              `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM "${name}" t`,
            )
          ).rows[0].rows,
      ),
    );
  const before = await snapshot();
  let readonly = false;
  afterQuery = async (client, sql) => {
    if (sql.startsWith("BEGIN")) {
      assert.equal((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "on");
      assert.equal((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "repeatable read");
      readonly = true;
    }
  };
  const response = await request();
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /foreign-secret|RAW COMMENT SECRET|RAW-DM-SECRET|TOKEN-SECRET|REMINDER-SECRET/);
  assert.equal(records(text).length, 1);
  assert.ok(readonly);
  assert.deepEqual(await snapshot(), before);
  assert.equal(notifications, 0);
});

test("all batches use the membership snapshot while fields/tags/archives and deletion change concurrently", async () => {
  for (const sender of ["1", "2", "3"]) await add(sender);
  const f = await field("saved", "text", '"before"', false, "3");
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'3',ARRAY['before'])",
    [workspace, connection],
  );
  let changed = false;
  afterQuery = async (_client, sql) => {
    if (!changed && sql.includes("WITH contacts AS")) {
      changed = true;
      await pool.query("UPDATE instagram_contact_tags SET tags=ARRAY['after'] WHERE connection_id=$1", [connection]);
      await pool.query("UPDATE instagram_contact_field_values SET value='\"after\"' WHERE field_id=$1", [f]);
      await pool.query("UPDATE instagram_contact_fields SET archived=true WHERE id=$1", [f]);
      await pool.query("DELETE FROM instagram_comment_events WHERE connection_id=$1 AND sender_id='2'", [connection]);
      await add("4");
    }
  };
  const first = records((await csv.exportContactCsv(tracked(), user, { batchSize: 1 })).body);
  assert.ok(changed);
  assert.deepEqual(
    first.map((x) => x.sender_id),
    ["'1", "'2", "'3"],
  );
  assert.deepEqual(JSON.parse(first[2]!.tags_json), ["before"]);
  assert.equal(JSON.parse(first[2]!.fields_json)[f].value, "before");
  afterQuery = undefined;
  const next = records((await csv.exportContactCsv(tracked(), user, { batchSize: 1 })).body);
  assert.deepEqual(
    next.map((x) => x.sender_id),
    ["'1", "'3", "'4"],
  );
  assert.deepEqual(JSON.parse(next[1]!.tags_json), ["after"]);
  assert.equal(JSON.parse(next[1]!.fields_json)[f], undefined);
});

test("internal row and UTF-8 byte limits rollback with no successful partial file", async () => {
  await add("1");
  await add("2");
  await assert.rejects(csv.exportContactCsv(tracked(), user, { maxRows: 1, batchSize: 1 }), {
    status: 422,
    message: "contact_export_too_large",
  });
  assert.ok(statements.includes("ROLLBACK"));
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(releases.length, 1);
  statements.length = 0;
  releases.length = 0;
  await assert.rejects(csv.exportContactCsv(tracked(), user, { maxBytes: 500 }), {
    status: 422,
    message: "contact_export_too_large",
  });
  assert.ok(statements.includes("ROLLBACK"));
  assert.equal(statements.includes("COMMIT"), false);
  assert.equal(releases.length, 1);
});

test("production row cap responds with a JSON error and no attachment rather than a truncated CSV", async () => {
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) SELECT $1,$2,n::text,'media',n::text,'x' FROM generate_series(1,5001) n",
    [workspace, connection],
  );
  const response = await request();
  assert.equal(response.status, 422, await response.clone().text());
  assert.equal(response.headers.has("content-disposition"), false);
  assert.deepEqual(await response.json(), { error: "contact_export_too_large" });
});

test("query failure rolls back and real statement timeout destroys the client without reusing a pending query", async () => {
  await add("1");
  changeQuery = (query) =>
    query.text.includes("WITH contacts AS") ? { ...query, text: "SELECT does_not_exist FROM nowhere" } : query;
  await assert.rejects(csv.exportContactCsv(tracked(), user), { code: "42P01" });
  assert.ok(statements.includes("ROLLBACK"));
  assert.equal(releases.length, 1);
  assert.notEqual(releases[0], true);
  statements.length = 0;
  releases.length = 0;
  changeQuery = (query) =>
    query.text.includes("WITH contacts AS") ? { ...query, text: "SELECT pg_sleep(5)", values: [] } : query;
  await assert.rejects(csv.exportContactCsv(tracked(), user, { timeoutMs: 100 }), {
    status: 503,
    message: "contact_export_timeout",
  });
  assert.deepEqual(releases, [true]);
  assert.equal(statements.includes("COMMIT"), false);
});

test("effective pause exports manual and handoff causes without implying delivery eligibility", async () => {
  await add("00123");
  for (const [manual, handoff] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    await pool.query(
      "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused,handoff_paused) VALUES($1,$2,'00123',$3,$4) ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET paused=$3,handoff_paused=$4",
      [workspace, connection, manual, handoff],
    );
    assert.equal(
      records((await csv.exportContactCsv(tracked(), user)).body)[0]!.automation_paused,
      String(manual || handoff),
    );
  }
  await pool.query("UPDATE instagram_connections SET username='' WHERE id=$1", [connection]);
  assert.equal(records((await csv.exportContactCsv(tracked(), user)).body)[0]!.connection_username, "'");
});

test("total budget is not restarted between batches or after client-side processing", async () => {
  for (const sender of ["1", "2", "3", "4"]) await add(sender);
  afterQuery = async (_client, sql) => {
    if (sql.includes("WITH contacts AS")) await pool.query("SELECT pg_sleep(0.04)");
  };
  await assert.rejects(csv.exportContactCsv(tracked(), user, { timeoutMs: 100, batchSize: 1 }), {
    status: 503,
    message: "contact_export_timeout",
  });
  assert.equal(statements.includes("COMMIT"), false);
  assert.deepEqual(releases, [true]);
});
