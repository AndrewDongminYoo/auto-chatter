import type { Pool } from "pg";
import { ApiError, type User } from "./auth.ts";
import { roleAllows, type WorkspaceRole } from "./settings.ts";

// Every public table is either exported here or listed in EXCLUDED_TABLES; workspace-export.db.test.ts enforces it.
// "connection" tables carry no workspace_id and are scoped through the workspace's connections; "self"
// is the workspace row itself, which holds its settings.
export const EXPORTED_TABLES: Record<string, { scope: "self" | "workspace" | "connection"; omit?: string[] }> = {
  workspaces: { scope: "self" },
  workspace_members: { scope: "workspace" },
  workspace_invites: { scope: "workspace", omit: ["token_hash"] },
  instagram_connections: { scope: "workspace", omit: ["access_token_encrypted"] },
  instagram_comment_rules: { scope: "workspace" },
  instagram_comment_events: { scope: "workspace" },
  private_reply_outbox: { scope: "workspace" },
  instagram_follow_conversations: { scope: "connection" },
  instagram_message_receipts: { scope: "connection" },
  instagram_inbox_messages: { scope: "workspace" },
  // Kept DM text is removed after 15 minutes and is not exported in the meantime either.
  instagram_unmatched_replies: { scope: "workspace", omit: ["message_text"] },
  instagram_contact_automation: { scope: "workspace" },
  instagram_contact_tags: { scope: "workspace" },
  instagram_contact_segments: { scope: "workspace" },
  instagram_contact_fields: { scope: "workspace" },
  instagram_contact_field_values: { scope: "workspace" },
  instagram_inbox_handoffs: { scope: "workspace" },
  instagram_inbox_handoff_events: { scope: "workspace" },
  instagram_inbox_conversations: { scope: "workspace" },
  instagram_inbox_conversation_events: { scope: "workspace" },
  instagram_inbox_read_state: { scope: "workspace" },
  instagram_manual_replies: { scope: "workspace" },
  instagram_manual_reply_events: { scope: "workspace" },
  channel_consent_events: { scope: "workspace" },
  channel_consent_state: { scope: "workspace" },
  flows: { scope: "workspace" },
  flow_versions: { scope: "workspace" },
  flow_runs: { scope: "workspace" },
  flow_step_runs: { scope: "workspace" },
  webhook_endpoints: { scope: "workspace" },
  // The sealed signing secret never leaves the database; the key ID and its dates are exported.
  webhook_signing_keys: { scope: "workspace", omit: ["secret_encrypted"] },
  webhook_deliveries: { scope: "workspace" },
  webhook_redelivery_events: { scope: "workspace" },
  data_deletion_records: { scope: "workspace" },
};

// OAuth states hold short-lived login secrets; workspace deletion evidence belongs to workspaces that no longer exist;
// scheduled_steps is service-wide operations state with no workspace data.
export const EXCLUDED_TABLES = ["instagram_oauth_states", "workspace_deletion_records", "scheduled_steps"];
// What the export leaves out, derived from the table settings so the file cannot understate it.
export const EXCLUDED_ITEMS = [
  ...Object.entries(EXPORTED_TABLES).flatMap(([table, { omit = [] }]) => omit.map((column) => `${table}.${column}`)),
  ...EXCLUDED_TABLES,
];

export async function exportWorkspace(pool: Pool, user: User) {
  const client = await pool.connect();
  try {
    // One snapshot for the membership check and every exported row, so a member removed concurrently
    // cannot export, and rows that reference each other are exported consistently.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const membership = await client.query<{ workspace_id: string; role: WorkspaceRole }>(
      "SELECT workspace_id,role FROM workspace_members WHERE user_id=$1 AND removed_at IS NULL",
      [user.id],
    );
    if (!membership.rows[0]) throw new ApiError(403, "workspace_required");
    // The export holds every comment, DM and contact record, so agents cannot take it.
    if (!roleAllows(membership.rows[0].role, "admin")) throw new ApiError(403, "role_forbidden");
    const workspace = membership.rows[0].workspace_id;
    // Rows stay as PostgreSQL JSON text: parsing them in JavaScript would round bigint IDs above 2^53.
    const tables: string[] = [];
    for (const [table, { scope, omit = [] }] of Object.entries(EXPORTED_TABLES)) {
      const filter =
        scope === "self"
          ? "t.id=$1"
          : scope === "workspace"
            ? "t.workspace_id=$1"
            : "t.connection_id IN (SELECT id FROM instagram_connections WHERE workspace_id=$1)";
      const result = await client.query<{ rows: string }>(
        `SELECT coalesce(jsonb_agg(to_jsonb(t) - $2::text[] ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS rows
         FROM ${table} t WHERE ${filter}`,
        [workspace, omit],
      );
      tables.push(`${JSON.stringify(table)}:${result.rows[0]!.rows}`);
    }
    const exportedAt = (await client.query<{ now: Date }>("SELECT now()")).rows[0]!.now;
    await client.query("COMMIT");
    const header = JSON.stringify({
      format: "auto-chatter-workspace-export",
      version: 1,
      exported_at: exportedAt.toISOString(),
      workspace_id: workspace,
      excluded: EXCLUDED_ITEMS,
    });
    return {
      exportedAt: exportedAt.toISOString(),
      body: `${header.slice(0, -1)},"tables":{${tables.join(",")}}}`,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
