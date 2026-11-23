import type { Pool } from "pg";
import { isRecord } from "./auth.ts";
import type { InstagramOAuthEnv } from "./instagram-oauth.ts";
import { logOperation } from "./operations-log.ts";
import { openSecret, tokenKeys, type SecretKey } from "./secrets.ts";
import { classifyMetaGraphFailure, metaTokenRejected } from "../instagram/meta-graph-error.ts";

// DM sender usernames from the Instagram User Profile API (#395 stage 2). The inbox list fetches them for its own
// page: at most this many senders per request, each call bounded by the timeout. A success is fetched again after
// 7 days and a failure after 1 day (the intervals are in the store statement below).
export const PROFILE_FETCHES_PER_LIST = 5;
const PROFILE_TIMEOUT_MS = 3_000;
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
const PROFILE_RECIPIENT = /^[0-9]{1,40}$/;

export type ProfileFailure = "graph_error" | "invalid_profile" | "profile_unavailable" | "token_rejected";
export type ProfileResult = { connection_id: string; recipient_id: string; username: string | null; failure_code: ProfileFailure | null };
type Listed = { connection_id: string; recipient_id: string; profile_due: boolean };
type Claimed = { connection_id: string; recipient_id: string; claim_id: string };

// Fetches the due profiles of the listed conversations and stores the answers. It never throws: the list request
// does not depend on it, and a missing configuration, an unreadable token or a database error skips the step.
// The token goes only to graph.instagram.com, only in the Authorization header. Logs carry fixed codes only.
export async function refreshDmProfiles(pool: Pool, workspaceId: string, listed: readonly Listed[], env: InstagramOAuthEnv, fetchImpl: typeof fetch): Promise<ProfileResult[]> {
  const due = listed.filter((row) => row.profile_due);
  if (!due.length || !env.TOKEN_ENCRYPTION_KEY || !env.META_GRAPH_VERSION || !/^v\d+\.\d+$/.test(env.META_GRAPH_VERSION)) return [];
  try {
    const claim = await claimDueProfiles(pool, workspaceId, due, tokenKeys(env)!);
    if (!claim.rows.length) return [];
    const results = await Promise.all(claim.rows.map(async (row) => ({ ...row, ...(await fetchProfile(row.recipient_id, claim.tokens.get(row.connection_id)!, env.META_GRAPH_VERSION!, fetchImpl)) })));
    for (const result of results) if (result.failure_code) logOperation({ event: "inbox_profile_fetch", code: result.failure_code, connection_id: result.connection_id }, "warn");
    // An UPDATE, not an upsert, and only on the row that still carries this request's claim_id: a row that a
    // deletion removed after the claim stays deleted, and a row that a later claim created again after that deletion
    // keeps the later answer. A success replaces the username and fetched_at; a failure changes only failure_code and
    // next_fetch_at, so a username from an earlier success stays shown. The stored rows are returned, so the
    // response shows what was stored.
    const stored = await pool.query<ProfileResult>(
      `UPDATE instagram_dm_profiles p SET username=coalesce(r.username,p.username),failure_code=r.failure_code,
         fetched_at=CASE WHEN r.failure_code IS NULL THEN now() ELSE p.fetched_at END,
         next_fetch_at=now()+CASE WHEN r.failure_code IS NULL THEN interval '7 days' ELSE interval '1 day' END,claim_id=NULL,updated_at=now()
       FROM unnest($2::uuid[],$3::text[],$4::uuid[],$5::text[],$6::text[]) AS r(connection_id,recipient_id,claim_id,username,failure_code)
       WHERE p.workspace_id=$1 AND p.connection_id=r.connection_id AND p.recipient_id=r.recipient_id AND p.claim_id=r.claim_id
       RETURNING p.connection_id,p.recipient_id,p.username,p.failure_code`,
      [workspaceId, results.map((row) => row.connection_id), results.map((row) => row.recipient_id), results.map((row) => row.claim_id), results.map((row) => row.username), results.map((row) => row.failure_code)],
    );
    return stored.rows;
  } catch {
    logOperation({ event: "inbox_profile_fetch", code: "store_failed" }, "warn");
    return [];
  }
}

