import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { lockWorkspaceForMember, workspaceFor } from "./settings.ts";
import {
  type FieldCondition,
  fieldConditionNeedsValue,
  lockContact,
  parseFieldCondition,
  type SqlReader,
  validateFieldCondition,
} from "./contact-fields.ts";
import { verifiedDmRecipientsSql } from "./inbox-identity.ts";

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
// A tag condition names 1 to 5 tags: all of them must be present (all) or at least one (any).
// A set that collapses to one tag is the single-tag condition, whatever the mode.
export const SEGMENT_TAG_LIMIT = 5;
type TagCondition = { tags: string[]; mode: "all" | "any" };
function parseTagCondition(values: readonly unknown[], mode: unknown): TagCondition | null {
  if (!values.length) {
    if (mode != null) throw new ApiError(400, "invalid_contact_condition");
    return null;
  }
  if (values.length > SEGMENT_TAG_LIMIT || (mode != null && mode !== "all" && mode !== "any"))
    throw new ApiError(400, "invalid_contact_tags");
  const tags = [...new Set(values.map(tag))].sort();
  return { tags, mode: tags.length > 1 && mode === "any" ? "any" : "all" };
}
// A field condition set names 1 to 3 conditions on distinct fields: every one must hold (all) or at least one (any).
// The legacy keys carry one condition and field_conditions a set; a set of one is the legacy condition, whatever the mode.
export const SEGMENT_FIELD_CONDITION_LIMIT = 3;
type FieldConditionSet = { conditions: FieldCondition[]; mode: "all" | "any" };
const FIELD_CONDITION_KEYS = ["field_id", "field_operator", "field_value"];
function parseFieldConditionSet(
  legacy: Record<string, unknown>,
  list: unknown,
  mode: unknown,
): FieldConditionSet | null {
  const single = parseFieldCondition(legacy);
  // null means no set (absent in a segment body); listContacts passes undefined when the key is absent.
  if (list !== undefined && list !== null && single) throw new ApiError(400, "invalid_field_condition");
  let conditions: FieldCondition[] = single ? [single] : [];
  if (list !== undefined && list !== null) {
    if (!Array.isArray(list) || !list.length || list.length > SEGMENT_FIELD_CONDITION_LIMIT)
      throw new ApiError(400, "invalid_field_condition");
    conditions = list.map((item) => {
      // Each item is one complete condition; a missing field_id is an error here, not an absent condition.
      if (
        !isRecord(item) ||
        item.field_id == null ||
        Object.keys(item).some((key) => !FIELD_CONDITION_KEYS.includes(key))
      )
        throw new ApiError(400, "invalid_field_condition");
      return parseFieldCondition(item)!;
    });
  }
  // Lowercase IDs, so the stored jsonb compares as the uuid column does (the field_in_use containment check).
  conditions = conditions
    .map((condition) => ({ ...condition, field_id: condition.field_id.toLowerCase() }))
    .sort((left, right) => (left.field_id < right.field_id ? -1 : left.field_id > right.field_id ? 1 : 0));
  if (conditions.some((condition, index) => index > 0 && conditions[index - 1].field_id === condition.field_id))
    throw new ApiError(400, "invalid_field_condition");
  if (mode != null && mode !== "all" && mode !== "any") throw new ApiError(400, "invalid_field_condition");
  if (!conditions.length) {
    if (mode != null) throw new ApiError(400, "invalid_field_condition");
    return null;
  }
  return { conditions, mode: conditions.length > 1 && mode === "any" ? "any" : "all" };
}
// The decoded length bound of the field_conditions query value; the contact-segments spec (다중 필드 조건) derives it.
export const FIELD_CONDITIONS_QUERY_LENGTH = 8192;
// A condition tree is a root all/any over 1 to 5 groups, each an all/any over 1 to 5 leaves, at most 10 leaves in all.
// A leaf is a tag that is present, a tag that is absent (negate) or one field condition. Groups and leaves keep their
// order and may repeat a tag or a field, so order is part of the definition. The contact-segments spec (중첩 조건
// 그룹) owns the contract and the derivation of the query length bound.
export const CONDITION_TREE_GROUP_LIMIT = 5;
export const CONDITION_TREE_GROUP_LEAF_LIMIT = 5;
export const CONDITION_TREE_LEAF_LIMIT = 10;
export const CONDITION_TREE_QUERY_LENGTH = 16384;
// The body limit of segment create and edit. The parser's value, tag and name limits bound a definition, and
// JSON.stringify writes at most three UTF-8 bytes per UTF-16 unit of a valid value, so the largest definition is
// 31,681 bytes; the limit is about twice that (the spec section 중첩 조건 그룹 and api.test.ts measure it).
export const SEGMENT_REQUEST_BYTES = 65_536;
type ConditionTreeLeaf = { tag: string; negate?: true } | FieldCondition;
type ConditionTree = {
  mode: "all" | "any";
  groups: { mode: "all" | "any"; conditions: ConditionTreeLeaf[] }[];
};
function treeMode(value: unknown): "all" | "any" {
  if (value !== "all" && value !== "any") throw new ApiError(400, "invalid_contact_condition");
  return value;
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}
function parseConditionTreeLeaf(value: unknown): ConditionTreeLeaf {
  if (!isRecord(value)) throw new ApiError(400, "invalid_contact_condition");
  const isTag = Object.hasOwn(value, "tag"),
    isField = Object.hasOwn(value, "field_id");
  if (isTag === isField) throw new ApiError(400, "invalid_contact_condition");
  if (isTag) {
    if (!hasOnlyKeys(value, ["tag", "negate"])) throw new ApiError(400, "invalid_contact_condition");
    // A lone surrogate survives JSON.parse but not PostgreSQL's jsonb input, so it is refused here.
    if (typeof value.tag === "string" && /\p{Cs}/u.test(value.tag)) throw new ApiError(400, "invalid_contact_tags");
    const name = tag(value.tag);
    if (Object.hasOwn(value, "negate") && value.negate !== true && value.negate !== false)
      throw new ApiError(400, "invalid_contact_condition");
    return value.negate === true ? { tag: name, negate: true } : { tag: name };
  }
  // An unknown key is a tree shape error at every level. A field leaf is one complete condition; a null field_id is
  // a field condition error here, as in field_conditions.
  if (!hasOnlyKeys(value, FIELD_CONDITION_KEYS)) throw new ApiError(400, "invalid_contact_condition");
  if (value.field_id == null) throw new ApiError(400, "invalid_field_condition");
  const condition = parseFieldCondition(value)!;
  return { ...condition, field_id: condition.field_id.toLowerCase() };
}
// null and undefined mean no tree; any other value must be a complete tree.
function parseConditionTree(value: unknown): ConditionTree | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["mode", "groups"]) ||
    !Array.isArray(value.groups) ||
    !value.groups.length ||
    value.groups.length > CONDITION_TREE_GROUP_LIMIT
  )
    throw new ApiError(400, "invalid_contact_condition");
  const mode = treeMode(value.mode);
  let leaves = 0;
  const groups = value.groups.map((group: unknown) => {
    if (
      !isRecord(group) ||
      !hasOnlyKeys(group, ["mode", "conditions"]) ||
      !Array.isArray(group.conditions) ||
      !group.conditions.length ||
      group.conditions.length > CONDITION_TREE_GROUP_LEAF_LIMIT
    )
      throw new ApiError(400, "invalid_contact_condition");
    leaves += group.conditions.length;
    if (leaves > CONDITION_TREE_LEAF_LIMIT) throw new ApiError(400, "invalid_contact_condition");
    return { mode: treeMode(group.mode), conditions: group.conditions.map(parseConditionTreeLeaf) };
  });
  return { mode, groups };
}
function treeFieldConditions(tree: ConditionTree | null): FieldCondition[] {
  return (tree?.groups ?? []).flatMap((group) =>
    group.conditions.filter((leaf): leaf is FieldCondition => "field_id" in leaf),
  );
}
// Every field condition of a lookup, the field set's and then the tree's in leaf order; the list and the export
// validate each before they read.
export function contactConditionFields(conditions: {
  fieldCondition: FieldConditionSet | null;
  conditionTree: ConditionTree | null;
}): FieldCondition[] {
  return [...(conditions.fieldCondition?.conditions ?? []), ...treeFieldConditions(conditions.conditionTree)];
}
function parseConditionOperator(value: unknown, hasTag: boolean, hasField: boolean): "and" | "or" {
  if (value === undefined) return "and";
  if ((value !== "and" && value !== "or") || (value === "or" && (!hasTag || !hasField)))
    throw new ApiError(400, "invalid_contact_condition");
  return value;
}
// Calendar periods of the workspace time zone; listContacts computes their boundaries in its evaluation CTE.
const CALENDAR_PERIODS = ["today", "yesterday", "this_month", "last_month"];
function parseActivityWindow(input: {
  last_comment_from?: unknown;
  last_comment_before?: unknown;
  last_comment_days?: unknown;
  last_comment_period?: unknown;
}): {
  last_comment_from?: string;
  last_comment_before?: string;
  last_comment_days?: number;
  last_comment_period?: string;
} | null {
  const from = input.last_comment_from,
    before = input.last_comment_before;
  // Checked first, so a period never disappears behind another activity form: the three forms exclude each other.
  if (input.last_comment_period != null) {
    const period = input.last_comment_period;
    if (
      typeof period !== "string" ||
      !CALENDAR_PERIODS.includes(period) ||
      input.last_comment_days != null ||
      from != null ||
      before != null
    )
      throw new ApiError(400, "invalid_contact_activity");
    return { last_comment_period: period };
  }
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
// The same pair for the recorded state of the contact's verified DM conversations (verifiedDmRecipientsSql).
function parseDmConsentCondition(input: { dm_consent_purpose?: unknown; dm_consent_state?: unknown }) {
  const condition = parseConsentCondition({
    consent_purpose: input.dm_consent_purpose,
    consent_state: input.dm_consent_state,
  });
  return condition && { dm_consent_purpose: condition.consent_purpose, dm_consent_state: condition.consent_state };
}
// Recent received DMs of the contact's verified DM conversations: the integer days of last_comment_days, refused
// with the same code. It is independent of the comment activity forms, so it never refuses a combination with them.
function parseDmActivity(input: { last_dm_days?: unknown }) {
  const days = input.last_dm_days;
  if (days == null) return null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 366)
    throw new ApiError(400, "invalid_contact_activity");
  return { last_dm_days: days };
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
type ContactConditions = {
  connectionId: string | null;
  tagCondition: TagCondition | null;
  fieldCondition: FieldConditionSet | null;
  activity: ReturnType<typeof parseActivityWindow>;
  consent: ReturnType<typeof parseConsentCondition>;
  dmConsent: ReturnType<typeof parseDmConsentCondition>;
  dmActivity: ReturnType<typeof parseDmActivity>;
  operator: "and" | "or";
  conditionTree: ConditionTree | null;
};
// The conditions of an active saved segment of the workspace. The contact list reads it from the pool and the
// contact export from its snapshot transaction; both evaluate the result with segmentConditionSql.
export async function savedSegmentConditions(
  db: SqlReader,
  workspaceId: string,
  segmentId: string,
): Promise<ContactConditions> {
  const segment = await db.query<{
    connection_id: string | null;
    tag: string | null;
    tags: string[] | null;
    tag_mode: string | null;
    field_id: string | null;
    field_operator: string;
    field_value: unknown;
    field_conditions: unknown;
    field_mode: string | null;
    condition_operator: string;
    last_comment_from: Date | null;
    last_comment_before: Date | null;
    last_comment_days: number | null;
    last_comment_period: string | null;
    consent_purpose: string | null;
    consent_state: string | null;
    dm_consent_purpose: string | null;
    dm_consent_state: string | null;
    last_dm_days: number | null;
    condition_tree: unknown;
  }>(
    "SELECT connection_id,tag,tags,tag_mode,field_id,field_operator,field_value,field_conditions,field_mode,condition_operator,last_comment_from,last_comment_before,last_comment_days,last_comment_period,consent_purpose,consent_state,dm_consent_purpose,dm_consent_state,last_dm_days,condition_tree FROM instagram_contact_segments WHERE workspace_id=$1 AND id=$2 AND NOT archived",
    [workspaceId, segmentId],
  );
  if (!segment.rows[0]) throw new ApiError(404, "segment_not_found");
  const saved = segment.rows[0];
  const tagCondition = saved.tags
    ? parseTagCondition(saved.tags, saved.tag_mode)
    : parseTagCondition(saved.tag === null ? [] : [saved.tag], null);
  const consent = parseConsentCondition(saved);
  const dmConsent = parseDmConsentCondition(saved);
  const dmActivity = parseDmActivity(saved);
  const activity = parseActivityWindow({
    last_comment_from: saved.last_comment_from?.toISOString(),
    last_comment_before: saved.last_comment_before?.toISOString(),
    last_comment_days: saved.last_comment_days,
    last_comment_period: saved.last_comment_period,
  });
  const fieldCondition: FieldConditionSet | null = saved.field_conditions
    ? parseFieldConditionSet({}, saved.field_conditions, saved.field_mode)
    : saved.field_id
      ? {
          conditions: [
            {
              field_id: saved.field_id,
              field_operator: saved.field_operator,
              ...(fieldConditionNeedsValue(saved.field_operator) ? { field_value: saved.field_value } : {}),
            },
          ],
          mode: "all",
        }
      : null;
  const operator = parseConditionOperator(saved.condition_operator, Boolean(tagCondition), Boolean(fieldCondition));
  return {
    connectionId: saved.connection_id,
    tagCondition,
    fieldCondition,
    activity,
    consent,
    dmConsent,
    dmActivity,
    operator,
    conditionTree: parseConditionTree(saved.condition_tree),
  };
}
// The comparison of one field condition, read from the alias c (field_id uuid, field_operator text, field_value
// jsonb) for the contact row e. The field set and the condition tree share this text, so they cannot drift.
function fieldConditionMatchSql(c: string) {
  return `CASE WHEN ${c}.field_operator='is_unset' THEN NOT EXISTS(
   SELECT 1 FROM instagram_contact_field_values v WHERE v.workspace_id=e.workspace_id AND v.connection_id=e.connection_id AND v.sender_id=e.sender_id AND v.field_id=${c}.field_id AND v.value IS NOT NULL)
 ELSE EXISTS(SELECT 1 FROM instagram_contact_field_values v WHERE v.workspace_id=e.workspace_id AND v.connection_id=e.connection_id AND v.sender_id=e.sender_id AND v.field_id=${c}.field_id AND v.value IS NOT NULL
   AND (${c}.field_operator='is_set' OR (jsonb_typeof(v.value)=jsonb_typeof(${c}.field_value) AND CASE ${c}.field_operator
     WHEN 'eq' THEN v.value=${c}.field_value WHEN 'gt' THEN v.value>${c}.field_value WHEN 'gte' THEN v.value>=${c}.field_value
     WHEN 'lt' THEN v.value<${c}.field_value WHEN 'lte' THEN v.value<=${c}.field_value ELSE false END))) END`;
}
// The one contact predicate of the list, the preview, a saved segment and the segment export. Its fragments use
// fixed positions: $1 workspace, $2 connection, $3 tags, $4 and $5 the caller's page cursor, $6 to $8 the field
// set, $9 the operator, $10 and $11 the fixed window, $12 and $13 consent, $14 days, $15 the calendar period,
// $16 and $17 the DM consent, $18 the DM activity days and $19 the condition tree; values holds them in that order.
// clock is the SQL expression of the evaluation time (as_of).
// matches is a row condition over e and t after contactScope; activityMatches is aggregate and goes in HAVING.
export function segmentConditionSql(
  workspaceId: string,
  conditions: ContactConditions,
  clock: string,
  after: { connection_id: string; sender_id: string } | null,
) {
  const {
    connectionId,
    tagCondition,
    fieldCondition,
    activity,
    consent,
    dmConsent,
    dmActivity,
    operator,
    conditionTree,
  } = conditions;
  // One statement clock for the page and preview, using elapsed hours even across DST.
  // The calendar period reads the workspace time zone in the same statement. Its local boundaries are
  // converted back with AT TIME ZONE, so PostgreSQL resolves daylight-saving gaps and overlaps.
  // The fragment also defines dm_verified, the verified DM recipients of the selected accounts, read only with a
  // DM consent ($16) or DM activity ($18) condition, so every caller that puts evaluation in its WITH gets the DM
  // predicates.
  const evaluation = `evaluation AS MATERIALIZED (SELECT as_of,time_zone,
    local_from AT TIME ZONE time_zone AS period_from,local_before AT TIME ZONE time_zone AS period_before
    FROM (SELECT ${clock} AS as_of) clock
    CROSS JOIN LATERAL (SELECT (SELECT time_zone FROM workspaces WHERE id=$1) AS time_zone) zone
    CROSS JOIN LATERAL (SELECT date_trunc(CASE WHEN $15::text IN ('today','yesterday') THEN 'day' ELSE 'month' END,
      as_of AT TIME ZONE time_zone) AS local_start) local_clock
    CROSS JOIN LATERAL (SELECT CASE $15::text
      WHEN 'today' THEN local_start WHEN 'yesterday' THEN local_start - interval '1 day'
      WHEN 'this_month' THEN local_start WHEN 'last_month' THEN local_start - interval '1 month' END AS local_from,
      CASE $15::text
      WHEN 'today' THEN local_start + interval '1 day' WHEN 'yesterday' THEN local_start
      WHEN 'this_month' THEN local_start + interval '1 month' WHEN 'last_month' THEN local_start END AS local_before) local_period),
    dm_verified AS MATERIALIZED (SELECT connection_id,sender_id,recipient_id
      FROM (${verifiedDmRecipientsSql("workspace_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($16::text IS NOT NULL OR $18::int IS NOT NULL)")}) bridge)`;
  const utc = (value: string) => `to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const activityWindow = activity?.last_comment_period
    ? `(SELECT json_build_object('from',${utc("period_from")},'before',${utc("period_before")},'time_zone',time_zone) FROM evaluation)`
    : `(SELECT json_build_object('from',${utc("(as_of - $14::int * interval '24 hours')")},'before',${utc("as_of")}) FROM evaluation)`;
  // The bounds of the DM activity window only, never a recipient or a message time.
  const dmActivityWindow = `(SELECT json_build_object('from',${utc("(as_of - $18::int * interval '24 hours')")},'before',${utc("as_of")}) FROM evaluation)`;
  const activityMatches = `(CASE WHEN $15::text IS NOT NULL THEN
    max(e.created_at)>=(SELECT period_from FROM evaluation)
    AND max(e.created_at)<(SELECT period_before FROM evaluation)
    WHEN $14::int IS NOT NULL THEN
    max(e.created_at)>=(SELECT as_of - $14 * interval '24 hours' FROM evaluation)
    AND max(e.created_at)<(SELECT as_of FROM evaluation)
    ELSE ($10::timestamptz IS NULL OR (max(e.created_at)>=$10 AND max(e.created_at)<$11::timestamptz)) END)`;
  const consentScope = `FROM channel_consent_state state WHERE state.workspace_id=e.workspace_id
    AND state.connection_id=e.connection_id AND state.channel='instagram' AND state.identity_kind='comment_sender'
    AND state.identity_value=e.sender_id AND state.purpose=$12`;
  // Recorded state only; this is not the delivery guard and compares only the exact comment sender identity.
  const consentMatches = `($12::text IS NULL OR CASE WHEN $13::text='no_record' THEN NOT EXISTS(SELECT 1 ${consentScope})
    ELSE EXISTS(SELECT 1 ${consentScope} AND state.decision=CASE WHEN $13='granted' THEN 'grant' ELSE 'revoke' END) END)`;
  // The DM consent filter reads the advisory verified bridge of the contact detail (dm_verified, defined with
  // evaluation), in the contact's own connection. A contact without a verified DM recipient never matches; one
  // with several matches when any of them has the recorded state. It does not merge identities, write consent or
  // decide delivery eligibility. Both predicates are uncorrelated IN lists, so each is evaluated once per statement.
  const dmConsentScope = `FROM channel_consent_state state WHERE state.workspace_id=$1
    AND state.connection_id=dm.connection_id AND state.channel='instagram' AND state.identity_kind='dm_recipient'
    AND state.identity_value=dm.recipient_id AND state.purpose=$16`;
  const dmIdentityMatches = `(($16::text IS NULL AND $18::int IS NULL) OR (e.connection_id,e.sender_id) IN (SELECT connection_id,sender_id FROM dm_verified))`;
  const dmConsentMatches = `($16::text IS NULL OR (e.connection_id,e.sender_id) IN (SELECT dm.connection_id,dm.sender_id FROM dm_verified dm
    WHERE CASE WHEN $17::text='no_record' THEN NOT EXISTS(SELECT 1 ${dmConsentScope})
    ELSE EXISTS(SELECT 1 ${dmConsentScope} AND state.decision=CASE WHEN $17='granted' THEN 'grant' ELSE 'revoke' END) END))`;
  // DM activity: a verified recipient whose latest stored inbox message (text or postback) in its own connection
  // lies in [as_of - $18 days, as_of), as last_comment_days reads the latest comment. Like DM consent, any verified
  // recipient may match, not necessarily the one that matches DM consent. It reads stored messages only: it opens
  // no messaging window and decides no delivery eligibility. The latest message is one probe of
  // instagram_inbox_messages_latest_idx (migration 059), so a long history is not read in every export batch.
  const dmActivityMatches = `($18::int IS NULL OR (e.connection_id,e.sender_id) IN (SELECT dm.connection_id,dm.sender_id FROM dm_verified dm
    CROSS JOIN LATERAL (SELECT message.message_at AS last_message_at FROM instagram_inbox_messages message
      WHERE message.workspace_id=$1 AND message.connection_id=dm.connection_id AND message.recipient_id=dm.recipient_id
      ORDER BY message.message_at DESC LIMIT 1) latest
    WHERE latest.last_message_at>=(SELECT as_of - $18::int * interval '24 hours' FROM evaluation)
      AND latest.last_message_at<(SELECT as_of FROM evaluation)))`;
  // The one field predicate of the list, the preview and a saved segment: $6 holds the sorted field IDs (NULL
  // without a field condition), $7 the mode and $8 the normalized set, one row per condition. The legacy single
  // condition is a set of one. bool_and over the set is all, bool_or any; the comparisons are those of one condition.
  const fieldMatches = `($6::uuid[] IS NULL OR (SELECT CASE WHEN $7::text='any' THEN bool_or(condition_matches) ELSE bool_and(condition_matches) END
 FROM (SELECT ${fieldConditionMatchSql("c")} AS condition_matches
 FROM jsonb_to_recordset($8::jsonb) AS c(field_id uuid,field_operator text,field_value jsonb)) conditions))`;
  // The condition tree in $19 (NULL without one): bool_and or bool_or over the groups, chosen by the root mode, of
  // bool_and or bool_or over each group's leaves, chosen by the group mode. A tag leaf has the contact tag test of
  // tagMatches, inverted for negate; a field leaf has the field set's comparison. The modes are compared as text and
  // the leaves are read as records, so the SQL text never depends on the tree. The parser guarantees at least one
  // group and one leaf per group, so no aggregate runs over an empty set.
  const treeMatches = `($19::jsonb IS NULL OR (SELECT CASE WHEN $19::jsonb->>'mode'='any' THEN bool_or(group_matches) ELSE bool_and(group_matches) END
 FROM jsonb_array_elements($19::jsonb->'groups') AS tree_group(value)
 CROSS JOIN LATERAL (SELECT CASE WHEN tree_group.value->>'mode'='any' THEN bool_or(leaf_matches) ELSE bool_and(leaf_matches) END AS group_matches
   FROM (SELECT CASE WHEN c.tag IS NOT NULL THEN (coalesce(t.tags,'{}'::text[]) @> ARRAY[c.tag]) <> coalesce(c.negate,false)
     ELSE ${fieldConditionMatchSql("c")} END AS leaf_matches
     FROM jsonb_array_elements(tree_group.value->'conditions') AS tree_leaf(value)
     CROSS JOIN LATERAL jsonb_to_record(tree_leaf.value) AS c(tag text,negate boolean,field_id uuid,field_operator text,field_value jsonb)) leaves) tree_groups))`;
  // The one tag predicate of the list, the preview and a saved segment: $3 is the sorted tag set or NULL.
  // A contact without a tag row has no tags. The operator is chosen from the validated mode, never from input text.
  const tagMatches = `($3::text[] IS NULL OR coalesce(t.tags,'{}'::text[]) ${tagCondition?.mode === "any" ? "&&" : "@>"} $3::text[])`;
  const contactScope = `FROM instagram_comment_events e JOIN instagram_connections c ON c.id=e.connection_id AND c.workspace_id=e.workspace_id
 LEFT JOIN instagram_contact_automation automation ON automation.workspace_id=e.workspace_id AND automation.connection_id=e.connection_id AND automation.sender_id=e.sender_id
 LEFT JOIN instagram_contact_tags t ON t.workspace_id=e.workspace_id AND t.connection_id=e.connection_id AND t.sender_id=e.sender_id
 WHERE e.workspace_id=$1 AND ($2::uuid IS NULL OR e.connection_id=$2)`;
  // AND needs both the tag and the field predicate, OR either one; the consent filters always apply. A tree is the
  // third form: with one, the tag and field parameters are NULL and their predicates are true.
  const matches = `($9::text='or' OR ${tagMatches})
 AND (($9::text='or' AND ${tagMatches}) OR ${fieldMatches})
 AND ${treeMatches}
 AND ${consentMatches}
 AND ${dmConsentMatches}
 AND ${dmActivityMatches}`;
  return {
    evaluation,
    activityWindow,
    dmActivityWindow,
    activityMatches,
    consentMatches,
    dmIdentityMatches,
    dmConsentMatches,
    dmActivityMatches,
    fieldMatches,
    tagMatches,
    treeMatches,
    contactScope,
    matches,
    values: [
      workspaceId,
      connectionId,
      tagCondition?.tags ?? null,
      after?.connection_id ?? null,
      after?.sender_id ?? null,
      fieldCondition?.conditions.map((condition) => condition.field_id) ?? null,
      fieldCondition?.mode ?? null,
      fieldCondition ? JSON.stringify(fieldCondition.conditions) : null,
      operator,
      activity?.last_comment_from ?? null,
      activity?.last_comment_before ?? null,
      consent?.consent_purpose ?? null,
      consent?.consent_state ?? null,
      activity?.last_comment_days ?? null,
      activity?.last_comment_period ?? null,
      dmConsent?.dm_consent_purpose ?? null,
      dmConsent?.dm_consent_state ?? null,
      dmActivity?.last_dm_days ?? null,
      conditionTree ? JSON.stringify(conditionTree) : null,
    ],
  };
}
// The preview's CTEs after evaluation: contact_filters, outcomes and summary, which counts every evaluated contact
// once by its predicate outcomes. listContacts and the segment snapshot share this text, so their counts cannot fork.
// Aggregate independently of matching samples so even zero matches retain their exclusion summary.
// Materialize only identities and predicate outcomes, not every contact's displayed field JSON.
export function segmentPreviewSql(sql: ReturnType<typeof segmentConditionSql>): string {
  const {
    activityMatches,
    consentMatches,
    dmIdentityMatches,
    dmConsentMatches,
    dmActivityMatches,
    fieldMatches,
    tagMatches,
    treeMatches,
    contactScope,
  } = sql;
  return `contact_filters AS MATERIALIZED (
 SELECT e.connection_id,e.sender_id,${tagMatches} AS tag_matches,
 ${fieldMatches} AS field_matches,${treeMatches} AS tree_matches,${activityMatches} AS activity_matches,${consentMatches} AS consent_matches,
 ${dmIdentityMatches} AS dm_identity_matches,${dmConsentMatches} AS dm_consent_matches,
 ${dmActivityMatches} AS dm_activity_matches
 ${contactScope}
 GROUP BY e.workspace_id,e.connection_id,e.sender_id,t.tags
), outcomes AS (
 SELECT *,activity_matches AND consent_matches AND dm_identity_matches AND dm_consent_matches AND dm_activity_matches
   AND CASE WHEN $9::text='or' THEN tag_matches OR field_matches ELSE tag_matches AND field_matches END
   AND tree_matches AS matched,
 activity_matches AND consent_matches AND dm_identity_matches AND dm_consent_matches AND dm_activity_matches AS limits_match
 FROM contact_filters
), summary AS (
 SELECT count(*)::text AS preview_evaluated,
 (count(*) FILTER (WHERE matched))::text AS preview_total,
 (count(*) FILTER (WHERE NOT activity_matches))::text AS preview_excluded_activity,
 (count(*) FILTER (WHERE activity_matches AND NOT consent_matches))::text AS preview_excluded_consent,
 (count(*) FILTER (WHERE activity_matches AND consent_matches AND NOT dm_identity_matches))::text AS preview_excluded_dm_identity,
 (count(*) FILTER (WHERE activity_matches AND consent_matches AND dm_identity_matches AND NOT dm_consent_matches))::text AS preview_excluded_dm_consent,
 (count(*) FILTER (WHERE activity_matches AND consent_matches AND dm_identity_matches AND dm_consent_matches AND NOT dm_activity_matches))::text AS preview_excluded_dm_activity,
 (count(*) FILTER (WHERE limits_match AND NOT matched AND NOT tag_matches AND field_matches))::text AS preview_excluded_tag,
 (count(*) FILTER (WHERE limits_match AND NOT matched AND tag_matches AND NOT field_matches))::text AS preview_excluded_field,
 (count(*) FILTER (WHERE limits_match AND NOT matched AND NOT tag_matches AND NOT field_matches))::text AS preview_excluded_both,
 (count(*) FILTER (WHERE limits_match AND NOT tree_matches))::text AS preview_excluded_conditions
 FROM outcomes
)`;
}
export type SegmentPreviewSummary = {
  preview_total?: string;
  preview_evaluated?: string;
  preview_excluded_tag?: string;
  preview_excluded_field?: string;
  preview_excluded_both?: string;
  preview_excluded_conditions?: string;
  preview_excluded_activity?: string;
  preview_excluded_consent?: string;
  preview_excluded_dm_identity?: string;
  preview_excluded_dm_consent?: string;
  preview_excluded_dm_activity?: string;
};
// The preview's total, evaluated and excluded decimal strings from a summary row; the excluded keys present depend on
// which conditions the lookup has. listContacts and the segment snapshot share it.
export function segmentPreviewCounts(
  summary: SegmentPreviewSummary | undefined,
  conditions: Pick<ContactConditions, "activity" | "consent" | "dmConsent" | "dmActivity" | "conditionTree">,
) {
  const { activity, consent, dmConsent, dmActivity, conditionTree } = conditions;
  return {
    total: summary?.preview_total ?? "0",
    evaluated: summary?.preview_evaluated ?? "0",
    excluded: {
      ...(activity ? { activity: summary?.preview_excluded_activity ?? "0" } : {}),
      ...(consent ? { consent: summary?.preview_excluded_consent ?? "0" } : {}),
      ...(dmConsent || dmActivity ? { dm_identity: summary?.preview_excluded_dm_identity ?? "0" } : {}),
      ...(dmConsent ? { dm_consent: summary?.preview_excluded_dm_consent ?? "0" } : {}),
      ...(dmActivity ? { dm_activity: summary?.preview_excluded_dm_activity ?? "0" } : {}),
      // A tree has one reason after the limits; the tag/field split describes only the other two forms.
      ...(conditionTree
        ? { conditions: summary?.preview_excluded_conditions ?? "0" }
        : {
            tag: summary?.preview_excluded_tag ?? "0",
            field: summary?.preview_excluded_field ?? "0",
            both: summary?.preview_excluded_both ?? "0",
          }),
    },
  };
}
export async function listContacts(pool: Pool, user: User, options: URLSearchParams = new URLSearchParams()) {
  for (const key of options.keys())
    if (
      ![
        "connection_id",
        "tag",
        "tag_mode",
        "after",
        "segment_id",
        "field_id",
        "field_operator",
        "field_value",
        "field_conditions",
        "field_mode",
        "condition_operator",
        "last_comment_from",
        "last_comment_before",
        "last_comment_days",
        "last_comment_period",
        "consent_purpose",
        "consent_state",
        "dm_consent_purpose",
        "dm_consent_state",
        "last_dm_days",
        "condition_tree",
        "preview",
      ].includes(key) ||
      // Only tag may repeat; parseTagCondition refuses more than five values.
      (key !== "tag" && options.getAll(key).length !== 1)
    )
      throw new ApiError(400, "invalid_contact_request");
  const preview = options.has("preview");
  if (preview && (options.get("preview") !== "true" || options.has("after")))
    throw new ApiError(400, "invalid_contact_request");
  let connectionId = options.get("connection_id");
  if (connectionId !== null && !isUuid(connectionId)) throw new ApiError(400, "invalid_contact_request");
  // Tag values are validated before the segment_id mixing check, as the single tag was; the count and mode after it.
  const tagValues = options.getAll("tag").map(tag);
  const segmentId = options.get("segment_id");
  if (
    segmentId !== null &&
    (!isUuid(segmentId) ||
      [
        "connection_id",
        "tag",
        "tag_mode",
        "field_id",
        "field_operator",
        "field_value",
        "field_conditions",
        "field_mode",
        "condition_operator",
        "last_comment_from",
        "last_comment_before",
        "last_comment_days",
        "last_comment_period",
        "consent_purpose",
        "consent_state",
        "dm_consent_purpose",
        "dm_consent_state",
        "last_dm_days",
        "condition_tree",
      ].some((key) => options.has(key)))
  )
    throw new ApiError(400, "invalid_contact_request");
  // condition_tree is one JSON object and the third condition form, so no tag, field or operator key may join it.
  const treeText = options.get("condition_tree");
  let conditionTree: ConditionTree | null = null;
  if (treeText !== null) {
    if (
      treeText.length > CONDITION_TREE_QUERY_LENGTH ||
      ["tag", "tag_mode", ...FIELD_CONDITION_KEYS, "field_conditions", "field_mode", "condition_operator"].some((key) =>
        options.has(key),
      )
    )
      throw new ApiError(400, "invalid_contact_condition");
    let tree: unknown;
    try {
      tree = JSON.parse(treeText);
    } catch {
      throw new ApiError(400, "invalid_contact_condition");
    }
    // A present key must hold a tree, so a JSON null is refused here.
    if (!isRecord(tree)) throw new ApiError(400, "invalid_contact_condition");
    conditionTree = parseConditionTree(tree);
  }
  let tagCondition = parseTagCondition(tagValues, options.get("tag_mode"));
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
  // field_conditions is one JSON array; a present key must hold one, so a JSON null is refused here.
  const fieldList = options.get("field_conditions");
  let fieldConditions: unknown;
  if (fieldList !== null) {
    if (fieldList.length > FIELD_CONDITIONS_QUERY_LENGTH) throw new ApiError(400, "invalid_field_condition");
    try {
      fieldConditions = JSON.parse(fieldList);
    } catch {
      throw new ApiError(400, "invalid_field_condition");
    }
    if (!Array.isArray(fieldConditions)) throw new ApiError(400, "invalid_field_condition");
  }
  let fieldCondition = parseFieldConditionSet(fieldInput, fieldConditions, options.get("field_mode"));
  const days = options.get("last_comment_days");
  if (days !== null && !/^[1-9][0-9]{0,2}$/.test(days)) throw new ApiError(400, "invalid_contact_activity");
  let activity = parseActivityWindow({
    last_comment_from: options.get("last_comment_from"),
    last_comment_before: options.get("last_comment_before"),
    last_comment_days: days === null ? null : Number(days),
    // An empty query value means no calendar period.
    last_comment_period: options.get("last_comment_period") || null,
  });
  let consent = parseConsentCondition({
    consent_purpose: options.get("consent_purpose"),
    consent_state: options.get("consent_state"),
  });
  let dmConsent = parseDmConsentCondition({
    dm_consent_purpose: options.get("dm_consent_purpose"),
    dm_consent_state: options.get("dm_consent_state"),
  });
  const dmDays = options.get("last_dm_days");
  if (dmDays !== null && !/^[1-9][0-9]{0,2}$/.test(dmDays)) throw new ApiError(400, "invalid_contact_activity");
  let dmActivity = parseDmActivity({ last_dm_days: dmDays === null ? null : Number(dmDays) });
  let operator = parseConditionOperator(
    options.get("condition_operator") ?? undefined,
    Boolean(tagCondition),
    Boolean(fieldCondition),
  );
  const after = cursor(options.get("after"));
  const workspaceId = await workspaceFor(pool, user, "agent");
  if (segmentId !== null)
    ({ connectionId, tagCondition, fieldCondition, activity, consent, dmConsent, dmActivity, operator, conditionTree } =
      await savedSegmentConditions(pool, workspaceId, segmentId));
  for (const condition of contactConditionFields({ fieldCondition, conditionTree }))
    await validateFieldCondition(pool, workspaceId, condition);
  const conditionSql = segmentConditionSql(
    workspaceId,
    { connectionId, tagCondition, fieldCondition, activity, consent, dmConsent, dmActivity, operator, conditionTree },
    "statement_timestamp()",
    after,
  );
  const { evaluation, activityWindow, dmActivityWindow, activityMatches, contactScope, matches, values } = conditionSql;
  const contactQuery = `SELECT e.connection_id,e.sender_id,c.username,min(e.created_at) AS first_comment_at,
 max(e.created_at) AS last_comment_at,count(*)::text AS comment_count,coalesce((automation.paused OR automation.handoff_paused),false) AS automation_paused,coalesce(t.tags,'{}'::text[]) AS tags,
 coalesce((SELECT jsonb_object_agg(v.field_id::text,v.value) FROM instagram_contact_field_values v
 JOIN instagram_contact_fields f ON f.id=v.field_id AND f.workspace_id=v.workspace_id AND NOT f.archived
 WHERE v.workspace_id=e.workspace_id AND v.connection_id=e.connection_id AND v.sender_id=e.sender_id AND v.value IS NOT NULL),'{}'::jsonb) AS fields
 ${contactScope}
 AND ($4::uuid IS NULL OR (e.connection_id,e.sender_id)>($4::uuid,$5::text))
 AND ${matches}
 GROUP BY e.workspace_id,e.connection_id,e.sender_id,c.username,t.tags,(automation.paused OR automation.handoff_paused)
 HAVING ${activityMatches} ORDER BY e.connection_id,e.sender_id LIMIT 51`;
  const query = preview
    ? `WITH ${evaluation}, ${segmentPreviewSql(conditionSql)}
 SELECT page.*,summary.*,${activityWindow} AS activity_window,${dmActivityWindow} AS dm_activity_window
 FROM summary LEFT JOIN LATERAL (${contactQuery}) page ON true
 ORDER BY page.connection_id,page.sender_id`
    : activity?.last_comment_days || activity?.last_comment_period || dmActivity
      ? `WITH ${evaluation} SELECT page.*,${activityWindow} AS activity_window,${dmActivityWindow} AS dm_activity_window
         FROM evaluation LEFT JOIN LATERAL (${contactQuery}) page ON true ORDER BY page.connection_id,page.sender_id`
      : `WITH ${evaluation} ${contactQuery}`;
  const result = await pool.query<
    (Contact | { [Key in keyof Contact]: null }) &
      SegmentPreviewSummary & {
        activity_window?: { from: string; before: string; time_zone?: string };
        dm_activity_window?: { from: string; before: string };
      }
  >(query, values);
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
        preview_excluded_conditions,
        preview_excluded_activity,
        preview_excluded_consent,
        preview_excluded_dm_identity,
        preview_excluded_dm_consent,
        preview_excluded_dm_activity,
        activity_window,
        dm_activity_window,
        ...contact
      }) => (contact.connection_id === null ? [] : [contact]),
    );
  const last = contacts.at(-1);
  return {
    contacts,
    ...(activity?.last_comment_days || activity?.last_comment_period
      ? { activity_window: summary?.activity_window }
      : {}),
    ...(dmActivity ? { dm_activity_window: summary?.dm_activity_window } : {}),
    ...(preview ? segmentPreviewCounts(summary, { activity, consent, dmConsent, dmActivity, conditionTree }) : {}),
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
  "id,name,connection_id,tag,tags,tag_mode,field_id,field_operator,field_value,field_conditions,field_mode,condition_operator,last_comment_from,last_comment_before,last_comment_days,last_comment_period,consent_purpose,consent_state,dm_consent_purpose,dm_consent_state,last_dm_days,condition_tree,version";

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
  tags?: string[] | null;
  tag_mode?: string | null;
  version: number;
  field_id?: string | null;
  field_operator?: string | null;
  field_value?: unknown;
  field_conditions?: unknown;
  field_mode?: string | null;
  condition_operator?: string;
  last_comment_from?: Date | null;
  last_comment_before?: Date | null;
  last_comment_days?: number | null;
  last_comment_period?: string | null;
  consent_purpose?: string | null;
  consent_state?: string | null;
  dm_consent_purpose?: string | null;
  dm_consent_state?: string | null;
  last_dm_days?: number | null;
  condition_tree?: unknown;
}) {
  const {
    condition_tree,
    field_id,
    field_operator,
    field_value,
    field_conditions,
    field_mode,
    condition_operator,
    last_comment_from,
    last_comment_before,
    last_comment_days,
    last_comment_period,
    consent_purpose,
    consent_state,
    dm_consent_purpose,
    dm_consent_state,
    last_dm_days,
    tag,
    tags,
    tag_mode,
    ...base
  } = row;
  // A multi-field segment returns its set and mode and no legacy field keys; a one-condition segment keeps them.
  const fieldKeys: {
    field_conditions?: unknown;
    field_mode?: string | null;
    field_id?: string;
    field_operator?: string | null;
    field_value?: unknown;
  } = field_conditions
    ? { field_conditions, field_mode }
    : field_id
      ? { field_id, field_operator, ...(fieldConditionNeedsValue(field_operator ?? "") ? { field_value } : {}) }
      : {};
  return {
    ...base,
    // A tree segment returns its tree and no tag key; a multi-tag segment its set and mode and no tag key; a
    // one-tag or legacy segment keeps tag. A tree segment has no field keys either, as its field columns are NULL.
    ...(condition_tree ? { condition_tree } : tags ? { tags, tag_mode } : { tag }),
    ...(last_comment_days ? { last_comment_days } : {}),
    ...(last_comment_period ? { last_comment_period } : {}),
    ...(consent_purpose && consent_state ? { consent_purpose, consent_state } : {}),
    ...(dm_consent_purpose && dm_consent_state ? { dm_consent_purpose, dm_consent_state } : {}),
    ...(last_dm_days ? { last_dm_days } : {}),
    ...(last_comment_from && last_comment_before
      ? { last_comment_from: last_comment_from.toISOString(), last_comment_before: last_comment_before.toISOString() }
      : {}),
    ...(condition_operator === "or" ? { condition_operator } : {}),
    ...fieldKeys,
  };
}

// The active segment as the segment API returns it, held FOR SHARE until commit, so an edit or an archive of it waits
// for the caller. An archived, missing or foreign segment answers segment_not_found.
export async function lockActiveSegment(client: PoolClient, workspaceId: string, segmentId: string) {
  const row = (
    await client.query(
      `SELECT ${SEGMENT_COLUMNS} FROM instagram_contact_segments WHERE workspace_id=$1 AND id=$2 AND NOT archived FOR SHARE`,
      [workspaceId, segmentId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "segment_not_found");
  return segmentResult(row);
}

const SEGMENT_DEFINITION_KEYS = [
  "name",
  "connection_id",
  "tag",
  "tags",
  "tag_mode",
  "field_id",
  "field_operator",
  "field_value",
  "field_conditions",
  "field_mode",
  "condition_operator",
  "last_comment_from",
  "last_comment_before",
  "last_comment_days",
  "last_comment_period",
  "consent_purpose",
  "consent_state",
  "dm_consent_purpose",
  "dm_consent_state",
  "last_dm_days",
  "condition_tree",
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
  // The legacy tag (a string) or tags (an array); an absent, null or empty tag counts as no tag.
  const legacyTag = input.tag === undefined || input.tag === null || input.tag === "" ? null : input.tag;
  // The tree is the third condition form: a body with one names no tag or field key and no condition_operator, not
  // even "and". An absent, null or empty tag and a null key count as absent, as for the other forms. This is checked
  // before the other forms are parsed, so every mixture answers with one code.
  const conditionTree = parseConditionTree(input.condition_tree);
  if (
    conditionTree &&
    (legacyTag !== null ||
      ["tags", "tag_mode", "field_id", "field_operator", "field_conditions", "field_mode"].some(
        (key) => input[key] != null,
      ) ||
      Object.hasOwn(input, "field_value") ||
      input.condition_operator !== undefined)
  )
    throw new ApiError(400, "invalid_contact_condition");
  if (input.tags != null && legacyTag !== null) throw new ApiError(400, "invalid_segment");
  if (input.tags != null && (!Array.isArray(input.tags) || !input.tags.length))
    throw new ApiError(400, "invalid_contact_tags");
  const tagCondition = parseTagCondition(
    Array.isArray(input.tags) ? input.tags : legacyTag === null ? [] : [legacyTag],
    input.tag_mode,
  );
  // The legacy field keys or field_conditions (an array); a null field_conditions counts as no set.
  const fieldCondition = parseFieldConditionSet(input, input.field_conditions, input.field_mode);
  const activity = parseActivityWindow(input);
  const consent = parseConsentCondition(input);
  const dmConsent = parseDmConsentCondition(input);
  const dmActivity = parseDmActivity(input);
  const operator = parseConditionOperator(input.condition_operator, Boolean(tagCondition), Boolean(fieldCondition));
  return {
    input,
    name,
    connectionId,
    tagCondition,
    fieldCondition,
    activity,
    consent,
    dmConsent,
    dmActivity,
    operator,
    conditionTree,
  };
}
type SegmentDefinition = ReturnType<typeof parseSegmentDefinition>;

// The stored columns of a definition, in the order of segmentDefinitionValues.
const SEGMENT_DEFINITION_COLUMNS =
  "name,connection_id,tag,field_id,field_operator,field_value,condition_operator,last_comment_from,last_comment_before,consent_purpose,consent_state,last_comment_days,last_comment_period,tags,tag_mode,field_conditions,field_mode,dm_consent_purpose,dm_consent_state,last_dm_days,condition_tree";
function segmentDefinitionValues(definition: SegmentDefinition) {
  const {
    name,
    connectionId,
    tagCondition,
    fieldCondition,
    activity,
    consent,
    dmConsent,
    dmActivity,
    operator,
    conditionTree,
  } = definition;
  // One tag is stored in the legacy tag column; two or more in tags with their mode.
  const single = tagCondition?.tags.length === 1;
  // One field condition is stored in the legacy field columns; two or three in field_conditions with their mode.
  const multiField = fieldCondition && fieldCondition.conditions.length > 1 ? fieldCondition : null;
  const condition = multiField ? null : (fieldCondition?.conditions[0] ?? null);
  return [
    name,
    connectionId,
    single ? tagCondition.tags[0] : null,
    condition?.field_id ?? null,
    condition?.field_operator ?? null,
    condition && fieldConditionNeedsValue(condition.field_operator) ? JSON.stringify(condition.field_value) : null,
    operator,
    activity?.last_comment_from ?? null,
    activity?.last_comment_before ?? null,
    consent?.consent_purpose ?? null,
    consent?.consent_state ?? null,
    activity?.last_comment_days ?? null,
    activity?.last_comment_period ?? null,
    tagCondition && !single ? tagCondition.tags : null,
    tagCondition && !single ? tagCondition.mode : null,
    multiField ? JSON.stringify(multiField.conditions) : null,
    multiField?.mode ?? null,
    dmConsent?.dm_consent_purpose ?? null,
    dmConsent?.dm_consent_state ?? null,
    dmActivity?.last_dm_days ?? null,
    conditionTree ? JSON.stringify(conditionTree) : null,
  ];
}

// Every referenced field is held FOR SHARE until commit, in field_id order, so archiveContactField (field FOR UPDATE,
// then the active-segment check) either waits and sees this segment, or commits first and this refuses the field.
// A tree may name one field in several leaves with different operators: each distinct field is locked once, with its
// first leaf, and its other leaves are validated against the row this transaction already holds, without a lock.
async function validateSegmentReferences(client: PoolClient, workspace: string, definition: SegmentDefinition) {
  const conditions = contactConditionFields(definition).sort((left, right) =>
    left.field_id < right.field_id ? -1 : left.field_id > right.field_id ? 1 : 0,
  );
  for (const [index, condition] of conditions.entries())
    await validateFieldCondition(
      client,
      workspace,
      condition,
      !index || conditions[index - 1].field_id !== condition.field_id,
    );
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
 SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16,$17::jsonb,$18,$19,$20,$21::int,$22::jsonb WHERE (SELECT count(*) FROM instagram_contact_segments WHERE workspace_id=$1 AND NOT archived)<50
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
        `UPDATE instagram_contact_segments SET (${SEGMENT_DEFINITION_COLUMNS})=($3,$4,$5,$6,$7,$8::jsonb,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14::int,$15::text,$16::text[],$17::text,$18::jsonb,$19::text,$20::text,$21::text,$22::int,$23::jsonb),
   version=version+1
 WHERE workspace_id=$1 AND id=$2
   AND (${SEGMENT_DEFINITION_COLUMNS}) IS DISTINCT FROM ($3,$4::uuid,$5,$6::uuid,$7,$8::jsonb,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14::int,$15::text,$16::text[],$17::text,$18::jsonb,$19::text,$20::text,$21::text,$22::int,$23::jsonb)
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
