import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { isPlanKey, PLANS, planLimits, type PlanKey } from "./plans.ts";

interface Entitlements {
  plan: string;
  limits: { seats: number; connections: number; campaign_sends_per_month: number };
  usage: { seats: number; connections: number; campaign_sends: number };
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
}

// public/app/plan-labels.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/plan-labels.js", import.meta.url), "utf8"), context);
const labels = context as unknown as PlanLabels;

const entitlements = (plan: PlanKey, seats: number, connections: number, campaignSends = 0): Entitlements => ({
  plan,
  limits: { ...planLimits(plan) },
  usage: { seats, connections, campaign_sends: campaignSends },
});

test("the catalog holds the five plans with the agreed seat, connection and monthly campaign send limits", () => {
  assert.deepEqual(PLANS, {
    free: { seats: 1, connections: 1, campaign_sends_per_month: 0 },
    essential: { seats: 2, connections: 2, campaign_sends_per_month: 1000 },
    pro: { seats: 3, connections: 3, campaign_sends_per_month: 5000 },
    business: { seats: 5, connections: 5, campaign_sends_per_month: 20000 },
    advanced: { seats: 10, connections: 10, campaign_sends_per_month: 50000 },
  });
  for (const key of Object.keys(PLANS)) assert.ok(isPlanKey(key), key);
  for (const value of ["gold", "", "toString", "__proto__", null, 1]) assert.equal(isPlanKey(value), false);
  assert.throws(() => planLimits("toString"), /Unknown workspace plan/);
});

test("every plan has a Korean name, and the summary shows usage against the limits", () => {
  for (const key of Object.keys(PLANS)) assert.doesNotMatch(labels.planName(key), /[a-z]/, key);
  assert.equal(labels.planName("gold"), "알 수 없는 요금제(gold)");
  assert.equal(
    labels.planSummary(entitlements("pro", 2, 3, 1234)),
    "요금제: 프로 · 멤버 2/3명(대기 중인 초대 포함) · Instagram 계정 3/3개 · 이번 달 캠페인 발송 1,234/5,000건",
  );
  // A plan without campaigns says so, with this month's rows when a downgrade left some.
  assert.equal(labels.planCampaignUsage(entitlements("free", 1, 1)), "캠페인 발송 불가");
  assert.equal(labels.planCampaignUsage(entitlements("free", 1, 1, 1500)), "캠페인 발송 불가(이번 달 1,500건 발송)");
  assert.equal(
    labels.planCampaignUsage(entitlements("essential", 1, 1, 1001)),
    "이번 달 캠페인 발송 1,001/1,000건",
    "a downgrade can leave the month over its limit",
  );
  assert.equal(labels.planSummary(undefined), "");
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
  for (const code of ["seat_limit_reached", "connection_limit_reached", "broadcast_limit_reached"])
    assert.match(app, new RegExp(`^  ${code}:\\s*"[^"]*[가-힣][^"]*",$`, "m"), code);
  assert.match(app, /const instagramErrors = \[[^\]]*"connection_limit_reached"/);
});

test("a full workspace keeps the invite button for new links, and the invitee gets its own refusal", () => {
  const app = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  // The server lets an invited email get a new link at the seat limit, so only the open link locks the button.
  assert.match(app, /querySelector\("button\[type=submit\]"\)\.disabled = inviteLinkLocked\(\);/);
  assert.match(app, /error\.code === "seat_limit_reached" \? planAcceptSeatRefusal\(\) : error\.message/);
  const refusal = labels.planAcceptSeatRefusal();
  assert.match(refusal, /소유자에게/);
  assert.match(refusal, /초대 링크를 다시 열어/);
  assert.doesNotMatch(refusal, /취소하거나 멤버를 제거/);
});
