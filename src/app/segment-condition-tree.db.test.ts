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
import { archiveContactField } from "./contact-fields.ts";
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
// C and C2 belong to the workspace; FC is foreign.
const C = "33333333-3333-4333-8333-333333333333";
const C2 = "44444444-4444-4444-8444-444444444444";
const FC = "66666666-6666-4666-8666-666666666666";
const owner = { id: "77777777-7777-4777-8777-777777777777", email: "owner@example.test" };
const outsider = { id: "88888888-8888-4888-8888-888888888888", email: "outsider@example.test" };
// One fixed evaluation clock; three days before it is the comment and DM activity window start.
const asOf = "2026-10-10T03:00:00.000000Z";
const inWindow = "2026-10-09T03:00:00.000000Z";
const old = "2026-09-01T03:00:00.000000Z";
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
     ($1,$4,'100','shop',true,now()-interval '1 day'),($2,$4,'101','second',true,now()-interval '1 day'),
     ($3,$5,'103','foreign',true,now()-interval '1 day')`,
    [C, C2, FC, workspace, foreignWorkspace],
  );
});
after(async () => pool.end());

// listContacts evaluates at statement_timestamp(); pin it as the DM activity tests do. The verified bridge keeps
// reading the real clock (now()), so replies sent an hour ago stay fresh evidence.
function listClock(): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("statement_timestamp()"))
        assert.equal(sql.match(/statement_timestamp\(\)/g)?.length, 1, "one evaluation clock per lookup");
      return pool.query(sql.replace("statement_timestamp()", `'${asOf}'::timestamptz`), values);
    },
  } as unknown as Pool;
}
// The export takes its one evaluation time from the exported_at read; pin that read and record each batch clock.
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
async function tags(sender: string, values: string[], conn = C, ws = workspace) {
  await pool.query(
    "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,$4)",
    [ws, conn, sender, values],
  );
}
async function field(name: string, type: string, ws = workspace) {
  return (
    await pool.query("INSERT INTO instagram_contact_fields(workspace_id,name,type) VALUES($1,$2,$3) RETURNING id", [
      ws,
      name,
      type,
    ])
  ).rows[0].id as string;
}
async function value(sender: string, fieldId: string, stored: unknown, conn = C) {
  await pool.query(
    "INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,$3,$4,$5::jsonb)",
    [workspace, conn, sender, fieldId, JSON.stringify(stored)],
  );
}
// A sent private reply from sender to recipient an hour ago and a received DM of recipient in the window.
async function bridge(sender: string, recipient: string) {
  const event = await comment(sender);
  const rule = (
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text)
       VALUES(gen_random_uuid(),$1,$2,$3,'hello','PRIVATE SEND BODY') RETURNING id`,
      [workspace, C, event.media_id],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,
     private_reply_text,recipient_id,status,provider_message_id,sent_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'PRIVATE SEND BODY',$8,'sent','acknowledged',now()-interval '1 hour')`,
    [workspace, C, event.id, rule, event.comment_id, event.media_id, sender, recipient],
  );
  sequence++;
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,$4,'PRIVATE DM BODY','text',$5)`,
    [workspace, C, recipient, `dm-${sequence}`, inWindow],
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

