import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { sealSecret } from "./secrets.ts";
import { lockWorkspaceForMember, workspaceFor } from "./settings.ts";
import { parseWebhookUrl, signingKeyContext } from "./webhook-delivery.ts";

// Administration of outbound webhook endpoints, their signing keys and deliveries (#47). Every route needs
// the admin role: an endpoint address can carry credentials in its path or query.
export const MAX_ACTIVE_WEBHOOK_ENDPOINTS = 5;
const DELIVERY_HISTORY_LIMIT = 50;

function encryptionKey(env: { TOKEN_ENCRYPTION_KEY?: string }): string {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new ApiError(503, "webhooks_unavailable");
  return env.TOKEN_ENCRYPTION_KEY;
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

// A new signing key in the given slot. The secret is returned to the caller once and stored only sealed.
async function addSigningKey(
  client: PoolClient,
  workspace: string,
  endpoint: string,
  slot: number,
  key: string,
): Promise<{ id: string; secret: string }> {
  const id = randomUUID();
  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  await client.query(
    "INSERT INTO webhook_signing_keys(id,workspace_id,endpoint_id,slot,secret_encrypted) VALUES($1,$2,$3,$4,$5)",
    [id, workspace, endpoint, slot, sealSecret(secret, key, signingKeyContext(workspace, endpoint, id))],
  );
  return { id, secret };
}

// The endpoint row, locked FOR NO KEY UPDATE: that serializes key changes of one endpoint without blocking
// the foreign-key checks of a flow run that queues a delivery to it.
async function lockEndpoint(client: PoolClient, workspace: string, id: string): Promise<void> {
  const endpoint = await client.query(
    "SELECT 1 FROM webhook_endpoints WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE",
    [id, workspace],
  );
  if (!endpoint.rowCount) throw new ApiError(404, "webhook_endpoint_not_found");
}

export async function listWebhookEndpoints(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user, "admin");
  return (
    await pool.query(
      `SELECT endpoint.id,endpoint.name,endpoint.url,endpoint.active,endpoint.created_at,endpoint.updated_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object('id',key.id,'created_at',key.created_at) ORDER BY key.created_at,key.id)
           FROM webhook_signing_keys key WHERE key.endpoint_id=endpoint.id AND key.retired_at IS NULL),'[]'::jsonb) AS keys
       FROM webhook_endpoints endpoint WHERE endpoint.workspace_id=$1 ORDER BY endpoint.created_at,endpoint.id`,
      [workspace],
    )
  ).rows;
}

export async function createWebhookEndpoint(
  pool: Pool,
  user: User,
  input: unknown,
  env: { TOKEN_ENCRYPTION_KEY?: string },
) {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !["name", "url"].includes(key)) ||
    typeof input.name !== "string" ||
    input.name.length > 300
  )
    throw new ApiError(400, "invalid_webhook_endpoint");
  const name = input.name.trim().normalize("NFC");
  if (!name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new ApiError(400, "invalid_webhook_endpoint");
  // The same URL rules as delivery, without the DNS check: the name is resolved before every request.
  const url = parseWebhookUrl(input.url);
  if (!url) throw new ApiError(400, "invalid_webhook_url");
  const workspace = await workspaceFor(pool, user, "admin");
  const key = encryptionKey(env);
  return transaction(pool, async (client) => {
    await lockWorkspaceForMember(client, workspace, user, "admin");
    const id = randomUUID();
    const created = await client.query(
      `INSERT INTO webhook_endpoints(id,workspace_id,name,url) SELECT $1,$2,$3,$4
       WHERE (SELECT count(*) FROM webhook_endpoints WHERE workspace_id=$2 AND active)<$5
       RETURNING id,name,url,active,created_at`,
      [id, workspace, name, url.href, MAX_ACTIVE_WEBHOOK_ENDPOINTS],
    );
    if (!created.rows[0]) throw new ApiError(409, "webhook_endpoint_limit_reached");
    return { ...created.rows[0], key: await addSigningKey(client, workspace, id, 1, key) };
  });
}

export async function setWebhookEndpointActive(pool: Pool, user: User, id: string, active: boolean) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_webhook_endpoint");
  const workspace = await workspaceFor(pool, user, "admin");
  return transaction(pool, async (client) => {
    // The active limit is counted under the workspace lock, as at creation.
    if (active) await lockWorkspaceForMember(client, workspace, user, "admin");
    const changed = await client.query(
      `UPDATE webhook_endpoints SET active=$3,updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2
         AND (NOT $3 OR active OR (SELECT count(*) FROM webhook_endpoints WHERE workspace_id=$2 AND active)<$4)
       RETURNING active`,
      [id, workspace, active, MAX_ACTIVE_WEBHOOK_ENDPOINTS],
    );
    if (changed.rows[0]) return { active };
    const exists = await client.query("SELECT 1 FROM webhook_endpoints WHERE id=$1 AND workspace_id=$2", [
      id,
      workspace,
    ]);
    throw exists.rowCount
      ? new ApiError(409, "webhook_endpoint_limit_reached")
      : new ApiError(404, "webhook_endpoint_not_found");
  });
}

