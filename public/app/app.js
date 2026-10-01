const byId = (id) => document.getElementById(id);
const form = byId("rule-form");
let connections = [];
let contactsGeneration = 0;
let contactsAfter = null;
let contactsBusy = false;
let contactsSaving = false;
let contactsQuery = "";
const contactsDirty = new Set();
// Connections deleted since the current contact list generation began; later pages drop their contacts.
const purgedContactConnections = new Set();
let contactSegments = [];
let segmentsGeneration = 0;
let segmentsRequest = 0;
let segmentBusy = false;
let activeSegmentId = "";
let segmentNameDirty = false;
let contactFields = [];
let fieldsGeneration = 0;
let fieldsRequest = 0;
let fieldBusy = false;
let fieldNameDirty = false;
let refreshPromise;
let currentUserId;
let currentRole;
let pendingInvite = null;
// Set when acceptPendingInvite reports an outcome, so the login notice does not overwrite it.
let inviteNoticeShown = false;
let activityRequest = 0;
let editingRuleId;
let dirty = false;
let mediaGeneration = 0;
let mediaAfter = null;
let mediaBusy = false;
let mediaSession = 0;
const mediaCache = new Map();
function editorState(
  message = dirty ? "저장하지 않은 변경 사항이 있습니다." : "새 댓글부터 저장한 설정이 적용됩니다.",
) {
  byId("editor-title").textContent = editingRuleId ? "규칙 수정" : "새 규칙 만들기";
  byId("edit-state").textContent = dirty ? "저장 전" : editingRuleId ? "저장됨" : "작성 전";
  byId("edit-state").className = `badge${dirty ? " warning" : ""}`;
  if (byId("save-status").textContent !== message) byId("save-status").textContent = message;
}
function canDiscard() {
  return (
    (!dirty && !contactsDirty.size && !segmentNameDirty && !fieldNameDirty && !inbox.hasDrafts()) ||
    confirm("저장하지 않은 규칙·연락처·필터 변경 사항과 답장 초안을 버릴까요?")
  );
}
function canDiscardRule() {
  return !dirty || confirm("저장하지 않은 규칙 변경 사항을 버릴까요?");
}
function focusEditor() {
  const target = editingRuleId
    ? form.elements[form.elements.match_mode.value === "all" ? "private_reply_text" : "keywords"]
    : byId("media-title");
  target.focus({ preventScroll: true });
  target.scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "center",
  });
}