// Contacts of C (s1 to s6), of C2 (s7) and of the foreign workspace (f1):
//   s1 tags {vip}, score 150000, joined 2026-02-01; bridged to 9001 with a recent DM and a DM marketing grant
//   s2 tags {vip}, score 50; bridged to 9002 with a recent DM
//   s3 tags {event}; a comment marketing grant
//   s4 no tag row, score 200000, plan "pro"
//   s5 tags {event,vip}, plan "basic", joined 2026-01-01, member true; its only comment is old (outside 3 days)
//   s6 an empty tag row, member false
//   s7 (C2) tags {vip}, score 150000
//   f1 (foreign) tags {event}
type Fields = { plan: string; score: string; member: string; joined: string };
async function fixture(): Promise<Fields> {
  const fields = {
    plan: await field("plan", "text"),
    score: await field("score", "number"),
    member: await field("member", "boolean"),
    joined: await field("joined", "date"),
  };
  await bridge("s1", "9001");
  await tags("s1", ["vip"]);
  await value("s1", fields.score, 150000);
  await value("s1", fields.joined, "2026-02-01");
  await consent("dm_recipient", "9001");
  await bridge("s2", "9002");
  await tags("s2", ["vip"]);
  await value("s2", fields.score, 50);
  await comment("s3");
  await tags("s3", ["event"]);
  await consent("comment_sender", "s3");
  await comment("s4");
  await value("s4", fields.score, 200000);
  await value("s4", fields.plan, "pro");
  await comment("s5", C, workspace, old);
  await tags("s5", ["event", "vip"]);
  await value("s5", fields.plan, "basic");
  await value("s5", fields.joined, "2026-01-01");
  await value("s5", fields.member, true);
  await comment("s6");
  await tags("s6", []);
  await value("s6", fields.member, false);
  await comment("s7", C2);
  await tags("s7", ["vip"], C2);
  await value("s7", fields.score, 150000, C2);
  await comment("f1", FC, foreignWorkspace);
  await tags("f1", ["event"], FC, foreignWorkspace);
  return fields;
}
const has = (tag: string) => ({ tag });
const lacks = (tag: string) => ({ tag, negate: true });
type Leaf = Record<string, unknown>;
type Group = { mode: string; conditions: Leaf[] };
const group = (mode: string, ...conditions: Leaf[]): Group => ({ mode, conditions });
const tree = (mode: string, ...groups: Group[]) => ({ mode, groups });
// "(VIP and spent at least 100000) or event".
const vipOrEvent = (fields: Fields) =>
  tree(
    "any",
    group("all", has("vip"), { field_id: fields.score, field_operator: "gte", field_value: 100000 }),
    group("all", has("event")),
  );
const senders = (page: { contacts: { sender_id: string }[] }) => page.contacts.map((contact) => contact.sender_id);
const query = (entries: Record<string, string>) => new URLSearchParams(entries);
const byTree = (value: unknown, extra: Record<string, string> = {}) =>
  query({ condition_tree: JSON.stringify(value), ...extra });
const sum = (page: { total?: string; excluded?: Record<string, string> }) =>
  BigInt(page.total!) + Object.values(page.excluded!).reduce((total, count) => total + BigInt(count), 0n);
const refused = (status: number, code: string) => (error: unknown) =>
  error instanceof ApiError && error.status === status && error.message === code;

test("condition trees evaluate all and any at both levels over tag and typed field leaves", async () => {
  const fields = await fixture();
  const list = async (value: unknown, extra: Record<string, string> = {}) =>
    senders(await listContacts(listClock(), owner, byTree(value, extra)));
  // Every account of the workspace; the foreign f1 never matches.
  assert.deepEqual(await list(vipOrEvent(fields)), ["s1", "s3", "s5", "s7"]);
  assert.deepEqual(await list(vipOrEvent(fields), { connection_id: C }), ["s1", "s3", "s5"]);
  assert.deepEqual(await list(vipOrEvent(fields), { connection_id: C2 }), ["s7"]);
  // Another workspace sees only its own contacts, and a tree naming a field of this workspace is refused there.
  assert.deepEqual(
    senders(await listContacts(listClock(), outsider, byTree(tree("any", group("all", has("event")))))),
    ["f1"],
  );
  await assert.rejects(listContacts(pool, outsider, byTree(vipOrEvent(fields))), refused(404, "field_not_found"));
  // Root all over two any groups: (not vip or plan unset) and (score < 100 or member false or joined >= Jan 15).
  const both = tree(
    "all",
    group("any", lacks("vip"), { field_id: fields.plan, field_operator: "is_unset" }),
    group(
      "any",
      { field_id: fields.score, field_operator: "lt", field_value: 100 },
      { field_id: fields.member, field_operator: "eq", field_value: false },
      { field_id: fields.joined, field_operator: "gte", field_value: "2026-01-15" },
    ),
  );
  assert.deepEqual(await list(both), ["s1", "s2", "s6"]);
  // The same field in two groups: score >= 100000 or score < 100.
  const range = tree(
    "any",
    group("all", { field_id: fields.score, field_operator: "gte", field_value: 100000 }),
    group("all", { field_id: fields.score, field_operator: "lt", field_value: 100 }),
  );
  assert.deepEqual(await list(range), ["s1", "s2", "s4", "s7"]);
  // A group all over a text eq, is_set and a negated tag; is_set alone.
  assert.deepEqual(
    await list(tree("all", group("all", { field_id: fields.plan, field_operator: "eq", field_value: "pro" }))),
    ["s4"],
  );
  assert.deepEqual(
    await list(tree("all", group("all", { field_id: fields.plan, field_operator: "is_set" }, lacks("event")))),
    ["s4"],
  );
  assert.deepEqual(await list(tree("any", group("all", { field_id: fields.member, field_operator: "is_set" }))), [
    "s5",
    "s6",
  ]);
  // Tag absent includes a contact without a tag row (s4) and one with an empty row (s6).
  assert.deepEqual(await list(tree("all", group("all", lacks("vip"), lacks("event")))), ["s4", "s6"]);
  assert.deepEqual(await list(tree("all", group("any", has("vip"), has("event")))), ["s1", "s2", "s3", "s5", "s7"]);
  assert.deepEqual(await list(tree("any", group("all", has("vip"), has("event")))), ["s5"]);
  // Tags are normalized, and negate false is a present tag.
  assert.deepEqual(await list(tree("all", group("all", { tag: " EVENT ", negate: false }))), ["s3", "s5"]);
  // A boolean leaf compares only boolean values, and a date leaf only dates.
  assert.deepEqual(
    await list(tree("all", group("all", { field_id: fields.member, field_operator: "eq", field_value: true }))),
    ["s5"],
  );
  assert.deepEqual(
    await list(tree("all", group("all", { field_id: fields.joined, field_operator: "lt", field_value: "2026-01-15" }))),
    ["s5"],
  );
});

