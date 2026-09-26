import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
export async function ensureWorkspace(pool: Pool, user: User): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.id]);
    const existing = await client.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM workspace_members WHERE user_id=$1",
      [user.id],
    );
    let id = existing.rows[0]?.workspace_id;
    if (!id) {
      id = randomUUID();
      await client.query("INSERT INTO workspaces(id) VALUES($1)", [id]);
      await client.query("INSERT INTO workspace_members(user_id,workspace_id) VALUES($1,$2)", [user.id, id]);
    }
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
export async function workspaceFor(pool: Pool, user: User): Promise<string> {
  const result = await pool.query<{ workspace_id: string }>(
    "SELECT workspace_id FROM workspace_members WHERE user_id=$1",
    [user.id],
  );
  if (!result.rows[0]) throw new ApiError(403, "workspace_required");
  return result.rows[0].workspace_id;
}
function text(value: unknown, max: number, required = true): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim()))
    throw new ApiError(400, "invalid_rule");
  return value.trim().normalize("NFC");
}
function keywords(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400, "invalid_keywords");
  return [...new Set(value.map((x) => text(x, 100).toLowerCase()))];
}
export function parseRule(input: unknown) {
  if (
    !isRecord(input) ||
    !isUuid(input.connection_id) ||
    (input.id !== undefined && !isUuid(input.id)) ||
    typeof input.media_id !== "string" ||
    !/^\d{1,40}$/.test(input.media_id) ||
    !["contains", "exact", "all"].includes(String(input.match_mode)) ||
    typeof input.enabled !== "boolean" ||
    typeof input.follow_gate_enabled !== "boolean"
  )
    throw new ApiError(400, "invalid_rule");
  const included = keywords(input.keywords),
    excluded = keywords(input.excluded_keywords);
  if (input.match_mode !== "all" && !included.length) throw new ApiError(400, "keywords_required");
  return {
    id: input.id as string | undefined,
    connection_id: input.connection_id,
    media_id: input.media_id,
    keywords: included,
    excluded_keywords: excluded,
    match_mode: input.match_mode as "contains" | "exact" | "all",
    private_reply_text: text(input.private_reply_text, 1000),
    enabled: input.enabled,
    follow_gate_enabled: input.follow_gate_enabled,
    follower_reply_text: text(input.follower_reply_text ?? "", 1000, input.follow_gate_enabled),
    non_follower_reply_text: text(input.non_follower_reply_text ?? "", 1000, input.follow_gate_enabled),
    confirmation_keyword: text(input.confirmation_keyword ?? "확인", 100),
  };
}
export async function listConnections(pool: Pool, user: User) {
  const workspaceId = await workspaceFor(pool, user);
  return (
    await pool.query(
      `SELECT id,account_id,username,active,send_enabled,token_expires_at,access_token_encrypted IS NOT NULL AS token_registered FROM instagram_connections WHERE workspace_id=$1 ORDER BY id`,
      [workspaceId],
    )
  ).rows;
}
export async function listRules(pool: Pool, user: User) {
  const workspaceId = await workspaceFor(pool, user);
  return (
    await pool.query(
      `SELECT id,connection_id,media_id,keyword,keywords,excluded_keywords,match_mode,private_reply_text,enabled,follow_gate_enabled,follower_reply_text,non_follower_reply_text,confirmation_keyword FROM instagram_comment_rules WHERE workspace_id=$1 ORDER BY id`,
      [workspaceId],
    )
  ).rows;
}
export async function saveRule(pool: Pool, user: User, input: unknown) {
  const rule = parseRule(input);
  const workspaceId = await workspaceFor(pool, user);
  const result = await pool.query(
    rule.id
      ? `UPDATE instagram_comment_rules SET keyword=$5,keywords=$6,excluded_keywords=$7,match_mode=$8,
 private_reply_text=$9,enabled=$10,follow_gate_enabled=$11,follower_reply_text=$12,non_follower_reply_text=$13,confirmation_keyword=$14
 WHERE id=$1 AND workspace_id=$2 AND connection_id=$3 AND media_id=$4 RETURNING id`
      : `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,keywords,excluded_keywords,match_mode,private_reply_text,enabled,follow_gate_enabled,follower_reply_text,non_follower_reply_text,confirmation_keyword)
 SELECT $1,$2,c.id,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14 FROM instagram_connections c WHERE c.id=$3 AND c.workspace_id=$2
 ON CONFLICT(connection_id,media_id) DO UPDATE SET keyword=EXCLUDED.keyword,keywords=EXCLUDED.keywords,excluded_keywords=EXCLUDED.excluded_keywords,match_mode=EXCLUDED.match_mode,private_reply_text=EXCLUDED.private_reply_text,enabled=EXCLUDED.enabled,follow_gate_enabled=EXCLUDED.follow_gate_enabled,follower_reply_text=EXCLUDED.follower_reply_text,non_follower_reply_text=EXCLUDED.non_follower_reply_text,confirmation_keyword=EXCLUDED.confirmation_keyword WHERE instagram_comment_rules.workspace_id=$2 RETURNING id`,
    [
      rule.id ?? randomUUID(),
      workspaceId,
      rule.connection_id,
      rule.media_id,
      rule.keywords[0] ?? "*",
      rule.keywords,
      rule.excluded_keywords,
      rule.match_mode,
      rule.private_reply_text,
      rule.enabled,
      rule.follow_gate_enabled,
      rule.follower_reply_text,
      rule.non_follower_reply_text,
      rule.confirmation_keyword,
    ],
  );
  if (!result.rows[0]) throw new ApiError(404, "connection_not_found");
  return { id: result.rows[0].id };
}
export async function updateConnection(pool: Pool, user: User, id: string, input: unknown) {
  if (!isUuid(id) || !isRecord(input) || typeof input.active !== "boolean" || typeof input.send_enabled !== "boolean")
    throw new ApiError(400, "invalid_connection");
  const workspaceId = await workspaceFor(pool, user);
  const result = await pool.query(
    `UPDATE instagram_connections SET active=$3,send_enabled=$4 WHERE id=$1 AND workspace_id=$2
 AND (($3=false AND $4=false) OR (access_token_encrypted IS NOT NULL AND token_expires_at>now())) RETURNING id`,
    [id, workspaceId, input.active, input.send_enabled],
  );
  if (!result.rows[0]) throw new ApiError(409, "connection_unavailable");
  return { id };
}
export async function disconnectConnection(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_connection");
  const workspaceId = await workspaceFor(pool, user);
  await pool.query(
    `WITH disconnected AS (UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL,token_expires_at=NULL
 WHERE id=$1 AND workspace_id=$2 RETURNING id) UPDATE instagram_comment_rules SET enabled=false WHERE connection_id IN(SELECT id FROM disconnected) AND workspace_id=$2`,
    [id, workspaceId],
  );
  return { disconnected: true };
}
export async function listActivity(pool: Pool, user: User) {
  const workspaceId = await workspaceFor(pool, user);
  return (
    await pool.query(
      `SELECT reply.id,reply.connection_id,reply.media_id,reply.status AS first_reply_status,reply.failure_code AS first_reply_error,
 flow.status AS follow_reply_status,flow.follow_status,flow.failure_code AS follow_reply_error,reply.created_at
 FROM private_reply_outbox reply LEFT JOIN instagram_follow_conversations flow ON flow.reply_id=reply.id
 WHERE reply.workspace_id=$1 ORDER BY reply.created_at DESC,reply.id DESC LIMIT 50`,
      [workspaceId],
    )
  ).rows;
}
