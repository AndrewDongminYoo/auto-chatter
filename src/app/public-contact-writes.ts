import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid } from "./auth.ts";
import { CONTACT_ROWS_SQL, type CsvContact } from "./contact-csv.ts";
import { isValidFieldValue, lockContact, type SqlReader } from "./contact-fields.ts";
import { CONTACT_TAG_LIMIT, CURRENT_CONTACT_TAGS_SQL, normalizeContactTags, normalizedStoredTag } from "./contacts.ts";

// PATCH /v1/contacts/{connection_id}/{sender_id} and GET /v1/fields (#48, docs/specs/2026-11-27-public-contact-writes-design.md).
// An external system adds and removes tags of one existing comment contact and sets or clears its field values. A
// tag the request does not name stays, so a write never removes a tag an agent added in the dashboard. Every change
// sets a result state, so a repeated request gives the same result. No stored tag or field proves messaging consent
// or delivery eligibility, and a write sends nothing.

export const CONTACT_WRITE_REQUEST_BYTES = 16_384;
export const MAX_CONTACT_WRITE_FIELDS = 20;

export type ContactWriteTarget = { connectionId: string; senderId: string };
// The tag lists hold sorted, unique single-pass normalized tags, and the fields are in field ID order with lowercase IDs.
export type ContactWrite = { add: string[]; remove: string[]; fields: [string, unknown][] };

function invalid(): ApiError {
  return new ApiError(400, "invalid_request");
}

function invalidValue(): ApiError {
  return new ApiError(400, "invalid_field_value");
}

// The two path segments. A connection ID that is not a UUID, and a sender ID that does not decode, is empty or
// contains NUL (which PostgreSQL text cannot hold), are 400 invalid_request.
export function parseContactWriteTarget(connection: string, sender: string): ContactWriteTarget {
  if (!isUuid(connection)) throw invalid();
  let senderId: string;
  try {
    senderId = decodeURIComponent(sender);
  } catch {
    throw invalid();
  }
  if (!senderId.trim() || senderId.includes("\0")) throw invalid();
  return { connectionId: connection.toLowerCase(), senderId };
}

// A request tag is kept in the dashboard's single-pass form (normalizeContactTags), which is the form the dashboard
// save stores and flow and segment conditions compare. Two single-pass forms of one normalizedStoredTag form (such as
// "j" + U+030C and U+01F0) both stay, as the dashboard save keeps both: a segment condition matches only its own form.
function tagList(value: unknown): string[] {
  if (value === undefined) return [];
  try {
    return normalizeContactTags(value);
  } catch {
    throw invalid();
  }
}

// True when one JSON object of the text names a key twice. JSON.parse keeps only the last value of a repeated key, so
// {"fields":{"<id>":true,"<id>":false}} would otherwise be read as one field. The text must be valid JSON: outside
// strings, only the structural characters matter, and a key is compared after its escapes are decoded.
export function hasDuplicateJsonKey(text: string): boolean {
  const containers: (Set<string> | null)[] = [];
  let expectKey = false;
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],]/g)) {
    const top = containers.at(-1);
    if (token === "{") {
      containers.push(new Set());
      expectKey = true;
    } else if (token === "[") {
      containers.push(null);
      expectKey = false;
    } else if (token === "}" || token === "]") {
      containers.pop();
      expectKey = false;
    } else if (token === ",") {
      expectKey = top instanceof Set;
    } else if (expectKey && top) {
      const key = JSON.parse(token) as string;
      if (top.has(key)) return true;
      top.add(key);
      expectKey = false;
    }
  }
  return false;
}

// The decimal value a JSON number literal denotes, as significant digits and an exponent, so two literals of the same
// value compare equal ("1.50" and "15e-1"). JavaScript's String(number) is such a literal for every finite number.
function decimalValue(literal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!match) return literal;
  const fraction = match[3] ?? "";
  const digits = (match[2]! + fraction).replace(/^0+/, "");
  if (!digits) return "0";
  const significant = digits.replace(/0+$/, "");
  return `${match[1]}${significant}e${BigInt(match[4] ?? 0) - BigInt(fraction.length) + BigInt(digits.length - significant.length)}`;
}

