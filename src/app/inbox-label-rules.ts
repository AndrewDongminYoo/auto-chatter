import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { lockWorkspaceForMember, workspaceFor } from "./settings.ts";
import { normalizeMatchText } from "../instagram/comment-rule.ts";

// Keyword auto-labeling rules for inbox conversations (#132). A rule belongs to the workspace, not to a connection,
// and adds one of the workspace's labels when a text DM stored after the rule exists matches it; ingestion applies
// the rules (applyLabelRules in src/instagram/inbox.ts). Rules are archived, never deleted, and only admins read or
// write them. A label archived after a rule was written only makes the rule skip; nothing here refuses to archive it.
export const ACTIVE_LABEL_RULE_LIMIT = 50;
// The keyword limits of comment rules (parseRule in settings.ts).
export const LABEL_RULE_KEYWORD_LIMIT = 20;
export const LABEL_RULE_KEYWORD_MAX = 100;

export type LabelRule = {
  id: string;
  label: { id: string; name: string; archived: boolean };
  match_mode: "contains" | "exact";
  keywords: string[];
  excluded_keywords: string[];
  archived: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
};

const RULE_SELECT = `SELECT r.id,jsonb_build_object('id',l.id,'name',l.name,'archived',l.archived) AS label,r.match_mode,
    r.keywords,r.excluded_keywords,r.archived,r.version,r.created_at,r.updated_at
  FROM instagram_inbox_label_rules r JOIN instagram_inbox_labels l ON l.id=r.label_id AND l.workspace_id=r.workspace_id`;

async function readRule(db: Pick<Pool, "query">, workspace: string, id: string): Promise<LabelRule | undefined> {
  return (await db.query<LabelRule>(`${RULE_SELECT} WHERE r.workspace_id=$1 AND r.id=$2`, [workspace, id])).rows[0];
}

// Keywords are stored normalized the way they are matched (NFC, trimmed, lower case), without repeats.
// The editor (public/app/inbox.js) joins keywords with ", " into an <input>, which strips CR and LF, and splits
// them again on commas, so a keyword with a comma or a line break would not survive an edit unchanged.
function keywordList(value: unknown, required: boolean): string[] {
  if (!Array.isArray(value) || value.length > LABEL_RULE_KEYWORD_LIMIT)
    throw new ApiError(400, "invalid_label_rule_keywords");
  const keywords = value.map((item) => {
    if (typeof item !== "string" || item.length > 300) throw new ApiError(400, "invalid_label_rule_keywords");
    const keyword = normalizeMatchText(item);
    if (!keyword || [...keyword].length > LABEL_RULE_KEYWORD_MAX || /[\u0000,\r\n]/.test(keyword))
      throw new ApiError(400, "invalid_label_rule_keywords");
    return keyword;
  });
  if (required && !keywords.length) throw new ApiError(400, "invalid_label_rule_keywords");
  return [...new Set(keywords)];
}

type RuleInput = {
  label_id: string;
  match_mode: "contains" | "exact";
  keywords: string[];
  excluded_keywords: string[];
};

function parseRule(input: unknown, extra: readonly string[] = []): RuleInput & Record<string, unknown> {
  const allowed = ["label_id", "match_mode", "keywords", "excluded_keywords", ...extra];
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    !isUuid(input.label_id) ||
    !["contains", "exact"].includes(String(input.match_mode))
  )
    throw new ApiError(400, "invalid_label_rule");
  return {
    ...input,
    label_id: input.label_id.toLowerCase(),
    match_mode: input.match_mode as RuleInput["match_mode"],
    keywords: keywordList(input.keywords, true),
    excluded_keywords: "excluded_keywords" in input ? keywordList(input.excluded_keywords, false) : [],
  };
}

