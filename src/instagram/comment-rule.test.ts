import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesCommentRule, normalizeMatchText } from "./comment-rule.ts";

test("legacy rules retain case-insensitive substring matching", () => {
  assert.equal(matchesCommentRule("Send LINK please", { keyword: "link" }), true);
  assert.equal(matchesCommentRule("hello", { keyword: "link" }), false);
});

test("multiple keywords match by OR with Unicode and whitespace normalization", () => {
  const rule = { keyword: "legacy", keywords: [" 자료 ", "CAFÉ"] };
  assert.equal(matchesCommentRule("자료 주세요", rule), true);
  assert.equal(matchesCommentRule("  cafe\u0301  ", rule), true);
  assert.equal(matchesCommentRule("legacy", rule), false);
});

test("exact mode requires the entire normalized comment", () => {
  const rule = { keyword: "link", match_mode: "exact" as const };
  assert.equal(matchesCommentRule(" LINK ", rule), true);
  assert.equal(matchesCommentRule("send link", rule), false);
});

test("excluded keywords take precedence in every matching mode", () => {
  for (const match_mode of ["contains", "exact", "all"] as const) {
    const rule = { keyword: "no link", match_mode, excluded_keywords: [" NO "] };
    assert.equal(matchesCommentRule("no link", rule), false);
  }
  assert.equal(matchesCommentRule("hello", { keyword: "unused", match_mode: "all" }), true);
});

test("empty include keywords never turn a keyword rule into a catch-all", () => {
  assert.equal(matchesCommentRule("hello", { keyword: " " }), false);
  assert.equal(matchesCommentRule("hello", { keyword: "hello", keywords: [""] }), false);
  assert.equal(matchesCommentRule("HELLO", { keyword: "hello", keywords: [] }), true);
});

test("the shared normalization is NFC, trimmed and lower case", () => {
  assert.equal(normalizeMatchText("  CAFE\u0301 \n"), "caf\u00e9");
  assert.equal(normalizeMatchText("\u3000환불\t"), "환불");
});
