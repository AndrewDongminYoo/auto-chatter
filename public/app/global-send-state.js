// The service-wide send switch (SEND_ENABLED, read from /api/me) as the dashboard shows it, and when to read it again
// while the dashboard stays open (#338). Pure functions only: src/app/global-send-state.test.ts runs this classic script
// in a node:vm context. The workspace load and the re-read both use these labels, so the two cannot drift apart.

// A re-read within this many milliseconds of the last successful read is skipped.
const globalSendRereadInterval = 30_000;

/**
 * Whether to read the global send state again now.
 * @param {{ loaded: boolean, visible: boolean, inFlight: boolean, lastReadAt: number, now: number }} state `loaded`
 *   is false until a workspace load has read /api/me; `lastReadAt` is the time of the last successful read.
 * @returns {boolean}
 */
function globalSendRereadDue({ loaded, visible, inFlight, lastReadAt, now }) {
  if (!loaded || !visible || inFlight) return false;
  // A clock that moved backwards reads again instead of waiting for the old time.
  return now < lastReadAt || now - lastReadAt >= globalSendRereadInterval;
}

/**
 * @param {boolean | null} globalSendEnabled
 * @returns {string} The home banner title.
 */
function globalSendDeliveryTitle(globalSendEnabled) {
  if (globalSendEnabled === null) return "전체 발송 설정을 확인하지 못했습니다";
  return globalSendEnabled ? "전체 발송 설정이 켜져 있습니다" : "전체 발송이 중지되어 있습니다";
}

/**
 * @param {boolean | null} globalSendEnabled
 * @param {boolean} connectAvailable Whether new Instagram connections are open.
 * @param {object} [account] Account snapshot for contextual guidance.
 * @param {boolean} [ruleEnabled] Saved or draft rule switch.
 * @returns {string} Settings guidance.
 */
function globalSendDeliveryStatus(globalSendEnabled, connectAvailable, account, ruleEnabled) {
  if (arguments.length > 2) return sendSettingsSummary(globalSendEnabled, connectAvailable, account, ruleEnabled);
  if (globalSendEnabled === null) return "상태를 다시 확인해 주세요. 이전 설정으로 현재 발송 여부를 판단할 수 없습니다.";
  if (globalSendEnabled) return "계정과 규칙 설정, 수신 동의 등 발송 조건은 별도로 확인합니다. 설정을 켜도 실제 발송·전달을 보장하지 않습니다.";
  return connectAvailable
    ? "전체 발송은 서비스 운영 측에서 재개합니다. 그전까지는 계정이나 규칙이 켜져 있어도 메시지가 전송되지 않으며, 계정 연결과 규칙 저장은 계속할 수 있습니다."
    : "전체 발송은 서비스 운영 측에서 재개합니다. 그전까지는 계정이나 규칙이 켜져 있어도 메시지가 전송되지 않습니다. 새 Instagram 연결은 현재 제한됩니다.";
}

/**
 * The account send badge. The account switch alone never means messages go out: the service-wide switch must also be on.
 * @param {boolean} sendEnabled The account's send switch.
 * @param {boolean} credentialValid Whether the account's token is valid.
 * @param {boolean | null} globalSendEnabled
 * @returns {[string, string]} The badge text and tone.
 */
function globalSendAccountBadge(sendEnabled, credentialValid, globalSendEnabled) {
  if (globalSendEnabled === null) return ["전체 발송 설정 확인 필요", ""];
  return [sendEnabled ? (globalSendEnabled ? "발송 설정 켜짐" : "발송 설정 켜짐 · 전체 중지 중") : "발송 설정 꺼짐", sendEnabled && credentialValid && globalSendEnabled ? "success" : ""];
}

/**
 * @param {boolean} ruleEnabled
 * @param {boolean | null} globalSendEnabled
 * @returns {[string, string]} The rule state badge text and tone.
 */
function globalSendRuleBadge(ruleEnabled, globalSendEnabled) {
  if (globalSendEnabled === null) return ["전체 발송 설정 확인 필요", ""];
  return [ruleEnabled ? (globalSendEnabled ? "활성" : "활성 · 전체 중지 중") : "중지", ruleEnabled && globalSendEnabled ? "success" : ""];
}

/**
 * Describes settings only; the server remains authoritative for each recipient and send.
 * @param {boolean | null} globalEnabled
 * @param {boolean} connectAvailable
 * @param {object} [account] The last workspace snapshot, not a live Meta verification.
 * @param {boolean} [ruleEnabled] The editor may pass its unsaved switch value.
 * @returns {string}
 */
function sendSettingsSummary(globalEnabled, connectAvailable, account, ruleEnabled) {
  const reasons = [];
  if (globalEnabled === null) reasons.push("전체 발송 설정을 확인하지 못했습니다. 상태를 다시 확인해 주세요.");
  else if (!globalEnabled) reasons.push("전체 발송 중지 · 서비스 운영자가 재개해야 합니다.");
  if (!connectAvailable) reasons.push("새 Instagram 연결이 제한되어 있습니다. 연결이 필요하면 서비스 운영자에게 제한 해제를 요청하세요.");
  if (!account) reasons.push(connectAvailable ? "계정을 선택하고 연결 상태를 확인해 주세요." : "연결 제한이 해제된 뒤 계정을 연결해 주세요.");
  else {
    if (account.send_enabled) reasons.push("계정 발송 설정 켜짐.");
    if (!account.send_enabled) reasons.push("계정 발송 설정 꺼짐 · 계정 관리자에게 발송 설정 켜기를 요청하세요.");
    if (!account.active) reasons.push("계정 수신 설정 꺼짐 · 계정 관리자에게 수신 설정 확인을 요청하세요.");
    if (account.credential_status !== "valid" || account.reauth_required_at || account.deauthorized_at)
      reasons.push(connectAvailable ? "연결 확인 필요 · 계정 관리자가 같은 Instagram 계정을 다시 연결해 주세요." : "연결 확인 필요 · 연결 제한이 해제된 뒤 계정 관리자가 같은 Instagram 계정을 다시 연결할 수 있습니다.");
    else reasons.push("토큰 만료 전 · 연결 권한과 실제 발송 가능 여부는 확인되지 않았습니다.");
    if (account.subscription_missing_at) reasons.push("웹후크 구독 확인 필요 · 계정 관리자가 Meta 상태를 확인해 주세요.");
  }
  if (ruleEnabled === false) reasons.push("규칙 중지 · 자동화를 사용하려면 규칙을 활성화하고 저장하세요.");
  else if (ruleEnabled === true) reasons.push("규칙 설정 켜짐 · 편집 중인 변경은 저장 후 적용됩니다.");
  reasons.push("설정은 실제 발송·전달을 보장하지 않습니다. 수신 동의와 발송 가능 시간 등은 발송 시 서버에서 확인합니다.");
  return reasons.join(" ");
}