test("condition trees are an AND with every outer limit, and the preview excludes conditions after the limits", async () => {
  const fields = await fixture();
  const T = vipOrEvent(fields);
  const page = (extra: Record<string, string>) => listContacts(listClock(), owner, byTree(T, extra));
  // Comment activity: s5's only comment is old.
  assert.deepEqual(senders(await page({ connection_id: C, last_comment_days: "3" })), ["s1", "s3"]);
  assert.deepEqual(
    senders(
      await page({
        connection_id: C,
        last_comment_from: "2026-10-01T00:00:00.000Z",
        last_comment_before: "2026-10-10T00:00:00.000Z",
      }),
    ),
    ["s1", "s3"],
  );
  // Comment consent: only s3 has a recorded comment grant.
  assert.deepEqual(senders(await page({ consent_purpose: "marketing", consent_state: "granted" })), ["s3"]);
  // DM consent and DM activity: only s1 and s2 have a verified DM conversation, and s2 fails the tree.
  assert.deepEqual(senders(await page({ dm_consent_purpose: "marketing", dm_consent_state: "granted" })), ["s1"]);
  assert.deepEqual(senders(await page({ last_dm_days: "3" })), ["s1"]);
  // The preview: s1..s6 are evaluated on C; s5 is activity, then s2, s4 and s6 fail the tree.
  const activity = await page({ connection_id: C, last_comment_days: "3", preview: "true" });
  assert.deepEqual(senders(activity), ["s1", "s3"]);
  assert.equal(activity.total, "2");
  assert.equal(activity.evaluated, "6");
  assert.deepEqual(Object.keys(activity.excluded!), ["activity", "conditions"]);
  assert.deepEqual(activity.excluded, { activity: "1", conditions: "3" });
  assert.equal(sum(activity), BigInt(activity.evaluated!));
  // Every limit reason precedes conditions.
  const dm = await page({ connection_id: C, last_dm_days: "3", preview: "true" });
  assert.deepEqual(dm.excluded, { dm_identity: "4", dm_activity: "0", conditions: "1" });
  assert.equal(sum(dm), BigInt(dm.evaluated!));
  const all = await page({
    connection_id: C,
    preview: "true",
    last_comment_days: "3",
    consent_purpose: "marketing",
    consent_state: "no_record",
    dm_consent_purpose: "marketing",
    dm_consent_state: "granted",
    last_dm_days: "3",
  });
  assert.deepEqual(Object.keys(all.excluded!), [
    "activity",
    "consent",
    "dm_identity",
    "dm_consent",
    "dm_activity",
    "conditions",
  ]);
  // s5 activity; s3 consent; s4, s6 no DM conversation; s2 no DM grant; s1 matches.
  assert.deepEqual(all.excluded, {
    activity: "1",
    consent: "1",
    dm_identity: "2",
    dm_consent: "1",
    dm_activity: "0",
    conditions: "0",
  });
  assert.deepEqual(senders(all), ["s1"]);
  assert.equal(sum(all), BigInt(all.evaluated!));
  // Zero matches keep the summary.
  const none = await listContacts(
    listClock(),
    owner,
    byTree(tree("all", group("all", has("nobody"))), { connection_id: C, preview: "true" }),
  );
  assert.deepEqual(none.contacts, []);
  assert.equal(none.total, "0");
  assert.equal(none.evaluated, "6");
  assert.deepEqual(none.excluded, { conditions: "6" });
  // Without a tree the response keeps the tag, field and both keys and has no conditions key.
  const legacy = await listContacts(listClock(), owner, query({ connection_id: C, tag: "vip", preview: "true" }));
  assert.deepEqual(legacy.excluded, { tag: "3", field: "0", both: "0" });
  assert.equal(legacy.total, "3");
  // A tree field leaf must name an active field of the workspace.
  const foreignField = await field("foreign", "number", foreignWorkspace);
  await assert.rejects(
    listContacts(pool, owner, byTree(tree("all", group("all", { field_id: foreignField, field_operator: "is_set" })))),
    refused(404, "field_not_found"),
  );
  await assert.rejects(
    listContacts(
      pool,
      owner,
      byTree(tree("all", group("all", { field_id: fields.member, field_operator: "gt", field_value: 1 }))),
    ),
    refused(400, "invalid_field_condition"),
  );
  await assert.rejects(
    listContacts(
      pool,
      owner,
      byTree(tree("all", group("all", { field_id: fields.score, field_operator: "eq", field_value: "x" }))),
    ),
    refused(400, "invalid_field_value"),
  );
});

