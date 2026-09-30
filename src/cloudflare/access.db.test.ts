import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";

test("Supabase roles cannot read product data; the server role has DML without DELETE or DDL", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const url = new URL(databaseUrl);
  if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
    throw new Error("Database tests require a local automations_test database");
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query(
      "DROP TABLE IF EXISTS data_deletion_records, flow_step_runs, flow_runs, flow_versions, flows, channel_consent_state, channel_consent_events, instagram_manual_reply_events, instagram_manual_replies, instagram_inbox_handoff_events, instagram_inbox_handoffs, instagram_inbox_messages, instagram_contact_automation, instagram_contact_field_values, instagram_contact_fields, instagram_contact_segments, instagram_contact_tags, instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
    );
    await client.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
    await client.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='auto_chatter_server') THEN CREATE ROLE auto_chatter_server; END IF; END $$",
    );
    await client.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END $$",
    );
    await client.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='automations_app') THEN CREATE ROLE automations_app; END IF; END $$",
    );
    const bootstrap = await readFile(new URL("../../deploy/init-app-user.sh", import.meta.url), "utf8");
    const grants = bootstrap.match(
      /GRANT SELECT, INSERT, UPDATE ON ALL TABLES[\s\S]*?GRANT USAGE, SELECT ON ALL SEQUENCES[^;]*;/,
    );
    assert.ok(grants, "Compose initializer must declare application table grants");
    await client.query(grants[0]);
    await client.query("SET ROLE automations_app");
    await assert.rejects(client.query("UPDATE data_deletion_records SET id=id"), { code: "42501" });
    await assert.rejects(
      client.query(
        "INSERT INTO data_deletion_records(workspace_id,connection_id,requested_by,deleted_counts,retained_counts) VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{}','{}')",
      ),
      { code: "42501" },
    );
    await assert.rejects(client.query("UPDATE instagram_manual_reply_events SET kind=kind"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM instagram_manual_reply_events"), { code: "42501" });
    await assert.rejects(client.query("UPDATE instagram_inbox_handoff_events SET active=active"), { code: "42501" });
    await assert.rejects(client.query("UPDATE channel_consent_events SET decision=decision"), { code: "42501" });
    await assert.rejects(client.query("UPDATE flow_versions SET version_no=version_no"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM flow_versions"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM flows"), { code: "42501" });
    await assert.rejects(client.query("UPDATE flow_step_runs SET outcome=outcome"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM flow_runs"), { code: "42501" });
    await client.query("RESET ROLE");
    await client.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role");
    await client.query("GRANT CREATE ON SCHEMA public TO PUBLIC");
    await client.query(await readFile(new URL("../../deploy/supabase-access.sql", import.meta.url), "utf8"));
    for (const role of ["anon", "authenticated", "service_role"]) {
      await client.query(`SET ROLE ${role}`);
      for (const table of [
        "data_deletion_records",
        "flows",
        "flow_versions",
        "flow_runs",
        "flow_step_runs",
        "channel_consent_state",
        "channel_consent_events",
        "workspaces",
        "instagram_manual_replies",
        "instagram_manual_reply_events",
        "instagram_inbox_handoffs",
        "instagram_inbox_handoff_events",
        "instagram_inbox_messages",
        "instagram_contact_automation",
        "instagram_contact_fields",
        "instagram_contact_field_values",
        "workspace_members",
        "instagram_oauth_states",
        "instagram_connections",
        "instagram_comment_rules",
        "instagram_comment_events",
        "private_reply_outbox",
        "instagram_follow_conversations",
        "instagram_message_receipts",
      ])
        await assert.rejects(client.query(`SELECT * FROM ${table}`), { code: "42501" });
      await assert.rejects(
        client.query("SELECT public.delete_connection_data(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'x')"),
        { code: "42501" },
      );
      await assert.rejects(
        client.query(
          "SELECT public.delete_person_data(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'comment_sender','1')",
        ),
        { code: "42501" },
      );
      await client.query("RESET ROLE");
    }
    await client.query("SET ROLE auto_chatter_server");
    await client.query("INSERT INTO workspaces VALUES ('11111111-1111-4111-8111-111111111111')");
    await client.query("UPDATE workspaces SET id=id");
    await client.query(
      "INSERT INTO workspace_members VALUES ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111')",
    );
    await client.query(
      "INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','access-account')",
    );
    await client.query(
      "INSERT INTO flows(id,workspace_id,name,draft) VALUES('77777777-7777-4777-8777-777777777777','11111111-1111-4111-8111-111111111111','access','{}')",
    );
    await client.query(
      `INSERT INTO flow_versions(id,flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,published_by)
       VALUES('88888888-8888-4888-8888-888888888888','77777777-7777-4777-8777-777777777777','11111111-1111-4111-8111-111111111111',1,0,'{}','44444444-4444-4444-8444-444444444444','1789','33333333-3333-4333-8333-333333333333')`,
    );
    await client.query(
      "UPDATE flows SET published_version_id='88888888-8888-4888-8888-888888888888' WHERE id='77777777-7777-4777-8777-777777777777'",
    );
    const consentEventId = (
      await client.query(
        `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
         VALUES('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','instagram','comment_sender','access-recipient','marketing','grant','explicit','access:test',now(),'33333333-3333-4333-8333-333333333333') RETURNING id`,
      )
    ).rows[0].id;
    await client.query(
      `INSERT INTO channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
       SELECT workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,id
       FROM channel_consent_events WHERE id=$1`,
      [consentEventId],
    );
    await assert.rejects(client.query("UPDATE channel_consent_state SET decision='revoke'"), { code: "23514" });
    const revokeEventId = (
      await client.query(
        `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
         VALUES('55555555-5555-4555-8555-555555555556','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','instagram','comment_sender','access-recipient','marketing','revoke','explicit','access:revoke',now(),'33333333-3333-4333-8333-333333333333') RETURNING id`,
      )
    ).rows[0].id;
    assert.equal(
      (
        await client.query(
          `UPDATE channel_consent_state state SET
             decision=event.decision,evidence_kind=event.evidence_kind,occurred_at=event.occurred_at,
             recorded_at=event.recorded_at,last_event_id=event.id
           FROM channel_consent_events event
           WHERE event.id=$1 AND state.identity_value='access-recipient'`,
          [revokeEventId],
        )
      ).rowCount,
      1,
    );
    assert.equal((await client.query("SELECT count(*) FROM channel_consent_state")).rows[0].count, "1");
    assert.equal((await client.query("SELECT count(*) FROM workspaces")).rows[0].count, "1");
    await assert.rejects(client.query("DELETE FROM workspaces"), { code: "42501" });
    await assert.rejects(client.query("UPDATE instagram_manual_reply_events SET kind=kind"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM instagram_manual_reply_events"), { code: "42501" });
    await assert.rejects(client.query("UPDATE instagram_inbox_handoff_events SET active=active"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM instagram_inbox_handoff_events"), { code: "42501" });
    await assert.rejects(client.query("UPDATE channel_consent_events SET decision=decision"), { code: "42501" });
    await assert.rejects(client.query("UPDATE flow_versions SET version_no=version_no"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM flow_versions"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM flows"), { code: "42501" });
    await assert.rejects(client.query("UPDATE flow_step_runs SET outcome=outcome"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM flow_runs"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM channel_consent_events"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM channel_consent_state"), { code: "42501" });
    await assert.rejects(client.query("CREATE TABLE public.forbidden(id int)"), { code: "42501" });
    const deletion = await client.query(
      "SELECT public.delete_connection_data('11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','access-account') AS result",
    );
    assert.equal(deletion.rows[0].result.deleted_counts.channel_consent_events, 1);
    assert.deepEqual(deletion.rows[0].result.retained_counts, {
      carried_comment_sender_revokes: 0,
      channel_consent_events: 1,
      channel_consent_state: 1,
    });
    assert.equal((await client.query("SELECT count(*) FROM data_deletion_records")).rows[0].count, "1");
    await assert.rejects(client.query("UPDATE data_deletion_records SET id=id"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM data_deletion_records"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM instagram_comment_events"), { code: "42501" });
    await assert.rejects(
      client.query(
        "SELECT public.delete_person_data('11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','comment_sender','1')",
      ),
      { code: "42501" },
    );
    await client.query("RESET ROLE");
    await client.query("SET ROLE automations_app");
    assert.equal((await client.query("SELECT count(*) FROM workspace_members")).rows[0].count, "1");
    await client.query(
      "INSERT INTO instagram_oauth_states(state_hash,user_id,workspace_id,expires_at) VALUES ('compose-test','33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',now()+interval '1 hour')",
    );
    assert.equal(
      (await client.query("UPDATE instagram_oauth_states SET consumed_at=now() WHERE state_hash='compose-test'"))
        .rowCount,
      1,
    );
    assert.equal((await client.query("SELECT count(*) FROM workspaces")).rows[0].count, "1");
    await client.query("INSERT INTO workspaces VALUES ('22222222-2222-4222-8222-222222222222')");
    await client.query("UPDATE workspaces SET id=id");
    const composeConsentEventId = (
      await client.query(
        `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
         VALUES('66666666-6666-4666-8666-666666666666','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','instagram','dm_recipient','compose-recipient','service_reply','revoke','explicit','compose:test',now(),'33333333-3333-4333-8333-333333333333') RETURNING id`,
      )
    ).rows[0].id;
    await client.query(
      `INSERT INTO channel_consent_state(workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,last_event_id)
       SELECT workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,occurred_at,recorded_at,id
       FROM channel_consent_events WHERE id=$1`,
      [composeConsentEventId],
    );
    await assert.rejects(
      client.query("UPDATE channel_consent_state SET decision='grant' WHERE identity_value='compose-recipient'"),
      { code: "23514" },
    );
    const composeGrantEventId = (
      await client.query(
        `INSERT INTO channel_consent_events(request_key,workspace_id,connection_id,channel,identity_kind,identity_value,purpose,decision,evidence_kind,evidence_reference,occurred_at,actor_id)
         VALUES('66666666-6666-4666-8666-666666666667','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','instagram','dm_recipient','compose-recipient','service_reply','grant','explicit','compose:grant',now(),'33333333-3333-4333-8333-333333333333') RETURNING id`,
      )
    ).rows[0].id;
    assert.equal(
      (
        await client.query(
          `UPDATE channel_consent_state state SET
             decision=event.decision,evidence_kind=event.evidence_kind,occurred_at=event.occurred_at,
             recorded_at=event.recorded_at,last_event_id=event.id
           FROM channel_consent_events event
           WHERE event.id=$1 AND state.identity_value='compose-recipient'`,
          [composeGrantEventId],
        )
      ).rowCount,
      1,
    );
    await assert.rejects(client.query("DELETE FROM workspaces"), { code: "42501" });
    await assert.rejects(client.query("UPDATE instagram_manual_reply_events SET kind=kind"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM instagram_manual_reply_events"), { code: "42501" });
    await assert.rejects(client.query("UPDATE instagram_inbox_handoff_events SET active=active"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM instagram_inbox_handoff_events"), { code: "42501" });
    await assert.rejects(client.query("UPDATE channel_consent_events SET decision=decision"), { code: "42501" });
    await assert.rejects(client.query("UPDATE flow_versions SET version_no=version_no"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM flow_versions"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM flows"), { code: "42501" });
    await assert.rejects(client.query("UPDATE flow_step_runs SET outcome=outcome"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM flow_runs"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM channel_consent_events"), { code: "42501" });
    await assert.rejects(client.query("DELETE FROM channel_consent_state"), { code: "42501" });
    await assert.rejects(
      client.query(
        "SELECT public.delete_person_data('11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','comment_sender','1')",
      ),
      { code: "42501" },
    );
    await assert.rejects(client.query("CREATE TABLE public.forbidden_compose(id int)"), { code: "42501" });
    for (const table of [
      "data_deletion_records",
      "flows",
      "flow_versions",
      "flow_runs",
      "flow_step_runs",
      "channel_consent_state",
      "channel_consent_events",
      "instagram_manual_replies",
      "instagram_manual_reply_events",
      "instagram_inbox_handoffs",
      "instagram_inbox_handoff_events",
      "instagram_inbox_messages",
      "instagram_contact_automation",
      "instagram_contact_fields",
      "instagram_contact_field_values",
      "workspace_members",
      "instagram_oauth_states",
      "instagram_follow_conversations",
      "instagram_message_receipts",
    ])
      await client.query(`SELECT * FROM ${table}`);
    await client.query("RESET ROLE");
    const protectedTables = await client.query(
      "SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relrowsecurity AND relname IN ('data_deletion_records','flows','flow_versions','flow_runs','flow_step_runs','channel_consent_state','channel_consent_events','instagram_manual_replies','instagram_manual_reply_events','instagram_inbox_handoffs','instagram_inbox_handoff_events','instagram_inbox_messages','instagram_contact_automation','instagram_contact_fields','instagram_contact_field_values','workspaces','workspace_members','instagram_oauth_states','instagram_follow_conversations','instagram_message_receipts','instagram_connections','instagram_comment_rules','instagram_comment_events','private_reply_outbox')",
    );
    assert.equal(protectedTables.rowCount, 24);
    // Exercise RLS independently of table grants: an accidental future grant must not expose rows.
    await client.query("GRANT SELECT ON workspaces TO anon");
    await client.query("SET ROLE anon");
    assert.equal((await client.query("SELECT count(*) FROM workspaces")).rows[0].count, "0");
    await client.query("RESET ROLE");
    await client.query("ALTER TABLE workspaces OWNER TO auto_chatter_server");
    await assert.rejects(
      client.query(await readFile(new URL("../../deploy/supabase-access.sql", import.meta.url), "utf8")),
      /must not own database objects/,
    );
  } finally {
    await client.query("RESET ROLE");
    client.release();
    await pool.end();
  }
});
