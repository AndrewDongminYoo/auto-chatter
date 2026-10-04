import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { membershipFor, workspaceFor } from "./settings.ts";
import { lockConversation } from "../instagram/inbox.ts";

// Inbox reminders (#23-C). A reminder belongs to the member who created it: no other member can read or change it.
// It is shown only in the app; nothing is sent, and no cron step touches it. A reminder is due while it is pending
// and its due_at has passed, computed when it is read. A member holds at most one pending reminder per conversation
// (a partial unique index), and a closed conversation holds none: closing it cancels them and creating one is refused.
export const REMINDER_NOTE_MAX = 200;
// The earliest and latest due time accepted, measured from clock_timestamp() in PostgreSQL. 90 days is written as
// hours so the bound does not follow the session time zone across a daylight-saving change.
const MIN_AHEAD = "1 minute";
const MAX_AHEAD = "2160 hours";

export type Reminder = {
  id: string;
  connection_id: string;
  recipient_id: string;
  due_at: Date;
  // due_at as a wall-clock time in the workspace's current time zone, the value the editor shows.
  due_local: string;
  time_zone: string;
  due: boolean;
  note: string | null;
  status: "pending" | "done" | "cancelled";
  cancel_reason: "manual" | "conversation_closed" | "member_removed" | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

// A local date and time (SQL text "YYYY-MM-DDTHH:MM:SS") as an instant in a time zone: PostgreSQL's
// `timestamp AT TIME ZONE`. A time skipped by a daylight-saving gap or repeated by an overlap follows PostgreSQL's
// rule, which the tests pin and the spec states. `local` and `zone` are SQL expressions.
export function localDueSql(local: string, zone: string): string {
  return `(${local})::timestamp AT TIME ZONE (${zone})`;
}

// An instant as the wall-clock "YYYY-MM-DDTHH:MM" of a time zone, the value a datetime-local input takes.
export function dueLocalSql(due: string, zone: string): string {
  return `to_char((${due}) AT TIME ZONE (${zone}),'YYYY-MM-DD"T"HH24:MI')`;
}

const REMINDER_COLUMNS = `r.id,r.connection_id,r.recipient_id,r.due_at,${dueLocalSql("r.due_at", "w.time_zone")} AS due_local,w.time_zone,
    (r.status='pending' AND r.due_at<=now()) AS due,r.note,r.status,r.cancel_reason,r.version,r.created_at,r.updated_at`;
const REMINDER_FROM = "instagram_inbox_reminders r JOIN workspaces w ON w.id=r.workspace_id";
const REMINDER_SELECT = `SELECT ${REMINDER_COLUMNS} FROM ${REMINDER_FROM}`;

async function readReminder(db: Pick<Pool, "query">, id: string): Promise<Reminder> {
  return (await db.query<Reminder>(`${REMINDER_SELECT} WHERE r.id=$1`, [id])).rows[0]!;
}

// The caller's pending reminder on one conversation, or null.
export async function readCallerReminder(
  db: Pick<Pool, "query">,
  workspace: string,
  user: string,
  connection: string,
  recipient: string,
): Promise<Reminder | null> {
  const result = await db.query<Reminder>(
    `${REMINDER_SELECT} WHERE r.workspace_id=$1 AND r.creator_id=$2 AND r.connection_id=$3 AND r.recipient_id=$4
       AND r.status='pending'`,
    [workspace, user, connection, recipient],
  );
  return result.rows[0] ?? null;
}

// A local date and time as the screen's datetime-local input sends it, "YYYY-MM-DDTHH:MM". The calendar is checked
// here; PostgreSQL converts it with the workspace time zone.
function localTime(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "invalid_reminder_due");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new ApiError(400, "invalid_reminder_due");
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    year < 2000 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  )
    throw new ApiError(400, "invalid_reminder_due");
  return `${value}:00`;
}

// null, or text that is empty after trimming, clears the note.
function reminderNote(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2000) throw new ApiError(400, "invalid_reminder_note");
  const note = value.trim();
  if (!note) return null;
  if ([...note].length > REMINDER_NOTE_MAX || note.includes("\u0000")) throw new ApiError(400, "invalid_reminder_note");
  return note;
}

