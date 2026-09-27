import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";

type Contact = {
  connection_id: string;
  sender_id: string;
  username: string | null;
  first_comment_at: Date;
  last_comment_at: Date;
  comment_count: string;
  tags: string[];
};
function tag(value: unknown): string {
  if (typeof value !== "string" || value.length > 200) throw new ApiError(400, "invalid_contact_tags");
  const result = value.trim().normalize("NFC").toLowerCase();
  if (!result || result.length > 40 || /[\p{Cc}\p{Cf}]/u.test(result)) throw new ApiError(400, "invalid_contact_tags");
  return result;
}
function senderIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function cursor(value: string | null): { connection_id: string; sender_id: string } | null {
  if (value === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const result: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(result) || !isUuid(result.connection_id) || !senderIdentity(result.sender_id)) throw new Error();
    return { connection_id: result.connection_id, sender_id: result.sender_id };
  } catch {
    throw new ApiError(400, "invalid_contact_request");
  }
}
export async function listContacts(pool: Pool, user: User, options: URLSearchParams = new URLSearchParams()) {
  for (const key of options.keys())
    if (!["connection_id", "tag", "after", "segment_id"].includes(key) || options.getAll(key).length !== 1)
      throw new ApiError(400, "invalid_contact_request");
  let connectionId = options.get("connection_id");
  if (connectionId !== null && !isUuid(connectionId)) throw new ApiError(400, "invalid_contact_request");
  let filterTag = options.has("tag") ? tag(options.get("tag")) : null;
  const segmentId = options.get("segment_id");
  if (segmentId !== null && (!isUuid(segmentId) || options.has("connection_id") || options.has("tag")))
    throw new ApiError(400, "invalid_contact_request");
  const after = cursor(options.get("after"));
  const workspaceId = await workspaceFor(pool, user);
  if (segmentId !== null) {
    const segment = await pool.query<{ connection_id: string | null; tag: string | null }>(
      "SELECT connection_id,tag FROM instagram_contact_segments WHERE workspace_id=$1 AND id=$2 AND NOT archived",
      [workspaceId, segmentId],
    );
    if (!segment.rows[0]) throw new ApiError(404, "segment_not_found");
    connectionId = segment.rows[0].connection_id;
    filterTag = segment.rows[0].tag;
  }
  const result = await pool.query<Contact>(
    `SELECT e.connection_id,e.sender_id,c.username,min(e.created_at) AS first_comment_at,
 max(e.created_at) AS last_comment_at,count(*)::text AS comment_count,coalesce(t.tags,'{}'::text[]) AS tags
 FROM instagram_comment_events e JOIN instagram_connections c ON c.id=e.connection_id AND c.workspace_id=e.workspace_id
 LEFT JOIN instagram_contact_tags t ON t.workspace_id=e.workspace_id AND t.connection_id=e.connection_id AND t.sender_id=e.sender_id
 WHERE e.workspace_id=$1 AND ($2::uuid IS NULL OR e.connection_id=$2)
 AND ($3::text IS NULL OR $3=ANY(t.tags))
 AND ($4::uuid IS NULL OR (e.connection_id,e.sender_id)>($4::uuid,$5::text))
 GROUP BY e.connection_id,e.sender_id,c.username,t.tags ORDER BY e.connection_id,e.sender_id LIMIT 51`,
    [workspaceId, connectionId, filterTag, after?.connection_id ?? null, after?.sender_id ?? null],
  );
  const contacts = result.rows.slice(0, 50);
  const last = contacts.at(-1);
  return {
    contacts,
    after:
      result.rows.length > 50 && last
        ? Buffer.from(JSON.stringify({ connection_id: last.connection_id, sender_id: last.sender_id })).toString(
            "base64url",
          )
        : null,
  };
}
export async function saveContactTags(pool: Pool, user: User, connectionId: string, senderId: string, input: unknown) {
  if (
    !isUuid(connectionId) ||
    !senderIdentity(senderId) ||
    !isRecord(input) ||
    !Array.isArray(input.tags) ||
    input.tags.length > 20
  )
    throw new ApiError(400, "invalid_contact_tags");
  const tags = [...new Set(input.tags.map(tag))].sort();
  const workspaceId = await workspaceFor(pool, user);
  const result = await pool.query(
    `INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags)
 SELECT $1,$2,$3,$4::text[] WHERE EXISTS(SELECT 1 FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3)
 ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET tags=EXCLUDED.tags RETURNING tags`,
    [workspaceId, connectionId, senderId, tags],
  );
  if (!result.rows[0]) throw new ApiError(404, "contact_not_found");
  return { tags: result.rows[0].tags };
}

export async function listContactSegments(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user);
  return (
    await pool.query(
      "SELECT id,name,connection_id,tag FROM instagram_contact_segments WHERE workspace_id=$1 AND NOT archived ORDER BY name,id",
      [workspace],
    )
  ).rows;
}

export async function createContactSegment(pool: Pool, user: User, input: unknown) {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !["name", "connection_id", "tag"].includes(key)) ||
    typeof input.name !== "string" ||
    input.name.length > 300
  )
    throw new ApiError(400, "invalid_segment");
  const name = input.name.trim().normalize("NFC");
  if (!name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new ApiError(400, "invalid_segment");
  const connectionId = input.connection_id ?? null;
  if (connectionId !== null && !isUuid(connectionId)) throw new ApiError(400, "invalid_segment");
  const filterTag = input.tag === undefined || input.tag === null || input.tag === "" ? null : tag(input.tag);
  const workspace = await workspaceFor(pool, user);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize creations so concurrent requests cannot exceed the active-segment limit.
    await client.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspace]);
    if (
      connectionId !== null &&
      !(
        await client.query("SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2", [
          connectionId,
          workspace,
        ])
      ).rows[0]
    )
      throw new ApiError(404, "connection_not_found");
    const result = await client.query(
      `INSERT INTO instagram_contact_segments(workspace_id,name,connection_id,tag)
 SELECT $1,$2,$3,$4 WHERE (SELECT count(*) FROM instagram_contact_segments WHERE workspace_id=$1 AND NOT archived)<50
 RETURNING id,name,connection_id,tag`,
      [workspace, name, connectionId, filterTag],
    );
    if (!result.rows[0]) throw new ApiError(409, "segment_limit_reached");
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    if (isRecord(error) && error.code === "23505") throw new ApiError(409, "segment_name_exists");
    throw error;
  } finally {
    client.release();
  }
}

export async function archiveContactSegment(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_segment");
  const workspace = await workspaceFor(pool, user);
  const result = await pool.query(
    "UPDATE instagram_contact_segments SET archived=true WHERE workspace_id=$1 AND id=$2 RETURNING id",
    [workspace, id],
  );
  if (!result.rows[0]) throw new ApiError(404, "segment_not_found");
  return { id: result.rows[0].id };
}
