import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { Pool } from "pg";
import { currentKeyPrefix, openSecret, sealSecret } from "./secrets.ts";
import { rewrapSealedSecrets } from "./token-key-rewrap.ts";
import { signingKeyContext } from "./webhook-delivery.ts";
import { refreshDueInstagramTokensWithFailures } from "./instagram-token-refresh.ts";
import { resetTestSchema } from "../test-schema.ts";

const url = new URL(process.env.TEST_DATABASE_URL ?? "http://invalid");
if (url.pathname !== "/automations_test" || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Database tests require a local automations_test database");
const pool = new Pool({ connectionString: url.toString() });
const workspace = "11111111-1111-4111-8111-111111111111";
const endpoint = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const previousKey = Buffer.alloc(32, 1).toString("base64");
const currentKey = Buffer.alloc(32, 2).toString("base64");
const unknownKey = Buffer.alloc(32, 3).toString("base64");
const keys = { current: currentKey, previous: previousKey };

// The envelope written before #61, with no key identifier.
function sealV1(value: string, masterKey: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(masterKey, "base64"), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

const connectionId = (index: number) => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`;
const signingKeyId = (index: number) => `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, "0")}`;

async function addConnection(index: number, sealed: (context: string) => string | null, active = true): Promise<void> {
  const account = `10${index}`;
  await pool.query(
    `INSERT INTO instagram_connections(id,workspace_id,account_id,active,access_token_encrypted,token_expires_at,token_obtained_at,
       reauth_required_at,reauth_reason,reauth_token_obtained_at,subscription_check_attempted_at)
     VALUES($1,$2,$3,$4,$5,now()+interval '20 days',now()-interval '2 days',now()-interval '1 hour','refresh_rejected',now()-interval '2 days',now()-interval '3 hours')`,
    [connectionId(index), workspace, account, active, sealed(`${workspace}:${account}`)],
  );
}

async function addSigningKey(index: number, slot: number, sealed: (context: string) => string | null): Promise<void> {
  const id = signingKeyId(index);
  const value = sealed(signingKeyContext(workspace, endpoint, id));
  await pool.query("INSERT INTO webhook_signing_keys(id,workspace_id,endpoint_id,slot,secret_encrypted,retired_at) VALUES($1,$2,$3,$4,$5,$6)", [id, workspace, endpoint, slot, value, value === null ? new Date() : null]);
}

async function connections(): Promise<Record<string, unknown>[]> {
  return (await pool.query("SELECT to_jsonb(c) AS row FROM instagram_connections c ORDER BY id")).rows.map((row) => row.row as Record<string, unknown>);
}

before(async () => {
  await resetTestSchema(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("TRUNCATE webhook_signing_keys, webhook_endpoints CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [workspace]);
  await pool.query("INSERT INTO webhook_endpoints(id,workspace_id,name,url) VALUES($1,$2,'crm','https://hooks.example.test/in')", [endpoint, workspace]);
});
after(async () => {
  await pool.end();
});

test("without a previous key nothing is read or written", async () => {
  const noQueries = { query: () => assert.fail("no query expected") } as unknown as Pool;
  assert.deepEqual(await rewrapSealedSecrets(noQueries, { current: currentKey }), { rewrapped: 0, failed: 0 });
  assert.deepEqual(await rewrapSealedSecrets(noQueries, { current: currentKey, previous: undefined }), { rewrapped: 0, failed: 0 });
  // The runbook first registers the current key as the previous key; that must change no ciphertext.
  assert.deepEqual(await rewrapSealedSecrets(noQueries, { current: currentKey, previous: currentKey }), { rewrapped: 0, failed: 0 });
});

test("every stored secret is sealed again with the current key, and nothing else changes", async () => {
  await addConnection(1, (context) => sealSecret("token-1", previousKey, context));
  await addConnection(2, (context) => sealV1("token-2", previousKey, context), false);
  await addConnection(3, (context) => sealV1("token-3", currentKey, context));
  const untouched = sealSecret("token-4", currentKey, `${workspace}:104`);
  await addConnection(4, () => untouched);
  await addConnection(5, () => null, false);
  await addSigningKey(1, 1, (context) => sealSecret("whsec_one", previousKey, context));
  await addSigningKey(2, 2, (context) => sealV1("whsec_two", previousKey, context));
  await addSigningKey(3, 1, () => null);
  const beforeRows = await connections();

  assert.deepEqual(await rewrapSealedSecrets(pool, keys), { rewrapped: 5, failed: 0 });

  const afterRows = await connections();
  for (const [index, row] of afterRows.entries()) {
    const { access_token_encrypted: sealed, ...rest } = row;
    const { access_token_encrypted: old, ...previousRest } = beforeRows[index]!;
    assert.deepEqual(rest, previousRest, "only the sealed column changes");
    if (sealed === null) {
      assert.equal(old, null);
      continue;
    }
    assert.equal((sealed as string).startsWith(currentKeyPrefix(currentKey)), true);
    const account = rest.account_id as string;
    assert.equal(openSecret(sealed as string, currentKey, `${workspace}:${account}`), `token-${account.slice(2)}`);
  }
  assert.equal(afterRows[3]!.access_token_encrypted, untouched);
  const secrets = (await pool.query("SELECT id::text,secret_encrypted FROM webhook_signing_keys ORDER BY id")).rows;
  assert.equal(openSecret(secrets[0].secret_encrypted, currentKey, signingKeyContext(workspace, endpoint, signingKeyId(1))), "whsec_one");
  assert.equal(openSecret(secrets[1].secret_encrypted, currentKey, signingKeyContext(workspace, endpoint, signingKeyId(2))), "whsec_two");
  assert.equal(secrets[2].secret_encrypted, null);

  // Nothing is left for a second run.
  assert.deepEqual(await rewrapSealedSecrets(pool, keys), { rewrapped: 0, failed: 0 });
});

test("a secret that no ring key opens counts as failed and does not hold up the rows after it", async () => {
  const unreadable = sealSecret("token-1", unknownKey, `${workspace}:101`);
  await addConnection(1, () => unreadable);
  await addConnection(2, (context) => sealSecret("token-2", previousKey, context));
  await addSigningKey(1, 1, (context) => sealSecret("whsec_one", unknownKey, context));
  await addSigningKey(2, 2, (context) => sealSecret("whsec_two", previousKey, context));
  assert.deepEqual(await rewrapSealedSecrets(pool, keys), { rewrapped: 2, failed: 2 });
  const rows = await connections();
  assert.equal(rows[0]!.access_token_encrypted, unreadable);
  assert.equal(openSecret(rows[1]!.access_token_encrypted as string, currentKey, `${workspace}:102`), "token-2");
  // Each later run counts it again until the token is replaced, so the step keeps failing.
  assert.deepEqual(await rewrapSealedSecrets(pool, keys), { rewrapped: 0, failed: 2 });
});

test("a write made after the read wins over the rewrap", async () => {
  await addConnection(1, (context) => sealSecret("token-1", previousKey, context));
  await addConnection(2, (context) => sealSecret("token-2", previousKey, context));
  await addSigningKey(1, 1, (context) => sealSecret("whsec_one", previousKey, context));
  const refreshed = sealSecret("refreshed-token", currentKey, `${workspace}:101`);
  // A token refresh of connection 1 and a retirement of the signing key commit between the read and the write.
  const racing = {
    query: async (text: string, values?: unknown[]) => {
      if (text.trimStart().startsWith("UPDATE instagram_connections")) await pool.query("UPDATE instagram_connections SET access_token_encrypted=$2 WHERE id=$1", [connectionId(1), refreshed]);
      if (text.trimStart().startsWith("UPDATE webhook_signing_keys")) await pool.query("UPDATE webhook_signing_keys SET secret_encrypted=NULL,retired_at=now() WHERE id=$1", [signingKeyId(1)]);
      return pool.query(text, values);
    },
  } as unknown as Pool;
  assert.deepEqual(await rewrapSealedSecrets(racing, keys), { rewrapped: 1, failed: 0 });
  const rows = await connections();
  assert.equal(rows[0]!.access_token_encrypted, refreshed);
  assert.equal(openSecret(rows[1]!.access_token_encrypted as string, currentKey, `${workspace}:102`), "token-2");
  assert.deepEqual((await pool.query("SELECT secret_encrypted,retired_at IS NOT NULL AS retired FROM webhook_signing_keys")).rows, [{ secret_encrypted: null, retired: true }]);
});

test("a token refresh that loses its save to a rewrap is due again at once and refreshes the rewrapped token", async () => {
  await addConnection(1, (context) => sealSecret("token-1", previousKey, context));
  await pool.query("UPDATE instagram_connections SET token_expires_at=now()+interval '20 days',reauth_required_at=NULL,reauth_reason=NULL,reauth_token_obtained_at=NULL");
  const sent: string[] = [];
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const target = new URL(String(input));
    if (target.pathname === "/refresh_access_token") {
      sent.push(target.searchParams.get("access_token")!);
      // The first refresh read the previous key's ciphertext, so its conditional save loses to this rewrap.
      if (sent.length === 1) assert.deepEqual(await rewrapSealedSecrets(pool, keys), { rewrapped: 1, failed: 0 });
      return Response.json({ access_token: `renewed-${sent.length}`, expires_in: 5_184_000 });
    }
    return Response.json({ user_id: "101" });
  }) as typeof fetch;
  // The lost save releases its attempt, so the same run claims the connection again, opens the rewrapped token
  // with the current key and stores the renewal under it.
  assert.deepEqual(await refreshDueInstagramTokensWithFailures(pool, keys, fetchImpl), { refreshed: 1, failed: 0 });
  assert.deepEqual(sent, ["token-1", "token-1"]);
  const row = (await pool.query("SELECT access_token_encrypted,token_refresh_attempted_at FROM instagram_connections")).rows[0];
  assert.equal(row.access_token_encrypted.startsWith(currentKeyPrefix(currentKey)), true);
  assert.equal(openSecret(row.access_token_encrypted, currentKey, `${workspace}:101`), "renewed-2");
  assert.equal(row.token_refresh_attempted_at, null);
});
