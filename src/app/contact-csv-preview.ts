import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { CONTACT_CSV_HEADER } from "./contact-csv.ts";
import { normalizeContactTags } from "./contacts.ts";
import { workspaceFor } from "./settings.ts";

export const CONTACT_IMPORT_BYTES = 128 * 1024;
export const CONTACT_IMPORT_REQUEST_BYTES = 6 * CONTACT_IMPORT_BYTES + 32;
export const CONTACT_IMPORT_ROWS = 500;
export type ImportRowStatus = "invalid" | "duplicate" | "not_found" | "changed" | "unchanged";
export type ParsedImportRow = { row: number; connection_id: string; sender_id: string; tags: string[] };
export type ImportResultRow = {
  row: number;
  status: ImportRowStatus;
  connection_id?: string;
  sender_id?: string;
  current_tags?: string[];
  proposed_tags?: string[];
};
export type ImportCounts = Record<"total" | ImportRowStatus, number>;
type ImportSnapshot = { checked_at: Date; contacts: { row: number; tags: string[] }[] };

// Parse records, not physical lines: quoted cells may contain CRLF, commas and doubled quotes.
export function parseImportCsv(value: string): string[][] {
  if (Buffer.byteLength(value, "utf8") > CONTACT_IMPORT_BYTES) throw new ApiError(422, "contact_import_too_large");
  if (/[\u0000\uD800-\uDFFF]/u.test(value)) throw new ApiError(400, "invalid_contact_import_format");
  const text = value.startsWith("\ufeff") ? value.slice(1) : value;
  const records: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const invalid = () => {
    throw new ApiError(400, "invalid_contact_import_format");
  };
  const finishCell = () => {
    row.push(cell);
    cell = "";
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    records.push(row);
    row = [];
    if (records.length > CONTACT_IMPORT_ROWS + 1) throw new ApiError(422, "contact_import_too_large");
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (char === ",") finishCell();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[++i] !== "\n") invalid();
      finishRow();
    } else if (char === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || char === '"') invalid();
      cell += char;
    }
  }
  if (quoted) invalid();
  if (row.length || cell || closed || text.endsWith(",")) finishRow();
  if (records[0]?.length !== CONTACT_CSV_HEADER.length || CONTACT_CSV_HEADER.some((key, i) => records[0]![i] !== key))
    invalid();
  return records.slice(1);
}

// Row classification shared by the preview and the apply (#25): invalid rows first, then every remaining
// duplicate connection/sender pair, so the two paths cannot drift. The lookup fills in the rest.
export function classifyImportRecords(
  records: string[][],
  workspace: string,
): { rows: ImportResultRow[]; unique: ParsedImportRow[] } {
  const rows: ImportResultRow[] = records.map((_, i) => ({ row: i + 1, status: "invalid" }));
  const parsed: ParsedImportRow[] = [];
  for (const [index, cells] of records.entries()) {
    if (
      cells.length !== CONTACT_CSV_HEADER.length ||
      cells[0] !== "1" ||
      !isUuid(cells[2]) ||
      cells[2]!.toLowerCase() !== workspace ||
      cells[3] !== "instagram" ||
      cells[4] !== "comment_sender" ||
      !isUuid(cells[5]) ||
      !cells[6]?.startsWith("'") ||
      !cells[6]!.slice(1).trim()
    )
      continue;
    try {
      parsed.push({
        row: index + 1,
        connection_id: cells[5]!.toLowerCase(),
        sender_id: cells[6]!.slice(1),
        tags: normalizeContactTags(JSON.parse(cells[12]!)),
      });
    } catch {
      /* Invalid tag JSON and values are row errors, never echoed. */
    }
  }
  const key = (row: ParsedImportRow) => JSON.stringify([row.connection_id, row.sender_id]);
  const frequency = new Map<string, number>();
  for (const row of parsed) frequency.set(key(row), (frequency.get(key(row)) ?? 0) + 1);
  const unique = parsed.filter((row) => {
    if (frequency.get(key(row)) === 1) return true;
    rows[row.row - 1] = { row: row.row, status: "duplicate" };
    return false;
  });
  return { rows, unique };
}

// One read snapshot rechecks authorization and account/contact ownership. The upload never becomes stored data.
export async function readImportSnapshot(
  db: Pick<Pool, "query">,
  user: User,
  workspace: string,
  unique: ParsedImportRow[],
): Promise<ImportSnapshot> {
  const result = await db.query<ImportSnapshot>(
    `SELECT statement_timestamp() AS checked_at,
       coalesce(jsonb_agg(jsonb_build_object('row',input.row,'tags',coalesce(tags.tags,'{}'::text[])))
         FILTER (WHERE connection.id IS NOT NULL AND EXISTS(
           SELECT 1 FROM instagram_comment_events event WHERE event.workspace_id=member.workspace_id
           AND event.connection_id=connection.id AND event.sender_id=input.sender_id)),'[]'::jsonb) AS contacts
     FROM workspace_members member
     LEFT JOIN jsonb_to_recordset($3::jsonb) AS input(row integer,connection_id uuid,sender_id text) ON true
     LEFT JOIN instagram_connections connection ON connection.id=input.connection_id AND connection.workspace_id=member.workspace_id
     LEFT JOIN instagram_contact_tags tags ON tags.workspace_id=member.workspace_id AND tags.connection_id=connection.id AND tags.sender_id=input.sender_id
     WHERE member.user_id=$1 AND member.workspace_id=$2 AND member.removed_at IS NULL AND member.role IN ('owner','admin')
     GROUP BY member.workspace_id`,
    [
      user.id,
      workspace,
      JSON.stringify(unique.map(({ row, connection_id, sender_id }) => ({ row, connection_id, sender_id }))),
    ],
  );
  if (!result.rows[0]) throw new ApiError(403, "role_forbidden");
  return result.rows[0];
}

export function applyImportSnapshot(rows: ImportResultRow[], unique: ParsedImportRow[], snapshot: ImportSnapshot) {
  const current = new Map(snapshot.contacts.map((value) => [value.row, value.tags]));
  for (const entry of unique) {
    const tags = current.get(entry.row);
    rows[entry.row - 1] =
      tags === undefined
        ? { row: entry.row, status: "not_found" }
        : {
            row: entry.row,
            status: JSON.stringify([...tags].sort()) === JSON.stringify(entry.tags) ? "unchanged" : "changed",
            connection_id: entry.connection_id,
            sender_id: entry.sender_id,
            current_tags: tags,
            proposed_tags: entry.tags,
          };
  }
}

export function countImportRows(rows: ImportResultRow[]): ImportCounts {
  const counts: ImportCounts = { total: rows.length, changed: 0, unchanged: 0, invalid: 0, duplicate: 0, not_found: 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
}

export async function previewContactCsv(pool: Pool, user: User, input: unknown) {
  const workspace = await workspaceFor(pool, user, "admin");
  if (!isRecord(input) || Object.keys(input).length !== 1 || typeof input.csv !== "string")
    throw new ApiError(400, "invalid_contact_import_request");
  const { rows, unique } = classifyImportRecords(parseImportCsv(input.csv), workspace);
  const snapshot = await readImportSnapshot(pool, user, workspace, unique);
  applyImportSnapshot(rows, unique, snapshot);
  return { checked_at: snapshot.checked_at.toISOString(), counts: countImportRows(rows), rows };
}