// A number that JavaScript cannot hold exactly is read as this value, which every field type refuses.
const INEXACT_NUMBER = Object.freeze({ inexact: true });

// The reviver of the request body. JSON.parse rounds a number to the nearest double, so 9007199254740993 would be
// stored as 9007199254740992 and answered 200. A number whose double does not denote the same decimal value as its
// source text becomes INEXACT_NUMBER and the write is 400 invalid_field_value. Without the source text (a runtime
// that does not pass it), every number is refused rather than possibly changed.
export function exactNumberReviver(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value !== "number") return value;
  const source = context?.source;
  return source !== undefined && Number.isFinite(value) && decimalValue(source) === decimalValue(String(value)) ? value : INEXACT_NUMBER;
}

// The request body text: JSON read with exactNumberReviver, refused (400 invalid_request through readWriteBody) when an
// object names a key twice.
export function parseContactWriteBody(text: string): unknown {
  const value: unknown = JSON.parse(text, exactNumberReviver);
  if (hasDuplicateJsonKey(text)) throw invalid();
  return value;
}

// The request body: { tags?: { add?: [...], remove?: [...] }, fields?: { "<field ID>": value | null } }. Tags pass
// the dashboard's normalization; each list holds at most 20. A tag in both lists, an unknown key, more than 20 fields,
// a field ID named twice and a body with no change are 400 invalid_request. A field value that is not a string,
// number, boolean or null, or a string that PostgreSQL's jsonb cannot hold, is 400 invalid_field_value; the type of
// each field is checked against the database in checkContactWriteFields.
export function parseContactWrite(input: unknown): ContactWrite {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "tags" && key !== "fields")) throw invalid();
  let add: string[] = [];
  let remove: string[] = [];
  if (input.tags !== undefined) {
    if (!isRecord(input.tags) || Object.keys(input.tags).some((key) => key !== "add" && key !== "remove")) throw invalid();
    add = tagList(input.tags.add);
    remove = tagList(input.tags.remove);
    const removeForms = new Set(remove.map(normalizedStoredTag));
    if (add.some((tag) => removeForms.has(normalizedStoredTag(tag)))) throw invalid();
  }
  const fields = new Map<string, unknown>();
  if (input.fields !== undefined) {
    if (!isRecord(input.fields)) throw invalid();
    const entries = Object.entries(input.fields);
    if (entries.length > MAX_CONTACT_WRITE_FIELDS) throw invalid();
    for (const [id, value] of entries) {
      if (!isUuid(id) || fields.has(id.toLowerCase())) throw invalid();
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw invalidValue();
      // A lone surrogate survives JSON.parse but not PostgreSQL's jsonb input.
      if (typeof value === "string" && /\p{Cs}/u.test(value)) throw invalidValue();
      fields.set(id.toLowerCase(), value);
    }
  }
  if (!add.length && !remove.length && !fields.size) throw invalid();
  return { add, remove, fields: [...fields].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) };
}

// Reads the active fields of the workspace among the request's field IDs in ID order, FOR SHARE inside the write
// transaction. A missing, archived or foreign field is 404 field_not_found, and a value of the wrong type for its
// field is 400 invalid_field_value; null clears any type. A field's type never changes, only its archive state.
export async function checkContactWriteFields(db: SqlReader, workspaceId: string, fields: ContactWrite["fields"], lock = false): Promise<void> {
  if (!fields.length) return;
  const rows = (await db.query<{ id: string; type: string }>(`SELECT id::text,type FROM instagram_contact_fields WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND NOT archived ORDER BY id${lock ? " FOR SHARE" : ""}`, [workspaceId, fields.map(([id]) => id)])).rows;
  if (rows.length !== fields.length) throw new ApiError(404, "field_not_found");
  const types = new Map(rows.map((row) => [row.id, row.type]));
  for (const [id, value] of fields) if (value !== null && !isValidFieldValue(types.get(id)!, value)) throw invalidValue();
}

