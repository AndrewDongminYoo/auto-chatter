import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { ConsentEventConflictError, recipientOptedOut, recordChannelConsentEvent } from "./channel-consent.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const workspaceId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";

async function waitForDatabaseLock(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await pool.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND state='active'",
      [applicationName],
    );
    if (activity.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${applicationName} did not wait for the connection lock`);
}

before(async () => {
  await pool.query(
    "DROP TABLE IF EXISTS workspace_invites, data_deletion_records, flow_step_runs, flow_runs, flow_versions, flows, channel_consent_state, channel_consent_events, instagram_manual_reply_events, instagram_manual_replies, instagram_inbox_handoff_events, instagram_inbox_handoffs, instagram_inbox_messages, instagram_contact_automation, instagram_contact_field_values, instagram_contact_fields, instagram_contact_segments, instagram_contact_tags, instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
  );
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [workspaceId]);
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active) VALUES($1,$2,'account-1',true)",
    [connectionId, workspaceId],
  );
});

after(async () => pool.end());

test("consent ledger preserves revoke and re-consent evidence", async () => {
  const grant = {
    requestKey: "44444444-4444-4444-8444-444444444444",
    workspaceId,
    connectionId,
    channel: "instagram" as const,
    identityKind: "comment_sender" as const,
    identityValue: "recipient-1",
    purpose: "marketing" as const,
    decision: "grant" as const,
    evidenceKind: "explicit" as const,
    evidenceReference: "form:settings",
    occurredAt: new Date("2026-09-29T01:00:00.000Z"),
    actorId,
  };

  const first = await recordChannelConsentEvent(pool, grant);
  assert.equal(first.applied, true);
  assert.equal(Reflect.get(first.states[0]!, "occurredAt")?.toISOString(), "2026-09-29T01:00:00.000Z");
  const replay = await recordChannelConsentEvent(pool, grant);
  assert.equal(replay.applied, false);
  assert.equal(replay.eventId, first.eventId);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM channel_consent_events")).rows[0].count, 1);

  await assert.rejects(
    recordChannelConsentEvent(pool, { ...grant, decision: "revoke" }),
    (error: unknown) => error instanceof ConsentEventConflictError && error.code === "consent_request_conflict",
  );

  const revoke = await recordChannelConsentEvent(pool, {
    ...grant,
    requestKey: "55555555-5555-4555-8555-555555555555",
    decision: "revoke",
    evidenceKind: "explicit",
    evidenceReference: "inbox:opt-out",
    occurredAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  assert.equal(revoke.applied, true);
  assert.equal(
    (
      await pool.query(
        "SELECT decision,last_event_id::text AS last_event_id FROM channel_consent_state WHERE workspace_id=$1 AND connection_id=$2 AND identity_value='recipient-1' AND purpose='marketing'",
        [workspaceId, connectionId],
      )
    ).rows[0].last_event_id,
    revoke.eventId,
  );

  const reconsent = await recordChannelConsentEvent(pool, {
    ...grant,
    requestKey: "66666666-6666-4666-8666-666666666666",
    evidenceReference: "form:reconsent",
    occurredAt: new Date("2019-01-01T00:00:00.000Z"),
  });
  assert.equal(reconsent.applied, true);
  const events = (
    await pool.query(
      "SELECT id::text,decision,evidence_kind,evidence_reference,occurred_at,recorded_at FROM channel_consent_events ORDER BY id",
    )
  ).rows;
  assert.deepEqual(
    events.map(({ id, decision, evidence_kind, evidence_reference }) => ({
      id,
      decision,
      evidence_kind,
      evidence_reference,
    })),
    [
      { id: first.eventId, decision: "grant", evidence_kind: "explicit", evidence_reference: "form:settings" },
      { id: revoke.eventId, decision: "revoke", evidence_kind: "explicit", evidence_reference: "inbox:opt-out" },
      { id: reconsent.eventId, decision: "grant", evidence_kind: "explicit", evidence_reference: "form:reconsent" },
    ],
  );
  assert.equal(events[1].occurred_at.toISOString(), "2020-01-01T00:00:00.000Z");
  assert.equal(events[2].occurred_at.toISOString(), "2019-01-01T00:00:00.000Z");
  assert.ok(events[0].recorded_at <= events[1].recorded_at && events[1].recorded_at <= events[2].recorded_at);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT decision,last_event_id::text AS last_event_id,evidence_kind,occurred_at FROM channel_consent_state WHERE workspace_id=$1 AND connection_id=$2 AND channel='instagram' AND identity_kind='comment_sender' AND identity_value='recipient-1' AND purpose='marketing'",
        [workspaceId, connectionId],
      )
    ).rows[0],
    {
      decision: "grant",
      last_event_id: reconsent.eventId,
      evidence_kind: "explicit",
      occurred_at: new Date("2019-01-01T00:00:00.000Z"),
    },
  );

  const allRevoke = await recordChannelConsentEvent(pool, {
    ...grant,
    requestKey: "77777777-7777-4777-8777-777777777777",
    purpose: "all",
    decision: "revoke",
    evidenceReference: "inbox:all-opt-out",
  });
  assert.equal(allRevoke.states.length, 2);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT purpose,decision,last_event_id::text AS last_event_id FROM channel_consent_state WHERE workspace_id=$1 AND connection_id=$2 AND identity_value='recipient-1' ORDER BY purpose",
        [workspaceId, connectionId],
      )
    ).rows,
    [
      { purpose: "marketing", decision: "revoke", last_event_id: allRevoke.eventId },
      { purpose: "service_reply", decision: "revoke", last_event_id: allRevoke.eventId },
    ],
  );
  const recipientScope = {
    workspaceId,
    connectionId,
    channel: "instagram",
    identityKind: "comment_sender",
    identityValue: "recipient-1",
  };
  assert.equal(await recipientOptedOut(pool, [recipientScope]), true);
  assert.equal(await recipientOptedOut(pool, [{ ...recipientScope, identityValue: "recipient-2" }]), false);
  assert.equal(await recipientOptedOut(pool, [{ ...recipientScope, identityKind: "dm_recipient" }]), false);
  assert.equal(
    await recipientOptedOut(pool, [{ ...recipientScope, connectionId: "99999999-9999-4999-8999-999999999999" }]),
    false,
  );
  assert.equal(
    await recipientOptedOut(pool, [{ ...recipientScope, workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]),
    false,
  );
  assert.equal(
    await recipientOptedOut(pool, [{ ...recipientScope, identityValue: "recipient-2" }, recipientScope]),
    true,
  );

  await assert.rejects(
    recordChannelConsentEvent(pool, {
      ...grant,
      requestKey: "99999999-9999-4999-8999-999999999999",
      purpose: "service_reply",
      evidenceKind: "import",
      evidenceReference: "import:old-list",
    }),
    (error: unknown) => (error as { code?: string }).code === "23514",
  );
  assert.equal(await recipientOptedOut(pool, [recipientScope]), true);

  const serviceReconsent = await recordChannelConsentEvent(pool, {
    ...grant,
    requestKey: "88888888-8888-4888-8888-888888888888",
    purpose: "service_reply",
    evidenceReference: "inbox:service-reconsent",
  });
  assert.deepEqual(
    (
      await pool.query(
        "SELECT purpose,decision,last_event_id::text AS last_event_id FROM channel_consent_state WHERE workspace_id=$1 AND connection_id=$2 AND identity_value='recipient-1' ORDER BY purpose",
        [workspaceId, connectionId],
      )
    ).rows,
    [
      { purpose: "marketing", decision: "revoke", last_event_id: allRevoke.eventId },
      { purpose: "service_reply", decision: "grant", last_event_id: serviceReconsent.eventId },
    ],
  );
  assert.equal(await recipientOptedOut(pool, [recipientScope]), false);
});

test("concurrent consent writes use server order instead of occurred_at", async () => {
  const blocker = await pool.connect();
  const firstUrl = new URL(databaseUrl);
  firstUrl.searchParams.set("application_name", "consent-order-first");
  const secondUrl = new URL(databaseUrl);
  secondUrl.searchParams.set("application_name", "consent-order-second");
  const firstPool = new Pool({ connectionString: firstUrl.toString(), max: 1 });
  const secondPool = new Pool({ connectionString: secondUrl.toString(), max: 1 });
  const common = {
    workspaceId,
    connectionId,
    channel: "instagram" as const,
    identityKind: "comment_sender" as const,
    identityValue: "concurrent-recipient",
    purpose: "marketing" as const,
    evidenceKind: "explicit" as const,
    actorId,
  };
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM instagram_connections WHERE id=$1 FOR UPDATE", [connectionId]);
    const firstWrite = recordChannelConsentEvent(firstPool, {
      ...common,
      requestKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      decision: "grant",
      evidenceReference: "concurrent:first",
      occurredAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    await waitForDatabaseLock("consent-order-first");
    const secondWrite = recordChannelConsentEvent(secondPool, {
      ...common,
      requestKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      decision: "revoke",
      evidenceReference: "concurrent:second",
      occurredAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await waitForDatabaseLock("consent-order-second");
    await blocker.query("COMMIT");

    const [first, second] = await Promise.all([firstWrite, secondWrite]);
    assert.notEqual(first.eventId, second.eventId);
    const events = await pool.query(
      "SELECT id::text,request_key::text,decision,occurred_at FROM channel_consent_events ORDER BY channel_consent_events.id",
    );
    assert.deepEqual(
      events.rows
        .map((row) => ({
          request_key: row.request_key,
          decision: row.decision,
          occurred_at: row.occurred_at.toISOString(),
        }))
        .sort((left, right) => left.request_key.localeCompare(right.request_key)),
      [
        {
          request_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          decision: "grant",
          occurred_at: "2030-01-01T00:00:00.000Z",
        },
        {
          request_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
          decision: "revoke",
          occurred_at: "2020-01-01T00:00:00.000Z",
        },
      ],
    );
    assert.equal(events.rows.find((row) => row.request_key.endsWith("1"))?.id, first.eventId);
    assert.equal(events.rows.find((row) => row.request_key.endsWith("2"))?.id, second.eventId);
    const newest = events.rows.at(-1);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT decision,last_event_id::text AS last_event_id,occurred_at FROM channel_consent_state WHERE identity_value='concurrent-recipient'",
        )
      ).rows[0],
      { decision: newest.decision, last_event_id: newest.id, occurred_at: newest.occurred_at },
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await firstPool.end();
    await secondPool.end();
  }
});

test("channel consent migration creates and preserves the ledger when replayed", async () => {
  const migration = await readFile(new URL("../../db/migrations/016_channel_consent.sql", import.meta.url), "utf8");
  await pool.query("DROP TABLE channel_consent_state, channel_consent_events");
  await pool.query(migration);
  const eventId = (
    await pool.query(
      `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
       VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',$1,$2,'instagram','dm_recipient','migration-recipient','service_reply','revoke','explicit','migration:test','2026-09-29T00:00:00Z',$3)
       RETURNING id`,
      [workspaceId, connectionId, actorId],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
     SELECT workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,id
     FROM channel_consent_events WHERE id=$1`,
    [eventId],
  );
  await assert.rejects(
    pool.query("UPDATE channel_consent_state SET decision='grant' WHERE identity_value='migration-recipient'"),
    { code: "23514" },
  );
  await pool.query(migration);
  const newerEventId = (
    await pool.query(
      `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
       VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',$1,$2,'instagram','dm_recipient','migration-recipient','service_reply','grant','explicit','migration:newer','2020-01-01T00:00:00Z',$3)
       RETURNING id`,
      [workspaceId, connectionId, actorId],
    )
  ).rows[0].id;
  assert.equal(
    (
      await pool.query(
        `UPDATE channel_consent_state state SET
           decision=event.decision,evidence_kind=event.evidence_kind,occurred_at=event.occurred_at,
           recorded_at=event.recorded_at,last_event_id=event.id
         FROM channel_consent_events event WHERE event.id=$1 AND state.identity_value='migration-recipient'`,
        [newerEventId],
      )
    ).rowCount,
    1,
  );
  await assert.rejects(
    pool.query(
      `UPDATE channel_consent_state state SET
         decision=event.decision,evidence_kind=event.evidence_kind,occurred_at=event.occurred_at,
         recorded_at=event.recorded_at,last_event_id=event.id
       FROM channel_consent_events event WHERE event.id=$1 AND state.identity_value='migration-recipient'`,
      [eventId],
    ),
    { code: "23514" },
  );

  assert.equal((await pool.query("SELECT count(*)::int AS count FROM channel_consent_events")).rows[0].count, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM channel_consent_state")).rows[0].count, 1);
  assert.equal(
    (await pool.query("SELECT to_regclass('channel_consent_events_scope_idx')::text AS index_name")).rows[0].index_name,
    "channel_consent_events_scope_idx",
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
       VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc',$1,$2,'instagram','dm_recipient','migration-recipient','all','grant','explicit','migration:invalid',now(),$3)`,
      [workspaceId, connectionId, actorId],
    ),
    { code: "23514" },
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
       VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',$1,$2,'instagram','dm_recipient','other-recipient','service_reply','revoke','explicit','migration:duplicate',now(),$3)`,
      [workspaceId, connectionId, actorId],
    ),
    { code: "23505" },
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
       VALUES($1,$2,'instagram','dm_recipient','missing-event','service_reply','revoke','explicit',now(),now(),9223372036854775806)`,
      [workspaceId, connectionId],
    ),
    { code: "23503" },
  );
});
