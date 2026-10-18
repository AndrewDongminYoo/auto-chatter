import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { before, beforeEach, after, test } from "node:test";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { appApi } from "./api.ts";
import * as csv from "./contact-csv.ts";
import { previewContactCsv } from "./contact-csv-preview.ts";
import { applyContactCsv, CONTACT_IMPORT_APPLY_REQUEST_BYTES } from "./contact-csv-import.ts";
import { decodeContactScalar, parseContactCsv } from "./contact-csv-test-utils.ts";
import {
  archiveContactSegment,
  createContactSegment,
  listContacts,
  lockContactConnection,
  saveContactTags,
} from "./contacts.ts";
import { lockContact } from "./contact-fields.ts";
import { seedWorkspace } from "./workspace-fixture.ts";
import { recordChannelConsentEvent } from "../instagram/channel-consent.ts";

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
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      CONTACT_EXPORT_LIMIT: { limit: async () => ({ success: true }) },
    },
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

function previewCsv(rows: Partial<Record<(typeof csv.CONTACT_CSV_HEADER)[number], string>>[]) {
  return (
    "\ufeff" +
    csv.contactCsvRow(csv.CONTACT_CSV_HEADER) +
    rows
      .map((row) => {
        const values = {
          format_version: "1",
          exported_at: "ignored",
          workspace_id: workspace,
          channel: "instagram",
          identity_kind: "comment_sender",
          connection_id: connection,
          sender_id: "'00123",
          connection_username: "PRIVATE NAME",
          first_comment_recorded_at: "ignored",
          last_comment_recorded_at: "ignored",
          comment_count: "ignored",
          automation_paused: "ignored",
          tags_json: '[" New ","NEW"]',
          fields_json: "PRIVATE FIELD\n<script>bad</script>",
          ...row,
        };
        return csv.contactCsvRow(csv.CONTACT_CSV_HEADER.map((key) => values[key]));
      })
      .join("")
  );
}
async function previewRequest(body: unknown, actor = owner, suffix = "", origin = "https://app.test") {
  return appApi(
    new Request(`https://app.test/api/contacts/import-preview${suffix}`, {
      method: "POST",
      headers: { origin, cookie: "__Host-ac-access=test", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      API_WRITE_USER_LIMIT: { limit: async () => ({ success: true }) },
      API_WRITE_WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
    },
    () => ({ query: pool.query.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () =>
      Response.json({ id: actor, email: "member@example.test", email_confirmed_at: "2026-10-17" })) as typeof fetch,
    async () => {
      notifications++;
    },
  );
}
async function applyRequest(body: unknown, actor = owner, suffix = "", raw?: string) {
  return appApi(
    new Request(`https://app.test/api/contacts/import${suffix}`, {
      method: "POST",
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      API_WRITE_USER_LIMIT: { limit: async () => ({ success: true }) },
      API_WRITE_WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
    },
    tracked,
    (async () =>
      Response.json({ id: actor, email: "member@example.test", email_confirmed_at: "2026-10-17" })) as typeof fetch,
    async () => {
      notifications++;
    },
  );
}
// The apply body a screen builds from a preview: the checked CSV plus the current tags of every changed row.
function applyBody(csvText: string, preview: { rows: { row: number; status: string; current_tags?: string[] }[] }) {
  return {
    csv: csvText,
    expected: preview.rows
      .filter((row) => row.status === "changed")
      .map((row) => ({ row: row.row, current_tags: row.current_tags })),
  };
}
async function tagsByContact() {
  return (
    await pool.query("SELECT connection_id,sender_id,tags FROM instagram_contact_tags ORDER BY connection_id,sender_id")
  ).rows;
}
async function databaseSnapshot() {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"))
    .rows;
  const snapshot: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    snapshot[tablename] = (
      await pool.query(
        `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS value FROM "${tablename}" t`,
      )
    ).rows[0].value;
  }
  return snapshot;
}

test("CSV tag preview uses existing contacts and exported v1 without changing any stored table", async () => {
  await add("00123");
  await add("00123", second);
  await add("90071992547409931234567890");
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'00123',ARRAY['old'])",
    [workspace, connection],
  );
  const before = await databaseSnapshot();
  const exported = await csv.exportContactCsv(tracked(), user);
  const roundtrip = await previewRequest({ csv: exported.body }, admin);
  assert.equal(roundtrip.status, 200);
  assert.equal((await roundtrip.json()).counts.unchanged, 3);
  const response = await previewRequest({
    csv: previewCsv([
      {},
      { connection_id: second, tags_json: "[]" },
      { sender_id: "'90071992547409931234567890", tags_json: '["=formula","<script>"]' },
    ]),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.deepEqual(result.counts, { total: 3, changed: 2, unchanged: 1, invalid: 0, duplicate: 0, not_found: 0 });
  assert.deepEqual(result.rows[0], {
    row: 1,
    status: "changed",
    connection_id: connection,
    sender_id: "00123",
    current_tags: ["old"],
    proposed_tags: ["new"],
  });
  assert.equal(result.rows[2].sender_id, "90071992547409931234567890");
  assert.ok(result.checked_at);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(notifications, 0);
  assert.deepEqual(await databaseSnapshot(), before);
});

test("CSV tag preview separates all duplicate identities invalid scope and unavailable contacts", async () => {
  await add("00123");
  await add("00123", second);
  const other = randomUUID();
  await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,'foreign')", [
    other,
    foreign,
  ]);
  await add("00123", other, foreign);
  const response = await previewRequest({
    csv: previewCsv([
      {},
      {},
      { connection_id: second },
      { workspace_id: foreign },
      { connection_id: other },
      { sender_id: "'missing" },
      { tags_json: '[""]' },
      { sender_id: "00123" },
      { format_version: "2" },
      { channel: "telegram" },
    ]),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.counts, { total: 10, changed: 1, unchanged: 0, invalid: 5, duplicate: 2, not_found: 2 });
  assert.deepEqual(result.rows.slice(0, 2), [
    { row: 1, status: "duplicate" },
    { row: 2, status: "duplicate" },
  ]);
  assert.deepEqual(result.rows[4], { row: 5, status: "not_found" });
  assert.deepEqual(result.rows[5], { row: 6, status: "not_found" });
  assert.equal(JSON.stringify(result).includes(other), false);
});

test("CSV tag preview enforces admin same-origin shape file and record limits", async () => {
  const body = { csv: previewCsv([]) };
  for (const actor of [agent, randomUUID()]) assert.equal((await previewRequest(body, actor)).status, 403);
  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [admin, owner]);
  assert.equal((await previewRequest(body, admin)).status, 403);
  assert.equal((await previewRequest(body, owner, "", "https://other.test")).status, 403);
  for (const input of [
    {},
    { csv: 3 },
    { ...body, apply: true },
    { csv: '"broken' },
    { csv: "wrong,header" },
    { csv: previewCsv([]) + "\0" },
  ])
    assert.equal((await previewRequest(input)).status, 400);
  assert.equal((await previewRequest(body, owner, "?apply=true")).status, 400);
  assert.equal((await previewRequest({ csv: "x".repeat(128 * 1024 + 1) })).status, 422);
  assert.equal((await previewRequest({ csv: previewCsv(Array.from({ length: 501 }, () => ({}))) })).status, 422);
  const empty = await previewRequest(body);
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).counts.total, 0);
});

