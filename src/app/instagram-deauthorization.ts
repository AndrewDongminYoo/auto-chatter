// The Instagram deauthorize callback (#16). Meta calls it when an account owner removes the app in Instagram,
// with one form field, signed_request = <base64url HMAC-SHA256 signature>.<base64url JSON payload>, signed with
// the app secret. A verified callback disconnects every matching connection exactly like the settings screen.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { isRecord } from "./auth.ts";
import { disconnectInTransaction } from "./settings.ts";

// A signed request is a few hundred bytes; anything larger is not one.
export const DEAUTHORIZE_BODY_LIMIT = 8 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

// Buffer.from skips characters outside the alphabet, so the alphabet is checked first.
function decodeBase64Url(value: string): Buffer | null {
  return BASE64URL.test(value) ? Buffer.from(value, "base64url") : null;
}

// An Instagram user ID as a digit string, from a digit string or a JSON number only while it is a safe integer:
// a larger number was already rounded by the parser. The OAuth exchange stores instagram_user_id with this too,
// so the callback compares the same form.
export function normalizedUserId(value: unknown): string | null {
  if (typeof value === "string") return /^\d{1,64}$/.test(value) ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

export interface DeauthorizeRequest {
  userId: string;
  // Seconds since the epoch, or null when the payload has no issued_at.
  issuedAt: number | null;
}

// Returns the user ID and issue time of a signed request that the app secret verifies, or null.
export function verifySignedRequest(signedRequest: string, appSecret: string): DeauthorizeRequest | null {
  if (!appSecret) return null;
  const dot = signedRequest.indexOf(".");
  if (dot < 0) return null;
  const encodedPayload = signedRequest.slice(dot + 1);
  const signature = decodeBase64Url(signedRequest.slice(0, dot));
  const payload = decodeBase64Url(encodedPayload);
  // timingSafeEqual throws on a length mismatch, so the length is checked first.
  if (!signature || signature.length !== 32 || !payload) return null;
  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  if (!timingSafeEqual(signature, expected)) return null;
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.algorithm !== "string" || data.algorithm.toUpperCase() !== "HMAC-SHA256")
    return null;
  const userId = normalizedUserId(data.user_id);
  if (userId === null) return null;
  // Meta does not document the Instagram Login payload, so an absent issued_at is accepted; a present one must
  // be whole seconds since the epoch.
  if (data.issued_at === undefined) return { userId, issuedAt: null };
  const issuedAt = data.issued_at;
  if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) return null;
  return { userId, issuedAt };
}

// Returns the verified request of a callback body, or null for anything else.
export function parseDeauthorizeBody(body: Uint8Array, appSecret: string): DeauthorizeRequest | null {
  if (body.byteLength > DEAUTHORIZE_BODY_LIMIT) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  const values = new URLSearchParams(text).getAll("signed_request");
  return values.length === 1 ? verifySignedRequest(values[0]!, appSecret) : null;
}

// Meta does not document which ID the Instagram Login callback carries, so both the account ID and the
// app-scoped user ID from the OAuth exchange are compared. Each match is disconnected in its own transaction,
// in ID order, and records deauthorized_at even when it was already disconnected. A match whose stored token
// was obtained in a later second than issued_at is skipped, so a delayed or replayed request cannot undo a
// reconnect; so is one that left its workspace after the lookup.
export async function deauthorizeInstagramUser(
  pool: Pool,
  { userId, issuedAt }: DeauthorizeRequest,
): Promise<{ disconnected: string[]; skipped: string[] }> {
  const matched = await pool.query<{ id: string; workspace_id: string }>(
    "SELECT id,workspace_id FROM instagram_connections WHERE account_id=$1 OR instagram_user_id=$1 ORDER BY id",
    [userId],
  );
  const disconnected: string[] = [];
  const skipped: string[] = [];
  for (const { id, workspace_id } of matched.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A skipped connection keeps its flows, so their changes are undone.
      const done = await disconnectInTransaction(client, id, workspace_id, { issuedAt });
      await client.query(done ? "COMMIT" : "ROLLBACK");
      (done ? disconnected : skipped).push(id);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return { disconnected, skipped };
}
