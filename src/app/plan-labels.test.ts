import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { activeContactLimitReached, isPlanKey, PLANS, planLimits, type PlanKey } from "./plans.ts";

interface Entitlements {
  plan: string;
  limits: { seats: number; connections: number; campaign_sends_per_month: number; active_contacts_per_month?: number; user_records_per_workspace?: number };
  usage: {
    seats: number;
    connections: number;
    campaign_sends: number;
    active_contacts?: { time_zone: string; month: string; count: number; previous_month: string; previous_count: number };
    user_records?: { consent_events: number; inbox_notes: number };
  };
}
interface PlanLabels {
  planName(plan: string): string;
  planSeatsFull(entitlements: Entitlements | undefined): boolean;
  planConnectionsFull(entitlements: Entitlements | undefined): boolean;
  planSummary(entitlements: Entitlements | undefined): string;
  planCampaignUsage(entitlements: Entitlements): string;
  planSeatHelp(entitlements: Entitlements | undefined): string;
  planConnectionHelp(entitlements: Entitlements | undefined): string;
  planAcceptSeatRefusal(): string;
  planActiveContacts(entitlements: Entitlements | undefined): string;
  planActiveContactsHelp(entitlements: Entitlements | undefined): string;
  planActiveContactsOver(entitlements: Entitlements | undefined): boolean;
  planActiveContactsFull(entitlements: Entitlements | undefined): boolean;
  planActiveContactsApprovalHelp(entitlements: Entitlements | undefined): string;
  planUserRecords(entitlements: Entitlements | undefined): string;
}

// public/app/plan-labels.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/display-values.js", import.meta.url), "utf8"), context);
vm.runInContext(readFileSync(new URL("../../public/app/plan-labels.js", import.meta.url), "utf8"), context);
const labels = context as unknown as PlanLabels;

const entitlements = (plan: PlanKey, seats: number, connections: number, campaignSends = 0): Entitlements => ({
  plan,
  limits: { ...planLimits(plan) },
  usage: { seats, connections, campaign_sends: campaignSends },
});

test("the catalog holds the five plans with the agreed seat, connection, monthly campaign send, active contact and hourly API write limits", () => {
  assert.deepEqual(PLANS, {
    free: { seats: 1, connections: 1, campaign_sends_per_month: 0, active_contacts_per_month: 25, api_writes_per_hour: 500, user_records_per_workspace: 1000 },
    essential: { seats: 2, connections: 2, campaign_sends_per_month: 1000, active_contacts_per_month: 250, api_writes_per_hour: 1000, user_records_per_workspace: 10000 },
    pro: { seats: 3, connections: 3, campaign_sends_per_month: 5000, active_contacts_per_month: 2500, api_writes_per_hour: 1500, user_records_per_workspace: 50000 },
    business: { seats: 5, connections: 5, campaign_sends_per_month: 20000, active_contacts_per_month: 7500, api_writes_per_hour: 3000, user_records_per_workspace: 150000 },
    advanced: { seats: 10, connections: 10, campaign_sends_per_month: 50000, active_contacts_per_month: 25000, api_writes_per_hour: 6000, user_records_per_workspace: 500000 },
  });
  for (const key of Object.keys(PLANS)) assert.ok(isPlanKey(key), key);
  for (const value of ["gold", "", "toString", "__proto__", null, 1]) assert.equal(isPlanKey(value), false);
  assert.throws(() => planLimits("toString"), /Unknown workspace plan/);
});

test("the active contact limit stops every send over the limit and a new person's send at it", () => {
  const at = (count: number, counted: boolean, recipient = true) => activeContactLimitReached({ limit: 25, count, counted }, recipient);
  // Below the limit everyone is reached; at it, only people already counted this month; over it, nobody.
  assert.deepEqual([at(24, false), at(24, true)], [false, false]);
  assert.deepEqual([at(25, false), at(25, true)], [true, false]);
  assert.deepEqual([at(26, false), at(26, true)], [true, true]);
  // A check with no recipient (a campaign approval) stops only over the limit.
  assert.deepEqual([at(25, false, false), at(26, false, false)], [false, true]);
});