test("CSV preview rechecks a role downgrade and contact deletion in the final read", async () => {
  await add("00123");
  let reads = 0;
  const changing = (change: () => Promise<unknown>) =>
    ({
      query: async (sql: string, values: unknown[]) => {
        reads++;
        if (sql.includes("statement_timestamp()")) await change();
        return pool.query(sql, values);
      },
    }) as unknown as Pool;
  await assert.rejects(
    previewContactCsv(
      changing(() => pool.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [admin])),
      { id: admin, email: "admin@example.test" },
      { csv: previewCsv([{}]) },
    ),
    { status: 403, message: "role_forbidden" },
  );
  assert.equal(reads, 2);
  const result = await previewContactCsv(
    changing(() => pool.query("DELETE FROM instagram_comment_events WHERE connection_id=$1", [connection])),
    user,
    { csv: previewCsv([{}]) },
  );
  assert.deepEqual(result.rows, [{ row: 1, status: "not_found" }]);
});

test("CSV preview shows tag clearing and rejects invalid rows before duplicate detection", async () => {
  await add("00123");
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'00123',ARRAY['old'])",
    [workspace, connection],
  );
  const result = await previewContactCsv(pool, user, { csv: previewCsv([{ tags_json: "[]" }, { tags_json: '[""]' }]) });
  assert.equal(result.rows[0]!.status, "changed");
  assert.deepEqual(result.rows[0]!.proposed_tags, []);
  assert.deepEqual(result.rows[1], { row: 2, status: "invalid" });
  assert.deepEqual((await pool.query("SELECT tags FROM instagram_contact_tags")).rows[0].tags, ["old"]);
});