function expectedVersion(input: Record<string, unknown>): number {
  const version = input.expected_version;
  if (!Number.isInteger(version) || Number(version) < 1 || Number(version) >= 2147483647)
    throw new ApiError(400, "invalid_reminder_request");
  return Number(version);
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
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

// The lock order of the conversation state change (saveConversationState): the workspace row, the caller's membership
// row (rechecking removed_at), the connection, then the conversation (lockConversation exclusive). The caller locks
// the reminder row after this. The workspace row first queues behind delete_workspace_data, the member row sees a
// committed removal (whose reminder cancellation then already ran), and the connection FOR SHARE serializes with the
// connection and person deletion functions, so no reminder row is written after a deletion removed the conversation.
// The conversation lock serializes reminder writes with a close, which cancels the conversation's reminders.
async function lockConversationFor(
  client: PoolClient,
  user: User,
  workspace: string,
  connection: string,
  recipient: string,
  notFound: string,
): Promise<void> {
  await client.query("SELECT 1 FROM workspaces WHERE id=$1 FOR SHARE", [workspace]);
  const member = await client.query(
    "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND removed_at IS NULL FOR SHARE",
    [workspace, user.id],
  );
  if (!member.rowCount) throw new ApiError(403, "workspace_required");
  const owned = await client.query("SELECT 1 FROM instagram_connections WHERE id=$1 AND workspace_id=$2 FOR SHARE", [
    connection,
    workspace,
  ]);
  if (!owned.rowCount) throw new ApiError(404, notFound);
  await lockConversation(client, connection, recipient, "exclusive");
}

// Converts the local time with the workspace's time zone as it is now. A later change of the time zone does not
// move a stored reminder.
async function dueAt(client: PoolClient, workspace: string, local: string): Promise<Date> {
  const result = await client.query<{ due_at: Date; in_range: boolean }>(
    `SELECT due_at,due_at BETWEEN clock_timestamp()+interval '${MIN_AHEAD}' AND clock_timestamp()+interval '${MAX_AHEAD}' AS in_range
     FROM (SELECT ${localDueSql("$2", "w.time_zone")} AS due_at FROM workspaces w WHERE w.id=$1) converted`,
    [workspace, local],
  );
  const row = result.rows[0]!;
  if (!row.in_range) throw new ApiError(400, "reminder_due_out_of_range");
  return row.due_at;
}

export type ReminderResult = { conflict: false; reminder: Reminder } | { conflict: true; reminder: Reminder };

export async function createReminder(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
  input: unknown,
): Promise<ReminderResult> {
  if (!isUuid(connection) || !/^\d{1,40}$/.test(recipient) || query.size || !isRecord(input))
    throw new ApiError(400, "invalid_reminder_request");
  if (!("due_local" in input) || Object.keys(input).some((key) => !["due_local", "note"].includes(key)))
    throw new ApiError(400, "invalid_reminder_request");
  const local = localTime(input.due_local);
  const note = "note" in input ? reminderNote(input.note) : null;
  const { workspace_id: workspace } = await membershipFor(pool, user, "agent");
  try {
    return await transaction(pool, async (client) => {
      await lockConversationFor(client, user, workspace, connection, recipient, "connection_not_found");
      const exists = await client.query(
        "SELECT 1 FROM instagram_inbox_messages WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 LIMIT 1",
        [workspace, connection, recipient],
      );
      if (!exists.rowCount) throw new ApiError(404, "conversation_not_found");
      // Status changes take the conversation lock too, so this read is current until COMMIT.
      const closed = await client.query(
        `SELECT 1 FROM instagram_inbox_conversations
         WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND status='closed'`,
        [workspace, connection, recipient],
      );
      if (closed.rowCount) throw new ApiError(409, "conversation_closed");
      const current = await readCallerReminder(client, workspace, user.id, connection, recipient);
      if (current) return { conflict: true, reminder: current };
      const due = await dueAt(client, workspace, local);
      const id = (
        await client.query<{ id: string }>(
          `INSERT INTO instagram_inbox_reminders(workspace_id,connection_id,recipient_id,creator_id,due_at,note)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [workspace, connection, recipient, user.id, due, note],
        )
      ).rows[0]!.id;
      await client.query(
        `INSERT INTO instagram_inbox_reminder_events(reminder_id,workspace_id,connection_id,recipient_id,version,kind,due_at,note,actor_id)
         VALUES($1,$2,$3,$4,1,'created',$5,$6,$7)`,
        [id, workspace, connection, recipient, due, note, user.id],
      );
      return { conflict: false, reminder: await readReminder(client, id) };
    });
  } catch (error) {
    // The conversation lock makes the check above see a committed reminder; the unique index is the backstop.
    if (isRecord(error) && error.code === "23505") {
      const current = await readCallerReminder(pool, workspace, user.id, connection, recipient);
      if (current) return { conflict: true, reminder: current };
    }
    throw error;
  }
}

type Change = { kind: "changed"; local?: string; note?: string | null } | { kind: "completed" } | { kind: "cancelled" };

// Changes, completes or cancels one of the caller's reminders at its expected version. Another member's reminder is
// answered like a missing one.
async function writeReminder(
  pool: Pool,
  user: User,
  id: string,
  expected: number,
  change: Change,
): Promise<ReminderResult> {
  const { workspace_id: workspace } = await membershipFor(pool, user, "agent");
  const target = (
    await pool.query<{ connection_id: string; recipient_id: string }>(
      "SELECT connection_id,recipient_id FROM instagram_inbox_reminders WHERE id=$1 AND workspace_id=$2 AND creator_id=$3",
      [id, workspace, user.id],
    )
  ).rows[0];
  if (!target) throw new ApiError(404, "reminder_not_found");
  return transaction(pool, async (client) => {
    await lockConversationFor(client, user, workspace, target.connection_id, target.recipient_id, "reminder_not_found");
    const row = (
      await client.query<{ status: string; version: number; due_at: Date; note: string | null }>(
        `SELECT status,version,due_at,note FROM instagram_inbox_reminders
         WHERE id=$1 AND workspace_id=$2 AND creator_id=$3 FOR UPDATE`,
        [id, workspace, user.id],
      )
    ).rows[0];
    // A deletion that committed while this waited for the connection removed the reminder.
    if (!row) throw new ApiError(404, "reminder_not_found");
    if (row.version !== expected) return { conflict: true, reminder: await readReminder(client, id) };
    if (row.status !== "pending") throw new ApiError(409, "reminder_not_pending");
    let due = row.due_at,
      note = row.note;
    if (change.kind === "changed") {
      if (change.local !== undefined) due = await dueAt(client, workspace, change.local);
      if (change.note !== undefined) note = change.note;
      // An unchanged due time and note store nothing.
      if (due.getTime() === row.due_at.getTime() && note === row.note)
        return { conflict: false, reminder: await readReminder(client, id) };
    }
    const status = change.kind === "completed" ? "done" : change.kind === "cancelled" ? "cancelled" : "pending";
    const reason = change.kind === "cancelled" ? "manual" : null;
    const version = row.version + 1;
    await client.query(
      `UPDATE instagram_inbox_reminders SET due_at=$2,note=$3,status=$4,cancel_reason=$5,version=$6,updated_at=clock_timestamp()
       WHERE id=$1`,
      [id, due, note, status, reason, version],
    );
    await client.query(
      `INSERT INTO instagram_inbox_reminder_events(reminder_id,workspace_id,connection_id,recipient_id,version,kind,reason,due_at,note,actor_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, workspace, target.connection_id, target.recipient_id, version, change.kind, reason, due, note, user.id],
    );
    return { conflict: false, reminder: await readReminder(client, id) };
  });
}

export async function changeReminder(pool: Pool, user: User, id: string, query: URLSearchParams, input: unknown) {
  if (!isUuid(id) || query.size || !isRecord(input)) throw new ApiError(400, "invalid_reminder_request");
  const keys = Object.keys(input);
  if (
    !keys.includes("expected_version") ||
    keys.length < 2 ||
    keys.some((key) => !["expected_version", "due_local", "note"].includes(key))
  )
    throw new ApiError(400, "invalid_reminder_request");
  const expected = expectedVersion(input);
  return writeReminder(pool, user, id, expected, {
    kind: "changed",
    ...("due_local" in input ? { local: localTime(input.due_local) } : {}),
    ...("note" in input ? { note: reminderNote(input.note) } : {}),
  });
}

export async function closeReminder(
  pool: Pool,
  user: User,
  id: string,
  action: "complete" | "cancel",
  query: URLSearchParams,
  input: unknown,
) {
  if (
    !isUuid(id) ||
    query.size ||
    !isRecord(input) ||
    Object.keys(input).length !== 1 ||
    !("expected_version" in input)
  )
    throw new ApiError(400, "invalid_reminder_request");
  return writeReminder(pool, user, id, expectedVersion(input), {
    kind: action === "complete" ? "completed" : "cancelled",
  });
}

// The caller's pending reminders, earliest due first, 50 per page; due=true lists only due ones. The cursor carries
// due_at as integer microseconds, like the inbox list.
export async function listReminders(pool: Pool, user: User, query: URLSearchParams) {
  if (
    [...query.keys()].some((key) => !["due", "after"].includes(key) || query.getAll(key).length !== 1) ||
    (query.has("due") && query.get("due") !== "true")
  )
    throw new ApiError(400, "invalid_reminder_request");
  let after: { at: string; id: string } | null = null;
  if (query.has("after")) {
    try {
      const value: unknown = JSON.parse(Buffer.from(query.get("after")!, "base64url").toString());
      if (!isRecord(value) || typeof value.at !== "string" || !/^-?\d{1,18}$/.test(value.at) || !isUuid(value.id))
        throw new Error();
      after = { at: value.at, id: value.id };
    } catch {
      throw new ApiError(400, "invalid_reminder_request");
    }
  }
  const workspace = await workspaceFor(pool, user, "agent");
  const result = await pool.query<Reminder & { username: string | null; due_us: string }>(
    `SELECT * FROM (
       SELECT ${REMINDER_COLUMNS},c.username,(extract(epoch FROM r.due_at)*1000000)::bigint AS due_us
       FROM ${REMINDER_FROM} JOIN instagram_connections c ON c.id=r.connection_id AND c.workspace_id=r.workspace_id
       WHERE r.workspace_id=$1 AND r.creator_id=$2 AND r.status='pending' AND (NOT $3::boolean OR r.due_at<=now())
     ) listed
     WHERE $4::bigint IS NULL OR (due_us,id)>($4::bigint,$5::uuid)
     ORDER BY due_us,id LIMIT 51`,
    [workspace, user.id, query.get("due") === "true", after?.at ?? null, after?.id ?? null],
  );
  const reminders = result.rows.slice(0, 50).map(({ due_us: _us, ...reminder }) => reminder),
    last = result.rows[49];
  return {
    reminders,
    after:
      result.rows.length > 50
        ? Buffer.from(JSON.stringify({ at: last!.due_us, id: last!.id })).toString("base64url")
        : null,
  };
}

// Called inside saveConversationState's transaction after it took the conversation lock, when the change closes an
// open conversation: every member's pending reminder on it is cancelled with one audit row each and no actor. A later
// reopen, by a member or by a new DM, does not revive them.
export async function cancelClosedConversationReminders(
  client: PoolClient,
  workspace: string,
  connection: string,
  recipient: string,
): Promise<number> {
  const result = await client.query(
    `WITH cancelled AS (
       UPDATE instagram_inbox_reminders SET status='cancelled',cancel_reason='conversation_closed',version=version+1,
         updated_at=clock_timestamp()
       WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND status='pending'
       RETURNING id,version,due_at,note
     )
     INSERT INTO instagram_inbox_reminder_events(reminder_id,workspace_id,connection_id,recipient_id,version,kind,reason,due_at,note,actor_id)
     SELECT id,$1,$2,$3,version,'cancelled','conversation_closed',due_at,note,NULL FROM cancelled`,
    [workspace, connection, recipient],
  );
  return result.rowCount ?? 0;
}

// Called inside removeMember's transaction after it locked the workspace row and then the member row: the removed
// member's pending reminders are cancelled with one audit row each and no actor. The connections are locked FOR SHARE
// in ID order first, as the reminder writes and unassignRemovedMember do, so a concurrent data deletion queues.
export async function cancelRemovedMemberReminders(
  client: PoolClient,
  workspace: string,
  memberId: string,
): Promise<number> {
  await client.query(
    `SELECT 1 FROM instagram_connections WHERE workspace_id=$1 AND id IN (
       SELECT connection_id FROM instagram_inbox_reminders WHERE workspace_id=$1 AND creator_id=$2 AND status='pending'
     ) ORDER BY id FOR SHARE`,
    [workspace, memberId],
  );
  await client.query(
    `SELECT 1 FROM instagram_inbox_reminders WHERE workspace_id=$1 AND creator_id=$2 AND status='pending'
     ORDER BY id FOR UPDATE`,
    [workspace, memberId],
  );
  const result = await client.query(
    `WITH cancelled AS (
       UPDATE instagram_inbox_reminders SET status='cancelled',cancel_reason='member_removed',version=version+1,
         updated_at=clock_timestamp()
       WHERE workspace_id=$1 AND creator_id=$2 AND status='pending'
       RETURNING id,connection_id,recipient_id,version,due_at,note
     )
     INSERT INTO instagram_inbox_reminder_events(reminder_id,workspace_id,connection_id,recipient_id,version,kind,reason,due_at,note,actor_id)
     SELECT id,$1,connection_id,recipient_id,version,'cancelled','member_removed',due_at,note,NULL FROM cancelled`,
    [workspace, memberId],
  );
  return result.rowCount ?? 0;
}
