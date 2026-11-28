import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { roleAllows, workspaceFor, type WorkspaceRole } from "./settings.ts";

// Workspace API keys (#48): an external system such as a CRM reads the workspace's data with one. The key is
// returned once at issue; only its SHA-256 hash is stored. Every route needs the admin role, like the webhooks.
// A key always reads contacts, and may also write contacts (a write answers with the written contact) and start flows
// (flows:start, which sends messages). The scopes are stored in this order, which the api_keys CHECK also requires.
export const API_KEY_SCOPES = ["contacts:read", "contacts:write", "flows:start"] as const;
export const API_KEY_EXPIRY_DAYS = [30, 90, 180, 365] as const;
export const DEFAULT_API_KEY_EXPIRY_DAYS = 90;
export const MAX_ACTIVE_API_KEYS = 10;
const API_KEY_PREFIX = "ac_live_";
const API_KEY_PATTERN = /^ac_live_[A-Za-z0-9_-]{43}$/;
const API_KEY_NAME_LENGTH = 80;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export type ApiKeyRevocation = "member_removed" | "member_demoted";

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isApiKeyFormat(value: unknown): value is string {
  return typeof value === "string" && API_KEY_PATTERN.test(value);
}

export function apiKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// The part of the key the dashboard shows to tell keys apart, including the ac_live_ marker.
export function apiKeyPrefix(key: string): string {
  return key.slice(0, 12);
}

export function parseApiKeyRequest(input: unknown): { name: string; expiresInDays: number; scopes: ApiKeyScope[] } {
  if (!isRecord(input) || Object.keys(input).some((key) => !["name", "expires_in_days", "scopes"].includes(key))) throw new ApiError(400, "invalid_api_key");
  if (typeof input.name !== "string" || input.name.length > 300) throw new ApiError(400, "invalid_api_key");
  const name = input.name.trim().normalize("NFC");
  if (!name || name.length > API_KEY_NAME_LENGTH || /[\p{Cc}\p{Cf}]/u.test(name)) throw new ApiError(400, "invalid_api_key");
  const expiresInDays = "expires_in_days" in input ? input.expires_in_days : DEFAULT_API_KEY_EXPIRY_DAYS;
  if (!(API_KEY_EXPIRY_DAYS as readonly unknown[]).includes(expiresInDays)) throw new ApiError(400, "invalid_api_key_expiry");
  const scopes = input.scopes;
  if (!Array.isArray(scopes) || !scopes.includes("contacts:read") || new Set(scopes).size !== scopes.length || scopes.some((scope) => !(API_KEY_SCOPES as readonly unknown[]).includes(scope))) throw new ApiError(400, "invalid_api_key_scopes");
  return { name, expiresInDays: expiresInDays as number, scopes: API_KEY_SCOPES.filter((scope) => scopes.includes(scope)) };
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const LISTED_COLUMNS = `id,name,key_prefix,scopes,created_by,created_by_email,created_at,expires_at,last_used_at,last_used_ip,
  revoked_at,revoked_reason,revoked_at IS NULL AND expires_at>now() AS active`;

// Every key of the workspace, revoked and expired ones included, newest first. The hash is never read.
export async function listApiKeys(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user, "admin");
  const keys = (await pool.query(`SELECT ${LISTED_COLUMNS} FROM api_keys WHERE workspace_id=$1 ORDER BY created_at DESC,id`, [workspace])).rows;
  return { keys, scopes: API_KEY_SCOPES, expiry_days: API_KEY_EXPIRY_DAYS, default_expiry_days: DEFAULT_API_KEY_EXPIRY_DAYS, max_active: MAX_ACTIVE_API_KEYS };
}

// Locks the caller's membership row FOR SHARE and checks the admin role again inside the transaction, after the
// workspace row (the lock order of the other workspace writes): a removal or demotion that commits first refuses
// the change, and one that commits later waits for it.
async function lockAdmin(client: PoolClient, workspace: string, user: User): Promise<{ email: string | null }> {
  const member = (await client.query<{ role: WorkspaceRole; email: string | null }>("SELECT role,email FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 AND removed_at IS NULL FOR SHARE", [user.id, workspace])).rows[0];
  if (!member) throw new ApiError(403, "workspace_required");
  if (!roleAllows(member.role, "admin")) throw new ApiError(403, "role_forbidden");
  return member;
}