test("CSV tag apply writes exactly the changed rows once and a repeated file changes nothing", async () => {
  await add("00123");
  await add("00123", second);
  await add("90071992547409931234567890");
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'00123',ARRAY['old']),($1,$3,'00123',ARRAY['kept'])",
    [workspace, connection, second],
  );
  const file = previewCsv([
    {},
    { connection_id: second, tags_json: '["kept"]' },
    { sender_id: "'90071992547409931234567890", tags_json: '["=formula","<script>"]' },
  ]);
  const before = await databaseSnapshot();
  const preview = await previewContactCsv(pool, { id: admin, email: "admin@example.test" }, { csv: file });
  assert.equal(preview.counts.changed, 2);
  const response = await applyRequest(applyBody(file, preview), admin);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.ok(Number.isFinite(Date.parse(result.applied_at)));
  assert.deepEqual(result.counts, { total: 3, applied: 2, unchanged: 1 });
  assert.deepEqual(result.rows, [
    { row: 1, status: "applied", connection_id: connection, sender_id: "00123", previous_tags: ["old"], tags: ["new"] },
    { row: 2, status: "unchanged", connection_id: second, sender_id: "00123", previous_tags: ["kept"], tags: ["kept"] },
    {
      row: 3,
      status: "applied",
      connection_id: connection,
      sender_id: "90071992547409931234567890",
      previous_tags: [],
      tags: ["<script>", "=formula"],
    },
  ]);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(notifications, 0);
  const after = await databaseSnapshot();
  assert.deepEqual(
    Object.keys(before).filter((table) => JSON.stringify(before[table]) !== JSON.stringify(after[table])),
    ["instagram_contact_tags"],
  );
  assert.deepEqual(
    (await tagsByContact()).map((row) => [row.connection_id, row.sender_id, row.tags]),
    [
      [connection, "00123", ["new"]],
      [connection, "90071992547409931234567890", ["<script>", "=formula"]],
      [second, "00123", ["kept"]],
    ],
  );
  assert.ok(statements.includes("COMMIT"));
  statements.length = 0;
  const again = await previewContactCsv(pool, user, { csv: file });
  assert.equal(again.counts.changed, 0);
  const repeat = await applyRequest(applyBody(file, again));
  assert.equal(repeat.status, 200);
  const repeated = await repeat.json();
  assert.equal(repeated.counts.applied, 0);
  assert.ok(repeated.rows.every((row: { status: string }) => row.status === "unchanged"));
  assert.deepEqual(await databaseSnapshot(), after);
});

