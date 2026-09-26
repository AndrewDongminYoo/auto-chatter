import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { Miniflare } from "miniflare";

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
      if (graphUrl.pathname.endsWith("/me")) return Response.json({ user_id: "123" });
      if (graphUrl.pathname.endsWith("/media-1")) return Response.json({ id: "media-1", owner: { id: "123" } });
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
      "DROP TABLE IF EXISTS instagram_message_receipts, instagram_follow_conversations, instagram_oauth_states, workspace_members, private_reply_outbox, instagram_comment_events, instagram_comment_rules, instagram_connections, workspaces CASCADE",
    );
    await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
    await pool.query("INSERT INTO workspaces VALUES ('11111111-1111-4111-8111-111111111111')");
    await pool.query(
      "INSERT INTO instagram_connections(id,workspace_id,account_id,active) VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','123',true)",
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
    const signature = `sha256=${createHmac("sha256", "runtime-secret").update(body).digest("hex")}`;
    assert.equal((await post(signature)).status, 200);
    assert.equal((await post(signature)).status, 200);
    const consumer = await runtime.getWorker();
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
    await consumer.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" });
    assert.equal(sends, 1);
  } finally {
    await runtime.dispose();
    await pool.end();
  }
});