function emptyState(title, description) {
  const element = node("div", "", "empty-state");
  element.append(node("strong", title), node("p", description));
  return element;
}
function badge(text, tone = "") {
  return node("span", text, `badge ${tone}`);
}
function updatePreview() {
  const fields = form.elements;
  const account = fields.connection_id.selectedOptions[0]?.textContent;
  byId("preview-account").textContent = account || "연결할 계정";
  byId("preview-comment").textContent =
    fields.match_mode.value === "all"
      ? "모든 댓글에 반응합니다"
      : list(fields.keywords.value)[0] || "키워드를 입력하세요";
  byId("preview-message").textContent =
    fields.private_reply_text.value.trim() || "작성한 첫 메시지가 여기에 표시됩니다.";
  const button = fields.follow_gate_enabled.checked && fields.confirmation_button_enabled.checked;
  for (const id of ["preview-first-button", "preview-retry-button"]) {
    byId(id).hidden = !button;
    byId(id).textContent = fields.confirmation_button_title.value.trim() || "버튼 이름을 입력하세요";
  }
  byId("preview-follow").hidden = !fields.follow_gate_enabled.checked;
  byId("preview-confirmation").textContent = fields.confirmation_keyword.value.trim() || "확인 단어를 입력하세요";
  byId("preview-follower").textContent = fields.follower_reply_text.value.trim() || "팔로우한 사람에게 보낼 답장";
  byId("preview-non-follower").textContent =
    fields.non_follower_reply_text.value.trim() || "팔로우하지 않은 사람에게 보낼 답장";
}
function formConditions() {
  const follow = form.elements.follow_gate_enabled.checked;
  byId("follow-settings").hidden = !follow;
  for (const name of ["confirmation_keyword", "follower_reply_text", "non_follower_reply_text"])
    form.elements[name].required = follow;
  const button = follow && form.elements.confirmation_button_enabled.checked;
  byId("confirmation-button-settings").hidden = !button;
  form.elements.confirmation_button_title.required = button;
  for (const name of ["private_reply_text", "non_follower_reply_text"]) {
    const field = form.elements[name];
    field.maxLength = button ? 640 : 1000;
    field.setCustomValidity(
      button && field.value.length > 640 ? "버튼이 있는 메시지는 640자 이내로 작성해 주세요." : "",
    );
  }
  const all = form.elements.match_mode.value === "all";
  byId("include-keywords").hidden = all;
  form.elements.keywords.required = !all;
  form.elements.keywords.setCustomValidity("");
  form.elements.excluded_keywords.setCustomValidity("");
  byId("message-count").textContent =
    `${form.elements.private_reply_text.value.length.toLocaleString("ko-KR")} / ${button ? "640" : "1,000"}`;
  updatePreview();
}
function markDirty() {
  formConditions();
  if (!dirty) {
    dirty = true;
    editorState();
  }
}
form.addEventListener("input", markDirty);
form.addEventListener("change", markDirty);
window.addEventListener("beforeunload", (event) => {
  if (dirty || contactsDirty.size || segmentNameDirty || fieldNameDirty || inbox.hasDrafts()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
function resetSession() {
  resetInbox();
  connections = [];
  currentUserId = undefined;
  currentRole = undefined;
  byId("members-section").hidden = true;
  byId("time-zone-form").reset();
  timeZoneControls();
  byId("members").replaceChildren();
  byId("invites").replaceChildren();
  byId("invite-result").hidden = true;
  byId("invite-link").value = "";
  byId("operations-section").hidden = true;
  byId("operations-summary").textContent = "";
  byId("operations-alerts").replaceChildren();
  byId("operations").replaceChildren();
  contactsGeneration++;
  contactsDirty.clear();
  purgedContactConnections.clear();
  contactsAfter = null;
  contactsBusy = false;
  contactsSaving = false;
  segmentsGeneration++;
  contactSegments = [];
  segmentBusy = false;
  activeSegmentId = "";
  segmentNameDirty = false;
  fieldsGeneration++;
  contactFields = [];
  fieldBusy = false;
  fieldNameDirty = false;
  byId("field-create").reset();
  byId("field-definitions").replaceChildren();
  byId("fields-status").textContent = "";
  byId("contacts-filter").elements.field_id.replaceChildren(new Option("조건 없음", ""));
  fieldControls();
  byId("contact-segment").replaceChildren(new Option("직접 조건 설정", ""));
  byId("segment-archive").disabled = true;
  byId("segment-save").reset();
  byId("segments-status").textContent = "";
  segmentControls();
  byId("contacts-list").replaceChildren();
  byId("contacts-filter").reset();
  fieldFilterControls();
  byId("contacts-more").hidden = true;
  byId("contacts-status").textContent = "";
  mediaCache.clear();
  mediaSession++;
  ruleMediaObserver.disconnect();
  dirty = false;
  byId("startup").hidden = true;
  editingRuleId = undefined;
  form.reset();
  form.elements.media_id.value = "";
  form.elements.connection_id.disabled = false;
  resetMedia();
  form.elements.connection_id.replaceChildren();
  byId("connections").replaceChildren();
  byId("rules").replaceChildren();
  byId("activity").replaceChildren();
  byId("workspace").hidden = true;
  byId("auth").hidden = false;
  byId("logout").hidden = true;
  formConditions();
  editorState();
}

function notice(message, error = false) {
  byId("notice").textContent = message;
  byId("notice").classList.toggle("error", error);
  byId("notice").setAttribute("aria-live", error ? "assertive" : "polite");
  if (error && message) byId("notice").focus({ preventScroll: false });
}

const errors = {
  role_forbidden: "이 작업을 할 권한이 없습니다. 작업 공간 소유자에게 역할 변경을 요청해 주세요.",
  workspace_required: "작업 공간에 참여하고 있지 않습니다. 페이지를 새로 고치거나 새 초대를 요청해 주세요.",
  invalid_email: "초대할 이메일 주소를 확인해 주세요.",
  invalid_role: "역할을 다시 선택해 주세요.",
  invalid_time_zone:
    "시간대 이름을 확인해 주세요. 목록에 있는 Asia/Seoul 같은 이름을 대소문자까지 그대로 입력해야 합니다.",
  already_member: "이미 작업 공간의 멤버입니다.",
  conversation_conflict: "다른 요청으로 대화 상태나 담당자가 먼저 바뀌었습니다. 최신 상태를 확인해 주세요.",
  assignee_unavailable: "작업 공간에서 제거되었거나 다른 작업 공간의 멤버에게는 배정할 수 없습니다.",
  invalid_conversation_request: "대화 상태 요청을 확인해 주세요. 새로고침한 뒤 다시 시도해 주세요.",
  invite_limit_reached: "대기 중인 초대가 너무 많습니다. 사용하지 않는 초대를 취소한 뒤 다시 시도해 주세요.",
  invite_not_found: "초대 링크를 확인할 수 없습니다. 링크 전체를 복사했는지 확인하거나 새 초대를 요청해 주세요.",
  invite_used: "이미 사용한 초대 링크입니다. 새 초대를 요청해 주세요.",
  invite_revoked: "취소된 초대 링크입니다. 새 초대를 요청해 주세요.",
  invite_expired: "만료된 초대 링크입니다. 새 초대를 요청해 주세요.",
  invite_email_mismatch: "초대받은 이메일과 로그인한 계정의 이메일이 다릅니다. 초대받은 이메일로 로그인해 주세요.",
  workspace_not_empty:
    "지금 작업 공간에 데이터나 다른 멤버가 있어 초대를 수락할 수 없습니다. 기존 작업 공간을 정리한 뒤 다시 시도해 주세요.",
  cannot_change_self: "자신의 역할은 바꾸거나 제거할 수 없습니다.",
  cannot_change_owner: "소유자의 역할은 바꾸거나 제거할 수 없습니다.",
  member_not_found: "멤버를 찾을 수 없습니다. 목록을 새로 고쳐 주세요.",
  authentication_failed: "로그인 정보를 확인하거나 잠시 후 다시 시도해 주세요.",
  auth_not_configured: "로그인 서비스를 준비 중입니다.",
  confirmed_email_required: "이메일 인증을 완료해 주세요.",
  login_required: "다시 로그인해 주세요.",
  origin_rejected: "이 페이지에서 다시 시도해 주세요.",
  connection_not_found: "접근할 수 있는 Instagram 계정을 선택해 주세요.",
  connection_unavailable: "계정 연결 상태와 토큰 유효기간을 확인해 주세요.",
  connection_active:
    "이 계정은 아직 연결되어 있습니다. '연결 해제'로 수신·발송을 중지하고 토큰을 삭제한 뒤 다시 시도해 주세요.",
  sending_in_progress: "이 계정에 발송 중인 메시지가 있어 지금은 삭제할 수 없습니다. 몇 분 뒤 다시 시도해 주세요.",
  confirmation_mismatch:
    "입력한 계정 ID가 이 연결의 Instagram 계정 ID와 다릅니다. 표시된 숫자 ID를 그대로 입력해 주세요.",
  invalid_data_deletion: "삭제를 확인할 Instagram 계정 ID를 입력해 주세요.",
  keywords_required: "키워드를 하나 이상 입력해 주세요.",
  invalid_contact_automation: "연락처 자동화 설정을 확인해 주세요.",
  invalid_contact_tags: "태그는 한 줄에 하나씩 최대 20개, 각각 40자까지 입력해 주세요.",
  invalid_contact_request: "연락처 필터를 확인한 뒤 다시 불러와 주세요.",
  contact_not_found: "연락처에 접근할 수 없습니다. 목록을 다시 불러와 주세요.",
  invalid_segment: "필터 이름은 1–60자이며 계정과 태그 조건을 확인해 주세요.",
  segment_not_found: "필터에 접근할 수 없습니다. 저장된 필터를 다시 불러와 주세요.",
  segment_name_exists: "같은 이름의 필터가 있습니다. 다른 이름으로 저장해 주세요.",
  segment_limit_reached: "저장된 필터는 최대 50개입니다. 사용하지 않는 필터를 보관해 주세요.",
  invalid_contact_field: "필드 이름은 1–60자이며 값 종류를 선택해 주세요.",
  invalid_field_value: "선택한 종류에 맞는 값을 입력해 주세요. 텍스트는 최대 1000자입니다.",
  invalid_field_condition: "추가 정보의 필드·조건·찾을 값을 확인해 주세요.",
  field_not_found: "접근할 수 없거나 보관된 필드입니다. 필드를 다시 불러와 주세요.",
  field_in_use: "저장된 필터에서 사용하는 필드입니다. 해당 필터를 먼저 보관해 주세요.",
  field_name_exists: "보관된 필드를 포함해 같은 이름이 있습니다. 다른 이름을 사용해 주세요.",
  field_limit_reached: "활성 필드는 최대 50개입니다. 사용하지 않는 필드를 보관해 주세요.",
  invalid_keywords: "키워드는 최대 20개, 각각 100자까지 입력할 수 있습니다.",
  invalid_confirmation_button: "버튼 이름은 20자, 버튼 메시지는 640자 이내로 작성하고 팔로우 확인을 켜주세요.",
  invalid_rule: "게시물 선택, 답장 문구와 팔로우 조건을 확인해 주세요.",
  invalid_media_request: "게시물 목록을 새로고침한 뒤 다시 선택해 주세요.",
  media_reconnect_required: "계정을 다시 연결한 뒤 게시물을 불러와 주세요.",
  media_unavailable: "게시물을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
  media_not_owned: "선택한 계정의 게시물만 사용할 수 있습니다. 게시물을 다시 선택해 주세요.",
  media_unsupported: "이 게시물은 댓글 자동화를 지원하지 않습니다. 피드 게시물이나 릴스를 선택해 주세요.",
  remote_logout_unconfirmed:
    "브라우저에서 로그아웃했습니다. 서버 세션 종료를 확인하지 못했으니 다시 로그인해 로그아웃하거나 운영자에게 문의해 주세요.",
  instagram_not_configured: "Instagram 연결 서비스를 준비 중입니다.",
  instagram_public_access_restricted:
    "일반 사용자의 Instagram 연결에 필요한 Meta 승인을 확인하지 못해 계정 연결을 제한합니다. 검수에 참여하는 계정만 연결할 수 있습니다.",
  instagram_authorization_denied: "Instagram 연결이 완료되지 않았습니다. 권한 동의를 취소했거나 요청이 거부됐습니다.",
  instagram_permissions_required: "필수 Instagram 권한을 받지 못했습니다. 계정과 앱 권한을 확인해 주세요.",
  health_rate_limited: "상태 확인 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  health_unavailable: "지금은 Meta 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  invalid_credentials: "이메일과 8자 이상의 비밀번호를 입력해 주세요.",
  invalid_recovery_email: "이메일 주소를 확인해 주세요.",
  auth_rate_limited: "요청이 많습니다. 잠시 기다린 뒤 다시 시도해 주세요.",
  invalid_recovery_link: "변경 링크를 다시 요청해 주세요.",
  recovery_link_invalid: "변경 링크가 만료되었거나 유효하지 않습니다. 새 링크를 요청해 주세요.",
  password_rejected: "새 비밀번호가 보안 기준을 충족하지 않습니다. 다른 비밀번호로 다시 시도해 주세요.",
  password_updated_logout_unconfirmed:
    "비밀번호는 변경됐지만 다른 세션 종료를 확인하지 못했습니다. 새 비밀번호로 로그인한 뒤 계정 상태를 확인해 주세요.",
};

async function api(path, method = "GET", body, retry = true, asText = false) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.");
  }
  if (response.status === 401 && retry && !path.startsWith("/api/auth/")) {
    refreshPromise ??= api("/api/auth/refresh", "POST", undefined, false).finally(() => {
      refreshPromise = undefined;
    });
    await refreshPromise;
    return api(path, method, body, false, asText);
  }
  if (response.status === 401) resetSession();
  if (asText && response.ok) return response.text();
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("서버 응답을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  }
  if (!response.ok) {
    const error = new Error(errors[result.error] ?? "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    error.status = response.status;
    error.code = result.error;
    throw error;
  }
  return result;
}

async function action(button, task) {
  if (button.disabled) return;
  const relatedControls =
    button === byId("save-rule")
      ? document.querySelectorAll("#workspace button, #logout")
      : (button.closest("form")?.querySelectorAll("button") ?? []);
  const controls = [...new Set([button, ...relatedControls])];
  const original = controls.map((control) => [control, control.disabled]);
  const label = button.textContent;
  for (const control of controls) control.disabled = true;
  button.textContent = button.dataset.loadingLabel ?? "처리 중…";
  button.setAttribute("aria-busy", "true");
  try {
    await task();
  } catch (error) {
    notice(error.message, true);
  } finally {
    for (const [control, disabled] of original) control.disabled = disabled;
    button.textContent = label;
    button.removeAttribute("aria-busy");
    byId("save-rule").disabled = connections.length === 0;
  }
}

function node(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}
function list(text) {
  return text
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

const deletedLabels = {
  instagram_comment_events: "댓글",
  private_reply_outbox: "비공개 답장",
  flow_runs: "플로 실행",
  flow_step_runs: "플로 실행 단계",
  webhook_deliveries: "외부 전송",
  webhook_redelivery_events: "외부 전송 재시도 기록",
  instagram_follow_conversations: "팔로우 후속 메시지",
  instagram_message_receipts: "확인 메시지 수신",
  instagram_inbox_messages: "보관한 수신 DM",
  instagram_unmatched_replies: "연결 대기 응답 DM",
  instagram_inbox_handoffs: "상담 전환",
  instagram_inbox_handoff_events: "상담 전환 이력",
  instagram_inbox_conversations: "대화 상태·담당자",
  instagram_inbox_conversation_events: "대화 상태·담당자 이력",
  instagram_manual_replies: "수동 답장",
  instagram_manual_reply_events: "수동 답장 감사 기록",
  instagram_contact_automation: "자동화 중지 상태",
  instagram_contact_tags: "연락처 태그",
  instagram_contact_field_values: "연락처 필드 값",
  channel_consent_state: "동의 허용 상태",
  channel_consent_events: "동의 허용 기록",
};
const retainedLabels = {
  channel_consent_state: "수신 거부 상태",
  channel_consent_events: "수신 거부 기록",
  carried_comment_sender_revokes: "댓글 작성자 ID로 옮긴 수신 거부",
};

function countTotal(counts) {
  return Object.values(counts ?? {}).reduce((sum, count) => sum + (Number(count) || 0), 0);
}

function countSummary(counts, labels) {
  return Object.entries(counts ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => `${labels[key] ?? key} ${Number(count).toLocaleString("ko-KR")}건`)
    .join(", ");
}

function deletionRecord(record) {
  const item = node("li", "");
  const scope = record.scope === "person" ? "이용자 단위 삭제(운영자 처리)" : "연결 단위 삭제";
  const requester =
    record.scope === "person" ? "" : record.requested_by === currentUserId ? " · 내 요청" : " · 다른 관리자 요청";
  item.append(node("strong", `${new Date(record.completed_at).toLocaleString("ko-KR")} · ${scope}${requester}`));
  const deleted = countSummary(record.deleted_counts, deletedLabels);
  item.append(
    node(
      "p",
      deleted
        ? `삭제 ${countTotal(record.deleted_counts).toLocaleString("ko-KR")}건 · ${deleted}`
        : "삭제할 기록이 없었습니다.",
      "hint",
    ),
  );
  const retained = countSummary(record.retained_counts, retainedLabels);
  if (retained) item.append(node("p", `보관 · ${retained}`, "hint"));
  return item;
}

// Removes the deleted connection's contacts, inbox drafts and activity from the screen, then reloads those views.
function forgetDeletedConnection(connectionId) {
  purgedContactConnections.add(connectionId);
  for (const key of contactsDirty) if (key.startsWith(`${connectionId}:`)) contactsDirty.delete(key);
  for (const card of byId("contacts-list").querySelectorAll(".contact-row"))
    if (card.dataset.connectionId === connectionId) card.remove();
  inbox.forgetConnection(connectionId);
  if (!contactsDirty.size && !contactsSaving) void loadContacts();
  const generation = segmentsGeneration;
  loadActivity().catch(() => {
    if (generation !== segmentsGeneration) return;
    byId("activity").replaceChildren(
      emptyState("처리 내역을 불러오지 못했습니다", "새로고침을 눌러 다시 시도해 주세요."),
    );
  });
}

function connectionData(account, generation) {
  const section = node("div", "", "connection-data");
  const history = document.createElement("details");
  history.append(node("summary", "삭제 기록"));
  const historyStatus = node("p", "", "hint");
  historyStatus.setAttribute("role", "status");
  const records = node("ul", "", "deletion-records");
  history.append(historyStatus, records);
  let historyRequest = 0;
  const loadHistory = async () => {
    const request = ++historyRequest;
    historyStatus.textContent = "삭제 기록을 불러오는 중…";
    try {
      const result = await api(`/api/connections/${account.id}/data-deletions`);
      if (generation !== segmentsGeneration || request !== historyRequest) return;
      records.replaceChildren(...result.deletions.map(deletionRecord));
      historyStatus.textContent = result.deletions.length
        ? `최근 ${result.deletions.length}건 · 댓글·메시지 내용과 이용자 식별자는 기록하지 않습니다.`
        : "이 연결의 삭제 기록이 없습니다.";
    } catch (error) {
      if (generation !== segmentsGeneration || request !== historyRequest) return;
      historyStatus.textContent = error.message;
    }
  };
  history.addEventListener("toggle", () => {
    if (history.open) void loadHistory();
  });
  // Mirrors the delete_connection_data guard: inactive, send off, and no stored token (an expired token still counts).
  if (!account.active && !account.send_enabled && account.token_registered === false) {
    const removal = document.createElement("details");
    removal.append(node("summary", "데이터 삭제"));
    const deletionForm = document.createElement("form");
    deletionForm.className = "deletion-form";
    const help = node(
      "p",
      "이 연결의 댓글·답장 처리 기록, 보관한 수신 DM, 상담 전환·수동 답장 기록, 연락처 태그·필드 값·자동화 중지 상태와 동의 허용 기록을 삭제합니다. 대기 중이거나 실패한 발송도 함께 삭제됩니다. 수신 거부 기록과 삭제 기록은 보관하며, 연결과 댓글 규칙·필드 정의는 남습니다. 삭제한 기록은 되돌릴 수 없습니다.",
      "hint",
    );
    const helpId = `deletion-help-${account.id}`;
    help.id = helpId;
    const label = node("label", `확인을 위해 Instagram 계정 ID(${account.account_id})를 입력하세요`);
    const input = document.createElement("input");
    input.name = "confirm_account_id";
    input.autocomplete = "off";
    input.inputMode = "numeric";
    input.spellcheck = false;
    input.required = true;
    input.maxLength = 255;
    input.setAttribute("aria-describedby", helpId);
    label.append(input);
    const failure = node("p", "", "form-error");
    failure.setAttribute("role", "alert");
    const submit = node("button", "기록 삭제", "secondary danger");
    submit.type = "submit";
    submit.dataset.loadingLabel = "삭제 중…";
    input.addEventListener("input", () => {
      failure.textContent = "";
      input.removeAttribute("aria-invalid");
    });
    deletionForm.append(help, label, failure, submit);
    deletionForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void action(submit, async () => {
        failure.textContent = "";
        input.removeAttribute("aria-invalid");
        try {
          const result = await api(`/api/connections/${account.id}/data-deletion`, "POST", {
            confirm_account_id: input.value.trim(),
          });
          if (generation !== segmentsGeneration) return;
          input.value = "";
          removal.open = false;
          // The focused control is now inside a closed <details>; keep keyboard users on the records that open next.
          history.querySelector("summary").focus();
          notice(
            `${account.username ?? account.account_id} 연결의 기록 ${countTotal(result.deleted_counts).toLocaleString("ko-KR")}건을 삭제했습니다. 항목별 건수는 삭제 기록에서 확인할 수 있습니다.`,
          );
          if (history.open) void loadHistory();
          else history.open = true;
          forgetDeletedConnection(account.id);
        } catch (error) {
          if (generation !== segmentsGeneration) return;
          failure.textContent = error.message;
          input.setAttribute("aria-invalid", "true");
          input.focus();
        }
      });
    });
    removal.append(deletionForm);
    section.append(removal);
  }
  section.append(history);
  return section;
}

const roleLabels = { owner: "소유자", admin: "관리자", agent: "상담원" };
const roleLabelsAs = { owner: "소유자로", admin: "관리자로", agent: "상담원으로" };

// The link carries the token in its fragment; it is kept for this tab until the user signs in.
function rememberInvite(token) {
  pendingInvite = token;
  try {
    if (token) sessionStorage.setItem("pending-invite", token);
    else sessionStorage.removeItem("pending-invite");
  } catch {
    // Storage can be unavailable; the token then lasts only for this page load.
  }
}

async function acceptPendingInvite() {
  const token = pendingInvite;
  try {
    const joined = await api("/api/invites/accept", "POST", { token });
    rememberInvite(null);
    notice(`초대를 수락했습니다. ${roleLabelsAs[joined.role] ?? "멤버로"} 작업 공간에 참여했습니다.`);
  } catch (error) {
    // Only a definitive refusal drops the token; a network failure, an expired session, a rate limit or a
    // server error keeps it so the next load or login retries the acceptance.
    if ([400, 403, 404, 409, 410].includes(error.status)) rememberInvite(null);
    notice(error.message, true);
  }
  inviteNoticeShown = true;
}

function memberItem(member) {
  const item = node("div", "", "item");
  item.append(node("strong", member.email ?? "이메일 미기록"));
  const badges = node("div", "", "badges");
  badges.append(badge(roleLabels[member.role] ?? member.role), ...(member.is_self ? [badge("나")] : []));
  item.append(badges);
  if (member.is_self || member.role === "owner") return item;
  const role = document.createElement("select");
  role.setAttribute("aria-label", `${member.email ?? "멤버"} 역할`);
  for (const value of ["agent", "admin"]) {
    const option = node("option", roleLabels[value]);
    option.value = value;
    option.selected = member.role === value;
    role.append(option);
  }
  role.addEventListener("change", async () => {
    role.disabled = true;
    try {
      await api(`/api/workspace/members/${member.user_id}`, "PATCH", { role: role.value });
      notice(
        `멤버(${member.email ?? "이메일 미기록"})의 역할을 ${roleLabelsAs[role.value]} 바꿨습니다. 다음 요청부터 적용됩니다.`,
      );
    } catch (error) {
      role.value = member.role;
      notice(error.message, true);
    } finally {
      role.disabled = false;
      void loadMembers();
    }
  });
  const remove = node("button", "멤버 제거", "secondary danger");
  remove.addEventListener("click", () =>
    action(remove, async () => {
      if (
        !confirm(
          `이 멤버(${member.email ?? "이메일 미기록"})를 작업 공간에서 제거할까요? 다음 요청부터 접근할 수 없고, 담당한 대화는 미배정으로 바뀝니다. 이미 예약한 답장과 시작한 상담은 취소되지 않습니다.`,
        )
      )
        return;
      const removed = await api(`/api/workspace/members/${member.user_id}`, "DELETE");
      notice(
        removed.unassigned_conversations
          ? `멤버를 작업 공간에서 제거하고 담당하던 대화 ${removed.unassigned_conversations}개를 미배정으로 바꿨습니다.`
          : "멤버를 작업 공간에서 제거했습니다.",
      );
      await loadMembers();
    }),
  );
  item.append(role, remove);
  return item;
}

function inviteItem(invite) {
  const item = node("div", "", "item");
  item.append(node("strong", invite.email));
  const badges = node("div", "", "badges");
  badges.append(
    badge(roleLabels[invite.role] ?? invite.role),
    badge(
      invite.expired ? "만료됨" : `${new Date(invite.expires_at).toLocaleDateString("ko-KR")}까지`,
      invite.expired ? "warning" : "",
    ),
  );
  const revoke = node("button", "초대 취소", "secondary");
  revoke.addEventListener("click", () =>
    action(revoke, async () => {
      await api(`/api/workspace/invites/${invite.id}`, "DELETE");
      notice("초대를 취소했습니다. 이 링크는 더 이상 사용할 수 없습니다.");
      await loadMembers();
    }),
  );
  item.append(badges, revoke);
  return item;
}

async function loadMembers() {
  const generation = segmentsGeneration;
  try {
    const [members, invites] = await Promise.all([api("/api/workspace/members"), api("/api/workspace/invites")]);
    if (generation !== segmentsGeneration) return;
    byId("member-count").textContent = members.members.length;
    byId("members").replaceChildren(...members.members.map(memberItem));
    byId("invites").replaceChildren(
      ...(invites.invites.length ? invites.invites.map(inviteItem) : [node("p", "대기 중인 초대가 없습니다.", "hint")]),
    );
  } catch (error) {
    if (generation === segmentsGeneration) notice(error.message, true);
  }
}

// Admins and owners change the workspace time zone; agents see it read-only.
function timeZoneControls() {
  const zoneForm = byId("time-zone-form");
  const editable = currentRole === "owner" || currentRole === "admin";
  zoneForm.elements.time_zone.readOnly = !editable;
  zoneForm.querySelector("button[type=submit]").hidden = !editable;
  byId("time-zone-readonly").hidden = editable || currentRole === undefined;
}

// Admins and owners see delivery metrics and alerts; the route refuses agents, so the section stays hidden for them.
const operationAlertLabels = {
  oldest_pending: (limits) => `발송 대기 ${limits.oldest_pending_minutes}분 초과`,
  sending_dwell: (limits) => `발송 처리 ${limits.sending_dwell_minutes}분 초과`,
  unknown_outcome: () => "결과 미확인 발송 있음",
  token_expiring: (limits) => `토큰 만료 ${limits.token_expiry_days}일 이내`,
  cron_stale: (limits) => `정기 작업이 ${limits.cron_stale_minutes}분 넘게 성공하지 않음`,
};
function operationAlert(name, limits) {
  return badge(operationAlertLabels[name]?.(limits) ?? name, "warning");
}
function operationDuration(seconds) {
  if (seconds === null || seconds === undefined) return "없음";
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}
async function loadOperations() {
  const generation = segmentsGeneration;
  try {
    const health = await api("/api/workspace/health");
    if (generation !== segmentsGeneration) return;
    const limits = health.thresholds;
    const cron = health.last_cron_success_at
      ? new Date(health.last_cron_success_at).toLocaleString("ko-KR")
      : "기록 없음";
    const summary = [
      `${new Date(health.checked_at).toLocaleTimeString("ko-KR")} 확인 · 마지막 정기 작업 성공: ${cron}`,
      ...(health.global_send_enabled ? [] : ["전체 발송이 중지되어 있어 발송 대기 경보는 표시하지 않습니다."]),
    ].join(" · ");
    byId("operations-summary").textContent = summary;
    byId("operations-alerts").replaceChildren(...health.alerts.map((name) => operationAlert(name, limits)));
    byId("operations").replaceChildren(
      ...(health.connections.length
        ? health.connections.map((connection) => {
            const item = node("div", "", "item");
            const badges = node("div", "", "badges");
            badges.append(
              ...(connection.alerts.length
                ? connection.alerts.map((name) => operationAlert(name, limits))
                : [badge("경보 없음")]),
            );
            item.append(
              node("strong", connection.username ?? "이름 없는 계정"),
              badges,
              node(
                "p",
                `가장 오래 기다린 발송: ${operationDuration(connection.oldest_due_pending_seconds)} · 가장 오래 처리 중인 발송: ${operationDuration(connection.longest_sending_seconds)}`,
                "hint",
              ),
              node(
                "p",
                `최근 24시간: 결과 미확인 ${connection.unknown_24h}건 · 실패 ${connection.failed_24h}건 · 차단 ${connection.blocked_24h}건`,
                "hint",
              ),
              node(
                "p",
                [
                  connection.token_expires_in_days === null
                    ? "연결 토큰 없음"
                    : connection.token_expires_in_days < 0
                      ? "토큰 만료됨"
                      : `토큰 만료까지 ${connection.token_expires_in_days}일`,
                  ...(connection.send_paused_until
                    ? [
                        `발송 제한으로 ${new Date(connection.send_paused_until).toLocaleTimeString("ko-KR")}까지 일시 중지`,
                      ]
                    : []),
                ].join(" · "),
                "hint",
              ),
            );
            return item;
          })
        : [node("p", "연결한 계정이 없습니다.", "hint")]),
    );
  } catch (error) {
    if (generation === segmentsGeneration) notice(error.message, true);
  }
}

async function loadWorkspace() {
  const generation = segmentsGeneration;
  const me = await api("/api/me");
  if (generation !== segmentsGeneration) return;
  currentUserId = me.user?.id;
  if (pendingInvite) await acceptPendingInvite();
  if (generation !== segmentsGeneration) return;
  const membership = await api("/api/workspace", "POST");
  currentRole = membership.role;
  byId("time-zone-form").elements.time_zone.value = membership.time_zone ?? "";
  timeZoneControls();
  const operationsVisible = currentRole === "owner" || currentRole === "admin";
  byId("operations-section").hidden = !operationsVisible;
  if (operationsVisible) void loadOperations();
  byId("members-section").hidden = currentRole !== "owner";
  if (currentRole === "owner") void loadMembers();
  if (generation !== segmentsGeneration) return;
  const [accounts, settings] = await Promise.all([api("/api/connections"), api("/api/rules")]);
  if (generation !== segmentsGeneration) return;
  connections = accounts.connections;
  const selectedConnection = form.elements.connection_id.value;
  byId("startup").hidden = true;
  byId("retry-load").hidden = true;
  byId("account-count").textContent = connections.length;
  byId("rule-count").textContent = settings.rules.length;
  byId("rule-fields").disabled = connections.length === 0;
  byId("save-rule").disabled = connections.length === 0;
  byId("new-rule").disabled = connections.length === 0;
  byId("editor-empty").hidden = connections.length > 0;
  byId("delivery-title").textContent = me.global_send_enabled
    ? "자동 발송을 시작할 수 있습니다"
    : "전체 발송이 중지되어 있습니다";
  byId("delivery-banner").classList.toggle("enabled", me.global_send_enabled);

  byId("auth").hidden = true;
  byId("workspace").hidden = false;
  byId("logout").hidden = false;
  const connectAvailable = me.instagram_connect_available === true;
  byId("delivery-status").textContent = me.global_send_enabled
    ? "계정별로 발송을 켜고 규칙을 활성화하면 자동화를 시작합니다."
    : connectAvailable
      ? "계정 연결과 규칙 저장은 가능합니다. 전체 발송이 재개되기 전에는 메시지가 전송되지 않습니다."
      : "전체 발송이 재개되기 전에는 메시지가 전송되지 않습니다. 새 Instagram 연결은 현재 제한됩니다.";
  byId("connect").disabled = !connectAvailable;
  byId("connect-help").hidden = connectAvailable;
  byId("connect-help").textContent = connectAvailable ? "" : errors.instagram_public_access_restricted;
  byId("connections").replaceChildren();
  form.elements.connection_id.replaceChildren();
  if (!connections.length)
    byId("connections").append(
      connectAvailable
        ? emptyState("첫 Instagram 계정을 연결하세요", "관리하는 전문 계정을 연결하면 댓글 자동화를 만들 수 있습니다.")
        : emptyState("새 Instagram 계정을 연결할 수 없습니다", "위의 연결 제한 사유를 확인해 주세요."),
    );
  for (const account of connections) {
    const item = node("div", "");
    item.className = "item";
    item.append(node("strong", account.username ?? account.account_id));
    const credentialStatus = ["missing", "expired", "valid"].includes(account.credential_status)
      ? account.credential_status
      : !account.token_registered
        ? "missing"
        : Date.parse(account.token_expires_at) > Date.now()
          ? "valid"
          : "expired";
    const state = node("div", "", "badges");
    state.append(
      badge(
        credentialStatus === "valid" ? "토큰 만료 전" : credentialStatus === "expired" ? "토큰 만료" : "토큰 없음",
        credentialStatus === "valid" ? "" : "warning",
      ),
      badge(
        account.active ? "수신 설정 켜짐" : "수신 설정 꺼짐",
        account.active && credentialStatus === "valid" ? "success" : "",
      ),
      badge(
        account.send_enabled ? "발송 설정 켜짐" : "발송 설정 꺼짐",
        account.send_enabled && credentialStatus === "valid" ? "success" : "",
      ),
    );
    item.append(state);
    const inboxToggle = node("button", account.inbox_enabled ? "DM 보관 끄기" : "DM 보관 켜기", "secondary");
    inboxToggle.addEventListener("click", () => {
      if (
        !account.inbox_enabled &&
        !confirm(
          "지금부터 받은 텍스트 DM과 확인 버튼 응답을 인박스에 보관할까요? 기존 수동 삭제 정책이 적용됩니다. 과거 메시지는 가져오지 않습니다.",
        )
      )
        return;
      const generation = segmentsGeneration;
      void action(inboxToggle, async () => {
        const result = await api(`/api/connections/${account.id}/inbox`, "PUT", { enabled: !account.inbox_enabled });
        if (generation !== segmentsGeneration) return;
        account.inbox_enabled = result.enabled;
        notice(result.enabled ? "이 계정의 새 DM 보관을 켰습니다." : "새 DM 보관을 껐습니다. 기존 기록은 유지됩니다.");
      }).then(() => {
        if (generation === segmentsGeneration)
          inboxToggle.textContent = account.inbox_enabled ? "DM 보관 끄기" : "DM 보관 켜기";
      });
    });
    item.append(inboxToggle);
    item.append(
      node(
        "p",
        credentialStatus === "valid"
          ? account.active
            ? `토큰 만료일: ${new Date(account.token_expires_at).toLocaleDateString("ko-KR")} · 만료 30일 전부터 갱신을 시도합니다. 철회·권한·구독 여부는 확인되지 않았습니다.`
            : `토큰 만료일: ${new Date(account.token_expires_at).toLocaleDateString("ko-KR")} · 수신 중지 중에는 갱신하지 않습니다. 철회·권한·구독 여부는 확인되지 않았습니다.`
          : `${credentialStatus === "expired" ? "토큰이 만료됐습니다." : "연결 토큰이 없습니다."} 상단의 '계정 연결'에서 같은 Instagram 계정을 다시 선택해 주세요.`,
        "hint",
      ),
    );
    const healthStatus = node("p", "Meta 계정과 웹훅 구독 상태는 아직 확인하지 않았습니다.", "hint");
    healthStatus.setAttribute("role", "status");
    const healthButton = node("button", "Meta 상태 확인", "secondary");
    healthButton.disabled = credentialStatus !== "valid";
    healthButton.dataset.loadingLabel = "확인 중…";
    healthButton.addEventListener("click", () =>
      action(healthButton, async () => {
        const result = await api(`/api/connections/${account.id}/health`);
        const message = {
          fields_present:
            "Meta가 이 계정의 댓글·DM·확인 버튼 구독 필드를 반환했습니다. 이 앱으로 실제 이벤트가 오는지는 별도로 확인해야 합니다.",
          fields_missing:
            "Meta 응답에서 필수 웹훅 구독 필드가 모두 확인되지 않았습니다. 같은 Instagram 계정을 다시 연결해 주세요.",
          reconnect_required:
            "Meta가 계정 접근이나 앱 권한을 거부했습니다. 앱 권한을 확인하고 필요한 경우 같은 Instagram 계정을 다시 연결해 주세요.",
          unverified: "Meta 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
          expired: "연결 토큰이 만료됐습니다. 같은 Instagram 계정을 다시 연결해 주세요.",
          missing: "연결 토큰이 없습니다. 같은 Instagram 계정을 다시 연결해 주세요.",
        }[result.status];
        healthStatus.textContent = message
          ? `${new Date(result.checked_at).toLocaleTimeString("ko-KR")} 확인 · ${message}`
          : "Meta 상태 응답을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.";
      }),
    );
    item.append(healthButton, healthStatus);
    for (const [label, active, send_enabled] of [
      [account.send_enabled ? "발송 끄기" : "발송 켜기", true, !account.send_enabled],
      [account.active ? "수신 중지" : "수신 재개", !account.active, false],
    ]) {
      const button = node("button", label);
      button.className = "secondary";
      button.disabled = credentialStatus !== "valid" && (active || send_enabled);
      button.addEventListener("click", () =>
        action(button, async () => {
          await api(`/api/connections/${account.id}`, "PATCH", { active, send_enabled });
          await loadWorkspace();
        }),
      );
      item.append(button);
    }
    const disconnect = node("button", "연결 해제");
    disconnect.className = "secondary danger";
    disconnect.addEventListener("click", () =>
      action(disconnect, async () => {
        if (
          !confirm(
            "이 계정의 수신·발송을 중지하고 저장한 토큰을 삭제할까요? 해제한 뒤에는 이 계정의 '데이터 삭제'에서 기존 기록을 삭제할 수 있습니다.",
          )
        )
          return;
        await api(`/api/connections/${account.id}`, "DELETE");
        await loadWorkspace();
      }),
    );
    item.append(disconnect, connectionData(account, generation));
    byId("connections").append(item);
    const option = node("option", account.username ?? account.account_id);
    option.value = account.id;
    form.elements.connection_id.append(option);
  }
  if (connections.some((account) => account.id === selectedConnection))
    form.elements.connection_id.value = selectedConnection;
  byId("rules").replaceChildren();
  if (!settings.rules.length)
    byId("rules").append(
      emptyState(
        "아직 만든 규칙이 없습니다",
        connections.length
          ? "오른쪽 설정에서 첫 규칙을 만들어 보세요. 모바일에서는 아래로 내려가면 됩니다."
          : "계정을 먼저 연결한 뒤 첫 규칙을 만들어 보세요.",
      ),
    );
  for (const rule of settings.rules) {
    const item = node("div", "");
    item.className = "item";
    item.dataset.ruleId = rule.id;
    item.classList.toggle("active-rule", rule.id === editingRuleId);
    const target = node("div", "", "rule-target");
    target.append(node("strong", "게시물 정보를 불러오는 중…"));
    item.append(target);
    observeRuleMedia(target, rule);
    const state = node("div", "", "badges");
    state.append(
      badge(rule.enabled ? "활성" : "중지", rule.enabled ? "success" : ""),
      badge(rule.follow_gate_enabled ? "팔로우 확인" : "바로 답장"),
    );
    item.append(
      state,
      node(
        "p",
        rule.match_mode === "all"
          ? "모든 댓글"
          : `${rule.match_mode === "exact" ? "정확히 일치" : "키워드 포함"} · ${(rule.keywords.length ? rule.keywords : [rule.keyword]).join(", ")}`,
        "rule-summary",
      ),
    );
    const button = node("button", "수정");
    button.className = "secondary";
    button.addEventListener("click", () => {
      if (!canDiscardRule()) return;
      dirty = false;
      editingRuleId = rule.id;
      form.elements.connection_id.disabled = true;

      for (const name of [
        "connection_id",
        "media_id",
        "match_mode",
        "private_reply_text",
        "follower_reply_text",
        "non_follower_reply_text",
        "confirmation_keyword",
      ])
        form.elements[name].value = rule[name];
      form.elements.confirmation_button_title.value = rule.confirmation_button_title || "확인";
      form.elements.confirmation_button_enabled.checked = Boolean(rule.confirmation_button_title);
      form.elements.keywords.value = (rule.keywords.length ? rule.keywords : [rule.keyword]).join("\n");
      form.elements.excluded_keywords.value = rule.excluded_keywords.join("\n");
      form.elements.enabled.checked = rule.enabled;
      form.elements.follow_gate_enabled.checked = rule.follow_gate_enabled;
      formConditions();
      editorState("계정과 게시물은 고정됩니다. 댓글 조건과 문구를 수정하세요.");
      for (const element of byId("rules").children)
        element.classList.toggle("active-rule", element.dataset.ruleId === rule.id);
      void loadMedia();
      focusEditor();
    });
    item.append(button);
    byId("rules").append(item);
  }
  formConditions();
  void loadMedia();
  initializeContacts();
  initializeInbox();
  void loadContactSegments();
  await loadContactFields();
  if (generation !== segmentsGeneration) return;
  if (!contactsDirty.size && !contactsSaving) void loadContacts();
  try {
    await loadActivity();
  } catch (error) {
    if (generation !== segmentsGeneration) return;
    if (error.status === 401) throw error;
    byId("activity").replaceChildren(
      emptyState(
        "처리 내역을 불러오지 못했습니다",
        "새로고침을 눌러 다시 시도해 주세요. 계정과 규칙 설정은 계속할 수 있습니다.",
      ),
    );
  }
}

function mediaKey(connectionId, mediaId) {
  return `${connectionId}:${mediaId}`;
}
function mediaTitle(media) {
  return media.caption.trim() || (media.media_type === "VIDEO" ? "내용 없는 릴스·동영상" : "내용 없는 게시물");
}
function mediaSummary(media) {
  const content = node("div", "", "media-copy");
  content.append(node("strong", mediaTitle(media)));
  const date = media.timestamp ? new Date(media.timestamp).toLocaleDateString("ko-KR") : "날짜 정보 없음";
  const kind = { IMAGE: "사진", VIDEO: "동영상", CAROUSEL_ALBUM: "여러 장" }[media.media_type];
  content.append(node("span", `${date} · ${kind || "게시물"}`));
  return content;
}
function mediaImage(media) {
  if (!media.image_url) return node("span", "사진 없음", "media-placeholder");
  const image = document.createElement("img");
  image.src = media.image_url;
  image.alt = "";
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => image.replaceWith(node("span", "사진 없음", "media-placeholder")), {
    once: true,
  });
  return image;
}
function showSelected(media) {
  const target = byId("selected-media");
  target.replaceChildren(mediaImage(media), mediaSummary(media));
  if (media.permalink) {
    const link = node("a", "Instagram에서 보기");
    link.href = media.permalink;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    target.append(link);
  }
  target.hidden = false;
}
function resetMedia() {
  mediaGeneration++;
  mediaAfter = null;
  mediaBusy = false;
  byId("media-more").hidden = true;
  byId("media-more").disabled = false;
  byId("media-reload").disabled = false;
  byId("media-list").replaceChildren();
  byId("selected-media").replaceChildren();
  byId("selected-media").hidden = true;
  byId("media-status").textContent = "";
}
async function getMedia(connectionId, mediaId, force = false) {
  const key = mediaKey(connectionId, mediaId);
  if (!force && mediaCache.has(key)) return mediaCache.get(key);
  const session = mediaSession;
  const result = await api(`/api/connections/${connectionId}/media/${mediaId}`);
  if (session !== mediaSession) throw new Error("로그인 상태가 변경되었습니다.");
  const media = result.media[0];
  mediaCache.set(key, media);
  return media;
}
const ruleMediaObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const target = entry.target;
      ruleMediaObserver.unobserve(target);
      const rule = target.rule;
      getMedia(rule.connection_id, rule.media_id)
        .then((media) => {
          if (!target.isConnected) return;
          target.replaceChildren(mediaImage(media), mediaSummary(media));
        })
        .catch(() => {
          if (target.isConnected)
            target.replaceChildren(
              node("strong", "게시물 정보를 확인할 수 없습니다"),
              node("span", "규칙 수정에서 다시 확인하세요."),
            );
        });
    }
  },
  { rootMargin: "100px" },
);
function observeRuleMedia(target, rule) {
  target.rule = rule;
  ruleMediaObserver.observe(target);
}
async function loadMedia(more = false, force = false) {
  if (more && (mediaBusy || !mediaAfter)) return;
  if (!more) resetMedia();
  const generation = mediaGeneration;
  const connectionId = form.elements.connection_id.value;
  if (!connectionId) return;
  const previousSelection = mediaCache.get(mediaKey(connectionId, form.elements.media_id.value));
  if (previousSelection) showSelected(previousSelection);
  mediaBusy = true;
  byId("media-reload").disabled = true;
  byId("media-more").disabled = true;
  byId("media-status").textContent = "게시물을 불러오고 있습니다…";
  try {
    if (editingRuleId) {
      const selected = await getMedia(connectionId, form.elements.media_id.value, force);
      if (generation !== mediaGeneration) return;
      showSelected(selected);
      byId("media-status").textContent = "이 규칙의 게시물은 고정됩니다.";
      return;
    }
    const page = await api(
      `/api/connections/${connectionId}/media${more ? `?after=${encodeURIComponent(mediaAfter)}` : ""}`,
    );
    if (generation !== mediaGeneration) return;
    for (const media of page.media) {
      mediaCache.set(mediaKey(connectionId, media.id), media);
      if ([...byId("media-list").children].some((element) => element.dataset.mediaId === media.id)) continue;
      const button = node("button", "", "media-option");
      button.type = "button";
      button.dataset.mediaId = media.id;
      button.setAttribute("aria-pressed", String(form.elements.media_id.value === media.id));
      button.append(mediaImage(media), mediaSummary(media));
      button.addEventListener("click", () => {
        if (editingRuleId || form.elements.connection_id.value !== connectionId) return;
        form.elements.media_id.value = media.id;
        for (const option of byId("media-list").children)
          option.setAttribute("aria-pressed", String(option === button));
        showSelected(media);
        byId("media-status").textContent = "게시물을 선택했습니다. 댓글 조건과 메시지를 작성하세요.";
        markDirty();
      });
      byId("media-list").append(button);
    }
    mediaAfter = page.after;
    byId("media-more").hidden = !mediaAfter;
    byId("media-status").textContent = byId("media-list").children.length
      ? "답장할 게시물을 선택하세요. 오래된 게시물은 더 불러올 수 있습니다."
      : mediaAfter
        ? "이 페이지에는 지원하는 게시물이 없습니다. 이전 게시물을 더 불러와 주세요."
        : "아직 선택할 게시물이 없습니다. 게시한 뒤 새로고침해 주세요.";
    const selected = mediaCache.get(mediaKey(connectionId, form.elements.media_id.value));
    if (selected) showSelected(selected);
  } catch (error) {
    if (generation !== mediaGeneration) return;
    if (editingRuleId && byId("selected-media").hidden) {
      const target = byId("selected-media");
      const identity = document.createElement("details");
      identity.append(node("summary", "게시물 식별정보"), node("code", form.elements.media_id.value));
      target.replaceChildren(node("strong", "현재 규칙에 저장한 게시물"), identity);
      target.hidden = false;
    }
    byId("media-status").textContent = editingRuleId
      ? `${error.message} 저장한 대상과 입력 내용은 유지됩니다.`
      : error.message;
  } finally {
    if (generation === mediaGeneration) {
      mediaBusy = false;
      byId("media-reload").disabled = false;
      byId("media-more").disabled = false;
    }
  }
}
form.elements.connection_id.addEventListener("change", () => {
  form.elements.media_id.value = "";
  void loadMedia();
});
byId("media-reload").addEventListener("click", () => {
  void loadMedia(false, true);
});
byId("media-more").addEventListener("click", () => void loadMedia(true));

