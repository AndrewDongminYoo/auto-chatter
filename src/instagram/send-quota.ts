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

// Campaign deliveries (#36) stop each connection at 1,000 provider calls per rolling hour. This is service policy,
// not a Meta limit: Meta documents 100 Send API calls per second for text messages per Instagram professional
// account and no hourly or app-wide messaging limit (https://developers.facebook.com/docs/instagram-platform/overview/,
// read 2026-10-29). At this rate a 5,000-member run (the snapshot freeze limit) finishes in about 5 hours, inside most
// recipients' 24-hour windows. It is separate from the private reply budget above, and the calls of deleted rows
// are not carried.
export const CAMPAIGN_HOURLY_BUDGET = 1000;

// An SQL condition that is true while the connection still has campaign budget: its campaign_deliveries rows with a
// provider send request in the last hour are fewer than the budget. connectionId is an SQL expression written by the
// caller (a column or a bind parameter), never request input.
export function campaignBudgetOpenSql(connectionId: string): string {
  return `(SELECT count(*) FROM campaign_deliveries called WHERE called.connection_id=${connectionId}
    AND called.provider_called_at>now()-interval '1 hour')<${CAMPAIGN_HOURLY_BUDGET}`;
}

// An SQL timestamp: the moment the connection's campaign budget last regained room, one hour after its
// CAMPAIGN_HOURLY_BUDGET-th most recent provider call, or NULL when it never made that many. While the budget is
// closed it lies in the future. connectionId is an SQL expression written by the caller, never request input.
export function campaignBudgetReopenedAtSql(connectionId: string): string {
  return `(SELECT reopened.provider_called_at+interval '1 hour' FROM campaign_deliveries reopened
    WHERE reopened.connection_id=${connectionId} AND reopened.provider_called_at IS NOT NULL
    ORDER BY reopened.provider_called_at DESC OFFSET ${CAMPAIGN_HOURLY_BUDGET - 1} LIMIT 1)`;
}
