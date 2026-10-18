import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool, type QueryConfig } from "pg";
import { ApiError } from "./auth.ts";
import {
  archiveContactSegment,
  createContactSegment,
  listContactSegments,
  listContacts,
  updateContactSegment,
} from "./contacts.ts";
import { CONTACT_CSV_HEADER, exportContactCsv } from "./contact-csv.ts";
import { parseContactCsv, decodeContactScalar } from "./contact-csv-test-utils.ts";
import { recordChannelConsentEvent } from "../instagram/channel-consent.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl });
const workspace = "11111111-1111-4111-8111-111111111111";
const foreignWorkspace = "22222222-2222-4222-8222-222222222222";
// C has its inbox enabled; C3 never enabled its inbox; FC is foreign.
const C = "33333333-3333-4333-8333-333333333333";
const C3 = "55555555-5555-4555-8555-555555555555";
const FC = "66666666-6666-4666-8666-666666666666";
const owner = { id: "77777777-7777-4777-8777-777777777777", email: "owner@example.test" };
const outsider = { id: "88888888-8888-4888-8888-888888888888", email: "outsider@example.test" };
// One fixed evaluation clock; three days before it is the window start.
const asOf = "2026-10-10T03:00:00.000000Z";
const windowFrom = "2026-10-07T03:00:00.000000Z";
const inWindow = "2026-10-09T03:00:00.000000Z";
let sequence = 0;

before(async () => pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8")));
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces,workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspace, foreignWorkspace]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [
    workspace,
    owner.id,
    foreignWorkspace,
    outsider.id,
  ]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,inbox_enabled,inbox_enabled_at) VALUES
     ($1,$4,'100','shop',true,now()-interval '1 day'),($2,$4,'102','closed',false,NULL),
     ($3,$5,'103','foreign',true,now()-interval '1 day')`,
    [C, C3, FC, workspace, foreignWorkspace],
  );
});
after(async () => pool.end());

// listContacts evaluates at statement_timestamp(); pin it as settings.db.test.ts relativeClock does. The verified
// bridge keeps reading the real clock (now()), so replies sent an hour ago stay fresh evidence.
function listClock(): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("statement_timestamp()"))
        assert.equal(sql.match(/statement_timestamp\(\)/g)?.length, 1, "one evaluation clock per lookup");
      return pool.query(sql.replace("statement_timestamp()", `'${asOf}'::timestamptz`), values);
    },
  } as unknown as Pool;
}
// The export takes its one evaluation time from the exported_at read (transaction_timestamp()); pin that read and
// record the clock value of every segment batch.
const exportClocks: unknown[] = [];
function exportClock(): Pool {
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (input: string | QueryConfig, values?: unknown[]) => {
          const query = typeof input === "string" ? { text: input, values } : input;
          if (query.text.includes("evaluation AS MATERIALIZED")) exportClocks.push(query.values?.at(-1));
          return client.query({
            ...query,
            text: query.text.replace("transaction_timestamp()", `'${asOf}'::timestamptz`),
          });
        },
        release: (destroy?: boolean | Error) => client.release(destroy),
      };
    },
    query: pool.query.bind(pool),
    end: async () => {},
  } as unknown as Pool;
}

async function comment(sender: string, conn = C, ws = workspace, at = inWindow) {
  sequence++;
  return (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at)
       VALUES($1,$2,$3,$3,$4,'PRIVATE COMMENT BODY',$5) RETURNING id::text,comment_id,media_id`,
      [ws, conn, `comment-${sequence}`, sender, at],
    )
  ).rows[0];
}
// A sent private reply from sender to recipient, sent `age` from now (before the inbox was enabled when older than a day).
async function bridge(sender: string, recipient: string, options: { conn?: string; ws?: string; age?: string } = {}) {
  const conn = options.conn ?? C,
    ws = options.ws ?? workspace;
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
     VALUES($1,$2,$3,$4,$5,$6,$7,'PRIVATE SEND BODY',$8,'sent','acknowledged',now()+$9::interval)`,
    [ws, conn, event.id, rule, event.comment_id, event.media_id, sender, recipient, options.age ?? "-1 hour"],
  );
}
// A received DM of recipient stored at an exact time (microseconds kept).
async function message(recipient: string, at: string, kind: "text" | "postback" = "text", conn = C, ws = workspace) {
  sequence++;
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,$4,'PRIVATE DM BODY',$5,$6)`,
    [ws, conn, recipient, `dm-${sequence}`, kind, at],
  );
}
async function consent(identityKind: "comment_sender" | "dm_recipient", identityValue: string) {
  await recordChannelConsentEvent(pool, {
    requestKey: randomUUID(),
    workspaceId: workspace,
    connectionId: C,
    channel: "instagram",
    identityKind,
    identityValue,
    purpose: "marketing",
    decision: "grant",
    evidenceKind: "explicit",
    evidenceReference: "PRIVATE CONSENT EVIDENCE",
    occurredAt: new Date(),
    actorId: owner.id,
  });
}