byId("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const login = event.currentTarget;
  action(login.querySelector("button[type=submit]"), async () => {
    try {
      await api("/api/auth/login", "POST", {
        email: login.elements.email.value,
        password: login.elements.password.value,
      });
    } finally {
      login.elements.password.value = "";
    }
    inviteNoticeShown = false;
    await loadWorkspace();
    if (!inviteNoticeShown) notice("로그인했습니다.");
  });
});
byId("signup").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    const login = byId("login-form");
    if (!login.reportValidity()) return;
    try {
      await api("/api/auth/signup", "POST", {
        email: login.elements.email.value,
        password: login.elements.password.value,
      });
    } finally {
      login.elements.password.value = "";
    }
    notice("가입할 수 있는 이메일이면 인증 안내가 전송됩니다. 이메일을 확인한 뒤 로그인해 주세요.");
  }),
);
byId("resend-confirmation").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    const email = byId("email");
    if (!email.reportValidity()) return;
    await api("/api/auth/resend-confirmation", "POST", { email: email.value });
    notice("인증이 필요한 이메일이면 새 인증 메일을 보내드립니다. 메일을 확인해 주세요.");
  }),
);
let recoveryToken = null;
let authLinkNotice = null;
function showAuthMode(mode) {
  byId("login-form").hidden = mode !== "login";
  byId("recovery-request-form").hidden = mode !== "recover";
  byId("password-reset-form").hidden = mode !== "reset";
  byId("auth-title").textContent =
    mode === "reset" ? "새 비밀번호 설정" : mode === "recover" ? "비밀번호 찾기" : "내 계정으로 로그인";
}
byId("forgot-password").addEventListener("click", () => {
  byId("recovery-request-form").elements.email.value = byId("login-form").elements.email.value;
  showAuthMode("recover");
  byId("recovery-email").focus();
});
byId("recovery-back").addEventListener("click", () => {
  showAuthMode("login");
  byId("email").focus();
});
byId("reset-restart").addEventListener("click", () => {
  recoveryToken = null;
  byId("password-reset-form").reset();
  showAuthMode("recover");
  byId("recovery-email").focus();
});
byId("recovery-request-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const recovery = event.currentTarget;
  action(recovery.querySelector("button[type=submit]"), async () => {
    await api("/api/auth/recover", "POST", { email: recovery.elements.email.value });
    notice("가입한 이메일이면 변경 링크를 보내드립니다. 메일을 확인해 주세요.");
  });
});
byId("password-reset-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const reset = event.currentTarget;
  action(reset.querySelector("button[type=submit]"), async () => {
    if (!recoveryToken) throw new Error(errors.recovery_link_invalid);
    try {
      await api("/api/auth/reset-password", "POST", {
        access_token: recoveryToken,
        password: reset.elements.password.value,
      });
    } catch (error) {
      if (error.status === 401 || error.code === "password_updated_logout_unconfirmed") {
        recoveryToken = null;
        reset.reset();
        showAuthMode(error.status === 401 ? "recover" : "login");
      }
      throw error;
    }
    recoveryToken = null;
    reset.reset();
    showAuthMode("login");
    notice("비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.");
  });
});
byId("logout").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    if (!canDiscard()) return;
    try {
      await api("/api/auth/logout", "POST");
    } finally {
      resetSession();
    }
    notice("로그아웃했습니다.");
  }),
);
byId("connect").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    if (!canDiscard()) return;
    const result = await api("/api/instagram/connect", "POST");
    const url = new URL(result.url);
    if (url.protocol !== "https:" || url.hostname !== "www.instagram.com" || url.pathname !== "/oauth/authorize")
      throw new Error("계정 연결 주소를 확인할 수 없습니다.");
    dirty = false;
    location.assign(url.href);
  }),
);
byId("invite-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const inviteForm = event.currentTarget;
  action(inviteForm.querySelector("button[type=submit]"), async () => {
    const created = await api("/api/workspace/invites", "POST", {
      email: inviteForm.elements.email.value,
      role: inviteForm.elements.role.value,
    });
    byId("invite-link").value = created.link;
    byId("invite-result").hidden = false;
    byId("invite-link").select();
    inviteForm.reset();
    notice(`${created.email} 초대 링크를 만들었습니다. 이 화면을 벗어나면 링크를 다시 볼 수 없습니다.`);
    await loadMembers();
  });
});
// The browser's zone names are only suggestions; the server accepts the names PostgreSQL knows.
try {
  byId("time-zone-options").replaceChildren(...Intl.supportedValuesOf("timeZone").map((zone) => new Option(zone)));
} catch {
  // Without the list the field still accepts a typed name.
}
byId("time-zone-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const zoneForm = event.currentTarget;
  action(zoneForm.querySelector("button[type=submit]"), async () => {
    const saved = await api("/api/workspace/settings", "PUT", { time_zone: zoneForm.elements.time_zone.value.trim() });
    zoneForm.elements.time_zone.value = saved.time_zone;
    notice(`시간대를 저장했습니다(${saved.time_zone}). 지금부터 정한 시각까지 기다리기 시작하는 실행에 적용됩니다.`);
  });
});
byId("operations-refresh").addEventListener("click", (event) => action(event.currentTarget, loadOperations));
byId("copy-invite").addEventListener("click", async () => {
  const link = byId("invite-link");
  try {
    await navigator.clipboard.writeText(link.value);
    notice("초대 링크를 복사했습니다.");
  } catch {
    link.select();
    notice("링크를 선택했습니다. 직접 복사해 주세요.", true);
  }
});
byId("export-data").addEventListener("click", (event) =>
  action(event.currentTarget, async () => {
    const generation = segmentsGeneration;
    // Saved as the server's text: parsing it would round bigint IDs above 2^53.
    const text = await api("/api/workspace/export", "GET", undefined, true, true);
    if (generation !== segmentsGeneration) return;
    const exportedOn = /"exported_at":"(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `auto-chatter-export-${exportedOn}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    notice("작업 공간 데이터를 JSON 파일로 저장했습니다. 댓글·메시지 내용이 들어 있으니 안전한 곳에 보관해 주세요.");
  }),
);
byId("new-rule").addEventListener("click", () => {
  if (!canDiscardRule()) return;
  dirty = false;
  editingRuleId = undefined;
  form.elements.connection_id.disabled = false;
  form.reset();
  form.elements.media_id.value = "";
  resetMedia();
  formConditions();
  editorState("새 규칙을 작성하고 저장하세요.");
  for (const element of byId("rules").children) element.classList.remove("active-rule");
  void loadMedia();
  focusEditor();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const included = data.match_mode === "all" ? [] : list(data.keywords ?? "");
  const excluded = list(data.excluded_keywords ?? "");
  for (const [name, values] of [
    ["keywords", included],
    ["excluded_keywords", excluded],
  ]) {
    const required = name === "keywords" && data.match_mode !== "all";
    form.elements[name].setCustomValidity(
      (required && !values.length) || values.length > 20 || values.some((value) => value.length > 100)
        ? "키워드를 한 줄에 하나씩, 각각 100자 이내로 최대 20개 입력해 주세요."
        : "",
    );
  }
  if (!form.elements.media_id.value) {
    byId("media-status").textContent = "답장할 게시물을 먼저 선택해 주세요.";
    focusEditor();
    return;
  }
  if (!form.reportValidity()) return;
  const payload = {
    ...data,
    ...(editingRuleId ? { id: editingRuleId } : {}),
    connection_id: form.elements.connection_id.value,
    keywords: included,
    excluded_keywords: excluded,
    enabled: form.elements.enabled.checked,
    follow_gate_enabled: form.elements.follow_gate_enabled.checked,
    confirmation_keyword: form.elements.follow_gate_enabled.checked ? data.confirmation_keyword : "확인",
    confirmation_button_title:
      form.elements.follow_gate_enabled.checked && form.elements.confirmation_button_enabled.checked
        ? data.confirmation_button_title
        : "",
  };
  action(byId("save-rule"), async () => {
    byId("rule-fields").disabled = true;
    editorState("규칙을 저장하고 있습니다…");
    try {
      const saved = await api("/api/rules", "PUT", payload);
      editingRuleId = saved.id;
      dirty = false;
      form.elements.connection_id.disabled = true;

      editorState("저장했습니다. 새로 수신하는 댓글부터 적용됩니다.");
      notice("규칙을 저장했습니다.");
      try {
        await loadWorkspace();
      } catch (error) {
        notice(`저장은 완료했습니다. ${error.message}`, true);
      }
    } catch (error) {
      editorState("저장하지 못했습니다. 입력한 내용은 유지됩니다.");
      throw error;
    } finally {
      byId("rule-fields").disabled = connections.length === 0;
    }
  });
});
async function start() {
  const instagramResult = new URLSearchParams(location.search).get("instagram");
  if (instagramResult === "instagram_authorization_denied" || instagramResult === "instagram_permissions_required") {
    authLinkNotice = errors[instagramResult];
    history.replaceState(null, "", location.pathname + location.hash);
  }
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has("invite")) {
    rememberInvite(fragment.get("invite"));
    history.replaceState(null, "", location.pathname + location.search);
  } else if (!pendingInvite) {
    try {
      pendingInvite = sessionStorage.getItem("pending-invite");
    } catch {
      pendingInvite = null;
    }
  }
  if (fragment.has("access_token") || fragment.has("error") || fragment.has("type")) {
    history.replaceState(null, "", location.pathname + location.search);
    if (fragment.get("type") === "recovery" && fragment.get("access_token")) {
      recoveryToken = fragment.get("access_token");
      showAuthMode("reset");
    } else if (fragment.has("error") || (fragment.get("type") === "signup" && !fragment.get("access_token")))
      authLinkNotice =
        "인증 또는 변경 링크가 만료되었거나 유효하지 않습니다. 인증 메일을 다시 받거나 비밀번호 변경 링크를 요청해 주세요.";
    else if (fragment.get("type") === "signup") authLinkNotice = "인증 링크를 처리했습니다. 로그인해 주세요.";
  }
  byId("retry-load").hidden = true;
  byId("startup").hidden = false;
  try {
    if (location.protocol === "file:")
      throw new Error("미리보기에서는 로그인할 수 없습니다. 서비스 웹사이트에서 이용해 주세요.");
    if (recoveryToken) {
      byId("auth").hidden = false;
      byId("new-password").focus();
      return;
    }
    await loadWorkspace();
  } catch (error) {
    if (error.status !== 401) {
      notice(error.message, true);
      byId("retry-load").hidden = location.protocol !== "file:" ? false : true;
    }
    byId("auth").hidden = false;
    if (error.status === 401 && pendingInvite)
      authLinkNotice ??=
        "초대 링크를 받았습니다. 초대받은 이메일로 로그인하면 작업 공간에 참여합니다. 새로 가입했다면 이메일 인증을 마친 뒤 초대 링크를 다시 열어 주세요.";
  } finally {
    byId("startup").hidden = true;
    if (authLinkNotice)
      notice(
        authLinkNotice,
        authLinkNotice.startsWith("인증 또는 변경 링크") ||
          instagramResult === "instagram_authorization_denied" ||
          instagramResult === "instagram_permissions_required",
      );
  }
}
byId("retry-load").addEventListener("click", (event) => action(event.currentTarget, start));
formConditions();
void start();

