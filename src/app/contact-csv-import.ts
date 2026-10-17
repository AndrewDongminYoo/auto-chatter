import type { Pool } from "pg";
import { ApiError, isRecord, type User } from "./auth.ts";
import {
  applyImportSnapshot,
  classifyImportRecords,
  countImportRows,
  CONTACT_IMPORT_REQUEST_BYTES,
  CONTACT_IMPORT_ROWS,
  parseImportCsv,
  readImportSnapshot,
  type ImportCounts,
  type ImportResultRow,
} from "./contact-csv-preview.ts";
import { CONTACT_TAG_LENGTH, CONTACT_TAG_LIMIT, lockContactConnection } from "./contacts.ts";
import { workspaceFor } from "./settings.ts";

// One expected row is `{"row":500,"current_tags":[...]},` around stored tags, each JSON-escaped to at most six
// bytes per character (`\uXXXX`) plus its quotes and comma; the preview's CSV allowance covers the `csv` key.
const EXPECTED_ROW_BYTES = 32 + CONTACT_TAG_LIMIT * (6 * CONTACT_TAG_LENGTH + 3);
export const CONTACT_IMPORT_APPLY_REQUEST_BYTES =
  CONTACT_IMPORT_REQUEST_BYTES + 32 + CONTACT_IMPORT_ROWS * EXPECTED_ROW_BYTES;

export type AppliedRow = {
  row: number;
  status: "applied" | "unchanged";
  connection_id: string;
  sender_id: string;
  previous_tags: string[];
  tags: string[];
};
export type ImportApplyOutcome =
  | {
      status: 200;
      body: { applied_at: string; counts: { total: number; applied: number; unchanged: number }; rows: AppliedRow[] };
    }
  | {
      status: 409 | 422;
      body: {
        error: "contact_import_stale" | "contact_import_rejected";
        checked_at: string;
        counts: ImportCounts;
        rows: ImportResultRow[];
      };
    };

// `expected` carries the preview's current tags of every changed row (sorted here), the optimistic check of #25.
export function parseImportApplyRequest(input: unknown): { csv: string; expected: Map<number, string[]> } {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 2 ||
    typeof input.csv !== "string" ||
    !Array.isArray(input.expected) ||
    input.expected.length > CONTACT_IMPORT_ROWS
  )
    throw new ApiError(400, "invalid_contact_import_request");
  const expected = new Map<number, string[]>();
  for (const entry of input.expected) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      !Number.isInteger(entry.row) ||
      (entry.row as number) < 1 ||
      (entry.row as number) > CONTACT_IMPORT_ROWS ||
      !Array.isArray(entry.current_tags) ||
      entry.current_tags.length > CONTACT_TAG_LIMIT ||
      !entry.current_tags.every((tag) => typeof tag === "string") ||
      expected.has(entry.row as number)
    )
      throw new ApiError(400, "invalid_contact_import_request");
    expected.set(entry.row as number, [...(entry.current_tags as string[])].sort());
  }
  return { csv: input.csv, expected };
}

// Applies a checked file all or nothing: the workspace import lock, the connections FOR SHARE in ID order and
// one lockContact per unique row in (connection, sender) order are taken before the snapshot read, the same
// order as the manual tag save, so the read and the write see the same contacts. Up to 500 advisory locks are
// held by one transaction. A rejected or stale file answers with the fresh per-row result and writes nothing.
export async function applyContactCsv(pool: Pool, user: User, input: unknown): Promise<ImportApplyOutcome> {
  const workspace = await workspaceFor(pool, user, "admin");
  const { csv, expected } = parseImportApplyRequest(input);
  const records = parseImportCsv(csv);
  for (const row of expected.keys())
    if (row > records.length) throw new ApiError(400, "invalid_contact_import_request");
  const { rows, unique } = classifyImportRecords(records, workspace);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('contact-import:' || $1::text, 0))", [workspace]);
    for (const connectionId of [...new Set(unique.map((row) => row.connection_id))].sort())
      await lockContactConnection(client, workspace, connectionId);
    // The ordered subquery is not flattened, so the locks are taken in that order; the key is lockContact's.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(input.connection_id || ':' || input.sender_id, 0))
       FROM (SELECT connection_id,sender_id FROM jsonb_to_recordset($1::jsonb) AS entry(connection_id text,sender_id text)
             ORDER BY connection_id,sender_id) input`,
      [JSON.stringify(unique.map(({ connection_id, sender_id }) => ({ connection_id, sender_id })))],
    );
    const snapshot = await readImportSnapshot(client, user, workspace, unique);
    applyImportSnapshot(rows, unique, snapshot);
    const counts = countImportRows(rows);
    const checked_at = snapshot.checked_at.toISOString();
    const refuse = async (error: "contact_import_stale" | "contact_import_rejected"): Promise<ImportApplyOutcome> => {
      await client.query("ROLLBACK");
      return { status: error === "contact_import_stale" ? 409 : 422, body: { error, checked_at, counts, rows } };
    };
    if (counts.invalid || counts.duplicate || counts.not_found) return refuse("contact_import_rejected");
    const changed = rows.filter((row) => row.status === "changed");
    if (
      changed.some((row) => {
        const previous = expected.get(row.row);
        return !previous || JSON.stringify(previous) !== JSON.stringify([...row.current_tags!].sort());
      })
    )
      return refuse("contact_import_stale");
    const written = await client.query<{ applied_at: Date; written: string }>(
      `WITH written AS (
         INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags)
         SELECT $1,input.connection_id,input.sender_id,input.tags
         FROM jsonb_to_recordset($2::jsonb) AS input(connection_id uuid,sender_id text,tags text[])
         WHERE EXISTS(SELECT 1 FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=input.connection_id AND sender_id=input.sender_id)
         ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET tags=EXCLUDED.tags RETURNING 1)
       SELECT statement_timestamp() AS applied_at,(SELECT count(*) FROM written) AS written`,
      [
        workspace,
        JSON.stringify(
          changed.map(({ connection_id, sender_id, proposed_tags }) => ({
            connection_id,
            sender_id,
            tags: proposed_tags,
          })),
        ),
      ],
    );
    // A contact deleted between the lookup and the write leaves its row unwritten; nothing partial is kept.
    if (Number(written.rows[0]!.written) !== changed.length) return refuse("contact_import_stale");
    await client.query("COMMIT");
    return {
      status: 200,
      body: {
        applied_at: written.rows[0]!.applied_at.toISOString(),
        counts: { total: rows.length, applied: changed.length, unchanged: counts.unchanged },
        rows: rows.map((row) => ({
          row: row.row,
          status: row.status === "changed" ? "applied" : "unchanged",
          connection_id: row.connection_id!,
          sender_id: row.sender_id!,
          previous_tags: row.current_tags!,
          tags: row.proposed_tags!,
        })),
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
