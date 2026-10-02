// Text for the outbound webhook settings (#47). Pure functions only: src/app/webhook-labels.test.ts runs this
// classic script in a node:vm context.
const webhookStatusLabels = {
  pending: "전송 대기",
  sending: "전송 중",
  sent: "전송 완료",
  retry: "재시도 대기",
  dead: "전송 중단",
};
// Every failure code the delivery step stores (src/app/webhook-delivery.ts).
const webhookFailureLabels = {
  endpoint_inactive: "주소가 꺼져 있어 보내지 않음",
  url_refused: "허용하지 않는 주소",
  signing_unavailable: "서명 키를 열 수 없음",
  dns_failed: "주소 조회 실패",
  dns_no_address: "조회된 IP 주소 없음",
  address_refused: "사설·내부망 IP 주소로 조회됨",
  timeout: "응답 시간 초과",
  redirect_refused: "리다이렉트 응답이라 따라가지 않음",
  http_error: "수신 서버가 오류로 응답",
  request_failed: "수신 서버에 연결하지 못함",
  worker_interrupted: "전송 처리 중 중단됨",
};

function webhookStatusLabel(status) {
  return webhookStatusLabels[status] ?? "알 수 없는 상태";
}

function webhookFailureLabel(code) {
  if (!code) return "";
  return webhookFailureLabels[code] ?? `기타 실패(${code})`;
}

// Attempt count, last HTTP status code and failure reason of one delivery, as one line.
function webhookAttemptSummary(delivery) {
  if (!delivery.attempt_count && !delivery.failure_code) return "아직 시도하지 않았습니다";
  return [
    `시도 ${delivery.attempt_count}회`,
    delivery.last_status_code === null || delivery.last_status_code === undefined
      ? "HTTP 응답 없음"
      : `마지막 HTTP 상태 ${delivery.last_status_code}`,
    ...(delivery.failure_code ? [`실패 사유: ${webhookFailureLabel(delivery.failure_code)}`] : []),
  ].join(" · ");
}

// Created and sent time of one delivery; formatTime turns an ISO timestamp into display text.
// Only a sent row gets sent_at; a dead row is final, so it must not read as still to be sent.
function webhookDeliveryTimes(delivery, formatTime) {
  let sent = "아직 전송하지 않음";
  if (delivery.sent_at) sent = `전송 ${formatTime(delivery.sent_at)}`;
  else if (delivery.status === "dead") sent = "보내지 못함";
  return [`생성 ${formatTime(delivery.created_at)}`, sent].join(" · ");
}

// Two valid keys mean a rotation is in progress: both sign every delivery until the older one is retired.
function webhookKeyState(keys) {
  if (keys.length >= 2) return "키 교체 중";
  return keys.length === 1 ? "키 1개" : "유효한 키 없음";
}