async function loadActivity() {
  const generation = segmentsGeneration;
  // A read that started before a data deletion must not replace the list reloaded after it.
  const request = ++activityRequest;
  let result;
  try {
    result = await api("/api/activity");
  } catch (error) {
    if (request !== activityRequest) return;
    throw error;
  }
  if (generation !== segmentsGeneration || request !== activityRequest) return;
  const labels = {
    pending: "대기",
    waiting: "응답 대기",
    sending: "발송 중",
    sent: "발송 완료",
    blocked: "조건 미충족",
    failed: "발송 거절",
    unknown: "결과 불명확",
    following: "팔로우 확인",
    not_following: "미팔로우 확인",
  };
  byId("activity").replaceChildren();
  if (!result.activity.length)
    byId("activity").append(
      emptyState(
        "첫 댓글을 기다리고 있습니다",
        "활성 규칙에 맞는 댓글을 받으면 첫 DM과 후속 메시지의 처리 상태가 여기에 표시됩니다.",
      ),
    );
  for (const row of result.activity) {
    const item = node(
      "div",
      `게시물 ${row.media_id} · 첫 DM: ${labels[row.first_reply_status] ?? row.first_reply_status}`,
    );
    item.className = "item";
    if (row.follow_reply_status)
      item.append(
        node(
          "p",
          `후속 DM: ${labels[row.follow_reply_status] ?? row.follow_reply_status} · ${row.follow_status === "unknown" ? "팔로우 확인 전 또는 확인 불가" : labels[row.follow_status]}`,
        ),
      );
    const reason = row.follow_reply_error ?? row.first_reply_error;
    if (reason) {
      const reasons = {
        follow_status_unavailable: "팔로우 상태를 확인하지 못해 잠시 후 다시 조회합니다.",
        response_window_expired: "응답 가능 시간이 지나 새 확인 메시지를 기다립니다.",
        follow_recipient_unavailable: "첫 DM은 발송했지만 후속 대상을 확인하지 못했습니다. 운영자에게 문의해 주세요.",
        send_outcome_unknown: "전송 결과를 확인할 수 없어 재발송을 중지했습니다.",
        worker_interrupted: "전송 중 처리가 중단돼 결과 확인이 필요합니다.",
        inactive_rule: "규칙이 중지됐습니다.",
        inactive_connection: "계정 수신이 중지됐습니다.",
        delivery_not_permitted: "계정·규칙 또는 응답 가능 시간을 확인해 주세요.",
        connection_paused: "요청 제한으로 잠시 대기합니다.",
        contact_paused: "이 연락처의 자동화가 중지되어 대기합니다.",
        connection_changed: "계정 연결 설정이 변경되어 중지됐습니다.",
      };
      item.append(
        node(
          "p",
          reasons[reason] ??
            (reason.startsWith("meta_error_")
              ? "Instagram이 요청을 제한하거나 거절했습니다."
              : "발송 조건을 확인할 수 없습니다. 연결과 규칙을 확인해 주세요."),
        ),
      );
    }
    byId("activity").append(item);
  }
}
byId("refresh-activity").addEventListener("click", (event) => action(event.currentTarget, loadActivity));

