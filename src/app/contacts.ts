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
    if (!["connection_id", "tag", "after"].includes(key) || options.getAll(key).length !== 1)
      throw new ApiError(400, "invalid_contact_request");
  const connectionId = options.get("connection_id");
  if (connectionId !== null && !isUuid(connectionId)) throw new ApiError(400, "invalid_contact_request");
  const filterTag = options.has("tag") ? tag(options.get("tag")) : null;
  const after = cursor(options.get("after"));
  const workspaceId = await workspaceFor(pool, user);
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
