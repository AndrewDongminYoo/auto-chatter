// One name for each provider send status of manual replies, private replies, follow replies, flow DMs and campaign
// deliveries, on every screen that shows one. Pure functions only: src/app/send-status-labels.test.ts runs this classic
// script in a node:vm context. "Meta 접수" is Meta's acceptance of the request only, not delivery or a read.
// Webhook delivery, flow run, campaign run and connection states mean other things and keep their own labels.
const sendStatusLabels = {
  pending: "발송 대기",
  sending: "발송 처리 중",
  sent: "Meta 접수",
  failed: "발송 실패",
  blocked: "정책 차단",
  unknown: "결과 확인 필요",
  cancelled: "취소",
};

function sendStatusLabel(status) {
  return Object.hasOwn(sendStatusLabels, status) ? sendStatusLabels[status] : "알 수 없는 상태";
}

// [status, label] pairs in the given order, for report and summary lists keyed by stored status.
function sendStatusEntries(statuses) {
  return statuses.map((status) => [status, sendStatusLabel(status)]);
}
