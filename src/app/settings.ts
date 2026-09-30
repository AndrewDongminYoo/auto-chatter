import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
export async function ensureWorkspace(pool: Pool, user: User): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.id]);
    const existing = await client.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND removed_at IS NULL",
      [user.id],
    );
    let id = existing.rows[0]?.workspace_id;
    if (id) {
      // Keeps the email owners see in the member list current for members created before it was recorded.
      await client.query(
        "UPDATE workspace_members SET email=$2 WHERE user_id=$1 AND removed_at IS NULL AND email IS DISTINCT FROM $2",
        [user.id, normalizeEmail(user.email)],
      );
    } else {
      // A removed member starts over as the owner of a new workspace; their old row is reused.
      id = randomUUID();
      await client.query("INSERT INTO workspaces(id) VALUES($1)", [id]);
      await client.query(
        `INSERT INTO workspace_members(user_id,workspace_id,role,email) VALUES($1,$2,'owner',$3)
         ON CONFLICT(user_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,role='owner',email=EXCLUDED.email,
           removed_at=NULL,removed_by=NULL`,
        [user.id, id, normalizeEmail(user.email)],
      );
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
export type WorkspaceRole = "owner" | "admin" | "agent";
const ROLE_RANK: Record<WorkspaceRole, number> = { agent: 1, admin: 2, owner: 3 };

export function roleAllows(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

// Every workspace-scoped request states the least role it needs; membership and role are read per request,
// so a removal or downgrade applies to the next request after it commits.
export async function workspaceFor(pool: Pool, user: User, minimum: WorkspaceRole): Promise<string> {
  return (await membershipFor(pool, user, minimum)).workspace_id;
}

export async function membershipFor(
  pool: Pool,
  user: User,
  minimum: WorkspaceRole,
): Promise<{ workspace_id: string; role: WorkspaceRole }> {
  const result = await pool.query<{ workspace_id: string; role: WorkspaceRole }>(
    "SELECT workspace_id,role FROM workspace_members WHERE user_id=$1 AND removed_at IS NULL",
    [user.id],
  );
  const member = result.rows[0];
  if (!member) throw new ApiError(403, "workspace_required");
  if (!roleAllows(member.role, minimum)) throw new ApiError(403, "role_forbidden");
  return member;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
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
  const buttonTitle = text(input.confirmation_button_title ?? "", 20, false);
  if (
    buttonTitle &&
    (!input.follow_gate_enabled ||
      String(input.private_reply_text).length > 640 ||
      String(input.non_follower_reply_text).length > 640)
  )
    throw new ApiError(400, "invalid_confirmation_button");
  return {
    confirmation_button_title: buttonTitle,
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
  const workspaceId = await workspaceFor(pool, user, "agent");
  return (
    await pool.query(
      `SELECT id,account_id,username,active,send_enabled,inbox_enabled,token_expires_at,access_token_encrypted IS NOT NULL AS token_registered,
        CASE WHEN access_token_encrypted IS NULL THEN 'missing'
             WHEN token_expires_at IS NULL OR token_expires_at<=now() THEN 'expired'
             ELSE 'valid' END AS credential_status
       FROM instagram_connections WHERE workspace_id=$1 ORDER BY id`,
      [workspaceId],
    )
  ).rows;
}
export async function listRules(pool: Pool, user: User) {
  const workspaceId = await workspaceFor(pool, user, "agent");
  return (
    await pool.query(
      `SELECT id,connection_id,media_id,keyword,keywords,excluded_keywords,match_mode,private_reply_text,enabled,follow_gate_enabled,follower_reply_text,non_follower_reply_text,confirmation_keyword,confirmation_button_title FROM instagram_comment_rules WHERE workspace_id=$1 ORDER BY id`,
      [workspaceId],
    )
  ).rows;
}
export async function saveRule(pool: Pool, user: User, input: unknown) {
  const rule = parseRule(input);
  const workspaceId = await workspaceFor(pool, user, "admin");
  const write = async (db: Pick<Pool, "query">) => {
    const result = await db.query(
      rule.id
        ? `UPDATE instagram_comment_rules SET keyword=$5,keywords=$6,excluded_keywords=$7,match_mode=$8,
 private_reply_text=$9,enabled=$10,follow_gate_enabled=$11,follower_reply_text=$12,non_follower_reply_text=$13,confirmation_keyword=$14,confirmation_button_title=$15
 WHERE id=$1 AND workspace_id=$2 AND connection_id=$3 AND media_id=$4 RETURNING id`
        : `INSERT INTO instagram_comment_rules(id,workspace_id,connection_id,media_id,keyword,keywords,excluded_keywords,match_mode,private_reply_text,enabled,follow_gate_enabled,follower_reply_text,non_follower_reply_text,confirmation_keyword,confirmation_button_title)
 SELECT $1,$2,c.id,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15 FROM instagram_connections c WHERE c.id=$3 AND c.workspace_id=$2
 ON CONFLICT(connection_id,media_id) DO UPDATE SET keyword=EXCLUDED.keyword,keywords=EXCLUDED.keywords,excluded_keywords=EXCLUDED.excluded_keywords,match_mode=EXCLUDED.match_mode,private_reply_text=EXCLUDED.private_reply_text,enabled=EXCLUDED.enabled,follow_gate_enabled=EXCLUDED.follow_gate_enabled,follower_reply_text=EXCLUDED.follower_reply_text,non_follower_reply_text=EXCLUDED.non_follower_reply_text,confirmation_keyword=EXCLUDED.confirmation_keyword,confirmation_button_title=EXCLUDED.confirmation_button_title WHERE instagram_comment_rules.workspace_id=$2 RETURNING id`,
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
        rule.confirmation_button_title,
      ],
    );
    if (!result.rows[0]) throw new ApiError(404, "connection_not_found");
    return { id: result.rows[0].id };
  };
  if (!rule.enabled) return write(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Flow publish takes the same connection lock, so a rule and a published flow never share one media.
    await client.query("SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE", [
      rule.connection_id,
      workspaceId,
    ]);
    const conflict = await client.query(
      `SELECT 1 FROM flows f JOIN flow_versions v ON v.id=f.published_version_id
       WHERE f.workspace_id=$1 AND NOT f.archived AND v.trigger_connection_id=$2 AND v.trigger_media_id=$3 LIMIT 1`,
      [workspaceId, rule.connection_id, rule.media_id],
    );
    if (conflict.rows[0]) throw new ApiError(409, "flow_trigger_conflict");
    const saved = await write(client);
    await client.query("COMMIT");
    return saved;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function updateConnection(pool: Pool, user: User, id: string, input: unknown) {
  if (!isUuid(id) || !isRecord(input) || typeof input.active !== "boolean" || typeof input.send_enabled !== "boolean")
    throw new ApiError(400, "invalid_connection");
  const workspaceId = await workspaceFor(pool, user, "admin");
  const result = await pool.query(
    `UPDATE instagram_connections SET active=$3,send_enabled=$4,
 inbox_enabled_at=CASE WHEN $3 AND NOT active AND inbox_enabled THEN clock_timestamp() ELSE inbox_enabled_at END
 WHERE id=$1 AND workspace_id=$2
 AND (($3=false AND $4=false) OR (access_token_encrypted IS NOT NULL AND token_expires_at>now())) RETURNING id`,
    [id, workspaceId, input.active, input.send_enabled],
  );
  if (!result.rows[0]) throw new ApiError(409, "connection_unavailable");
  return { id };
}
export async function disconnectConnection(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_connection");
  const workspaceId = await workspaceFor(pool, user, "admin");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Flows first, all of them: enabling or publishing locks one flow row before its trigger connection
    // row, so waiting here lets a concurrent enable commit and be turned off below, and any later one
    // finds the connection inactive. A row skipped by the filter alone would not wait. NO KEY UPDATE
    // still conflicts with their FOR UPDATE but not with the KEY SHARE that comment ingestion's foreign
    // key checks hold on flows, so a multi-comment ingestion batch cannot deadlock with this.
    await client.query("SELECT id FROM flows WHERE workspace_id=$1 ORDER BY id FOR NO KEY UPDATE", [workspaceId]);
    await client.query(
      `UPDATE flows f SET enabled=false,updated_at=clock_timestamp() FROM flow_versions v
       WHERE v.id=f.published_version_id AND v.trigger_connection_id=$1 AND f.workspace_id=$2 AND f.enabled`,
      [id, workspaceId],
    );
    await client.query(
      `WITH disconnected AS (UPDATE instagram_connections SET active=false,send_enabled=false,access_token_encrypted=NULL,token_expires_at=NULL
 WHERE id=$1 AND workspace_id=$2 RETURNING id) UPDATE instagram_comment_rules SET enabled=false WHERE connection_id IN(SELECT id FROM disconnected) AND workspace_id=$2`,
      [id, workspaceId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { disconnected: true };
}
export async function listActivity(pool: Pool, user: User) {
  const workspaceId = await workspaceFor(pool, user, "agent");
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
