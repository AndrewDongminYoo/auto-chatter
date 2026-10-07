import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { appApi } from "./api.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const owner = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const admin = { id: "22222222-2222-4222-8222-222222222222", email: "admin@example.test" };
const invitee = { id: "33333333-3333-4333-8333-333333333333", email: "Invitee@Example.test" };
const stranger = { id: "44444444-4444-4444-8444-444444444444", email: "stranger@example.test" };
const outsider = { id: "55555555-5555-4555-8555-555555555555", email: "outsider@example.test" };
const workspaceId = "66666666-6666-4666-8666-666666666666";
const otherWorkspaceId = "77777777-7777-4777-8777-777777777777";
const apiEnv = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "test",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
};

type Actor = { id: string; email: string };

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1),($2)", [workspaceId, otherWorkspaceId]);
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,user_id,role,email)
     VALUES($1,$2,'owner',$3),($1,$4,'admin',$5),($6,$7,'owner',$8)`,
    [workspaceId, owner.id, owner.email, admin.id, admin.email, otherWorkspaceId, outsider.id, outsider.email],
  );
});

after(async () => pool.end());

function request(actor: Actor, method: string, path: string, body?: unknown) {
  return appApi(
    new Request(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", cookie: "__Host-ac-access=test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    apiEnv,
    () => ({ query: pool.query.bind(pool), connect: pool.connect.bind(pool), end: async () => {} }) as unknown as Pool,
    (async () => Response.json({ id: actor.id, email: actor.email, email_confirmed_at: "2026-09-25" })) as typeof fetch,
  );
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function invite(email = "invitee@example.test", role = "agent"): Promise<{ id: string; token: string }> {
  const response = await request(owner, "POST", "/api/workspace/invites", { email, role });
  assert.equal(response.status, 201);
  const created = await body<{ id: string; link: string }>(response);
  assert.match(created.link, /^https:\/\/app\.test\/app\/#invite=[A-Za-z0-9_-]{43}$/);
  return { id: created.id, token: created.link.split("#invite=")[1]! };
}

function accept(actor: Actor, token: string) {
  return request(actor, "POST", "/api/invites/accept", { token });
}

test("only the owner manages invites, and the stored invite holds only a hash of the link token", async () => {
  const { id, token } = await invite();
  const stored = (await pool.query("SELECT email,role,token_hash FROM workspace_invites WHERE id=$1", [id])).rows[0];
  assert.deepEqual(stored, {
    email: "invitee@example.test",
    role: "agent",
    token_hash: createHash("sha256").update(token).digest("hex"),
  });
  const listed = await body<{ invites: Record<string, unknown>[] }>(
    await request(owner, "GET", "/api/workspace/invites"),
  );
  assert.equal(listed.invites.length, 1);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(token));

  for (const [method, path, payload] of [
    ["POST", "/api/workspace/invites", { email: "x@example.test", role: "agent" }],
    ["GET", "/api/workspace/invites", undefined],
    ["DELETE", `/api/workspace/invites/${id}`, undefined],
    ["GET", "/api/workspace/members", undefined],
    ["PATCH", `/api/workspace/members/${owner.id}`, { role: "agent" }],
    ["DELETE", `/api/workspace/members/${owner.id}`, undefined],
  ] as const) {
    const denied = await request(admin, method, path, payload);
    assert.equal(denied.status, 403, `${method} ${path}`);
    assert.equal((await body<{ error: string }>(denied)).error, "role_forbidden");
  }
  assert.equal(
    (await request(owner, "POST", "/api/workspace/invites", { email: "x@example.test", role: "owner" })).status,
    400,
  );
  const member = await request(owner, "POST", "/api/workspace/invites", { email: "ADMIN@example.test", role: "agent" });
  assert.equal(member.status, 409);
  assert.equal((await body<{ error: string }>(member)).error, "already_member");
});

test("an invite joins the matching confirmed email once and then gives that role", async () => {
  const { token } = await invite();
  const wrong = await accept(stranger, token);
  assert.equal(wrong.status, 403);
  assert.equal((await body<{ error: string }>(wrong)).error, "invite_email_mismatch");
  assert.equal((await request(invitee, "GET", "/api/flows")).status, 403);

  const joined = await accept(invitee, token);
  assert.equal(joined.status, 200);
  assert.deepEqual(await body(joined), { workspace_id: workspaceId, role: "agent" });
  assert.equal((await request(invitee, "GET", "/api/flows")).status, 200);
  assert.equal((await request(invitee, "POST", "/api/flows", { name: "no" })).status, 403);

  // A retry after a lost response returns the original success.
  const again = await accept(invitee, token);
  assert.equal(again.status, 200);
  assert.deepEqual(await body(again), { workspace_id: workspaceId, role: "agent" });
  const members = await body<{ members: { email: string; role: string }[] }>(
    await request(owner, "GET", "/api/workspace/members"),
  );
  assert.deepEqual(
    members.members.map((entry) => [entry.email, entry.role]),
    [
      ["owner@example.test", "owner"],
      ["admin@example.test", "admin"],
      ["invitee@example.test", "agent"],
    ],
  );
});

test("expired, revoked and replaced invites cannot be used", async () => {
  const expired = await invite("invitee@example.test");
  await pool.query(
    "UPDATE workspace_invites SET created_at=now()-interval '8 days',expires_at=now()-interval '1 day' WHERE id=$1",
    [expired.id],
  );
  const late = await accept(invitee, expired.token);
  assert.equal(late.status, 410);
  assert.equal((await body<{ error: string }>(late)).error, "invite_expired");

  const replaced = await invite("invitee@example.test");
  const current = await invite("invitee@example.test");
  const old = await accept(invitee, replaced.token);
  assert.equal(old.status, 410);
  assert.equal((await body<{ error: string }>(old)).error, "invite_revoked");

  assert.equal((await request(owner, "DELETE", `/api/workspace/invites/${current.id}`)).status, 200);
  assert.equal((await request(owner, "DELETE", `/api/workspace/invites/${current.id}`)).status, 404);
  assert.equal((await accept(invitee, current.token)).status, 410);
  assert.equal((await accept(invitee, "A".repeat(43))).status, 404);
  assert.equal((await accept(invitee, "short")).status, 404);
});

test("an invitee moves out of their own empty workspace but not out of one with data", async () => {
  const first = await invite();
  const created = await body<{ workspace_id: string; role: string }>(await request(invitee, "POST", "/api/workspace"));
  assert.equal(created.role, "owner");
  assert.equal((await accept(invitee, first.token)).status, 200);
  assert.equal(
    (await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1", [invitee.id])).rows[0]
      .workspace_id,
    workspaceId,
  );

  const busyInvite = await request(outsider, "POST", "/api/workspace/invites", {
    email: stranger.email,
    role: "admin",
  });
  const busyToken = (await body<{ link: string }>(busyInvite)).link.split("#invite=")[1]!;
  await body(await request(stranger, "POST", "/api/workspace"));
  const strangerWorkspace = (
    await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1", [stranger.id])
  ).rows[0].workspace_id;
  await pool.query("INSERT INTO flows(workspace_id,name,draft) VALUES($1,'kept','{}')", [strangerWorkspace]);
  const refused = await accept(stranger, busyToken);
  assert.equal(refused.status, 409);
  assert.equal((await body<{ error: string }>(refused)).error, "workspace_not_empty");
  assert.equal(
    (await pool.query("SELECT accepted_at FROM workspace_invites WHERE workspace_id=$1", [otherWorkspaceId])).rows[0]
      .accepted_at,
    null,
  );
});

test("a sole owner whose workspace holds only an inbox label is not moved by accepting an invite", async () => {
  const { token } = await invite(stranger.email, "agent");
  await body(await request(stranger, "POST", "/api/workspace"));
  const ownWorkspace = (await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1", [stranger.id]))
    .rows[0].workspace_id;
  const created = await request(stranger, "POST", "/api/inbox/labels", { name: "VIP" });
  assert.equal(created.status, 201);
  const label = await body<{ id: string }>(created);
  // An archived label is still workspace data that only a member can read, export or delete.
  for (const archived of [false, true]) {
    if (archived) assert.equal((await request(stranger, "DELETE", `/api/inbox/labels/${label.id}`)).status, 200);
    const refused = await accept(stranger, token);
    assert.equal(refused.status, 409);
    assert.equal((await body<{ error: string }>(refused)).error, "workspace_not_empty");
    assert.deepEqual(
      (await pool.query("SELECT workspace_id,role FROM workspace_members WHERE user_id=$1", [stranger.id])).rows,
      [{ workspace_id: ownWorkspace, role: "owner" }],
    );
  }
  assert.equal(
    (await pool.query("SELECT accepted_at FROM workspace_invites WHERE email=$1", [stranger.email])).rows[0]
      .accepted_at,
    null,
  );
});

for (const active of [true, false]) {
  test(`a sole owner whose workspace holds only an ${active ? "active" : "inactive"} webhook endpoint cannot leave it`, async () => {
    const { id: inviteId, token } = await invite(stranger.email, "agent");
    const { workspace_id: ownWorkspace } = await body<{ workspace_id: string }>(
      await request(stranger, "POST", "/api/workspace"),
    );
    const created = await request(stranger, "POST", "/api/webhooks/endpoints", {
      name: "kept endpoint",
      url: "https://hooks.example.test/in",
    });
    assert.equal(created.status, 201);
    const endpoint = await body<{ id: string }>(created);
    if (!active)
      assert.equal((await request(stranger, "POST", `/api/webhooks/endpoints/${endpoint.id}/disable`)).status, 200);

    const refused = await accept(stranger, token);
    assert.equal(refused.status, 409);
    assert.equal((await body<{ error: string }>(refused)).error, "workspace_not_empty");
    assert.deepEqual(
      (await pool.query("SELECT workspace_id,role FROM workspace_members WHERE user_id=$1", [stranger.id])).rows,
      [{ workspace_id: ownWorkspace, role: "owner" }],
    );
    assert.equal(
      (await pool.query("SELECT accepted_at FROM workspace_invites WHERE id=$1", [inviteId])).rows[0].accepted_at,
      null,
    );
    const listed = await request(stranger, "GET", "/api/webhooks/endpoints");
    assert.equal(listed.status, 200);
    const { endpoints } = await body<{ endpoints: { id: string; active: boolean; keys: unknown[] }[] }>(listed);
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0]!.id, endpoint.id);
    assert.equal(endpoints[0]!.active, active);
    assert.equal(endpoints[0]!.keys.length, 1);
  });
}

test("a removed member is refused on the next request and a role change applies at once", async () => {
  const { token } = await invite();
  assert.equal((await accept(invitee, token)).status, 200);
  const changed = await request(owner, "PATCH", `/api/workspace/members/${invitee.id}`, { role: "admin" });
  assert.deepEqual(await body(changed), { user_id: invitee.id, role: "admin" });
  assert.equal((await request(invitee, "POST", "/api/flows", { name: "admin flow" })).status, 201);

  assert.equal((await request(owner, "DELETE", `/api/workspace/members/${invitee.id}`)).status, 200);
  const refused = await request(invitee, "GET", "/api/flows");
  assert.equal(refused.status, 403);
  assert.equal((await body<{ error: string }>(refused)).error, "workspace_required");
  assert.equal((await request(owner, "DELETE", `/api/workspace/members/${invitee.id}`)).status, 404);

  const fresh = await body<{ workspace_id: string; role: string }>(await request(invitee, "POST", "/api/workspace"));
  assert.notEqual(fresh.workspace_id, workspaceId);
  assert.equal(fresh.role, "owner");
  assert.deepEqual(
    (await request(invitee, "GET", "/api/flows").then((response) => body<{ flows: unknown[] }>(response))).flows,
    [],
  );

  for (const [method, payload] of [
    ["DELETE", undefined],
    ["PATCH", { role: "agent" }],
  ] as const) {
    const self = await request(owner, method, `/api/workspace/members/${owner.id}`, payload);
    assert.equal(self.status, 409);
    assert.equal((await body<{ error: string }>(self)).error, "cannot_change_self");
  }
});

test("the owner role can be neither granted nor invited, and open invites stop at 20", async () => {
  const { token } = await invite();
  assert.equal((await accept(invitee, token)).status, 200);
  for (const role of ["owner", "OWNER", "superuser", ""]) {
    const promoted = await request(owner, "PATCH", `/api/workspace/members/${invitee.id}`, { role });
    assert.equal(promoted.status, 400, role);
    assert.equal((await body<{ error: string }>(promoted)).error, "invalid_role");
    const invited = await request(owner, "POST", "/api/workspace/invites", { email: "x@example.test", role });
    assert.equal(invited.status, 400, role);
  }
  const members = await pool.query<{ user_id: string; role: string }>(
    "SELECT user_id, role FROM workspace_members WHERE workspace_id=$1 AND (role='owner' OR user_id=$2) ORDER BY role",
    [workspaceId, invitee.id],
  );
  assert.deepEqual(members.rows, [
    { user_id: invitee.id, role: "agent" },
    { user_id: owner.id, role: "owner" },
  ]);
  for (let index = 0; index < 20; index++) await invite(`open-${index}@example.test`);
  const over = await request(owner, "POST", "/api/workspace/invites", { email: "open-20@example.test", role: "agent" });
  assert.equal(over.status, 409);
  assert.equal((await body<{ error: string }>(over)).error, "invite_limit_reached");
});

test("an acceptance waits for a concurrent re-invite instead of deadlocking with it", async () => {
  const { id, token } = await invite();
  const reinviting = await pool.connect();
  try {
    // The same lock order as createInvite: the workspace row, then the open invite for that email.
    await reinviting.query("BEGIN");
    await reinviting.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspaceId]);
    const accepting = accept(invitee, token);
    for (let attempt = 0; attempt < 40; attempt++) {
      const waiting = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM workspaces WHERE id=%FOR SHARE%'",
      );
      if (waiting.rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await reinviting.query("UPDATE workspace_invites SET revoked_at=now() WHERE id=$1", [id]);
    await reinviting.query("COMMIT");
    const response = await accepting;
    assert.equal(response.status, 410);
    assert.equal((await body<{ error: string }>(response)).error, "invite_revoked");
  } finally {
    reinviting.release();
  }
});

test("owners cannot reach another workspace's members or invites", async () => {
  const { id } = await invite();
  assert.equal((await request(outsider, "DELETE", `/api/workspace/invites/${id}`)).status, 404);
  assert.equal((await request(outsider, "DELETE", `/api/workspace/members/${admin.id}`)).status, 404);
  assert.equal((await request(outsider, "PATCH", `/api/workspace/members/${admin.id}`, { role: "agent" })).status, 404);
  const listed = await body<{ members: { user_id: string }[] }>(
    await request(outsider, "GET", "/api/workspace/members"),
  );
  assert.deepEqual(
    listed.members.map((entry) => entry.user_id),
    [outsider.id],
  );
  assert.deepEqual(
    (await body<{ invites: unknown[] }>(await request(outsider, "GET", "/api/workspace/invites"))).invites,
    [],
  );
  assert.equal(
    (await pool.query("SELECT role FROM workspace_members WHERE user_id=$1", [admin.id])).rows[0].role,
    "admin",
  );
});

test("workspace deletion removes invites and names only the owner for login deletion", async () => {
  await invite();
  const deleted = (
    await pool.query<{
      result: { owner_user_id: string; member_user_ids: string[]; deleted_counts: Record<string, number> };
    }>("SELECT public.delete_workspace_data($1,$2) AS result", [workspaceId, owner.id])
  ).rows[0]!.result;
  assert.equal(deleted.owner_user_id, owner.id);
  assert.deepEqual(deleted.member_user_ids.sort(), [owner.id, admin.id].sort());
  assert.equal(deleted.deleted_counts.workspace_invites, 1);
});

test("the invite migration replays and the schema keeps one active owner and no removed owner", async () => {
  const migration = await readFile(new URL("../../db/migrations/024_workspace_invites.sql", import.meta.url), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  await assert.rejects(
    pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [owner.id, admin.id]),
    { code: "23514" },
  );
  await pool.query("UPDATE workspace_members SET removed_at=now(),removed_by=$2 WHERE user_id=$1", [
    admin.id,
    owner.id,
  ]);
  await assert.rejects(pool.query("UPDATE workspace_members SET role='owner' WHERE user_id=$1", [admin.id]), {
    code: "23514",
  });
  await assert.rejects(
    pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,gen_random_uuid(),'owner')", [
      workspaceId,
    ]),
    { code: "23505" },
  );
});

test("creations that resolved the old workspace before an acceptance moved the user are refused", async () => {
  const ownWorkspace = "88888888-8888-4888-8888-888888888888";
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [ownWorkspace]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,email) VALUES($1,$2,'owner',$3)", [
    ownWorkspace,
    stranger.id,
    stranger.email,
  ]);
  async function waitForLockWaiters(count: number) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const waiting = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock'");
      if (waiting.rows[0].n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`fewer than ${count} lock waiters`);
  }
  const creations: [string, unknown][] = [
    ["/api/flows", { name: "late flow" }],
    ["/api/contact-fields", { name: "late field", type: "text" }],
    ["/api/contact-segments", { name: "late segment" }],
    ["/api/inbox/labels", { name: "late label" }],
    ["/api/webhooks/endpoints", { name: "late endpoint", url: "https://hooks.example.test/in" }],
    // The membership recheck comes before the label lookup, so a rule is refused before its (absent) label is read.
    [
      "/api/inbox/label-rules",
      { label_id: "abababab-abab-4bab-8bab-abababababab", match_mode: "contains", keywords: ["late"] },
    ],
    ["/api/workspace/invites", { email: "late@example.test", role: "agent" }],
  ];
  const { token } = await invite(stranger.email, "admin");
  const blocker = await pool.connect();
  try {
    // Hold the user's own workspace so the acceptance and then every creation queue behind it in that order.
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [ownWorkspace]);
    const accepting = accept(stranger, token);
    await waitForLockWaiters(1);
    const creating = creations.map(([path, input]) => request(stranger, "POST", path, input));
    await waitForLockWaiters(1 + creations.length);
    await blocker.query("COMMIT");
    assert.equal((await accepting).status, 200);
    for (const [index, response] of (await Promise.all(creating)).entries())
      assert.equal(response.status, 403, creations[index]![0]);
  } finally {
    blocker.release();
  }
  const left = await pool.query(
    `SELECT (SELECT count(*) FROM flows WHERE workspace_id=$1)
      + (SELECT count(*) FROM instagram_contact_fields WHERE workspace_id=$1)
      + (SELECT count(*) FROM instagram_contact_segments WHERE workspace_id=$1)
      + (SELECT count(*) FROM instagram_inbox_labels WHERE workspace_id=$1)
      + (SELECT count(*) FROM instagram_inbox_label_rules WHERE workspace_id=$1)
      + (SELECT count(*) FROM webhook_endpoints WHERE workspace_id=$1)
      + (SELECT count(*) FROM webhook_signing_keys WHERE workspace_id=$1)
      + (SELECT count(*) FROM workspace_invites WHERE workspace_id=$1) AS n`,
    [ownWorkspace],
  );
  assert.equal(Number(left.rows[0].n), 0);
});

test("two owners accepting each other's invites get workspace_not_empty instead of a deadlock", async () => {
  const strangerWorkspace = "99999999-9999-4999-8999-999999999999";
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [strangerWorkspace]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,email) VALUES($1,$2,'owner',$3)", [
    strangerWorkspace,
    stranger.id,
    stranger.email,
  ]);
  async function inviteFrom(actor: Actor, email: string) {
    const response = await request(actor, "POST", "/api/workspace/invites", { email, role: "admin" });
    assert.equal(response.status, 201);
    return (await body<{ link: string }>(response)).link.split("#invite=")[1]!;
  }
  const toStranger = await inviteFrom(outsider, stranger.email);
  const toOutsider = await inviteFrom(stranger, outsider.email);
  const blocker = await pool.connect();
  try {
    // Release both acceptances at once so each takes its destination lock before its source lock.
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workspaces WHERE id=ANY($1) FOR UPDATE", [
      [strangerWorkspace, otherWorkspaceId],
    ]);
    const accepting = [accept(stranger, toStranger), accept(outsider, toOutsider)];
    for (let attempt = 0; attempt < 80; attempt++) {
      const waiting = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock'");
      if (waiting.rows[0].n >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await blocker.query("COMMIT");
    const responses = await Promise.all(accepting);
    for (const response of responses) {
      assert.equal(response.status, 409);
      assert.equal((await body<{ error: string }>(response)).error, "workspace_not_empty");
    }
  } finally {
    blocker.release();
  }
});

test("a removed member cannot rejoin with the invite link they already used", async () => {
  const { token } = await invite();
  assert.equal((await accept(invitee, token)).status, 200);
  assert.equal((await request(owner, "DELETE", `/api/workspace/members/${invitee.id}`)).status, 200);
  const reused = await accept(invitee, token);
  assert.equal(reused.status, 409);
  assert.equal((await body<{ error: string }>(reused)).error, "invite_used");
});

test("an owner whose workspace holds only revoked or expired invites cannot leave it", async () => {
  const strangerWorkspace = "99999999-9999-4999-8999-999999999998";
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [strangerWorkspace]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,email) VALUES($1,$2,'owner',$3)", [
    strangerWorkspace,
    stranger.id,
    stranger.email,
  ]);
  const created = await request(stranger, "POST", "/api/workspace/invites", {
    email: "old@example.test",
    role: "agent",
  });
  assert.equal(created.status, 201);
  const { id } = await body<{ id: string }>(created);
  assert.equal((await request(stranger, "DELETE", `/api/workspace/invites/${id}`)).status, 200);
  const { token } = await invite(stranger.email, "admin");
  const refused = await accept(stranger, token);
  assert.equal(refused.status, 409);
  assert.equal((await body<{ error: string }>(refused)).error, "workspace_not_empty");
  assert.equal(
    (await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id=$1", [stranger.id])).rows[0]
      .workspace_id,
    strangerWorkspace,
  );
});
