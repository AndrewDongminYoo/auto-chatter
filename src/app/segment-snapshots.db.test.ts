import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { appApi } from "./api.ts";
import { ApiError } from "./auth.ts";
import { archiveContactSegment, createContactSegment, listContacts, saveContactTags } from "./contacts.ts";
import { parseContactCsv, decodeContactScalar } from "./contact-csv-test-utils.ts";
import {
  SEGMENT_SNAPSHOT_CSV_HEADER,
  SEGMENT_SNAPSHOT_LIMITS,
  createSegmentSnapshot,
  getSegmentSnapshot,
  listSegmentSnapshots,
} from "./segment-snapshots.ts";
import { EXPORTED_TABLES } from "./workspace-export.ts";
import { recordChannelConsentEvent } from "../instagram/channel-consent.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl });
const workspace = "11111111-1111-4111-8111-111111111111",
  foreign = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333",
  C2 = "44444444-4444-4444-8444-444444444444",
  FC = "99999999-9999-4999-8999-999999999999";
const ownerId = "55555555-5555-4555-8555-555555555555",
  adminId = "66666666-6666-4666-8666-666666666666",
  agentId = "77777777-7777-4777-8777-777777777777",
  outsiderId = "88888888-8888-4888-8888-888888888888";
const owner = { id: ownerId, email: "owner@example.test" };
const admin = { id: adminId, email: "admin@example.test" };
const agent = { id: agentId, email: "agent@example.test" };
const asOf = "2026-10-10T03:00:00.000000Z";
let sequence = 0;
let changeQuery: ((query: QueryConfig) => QueryConfig) | undefined;
let afterQuery: ((client: PoolClient, sql: string) => Promise<void>) | undefined;
const statements: string[] = [];

// The snapshot evaluates at its statement's statement_timestamp(); pin it as the CSV tests pin their clocks.
const pinned = (query: QueryConfig) =>
  query.text.includes("statement_timestamp()")
    ? { ...query, text: query.text.replace("statement_timestamp()", `'${asOf}'::timestamptz`) }
    : query;
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
        release: (destroy?: boolean | Error) => client.release(destroy),
      };
    },
    query: pool.query.bind(pool),
    end: async () => {},
  }) as unknown as Pool;
function listClock(): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) =>
      pool.query(sql.replace("statement_timestamp()", `'${asOf}'::timestamptz`), values),
  } as unknown as Pool;
}
const env = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  CONTACT_EXPORT_LIMIT: { limit: async () => ({ success: true }) },
  API_WRITE_USER_LIMIT: { limit: async () => ({ success: true }) },
  API_WRITE_WORKSPACE_LIMIT: { limit: async () => ({ success: true }) },
};
function request(actor: string, method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { cookie: "__Host-ac-access=test", origin: "https://app.test", ...headers },
      ...(body === undefined ? {} : { body }),
    }),
    env,
    tracked,
    (async () =>
      Response.json({ id: actor, email: "member@example.test", email_confirmed_at: "2026-10-18" })) as typeof fetch,
  );
}

