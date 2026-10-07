import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { evaluateChannelConsent } from "../instagram/channel-consent.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const connectionId = "55555555-5555-4555-8555-555555555555";
const foreignConnectionId = "66666666-6666-4666-8666-666666666666";
const apiEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test" };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE channel_consent_state,channel_consent_events,workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2),($3,$4)", [
    workspaceId,
    userId,
    otherWorkspaceId,
    otherUserId,
  ]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted)
     VALUES($1,$2,'owned-account',true,'access-token-secret'),($3,$4,'foreign-account',true,'foreign-token-secret')`,
    [connectionId, workspaceId, foreignConnectionId, otherWorkspaceId],
  );
  await pool.query(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     VALUES($1,$2,'sensitive-comment','media-1','123456','webhook-body-secret')`,
    [workspaceId, connectionId],
  );
});

after(async () => pool.end());

function consentRequest(connection: string, body: unknown, actorId = userId) {
  return appApi(
    new Request(`https://app.test/api/connections/${connection}/channel-consent-events`, {
      method: "POST",
      headers: {
        origin: "https://app.test",
        cookie: "__Host-ac-access=test",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () =>
      Response.json({ id: actorId, email: "a@example.test", email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

test("owned consent API records idempotent revoke and scoped re-consent", async () => {
  const revokeBody = {
    request_key: "77777777-7777-4777-8777-777777777777",
    identity_kind: "comment_sender",
    identity_value: "123456",
    purpose: "all",
    decision: "revoke",
    evidence_kind: "explicit",
    evidence_reference: "evidence-reference-secret",
    occurred_at: "2026-09-29T02:03:04.000Z",
  };

  const first = await consentRequest(connectionId, revokeBody);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.deepEqual(firstBody, {
    event_id: firstBody.event_id,
    applied: true,
    states: [
      { purpose: "marketing", decision: "revoke", occurred_at: "2026-09-29T02:03:04.000Z" },
      { purpose: "service_reply", decision: "revoke", occurred_at: "2026-09-29T02:03:04.000Z" },
    ],
  });
  assert.match(firstBody.event_id, /^\d+$/);
  for (const secret of ["evidence-reference-secret", "webhook-body-secret", "access-token-secret", "INSERT INTO"])
    assert.equal(JSON.stringify(firstBody).includes(secret), false);

  const replay = await consentRequest(connectionId, revokeBody);
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.event_id, firstBody.event_id);
  assert.equal(replayBody.applied, false);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM channel_consent_events WHERE workspace_id=$1 AND request_key=$2",
        [workspaceId, revokeBody.request_key],
      )
    ).rows[0].count,
    1,
  );

  const conflict = await consentRequest(connectionId, {
    ...revokeBody,
    evidence_reference: "different-evidence-secret",
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "consent_request_conflict" });
  const whitespaceConflict = await consentRequest(connectionId, {
    ...revokeBody,
    evidence_reference: ` ${revokeBody.evidence_reference} `,
  });
  assert.equal(whitespaceConflict.status, 409);
  assert.deepEqual(await whitespaceConflict.json(), { error: "consent_request_conflict" });

  for (const [evidenceKind, requestKey] of [
    ["import", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"],
    ["comment", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"],
    ["inbound_dm", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3"],
  ]) {
    const nonExplicitGrant = await consentRequest(connectionId, {
      ...revokeBody,
      request_key: requestKey,
      purpose: "service_reply",
      decision: "grant",
      evidence_kind: evidenceKind,
    });
    assert.equal(nonExplicitGrant.status, 400);
    assert.deepEqual(await nonExplicitGrant.json(), { error: "invalid_consent_event" });
  }
  assert.deepEqual(
    (
      await pool.query(
        "SELECT purpose,decision,last_event_id::text AS last_event_id FROM channel_consent_state WHERE workspace_id=$1 AND connection_id=$2 AND identity_value='123456' ORDER BY purpose",
        [workspaceId, connectionId],
      )
    ).rows,
    [
      { purpose: "marketing", decision: "revoke", last_event_id: firstBody.event_id },
      { purpose: "service_reply", decision: "revoke", last_event_id: firstBody.event_id },
    ],
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM channel_consent_events WHERE workspace_id=$1", [workspaceId]))
      .rows[0].count,
    1,
  );

  const serviceGrant = await consentRequest(connectionId, {
    ...revokeBody,
    request_key: "88888888-8888-4888-8888-888888888888",
    purpose: "service_reply",
    decision: "grant",
    evidence_reference: "service-reconsent-secret",
    occurred_at: "2026-09-29T03:04:05.000Z",
  });
  assert.equal(serviceGrant.status, 201);
  assert.deepEqual(await serviceGrant.json(), {
    event_id: (await pool.query("SELECT max(id)::text AS id FROM channel_consent_events")).rows[0].id,
    applied: true,
    states: [{ purpose: "service_reply", decision: "grant", occurred_at: "2026-09-29T03:04:05.000Z" }],
  });
  assert.deepEqual(
    (
      await pool.query(
        "SELECT purpose,decision FROM channel_consent_state WHERE workspace_id=$1 AND connection_id=$2 AND identity_kind='comment_sender' AND identity_value='123456' ORDER BY purpose",
        [workspaceId, connectionId],
      )
    ).rows,
    [
      { purpose: "marketing", decision: "revoke" },
      { purpose: "service_reply", decision: "grant" },
    ],
  );

  const importGrant = await consentRequest(connectionId, {
    ...revokeBody,
    request_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    identity_value: "999999",
    purpose: "marketing",
    decision: "grant",
    evidence_kind: "import",
    evidence_reference: "legacy-import-secret",
  });
  assert.equal(importGrant.status, 201);
  const importGrantBody = await importGrant.json();
  assert.deepEqual(importGrantBody.states, [
    { purpose: "marketing", decision: "grant", occurred_at: "2026-09-29T02:03:04.000Z" },
  ]);
  assert.equal("allowed" in importGrantBody, false);
  assert.equal("eligible" in importGrantBody, false);
  const importedState = (
    await pool.query(
      `SELECT workspace_id::text,connection_id::text,channel,identity_kind,identity_value,purpose,decision,evidence_kind
       FROM channel_consent_state WHERE workspace_id=$1 AND connection_id=$2 AND identity_value='999999'`,
      [workspaceId, connectionId],
    )
  ).rows[0];
  assert.deepEqual(
    evaluateChannelConsent({
      scope: {
        workspaceId,
        connectionId,
        channel: "instagram",
        identityKind: "comment_sender",
        identityValue: "999999",
        purpose: "marketing",
      },
      state: {
        workspaceId: importedState.workspace_id,
        connectionId: importedState.connection_id,
        channel: importedState.channel,
        identityKind: importedState.identity_kind,
        identityValue: importedState.identity_value,
        purpose: importedState.purpose,
        decision: importedState.decision,
        evidenceKind: importedState.evidence_kind,
      },
    }),
    { eligible: false, reason: "marketing_consent_required" },
  );

  const countBeforeDenials = (
    await pool.query("SELECT count(*)::int AS count FROM channel_consent_events WHERE workspace_id=$1", [workspaceId])
  ).rows[0].count;
  const foreign = await consentRequest(foreignConnectionId, {
    ...revokeBody,
    request_key: "99999999-9999-4999-8999-999999999999",
  });
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), { error: "connection_not_found" });

  const invalidBodies = [
    { ...revokeBody, request_key: "not-a-uuid" },
    { ...revokeBody, identity_kind: "email" },
    { ...revokeBody, identity_value: "not-numeric" },
    { ...revokeBody, purpose: "broadcast" },
    { ...revokeBody, decision: "allow" },
    { ...revokeBody, evidence_kind: "provider_permission" },
    { ...revokeBody, evidence_reference: "x".repeat(501) },
    { ...revokeBody, occurred_at: "September 29, 2026" },
    { ...revokeBody, occurred_at: "2026-02-30T00:00:00.000Z" },
    { ...revokeBody, decision: "grant" },
    { ...revokeBody, channel: "instagram" },
  ];
  for (const invalidBody of invalidBodies) {
    const invalid = await consentRequest(connectionId, invalidBody);
    assert.equal(invalid.status, 400);
    const error = await invalid.json();
    assert.deepEqual(error, { error: "invalid_consent_event" });
    for (const secret of ["webhook-body-secret", "access-token-secret", "SELECT ", "INSERT INTO"])
      assert.equal(JSON.stringify(error).includes(secret), false);
  }
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM channel_consent_events WHERE workspace_id=$1", [workspaceId]))
      .rows[0].count,
    countBeforeDenials,
  );
});
