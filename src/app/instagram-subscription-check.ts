import type { Pool } from "pg";
import { isRecord } from "./auth.ts";
import { openSecret, sealSecret } from "./secrets.ts";
import { clearReauthRequired, markReauthRequired } from "./instagram-reauth.ts";
import { ConfigurationError, failureCode, logOperation } from "./operations-log.ts";
import { isMetaTokenRejection, readMetaGraphErrorCode } from "../instagram/meta-graph-error.ts";

// The webhook subscription check (#179), shared by the manual status check (connectionHealth) and the cron step
// subscription_check, so both classify a Meta answer identically and write the same record. The record is
// display only: no claim, wake query, final guard, ingestion or send decision reads it.

// One cron run checks at most this many connections, and a connection is attempted at most once per interval.
// One check is two Meta GETs. Both are service policy (operator decision, 2026-10-11).
export const SUBSCRIPTION_CHECKS_PER_RUN = 2;
export const SUBSCRIPTION_CHECK_INTERVAL_HOURS = 6;
export const REQUIRED_SUBSCRIPTION_FIELDS = ["comments", "messages", "messaging_postbacks"] as const;

// fields_present and fields_missing are definite results. token_rejected is a Meta rejection of the token
// (isMetaTokenRejection) on either call; account_mismatch is a token Meta accepted for another account.
// unverified covers timeouts, network errors, 5xx, rate limits, unknown shapes and a remaining next page.
// identityAccepted says Meta accepted the token for the stored account, which clears a token_rejected marker.
export type SubscriptionCheckStatus =
  "fields_present" | "fields_missing" | "token_rejected" | "account_mismatch" | "unverified" | "undecryptable";
export interface SubscriptionCheck {
  status: SubscriptionCheckStatus;
  identityAccepted: boolean;
}

type ProviderResult = { status: "ok"; value: unknown } | { status: "token_rejected" | "unverified" };

async function providerGet(fetchImpl: typeof fetch, url: string, token: string): Promise<ProviderResult> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // Only a 400 or 403 body is read; any other body is released unread.
      const code = await readMetaGraphErrorCode(response);
      if (response.status !== 400 && response.status !== 403) await response.body?.cancel();
      return { status: isMetaTokenRejection(response.status, code) ? "token_rejected" : "unverified" };
    }
    return { status: "ok", value: await response.json() };
  } catch {
    return { status: "unverified" };
  }
}

export function validGraphVersion(graphVersion: string | undefined): graphVersion is string {
  return typeof graphVersion === "string" && /^v\d+\.\d+$/.test(graphVersion);
}

// Decrypts the stored token and reads me?fields=user_id, then the account's subscribed_apps. The second call is
// made only after Meta accepted the token for the stored account.
export async function checkInstagramSubscription(
  connection: { workspaceId: string; accountId: string; encryptedToken: string },
  key: string,
  graphVersion: string,
  fetchImpl: typeof fetch,
): Promise<SubscriptionCheck> {
  let token: string;
  try {
    token = openSecret(connection.encryptedToken, key, `${connection.workspaceId}:${connection.accountId}`);
  } catch {
    return { status: "undecryptable", identityAccepted: false };
  }
  const base = `https://graph.instagram.com/${graphVersion}`;
  const identity = await providerGet(fetchImpl, `${base}/me?fields=user_id`, token);
  if (identity.status !== "ok") return { status: identity.status, identityAccepted: false };
  const account =
    isRecord(identity.value) && Array.isArray(identity.value.data) ? identity.value.data[0] : identity.value;
  if (!isRecord(account) || typeof account.user_id !== "string")
    return { status: "unverified", identityAccepted: false };
  if (account.user_id !== connection.accountId) return { status: "account_mismatch", identityAccepted: false };
  const subscription = await providerGet(
    fetchImpl,
    `${base}/${encodeURIComponent(connection.accountId)}/subscribed_apps`,
    token,
  );
  if (subscription.status !== "ok") return { status: subscription.status, identityAccepted: true };
  return { status: classifySubscribedApps(subscription.value), identityAccepted: true };
}