before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  changeQuery = undefined;
  afterQuery = undefined;
  statements.length = 0;
  await pool.query("TRUNCATE workspaces,workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspace, foreign]);
  await pool.query(
    "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')",
    [workspace, ownerId, adminId, agentId, foreign, outsiderId],
  );
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,inbox_enabled,inbox_enabled_at) VALUES
     ($1,$4,'100','shop',true,now()-interval '1 day'),($2,$4,'101',NULL,false,NULL),($3,$5,'103','foreign',false,NULL)`,
    [C, C2, FC, workspace, foreign],
  );
});
after(async () => pool.end());

async function comment(sender: string, at: string, conn = C, ws = workspace) {
  sequence++;
  return (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at)
       VALUES($1,$2,$3,$3,$4,'RAW COMMENT SECRET',$5) RETURNING id::text,comment_id,media_id`,
      [ws, conn, `comment-${sequence}`, sender, at],
    )
  ).rows[0] as { id: string; comment_id: string; media_id: string };
}
// A provider-acknowledged reply from sender to a numeric DM recipient and a stored DM from it: a verified bridge.
async function bridge(sender: string, recipient: string, conn = C) {
  const event = await comment(sender, "2026-10-09T00:00:00.000000Z", conn);
  const rule = (
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text)
       VALUES(gen_random_uuid(),$1,$2,$3,'hello','reply') RETURNING id`,
      [workspace, conn, event.media_id],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,
     private_reply_text,recipient_id,status,provider_message_id,sent_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'reply',$8,'sent','acknowledged',now()-interval '1 hour')`,
    [workspace, conn, event.id, rule, event.comment_id, event.media_id, sender, recipient],
  );
  sequence++;
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,$4,'RAW DM SECRET','text',now())`,
    [workspace, conn, recipient, `dm-${sequence}`],
  );
}
async function consent(kind: "comment_sender" | "dm_recipient", value: string, decision: "grant" | "revoke") {
  await recordChannelConsentEvent(pool, {
    requestKey: randomUUID(),
    workspaceId: workspace,
    connectionId: C,
    channel: "instagram",
    identityKind: kind,
    identityValue: value,
    purpose: "marketing",
    decision,
    evidenceKind: "explicit",
    evidenceReference: "test evidence",
    occurredAt: new Date("2026-10-01T00:00:00Z"),
    actorId: ownerId,
  });
}
// The CSV segment fixture's contacts (latest comments relative to asOf), with a verified DM bridge for a.
async function fixture() {
  await comment("a", "2026-10-10T01:00:00.000000Z");
  await comment("b", "2026-10-09T10:00:00.000000Z");
  await comment("c", "2026-10-05T00:00:00.000000Z");
  await comment("d", "2026-10-10T02:59:59.999999Z");
  await comment("e", "2026-10-10T02:00:00.000000Z", C2);
  await comment("f", asOf);
  await comment("00123", "2026-10-01T00:00:00.000000Z");
  for (const [sender, tags, conn] of [
    ["a", ["lead", "vip"], C],
    ["b", ["lead"], C],
    ["c", ["vip"], C],
    ["e", ["lead"], C2],
  ] as const)
    await saveContactTags(pool, owner, conn, sender, { tags });
  const score = (
    await pool.query(
      "INSERT INTO instagram_contact_fields(workspace_id,name,type) VALUES($1,'score','number') RETURNING id",
      [workspace],
    )
  ).rows[0].id as string;
  for (const [sender, value, conn] of [
    ["a", "10", C],
    ["b", "3", C],
    ["e", "10", C2],
  ] as const)
    await pool.query(
      "INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,$3,$4,$5::jsonb)",
      [workspace, conn, sender, score, value],
    );
  await consent("comment_sender", "a", "grant");
  await consent("comment_sender", "c", "revoke");
  await bridge("a", "9001");
  await bridge("b", "9002");
  await consent("dm_recipient", "9001", "grant");
  return { score };
}
const pairs = (rows: { connection_id: string; sender_id: string }[]) =>
  rows.map((row) => `${row.connection_id === C2 ? "second:" : ""}${row.sender_id}`);
async function members(snapshot: string) {
  return (
    await pool.query(
      `SELECT connection_id,sender_id FROM instagram_segment_snapshot_members WHERE snapshot_id=$1
       ORDER BY connection_id,sender_id COLLATE "C"`,
      [snapshot],
    )
  ).rows as { connection_id: string; sender_id: string }[];
}
async function tableCounts() {
  return (
    await pool.query(
      `SELECT (SELECT count(*)::int FROM instagram_segment_snapshots) AS snapshots,
              (SELECT count(*)::int FROM instagram_segment_snapshot_members) AS members`,
    )
  ).rows[0] as { snapshots: number; members: number };
}
async function lockWaiters(count: number) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const waiting = Number(
      (
        await pool.query(
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
        )
      ).rows[0].count,
    );
    if (waiting >= count) return;
    if (Date.now() > deadline) throw new Error(`expected ${count} lock waiters, saw ${waiting}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const CONNECTION_LOCK =
  "SELECT id FROM instagram_connections WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY id FOR SHARE";

