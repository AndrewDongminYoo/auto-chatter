import { ACTIVE_CONTACT_LIMIT, ACTIVE_CONTACT_LIMIT_UNAVAILABLE, activeContactLimitBlocks, type ActiveContactRecipient } from "../app/plans.ts";
import { PreSendVerificationError } from "./reply-worker.ts";

type Queryable = Parameters<typeof activeContactLimitBlocks>[0];

/**
 * The active contact limit check of a send's final guard (#52, docs/specs/2026-11-25-active-contact-limit-design.md).
 * Every send path calls it after the claim and before the provider POST. A stop is a block (`active_contact_limit`),
 * so the row ends and is never sent later, when the plan goes up or the month changes. A failed read defers the send
 * (`active_contact_limit_unavailable`); the send never goes out unchecked.
 *
 * @param db - Any client or pool.
 * @param workspace - The send's workspace.
 * @param connection - The send's connection.
 * @param recipient - The person the send's ledger trigger records.
 */
export async function assertActiveContactLimit(db: Queryable, workspace: string, connection: string, recipient: ActiveContactRecipient): Promise<void> {
  let blocked: boolean;
  try {
    blocked = await activeContactLimitBlocks(db, workspace, connection, recipient);
  } catch {
    throw new PreSendVerificationError("retry", ACTIVE_CONTACT_LIMIT_UNAVAILABLE);
  }
  if (blocked) throw new PreSendVerificationError("block", ACTIVE_CONTACT_LIMIT);
}
