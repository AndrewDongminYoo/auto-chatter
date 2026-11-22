import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { listContacts } from "./contacts.ts";
import { resetTestSchema } from "../test-schema.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname)) throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: databaseUrl });
const workspace = "11111111-1111-4111-8111-111111111111";
const connection = "33333333-3333-4333-8333-333333333333";
const owner = { id: "77777777-7777-4777-8777-777777777777", email: "owner@example.test" };

before(async () => {
  await resetTestSchema(pool);
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [workspace]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspace, owner.id]);
  await pool.query("INSERT INTO instagram_connections(id,workspace_id,account_id,username) VALUES($1,$2,'100','shop')", [connection, workspace]);
});
after(async () => pool.end());

async function comment(id: string, sender: string, username: string | null, at: string) {
  await pool.query("INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text,sender_username,created_at) VALUES($1,$2,$3,'media',$4,'x',$5,$6)", [workspace, connection, id, sender, username, at]);
}

test("the contacts list returns the commenter's username from the newest comment that carried one (#388)", async () => {
  // renamed: the newest comment carries the new name.
  await comment("c1", "renamed", "old.name", "2026-11-20T00:00:00Z");
  await comment("c2", "renamed", "new.name", "2026-11-21T00:00:00Z");
  // later_missing: the newest comment has no username, so the older one still names the contact.
  await comment("c3", "later_missing", "kept_name", "2026-11-20T00:00:00Z");
  await comment("c4", "later_missing", null, "2026-11-21T00:00:00Z");
  // never: no comment carried a username.
  await comment("c5", "never", null, "2026-11-21T00:00:00Z");

  const contacts = (await listContacts(pool, owner)).contacts as { sender_id: string; sender_username: string | null; username: string | null }[];
  assert.deepEqual(Object.fromEntries(contacts.map((contact) => [contact.sender_id, [contact.sender_username, contact.username]])), {
    later_missing: ["kept_name", "shop"],
    never: [null, "shop"],
    renamed: ["new.name", "shop"],
  });
});
