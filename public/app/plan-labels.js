// @ts-check
// Text for the workspace plan and its limits (#52). Pure functions only: src/app/plan-labels.test.ts runs this
// classic script in a node:vm context. The values come from POST /api/workspace and GET /api/workspace/members.
const planNames = {
  free: "무료",
  essential: "에센셜",
  pro: "프로",
  business: "비즈니스",
  advanced: "어드밴스드",
};

function planName(plan) {
  return planNames[plan] ?? `알 수 없는 요금제(${plan})`;
}

function planSeatsFull(entitlements) {
  return Boolean(entitlements) && entitlements.usage.seats >= entitlements.limits.seats;
}

function planConnectionsFull(entitlements) {
  return Boolean(entitlements) && entitlements.usage.connections >= entitlements.limits.connections;
}

// Campaign delivery rows of this calendar month in the workspace time zone against the monthly limit (#52). A plan
// without campaigns says so, with the month's rows when a downgrade left some.
function planCampaignUsage(entitlements) {
  const count = (value) => formatCount(Number(value));
  const { usage, limits } = entitlements;
  if (!limits.campaign_sends_per_month) return usage.campaign_sends ? `캠페인 발송 불가(이번 달 ${count(usage.campaign_sends)}건 발송)` : "캠페인 발송 불가";
  return `이번 달 캠페인 발송 ${count(usage.campaign_sends)}/${count(limits.campaign_sends_per_month)}건`;
}

// One line for the settings screen: the plan, then seats, connected accounts and campaign sends against their limits.
function planSummary(entitlements) {
  if (!entitlements) return "";
  const { usage, limits } = entitlements;
  return [`요금제: ${planName(entitlements.plan)}`, `멤버 ${usage.seats}/${limits.seats}명(대기 중인 초대 포함)`, `Instagram 계정 ${usage.connections}/${limits.connections}개`, planCampaignUsage(entitlements)].join(" · ");
}

// The billing-month active contact counts (#51): people the workspace exchanged a message with, once per month and
// connection. The months follow the workspace time zone the server used. This month's count is shown against the
// plan's monthly allowance (#52); no price is shown. An older server without the counts shows nothing, and one
// without the allowance shows the counts alone.
function planActiveContactLimit(entitlements) {
  const limit = Number(entitlements?.limits.active_contacts_per_month);
  return Number.isFinite(limit) && limit >= 0 ? limit : null;
}

// The server's rule (activeContactLimitBlocks in src/app/plans.ts): over the allowance every send stops; at it, only a
// send to a person not yet counted this month stops.
function planActiveContactsOver(entitlements) {
  const counts = entitlements?.usage.active_contacts;
  const limit = planActiveContactLimit(entitlements);
  return Boolean(counts) && limit !== null && Number(counts.count) > limit;
}

function planActiveContactsFull(entitlements) {
  const counts = entitlements?.usage.active_contacts;
  const limit = planActiveContactLimit(entitlements);
  return Boolean(counts) && limit !== null && Number(counts.count) === limit;
}

function planActiveContacts(entitlements) {
  const counts = entitlements?.usage.active_contacts;
  if (!counts) return "";
  const limit = planActiveContactLimit(entitlements);
  const current = limit === null ? `${formatCount(Number(counts.count))}명` : `${formatCount(Number(counts.count))}/${formatCount(limit)}명`;
  return `이번 달 활성 연락처 ${current} · 지난 달 ${formatCount(Number(counts.previous_count))}명`;
}

function planActiveContactsHelp(entitlements) {
  const counts = entitlements?.usage.active_contacts;
  if (!counts) return "";
  const limit = planActiveContactLimit(entitlements);
  if (planActiveContactsOver(entitlements))
    return `이번 달 활성 연락처가 요금제에 포함된 ${formatCount(limit)}명을 넘어 자동 답장, 직접 답장, 캠페인 발송을 모두 멈췄습니다. 받은 메시지 확인과 설정 변경은 그대로 할 수 있습니다. 다음 달이 되거나 요금제가 올라가면 다시 보내며, 멈춘 동안 보내지 못한 메시지는 나중에 보내지 않습니다.`;
  if (planActiveContactsFull(entitlements))
    return `이번 달 활성 연락처가 요금제에 포함된 ${formatCount(limit)}명에 도달했습니다. 이번 달에 메시지를 주고받은 사람에게는 계속 보내지만, 새로운 사람에게는 보내지 않습니다. 새로운 사람의 댓글이나 DM으로 포함량을 넘으면 모든 발송을 멈춥니다.`;
  return `메시지를 주고받은 사람을 달마다 한 번씩 셉니다. 달은 ${counts.time_zone} 기준입니다.`;
}

// The reason beside the disabled campaign approval while the workspace is over its allowance.
function planActiveContactsApprovalHelp(entitlements) {
  return planActiveContactsOver(entitlements) ? "이번 달 활성 연락처가 요금제 포함량을 넘어 실행 승인을 기록할 수 없습니다. 설정의 요금제 안내를 확인해 주세요." : "";
}

function planSeatHelp(entitlements) {
  if (!planSeatsFull(entitlements)) return "";
  return `요금제의 멤버 자리 ${entitlements.limits.seats}개를 모두 쓰고 있어 새 이메일은 초대할 수 없습니다. 이미 초대한 이메일로는 새 링크를 만들 수 있습니다. 대기 중인 초대를 취소하거나 멤버를 제거하면 자리가 생깁니다.`;
}

// Accepting shares seat_limit_reached with invite creation, but the invitee cannot free a seat; the invite stays
// open, so the received link works again once the owner makes room.
function planAcceptSeatRefusal() {
  return "작업 공간의 멤버 자리가 모두 차 있어 참여하지 못했습니다. 작업 공간 소유자에게 자리를 마련해 달라고 요청한 뒤 받은 초대 링크를 다시 열어 주세요.";
}

function planConnectionHelp(entitlements) {
  if (!planConnectionsFull(entitlements)) return "";
  return `요금제의 Instagram 계정 ${entitlements.limits.connections}개를 모두 연결했습니다. 연결한 계정의 재연결은 할 수 있지만, 새 계정을 연결하려면 다른 계정의 연결을 먼저 해제해 주세요.`;
}
