import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { lockWorkspaceForMember, roleAllows, workspaceFor, type WorkspaceRole } from "./settings.ts";
import { validateFieldCondition } from "./contact-fields.ts";
import { contactCsvRow, contactCsvScalar } from "./contact-csv.ts";
import {
  contactConditionFields,
  lockActiveSegment,
  savedSegmentConditions,
  segmentConditionSql,
  segmentPreviewCounts,
  segmentPreviewSql,
  type SegmentPreviewSummary,
} from "./contacts.ts";

// A snapshot freezes the comment senders a saved segment selects at one as_of (#35, the target snapshot spec).
// It stores identifiers only, sends nothing and decides no delivery eligibility.
// maxStoredMembers caps the member rows a workspace keeps across its snapshots: they count toward the workspace
// export's 50,000 rows and 20 MiB, and server roles cannot delete them, so without it ten full snapshots would close
// the export for good. 20,000 rows of about 200 bytes are 40% of those rows and under a quarter of those bytes.
type SegmentSnapshotLimits = { maxMembers: number; perWorkspace: number; maxStoredMembers: number; pageSize: number };
export const SEGMENT_SNAPSHOT_LIMITS: Readonly<SegmentSnapshotLimits> = Object.freeze({
  maxMembers: 5000,
  perWorkspace: 200,
  maxStoredMembers: 20_000,
  pageSize: 50,
});

export const SEGMENT_SNAPSHOT_CSV_HEADER = [
  "format_version",
  "snapshot_id",
  "segment_id",
  "as_of",
  "workspace_id",
  "channel",
  "identity_kind",
  "connection_id",
  "sender_id",
] as const;

const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// The summary columns of a snapshot row (prefix is its alias with the dot): never its members or its definition.
const summary = (prefix = "s.") =>
  `${prefix}id,${prefix}segment_id,${prefix}segment_name,${utc(`${prefix}as_of`)} AS as_of,${prefix}counts,${prefix}member_count,${prefix}created_at`;
const SUMMARY = summary();
// The member rows the workspace ($1) stores now across its snapshots: what the freeze limit and the usage both count.
const STORED_MEMBERS = `(SELECT count(*)::int FROM instagram_segment_snapshot_members m
   WHERE m.workspace_id=$1 AND m.snapshot_id IN (SELECT id FROM instagram_segment_snapshots WHERE workspace_id=$1))`;

// Create takes an empty body (the dashboard sends none) or exactly {}.
export function parseSnapshotRequest(input: unknown): void {
  if (input === undefined) return;
  if (!isRecord(input) || Object.keys(input).length) throw new ApiError(400, "invalid_snapshot_request");
}

function memberCursor(value: string | null): { connection_id: string; sender_id: string } | null {
  if (value === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const result: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isRecord(result) ||
      !isUuid(result.connection_id) ||
      typeof result.sender_id !== "string" ||
      !result.sender_id.trim()
    )
      throw new Error();
    return { connection_id: result.connection_id, sender_id: result.sender_id };
  } catch {
    throw new ApiError(400, "invalid_snapshot_request");
  }
}

