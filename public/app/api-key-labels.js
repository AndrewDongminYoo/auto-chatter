// @ts-check
// Text for the workspace API key settings (#48). Pure functions only: src/app/api-key-labels.test.ts runs this
// classic script in a node:vm context.
const apiKeyExpiryWarningMs = 7 * 24 * 60 * 60 * 1000;
// Every revoked_reason the server stores (src/app/api-keys.ts).
const apiKeyRevocationLabels = {
  revoked: "관리자가 폐기",
  member_removed: "만든 멤버가 제거되어 자동 폐기",
  member_demoted: "만든 멤버의 역할이 낮아져 자동 폐기",
};

// The state badge of one key: revoked comes first, then expired, then expiring within 7 days.
function apiKeyStatus(key, now) {
  if (key.revoked_at) return { label: `폐기됨 · ${apiKeyRevocationLabels[key.revoked_reason] ?? "알 수 없는 이유"}`, tone: "warning" };
  const expires = Date.parse(key.expires_at);
  if (!Number.isFinite(expires) || expires <= now) return { label: "만료됨", tone: "warning" };
  if (expires - now <= apiKeyExpiryWarningMs) return { label: "만료 임박", tone: "warning" };
  return { label: "사용 중", tone: "success" };
}

// The last authenticated request as one line; formatTime turns an ISO timestamp into display text.
function apiKeyLastUse(key, formatTime) {
  if (!key.last_used_at) return "아직 사용한 적 없음";
  return `마지막 사용 ${formatTime(key.last_used_at)} · IP ${formatText(key.last_used_ip)}`;
}

// Creator, creation time and expiry of one key, as one line.
function apiKeyDates(key, formatTime) {
  return [`만든 사람 ${formatText(key.created_by_email)}`, `발급 ${formatTime(key.created_at)}`, `만료 ${formatTime(key.expires_at)}`].join(" · ");
}