// The contact's row in the shape of GET /v1/contacts, read with CONTACT_ROWS_SQL.
const CONTACT_ROW_SQL = `WITH contacts AS (
  SELECT connection_id,sender_id,min(created_at) AS first_at,max(created_at) AS last_at,count(*)::text AS comment_count
  FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3 GROUP BY connection_id,sender_id
)
${CONTACT_ROWS_SQL}`;

async function transaction<T>(pool: Pick<Pool, "connect">, work: (client: PoolClient) => Promise<T>): Promise<T> {
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

// Applies one write in one transaction, all or nothing, and returns the contact as it is after the write. The
// workspace row comes first, FOR KEY SHARE: the tag and field inserts take that lock through their foreign keys
// anyway, and delete_workspace_data locks the workspace FOR UPDATE before its connections, so taking it after the
// connection could deadlock with a workspace deletion. Then come the dashboard saves' locks: the connection row FOR
// SHARE (which serializes with data deletion), the fields FOR SHARE in ID order, then lockContact. The tags are read after lockContact and the result computed from them, so
// a concurrent dashboard save, flow run or other write is never lost. Removal comes before addition; a result of
// more than 20 tags is 409 contact_tag_limit. A null value is stored as NULL, as the dashboard's clear does.
export async function writeContact(pool: Pick<Pool, "connect">, workspaceId: string, target: ContactWriteTarget, write: ContactWrite): Promise<CsvContact> {
  return transaction(pool, async (client) => {
    await client.query("SELECT 1 FROM workspaces WHERE id=$1 FOR KEY SHARE", [workspaceId]);
    const connection = await client.query("SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2 FOR SHARE", [target.connectionId, workspaceId]);
    if (!connection.rows[0]) throw new ApiError(404, "connection_not_found");
    await checkContactWriteFields(client, workspaceId, write.fields, true);
    await lockContact(client, target.connectionId, target.senderId);
    const key = [workspaceId, target.connectionId, target.senderId];
    const current = (await client.query<{ found: boolean; tags: string[] | null }>(CURRENT_CONTACT_TAGS_SQL, key)).rows[0]!;
    if (!current.found) throw new ApiError(404, "contact_not_found");
    if (write.add.length || write.remove.length) {
      // A removed tag is matched by its normalizedStoredTag form, so a tag sent back as GET returned it is removed even
      // when the normalization changes it again. An added tag is stored in its single-pass form, as the dashboard save
      // stores it, unless that exact string is stored: a kept tag of another single-pass form stays beside it, so a
      // segment or flow condition on either form still matches.
      const removeForms = new Set(write.remove.map(normalizedStoredTag));
      const kept = (current.tags ?? []).filter((tag) => !removeForms.has(normalizedStoredTag(tag)));
      const tags = [...new Set([...kept, ...write.add])].sort();
      if (tags.length > CONTACT_TAG_LIMIT) throw new ApiError(409, "contact_tag_limit");
      await client.query(
        `INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags) VALUES($1,$2,$3,$4::text[])
         ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET tags=EXCLUDED.tags`,
        [...key, tags],
      );
    }
    for (const [fieldId, value] of write.fields)
      await client.query(
        `INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value) VALUES($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT(workspace_id,connection_id,sender_id,field_id) DO UPDATE SET value=EXCLUDED.value`,
        [...key, fieldId, value === null ? null : JSON.stringify(value)],
      );
    return (await client.query<CsvContact>(CONTACT_ROW_SQL, key)).rows[0]!;
  });
}

// The active fields of the workspace, in the dashboard's order.
export async function listWorkspaceFields(pool: Pick<Pool, "query">, workspaceId: string): Promise<{ id: string; name: string; type: string }[]> {
  return (await pool.query<{ id: string; name: string; type: string }>("SELECT id,name,type FROM instagram_contact_fields WHERE workspace_id=$1 AND NOT archived ORDER BY name,id", [workspaceId])).rows;
}