// FOR SHARE holds the label until the rule write commits, so an archive cannot commit between this check and the
// write; the archive then waits for the rule and the rule only makes ingestion skip it.
async function lockActiveLabel(client: PoolClient, workspace: string, label: string): Promise<void> {
  const found = (
    await client.query<{ archived: boolean }>(
      "SELECT archived FROM instagram_inbox_labels WHERE workspace_id=$1 AND id=$2 FOR SHARE",
      [workspace, label],
    )
  ).rows[0];
  if (!found) throw new ApiError(404, "label_not_found");
  if (found.archived) throw new ApiError(409, "label_archived");
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

// Active rules first, each group in the order ingestion applies them.
export async function listLabelRules(pool: Pool, user: User): Promise<LabelRule[]> {
  const workspace = await workspaceFor(pool, user, "admin");
  return (
    await pool.query<LabelRule>(`${RULE_SELECT} WHERE r.workspace_id=$1 ORDER BY r.archived,r.created_at,r.id`, [
      workspace,
    ])
  ).rows;
}

export async function createLabelRule(pool: Pool, user: User, input: unknown): Promise<LabelRule> {
  const rule = parseRule(input);
  const workspace = await workspaceFor(pool, user, "admin");
  return transaction(pool, async (client) => {
    // The workspace row lock serializes creations, so concurrent requests cannot pass the active-rule limit, and it
    // rechecks the membership after an invite moved the caller out of this workspace.
    await lockWorkspaceForMember(client, workspace, user, "admin");
    await lockActiveLabel(client, workspace, rule.label_id);
    const created = await client.query<{ id: string }>(
      `INSERT INTO instagram_inbox_label_rules(workspace_id,label_id,match_mode,keywords,excluded_keywords,created_by,updated_by)
       SELECT $1,$2,$3,$4::text[],$5::text[],$6,$6
       WHERE (SELECT count(*) FROM instagram_inbox_label_rules WHERE workspace_id=$1 AND NOT archived)<$7
       RETURNING id`,
      [
        workspace,
        rule.label_id,
        rule.match_mode,
        rule.keywords,
        rule.excluded_keywords,
        user.id,
        ACTIVE_LABEL_RULE_LIMIT,
      ],
    );
    if (!created.rows[0]) throw new ApiError(409, "label_rule_limit_reached");
    return (await readRule(client, workspace, created.rows[0].id))!;
  });
}

export type SaveLabelRuleResult = { conflict: boolean; rule: LabelRule };

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

// Replaces the rule's label, mode and keywords at its expected version; a stale version answers with the current rule.
// The rule row is locked FOR NO KEY UPDATE, which never blocks the key-share lock that ingestion's audit row takes on
// it. An archived rule cannot be changed, and its label must still be active, as at creation.
export async function updateLabelRule(
  pool: Pool,
  user: User,
  id: string,
  input: unknown,
): Promise<SaveLabelRuleResult> {
  if (!isUuid(id)) throw new ApiError(400, "invalid_label_rule");
  const rule = parseRule(input, ["expected_version"]);
  const expected = rule.expected_version;
  if (!Number.isInteger(expected) || Number(expected) < 1 || Number(expected) >= 2147483647)
    throw new ApiError(400, "invalid_label_rule");
  const workspace = await workspaceFor(pool, user, "admin");
  return transaction(pool, async (client) => {
    const row = (
      await client.query<RuleInput & { archived: boolean; version: number }>(
        `SELECT label_id::text,match_mode,keywords,excluded_keywords,archived,version FROM instagram_inbox_label_rules
         WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE`,
        [workspace, id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "label_rule_not_found");
    if (row.version !== expected) return { conflict: true, rule: (await readRule(client, workspace, id))! };
    if (row.archived) throw new ApiError(409, "label_rule_archived");
    // An unchanged rule stores nothing and keeps its version.
    if (
      row.label_id === rule.label_id &&
      row.match_mode === rule.match_mode &&
      sameList(row.keywords, rule.keywords) &&
      sameList(row.excluded_keywords, rule.excluded_keywords)
    )
      return { conflict: false, rule: (await readRule(client, workspace, id))! };
    await lockActiveLabel(client, workspace, rule.label_id);
    await client.query(
      `UPDATE instagram_inbox_label_rules SET label_id=$3,match_mode=$4,keywords=$5::text[],excluded_keywords=$6::text[],
         version=version+1,updated_by=$7,updated_at=clock_timestamp()
       WHERE workspace_id=$1 AND id=$2`,
      [workspace, id, rule.label_id, rule.match_mode, rule.keywords, rule.excluded_keywords, user.id],
    );
    return { conflict: false, rule: (await readRule(client, workspace, id))! };
  });
}

// Archiving stops the rule for the next DM; labels it already added stay. Archiving again changes nothing.
export async function archiveLabelRule(pool: Pool, user: User, id: string): Promise<LabelRule> {
  if (!isUuid(id)) throw new ApiError(400, "invalid_label_rule");
  const workspace = await workspaceFor(pool, user, "admin");
  await pool.query(
    `UPDATE instagram_inbox_label_rules SET archived=true,version=version+1,updated_by=$3,updated_at=clock_timestamp()
     WHERE workspace_id=$1 AND id=$2 AND NOT archived`,
    [workspace, id, user.id],
  );
  const rule = await readRule(pool, workspace, id);
  if (!rule) throw new ApiError(404, "label_rule_not_found");
  return rule;
}
