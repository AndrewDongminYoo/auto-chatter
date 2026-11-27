import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

interface ApiKeyRow {
  created_by_email: string | null;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}
interface ApiKeyLabels {
  apiKeyStatus(key: ApiKeyRow, now: number): { label: string; tone: string };
  apiKeyLastUse(key: ApiKeyRow, formatTime: (value: string) => string): string;
  apiKeyDates(key: ApiKeyRow, formatTime: (value: string) => string): string;
}

// public/app/api-key-labels.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/display-values.js", import.meta.url), "utf8"), context);
vm.runInContext(readFileSync(new URL("../../public/app/api-key-labels.js", import.meta.url), "utf8"), context);
const labels = context as unknown as ApiKeyLabels;

const now = Date.parse("2026-11-27T00:00:00.000Z");
const day = 86_400_000;
const key = (fields: Partial<ApiKeyRow>): ApiKeyRow => ({
  created_by_email: "admin@example.test",
  created_at: "2026-11-01T00:00:00.000Z",
  expires_at: new Date(now + 30 * day).toISOString(),
  last_used_at: null,
  last_used_ip: null,
  revoked_at: null,
  revoked_reason: null,
  ...fields,
});
// The result is copied out of the vm realm so deepEqual compares plain objects.
const status = (row: ApiKeyRow) => ({ ...labels.apiKeyStatus(row, now) });

test("a key reads as in use, expiring within 7 days, expired, or revoked with its reason", () => {
  assert.deepEqual(status(key({})), { label: "사용 중", tone: "success" });
  assert.deepEqual(status(key({ expires_at: new Date(now + 7 * day + 1000).toISOString() })), { label: "사용 중", tone: "success" });
  assert.deepEqual(status(key({ expires_at: new Date(now + 7 * day).toISOString() })), { label: "만료 임박", tone: "warning" });
  assert.deepEqual(status(key({ expires_at: new Date(now).toISOString() })), { label: "만료됨", tone: "warning" });
  for (const reason of ["revoked", "member_removed", "member_demoted"]) {
    const state = status(key({ revoked_at: "2026-11-20T00:00:00.000Z", revoked_reason: reason }));
    assert.equal(state.tone, "warning");
    assert.match(state.label, /^폐기됨 · /);
    assert.doesNotMatch(state.label, /[a-z_]|알 수 없는/, reason);
  }
  // Revoked wins over expired.
  assert.match(status(key({ expires_at: new Date(now - day).toISOString(), revoked_at: "2026-11-20T00:00:00.000Z", revoked_reason: "revoked" })).label, /^폐기됨/);
});

test("the last use shows its time and IP, and the dates name the creator", () => {
  const time = (value: string) => `<${value}>`;
  assert.equal(labels.apiKeyLastUse(key({}), time), "아직 사용한 적 없음");
  assert.equal(labels.apiKeyLastUse(key({ last_used_at: "2026-11-26T00:00:00.000Z", last_used_ip: "203.0.113.9" }), time), "마지막 사용 <2026-11-26T00:00:00.000Z> · IP 203.0.113.9");
  assert.equal(labels.apiKeyDates(key({}), time), `만든 사람 admin@example.test · 발급 <2026-11-01T00:00:00.000Z> · 만료 <${new Date(now + 30 * day).toISOString()}>`);
  assert.match(labels.apiKeyDates(key({ created_by_email: null }), time), /^만든 사람 – · /);
});
