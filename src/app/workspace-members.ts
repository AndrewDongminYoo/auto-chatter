import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { lockWorkspaceForMember, normalizeEmail, workspaceFor } from "./settings.ts";
import { unassignRemovedMember } from "./inbox-conversations.ts";

const INVITE_DAYS = 7;
const MAX_OPEN_INVITES = 20;
const INVITABLE_ROLES = ["admin", "agent"];

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function inviteRole(value: unknown): "admin" | "agent" {
  if (typeof value !== "string" || !INVITABLE_ROLES.includes(value)) throw new ApiError(400, "invalid_role");
  return value as "admin" | "agent";
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

export async function listMembers(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user, "owner");
  return (
    await pool.query(
      `SELECT user_id,email,role,user_id=$2 AS is_self FROM workspace_members
       WHERE workspace_id=$1 AND removed_at IS NULL ORDER BY role='owner' DESC,email NULLS LAST,user_id`,
      [workspace, user.id],
    )
  ).rows;
}

export async function listInvites(pool: Pool, user: User) {
  const workspace = await workspaceFor(pool, user, "owner");
  return (
    await pool.query(
      `SELECT id,email,role,created_at,expires_at,expires_at<=now() AS expired FROM workspace_invites
       WHERE workspace_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC,id`,
      [workspace],
    )
  ).rows;
}

// The token appears once, in the returned link; only its hash is stored. The link keeps it in the fragment,
// which browsers do not send to the server or in a Referer header.
export async function createInvite(pool: Pool, user: User, input: unknown, origin: string) {
  if (!isRecord(input) || Object.keys(input).some((key) => !["email", "role"].includes(key)))
    throw new ApiError(400, "invalid_invite");
  if (
    typeof input.email !== "string" ||
    input.email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())
  )
    throw new ApiError(400, "invalid_email");
  const email = normalizeEmail(input.email);
  const role = inviteRole(input.role);
  const workspace = await workspaceFor(pool, user, "owner");
  const token = randomBytes(32).toString("base64url");
  const invite = await transaction(pool, async (client) => {
    await lockWorkspaceForMember(client, workspace, user, "owner");
    if (
      (
        await client.query(
          "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND email=$2 AND removed_at IS NULL",
          [workspace, email],
        )
      ).rowCount
    )
      throw new ApiError(409, "already_member");
    // A new invite for the same email replaces the open one, so only the latest link works.
    await client.query(
      "UPDATE workspace_invites SET revoked_at=now() WHERE workspace_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
      [workspace, email],
    );
    const created = await client.query(
      `INSERT INTO workspace_invites(workspace_id,email,role,token_hash,created_by,expires_at)
       SELECT $1,$2,$3,$4,$5,now()+make_interval(days=>$6)
       WHERE (SELECT count(*) FROM workspace_invites WHERE workspace_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now())<$7
       RETURNING id,email,role,created_at,expires_at`,
      [workspace, email, role, tokenHash(token), user.id, INVITE_DAYS, MAX_OPEN_INVITES],
    );
    if (!created.rows[0]) throw new ApiError(409, "invite_limit_reached");
    return created.rows[0];
  });
  return { ...invite, link: `${origin}/app/#invite=${token}` };
}

