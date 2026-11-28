import type { Pool, QueryConfig } from "pg";
import { ApiError, isUuid } from "./auth.ts";
import { CONTACT_ROWS_SQL, type CsvContact } from "./contact-csv.ts";

// GET /v1/contacts (#48): the workspace's comment contacts in pages, with the same information as the contact CSV v1.
// Every page is one read statement without a transaction or a lock, so a contact that is recorded during a full read
// at a position the client has already passed is not in that read.

export const MAX_CONTACTS_PAGE = 100;
// The same budget as the contact CSV export, but only as a client-side read timeout: the page takes no transaction, so
// it sets no statement_timeout, and pg sends no cancel request, so the statement can run on after a timeout.
const PAGE_TIMEOUT_MS = 10_000;
const QUERY_KEYS = ["after", "connection_id", "limit"];

export type ContactsCursor = { connectionId: string; senderId: string };
export type ContactsPageRequest = { limit: number; after: ContactsCursor | null; connectionId: string | null };

function invalid(): ApiError {
  return new ApiError(400, "invalid_request");
}

// The cursor is the position of the last contact of a page. Clients pass it back unchanged and do not read it.
export function encodeContactsCursor(cursor: ContactsCursor): string {
  return Buffer.from(JSON.stringify([cursor.connectionId, cursor.senderId]), "utf8").toString("base64url");
}

// Only the canonical encoding of a JSON array of a connection UUID and a sender ID is accepted. Stored sender IDs have
// no length limit, so the cursor has none either: every issued cursor must decode, and the platform's URL limit bounds
// the request. PostgreSQL text cannot hold NUL, so no stored sender ID contains one.
export function decodeContactsCursor(value: string): ContactsCursor {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalid();
  const [connectionId, senderId] = parsed as unknown[];
  if (!isUuid(connectionId) || typeof senderId !== "string" || !senderId || senderId.includes("\0")) throw invalid();
  return { connectionId: connectionId.toLowerCase(), senderId };
}

// An unknown or repeated key, a limit outside 1-100, a malformed cursor or connection ID, and a cursor of another
// connection than connection_id are all 400 invalid_request.
export function parseContactsQuery(params: URLSearchParams): ContactsPageRequest {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length || keys.some((key) => !QUERY_KEYS.includes(key))) throw invalid();
  const rawLimit = params.get("limit");
  let limit = MAX_CONTACTS_PAGE;
  if (rawLimit !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > MAX_CONTACTS_PAGE) throw invalid();
    limit = Number(rawLimit);
  }
  const rawConnection = params.get("connection_id");
  if (rawConnection !== null && !isUuid(rawConnection)) throw invalid();
  const connectionId = rawConnection?.toLowerCase() ?? null;
  const rawAfter = params.get("after");
  const after = rawAfter === null ? null : decodeContactsCursor(rawAfter);
  if (after && connectionId && after.connectionId !== connectionId) throw invalid();
  return { limit, after, connectionId };
}

export type ContactsPage = { found: boolean; rows: CsvContact[]; nextCursor: string | null };

// One statement reads at most limit+1 contacts after the cursor, always under the key's workspace, and whether
// connection_id names a connection of that workspace. A connection of another workspace reads the same as one that
// does not exist. The cursor is only a position: it is never checked against a workspace.
//
// The cursor range, the grouping and both orders use the column's own collation, not "C" as the CSV export does, so
// that instagram_comment_events_contact_lookup_idx (workspace_id, connection_id, sender_id) drives the read and a
// page aggregates only the comments of its own contacts. The connection and cursor conditions are in the statement
// text only when the request has them, so that a generic plan also keeps them as index conditions.
export async function readContactsPage(pool: Pick<Pool, "query">, workspaceId: string, request: ContactsPageRequest): Promise<ContactsPage> {
  const values: unknown[] = [workspaceId, request.connectionId, request.limit + 1];
  const conditions = ["e.workspace_id=$1"];
  if (request.connectionId) conditions.push("e.connection_id=$2::uuid");
  if (request.after) {
    values.push(request.after.connectionId, request.after.senderId);
    conditions.push("(e.connection_id,e.sender_id)>($4::uuid,$5::text)");
  }
  // pg supports per-query read timeout at runtime; its QueryConfig declarations omit this property.
  const config: QueryConfig & { query_timeout: number } = {
    text: `WITH owned AS (
           SELECT $2::uuid IS NULL OR EXISTS(SELECT 1 FROM instagram_connections WHERE id=$2::uuid AND workspace_id=$1) AS found
         ), contacts AS (
           SELECT e.connection_id,e.sender_id,min(e.created_at) AS first_at,max(e.created_at) AS last_at,count(*)::text AS comment_count
           FROM instagram_comment_events e JOIN instagram_connections c ON c.id=e.connection_id AND c.workspace_id=e.workspace_id
           WHERE ${conditions.join(" AND ")}
           GROUP BY e.connection_id,e.sender_id ORDER BY e.connection_id,e.sender_id LIMIT $3
         ), page AS (
         ${CONTACT_ROWS_SQL}
         )
         SELECT owned.found,page.* FROM owned LEFT JOIN page ON true ORDER BY page.connection_id,page.sender_id`,
    values,
    query_timeout: PAGE_TIMEOUT_MS,
  };
  const result = await pool.query<CsvContact & { found: boolean }>(config);
  const found = result.rows[0]?.found === true;
  const rows = result.rows.filter((row) => row.connection_id !== null);
  if (rows.length <= request.limit) return { found, rows, nextCursor: null };
  const page = rows.slice(0, request.limit);
  const last = page.at(-1)!;
  return { found, rows: page, nextCursor: encodeContactsCursor({ connectionId: last.connection_id, senderId: last.sender_id }) };
}

// One contact's JSON text. tags_json and fields_json are PostgreSQL's JSON text, inserted unchanged so that no number
// passes through a JavaScript number. Unlike the CSV, no value carries the spreadsheet quote marker. The contact
// write answers with the same text.
export function contactJson(row: CsvContact): string {
  const scalars = JSON.stringify({
    channel: "instagram",
    identity_kind: "comment_sender",
    connection_id: row.connection_id,
    sender_id: row.sender_id,
    connection_username: row.username,
    first_comment_recorded_at: row.first_at,
    last_comment_recorded_at: row.last_at,
    comment_count: row.comment_count,
    automation_paused: row.paused,
  });
  return `${scalars.slice(0, -1)},"tags":${row.tags_json},"fields":${row.fields_json}}`;
}

// The response text of one page.
export function contactsPageJson(page: ContactsPage): string {
  return `{"contacts":[${page.rows.map(contactJson).join(",")}],"next_cursor":${JSON.stringify(page.nextCursor)}}`;
}