// Adds a second valid key and returns its secret once. Both keys sign every delivery until the older one is
// retired, so the receiver can switch secrets without losing a delivery.
export async function rotateWebhookKey(pool: Pool, user: User, id: string, env: { TOKEN_ENCRYPTION_KEY?: string }) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_webhook_endpoint");
  const workspace = await workspaceFor(pool, user, "admin");
  const key = encryptionKey(env);
  return transaction(pool, async (client) => {
    await lockEndpoint(client, workspace, id);
    const valid = await client.query<{ slot: number }>(
      "SELECT slot FROM webhook_signing_keys WHERE endpoint_id=$1 AND retired_at IS NULL",
      [id],
    );
    if (valid.rows.length >= 2) throw new ApiError(409, "webhook_rotation_in_progress");
    return { key: await addSigningKey(client, workspace, id, valid.rows[0]?.slot === 1 ? 2 : 1, key) };
  });
}

// Retires the older of two valid keys and removes its sealed secret. The last valid key is never retired.
export async function retireWebhookKey(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_webhook_endpoint");
  const workspace = await workspaceFor(pool, user, "admin");
  return transaction(pool, async (client) => {
    await lockEndpoint(client, workspace, id);
    const valid = await client.query<{ id: string }>(
      "SELECT id FROM webhook_signing_keys WHERE endpoint_id=$1 AND retired_at IS NULL ORDER BY created_at,id",
      [id],
    );
    if (valid.rows.length < 2) throw new ApiError(409, "webhook_key_required");
    await client.query(
      "UPDATE webhook_signing_keys SET retired_at=clock_timestamp(),secret_encrypted=NULL WHERE id=$1",
      [valid.rows[0]!.id],
    );
    return { retired_key_id: valid.rows[0]!.id, key_id: valid.rows[1]!.id };
  });
}

// Recent deliveries with their result only: no payload and no sender.
export async function listWebhookDeliveries(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user, "admin");
  return (
    await pool.query(
      `SELECT event_id,endpoint_id,flow_id,flow_run_id,node_id,status,attempt_count,next_attempt_at,
         last_status_code,failure_code,created_at,sent_at
       FROM webhook_deliveries WHERE workspace_id=$1 ORDER BY created_at DESC,event_id LIMIT $2`,
      [workspace, DELIVERY_HISTORY_LIMIT],
    )
  ).rows;
}

// Queues a dead delivery again with the same event ID and a fresh attempt schedule, and records who asked.
// The connection is locked FOR SHARE before the delivery row, so this serializes with the deletion functions.
export async function redeliverWebhook(pool: Pool, user: User, eventId: string) {
  if (!isUuid(eventId)) throw new ApiError(400, "invalid_webhook_delivery");
  const workspace = await workspaceFor(pool, user, "admin");
  return transaction(pool, async (client) => {
    const found = await client.query<{ connection_id: string }>(
      "SELECT connection_id FROM webhook_deliveries WHERE event_id=$1 AND workspace_id=$2",
      [eventId, workspace],
    );
    if (!found.rows[0]) throw new ApiError(404, "webhook_delivery_not_found");
    await client.query("SELECT 1 FROM instagram_connections WHERE id=$1 AND workspace_id=$2 FOR SHARE", [
      found.rows[0].connection_id,
      workspace,
    ]);
    const delivery = (
      await client.query<{ status: string; connection_id: string; endpoint_active: boolean }>(
        `SELECT delivery.status,delivery.connection_id,endpoint.active AS endpoint_active
         FROM webhook_deliveries delivery JOIN webhook_endpoints endpoint ON endpoint.id=delivery.endpoint_id
         WHERE delivery.event_id=$1 AND delivery.workspace_id=$2 FOR UPDATE OF delivery`,
        [eventId, workspace],
      )
    ).rows[0];
    if (!delivery) throw new ApiError(404, "webhook_delivery_not_found");
    if (delivery.status !== "dead") throw new ApiError(409, "webhook_delivery_not_dead");
    if (!delivery.endpoint_active) throw new ApiError(409, "webhook_endpoint_inactive");
    await client.query(
      "INSERT INTO webhook_redelivery_events(workspace_id,connection_id,delivery_event_id,actor_id) VALUES($1,$2,$3,$4)",
      [workspace, delivery.connection_id, eventId, user.id],
    );
    await client.query(
      `UPDATE webhook_deliveries SET status='pending',attempt_count=0,attempt_id=NULL,next_attempt_at=now(),
         failure_code=NULL,last_status_code=NULL,updated_at=clock_timestamp() WHERE event_id=$1`,
      [eventId],
    );
    return { event_id: eventId, status: "pending" };
  });
}