test("CSV tag apply refuses a file with an invalid duplicate or unavailable row and writes nothing", async () => {
  await add("00123");
  await add("00123", second);
  const other = randomUUID();
  await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,'foreign')", [
    other,
    foreign,
  ]);
  await add("00123", other, foreign);
  const before = await databaseSnapshot();
  for (const [bad, status] of [
    [{ tags_json: '[""]' }, "invalid"],
    [{ connection_id: second, tags_json: '["x"]' }, "duplicate"],
    [{ sender_id: "'missing" }, "not_found"],
    [{ connection_id: other }, "not_found"],
  ] as const) {
    const rows = [{}, { connection_id: second, tags_json: '["x"]' }, bad];
    const file = previewCsv(rows);
    const preview = await previewContactCsv(pool, user, { csv: file });
    const response = await applyRequest(applyBody(file, preview));
    assert.equal(response.status, 422, await response.clone().text());
    const body = await response.json();
    assert.equal(body.error, "contact_import_rejected");
    assert.ok(Number.isFinite(Date.parse(body.checked_at)));
    assert.equal(body.counts.total, 3);
    assert.equal(body.rows[0].status, "changed");
    assert.equal(body.rows[1].status, status === "duplicate" ? "duplicate" : "changed");
    assert.equal(body.rows[2].status, status);
    assert.equal(JSON.stringify(body).includes(other), false);
    assert.ok(statements.includes("ROLLBACK"));
    assert.equal(statements.includes("COMMIT"), false);
    statements.length = 0;
  }
  assert.deepEqual(await databaseSnapshot(), before);
});

test("CSV tag apply refuses stale rows after an edit committed before its read or started after its locks", async () => {
  await add("00123");
  await add("456");
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'00123',ARRAY['old'])",
    [workspace, connection],
  );
  const file = previewCsv([{}, { sender_id: "'456", tags_json: '["second"]' }]);
  const preview = await previewContactCsv(pool, user, { csv: file });
  assert.equal(preview.counts.changed, 2);
  const body = applyBody(file, preview);
  // 1. The edit commits before the apply reads: it runs right after the workspace import lock.
  afterQuery = async (_client, sql) => {
    if (sql.includes("contact-import:")) await saveContactTags(pool, user, connection, "00123", { tags: ["edited"] });
  };
  const stale = await applyRequest(body);
  assert.equal(stale.status, 409, await stale.clone().text());
  const staleBody = await stale.json();
  assert.equal(staleBody.error, "contact_import_stale");
  assert.deepEqual(staleBody.rows[0].current_tags, ["edited"]);
  assert.equal(staleBody.rows[1].status, "changed");
  assert.deepEqual(
    (await tagsByContact()).map((row) => row.tags),
    [["edited"]],
  );
  afterQuery = undefined;
  await pool.query("UPDATE instagram_contact_tags SET tags=ARRAY['old']");
  // 2. A manual save holds the contact lock when the apply starts: the apply must wait before its read.
  const waitFor = async (check: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 200 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(await check(), "condition never held");
  };
  const snapshotSql = "statement_timestamp() AS checked_at";
  const holdContact = async (edit: string[] | null) => {
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await lockContactConnection(holder, workspace, connection);
    await lockContact(holder, connection, "00123");
    statements.length = 0;
    const applying = applyContactCsv(tracked(), user, body);
    await waitFor(
      async () =>
        (await pool.query("SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype='advisory' AND NOT granted"))
          .rows[0].waiting === 1,
    );
    assert.equal(
      statements.some((sql) => sql.includes(snapshotSql)),
      false,
      "the apply must not read before it holds every contact lock",
    );
    if (edit) await holder.query("UPDATE instagram_contact_tags SET tags=$1 WHERE sender_id='00123'", [edit]);
    await holder.query("COMMIT");
    holder.release();
    return applying;
  };
  const refused = await holdContact(["edited"]);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body.rows[0]!.current_tags, ["edited"]);
  assert.deepEqual(
    (await tagsByContact()).map((row) => row.tags),
    [["edited"]],
  );
  await pool.query("UPDATE instagram_contact_tags SET tags=ARRAY['old']");
  const applied = await holdContact(null);
  assert.equal(applied.status, 200);
  assert.deepEqual(
    (await tagsByContact()).map((row) => [row.sender_id, row.tags]),
    [
      ["00123", ["new"]],
      ["456", ["second"]],
    ],
  );
});

