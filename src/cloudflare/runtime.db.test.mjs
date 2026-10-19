import { sealSecret } from "../app/secrets.ts";
import { signingKeyContext } from "../app/webhook-delivery.ts";
import { recordChannelConsentEvent } from "../instagram/channel-consent.ts";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
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
    durableObjects: Object.fromEntries(
      config.durable_objects.bindings.map(({ name, class_name }) => [name, { className: class_name, useSQLite: true }]),
    ),
    bindings: {
      SUPABASE_URL: "https://auth-test.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://auth-test.supabase.co");
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("apikey"), "sb_secret_test");
      // The caller's address reaches Supabase so its per-IP limits are not shared through the Worker (#164).
      assert.equal(request.headers.get("sb-forwarded-for"), "203.0.113.20");
      const body = await request.json();
      if (url.pathname === "/auth/v1/signup") {
        assert.deepEqual(body, { email: "owner@example.test", password: "example-password" });
        return Response.json({ user: { id: "synthetic-user" } });
      }
      if (url.pathname === "/auth/v1/recover") {
        assert.deepEqual(Object.keys(body), ["email"]);
        assert.match(body.email, /^[a-z0-9-]+@example\.test$/);
        return Response.json({});
      }
      assert.equal(url.pathname + url.search, "/auth/v1/token?grant_type=password");
      assert.deepEqual(body, { email: "owner@example.test", password: "example-password" });
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
        headers: { Origin: "https://app.test", "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.20" },
        body: JSON.stringify({ email: "owner@example.test", password: "example-password" }),
      });
      assert.equal(response.status, status, `${route}: ${await response.clone().text()}`);
      assert.deepEqual(await response.json(), body);
    }
    // Signup was the first mail request for this email; four recoveries reach the limit of five (#148).
    for (const [route, status, body] of [
      ...Array.from({ length: 4 }, () => ["recover", 200, { recovery_requested: true }]),
      ["resend-confirmation", 429, { error: "auth_rate_limited" }],
    ]) {
      const response = await runtime.dispatchFetch(`https://app.test/api/auth/${route}`, {
        method: "POST",
        headers: { Origin: "https://app.test", "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.20" },
        body: JSON.stringify({ email: "owner@example.test" }),
      });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), body);
    }
    // The client has spent 5 of its 10 hourly mail requests (the refused resend stopped at the email limit). Five
    // more for other addresses pass and the next is refused, whatever the address (#165).
    for (const [index, status] of [200, 200, 200, 200, 200, 429].entries()) {
      const response = await runtime.dispatchFetch("https://app.test/api/auth/recover", {
        method: "POST",
        headers: { Origin: "https://app.test", "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.20" },
        body: JSON.stringify({ email: `other-${index}@example.test` }),
      });
      assert.equal(response.status, status, `mail request ${index}`);
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
  const webhookRequests = [];
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
      // The flow webhook (#47): the DNS-over-HTTPS lookups, then the signed request to the endpoint.
      if (graphUrl.hostname === "cloudflare-dns.com")
        return Response.json(
          graphUrl.searchParams.get("type") === "A"
            ? { Status: 0, Answer: [{ name: "hooks.example.test", type: 1, data: "93.184.216.34" }] }
            : { Status: 0 },
        );
      if (graphUrl.hostname === "hooks.example.test") {
        webhookRequests.push({
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(request.headers),
          body: await request.text(),
        });
        return new Response("ok");
      }
      graphPaths.push(graphUrl.pathname);
      assert.equal(graphUrl.hostname, "graph.instagram.com");
      if (request.method === "POST") {
        sends++;
        return Response.json({ message_id: "runtime-message" });
      }
      if (graphUrl.pathname.endsWith("/me")) return Response.json({ id: "987", user_id: "123" });
      // The cron's webhook subscription check (#179).
      if (graphUrl.pathname.endsWith("/123/subscribed_apps"))
        return Response.json({
          data: [{ id: "app", subscribed_fields: ["comments", "messages", "messaging_postbacks"] }],
        });
      if (graphUrl.pathname.endsWith("/media-1")) return Response.json({ id: "media-1", owner: { id: "987" } });
      if (graphUrl.pathname.endsWith("/1789")) return Response.json({ id: "1789", owner: { id: "987" } });
      if (graphUrl.pathname.endsWith("/comment-flow"))
        return Response.json({
          id: "comment-flow",
          from: { id: "sender-flow" },
          media: { id: "1789" },
          timestamp: new Date().toISOString(),
        });
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
      "DROP TABLE IF EXISTS workspace_reply_templates, webhook_redelivery_events, webhook_deliveries, webhook_signing_keys, webhook_endpoints, scheduled_steps, workspace_invites, data_deletion_records, instagram_inbox_reminder_events, instagram_inbox_reminders, instagram_inbox_notes, instagram_inbox_label_events, instagram_inbox_label_rules, instagram_inbox_conversation_labels, instagram_inbox_labels, instagram_inbox_read_state, instagram_inbox_conversation_events, instagram_inbox_conversations, flow_step_runs, flow_runs, flow_versions, flows, channel_consent_state, channel_consent_events, instagram_manual_reply_events, instagram_manual_replies, instagram_inbox_handoff_events, instagram_inbox_handoffs, instagram_inbox_messages, instagram_unmatched_replies, instagram_contact_automation, instagram_contact_field_values, instagram_contact_fields, instagram_segment_snapshot_members, instagram_segment_snapshots, instagram_contact_segments, instagram_contact_tags, instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
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
    // An enabled flow answers through the same outbox, ingestion and final guard as a rule.
    const flowId = "77777777-7777-4777-8777-777777777777";
    const versionId = "88888888-8888-4888-8888-888888888888";
    const definition = {
      schema_version: 1,
      nodes: [
        {
          id: "start",
          type: "instagram_comment",
          config: {
            connection_id: connection,
            media_id: "1789",
            keywords: [],
            match_mode: "all",
            excluded_keywords: [],
          },
        },
        {
          id: "notify",
          type: "webhook",
          config: { endpoint_id: "99999999-9999-4999-8999-999999999999", field_ids: [], include_tags: true },
        },
        { id: "reply", type: "instagram_message", config: { text: "Flow workerd reply" } },
      ],
      edges: [
        { from: "start", port: "next", to: "notify" },
        { from: "notify", port: "next", to: "reply" },
      ],
    };
    const endpointId = "99999999-9999-4999-8999-999999999999";
    const signingKeyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
    const signingSecret = "whsec_workerd-test";
    await pool.query(
      "INSERT INTO webhook_endpoints(id,workspace_id,name,url) VALUES($1,'11111111-1111-4111-8111-111111111111','crm','https://hooks.example.test/in')",
      [endpointId],
    );
    await pool.query(
      "INSERT INTO webhook_signing_keys(id,workspace_id,endpoint_id,slot,secret_encrypted) VALUES($1,'11111111-1111-4111-8111-111111111111',$2,1,$3)",
      [
        signingKeyId,
        endpointId,
        sealSecret(
          signingSecret,
          Buffer.alloc(32, 1).toString("base64"),
          signingKeyContext("11111111-1111-4111-8111-111111111111", endpointId, signingKeyId),
        ),
      ],
    );
    await pool.query(
      "INSERT INTO flows(id,workspace_id,name,draft) VALUES($1,'11111111-1111-4111-8111-111111111111','Flow',$2)",
      [flowId, definition],
    );
    await pool.query(
      `INSERT INTO flow_versions(id,flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,published_by)
       VALUES($1,$2,'11111111-1111-4111-8111-111111111111',1,0,$3,$4,'1789',$5)`,
      [versionId, flowId, definition, connection, operator.id],
    );
    await pool.query("UPDATE flows SET published_version_id=$2,enabled=true WHERE id=$1", [flowId, versionId]);
    const flowBody = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "123",
          field: "comments",
          value: { id: "comment-flow", text: "anything", from: { id: "sender-flow" }, media: { id: "1789" } },
        },
      ],
    });
    assert.equal(
      (
        await runtime.dispatchFetch("https://example.test/webhooks/instagram", {
          method: "POST",
          body: flowBody,
          headers: {
            "x-hub-signature-256": `sha256=${createHmac("sha256", "runtime-secret").update(flowBody).digest("hex")}`,
          },
        })
      ).status,
      200,
    );
    await consumer.queue("auto-chatter-replies", [
      { id: "flow", timestamp: new Date(), body: { connectionId: connection }, attempts: 1 },
    ]);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (await pool.query("SELECT status FROM private_reply_outbox WHERE flow_run_id IS NOT NULL")).rows[0]?.status ===
        "sent"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(
      (
        await pool.query(
          `SELECT reply.status,reply.private_reply_text,run.status AS run_status,
             (SELECT count(*)::int FROM flow_step_runs step WHERE step.run_id=run.id) AS steps
           FROM private_reply_outbox reply JOIN flow_runs run ON run.id=reply.flow_run_id`,
        )
      ).rows,
      [{ status: "sent", private_reply_text: "Flow workerd reply", run_status: "delivering", steps: 3 }],
      JSON.stringify(graphPaths),
    );
    assert.equal(sends, 3);
    // Ingestion queued the webhook delivery under the restricted server role; only the cron sends it.
    assert.deepEqual((await pool.query("SELECT status,node_id FROM webhook_deliveries")).rows, [
      { status: "pending", node_id: "notify" },
    ]);
    assert.deepEqual(webhookRequests, []);
    // The restricted server role removes an expired OAuth state through the cleanup function and keeps a live one.
    await pool.query(
      "INSERT INTO instagram_oauth_states(state_hash,user_id,workspace_id,expires_at) VALUES ('runtime-expired','44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111',now()-interval '1 second'),('runtime-live','44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111',now()+interval '10 minutes')",
    );
    await consumer.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" });
    assert.deepEqual((await pool.query("SELECT state_hash FROM instagram_oauth_states")).rows, [
      { state_hash: "runtime-live" },
    ]);
    assert.equal(sends, 3);
    assert.equal(webhookRequests.length, 1);
    const [webhookRequest] = webhookRequests;
    const delivered = (
      await pool.query("SELECT event_id::text,status,payload,last_status_code FROM webhook_deliveries")
    ).rows[0];
    assert.deepEqual([delivered.status, delivered.payload, delivered.last_status_code], ["sent", null, 200]);
    assert.equal(webhookRequest.method, "POST");
    assert.equal(webhookRequest.url, "https://hooks.example.test/in");
    assert.equal(webhookRequest.headers["content-type"], "application/json");
    assert.equal(webhookRequest.headers["user-agent"], "auto-chatter-webhook/1");
    assert.equal(webhookRequest.headers["x-autochatter-event-id"], delivered.event_id);
    const [signedAt, signedKey, signedValue] = webhookRequest.headers["x-autochatter-signature"].split(",");
    assert.equal(signedKey, `k=${signingKeyId}`);
    assert.equal(
      signedValue,
      `v1=${createHmac("sha256", signingSecret)
        .update(`${signedAt.slice(2)}.${webhookRequest.body}`)
        .digest("hex")}`,
    );
    const sentPayload = JSON.parse(webhookRequest.body);
    assert.equal(sentPayload.event_id, delivered.event_id);
    assert.deepEqual([sentPayload.type, sentPayload.node_id, sentPayload.tags], ["flow.webhook", "notify", []]);
    for (const forbidden of ["sender-flow", "comment-flow", "anything", "media"])
      assert.ok(!webhookRequest.body.includes(forbidden), forbidden);
    // The restricted server role records every step, and the one-day fixture token raises its alert.
    assert.deepEqual(
      (
        await pool.query(
          "SELECT name FROM scheduled_steps WHERE last_success_at IS NOT NULL AND last_failure_at IS NULL ORDER BY name",
        )
      ).rows.map((row) => row.name),
      [
        "alerts",
        "cron",
        "early_reply_reconcile",
        "flow_resume",
        "kept_reply_cleanup",
        "oauth_state_cleanup",
        "stale_recovery",
        "subscription_check",
        "token_refresh",
        "wake",
        "webhook_delivery",
      ],
    );
    assert.deepEqual((await pool.query("SELECT name FROM scheduled_steps WHERE alert_active")).rows, [
      { name: "alert_token_expiring" },
    ]);
    // The restricted server role claims the connection and stores the subscription check's result.
    assert.deepEqual(
      (
        await pool.query(
          `SELECT subscription_check_attempted_at IS NOT NULL AS attempted,subscription_checked_at IS NOT NULL AS checked,
             subscription_missing_at,subscription_token_obtained_at=token_obtained_at AS same_token FROM instagram_connections`,
        )
      ).rows,
      [{ attempted: true, checked: true, subscription_missing_at: null, same_token: true }],
    );
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
    // A signed-in user with no workspace and no earlier writes, for the per-user write limit (#167).
    writer = "88888888-8888-4888-8888-888888888888",
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
    // The workspace export spends a per-user allowance from the limiter object (#166).
    durableObjects: Object.fromEntries(
      config.durable_objects.bindings.map(({ name, class_name }) => [name, { className: class_name, useSQLite: true }]),
    ),
    bindings: {
      SUPABASE_URL: "https://auth-test.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      SEND_ENABLED: "true",
    },
    outboundService: async (request) => {
      assert.equal(new URL(request.url).origin, "https://auth-test.supabase.co");
      return Response.json({
        id: { "Bearer foreign": foreign, "Bearer writer": writer }[request.headers.get("authorization")] ?? user,
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
    assert.equal(composerStatus.channel, "instagram");
    assert.deepEqual(composerStatus.capabilities.operations.manual_reply, { supported: true, content_types: ["text"] });
    assert.equal(composerStatus.capabilities.templates.approved_message, false);
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
    for (const content_type of ["attachment", "provider_template"]) {
      const unsupported = await runtime.dispatchFetch(manualPath, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...manualBody, content_type }),
      });
      assert.equal(unsupported.status, 422);
      assert.deepEqual(await unsupported.json(), { error: "channel_capability_unsupported" });
    }
    const invalidContent = await runtime.dispatchFetch(manualPath, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...manualBody, content_type: "text", attachment_url: "https://example.test/image" }),
    });
    assert.equal(invalidContent.status, 400);
    assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_replies")).rows[0].count, "0");
    assert.equal((await pool.query("SELECT count(*) FROM instagram_manual_reply_events")).rows[0].count, "0");
    const queued = await runtime.dispatchFetch(manualPath, {
      method: "POST",
      headers,
      body: JSON.stringify(manualBody),
    });
    assert.equal(queued.status, 202);
    const manual = await queued.json();
    assert.equal(manual.status, "pending");
    const explicitText = await runtime.dispatchFetch(manualPath, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...manualBody, content_type: "text" }),
    });
    assert.equal(explicitText.status, 202);
    assert.equal((await explicitText.json()).id, manual.id);
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
    const schedule = (
      await pool.query(
        `SELECT to_char((now()+interval '1 hour') AT TIME ZONE time_zone,'YYYY-MM-DD"T"HH24:MI') AS schedule_local,time_zone AS expected_time_zone FROM workspaces WHERE id=$1`,
        [workspace],
      )
    ).rows[0];
    const scheduledResponse = await runtime.dispatchFetch(manualPath, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...manualBody, ...schedule, request_key: randomUUID() }),
    });
    assert.equal(scheduledResponse.status, 202);
    const scheduled = await scheduledResponse.json();
    const editSchedule = {
      ...schedule,
      request_key: randomUUID(),
      expected_version: 1,
      text: "Revised runtime schedule",
    };
    assert.equal(
      (
        await runtime.dispatchFetch(`${manualPath}/${scheduled.id}/schedule`, {
          method: "PATCH",
          headers: { ...headers, origin: "https://evil.test" },
          body: JSON.stringify(editSchedule),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await runtime.dispatchFetch(`${manualPath}/${scheduled.id}/schedule`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(editSchedule),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await runtime.dispatchFetch(`${manualPath}/${scheduled.id}/schedule`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ ...editSchedule, request_key: randomUUID() }),
        })
      ).status,
      409,
    );
    const cancelSchedule = { request_key: randomUUID(), expected_version: 2 };
    assert.equal(
      (
        await runtime.dispatchFetch(`${manualPath}/${scheduled.id}/cancel`, {
          method: "POST",
          headers,
          body: JSON.stringify(cancelSchedule),
        })
      ).status,
      200,
    );
    const scheduledHistory = await (await runtime.dispatchFetch(manualPath, { headers })).json();
    assert.equal(scheduledHistory.replies.find((reply) => reply.id === scheduled.id).status, "cancelled");
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
    const listBody = await list.json();
    assert.equal(listBody.contacts[0].sender_id, "sender-1");
    assert.equal("total" in listBody, false);
    const preview = await runtime.dispatchFetch("https://app.test/api/contacts?preview=true", { headers });
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), {
      ...listBody,
      total: "1",
      evaluated: "1",
      excluded: { tag: "0", field: "0", both: "0" },
    });
    const excludedPreview = await runtime.dispatchFetch("https://app.test/api/contacts?preview=true&tag=missing", {
      headers,
    });
    assert.equal(excludedPreview.status, 200);
    assert.deepEqual(await excludedPreview.json(), {
      contacts: [],
      total: "0",
      evaluated: "1",
      excluded: { tag: "1", field: "0", both: "0" },
      after: null,
    });
    const foreignPreview = await runtime.dispatchFetch(
      `https://app.test/api/contacts?preview=true&connection_id=${connection}`,
      { headers: { ...headers, cookie: "__Host-ac-access=foreign" } },
    );
    assert.equal(foreignPreview.status, 200);
    assert.deepEqual(await foreignPreview.json(), {
      contacts: [],
      total: "0",
      evaluated: "0",
      excluded: { tag: "0", field: "0", both: "0" },
      after: null,
    });
    assert.equal(
      (await runtime.dispatchFetch("https://app.test/api/contacts?preview=true&after=", { headers })).status,
      400,
    );
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
    const orderedCreated = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Nonnegative score", field_id: field.id, field_operator: "gte", field_value: 0 }),
    });
    assert.equal(orderedCreated.status, 201);
    const orderedSegment = await orderedCreated.json();
    assert.equal(orderedSegment.field_value, 0);
    const orderedPath = `https://app.test/api/contacts?segment_id=${orderedSegment.id}`;
    const orderedSelected = await runtime.dispatchFetch(orderedPath, { headers });
    assert.equal(orderedSelected.status, 200);
    assert.equal((await orderedSelected.json()).contacts[0].sender_id, "sender-1");
    assert.equal(
      (
        await runtime.dispatchFetch(orderedPath, {
          headers: { ...headers, cookie: "__Host-ac-access=foreign" },
        })
      ).status,
      404,
    );
    await runtime.dispatchFetch(valuePath, { method: "PUT", headers, body: JSON.stringify({ value: -1 }) });
    assert.equal((await (await runtime.dispatchFetch(orderedPath, { headers })).json()).contacts.length, 0);
    await runtime.dispatchFetch(valuePath, { method: "PUT", headers, body: JSON.stringify({ value: 0 }) });
    const orderedArchived = await runtime.dispatchFetch(`https://app.test/api/contact-segments/${orderedSegment.id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(orderedArchived.status, 200);
    const combinedCreated = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Lead or nonnegative",
        connection_id: connection,
        tag: "lead",
        field_id: field.id,
        field_operator: "gte",
        field_value: 0,
        condition_operator: "or",
      }),
    });
    assert.equal(combinedCreated.status, 201);
    const combinedSegment = await combinedCreated.json();
    assert.equal(combinedSegment.condition_operator, "or");
    const combinedPath = `https://app.test/api/contacts?segment_id=${combinedSegment.id}`;
    assert.equal(
      (await (await runtime.dispatchFetch(combinedPath, { headers })).json()).contacts[0].sender_id,
      "sender-1",
    );
    assert.equal(
      (await runtime.dispatchFetch(combinedPath, { headers: { ...headers, cookie: "__Host-ac-access=foreign" } }))
        .status,
      404,
    );
    const tagPath = `https://app.test/api/connections/${connection}/contacts/sender-1`;
    assert.equal(
      (await runtime.dispatchFetch(tagPath, { method: "PATCH", headers, body: JSON.stringify({ tags: ["lead"] }) }))
        .status,
      200,
    );
    await runtime.dispatchFetch(valuePath, { method: "PUT", headers, body: JSON.stringify({ value: -1 }) });
    assert.equal((await (await runtime.dispatchFetch(combinedPath, { headers })).json()).contacts.length, 1);
    assert.equal(
      (await runtime.dispatchFetch(tagPath, { method: "PATCH", headers, body: JSON.stringify({ tags: [] }) })).status,
      200,
    );
    assert.equal((await (await runtime.dispatchFetch(combinedPath, { headers })).json()).contacts.length, 0);
    await runtime.dispatchFetch(valuePath, { method: "PUT", headers, body: JSON.stringify({ value: 0 }) });
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/contact-segments/${combinedSegment.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    assert.equal(
      (await runtime.dispatchFetch(tagPath, { method: "PATCH", headers, body: JSON.stringify({ tags: ["lead"] }) }))
        .status,
      200,
    );
    // The restricted server role can read every exported table, and the export omits token ciphertext.
    const templateRoot = "https://app.test/api/inbox/reply-templates";
    const templateCreated = await runtime.dispatchFetch(templateRoot, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Greeting", body: "Hello {{name}}" }),
    });
    assert.equal(templateCreated.status, 201);
    const template = await templateCreated.json();
    assert.deepEqual(template.variables, ["name"]);
    const templatePreview = await runtime.dispatchFetch(`${templateRoot}/${template.id}/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expected_version: 1, values: { name: "{{literal}}" } }),
    });
    assert.equal(templatePreview.status, 200);
    assert.deepEqual(await templatePreview.json(), { text: "Hello {{literal}}", version: 1 });
    assert.equal(
      (
        await runtime.dispatchFetch(`${templateRoot}/${template.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ name: "Greeting", body: "Hi {{name}}", expected_version: 1 }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await runtime.dispatchFetch(`${templateRoot}/${template.id}/preview`, {
          method: "POST",
          headers,
          body: JSON.stringify({ expected_version: 1, values: { name: "stale" } }),
        })
      ).status,
      409,
    );
    assert.equal(
      (await runtime.dispatchFetch(`${templateRoot}/${template.id}`, { method: "DELETE", headers })).status,
      200,
    );
    assert.deepEqual((await (await runtime.dispatchFetch(templateRoot, { headers })).json()).templates, []);
    const exported = await runtime.dispatchFetch("https://app.test/api/workspace/export", { headers });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition") ?? "", /^attachment; filename="auto-chatter-export-/);
    const exportBody = await exported.json();
    assert.equal(exportBody.tables.instagram_contact_field_values[0].value, 0);
    assert.equal(exportBody.tables.workspace_reply_templates[0].id, template.id);
    assert.ok(exportBody.tables.instagram_connections.length > 0);
    assert.ok(exportBody.tables.instagram_connections.every((row) => !("access_token_encrypted" in row)));
    const csvExport = await runtime.dispatchFetch("https://app.test/api/contacts/export.csv", { headers });
    assert.equal(csvExport.status, 200);
    assert.equal(csvExport.headers.get("content-type"), "text/csv; charset=utf-8");
    const csvBytes = Buffer.from(await csvExport.arrayBuffer());
    assert.equal(csvBytes.subarray(0, 3).toString("hex"), "efbbbf");
    assert.ok(csvBytes.toString().includes("'sender-1"));
    assert.doesNotMatch(csvBytes.toString(), /private comment|access_token_encrypted/);
    assert.equal(
      (await runtime.dispatchFetch("https://app.test/api/contacts/export.csv?tag=lead", { headers })).status,
      400,
    );
    const csvPreviewBody = JSON.stringify({ csv: csvBytes.toString() });
    const csvPreview = await runtime.dispatchFetch("https://app.test/api/contacts/import-preview", {
      method: "POST",
      headers,
      body: csvPreviewBody,
    });
    assert.equal(csvPreview.status, 200, await csvPreview.clone().text());
    const csvPreviewResult = await csvPreview.json();
    assert.ok(csvPreviewResult.counts.total > 0);
    assert.equal(csvPreviewResult.counts.unchanged, csvPreviewResult.counts.total);
    assert.equal(csvPreviewResult.rows[0].sender_id, "sender-1");
    // The restricted server role applies a checked file through INSERT/UPDATE only (#25); the file adds one tag.
    const csvEdited = csvBytes.toString().replace('"[""lead""]"', '"[""lead"",""vip""]"');
    assert.notEqual(csvEdited, csvBytes.toString(), "fixture must contain the exported lead tag cell");
    const csvEditedPreview = await (
      await runtime.dispatchFetch("https://app.test/api/contacts/import-preview", {
        method: "POST",
        headers,
        body: JSON.stringify({ csv: csvEdited }),
      })
    ).json();
    assert.equal(csvEditedPreview.counts.changed, 1);
    const csvApplyBody = JSON.stringify({
      csv: csvEdited,
      expected: csvEditedPreview.rows
        .filter((row) => row.status === "changed")
        .map((row) => ({ row: row.row, current_tags: row.current_tags })),
    });
    const csvApply = await runtime.dispatchFetch("https://app.test/api/contacts/import", {
      method: "POST",
      headers,
      body: csvApplyBody,
    });
    assert.equal(csvApply.status, 200, await csvApply.clone().text());
    const csvApplyResult = await csvApply.json();
    assert.equal(csvApplyResult.counts.applied, 1);
    assert.deepEqual(
      (await pool.query("SELECT tags FROM instagram_contact_tags WHERE sender_id='sender-1'")).rows.map(
        (row) => row.tags,
      ),
      [["lead", "vip"]],
    );
    const csvApplyAgain = await runtime.dispatchFetch("https://app.test/api/contacts/import", {
      method: "POST",
      headers,
      body: csvApplyBody,
    });
    assert.equal(csvApplyAgain.status, 200);
    assert.equal((await csvApplyAgain.json()).counts.applied, 0);
    // The exported file now proposes removing the added tag; applying it restores the fixture's tags.
    const csvRestorePreview = await (
      await runtime.dispatchFetch("https://app.test/api/contacts/import-preview", {
        method: "POST",
        headers,
        body: csvPreviewBody,
      })
    ).json();
    assert.equal(csvRestorePreview.counts.changed, 1);
    const csvRestore = await runtime.dispatchFetch("https://app.test/api/contacts/import", {
      method: "POST",
      headers,
      body: JSON.stringify({
        csv: csvBytes.toString(),
        expected: csvRestorePreview.rows
          .filter((row) => row.status === "changed")
          .map((row) => ({ row: row.row, current_tags: row.current_tags })),
      }),
    });
    assert.equal(csvRestore.status, 200, await csvRestore.clone().text());
    assert.deepEqual(
      (await pool.query("SELECT tags FROM instagram_contact_tags WHERE sender_id='sender-1'")).rows.map(
        (row) => row.tags,
      ),
      [["lead"]],
    );
    await pool.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [user]);
    assert.equal(
      (
        await runtime.dispatchFetch("https://app.test/api/contacts/import-preview", {
          method: "POST",
          headers,
          body: csvPreviewBody,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await runtime.dispatchFetch("https://app.test/api/contacts/import", {
          method: "POST",
          headers,
          body: csvApplyBody,
        })
      ).status,
      403,
    );
    const deniedCsv = await runtime.dispatchFetch("https://app.test/api/contacts/export.csv", { headers });
    assert.equal(deniedCsv.status, 403);
    assert.equal(deniedCsv.headers.has("content-disposition"), false);
    await pool.query("UPDATE workspace_members SET role='owner' WHERE user_id=$1", [user]);
    // The successful export and the role refusal spent two of this user's five CSV requests (#196).
    for (let i = 0; i < 3; i++) {
      const allowedCsv = await runtime.dispatchFetch("https://app.test/api/contacts/export.csv", { headers });
      assert.equal(allowedCsv.status, 200);
      await allowedCsv.arrayBuffer();
    }
    const limitedCsv = await runtime.dispatchFetch("https://app.test/api/contacts/export.csv", { headers });
    assert.equal(limitedCsv.status, 429);
    assert.deepEqual(await limitedCsv.json(), { error: "contact_export_rate_limited" });
    assert.equal(limitedCsv.headers.has("content-disposition"), false);
    const independentExport = await runtime.dispatchFetch("https://app.test/api/workspace/export", { headers });
    assert.equal(independentExport.status, 200);
    await independentExport.arrayBuffer();
    // The restricted server role stores a field set in the new columns, evaluates it and refuses to archive its fields.
    const planResponse = await runtime.dispatchFetch("https://app.test/api/contact-fields", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Plan", type: "text" }),
    });
    assert.equal(planResponse.status, 201);
    const plan = await planResponse.json();
    const planPath = `https://app.test/api/connections/${connection}/contacts/sender-1/fields/${plan.id}`;
    assert.equal(
      (await runtime.dispatchFetch(planPath, { method: "PUT", headers, body: JSON.stringify({ value: "pro" }) }))
        .status,
      200,
    );
    const fieldSet = [
      { field_id: field.id, field_operator: "gte", field_value: 0 },
      { field_id: plan.id, field_operator: "eq", field_value: "pro" },
    ].sort((x, y) => (x.field_id < y.field_id ? -1 : 1));
    const setCreated = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Scored pro",
        connection_id: connection,
        field_conditions: fieldSet,
        field_mode: "all",
      }),
    });
    assert.equal(setCreated.status, 201, await setCreated.clone().text());
    const setSegment = await setCreated.json();
    assert.deepEqual(setSegment, {
      id: setSegment.id,
      name: "Scored pro",
      connection_id: connection,
      tag: null,
      field_conditions: fieldSet,
      field_mode: "all",
      version: 1,
    });
    const setSelected = await (
      await runtime.dispatchFetch(`https://app.test/api/contacts?segment_id=${setSegment.id}`, { headers })
    ).json();
    assert.deepEqual(
      setSelected.contacts.map((contact) => contact.sender_id),
      ["sender-1"],
    );
    const setQuery = new URLSearchParams({
      preview: "true",
      connection_id: connection,
      field_conditions: JSON.stringify([
        { field_id: field.id, field_operator: "gte", field_value: 0 },
        { field_id: plan.id, field_operator: "eq", field_value: "free" },
      ]),
      field_mode: "all",
    });
    const noneMatch = await (
      await runtime.dispatchFetch(`https://app.test/api/contacts?${setQuery}`, { headers })
    ).json();
    assert.equal(noneMatch.total, "0");
    assert.equal(noneMatch.excluded.field, noneMatch.evaluated);
    // The restricted server role saves and evaluates a DM consent segment over the verified bridge: sender-1's
    // fresh sent reply to 456 above, and 456's stored DMs.
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM instagram_inbox_messages WHERE recipient_id='456'")).rows[0]
        .count > 0,
      true,
    );
    const dmCreated = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "DM no record",
        connection_id: connection,
        dm_consent_purpose: "marketing",
        dm_consent_state: "no_record",
      }),
    });
    assert.equal(dmCreated.status, 201, await dmCreated.clone().text());
    const dmSegment = await dmCreated.json();
    assert.equal(dmSegment.dm_consent_purpose, "marketing");
    assert.equal(dmSegment.dm_consent_state, "no_record");
    assert.deepEqual(
      (await (await runtime.dispatchFetch("https://app.test/api/contact-segments", { headers })).json()).segments.find(
        (segment) => segment.id === dmSegment.id,
      ),
      dmSegment,
    );
    const dmSelected = await (
      await runtime.dispatchFetch(`https://app.test/api/contacts?segment_id=${dmSegment.id}`, { headers })
    ).json();
    assert.deepEqual(
      dmSelected.contacts.map((contact) => contact.sender_id),
      ["sender-1"],
    );
    assert.equal(JSON.stringify(dmSelected).includes('"456"'), false);
    const dmGranted = await (
      await runtime.dispatchFetch(
        `https://app.test/api/contacts?${new URLSearchParams({
          preview: "true",
          connection_id: connection,
          dm_consent_purpose: "marketing",
          dm_consent_state: "granted",
        })}`,
        { headers },
      )
    ).json();
    assert.equal(dmGranted.total, "0");
    assert.equal(dmGranted.excluded.dm_consent, "1");
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/contact-segments/${dmSegment.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    // The restricted server role saves, edits and evaluates a DM activity segment: 456's latest stored DM is from
    // this run, so it lies inside the last day.
    const dmActivityCreated = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Recent DM", connection_id: connection, last_dm_days: 1 }),
    });
    assert.equal(dmActivityCreated.status, 201, await dmActivityCreated.clone().text());
    const dmActivitySegment = await dmActivityCreated.json();
    assert.equal(dmActivitySegment.last_dm_days, 1);
    assert.deepEqual(
      (await (await runtime.dispatchFetch("https://app.test/api/contact-segments", { headers })).json()).segments.find(
        (segment) => segment.id === dmActivitySegment.id,
      ),
      dmActivitySegment,
    );
    const dmActivityEdited = await runtime.dispatchFetch(
      `https://app.test/api/contact-segments/${dmActivitySegment.id}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          name: "Recent DM",
          connection_id: connection,
          last_dm_days: 7,
          expected_version: dmActivitySegment.version,
        }),
      },
    );
    assert.equal(dmActivityEdited.status, 200, await dmActivityEdited.clone().text());
    assert.equal((await dmActivityEdited.json()).last_dm_days, 7);
    const dmActivitySelected = await (
      await runtime.dispatchFetch(`https://app.test/api/contacts?segment_id=${dmActivitySegment.id}`, { headers })
    ).json();
    assert.deepEqual(
      dmActivitySelected.contacts.map((contact) => contact.sender_id),
      ["sender-1"],
    );
    assert.deepEqual(Object.keys(dmActivitySelected.dm_activity_window), ["from", "before"]);
    assert.equal(JSON.stringify(dmActivitySelected).includes('"456"'), false);
    const dmActivityPreview = await (
      await runtime.dispatchFetch(
        `https://app.test/api/contacts?${new URLSearchParams({ preview: "true", connection_id: connection, last_dm_days: "7" })}`,
        { headers },
      )
    ).json();
    assert.equal(dmActivityPreview.total, "1");
    assert.equal(dmActivityPreview.excluded.dm_activity, "0");
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/contact-segments/${dmActivitySegment.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    // The restricted server role saves, lists, edits and evaluates a condition tree segment: sender-1 has the lead
    // tag (restored by the CSV import above) and the plan "pro", and nobody has the tag "nobody".
    const conditionTree = {
      mode: "any",
      groups: [
        {
          mode: "all",
          conditions: [{ tag: "lead" }, { field_id: plan.id, field_operator: "eq", field_value: "pro" }],
        },
        { mode: "all", conditions: [{ tag: "nobody" }] },
      ],
    };
    const treeCreated = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Grouped", connection_id: connection, condition_tree: conditionTree }),
    });
    assert.equal(treeCreated.status, 201, await treeCreated.clone().text());
    const treeSegment = await treeCreated.json();
    assert.deepEqual(treeSegment, {
      id: treeSegment.id,
      name: "Grouped",
      connection_id: connection,
      condition_tree: conditionTree,
      version: 1,
    });
    assert.deepEqual(
      (await (await runtime.dispatchFetch("https://app.test/api/contact-segments", { headers })).json()).segments.find(
        (segment) => segment.id === treeSegment.id,
      ),
      treeSegment,
    );
    const treeEdited = await runtime.dispatchFetch(`https://app.test/api/contact-segments/${treeSegment.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: "Grouped",
        connection_id: connection,
        condition_tree: { ...conditionTree, groups: [...conditionTree.groups].reverse() },
        expected_version: treeSegment.version,
      }),
    });
    assert.equal(treeEdited.status, 200, await treeEdited.clone().text());
    assert.equal((await treeEdited.json()).version, 2);
    const treeSelected = await (
      await runtime.dispatchFetch(`https://app.test/api/contacts?segment_id=${treeSegment.id}`, { headers })
    ).json();
    assert.deepEqual(
      treeSelected.contacts.map((contact) => contact.sender_id),
      ["sender-1"],
    );
    const treePreview = await (
      await runtime.dispatchFetch(
        `https://app.test/api/contacts?${new URLSearchParams({
          preview: "true",
          connection_id: connection,
          condition_tree: JSON.stringify(conditionTree),
        })}`,
        { headers },
      )
    ).json();
    assert.equal(treePreview.total, "1");
    assert.deepEqual(Object.keys(treePreview.excluded), ["conditions"]);
    assert.equal(BigInt(treePreview.evaluated), 1n + BigInt(treePreview.excluded.conditions));
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/contact-segments/${treeSegment.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    const planInUse = await runtime.dispatchFetch(`https://app.test/api/contact-fields/${plan.id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(planInUse.status, 409);
    assert.deepEqual(await planInUse.json(), { error: "field_in_use" });
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/contact-segments/${setSegment.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    assert.equal(
      (await runtime.dispatchFetch(`https://app.test/api/contact-fields/${plan.id}`, { method: "DELETE", headers }))
        .status,
      200,
    );
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
    // The restricted server role edits a segment through the Worker; the next contact read uses the new definition.
    const segmentPath = `https://app.test/api/contact-segments/${segment.id}`;
    const edited = await runtime.dispatchFetch(segmentPath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ name: "Leads", connection_id: connection, tag: "vip", expected_version: 1 }),
    });
    assert.equal(edited.status, 200, await edited.clone().text());
    assert.deepEqual(await edited.json(), { ...segment, tag: "vip", version: 2 });
    assert.equal(
      (
        await (
          await runtime.dispatchFetch(`https://app.test/api/contacts?segment_id=${segment.id}`, { headers })
        ).json()
      ).contacts.length,
      0,
    );
    const staleEdit = await runtime.dispatchFetch(segmentPath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ name: "Leads", tag: "lead", expected_version: 1 }),
    });
    assert.equal(staleEdit.status, 409);
    assert.equal((await staleEdit.json()).segment.version, 2);
    await pool.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [user]);
    const agentEdit = await runtime.dispatchFetch(segmentPath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ name: "Leads", connection_id: connection, tag: "lead", expected_version: 2 }),
    });
    assert.equal(agentEdit.status, 403);
    assert.deepEqual(await agentEdit.json(), { error: "role_forbidden" });
    await pool.query("UPDATE workspace_members SET role='owner' WHERE user_id=$1", [user]);
    // The restricted server role stores a tag set in the new columns and evaluates it through the Worker.
    const multiCreated = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Lead or VIP", connection_id: connection, tags: ["VIP", " lead"], tag_mode: "any" }),
    });
    assert.equal(multiCreated.status, 201, await multiCreated.clone().text());
    const multiSegment = await multiCreated.json();
    assert.deepEqual(multiSegment, {
      id: multiSegment.id,
      name: "Lead or VIP",
      connection_id: connection,
      tags: ["lead", "vip"],
      tag_mode: "any",
      version: 1,
    });
    const multiSelected = await (
      await runtime.dispatchFetch(`https://app.test/api/contacts?segment_id=${multiSegment.id}`, { headers })
    ).json();
    assert.deepEqual(
      multiSelected.contacts.map((contact) => contact.sender_id),
      ["sender-1"],
    );
    const bothTags = await (
      await runtime.dispatchFetch(
        `https://app.test/api/contacts?preview=true&connection_id=${connection}&tag=lead&tag=vip&tag_mode=all`,
        { headers },
      )
    ).json();
    assert.equal(bothTags.total, "0");
    assert.equal(bothTags.excluded.tag, bothTags.evaluated);
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/contact-segments/${multiSegment.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    const restored = await runtime.dispatchFetch(segmentPath, {
      method: "PUT",
      headers,
      body: JSON.stringify({ name: "Leads", connection_id: connection, tag: "lead", expected_version: 2 }),
    });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).version, 3);
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
    const activity = { last_comment_from: "2026-10-10T00:00:00.000Z", last_comment_before: "2026-10-12T00:00:00.000Z" };
    await pool.query("UPDATE instagram_comment_events SET created_at=$2 WHERE connection_id=$1", [
      connection,
      activity.last_comment_from,
    ]);
    const activityCreated = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Activity", connection_id: connection, tag: "lead", ...activity }),
    });
    assert.equal(activityCreated.status, 201);
    const activitySegment = await activityCreated.json();
    assert.equal(activitySegment.last_comment_from, activity.last_comment_from);
    assert.equal(activitySegment.last_comment_before, activity.last_comment_before);
    const activityListed = await (
      await runtime.dispatchFetch("https://app.test/api/contact-segments", { headers })
    ).json();
    assert.deepEqual(
      activityListed.segments.find((s) => s.id === activitySegment.id),
      activitySegment,
    );
    const activityPath = `https://app.test/api/contacts?preview=true&segment_id=${activitySegment.id}`;
    const activityMatched = await (await runtime.dispatchFetch(activityPath, { headers })).json();
    assert.equal(activityMatched.total, "1");
    assert.deepEqual(activityMatched.excluded, { activity: "0", tag: "0", field: "0", both: "0" });
    await pool.query("UPDATE instagram_comment_events SET created_at=$2 WHERE connection_id=$1", [
      connection,
      activity.last_comment_before,
    ]);
    const activityExcluded = await (await runtime.dispatchFetch(activityPath, { headers })).json();
    assert.deepEqual(activityExcluded, {
      contacts: [],
      after: null,
      total: "0",
      evaluated: "1",
      excluded: { activity: "1", tag: "0", field: "0", both: "0" },
    });
    assert.equal(
      (await runtime.dispatchFetch(activityPath, { headers: { ...headers, cookie: "__Host-ac-access=foreign" } }))
        .status,
      404,
    );
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/contacts?last_comment_from=${activity.last_comment_from}`, {
          headers,
        })
      ).status,
      400,
    );
    const activityArchived = await runtime.dispatchFetch(
      `https://app.test/api/contact-segments/${activitySegment.id}`,
      { method: "DELETE", headers },
    );
    assert.equal(activityArchived.status, 200);
    assert.equal((await runtime.dispatchFetch(activityPath, { headers })).status, 404);
    await pool.query("UPDATE instagram_comment_events SET created_at=now()-interval '1 hour' WHERE connection_id=$1", [
      connection,
    ]);
    const relativeCreated = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Recent", connection_id: connection, last_comment_days: 7 }),
    });
    assert.equal(relativeCreated.status, 201);
    const relativeSegment = await relativeCreated.json();
    assert.equal(relativeSegment.last_comment_days, 7);
    const relativePath = `https://app.test/api/contacts?preview=true&segment_id=${relativeSegment.id}`;
    const recent = await (await runtime.dispatchFetch(relativePath, { headers })).json();
    assert.equal(recent.total, "1");
    assert.deepEqual(recent.excluded, { activity: "0", tag: "0", field: "0", both: "0" });
    assert.equal(Date.parse(recent.activity_window.before) - Date.parse(recent.activity_window.from), 7 * 86400000);
    assert.equal(
      (await runtime.dispatchFetch(relativePath, { headers: { ...headers, cookie: "__Host-ac-access=foreign" } }))
        .status,
      404,
    );
    await pool.query("UPDATE instagram_comment_events SET created_at=now()-interval '8 days' WHERE connection_id=$1", [
      connection,
    ]);
    const old = await (await runtime.dispatchFetch(relativePath, { headers })).json();
    assert.equal(old.total, "0");
    assert.deepEqual(old.excluded, { activity: "1", tag: "0", field: "0", both: "0" });
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/contact-segments/${relativeSegment.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    assert.equal((await runtime.dispatchFetch(relativePath, { headers })).status, 404);
    // The first instant of last month in the workspace time zone, computed by the same PostgreSQL conversion.
    await pool.query(
      `UPDATE instagram_comment_events e SET created_at=(date_trunc('month',now() AT TIME ZONE w.time_zone)-interval '1 month') AT TIME ZONE w.time_zone
       FROM workspaces w WHERE w.id=e.workspace_id AND e.connection_id=$1`,
      [connection],
    );
    const calendarCreated = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Last month", connection_id: connection, last_comment_period: "last_month" }),
    });
    assert.equal(calendarCreated.status, 201);
    const calendarSegment = await calendarCreated.json();
    assert.equal(calendarSegment.last_comment_period, "last_month");
    const calendarPath = `https://app.test/api/contacts?preview=true&segment_id=${calendarSegment.id}`;
    const lastMonth = await (await runtime.dispatchFetch(calendarPath, { headers })).json();
    assert.equal(lastMonth.total, "1");
    assert.deepEqual(lastMonth.excluded, { activity: "0", tag: "0", field: "0", both: "0" });
    const zone = (
      await pool.query(
        "SELECT time_zone FROM workspaces WHERE id=(SELECT workspace_id FROM instagram_connections WHERE id=$1)",
        [connection],
      )
    ).rows[0].time_zone;
    assert.equal(lastMonth.activity_window.time_zone, zone);
    const thisMonth = await (
      await runtime.dispatchFetch(
        `https://app.test/api/contacts?preview=true&connection_id=${connection}&last_comment_period=this_month`,
        { headers },
      )
    ).json();
    assert.equal(thisMonth.total, "0");
    assert.deepEqual(thisMonth.excluded, { activity: "1", tag: "0", field: "0", both: "0" });
    assert.equal(thisMonth.activity_window.from, lastMonth.activity_window.before);
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/contact-segments/${calendarSegment.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    const consentCreated = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Recorded consent",
        connection_id: connection,
        consent_purpose: "marketing",
        consent_state: "granted",
      }),
    });
    assert.equal(consentCreated.status, 201);
    const consentSegment = await consentCreated.json();
    assert.equal(consentSegment.consent_purpose, "marketing");
    assert.equal(consentSegment.consent_state, "granted");
    const consentListed = await (
      await runtime.dispatchFetch("https://app.test/api/contact-segments", { headers })
    ).json();
    assert.deepEqual(
      consentListed.segments.find((s) => s.id === consentSegment.id),
      consentSegment,
    );
    const consentPath = `https://app.test/api/contacts?preview=true&segment_id=${consentSegment.id}`;
    const consentMissing = await (await runtime.dispatchFetch(consentPath, { headers })).json();
    assert.equal(consentMissing.total, "0");
    assert.deepEqual(consentMissing.excluded, { consent: "1", tag: "0", field: "0", both: "0" });
    for (const decision of ["grant", "revoke"]) {
      await recordChannelConsentEvent(pool, {
        requestKey: randomUUID(),
        workspaceId: workspace,
        connectionId: connection,
        channel: "instagram",
        identityKind: "comment_sender",
        identityValue: "sender-1",
        purpose: "marketing",
        decision,
        evidenceKind: "explicit",
        evidenceReference: "runtime fixture",
        occurredAt: new Date("2026-10-10T00:00:00Z"),
        actorId: user,
      });
      const response = await runtime.dispatchFetch(consentPath, { headers });
      assert.equal(response.status, 200);
      const page = await response.json();
      assert.equal(page.total, decision === "grant" ? "1" : "0");
      assert.deepEqual(page.excluded, { consent: decision === "grant" ? "0" : "1", tag: "0", field: "0", both: "0" });
    }
    assert.equal(
      (await runtime.dispatchFetch(consentPath, { headers: { ...headers, cookie: "__Host-ac-access=foreign" } }))
        .status,
      404,
    );
    assert.equal(
      (await runtime.dispatchFetch("https://app.test/api/contacts?consent_purpose=marketing", { headers })).status,
      400,
    );
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/contact-segments/${consentSegment.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    assert.equal((await runtime.dispatchFetch(consentPath, { headers })).status, 404);
    const other = await runtime.dispatchFetch(`https://app.test/api/connections/${connection}/contacts/sender-1`, {
      method: "PATCH",
      headers: { ...headers, cookie: "__Host-ac-access=foreign" },
      body: JSON.stringify({ tags: ["foreign"] }),
    });
    assert.equal(other.status, 404);
    assert.deepEqual((await pool.query("SELECT tags FROM instagram_contact_tags")).rows[0].tags, ["lead"]);
    // The limiter object counts signed-in writes per user: 120 per minute, then 429 (#167). A user without a
    // workspace spends only that limit, and reads stay open.
    const writerHeaders = { ...headers, cookie: "__Host-ac-access=writer" };
    for (let index = 0; index < 121; index++) {
      const response = await runtime.dispatchFetch("https://app.test/api/no-such-route", {
        method: "POST",
        headers: writerHeaders,
        body: "{}",
      });
      assert.equal(response.status, index < 120 ? 404 : 429, `write ${index}`);
      if (index === 120) assert.deepEqual(await response.json(), { error: "rate_limited" });
      else await response.arrayBuffer();
    }
    assert.equal((await runtime.dispatchFetch("https://app.test/api/me", { headers: writerHeaders })).status, 200);
  } finally {
    await runtime.dispose();
    await pool.end();
  }
});

