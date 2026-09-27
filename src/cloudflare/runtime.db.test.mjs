import { sealSecret } from "../app/secrets.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { Miniflare } from "miniflare";

test("static dashboard CSP admits validated Instagram thumbnail hosts and rejects other origins", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('not found', {status:404}); } }",
    compatibilityDate: "2026-07-30",
    assets: { directory: "public" },
  });
  try {
    const response = await runtime.dispatchFetch("https://app.test/app/");
    assert.equal(response.status, 200);
    const policy = response.headers.get("content-security-policy");
    assert.ok(policy, "static asset response must carry the production CSP");
    const images = policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .find((part) => part[0] === "img-src")
      .slice(1);
    const admits = (input) => {
      const url = new URL(input);
      return images.some((source) =>
        source === "'self'"
          ? url.origin === "https://app.test"
          : source.startsWith("https://*.") &&
            url.protocol === "https:" &&
            !url.port &&
            url.hostname.endsWith(source.slice(9)),
      );
    };
    assert.equal(admits("https://scontent.cdninstagram.com/post.jpg"), true);
    assert.equal(admits("https://scontent.xx.fbcdn.net/post.jpg"), true);
    assert.equal(admits("https://evil.test/post.jpg"), false);
    assert.equal(admits("http://scontent.cdninstagram.com/post.jpg"), false);
    assert.equal(admits("https://cdninstagram.com.evil.test/post.jpg"), false);
    assert.equal(policy.includes("script-src 'self'"), true);
    assert.equal(policy.includes("connect-src 'self'"), true);
  } finally {
    await runtime.dispose();
  }
});

test("workerd auth routes call the provider with the native fetch receiver", async () => {
  const config = JSON.parse(await readFile(new URL("../../wrangler.json", import.meta.url), "utf8"));
  const runtime = new Miniflare({
    modules: true,
    scriptPath: ".wrangler/build/index.js",
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: {
      SUPABASE_URL: "https://auth-test.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "synthetic-public-key",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://auth-test.supabase.co");
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("apikey"), "synthetic-public-key");
      assert.deepEqual(await request.json(), { email: "owner@example.test", password: "example-password" });
      if (url.pathname === "/auth/v1/signup") return Response.json({ user: { id: "synthetic-user" } });
      assert.equal(url.pathname + url.search, "/auth/v1/token?grant_type=password");
      return Response.json({ error_code: "invalid_credentials" }, { status: 400 });
    },
  });
  try {
    for (const [route, status, body] of [
      ["signup", 200, { confirmation_required: true }],
      ["login", 401, { error: "authentication_failed" }],
    ]) {
      const response = await runtime.dispatchFetch(`https://app.test/api/auth/${route}`, {
        method: "POST",
        headers: { Origin: "https://app.test", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "owner@example.test", password: "example-password" }),
      });
      assert.equal(response.status, status, `${route}: ${await response.clone().text()}`);
      assert.deepEqual(await response.json(), body);
    }
  } finally {
    await runtime.dispose();
  }
});