test("every plan has a Korean name, and the summary shows usage against the limits", () => {
  for (const key of Object.keys(PLANS)) assert.doesNotMatch(labels.planName(key), /[a-z]/, key);
  assert.equal(labels.planName("gold"), "알 수 없는 요금제(gold)");
  assert.equal(labels.planSummary(entitlements("pro", 2, 3, 1234)), "요금제: 프로 · 멤버 2/3명(대기 중인 초대 포함) · Instagram 계정 3/3개 · 이번 달 캠페인 발송 1,234/5,000건");
  // A plan without campaigns says so, with this month's rows when a downgrade left some.
  assert.equal(labels.planCampaignUsage(entitlements("free", 1, 1)), "캠페인 발송 불가");
  assert.equal(labels.planCampaignUsage(entitlements("free", 1, 1, 1500)), "캠페인 발송 불가(이번 달 1,500건 발송)");
  assert.equal(labels.planCampaignUsage(entitlements("essential", 1, 1, 1001)), "이번 달 캠페인 발송 1,001/1,000건", "a downgrade can leave the month over its limit");
  assert.equal(labels.planSummary(undefined), "");
});

test("the active contact line shows this month's count against the plan's allowance, with no price", () => {
  const withCount = (plan: PlanKey, count: number): Entitlements => ({
    ...entitlements(plan, 1, 1),
    usage: { seats: 1, connections: 1, campaign_sends: 0, active_contacts: { time_zone: "America/Los_Angeles", month: "2026-11", count, previous_month: "2026-10", previous_count: 0 } },
  });
  const counted = withCount("pro", 1234);
  assert.equal(labels.planActiveContacts(counted), "이번 달 활성 연락처 1,234/2,500명 · 지난 달 0명");
  assert.equal(labels.planActiveContactsHelp(counted), "메시지를 주고받은 사람을 달마다 한 번씩 셉니다. 달은 America/Los_Angeles 기준입니다.");
  assert.deepEqual([labels.planActiveContactsFull(counted), labels.planActiveContactsOver(counted), labels.planActiveContactsApprovalHelp(counted)], [false, false, ""]);
  // At the allowance only people not yet counted this month are refused; over it every send stops (the server rule).
  const full = withCount("free", 25);
  assert.equal(labels.planActiveContacts(full), "이번 달 활성 연락처 25/25명 · 지난 달 0명");
  assert.deepEqual([labels.planActiveContactsFull(full), labels.planActiveContactsOver(full), labels.planActiveContactsApprovalHelp(full)], [true, false, ""]);
  assert.match(labels.planActiveContactsHelp(full), /^이번 달 활성 연락처가 요금제에 포함된 25명에 도달했습니다\. .*새로운 사람에게는 보내지 않습니다\./);
  const over = withCount("free", 26);
  assert.deepEqual([labels.planActiveContactsFull(over), labels.planActiveContactsOver(over)], [false, true]);
  assert.match(labels.planActiveContactsHelp(over), /^이번 달 활성 연락처가 요금제에 포함된 25명을 넘어 자동 답장, 직접 답장, 캠페인 발송을 모두 멈췄습니다\. 받은 메시지 확인과 설정 변경은 그대로 할 수 있습니다\./);
  assert.match(labels.planActiveContactsApprovalHelp(over), /^이번 달 활성 연락처가 요금제 포함량을 넘어 실행 승인을 기록할 수 없습니다\./);
  // An older server without the allowance shows the counts alone and never reports a stop.
  const older = { ...counted, limits: { seats: 3, connections: 3, campaign_sends_per_month: 5000 } };
  assert.equal(labels.planActiveContacts(older), "이번 달 활성 연락처 1,234명 · 지난 달 0명");
  assert.equal(labels.planActiveContactsOver(older), false);
  // The plan line itself is unchanged, and a response without the counts shows no line.
  assert.equal(labels.planSummary(counted), "요금제: 프로 · 멤버 1/3명(대기 중인 초대 포함) · Instagram 계정 1/3개 · 이번 달 캠페인 발송 0/5,000건");
  assert.equal(labels.planActiveContacts(entitlements("pro", 1, 1)), "");
  assert.equal(labels.planActiveContactsHelp(entitlements("pro", 1, 1)), "");
  assert.equal(labels.planActiveContacts(undefined), "");
  const app = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  assert.match(app, /byId\("active-contact-summary"\)\.hidden = !planActiveContacts\(workspacePlan\);/);
  assert.match(app, /byId\("active-contact-help"\)\.hidden = !planActiveContactsHelp\(workspacePlan\);/);
  assert.match(app, /byId\("active-contact-help"\)\.className = planActiveContactsOver\(workspacePlan\) \? "flow-alert warning alert-detail" : "hint";/);
});

