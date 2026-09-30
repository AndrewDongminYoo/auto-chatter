import type { Pool } from "pg";
import type { User } from "./auth.ts";
import { workspaceFor } from "./settings.ts";

// Every public table is either exported here or listed in EXCLUDED_TABLES; workspace-export.db.test.ts enforces it.
// "connection" tables carry no workspace_id and are scoped through the workspace's connections.
export const EXPORTED_TABLES: Record<string, { scope: "workspace" | "connection"; omit?: string[] }> = {
  workspace_members: { scope: "workspace" },
  instagram_connections: { scope: "workspace", omit: ["access_token_encrypted"] },
  instagram_comment_rules: { scope: "workspace" },
  instagram_comment_events: { scope: "workspace" },
  private_reply_outbox: { scope: "workspace" },
  instagram_follow_conversations: { scope: "connection" },
  instagram_message_receipts: { scope: "connection" },
  instagram_inbox_messages: { scope: "workspace" },
  instagram_contact_automation: { scope: "workspace" },
  instagram_contact_tags: { scope: "workspace" },
  instagram_contact_segments: { scope: "workspace" },
  instagram_contact_fields: { scope: "workspace" },
  instagram_contact_field_values: { scope: "workspace" },
  instagram_inbox_handoffs: { scope: "workspace" },
  instagram_inbox_handoff_events: { scope: "workspace" },
  instagram_manual_replies: { scope: "workspace" },
  instagram_manual_reply_events: { scope: "workspace" },
  channel_consent_events: { scope: "workspace" },
  channel_consent_state: { scope: "workspace" },
  flows: { scope: "workspace" },
  flow_versions: { scope: "workspace" },
  data_deletion_records: { scope: "workspace" },
};

// workspaces only holds the ID, which the export carries at the top level; OAuth states hold short-lived login secrets.
export const EXCLUDED_TABLES = ["workspaces", "instagram_oauth_states"];

export async function exportWorkspace(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user);
  const client = await pool.connect();
  try {
    // One snapshot so rows that reference each other are exported consistently.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables: Record<string, unknown[]> = {};
    for (const [table, { scope, omit = [] }] of Object.entries(EXPORTED_TABLES)) {
      const filter =
        scope === "workspace"
          ? "t.workspace_id=$1"
          : "t.connection_id IN (SELECT id FROM instagram_connections WHERE workspace_id=$1)";
      const result = await client.query<{ rows: unknown[] }>(
        `SELECT coalesce(jsonb_agg(to_jsonb(t) - $2::text[] ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows
         FROM ${table} t WHERE ${filter}`,
        [workspace, omit],
      );
      tables[table] = result.rows[0]!.rows;
    }
    const exportedAt = (await client.query<{ now: Date }>("SELECT now()")).rows[0]!.now;
    await client.query("COMMIT");
    return {
      format: "auto-chatter-workspace-export",
      version: 1,
      exported_at: exportedAt.toISOString(),
      workspace_id: workspace,
      excluded: ["instagram_connections.access_token_encrypted", ...EXCLUDED_TABLES],
      tables,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
