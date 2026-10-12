import assert from "node:assert/strict";
import { test } from "node:test";
import { PRIVATE_REPLY_HOURLY_BUDGET, privateReplyBudgetOpenSql } from "./send-quota.ts";

test("the private reply budget stays under Meta's 750 calls per hour with a margin", () => {
  assert.equal(PRIVATE_REPLY_HOURLY_BUDGET, 700);
  assert.ok(PRIVATE_REPLY_HOURLY_BUDGET < 750);
});

test("the budget condition counts the given connection's provider calls of the last hour", () => {
  const sql = privateReplyBudgetOpenSql("c.id");
  assert.match(sql, /called\.connection_id=c\.id/);
  assert.match(sql, /called\.provider_called_at>now\(\)-interval '1 hour'/);
  assert.match(sql, /\)<700$/);
});

test("the budget condition adds the connection's carried calls only while the carry is in force", () => {
  const sql = privateReplyBudgetOpenSql("c.id");
  assert.match(sql, /\+coalesce\(\(SELECT carry\.private_reply_carried_calls FROM instagram_connections carry/);
  assert.match(sql, /carry\.id=c\.id AND carry\.private_reply_carried_until>now\(\)\),0\)\)<700$/);
});
