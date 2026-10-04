import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import type { Pool as PoolType } from "pg";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { EXPORTED_TABLES } from "./workspace-export.ts";
import { ingestMessages } from "../instagram/follow-flow.ts";
import { storeInboxMessage } from "../instagram/inbox.ts";
import type { InstagramMessage } from "../instagram/message-events.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const owner = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const admin = { id: "22222222-2222-4222-8222-222222222222", email: "admin@example.test" };
const agent = { id: "33333333-3333-4333-8333-333333333333", email: "agent@example.test" };
const outsider = { id: "55555555-5555-4555-8555-555555555555", email: "outsider@example.test" };
const stranger = { id: "56565656-5656-4565-8565-565656565656", email: "stranger@example.test" };
const workspaceId = "66666666-6666-4666-8666-666666666666";
const otherWorkspaceId = "77777777-7777-4777-8777-777777777777";
const connectionId = "88888888-8888-4888-8888-888888888888";
const secondConnectionId = "99999999-9999-4999-8999-999999999999";
const foreignConnectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test" };

type Actor = { id: string; email: string };
type Label = { id: string; name: string; archived: boolean };
type Rule = {
  id: string;
  label: Label;
  match_mode: string;
  keywords: string[];
  excluded_keywords: string[];
  archived: boolean;
  version: number;
};
type LabelSet = { version: number; labels: Label[] };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces, workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role,email)
     VALUES($1,$2,'owner',$3),($1,$4,'admin',$5),($1,$6,'agent',$7),($8,$9,'owner',$10)`,
    [
      workspaceId,
      owner.id,
      owner.email,
      admin.id,
      admin.email,
      agent.id,
      agent.email,
      otherWorkspaceId,
      outsider.id,
      outsider.email,
    ],
  );
  // Only an active connection with the inbox on stores DMs, so only then do rules apply.
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,active,inbox_enabled,inbox_enabled_at)
     VALUES($1,$4,'123','shop',true,true,now()-interval '1 day'),($2,$4,'124','studio',true,false,NULL),
       ($3,$5,'125','foreign',true,true,now()-interval '1 day')`,
    [connectionId, secondConnectionId, foreignConnectionId, workspaceId, otherWorkspaceId],
  );
});

after(async () => pool.end());

type Connect = () => Promise<unknown>;

