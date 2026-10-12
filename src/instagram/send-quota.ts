// Meta allows 750 private replies to post and reel comments per hour per Instagram professional account
// (https://developers.facebook.com/docs/instagram-platform/overview/, read 2026-10-12). The service stops each
// connection at 700 per rolling hour to keep a margin; docs/specs/2026-10-12-send-quotas.md owns the reasoning.
export const PRIVATE_REPLY_HOURLY_BUDGET = 700;

// An SQL condition that is true while the connection still has private reply budget: the rows of it that had a
// provider send request in the last hour, plus the calls of deleted rows carried on the connection while that
// carry is in force (#189), are fewer than the budget. connectionId is an SQL expression written by the caller
// (a column or a bind parameter), never request input. Pass an expression that does not depend on the outbox
// row being filtered, so PostgreSQL counts once per connection.
export function privateReplyBudgetOpenSql(connectionId: string): string {
  return `((SELECT count(*) FROM private_reply_outbox called WHERE called.connection_id=${connectionId}
    AND called.provider_called_at>now()-interval '1 hour')
    +coalesce((SELECT carry.private_reply_carried_calls FROM instagram_connections carry
      WHERE carry.id=${connectionId} AND carry.private_reply_carried_until>now()),0))<${PRIVATE_REPLY_HOURLY_BUDGET}`;
}
