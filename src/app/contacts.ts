import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { lockWorkspaceForMember, workspaceFor } from "./settings.ts";
import {
  fieldConditionNeedsValue,
  lockContact,
  parseFieldCondition,
  validateFieldCondition,
} from "./contact-fields.ts";

type Contact = {
  connection_id: string;
  sender_id: string;
  username: string | null;
  first_comment_at: Date;
  last_comment_at: Date;
  comment_count: string;
  automation_paused: boolean;
  tags: string[];
  fields: Record<string, unknown>;
};
export const CONTACT_TAG_LIMIT = 20;
export const CONTACT_TAG_LENGTH = 40;
function tag(value: unknown): string {
  if (typeof value !== "string" || value.length > 200) throw new ApiError(400, "invalid_contact_tags");
  const result = value.trim().normalize("NFC").toLowerCase();
  if (!result || result.length > CONTACT_TAG_LENGTH || /[\p{Cc}\p{Cf}]/u.test(result))
    throw new ApiError(400, "invalid_contact_tags");
  return result;
}
export function normalizeContactTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > CONTACT_TAG_LIMIT) throw new ApiError(400, "invalid_contact_tags");
  return [...new Set(value.map(tag))].sort();
}
function parseConditionOperator(value: unknown, filterTag: string | null, hasField: boolean): "and" | "or" {
  if (value === undefined) return "and";
  if ((value !== "and" && value !== "or") || (value === "or" && (!filterTag || !hasField)))
    throw new ApiError(400, "invalid_contact_condition");
  return value;
}
function parseActivityWindow(input: {
  last_comment_from?: unknown;
  last_comment_before?: unknown;
  last_comment_days?: unknown;
}): { last_comment_from?: string; last_comment_before?: string; last_comment_days?: number } | null {
  const from = input.last_comment_from,
    before = input.last_comment_before;
  if (input.last_comment_days != null) {
    const days = input.last_comment_days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 366 || from != null || before != null)
      throw new ApiError(400, "invalid_contact_activity");
    return { last_comment_days: days };
  }
  if (from == null && before == null) return null;
  const valid = (value: unknown): value is string => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      value.startsWith("0000-")
    )
      return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  };
  if (!valid(from) || !valid(before) || from >= before) throw new ApiError(400, "invalid_contact_activity");
  return { last_comment_from: from, last_comment_before: before };
}
function parseConsentCondition(input: { consent_purpose?: unknown; consent_state?: unknown }) {
  const purpose = input.consent_purpose,
    state = input.consent_state;
  if (purpose == null && state == null) return null;
  if (
    (purpose !== "service_reply" && purpose !== "marketing") ||
    (state !== "granted" && state !== "revoked" && state !== "no_record")
  )
    throw new ApiError(400, "invalid_contact_consent");
  return { consent_purpose: purpose, consent_state: state };
}
// Contact writes share the connection row lock with delete_connection_data (FOR NO KEY UPDATE),
// so a write either finishes before a deletion or re-checks the contact after it.
export async function lockContactConnection(client: PoolClient, workspace: string, connectionId: string) {
  await client.query("SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2 FOR SHARE", [
    connectionId,
    workspace,
  ]);
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
    if (
      ![
        "connection_id",
        "tag",
        "after",
        "segment_id",
        "field_id",
        "field_operator",
        "field_value",
        "condition_operator",
        "last_comment_from",
        "last_comment_before",
        "last_comment_days",
        "consent_purpose",
        "consent_state",
        "preview",
      ].includes(key) ||
      options.getAll(key).length !== 1
    )
      throw new ApiError(400, "invalid_contact_request");
  const preview = options.has("preview");
  if (preview && (options.get("preview") !== "true" || options.has("after")))
    throw new ApiError(400, "invalid_contact_request");
  let connectionId = options.get("connection_id");
  if (connectionId !== null && !isUuid(connectionId)) throw new ApiError(400, "invalid_contact_request");
  let filterTag = options.has("tag") ? tag(options.get("tag")) : null;
  const segmentId = options.get("segment_id");
  if (
    segmentId !== null &&
    (!isUuid(segmentId) ||
      [
        "connection_id",
        "tag",
        "field_id",
        "field_operator",
        "field_value",
        "condition_operator",
        "last_comment_from",
        "last_comment_before",
        "last_comment_days",
        "consent_purpose",
        "consent_state",
      ].some((key) => options.has(key)))
  )
    throw new ApiError(400, "invalid_contact_request");
  const fieldInput: Record<string, unknown> = {};
  for (const key of ["field_id", "field_operator", "field_value"])
    if (options.has(key)) fieldInput[key] = options.get(key);
  if (Object.hasOwn(fieldInput, "field_value")) {
    try {
      fieldInput.field_value = JSON.parse(String(fieldInput.field_value));
    } catch {
      throw new ApiError(400, "invalid_field_condition");
    }
  }
  let condition = parseFieldCondition(fieldInput);
  const days = options.get("last_comment_days");
  if (days !== null && !/^[1-9][0-9]{0,2}$/.test(days)) throw new ApiError(400, "invalid_contact_activity");
  let activity = parseActivityWindow({
    last_comment_from: options.get("last_comment_from"),
    last_comment_before: options.get("last_comment_before"),
    last_comment_days: days === null ? null : Number(days),
  });
  let consent = parseConsentCondition({
    consent_purpose: options.get("consent_purpose"),
    consent_state: options.get("consent_state"),
  });
  let operator = parseConditionOperator(options.get("condition_operator") ?? undefined, filterTag, Boolean(condition));
  const after = cursor(options.get("after"));
  const workspaceId = await workspaceFor(pool, user, "agent");
  if (segmentId !== null) {
    const segment = await pool.query<{
      connection_id: string | null;
      tag: string | null;
      field_id: string | null;
      field_operator: string;
      field_value: unknown;
      condition_operator: string;
      last_comment_from: Date | null;
      last_comment_before: Date | null;
      last_comment_days: number | null;
      consent_purpose: string | null;
      consent_state: string | null;
    }>(
      "SELECT connection_id,tag,field_id,field_operator,field_value,condition_operator,last_comment_from,last_comment_before,last_comment_days,consent_purpose,consent_state FROM instagram_contact_segments WHERE workspace_id=$1 AND id=$2 AND NOT archived",
      [workspaceId, segmentId],
    );
    if (!segment.rows[0]) throw new ApiError(404, "segment_not_found");
    connectionId = segment.rows[0].connection_id;
    filterTag = segment.rows[0].tag;
    const saved = segment.rows[0];
    consent = parseConsentCondition(saved);
    activity = parseActivityWindow({
      last_comment_from: saved.last_comment_from?.toISOString(),
      last_comment_before: saved.last_comment_before?.toISOString(),
      last_comment_days: saved.last_comment_days,
    });
    condition = saved.field_id
      ? {
          field_id: saved.field_id,
          field_operator: saved.field_operator,
          ...(fieldConditionNeedsValue(saved.field_operator) ? { field_value: saved.field_value } : {}),
        }
      : null;
    operator = parseConditionOperator(saved.condition_operator, filterTag, Boolean(condition));
  }
  await validateFieldCondition(pool, workspaceId, condition);
  // One statement clock for the page and preview, using elapsed hours even across DST.
  const evaluation = `evaluation AS MATERIALIZED (SELECT statement_timestamp() AS as_of)`;
  const relativeWindow = `(SELECT json_build_object(
    'from',to_char((as_of - $14::int * interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'before',to_char(as_of AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) FROM evaluation)`;
  const activityMatches = `(CASE WHEN $14::int IS NOT NULL THEN
    max(e.created_at)>=(SELECT as_of - $14 * interval '24 hours' FROM evaluation)
    AND max(e.created_at)<(SELECT as_of FROM evaluation)
    ELSE ($10::timestamptz IS NULL OR (max(e.created_at)>=$10 AND max(e.created_at)<$11::timestamptz)) END)`;
  const consentScope = `FROM channel_consent_state state WHERE state.workspace_id=e.workspace_id
    AND state.connection_id=e.connection_id AND state.channel='instagram' AND state.identity_kind='comment_sender'
    AND state.identity_value=e.sender_id AND state.purpose=$12`;
  // Recorded state only; this is not the delivery guard and never bridges DM identities.
  const consentMatches = `($12::text IS NULL OR CASE WHEN $13::text='no_record' THEN NOT EXISTS(SELECT 1 ${consentScope})
    ELSE EXISTS(SELECT 1 ${consentScope} AND state.decision=CASE WHEN $13='granted' THEN 'grant' ELSE 'revoke' END) END)`;
  const fieldMatches = `($6::uuid IS NULL OR CASE WHEN $7::text='is_unset' THEN NOT EXISTS(
   SELECT 1 FROM instagram_contact_field_values v WHERE v.workspace_id=e.workspace_id AND v.connection_id=e.connection_id AND v.sender_id=e.sender_id AND v.field_id=$6 AND v.value IS NOT NULL)
 ELSE EXISTS(SELECT 1 FROM instagram_contact_field_values v WHERE v.workspace_id=e.workspace_id AND v.connection_id=e.connection_id AND v.sender_id=e.sender_id AND v.field_id=$6 AND v.value IS NOT NULL
   AND ($7='is_set' OR (jsonb_typeof(v.value)=jsonb_typeof($8::jsonb) AND CASE $7
     WHEN 'eq' THEN v.value=$8::jsonb WHEN 'gt' THEN v.value>$8::jsonb WHEN 'gte' THEN v.value>=$8::jsonb
     WHEN 'lt' THEN v.value<$8::jsonb WHEN 'lte' THEN v.value<=$8::jsonb ELSE false END))) END)`;
  const contactScope = `FROM instagram_comment_events e JOIN instagram_connections c ON c.id=e.connection_id AND c.workspace_id=e.workspace_id
 LEFT JOIN instagram_contact_automation automation ON automation.workspace_id=e.workspace_id AND automation.connection_id=e.connection_id AND automation.sender_id=e.sender_id
 LEFT JOIN instagram_contact_tags t ON t.workspace_id=e.workspace_id AND t.connection_id=e.connection_id AND t.sender_id=e.sender_id
 WHERE e.workspace_id=$1 AND ($2::uuid IS NULL OR e.connection_id=$2)`;
  const contactQuery = `SELECT e.connection_id,e.sender_id,c.username,min(e.created_at) AS first_comment_at,
 max(e.created_at) AS last_comment_at,count(*)::text AS comment_count,coalesce((automation.paused OR automation.handoff_paused),false) AS automation_paused,coalesce(t.tags,'{}'::text[]) AS tags,
 coalesce((SELECT jsonb_object_agg(v.field_id::text,v.value) FROM instagram_contact_field_values v
 JOIN instagram_contact_fields f ON f.id=v.field_id AND f.workspace_id=v.workspace_id AND NOT f.archived
 WHERE v.workspace_id=e.workspace_id AND v.connection_id=e.connection_id AND v.sender_id=e.sender_id AND v.value IS NOT NULL),'{}'::jsonb) AS fields
 ${contactScope}
 AND ($9::text='or' OR $3::text IS NULL OR $3=ANY(t.tags))
 AND ($4::uuid IS NULL OR (e.connection_id,e.sender_id)>($4::uuid,$5::text))
 AND (($9::text='or' AND $3=ANY(t.tags)) OR ${fieldMatches})
 AND ${consentMatches}
 GROUP BY e.workspace_id,e.connection_id,e.sender_id,c.username,t.tags,(automation.paused OR automation.handoff_paused)
 HAVING ${activityMatches} ORDER BY e.connection_id,e.sender_id LIMIT 51`;
  // Aggregate independently of matching samples so even zero matches retain their exclusion summary.
  // Materialize only identities and predicate outcomes, not every contact's displayed field JSON.
  const query = preview
    ? `WITH ${evaluation}, contact_filters AS MATERIALIZED (
 SELECT e.connection_id,e.sender_id,coalesce($3::text IS NULL OR $3=ANY(t.tags),false) AS tag_matches,
 ${fieldMatches} AS field_matches,${activityMatches} AS activity_matches,${consentMatches} AS consent_matches
 ${contactScope}
 GROUP BY e.workspace_id,e.connection_id,e.sender_id,t.tags
), outcomes AS (
 SELECT *,activity_matches AND consent_matches AND CASE WHEN $9::text='or' THEN tag_matches OR field_matches ELSE tag_matches AND field_matches END AS matched
 FROM contact_filters
), summary AS (
 SELECT count(*)::text AS preview_evaluated,
 (count(*) FILTER (WHERE matched))::text AS preview_total,
 (count(*) FILTER (WHERE NOT activity_matches))::text AS preview_excluded_activity,
 (count(*) FILTER (WHERE activity_matches AND NOT consent_matches))::text AS preview_excluded_consent,
 (count(*) FILTER (WHERE activity_matches AND consent_matches AND NOT matched AND NOT tag_matches AND field_matches))::text AS preview_excluded_tag,
 (count(*) FILTER (WHERE activity_matches AND consent_matches AND NOT matched AND tag_matches AND NOT field_matches))::text AS preview_excluded_field,
 (count(*) FILTER (WHERE activity_matches AND consent_matches AND NOT matched AND NOT tag_matches AND NOT field_matches))::text AS preview_excluded_both
 FROM outcomes
)
 SELECT page.*,summary.*,${relativeWindow} AS activity_window FROM summary LEFT JOIN LATERAL (${contactQuery}) page ON true
 ORDER BY page.connection_id,page.sender_id`
    : activity?.last_comment_days
      ? `WITH ${evaluation} SELECT page.*,${relativeWindow} AS activity_window
         FROM evaluation LEFT JOIN LATERAL (${contactQuery}) page ON true ORDER BY page.connection_id,page.sender_id`
      : `WITH ${evaluation} ${contactQuery}`;
  const result = await pool.query<
    (Contact | { [Key in keyof Contact]: null }) & {
      preview_total?: string;
      preview_evaluated?: string;
      preview_excluded_tag?: string;
      preview_excluded_field?: string;
      preview_excluded_both?: string;
      preview_excluded_activity?: string;
      preview_excluded_consent?: string;
      activity_window?: { from: string; before: string };
    }
  >(query, [
    workspaceId,
    connectionId,
    filterTag,
    after?.connection_id ?? null,
    after?.sender_id ?? null,
    condition?.field_id ?? null,
    condition?.field_operator ?? null,
    condition && fieldConditionNeedsValue(condition.field_operator) ? JSON.stringify(condition.field_value) : null,
    operator,
    activity?.last_comment_from ?? null,
    activity?.last_comment_before ?? null,
    consent?.consent_purpose ?? null,
    consent?.consent_state ?? null,
    activity?.last_comment_days ?? null,
  ]);
  const summary = result.rows[0];
  const contacts = result.rows
    .slice(0, 50)
    .flatMap(
      ({
        preview_total,
        preview_evaluated,
        preview_excluded_tag,
        preview_excluded_field,
        preview_excluded_both,
        preview_excluded_activity,
        preview_excluded_consent,
        activity_window,
        ...contact
      }) => (contact.connection_id === null ? [] : [contact]),
    );
  const last = contacts.at(-1);
  return {
    contacts,
    ...(activity?.last_comment_days ? { activity_window: summary?.activity_window } : {}),
    ...(preview
      ? {
          total: summary?.preview_total ?? "0",
          evaluated: summary?.preview_evaluated ?? "0",
          excluded: {
            ...(activity ? { activity: summary?.preview_excluded_activity ?? "0" } : {}),
            ...(consent ? { consent: summary?.preview_excluded_consent ?? "0" } : {}),
            tag: summary?.preview_excluded_tag ?? "0",
            field: summary?.preview_excluded_field ?? "0",
            both: summary?.preview_excluded_both ?? "0",
          },
        }
      : {}),
    after:
      result.rows.length > 50 && last
        ? Buffer.from(JSON.stringify({ connection_id: last.connection_id, sender_id: last.sender_id })).toString(
            "base64url",
          )
        : null,
  };
}
export async function saveContactTags(pool: Pool, user: User, connectionId: string, senderId: string, input: unknown) {
  if (!isUuid(connectionId) || !senderIdentity(senderId) || !isRecord(input))
    throw new ApiError(400, "invalid_contact_tags");
  const tags = normalizeContactTags(input.tags);
  const workspaceId = await workspaceFor(pool, user, "agent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockContactConnection(client, workspaceId, connectionId);
    await lockContact(client, connectionId, senderId);
    const result = await client.query(
      `INSERT INTO instagram_contact_tags(workspace_id,connection_id,sender_id,tags)
 SELECT $1,$2,$3,$4::text[] WHERE EXISTS(SELECT 1 FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3)
 ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET tags=EXCLUDED.tags RETURNING tags`,
      [workspaceId, connectionId, senderId, tags],
    );
    if (!result.rows[0]) throw new ApiError(404, "contact_not_found");
    await client.query("COMMIT");
    return { tags: result.rows[0].tags };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// The columns of a segment list item, also returned by create and edit.
const SEGMENT_COLUMNS =
  "id,name,connection_id,tag,field_id,field_operator,field_value,condition_operator,last_comment_from,last_comment_before,last_comment_days,consent_purpose,consent_state,version";

export async function listContactSegments(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user, "agent");
  return (
    await pool.query(
      `SELECT ${SEGMENT_COLUMNS} FROM instagram_contact_segments WHERE workspace_id=$1 AND NOT archived ORDER BY name,id`,
      [workspace],
    )
  ).rows.map(segmentResult);
}

function segmentResult(row: {
  id: string;
  name: string;
  connection_id: string | null;
  tag: string | null;
  version: number;
  field_id?: string | null;
  field_operator?: string | null;
  field_value?: unknown;
  condition_operator?: string;
  last_comment_from?: Date | null;
  last_comment_before?: Date | null;
  last_comment_days?: number | null;
  consent_purpose?: string | null;
  consent_state?: string | null;
}) {
  const {
    field_id,
    field_operator,
    field_value,
    condition_operator,
    last_comment_from,
    last_comment_before,
    last_comment_days,
    consent_purpose,
    consent_state,
    ...base
  } = row;
  return {
    ...base,
    ...(last_comment_days ? { last_comment_days } : {}),
    ...(consent_purpose && consent_state ? { consent_purpose, consent_state } : {}),
    ...(last_comment_from && last_comment_before
      ? { last_comment_from: last_comment_from.toISOString(), last_comment_before: last_comment_before.toISOString() }
      : {}),
    ...(condition_operator === "or" ? { condition_operator } : {}),
    ...(field_id
      ? { field_id, field_operator, ...(fieldConditionNeedsValue(field_operator ?? "") ? { field_value } : {}) }
      : {}),
  };
}

const SEGMENT_DEFINITION_KEYS = [
  "name",
  "connection_id",
  "tag",
  "field_id",
  "field_operator",
  "field_value",
  "condition_operator",
  "last_comment_from",
  "last_comment_before",
  "last_comment_days",
  "consent_purpose",
  "consent_state",
];

// Create and edit share this parser, so both accept and refuse the same definitions. The body is a full
// definition: an omitted optional condition means that condition is absent.
export function parseSegmentDefinition(input: unknown, extraKeys: readonly string[] = []) {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !SEGMENT_DEFINITION_KEYS.includes(key) && !extraKeys.includes(key)) ||
    typeof input.name !== "string" ||
    input.name.length > 300
  )
    throw new ApiError(400, "invalid_segment");
  const name = input.name.trim().normalize("NFC");
  if (!name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new ApiError(400, "invalid_segment");
  const connectionId = input.connection_id ?? null;
  if (connectionId !== null && !isUuid(connectionId)) throw new ApiError(400, "invalid_segment");
  const filterTag = input.tag === undefined || input.tag === null || input.tag === "" ? null : tag(input.tag);
  const condition = parseFieldCondition(input);
  const activity = parseActivityWindow(input);
  const consent = parseConsentCondition(input);
  const operator = parseConditionOperator(input.condition_operator, filterTag, Boolean(condition));
  return { input, name, connectionId, filterTag, condition, activity, consent, operator };
}
type SegmentDefinition = ReturnType<typeof parseSegmentDefinition>;

