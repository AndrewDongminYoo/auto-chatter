import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

interface SendStatusLabels {
  sendStatusLabel(status: string): string;
  sendStatusEntries(statuses: string[]): [string, string][];
}

// public/app/send-status-labels.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/send-status-labels.js", import.meta.url), "utf8"), context);
const labels = context as unknown as SendStatusLabels;
const read = (name: string) => readFileSync(new URL(`../../public/app/${name}`, import.meta.url), "utf8");
const consumers = ["manual-reply-reports.js", "flow-run-reports.js", "campaign-run-reports.js", "inbox.js", "campaign-drafts.js", "app.js"];

test("every shared provider send status has one Korean label", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(labels.sendStatusEntries(["pending", "sending", "sent", "failed", "blocked", "unknown", "cancelled"]))), [
    ["pending", "발송 대기"],
    ["sending", "발송 처리 중"],
    ["sent", "Meta 접수"],
    ["failed", "발송 실패"],
    ["blocked", "정책 차단"],
    ["unknown", "결과 확인 필요"],
    ["cancelled", "취소"],
  ]);
});

test("an unlisted status falls back to one generic label", () => {
  assert.equal(labels.sendStatusLabel("archived"), "알 수 없는 상태");
  assert.equal(labels.sendStatusLabel("toString"), "알 수 없는 상태");
});

test("the dashboard loads the label script before every script that uses it", () => {
  const html = read("index.html");
  const position = (name: string) => html.indexOf(`<script src="./${name}" defer></script>`);
  assert.ok(position("send-status-labels.js") > 0, "send-status-labels.js is not loaded with defer");
  for (const name of consumers) {
    assert.ok(position(name) > position("send-status-labels.js"), `${name} loads before the labels`);
    assert.match(read(name), /sendStatus(Label|Labels|Entries)\b/, `${name} does not use the shared labels`);
  }
});

test("no screen keeps an older name for a shared send status", () => {
  for (const name of consumers) assert.doesNotMatch(read(name), /"(발송 완료|보냄|보내는 중|결과 불명|결과 불명확|결과 미확인|확인 필요|발송 거부|발송 거절)"/, name);
  // Explanatory hints use the same names as the counts they explain.
  const html = read("index.html");
  assert.doesNotMatch(html, /‘보냄’|보냄은|결과\s+불명|발송\s+완료/);
});

test("the reply composer describes sending unless a send time is set", () => {
  const html = read("index.html");
  const inbox = read("inbox.js");
  assert.match(html, /<p id="inbox-reply-help" class="hint">Enter로 줄바꿈 · Ctrl\/⌘ \+ Enter로 보내기<\/p>/);
  assert.match(inbox, /Ctrl\/⌘ \+ Enter로 \$\{state\.scheduleEnabled \? "예약" : "보내기"\}/);
  assert.doesNotMatch(inbox, /답장을 예약하세요|발송 완료는 이력에서/);
  // The schedule flag is cleared before the notice is chosen, so the notice reads the submitted body instead.
  assert.match(inbox, /operation\.kind === "create" && !operation\.body\.schedule_local\s*\?\s*"보내기를 요청했습니다\. Meta 접수 여부는 이력에서 확인해 주세요\."/);
});
