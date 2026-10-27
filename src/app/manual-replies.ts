import { CONTENT_TYPES, checkCapability } from "../channels/contract.ts";
import { createHash } from "node:crypto";
import { instagramCapabilities } from "../instagram/channel-adapter.ts";
import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";
import { manualReplyStatus } from "../instagram/manual-reply-worker.ts";
import { localDueSql } from "./inbox-reminders.ts";

function validate(connection: string, recipient: string, query: URLSearchParams) {
  if (!isUuid(connection) || !/^\d{1,40}$/.test(recipient) || query.size)
    throw new ApiError(400, "invalid_manual_reply_request");
}
export async function readManualReplyStatus(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
  enabled: boolean,
) {
  validate(connection, recipient, query);
  const workspace = await workspaceFor(pool, user, "agent");
  const owned = await pool.query(
    "SELECT 1 FROM instagram_connections c WHERE c.id=$1 AND c.workspace_id=$2 AND EXISTS(SELECT 1 FROM instagram_inbox_messages m WHERE m.workspace_id=c.workspace_id AND m.connection_id=c.id AND m.recipient_id=$3)",
    [connection, workspace, recipient],
  );
  if (!owned.rowCount) throw new ApiError(404, "conversation_not_found");
  const status = await manualReplyStatus(pool, {
    workspace_id: workspace,
    connection_id: connection,
    recipient_id: recipient,
  });
  const failure_code = status.failure_code ?? (enabled ? null : "global_send_disabled");
  return {
    ...status,
    failure_code,
    allowed: failure_code === null,
    channel: "instagram",
    capabilities: instagramCapabilities("cloudflare_oauth"),
  };
}
function requestKey(input: unknown, fields: string[]) {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== fields.length ||
    !fields.every((key) => key in input) ||
    !isUuid(input.request_key)
  )
    throw new ApiError(400, "invalid_manual_reply_request");
  return input;
}
function version(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2147483647)
    throw new ApiError(400, "invalid_manual_reply_request");
  return Number(value);
}
function reason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500)
    throw new ApiError(400, "invalid_manual_reply_request");
  return value.trim();
}
const columns =
  "id,text,status,failure_code,safe_to_retry,handoff_version,retry_of,created_at,sent_at,provider_message_id,resolved_at,created_by,scheduled_at,schedule_time_zone,schedule_version";

// A wall-clock "YYYY-MM-DDTHH:MM" that exists on the calendar; campaign approvals share it with their own code.
export function scheduleLocal(value: unknown, code = "invalid_reply_schedule"): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new ApiError(400, code);
  const instant = new Date(`${value}:00Z`);
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString().slice(0, 16) !== value ||
    instant.getUTCFullYear() < 2000
  )
    throw new ApiError(400, code);
  return value;
}

function scheduleZone(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 100) throw new ApiError(400, "invalid_reply_schedule");
  return value;
}

async function lockScheduleMember(client: PoolClient, workspace: string, user: User): Promise<string> {
  // Match member removal's workspace -> membership -> connection order and freeze the interpreted time zone.
  await client.query("SELECT id FROM workspaces WHERE id=$1 FOR SHARE", [workspace]);
  const member = (
    await client.query(
      "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND removed_at IS NULL FOR SHARE",
      [workspace, user.id],
    )
  ).rows[0];
  if (!member || !["owner", "admin", "agent"].includes(member.role)) throw new ApiError(403, "workspace_required");
  return member.role;
}

// The only fixed schedule bound; the upper bound is the recipient's reply window. Campaign approvals share it.
export const SCHEDULE_MIN_AHEAD = "1 minute";
async function readSchedule(client: PoolClient, workspace: string, local: string) {
  return (
    await client.query<{ scheduled_at: Date; time_zone: string; future: boolean }>(
      `SELECT scheduled_at,time_zone,scheduled_at>=clock_timestamp()+interval '${SCHEDULE_MIN_AHEAD}' AS future
       FROM (SELECT ${localDueSql("$2", "w.time_zone")} AS scheduled_at,
         w.time_zone FROM workspaces w WHERE w.id=$1) converted`,
      [workspace, local],
    )
  ).rows[0]!;
}