function request(
  actor: Actor,
  method: string,
  path: string,
  body?: unknown,
  connect: Connect = pool.connect.bind(pool),
  origin = "https://app.test",
) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin, cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect, end: async () => {} }) as unknown as PoolType,
    (async () => Response.json({ id: actor.id, email: actor.email, email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

async function body<T>(response: Response, status: number): Promise<T> {
  const value = (await response.json()) as T;
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

async function errorCode(response: Response, status: number): Promise<string> {
  return (await body<{ error: string }>(response, status)).error;
}

async function label(name: string, workspace = workspaceId): Promise<string> {
  return (
    await pool.query("INSERT INTO instagram_inbox_labels(workspace_id,name,created_by) VALUES($1,$2,$3) RETURNING id", [
      workspace,
      name,
      admin.id,
    ])
  ).rows[0].id;
}

const createRule = (actor: Actor, input: unknown) => request(actor, "POST", "/api/inbox/label-rules", input);
async function rule(labelId: string, keywords: string[], extra: Record<string, unknown> = {}): Promise<Rule> {
  return body<Rule>(await createRule(admin, { label_id: labelId, match_mode: "contains", keywords, ...extra }), 201);
}
const editRule = (actor: Actor, id: string, input: unknown) =>
  request(actor, "PATCH", `/api/inbox/label-rules/${id}`, input);
const archiveRule = (actor: Actor, id: string) => request(actor, "DELETE", `/api/inbox/label-rules/${id}`);
const listRules = async () =>
  (await body<{ rules: Rule[] }>(await request(admin, "GET", "/api/inbox/label-rules"), 200)).rules;

let messageSeq = 0;
function dm(sender: string, text: string, extra: Partial<InstagramMessage> = {}): InstagramMessage {
  messageSeq += 1;
  return {
    accountId: "123",
    senderId: sender,
    messageId: `m-${messageSeq}`,
    text,
    timestamp: new Date(Date.now() - 1000),
    ...extra,
  };
}

const labelsPath = (recipient: string) => `/api/inbox/conversations/${connectionId}/${recipient}/labels`;
const putLabels = (actor: Actor, recipient: string, ids: string[], expected: number) =>
  request(actor, "PUT", labelsPath(recipient), { expected_version: expected, label_ids: ids });

async function labelSet(
  recipient: string,
): Promise<{ label_ids: string[]; version: number; updated_by: string | null }> {
  return (
    await pool.query(
      `SELECT label_ids::text[] AS label_ids,version,updated_by FROM instagram_inbox_conversation_labels
       WHERE connection_id=$1 AND recipient_id=$2`,
      [connectionId, recipient],
    )
  ).rows[0];
}
async function events(recipient?: string) {
  return (
    await pool.query(
      `SELECT recipient_id,version,added::text[] AS added,removed::text[] AS removed,actor_id,rule_id::text
       FROM instagram_inbox_label_events WHERE $1::text IS NULL OR recipient_id=$1 ORDER BY recipient_id,version`,
      [recipient ?? null],
    )
  ).rows;
}
async function storedMessages(recipient: string): Promise<number> {
  return (
    await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_messages WHERE recipient_id=$1", [recipient])
  ).rows[0].count;
}

// Returns once `operation` either finished or `count` backends wait for a lock, so a missing lock fails a value
// assertion instead of a lock-wait timeout.
async function settledOrWaiting(operation: Promise<unknown>, count = 1) {
  let settled = false;
  void operation.finally(() => (settled = true)).catch(() => undefined);
  for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
    const waiting = await pool.query(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()",
    );
    if (waiting.rows[0].waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A connection that holds its transaction just before COMMIT until `release` is called.
function heldConnect() {
  let reached!: () => void;
  let release!: () => void;
  const atCommit = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const connect = async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (text: string, values?: unknown[]) => {
            if (text === "COMMIT") {
              reached();
              await released;
            }
            return target.query(text, values);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return { connect, atCommit, release };
}

// Runs ingestion and holds its transaction before COMMIT, after the DMs and their labels were written.
function heldIngestion(messages: InstagramMessage[]) {
  const held = heldConnect();
  const done = ingestMessages({ connect: held.connect } as unknown as PoolType, messages);
  return { ...held, done };
}

function heldRequest(actor: Actor, method: string, path: string, payload: unknown) {
  const held = heldConnect();
  return { ...held, response: request(actor, method, path, payload, held.connect) };
}

test("admins create, list, change and archive rules; keywords are stored the way they are matched", async () => {
  const refund = await label("환불");
  const vip = await label("VIP");
  const created = await rule(refund, ["  환불 ", "REFUND", "refund", "Café"], {
    excluded_keywords: [" 취소 ", "취소"],
  });
  assert.deepEqual(
    { ...created, id: undefined },
    {
      id: undefined,
      label: { id: refund, name: "환불", archived: false },
      match_mode: "contains",
      keywords: ["환불", "refund", "café"],
      excluded_keywords: ["취소"],
      archived: false,
      version: 1,
      created_at: (created as unknown as { created_at: string }).created_at,
      updated_at: (created as unknown as { updated_at: string }).updated_at,
    },
  );
  const changed = await body<Rule>(
    await editRule(owner, created.id, { expected_version: 1, label_id: vip, match_mode: "exact", keywords: ["vip"] }),
    200,
  );
  assert.deepEqual(
    [changed.label.id, changed.match_mode, changed.keywords, changed.excluded_keywords, changed.version],
    [vip, "exact", ["vip"], [], 2],
  );
  const audit = (
    await pool.query("SELECT created_by,updated_by FROM instagram_inbox_label_rules WHERE id=$1", [created.id])
  ).rows[0];
  assert.deepEqual(audit, { created_by: admin.id, updated_by: owner.id });
  const second = await rule(refund, ["환불"]);
  const archived = await body<Rule>(await archiveRule(admin, created.id), 200);
  assert.deepEqual([archived.archived, archived.version], [true, 3]);
  // Archiving again changes nothing.
  assert.equal((await body<Rule>(await archiveRule(admin, created.id), 200)).version, 3);
  // Active rules first, each group in creation order.
  assert.deepEqual(
    (await listRules()).map((row) => [row.id, row.archived]),
    [
      [second.id, false],
      [created.id, true],
    ],
  );
  assert.equal(
    await errorCode(
      await editRule(admin, created.id, { expected_version: 3, label_id: vip, match_mode: "exact", keywords: ["x"] }),
      409,
    ),
    "label_rule_archived",
  );
  assert.equal(
    await errorCode(await archiveRule(admin, "abababab-abab-4bab-8bab-abababababab"), 404),
    "label_rule_not_found",
  );
});

test("rule requests are admin-only, same-origin, validated and scoped to the workspace", async () => {
  const refund = await label("환불");
  const foreign = await label("foreign", otherWorkspaceId);
  const valid = { label_id: refund, match_mode: "contains", keywords: ["환불"] };
  assert.equal(await errorCode(await request(agent, "GET", "/api/inbox/label-rules"), 403), "role_forbidden");
  assert.equal(await errorCode(await createRule(agent, valid), 403), "role_forbidden");
  assert.equal(await errorCode(await createRule(stranger, valid), 403), "workspace_required");
  assert.equal(
    await errorCode(await request(admin, "POST", "/api/inbox/label-rules", valid, undefined, "https://evil.test"), 403),
    "origin_rejected",
  );
  const invalid: [unknown, string][] = [
    [{ ...valid, match_mode: "all" }, "invalid_label_rule"],
    [{ ...valid, label_id: "not-a-uuid" }, "invalid_label_rule"],
    [{ ...valid, extra: true }, "invalid_label_rule"],
    [{ ...valid, keywords: [] }, "invalid_label_rule_keywords"],
    [{ ...valid, keywords: ["   "] }, "invalid_label_rule_keywords"],
    [{ ...valid, keywords: ["x".repeat(101)] }, "invalid_label_rule_keywords"],
    [{ ...valid, keywords: Array.from({ length: 21 }, (_, index) => `k${index}`) }, "invalid_label_rule_keywords"],
    [{ ...valid, keywords: [1] }, "invalid_label_rule_keywords"],
    // The editor separates keywords with commas, so a comma or a line break inside one is refused.
    [{ ...valid, keywords: ["hello, world"] }, "invalid_label_rule_keywords"],
    [{ ...valid, keywords: ["hello\nworld"] }, "invalid_label_rule_keywords"],
    [{ ...valid, keywords: ["hello\rworld"] }, "invalid_label_rule_keywords"],
    [{ ...valid, excluded_keywords: ["취소,환불"] }, "invalid_label_rule_keywords"],
    [{ ...valid, excluded_keywords: [""] }, "invalid_label_rule_keywords"],
    [{ ...valid, excluded_keywords: "취소" }, "invalid_label_rule_keywords"],
  ];
  for (const [input, code] of invalid) assert.equal(await errorCode(await createRule(admin, input), 400), code);
  // Twenty keywords of 100 characters each are accepted.
  await rule(
    refund,
    Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(100, "가")),
  );
  // Another workspace's label is answered like a missing one, and so is a rule of another workspace.
  assert.equal(await errorCode(await createRule(admin, { ...valid, label_id: foreign }), 404), "label_not_found");
  const theirs = (
    await pool.query(
      `INSERT INTO instagram_inbox_label_rules(workspace_id,label_id,match_mode,keywords,created_by,updated_by)
       VALUES($1,$2,'contains','{x}',$3,$3) RETURNING id`,
      [otherWorkspaceId, foreign, outsider.id],
    )
  ).rows[0].id;
  assert.equal(
    await errorCode(await editRule(admin, theirs, { ...valid, expected_version: 1 }), 404),
    "label_rule_not_found",
  );
  assert.equal(await errorCode(await archiveRule(admin, theirs), 404), "label_rule_not_found");
  assert.equal(await errorCode(await editRule(admin, theirs, { ...valid }), 400), "invalid_label_rule");
  assert.deepEqual(
    (await listRules()).map((row) => row.label.id),
    [refund],
  );
});

test("a rule's label must be active when the rule is written; a label archived later only makes the rule skip", async () => {
  const refund = await label("환불");
  const vip = await label("vip");
  const created = await rule(refund, ["환불"]);
  await pool.query("UPDATE instagram_inbox_labels SET archived=true WHERE id=$1", [vip]);
  assert.equal(
    await errorCode(await createRule(admin, { label_id: vip, match_mode: "contains", keywords: ["x"] }), 409),
    "label_archived",
  );
  assert.equal(
    await errorCode(
      await editRule(admin, created.id, {
        expected_version: 1,
        label_id: vip,
        match_mode: "contains",
        keywords: ["x"],
      }),
      409,
    ),
    "label_archived",
  );
  // A rule write that waits on an uncommitted archive of its label sees the archive and refuses.
  const pending = await label("pending");
  const archiver = await pool.connect();
  try {
    await archiver.query("BEGIN");
    await archiver.query("UPDATE instagram_inbox_labels SET archived=true WHERE id=$1", [pending]);
    const creation = createRule(admin, { label_id: pending, match_mode: "contains", keywords: ["x"] });
    await settledOrWaiting(creation);
    await archiver.query("COMMIT");
    assert.equal(await errorCode(await creation, 409), "label_archived");
  } finally {
    await archiver.query("ROLLBACK").catch(() => undefined);
    archiver.release();
  }
  await body(await request(admin, "DELETE", `/api/inbox/labels/${refund}`), 200);
  // The rule stays and is listed with its archived label; ingestion skips it.
  assert.deepEqual((await listRules())[0]!.label, { id: refund, name: "환불", archived: true });
  await ingestMessages(pool, [dm("456", "환불 부탁해요")]);
  assert.equal(await storedMessages("456"), 1);
  assert.equal(await labelSet("456"), undefined);
});

test("a stale expected_version answers with the current rule; an unchanged rule keeps its version", async () => {
  const refund = await label("환불");
  const created = await rule(refund, ["환불"]);
  const same = await body<Rule>(
    await editRule(admin, created.id, {
      expected_version: 1,
      label_id: refund,
      match_mode: "contains",
      keywords: [" 환불"],
    }),
    200,
  );
  assert.equal(same.version, 1);
  await body(
    await editRule(admin, created.id, {
      expected_version: 1,
      label_id: refund,
      match_mode: "contains",
      keywords: ["환불", "반품"],
    }),
    200,
  );
  const stale = await editRule(owner, created.id, {
    expected_version: 1,
    label_id: refund,
    match_mode: "exact",
    keywords: ["x"],
  });
  const conflict = await body<{ error: string; rule: Rule }>(stale, 409);
  assert.equal(conflict.error, "label_rule_conflict");
  assert.deepEqual([conflict.rule.version, conflict.rule.keywords], [2, ["환불", "반품"]]);
  for (const expected_version of [0, "2", 2147483647])
    assert.equal(
      await errorCode(
        await editRule(admin, created.id, {
          expected_version,
          label_id: refund,
          match_mode: "contains",
          keywords: ["x"],
        }),
        400,
      ),
      "invalid_label_rule",
    );
});

test("a workspace has at most 50 active rules, and concurrent creations at the limit queue on the workspace row", async () => {
  const refund = await label("환불");
  for (let index = 0; index < 49; index += 1)
    await pool.query(
      `INSERT INTO instagram_inbox_label_rules(workspace_id,label_id,match_mode,keywords,created_by,updated_by)
       VALUES($1,$2,'contains',ARRAY[$3],$4,$4)`,
      [workspaceId, refund, `keyword ${index}`, admin.id],
    );
  const input = { label_id: refund, match_mode: "contains", keywords: ["last"] };
  const held = heldRequest(admin, "POST", "/api/inbox/label-rules", input);
  try {
    await Promise.race([
      held.atCommit,
      held.response.then((response) => assert.fail(`finished before COMMIT with ${response.status}`)),
    ]);
    let settled = false;
    const second = createRule(owner, input).finally(() => (settled = true));
    await settledOrWaiting(second);
    const waited = !settled;
    held.release();
    assert.equal((await held.response).status, 201);
    assert.equal(await errorCode(await second, 409), "label_rule_limit_reached");
    assert.ok(waited, "the second creation did not wait for the first");
  } finally {
    held.release();
  }
  // Archived rules do not count.
  const first = (await listRules())[0]!;
  await body(await archiveRule(admin, first.id), 200);
  await rule(refund, ["again"]);
  assert.equal(await errorCode(await createRule(admin, input), 409), "label_rule_limit_reached");
});

test("matching uses contains and exact with the comment-rule normalization, excluded keywords first, and text DMs only", async () => {
  const refund = await label("환불");
  const vip = await label("vip");
  const order = await label("주문");
  const cafe = await label("cafe");
  const refundRule = await rule(refund, ["환불"]);
  const vipRule = await rule(vip, ["VIP"], { match_mode: "exact" });
  const orderRule = await rule(order, ["주문"], { excluded_keywords: ["취소"] });
  const cafeRule = await rule(cafe, ["café"]);
  await ingestMessages(pool, [
    dm("501", "환불 해주세요"),
    dm("502", "  Vip  "),
    dm("503", "vip please"),
    dm("504", "주문 취소할게요"),
    dm("505", "주문 확인 부탁"),
    // Decomposed and upper case: NFC and lower case make it "café".
    dm("506", "CAFÉ latte"),
    // A button postback carries text but is never matched.
    dm("507", "환불", { confirmationReplyId: "abababab-abab-4bab-8bab-abababababab" }),
  ]);
  for (const sender of ["501", "502", "503", "504", "505", "506", "507"]) assert.equal(await storedMessages(sender), 1);
  assert.deepEqual(
    (await events()).map((row) => [row.recipient_id, row.version, row.added, row.removed, row.actor_id, row.rule_id]),
    [
      ["501", 1, [refund], [], null, refundRule.id],
      ["502", 1, [vip], [], null, vipRule.id],
      ["505", 1, [order], [], null, orderRule.id],
      ["506", 1, [cafe], [], null, cafeRule.id],
    ],
  );
  // A conversation no rule labelled has no label-set row at all.
  for (const sender of ["503", "504", "507"]) assert.equal(await labelSet(sender), undefined);
  assert.deepEqual(await labelSet("501"), { label_ids: [refund], version: 1, updated_by: null });
  // The label set reads like a member's change, so the inbox shows the label.
  const read = await body<{ label_set: LabelSet }>(
    await request(agent, "GET", `/api/connections/${connectionId}/inbox/501`),
    200,
  );
  assert.deepEqual(read.label_set, { version: 1, labels: [{ id: refund, name: "환불", archived: false }] });
});

test("rules apply only to DMs stored after them, and a redelivered DM applies nothing twice", async () => {
  const refund = await label("환불");
  const first = dm("456", "환불 문의");
  await ingestMessages(pool, [first]);
  const created = await rule(refund, ["환불"]);
  // The stored DM is not labelled after the fact, and its redelivery stores nothing, so it applies nothing.
  await ingestMessages(pool, [first]);
  assert.equal(await storedMessages("456"), 1);
  assert.equal(await labelSet("456"), undefined);
  const second = dm("456", "환불 다시");
  await ingestMessages(pool, [second]);
  assert.deepEqual(await labelSet("456"), { label_ids: [refund], version: 1, updated_by: null });
  // A member removes it; a redelivery of the DM that added it does not bring it back.
  await body(await putLabels(agent, "456", [], 1), 200);
  await ingestMessages(pool, [second]);
  assert.deepEqual(
    (await events("456")).map((row) => [row.version, row.added, row.removed, row.actor_id, row.rule_id]),
    [
      [1, [refund], [], null, created.id],
      [2, [], [refund], agent.id, null],
    ],
  );
  // DMs to a connection whose inbox is off are not stored, so no rule applies to them.
  await ingestMessages(pool, [dm("456", "환불", { accountId: "124" })]);
  assert.equal(
    (
      await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_label_events WHERE connection_id=$1", [
        secondConnectionId,
      ])
    ).rows[0].count,
    0,
  );
});

test("a label a member removed is never added back by a rule, but a member can add it back", async () => {
  const refund = await label("환불");
  const vip = await label("vip");
  await rule(refund, ["환불"]);
  await rule(vip, ["환불"]);
  await ingestMessages(pool, [dm("456", "환불")]);
  assert.deepEqual((await labelSet("456")).label_ids, [refund, vip]);
  await body(await putLabels(agent, "456", [vip], 1), 200);
  // Only the label the member removed is skipped; the DM is stored and nothing is written.
  await ingestMessages(pool, [dm("456", "환불 또")]);
  assert.equal(await storedMessages("456"), 2);
  assert.deepEqual(await labelSet("456"), { label_ids: [vip], version: 2, updated_by: agent.id });
  await body(await putLabels(admin, "456", [refund, vip], 2), 200);
  await body(await putLabels(admin, "456", [refund], 3), 200);
  // vip was removed by a member now too; refund is on the conversation already.
  await ingestMessages(pool, [dm("456", "환불 세 번째")]);
  assert.equal((await labelSet("456")).version, 4);
  // Another conversation is not affected by this one's removals.
  await ingestMessages(pool, [dm("457", "환불")]);
  assert.deepEqual((await labelSet("457")).label_ids, [refund, vip]);
});

test("an archived label, an archived rule or a full set leaves the DM stored and the set unchanged", async () => {
  const refund = await label("환불");
  const vip = await label("vip");
  const refundRule = await rule(refund, ["환불"]);
  await rule(vip, ["vip"]);
  await body(await archiveRule(admin, refundRule.id), 200);
  await pool.query("UPDATE instagram_inbox_labels SET archived=true WHERE id=$1", [vip]);
  await ingestMessages(pool, [dm("456", "환불 vip")]);
  assert.equal(await storedMessages("456"), 1);
  assert.equal(await labelSet("456"), undefined);

  // Ten labels are the most a conversation holds.
  const ten = [];
  for (let index = 0; index < 10; index += 1) ten.push(await label(`full ${index}`));
  const extra = await label("extra");
  await rule(extra, ["extra"]);
  await pool.query(
    `INSERT INTO instagram_inbox_conversation_labels(workspace_id,connection_id,recipient_id,label_ids,version)
     VALUES($1,$2,'457',$3::uuid[],1)`,
    [workspaceId, connectionId, ten],
  );
  await ingestMessages(pool, [dm("457", "extra please")]);
  assert.equal(await storedMessages("457"), 1);
  assert.deepEqual((await labelSet("457")).version, 1);
  assert.deepEqual(await events("457"), []);

  // A sender ID longer than the label tables' 40 digits skips the rules instead of failing their recipient CHECK.
  const long = "1".repeat(41);
  await ingestMessages(pool, [dm(long, "extra please")]);
  assert.equal(await storedMessages(long), 1);
  assert.equal(await labelSet(long), undefined);
  assert.deepEqual(await events(long), []);
});

test("several matching rules write one version and one audit row naming the first matching rule", async () => {
  const labels = [];
  for (const name of ["a", "b", "c", "d"]) labels.push(await label(name));
  const [a, b, c, d] = labels as [string, string, string, string];
  // Rules apply in (created_at, id) order; a later rule for the same label never names the change.
  const ruleA = await rule(a, ["환불"]);
  const ruleB = await rule(b, ["환불"]);
  const ruleB2 = await rule(b, ["환불"]);
  const ruleC = await rule(c, ["환불"]);
  assert.notEqual(ruleB2.id, ruleB.id);
  await ingestMessages(pool, [dm("456", "환불")]);
  assert.deepEqual(await events("456"), [
    { recipient_id: "456", version: 1, added: [a, b, c], removed: [], actor_id: null, rule_id: ruleA.id },
  ]);
  // The change names the first matching rule even when that rule's label is already there.
  await pool.query(
    `INSERT INTO instagram_inbox_conversation_labels(workspace_id,connection_id,recipient_id,label_ids,version)
     VALUES($1,$2,'457',ARRAY[$3::uuid],1)`,
    [workspaceId, connectionId, a],
  );
  await ingestMessages(pool, [dm("457", "환불")]);
  assert.deepEqual(
    (await events("457")).map((row) => [row.version, row.added, row.rule_id]),
    [[2, [b, c], ruleA.id]],
  );
  // With room for one more label, the first rule's label is kept and the rest are dropped.
  const nine = [];
  for (let index = 0; index < 9; index += 1) nine.push(await label(`nine ${index}`));
  await pool.query(
    `INSERT INTO instagram_inbox_conversation_labels(workspace_id,connection_id,recipient_id,label_ids,version)
     VALUES($1,$2,'458',$3::uuid[],1)`,
    [workspaceId, connectionId, nine],
  );
  const ruleD = await rule(d, ["환불"]);
  await pool.query("UPDATE instagram_inbox_label_rules SET archived=true WHERE id<>$1", [ruleD.id]);
  await rule(a, ["환불"]);
  await ingestMessages(pool, [dm("458", "환불")]);
  assert.deepEqual(
    (await events("458")).map((row) => [row.version, row.added, row.rule_id]),
    [[2, [d], ruleD.id]],
  );
  assert.equal((await labelSet("458")).label_ids.length, 10);
});

test("a member's label change racing an auto-label waits for it and gets 409 label_conflict", async () => {
  const refund = await label("환불");
  const vip = await label("vip");
  await ingestMessages(pool, [dm("456", "hello")]);
  await rule(refund, ["환불"]);
  const ingestion = heldIngestion([dm("456", "환불")]);
  try {
    await ingestion.atCommit;
    // The member loaded the conversation at version 0, before the DM arrived.
    let settled = false;
    const put = putLabels(agent, "456", [vip], 0).finally(() => (settled = true));
    await settledOrWaiting(put);
    const waited = !settled;
    ingestion.release();
    await ingestion.done;
    const conflict = await body<{ error: string; label_set: LabelSet }>(await put, 409);
    assert.equal(conflict.error, "label_conflict");
    assert.deepEqual(conflict.label_set, { version: 1, labels: [{ id: refund, name: "환불", archived: false }] });
    assert.ok(waited, "the label change did not wait for the auto-label");
  } finally {
    ingestion.release();
  }
});

test("an auto-label that waits on an uncommitted label archive adds nothing, and an archive waits for an auto-label", async () => {
  const refund = await label("환불");
  const vip = await label("vip");
  await rule(refund, ["환불"]);
  await rule(vip, ["vip"]);
  const archiver = await pool.connect();
  try {
    await archiver.query("BEGIN");
    await archiver.query("UPDATE instagram_inbox_labels SET archived=true WHERE id=$1", [refund]);
    const ingestion = ingestMessages(pool, [dm("456", "환불")]);
    await settledOrWaiting(ingestion);
    await archiver.query("COMMIT");
    await ingestion;
  } finally {
    await archiver.query("ROLLBACK").catch(() => undefined);
    archiver.release();
  }
  assert.equal(await storedMessages("456"), 1);
  assert.deepEqual(await events("456"), []);
  // The decision waited for the archive before writing anything, so not even the version 0 placeholder is left.
  assert.equal(await labelSet("456"), undefined);

  const ingestion = heldIngestion([dm("457", "vip")]);
  try {
    await ingestion.atCommit;
    let settled = false;
    const archive = request(admin, "DELETE", `/api/inbox/labels/${vip}`).finally(() => (settled = true));
    await settledOrWaiting(archive);
    const waited = !settled;
    ingestion.release();
    await ingestion.done;
    assert.equal((await body<Label>(await archive, 200)).archived, true);
    assert.ok(waited, "the archive did not wait for the auto-label");
  } finally {
    ingestion.release();
  }
  assert.deepEqual((await labelSet("457")).label_ids, [vip]);
});

test("rule writes never wait for an ingestion that applied the rule", async () => {
  const refund = await label("환불");
  const created = await rule(refund, ["환불"]);
  const ingestion = heldIngestion([dm("456", "환불")]);
  try {
    await ingestion.atCommit;
    // The audit row's foreign key holds a key-share lock on the rule; an edit and an archive take no stronger lock.
    let settled = false;
    const writes = (async () => {
      const edited = await editRule(admin, created.id, {
        expected_version: 1,
        label_id: refund,
        match_mode: "contains",
        keywords: ["반품"],
      });
      return [edited, await archiveRule(admin, created.id)] as const;
    })().finally(() => (settled = true));
    await settledOrWaiting(writes);
    const finished = settled;
    ingestion.release();
    await ingestion.done;
    const [edited, archived] = await writes;
    assert.equal((await body<Rule>(edited, 200)).version, 2);
    assert.equal((await body<Rule>(archived, 200)).archived, true);
    assert.ok(finished, "a rule write waited for the ingestion");
  } finally {
    ingestion.release();
  }
  assert.deepEqual(
    (await events("456")).map((row) => row.rule_id),
    [created.id],
  );
});

test("an auto-label queues behind person deletion instead of deadlocking", async () => {
  const refund = await label("환불");
  await rule(refund, ["환불"]);
  const ingestion = await pool.connect();
  try {
    await ingestion.query("BEGIN");
    await storeInboxMessage(ingestion, dm("456", "환불"), new Date());
    const deletion = pool
      .query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','456') AS result", [
        workspaceId,
        connectionId,
        owner.id,
      ])
      .then(
        (result) => result.rows[0].result,
        (error: unknown) => error,
      );
    await settledOrWaiting(deletion);
    // Later in the same batch, ingestion takes the connection FOR SHARE again (sendingConnection, the reply wait).
    await ingestion.query("SELECT 1 FROM instagram_connections WHERE id=$1 FOR SHARE", [connectionId]);
    await ingestion.query("COMMIT");
    const result = await deletion;
    assert.ok(!(result instanceof Error), String(result));
    assert.equal(result.deleted_counts.instagram_inbox_label_events, 1);
    assert.equal(result.deleted_counts.instagram_inbox_conversation_labels, 1);
  } finally {
    await ingestion.query("ROLLBACK").catch(() => undefined);
    ingestion.release();
  }
  assert.deepEqual(await events(), []);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_label_rules")).rows[0].count, 1);
});

test("connection and person deletion remove rule-made label changes and keep the rules; workspace deletion removes them", async () => {
  const refund = await label("환불");
  await rule(refund, ["환불"]);
  await ingestMessages(pool, [dm("456", "환불"), dm("457", "환불")]);
  assert.equal((await events()).length, 2);
  const person = (
    await pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','456') AS result", [
      workspaceId,
      connectionId,
      owner.id,
    ])
  ).rows[0].result;
  assert.equal(person.deleted_counts.instagram_inbox_label_events, 1);
  assert.equal(person.deleted_counts.instagram_inbox_label_rules, undefined);
  await pool.query("UPDATE instagram_connections SET active=false WHERE workspace_id=$1", [workspaceId]);
  const connection = (
    await pool.query("SELECT public.delete_connection_data($1,$2,$3,'123') AS result", [
      workspaceId,
      connectionId,
      owner.id,
    ])
  ).rows[0].result;
  assert.equal(connection.deleted_counts.instagram_inbox_label_events, 1);
  assert.equal(connection.deleted_counts.instagram_inbox_label_rules, undefined);
  assert.deepEqual(await events(), []);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_label_rules")).rows[0].count, 1);
  const workspace = (await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspaceId, owner.id]))
    .rows[0].result;
  assert.equal(workspace.deleted_counts.instagram_inbox_label_rules, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_label_rules")).rows[0].count, 0);
});