test("tree segments save, edit with order as part of the definition, select, export at one clock and archive", async () => {
  const fields = await fixture();
  const T = vipOrEvent(fields);
  const legacy = await createContactSegment(pool, owner, { name: "Legacy", tag: "vip" });
  assert.deepEqual(legacy, { id: legacy.id, name: "Legacy", connection_id: null, tag: "vip", version: 1 });
  const upper = tree(
    "any",
    group(
      "all",
      { tag: " VIP ", negate: false },
      { ...T.groups[0].conditions[1], field_id: fields.score.toUpperCase() },
    ),
    group("all", has("event")),
  );
  const segment = await createContactSegment(pool, owner, { name: "Grouped", connection_id: C, condition_tree: upper });
  assert.deepEqual(segment, { id: segment.id, name: "Grouped", connection_id: C, condition_tree: T, version: 1 });
  assert.deepEqual(
    (await listContactSegments(pool, owner)).find((value) => value.id === segment.id),
    segment,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT tag,tags,tag_mode,field_id,field_operator,field_value,field_conditions,field_mode,condition_operator,condition_tree FROM instagram_contact_segments WHERE id=$1",
        [segment.id],
      )
    ).rows[0],
    {
      tag: null,
      tags: null,
      tag_mode: null,
      field_id: null,
      field_operator: null,
      field_value: null,
      field_conditions: null,
      field_mode: null,
      condition_operator: "and",
      condition_tree: T,
    },
  );
  const bySegment = query({ segment_id: segment.id });
  const selected = await listContacts(listClock(), owner, bySegment);
  assert.deepEqual(selected, await listContacts(listClock(), owner, byTree(T, { connection_id: C })));
  assert.deepEqual(senders(selected), ["s1", "s3", "s5"]);
  const preview = await listContacts(listClock(), owner, query({ segment_id: segment.id, preview: "true" }));
  assert.deepEqual(preview.excluded, { conditions: "3" });
  await assert.rejects(
    listContacts(pool, owner, query({ segment_id: segment.id, condition_tree: JSON.stringify(T) })),
    refused(400, "invalid_contact_request"),
  );
  await assert.rejects(listContacts(pool, outsider, bySegment), refused(404, "segment_not_found"));
  // The export evaluates the tree once at exported_at for every batch and selects the list's contacts.
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
  // The same tree in another spelling is unchanged and keeps the version.
  const edit = (condition_tree: unknown, expected_version: number) =>
    updateContactSegment(pool, owner, segment.id, {
      name: "Grouped",
      connection_id: C,
      condition_tree,
      expected_version,
    });
  assert.deepEqual(await edit(upper, 1), { conflict: false, segment });
  // Reordering the groups is a change, and so is reordering the leaves of a group.
  const swapped = tree("any", T.groups[1], T.groups[0]);
  const second = await edit(swapped, 1);
  assert.deepEqual(second.segment, { ...segment, condition_tree: swapped, version: 2 });
  assert.deepEqual(senders(await listContacts(listClock(), owner, bySegment)), ["s1", "s3", "s5"]);
  const leaves = tree("any", T.groups[1], group("all", T.groups[0].conditions[1], T.groups[0].conditions[0]));
  const third = await edit(leaves, 2);
  assert.equal(third.segment.version, 3);
  // A mode change changes the selection.
  const fourth = await edit({ ...leaves, mode: "all" }, 3);
  assert.equal(fourth.segment.version, 4);
  assert.deepEqual(senders(await listContacts(listClock(), owner, bySegment)), []);
  const stale = await edit(T, 3);
  assert.deepEqual(stale, { conflict: true, segment: fourth.segment });
  // Replacing the tree with a legacy tag drops the tree; the response then has the tag key again.
  const back = await updateContactSegment(pool, owner, segment.id, {
    name: "Grouped",
    tag: "event",
    expected_version: 4,
  });
  assert.deepEqual(back.segment, { id: segment.id, name: "Grouped", connection_id: null, tag: "event", version: 5 });
  assert.equal(
    (await pool.query("SELECT condition_tree FROM instagram_contact_segments WHERE id=$1", [segment.id])).rows[0]
      .condition_tree,
    null,
  );
  // Mixing forms is refused on create and on edit, and nothing is written.
  for (const mixed of [
    { tag: "vip" },
    { condition_operator: "and" },
    { field_conditions: [T.groups[0].conditions[1]] },
  ])
    await assert.rejects(
      createContactSegment(pool, owner, { name: "Mixed", condition_tree: T, ...mixed }),
      refused(400, "invalid_contact_condition"),
    );
  assert.equal((await listContactSegments(pool, owner)).length, 2);
  await archiveContactSegment(pool, owner, segment.id);
  await assert.rejects(listContacts(pool, owner, bySegment), refused(404, "segment_not_found"));
});