export async function revokeInvite(pool: Pool, user: User, id: string) {
  if (!isUuid(id)) throw new ApiError(400, "invalid_invite");
  const workspace = await workspaceFor(pool, user, "owner");
  const revoked = await pool.query(
    `UPDATE workspace_invites SET revoked_at=now()
     WHERE id=$1 AND workspace_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
    [id, workspace],
  );
  if (!revoked.rowCount) throw new ApiError(404, "invite_not_found");
  return { id };
}

async function targetMember(client: PoolClient, workspace: string, user: User, memberId: string) {
  if (!isUuid(memberId)) throw new ApiError(400, "invalid_member");
  if (memberId === user.id) throw new ApiError(409, "cannot_change_self");
  const member = (
    await client.query<{ role: string }>(
      "SELECT role FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 AND removed_at IS NULL FOR UPDATE",
      [memberId, workspace],
    )
  ).rows[0];
  if (!member) throw new ApiError(404, "member_not_found");
  if (member.role === "owner") throw new ApiError(409, "cannot_change_owner");
}

export async function changeMemberRole(pool: Pool, user: User, memberId: string, input: unknown) {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "role")) throw new ApiError(400, "invalid_role");
  const role = inviteRole(input.role);
  const workspace = await workspaceFor(pool, user, "owner");
  return transaction(pool, async (client) => {
    await targetMember(client, workspace, user, memberId);
    await client.query("UPDATE workspace_members SET role=$3 WHERE user_id=$1 AND workspace_id=$2", [
      memberId,
      workspace,
      role,
    ]);
    return { user_id: memberId, role };
  });
}

// The row stays with removed_at set: server roles cannot DELETE, and every request filters removed members out.
// The member's conversations become unassigned in the same transaction; replies they already queued are kept.
export async function removeMember(pool: Pool, user: User, memberId: string) {
  const workspace = await workspaceFor(pool, user, "owner");
  return transaction(pool, async (client) => {
    // The workspace row first: delete_workspace_data locks it before the connections that unassigning takes.
    await client.query("SELECT 1 FROM workspaces WHERE id=$1 FOR SHARE", [workspace]);
    await targetMember(client, workspace, user, memberId);
    await client.query(
      "UPDATE workspace_members SET removed_at=now(),removed_by=$3 WHERE user_id=$1 AND workspace_id=$2",
      [memberId, workspace, user.id],
    );
    const unassigned = await unassignRemovedMember(client, workspace, memberId, user.id);
    return { user_id: memberId, removed: true, unassigned_conversations: unassigned };
  });
}

// Joining is allowed from no workspace, from a removed membership, or from the user's own workspace when
// they are its only member and it holds nothing yet (the app creates one on first sign-in).
async function currentWorkspaceMovable(client: PoolClient, workspace: string, userId: string): Promise<boolean> {
  const busy = await client.query(
    `SELECT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id<>$2 AND removed_at IS NULL)
       OR EXISTS(SELECT 1 FROM instagram_connections WHERE workspace_id=$1)
       OR EXISTS(SELECT 1 FROM instagram_comment_rules WHERE workspace_id=$1)
       OR EXISTS(SELECT 1 FROM flows WHERE workspace_id=$1)
       OR EXISTS(SELECT 1 FROM instagram_contact_fields WHERE workspace_id=$1)
       OR EXISTS(SELECT 1 FROM instagram_contact_segments WHERE workspace_id=$1)
       OR EXISTS(SELECT 1 FROM instagram_inbox_labels WHERE workspace_id=$1)
       OR EXISTS(SELECT 1 FROM workspace_invites WHERE workspace_id=$1)
       OR EXISTS(SELECT 1 FROM instagram_oauth_states WHERE workspace_id=$1 AND consumed_at IS NULL AND expires_at>now())
       AS busy`,
    [workspace, userId],
  );
  return !busy.rows[0]!.busy;
}

export async function acceptInvite(pool: Pool, user: User, input: unknown) {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "token") || typeof input.token !== "string")
    throw new ApiError(400, "invalid_invite");
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw new ApiError(404, "invite_not_found");
  const hash = tokenHash(input.token);
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.id]);
    // Lock order matches createInvite (workspace, then invite row): find the workspace unlocked, lock it,
    // then lock and re-read the invite, so a concurrent re-invite cannot deadlock with this acceptance.
    const target = (
      await client.query<{ workspace_id: string }>("SELECT workspace_id FROM workspace_invites WHERE token_hash=$1", [
        hash,
      ])
    ).rows[0];
    if (!target) throw new ApiError(404, "invite_not_found");
    // An owner leaving their own workspace also needs that row FOR UPDATE below. Take both workspace locks
    // in ID order, so two owners accepting each other's invites queue instead of deadlocking.
    const source = (
      await client.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND removed_at IS NULL AND role='owner'",
        [user.id],
      )
    ).rows[0]?.workspace_id;
    const workspaceLocks: [string, "SHARE" | "UPDATE"][] = [[target.workspace_id, "SHARE"]];
    if (source && source !== target.workspace_id) workspaceLocks.push([source, "UPDATE"]);
    workspaceLocks.sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [id, mode] of workspaceLocks)
      await client.query(`SELECT id FROM workspaces WHERE id=$1 FOR ${mode}`, [id]);
    const invite = (
      await client.query<{
        id: string;
        workspace_id: string;
        email: string;
        role: string;
        expired: boolean;
        accepted_at: Date | null;
        accepted_by: string | null;
        revoked_at: Date | null;
      }>(
        `SELECT id,workspace_id,email,role,expires_at<=now() AS expired,accepted_at,accepted_by,revoked_at
         FROM workspace_invites WHERE token_hash=$1 FOR UPDATE`,
        [hash],
      )
    ).rows[0];
    if (!invite) throw new ApiError(404, "invite_not_found");
    if (invite.accepted_at) {
      // A retry after a lost response answers the original success; anyone else, or the same user after a
      // removal or a move, gets invite_used.
      if (invite.accepted_by === user.id) {
        const member = (
          await client.query<{ role: string }>(
            "SELECT role FROM workspace_members WHERE user_id=$1 AND workspace_id=$2 AND removed_at IS NULL",
            [user.id, invite.workspace_id],
          )
        ).rows[0];
        if (member) return { workspace_id: invite.workspace_id, role: member.role };
      }
      throw new ApiError(409, "invite_used");
    }
    if (invite.revoked_at) throw new ApiError(410, "invite_revoked");
    if (invite.expired) throw new ApiError(410, "invite_expired");
    if (invite.email !== normalizeEmail(user.email)) throw new ApiError(403, "invite_email_mismatch");
    const current = (
      await client.query<{ workspace_id: string; role: string; removed: boolean }>(
        "SELECT workspace_id,role,removed_at IS NOT NULL AS removed FROM workspace_members WHERE user_id=$1 FOR UPDATE",
        [user.id],
      )
    ).rows[0];
    if (current && !current.removed) {
      if (current.workspace_id === invite.workspace_id) throw new ApiError(409, "already_member");
      // Holding the old workspace row blocks a concurrent invite or connection from filling it during the check.
      if (current.role === "owner")
        await client.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [current.workspace_id]);
      if (current.role !== "owner" || !(await currentWorkspaceMovable(client, current.workspace_id, user.id)))
        throw new ApiError(409, "workspace_not_empty");
    }
    await client.query(
      `INSERT INTO workspace_members(user_id,workspace_id,role,email) VALUES($1,$2,$3,$4)
       ON CONFLICT(user_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,role=EXCLUDED.role,email=EXCLUDED.email,
         removed_at=NULL,removed_by=NULL`,
      [user.id, invite.workspace_id, invite.role, invite.email],
    );
    await client.query("UPDATE workspace_invites SET accepted_at=now(),accepted_by=$2 WHERE id=$1", [
      invite.id,
      user.id,
    ]);
    return { workspace_id: invite.workspace_id, role: invite.role };
  });
}
