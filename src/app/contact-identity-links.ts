import type { Pool } from "pg";
import { ApiError, isRecord, isUuid, type User } from "./auth.ts";
import { lockWorkspaceForMember, membershipFor, roleAllows, workspaceFor } from "./settings.ts";
import { verifiedDmRecipientsSql } from "./inbox-identity.ts";

function invalid(): never {
  throw new ApiError(400, "invalid_identity_link_request");
}
function validatePath(connection: string, sender: string, recipient?: string) {
  if (!isUuid(connection) || !/^\d{1,40}$/.test(sender) || (recipient !== undefined && !/^\d{1,40}$/.test(recipient)))
    invalid();
}
type Change = {
  action: "confirm" | "detach";
  request_key: string;
  expected_version: number;
  evidence_reply_id: string | null;
};
export function parseIdentityLinkChange(input: unknown): Change {
  if (
    !isRecord(input) ||
    !["confirm", "detach"].includes(String(input.action)) ||
    !isUuid(input.request_key) ||
    !Number.isInteger(input.expected_version) ||
    Number(input.expected_version) < 0 ||
    Number(input.expected_version) >= 2147483647
  )
    invalid();
  const fields = [
    "action",
    "request_key",
    "expected_version",
    ...(input.action === "confirm" ? ["evidence_reply_id"] : []),
  ];
  if (Object.keys(input).length !== fields.length || !fields.every((key) => key in input)) invalid();
  if (
    input.action === "confirm" &&
    (typeof input.evidence_reply_id !== "string" ||
      !/^[1-9]\d{0,18}$/.test(input.evidence_reply_id) ||
      BigInt(input.evidence_reply_id) > 9223372036854775807n)
  )
    invalid();
  return {
    action: input.action as Change["action"],
    request_key: input.request_key,
    expected_version: Number(input.expected_version),
    evidence_reply_id: input.action === "confirm" ? (input.evidence_reply_id as string) : null,
  };
}
const currentColumns = "sender_id,recipient_id,state,version,evidence_reply_id::text,last_event_id::text,updated_at";
// Confirmation is advisory. Neither delivery nor deletion traverses these links.
export async function changeIdentityLink(
  pool: Pool,
  user: User,
  connection: string,
  sender: string,
  recipient: string,
  input: unknown,
) {
  validatePath(connection, sender, recipient);
  const change = parseIdentityLinkChange(input);
  const workspace = await workspaceFor(pool, user, "admin");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockWorkspaceForMember(client, workspace, user, "admin");
    const owned = await client.query(
      "SELECT id FROM instagram_connections WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE",
      [workspace, connection],
    );
    if (!owned.rows.length) throw new ApiError(404, "contact_not_found");
    const current =
      (
        await client.query(
          `SELECT ${currentColumns} FROM instagram_contact_identity_links WHERE workspace_id=$1 AND connection_id=$2 AND recipient_id=$3 FOR UPDATE`,
          [workspace, connection, recipient],
        )
      ).rows[0] ?? null;
    const previous = (
      await client.query(
        "SELECT id::text,connection_id,sender_id,recipient_id,action,version,evidence_reply_id::text FROM instagram_contact_identity_link_events WHERE workspace_id=$1 AND request_key=$2",
        [workspace, change.request_key],
      )
    ).rows[0];
    if (previous) {
      if (
        previous.connection_id !== connection ||
        previous.sender_id !== sender ||
        previous.recipient_id !== recipient ||
        previous.action !== change.action ||
        previous.version !== change.expected_version + 1 ||
        previous.evidence_reply_id !== change.evidence_reply_id
      )
        throw new ApiError(409, "identity_link_conflict");
      await client.query("COMMIT");
      return { event: previous, current, replayed: true };
    }
    if (change.action === "confirm") {
      const exists = await client.query(
        "SELECT 1 FROM instagram_comment_events WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3 LIMIT 1",
        [workspace, connection, sender],
      );
      if (!exists.rows.length) throw new ApiError(404, "contact_not_found");
    } else if (!current || current.sender_id !== sender) throw new ApiError(404, "contact_not_found");
    if ((current?.version ?? 0) !== change.expected_version) throw new ApiError(409, "identity_link_conflict");
    if (change.action === "confirm") {
      const bridge = (
        await client.query(
          `SELECT evidence_reply_id FROM (${verifiedDmRecipientsSql("workspace_id=$1 AND id=$2")}) verified WHERE sender_id=$3 AND recipient_id=$4`,
          [workspace, connection, sender, recipient],
        )
      ).rows[0];
      if (!bridge || bridge.evidence_reply_id !== change.evidence_reply_id)
        throw new ApiError(409, "identity_link_evidence_changed");
      if (
        current?.state === "confirmed" &&
        (current.sender_id !== sender || current.evidence_reply_id === change.evidence_reply_id)
      )
        throw new ApiError(409, "identity_link_conflict");
    } else if (current.state !== "confirmed") throw new ApiError(409, "identity_link_conflict");
    const event = (
      await client.query(
        `INSERT INTO instagram_contact_identity_link_events(workspace_id,connection_id,sender_id,recipient_id,previous_sender_id,previous_state,action,version,evidence_reply_id,request_key,actor_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id::text,action,version,evidence_reply_id::text`,
        [
          workspace,
          connection,
          sender,
          recipient,
          current?.sender_id ?? null,
          current?.state ?? null,
          change.action,
          change.expected_version + 1,
          change.evidence_reply_id,
          change.request_key,
          user.id,
        ],
      )
    ).rows[0];
    const saved = (
      await client.query(
        `INSERT INTO instagram_contact_identity_links(workspace_id,connection_id,recipient_id,sender_id,state,version,evidence_reply_id,last_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,connection_id,recipient_id) DO UPDATE SET
      sender_id=EXCLUDED.sender_id,state=EXCLUDED.state,version=EXCLUDED.version,evidence_reply_id=EXCLUDED.evidence_reply_id,last_event_id=EXCLUDED.last_event_id,updated_at=now()
      RETURNING ${currentColumns}`,
        [
          workspace,
          connection,
          recipient,
          sender,
          change.action === "confirm" ? "confirmed" : "detached",
          event.version,
          change.evidence_reply_id,
          event.id,
        ],
      )
    ).rows[0];
    await client.query("COMMIT");
    return { event, current: saved, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listIdentityLinks(
  pool: Pool,
  user: User,
  connection: string,
  sender: string,
  query: URLSearchParams,
) {
  validatePath(connection, sender);
  for (const key of query.keys()) if (key !== "after" || query.getAll(key).length !== 1) invalid();
  type Cursor = { workspace_id: string; connection_id: string; sender_id: string; recipient_id: string };
  let after: Cursor | null = null;
  if (query.has("after")) {
    try {
      const encoded = query.get("after")!;
      if (encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
      const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 4 ||
        !isUuid(value.workspace_id) ||
        value.connection_id !== connection ||
        value.sender_id !== sender ||
        typeof value.recipient_id !== "string" ||
        !/^\d{1,40}$/.test(value.recipient_id)
      )
        invalid();
      after = value as Cursor;
    } catch {
      invalid();
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { workspace_id: workspace, role } = await membershipFor(client, user, "agent");
    if (after && after.workspace_id !== workspace) invalid();
    const owned = await client.query(
      `SELECT id FROM instagram_connections c WHERE workspace_id=$1 AND id=$2 AND (
      EXISTS(SELECT 1 FROM instagram_comment_events e WHERE e.workspace_id=$1 AND e.connection_id=$2 AND e.sender_id=$3)
      OR EXISTS(SELECT 1 FROM instagram_contact_identity_links l WHERE l.workspace_id=$1 AND l.connection_id=$2 AND l.sender_id=$3))`,
      [workspace, connection, sender],
    );
    if (!owned.rows.length) throw new ApiError(404, "contact_not_found");
    // Include current verified candidates so a detached row previously owned by another sender can be confirmed
    // with its actual version, without exposing that sender or its history. Pagination covers both sets once.
    const rows = (
      await client.query(
        `WITH verified AS (${verifiedDmRecipientsSql("workspace_id=$1 AND id=$2")}), targets AS (
      SELECT recipient_id FROM verified WHERE sender_id=$3 UNION SELECT recipient_id FROM instagram_contact_identity_links WHERE workspace_id=$1 AND connection_id=$2 AND sender_id=$3
    ) SELECT t.recipient_id,CASE WHEN l.sender_id=$3 THEN l.state ELSE NULL END AS state,coalesce(l.version,0) AS version,
      CASE WHEN l.sender_id=$3 THEN l.evidence_reply_id::text ELSE NULL END AS evidence_reply_id,
      v.evidence_reply_id AS current_evidence_reply_id,
      coalesce(l.sender_id=$3 AND l.state='confirmed' AND l.evidence_reply_id::text=v.evidence_reply_id,false) AS evidence_valid,
      coalesce(l.sender_id<>$3 AND l.state='confirmed',false) AS blocked
    FROM targets t LEFT JOIN instagram_contact_identity_links l ON l.workspace_id=$1 AND l.connection_id=$2 AND l.recipient_id=t.recipient_id
    LEFT JOIN verified v ON v.recipient_id=t.recipient_id AND v.sender_id=$3
    WHERE ($4::text IS NULL OR t.recipient_id COLLATE "C">$4 COLLATE "C") ORDER BY t.recipient_id COLLATE "C" LIMIT 51`,
        [workspace, connection, sender, after?.recipient_id ?? null],
      )
    ).rows;
    const links = rows.slice(0, 50);
    const cursor =
      rows.length > 50
        ? Buffer.from(
            JSON.stringify({
              workspace_id: workspace,
              connection_id: connection,
              sender_id: sender,
              recipient_id: links.at(-1)!.recipient_id,
            }),
          ).toString("base64url")
        : null;
    await client.query("COMMIT");
    return { links, after: cursor, can_edit: roleAllows(role, "admin") };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
