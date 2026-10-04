import type { Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow } from "pg";
import { ApiError, isRecord, type User } from "./auth.ts";
import { roleAllows, type WorkspaceRole } from "./settings.ts";

export const CONTACT_CSV_HEADER = [
  "format_version",
  "exported_at",
  "workspace_id",
  "channel",
  "identity_kind",
  "connection_id",
  "sender_id",
  "connection_username",
  "first_comment_recorded_at",
  "last_comment_recorded_at",
  "comment_count",
  "automation_paused",
  "tags_json",
  "fields_json",
] as const;

// A reversible source-file text marker, not a promise about spreadsheet re-saving behavior.
export function contactCsvScalar(value: string | null, identifier = false): string {
  if (value === null) return "";
  const unsafe = /^[\p{White_Space}\p{Cc}\p{Cf}]*[=+\-@＝＋－＠\t\r\n]/u.test(value);
  return identifier || value === "" || value.startsWith("'") || unsafe ? "'" + value : value;
}
export function contactCsvRow(cells: readonly string[]): string {
  return cells.map((value) => '"' + value.replaceAll('"', '""') + '"').join(",") + "\r\n";
}

export class ContactCsvBuffer {
  private parts: string[] = [];
  private bytes = 0;
  private rows = 0;
  private maxRows: number;
  private maxBytes: number;
  constructor(maxRows: number, maxBytes: number) {
    this.maxRows = maxRows;
    this.maxBytes = maxBytes;
    this.append("\ufeff" + contactCsvRow(CONTACT_CSV_HEADER));
  }
  private append(text: string): void {
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.bytes + bytes > this.maxBytes) throw new ApiError(422, "contact_export_too_large");
    this.parts.push(text);
    this.bytes += bytes;
  }
  add(cells: readonly string[]): void {
    if (this.rows >= this.maxRows) throw new ApiError(422, "contact_export_too_large");
    this.append(contactCsvRow(cells));
    this.rows++;
  }
  finish(): string {
    return this.parts.join("");
  }
}

type ContactCsvLimits = { maxRows: number; maxBytes: number; timeoutMs: number; batchSize: number };
export const CONTACT_CSV_LIMITS: Readonly<ContactCsvLimits> = Object.freeze({
  maxRows: 5000,
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 10_000,
  batchSize: 25,
});
type CsvContact = {
  connection_id: string;
  sender_id: string;
  username: string | null;
  first_at: string;
  last_at: string;
  comment_count: string;
  paused: boolean;
  tags_json: string;
  fields_json: string;
};
const timeout = () => new ApiError(503, "contact_export_timeout");