test("the limit help appears only when a limit is reached, including after a downgrade", () => {
  const below = entitlements("essential", 1, 1);
  assert.equal(labels.planSeatsFull(below), false);
  assert.equal(labels.planConnectionsFull(below), false);
  assert.equal(labels.planSeatHelp(below), "");
  assert.equal(labels.planConnectionHelp(below), "");
  const over = entitlements("free", 3, 2);
  assert.equal(labels.planSeatsFull(over), true);
  assert.equal(labels.planConnectionsFull(over), true);
  assert.match(labels.planSeatHelp(over), /멤버 자리 1개.*이미 초대한 이메일로는 새 링크를 만들 수 있습니다/);
  assert.match(labels.planConnectionHelp(over), /계정 1개.*재연결은 할 수 있지만/);
  assert.equal(labels.planSeatsFull(undefined), false);
});

test("the stored record line shows each kind's count against the plan's per-kind limit", () => {
  const withRecords = (plan: PlanKey, notes: number, events: number): Entitlements => ({
    ...entitlements(plan, 1, 1),
    usage: { seats: 1, connections: 1, campaign_sends: 0, user_records: { inbox_notes: notes, consent_events: events } },
  });
  assert.equal(labels.planUserRecords(withRecords("pro", 1234, 0)), "저장한 메모 1,234/50,000건 · 동의 기록 0/50,000건");
  assert.equal(labels.planUserRecords(withRecords("free", 1500, 1000)), "저장한 메모 1,500/1,000건 · 동의 기록 1,000/1,000건", "a downgrade can leave a count over the limit");
  // A response without the counts or the limit, from an older server, shows no line.
  assert.equal(labels.planUserRecords(entitlements("pro", 1, 1)), "");
  assert.equal(labels.planUserRecords({ ...withRecords("pro", 1, 1), limits: { seats: 3, connections: 3, campaign_sends_per_month: 5000 } }), "");
  assert.equal(labels.planUserRecords(undefined), "");
  const app = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  assert.match(app, /byId\("user-record-summary"\)\.hidden = !planUserRecords\(workspacePlan\);/);
  assert.match(readFileSync(new URL("../../public/app/index.html", import.meta.url), "utf8"), /<p id="user-record-summary" class="hint" hidden><\/p>/);
});

test("the dashboard explains every limit code, and the callback's limit code is shown on return", () => {
  const app = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  for (const code of ["seat_limit_reached", "connection_limit_reached", "broadcast_limit_reached", "user_record_limit_reached"]) assert.match(app, new RegExp(`^  ${code}:\\s*"[^"]*[가-힣][^"]*",$`, "m"), code);
  assert.match(app, /const instagramErrors = \[[^\]]*"connection_limit_reached"/);
});

test("a full workspace keeps the invite button for new links, and the invitee gets its own refusal", () => {
  const app = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  // The server lets an invited email get a new link at the seat limit, so only the open link locks the button.
  assert.match(app, /querySelector\("button\[type=submit\]"\)\.disabled = inviteLinkLocked\(\);/);
  assert.match(app, /error\.code === "seat_limit_reached" \? planAcceptSeatRefusal\(\) : errorMessage\(error\)/);
  const refusal = labels.planAcceptSeatRefusal();
  assert.match(refusal, /소유자에게/);
  assert.match(refusal, /초대 링크를 다시 열어/);
  assert.doesNotMatch(refusal, /취소하거나 멤버를 제거/);
});