function initializeContacts() {
  const select = byId("contacts-filter").elements.connection_id;
  const previous = select.value;
  select.replaceChildren(new Option("모든 계정", ""));
  for (const connection of connections)
    select.add(new Option(connection.username || connection.account_id, connection.id));
  if (connections.some((connection) => connection.id === previous)) select.value = previous;
}
function canReloadContacts() {
  return (
    !segmentBusy &&
    !fieldBusy &&
    !contactsSaving &&
    (!contactsDirty.size || confirm("저장하지 않은 연락처 변경 사항을 버릴까요?"))
  );
}
function contactCard(contact) {
  const item = node("article", "", "contact-row");
  item.dataset.connectionId = contact.connection_id;
  const summary = node("div", "", "contact-summary");
  summary.append(
    node("h3", `참여자 ${contact.sender_id}`),
    node(
      "p",
      `연결 계정 ${contact.username ? `@${contact.username}` : "이름 확인 전"} · 댓글 ${contact.comment_count}개`,
      "hint",
    ),
  );
  const automation = node("div");
  const automationStatus = badge("");
  const toggle = node("button", "", "secondary");
  toggle.type = "button";
  toggle.dataset.automationToggle = "";
  const renderAutomation = () => {
    automationStatus.textContent = contact.automation_paused ? "자동화 중지 중" : "자동화 허용";
    automationStatus.className = `badge${contact.automation_paused ? " warning" : ""}`;
    toggle.textContent = contact.automation_paused ? "자동화 재개" : "자동화 중지";
    toggle.setAttribute("aria-label", `${contact.sender_id} ${toggle.textContent}`);
  };
  renderAutomation();
  toggle.addEventListener("click", () => {
    if (contactsSaving || contactsBusy || fieldBusy || segmentBusy) return;
    const paused = !contact.automation_paused;
    if (
      !paused &&
      !confirm("자동화를 재개할까요? 응답 가능 시간이 남은 대기 메시지는 다음 워커 실행에서 발송될 수 있습니다.")
    )
      return;
    const generation = contactsGeneration;
    void action(toggle, async () => {
      contactsSaving = true;
      try {
        const saved = await api(
          `/api/connections/${contact.connection_id}/contacts/${encodeURIComponent(contact.sender_id)}/automation`,
          "PUT",
          { paused },
        );
        if (generation !== contactsGeneration) return;
        contact.automation_paused = saved.automation_paused;
        renderAutomation();
        notice(
          paused
            ? "자동화를 중지했습니다. 이미 전송 중인 메시지는 취소할 수 없습니다."
            : "자동화를 재개했습니다. 대기 메시지는 기존 발송 정책을 다시 확인합니다.",
        );
      } catch (error) {
        if (generation === contactsGeneration) throw error;
      } finally {
        if (generation === contactsGeneration) contactsSaving = false;
      }
    }).finally(() => {
      if (generation === contactsGeneration) renderAutomation();
    });
  });
  automation.append(
    automationStatus,
    node("p", "중지 중에는 새 확인 답장을 자동 처리하지 않습니다. 대기 발송은 보관됩니다.", "hint"),
    toggle,
  );
  summary.append(automation);
  const date = new Date(contact.last_comment_at);
  summary.append(node("p", `최근 댓글 · ${date.toLocaleString("ko-KR")}`, "hint"));
  const tags = node("div", "", "badges");
  for (const tag of contact.tags) tags.append(badge(tag));
  if (!contact.tags.length) tags.append(node("span", "태그 없음", "hint"));
  summary.append(tags);
  const edit = document.createElement("details");
  edit.append(node("summary", "태그 편집"));
  const editor = document.createElement("form");
  const label = node("label", "태그");
  const input = document.createElement("textarea");
  input.rows = 3;
  input.maxLength = 1000;
  input.value = contact.tags.join("\n");
  label.append(input);
  const hint = node(
    "p",
    "한 줄에 하나씩, 최대 20개·각 40자. 대소문자는 구분하지 않습니다. 모두 지우고 저장하면 태그가 제거됩니다.",
    "hint",
  );
  const hintId = `contact-help-${contact.connection_id}-${contact.sender_id}`;
  hint.id = hintId;
  input.setAttribute("aria-describedby", hintId);
  const save = node("button", "태그 저장");
  save.type = "submit";
  save.dataset.loadingLabel = "저장 중…";
  editor.append(label, hint, save);
  const key = `${contact.connection_id}:${contact.sender_id}`;
  input.addEventListener("input", () => {
    if (input.value !== contact.tags.join("\n")) contactsDirty.add(key);
    else contactsDirty.delete(key);
    input.setCustomValidity("");
  });
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    if (contactsSaving || contactsBusy || fieldBusy) return;
    const values = list(input.value);
    if (values.length > 20 || values.some((value) => value.length > 40)) {
      input.setCustomValidity(errors.invalid_contact_tags);
      input.reportValidity();
      return;
    }
    const generation = contactsGeneration;
    void action(save, async () => {
      contactsSaving = true;
      input.disabled = true;
      try {
        const result = await api(
          `/api/connections/${contact.connection_id}/contacts/${encodeURIComponent(contact.sender_id)}`,
          "PATCH",
          {
            tags: values,
          },
        );
        if (generation !== contactsGeneration) return;
        contact.tags = result.tags;
        input.value = result.tags.join("\n");
        contactsDirty.delete(key);
        tags.replaceChildren(...result.tags.map((value) => badge(value)));
        if (!result.tags.length) tags.append(node("span", "태그 없음", "hint"));
        notice("태그를 저장했습니다. 필터 결과를 갱신하려면 필터를 다시 적용해 주세요.");
      } finally {
        input.disabled = false;
        if (generation === contactsGeneration) contactsSaving = false;
      }
    });
  });
  edit.append(editor);
  const editors = node("div");
  editors.append(edit);
  item.append(summary, editors);
  const fieldSummary = node("div", "", "contact-field-values");
  const fieldNames = new Map(contactFields.map((field) => [field.id, field]));
  for (const [id, value] of Object.entries(contact.fields || {})) {
    const field = fieldNames.get(id);
    if (field) fieldSummary.append(node("p", `${field.name} · ${displayFieldValue(value)}`, "hint"));
  }
  summary.append(fieldSummary);
  if (contactFields.length) editors.append(contactFieldEditor(contact, fieldSummary));
  return item;
}
function clearContactResults() {
  contactsGeneration++;
  contactsAfter = null;
  contactsQuery = "";
  contactsDirty.clear();
  purgedContactConnections.clear();
  contactsBusy = false;
  byId("contacts-list").replaceChildren();
  byId("contacts-more").hidden = true;
}
async function loadContacts(more = false) {
  if (contactsSaving || (more && (contactsBusy || !contactsAfter))) return;
  let fieldCondition;
  if (!more && !activeSegmentId) {
    try {
      fieldCondition = contactFieldCondition();
    } catch (error) {
      if (!contactFields.some((field) => field.id === byId("contacts-filter").elements.field_id.value)) {
        clearContactResults();
      }
      byId("contacts-status").textContent = error.message;
      return;
    }
  }
  if (!more) {
    contactsGeneration++;
    contactsDirty.clear();
    purgedContactConnections.clear();
    contactsAfter = null;
    const fields = byId("contacts-filter").elements;
    const query = new URLSearchParams();
    if (activeSegmentId) query.set("segment_id", activeSegmentId);
    else {
      if (fields.connection_id.value) query.set("connection_id", fields.connection_id.value);
      if (fields.tag.value.trim()) query.set("tag", fields.tag.value.trim());
      const condition = fieldCondition;
      if (condition) {
        query.set("field_id", condition.field_id);
        query.set("field_operator", condition.field_operator);
        if (condition.field_operator === "eq") query.set("field_value", JSON.stringify(condition.field_value));
      }
    }
    contactsQuery = query.toString();
    byId("contacts-list").replaceChildren();
    byId("contacts-more").hidden = true;
  }
  const generation = contactsGeneration;
  contactsBusy = true;
  byId("contacts-more").disabled = true;
  byId("contacts-status").textContent = "연락처를 불러오고 있습니다…";
  const query = new URLSearchParams(contactsQuery);
  if (more) query.set("after", contactsAfter);
  try {
    const page = await api(`/api/contacts?${query}`);
    if (generation !== contactsGeneration) return;
    for (const contact of page.contacts)
      if (!purgedContactConnections.has(contact.connection_id)) byId("contacts-list").append(contactCard(contact));
    contactsAfter = page.after;
    byId("contacts-more").hidden = !contactsAfter;
    byId("contacts-status").textContent =
      `연락처 ${byId("contacts-list").children.length}명을 표시합니다. 같은 계정의 반복 댓글은 한 명으로 묶습니다.`;
    if (!byId("contacts-list").children.length)
      byId("contacts-list").append(
        emptyState("표시할 연락처가 없습니다", "댓글을 받거나 태그·계정 필터를 바꾼 뒤 다시 불러와 주세요."),
      );
  } catch (error) {
    if (generation === contactsGeneration)
      byId("contacts-status").textContent = `${error.message} 새로고침으로 다시 시도할 수 있습니다.`;
  } finally {
    if (generation === contactsGeneration) {
      contactsBusy = false;
      byId("contacts-more").disabled = false;
    }
  }
}
byId("contacts-filter").addEventListener("submit", (event) => {
  event.preventDefault();
  if (canReloadContacts()) void loadContacts();
});
byId("contacts-reload").addEventListener("click", async () => {
  if (contactsSaving || segmentBusy || fieldBusy) return;
  const generation = fieldsGeneration;
  if ((await loadContactFields()) && generation === fieldsGeneration && canReloadContacts()) {
    void loadContacts();
    void loadContactSegments();
  }
});
byId("contacts-more").addEventListener("click", () => {
  void loadContacts(true);
});