test("a snapshot's members and counts equal the segment list and preview at the same clock for every condition kind", async () => {
  const { score } = await fixture();
  const definitions: [Record<string, unknown>, string[]][] = [
    [{}, ["00123", "a", "b", "c", "d", "f", "second:e"]],
    [{ tag: "lead" }, ["a", "b", "second:e"]],
    [{ tags: ["lead", "vip"], tag_mode: "any" }, ["a", "b", "c", "second:e"]],
    [{ field_id: score, field_operator: "gte", field_value: 5 }, ["a", "second:e"]],
    [{ last_comment_days: 3 }, ["a", "b", "d", "second:e"]],
    [{ last_comment_period: "today" }, ["a", "d", "f", "second:e"]],
    [{ consent_purpose: "marketing", consent_state: "granted" }, ["a"]],
    // The DM consent condition reads the verified bridge: a's recipient has the grant, b's has no record.
    [{ dm_consent_purpose: "marketing", dm_consent_state: "granted" }, ["a"]],
    [{ dm_consent_purpose: "marketing", dm_consent_state: "no_record" }, ["b"]],
    [
      {
        condition_tree: {
          mode: "any",
          groups: [
            { mode: "all", conditions: [{ tag: "lead" }, { tag: "vip", negate: true }] },
            { mode: "all", conditions: [{ field_id: score, field_operator: "gte", field_value: 5 }] },
          ],
        },
      },
      ["a", "b", "second:e"],
    ],
    [{ connection_id: C, tag: "lead" }, ["a", "b"]],
    [{ tag: "nobody" }, []],
  ];
  changeQuery = pinned;
  for (const [index, [definition, expected]] of definitions.entries()) {
    const segment = await createContactSegment(pool, owner, { name: `segment ${index}`, ...definition });
    const listed = await listContacts(listClock(), owner, new URLSearchParams({ segment_id: segment.id }));
    assert.deepEqual(pairs(listed.contacts), expected, JSON.stringify(definition));
    const preview = await listContacts(
      listClock(),
      owner,
      new URLSearchParams({ segment_id: segment.id, preview: "true" }),
    );
    const saved = await createSegmentSnapshot(tracked(), admin, segment.id, undefined);
    assert.equal(saved.as_of, asOf);
    assert.equal(saved.segment_id, segment.id);
    assert.equal(saved.segment_name, `segment ${index}`);
    assert.deepEqual(saved.counts, { total: preview.total, evaluated: preview.evaluated, excluded: preview.excluded });
    assert.equal(saved.member_count, expected.length);
    assert.equal(String(saved.member_count), preview.total);
    const stored = await members(saved.id);
    assert.deepEqual(pairs(stored), pairs(listed.contacts), JSON.stringify(definition));
    // The definition copy is the segment API's item without its ID and name, version included.
    const row = (
      await pool.query("SELECT definition,created_by FROM instagram_segment_snapshots WHERE id=$1", [saved.id])
    ).rows[0];
    const { id: _id, name: _name, ...copy } = segment;
    assert.deepEqual(row.definition, copy);
    assert.equal(row.created_by, adminId);
  }
});

