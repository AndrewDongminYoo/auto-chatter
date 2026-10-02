import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

interface Delivery {
  status: string;
  attempt_count: number;
  last_status_code: number | null;
  failure_code: string | null;
  created_at: string;
  sent_at: string | null;
}
interface WebhookLabels {
  webhookStatusLabel(status: string): string;
  webhookFailureLabel(code: string | null): string;
  webhookAttemptSummary(delivery: Delivery): string;
  webhookDeliveryTimes(delivery: Delivery, formatTime: (value: string) => string): string;
  webhookKeyState(keys: unknown[]): string;
}

// public/app/webhook-labels.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/webhook-labels.js", import.meta.url), "utf8"), context);
const labels = context as unknown as WebhookLabels;

const delivery = (fields: Partial<Delivery>): Delivery => ({
  status: "pending",
  attempt_count: 0,
  last_status_code: null,
  failure_code: null,
  created_at: "2026-10-02T01:00:00.000Z",
  sent_at: null,
  ...fields,
});

test("every stored delivery status and failure code has a Korean label", () => {
  for (const status of ["pending", "sending", "sent", "retry", "dead"])
    assert.doesNotMatch(labels.webhookStatusLabel(status), /[a-z_]/);
  const codes = [
    "endpoint_inactive",
    "url_refused",
    "signing_unavailable",
    "dns_failed",
    "dns_no_address",
    "address_refused",
    "timeout",
    "redirect_refused",
    "http_error",
    "request_failed",
    "worker_interrupted",
  ];
  for (const code of codes) assert.doesNotMatch(labels.webhookFailureLabel(code), /[a-z_]/, code);
  // The delivery module stores the `code` of a failed attempt and the SQL failure_code literals.
  const source = readFileSync(new URL("./webhook-delivery.ts", import.meta.url), "utf8");
  const stored = new Set([
    ...[...source.matchAll(/sent: false, code: ([^}]*)/g)].flatMap((line) =>
      [...line[1]!.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]),
    ),
    ...[...source.matchAll(/failure_code='([a-z_]+)'/g)].map((match) => match[1]),
  ]);
  assert.deepEqual([...stored].sort(), [...codes].sort());
});

test("unknown values fall back without hiding the code", () => {
  assert.equal(labels.webhookStatusLabel("archived"), "알 수 없는 상태");
  assert.equal(labels.webhookFailureLabel("new_code"), "기타 실패(new_code)");
  assert.equal(labels.webhookFailureLabel(null), "");
});

test("attempt summary shows the count, the last HTTP status and the reason", () => {
  assert.equal(labels.webhookAttemptSummary(delivery({})), "아직 시도하지 않았습니다");
  assert.equal(
    labels.webhookAttemptSummary(delivery({ attempt_count: 6, last_status_code: 503, failure_code: "http_error" })),
    "시도 6회 · 마지막 HTTP 상태 503 · 실패 사유: 수신 서버가 오류로 응답",
  );
  assert.equal(
    labels.webhookAttemptSummary(delivery({ attempt_count: 1, last_status_code: 204 })),
    "시도 1회 · 마지막 HTTP 상태 204",
  );
  // An inactive endpoint ends the delivery without an attempt.
  assert.equal(
    labels.webhookAttemptSummary(delivery({ failure_code: "endpoint_inactive" })),
    "시도 0회 · HTTP 응답 없음 · 실패 사유: 주소가 꺼져 있어 보내지 않음",
  );
});

test("delivery times use the given formatter", () => {
  const format = (value: string) => `<${value}>`;
  assert.equal(
    labels.webhookDeliveryTimes(delivery({}), format),
    "생성 <2026-10-02T01:00:00.000Z> · 아직 전송하지 않음",
  );
  assert.equal(
    labels.webhookDeliveryTimes(delivery({ sent_at: "2026-10-02T01:01:00.000Z" }), format),
    "생성 <2026-10-02T01:00:00.000Z> · 전송 <2026-10-02T01:01:00.000Z>",
  );
  // A dead row never gets sent_at, and it is not going to be sent later either.
  assert.equal(
    labels.webhookDeliveryTimes(delivery({ status: "dead" }), format),
    "생성 <2026-10-02T01:00:00.000Z> · 보내지 못함",
  );
});

test("key state marks a rotation in progress", () => {
  assert.equal(labels.webhookKeyState([]), "유효한 키 없음");
  assert.equal(labels.webhookKeyState([{}]), "키 1개");
  assert.equal(labels.webhookKeyState([{}, {}]), "키 교체 중");
});