test("CSV tag apply refuses when a changed contact disappears between its read and its write", async () => {
  await add("00123");
  await add("456");
  const file = previewCsv([{}, { sender_id: "'456" }]);
  const preview = await previewContactCsv(pool, user, { csv: file });
  const before = await databaseSnapshot();
  afterQuery = async (_client, sql) => {
    if (sql.includes("statement_timestamp() AS checked_at"))
      await pool.query("DELETE FROM instagram_comment_events WHERE sender_id='456'");
  };
  const response = await applyRequest(applyBody(file, preview));
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error, "contact_import_stale");
  assert.equal(statements.includes("COMMIT"), false);
  const after = await databaseSnapshot();
  assert.deepEqual(after.instagram_contact_tags, before.instagram_contact_tags);
  assert.equal((after.instagram_comment_events as unknown[]).length, 1);
});

test("CSV tag apply enforces admin membership query shape and body limits without writes", async () => {
  await add("00123");
  const file = previewCsv([{}]);
  const preview = await previewContactCsv(pool, user, { csv: file });
  const body = applyBody(file, preview);
  const before = await databaseSnapshot();
  for (const actor of [agent, randomUUID()]) assert.equal((await applyRequest(body, actor)).status, 403);
  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [admin, owner]);
  assert.equal((await applyRequest(body, admin)).status, 403);
  assert.equal((await applyRequest(body, owner, "?dry_run=true")).status, 400);
  for (const input of [
    { csv: file },
    { ...body, apply: true },
    { csv: file, expected: [{ row: "1", current_tags: ["old"] }] },
    { csv: file, expected: [{ row: 1.5, current_tags: [] }] },
    { csv: file, expected: [{ row: 2, current_tags: [] }] },
    { csv: file, expected: [{ row: 1, current_tags: [1] }] },
    {
      csv: file,
      expected: [
        { row: 1, current_tags: [] },
        { row: 1, current_tags: [] },
      ],
    },
    { csv: file, expected: [{ row: 1, current_tags: [], extra: true }] },
  ])
    assert.equal((await applyRequest(input)).status, 400, JSON.stringify(input).slice(0, 80));
  assert.equal(
    (await applyRequest(undefined, owner, "", "x".repeat(CONTACT_IMPORT_APPLY_REQUEST_BYTES + 1))).status,
    413,
  );
  // The preview recheck inside the transaction refuses a role lost after workspaceFor.
  afterQuery = async (_client, sql) => {
    if (sql.includes("contact-import:"))
      await pool.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [owner]);
  };
  assert.equal((await applyRequest(body)).status, 403);
  afterQuery = undefined;
  assert.equal(notifications, 0);
  const after = await databaseSnapshot();
  assert.deepEqual(after.instagram_contact_tags, before.instagram_contact_tags);
  assert.deepEqual(after.instagram_comment_events, before.instagram_comment_events);
});

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

// Segment export (#26): one fixture whose contacts each condition kind separates, evaluated at a fixed clock.
const asOf = "2026-10-10T03:00:00.000000Z";
// listContacts evaluates at statement_timestamp(); pin it as settings.db.test.ts relativeClock does.
function listClock(): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) =>
      pool.query(sql.replace("statement_timestamp()", `'${asOf}'::timestamptz`), values),
  } as unknown as Pool;
}
// The export takes its one evaluation time from the exported_at read (transaction_timestamp()); pin that read.
const exportClock = (query: QueryConfig) =>
  query.text.includes("transaction_timestamp()")
    ? { ...query, text: query.text.replace("transaction_timestamp()", `'${asOf}'::timestamptz`) }
    : query;