// The subscribed_apps answer: present when one entry holds every required field, missing when none does and
// there is no next page, unverified for any other shape.
export function classifySubscribedApps(value: unknown): "fields_present" | "fields_missing" | "unverified" {
  if (!isRecord(value) || !Array.isArray(value.data)) return "unverified";
  const entries: unknown[] = value.data;
  if (entries.some((entry) => !isRecord(entry) || !Array.isArray(entry.subscribed_fields))) return "unverified";
  if (
    entries.some((entry) => {
      if (!isRecord(entry)) return false;
      const fields = entry.subscribed_fields;
      return Array.isArray(fields) && REQUIRED_SUBSCRIPTION_FIELDS.every((field) => fields.includes(field));
    })
  )
    return "fields_present";
  if (isRecord(value.paging) && value.paging.next) return "unverified";
  return "fields_missing";
}

// Writes a definite result for the token the check used: missing keeps the first recorded time of the same
// token, present clears it. Returns whether the loss was newly recorded or cleared, or null when the token was
// replaced meanwhile and nothing changed. One timestamp parameter is used for every column, so a newly set
// subscription_missing_at equals subscription_checked_at.
async function writeResult(
  pool: Pick<Pool, "query">,
  connectionId: string,
  encryptedToken: string,
  missing: boolean,
): Promise<{ lost: boolean; restored: boolean } | null> {
  const written = await pool.query<{ was_missing: boolean; is_missing: boolean }>(
    `UPDATE instagram_connections c SET subscription_checked_at=now_.at,
       subscription_missing_at=CASE WHEN NOT $3::boolean THEN NULL WHEN previous.was_missing
         THEN c.subscription_missing_at ELSE now_.at END,
       subscription_token_obtained_at=c.token_obtained_at
     FROM (SELECT clock_timestamp() AS at) now_,
       (SELECT id,coalesce(subscription_missing_at IS NOT NULL AND subscription_token_obtained_at=token_obtained_at,false)
          AS was_missing
        FROM instagram_connections WHERE id=$1 AND access_token_encrypted=$2 FOR UPDATE) previous
     WHERE c.id=previous.id AND c.access_token_encrypted=$2
     RETURNING previous.was_missing,c.subscription_missing_at IS NOT NULL AS is_missing`,
    [connectionId, encryptedToken, missing],
  );
  const row = written.rows[0];
  if (!row) return null;
  return { lost: row.is_missing && !row.was_missing, restored: row.was_missing && !row.is_missing };
}

// Records one check. Every write compares the ciphertext the check used, so a result for a replaced token changes
// nothing. A Meta rejection records the reconnect marker and leaves the subscription columns; an identity Meta
// accepted for the stored account clears a token_rejected marker, as a successful pre-send account check does,
// but keeps refresh_rejected, which only a stored refresh, a reconnect or a disconnect clears. Transient and
// other results change no subscription column. Write failures are logged with fixed codes and never thrown;
// the return value says whether every subscription write succeeded (reconnect marker writes are not counted, as
// in token_refresh).
export async function recordSubscriptionCheck(
  pool: Pick<Pool, "query">,
  connectionId: string,
  encryptedToken: string,
  check: SubscriptionCheck,
  correlationId?: string,
): Promise<boolean> {
  try {
    if (check.status === "token_rejected")
      await markReauthRequired(pool, connectionId, encryptedToken, "token_rejected");
    else if (check.identityAccepted) await clearReauthRequired(pool, connectionId, encryptedToken, "token_rejected");
  } catch (error) {
    logOperation({
      event: "reauth_record_failed",
      code: failureCode(error),
      correlation_id: correlationId,
      connection_id: connectionId,
    });
  }
  if (check.status !== "fields_present" && check.status !== "fields_missing") return true;
  try {
    const changed = await writeResult(pool, connectionId, encryptedToken, check.status === "fields_missing");
    if (changed?.lost)
      logOperation(
        {
          event: "instagram_subscription_check",
          code: "subscription_lost",
          correlation_id: correlationId,
          connection_id: connectionId,
        },
        "warn",
      );
    if (changed?.restored)
      logOperation(
        {
          event: "instagram_subscription_check",
          code: "subscription_restored",
          correlation_id: correlationId,
          connection_id: connectionId,
        },
        "info",
      );
    return true;
  } catch (error) {
    logOperation({
      event: "subscription_record_failed",
      code: failureCode(error),
      correlation_id: correlationId,
      connection_id: connectionId,
    });
    return false;
  }
}