test("the HTTP routes create, list, read pages of and download a snapshot with identifiers only", async () => {
  await fixture();
  const segment = await createContactSegment(pool, owner, { name: "Lead buyers", tag: "lead" });
  changeQuery = pinned;
  const created = await request(ownerId, "POST", `/api/contact-segments/${segment.id}/snapshots`);
  assert.equal(created.status, 201, await created.clone().text());
  const summary = await created.json();
  assert.deepEqual(Object.keys(summary).sort(), [
    "as_of",
    "counts",
    "created_at",
    "id",
    "member_count",
    "segment_id",
    "segment_name",
  ]);
  assert.equal(summary.member_count, 3);
  // An explicit {} body is the same request.
  const second = await request(ownerId, "POST", `/api/contact-segments/${segment.id}/snapshots`, "{}", {
    "content-type": "application/json",
  });
  assert.equal(second.status, 201);
  const secondSummary = await second.json();
  for (const body of ['{"note":"x"}', "[]", "null", '"text"'])
    assert.deepEqual(
      await (
        await request(ownerId, "POST", `/api/contact-segments/${segment.id}/snapshots`, body, {
          "content-type": "application/json",
        })
      ).json(),
      { error: "invalid_snapshot_request" },
      body,
    );
  const listed = await (await request(adminId, "GET", `/api/contact-segments/${segment.id}/snapshots`)).json();
  assert.deepEqual(
    listed.snapshots.map((item: { id: string }) => item.id),
    [secondSummary.id, summary.id],
  );
  const detail = await (await request(adminId, "GET", `/api/segment-snapshots/${summary.id}`)).json();
  assert.deepEqual(Object.keys(detail).sort(), ["after", "members", "snapshot"]);
  assert.equal(detail.snapshot.stored_member_count, 3);
  assert.equal(detail.snapshot.created_by, ownerId);
  assert.deepEqual(detail.snapshot.definition, { connection_id: null, tag: "lead", version: 1 });
  assert.deepEqual(detail.members, [
    { connection_id: C, sender_id: "a" },
    { connection_id: C, sender_id: "b" },
    { connection_id: C2, sender_id: "e" },
  ]);
  assert.equal(detail.after, null);
  const csv = await request(adminId, "GET", `/api/segment-snapshots/${summary.id}/members.csv`);
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(csv.headers.get("cache-control"), "no-store");
  assert.equal(
    csv.headers.get("content-disposition"),
    `attachment; filename="auto-chatter-segment-snapshot-${summary.id}-2026-10-10.csv"`,
  );
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
  const rows = parseContactCsv(bytes.toString());
  assert.deepEqual(rows[0], Array.from(SEGMENT_SNAPSHOT_CSV_HEADER));
  assert.deepEqual(
    rows.slice(1).map((row) => [row[7], decodeContactScalar(row[8]!)]),
    [
      [C, "a"],
      [C, "b"],
      [C2, "e"],
    ],
  );
  for (const row of rows.slice(1)) {
    assert.deepEqual(row.slice(0, 7), ["1", summary.id, segment.id, asOf, workspace, "instagram", "comment_sender"]);
    assert.ok(row[8]!.startsWith("'"));
  }
  assert.doesNotMatch(bytes.toString(), /RAW COMMENT SECRET|RAW DM SECRET|Lead buyers|shop|9001/);
  assert.equal((await request(adminId, "GET", `/api/segment-snapshots/${summary.id}/members.csv?x=1`)).status, 400);
  for (const query of ["?after=", "?after=!!", "?page=1", "?after=a&after=b"])
    assert.equal((await request(adminId, "GET", `/api/segment-snapshots/${summary.id}${query}`)).status, 400, query);
  // Freezing sends nothing: no delivery row is created.
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM private_reply_outbox")).rows[0].count, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM webhook_deliveries")).rows[0].count, 0);
});

test("member pages follow (connection_id, sender_id) with an opaque cursor", async () => {
  for (let index = 0; index < 52; index++) await comment(`s${String(index).padStart(3, "0")}`, "2026-10-09T00:00:00Z");
  await comment("Z", "2026-10-09T00:00:00Z");
  const segment = await createContactSegment(pool, owner, { name: "Everyone" });
  const saved = await createSegmentSnapshot(pool, owner, segment.id, {});
  assert.equal(saved.member_count, 53);
  const first = await getSegmentSnapshot(pool, owner, saved.id);
  assert.equal(first.members.length, SEGMENT_SNAPSHOT_LIMITS.pageSize);
  // "C" collation: the capital Z sorts before the lowercase senders.
  assert.equal(first.members[0]!.sender_id, "Z");
  assert.ok(first.after);
  const next = await getSegmentSnapshot(pool, owner, saved.id, new URLSearchParams({ after: first.after! }));
  assert.deepEqual(
    next.members.map((member) => member.sender_id),
    ["s049", "s050", "s051"],
  );
  assert.equal(next.after, null);
});