async function comment(sender: string, at: string, conn = connection) {
  await pool.query(
    "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at) VALUES($1,$2,$3,'media',$4,'RAW COMMENT SECRET',$5)",
    [workspace, conn, randomUUID(), sender, at],
  );
}
async function segmentFixture() {
  // Latest comments, in Asia/Seoul (the workspace default) relative to asOf (12:00 on 2026-10-10 local).
  await comment("a", "2026-10-10T01:00:00.000000Z");
  await comment("b", "2026-10-09T10:00:00.000000Z"); // 19:00 local yesterday
  await comment("c", "2026-10-05T00:00:00.000000Z");
  await comment("d", "2026-10-10T02:59:59.999999Z");
  await comment("e", "2026-10-10T02:00:00.000000Z", second);
  await comment("f", asOf);
  await comment("g", "2026-10-01T00:00:00.000000Z");
  await comment("g", "2026-10-10T01:30:00.000000Z");
  for (const [sender, tags, conn] of [
    ["a", ["lead", "vip"], connection],
    ["b", ["lead"], connection],
    ["c", ["vip"], connection],
    ["e", ["lead"], second],
  ] as const)
    await saveContactTags(pool, user, conn, sender, { tags });
  const field = async (name: string, type: string) =>
    (
      await pool.query("INSERT INTO instagram_contact_fields(workspace_id,name,type) VALUES($1,$2,$3) RETURNING id", [
        workspace,
        name,
        type,
      ])
    ).rows[0].id as string;
  const score = await field("score", "number"),
    plan = await field("plan", "text");
  for (const [sender, id, value, conn] of [
    ["a", score, "10", connection],
    ["b", score, "3", connection],
    ["e", score, "10", second],
    ["a", plan, '"pro"', connection],
    ["c", plan, '"pro"', connection],
  ] as const)
    await pool.query(
      "INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,$3,$4,$5::jsonb)",
      [workspace, conn, sender, id, value],
    );
  for (const [sender, decision] of [
    ["a", "grant"],
    ["c", "revoke"],
  ] as const)
    await recordChannelConsentEvent(pool, {
      requestKey: randomUUID(),
      workspaceId: workspace,
      connectionId: connection,
      channel: "instagram",
      identityKind: "comment_sender",
      identityValue: sender,
      purpose: "marketing",
      decision,
      evidenceKind: "explicit",
      evidenceReference: "test evidence",
      occurredAt: new Date("2026-10-01T00:00:00Z"),
      actorId: owner,
    });
  return { score, plan };
}
const pairs = (rows: { connection_id: string; sender_id: string }[]) =>
  rows.map((row) => `${row.connection_id === second ? "second" : "first"}:${row.sender_id}`).sort();