test("workerd verifies signed bytes, persists via Hyperdrive, and consumes duplicate notifications", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const url = new URL(databaseUrl);
  if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
    throw new Error("Database tests require a local automations_test database");
  const pool = new Pool({ connectionString: databaseUrl });
  const serverUrl = new URL(databaseUrl);
  serverUrl.username = "auto_chatter_server";
  serverUrl.password = "runtime-test-only";
  const config = JSON.parse(await readFile(new URL("../../wrangler.json", import.meta.url), "utf8"));
  let sends = 0;
  const graphPaths = [];
  const runtime = new Miniflare({
    modules: true,
    scriptPath: ".wrangler/build/index.js",
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    hyperdrives: { HYPERDRIVE: serverUrl.href },
    queueProducers: { REPLY_QUEUE: "auto-chatter-replies" },
    queueConsumers: { "auto-chatter-replies": { maxBatchSize: 1, maxBatchTimeout: 0 } },
    bindings: {
      SEND_ENABLED: "true",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      INSTAGRAM_APP_SECRET: "runtime-secret",
      INSTAGRAM_VERIFY_TOKEN: "runtime-verify",
      META_INSTAGRAM_CONNECTION_ID: "22222222-2222-4222-8222-222222222222",
      META_INSTAGRAM_ACCOUNT_ID: "123",
      META_GRAPH_VERSION: "v24.0",
      META_INSTAGRAM_ACCESS_TOKEN: "synthetic",
    },
    outboundService: async (request) => {
      const graphUrl = new URL(request.url);
      graphPaths.push(graphUrl.pathname);
      assert.equal(graphUrl.hostname, "graph.instagram.com");
      if (request.method === "POST") {
        sends++;
        return Response.json({ message_id: "runtime-message" });
      }
      if (graphUrl.pathname.endsWith("/me")) return Response.json({ id: "987", user_id: "123" });
      if (graphUrl.pathname.endsWith("/media-1")) return Response.json({ id: "media-1", owner: { id: "987" } });
      return Response.json({
        id: "comment-1",
        from: { id: "sender-1" },
        media: { id: "media-1" },
        timestamp: new Date().toISOString(),
      });
    },
  });
  try {
    await pool.query(
      "DROP TABLE IF EXISTS instagram_manual_reply_events, instagram_manual_replies, instagram_inbox_handoff_events, instagram_inbox_handoffs, instagram_inbox_messages, instagram_contact_automation, instagram_contact_field_values, instagram_contact_fields, instagram_contact_segments, instagram_contact_tags, instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
    );
    await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
    await pool.query("INSERT INTO workspaces VALUES ('11111111-1111-4111-8111-111111111111')");
    await pool.query(
      "INSERT INTO instagram_connections(id,workspace_id,account_id,active) VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','123',true)",
    );
    await pool.query(
      "UPDATE instagram_connections SET send_enabled=true,token_expires_at=now()+interval '1 day',access_token_encrypted=$1",
      [sealSecret("synthetic", Buffer.alloc(32, 1).toString("base64"), "11111111-1111-4111-8111-111111111111:123")],
    );
    await pool.query(
      "INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled) VALUES ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','media-1','hello','reply',true)",
    );
    await pool.query(await readFile(new URL("../../deploy/supabase-access.sql", import.meta.url), "utf8"));
    await pool.query("ALTER ROLE auto_chatter_server LOGIN PASSWORD 'runtime-test-only'");
    await runtime.ready;
    const challenge = await runtime.dispatchFetch(
      "https://example.test/webhooks/instagram?hub.mode=subscribe&hub.verify_token=runtime-verify&hub.challenge=verified",
    );
    assert.equal(challenge.status, 200);
    assert.equal(await challenge.text(), "verified");
    await pool.query("UPDATE instagram_connections SET inbox_enabled=true,inbox_enabled_at=now()-interval '1 minute'");
    const dmBody = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "123",
          messaging: [
            {
              sender: { id: "456" },
              recipient: { id: "123" },
              timestamp: Date.now(),
              message: { mid: "runtime-inbox", text: "private runtime inbox" },
            },
          ],
        },
      ],
    });
    const dmSignature = `sha256=${createHmac("sha256", "runtime-secret").update(dmBody).digest("hex")}`;
    for (let replay = 0; replay < 2; replay++)
      assert.equal(
        (
          await runtime.dispatchFetch("https://example.test/webhooks/instagram", {
            method: "POST",
            body: dmBody,
            headers: { "x-hub-signature-256": dmSignature },
          })
        ).status,
        200,
      );
    assert.equal((await pool.query("SELECT count(*) FROM instagram_inbox_messages")).rows[0].count, "1");
    await pool.query("UPDATE instagram_connections SET inbox_enabled=false");
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "123",
          field: "comments",
          value: {
            id: "comment-1",
            text: "hello",
            from: { id: "sender-1" },
            media: { id: "media-1" },
          },
        },
      ],
    });
    const post = (signature) =>
      runtime.dispatchFetch("https://example.test/webhooks/instagram", {
        method: "POST",
        body,
        headers: { "x-hub-signature-256": signature },
      });
    assert.equal((await post(`sha256=${"0".repeat(64)}`)).status, 403);
    assert.equal((await pool.query("SELECT count(*) FROM private_reply_outbox")).rows[0].count, "0");
    await pool.query(
      "INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused) VALUES('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','sender-1',true)",
    );
    const signature = `sha256=${createHmac("sha256", "runtime-secret").update(body).digest("hex")}`;
    assert.equal((await post(signature)).status, 200);
    assert.equal((await post(signature)).status, 200);
    const consumer = await runtime.getWorker();
    await consumer.queue("auto-chatter-replies", [
      {
        id: "paused",
        timestamp: new Date(),
        body: { connectionId: "22222222-2222-4222-8222-222222222222" },
        attempts: 1,
      },
    ]);
    assert.equal(sends, 0);
    assert.deepEqual(graphPaths, []);
    assert.equal((await pool.query("SELECT status FROM private_reply_outbox")).rows[0].status, "pending");
    await pool.query("UPDATE instagram_contact_automation SET paused=false");
    await consumer.queue("auto-chatter-replies", [
      {
        id: "duplicate",
        timestamp: new Date(),
        body: { connectionId: "22222222-2222-4222-8222-222222222222" },
        attempts: 1,
      },
    ]);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await pool.query("SELECT status FROM private_reply_outbox")).rows[0]?.status === "sent") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(
      (await pool.query("SELECT status, provider_message_id FROM private_reply_outbox")).rows,
      [{ status: "sent", provider_message_id: "runtime-message" }],
      JSON.stringify(graphPaths),
    );
    await pool.query(
      "UPDATE instagram_connections SET inbox_enabled=true; UPDATE private_reply_outbox SET recipient_id='456'",
    );
    const { saveInboxHandoff } = await import("../app/inbox-handoff.ts");
    const { queueManualReply } = await import("../app/manual-replies.ts");
    const operator = { id: "66666666-6666-4666-8666-666666666666", email: "operator@example.test" };
    await pool.query("INSERT INTO workspace_members VALUES($1,'11111111-1111-4111-8111-111111111111')", [operator.id]);
    const connection = "22222222-2222-4222-8222-222222222222";
    await saveInboxHandoff(pool, operator, connection, "456", new URLSearchParams(), {
      active: true,
      expected_version: 0,
    });
    await queueManualReply(
      pool,
      operator,
      connection,
      "456",
      new URLSearchParams(),
      {
        request_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        text: "Manual workerd reply",
        expected_handoff_version: 1,
      },
      true,
    );
    await consumer.queue("auto-chatter-replies", [
      { id: "manual", timestamp: new Date(), body: { connectionId: connection }, attempts: 1 },
    ]);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await pool.query("SELECT status FROM instagram_manual_replies")).rows[0]?.status === "sent") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual((await pool.query("SELECT status,provider_message_id FROM instagram_manual_replies")).rows, [
      { status: "sent", provider_message_id: "runtime-message" },
    ]);
    assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_reply_events")).rows[0].count, "3");
    assert.equal(sends, 2);
    await consumer.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" });
    assert.equal(sends, 2);
  } finally {
    await runtime.dispose();
    await pool.end();
  }
});