test("more than 5,000 members refuses the whole snapshot and an empty audience stores zero members", async () => {
  assert.equal(SEGMENT_SNAPSHOT_LIMITS.maxMembers, 5000);
  await pool.query(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     SELECT $1,$2,'bulk-'||n,'media','bulk-'||n,'x' FROM generate_series(1,5001) n`,
    [workspace, C],
  );
  const everyone = await createContactSegment(pool, owner, { name: "Everyone" });
  await assert.rejects(createSegmentSnapshot(pool, owner, everyone.id, undefined), {
    status: 409,
    message: "snapshot_too_large",
  });
  assert.deepEqual(await tableCounts(), { snapshots: 0, members: 0 });
  await pool.query("DELETE FROM instagram_comment_events WHERE sender_id='bulk-5001'");
  const full = await createSegmentSnapshot(pool, owner, everyone.id, undefined);
  assert.equal(full.member_count, 5000);
  assert.deepEqual(await tableCounts(), { snapshots: 1, members: 5000 });
  const nobody = await createContactSegment(pool, owner, { name: "Nobody", tag: "nobody" });
  const empty = await createSegmentSnapshot(pool, owner, nobody.id, undefined);
  assert.equal(empty.member_count, 0);
  assert.equal(empty.counts.total, "0");
  assert.equal(empty.counts.evaluated, "5000");
  assert.deepEqual(await members(empty.id), []);
});

test("at most 200 snapshots per workspace, counted under the workspace lock while two creations race", async () => {
  await comment("a", "2026-10-09T00:00:00Z");
  const segment = await createContactSegment(pool, owner, { name: "Everyone" });
  await pool.query(
    `INSERT INTO instagram_segment_snapshots(workspace_id,segment_id,created_by,as_of,definition,segment_name,counts,member_count)
     SELECT $1,$2,$3,now(),'{}','Everyone','{}',0 FROM generate_series(1,199)`,
    [workspace, segment.id, ownerId],
  );
  // A foreign workspace's snapshots do not count.
  const foreignSegment = (
    await pool.query("INSERT INTO instagram_contact_segments(workspace_id,name) VALUES($1,'foreign') RETURNING id", [
      foreign,
    ])
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_segment_snapshots(workspace_id,segment_id,created_by,as_of,definition,segment_name,counts,member_count)
     VALUES($1,$2,$3,now(),'{}','foreign','{}',0)`,
    [foreign, foreignSegment, outsiderId],
  );
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspace]);
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        () => "created",
        (error: unknown) => (error instanceof ApiError ? error.message : String(error)),
      );
    const racing = [
      outcome(createSegmentSnapshot(pool, owner, segment.id, undefined)),
      outcome(createSegmentSnapshot(pool, admin, segment.id, undefined)),
    ];
    await lockWaiters(2);
    await blocker.query("COMMIT");
    assert.deepEqual((await Promise.all(racing)).sort(), ["created", "snapshot_limit_reached"]);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  assert.equal(
    (
      await pool.query("SELECT count(*)::int AS count FROM instagram_segment_snapshots WHERE workspace_id=$1", [
        workspace,
      ])
    ).rows[0].count,
    200,
  );
  await assert.rejects(createSegmentSnapshot(pool, owner, segment.id, undefined), {
    status: 409,
    message: "snapshot_limit_reached",
  });
});

test("the stored member rows of a workspace stay within the budget that keeps the workspace export open", async () => {
  // 20,000 member rows of about 200 bytes each use 40% of the export's 50,000 rows and under a quarter of its 20 MiB.
  assert.equal(SEGMENT_SNAPSHOT_LIMITS.maxStoredMembers, 20_000);
  await comment("a", "2026-10-09T00:00:00Z");
  await comment("b", "2026-10-09T00:00:00Z");
  await comment("c", "2026-10-09T00:00:00Z", C2);
  const everyone = await createContactSegment(pool, owner, { name: "Everyone" });
  const one = await createContactSegment(pool, owner, { name: "One", connection_id: C2 });
  // A foreign workspace's member rows do not count.
  await comment("f1", "2026-10-09T00:00:00Z", FC, foreign);
  await comment("f2", "2026-10-09T00:00:00Z", FC, foreign);
  const outsider = { id: outsiderId, email: "outsider@example.test" };
  const foreignSegment = await createContactSegment(pool, outsider, { name: "Foreign" });
  assert.equal((await createSegmentSnapshot(pool, outsider, foreignSegment.id, undefined)).member_count, 2);
  const limits = { maxStoredMembers: 4 };
  assert.equal((await createSegmentSnapshot(pool, owner, everyone.id, undefined, limits)).member_count, 3);
  const before = await tableCounts();
  await assert.rejects(createSegmentSnapshot(pool, owner, everyone.id, undefined, limits), {
    status: 409,
    message: "snapshot_members_limit_reached",
  });
  assert.deepEqual(await tableCounts(), before);
  // Reaching the budget exactly is allowed, and an empty audience still fits a full budget.
  assert.equal((await createSegmentSnapshot(pool, owner, one.id, undefined, limits)).member_count, 1);
  const nobody = await createContactSegment(pool, owner, { name: "Nobody", tag: "nobody" });
  assert.equal((await createSegmentSnapshot(pool, owner, nobody.id, undefined, limits)).member_count, 0);
  await assert.rejects(createSegmentSnapshot(pool, owner, one.id, undefined, limits), {
    status: 409,
    message: "snapshot_members_limit_reached",
  });
  // Rows a deletion removed no longer count, while the stored member_count stays as evidence.
  await pool.query("DELETE FROM instagram_segment_snapshot_members WHERE connection_id=$1 AND sender_id='a'", [C]);
  assert.equal((await createSegmentSnapshot(pool, owner, one.id, undefined, limits)).member_count, 1);
});

