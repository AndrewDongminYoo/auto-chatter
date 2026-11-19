import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");

// Runs one top-level declaration of public/app/app.js in a context holding `globals` and returns what `expose` reads.
function declaration(start: string, end: string, expose: string, globals: Record<string, unknown> = {}): unknown {
  const begin = source.indexOf(start);
  assert.ok(begin >= 0, `${start} is declared`);
  const context = vm.createContext({ ...globals });
  vm.runInContext(`${source.slice(begin, source.indexOf(end, begin) + end.length)}\nexposed = ${expose};`, context);
  return (context as { exposed: unknown }).exposed;
}

test("the comment-rule archive error codes have Korean dashboard labels", () => {
  const errors = declaration("const errors = {", "\n};", "errors") as Record<string, string>;
  for (const code of ["media_not_found", "rule_archived", "rule_not_found"]) {
    assert.equal(typeof errors[code], "string", `${code} has a label`);
    assert.match(errors[code]!, /[가-힣]/, `${code} is Korean`);
  }
  // A new rule saved on a deleted post also gets media_not_found, so the general label must not ask to archive a rule.
  assert.doesNotMatch(errors.media_not_found!, /보관|규칙/);
});

test("a rule card shows a deleted post only for media_not_found", () => {
  const failure = declaration("function ruleMediaFailure(", "\n}", "ruleMediaFailure") as (code: unknown) => [string, string];
  assert.equal(failure("media_not_found")[0], "게시물이 삭제되었거나 볼 수 없습니다");
  assert.match(failure("media_not_found")[1], /보관/);
  for (const code of ["media_unavailable", "media_not_owned", "media_reconnect_required", undefined]) {
    assert.equal(failure(code)[0], "게시물 정보를 확인할 수 없습니다", String(code));
  }
});

test("an archive in progress locks the rule editor and every rule card like a save", () => {
  const control = () => ({ disabled: false, hasAttribute: () => false });
  const cards = [control(), control()];
  const elements: Record<string, { disabled: boolean } | { querySelectorAll: () => typeof cards }> = {
    "save-rule": control(),
    "rule-fields": control(),
    "new-rule": control(),
    "rule-preview-toggle": control(),
    rules: { querySelectorAll: () => cards },
  };
  // archivingRule holds the running request's token, or undefined when none runs.
  for (const [archivingRule, locked] of [
    [{}, true],
    [undefined, false],
  ] as const) {
    const ruleControls = declaration("function ruleControls(", "\n}", "ruleControls", { byId: (id: string) => elements[id], connections: [{}], archivingRule }) as () => void;
    ruleControls();
    for (const id of ["save-rule", "rule-fields", "new-rule", "rule-preview-toggle"]) assert.equal((elements[id] as { disabled: boolean }).disabled, locked, id);
    for (const card of cards) assert.equal(card.disabled, locked, "rule card button");
  }
});

test("only owners and admins get the archive button, matching the server's admin role", () => {
  const archive = source.indexOf('node("button", "보관", "secondary danger")');
  assert.ok(archive >= 0, "the rule card has an archive button");
  const gate = source.lastIndexOf('if (currentRole === "owner" || currentRole === "admin") {', archive);
  assert.ok(gate >= 0 && archive - gate < 200, "the archive button is created inside the owner/admin check");
});

test("a session change unlocks the rules, and an archive only clears its own lock and removes the current card", () => {
  const reset = source.slice(source.indexOf("function resetSession("), source.indexOf("\n}", source.indexOf("function resetSession(")));
  assert.match(reset, /archivingRule = undefined;/, "resetSession clears the archive lock");
  const handler = source.slice(source.indexOf("const archiveToken = {};"), source.indexOf("await loadWorkspace();", source.indexOf("const archiveToken = {};")));
  assert.match(handler, /if \(archivingRule === archiveToken\) \{\s*archivingRule = undefined;\s*ruleControls\(\);/, "the request re-runs ruleControls when it clears its own lock");
  assert.match(handler, /card\.dataset\.ruleId === rule\.id\) card\.remove\(\)/, "the card is found by rule ID in the current list");
  assert.doesNotMatch(handler, /item\.remove\(\)/);
});
