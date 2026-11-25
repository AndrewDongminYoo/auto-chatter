import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { activeContactLimitReached, isPlanKey, PLANS, planLimits, type PlanKey } from "./plans.ts";

interface Entitlements {
  plan: string;
  limits: { seats: number; connections: number; campaign_sends_per_month: number };
  usage: { seats: number; connections: number; campaign_sends: number; active_contacts?: { time_zone: string; month: string; count: number; previous_month: string; previous_count: number } };
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

test("the catalog holds the five plans with the agreed seat, connection, monthly campaign send and active contact limits", () => {
  assert.deepEqual(PLANS, {
    free: { seats: 1, connections: 1, campaign_sends_per_month: 0, active_contacts_per_month: 25 },
    essential: { seats: 2, connections: 2, campaign_sends_per_month: 1000, active_contacts_per_month: 250 },
    pro: { seats: 3, connections: 3, campaign_sends_per_month: 5000, active_contacts_per_month: 2500 },
    business: { seats: 5, connections: 5, campaign_sends_per_month: 20000, active_contacts_per_month: 7500 },
    advanced: { seats: 10, connections: 10, campaign_sends_per_month: 50000, active_contacts_per_month: 25000 },
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

test("the active contact line shows this and last month's counts without an allowance or price", () => {
  const counted: Entitlements = {
    ...entitlements("pro", 1, 1),
    usage: { seats: 1, connections: 1, campaign_sends: 0, active_contacts: { time_zone: "America/Los_Angeles", month: "2026-11", count: 1234, previous_month: "2026-10", previous_count: 0 } },
  };
  assert.equal(labels.planActiveContacts(counted), "이번 달 활성 연락처 1,234명 · 지난 달 0명");
  assert.equal(labels.planActiveContactsHelp(counted), "메시지를 주고받은 사람을 달마다 한 번씩 셉니다. 달은 America/Los_Angeles 기준입니다.");
  // The plan line itself is unchanged, and a response without the counts shows no line.
  assert.equal(labels.planSummary(counted), "요금제: 프로 · 멤버 1/3명(대기 중인 초대 포함) · Instagram 계정 1/3개 · 이번 달 캠페인 발송 0/5,000건");
  assert.equal(labels.planActiveContacts(entitlements("pro", 1, 1)), "");
  assert.equal(labels.planActiveContactsHelp(entitlements("pro", 1, 1)), "");
  assert.equal(labels.planActiveContacts(undefined), "");
  const app = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  assert.match(app, /byId\("active-contact-summary"\)\.hidden = !planActiveContacts\(workspacePlan\);/);
  assert.match(app, /byId\("active-contact-help"\)\.hidden = !planActiveContactsHelp\(workspacePlan\);/);
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

test("the dashboard explains every limit code, and the callback's limit code is shown on return", () => {
  const app = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  for (const code of ["seat_limit_reached", "connection_limit_reached", "broadcast_limit_reached"]) assert.match(app, new RegExp(`^  ${code}:\\s*"[^"]*[가-힣][^"]*",$`, "m"), code);
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
