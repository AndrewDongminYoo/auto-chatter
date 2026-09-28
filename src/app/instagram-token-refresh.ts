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
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid refresh time");
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error("Invalid Graph API version");
  sealSecret("key-check", key, "config-check");
  let refreshed = 0;
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
    )
      continue;
    const profile = await providerJson(fetchImpl, `https://graph.instagram.com/${graphVersion}/me?fields=user_id`, {
      method: "GET",
      headers: { Authorization: `Bearer ${value.access_token}` },
    });
    if (!profile || typeof profile !== "object" || !("user_id" in profile) || profile.user_id !== connection.account_id)
      continue;
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
  return refreshed;
}