test("archived, missing and foreign segments and snapshots are not found; agents and removed members are refused", async () => {
  await comment("a", "2026-10-09T00:00:00Z");
  const archived = await createContactSegment(pool, owner, { name: "Archived" });
  const frozen = await createSegmentSnapshot(pool, owner, archived.id, undefined);
  await archiveContactSegment(pool, owner, archived.id);
  const foreignSegment = (
    await pool.query("INSERT INTO instagram_contact_segments(workspace_id,name) VALUES($1,'foreign') RETURNING id", [
      foreign,
    ])
  ).rows[0].id as string;
  const foreignSnapshot = (
    await pool.query(
      `INSERT INTO instagram_segment_snapshots(workspace_id,segment_id,created_by,as_of,definition,segment_name,counts,member_count)
       VALUES($1,$2,$3,now(),'{}','foreign','{}',0) RETURNING id`,
      [foreign, foreignSegment, outsiderId],
    )
  ).rows[0].id as string;
  for (const id of [archived.id, randomUUID(), foreignSegment]) {
    const response = await request(ownerId, "POST", `/api/contact-segments/${id}/snapshots`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "segment_not_found" });
  }
  // An archived segment keeps its list; a missing or foreign one is not found.
  assert.deepEqual(
    (await listSegmentSnapshots(pool, owner, archived.id)).map((item) => item.id),
    [frozen.id],
  );
  for (const id of [randomUUID(), foreignSegment])
    await assert.rejects(listSegmentSnapshots(pool, owner, id), { status: 404, message: "segment_not_found" });
  for (const path of [
    `/api/segment-snapshots/${foreignSnapshot}`,
    `/api/segment-snapshots/${randomUUID()}/members.csv`,
  ]) {
    const response = await request(ownerId, "GET", path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "snapshot_not_found" });
  }
  assert.equal((await request(ownerId, "GET", `/api/segment-snapshots/${frozen.id}`)).status, 200);
  const active = await createContactSegment(pool, owner, { name: "Active" });
  for (const [method, path] of [
    ["POST", `/api/contact-segments/${active.id}/snapshots`],
    ["GET", `/api/contact-segments/${active.id}/snapshots`],
    ["GET", `/api/segment-snapshots/${frozen.id}`],
    ["GET", `/api/segment-snapshots/${frozen.id}/members.csv`],
  ] as const) {
    const response = await request(agentId, method, path);
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { error: "role_forbidden" });
  }
  // A removal between the role read and the workspace lock is caught by the lock's recheck.
  afterQuery = async (_client, sql) => {
    if (sql.startsWith("BEGIN"))
      await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [
        adminId,
        ownerId,
      ]);
  };
  await assert.rejects(createSegmentSnapshot(tracked(), admin, active.id, undefined), {
    status: 403,
    message: "workspace_required",
  });
  afterQuery = undefined;
  const removed = await request(adminId, "GET", `/api/segment-snapshots/${frozen.id}`);
  assert.equal(removed.status, 403);
  assert.deepEqual(await removed.json(), { error: "workspace_required" });
  assert.deepEqual(await tableCounts(), { snapshots: 2, members: 1 });
});

test("a snapshot holding its connection lock makes delete_connection_data wait, which then removes its members", async () => {
  await fixture();
  const segment = await createContactSegment(pool, owner, { name: "Everyone" });
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [C]);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => (locked = resolve));
  afterQuery = async (_client, sql) => {
    if (sql === CONNECTION_LOCK) {
      locked();
      await paused;
    }
  };
  const snapshot = createSegmentSnapshot(tracked(), owner, segment.id, undefined);
  await holding;
  const deletion = pool.query("SELECT public.delete_connection_data($1,$2,$3,'100') AS result", [
    workspace,
    C,
    ownerId,
  ]);
  await lockWaiters(1);
  release();
  const saved = await snapshot;
  const result = (await deletion).rows[0].result;
  assert.equal(saved.member_count, 7);
  assert.equal(result.deleted_counts.instagram_segment_snapshot_members, 6);
  assert.deepEqual(pairs(await members(saved.id)), ["second:e"]);
  // The stored counts stay as evidence of the evaluation.
  assert.equal(
    (await pool.query("SELECT member_count FROM instagram_segment_snapshots WHERE id=$1", [saved.id])).rows[0]
      .member_count,
    7,
  );
});

