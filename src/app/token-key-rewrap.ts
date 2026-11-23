import type { Pool } from "pg";
import { currentKeyPrefix, openSecret, sealSecret, type TokenKeys } from "./secrets.ts";
import { signingKeyContext } from "./webhook-delivery.ts";

// Seals the stored secrets again with the current token encryption key during a key rotation (#61): the
// Instagram access tokens of every connection that stores one (inactive ones too) and the valid webhook signing
// secrets. Only the Cloudflare cron step token_key_rewrap calls it, and only while TOKEN_ENCRYPTION_KEY_PREVIOUS
// is set; the runbook removes that key once no stored secret lacks the current key's prefix.
//
// Each write is conditional on the row's ciphertext still being the one that was opened, and it changes that
// column only. A concurrent token refresh, reconnect or key retirement therefore wins, and a rewrapped row looks to
// an in-flight send like a rotated token, which every send path retries before its POST. A secret that no ring
// key opens counts as failed and stays as it is; the scan reads past it by ID, so it does not hold up the rows
// after it within the run's page limit.

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

// A connection row carries its context; a signing key row carries the parts of signingKeyContext.
interface Sealed {
  id: string;
  sealed: string;
  context?: string;
  workspace_id?: string;
  endpoint_id?: string;
}

interface Target {
  select: string;
  update: string;
}

const TARGETS: readonly Target[] = [
  {
    select: `SELECT id::text,access_token_encrypted AS sealed,workspace_id::text||':'||account_id AS context
      FROM instagram_connections
      WHERE access_token_encrypted IS NOT NULL AND NOT starts_with(access_token_encrypted,$1)
        AND ($2::uuid IS NULL OR id>$2::uuid)
      ORDER BY id LIMIT ${PAGE_SIZE}`,
    update: `UPDATE instagram_connections c SET access_token_encrypted=u.sealed
      FROM unnest($1::uuid[],$2::text[],$3::text[]) AS u(id,old,sealed)
      WHERE c.id=u.id AND c.access_token_encrypted=u.old`,
  },
  {
    select: `SELECT id::text,secret_encrypted AS sealed,workspace_id::text AS workspace_id,endpoint_id::text AS endpoint_id
      FROM webhook_signing_keys
      WHERE retired_at IS NULL AND secret_encrypted IS NOT NULL AND NOT starts_with(secret_encrypted,$1)
        AND ($2::uuid IS NULL OR id>$2::uuid)
      ORDER BY id LIMIT ${PAGE_SIZE}`,
    update: `UPDATE webhook_signing_keys k SET secret_encrypted=u.sealed
      FROM unnest($1::uuid[],$2::text[],$3::text[]) AS u(id,old,sealed)
      WHERE k.id=u.id AND k.retired_at IS NULL AND k.secret_encrypted=u.old`,
  },
];

function context(row: Sealed): string {
  return row.context ?? signingKeyContext(row.workspace_id!, row.endpoint_id!, row.id);
}

// Returns how many secrets were sealed again and how many could not be opened. It runs no query without a
// previous key or with a previous key equal to the current one, so registering the current key as the previous key
// changes no ciphertext. Each run starts again from the lowest ID, so more than PAGE_SIZE * MAX_PAGES unreadable
// rows in one table would keep the rows after them unread.
export async function rewrapSealedSecrets(pool: Pick<Pool, "query">, keys: TokenKeys): Promise<{ rewrapped: number; failed: number }> {
  if (!keys.previous || keys.previous === keys.current) return { rewrapped: 0, failed: 0 };
  const prefix = currentKeyPrefix(keys);
  let rewrapped = 0;
  let failed = 0;
  for (const target of TARGETS) {
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows: Sealed[] = (await pool.query<Sealed>(target.select, [prefix, after])).rows;
      const ids: string[] = [];
      const old: string[] = [];
      const next: string[] = [];
      for (const row of rows) {
        let value: string;
        try {
          value = openSecret(row.sealed, keys, context(row));
        } catch {
          failed++;
          continue;
        }
        ids.push(row.id);
        old.push(row.sealed);
        next.push(sealSecret(value, keys, context(row)));
      }
      if (ids.length) rewrapped += (await pool.query(target.update, [ids, old, next])).rowCount ?? 0;
      if (rows.length < PAGE_SIZE) break;
      after = rows[rows.length - 1]!.id;
    }
  }
  return { rewrapped, failed };
}