function segmentControls() {
  byId("contact-segment").disabled = segmentBusy;
  byId("segment-archive").disabled = segmentBusy || !activeSegmentId;
  byId("segment-save").elements.name.disabled = segmentBusy;
  byId("segment-save").querySelector("button").disabled = segmentBusy;
}
async function loadContactSegments(force = false) {
  if (segmentBusy && !force) return;
  const generation = segmentsGeneration;
  const request = ++segmentsRequest;
  try {
    const result = await api("/api/contact-segments");
    if (generation !== segmentsGeneration || request !== segmentsRequest) return;
    contactSegments = result.segments;
    const select = byId("contact-segment");
    select.replaceChildren(new Option("직접 조건 설정", ""));
    for (const segment of contactSegments) select.add(new Option(segment.name, segment.id));
    if (!contactSegments.some((segment) => segment.id === activeSegmentId)) activeSegmentId = "";
    select.value = activeSegmentId;
    segmentControls();
    byId("segments-status").textContent = contactSegments.length
      ? `저장된 필터 ${contactSegments.length}개. 조건에 맞는 연락처는 조회할 때 갱신됩니다.`
      : "자주 쓰는 계정·태그 조건을 필터로 저장해 보세요.";
  } catch (error) {
    if (generation === segmentsGeneration && request === segmentsRequest)
      byId("segments-status").textContent = `${error.message} 새로고침으로 다시 시도해 주세요.`;
  }
}
byId("contacts-filter").addEventListener("input", () => {
  activeSegmentId = "";
  byId("contact-segment").value = "";
  segmentControls();
});
byId("contact-segment").addEventListener("change", (event) => {
  if (!canReloadContacts()) {
    event.currentTarget.value = activeSegmentId;
    return;
  }
  const segment = contactSegments.find((value) => value.id === event.currentTarget.value);
  activeSegmentId = segment?.id || "";
  const fields = byId("contacts-filter").elements;
  fields.connection_id.value = segment?.connection_id || "";
  fields.tag.value = segment?.tag || "";
  fields.field_id.value = segment?.field_id || "";
  fields.field_operator.value = segment?.field_operator || "eq";
  fieldFilterControls();
  fields.field_value.value = segment?.field_operator === "eq" ? String(segment.field_value) : "";
  fields.field_boolean.value = segment?.field_value === false ? "false" : "true";
  segmentControls();
  void loadContacts();
});
byId("segment-save").addEventListener("input", () => {
  segmentNameDirty = Boolean(byId("segment-save").elements.name.value);
});
byId("segment-save").addEventListener("submit", (event) => {
  event.preventDefault();
  if (segmentBusy) return;
  const generation = segmentsGeneration;
  const fields = byId("contacts-filter").elements;
  const name = byId("segment-save").elements.name.value;
  const payload = { name, connection_id: fields.connection_id.value || null, tag: fields.tag.value.trim() || null };
  try {
    Object.assign(payload, contactFieldCondition());
  } catch (error) {
    notice(error.message, true);
    return;
  }
  void action(event.currentTarget.querySelector("button"), async () => {
    segmentBusy = true;
    segmentControls();
    try {
      await api("/api/contact-segments", "POST", payload);
      if (generation !== segmentsGeneration) return;
      byId("segment-save").reset();
      segmentNameDirty = false;
      await loadContactSegments(true);
      notice("필터를 저장했습니다. 저장된 필터에서 선택해 다시 사용할 수 있습니다.");
    } finally {
      if (generation === segmentsGeneration) {
        segmentBusy = false;
        segmentControls();
      }
    }
  }).finally(segmentControls);
});
byId("segment-archive").addEventListener("click", (event) => {
  if (
    !activeSegmentId ||
    segmentBusy ||
    contactsSaving ||
    !confirm("이 필터를 보관할까요? 연락처와 태그는 유지됩니다.")
  )
    return;
  const generation = segmentsGeneration;
  const id = activeSegmentId;
  const segment = contactSegments.find((value) => value.id === id);
  void action(event.currentTarget, async () => {
    segmentBusy = true;
    segmentControls();
    try {
      await api(`/api/contact-segments/${id}`, "DELETE");
      if (generation !== segmentsGeneration) return;
      if (segment && new URLSearchParams(contactsQuery).get("segment_id") === id) {
        const query = new URLSearchParams();
        if (segment.connection_id) query.set("connection_id", segment.connection_id);
        if (segment.tag) query.set("tag", segment.tag);
        if (segment.field_id) {
          query.set("field_id", segment.field_id);
          query.set("field_operator", segment.field_operator);
          if (segment.field_operator === "eq") query.set("field_value", JSON.stringify(segment.field_value));
        }
        contactsQuery = query.toString();
      }
      if (activeSegmentId === id) activeSegmentId = "";
      await loadContactSegments(true);
      if (!contactsDirty.size && !contactsSaving) await loadContacts();
      notice("필터를 보관했습니다. 연락처와 태그는 유지됩니다.");
    } finally {
      if (generation === segmentsGeneration) {
        segmentBusy = false;
        segmentControls();
      }
    }
  }).finally(segmentControls);
});