// Contacts of C, evaluated at asOf with last_dm_days=3 ([windowFrom, asOf)):
// verified and in the window: 100 (exactly at the start), 103 (a postback), 105 (latest in, older out), 111 (two
// recipients, one recent); verified but outside: 101 (one microsecond early), 102 (exactly at asOf), 104 (an older
// DM in the window, the latest after asOf); unverified: 106 (no reply), 107 (stale reply), 108 and 109 (ambiguous).
async function fixture() {
  await bridge("100", "9001");
  await message("9001", windowFrom);
  await consent("dm_recipient", "9001");
  await bridge("101", "9002");
  await message("9002", "2026-10-07T02:59:59.999999Z");
  await bridge("102", "9003");
  await message("9003", asOf);
  await bridge("103", "9004");
  await message("9004", inWindow, "postback");
  await bridge("104", "9005");
  await message("9005", "2026-10-08T03:00:00.000000Z");
  await message("9005", "2026-10-10T04:00:00.000000Z");
  await bridge("105", "9006");
  await message("9006", "2026-09-01T00:00:00.000000Z");
  await message("9006", "2026-10-09T12:00:00.000000Z");
  await comment("106");
  await bridge("107", "9007", { age: "-2 days" });
  await message("9007", inWindow);
  await bridge("109", "9009", { age: "-2 days" });
  await bridge("108", "9009");
  await message("9009", inWindow);
  // 111: 9011 has a recent DM and no consent; 9012 has an old DM and a marketing grant.
  await bridge("111", "9011");
  await bridge("111", "9012");
  await message("9011", inWindow);
  await message("9012", "2026-10-01T00:00:00.000000Z");
  await consent("dm_recipient", "9012");
  // 110 on C3: a fresh reply and a recent DM, but the inbox was never enabled.
  await bridge("110", "9010", { conn: C3 });
  await message("9010", inWindow, "text", C3);
  // The foreign workspace has 100 bridged to 9001 with a recent DM; it never reaches workspace a.
  await bridge("100", "9001", { conn: FC, ws: foreignWorkspace });
  await message("9001", inWindow, "text", FC, foreignWorkspace);
}
const senders = (page: { contacts: { sender_id: string }[] }) => page.contacts.map((contact) => contact.sender_id);
const query = (entries: Record<string, string>) => new URLSearchParams(entries);
const sum = (page: { total?: string; excluded?: Record<string, string> }) =>
  BigInt(page.total!) + Object.values(page.excluded!).reduce((total, count) => total + BigInt(count), 0n);
const dmWindow = { from: windowFrom, before: asOf };