// Claims at most PROFILE_FETCHES_PER_LIST due rows in one transaction that commits before any Graph call. The
// connections are locked FOR SHARE in ID order, like other writes that must serialize with the connection, person
// and workspace deletion functions; the claim then runs with a snapshot taken after the lock, so it sees a
// deletion that committed first: a cleared token excludes the connection, and a conversation without stored
// messages is not claimed. Only active connections with a stored, unexpired token qualify: an environment-managed
// Node connection has none, and an OAuth reconnect keeps the new token on an inactive row until its webhook
// subscription succeeds.
async function claimDueProfiles(pool: Pool, workspaceId: string, due: readonly Listed[], key: SecretKey): Promise<{ rows: Claimed[]; tokens: Map<string, string> }> {
  const tokens = new Map<string, string>();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const connections = await client.query<{ id: string; account_id: string; access_token_encrypted: string }>(
      `SELECT id,account_id,access_token_encrypted FROM instagram_connections
       WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND active AND access_token_encrypted IS NOT NULL AND token_expires_at>now()
       ORDER BY id FOR SHARE`,
      [workspaceId, [...new Set(due.map((row) => row.connection_id))]],
    );
    for (const connection of connections.rows) {
      try {
        tokens.set(connection.id, openSecret(connection.access_token_encrypted, key, `${workspaceId}:${connection.account_id}`));
      } catch {
        logOperation({ event: "inbox_profile_fetch", code: "token_unreadable", connection_id: connection.id }, "warn");
      }
    }
    // The table accepts only the IDs that its CHECK accepts; stored inbox messages allow longer digit strings, and
    // one such ID would otherwise fail the whole claim, so those conversations are never fetched.
    const candidates = due.filter((row) => tokens.has(row.connection_id) && PROFILE_RECIPIENT.test(row.recipient_id)).slice(0, PROFILE_FETCHES_PER_LIST);
    if (!candidates.length) {
      await client.query("COMMIT");
      return { rows: [], tokens };
    }
    // One conditional upsert claims the rows: a row is claimed only when it is new or due, and the claim moves
    // next_fetch_at ahead, so a concurrent list load that reaches the same row afterwards does not claim it again.
    // Each claim writes a new claim_id, which the result UPDATE must match. The upsert writes the rows in key order,
    // not list order, so two concurrent claims that read the list in different orders do not deadlock.
    const claimed = await client.query<Claimed>(
      `INSERT INTO instagram_dm_profiles(workspace_id,connection_id,recipient_id,next_fetch_at,claim_id)
       SELECT $1,t.connection_id,t.recipient_id,now()+interval '5 minutes',gen_random_uuid()
       FROM unnest($2::uuid[],$3::text[]) AS t(connection_id,recipient_id)
       WHERE EXISTS(SELECT 1 FROM instagram_inbox_messages m
         WHERE m.workspace_id=$1 AND m.connection_id=t.connection_id AND m.recipient_id=t.recipient_id)
       ORDER BY t.connection_id,t.recipient_id
       ON CONFLICT(connection_id,recipient_id) DO UPDATE SET next_fetch_at=EXCLUDED.next_fetch_at,claim_id=EXCLUDED.claim_id,updated_at=now()
       WHERE instagram_dm_profiles.next_fetch_at<=now()
       RETURNING connection_id,recipient_id,claim_id`,
      [workspaceId, candidates.map((row) => row.connection_id), candidates.map((row) => row.recipient_id)],
    );
    await client.query("COMMIT");
    return { rows: claimed.rows, tokens };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function fetchProfile(recipientId: string, token: string, version: string, fetchImpl: typeof fetch): Promise<{ username: string | null; failure_code: ProfileFailure | null }> {
  const failure = (failure_code: ProfileFailure) => ({ username: null, failure_code });
  const url = new URL(`https://graph.instagram.com/${version}/${recipientId}`);
  url.searchParams.set("fields", "username");
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS), redirect: "manual" });
  } catch {
    return failure("graph_error");
  }
  try {
    if (!response.ok) {
      if (response.status < 400 || response.status >= 500) {
        await response.body?.cancel();
        return failure("graph_error");
      }
      if (await metaTokenRejected(response)) {
        await response.body?.cancel();
        return failure("token_rejected");
      }
      // A 429 or a transient Graph error is an Error; any other 4xx is a definite refusal for this sender.
      return failure((await classifyMetaGraphFailure(response, "GET", new Date())) ? "graph_error" : "profile_unavailable");
    }
    const body: unknown = await response.json();
    return isRecord(body) && typeof body.username === "string" && USERNAME.test(body.username) ? { username: body.username, failure_code: null } : failure("invalid_profile");
  } catch {
    return failure("graph_error");
  }
}