// A separate runtime gives this test its own CSV export allowance, so the contact API test above keeps its counts (#26).
test("workerd segment CSV export uses restricted server privileges and the saved segment", async () => {
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
    durableObjects: Object.fromEntries(
      config.durable_objects.bindings.map(({ name, class_name }) => [name, { className: class_name, useSQLite: true }]),
    ),
    bindings: {
      SUPABASE_URL: "https://auth-test.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      SEND_ENABLED: "false",
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
    await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id,active) VALUES($1,$2,'123',true)", [
      connection,
      workspace,
    ]);
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,'comment-1','media','sender-1','private comment'),($1,$2,'comment-2','media','sender-2','other comment')`,
      [workspace, connection],
    );
    await pool.query(
      "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'sender-1',ARRAY['lead'])",
      [workspace, connection],
    );
    await pool.query(await readFile(new URL("../../deploy/supabase-access.sql", import.meta.url), "utf8"));
    await pool.query("ALTER ROLE auto_chatter_server LOGIN PASSWORD 'runtime-test-only'");
    const headers = {
      cookie: "__Host-ac-access=owned",
      origin: "https://app.test",
      "content-type": "application/json",
    };
    const created = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "CSV export leads", tag: "lead" }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const segment = await created.json();
    const segmentPath = `https://app.test/api/contacts/export.csv?segment_id=${segment.id}`;
    // A malformed segment ID is refused before the allowance is spent.
    assert.equal(
      (await runtime.dispatchFetch("https://app.test/api/contacts/export.csv?segment_id=not-a-uuid", { headers }))
        .status,
      400,
    );
    const exported = await runtime.dispatchFetch(segmentPath, { headers });
    assert.equal(exported.status, 200, await exported.clone().text());
    assert.equal(exported.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.match(
      exported.headers.get("content-disposition") ?? "",
      new RegExp(`filename="auto-chatter-contacts-v1-segment-${segment.id}-\\d{4}-\\d{2}-\\d{2}\\.csv"`),
    );
    const rows = (await exported.text()).split("\r\n").slice(1, -1);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].includes("'sender-1"));
    assert.ok(rows[0].includes('""lead""'));
    assert.doesNotMatch(rows.join(""), /sender-2|private comment|CSV export leads/);
    assert.equal(
      (await runtime.dispatchFetch(segmentPath, { headers: { ...headers, cookie: "__Host-ac-access=foreign" } }))
        .status,
      404,
    );
    await pool.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [user]);
    const denied = await runtime.dispatchFetch(segmentPath, { headers });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "role_forbidden" });
    assert.equal(denied.headers.has("content-disposition"), false);
    await pool.query("UPDATE workspace_members SET role='owner' WHERE user_id=$1", [user]);
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/contact-segments/${segment.id}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    const archived = await runtime.dispatchFetch(segmentPath, { headers });
    assert.equal(archived.status, 404);
    assert.equal(archived.headers.has("content-disposition"), false);
  } finally {
    await runtime.dispose();
    await pool.end();
  }
});