test("DM activity reads the latest stored DM of verified recipients in a half-open window at one clock", async () => {
  await fixture();
  const conditions = { connection_id: C, last_dm_days: "3" };
  const list = await listContacts(listClock(), owner, query(conditions));
  assert.deepEqual(senders(list), ["100", "103", "105", "111"]);
  assert.deepEqual(list.dm_activity_window, dmWindow);
  assert.equal("excluded" in list, false);
  assert.equal("activity_window" in list, false);
  const preview = await listContacts(listClock(), owner, query({ ...conditions, preview: "true" }));
  assert.deepEqual(senders(preview), ["100", "103", "105", "111"]);
  assert.equal(preview.total, "4");
  assert.equal(preview.evaluated, "11");
  // Unverified contacts are dm_identity, never dm_activity, even with a recent DM.
  assert.deepEqual(preview.excluded, { dm_identity: "4", dm_activity: "3", tag: "0", field: "0", both: "0" });
  assert.deepEqual(preview.dm_activity_window, dmWindow);
  assert.equal(sum(preview), BigInt(preview.evaluated!));
  // No response carries a DM recipient ID or a DM message time.
  const body = JSON.stringify([list, preview]);
  assert.equal(/"90\d\d"/.test(body), false);
  for (const time of ["2026-10-09T12:00:00", "2026-10-08T03:00:00", "2026-10-07T02:59:59"])
    assert.equal(body.includes(time), false, time);
  // A wider window takes in 101 (one microsecond early) but never 102 (at asOf) or 104 (latest after asOf).
  assert.deepEqual(senders(await listContacts(listClock(), owner, query({ connection_id: C, last_dm_days: "4" }))), [
    "100",
    "101",
    "103",
    "105",
    "111",
  ]);
  // One day keeps only the DMs after asOf minus 24 hours.
  assert.deepEqual(senders(await listContacts(listClock(), owner, query({ connection_id: C, last_dm_days: "1" }))), [
    "103",
    "105",
    "111",
  ]);
  // Every account: 110 on C3 has no verified identity; the foreign workspace sees only its own contact.
  const all = await listContacts(listClock(), owner, query({ preview: "true", last_dm_days: "3" }));
  assert.equal(all.evaluated, "12");
  assert.deepEqual(all.excluded, { dm_identity: "5", dm_activity: "3", tag: "0", field: "0", both: "0" });
  assert.deepEqual(senders(await listContacts(listClock(), outsider, query({ last_dm_days: "3" }))), ["100"]);
});

test("DM activity combines with DM consent over any verified recipient, not one recipient for both", async () => {
  await fixture();
  // 111's grant is on 9012 (an old DM) and its recent DM on 9011; it matches both conditions.
  const dmConsent = { connection_id: C, dm_consent_purpose: "marketing", dm_consent_state: "granted" };
  assert.deepEqual(senders(await listContacts(listClock(), owner, query(dmConsent))), ["100", "111"]);
  const both = await listContacts(listClock(), owner, query({ ...dmConsent, last_dm_days: "3", preview: "true" }));
  assert.deepEqual(senders(both), ["100", "111"]);
  assert.deepEqual(Object.keys(both.excluded!), ["dm_identity", "dm_consent", "dm_activity", "tag", "field", "both"]);
  assert.deepEqual(both.excluded, {
    dm_identity: "4",
    dm_consent: "5",
    dm_activity: "0",
    tag: "0",
    field: "0",
    both: "0",
  });
  assert.equal(sum(both), BigInt(both.evaluated!));
  // One day: 100's DM is now outside, so it is dm_activity after satisfying DM consent.
  const narrow = await listContacts(listClock(), owner, query({ ...dmConsent, last_dm_days: "1", preview: "true" }));
  assert.deepEqual(senders(narrow), ["111"]);
  assert.deepEqual(narrow.excluded, {
    dm_identity: "4",
    dm_consent: "5",
    dm_activity: "1",
    tag: "0",
    field: "0",
    both: "0",
  });
});

