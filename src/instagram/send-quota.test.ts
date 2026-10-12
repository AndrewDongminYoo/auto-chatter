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