function checkSchedule(schedule: { scheduled_at: Date; future: boolean }, window: string | null) {
  if (!schedule.future || !window || schedule.scheduled_at.getTime() >= Date.parse(window))
    throw new ApiError(400, "reply_schedule_out_of_range");
}
async function lockConnection(client: PoolClient, workspace: string, connection: string) {
  if (
    !(
      await client.query("SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE", [
        connection,
        workspace,
      ])
    ).rowCount
  )
    throw new ApiError(404, "connection_not_found");
}
export async function queueManualReply(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
  input: unknown,
  enabled: boolean,
  retryOf?: string,
) {
  validate(connection, recipient, query);
  if (retryOf && !isUuid(retryOf)) throw new ApiError(400, "invalid_manual_reply_request");
  let contentType = "text";
  if (!retryOf && isRecord(input) && Object.hasOwn(input, "content_type")) {
    const { content_type, ...rest } = input;
    if (typeof content_type !== "string" || !CONTENT_TYPES.some((type) => type === content_type))
      throw new ApiError(400, "invalid_manual_reply_request");
    contentType = content_type;
    input = rest;
  }
  let local: string | null = null;
  let expectedZone: string | null = null;
  if (!retryOf && isRecord(input) && Object.hasOwn(input, "schedule_local")) {
    const { schedule_local, expected_time_zone, ...rest } = input;
    local = scheduleLocal(schedule_local);
    expectedZone = scheduleZone(expected_time_zone);
    input = rest;
  }
  const body = requestKey(
    input,
    retryOf
      ? ["request_key", "expected_handoff_version", "reason"]
      : ["request_key", "expected_handoff_version", "text"],
  );
  const handoffVersion = version(body.expected_handoff_version);
  if (!retryOf && (typeof body.text !== "string" || !body.text.trim() || body.text.length > 1000))
    throw new ApiError(400, "invalid_manual_reply_request");
  const retryReason = retryOf ? reason(body.reason) : null;
  const scheduleFingerprint =
    local === null
      ? null
      : createHash("sha256")
          .update(JSON.stringify([handoffVersion, body.text, local, expectedZone]))
          .digest("hex");
  const workspace = await workspaceFor(pool, user, "agent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (local !== null) await lockScheduleMember(client, workspace, user);
    await lockConnection(client, workspace, connection);
    if (!checkCapability(instagramCapabilities("cloudflare_oauth"), "manual_reply", contentType))
      throw new ApiError(422, "channel_capability_unsupported");
    const old = (
      await client.query(
        `SELECT ${columns},retry_reason FROM instagram_manual_replies WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND request_key=$4`,
        [workspace, connection, recipient, body.request_key],
      )
    ).rows[0];
    if (old) {
      const sameSchedule =
        local === null
          ? old.scheduled_at === null
          : old.scheduled_at !== null &&
            Boolean(
              (
                await client.query(
                  "SELECT 1 FROM instagram_manual_reply_events WHERE reply_id=$1 AND kind='queued' AND request_fingerprint=$2",
                  [old.id, scheduleFingerprint],
                )
              ).rowCount,
            );
      if (
        old.created_by !== user.id ||
        old.handoff_version !== handoffVersion ||
        old.retry_of !== (retryOf ?? null) ||
        old.retry_reason !== retryReason ||
        (!retryOf && local === null && old.text !== body.text) ||
        !sameSchedule
      )
        throw new ApiError(409, "idempotency_conflict");
      await client.query("COMMIT");
      const { retry_reason: _reason, ...result } = old;
      return result;
    }
    let text = body.text;
    if (retryOf) {
      const original = (
        await client.query(
          "SELECT status,safe_to_retry,text FROM instagram_manual_replies WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND id=$4 FOR UPDATE",
          [workspace, connection, recipient, retryOf],
        )
      ).rows[0];
      if (!original) throw new ApiError(404, "reply_not_found");
      if (
        original.status !== "failed" ||
        !original.safe_to_retry ||
        (await client.query("SELECT 1 FROM instagram_manual_replies WHERE retry_of=$1", [retryOf])).rowCount
      )
        throw new ApiError(409, "reply_not_retryable");
      text = original.text;
    }
    const status = await manualReplyStatus(client, {
      workspace_id: workspace,
      connection_id: connection,
      recipient_id: recipient,
      handoff_version: handoffVersion,
    });
    if (status.failure_code) throw new ApiError(409, status.failure_code);
    if (!enabled) throw new ApiError(409, "global_send_disabled");
    const schedule = local === null ? null : await readSchedule(client, workspace, local);
    if (schedule && schedule.time_zone !== expectedZone) throw new ApiError(409, "reply_schedule_timezone_changed");
    if (schedule) checkSchedule(schedule, status.window_expires_at);
    const result = await client.query(
      `INSERT INTO instagram_manual_replies(workspace_id,connection_id,recipient_id,request_key,created_by,text,handoff_version,retry_of,retry_reason,scheduled_at,schedule_time_zone,next_attempt_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($10::timestamptz,clock_timestamp())) RETURNING ${columns}`,
      [
        workspace,
        connection,
        recipient,
        body.request_key,
        user.id,
        text,
        handoffVersion,
        retryOf ?? null,
        retryReason,
        schedule?.scheduled_at ?? null,
        schedule?.time_zone ?? null,
      ],
    );
    const reply = result.rows[0];
    await client.query(
      "INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,actor_id,reason,scheduled_at,schedule_version,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        workspace,
        connection,
        recipient,
        reply.id,
        retryOf ? "retry_requested" : "queued",
        user.id,
        retryReason,
        schedule?.scheduled_at ?? null,
        schedule ? 1 : null,
        scheduleFingerprint,
      ],
    );
    await client.query("COMMIT");
    return reply;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function changeManualReplySchedule(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  reply: string,
  query: URLSearchParams,
  input: unknown,
  enabled: boolean,
  cancel: boolean,
) {
  validate(connection, recipient, query);
  if (!isUuid(reply)) throw new ApiError(400, "invalid_manual_reply_request");
  const body = requestKey(
    input,
    cancel
      ? ["request_key", "expected_version"]
      : ["request_key", "expected_version", "text", "schedule_local", "expected_time_zone"],
  );
  const expected = version(body.expected_version);
  const local = cancel ? null : scheduleLocal(body.schedule_local);
  const expectedZone = cancel ? null : scheduleZone(body.expected_time_zone);
  if (
    !cancel &&
    (typeof body.text !== "string" || !body.text.trim() || body.text.length > 1000 || body.text.includes("\0"))
  )
    throw new ApiError(400, "invalid_manual_reply_request");
  const kind = cancel ? "cancelled" : "rescheduled";
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([kind, reply, expected, cancel ? null : body.text, local, expectedZone]))
    .digest("hex");
  const workspace = await workspaceFor(pool, user, "agent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const role = await lockScheduleMember(client, workspace, user);
    await lockConnection(client, workspace, connection);
    const row = (
      await client.query(
        `SELECT ${columns} FROM instagram_manual_replies WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND id=$4 FOR UPDATE`,
        [workspace, connection, recipient, reply],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "reply_not_found");
    if (row.created_by !== user.id && role === "agent") throw new ApiError(403, "reply_schedule_forbidden");
    const previous = (
      await client.query(
        "SELECT reply_id,actor_id,kind,request_fingerprint FROM instagram_manual_reply_events WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND request_key=$4",
        [workspace, connection, recipient, body.request_key],
      )
    ).rows[0];
    if (previous) {
      if (
        previous.reply_id !== reply ||
        previous.actor_id !== user.id ||
        previous.kind !== kind ||
        previous.request_fingerprint !== fingerprint
      )
        throw new ApiError(409, "idempotency_conflict");
      await client.query("COMMIT");
      return row;
    }
    if (!row.scheduled_at || row.status !== "pending") throw new ApiError(409, "reply_schedule_not_pending");
    if (row.schedule_version !== expected || row.schedule_version === 2147483647)
      throw new ApiError(409, "reply_schedule_conflict");
    let schedule = { scheduled_at: row.scheduled_at as Date, time_zone: row.schedule_time_zone as string };
    if (!cancel) {
      if (
        !(
          await client.query(
            "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND removed_at IS NULL",
            [workspace, row.created_by],
          )
        ).rowCount
      )
        throw new ApiError(409, "scheduled_actor_unavailable");
      const status = await manualReplyStatus(client, {
        workspace_id: workspace,
        connection_id: connection,
        recipient_id: recipient,
        handoff_version: row.handoff_version,
      });
      if (status.failure_code) throw new ApiError(409, status.failure_code);
      if (!enabled) throw new ApiError(409, "global_send_disabled");
      const proposed = await readSchedule(client, workspace, local!);
      if (proposed.time_zone !== expectedZone) throw new ApiError(409, "reply_schedule_timezone_changed");
      checkSchedule(proposed, status.window_expires_at);
      schedule = proposed;
    }
    const result = (
      await client.query(
        `UPDATE instagram_manual_replies SET text=$5,scheduled_at=$6,schedule_time_zone=$7,schedule_version=schedule_version+1,
         status=$8,failure_code=NULL,next_attempt_at=CASE WHEN $8='cancelled' THEN next_attempt_at ELSE $6 END
       WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND id=$4 RETURNING ${columns}`,
        [
          workspace,
          connection,
          recipient,
          reply,
          cancel ? row.text : body.text,
          schedule.scheduled_at,
          schedule.time_zone,
          cancel ? "cancelled" : "pending",
        ],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,actor_id,request_key,request_fingerprint,scheduled_at,schedule_version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        workspace,
        connection,
        recipient,
        reply,
        kind,
        user.id,
        body.request_key,
        fingerprint,
        result.scheduled_at,
        result.schedule_version,
      ],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveManualReply(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  reply: string,
  query: URLSearchParams,
  input: unknown,
) {
  validate(connection, recipient, query);
  if (!isUuid(reply)) throw new ApiError(400, "invalid_manual_reply_request");
  const body = requestKey(input, ["request_key", "decision", "reason"]);
  if (body.decision !== "no_retry") throw new ApiError(400, "invalid_manual_reply_request");
  const note = reason(body.reason),
    workspace = await workspaceFor(pool, user, "agent"),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockConnection(client, workspace, connection);
    const existing = (
      await client.query(
        "SELECT reply_id,reason,actor_id FROM instagram_manual_reply_events WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND request_key=$4",
        [workspace, connection, recipient, body.request_key],
      )
    ).rows[0];
    if (existing) {
      if (existing.reply_id !== reply || existing.reason !== note || existing.actor_id !== user.id)
        throw new ApiError(409, "idempotency_conflict");
    } else {
      const found = (
        await client.query(
          "SELECT status,resolved_at FROM instagram_manual_replies WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND id=$4 FOR UPDATE",
          [workspace, connection, recipient, reply],
        )
      ).rows[0];
      if (!found) throw new ApiError(404, "reply_not_found");
      if (found.status !== "unknown" || found.resolved_at) throw new ApiError(409, "reply_not_unresolved");
      await client.query("UPDATE instagram_manual_replies SET resolved_at=clock_timestamp() WHERE id=$1", [reply]);
      await client.query(
        "INSERT INTO instagram_manual_reply_events(workspace_id,connection_id,recipient_id,reply_id,kind,actor_id,request_key,reason) VALUES($1,$2,$3,$4,'no_retry',$5,$6,$7)",
        [workspace, connection, recipient, reply, user.id, body.request_key, note],
      );
    }
    await client.query("COMMIT");
    return { id: reply, status: "unknown", decision: "no_retry" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function listManualReplies(
  pool: Pool,
  user: User,
  connection: string,
  recipient: string,
  query: URLSearchParams,
) {
  if ([...query.keys()].some((key) => key !== "before" || query.getAll(key).length !== 1))
    throw new ApiError(400, "invalid_manual_reply_query");
  validate(connection, recipient, new URLSearchParams());
  let cursor: { created_at: string; id: string } | null = null;
  if (query.has("before")) {
    try {
      const value: unknown = JSON.parse(Buffer.from(query.get("before")!, "base64url").toString());
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 2 ||
        !isUuid(value.id) ||
        typeof value.created_at !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.created_at) ||
        !Number.isFinite(Date.parse(value.created_at))
      )
        throw new Error("cursor");
      cursor = { id: value.id, created_at: value.created_at };
    } catch {
      throw new ApiError(400, "invalid_manual_reply_query");
    }
  }
  const workspace = await workspaceFor(pool, user, "agent");
  if (
    !(await pool.query("SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2", [connection, workspace]))
      .rowCount
  )
    throw new ApiError(404, "connection_not_found");
  const result = await pool.query(
    `SELECT ${columns},to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM instagram_manual_replies WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51`,
    [workspace, connection, recipient, cursor?.created_at ?? null, cursor?.id ?? null],
  );
  const rows = result.rows.slice(0, 50);
  const events = rows.length
    ? (
        await pool.query(
          "SELECT event.reply_id,event.kind,event.attempt_id,event.actor_id,event.reason,event.failure_code,event.created_at,event.scheduled_at,event.schedule_version FROM unnest($4::uuid[]) selected(reply_id) CROSS JOIN LATERAL (SELECT reply_id,kind,attempt_id,actor_id,reason,failure_code,created_at,id,scheduled_at,schedule_version FROM instagram_manual_reply_events WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 AND reply_id=selected.reply_id ORDER BY created_at DESC,id DESC LIMIT 50) event ORDER BY event.created_at,event.id",
          [workspace, connection, recipient, rows.map((row) => row.id)],
        )
      ).rows
    : [];
  const last = rows.at(-1);
  return {
    replies: rows.map(({ cursor_time: _time, ...row }) => ({
      ...row,
      events: events.filter((event) => event.reply_id === row.id),
    })),
    before:
      result.rows.length > 50
        ? Buffer.from(JSON.stringify({ created_at: last.cursor_time, id: last.id })).toString("base64url")
        : null,
  };
}
