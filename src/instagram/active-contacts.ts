import type { PoolClient } from "pg";
import { logOperation } from "../app/operations-log.ts";

/**
 * Runs one write of the billing-month active contact ledger (#51) inside a savepoint of the caller's transaction.
 * The caller runs it as the last statement before COMMIT, so the transaction holds an uncommitted ledger key only
 * while it waits on nothing else; a wait for another ledger key therefore cannot close a lock cycle. A failure rolls
 * back to the savepoint and is logged with the fixed code, and the caller still commits its source write.
 *
 * The write waits at most `lock_timeout` (2 s) for another transaction's uncommitted key of the same person and month.
 * The bound is set on the server, because a client query timeout does not cancel the server statement, and a client
 * timeout here would also cut the ROLLBACK TO and with it the source write. `SET LOCAL` inside the savepoint is undone
 * by ROLLBACK TO; after RELEASE it lasts until the end of the transaction, where only COMMIT follows this write
 * (both callers, ingestComments and ingestMessages, call this last).
 *
 * @param client - The caller's client, inside its open transaction.
 * @param code - The fixed log code for a failure.
 * @param sql - One statement that calls `public.record_active_contacts`.
 * @param values - The statement's parameters.
 */
export async function recordActiveContacts(client: PoolClient, code: string, sql: string, values: readonly unknown[]): Promise<void> {
  await client.query("SAVEPOINT active_contacts");
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query(sql, [...values]);
    await client.query("RELEASE SAVEPOINT active_contacts");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT active_contacts");
    logOperation({ event: "active_contact_ledger_failed", code }, "warn");
  }
}