test("a snapshot waiting behind delete_connection_data reads after the deletion and stores none of its members", async () => {
  await fixture();
  const segment = await createContactSegment(pool, owner, { name: "Everyone" });
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [C]);
  const deletion = await pool.connect();
  try {
    await deletion.query("BEGIN");
    await deletion.query("SELECT public.delete_connection_data($1,$2,$3,'100')", [workspace, C, ownerId]);
    const snapshot = createSegmentSnapshot(pool, owner, segment.id, undefined);
    await lockWaiters(1);
    await deletion.query("COMMIT");
    const saved = await snapshot;
    assert.equal(saved.member_count, 1);
    assert.deepEqual(pairs(await members(saved.id)), ["second:e"]);
    assert.equal(saved.counts.total, "1");
  } finally {
    await deletion.query("ROLLBACK").catch(() => undefined);
    deletion.release();
  }
});

test("the deletion functions remove the right member rows, keep other people's and keep the stored counts", async () => {
  await fixture();
  const segment = await createContactSegment(pool, owner, { name: "Everyone" });
  const saved = await createSegmentSnapshot(pool, owner, segment.id, undefined);
  const again = await createSegmentSnapshot(pool, owner, segment.id, undefined);
  assert.equal(saved.member_count, 7);
  // Person deletion by the DM recipient 9001 follows the acknowledged reply to the comment sender a.
  const person = (
    await pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','9001') AS result", [
      workspace,
      C,
      ownerId,
    ])
  ).rows[0].result;
  assert.equal(person.deleted_counts.instagram_segment_snapshot_members, 2);
  for (const id of [saved.id, again.id])
    assert.deepEqual(pairs(await members(id)), ["00123", "b", "c", "d", "f", "second:e"]);
  const sender = (
    await pool.query("SELECT public.delete_person_data($1,$2,$3,'comment_sender','00123') AS result", [
      workspace,
      C,
      ownerId,
    ])
  ).rows[0].result;
  assert.equal(sender.deleted_counts.instagram_segment_snapshot_members, 2);
  await pool.query("UPDATE instagram_connections SET active=false WHERE workspace_id=$1", [workspace]);
  const connection = (
    await pool.query("SELECT public.delete_connection_data($1,$2,$3,'101') AS result", [workspace, C2, ownerId])
  ).rows[0].result;
  assert.equal(connection.deleted_counts.instagram_segment_snapshot_members, 2);
  assert.deepEqual(pairs(await members(saved.id)), ["b", "c", "d", "f"]);
  const detail = await getSegmentSnapshot(pool, owner, saved.id);
  assert.equal(detail.snapshot.member_count, 7);
  assert.equal(detail.snapshot.stored_member_count, 4);
  assert.deepEqual(detail.snapshot.counts, saved.counts);
  // A foreign workspace's snapshot is untouched by workspace deletion.
  const foreignSegment = (
    await pool.query("INSERT INTO instagram_contact_segments(workspace_id,name) VALUES($1,'foreign') RETURNING id", [
      foreign,
    ])
  ).rows[0].id;
  await comment("x", "2026-10-09T00:00:00Z", FC, foreign);
  const outsider = { id: outsiderId, email: "outsider@example.test" };
  const kept = await createSegmentSnapshot(pool, outsider, foreignSegment, undefined);
  const workspaceResult = (
    await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspace, ownerId])
  ).rows[0].result;
  assert.equal(workspaceResult.deleted_counts.instagram_segment_snapshot_members, 8);
  assert.equal(workspaceResult.deleted_counts.instagram_segment_snapshots, 2);
  assert.deepEqual(await tableCounts(), { snapshots: 1, members: 1 });
  assert.equal((await members(kept.id)).length, 1);
});