test("a field referenced only inside a condition tree cannot be archived", async () => {
  const fields = await fixture();
  const T = tree(
    "all",
    group("all", has("vip")),
    group("any", has("event"), { field_id: fields.plan, field_operator: "eq", field_value: "pro" }),
  );
  const segment = await createContactSegment(pool, owner, { name: "Nested", condition_tree: T });
  await assert.rejects(archiveContactField(pool, owner, fields.plan), refused(409, "field_in_use"));
  // A field the tree does not name archives, and an archived tree segment no longer holds its field.
  assert.deepEqual(await archiveContactField(pool, owner, fields.member), { id: fields.member });
  await archiveContactSegment(pool, owner, segment.id);
  assert.deepEqual(await archiveContactField(pool, owner, fields.plan), { id: fields.plan });
  // A tree that names an archived field is refused.
  await assert.rejects(
    createContactSegment(pool, owner, {
      name: "Archived",
      condition_tree: tree("all", group("all", { field_id: fields.plan, field_operator: "is_set" })),
    }),
    refused(404, "field_not_found"),
  );
});

async function lockWaiters(count: number, settled: () => boolean = () => false) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const waiting = Number(
      (
        await pool.query(
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
        )
      ).rows[0].count,
    );
    if (waiting >= count || settled()) return;
    if (Date.now() > deadline) throw new Error(`expected ${count} lock waiters, saw ${waiting}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a tree segment write holds every tree field, so a concurrent archive waits and answers field_in_use", async () => {
  const fields = await fixture();
  // The archived field is the one that sorts last, and the tree names it first, in the second group.
  const [first, last] = [fields.plan, fields.score].sort();
  const T = tree(
    "any",
    group("all", { field_id: first, field_operator: "is_set" }),
    group("all", { field_id: last, field_operator: "is_unset" }, { field_id: first, field_operator: "is_unset" }),
  );
  // The blocker holds C2, so the create's foreign-key check waits after it locked the fields.
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM instagram_connections WHERE id=$1 FOR UPDATE", [C2]);
    const create = createContactSegment(pool, owner, { name: "Race tree", connection_id: C2, condition_tree: T });
    await lockWaiters(1);
    let archiveSettled = false;
    const archive = archiveContactField(pool, owner, last).then(
      () => "archived",
      (error: unknown) => (error instanceof ApiError ? error.message : String(error)),
    );
    void archive.finally(() => {
      archiveSettled = true;
    });
    await lockWaiters(2, () => archiveSettled);
    await blocker.query("COMMIT");
    const [saved, archived] = await Promise.all([create, archive]);
    assert.equal(saved.name, "Race tree");
    assert.equal(archived, "field_in_use");
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
  assert.equal(
    (await pool.query("SELECT archived FROM instagram_contact_fields WHERE id=$1", [last])).rows[0].archived,
    false,
  );
});

test("condition tree migration preserves existing rows, replays with the schema and enforces the root shape", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE instagram_contact_segments DROP COLUMN condition_tree");
    await client.query(
      "INSERT INTO instagram_contact_segments(workspace_id,name,tag,last_dm_days) VALUES($1,'Legacy','vip',7)",
      [workspace],
    );
    const migration = await readFile(
      new URL("../../db/migrations/060_segment_condition_tree.sql", import.meta.url),
      "utf8",
    );
    const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
    await client.query(migration);
    await client.query(migration);
    const read = async () =>
      (
        await client.query(
          "SELECT name,tag,last_dm_days,condition_operator,condition_tree FROM instagram_contact_segments",
        )
      ).rows;
    assert.deepEqual(await read(), [
      { name: "Legacy", tag: "vip", last_dm_days: 7, condition_operator: "and", condition_tree: null },
    ]);
    // A valid root shape is stored; group and leaf detail stays with the parser.
    const valid = { mode: "any", groups: [{ mode: "all", conditions: [{ tag: "vip" }] }] };
    await client.query(
      "INSERT INTO instagram_contact_segments(workspace_id,name,condition_tree) VALUES($1,'Tree',$2::jsonb)",
      [workspace, JSON.stringify(valid)],
    );
    // The full runner order re-applies 060 and the DB tests re-apply the schema over rows that hold a tree.
    await client.query(migration);
    await client.query(schema);
    assert.deepEqual((await read()).find((row) => row.name === "Tree")?.condition_tree, valid);
    const refusedBy = async (sql: string, values: unknown[], constraint?: string) => {
      await client.query("SAVEPOINT invalid_tree");
      await assert.rejects(client.query(sql, values), (error: unknown) => {
        const failure = error as { code?: string; constraint?: string };
        return failure.code === "23514" && (constraint === undefined || failure.constraint === constraint);
      });
      await client.query("ROLLBACK TO SAVEPOINT invalid_tree");
    };
    const set = "UPDATE instagram_contact_segments SET condition_tree=$1::jsonb WHERE name='Tree'";
    for (const shape of [
      [],
      "tree",
      1,
      {},
      { mode: "all" },
      { groups: [{}] },
      { mode: "none", groups: [{}] },
      { mode: "all", groups: [] },
      { mode: "all", groups: {} },
      { mode: "all", groups: [{}, {}, {}, {}, {}, {}] },
      { ...valid, extra: 1 },
    ])
      await refusedBy(set, [JSON.stringify(shape)], "contact_segment_condition_tree");
    // A tree row has no other condition form and the operator and.
    for (const column of ["tag='vip'", "tags='{a,b}',tag_mode='all'", "field_conditions='[]',field_mode='all'"])
      await refusedBy(`UPDATE instagram_contact_segments SET ${column} WHERE name='Tree'`, []);
    await refusedBy("UPDATE instagram_contact_segments SET condition_operator='or' WHERE name='Tree'", []);
    await refusedBy(
      "UPDATE instagram_contact_segments SET condition_tree=$1::jsonb WHERE name='Legacy'",
      [JSON.stringify(valid)],
      "contact_segment_condition_tree",
    );
    // Five groups is the largest root.
    await client.query(set, [JSON.stringify({ mode: "all", groups: [{}, {}, {}, {}, {}] })]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