// One READ COMMITTED transaction. The locks come first: the workspace row (it serializes creations, so the
// per-workspace count holds), the segment FOR SHARE (an edit or archive waits), then every connection the evaluation
// can include FOR SHARE in ID order, the order of the deletion functions. The evaluation is then one statement, so the
// preview counts and the members share one snapshot taken after those locks: a connection or person deletion either
// committed before it (and its rows are not read) or waits for this commit (and deletes the new member rows).
// REPEATABLE READ would fix the snapshot at the first lock and read rows a deletion removed while this waited.
export async function createSegmentSnapshot(
  pool: Pool,
  user: User,
  segmentId: string,
  input: unknown,
  limits: Partial<SegmentSnapshotLimits> = {},
) {
  const { maxMembers, perWorkspace, maxStoredMembers } = { ...SEGMENT_SNAPSHOT_LIMITS, ...limits };
  if (!isUuid(segmentId)) throw new ApiError(400, "invalid_snapshot_request");
  parseSnapshotRequest(input);
  const workspace = await workspaceFor(pool, user, "admin");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockWorkspaceForMember(client, workspace, user, "admin");
    const segment = await lockActiveSegment(client, workspace, segmentId);
    const conditions = await savedSegmentConditions(client, workspace, segment.id);
    for (const condition of contactConditionFields(conditions))
      await validateFieldCondition(client, workspace, condition);
    await client.query(
      "SELECT id FROM instagram_connections WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY id FOR SHARE",
      [workspace, conditions.connectionId],
    );
    // Both counts read rows committed before the workspace lock was granted, so concurrent creations stay within them.
    // Stored member rows are counted, not member_count, so rows a deletion removed no longer count.
    const existing = (
      await client.query<{ snapshots: number; members: number }>(
        `SELECT count(*)::int AS snapshots,${STORED_MEMBERS} AS members FROM instagram_segment_snapshots WHERE workspace_id=$1`,
        [workspace],
      )
    ).rows[0]!;
    if (existing.snapshots >= perWorkspace) throw new ApiError(409, "snapshot_limit_reached");
    // The members are the segment export's selection (its contactScope, matches and HAVING, in its order) and the
    // counts the preview's summary, both from segmentConditionSql at the statement's own clock. The clock appears
    // once, in evaluation.
    const sql = segmentConditionSql(workspace, conditions, "statement_timestamp()", null);
    const limitPosition = sql.values.length + 1;
    const rows = (
      await client.query<
        SegmentPreviewSummary & { connection_id: string | null; sender_id: string | null; as_of: string }
      >(
        `WITH ${sql.evaluation}, ${segmentPreviewSql(sql)}, selected AS (
           SELECT e.connection_id,e.sender_id
           ${sql.contactScope}
           AND ($4::uuid IS NULL OR (e.connection_id,e.sender_id COLLATE "C")>($4::uuid,$5::text COLLATE "C"))
           AND ${sql.matches}
           GROUP BY e.connection_id,e.sender_id HAVING ${sql.activityMatches}
           ORDER BY e.connection_id,e.sender_id COLLATE "C" LIMIT $${limitPosition}
         )
         SELECT selected.connection_id,selected.sender_id,summary.*,(SELECT ${utc("as_of")} FROM evaluation) AS as_of
         FROM summary LEFT JOIN LATERAL (SELECT * FROM selected) selected ON true
         ORDER BY selected.connection_id,selected.sender_id COLLATE "C"`,
        [...sql.values, maxMembers + 1],
      )
    ).rows;
    const members = rows.filter((row) => row.connection_id !== null);
    if (members.length > maxMembers) throw new ApiError(409, "snapshot_too_large");
    if (existing.members + members.length > maxStoredMembers) throw new ApiError(409, "snapshot_members_limit_reached");
    const { id: _id, name: _name, ...definition } = segment;
    const saved = (
      await client.query(
        `INSERT INTO instagram_segment_snapshots(workspace_id,segment_id,created_by,as_of,definition,segment_name,counts,member_count)
         VALUES($1,$2,$3,$4::timestamptz,$5::jsonb,$6,$7::jsonb,$8) RETURNING ${summary("")}`,
        [
          workspace,
          segment.id,
          user.id,
          rows[0]!.as_of,
          JSON.stringify(definition),
          segment.name,
          JSON.stringify(segmentPreviewCounts(rows[0], conditions)),
          members.length,
        ],
      )
    ).rows[0];
    if (members.length)
      await client.query(
        `INSERT INTO instagram_segment_snapshot_members(snapshot_id,workspace_id,connection_id,sender_id)
         SELECT $1,$2,member.connection_id,member.sender_id FROM unnest($3::uuid[],$4::text[]) AS member(connection_id,sender_id)`,
        [saved.id, workspace, members.map((row) => row.connection_id), members.map((row) => row.sender_id)],
      );
    await client.query("COMMIT");
    return saved;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// The segment's snapshots, newest first; an archived segment of the workspace keeps its list.
export async function listSegmentSnapshots(pool: Pool, user: User, segmentId: string) {
  if (!isUuid(segmentId)) throw new ApiError(400, "invalid_snapshot_request");
  const workspace = await workspaceFor(pool, user, "admin");
  const result = await pool.query(
    `SELECT segment.id AS found,${SUMMARY} FROM instagram_contact_segments segment
     LEFT JOIN instagram_segment_snapshots s ON s.workspace_id=segment.workspace_id AND s.segment_id=segment.id
     WHERE segment.workspace_id=$1 AND segment.id=$2
     ORDER BY s.created_at DESC,s.id DESC`,
    [workspace, segmentId],
  );
  if (!result.rows[0]) throw new ApiError(404, "segment_not_found");
  return result.rows.filter((row) => row.id !== null).map(({ found: _found, ...snapshot }) => snapshot);
}

// Every snapshot of the workspace, newest first, with whether its segment is archived now, and the usage the freeze
// limits count. One statement reads both, so the list and the usage share one snapshot. usage.snapshots is the list's
// length, which equals the freeze check's count because the (segment_id, workspace_id) foreign key keeps every
// snapshot's segment in its workspace. The workspace keeps at most perWorkspace snapshots, so there is no pagination.
export async function listWorkspaceSegmentSnapshots(
  pool: Pool,
  user: User,
  options: URLSearchParams = new URLSearchParams(),
) {
  if (options.size) throw new ApiError(400, "invalid_snapshot_request");
  const workspace = await workspaceFor(pool, user, "admin");
  const rows = (
    await pool.query(
      `SELECT usage.stored_members,${SUMMARY},segment.archived AS segment_archived
       FROM (SELECT ${STORED_MEMBERS} AS stored_members) usage
       LEFT JOIN (
         instagram_segment_snapshots s
         JOIN instagram_contact_segments segment ON segment.workspace_id=s.workspace_id AND segment.id=s.segment_id
       ) ON s.workspace_id=$1
       ORDER BY s.created_at DESC,s.id DESC`,
      [workspace],
    )
  ).rows;
  const snapshots = rows.filter((row) => row.id !== null).map(({ stored_members: _stored, ...snapshot }) => snapshot);
  const { perWorkspace, maxStoredMembers } = SEGMENT_SNAPSHOT_LIMITS;
  return {
    snapshots,
    usage: {
      snapshots: snapshots.length,
      stored_members: rows[0]!.stored_members as number,
      max_snapshots: perWorkspace,
      max_stored_members: maxStoredMembers,
    },
  };
}

// The summary, the definition copy and one page of the stored members. stored_member_count counts the rows still
// stored, which a connection or person deletion can make smaller than member_count.
export async function getSegmentSnapshot(
  pool: Pool,
  user: User,
  snapshotId: string,
  options: URLSearchParams = new URLSearchParams(),
) {
  if (!isUuid(snapshotId) || [...options.keys()].some((key) => key !== "after") || options.getAll("after").length > 1)
    throw new ApiError(400, "invalid_snapshot_request");
  const after = memberCursor(options.get("after"));
  const workspace = await workspaceFor(pool, user, "admin");
  const { pageSize } = SEGMENT_SNAPSHOT_LIMITS;
  const rows = (
    await pool.query(
      `SELECT ${SUMMARY},s.definition,s.created_by,
         (SELECT count(*)::int FROM instagram_segment_snapshot_members m WHERE m.snapshot_id=s.id) AS stored_member_count,
         page.connection_id AS member_connection_id,page.sender_id AS member_sender_id
       FROM instagram_segment_snapshots s
       LEFT JOIN LATERAL (
         SELECT m.connection_id,m.sender_id FROM instagram_segment_snapshot_members m
         WHERE m.snapshot_id=s.id AND ($3::uuid IS NULL OR (m.connection_id,m.sender_id COLLATE "C")>($3::uuid,$4::text COLLATE "C"))
         ORDER BY m.connection_id,m.sender_id COLLATE "C" LIMIT $5
       ) page ON true
       WHERE s.workspace_id=$1 AND s.id=$2
       ORDER BY page.connection_id,page.sender_id COLLATE "C"`,
      [workspace, snapshotId, after?.connection_id ?? null, after?.sender_id ?? null, pageSize + 1],
    )
  ).rows;
  if (!rows[0]) throw new ApiError(404, "snapshot_not_found");
  const { member_connection_id: _connection, member_sender_id: _sender, ...snapshot } = rows[0];
  const members = rows
    .filter((row) => row.member_connection_id !== null)
    .map((row) => ({ connection_id: row.member_connection_id, sender_id: row.member_sender_id }));
  const page = members.slice(0, pageSize);
  const last = page.at(-1);
  return {
    snapshot,
    members: page,
    after:
      members.length > pageSize && last
        ? Buffer.from(JSON.stringify({ connection_id: last.connection_id, sender_id: last.sender_id })).toString(
            "base64url",
          )
        : null,
  };
}

// Compare only still-stored keys with the current saved definition. All reads share one read-only snapshot,
// including membership, the definition and both sets; no deleted identity is reconstructed and no key is returned.
export async function compareSegmentSnapshot(
  pool: Pool,
  user: User,
  snapshotId: string,
  options: URLSearchParams = new URLSearchParams(),
) {
  if (!isUuid(snapshotId) || options.size) throw new ApiError(400, "invalid_snapshot_request");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const membership = (
      await client.query<{ workspace_id: string; role: WorkspaceRole }>(
        "SELECT workspace_id,role FROM workspace_members WHERE user_id=$1 AND removed_at IS NULL",
        [user.id],
      )
    ).rows[0];
    if (!membership) throw new ApiError(403, "workspace_required");
    if (!roleAllows(membership.role, "admin")) throw new ApiError(403, "role_forbidden");
    const workspace = membership.workspace_id;
    const snapshot = (
      await client.query(
        `SELECT s.segment_id,${utc("s.as_of")} AS snapshot_as_of,s.member_count,
           (s.definition->>'version')::int AS snapshot_segment_version,segment.version AS segment_version,segment.archived
         FROM instagram_segment_snapshots s
         JOIN instagram_contact_segments segment ON segment.workspace_id=s.workspace_id AND segment.id=s.segment_id
         WHERE s.workspace_id=$1 AND s.id=$2`,
        [workspace, snapshotId],
      )
    ).rows[0];
    if (!snapshot) throw new ApiError(404, "snapshot_not_found");
    if (snapshot.archived) throw new ApiError(404, "segment_not_found");
    const conditions = await savedSegmentConditions(client, workspace, snapshot.segment_id);
    for (const condition of contactConditionFields(conditions))
      await validateFieldCondition(client, workspace, condition);
    const sql = segmentConditionSql(workspace, conditions, "statement_timestamp()", null);
    const result = (
      await client.query(
        `WITH ${sql.evaluation}, selected AS MATERIALIZED (
           SELECT e.connection_id,e.sender_id ${sql.contactScope}
           AND ($4::uuid IS NULL OR (e.connection_id,e.sender_id COLLATE "C")>($4::uuid,$5::text COLLATE "C"))
           AND ${sql.matches}
           GROUP BY e.connection_id,e.sender_id HAVING ${sql.activityMatches}
         ), baseline AS (
           SELECT connection_id,sender_id FROM instagram_segment_snapshot_members
           WHERE workspace_id=$1 AND snapshot_id=$${sql.values.length + 1}::uuid
         )
         SELECT (SELECT ${utc("as_of")} FROM evaluation) AS compared_at,
           count(b.connection_id)::text AS baseline,count(c.connection_id)::text AS current,
           count(*) FILTER (WHERE b.connection_id IS NULL)::text AS added,
           count(*) FILTER (WHERE c.connection_id IS NULL)::text AS removed,
           count(*) FILTER (WHERE b.connection_id IS NOT NULL AND c.connection_id IS NOT NULL)::text AS retained
         FROM baseline b FULL JOIN selected c USING(connection_id,sender_id)`,
        [...sql.values, snapshotId],
      )
    ).rows[0]!;
    await client.query("COMMIT");
    const { compared_at, ...counts } = result;
    const { archived: _archived, member_count, ...metadata } = snapshot;
    return { snapshot_id: snapshotId, ...metadata, compared_at, counts: { original: String(member_count), ...counts } };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// The stored members as CSV, with the v1 contact CSV's quoting and identifier marker. At most 5,000 rows.
export async function exportSegmentSnapshotCsv(pool: Pool, user: User, snapshotId: string) {
  if (!isUuid(snapshotId)) throw new ApiError(400, "invalid_snapshot_request");
  const workspace = await workspaceFor(pool, user, "admin");
  const rows = (
    await pool.query<{
      id: string;
      segment_id: string;
      as_of: string;
      connection_id: string | null;
      sender_id: string | null;
    }>(
      `SELECT s.id,s.segment_id,${utc("s.as_of")} AS as_of,m.connection_id,m.sender_id
       FROM instagram_segment_snapshots s
       LEFT JOIN instagram_segment_snapshot_members m ON m.snapshot_id=s.id
       WHERE s.workspace_id=$1 AND s.id=$2
       ORDER BY m.connection_id,m.sender_id COLLATE "C"`,
      [workspace, snapshotId],
    )
  ).rows;
  if (!rows[0]) throw new ApiError(404, "snapshot_not_found");
  const { id, segment_id: segment, as_of: asOf } = rows[0];
  let body = "﻿" + contactCsvRow(SEGMENT_SNAPSHOT_CSV_HEADER);
  for (const row of rows)
    if (row.connection_id !== null && row.sender_id !== null)
      body += contactCsvRow([
        "1",
        id,
        segment,
        asOf,
        workspace,
        "instagram",
        "comment_sender",
        row.connection_id,
        contactCsvScalar(row.sender_id, true),
      ]);
  return { body, snapshotId: id, asOf };
}