test("DM activity is a separate limit after comment activity and consent, outside the tag-field OR", async () => {
  await fixture();
  await pool.query(
    "UPDATE instagram_comment_events SET created_at='2026-10-01T00:00:00Z' WHERE connection_id=$1 AND sender_id='105'",
    [C],
  );
  const base = { connection_id: C, preview: "true", last_dm_days: "3" };
  for (const activity of [
    { last_comment_days: "3" },
    { last_comment_from: "2026-10-08T00:00:00.000Z", last_comment_before: "2026-10-10T00:00:00.000Z" },
  ] as Record<string, string>[]) {
    const page = await listContacts(listClock(), owner, query({ ...base, ...activity }));
    assert.deepEqual(senders(page), ["100", "103", "111"], JSON.stringify(activity));
    assert.deepEqual(page.excluded, {
      activity: "1",
      dm_identity: "4",
      dm_activity: "3",
      tag: "0",
      field: "0",
      both: "0",
    });
    assert.equal(sum(page), BigInt(page.evaluated!));
  }
  // The calendar period keeps its own window beside the DM window; 105's comment (09:00 on October 1 in Seoul) is
  // in this month.
  const calendar = await listContacts(listClock(), owner, query({ ...base, last_comment_period: "this_month" }));
  assert.deepEqual(senders(calendar), ["100", "103", "105", "111"]);
  assert.deepEqual(calendar.dm_activity_window, dmWindow);
  assert.equal(calendar.activity_window?.time_zone, "Asia/Seoul");
  for (const sender of ["100", "101", "106"]) await consent("comment_sender", sender);
  const consented = await listContacts(
    listClock(),
    owner,
    query({ ...base, consent_purpose: "marketing", consent_state: "granted" }),
  );
  assert.deepEqual(senders(consented), ["100"]);
  assert.deepEqual(consented.excluded, {
    consent: "8",
    dm_identity: "1",
    dm_activity: "1",
    tag: "0",
    field: "0",
    both: "0",
  });
  // Tags: 100, 101 and 106 have lead; 103 has a score of 5.
  for (const sender of ["100", "101", "106"])
    await pool.query(
      "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,'{lead}')",
      [workspace, C, sender],
    );
  const field = (
    await pool.query(
      "INSERT INTO instagram_contact_fields(workspace_id,name,type) VALUES($1,'score','number') RETURNING id",
      [workspace],
    )
  ).rows[0].id as string;
  await pool.query(
    "INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,'103',$3,'5')",
    [workspace, C, field],
  );
  const tagField = { ...base, tag: "lead", field_id: field, field_operator: "gte", field_value: "1" };
  // OR: 101 (tag, old DM) and 106 (tag, no verified DM) stay excluded by the DM limit.
  const or = await listContacts(listClock(), owner, query({ ...tagField, condition_operator: "or" }));
  assert.deepEqual(senders(or), ["100", "103"]);
  assert.deepEqual(or.excluded, { dm_identity: "4", dm_activity: "3", tag: "0", field: "0", both: "2" });
  // AND: no contact has both; the zero-match preview keeps its summary.
  const and = await listContacts(listClock(), owner, query(tagField));
  assert.equal(and.total, "0");
  assert.deepEqual(and.contacts, []);
  assert.equal(and.evaluated, "11");
  assert.deepEqual(and.excluded, { dm_identity: "4", dm_activity: "3", tag: "1", field: "1", both: "2" });
  assert.deepEqual(and.dm_activity_window, dmWindow);
  for (const page of [consented, or, and]) assert.equal(sum(page), BigInt(page.evaluated!));
});