test("both tables are exported, and a snapshot alone keeps a workspace from moving in both move checks", async () => {
  assert.deepEqual(EXPORTED_TABLES.instagram_segment_snapshots, { scope: "workspace" });
  assert.deepEqual(EXPORTED_TABLES.instagram_segment_snapshot_members, { scope: "workspace" });
  const mover = "66666666-6666-4666-8666-666666666661",
    own = "66666666-6666-4666-8666-666666666662",
    target = "66666666-6666-4666-8666-666666666663";
  // A plan with free seats for the invite.
  await pool.query("UPDATE workspaces SET plan='advanced' WHERE id=$1", [workspace]);
  const client = await pool.connect();
  try {
    await client.query("INSERT INTO workspaces VALUES($1),($2)", [own, target]);
    await client.query("INSERT INTO workspace_members(user_id,workspace_id,role) VALUES($1,$2,'owner')", [mover, own]);
    // Replica mode skips the segment foreign key, so the snapshot is all the workspace holds.
    await client.query("SET session_replication_role=replica");
    await client.query(
      `INSERT INTO instagram_segment_snapshots(workspace_id,segment_id,created_by,as_of,definition,segment_name,counts,member_count)
       VALUES($1,gen_random_uuid(),$2,now(),'{}','kept','{}',0)`,
      [own, mover],
    );
    await client.query("RESET session_replication_role");
    // The invite acceptance check (currentWorkspaceMovable).
    const invite = await request(
      ownerId,
      "POST",
      "/api/workspace/invites",
      JSON.stringify({ email: "mover@example.test", role: "agent" }),
      {
        "content-type": "application/json",
      },
    );
    assert.equal(invite.status, 201, await invite.clone().text());
    const token = (await invite.json()).link.split("#invite=")[1];
    const accepted = await appApi(
      new Request("https://app.test/api/invites/accept", {
        method: "POST",
        headers: { cookie: "__Host-ac-access=test", origin: "https://app.test", "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      env,
      tracked,
      (async () =>
        Response.json({ id: mover, email: "mover@example.test", email_confirmed_at: "2026-10-18" })) as typeof fetch,
    );
    assert.equal(accepted.status, 409, await accepted.clone().text());
    assert.deepEqual(await accepted.json(), { error: "workspace_not_empty" });
    // The administrator script's check.
    const script = await readFile(new URL("../../deploy/assign-workspace-owner.sql", import.meta.url), "utf8");
    await client.query("CREATE TEMP TABLE verified_users(id uuid,email_confirmed_at timestamptz)");
    await client.query(
      script
        .slice(script.indexOf("CREATE FUNCTION"), script.indexOf("SELECT pg_temp.assign_workspace_owner"))
        .replace("auth.users", "pg_temp.verified_users")
        .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"),
    );
    await client.query("INSERT INTO verified_users VALUES($1,now())", [mover]);
    await assert.rejects(client.query("SELECT pg_temp.assign_workspace_owner($1,$2)", [mover, target]), /not empty/);
  } finally {
    await client.query("RESET session_replication_role");
    await client.query("DROP TABLE IF EXISTS pg_temp.verified_users");
    client.release();
  }
});

test("migration 061 replays over stored snapshots and leaves the deletion functions as the schema defines them", async () => {
  const functions = async () =>
    (
      await pool.query(
        `SELECT proname,pg_get_functiondef(oid) AS body FROM pg_proc
         WHERE pronamespace='public'::regnamespace AND proname IN ('delete_connection_data','delete_person_data','delete_workspace_data')
         ORDER BY proname`,
      )
    ).rows;
  // Other test files replay older migrations, so the current bodies are loaded first.
  const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
  await pool.query(schema);
  const current = await functions();
  assert.equal(current.length, 3);
  for (const { proname, body } of current)
    assert.match(body, /DELETE FROM public\.instagram_segment_snapshot_members\b/, proname);
  const migration = await readFile(
    new URL("../../db/migrations/061_segment_target_snapshots.sql", import.meta.url),
    "utf8",
  );
  // Back to the shape before 061: no tables and no segment key for them.
  await pool.query("DROP TABLE instagram_segment_snapshot_members,instagram_segment_snapshots");
  await pool.query("DROP INDEX instagram_contact_segments_id_workspace");
  await comment("a", "2026-10-09T00:00:00Z");
  const segment = await createContactSegment(pool, owner, { name: "Everyone" });
  await pool.query(migration);
  const saved = await createSegmentSnapshot(pool, owner, segment.id, undefined);
  await pool.query(migration);
  await pool.query(schema);
  assert.deepEqual(await functions(), current);
  assert.equal((await members(saved.id)).length, 1);
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(
    runner.indexOf("061_segment_target_snapshots.sql") > runner.indexOf("060_segment_condition_tree.sql") &&
      runner.indexOf("061_segment_target_snapshots.sql") < runner.indexOf("supabase-access.sql"),
  );
});
