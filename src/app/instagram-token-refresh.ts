import type { Pool } from "pg";
import { openSecret, sealSecret } from "./secrets.ts";

interface DueToken {
  id: string;
  workspace_id: string;
  account_id: string;
  access_token_encrypted: string;
}

async function providerJson(fetchImpl: typeof fetch, url: URL | string, init: RequestInit): Promise<unknown> {
  try {
    const response = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

export async function refreshDueInstagramTokens(
  pool: Pool,
  key: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  graphVersion = "v26.0",
): Promise<number> {
  return (await refreshDueInstagramTokensWithFailures(pool, key, fetchImpl, now, graphVersion)).refreshed;
}

// Also counts the claimed connections whose token could not be refreshed: a token that does not decrypt, a
// failed or timed-out Meta call, an invalid refresh body or a profile that does not match the account. A
// refresh that loses to a newer token or a stopped connection is not a failure.
export async function refreshDueInstagramTokensWithFailures(
  pool: Pool,
  key: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  graphVersion = "v26.0",
): Promise<{ refreshed: number; failed: number }> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid refresh time");
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error("Invalid Graph API version");
  sealSecret("key-check", key, "config-check");
  let refreshed = 0;
  let failed = 0;
  for (let count = 0; count < 10; count++) {
    const claimed = await pool.query<DueToken>(
      `UPDATE instagram_connections SET token_refresh_attempted_at=$1
       WHERE id=(SELECT id FROM instagram_connections
         WHERE active=true AND access_token_encrypted IS NOT NULL AND token_expires_at>$1
           AND token_expires_at<=$1::timestamptz+interval '30 days'
           AND token_obtained_at<=$1::timestamptz-interval '1 day'
           AND (token_refresh_attempted_at IS NULL OR token_refresh_attempted_at<=$1::timestamptz-interval '1 day')
         ORDER BY token_expires_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,workspace_id,account_id,access_token_encrypted`,
      [now],
    );
    const connection = claimed.rows[0];
    if (!connection) break;
    const context = `${connection.workspace_id}:${connection.account_id}`;
    let accessToken: string;
    try {
      accessToken = openSecret(connection.access_token_encrypted, key, context);
    } catch {
      failed++;
      continue;
    }
    const endpoint = new URL("https://graph.instagram.com/refresh_access_token");
    endpoint.searchParams.set("grant_type", "ig_refresh_token");
    endpoint.searchParams.set("access_token", accessToken);
    const value = await providerJson(fetchImpl, endpoint, { method: "GET" });
    if (
      !value ||
      typeof value !== "object" ||
      !("access_token" in value) ||
      typeof value.access_token !== "string" ||
      !value.access_token ||
      !("expires_in" in value) ||
      typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 30 * 86400 ||
      value.expires_in > 90 * 86400
    ) {
      failed++;
      continue;
    }
    const profile = await providerJson(fetchImpl, `https://graph.instagram.com/${graphVersion}/me?fields=user_id`, {
      method: "GET",
      headers: { Authorization: `Bearer ${value.access_token}` },
    });
    const account =
      profile && typeof profile === "object" && "data" in profile && Array.isArray(profile.data)
        ? profile.data[0]
        : profile;
    if (
      !account ||
      typeof account !== "object" ||
      !("user_id" in account) ||
      account.user_id !== connection.account_id
    ) {
      failed++;
      continue;
    }
    const encrypted =
      value.access_token === accessToken
        ? connection.access_token_encrypted
        : sealSecret(value.access_token, key, context);
    const saved = await pool.query(
      `UPDATE instagram_connections SET access_token_encrypted=$4,token_expires_at=$5,
         token_obtained_at=$3,token_refresh_attempted_at=NULL
       WHERE id=$1 AND active=true AND access_token_encrypted=$2 AND token_refresh_attempted_at=$3 RETURNING id`,
      [
        connection.id,
        connection.access_token_encrypted,
        now,
        encrypted,
        new Date(now.getTime() + value.expires_in * 1000),
      ],
    );
    if (saved.rowCount === 1) refreshed++;
  }
  return { refreshed, failed };
}
