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

// One line for the settings screen: the plan, then seats and connected accounts against their limits.
function planSummary(entitlements) {
  if (!entitlements) return "";
  const { usage, limits } = entitlements;
  return [
    `요금제: ${planName(entitlements.plan)}`,
    `멤버 ${usage.seats}/${limits.seats}명(대기 중인 초대 포함)`,
    `Instagram 계정 ${usage.connections}/${limits.connections}개`,
  ].join(" · ");
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