test("DM activity segments save, edit, evaluate, export at one clock and archive with the list's selection", async () => {
  await fixture();
  const legacy = await createContactSegment(pool, owner, { name: "Legacy" });
  assert.equal("last_dm_days" in legacy, false);
  const segment = await createContactSegment(pool, owner, { name: "Recent DM", last_dm_days: 3 });
  assert.equal(segment.last_dm_days, 3);
  assert.equal("last_comment_days" in segment, false);
  assert.deepEqual(
    (await listContactSegments(pool, owner)).find((value) => value.id === segment.id),
    segment,
  );
  const bySegment = query({ segment_id: segment.id });
  const selected = await listContacts(listClock(), owner, bySegment);
  assert.deepEqual(selected, await listContacts(listClock(), owner, query({ last_dm_days: "3" })));
  assert.deepEqual(senders(selected), ["100", "103", "105", "111"]);
  assert.deepEqual(selected.dm_activity_window, dmWindow);
  const preview = await listContacts(listClock(), owner, query({ segment_id: segment.id, preview: "true" }));
  assert.deepEqual(preview.excluded, { dm_identity: "5", dm_activity: "3", tag: "0", field: "0", both: "0" });
  // The export evaluates the window once at exported_at for every batch and selects the list's contacts.
  exportClocks.length = 0;
  const exported = await exportContactCsv(exportClock(), owner, { batchSize: 1 }, segment.id);
  assert.equal(exported.exportedAt, asOf);
  assert.ok(exportClocks.length > 1);
  assert.deepEqual(new Set(exportClocks), new Set([asOf]));
  const [header, ...rows] = parseContactCsv(exported.body);
  assert.deepEqual(header, [...CONTACT_CSV_HEADER]);
  const at = (name: string) => CONTACT_CSV_HEADER.indexOf(name as (typeof CONTACT_CSV_HEADER)[number]);
  assert.deepEqual(
    rows.map((row) => `${row[at("connection_id")]}:${decodeContactScalar(row[at("sender_id")]!)}`).sort(),
    selected.contacts.map((contact) => `${contact.connection_id}:${contact.sender_id}`).sort(),
  );
  assert.equal(/(^|[^0-9])90\d\d([^0-9]|$)/.test(exported.body), false);
  // An unchanged edit keeps the version; changed days increment it and change the selection.
  const unchanged = await updateContactSegment(pool, owner, segment.id, {
    name: "Recent DM",
    last_dm_days: 3,
    expected_version: 1,
  });
  assert.deepEqual(unchanged, { conflict: false, segment });
  const edited = await updateContactSegment(pool, owner, segment.id, {
    name: "Recent DM",
    last_dm_days: 1,
    expected_version: 1,
  });
  assert.equal(edited.conflict, false);
  assert.equal(edited.segment.version, 2);
  assert.equal(edited.segment.last_dm_days, 1);
  assert.deepEqual(senders(await listContacts(listClock(), owner, bySegment)), ["103", "105", "111"]);
  const stale = await updateContactSegment(pool, owner, segment.id, { name: "Recent DM", expected_version: 1 });
  assert.deepEqual(stale, { conflict: true, segment: edited.segment });
  // Removing the days is a change too, and the response then omits the key.
  const removed = await updateContactSegment(pool, owner, segment.id, { name: "Recent DM", expected_version: 2 });
  assert.equal(removed.segment.version, 3);
  assert.equal("last_dm_days" in removed.segment, false);
  const removedList = await listContacts(listClock(), owner, bySegment);
  assert.equal("dm_activity_window" in removedList, false);
  // segment_id cannot be mixed with the manual DM activity key.
  await assert.rejects(
    listContacts(pool, owner, query({ segment_id: segment.id, last_dm_days: "3" })),
    (error: unknown) =>
      error instanceof ApiError && error.status === 400 && error.message === "invalid_contact_request",
  );
  await assert.rejects(
    listContacts(pool, outsider, bySegment),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  await archiveContactSegment(pool, owner, segment.id);
  await assert.rejects(
    listContacts(pool, owner, bySegment),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
});

test("DM activity segment migration preserves existing rows and enforces 1 to 366 on replay", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE instagram_contact_segments DROP COLUMN last_dm_days");
    await client.query("DROP INDEX instagram_inbox_messages_latest_idx");
    await client.query(
      "INSERT INTO instagram_contact_segments(workspace_id,name,dm_consent_purpose,dm_consent_state,last_comment_days) VALUES($1,'Legacy','marketing','granted',7)",
      [workspace],
    );
    const migration = await readFile(
      new URL("../../db/migrations/059_segment_dm_activity.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    const read = async () =>
      (
        await client.query(
          "SELECT name,dm_consent_purpose,dm_consent_state,last_comment_days,last_dm_days FROM instagram_contact_segments",
        )
      ).rows;
    assert.deepEqual(await read(), [
      {
        name: "Legacy",
        dm_consent_purpose: "marketing",
        dm_consent_state: "granted",
        last_comment_days: 7,
        last_dm_days: null,
      },
    ]);
    assert.deepEqual(
      (
        await client.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='instagram_inbox_messages_latest_idx'",
        )
      ).rows,
      [
        {
          indexdef:
            "CREATE INDEX instagram_inbox_messages_latest_idx ON public.instagram_inbox_messages USING btree (workspace_id, connection_id, recipient_id, message_at DESC)",
        },
      ],
    );
    for (const days of [1, 366]) {
      await client.query("UPDATE instagram_contact_segments SET last_dm_days=$1", [days]);
      await client.query(migration);
      assert.equal((await read())[0].last_dm_days, days);
    }
    for (const days of [0, 367, -1]) {
      await client.query("SAVEPOINT invalid_dm_activity");
      await assert.rejects(
        client.query("UPDATE instagram_contact_segments SET last_dm_days=$1", [days]),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514",
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_dm_activity");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