test("workerd contact API uses restricted server privileges and verified workspace ownership", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const url = new URL(databaseUrl);
  if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname))
    throw new Error("Database tests require a local automations_test database");
  const pool = new Pool({ connectionString: databaseUrl });
  const workspace = "11111111-1111-4111-8111-111111111111",
    user = "66666666-6666-4666-8666-666666666666",
    foreign = "77777777-7777-4777-8777-777777777777",
    connection = "22222222-2222-4222-8222-222222222222";
  const serverUrl = new URL(databaseUrl);
  serverUrl.username = "auto_chatter_server";
  serverUrl.password = "runtime-test-only";
  const config = JSON.parse(await readFile(new URL("../../wrangler.json", import.meta.url), "utf8"));
  const runtime = new Miniflare({
    modules: true,
    scriptPath: ".wrangler/build/index.js",
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    hyperdrives: { HYPERDRIVE: serverUrl.href },
    bindings: {
      SUPABASE_URL: "https://auth-test.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "synthetic-public-key",
      SEND_ENABLED: "true",
    },
    outboundService: async (request) => {
      assert.equal(new URL(request.url).origin, "https://auth-test.supabase.co");
      return Response.json({
        id: request.headers.get("authorization") === "Bearer foreign" ? foreign : user,
        email: "owner@example.test",
        email_confirmed_at: "2026-09-27",
      });
    },
  });
  try {
    await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
    await pool.query("TRUNCATE workspaces CASCADE");
    await pool.query("INSERT INTO workspaces VALUES($1),($2)", [workspace, foreign]);
    await pool.query("INSERT INTO workspace_members VALUES($1,$2),($3,$3)", [user, workspace, foreign]);
    await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id) VALUES($1,$2,'123')", [
      connection,
      workspace,
    ]);
    await pool.query(
      "INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text) VALUES($1,$2,'comment','media','sender-1','private comment')",
      [workspace, connection],
    );
    await pool.query(await readFile(new URL("../../deploy/supabase-access.sql", import.meta.url), "utf8"));
    await pool.query("ALTER ROLE auto_chatter_server LOGIN PASSWORD 'runtime-test-only'");
    assert.equal(
      (
        await pool.query(
          "SELECT has_table_privilege('auto_chatter_server','instagram_contact_tags','DELETE') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
    assert.equal(
      (await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='instagram_contact_tags'::regclass")).rows[0]
        .relrowsecurity,
      true,
    );
    const headers = {
      cookie: "__Host-ac-access=owned",
      origin: "https://app.test",
      "content-type": "application/json",
    };
    await pool.query("UPDATE instagram_connections SET active=true WHERE id=$1", [connection]);
    const inboxPath = `https://app.test/api/connections/${connection}/inbox`;
    assert.equal(
      (await runtime.dispatchFetch(inboxPath, { method: "PUT", headers, body: JSON.stringify({ enabled: true }) }))
        .status,
      200,
    );
    await pool.query(
      "INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at) VALUES($1,$2,'456','owned-dm','private body','text',now())",
      [workspace, connection],
    );
    const inboxPage = await runtime.dispatchFetch("https://app.test/api/inbox", { headers });
    assert.equal(inboxPage.status, 200);
    assert.equal((await inboxPage.json()).conversations[0].recipient_id, "456");
    const inboxContext = await runtime.dispatchFetch(`${inboxPath}/456/context`, { headers });
    assert.equal(inboxContext.status, 200);
    const context = await inboxContext.json();
    assert.equal(context.mapping_status, "unmapped");
    assert.equal(context.comment_sender_id, null);
    assert.equal(context.automation_paused, null);
    assert.equal(JSON.stringify(context).includes("private body"), false);
    assert.equal(
      (
        await runtime.dispatchFetch(`${inboxPath}/456/context`, {
          headers: { ...headers, cookie: "__Host-ac-access=foreign" },
        })
      ).status,
      404,
    );
    await pool.query(
      `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,private_reply_text,enabled)
      VALUES('33333333-3333-4333-8333-333333333333',$1,$2,'media','hello','fixture',true)`,
      [workspace, connection],
    );
    await pool.query(
      `INSERT INTO private_reply_outbox(workspace_id,connection_id,event_id,rule_id,comment_id,media_id,sender_id,status,private_reply_text,recipient_id,provider_message_id,sent_at)
      SELECT $1,$2,event.id,'33333333-3333-4333-8333-333333333333','comment','media','sender-1','sent','fixture','456','provider-fixture',connection.inbox_enabled_at
      FROM instagram_comment_events event JOIN instagram_connections connection ON connection.id=event.connection_id
      WHERE event.connection_id=$2 AND event.comment_id='comment'`,
      [workspace, connection],
    );
    const handoffPath = `${inboxPath}/456/handoff`;
    const startHandoff = await runtime.dispatchFetch(handoffPath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ active: true, expected_version: 0 }),
    });
    assert.equal(startHandoff.status, 200);
    assert.deepEqual(await startHandoff.json(), { active: true, version: 1 });
    assert.equal(
      (await (await runtime.dispatchFetch(`${inboxPath}/456/context`, { headers })).json()).automation_paused,
      true,
    );
    assert.equal(
      (await runtime.dispatchFetch(handoffPath, { headers: { ...headers, cookie: "__Host-ac-access=foreign" } }))
        .status,
      404,
    );
    await pool.query(
      "UPDATE instagram_connections SET send_enabled=true,access_token_encrypted='synthetic-encrypted',token_expires_at=now()+interval '1 day' WHERE id=$1",
      [connection],
    );
    const manualPath = `${inboxPath}/456/replies`;
    const replyStatus = await runtime.dispatchFetch(`${inboxPath}/456/reply-status`, { headers });
    assert.equal(replyStatus.status, 200);
    const composerStatus = await replyStatus.json();
    assert.equal(composerStatus.handoff_active, true);
    assert.equal(composerStatus.handoff_version, 1);
    assert.equal(composerStatus.failure_code, null);
    assert.equal(composerStatus.allowed, true);
    assert.equal(JSON.stringify(composerStatus).includes("synthetic-encrypted"), false);
    assert.equal(
      (
        await runtime.dispatchFetch(`${inboxPath}/456/reply-status`, {
          headers: { ...headers, cookie: "__Host-ac-access=foreign" },
        })
      ).status,
      404,
    );
    const manualBody = {
      request_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expected_handoff_version: 1,
      text: "Manual runtime reply",
    };
    const queued = await runtime.dispatchFetch(manualPath, {
      method: "POST",
      headers,
      body: JSON.stringify(manualBody),
    });
    assert.equal(queued.status, 202);
    const manual = await queued.json();
    assert.equal(manual.status, "pending");
    assert.equal(
      (
        await runtime.dispatchFetch(manualPath, {
          method: "POST",
          headers: { ...headers, cookie: "__Host-ac-access=foreign" },
          body: JSON.stringify(manualBody),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await runtime.dispatchFetch(manualPath, {
          method: "POST",
          headers: { ...headers, origin: "https://evil.test" },
          body: JSON.stringify(manualBody),
        })
      ).status,
      403,
    );
    const outbound = await (await runtime.dispatchFetch(manualPath, { headers })).json();
    assert.equal(outbound.replies[0].text, "Manual runtime reply");
    assert.equal(outbound.replies[0].events[0].kind, "queued");
    assert.equal(JSON.stringify(outbound).includes("synthetic-encrypted"), false);
    await pool.query(
      "UPDATE instagram_manual_replies SET status='unknown',failure_code='worker_interrupted' WHERE id=$1",
      [manual.id],
    );
    const resolution = await runtime.dispatchFetch(`${manualPath}/${manual.id}/resolution`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        request_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        decision: "no_retry",
        reason: "Reviewed without retry",
      }),
    });
    assert.equal(resolution.status, 200);
    assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_reply_events")).rows[0].count, "2");
    const endHandoff = await runtime.dispatchFetch(handoffPath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ active: false, expected_version: 1 }),
    });
    assert.equal(endHandoff.status, 200);
    assert.deepEqual(await endHandoff.json(), { active: false, version: 2 });
    assert.equal((await pool.query("SELECT count(*) FROM instagram_inbox_handoff_events")).rows[0].count, "2");
    const inboxHistory = await runtime.dispatchFetch(`${inboxPath}/456`, { headers });
    assert.equal((await inboxHistory.json()).messages[0].text, "private body");
    assert.equal(
      (await runtime.dispatchFetch(`${inboxPath}/456`, { headers: { ...headers, cookie: "__Host-ac-access=foreign" } }))
        .status,
      404,
    );
    assert.equal(
      (
        await runtime.dispatchFetch(inboxPath, {
          method: "PUT",
          headers: { ...headers, origin: "https://foreign.test" },
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT has_table_privilege('auto_chatter_server','instagram_inbox_messages','DELETE') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
    const list = await runtime.dispatchFetch("https://app.test/api/contacts", { headers });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).contacts[0].sender_id, "sender-1");
    const automationPath = `https://app.test/api/connections/${connection}/contacts/sender-1/automation`;
    const pause = await runtime.dispatchFetch(automationPath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(pause.status, 200);
    assert.deepEqual(await pause.json(), { automation_paused: true });
    const pausedList = await runtime.dispatchFetch("https://app.test/api/contacts", { headers });
    assert.equal((await pausedList.json()).contacts[0].automation_paused, true);
    const foreignPause = await runtime.dispatchFetch(automationPath, {
      method: "PUT",
      headers: { ...headers, cookie: "__Host-ac-access=foreign" },
      body: JSON.stringify({ paused: false }),
    });
    assert.equal(foreignPause.status, 404);
    const resume = await runtime.dispatchFetch(automationPath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ paused: false }),
    });
    assert.equal(resume.status, 200);
    assert.deepEqual(await resume.json(), { automation_paused: false });
    const saved = await runtime.dispatchFetch(`https://app.test/api/connections/${connection}/contacts/sender-1`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ tags: [" Lead "] }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { tags: ["lead"] });
    const filtered = await runtime.dispatchFetch("https://app.test/api/contacts?tag=lead", { headers });
    assert.equal((await filtered.json()).contacts.length, 1);
    for (const table of [
      "instagram_contact_automation",
      "instagram_contact_fields",
      "instagram_contact_field_values",
    ]) {
      const protectedTable = await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [table]);
      assert.equal(protectedTable.rows[0].relrowsecurity, true);
      const privileges = await pool.query("SELECT has_table_privilege('auto_chatter_server',$1,'DELETE') AS allowed", [
        table,
      ]);
      assert.equal(privileges.rows[0].allowed, false);
    }
    const fieldResponse = await runtime.dispatchFetch("https://app.test/api/contact-fields", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Score", type: "number" }),
    });
    assert.equal(fieldResponse.status, 201);
    const field = await fieldResponse.json();
    const fieldList = await runtime.dispatchFetch("https://app.test/api/contact-fields", { headers });
    assert.equal((await fieldList.json()).fields[0].id, field.id);
    const valuePath = `https://app.test/api/connections/${connection}/contacts/sender-1/fields/${field.id}`;
    const fieldSaved = await runtime.dispatchFetch(valuePath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ value: 0 }),
    });
    assert.equal(fieldSaved.status, 200);
    assert.deepEqual(await fieldSaved.json(), { value: 0 });
    const fieldFiltered = await runtime.dispatchFetch(
      `https://app.test/api/contacts?field_id=${field.id}&field_operator=eq&field_value=0`,
      { headers },
    );
    assert.equal((await fieldFiltered.json()).contacts[0].fields[field.id], 0);
    const foreignField = await runtime.dispatchFetch(valuePath, {
      method: "PUT",
      headers: { ...headers, cookie: "__Host-ac-access=foreign" },
      body: JSON.stringify({ value: 1 }),
    });
    assert.equal(foreignField.status, 404);
    const fieldArchive = await runtime.dispatchFetch(`https://app.test/api/contact-fields/${field.id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(fieldArchive.status, 200);
    const inactiveField = await runtime.dispatchFetch(valuePath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ value: 1 }),
    });
    assert.equal(inactiveField.status, 404);
    assert.equal(
      (await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='instagram_contact_segments'::regclass")).rows[0]
        .relrowsecurity,
      true,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT has_table_privilege('auto_chatter_server','instagram_contact_segments','DELETE') AS allowed",
        )
      ).rows[0].allowed,
      false,
    );
    const created = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Leads", connection_id: connection, tag: " Lead " }),
    });
    assert.equal(created.status, 201);
    const segment = await created.json();
    const segments = await runtime.dispatchFetch("https://app.test/api/contact-segments", { headers });
    assert.equal((await segments.json()).segments[0].id, segment.id);
    const selected = await runtime.dispatchFetch(`https://app.test/api/contacts?segment_id=${segment.id}`, { headers });
    assert.equal((await selected.json()).contacts[0].sender_id, "sender-1");
    const hidden = await runtime.dispatchFetch(`https://app.test/api/contacts?segment_id=${segment.id}`, {
      headers: { ...headers, cookie: "__Host-ac-access=foreign" },
    });
    assert.equal(hidden.status, 404);
    const foreignArchive = await runtime.dispatchFetch(`https://app.test/api/contact-segments/${segment.id}`, {
      method: "DELETE",
      headers: { ...headers, cookie: "__Host-ac-access=foreign" },
    });
    assert.equal(foreignArchive.status, 404);
    const archived = await runtime.dispatchFetch(`https://app.test/api/contact-segments/${segment.id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(archived.status, 200);
    const removed = await runtime.dispatchFetch(`https://app.test/api/contacts?segment_id=${segment.id}`, { headers });
    assert.equal(removed.status, 404);
    const other = await runtime.dispatchFetch(`https://app.test/api/connections/${connection}/contacts/sender-1`, {
      method: "PATCH",
      headers: { ...headers, cookie: "__Host-ac-access=foreign" },
      body: JSON.stringify({ tags: ["foreign"] }),
    });
    assert.equal(other.status, 404);
    assert.deepEqual((await pool.query("SELECT tags FROM instagram_contact_tags")).rows[0].tags, ["lead"]);
  } finally {
    await runtime.dispose();
    await pool.end();
  }
});