const fieldTypeLabels = { text: "텍스트", number: "숫자", boolean: "예 / 아니요", date: "날짜" };
function displayFieldValue(value) {
  return value === true ? "예" : value === false ? "아니요" : value === "" ? "빈 텍스트" : String(value);
}
function typedFieldValue(field, raw) {
  if (field.type === "number") {
    if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error(errors.invalid_field_value);
    return Number(raw);
  }
  if (field.type === "boolean") {
    if (!["true", "false"].includes(raw)) throw new Error(errors.invalid_field_value);
    return raw === "true";
  }
  return raw;
}
function configureFieldInput(input, field) {
  input.type = field?.type === "number" ? "number" : field?.type === "date" ? "date" : "text";
  input.step = "any";
  input.required = Boolean(field && field.type !== "text" && field.type !== "boolean");
  input.maxLength = 1000;
  input.placeholder =
    field?.type === "boolean"
      ? "true = 예, false = 아니요"
      : field?.type === "text"
        ? "빈 텍스트도 저장할 수 있습니다"
        : "";
}
function fieldFilterControls() {
  const fields = byId("contacts-filter").elements;
  const selected = Boolean(fields.field_id.value);
  byId("field-filter-operator").hidden = !selected;
  byId("field-filter-value").hidden = !selected || fields.field_operator.value !== "eq";
  const field = contactFields.find((field) => field.id === fields.field_id.value);
  configureFieldInput(fields.field_value, field);
  fields.field_value.required =
    selected && fields.field_operator.value === "eq" && Boolean(field && !["text", "boolean"].includes(field.type));
  fields.field_value.hidden = field?.type === "boolean";
  fields.field_boolean.hidden = field?.type !== "boolean";
}
function contactFieldCondition() {
  const fields = byId("contacts-filter").elements;
  if (!fields.field_id.value) return null;
  const field = contactFields.find((item) => item.id === fields.field_id.value);
  if (!field) throw new Error(errors.field_not_found);
  return {
    field_id: field.id,
    field_operator: fields.field_operator.value,
    ...(fields.field_operator.value === "eq"
      ? {
          field_value: typedFieldValue(
            field,
            field.type === "boolean" ? fields.field_boolean.value : fields.field_value.value,
          ),
        }
      : {}),
  };
}
byId("contacts-filter").addEventListener("change", fieldFilterControls);
function fieldControls() {
  for (const control of byId("field-create").elements) control.disabled = fieldBusy;
  for (const button of byId("field-definitions").querySelectorAll("button")) button.disabled = fieldBusy;
}
async function loadContactFields(force = false) {
  if (fieldBusy && !force) return false;
  const generation = fieldsGeneration;
  const request = ++fieldsRequest;
  try {
    const result = await api("/api/contact-fields");
    if (generation !== fieldsGeneration || request !== fieldsRequest) return false;
    contactFields = result.fields;
    const select = byId("contacts-filter").elements.field_id;
    const previous = select.value;
    select.replaceChildren(new Option("조건 없음", ""));
    for (const field of contactFields) select.add(new Option(field.name, field.id));
    if (previous && !contactFields.some((field) => field.id === previous))
      select.add(new Option("사용할 수 없는 필드", previous));
    select.value = previous;
    fieldFilterControls();
    byId("field-definitions").replaceChildren();
    for (const field of contactFields) {
      const row = node("div", "", "field-definition");
      row.append(node("span", `${field.name} · ${fieldTypeLabels[field.type]}`));
      const archive = node("button", "보관", "secondary");
      archive.type = "button";
      archive.setAttribute("aria-label", `${field.name} 필드 보관`);
      archive.addEventListener("click", () => archiveField(field, archive));
      row.append(archive);
      byId("field-definitions").append(row);
    }
    fieldControls();
    byId("fields-status").textContent = contactFields.length
      ? `활성 필드 ${contactFields.length}개 / 50개`
      : "아직 필드가 없습니다. 연락처에 기록할 항목을 만들어 보세요.";
    return true;
  } catch (error) {
    if (generation === fieldsGeneration && request === fieldsRequest)
      byId("fields-status").textContent = `${error.message} 새로고침으로 다시 시도해 주세요.`;
    return false;
  }
}
byId("field-create").addEventListener("input", () => {
  fieldNameDirty = Boolean(byId("field-create").elements.name.value);
});
byId("field-create").addEventListener("submit", (event) => {
  event.preventDefault();
  if (fieldBusy) return;
  const generation = fieldsGeneration;
  const fields = event.currentTarget.elements;
  const payload = { name: fields.name.value, type: fields.type.value };
  void action(event.currentTarget.querySelector("button"), async () => {
    fieldBusy = true;
    fieldControls();
    try {
      await api("/api/contact-fields", "POST", payload);
      if (generation !== fieldsGeneration) return;
      byId("field-create").reset();
      fieldNameDirty = false;
      const loaded = await loadContactFields(true);
      if (generation !== fieldsGeneration) return;
      if (loaded && !contactsDirty.size && !contactsSaving) await loadContacts();
      notice(
        loaded
          ? "필드를 만들었습니다. 연락처의 추가 정보 편집에서 값을 기록할 수 있습니다."
          : "필드를 만들었지만 목록을 갱신하지 못했습니다. 새로고침으로 다시 불러와 주세요.",
      );
    } finally {
      if (generation === fieldsGeneration) {
        fieldBusy = false;
        fieldControls();
      }
    }
  }).finally(fieldControls);
});
function archiveField(field, button) {
  const selected = byId("contacts-filter").elements.field_id;
  const filterNotice = selected.value === field.id ? " 이 필드의 검색 조건은 해제됩니다." : "";
  if (!canReloadContacts() || !confirm(`${field.name} 필드를 보관할까요? 저장한 값은 유지됩니다.${filterNotice}`))
    return;
  const generation = fieldsGeneration;
  void action(button, async () => {
    fieldBusy = true;
    fieldControls();
    try {
      await api(`/api/contact-fields/${field.id}`, "DELETE");
      if (generation !== fieldsGeneration) return;
      if (selected.value === field.id) selected.value = "";
      contactFields = contactFields.filter((definition) => definition.id !== field.id);
      button.closest(".field-definition")?.remove();
      [...selected.options].find((option) => option.value === field.id)?.remove();
      fieldFilterControls();
      clearContactResults();
      const loaded = await loadContactFields(true);
      if (generation !== fieldsGeneration) return;
      if (loaded) await loadContacts();
      notice(
        loaded
          ? "필드를 보관했습니다. 저장한 값은 유지됩니다."
          : "필드를 보관했지만 목록을 갱신하지 못했습니다. 새로고침으로 다시 불러와 주세요.",
      );
    } finally {
      if (generation === fieldsGeneration) {
        fieldBusy = false;
        fieldControls();
      }
    }
  }).finally(fieldControls);
}
function contactFieldEditor(contact, summary) {
  const details = document.createElement("details");
  details.className = "contact-field-editor";
  details.append(node("summary", "추가 정보 편집"));
  const editor = document.createElement("form");
  const select = document.createElement("select");
  for (const field of contactFields) select.add(new Option(`${field.name} · ${fieldTypeLabels[field.type]}`, field.id));
  const label = node("label", "필드");
  label.append(select);
  const valueLabel = node("label", "값");
  const input = document.createElement("input");
  const booleanInput = document.createElement("select");
  booleanInput.add(new Option("예", "true"));
  booleanInput.add(new Option("아니요", "false"));
  valueLabel.append(input, booleanInput);
  const status = node("p", "", "hint");
  status.setAttribute("role", "status");
  const save = node("button", "값 저장");
  save.type = "submit";
  const clear = node("button", "값 제거", "secondary");
  clear.type = "button";
  editor.append(label, valueLabel, status, save, clear);
  details.append(editor);
  const key = `${contact.connection_id}:${contact.sender_id}:field`;
  let selectedId = select.value;
  let original = "";
  const activeInput = () => (booleanInput.hidden ? input : booleanInput);
  function populate() {
    const field = contactFields.find((item) => item.id === select.value);
    const value = contact.fields?.[select.value];
    configureFieldInput(input, field);
    booleanInput.hidden = field?.type !== "boolean";
    input.hidden = !booleanInput.hidden;
    input.value = value === undefined ? "" : String(value);
    booleanInput.value = value === false ? "false" : "true";
    original = activeInput().value;
    status.textContent =
      value === undefined ? "미입력. 값을 저장하면 입력된 상태가 됩니다." : `저장된 값: ${displayFieldValue(value)}`;
    contactsDirty.delete(key);
  }
  populate();
  editor.addEventListener("input", (event) => {
    if (event.target === select) return;
    if (activeInput().value === original) contactsDirty.delete(key);
    else contactsDirty.add(key);
  });
  select.addEventListener("change", () => {
    if (contactsDirty.has(key) && !confirm("저장하지 않은 추가 정보 변경 사항을 버릴까요?")) {
      select.value = selectedId;
      return;
    }
    selectedId = select.value;
    populate();
  });
  async function persist(value, button) {
    if (contactsSaving || contactsBusy || fieldBusy) return;
    const generation = contactsGeneration;
    const id = select.value;
    await action(button, async () => {
      contactsSaving = true;
      for (const control of editor.elements) control.disabled = true;
      try {
        const saved = await api(
          `/api/connections/${contact.connection_id}/contacts/${encodeURIComponent(contact.sender_id)}/fields/${id}`,
          "PUT",
          { value },
        );
        if (generation !== contactsGeneration) return;
        contact.fields ||= {};
        if (saved.value === null) delete contact.fields[id];
        else contact.fields[id] = saved.value;
        summary.replaceChildren();
        for (const field of contactFields)
          if (Object.hasOwn(contact.fields, field.id))
            summary.append(node("p", `${field.name} · ${displayFieldValue(contact.fields[field.id])}`, "hint"));
        populate();
        notice(
          value === null ? "값을 제거했습니다." : "값을 저장했습니다. 검색 결과는 필터를 다시 적용하면 갱신됩니다.",
        );
      } finally {
        for (const control of editor.elements) control.disabled = false;
        if (generation === contactsGeneration) contactsSaving = false;
      }
    });
  }
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const field = contactFields.find((item) => item.id === select.value);
      if (!field) throw new Error(errors.field_not_found);
      void persist(typedFieldValue(field, activeInput().value), save);
    } catch (error) {
      notice(error.message, true);
    }
  });
  clear.addEventListener("click", () => {
    void persist(null, clear);
  });
  return details;
}

const inbox = createInbox({
  api,
  node,
  getConnections: () => connections,
  getRole: () => currentRole,
  getUserId: () => currentUserId,
});
function resetInbox() {
  inbox.reset();
}
function initializeInbox() {
  inbox.initialize();
}
function loadInbox(more = false) {
  return inbox.loadList(more);
}
function loadInboxMessages(older = false) {
  return inbox.loadConversation(older);
}