test("segment export selects exactly the contact list's segment contacts for every condition kind at one clock", async () => {
  const { score, plan } = await segmentFixture();
  const definitions: [Record<string, unknown>, string[]][] = [
    [{ tag: "lead" }, ["a", "b", "second:e"]],
    [{ tags: ["lead", "vip"], tag_mode: "all" }, ["a"]],
    [{ tags: ["lead", "vip"], tag_mode: "any" }, ["a", "b", "c", "second:e"]],
    [{ field_id: score, field_operator: "gte", field_value: 5 }, ["a", "second:e"]],
    [
      {
        field_conditions: [
          { field_id: score, field_operator: "gte", field_value: 5 },
          { field_id: plan, field_operator: "eq", field_value: "pro" },
        ],
        field_mode: "all",
      },
      ["a"],
    ],
    [
      {
        field_conditions: [
          { field_id: score, field_operator: "gte", field_value: 5 },
          { field_id: plan, field_operator: "eq", field_value: "pro" },
        ],
        field_mode: "any",
      },
      ["a", "c", "second:e"],
    ],
    [
      { tag: "vip", field_id: score, field_operator: "gte", field_value: 5, condition_operator: "or" },
      ["a", "c", "second:e"],
    ],
    [
      { last_comment_from: "2026-10-09T00:00:00.000Z", last_comment_before: "2026-10-10T02:00:00.000Z" },
      ["a", "b", "g"],
    ],
    [{ last_comment_days: 3 }, ["a", "b", "d", "g", "second:e"]],
    [{ last_comment_period: "today" }, ["a", "d", "f", "g", "second:e"]],
    [{ consent_purpose: "marketing", consent_state: "granted" }, ["a"]],
    [{ consent_purpose: "marketing", consent_state: "no_record" }, ["b", "d", "f", "g", "second:e"]],
    [{ connection_id: connection, tag: "lead" }, ["a", "b"]],
  ];
  changeQuery = exportClock;
  const clocks: unknown[] = [];
  afterQuery = async (_client, sql) => {
    // The clock follows the predicate's 19 values and the batch size.
    if (sql.includes("evaluation AS MATERIALIZED")) assert.match(sql, /SELECT \$21::timestamptz AS as_of/);
  };
  const full = records((await csv.exportContactCsv(tracked(), user)).body);
  for (const [index, [definition, expected]] of definitions.entries()) {
    const segment = await createContactSegment(pool, user, { name: `segment ${index}`, ...definition });
    const listed = await listContacts(listClock(), user, new URLSearchParams({ segment_id: segment.id }));
    assert.equal(listed.after, null);
    const names = (rows: { connection_id: string; sender_id: string }[]) =>
      pairs(rows).map((pair) => pair.replace(/^first:/, ""));
    assert.deepEqual(names(listed.contacts), [...expected].sort(), JSON.stringify(definition));
    const tracking: (query: QueryConfig) => QueryConfig = exportClock;
    changeQuery = (query) => {
      if (query.text.includes("evaluation AS MATERIALIZED")) clocks.push(query.values?.[20]);
      return tracking(query);
    };
    const exported = await csv.exportContactCsv(tracked(), user, { batchSize: 2 }, segment.id);
    changeQuery = tracking;
    assert.equal(exported.exportedAt, asOf);
    assert.equal(exported.segmentId, segment.id);
    const rows = records(exported.body);
    assert.deepEqual(
      pairs(rows.map((row) => ({ connection_id: row.connection_id!, sender_id: decodeContactScalar(row.sender_id!) }))),
      pairs(listed.contacts),
      JSON.stringify(definition),
    );
    // The same v1 rows as the full export, in its order, filtered to the segment.
    const selected = new Set(rows.map((row) => `${row.connection_id}:${row.sender_id}`));
    assert.deepEqual(
      rows,
      full.filter((row) => selected.has(`${row.connection_id}:${row.sender_id}`)),
    );
  }
  // Every batch of every export evaluated the window at that export's exported_at.
  assert.ok(clocks.length > definitions.length);
  assert.deepEqual(new Set(clocks), new Set([asOf]));
});

test("segment export evaluates one as_of for all batches even while the clock moves", async () => {
  await segmentFixture();
  // A relative window over the real clock, wide enough that every contact is in it and each batch evaluates it.
  const segment = await createContactSegment(pool, user, { name: "recent", last_comment_days: 366 });
  const clocks: unknown[] = [];
  changeQuery = (query) => {
    if (query.text.includes("evaluation AS MATERIALIZED")) clocks.push(query.values?.[20]);
    return query;
  };
  afterQuery = async (_client, sql) => {
    if (sql.includes("evaluation AS MATERIALIZED")) await pool.query("SELECT pg_sleep(0.01)");
  };
  const exported = await csv.exportContactCsv(tracked(), user, { batchSize: 1 }, segment.id);
  assert.equal(clocks.length, 8);
  assert.equal(records(exported.body).length, 7);
  assert.deepEqual(new Set(clocks), new Set([exported.exportedAt]));
  assert.ok(statements.some((sql) => sql.includes("instagram_contact_segments")));
});