test("workerd segment snapshots use restricted server privileges and refuse an agent", async () => {
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
    durableObjects: Object.fromEntries(
      config.durable_objects.bindings.map(({ name, class_name }) => [name, { className: class_name, useSQLite: true }]),
    ),
    bindings: {
      SUPABASE_URL: "https://auth-test.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      SEND_ENABLED: "false",
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
    await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id,active) VALUES($1,$2,'123',true)", [
      connection,
      workspace,
    ]);
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,'comment-1','media','sender-1','private comment'),($1,$2,'comment-2','media','sender-2','other comment')`,
      [workspace, connection],
    );
    await pool.query(
      "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'sender-1',ARRAY['lead'])",
      [workspace, connection],
    );
    await pool.query(await readFile(new URL("../../deploy/supabase-access.sql", import.meta.url), "utf8"));
    await pool.query("ALTER ROLE auto_chatter_server LOGIN PASSWORD 'runtime-test-only'");
    for (const table of ["instagram_segment_snapshots", "instagram_segment_snapshot_members"])
      assert.deepEqual(
        (
          await pool.query(
            `SELECT has_table_privilege('auto_chatter_server',$1,'SELECT') AS select,
               has_table_privilege('auto_chatter_server',$1,'INSERT') AS insert,
               has_table_privilege('auto_chatter_server',$1,'UPDATE') AS update,
               has_table_privilege('auto_chatter_server',$1,'DELETE') AS delete`,
            [table],
          )
        ).rows[0],
        { select: true, insert: true, update: false, delete: false },
        table,
      );
    const headers = {
      cookie: "__Host-ac-access=owned",
      origin: "https://app.test",
      "content-type": "application/json",
    };
    const created = await runtime.dispatchFetch("https://app.test/api/contact-segments", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Snapshot leads", tag: "lead" }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const segment = await created.json();
    const snapshotsPath = `https://app.test/api/contact-segments/${segment.id}/snapshots`;
    // The dashboard sends no body; an explicit {} is the same request and any key is refused.
    const frozen = await runtime.dispatchFetch(snapshotsPath, {
      method: "POST",
      headers: { cookie: headers.cookie, origin: headers.origin },
    });
    assert.equal(frozen.status, 201, await frozen.clone().text());
    const snapshot = await frozen.json();
    assert.equal(snapshot.member_count, 1);
    assert.equal(snapshot.counts.total, "1");
    assert.equal(snapshot.counts.evaluated, "2");
    const again = await runtime.dispatchFetch(snapshotsPath, { method: "POST", headers, body: "{}" });
    assert.equal(again.status, 201, await again.clone().text());
    const refused = await runtime.dispatchFetch(snapshotsPath, { method: "POST", headers, body: '{"send":true}' });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: "invalid_snapshot_request" });
    const listed = await (await runtime.dispatchFetch(snapshotsPath, { headers })).json();
    assert.deepEqual(
      listed.snapshots.map((item) => item.id),
      [(await again.json()).id, snapshot.id],
    );
    const detail = await (
      await runtime.dispatchFetch(`https://app.test/api/segment-snapshots/${snapshot.id}`, { headers })
    ).json();
    assert.deepEqual(detail.members, [{ connection_id: connection, sender_id: "sender-1" }]);
    assert.equal(detail.snapshot.stored_member_count, 1);
    const csv = await runtime.dispatchFetch(`https://app.test/api/segment-snapshots/${snapshot.id}/members.csv`, {
      headers,
    });
    assert.equal(csv.status, 200, await csv.clone().text());
    assert.equal(
      csv.headers.get("content-disposition"),
      `attachment; filename="auto-chatter-segment-snapshot-${snapshot.id}-${snapshot.as_of.slice(0, 10)}.csv"`,
    );
    const bytes = Buffer.from(await csv.arrayBuffer());
    assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
    const rows = bytes.toString().split("\r\n").slice(1, -1);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].includes(`"${connection}","'sender-1"`));
    assert.doesNotMatch(bytes.toString(), /sender-2|private comment|Snapshot leads/);
    await pool.query("UPDATE instagram_contact_tags SET tags='{}' WHERE workspace_id=$1 AND connection_id=$2", [
      workspace,
      connection,
    ]);
    await pool.query(
      "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,'sender-2',ARRAY['lead'])",
      [workspace, connection],
    );
    const comparisonPath = `https://app.test/api/segment-snapshots/${snapshot.id}/comparison`;
    const compared = await runtime.dispatchFetch(comparisonPath, { headers });
    assert.equal(compared.status, 200, await compared.clone().text());
    assert.deepEqual((await compared.json()).counts, {
      original: "1",
      baseline: "1",
      current: "1",
      added: "1",
      removed: "1",
      retained: "0",
    });
    assert.equal((await runtime.dispatchFetch(comparisonPath + "?after=x", { headers })).status, 400);
    // Freezing sends nothing.
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM private_reply_outbox")).rows[0].count, 0);
    const foreignHeaders = { ...headers, cookie: "__Host-ac-access=foreign" };
    assert.equal((await runtime.dispatchFetch(comparisonPath, { headers: foreignHeaders })).status, 404);
    assert.equal(
      (
        await runtime.dispatchFetch(`https://app.test/api/segment-snapshots/${snapshot.id}`, {
          headers: foreignHeaders,
        })
      ).status,
      404,
    );
    await pool.query("UPDATE workspace_members SET role='agent' WHERE user_id=$1", [user]);
    for (const [path, method] of [
      [snapshotsPath, "POST"],
      [snapshotsPath, "GET"],
      [`https://app.test/api/segment-snapshots/${snapshot.id}`, "GET"],
      [`https://app.test/api/segment-snapshots/${snapshot.id}/members.csv`, "GET"],
      [comparisonPath, "GET"],
    ]) {
      const denied = await runtime.dispatchFetch(path, { method, headers });
      assert.equal(denied.status, 403, path);
      assert.deepEqual(await denied.json(), { error: "role_forbidden" });
      assert.equal(denied.headers.has("content-disposition"), false);
    }
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM instagram_segment_snapshots")).rows[0].count, 2);
  } finally {
    await runtime.dispose();
    await pool.end();
  }
});