// The key is in this response only. The workspace row is locked FOR NO KEY UPDATE, which serializes issues for the
// active count without blocking foreign key checks, then the caller's membership (lockAdmin): a removal or demotion
// that commits later revokes the new key.
export async function createApiKey(pool: Pool, user: User, input: unknown) {
  const request = parseApiKeyRequest(input);
  const workspace = await workspaceFor(pool, user, "admin");
  const key = generateApiKey();
  return transaction(pool, async (client) => {
    await client.query("SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE", [workspace]);
    const member = await lockAdmin(client, workspace, user);
    const created = await client.query(
      `INSERT INTO api_keys(workspace_id,name,key_prefix,key_hash,scopes,created_by,created_by_email,expires_at)
       SELECT $1,$2,$3,$4,$5::text[],$6,$7,clock_timestamp()+make_interval(days=>$8)
       WHERE (SELECT count(*) FROM api_keys WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at>now())<$9
       RETURNING ${LISTED_COLUMNS}`,
      [workspace, request.name, apiKeyPrefix(key), apiKeyHash(key), request.scopes, user.id, member.email, request.expiresInDays, MAX_ACTIVE_API_KEYS],
    );
    if (!created.rows[0]) throw new ApiError(409, "api_key_limit_reached");
    await client.query("INSERT INTO api_key_events(workspace_id,api_key_id,kind,actor_id) VALUES($1,$2,'created',$3)", [workspace, created.rows[0].id, user.id]);
    return { ...created.rows[0], key };
  });
}

export async function revokeApiKey(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_api_key");
  const workspace = await workspaceFor(pool, user, "admin");
  return transaction(pool, async (client) => {
    // The workspace row FOR SHARE first, as removeMember takes it, then the caller's membership (lockAdmin).
    await client.query("SELECT id FROM workspaces WHERE id=$1 FOR SHARE", [workspace]);
    await lockAdmin(client, workspace, user);
    const revoked = await client.query(
      `UPDATE api_keys SET revoked_at=clock_timestamp(),revoked_reason='revoked',revoked_by=$3
       WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL RETURNING ${LISTED_COLUMNS}`,
      [id, workspace, user.id],
    );
    if (!revoked.rows[0]) {
      const exists = await client.query("SELECT 1 FROM api_keys WHERE id=$1 AND workspace_id=$2", [id, workspace]);
      throw exists.rowCount ? new ApiError(409, "api_key_already_revoked") : new ApiError(404, "api_key_not_found");
    }
    await client.query("INSERT INTO api_key_events(workspace_id,api_key_id,kind,actor_id) VALUES($1,$2,'revoked',$3)", [workspace, id, user.id]);
    return revoked.rows[0];
  });
}

// Revokes every key the member made that is not revoked yet, expired ones included, in the caller's transaction
// that removes or demotes the member. The audit rows have no actor, like the automatic reminder cancellation.
export async function revokeMemberApiKeys(client: PoolClient, workspace: string, memberId: string, reason: ApiKeyRevocation): Promise<number> {
  const revoked = await client.query(
    `WITH revoked AS (
       UPDATE api_keys SET revoked_at=clock_timestamp(),revoked_reason=$3
       WHERE workspace_id=$1 AND created_by=$2 AND revoked_at IS NULL RETURNING id,workspace_id
     )
     INSERT INTO api_key_events(workspace_id,api_key_id,kind) SELECT workspace_id,id,$3 FROM revoked RETURNING api_key_id`,
    [workspace, memberId, reason],
  );
  return revoked.rowCount ?? 0;
}

export type AuthenticatedApiKey = { id: string; workspace_id: string; name: string; scopes: ApiKeyScope[]; expires_at: Date };

// One key row by the hash of the presented key; a revoked or expired key reads as unknown. The workspace has no
// state of its own to check, and deleting it deletes its keys.
export async function findActiveApiKey(pool: Pick<Pool, "query">, key: string): Promise<AuthenticatedApiKey | undefined> {
  if (!isApiKeyFormat(key)) return undefined;
  return (await pool.query<AuthenticatedApiKey>("SELECT id,workspace_id,name,scopes,expires_at FROM api_keys WHERE key_hash=$1 AND revoked_at IS NULL AND expires_at>now()", [apiKeyHash(key)])).rows[0];
}

// A client address in the CF-Connecting-IP form only; anything else is not stored.
export function clientIp(value: string | null): string | null {
  return value !== null && /^[0-9A-Fa-f.:]{2,45}$/.test(value) ? value : null;
}

// Stores the time and client address of an authenticated request, at most once a minute per key, so a busy key
// does not write on every request.
export async function recordApiKeyUse(pool: Pick<Pool, "query">, id: string, ip: string | null): Promise<void> {
  await pool.query(
    `UPDATE api_keys SET last_used_at=clock_timestamp(),last_used_ip=$2
     WHERE id=$1 AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at<=now()-interval '1 minute')`,
    [id, ip],
  );
}