test("migration 035 replays, the export lists the rules, and a rule alone keeps the workspace from moving", async () => {
  const functions = async () =>
    (
      await pool.query(
        `SELECT proname,pg_get_functiondef(oid) AS body FROM pg_proc
         WHERE pronamespace='public'::regnamespace AND proname IN ('delete_connection_data','delete_person_data','delete_workspace_data')
         ORDER BY proname`,
      )
    ).rows;
  // Other test files replay older migrations, so the current bodies are loaded first.
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  const current = await functions();
  assert.equal(current.length, 3);
  const removesRules = Object.fromEntries(
    current.map(({ proname, body: text }) => [proname, /DELETE FROM public\.instagram_inbox_label_rules\b/.test(text)]),
  );
  assert.deepEqual(removesRules, {
    delete_connection_data: false,
    delete_person_data: false,
    delete_workspace_data: true,
  });
  // Back to the shape before 035, with a label event that names a member as every row then did; the migration then
  // adds the column and validates both constraints against that row.
  await pool.query("ALTER TABLE instagram_inbox_label_events DROP COLUMN rule_id");
  await pool.query("ALTER TABLE instagram_inbox_label_events ALTER COLUMN actor_id SET NOT NULL");
  await pool.query("DROP TABLE instagram_inbox_label_rules");
  await pool.query("DROP FUNCTION public.inbox_label_rule_keywords_valid(text[])");
  const refund = await label("환불");
  await pool.query(
    `INSERT INTO instagram_inbox_conversation_labels(workspace_id,connection_id,recipient_id,label_ids,version,updated_by)
     VALUES($1,$2,'456',ARRAY[$3::uuid],1,$4)`,
    [workspaceId, connectionId, refund, agent.id],
  );
  await pool.query(
    `INSERT INTO instagram_inbox_label_events(workspace_id,connection_id,recipient_id,version,added,removed,actor_id)
     VALUES($1,$2,'456',1,ARRAY[$3::uuid],'{}',$4)`,
    [workspaceId, connectionId, refund, agent.id],
  );
  const migration = await readFile(new URL("../../db/migrations/035_inbox_label_rules.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  assert.deepEqual(await functions(), current);
  assert.deepEqual(EXPORTED_TABLES.instagram_inbox_label_rules, { scope: "workspace" });
  const constraints = await pool.query(
    `SELECT conname,convalidated FROM pg_constraint WHERE conrelid='instagram_inbox_label_events'::regclass
       AND conname IN ('instagram_inbox_label_events_rule','instagram_inbox_label_events_source') ORDER BY conname`,
  );
  assert.deepEqual(constraints.rows, [
    { conname: "instagram_inbox_label_events_rule", convalidated: true },
    { conname: "instagram_inbox_label_events_source", convalidated: true },
  ]);

  // The constraints the migration adds.
  const ruleRow = (match: string, keywords: string, excluded = "'{}'") =>
    pool.query(
      `INSERT INTO instagram_inbox_label_rules(workspace_id,label_id,match_mode,keywords,excluded_keywords,created_by,updated_by)
       VALUES($1,$2,'${match}',${keywords},${excluded},$3,$3) RETURNING id`,
      [workspaceId, refund, admin.id],
    );
  await assert.rejects(ruleRow("all", "'{x}'"), { code: "23514" });
  await assert.rejects(ruleRow("contains", "'{}'"), { code: "23514" });
  await assert.rejects(ruleRow("contains", "ARRAY[' ']"), { code: "23514" });
  await assert.rejects(ruleRow("contains", `ARRAY['${"x".repeat(101)}']`), { code: "23514" });
  await assert.rejects(ruleRow("contains", "ARRAY[NULL::text]"), { code: "23514" });
  await assert.rejects(ruleRow("contains", "'{x}'", "ARRAY['']"), { code: "23514" });
  await assert.rejects(
    pool.query(
      `INSERT INTO instagram_inbox_label_rules(workspace_id,label_id,match_mode,keywords,created_by,updated_by)
       VALUES($1,$2,'contains','{x}',$3,$3)`,
      [otherWorkspaceId, refund, admin.id],
    ),
    { code: "23503" },
  );
  const ruleId = (await ruleRow("exact", `ARRAY['${"x".repeat(100)}']`)).rows[0].id;
  const event = (version: number, actor: string | null, ruleRef: string | null) =>
    pool.query(
      `INSERT INTO instagram_inbox_label_events(workspace_id,connection_id,recipient_id,version,added,removed,actor_id,rule_id)
       VALUES($1,$2,'456',$3,'{}',ARRAY[$4::uuid],$5,$6)`,
      [workspaceId, connectionId, version, refund, actor, ruleRef],
    );
  // Exactly one of the member and the rule.
  await assert.rejects(event(2, null, null), { code: "23514" });
  await assert.rejects(event(2, agent.id, ruleId), { code: "23514" });
  await event(2, null, ruleId);

  // The move check of an accepted invite: a workspace that holds only a rule is not empty. The label is skipped
  // (replica mode skips foreign key checks), so that the rule is all the workspace holds.
  const invited = await body<{ link: string }>(
    await request(outsider, "POST", "/api/workspace/invites", { email: stranger.email, role: "agent" }),
    201,
  );
  await body(await request(stranger, "POST", "/api/workspace"), 200);
  const strangerWorkspace = (
    await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1", [stranger.id])
  ).rows[0].workspace_id;
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role=replica");
    await client.query(
      `INSERT INTO instagram_inbox_label_rules(workspace_id,label_id,match_mode,keywords,created_by,updated_by)
       VALUES($1,gen_random_uuid(),'contains','{kept}',$2,$2)`,
      [strangerWorkspace, stranger.id],
    );
  } finally {
    await client.query("RESET session_replication_role");
    client.release();
  }
  const token = invited.link.split("#invite=")[1]!;
  assert.equal(
    await errorCode(await request(stranger, "POST", "/api/invites/accept", { token }), 409),
    "workspace_not_empty",
  );
});