// The stored columns of a definition, in the order of segmentDefinitionValues.
const SEGMENT_DEFINITION_COLUMNS =
  "name,connection_id,tag,field_id,field_operator,field_value,condition_operator,last_comment_from,last_comment_before,consent_purpose,consent_state,last_comment_days";
function segmentDefinitionValues(definition: SegmentDefinition) {
  const { name, connectionId, filterTag, condition, activity, consent, operator } = definition;
  return [
    name,
    connectionId,
    filterTag,
    condition?.field_id ?? null,
    condition?.field_operator ?? null,
    condition && fieldConditionNeedsValue(condition.field_operator) ? JSON.stringify(condition.field_value) : null,
    operator,
    activity?.last_comment_from ?? null,
    activity?.last_comment_before ?? null,
    consent?.consent_purpose ?? null,
    consent?.consent_state ?? null,
    activity?.last_comment_days ?? null,
  ];
}

// The referenced field is held FOR SHARE until commit, so archiveContactField (field FOR UPDATE, then the
// active-segment check) either waits and sees this segment, or commits first and this refuses the field.
async function validateSegmentReferences(client: PoolClient, workspace: string, definition: SegmentDefinition) {
  await validateFieldCondition(client, workspace, definition.condition, true);
  if (
    definition.connectionId !== null &&
    !(
      await client.query("SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2", [
        definition.connectionId,
        workspace,
      ])
    ).rows[0]
  )
    throw new ApiError(404, "connection_not_found");
}

