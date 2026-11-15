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
 * @param {boolean} globalSendEnabled
 * @returns {string} The home banner title.
 */
function globalSendDeliveryTitle(globalSendEnabled) {
  return globalSendEnabled ? "자동 발송을 시작할 수 있습니다" : "전체 발송이 중지되어 있습니다";
}

/**
 * @param {boolean} globalSendEnabled
 * @param {boolean} connectAvailable Whether new Instagram connections are open.
 * @returns {string} The home banner description.
 */
function globalSendDeliveryStatus(globalSendEnabled, connectAvailable) {
  if (globalSendEnabled) return "계정별로 발송을 켜고 규칙을 활성화하면 자동화를 시작합니다.";
  return connectAvailable
    ? "전체 발송은 서비스 운영 측에서 재개합니다. 그전까지는 계정이나 규칙이 켜져 있어도 메시지가 전송되지 않으며, 계정 연결과 규칙 저장은 계속할 수 있습니다."
    : "전체 발송은 서비스 운영 측에서 재개합니다. 그전까지는 계정이나 규칙이 켜져 있어도 메시지가 전송되지 않습니다. 새 Instagram 연결은 현재 제한됩니다.";
}

/**
 * The account send badge. The account switch alone never means messages go out: the service-wide switch must also be on.
 * @param {boolean} sendEnabled The account's send switch.
 * @param {boolean} credentialValid Whether the account's token is valid.
 * @param {boolean} globalSendEnabled
 * @returns {[string, string]} The badge text and tone.
 */
function globalSendAccountBadge(sendEnabled, credentialValid, globalSendEnabled) {
  return [sendEnabled ? (globalSendEnabled ? "발송 설정 켜짐" : "발송 설정 켜짐 · 전체 중지 중") : "발송 설정 꺼짐", sendEnabled && credentialValid && globalSendEnabled ? "success" : ""];
}

/**
 * @param {boolean} ruleEnabled
 * @param {boolean} globalSendEnabled
 * @returns {[string, string]} The rule state badge text and tone.
 */
function globalSendRuleBadge(ruleEnabled, globalSendEnabled) {
  return [ruleEnabled ? (globalSendEnabled ? "활성" : "활성 · 전체 중지 중") : "중지", ruleEnabled && globalSendEnabled ? "success" : ""];
}