// A timed-out acquisition can still complete later. Its continuation owns and destroys that late client.
async function acquire(pool: Pool, milliseconds: number): Promise<PoolClient> {
  const deadline = performance.now() + milliseconds;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = pool.connect().then((client) => {
    if (expired) {
      client.release(true);
      throw timeout();
    }
    return client;
  });
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(timeout());
        }, milliseconds);
      }),
    ]);
  } catch (error) {
    if (expired || performance.now() >= deadline) throw timeout();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Trusted internal limits support smaller resource budgets; HTTP never accepts an override.
// An admitted snapshot may finish after a concurrent deletion/removal. It changes no stored data.
export async function exportContactCsv(pool: Pool, user: User, options: Partial<ContactCsvLimits> = {}) {
  const limits = { ...CONTACT_CSV_LIMITS, ...options };
  const deadline = performance.now() + limits.timeoutMs;
  const remaining = () => {
    const milliseconds = Math.ceil(deadline - performance.now());
    if (milliseconds <= 0) throw timeout();
    return milliseconds;
  };
  const client = await acquire(pool, remaining());
  let destroy = false;
  async function raw<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    // pg supports per-query read timeout at runtime; its QueryConfig declarations omit this property.
    const config: QueryConfig & { query_timeout: number } = { text, values, query_timeout: remaining() };
    const result = await client.query<R>(config);
    remaining();
    return result;
  }
  async function query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    await raw("SELECT set_config('statement_timeout',$1,true)", [String(remaining())]);
    return raw<R>(text, values);
  }
  try {
    await raw("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const membership = (
      await query<{ workspace_id: string; role: WorkspaceRole }>(
        "SELECT workspace_id,role FROM workspace_members WHERE user_id=$1 AND removed_at IS NULL",
        [user.id],
      )
    ).rows[0];
    if (!membership) throw new ApiError(403, "workspace_required");
    if (!roleAllows(membership.role, "admin")) throw new ApiError(403, "role_forbidden");
    const workspace = membership.workspace_id;
    const exportedAt = (
      await query<{ exported_at: string }>(
        `SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exported_at`,
      )
    ).rows[0]!.exported_at;
    const buffer = new ContactCsvBuffer(limits.maxRows, limits.maxBytes);
    let after: CsvContact | undefined;
    while (true) {
      const rows = (
        await query<CsvContact>(
          `WITH contacts AS (
           SELECT e.connection_id,e.sender_id,min(e.created_at) AS first_at,max(e.created_at) AS last_at,count(*)::text AS comment_count
           FROM instagram_comment_events e JOIN instagram_connections c ON c.id=e.connection_id AND c.workspace_id=e.workspace_id
           WHERE e.workspace_id=$1 AND ($2::uuid IS NULL OR (e.connection_id,e.sender_id COLLATE "C")>($2::uuid,$3::text COLLATE "C"))
           GROUP BY e.connection_id,e.sender_id ORDER BY e.connection_id,e.sender_id COLLATE "C" LIMIT $4
         )
         SELECT e.connection_id,e.sender_id,c.username,e.comment_count,
           to_char(e.first_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_at,
           to_char(e.last_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_at,
           coalesce(automation.paused OR automation.handoff_paused,false) AS paused,
           (SELECT coalesce(json_agg(tag ORDER BY tag COLLATE "C"),'[]'::json)::text FROM unnest(tags.tags) AS tag) AS tags_json,
           (SELECT coalesce(json_object_agg(f.id::text,json_build_object('name',f.name,'type',f.type,'value',v.value) ORDER BY f.id),'{}'::json)::text
             FROM instagram_contact_field_values v JOIN instagram_contact_fields f ON f.id=v.field_id AND f.workspace_id=v.workspace_id
             WHERE v.workspace_id=$1 AND v.connection_id=e.connection_id AND v.sender_id=e.sender_id AND NOT f.archived AND v.value IS NOT NULL) AS fields_json
         FROM contacts e JOIN instagram_connections c ON c.id=e.connection_id AND c.workspace_id=$1
         LEFT JOIN instagram_contact_tags tags ON tags.workspace_id=$1 AND tags.connection_id=e.connection_id AND tags.sender_id=e.sender_id
         LEFT JOIN instagram_contact_automation automation ON automation.workspace_id=$1 AND automation.connection_id=e.connection_id AND automation.sender_id=e.sender_id
         ORDER BY e.connection_id,e.sender_id COLLATE "C"`,
          [workspace, after?.connection_id ?? null, after?.sender_id ?? null, limits.batchSize],
        )
      ).rows;
      for (const row of rows) {
        buffer.add([
          "1",
          exportedAt,
          workspace,
          "instagram",
          "comment_sender",
          row.connection_id,
          contactCsvScalar(row.sender_id, true),
          contactCsvScalar(row.username),
          row.first_at,
          row.last_at,
          row.comment_count,
          row.paused ? "true" : "false",
          row.tags_json,
          row.fields_json,
        ]);
        remaining();
      }
      if (rows.length < limits.batchSize) break;
      after = rows.at(-1)!;
    }
    const body = buffer.finish();
    remaining();
    await raw("COMMIT");
    return { body, exportedAt };
  } catch (error) {
    const timedOut =
      performance.now() >= deadline ||
      (isRecord(error) &&
        (error.code === "57014" ||
          error.message === "Query read timeout" ||
          error.message === "contact_export_timeout"));
    if (timedOut) {
      // Destroying the connection rolls back the read-only transaction and cancels any query still running.
      // Never return a pg client whose client-side timeout fired before the server finished to the pool.
      destroy = true;
      throw timeout();
    }
    try {
      const rollback: QueryConfig & { query_timeout: number } = { text: "ROLLBACK", query_timeout: 1000 };
      await client.query(rollback);
    } catch {
      destroy = true;
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}