test("segment export answers segment_not_found for archived missing and foreign segments, and refuses agent and removed members", async () => {
  await add("00123");
  const archived = await createContactSegment(pool, user, { name: "archived" });
  await archiveContactSegment(pool, user, archived.id);
  const foreignSegment = (
    await pool.query("INSERT INTO instagram_contact_segments(workspace_id,name) VALUES($1,'foreign') RETURNING id", [
      foreign,
    ])
  ).rows[0].id as string;
  for (const id of [archived.id, randomUUID(), foreignSegment]) {
    const response = await request(owner, `?segment_id=${id}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "segment_not_found" });
    assert.equal(response.headers.has("content-disposition"), false);
  }
  const active = await createContactSegment(pool, user, { name: "active" });
  // The role is checked before the segment is read, so an agent learns nothing about a segment ID.
  for (const id of [active.id, randomUUID()]) {
    const response = await request(agent, `?segment_id=${id}`);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "role_forbidden" });
  }
  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [admin, owner]);
  const removed = await request(admin, `?segment_id=${active.id}`);
  assert.equal(removed.status, 403);
  assert.deepEqual(await removed.json(), { error: "workspace_required" });
  // The segment is read inside the snapshot transaction, after BEGIN and the membership read.
  statements.length = 0;
  await request(owner, `?segment_id=${randomUUID()}`);
  const begin = statements.findIndex((sql) => sql.startsWith("BEGIN"));
  const read = statements.findIndex((sql) => sql.includes("FROM instagram_contact_segments"));
  assert.ok(begin >= 0 && read > begin);
  assert.ok(statements.includes("ROLLBACK"));
});

test("segment export refuses an oversized selection whole, returns only the header when empty and changes no table", async () => {
  await segmentFixture();
  const lead = await createContactSegment(pool, user, { name: "Lead buyers", tag: "lead" });
  await assert.rejects(csv.exportContactCsv(tracked(), user, { maxRows: 2, batchSize: 1 }, lead.id), {
    status: 422,
    message: "contact_export_too_large",
  });
  assert.ok(statements.includes("ROLLBACK"));
  assert.equal(statements.includes("COMMIT"), false);
  statements.length = 0;
  await assert.rejects(csv.exportContactCsv(tracked(), user, { maxBytes: 700 }, lead.id), {
    status: 422,
    message: "contact_export_too_large",
  });
  assert.equal(statements.includes("COMMIT"), false);
  // Three lead contacts fit in three rows: the refusal above is the limit, not the segment.
  assert.equal(records((await csv.exportContactCsv(tracked(), user, { maxRows: 3 }, lead.id)).body).length, 3);
  const empty = await createContactSegment(pool, user, { name: "Nobody yet", tag: "nobody" });
  const before = await databaseSnapshot();
  for (const id of [empty.id, lead.id]) {
    const response = await request(admin, `?segment_id=${id.toUpperCase()}`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      response.headers.get("content-disposition") ?? "",
      new RegExp(`^attachment; filename="auto-chatter-contacts-v1-segment-${id}-\\d{4}-\\d{2}-\\d{2}\\.csv"$`),
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
    const parsed = parseContactCsv(bytes.toString());
    assert.deepEqual(parsed[0], Array.from(csv.CONTACT_CSV_HEADER));
    assert.equal(parsed.length - 1, id === empty.id ? 0 : 3);
    assert.doesNotMatch(bytes.toString(), /RAW COMMENT SECRET|Lead buyers|Nobody yet/);
  }
  assert.deepEqual(await databaseSnapshot(), before);
  assert.equal(notifications, 0);
});
