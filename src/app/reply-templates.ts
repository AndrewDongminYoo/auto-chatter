import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { lockWorkspaceForMember, workspaceFor } from "./settings.ts";

const ACTIVE_LIMIT = 50;
const TEXT_LIMIT = 1000;
const VARIABLE = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;
type TemplateRow = {
  id: string;
  name: string;
  body: string;
  version: number;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
};
const COLUMNS = "id,name,body,version,archived,created_at,updated_at";

function validText(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= TEXT_LIMIT && !value.includes("\u0000")
  );
}

// The grammar is intentionally smaller than an expression language. Values are never parsed again.
export function templateVariables(body: unknown): string[] {
  if (!validText(body) || body.includes("{{{") || body.includes("}}}"))
    throw new ApiError(400, "invalid_template_body");
  const rest = body.replace(VARIABLE, "");
  if (rest.includes("{{") || rest.includes("}}")) throw new ApiError(400, "invalid_template_body");
  const variables = [...new Set([...body.matchAll(VARIABLE)].map((match) => match[1]!))];
  if (variables.length > 10) throw new ApiError(400, "invalid_template_body");
  return variables;
}

export function renderTemplate(body: string, values: unknown): string {
  const variables = templateVariables(body);
  if (
    !isRecord(values) ||
    Object.keys(values).some((key) => !variables.includes(key)) ||
    variables.some((key) => !Object.hasOwn(values, key) || !validText(values[key]))
  )
    throw new ApiError(400, "invalid_template_values");
  const text = body.replace(VARIABLE, (_match, key: string) => values[key] as string);
  if (!validText(text)) throw new ApiError(400, "template_text_too_long");
  return text;
}

function present(row: TemplateRow) {
  return { ...row, variables: templateVariables(row.body) };
}

function parse(input: unknown, editing = false) {
  const allowed = ["name", "body", ...(editing ? ["expected_version"] : [])];
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    typeof input.name !== "string" ||
    /[\u0000-\u001f\u007f]/.test(input.name)
  )
    throw new ApiError(400, "invalid_reply_template");
  const name = input.name.normalize("NFC").trim();
  if (!name || [...name].length > 60) throw new ApiError(400, "invalid_reply_template");
  templateVariables(input.body);
  if (editing) expectedVersion(input.expected_version);
  return { name, body: input.body as string, expected: input.expected_version };
}

function expectedVersion(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) >= 2147483647)
    throw new ApiError(400, "invalid_reply_template");
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
    if (isRecord(error) && error.code === "23505") throw new ApiError(409, "template_name_exists");
    throw error;
  } finally {
    client.release();
  }
}

export async function listReplyTemplates(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user, "agent");
  return (
    await pool.query<TemplateRow>(
      `SELECT ${COLUMNS} FROM workspace_reply_templates WHERE workspace_id=$1 AND NOT archived ORDER BY name,id LIMIT $2`,
      [workspace, ACTIVE_LIMIT],
    )
  ).rows.map(present);
}

export async function createReplyTemplate(pool: Pool, user: User, input: unknown) {
  const template = parse(input);
  const workspace = await workspaceFor(pool, user, "admin");
  return transaction(pool, async (client) => {
    await lockWorkspaceForMember(client, workspace, user, "admin");
    const row = (
      await client.query<TemplateRow>(
        `INSERT INTO workspace_reply_templates(workspace_id,name,body,created_by,updated_by)
       SELECT $1,$2,$3,$4,$4 WHERE (SELECT count(*) FROM workspace_reply_templates WHERE workspace_id=$1 AND NOT archived)<$5
       RETURNING ${COLUMNS}`,
        [workspace, template.name, template.body, user.id, ACTIVE_LIMIT],
      )
    ).rows[0];
    if (!row) throw new ApiError(409, "template_limit_reached");
    return present(row);
  });
}

export async function updateReplyTemplate(pool: Pool, user: User, id: string, input: unknown) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_reply_template");
  const template = parse(input, true);
  const workspace = await workspaceFor(pool, user, "admin");
  return transaction(pool, async (client) => {
    const row = (
      await client.query<TemplateRow>(
        `SELECT ${COLUMNS} FROM workspace_reply_templates WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE`,
        [workspace, id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, "template_not_found");
    if (row.archived) throw new ApiError(409, "template_archived");
    if (row.version !== template.expected) throw new ApiError(409, "template_conflict");
    if (row.name === template.name && row.body === template.body) return present(row);
    return present(
      (
        await client.query<TemplateRow>(
          `UPDATE workspace_reply_templates SET name=$3,body=$4,version=version+1,updated_by=$5,updated_at=clock_timestamp()
       WHERE workspace_id=$1 AND id=$2 RETURNING ${COLUMNS}`,
          [workspace, id, template.name, template.body, user.id],
        )
      ).rows[0]!,
    );
  });
}

export async function archiveReplyTemplate(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_reply_template");
  const workspace = await workspaceFor(pool, user, "admin");
  await pool.query(
    `UPDATE workspace_reply_templates SET archived=true,version=version+1,updated_by=$3,updated_at=clock_timestamp()
     WHERE workspace_id=$1 AND id=$2 AND NOT archived`,
    [workspace, id, user.id],
  );
  const row = (
    await pool.query<TemplateRow>(`SELECT ${COLUMNS} FROM workspace_reply_templates WHERE workspace_id=$1 AND id=$2`, [
      workspace,
      id,
    ])
  ).rows[0];
  if (!row) throw new ApiError(404, "template_not_found");
  return present(row);
}

export async function previewReplyTemplate(pool: Pool, user: User, id: string, input: unknown) {
  if (
    !isUuid(id) ||
    !isRecord(input) ||
    Object.keys(input).some((key) => !["expected_version", "values"].includes(key))
  )
    throw new ApiError(400, "invalid_reply_template");
  expectedVersion(input.expected_version);
  const workspace = await workspaceFor(pool, user, "agent");
  const row = (
    await pool.query<TemplateRow>(
      `SELECT ${COLUMNS} FROM workspace_reply_templates WHERE workspace_id=$1 AND id=$2 AND NOT archived`,
      [workspace, id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "template_not_found");
  if (row.version !== input.expected_version) throw new ApiError(409, "template_conflict");
  return { text: renderTemplate(row.body, input.values), version: row.version };
}
