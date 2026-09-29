import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";

// SQLSTATEs raised by public.delete_connection_data (db/migrations/018_connection_data_deletion.sql).
const DELETION_ERRORS: Record<string, [number, string]> = {
  AC001: [404, "connection_not_found"],
  AC002: [409, "connection_active"],
  AC003: [409, "sending_in_progress"],
  AC004: [409, "confirmation_mismatch"],
};

export async function deleteConnectionData(pool: Pool, user: User, connectionId: string, input: unknown) {
  if (
    !isUuid(connectionId) ||
    !isRecord(input) ||
    Object.keys(input).some((key) => key !== "confirm_account_id") ||
    typeof input.confirm_account_id !== "string" ||
    !input.confirm_account_id.trim() ||
    input.confirm_account_id.length > 255
  )
    throw new ApiError(400, "invalid_data_deletion");
  const workspace = await workspaceFor(pool, user);
  try {
    const result = await pool.query<{ result: unknown }>(
      "SELECT public.delete_connection_data($1,$2,$3,$4) AS result",
      [workspace, connectionId, user.id, input.confirm_account_id],
    );
    return result.rows[0]!.result;
  } catch (error) {
    const mapped = isRecord(error) && typeof error.code === "string" ? DELETION_ERRORS[error.code] : undefined;
    if (mapped) throw new ApiError(mapped[0], mapped[1]);
    throw error;
  }
}

export async function listDataDeletions(pool: Pool, user: User, connectionId: string) {
  if (!isUuid(connectionId)) throw new ApiError(400, "invalid_data_deletion");
  const workspace = await workspaceFor(pool, user);
  const owned = await pool.query("SELECT 1 FROM instagram_connections WHERE id=$1 AND workspace_id=$2", [
    connectionId,
    workspace,
  ]);
  if (!owned.rows[0]) throw new ApiError(404, "connection_not_found");
  return (
    await pool.query(
      `SELECT id,requested_by,completed_at,deleted_counts,retained_counts FROM data_deletion_records
       WHERE workspace_id=$1 AND connection_id=$2 ORDER BY completed_at DESC,id LIMIT 50`,
      [workspace, connectionId],
    )
  ).rows;
}
