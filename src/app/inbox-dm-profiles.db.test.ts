import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";
import { refreshDmProfiles } from "./inbox-profiles.ts";
import { sealSecret } from "./secrets.ts";
import { EXPORTED_TABLES } from "./workspace-export.ts";

// The DM sender username from the Instagram User Profile API (#395 stage 2), fetched by the inbox list.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const owner = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const agent = { id: "33333333-3333-4333-8333-333333333333", email: "agent@example.test" };
const workspaceId = "66666666-6666-4666-8666-666666666666";
// A connection with a stored, unexpired token; one whose token expired; one managed by the environment (no token).
const connectionId = "88888888-8888-4888-8888-888888888888";
const expiredConnectionId = "99999999-9999-4999-8999-999999999999";
const environmentConnectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const token = "profile-access-token";
const baseEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_test", TOKEN_ENCRYPTION_KEY: encryptionKey, META_GRAPH_VERSION: "v26.0" };

type Actor = { id: string; email: string };
type Row = { connection_id: string; recipient_id: string; sender_username: string | null } & Record<string, unknown>;
type Call = { url: URL; init: RequestInit | undefined };

// Every Graph call, and the answer per recipient ID. Supabase requests answer the session user and are not counted.
let graphCalls: Call[] = [];
let otherCalls: Call[] = [];
let answer: (recipient: string) => Response | Promise<Response> = () => Response.json({ id: "0", username: "unused" });

function graphFetch(actor: Actor) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "graph.instagram.com") {
      graphCalls.push({ url, init });
      return answer(url.pathname.split("/").at(-1)!);
    }
    otherCalls.push({ url, init });
    return Response.json({ id: actor.id, email: actor.email, email_confirmed_at: "2026-09-25" });
  }) as typeof fetch;
}

function request(actor: Actor, path: string, env: Record<string, string> = baseEnv) {
  return appApi(
    new Request(`https://app.test${path}`, { method: "GET", headers: { origin: "https://app.test", cookie: "__Host-ac-access=test" } }),
    env,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    graphFetch(actor),
  );
}

