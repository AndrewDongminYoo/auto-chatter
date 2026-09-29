import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";

export type FieldCondition = { field_id: string; field_operator: string; field_value?: unknown };

export function parseFieldCondition(input: Record<string, unknown>): FieldCondition | null {
  if (input.field_id === undefined || input.field_id === null) {
    if (input.field_operator != null || Object.hasOwn(input, "field_value"))
      throw new ApiError(400, "invalid_field_condition");
    return null;
  }
  if (
    !isUuid(input.field_id) ||
    typeof input.field_operator !== "string" ||
    !["eq", "is_set", "is_unset"].includes(input.field_operator)
  )
    throw new ApiError(400, "invalid_field_condition");
  if (
    input.field_operator === "eq"
      ? !Object.hasOwn(input, "field_value") || input.field_value === null
      : Object.hasOwn(input, "field_value")
  )
    throw new ApiError(400, "invalid_field_condition");
  return {
    field_id: input.field_id,
    field_operator: input.field_operator,
    ...(input.field_operator === "eq" ? { field_value: input.field_value } : {}),
  };
}

export function isValidFieldValue(type: string, value: unknown): boolean {
  return type === "text"
    ? typeof value === "string" && value.length <= 1000 && !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\r\t]/g, ""))
    : type === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : type === "boolean"
        ? typeof value === "boolean"
        : type === "date" &&
          typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value;
}

function validateValue(type: string, value: unknown) {
  if (!isValidFieldValue(type, value)) throw new ApiError(400, "invalid_field_value");
}

export async function validateFieldCondition(
  db: Pool | PoolClient,
  workspace: string,
  condition: FieldCondition | null,
  lock = false,
) {
  if (!condition) return;
  const field = (
    await db.query<{ type: string }>(
      `SELECT type FROM instagram_contact_fields WHERE workspace_id=$1 AND id=$2 AND NOT archived${lock ? " FOR SHARE" : ""}`,
      [workspace, condition.field_id],
    )
  ).rows[0];
  if (!field) throw new ApiError(404, "field_not_found");
  if (condition.field_operator === "eq") validateValue(field.type, condition.field_value);
}

export async function listContactFields(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user);
  return (
    await pool.query(
      "SELECT id,name,type FROM instagram_contact_fields WHERE workspace_id=$1 AND NOT archived ORDER BY name,id",
      [workspace],
    )
  ).rows;
}

export async function createContactField(pool: Pool, user: User, input: unknown) {
  if (
    !isRecord(input) ||
    Object.keys(input).some((key) => !["name", "type"].includes(key)) ||
    typeof input.name !== "string" ||
    input.name.length > 300 ||
    typeof input.type !== "string" ||
    !["text", "number", "boolean", "date"].includes(input.type)
  )
    throw new ApiError(400, "invalid_contact_field");
  const name = input.name.trim().normalize("NFC");
  if (!name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new ApiError(400, "invalid_contact_field");
  const workspace = await workspaceFor(pool, user);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [workspace]);
    const result = await client.query(
      `INSERT INTO instagram_contact_fields(workspace_id,name,type)
      SELECT $1,$2,$3 WHERE (SELECT count(*) FROM instagram_contact_fields WHERE workspace_id=$1 AND NOT archived)<50 RETURNING id,name,type`,
      [workspace, name, input.type],
    );
    if (!result.rows[0]) throw new ApiError(409, "field_limit_reached");
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    if (isRecord(error) && error.code === "23505") throw new ApiError(409, "field_name_exists");
    throw error;
  } finally {
    client.release();
  }
}

export async function archiveContactField(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_contact_field");
  const workspace = await workspaceFor(pool, user);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (
      !(
        await client.query("SELECT id FROM instagram_contact_fields WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [
          workspace,
          id,
        ])
      ).rows[0]
    )
      throw new ApiError(404, "field_not_found");
    if (
      (
        await client.query(
          "SELECT id FROM instagram_contact_segments WHERE workspace_id=$1 AND field_id=$2 AND NOT archived LIMIT 1",
          [workspace, id],
        )
      ).rows[0]
    )
      throw new ApiError(409, "field_in_use");
    if (
      (
        await client.query(
          `SELECT 1 FROM flows f JOIN flow_versions v ON v.id=f.published_version_id
           WHERE f.workspace_id=$1 AND NOT f.archived AND $2::uuid=ANY(v.field_ids) LIMIT 1`,
          [workspace, id],
        )
      ).rows[0]
    )
      throw new ApiError(409, "field_in_use");
    await client.query("UPDATE instagram_contact_fields SET archived=true WHERE workspace_id=$1 AND id=$2", [
      workspace,
      id,
    ]);
    await client.query("COMMIT");
    return { id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function saveContactFieldValue(
  pool: Pool,
  user: User,
  connectionId: string,
  senderId: string,
  id: string,
  input: unknown,
) {
  if (
    !isUuid(connectionId) ||
    !isUuid(id) ||
    !senderId.trim() ||
    !isRecord(input) ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, "value")
  )
    throw new ApiError(400, "invalid_field_value");
  const workspace = await workspaceFor(pool, user);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Same connection lock as lockContactConnection in contacts.ts, which serializes with data deletion.
    await client.query("SELECT id FROM instagram_connections WHERE id=$1 AND workspace_id=$2 FOR SHARE", [
      connectionId,
      workspace,
    ]);
    const field = (
      await client.query<{ type: string }>(
        "SELECT type FROM instagram_contact_fields WHERE workspace_id=$1 AND id=$2 AND NOT archived FOR SHARE",
        [workspace, id],
      )
    ).rows[0];
    if (!field) throw new ApiError(404, "field_not_found");
    if (input.value !== null) validateValue(field.type, input.value);
    const saved = await client.query(
      `INSERT INTO instagram_contact_field_values(workspace_id,connection_id,sender_id,field_id,value)
      SELECT $1,$2,$3,$4,$5::jsonb WHERE EXISTS(SELECT 1 FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3)
      ON CONFLICT(workspace_id,connection_id,sender_id,field_id) DO UPDATE SET value=EXCLUDED.value RETURNING value`,
      [workspace, connectionId, senderId, id, input.value === null ? null : JSON.stringify(input.value)],
    );
    if (!saved.rows[0]) throw new ApiError(404, "contact_not_found");
    await client.query("COMMIT");
    return { value: saved.rows[0].value };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
