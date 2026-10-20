// Local-only manual acceptance fixture: real dashboard, Worker and DB; synthetic auth only.
// Run against a fresh disposable cluster, never the DB used by a concurrent test run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { Pool } from "pg";

const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
if (
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
  databaseUrl.hostname !== "127.0.0.1" ||
  databaseUrl.pathname !== "/automations_test" ||
  databaseUrl.search ||
  databaseUrl.hash ||
  !databaseUrl.port
)
  throw new Error("Acceptance requires postgres://...@127.0.0.1:<port>/automations_test without query parameters");

const workspace = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
const connection = "33333333-3333-4333-8333-333333333333";
const foreignConnection = "44444444-4444-4444-8444-444444444444";
const users = {
  owner: { id: "55555555-5555-4555-8555-555555555555", workspace, role: "owner" },
  agent: { id: "66666666-6666-4666-8666-666666666666", workspace, role: "agent" },
  foreign: { id: "77777777-7777-4777-8777-777777777777", workspace: foreign, role: "owner" },
};
const pool = new Pool({ connectionString: databaseUrl.href });
let runtime;
try {
  const { rows } = await pool.query(
    // Namespace dependencies cover functions, types and other non-relation objects too.
    "SELECT 1 FROM pg_depend WHERE refclassid='pg_namespace'::regclass AND refobjid='public'::regnamespace LIMIT 1",
  );
  assert.equal(rows.length, 0, "Acceptance requires an empty public schema; use a fresh disposable cluster");
  // The access script changes cluster roles too; refuse an existing server role before applying it.
  assert.equal(
    (await pool.query("SELECT 1 FROM pg_roles WHERE rolname IN ('auto_chatter_server','automations_app')")).rowCount,
    0,
    "Acceptance requires a disposable cluster without application roles",
  );
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await pool.query("INSERT INTO workspaces(id,plan) VALUES($1,'advanced'),($2,'advanced')", [workspace, foreign]);
  for (const [name, user] of Object.entries(users)) {
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,email) VALUES($1,$2,$3,$4)", [
      user.workspace,
      user.id,
      user.role,
      `${name}@example.test`,
    ]);
  }
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,active) VALUES
      ($1,$3,'100','acceptance_shop',true),($2,$4,'200','foreign_shop',true)`,
    [connection, foreignConnection, workspace, foreign],
  );
  for (const [sender, tags] of [
    ["1001", ["vip"]],
    ["1002", ["vip", "prospect"]],
    ["1003", ["prospect"]],
    ...Array.from({ length: 55 }, (_, i) => [String(2000 + i), ["bulk"]]),
  ]) {
    await pool.query(
      `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
       VALUES($1,$2,$3,'synthetic-media',$3,'Synthetic acceptance comment')`,
      [workspace, connection, sender],
    );
    await pool.query(
      "INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,$4)",
      [workspace, connection, sender, tags],
    );
  }
  await pool.query(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     VALUES($1,$2,'foreign-comment','synthetic-media','1001','Foreign synthetic contact')`,
    [foreign, foreignConnection],
  );
  await pool.query(await readFile(new URL("../deploy/supabase-access.sql", import.meta.url), "utf8"));
  await pool.query("ALTER ROLE auto_chatter_server LOGIN PASSWORD 'acceptance-local-only'");
  const serverUrl = new URL(databaseUrl);
  serverUrl.username = "auto_chatter_server";
  serverUrl.password = "acceptance-local-only";
  const config = JSON.parse(await readFile(new URL("../wrangler.json", import.meta.url), "utf8"));
  runtime = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    https: true,
    modules: true,
    scriptPath: fileURLToPath(new URL("../.wrangler/build/index.js", import.meta.url)),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    assets: {
      directory: fileURLToPath(new URL("../public", import.meta.url)),
      routerConfig: { has_user_worker: true },
    },
    hyperdrives: { HYPERDRIVE: serverUrl.href },
    durableObjects: Object.fromEntries(
      config.durable_objects.bindings.map(({ name, class_name }) => [name, { className: class_name, useSQLite: true }]),
    ),
    bindings: {
      SUPABASE_URL: "https://auth-acceptance.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_synthetic",
      SEND_ENABLED: "false",
      INSTAGRAM_PUBLIC_CONNECT_ENABLED: "false",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://auth-acceptance.supabase.co", "Unexpected external request");
      if (request.method === "POST" && url.pathname === "/auth/v1/token") {
        const body = await request.json();
        const name =
          url.searchParams.get("grant_type") === "password"
            ? body.password === "acceptance-only" &&
              Object.keys(users).find((key) => body.email === `${key}@example.test`)
            : url.searchParams.get("grant_type") === "refresh_token" && body.refresh_token;
        if (!Object.hasOwn(users, name)) return Response.json({ error: "invalid_credentials" }, { status: 400 });
        return Response.json({ access_token: name, refresh_token: name, expires_in: 3600 });
      }
      const name = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!Object.hasOwn(users, name)) return Response.json({ error: "invalid_token" }, { status: 401 });
      if (request.method === "GET" && url.pathname === "/auth/v1/user")
        return Response.json({ id: users[name].id, email: `${name}@example.test`, email_confirmed_at: "2026-10-20" });
      if (request.method === "POST" && url.pathname === "/auth/v1/logout") return Response.json({});
      throw new Error("Unexpected synthetic auth request");
    },
  });
  const origin = await runtime.ready;
  assert.equal((await runtime.dispatchFetch(new URL("/app/", origin))).status, 200, "Dashboard assets must load");
  assert.equal(
    (await runtime.dispatchFetch(new URL("/api/me", origin))).status,
    401,
    "Unauthenticated API must reach the Worker, not the asset 404 fallback",
  );
  console.log(`Acceptance dashboard: ${new URL("/app/", origin)}`);
  console.log("Synthetic accounts: owner@example.test, agent@example.test, foreign@example.test");
  console.log("Synthetic password: acceptance-only. Sends and public connections are disabled.");
  console.log("Press Ctrl+C to stop. The disposable database is retained for inspection.");
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await runtime?.dispose();
  await pool.end();
}
