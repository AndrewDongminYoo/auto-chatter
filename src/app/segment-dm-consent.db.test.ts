import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
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
// C has its inbox enabled; C2 is a second account of the workspace; C3 never enabled its inbox; FC is foreign.
const C = "33333333-3333-4333-8333-333333333333";
const C2 = "44444444-4444-4444-8444-444444444444";
const C3 = "55555555-5555-4555-8555-555555555555";
const FC = "66666666-6666-4666-8666-666666666666";
const owner = { id: "77777777-7777-4777-8777-777777777777", email: "owner@example.test" };
const outsider = { id: "88888888-8888-4888-8888-888888888888", email: "outsider@example.test" };
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
     ($1,$5,'100','shop',true,now()-interval '1 day'),($2,$5,'101','second',true,now()-interval '1 day'),
     ($3,$5,'102','closed',false,NULL),($4,$6,'103','foreign',true,now()-interval '1 day')`,
    [C, C2, C3, FC, workspace, foreignWorkspace],
  );
});
after(async () => pool.end());

async function comment(sender: string, conn = C, ws = workspace, at: string | null = null) {
  sequence++;
  return (
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,created_at)
       VALUES($1,$2,$3,$3,$4,'PRIVATE COMMENT BODY',coalesce($5::timestamptz,now())) RETURNING id::text,comment_id,media_id`,
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
async function message(recipient: string, conn = C, ws = workspace) {
  sequence++;
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,$4,'PRIVATE DM BODY','text',now())`,
    [ws, conn, recipient, `dm-${sequence}`],
  );
}
async function consent(
  identityKind: "comment_sender" | "dm_recipient",
  identityValue: string,
  purpose: "service_reply" | "marketing" | "all",
  decision: "grant" | "revoke",
  conn = C,
  ws = workspace,
) {
  await recordChannelConsentEvent(pool, {
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
    actorId: owner.id,
  });
}

// Contacts of C: 100, 110 and 112 have verified DM recipients; the others do not, each for one reason.
async function fixture() {
  // 100: one verified recipient 9001 (marketing grant; service_reply revoke then grant).
  await bridge("100", "9001");
  await message("9001");
  await consent("dm_recipient", "9001", "marketing", "grant");
  await consent("dm_recipient", "9001", "service_reply", "revoke");
  await consent("dm_recipient", "9001", "service_reply", "grant");
  // 101: comments only, no sent reply.
  await comment("101");
  // 102: its only reply was sent before the inbox was enabled (stale), so 9002 is not verified.
  await bridge("102", "9002", { age: "-2 days" });
  await message("9002");
  // 103 and 104 both bridged to 9003 (104's older reply is stale): ambiguous for both.
  await bridge("104", "9003", { age: "-2 days" });
  await bridge("103", "9003");
  await message("9003");
  // 105: a fresh reply but no stored inbox message from 9005.
  await bridge("105", "9005");
  // 107 on C: no bridge on C; a DM recipient with the same numeric value has a grant on C. On C2, 107 is verified.
  await comment("107");
  await consent("dm_recipient", "107", "marketing", "grant");
  await bridge("107", "9007", { conn: C2 });
  await message("9007", C2);
  await consent("dm_recipient", "9007", "marketing", "grant", C2);
  // 110: two verified recipients, 9010 with a marketing grant and 9011 without records.
  await bridge("110", "9010");
  await bridge("110", "9011");
  await message("9010");
  await message("9011");
  await consent("dm_recipient", "9010", "marketing", "grant");
  // 112: verified 9012 with an all-purpose revoke, projected to both purposes.
  await bridge("112", "9012");
  await message("9012");
  await consent("dm_recipient", "9012", "all", "revoke");
  // 108 on C3: a fresh reply and a message, but the inbox was never enabled.
  await bridge("108", "9008", { conn: C3 });
  await message("9008", C3);
  // The foreign workspace has 100 bridged to 9001 with a marketing revoke; it never reaches workspace a.
  await bridge("100", "9001", { conn: FC, ws: foreignWorkspace });
  await message("9001", FC, foreignWorkspace);
  await consent("dm_recipient", "9001", "marketing", "revoke", FC, foreignWorkspace);
}
const senders = (page: { contacts: { sender_id: string }[] }) => page.contacts.map((contact) => contact.sender_id);
const query = (entries: Record<string, string>) => new URLSearchParams(entries);

test("DM consent matches only contacts whose verified DM recipients have the recorded state", async () => {
  await fixture();
  const expected: [string, string, string[], Record<string, string>][] = [
    ["marketing", "granted", ["100", "110"], { dm_identity: "6", dm_consent: "1" }],
    ["marketing", "revoked", ["112"], { dm_identity: "6", dm_consent: "2" }],
    ["marketing", "no_record", ["110"], { dm_identity: "6", dm_consent: "2" }],
    ["service_reply", "granted", ["100"], { dm_identity: "6", dm_consent: "2" }],
    ["service_reply", "revoked", ["112"], { dm_identity: "6", dm_consent: "2" }],
    ["service_reply", "no_record", ["110"], { dm_identity: "6", dm_consent: "2" }],
  ];
  for (const [purpose, state, matched, excluded] of expected) {
    const conditions = { connection_id: C, dm_consent_purpose: purpose, dm_consent_state: state };
    const list = await listContacts(pool, owner, query(conditions));
    assert.deepEqual(senders(list), matched, `${purpose} ${state}`);
    assert.equal("excluded" in list, false);
    const preview = await listContacts(pool, owner, query({ ...conditions, preview: "true" }));
    assert.equal(preview.total, String(matched.length));
    assert.equal(preview.evaluated, "9");
    assert.deepEqual(preview.excluded, { ...excluded, tag: "0", field: "0", both: "0" });
    assert.deepEqual(senders(preview), matched);
    // No list or preview response carries a DM recipient ID.
    assert.equal(/"90\d\d"/.test(JSON.stringify([list, preview])), false);
  }
  // Every account of the workspace: 107 matches on C2 and stays excluded on C; 108 on C3 has no verified identity.
  const all = await listContacts(
    pool,
    owner,
    query({ preview: "true", dm_consent_purpose: "marketing", dm_consent_state: "granted" }),
  );
  assert.deepEqual(
    all.contacts.map((contact) => `${contact.connection_id === C ? "C" : "C2"}:${contact.sender_id}`).sort(),
    ["C2:107", "C:100", "C:110"],
  );
  assert.equal(all.evaluated, "11");
  assert.deepEqual(all.excluded, { dm_identity: "7", dm_consent: "1", tag: "0", field: "0", both: "0" });
  // The foreign workspace sees only its own revoke.
  const foreign = await listContacts(
    pool,
    outsider,
    query({ dm_consent_purpose: "marketing", dm_consent_state: "revoked" }),
  );
  assert.deepEqual(senders(foreign), ["100"]);
});

test("verified DM evidence follows the contact detail and never counts a missing identity as no_record", async () => {
  await fixture();
  const noRecord = query({
    connection_id: C,
    preview: "true",
    dm_consent_purpose: "marketing",
    dm_consent_state: "no_record",
  });
  // A stale reply becomes fresh evidence once the inbox was enabled before it.
  await pool.query("UPDATE instagram_connections SET inbox_enabled_at=now()-interval '3 days' WHERE id=$1", [C]);
  const widened = await listContacts(pool, owner, noRecord);
  // 102 is now verified without a record; 103/104 stay ambiguous; 105 still has no message.
  assert.deepEqual(senders(widened), ["102", "110"]);
  assert.deepEqual(widened.excluded, { dm_identity: "5", dm_consent: "2", tag: "0", field: "0", both: "0" });
  // A stored message makes 105 verified.
  await message("9005");
  assert.deepEqual(senders(await listContacts(pool, owner, noRecord)), ["102", "105", "110"]);
  // Without an activation time, as for an inbox never enabled, no reply is fresh evidence. (Turning the inbox off
  // keeps the activation time, so this is not the disable path.)
  await pool.query("UPDATE instagram_connections SET inbox_enabled=false,inbox_enabled_at=NULL WHERE id=$1", [C]);
  const closed = await listContacts(pool, owner, noRecord);
  assert.deepEqual(senders(closed), []);
  assert.deepEqual(closed.excluded, { dm_identity: "9", dm_consent: "0", tag: "0", field: "0", both: "0" });
});

test("DM consent is a separate limit after activity and comment consent, outside the tag-field OR", async () => {
  await fixture();
  // 110's comments are three days old; the others are recent.
  await pool.query(
    "UPDATE instagram_comment_events SET created_at=now()-interval '3 days' WHERE connection_id=$1 AND sender_id='110'",
    [C],
  );
  const base = { connection_id: C, preview: "true", dm_consent_purpose: "marketing", dm_consent_state: "granted" };
  const recent = await listContacts(pool, owner, query({ ...base, last_comment_days: "1" }));
  assert.deepEqual(senders(recent), ["100"]);
  assert.deepEqual(recent.excluded, {
    activity: "1",
    dm_identity: "6",
    dm_consent: "1",
    tag: "0",
    field: "0",
    both: "0",
  });
  for (const sender of ["100", "101", "112"]) await consent("comment_sender", sender, "marketing", "grant");
  const both = await listContacts(
    pool,
    owner,
    query({ ...base, consent_purpose: "marketing", consent_state: "granted" }),
  );
  assert.deepEqual(senders(both), ["100"]);
  assert.deepEqual(Object.keys(both.excluded!), ["consent", "dm_identity", "dm_consent", "tag", "field", "both"]);
  assert.deepEqual(both.excluded, {
    consent: "6",
    dm_identity: "1",
    dm_consent: "1",
    tag: "0",
    field: "0",
    both: "0",
  });
  // Tags: 100, 101 and 112 have lead; 110 has a score of 5.
  for (const sender of ["100", "101", "112"])
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
    "INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,'110',$3,'5')",
    [workspace, C, field],
  );
  const tagField = { ...base, tag: "lead", field_id: field, field_operator: "gte", field_value: "1" };
  // OR: 101 (tag, no verified DM) and 112 (tag, revoked) stay excluded by the DM limit.
  const or = await listContacts(pool, owner, query({ ...tagField, condition_operator: "or" }));
  assert.deepEqual(senders(or), ["100", "110"]);
  assert.deepEqual(or.excluded, { dm_identity: "6", dm_consent: "1", tag: "0", field: "0", both: "0" });
  // AND: no contact has both; the zero-match preview keeps its summary.
  const and = await listContacts(pool, owner, query(tagField));
  assert.equal(and.total, "0");
  assert.deepEqual(and.contacts, []);
  assert.equal(and.evaluated, "9");
  assert.deepEqual(and.excluded, { dm_identity: "6", dm_consent: "1", tag: "1", field: "1", both: "0" });
  const sum = (page: typeof and) =>
    BigInt(page.total!) + Object.values(page.excluded!).reduce((total, count) => total + BigInt(count), 0n);
  for (const page of [recent, both, or, and]) assert.equal(sum(page), BigInt(page.evaluated!));
});

test("DM consent segments save, edit, evaluate, export and archive with the list's selection", async () => {
  await fixture();
  const legacy = await createContactSegment(pool, owner, { name: "Legacy" });
  assert.equal("dm_consent_purpose" in legacy, false);
  assert.equal("dm_consent_state" in legacy, false);
  const segment = await createContactSegment(pool, owner, {
    name: "DM granted",
    dm_consent_purpose: "marketing",
    dm_consent_state: "granted",
  });
  assert.equal(segment.dm_consent_purpose, "marketing");
  assert.equal(segment.dm_consent_state, "granted");
  assert.equal("consent_purpose" in segment, false);
  assert.deepEqual(
    (await listContactSegments(pool, owner)).find((value) => value.id === segment.id),
    segment,
  );
  const bySegment = query({ segment_id: segment.id });
  const manual = query({ dm_consent_purpose: "marketing", dm_consent_state: "granted" });
  const selected = await listContacts(pool, owner, bySegment);
  assert.deepEqual(selected, await listContacts(pool, owner, manual));
  assert.deepEqual(senders(selected).sort(), ["100", "107", "110"]);
  const preview = await listContacts(pool, owner, query({ segment_id: segment.id, preview: "true" }));
  assert.deepEqual(preview.excluded, { dm_identity: "7", dm_consent: "1", tag: "0", field: "0", both: "0" });
  // The export selects the list's contacts and keeps the v1 columns without any DM recipient ID.
  const exported = await exportContactCsv(pool, owner, { batchSize: 1 }, segment.id);
  const [header, ...rows] = parseContactCsv(exported.body);
  assert.deepEqual(header, [...CONTACT_CSV_HEADER]);
  const at = (name: string) => CONTACT_CSV_HEADER.indexOf(name as (typeof CONTACT_CSV_HEADER)[number]);
  assert.deepEqual(
    rows.map((row) => `${row[at("connection_id")]}:${decodeContactScalar(row[at("sender_id")]!)}`).sort(),
    selected.contacts.map((contact) => `${contact.connection_id}:${contact.sender_id}`).sort(),
  );
  assert.equal(/(^|[^0-9])90\d\d([^0-9]|$)/.test(exported.body), false);
  // An unchanged edit keeps the version; a changed state increments it and changes the selection.
  const unchanged = await updateContactSegment(pool, owner, segment.id, {
    name: "DM granted",
    dm_consent_purpose: "marketing",
    dm_consent_state: "granted",
    expected_version: 1,
  });
  assert.deepEqual(unchanged, { conflict: false, segment });
  const edited = await updateContactSegment(pool, owner, segment.id, {
    name: "DM granted",
    dm_consent_purpose: "marketing",
    dm_consent_state: "revoked",
    expected_version: 1,
  });
  assert.equal(edited.conflict, false);
  assert.equal(edited.segment.version, 2);
  assert.equal(edited.segment.dm_consent_state, "revoked");
  assert.deepEqual(senders(await listContacts(pool, owner, bySegment)), ["112"]);
  const stale = await updateContactSegment(pool, owner, segment.id, {
    name: "DM granted",
    expected_version: 1,
  });
  assert.deepEqual(stale, { conflict: true, segment: edited.segment });
  // Removing the pair is a change too, and the response then omits both keys.
  const removed = await updateContactSegment(pool, owner, segment.id, { name: "DM granted", expected_version: 2 });
  assert.equal(removed.segment.version, 3);
  assert.equal("dm_consent_purpose" in removed.segment, false);
  // segment_id cannot be mixed with the manual DM keys.
  await assert.rejects(
    listContacts(pool, owner, query({ segment_id: segment.id, dm_consent_purpose: "marketing" })),
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

test("DM consent segment migration preserves existing rows and enforces paired enums on replay", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "ALTER TABLE instagram_contact_segments DROP COLUMN dm_consent_purpose, DROP COLUMN dm_consent_state",
    );
    await client.query(
      "INSERT INTO instagram_contact_segments(workspace_id,name,consent_purpose,consent_state) VALUES($1,'Legacy','marketing','granted')",
      [workspace],
    );
    const migration = await readFile(
      new URL("../../db/migrations/058_segment_dm_consent.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration);
    await client.query(migration);
    const read = async () =>
      (
        await client.query(
          "SELECT name,consent_purpose,consent_state,dm_consent_purpose,dm_consent_state FROM instagram_contact_segments",
        )
      ).rows;
    assert.deepEqual(await read(), [
      {
        name: "Legacy",
        consent_purpose: "marketing",
        consent_state: "granted",
        dm_consent_purpose: null,
        dm_consent_state: null,
      },
    ]);
    await client.query(
      "UPDATE instagram_contact_segments SET dm_consent_purpose='service_reply',dm_consent_state='no_record'",
    );
    await client.query(migration);
    assert.equal((await read())[0].dm_consent_state, "no_record");
    for (const change of [
      "dm_consent_purpose=NULL",
      "dm_consent_state=NULL",
      "dm_consent_purpose='all'",
      "dm_consent_state='eligible'",
      "dm_consent_purpose=''",
      "dm_consent_state=''",
    ]) {
      await client.query("SAVEPOINT invalid_dm_consent");
      await assert.rejects(
        client.query(`UPDATE instagram_contact_segments SET ${change}`),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514",
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_dm_consent");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