// The manual check's attempt time, for scheduling only: the cron then waits a full interval for this token.
export async function recordSubscriptionAttempt(
  pool: Pick<Pool, "query">,
  connectionId: string,
  encryptedToken: string,
  correlationId?: string,
): Promise<boolean> {
  try {
    await pool.query(
      "UPDATE instagram_connections SET subscription_check_attempted_at=clock_timestamp() WHERE id=$1 AND access_token_encrypted=$2",
      [connectionId, encryptedToken],
    );
    return true;
  } catch (error) {
    logOperation({
      event: "subscription_record_failed",
      code: failureCode(error),
      correlation_id: correlationId,
      connection_id: connectionId,
    });
    return false;
  }
}

interface DueConnection {
  id: string;
  workspace_id: string;
  account_id: string;
  access_token_encrypted: string;
}

// The cron step subscription_check. Each claim sets subscription_check_attempted_at, so a persistent transient
// failure is retried after the interval, not every run. A token that does not decrypt or a failed record write
// counts as a failure and fails the step after every claimed connection was checked, as in token_refresh;
// transient Meta results, a rejection and an account mismatch do not.
export async function checkDueInstagramSubscriptions(
  pool: Pool,
  key: string | undefined,
  fetchImpl: typeof fetch,
  now: Date,
  graphVersion: string | undefined,
  correlationId?: string,
): Promise<{ checked: number; failed: number }> {
  if (!key) throw new ConfigurationError("Token encryption not configured");
  if (!validGraphVersion(graphVersion)) throw new ConfigurationError("Graph API version not configured");
  try {
    sealSecret("key-check", key, "config-check");
  } catch {
    throw new ConfigurationError("Token encryption not configured");
  }
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid check time");
  let checked = 0;
  let failed = 0;
  for (let count = 0; count < SUBSCRIPTION_CHECKS_PER_RUN; count++) {
    const claimed = await pool.query<DueConnection>(
      `UPDATE instagram_connections SET subscription_check_attempted_at=$1
       WHERE id=(SELECT id FROM instagram_connections
         WHERE active AND access_token_encrypted IS NOT NULL AND token_expires_at>$1 AND deauthorized_at IS NULL
           AND (subscription_check_attempted_at IS NULL
             OR subscription_check_attempted_at<=$1::timestamptz-make_interval(hours=>$2))
         ORDER BY subscription_check_attempted_at NULLS FIRST,id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id,workspace_id,account_id,access_token_encrypted`,
      [now, SUBSCRIPTION_CHECK_INTERVAL_HOURS],
    );
    const connection = claimed.rows[0];
    if (!connection) break;
    checked++;
    const check = await checkInstagramSubscription(
      {
        workspaceId: connection.workspace_id,
        accountId: connection.account_id,
        encryptedToken: connection.access_token_encrypted,
      },
      key,
      graphVersion,
      fetchImpl,
    );
    if (check.status === "undecryptable") failed++;
    if (!(await recordSubscriptionCheck(pool, connection.id, connection.access_token_encrypted, check, correlationId)))
      failed++;
  }
  return { checked, failed };
}