export async function createContactSegment(pool: Pool, user: User, input: unknown) {
  const definition = parseSegmentDefinition(input);
  const workspace = await workspaceFor(pool, user, "admin");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize creations so concurrent requests cannot exceed the active-segment limit.
    await lockWorkspaceForMember(client, workspace, user, "admin");
    await validateSegmentReferences(client, workspace, definition);
    const result = await client.query(
      `INSERT INTO instagram_contact_segments(workspace_id,${SEGMENT_DEFINITION_COLUMNS})
 SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13 WHERE (SELECT count(*) FROM instagram_contact_segments WHERE workspace_id=$1 AND NOT archived)<50
 RETURNING ${SEGMENT_COLUMNS}`,
      [workspace, ...segmentDefinitionValues(definition)],
    );
    if (!result.rows[0]) throw new ApiError(409, "segment_limit_reached");
    await client.query("COMMIT");
    return segmentResult(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    if (isRecord(error) && error.code === "23505") throw new ApiError(409, "segment_name_exists");
    throw error;
  } finally {
    client.release();
  }
}

export type SaveSegmentResult = { conflict: boolean; segment: ReturnType<typeof segmentResult> };

// Replaces an active segment's name and conditions when expected_version matches. A stale version answers with
// the current segment; an unchanged definition writes nothing and keeps the version. There is no edit history.
export async function updateContactSegment(
  pool: Pool,
  user: User,
  id: string,
  input: unknown,
): Promise<SaveSegmentResult> {
  if (!isUuid(id)) throw new ApiError(400, "invalid_segment");
  const definition = parseSegmentDefinition(input, ["expected_version"]);
  const expected = definition.input.expected_version;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 1)
    throw new ApiError(400, "invalid_segment");
  const workspace = await workspaceFor(pool, user, "admin");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The same workspace lock as create, then the segment row, then the field (validateSegmentReferences).
    await lockWorkspaceForMember(client, workspace, user, "admin");
    const current = (
      await client.query(
        `SELECT ${SEGMENT_COLUMNS},archived FROM instagram_contact_segments WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [workspace, id],
      )
    ).rows[0];
    // An archived segment answers like a missing one, so its ID is not distinguishable.
    if (!current || current.archived) throw new ApiError(404, "segment_not_found");
    const { archived: _archived, ...stored } = current;
    if (stored.version !== expected) {
      await client.query("COMMIT");
      return { conflict: true, segment: segmentResult(stored) };
    }
    await validateSegmentReferences(client, workspace, definition);
    // IS DISTINCT FROM compares in SQL, so jsonb and timestamps need no conversion; an unchanged row updates nothing.
    const updated = (
      await client.query(
        `UPDATE instagram_contact_segments SET (${SEGMENT_DEFINITION_COLUMNS})=($3,$4,$5,$6,$7,$8::jsonb,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14::int),
   version=version+1
 WHERE workspace_id=$1 AND id=$2
   AND (${SEGMENT_DEFINITION_COLUMNS}) IS DISTINCT FROM ($3,$4::uuid,$5,$6::uuid,$7,$8::jsonb,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14::int)
 RETURNING ${SEGMENT_COLUMNS}`,
        [workspace, id, ...segmentDefinitionValues(definition)],
      )
    ).rows[0];
    await client.query("COMMIT");
    return { conflict: false, segment: segmentResult(updated ?? stored) };
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
  const workspace = await workspaceFor(pool, user, "admin");
  const result = await pool.query(
    "UPDATE instagram_contact_segments SET archived=true WHERE workspace_id=$1 AND id=$2 RETURNING id",
    [workspace, id],
  );
  if (!result.rows[0]) throw new ApiError(404, "segment_not_found");
  return { id: result.rows[0].id };
}

export async function saveContactAutomation(
  pool: Pool,
  user: User,
  connectionId: string,
  senderId: string,
  input: unknown,
) {
  if (
    !isUuid(connectionId) ||
    !senderIdentity(senderId) ||
    !isRecord(input) ||
    Object.keys(input).length !== 1 ||
    typeof input.paused !== "boolean"
  )
    throw new ApiError(400, "invalid_contact_automation");
  const workspace = await workspaceFor(pool, user, "agent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockContactConnection(client, workspace, connectionId);
    const result = await client.query(
      `INSERT INTO instagram_contact_automation(workspace_id,connection_id,sender_id,paused)
     SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3)
     ON CONFLICT(workspace_id,connection_id,sender_id) DO UPDATE SET paused=EXCLUDED.paused,updated_at=now()
       WHERE NOT instagram_contact_automation.handoff_paused OR EXCLUDED.paused
     RETURNING (paused OR handoff_paused) AS automation_paused`,
      [workspace, connectionId, senderId, input.paused],
    );
    if (!result.rows[0]) {
      const exists = await client.query(
        "SELECT 1 FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3 LIMIT 1",
        [workspace, connectionId, senderId],
      );
      if (exists.rowCount && !input.paused) throw new ApiError(409, "handoff_active");
      throw new ApiError(404, "contact_not_found");
    }
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