async function list(actor: Actor = agent, env?: Record<string, string>): Promise<Record<string, string | null>> {
  const response = await request(actor, "/api/inbox", env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const rows = ((await response.json()) as { conversations: Row[] }).conversations;
  for (const row of rows) {
    assert.ok(!("profile_username" in row) && !("profile_due" in row) && !("link_username" in row), "helper columns stay out of the response");
  }
  return Object.fromEntries(rows.map((row) => [`${row.connection_id === connectionId ? "" : `${row.connection_id}:`}${row.recipient_id}`, row.sender_username]));
}

async function seed(recipient: string, connection = connectionId) {
  await pool.query(
    `INSERT INTO instagram_inbox_messages(workspace_id,connection_id,recipient_id,message_id,text,kind,message_at)
     VALUES($1,$2,$3,gen_random_uuid()::text,'hello','text',now()-interval '1 minute')`,
    [workspaceId, connection, recipient],
  );
}

async function profiles() {
  return (
    await pool.query<{ recipient_id: string; username: string | null; failure_code: string | null; fetched: boolean; days: number }>(
      `SELECT recipient_id,username,failure_code,fetched_at IS NOT NULL AS fetched,
         round(extract(epoch FROM next_fetch_at-now())/86400)::integer AS days
       FROM instagram_dm_profiles ORDER BY connection_id,recipient_id`,
    )
  ).rows;
}

const calledRecipients = () => graphCalls.map((call) => call.url.pathname.split("/").at(-1)).sort();

// Stores a confirmed identity link from a DM recipient to a commenter with a username (the stage 1 fallback).
async function linkedUsername(recipient: string, sender: string, username: string) {
  const event = (
    await pool.query(
      `INSERT INTO instagram_contact_identity_link_events(workspace_id,connection_id,recipient_id,sender_id,action,version,evidence_reply_id,request_key,actor_id)
       VALUES($1,$2,$3,$4,'confirm',1,1,gen_random_uuid(),$5) RETURNING id`,
      [workspaceId, connectionId, recipient, sender, owner.id],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO instagram_contact_identity_links(workspace_id,connection_id,recipient_id,sender_id,state,version,evidence_reply_id,last_event_id)
     VALUES($1,$2,$3,$4,'confirmed',1,1,$5)`,
    [workspaceId, connectionId, recipient, sender, event],
  );
  await pool.query(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,sender_username,comment_text)
     VALUES($1,$2,gen_random_uuid()::text,'media',$3,$4,'hi')`,
    [workspaceId, connectionId, sender, username],
  );
}

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  graphCalls = [];
  otherCalls = [];
  answer = (recipient) => Response.json({ id: recipient, username: `user_${recipient}` });
  await pool.query("TRUNCATE workspaces, workspace_deletion_records CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [workspaceId]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,email) VALUES($1,$2,'owner',$3),($1,$4,'agent',$5)", [workspaceId, owner.id, owner.email, agent.id, agent.email]);
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,username,active,inbox_enabled,inbox_enabled_at,access_token_encrypted,token_expires_at)
     VALUES($1,$4,'123','shop',true,true,now()-interval '1 day',$5,now()+interval '30 days'),
       ($2,$4,'124','studio',true,true,now()-interval '1 day',$6,now()-interval '1 minute'),
       ($3,$4,'125','managed',true,true,now()-interval '1 day',NULL,NULL)`,
    [connectionId, expiredConnectionId, environmentConnectionId, workspaceId, sealSecret(token, encryptionKey, `${workspaceId}:123`), sealSecret(token, encryptionKey, `${workspaceId}:124`)],
  );
});

after(async () => pool.end());

test("a fetched username is stored and shown, and fetched again only after 7 days", async () => {
  await seed("501");
  assert.deepEqual(await list(), { "501": "user_501" });
  assert.deepEqual(calledRecipients(), ["501"]);
  assert.deepEqual(await profiles(), [{ recipient_id: "501", username: "user_501", failure_code: null, fetched: true, days: 7 }]);
  // Within 7 days the stored username is shown without a call.
  answer = () => Response.json({ username: "renamed" });
  assert.deepEqual(await list(), { "501": "user_501" });
  assert.equal(graphCalls.length, 1);
  // Once next_fetch_at has passed, the next list load fetches again and shows the new answer.
  await pool.query("UPDATE instagram_dm_profiles SET next_fetch_at=now()-interval '1 second'");
  assert.deepEqual(await list(), { "501": "renamed" });
  assert.equal(graphCalls.length, 2);
});

test("a failure stores a fixed code, shows the confirmed-link username and is retried only after 1 day", async () => {
  for (const recipient of ["501", "502", "503", "504", "505"]) await seed(recipient);
  await linkedUsername("501", "701", "commenter.name");
  answer = (recipient) => {
    if (recipient === "501") return Response.json({ error: { code: 100, error_subcode: 33, message: "Unsupported get request" } }, { status: 400 });
    if (recipient === "502") return new Response("upstream", { status: 503 });
    if (recipient === "503") return Response.json({ id: recipient, username: "not a username!" });
    if (recipient === "504") return Response.json({ error: { code: 190, message: "Invalid OAuth access token" } }, { status: 400 });
    return Response.json({ error: { code: 4, is_transient: true } }, { status: 400 });
  };
  const logged: string[] = [];
  const warn = console.warn;
  console.warn = (...values: unknown[]) => void logged.push(values.join(" "));
  try {
    assert.deepEqual(await list(), { "501": "commenter.name", "502": null, "503": null, "504": null, "505": null });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(
    (await profiles()).map(({ recipient_id, username, failure_code, days }) => ({ recipient_id, username, failure_code, days })),
    [
      { recipient_id: "501", username: null, failure_code: "profile_unavailable", days: 1 },
      { recipient_id: "502", username: null, failure_code: "graph_error", days: 1 },
      { recipient_id: "503", username: null, failure_code: "invalid_profile", days: 1 },
      { recipient_id: "504", username: null, failure_code: "token_rejected", days: 1 },
      { recipient_id: "505", username: null, failure_code: "graph_error", days: 1 },
    ],
  );
  // The logs carry fixed codes and the connection ID only: no token, messaging ID, username or provider text.
  const profileLines = logged.filter((line) => line.includes('"inbox_profile_fetch"'));
  assert.equal(profileLines.length, 5);
  for (const line of profileLines) {
    assert.deepEqual(Object.keys(JSON.parse(line) as object).sort(), ["code", "connection_id", "event"]);
    for (const secret of [token, "50", "commenter", "Unsupported", "username", "OAuth"]) assert.ok(!line.includes(secret), line);
  }
  // Within 1 day no call is made.
  assert.equal(graphCalls.length, 5);
  assert.deepEqual(await list(), { "501": "commenter.name", "502": null, "503": null, "504": null, "505": null });
  assert.equal(graphCalls.length, 5);
});

test("a failed refresh keeps the username and fetched_at of the earlier success, and the next success clears the code", async () => {
  await seed("501");
  await linkedUsername("501", "701", "link.name");
  assert.deepEqual(await list(), { "501": "user_501" });
  const fetchedAt = async () => (await pool.query<{ fetched_at: string }>("SELECT fetched_at::text FROM instagram_dm_profiles")).rows[0]!.fetched_at;
  const firstFetch = await fetchedAt();
  // A transient failure on the 7-day refresh: the profile username stays shown, not the confirmed-link username.
  await pool.query("UPDATE instagram_dm_profiles SET next_fetch_at=now()-interval '1 second'");
  answer = () => new Response("upstream", { status: 503 });
  assert.deepEqual(await list(), { "501": "user_501" });
  assert.equal(graphCalls.length, 2);
  assert.deepEqual(await profiles(), [{ recipient_id: "501", username: "user_501", failure_code: "graph_error", fetched: true, days: 1 }]);
  assert.equal(await fetchedAt(), firstFetch);
  assert.deepEqual(await list(), { "501": "user_501" });
  assert.equal(graphCalls.length, 2);
  // The next success replaces the username and fetched_at and clears the failure code.
  await pool.query("UPDATE instagram_dm_profiles SET next_fetch_at=now()-interval '1 second'");
  answer = () => Response.json({ username: "renamed" });
  assert.deepEqual(await list(), { "501": "renamed" });
  assert.deepEqual(await profiles(), [{ recipient_id: "501", username: "renamed", failure_code: null, fetched: true, days: 7 }]);
  assert.notEqual(await fetchedAt(), firstFetch);
});

test("a claim after a deletion makes no call and does not recreate the deleted row", async () => {
  for (const recipient of ["501", "502"]) await seed(recipient);
  // Rows a list load read as due before the deletions committed.
  const stale = ["501", "502"].map((recipient) => ({ connection_id: connectionId, recipient_id: recipient, profile_due: true }));
  // Person deletion removed 501's messages: only 502 is claimed and fetched.
  await pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','501')", [workspaceId, connectionId, owner.id]);
  const results = await refreshDmProfiles(pool, workspaceId, stale, baseEnv, graphFetch(agent));
  assert.deepEqual(calledRecipients(), ["502"]);
  assert.deepEqual(
    results.map((row) => row.recipient_id),
    ["502"],
  );
  assert.deepEqual(
    (await profiles()).map((row) => row.recipient_id),
    ["502"],
  );
  // A disconnect clears the token (connection deletion requires that first): nothing is claimed or fetched.
  await pool.query("UPDATE instagram_dm_profiles SET next_fetch_at=now()-interval '1 second'");
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL,token_expires_at=NULL WHERE id=$1", [connectionId]);
  assert.deepEqual(await refreshDmProfiles(pool, workspaceId, stale, baseEnv, graphFetch(agent)), []);
  assert.equal(graphCalls.length, 1);
});

test("a late answer does not overwrite a row that a deletion removed and a later claim created again", async () => {
  await seed("501");
  const due = [{ connection_id: connectionId, recipient_id: "501", profile_due: true }];
  // The first request's call waits until released; the second request's call answers at once.
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const calling = new Promise<void>((resolve) => (started = resolve));
  answer = async () => {
    if (graphCalls.length === 1) {
      started();
      await held;
      return Response.json({ username: "older.answer" });
    }
    return Response.json({ username: "newer.answer" });
  };
  const slow = refreshDmProfiles(pool, workspaceId, due, baseEnv, graphFetch(agent));
  // If the first claim fails, the request ends without a call; fail instead of waiting.
  await Promise.race([calling, slow.then(() => assert.fail("the first request made no call"))]);
  // Person deletion removes the claimed row, a new DM arrives, and another list request claims and stores it.
  await pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','501')", [workspaceId, connectionId, owner.id]);
  assert.deepEqual(await profiles(), []);
  await seed("501");
  assert.deepEqual(
    (await refreshDmProfiles(pool, workspaceId, due, baseEnv, graphFetch(agent))).map((row) => row.username),
    ["newer.answer"],
  );
  release();
  // The first request's claim no longer matches, so its answer is dropped.
  assert.deepEqual(await slow, []);
  assert.equal(graphCalls.length, 2);
  assert.deepEqual(await profiles(), [{ recipient_id: "501", username: "newer.answer", failure_code: null, fetched: true, days: 7 }]);
});

test("an ID longer than the profile table allows is skipped and does not stop the other claims", async () => {
  const long = "1".repeat(41);
  for (const recipient of ["501", long, "502"]) await seed(recipient);
  assert.deepEqual(await list(), { "501": "user_501", [long]: null, "502": "user_502" });
  assert.deepEqual(calledRecipients(), ["501", "502"]);
  assert.deepEqual(
    (await profiles()).map((row) => row.recipient_id),
    ["501", "502"],
  );
  // Later loads skip the conversation too.
  await list();
  assert.equal(graphCalls.length, 2);
});

test("one list request makes at most 5 calls, and the rest are fetched by later loads", async () => {
  for (let recipient = 501; recipient <= 508; recipient++) await seed(String(recipient));
  await list();
  assert.equal(graphCalls.length, 5);
  await list();
  assert.equal(graphCalls.length, 8);
  assert.deepEqual(calledRecipients(), ["501", "502", "503", "504", "505", "506", "507", "508"]);
  const names = await list();
  assert.equal(graphCalls.length, 8);
  assert.ok(Object.values(names).every((name) => name?.startsWith("user_")));
});

test("two concurrent list loads call the API once per sender", async () => {
  for (const recipient of ["501", "502", "503"]) await seed(recipient);
  answer = async (recipient) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return Response.json({ username: `user_${recipient}` });
  };
  await Promise.all([list(), list(), list()]);
  assert.deepEqual(calledRecipients(), ["501", "502", "503"]);
  assert.deepEqual(await list(), { "501": "user_501", "502": "user_502", "503": "user_503" });
  // Two loads that both read the same conversations as due before either claimed: only the claim decides.
  graphCalls = [];
  await seed("504");
  const due = ["503", "504"].map((recipient) => ({ connection_id: connectionId, recipient_id: recipient, profile_due: true }));
  const results = await Promise.all([refreshDmProfiles(pool, workspaceId, due, baseEnv, graphFetch(agent)), refreshDmProfiles(pool, workspaceId, due, baseEnv, graphFetch(agent))]);
  assert.deepEqual(calledRecipients(), ["504"]);
  assert.deepEqual(
    results.flat().map((row) => row.recipient_id),
    ["504"],
  );
});

test("the claim writes its rows in key order, not list order, so concurrent claims do not deadlock", async () => {
  const recipients = ["501", "502", "503", "504", "505"];
  for (const recipient of recipients) await seed(recipient);
  await pool.query(
    `INSERT INTO instagram_dm_profiles(workspace_id,connection_id,recipient_id,next_fetch_at)
     SELECT $1,$2,r,now()-interval '1 second' FROM unnest($3::text[]) AS r`,
    [workspaceId, connectionId, recipients],
  );
  // Another transaction holds the first row in key order; the claim reads the list in reverse.
  const blocker = await pool.connect();
  const probe = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM instagram_dm_profiles WHERE recipient_id='501' FOR UPDATE");
    const due = [...recipients].reverse().map((recipient) => ({ connection_id: connectionId, recipient_id: recipient, profile_due: true }));
    const claim = refreshDmProfiles(pool, workspaceId, due, baseEnv, graphFetch(agent));
    const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    for (let attempt = 0; ; attempt++) {
      const waiting = await probe.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [blockerPid]);
      if (waiting.rowCount) break;
      assert.ok(attempt < 200, "the claim never waited on the held row");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The claim waits on 501 before it touches any other row, so the last row in key order is still free.
    await probe.query("BEGIN");
    await probe.query("SELECT 1 FROM instagram_dm_profiles WHERE recipient_id='505' FOR UPDATE NOWAIT");
    await probe.query("ROLLBACK");
    await blocker.query("COMMIT");
    assert.deepEqual((await claim).map((row) => row.recipient_id).sort(), recipients);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await probe.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    probe.release();
  }
  assert.deepEqual(calledRecipients(), recipients);
});

test("no call is made without a stored, unexpired, readable token or the configuration", async () => {
  await seed("501", expiredConnectionId);
  await seed("502", environmentConnectionId);
  assert.deepEqual(await list(), { [`${expiredConnectionId}:501`]: null, [`${environmentConnectionId}:502`]: null });
  // A token sealed for another account is skipped too.
  await seed("503");
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [connectionId, sealSecret(token, encryptionKey, `${workspaceId}:999`)]);
  await list();
  // A missing encryption key or Graph version never fails the list request.
  await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [connectionId, sealSecret(token, encryptionKey, `${workspaceId}:123`)]);
  const { TOKEN_ENCRYPTION_KEY: _key, ...withoutKey } = baseEnv;
  const { META_GRAPH_VERSION: _version, ...withoutVersion } = baseEnv;
  for (const env of [withoutKey, withoutVersion, { ...baseEnv, META_GRAPH_VERSION: "latest" }]) await list(agent, env);
  // An OAuth reconnect stores the new token on an inactive row until the webhook subscription succeeds.
  await pool.query("UPDATE instagram_connections SET active=false WHERE id=$1", [connectionId]);
  await list();
  assert.equal(graphCalls.length, 0);
  assert.deepEqual(await profiles(), []);
  await pool.query("UPDATE instagram_connections SET active=true WHERE id=$1", [connectionId]);
  // With everything in place the same conversation is fetched.
  await list();
  assert.deepEqual(calledRecipients(), ["503"]);
});

test("the displayed username prefers the profile, then the confirmed link, then null", async () => {
  for (const recipient of ["501", "502", "503", "504"]) await seed(recipient);
  await linkedUsername("501", "701", "link.one");
  await linkedUsername("502", "702", "link.two");
  // 501: a stored profile beats the link; 502: a failed profile falls back to the link; 503: a stored profile
  // without a link; 504: neither. No row is due, so the list makes no call and reads the stored rows.
  await pool.query(
    `INSERT INTO instagram_dm_profiles(workspace_id,connection_id,recipient_id,username,failure_code,fetched_at,next_fetch_at)
     VALUES($1,$2,'501','profile.one',NULL,now(),now()+interval '7 days'),($1,$2,'502',NULL,'profile_unavailable',now(),now()+interval '1 day'),
       ($1,$2,'503','profile.three',NULL,now(),now()+interval '7 days'),($1,$2,'504',NULL,'graph_error',now(),now()+interval '1 day')`,
    [workspaceId, connectionId],
  );
  assert.deepEqual(await list(), { "501": "profile.one", "502": "link.two", "503": "profile.three", "504": null });
  assert.equal(graphCalls.length, 0);
});

test("the token goes only to graph.instagram.com and only in the Authorization header", async () => {
  await seed("501");
  await list();
  assert.equal(graphCalls.length, 1);
  const [{ url, init }] = graphCalls as [Call];
  assert.equal(url.origin, "https://graph.instagram.com");
  assert.equal(url.pathname, "/v26.0/501");
  assert.deepEqual([...url.searchParams], [["fields", "username"]]);
  assert.ok(!url.href.includes(token));
  assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
  assert.equal(init?.redirect, "manual");
  assert.ok(init?.signal instanceof AbortSignal);
  for (const call of otherCalls) {
    assert.ok(!call.url.href.includes(token));
    assert.ok(![...new Headers(call.init?.headers).values()].some((value) => value.includes(token)));
  }
});

test("the deletion functions remove the profile rows and the export lists the table", async () => {
  for (const recipient of ["501", "502"]) await seed(recipient);
  await list();
  assert.equal((await profiles()).length, 2);
  const person = await pool.query("SELECT public.delete_person_data($1,$2,$3,'dm_recipient','501') AS result", [workspaceId, connectionId, owner.id]);
  assert.equal(person.rows[0].result.deleted_counts.instagram_dm_profiles, 1);
  assert.deepEqual(
    (await profiles()).map((row) => row.recipient_id),
    ["502"],
  );
  await pool.query("UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL,token_expires_at=NULL");
  const connection = await pool.query("SELECT public.delete_connection_data($1,$2,$3,'123') AS result", [workspaceId, connectionId, owner.id]);
  assert.equal(connection.rows[0].result.deleted_counts.instagram_dm_profiles, 1);
  assert.deepEqual(await profiles(), []);
  await pool.query("INSERT INTO instagram_dm_profiles(workspace_id,connection_id,recipient_id,username,fetched_at,next_fetch_at) VALUES($1,$2,'503','again',now(),now()+interval '7 days')", [workspaceId, expiredConnectionId]);
  const workspace = await pool.query("SELECT public.delete_workspace_data($1,$2) AS result", [workspaceId, owner.id]);
  assert.equal(workspace.rows[0].result.deleted_counts.instagram_dm_profiles, 1);
  assert.deepEqual(await profiles(), []);
  assert.deepEqual(EXPORTED_TABLES.instagram_dm_profiles, { scope: "workspace" });
});

test("migration 076 replays over stored rows, keeps the canonical deletion functions and runs in the runner", async () => {
  const definitions = async () => (await pool.query("SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('delete_person_data','delete_connection_data','delete_workspace_data') ORDER BY proname")).rows;
  const canonical = await definitions();
  for (const { definition } of canonical) assert.match(definition, /instagram_dm_profiles/);
  await seed("501");
  await list();
  const stored = await profiles();
  const sql = await readFile(new URL("../../db/migrations/076_instagram_dm_profiles.sql", import.meta.url), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  await pool.query(await readFile(new URL("../../db/migrations/077_active_contacts.sql", import.meta.url), "utf8"));
  await pool.query(await readFile(new URL("../../db/migrations/078_active_contact_deletion_counts.sql", import.meta.url), "utf8"));
  assert.deepEqual(await definitions(), canonical);
  assert.deepEqual(await profiles(), stored);
  await assert.rejects(pool.query("UPDATE instagram_dm_profiles SET username='bad name'"), { code: "23514" });
  await assert.rejects(pool.query("UPDATE instagram_dm_profiles SET failure_code='other'"), { code: "23514" });
  const runner = await readFile(new URL("../../deploy/migrate-multi-user.sql", import.meta.url), "utf8");
  assert.ok(runner.indexOf("076_instagram_dm_profiles.sql") > runner.indexOf("075_dm_start_limits.sql") && runner.indexOf("076_instagram_dm_profiles.sql") < runner.indexOf("supabase-access.sql"));
});
