import type { Pool } from "pg";

// The reconnect marker on instagram_connections (#16): Meta rejected the stored token, so the account must be
// reconnected. It is display only; no claim, wake query or final guard reads it. Each write compares the
// ciphertext the caller used, as the Cloudflare final guard does, so a result for a replaced token changes
// nothing. reauth_token_obtained_at records which token was rejected.
export type ReauthReason = "refresh_rejected" | "token_rejected";

// Marks the connection unless it is already marked for the same token, which keeps the first rejection time.
export async function markReauthRequired(
  pool: Pick<Pool, "query">,
  connectionId: string,
  encryptedToken: string,
  reason: ReauthReason,
  at: Date | null = null,
): Promise<boolean> {
  const marked = await pool.query(
    `UPDATE instagram_connections
     SET reauth_required_at=coalesce($4::timestamptz,clock_timestamp()),reauth_reason=$3,
       reauth_token_obtained_at=token_obtained_at
     WHERE id=$1 AND access_token_encrypted=$2 AND reauth_token_obtained_at IS DISTINCT FROM token_obtained_at`,
    [connectionId, encryptedToken, reason, at],
  );
  return marked.rowCount === 1;
}

// Clears the marker after Meta accepted the same stored token. With onlyReason, a marker with another reason is
// kept: an accepted me read proves the token works, not that Meta will refresh it (refresh_rejected).
export async function clearReauthRequired(
  pool: Pick<Pool, "query">,
  connectionId: string,
  encryptedToken: string,
  onlyReason: ReauthReason | null = null,
): Promise<boolean> {
  const cleared = await pool.query(
    `UPDATE instagram_connections SET reauth_required_at=NULL,reauth_reason=NULL,reauth_token_obtained_at=NULL
     WHERE id=$1 AND access_token_encrypted=$2 AND reauth_required_at IS NOT NULL
       AND ($3::text IS NULL OR reauth_reason=$3)`,
    [connectionId, encryptedToken, onlyReason],
  );
  return cleared.rowCount === 1;
}
