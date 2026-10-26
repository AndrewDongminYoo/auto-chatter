const byId = (id) => document.getElementById(id);
const contactSessionSource = crypto.randomUUID();
const manualReports = createManualReplyReports({ api, node });
const flowReports = createFlowRunReports({ api, node });
const handoffReports = createHandoffReports({ api, node });
const campaignDrafts = createCampaignDrafts({ api, node });
// Members are shown by the account's current username from the loaded connection list; the server returns IDs only.
const segmentSnapshots = createSegmentSnapshots({
  api,
  node,
  connectionLabel: (id) => {
    const account = connections.find((connection) => connection.id === id);
    return account?.username ? `@${account.username}` : id;
  },
});
const contactCsvPreview = createContactCsvPreview({
  api,
  node,
  sessionSource: contactSessionSource,
  // An applied import reloads the list like a saved tag does, and never over an unsaved contact draft;
  // it returns whether it reloaded so the import status can say when the list still shows old tags.
  reloadContacts: () => {
    if (contactsDirty.size || contactsSaving) return false;
    void loadContacts();
    return true;
  },
});
const form = byId("rule-form");
let connections = [];
let contactsGeneration = 0;
let workspaceGeneration = 0;
// Invalidate contact disclosures on cross-tab sessions and BFCache restoration.
const invalidateContactSession = () => {
  workspaceGeneration++;
  campaignDrafts.reset();
  contactsSaving = false;
  clearContactResults();
  if (!byId("workspace").hidden) {
    byId("retry-load").hidden = false;
    notice("로그인 상태를 다시 확인해야 합니다. ‘다시 불러오기’를 눌러 작업 공간을 확인해 주세요.");
  }
};
try {
  const contactSessionChannel = new BroadcastChannel("auto-chatter-session");
  contactSessionChannel.addEventListener("message", (event) => {
    if (event.data?.source !== contactSessionSource) invalidateContactSession();
  });
} catch {
  // Same-tab session reset and server authorization still apply without BroadcastChannel.
}
window.addEventListener("pageshow", (event) => {
  if (event.persisted) invalidateContactSession();
});
// End contact session listeners.
let contactsExportGeneration = 0;
let contactsExportBusy = false;
// The saved segment whose export is in flight, so archiving that segment cancels it.
let contactsExportSegmentId = "";
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
// The condition tree of the draft, as a draft of condition-tree-model.js: started with "그룹 조건 사용" or read from
// the selected tree segment, changed in the group editor, kept while the limit inputs change and removed only by
// choosing "직접 조건 설정" or "그룹 조건 지우기". Requests send segmentTreeBuild's tree, never the draft.
let draftConditionTree = null;
let segmentNameDirty = false;
let segmentPreviewRequest = 0;
// The saved segment being edited: its ID, the version the edit is based on, the segment as last read from the
// server, and the name and the tree draft put in the form when the edit started or the saved values were last loaded.
// It is kept apart from activeSegmentId, because changing a condition clears the selection.
let editingSegment = null;
// Counts operator edits of the filter conditions, so an edit can tell whether they changed since it started.
let segmentConditionInputs = 0;
// The contact filter's tag inputs: one input per tag, so a tag may contain a comma. The server accepts at most five.
const contactTagInputNames = ["tag", "tag_2", "tag_3", "tag_4", "tag_5"];
// The rows of the field condition: the first keeps the original control names, rows 2 and 3 add a suffix.
// The server accepts at most three conditions on distinct fields; one row sends the legacy keys.
const fieldRowSuffixes = ["", "_2", "_3"];
// True when the operator changed a condition or the name since the edit started or since the saved values were last
// loaded. The name is compared with the loaded one, because segmentNameDirty is false for an emptied name field.
// Group editor changes do not count as inputs; the tree is compared with the loaded one in order, so moving a group
// or a condition is a change and moving it back is not.
function segmentEditChanged() {
  return (
    Boolean(editingSegment) &&
    (segmentConditionInputs !== editingSegment.inputs ||
      byId("segment-save").elements.name.value !== editingSegment.loadedName ||
      !segmentTreeSame(draftConditionTree, editingSegment.loadedTree, contactFields))
  );
}
// True when the draft's group conditions would be lost by discarding them, because no saved filter holds that tree.
// It protects a tree built outside edit mode, which no input counter records, wherever the draft can be discarded.
function conditionTreeUnsaved() {
  return segmentTreeUnsaved(
    draftConditionTree,
    contactSegments.map((segment) => segment.condition_tree),
    contactFields,
  );
}
// Asks before the draft's tree is cleared or replaced, when choosing a saved filter again could not bring it back.
function canDropConditionTree() {
  return !conditionTreeUnsaved() || confirm("만든 그룹 조건을 지울까요? 지운 그룹과 조건은 되돌릴 수 없습니다.");
}
let contactFields = [];
let fieldsGeneration = 0;
let fieldsRequest = 0;
let fieldBusy = false;
let fieldNameDirty = false;
let refreshPromise;
let currentUserId;
let currentRole;
let currentView;
// The workspace time zone, which the inbox reminder editor shows its date and time in.
let workspaceTimeZone;
// The workspace plan, its limits and usage (#52) from the latest workspace or member list response.
let workspacePlan;
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
// The manual Meta status result per connection, handed to the one list refresh that follows the check and removed
// there, so a later refresh (disconnect, toggles) does not show a result for a changed account.
const healthResults = new Map();
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
    (!dirty &&
      !contactsDirty.size &&
      !segmentNameDirty &&
      !segmentEditChanged() &&
      !conditionTreeUnsaved() &&
      !fieldNameDirty &&
      !inbox.hasDrafts() &&
      !campaignDrafts.hasChanges() &&
      !flowEditor.hasChanges()) ||
    confirm("저장하지 않은 규칙·연락처·필터·플로 변경 사항과 답장·캠페인 초안을 버릴까요?")
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
  if (
    dirty ||
    contactsDirty.size ||
    segmentNameDirty ||
    segmentEditChanged() ||
    conditionTreeUnsaved() ||
    fieldNameDirty ||
    inbox.hasDrafts() ||
    campaignDrafts.hasChanges() ||
    flowEditor.hasChanges()
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
function resetSession() {
  workspaceGeneration++;
  campaignDrafts.reset();
  contactCsvPreview.sessionChanged();
  segmentSnapshots.reset();
  manualReports.reset();
  flowReports.reset();
  handoffReports.reset();
  invalidateContactExport();
  byId("contacts-export").hidden = true;
  byId("contacts-export-help").hidden = true;
  byId("contacts-segment-export").hidden = true;
  byId("contacts-segment-export-help").hidden = true;
  byId("contacts-export-format").hidden = true;
  byId("contacts-export-format").open = false;
  resetInbox();
  flowEditor.reset();
  connections = [];
  currentUserId = undefined;
  currentRole = undefined;
  currentView = undefined;
  workspaceTimeZone = undefined;
  workspacePlan = undefined;
  planControls();
  byId("members-section").hidden = true;
  byId("getting-started").hidden = true;
  byId("time-zone-form").reset();
  timeZoneControls();
  byId("members").replaceChildren();
  byId("invites").replaceChildren();
  hideInviteLink();
  byId("operations-section").hidden = true;
  byId("operations-summary").textContent = "";
  byId("operations-alerts").replaceChildren();
  byId("operations").replaceChildren();
  byId("webhooks-section").hidden = true;
  byId("webhook-endpoints").replaceChildren();
  byId("webhook-deliveries").replaceChildren();
  byId("webhook-form").reset();
  hideWebhookSecret();
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
  draftConditionTree = null;
  renderConditionTree();
  leaveSegmentEdit({ discard: true });
  segmentNameDirty = false;
  fieldsGeneration++;
  contactFields = [];
  fieldBusy = false;
  fieldNameDirty = false;
  byId("field-create").reset();
  byId("field-definitions").replaceChildren();
  byId("fields-status").textContent = "";
  for (const row of fieldFilterRows()) row.field.replaceChildren(new Option("조건 없음", ""));
  fieldControls();
  byId("contact-segment").replaceChildren(new Option("직접 조건 설정", ""));
  byId("segment-archive").disabled = true;
  byId("segment-save").reset();
  byId("segments-status").textContent = "";
  segmentControls();
  byId("contacts-list").replaceChildren();
  byId("contacts-filter").reset();
  contactTagControls();
  showFieldRows(1);
  fieldFilterControls();
  contactActivityControls();
  contactConsentControls();
  byId("contacts-more").hidden = true;
  byId("contacts-status").textContent = "";
  mediaCache.clear();
  healthResults.clear();
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
  seat_limit_reached:
    "요금제의 멤버 자리를 모두 쓰고 있습니다. 대기 중인 초대를 취소하거나 멤버를 제거한 뒤 다시 시도해 주세요.",
  connection_limit_reached:
    "요금제에서 연결할 수 있는 Instagram 계정 수를 모두 썼습니다. 새 계정을 연결하려면 다른 계정의 연결을 먼저 해제해 주세요.",
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
  invalid_contact_export_request: "연락처 내보내기 요청을 확인해 주세요.",
  contact_export_too_large: "내보내기 한도(5,000명 또는 5 MiB)를 넘었습니다. 파일을 만들지 않았습니다.",
  contact_export_rate_limited: "연락처 내보내기 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  contact_export_unavailable: "지금은 연락처를 내보낼 수 없습니다. 잠시 후 다시 시도해 주세요.",
  contact_export_timeout: "내보내기 처리 시간 한도를 넘었습니다. 파일을 만들지 않았습니다. 잠시 후 다시 시도해 주세요.",
  workspace_export_too_large:
    "작업 공간 내보내기 한도(데이터 50,000건 또는 20 MiB)를 넘었습니다. 파일을 만들지 않았습니다. 서비스 운영자에게 문의해 주세요.",
  workspace_export_rate_limited: "데이터 내보내기 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  workspace_export_unavailable: "지금은 데이터를 내보낼 수 없습니다. 잠시 후 다시 시도해 주세요.",
  invalid_identity_link_request: "식별자 연결 요청을 확인한 뒤 다시 불러와 주세요.",
  identity_link_conflict: "연결 상태가 변경됐습니다. 최신 내용을 확인해 주세요.",
  identity_link_evidence_changed: "연결 근거가 변경됐습니다. 최신 내용을 확인해 주세요.",
  invalid_contact_request: "연락처 필터를 확인한 뒤 다시 불러와 주세요.",
  contact_not_found: "연락처에 접근할 수 없습니다. 목록을 다시 불러와 주세요.",
  invalid_segment: "필터 이름은 1–60자이며 계정과 태그 조건을 확인해 주세요.",
  segment_not_found: "필터에 접근할 수 없습니다. 저장된 필터를 다시 불러와 주세요.",
  segment_name_exists: "같은 이름의 필터가 있습니다. 다른 이름으로 저장해 주세요.",
  segment_limit_reached: "저장된 필터는 최대 50개입니다. 사용하지 않는 필터를 보관해 주세요.",
  segment_conflict: "다른 변경이 먼저 저장되었습니다. 저장된 값을 확인한 뒤 다시 저장해 주세요.",
  invalid_label: "라벨 이름은 1–30자로 입력하고 제어 문자는 쓰지 마세요.",
  label_name_exists: "같은 이름의 라벨이 있습니다. 다른 이름을 입력해 주세요.",
  label_limit_reached: "사용 중인 라벨은 최대 50개입니다. 쓰지 않는 라벨을 보관해 주세요.",
  label_archived: "보관한 라벨은 대화에 새로 붙이거나 이름을 바꿀 수 없습니다.",
  label_not_found: "라벨을 찾을 수 없습니다. 인박스를 새로고침해 주세요.",
  label_conflict: "다른 요청으로 이 대화의 라벨이 먼저 바뀌었습니다. 최신 라벨을 확인해 주세요.",
  invalid_label_request: "라벨 요청을 확인해 주세요. 대화에는 라벨을 최대 10개까지 붙일 수 있습니다.",
  invalid_label_rule: "붙일 라벨과 맞추는 방식을 확인해 주세요.",
  invalid_label_rule_keywords: "키워드는 1–20개, 제외 키워드는 20개까지 입력하고 각각 100자를 넘지 않게 해 주세요.",
  label_rule_limit_reached: "사용 중인 라벨 규칙은 최대 50개입니다. 쓰지 않는 규칙을 보관해 주세요.",
  label_rule_archived: "보관한 라벨 규칙은 수정할 수 없습니다.",
  label_rule_not_found: "라벨 규칙을 찾을 수 없습니다. 목록을 다시 불러왔습니다.",
  label_rule_conflict:
    "다른 화면에서 이 규칙이 먼저 바뀌어 최신 내용을 다시 불러왔습니다. 확인한 뒤 다시 저장해 주세요.",
  invalid_note: "메모는 1–2,000자로 입력해 주세요.",
  invalid_note_request: "메모 요청을 확인해 주세요. 새로고침한 뒤 다시 시도해 주세요.",
  conversation_not_found: "대화를 찾을 수 없습니다. 삭제되었을 수 있으니 인박스를 새로고침해 주세요.",
  invalid_reminder_due: "리마인더 날짜와 시각을 확인해 주세요.",
  reminder_due_out_of_range: "리마인더는 지금부터 1분 뒤에서 90일 안으로 정해 주세요.",
  invalid_reminder_note: "리마인더 메모는 200자까지 입력할 수 있습니다.",
  invalid_reminder_request: "리마인더 요청을 확인해 주세요. 새로고침한 뒤 다시 시도해 주세요.",
  reminder_exists: "이 대화에는 이미 내 리마인더가 있습니다. 기존 리마인더를 바꿔 주세요.",
  reminder_conflict: "다른 화면에서 이 리마인더가 먼저 바뀌어 최신 내용을 다시 불러왔습니다.",
  reminder_not_found: "리마인더를 찾을 수 없습니다. 삭제되었을 수 있으니 인박스를 새로고침해 주세요.",
  reminder_not_pending: "이미 완료했거나 취소한 리마인더입니다.",
  conversation_closed: "완료 처리한 대화에는 리마인더를 둘 수 없습니다. 대화를 다시 연 뒤 정해 주세요.",
  invalid_contact_field: "필드 이름은 1–60자이며 값 종류를 선택해 주세요.",
  invalid_field_value: "선택한 종류에 맞는 값을 입력해 주세요. 텍스트는 최대 1000자입니다.",
  invalid_contact_import_request: "CSV 검사 요청을 확인해 주세요.",
  invalid_contact_import_format: "v1 CSV 헤더와 인용 형식을 확인해 주세요.",
  contact_import_too_large: "CSV 파일은 128KiB, 500행까지 검사할 수 있습니다.",
  contact_import_rejected:
    "오류·중복·조회 불가 행이 있어 태그를 저장하지 않았습니다. 아래 결과를 고친 뒤 다시 검사해 주세요.",
  contact_import_stale:
    "검사 후 태그가 바뀐 연락처가 있어 저장하지 않았습니다. 현재 결과를 확인하고 다시 검사해 주세요.",
  invalid_field_condition: "추가 정보의 필드·조건·찾을 값을 확인해 주세요.",
  invalid_contact_condition: "OR 결합에는 태그와 추가 정보 조건이 모두 필요합니다.",
  invalid_contact_activity: "UTC 시작·종료를 함께 지정하거나 최근 일수 1~366 또는 달력 기간 중 하나를 선택해 주세요.",
  invalid_contact_consent: "동의 목적과 기록 상태를 함께 선택해 주세요.",
  field_not_found: "접근할 수 없거나 보관된 필드입니다. 필드를 다시 불러와 주세요.",
  field_in_use: "저장된 필터에서 사용하는 필드입니다. 해당 필터를 먼저 보관해 주세요.",
  field_name_exists: "보관된 필드를 포함해 같은 이름이 있습니다. 다른 이름을 사용해 주세요.",
  field_limit_reached: "활성 필드는 최대 50개입니다. 사용하지 않는 필드를 보관해 주세요.",
  invalid_keywords: "키워드는 최대 20개, 각각 100자까지 입력할 수 있습니다.",
  invalid_confirmation_button: "버튼 이름은 20자, 버튼 메시지는 640자 이내로 작성하고 팔로우 확인을 켜주세요.",
  channel_capability_unsupported: "이 채널은 요청한 답장 형식을 지원하지 않습니다.",
  invalid_rule: "게시물 선택, 답장 문구와 팔로우 조건을 확인해 주세요.",
  invalid_media_request: "게시물 목록을 새로고침한 뒤 다시 선택해 주세요.",
  media_reconnect_required: "계정을 다시 연결한 뒤 게시물을 불러와 주세요.",
  media_unavailable: "게시물을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
  media_not_owned: "선택한 계정의 게시물만 사용할 수 있습니다. 게시물을 다시 선택해 주세요.",
  media_unsupported: "이 게시물은 댓글 자동화를 지원하지 않습니다. 피드 게시물이나 릴스를 선택해 주세요.",
  media_rate_limited: "게시물 조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  remote_logout_unconfirmed:
    "브라우저에서 로그아웃했습니다. 서버 세션 종료를 확인하지 못했으니 다시 로그인해 로그아웃하거나 운영자에게 문의해 주세요.",
  instagram_not_configured: "Instagram 연결 서비스를 준비 중입니다.",
  instagram_connect_rate_limited: "계정 연결 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  instagram_connect_unavailable: "지금은 계정 연결을 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  instagram_public_access_restricted:
    "일반 사용자의 Instagram 연결에 필요한 Meta 승인을 확인하지 못해 계정 연결을 제한합니다. 검수에 참여하는 계정만 연결할 수 있습니다.",
  instagram_authorization_denied: "Instagram 연결이 완료되지 않았습니다. 권한 동의를 취소했거나 요청이 거부됐습니다.",
  instagram_permissions_required: "필수 Instagram 권한을 받지 못했습니다. 계정과 앱 권한을 확인해 주세요.",
  health_rate_limited: "상태 확인 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  health_unavailable: "지금은 Meta 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  invalid_webhook_endpoint:
    "주소 이름은 1–60자로 입력하고, 줄바꿈이나 보이지 않는 문자(여러 이모지를 이어 붙인 기호 등)는 빼 주세요. 계속 실패하면 목록을 새로 고친 뒤 다시 시도해 주세요.",
  invalid_webhook_url:
    "443 포트를 쓰는 https:// 주소만 등록할 수 있습니다. IP 주소, localhost와 .local·.internal 주소, 사용자 정보가 들어간 주소는 쓸 수 없습니다.",
  webhooks_unavailable: "지금은 주소를 추가하거나 키를 교체할 수 없습니다. 서비스 운영자에게 문의해 주세요.",
  webhook_endpoint_not_found: "주소를 찾을 수 없습니다. 목록을 새로 고쳐 주세요.",
  webhook_endpoint_limit_reached: "켜 둘 수 있는 주소는 최대 5개입니다. 사용하지 않는 주소를 끈 뒤 다시 시도해 주세요.",
  webhook_rotation_in_progress: "이미 키를 교체하는 중입니다. 이전 키를 폐기한 뒤 다시 교체해 주세요.",
  webhook_key_required: "유효한 키가 하나뿐이라 폐기할 수 없습니다. 먼저 키를 교체해 주세요.",
  invalid_webhook_delivery: "전송 기록을 확인할 수 없습니다. 목록을 새로 고쳐 주세요.",
  webhook_delivery_not_found: "전송 기록을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.",
  webhook_delivery_not_dead: "전송이 중단된 기록만 다시 보낼 수 있습니다. 목록을 새로 고쳐 주세요.",
  webhook_endpoint_inactive: "꺼진 주소로는 다시 보낼 수 없습니다. 주소를 켠 뒤 다시 시도해 주세요.",
  invalid_flow: "플로 이름은 1–80자로 입력하고 줄바꿈이나 보이지 않는 문자는 빼 주세요.",
  flow_not_found: "플로를 찾을 수 없습니다. 목록을 새로 고쳐 주세요.",
  flow_archived: "보관된 플로입니다. 목록을 새로 고쳐 주세요.",
  revision_conflict: "다른 곳에서 이 플로를 먼저 저장했습니다. 최신 초안을 불러온 뒤 다시 시도해 주세요.",
  flow_limit_reached: "보관하지 않은 플로는 최대 50개입니다. 사용하지 않는 플로를 보관해 주세요.",
  flow_not_published: "아직 발행한 버전이 없습니다. 먼저 초안을 발행해 주세요.",
  invalid_test_run: "테스트 입력을 확인해 주세요. 댓글과 응답 본문은 2,000자, 태그는 20개까지입니다.",
  unknown_field: "보관됐거나 없는 필드입니다. 필드를 빼거나 다시 선택해 주세요.",
  invalid_credentials: "이메일과 8자 이상의 비밀번호를 입력해 주세요.",
  invalid_recovery_email: "이메일 주소를 확인해 주세요.",
  auth_rate_limited: "요청이 많습니다. 잠시 기다린 뒤 다시 시도해 주세요.",
  rate_limited: "요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  invalid_recovery_link: "변경 링크를 다시 요청해 주세요.",
  recovery_link_invalid: "변경 링크가 만료되었거나 유효하지 않습니다. 새 링크를 요청해 주세요.",
  password_rejected: "새 비밀번호가 보안 기준을 충족하지 않습니다. 다른 비밀번호로 다시 시도해 주세요.",
  password_updated_logout_unconfirmed:
    "비밀번호는 변경됐지만 다른 세션 종료를 확인하지 못했습니다. 새 비밀번호로 로그인한 뒤 계정 상태를 확인해 주세요.",
};

function authSessionRevision() {
  try {
    return localStorage.getItem("auto-chatter-auth-session") ?? "";
  } catch {
    return null;
  }
}

// Bind this document's UI to its accepted session, not to whichever account wrote
// storage most recently. Other documents' broadcasts may not have arrived yet.
let acceptedAuthRevision = authSessionRevision();

async function api(path, method = "GET", body, retry = true, asText = false) {
  const requestSession = workspaceGeneration;
  const requestRevision = acceptedAuthRevision;
  const requireCurrentSession = () => {
    if (
      requestSession !== workspaceGeneration ||
      requestRevision !== authSessionRevision() ||
      requestRevision?.startsWith("pending:")
    )
      throw new Error("로그인 상태가 변경되었습니다. 작업 공간을 다시 불러온 뒤 시도해 주세요.");
  };
  const refresh = path === "/api/auth/refresh";
  const changesCookies =
    method === "POST" &&
    ["/api/auth/login", "/api/auth/refresh", "/api/auth/logout", "/api/auth/reset-password"].includes(path);
  const protectedRequest = !path.startsWith("/api/auth/");
  const locks = globalThis.navigator?.locks;
  const storageUnavailable = () => {
    if (refresh) resetSession();
    const error = new Error("브라우저 저장소를 사용할 수 없습니다. 저장소를 허용한 뒤 다시 로그인해 주세요.");
    error.status = 401;
    error.code = "login_required";
    return error;
  };
  const send = async () => {
    if (refresh || protectedRequest) requireCurrentSession();
    let transition;
    if (changesCookies && locks?.request) {
      try {
        // A pending marker also retires requests started during this transition. If the
        // completion write fails, the marker remains and queued refresh/replay stays blocked.
        transition = refresh ? undefined : crypto.randomUUID();
        localStorage.setItem("auto-chatter-auth-session", refresh ? requestRevision : `pending:${transition}`);
      } catch {
        throw storageUnavailable();
      }
    }
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
    // Publish the cookie transition before releasing the origin-wide lock. A queued refresh
    // must see it even when the other document's BroadcastChannel event has not arrived.
    if (transition || (refresh && response.status === 401)) {
      try {
        localStorage.setItem("auto-chatter-auth-session", `ready:${transition ?? crypto.randomUUID()}`);
      } catch {
        invalidateContactSession();
        contactCsvPreview.sessionChanged();
        throw storageUnavailable();
      }
    }
    if (response.ok && path === "/api/auth/login") {
      acceptedAuthRevision = transition ? `ready:${transition}` : authSessionRevision();
      invalidateContactSession();
      contactCsvPreview.sessionChanged();
    }
    return response;
  };
  if (refresh && (!locks?.request || requestRevision === null)) {
    resetSession();
    const error = new Error("로그인 상태를 안전하게 갱신할 수 없습니다. 다시 로그인해 주세요.");
    error.status = 401;
    error.code = "login_required";
    throw error;
  }
  // Fetch resolves after the browser applies response headers, including Set-Cookie.
  // Do not cancel an older fetch and assume its cookie effects have been cancelled.
  const response =
    (changesCookies || protectedRequest) && locks?.request
      ? await locks.request("auto-chatter-auth-cookies", { mode: changesCookies ? "exclusive" : "shared" }, send)
      : await send();
  if (response.status === 401 && retry && !path.startsWith("/api/auth/")) {
    await response.body?.cancel();
    requireCurrentSession();
    refreshPromise ??= api("/api/auth/refresh", "POST", undefined, false).finally(() => {
      refreshPromise = undefined;
    });
    await refreshPromise;
    requireCurrentSession();
    return api(path, method, body, false, asText);
  }
  if (asText && response.ok) {
    const result = await response.text();
    if (protectedRequest) requireCurrentSession();
    return result;
  }
  let result;
  try {
    result = await response.json();
  } catch {
    if (protectedRequest) requireCurrentSession();
    if (response.status === 401) resetSession();
    throw new Error("서버 응답을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  }
  if (protectedRequest) requireCurrentSession();
  if (response.status === 401) resetSession();
  if (!response.ok) {
    const error = new Error(errors[result.error] ?? "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    error.status = response.status;
    error.code = result.error;
    // Publish, enable and test-run refusals list their problems (422).
    error.errors = result.errors;
    // A reminder refusal for an existing or newer reminder carries that reminder (409).
    error.reminder = result.reminder;
    // A stale segment edit carries the saved segment (409).
    error.segment = result.segment;
    // A rejected (422) or stale (409) CSV import carries the fresh per-row check result.
    error.checked_at = result.checked_at;
    error.counts = result.counts;
    error.rows = result.rows;
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
  instagram_inbox_read_state: "대화 읽음 위치",
  instagram_inbox_conversation_labels: "대화별 라벨",
  instagram_inbox_label_events: "대화 라벨 변경 이력",
  instagram_inbox_notes: "내부 메모",
  instagram_inbox_reminders: "리마인더",
  instagram_inbox_reminder_events: "리마인더 변경 이력",
  instagram_manual_replies: "수동 답장",
  instagram_manual_reply_events: "수동 답장 감사 기록",
  instagram_contact_automation: "자동화 중지 상태",
  instagram_contact_tags: "연락처 태그",
  instagram_contact_field_values: "연락처 필드 값",
  instagram_segment_snapshot_members: "고정한 발송 대상 명단",
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
  contactCsvPreview.invalidate();
  invalidateSegmentPreview();
  invalidateContactExport(
    "연락처 기록이 삭제되어 진행 중인 내보내기를 취소했습니다. 다시 요청하면 현재 저장된 정보로 만듭니다.",
  );
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
    // The errors map speaks to the owner who creates invites; the invitee gets its own text for a full workspace.
    notice(error.code === "seat_limit_reached" ? planAcceptSeatRefusal() : error.message, true);
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
    workspacePlan = { plan: members.plan, limits: members.limits, usage: members.usage };
    planControls();
    byId("members").replaceChildren(...members.members.map(memberItem));
    byId("invites").replaceChildren(
      ...(invites.invites.length ? invites.invites.map(inviteItem) : [node("p", "대기 중인 초대가 없습니다.", "hint")]),
    );
  } catch (error) {
    if (generation === segmentsGeneration) notice(error.message, true);
  }
}

// An invite link is returned once, so while a request is in flight or a link is showing, the invite form stays
// locked: a second link would replace the first in the panel before it is copied. Only "닫기" or a session reset
// clears the link, and it is kept nowhere else.
let invitePending = false;
function inviteLinkLocked() {
  return invitePending || !byId("invite-result").hidden;
}
function inviteControls() {
  byId("invite-form").querySelector("button[type=submit]").disabled = inviteLinkLocked();
}
// The plan line in the settings and the limit help beside the invite and connect actions. Both actions stay
// enabled at the limit, because a new link for an invited email and re-authorizing a connected account are
// allowed; the server refuses a new email or a new account.
function planControls() {
  byId("plan-summary").textContent = planSummary(workspacePlan);
  byId("seat-limit-help").textContent = planSeatHelp(workspacePlan);
  byId("seat-limit-help").hidden = !planSeatsFull(workspacePlan);
  byId("connection-limit-help").textContent = planConnectionHelp(workspacePlan);
  byId("connection-limit-help").hidden = !planConnectionsFull(workspacePlan);
}
function showInviteLink(link) {
  byId("invite-link").value = link;
  byId("invite-result").hidden = false;
  byId("invite-link").select();
  inviteControls();
}
function hideInviteLink() {
  byId("invite-link").value = "";
  byId("invite-result").hidden = true;
  inviteControls();
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

// Outbound webhooks are admin-only, like operations. A signing secret is shown once in the panel and kept
// nowhere else: dismissing it, a reload or a session reset clears it.
// Create and rotate each return a secret once, so while one is in flight or showing, both stay locked:
// a second result would replace the first in the panel before it is saved.
let webhookSecretPending = false;
function webhookSecretLocked() {
  return webhookSecretPending || !byId("webhook-secret").hidden;
}
function webhookSecretControls() {
  const locked = webhookSecretLocked();
  byId("webhook-form").querySelector("button[type=submit]").disabled = locked;
  for (const rotate of document.querySelectorAll("#webhook-endpoints button[data-key-count]"))
    rotate.disabled = locked || Number(rotate.dataset.keyCount) >= 2;
}
async function webhookSecretAction(button, task) {
  if (webhookSecretLocked()) return;
  await action(button, async () => {
    webhookSecretPending = true;
    webhookSecretControls();
    try {
      await task();
    } finally {
      webhookSecretPending = false;
    }
  });
  // action() restores the disabled state it found before the task, so the lock is applied again here.
  webhookSecretControls();
}
function showWebhookSecret(endpointName, key) {
  byId("webhook-secret-value").value = key.secret;
  byId("webhook-secret-help").textContent =
    `"${endpointName}" 주소의 키 ${key.id} 비밀입니다. 지금 한 번만 보여 주며 닫거나 새로 고치면 다시 볼 수 없으니 수신 서버에 저장한 뒤 닫아 주세요. 닫기 전에는 주소를 추가하거나 키를 교체할 수 없습니다.`;
  byId("webhook-secret").hidden = false;
  byId("webhook-secret-value").select();
  webhookSecretControls();
}
function hideWebhookSecret() {
  byId("webhook-secret-value").value = "";
  byId("webhook-secret-help").textContent = "";
  byId("webhook-secret").hidden = true;
  webhookSecretControls();
}
function webhookEndpointItem(endpoint) {
  const item = node("div", "", "item");
  const badges = node("div", "", "badges");
  badges.append(
    badge(endpoint.active ? "켜짐" : "꺼짐", endpoint.active ? "success" : "warning"),
    badge(webhookKeyState(endpoint.keys)),
  );
  item.append(node("strong", endpoint.name), badges, node("p", endpoint.url, "hint"));
  for (const key of endpoint.keys)
    item.append(node("p", `키 ${key.id} · ${new Date(key.created_at).toLocaleString("ko-KR")} 발급`, "hint"));
  const rotate = node("button", "키 교체", "secondary");
  rotate.dataset.loadingLabel = "발급 중…";
  rotate.dataset.keyCount = String(endpoint.keys.length);
  rotate.disabled = endpoint.keys.length >= 2 || webhookSecretLocked();
  rotate.addEventListener("click", () =>
    webhookSecretAction(rotate, async () => {
      const generation = segmentsGeneration;
      const rotated = await api(`/api/webhooks/endpoints/${endpoint.id}/rotate`, "POST");
      // A session reset while the request was in flight must not reveal the secret to the next session.
      if (generation !== segmentsGeneration) return;
      showWebhookSecret(endpoint.name, rotated.key);
      notice("새 키를 발급했습니다. 수신 서버가 새 비밀로 검증하도록 바꾼 뒤 이전 키를 폐기해 주세요.");
      await loadWebhooks();
    }),
  );
  const retire = node("button", "이전 키 폐기", "secondary danger");
  retire.disabled = endpoint.keys.length < 2;
  retire.addEventListener("click", () =>
    action(retire, async () => {
      if (
        !confirm(
          `"${endpoint.name}" 주소의 이전 키를 폐기할까요? 폐기하면 그 키로 서명하지 않으므로, 수신 서버가 새 비밀로 검증하는지 먼저 확인해 주세요.`,
        )
      )
        return;
      await api(`/api/webhooks/endpoints/${endpoint.id}/retire`, "POST");
      notice("이전 키를 폐기했습니다. 이제 새 키로만 서명합니다.");
      await loadWebhooks();
    }),
  );
  const toggle = node("button", endpoint.active ? "끄기" : "켜기", "secondary");
  toggle.addEventListener("click", () =>
    action(toggle, async () => {
      if (
        endpoint.active &&
        !confirm(
          `"${endpoint.name}" 주소를 끌까요? 꺼진 동안 이 주소로 보낼 전송은 보내지 않고 중단됩니다. 다시 켜도 자동으로 다시 보내지 않습니다.`,
        )
      )
        return;
      await api(`/api/webhooks/endpoints/${endpoint.id}/${endpoint.active ? "disable" : "enable"}`, "POST");
      notice(endpoint.active ? "주소를 껐습니다." : "주소를 켰습니다.");
      await loadWebhooks();
    }),
  );
  item.append(rotate, retire, toggle);
  return item;
}
function webhookDeliveryItem(delivery, endpointName) {
  const item = node("div", "", "item");
  const badges = node("div", "", "badges");
  badges.append(badge(webhookStatusLabel(delivery.status), delivery.status === "dead" ? "warning" : ""));
  item.append(
    node("strong", endpointName ?? "알 수 없는 주소"),
    badges,
    node("p", webhookAttemptSummary(delivery), "hint"),
    node(
      "p",
      webhookDeliveryTimes(delivery, (value) => new Date(value).toLocaleString("ko-KR")),
      "hint",
    ),
  );
  if (delivery.status !== "dead") return item;
  const redeliver = node("button", "다시 보내기", "secondary");
  redeliver.addEventListener("click", () =>
    action(redeliver, async () => {
      if (
        !confirm(
          "이 전송을 같은 이벤트 ID로 다시 보낼까요? 수신 서버가 이미 받은 이벤트라면 이벤트 ID로 중복을 걸러야 합니다.",
        )
      )
        return;
      await api(`/api/webhooks/deliveries/${delivery.event_id}/redeliver`, "POST");
      notice("전송을 다시 대기열에 넣었습니다. 전체 발송이 켜져 있으면 다음 정기 작업에서 보냅니다.");
      await loadWebhooks();
    }),
  );
  item.append(redeliver);
  return item;
}
async function loadWebhooks() {
  const generation = segmentsGeneration;
  try {
    const [endpoints, deliveries] = await Promise.all([
      api("/api/webhooks/endpoints"),
      api("/api/webhooks/deliveries"),
    ]);
    if (generation !== segmentsGeneration) return;
    const names = new Map(endpoints.endpoints.map((endpoint) => [endpoint.id, endpoint.name]));
    byId("webhook-endpoints").replaceChildren(
      ...(endpoints.endpoints.length
        ? endpoints.endpoints.map(webhookEndpointItem)
        : [node("p", "등록한 주소가 없습니다.", "hint")]),
    );
    byId("webhook-deliveries").replaceChildren(
      ...(deliveries.deliveries.length
        ? deliveries.deliveries.map((delivery) => webhookDeliveryItem(delivery, names.get(delivery.endpoint_id)))
        : [node("p", "아직 전송 기록이 없습니다.", "hint")]),
    );
  } catch (error) {
    if (generation === segmentsGeneration) notice(error.message, true);
  }
}

// Menu views: each one shows a group of sections. Switching only hides the others, so drafts and inputs stay.
const views = ["home", "accounts", "automation", "inbox", "contacts", "settings"];
function viewFromHash() {
  const name = location.hash.slice(1);
  if (views.includes(name)) return name;
  // An older section link such as #inbox-section opens the view that holds it. Anything else (#main, auth and invite
  // fragments) leaves the view as it is.
  if (!/^[a-z][a-z-]*$/.test(name)) return null;
  return byId(name)?.closest(".view")?.dataset.view ?? null;
}
function showView(name, focus) {
  currentView = name;
  for (const view of document.querySelectorAll("#workspace .view")) view.hidden = view.dataset.view !== name;
  for (const link of document.querySelectorAll(".workspace-nav a")) {
    if (link.hash === `#${name}`) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (!focus) return;
  scrollTo({ top: 0 });
  byId(`view-${name}`).focus({ preventScroll: true });
}
// After the view is shown, an older section link scrolls to its section; the browser could not while it was hidden.
function scrollToSectionHash() {
  const target = location.hash.slice(1);
  if (!views.includes(target) && viewFromHash()) byId(target).scrollIntoView({ block: "start" });
}
addEventListener("hashchange", () => {
  if (byId("workspace").hidden) return;
  const name = viewFromHash();
  if (!name) return;
  showView(name, true);
  scrollToSectionHash();
});
// Clicking the menu that is already in the address changes no fragment, so no hashchange follows.
document.querySelector(".workspace-nav").addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (link && link.hash === location.hash) showView(link.hash.slice(1), true);
});

// The getting-started steps on the home view, for owners and admins until every step is done.
function renderGettingStarted(rules, globalSendEnabled, connectAvailable) {
  const connected = connections.length > 0;
  const sendSet = connections.some((account) => account.send_enabled);
  // [id, done, available, waiting]: a waiting step is blocked by a service setting the owner cannot change.
  const steps = [
    ["step-connect", connected, true, connectAvailable ? "" : "연결 제한 중"],
    ["step-rule", rules.length > 0, connected, ""],
    ["step-send", sendSet && globalSendEnabled, connected, sendSet && !globalSendEnabled ? "전체 발송 재개 대기" : ""],
  ];
  byId("getting-started").hidden =
    (currentRole !== "owner" && currentRole !== "admin") || steps.every(([, done]) => done);
  for (const [id, done, available, waiting] of steps) {
    const step = byId(id);
    step.classList.toggle("done", done);
    const state = step.querySelector(".step-state");
    state.textContent = done ? "완료" : !available ? "계정을 먼저 연결하세요" : waiting;
    state.className = `step-state${done ? " badge success" : !available || waiting ? " badge" : ""}`;
    step.querySelector(".step-action").hidden = done || !available || waiting !== "";
  }
  byId("step-connect-help").textContent = connectAvailable
    ? "관리하는 전문 계정을 연결합니다."
    : "새 Instagram 계정 연결이 현재 제한되어 있습니다. 연결이 열리면 이 단계부터 시작할 수 있습니다.";
  byId("step-send-help").textContent = globalSendEnabled
    ? "계정의 발송 설정을 켜면 규칙에 맞는 댓글에 DM을 보냅니다."
    : "전체 발송이 중지되어 있어, 계정의 발송 설정을 켜도 재개되기 전에는 메시지가 전송되지 않습니다.";
}

async function loadWorkspace() {
  contactCsvPreview.reset();
  segmentSnapshots.reset();
  // A workspace reload ends a segment edit but keeps the draft: the name and conditions stay, and a changed draft
  // stays marked unsaved.
  if (editingSegment) leaveSegmentEdit();
  segmentControls();
  manualReports.reset();
  flowReports.reset();
  handoffReports.reset();
  invalidateContactExport();
  const generation = segmentsGeneration,
    workspaceSession = workspaceGeneration;
  const me = await api("/api/me");
  if (generation !== segmentsGeneration || workspaceSession !== workspaceGeneration) return;
  currentUserId = me.user?.id;
  if (pendingInvite) await acceptPendingInvite();
  if (generation !== segmentsGeneration || workspaceSession !== workspaceGeneration) return;
  const membership = await api("/api/workspace", "POST");
  if (generation !== segmentsGeneration || workspaceSession !== workspaceGeneration) return;
  currentRole = membership.role;
  contactCsvPreview.configure(currentRole);
  workspaceTimeZone = membership.time_zone ?? undefined;
  workspacePlan = { plan: membership.plan, limits: membership.limits, usage: membership.usage };
  planControls();
  byId("time-zone-form").elements.time_zone.value = membership.time_zone ?? "";
  timeZoneControls();
  const operationsVisible = currentRole === "owner" || currentRole === "admin";
  byId("contacts-export").hidden = !operationsVisible;
  byId("contacts-export-help").hidden = !operationsVisible;
  byId("contacts-segment-export").hidden = !operationsVisible;
  byId("contacts-segment-export-help").hidden = !operationsVisible;
  byId("contacts-export-format").hidden = !operationsVisible;
  segmentSnapshots.configure(currentRole, workspaceTimeZone);
  void campaignDrafts.configure(currentRole, membership.workspace_id, workspaceTimeZone);
  byId("operations-section").hidden = !operationsVisible;
  byId("webhooks-section").hidden = !operationsVisible;
  if (operationsVisible) {
    void loadOperations();
    void loadWebhooks();
  }
  byId("members-section").hidden = currentRole !== "owner";
  if (currentRole === "owner") void loadMembers();
  if (generation !== segmentsGeneration || workspaceSession !== workspaceGeneration) return;
  const [accounts, settings] = await Promise.all([api("/api/connections"), api("/api/rules")]);
  if (generation !== segmentsGeneration || workspaceSession !== workspaceGeneration) return;
  connections = accounts.connections;
  manualReports.configure(currentRole, workspaceTimeZone, connections);
  void flowReports.configure(currentRole, workspaceTimeZone, connections);
  handoffReports.configure(currentRole, workspaceTimeZone, connections);
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
  renderGettingStarted(settings.rules, me.global_send_enabled, me.instagram_connect_available === true);

  byId("auth").hidden = true;
  byId("workspace").hidden = false;
  byId("logout").hidden = false;
  const firstDisplay = currentView === undefined;
  showView(viewFromHash() ?? currentView ?? "home", false);
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
    // Meta rejected the stored token (refresh, pre-send identity check or subscription check); the server records
    // it, display only.
    const reauthReason = {
      refresh_rejected: "Meta가 토큰 자동 갱신을 거부했습니다.",
      token_rejected: "발송 전 계정 확인이나 Meta 상태 확인에서 Meta가 토큰을 거부했습니다.",
    }[account.reauth_reason];
    const state = node("div", "", "badges");
    state.append(
      badge(
        credentialStatus === "valid" ? "토큰 만료 전" : credentialStatus === "expired" ? "토큰 만료" : "토큰 없음",
        credentialStatus === "valid" ? "" : "warning",
      ),
      ...(reauthReason ? [badge("재연결 필요", "warning")] : []),
      ...(account.subscription_missing_at ? [badge("웹후크 구독 유실", "warning")] : []),
      ...(account.deauthorized_at ? [badge("Instagram에서 권한 해제됨", "warning")] : []),
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
      const generation = segmentsGeneration,
        workspaceSession = workspaceGeneration;
      void action(inboxToggle, async () => {
        const result = await api(`/api/connections/${account.id}/inbox`, "PUT", { enabled: !account.inbox_enabled });
        if (generation !== segmentsGeneration || workspaceSession !== workspaceGeneration) return;
        account.inbox_enabled = result.enabled;
        notice(result.enabled ? "이 계정의 새 DM 보관을 켰습니다." : "새 DM 보관을 껐습니다. 기존 기록은 유지됩니다.");
      }).then(() => {
        if (generation === segmentsGeneration)
          inboxToggle.textContent = account.inbox_enabled ? "DM 보관 끄기" : "DM 보관 켜기";
      });
    });
    item.append(inboxToggle);
    const unconfirmed = account.subscription_checked_at
      ? "철회·권한 여부는 확인되지 않았습니다."
      : "철회·권한·구독 여부는 확인되지 않았습니다.";
    item.append(
      node(
        "p",
        credentialStatus === "valid"
          ? account.active
            ? `토큰 만료일: ${new Date(account.token_expires_at).toLocaleDateString("ko-KR")} · 만료 30일 전부터 갱신을 시도합니다. ${unconfirmed}`
            : `토큰 만료일: ${new Date(account.token_expires_at).toLocaleDateString("ko-KR")} · 수신 중지 중에는 갱신하지 않습니다. ${unconfirmed}`
          : `${credentialStatus === "expired" ? "토큰이 만료됐습니다." : "연결 토큰이 없습니다."} 상단의 '계정 연결'에서 같은 Instagram 계정을 다시 선택해 주세요.`,
        "hint",
      ),
    );
    if (reauthReason)
      item.append(
        node(
          "p",
          `${new Date(account.reauth_required_at).toLocaleString("ko-KR")} · ${reauthReason} 다시 연결하기 전까지 대기 중인 답장이 발송 전 확인에서 차단될 수 있습니다. 상단의 '계정 연결'에서 같은 Instagram 계정을 다시 선택해 주세요.`,
          "hint",
        ),
      );
    // The periodic or manual check found a required webhook subscription field missing for the stored token;
    // the server records it, display only.
    const subscriptionChecked = account.subscription_checked_at
      ? ` 마지막 확인: ${new Date(account.subscription_checked_at).toLocaleString("ko-KR")}.`
      : "";
    if (account.subscription_missing_at)
      item.append(
        node(
          "p",
          `${new Date(account.subscription_missing_at).toLocaleString("ko-KR")} 처음 기록 · Meta가 이 계정의 댓글·DM·확인 버튼 웹후크 구독 필드를 모두 반환하지 않았습니다. 새 댓글과 DM이 이 앱에 도착하지 않을 수 있습니다. 상단의 '계정 연결'에서 같은 Instagram 계정을 다시 선택하거나 'Meta 상태 확인'을 실행해 주세요.${subscriptionChecked}`,
          "hint",
        ),
      );
    else if (account.subscription_checked_at)
      item.append(node("p", `Meta가 필수 웹후크 구독 필드를 반환했습니다.${subscriptionChecked}`, "hint"));
    // Meta reported that the account owner removed the app in Instagram; the server disconnected the account.
    if (account.deauthorized_at)
      item.append(
        node(
          "p",
          `${new Date(account.deauthorized_at).toLocaleString("ko-KR")} · 계정 소유자가 Instagram에서 이 앱의 권한을 해제해 연결이 해제됐습니다. 수신과 발송, 이 계정의 댓글 규칙과 플로우가 꺼졌습니다. 다시 사용하려면 상단의 '계정 연결'에서 같은 Instagram 계정을 다시 선택해 주세요.`,
          "hint",
        ),
      );
    const healthStatus = node(
      "p",
      healthResults.get(account.id) ?? "Meta 계정과 웹훅 구독 상태는 아직 확인하지 않았습니다.",
      "hint",
    );
    healthResults.delete(account.id);
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
        // The check also stores the subscription record and the reconnect marker; reload so the badges match.
        healthResults.set(account.id, healthStatus.textContent);
        await loadWorkspace();
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
  flowEditor.initialize();
  void loadContactSegments();
  await loadContactFields();
  if (generation !== segmentsGeneration || workspaceSession !== workspaceGeneration) return;
  if (!contactsDirty.size && !contactsSaving) void loadContacts();
  try {
    await loadActivity();
  } catch (error) {
    if (generation !== segmentsGeneration || workspaceSession !== workspaceGeneration) return;
    if (error.status === 401) throw error;
    byId("activity").replaceChildren(
      emptyState(
        "처리 내역을 불러오지 못했습니다",
        "새로고침을 눌러 다시 시도해 주세요. 계정과 규칙 설정은 계속할 수 있습니다.",
      ),
    );
  }
  if (firstDisplay) scrollToSectionHash();
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
        .catch((error) => {
          if (!target.isConnected) return;
          if (error.code === "media_rate_limited") {
            target.replaceChildren(
              node("strong", "게시물 정보 조회가 잠시 제한되었습니다"),
              node("span", "1분 뒤 자동으로 다시 확인합니다."),
            );
            setTimeout(() => {
              if (target.isConnected) ruleMediaObserver.observe(target);
            }, 60_000);
            return;
          }
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
    } finally {
      contactCsvPreview.sessionChanged();
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
byId("invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (inviteLinkLocked()) return;
  const inviteForm = event.currentTarget;
  await action(inviteForm.querySelector("button[type=submit]"), async () => {
    invitePending = true;
    inviteControls();
    try {
      const generation = segmentsGeneration;
      const created = await api("/api/workspace/invites", "POST", {
        email: inviteForm.elements.email.value,
        role: inviteForm.elements.role.value,
      });
      // A session reset while the request was in flight must not reveal the link to the next session.
      if (generation !== segmentsGeneration) return;
      showInviteLink(created.link);
      inviteForm.reset();
      notice(`${created.email} 초대 링크를 만들었습니다. 이 화면을 벗어나면 링크를 다시 볼 수 없습니다.`);
      await loadMembers();
    } finally {
      invitePending = false;
    }
  });
  // action() restores the disabled state it found before the task, so the lock is applied again here.
  inviteControls();
});
byId("dismiss-invite").addEventListener("click", hideInviteLink);
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
    const changed = saved.time_zone !== workspaceTimeZone;
    workspaceTimeZone = saved.time_zone;
    // Reminder due times on screen are wall-clock values in the previous zone.
    if (changed) {
      inbox.timeZoneChanged();
      campaignDrafts.timeZoneChanged(workspaceTimeZone);
      manualReports.configure(currentRole, workspaceTimeZone, connections);
      void flowReports.configure(currentRole, workspaceTimeZone, connections);
      handoffReports.configure(currentRole, workspaceTimeZone, connections);
    }
    notice(`시간대를 저장했습니다(${saved.time_zone}). 지금부터 정한 시각까지 기다리기 시작하는 실행에 적용됩니다.`);
  });
});
byId("operations-refresh").addEventListener("click", (event) => action(event.currentTarget, loadOperations));
byId("webhooks-refresh").addEventListener("click", (event) => action(event.currentTarget, loadWebhooks));
byId("webhook-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const webhookForm = event.currentTarget;
  webhookSecretAction(webhookForm.querySelector("button[type=submit]"), async () => {
    const generation = segmentsGeneration;
    const created = await api("/api/webhooks/endpoints", "POST", {
      name: webhookForm.elements.name.value,
      url: webhookForm.elements.url.value.trim(),
    });
    if (generation !== segmentsGeneration) return;
    showWebhookSecret(created.name, created.key);
    webhookForm.reset();
    notice(`"${created.name}" 주소를 추가했습니다. 서명 비밀은 지금 한 번만 보여 줍니다.`);
    await loadWebhooks();
  });
});
byId("copy-webhook-secret").addEventListener("click", async () => {
  const secret = byId("webhook-secret-value");
  try {
    await navigator.clipboard.writeText(secret.value);
    notice("서명 비밀을 복사했습니다.");
  } catch {
    secret.select();
    notice("서명 비밀을 선택했습니다. 직접 복사해 주세요.", true);
  }
});
byId("dismiss-webhook-secret").addEventListener("click", hideWebhookSecret);
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
// Independent of contact-list generations: changing filters never narrows or cancels an export in flight. Only one
// export runs at a time; archiving the exported segment, a connection deletion or a session change cancels it.
const contactExportLabels = {
  "contacts-export": "전체 연락처 CSV",
  "contacts-segment-export": "선택한 필터로 내보내기",
};
function contactExportControls() {
  byId("contacts-export").disabled = contactsExportBusy;
  // The saved definition is exported, so an edit with unsaved changes must be saved or cancelled first.
  byId("contacts-segment-export").disabled =
    contactsExportBusy || segmentBusy || !activeSegmentId || Boolean(editingSegment && segmentEditChanged());
}
function invalidateContactExport(message = "") {
  contactsExportGeneration++;
  contactsExportBusy = false;
  contactsExportSegmentId = "";
  for (const [id, label] of Object.entries(contactExportLabels)) {
    byId(id).textContent = label;
    byId(id).removeAttribute("aria-busy");
  }
  contactExportControls();
  byId("contacts-export-status").textContent = message;
}
async function downloadContactCsv(button, path, fileName, progress, done, segmentId = "") {
  if (contactsExportBusy || !["owner", "admin"].includes(currentRole)) return;
  const generation = contactsExportGeneration;
  const status = byId("contacts-export-status");
  contactsExportBusy = true;
  contactsExportSegmentId = segmentId;
  contactExportControls();
  button.textContent = "내보내는 중…";
  button.setAttribute("aria-busy", "true");
  status.textContent = progress;
  try {
    const text = await api(path, "GET", undefined, true, true);
    if (generation !== contactsExportGeneration) return;
    // Response.text() removes a UTF-8 BOM during decoding. Restore exactly one in the actual file.
    const normalized = "\ufeff" + text.replace(/^\ufeff/, "");
    const exportedOn = /\r\n"1","(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(new Blob([normalized], { type: "text/csv;charset=utf-8" }));
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName(exportedOn);
      link.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    status.textContent = done;
  } catch (error) {
    if (generation === contactsExportGeneration) status.textContent = error.message;
  } finally {
    if (generation === contactsExportGeneration) {
      contactsExportBusy = false;
      contactsExportSegmentId = "";
      button.textContent = contactExportLabels[button.id];
      button.removeAttribute("aria-busy");
      contactExportControls();
    }
  }
}
byId("contacts-export").addEventListener("click", (event) =>
  downloadContactCsv(
    event.currentTarget,
    "/api/contacts/export.csv",
    (exportedOn) => `auto-chatter-contacts-v1-${exportedOn}.csv`,
    "저장된 전체 연락처 CSV를 만들고 있습니다…",
    "전체 연락처 CSV를 저장했습니다. 필터와 저장 전 수정은 적용하지 않았습니다. 개인정보가 포함되므로 안전하게 보관하세요.",
  ),
);
byId("contacts-segment-export").addEventListener("click", (event) => {
  const segment = contactSegments.find((value) => value.id === activeSegmentId);
  if (!segment || event.currentTarget.disabled) return;
  void downloadContactCsv(
    event.currentTarget,
    `/api/contacts/export.csv?${new URLSearchParams({ segment_id: segment.id })}`,
    (exportedOn) => `auto-chatter-contacts-v1-segment-${segment.id}-${exportedOn}.csv`,
    `저장된 "${segment.name}" 필터에 맞는 연락처 CSV를 만들고 있습니다…`,
    `"${segment.name}" 필터에 맞는 연락처 CSV를 저장했습니다. 저장된 필터 조건으로 만들었고 화면의 저장 전 수정은 적용하지 않았습니다. 개인정보가 포함되므로 안전하게 보관하세요.`,
    segment.id,
  );
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
// Refusals the OAuth callback sends back to the dashboard as ?instagram=<code> (src/app/api.ts).
const instagramErrors = [
  "instagram_authorization_denied",
  "instagram_permissions_required",
  "connection_limit_reached",
];
async function start() {
  if (acceptedAuthRevision !== authSessionRevision()) {
    // An explicit reload discards the previous account's entire UI before adopting
    // the new revision. Background loadWorkspace calls must never adopt it.
    location.reload();
    return;
  }
  const instagramResult = new URLSearchParams(location.search).get("instagram");
  if (instagramErrors.includes(instagramResult)) {
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
        authLinkNotice.startsWith("인증 또는 변경 링크") || instagramErrors.includes(instagramResult),
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
  invalidateSegmentPreview();
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
  item.append(contactDetail(contact));
  return item;
}
// Independent read-only disclosure: never re-render the tag/field editors or replace their drafts.
function contactDetail(contact) {
  const details = node("details", "", "contact-detail");
  const summary = node("summary", "상세 보기");
  const status = node("p", "", "hint");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const content = node("div", "", "contact-detail-content");
  const refresh = node("button", "상세 새로고침", "secondary");
  const more = node("button", "다음 대화 보기", "secondary");
  refresh.type = more.type = "button";
  more.hidden = true;
  const controls = node("div", "", "contact-detail-controls");
  controls.append(refresh, more);
  details.append(summary, status, controls, content);
  const generation = contactsGeneration;
  let requestId = 0;
  let after = null;
  const date = (value) => new Date(value).toLocaleString("ko-KR");
  const section = (title) => {
    const part = node("section");
    part.append(node("h4", title));
    return part;
  };
  function consentRecords(records) {
    const list = node("ul", "", "contact-consent");
    const evidence = { explicit: "명시적 확인", comment: "댓글", inbound_dm: "수신 DM", import: "가져온 자료" };
    for (const [purpose, label] of [
      ["service_reply", "서비스 답장"],
      ["marketing", "마케팅"],
    ]) {
      const record = records.find((item) => item.purpose === purpose);
      const entry = node("li");
      entry.append(
        node(
          "strong",
          `${label} · ${record ? (record.decision === "revoke" ? "철회 기록" : "동의 기록") : "기록 없음"}`,
        ),
      );
      if (record)
        entry.append(
          node(
            "p",
            `근거 종류: ${evidence[record.evidence_kind] || "확인 전"} · 근거 발생: ${date(record.occurred_at)} · 서버 기록: ${date(record.recorded_at)}`,
            "hint",
          ),
        );
      list.append(entry);
    }
    return list;
  }
  function render(detail) {
    const facts = section("저장된 연락처 정보");
    facts.append(
      node("p", `댓글 참여자 ${detail.sender_id} · 댓글 ${detail.comment_count}개`),
      node("p", `첫 댓글 ${date(detail.first_comment_at)} · 최근 댓글 ${date(detail.last_comment_at)}`, "hint"),
    );
    const tags = node("div", "", "badges");
    for (const tag of detail.tags) tags.append(badge(tag));
    if (!detail.tags.length) tags.append(node("span", "태그 없음", "hint"));
    facts.append(tags);
    const fields = section("추가 정보");
    for (const field of detail.fields)
      fields.append(
        node(
          "p",
          `${field.name} · ${fieldTypeLabels[field.type]} · ${field.value === null ? "미설정" : displayFieldValue(field.value)}`,
        ),
      );
    if (!detail.fields.length) fields.append(node("p", "활성 필드가 없습니다.", "hint"));
    const pause = section("자동화 중지 사유");
    const reasons = [];
    if (detail.automation.manual_paused) reasons.push("직접 중지");
    if (detail.automation.handoff_paused) reasons.push("상담 전환으로 중지");
    pause.append(node("p", reasons.length ? reasons.join(" · ") : "연락처 중지 설정 없음"));
    const consent = section("댓글 참여자의 동의 기록");
    consent.append(
      consentRecords(detail.consent),
      node(
        "p",
        "같은 작업 공간·연결·식별자·목적의 현재 기록입니다. 기록 없음이나 다른 식별자의 동의를 발송 허가로 보지 않습니다.",
        "hint",
      ),
    );
    const conversations = section("연결 근거가 확인된 DM 대화");
    conversations.append(
      node(
        "p",
        "현재 연결 근거가 확인된 저장 대화만 표시합니다. 전체 대화 이력이나 발송 가능 여부를 뜻하지 않습니다. 대화마다 동의 범위를 따로 표시합니다.",
        "hint",
      ),
    );
    for (const conversation of detail.conversations) {
      const row = node("article", "", "contact-detail-conversation");
      row.append(
        node("h5", `DM 상대 ${conversation.recipient_id}`),
        node(
          "p",
          `저장 메시지 ${conversation.message_count}개 · ${conversation.state === "closed" ? "종료된 대화" : "열린 대화"} · ${conversation.handoff_active ? "상담 전환 중" : "상담 전환 없음"}`,
        ),
        node(
          "p",
          `첫 수신 ${date(conversation.first_message_at)} · 최근 수신 ${date(conversation.last_message_at)}`,
          "hint",
        ),
        node("p", `연결 근거 답장 기록 ${conversation.evidence_reply_id}`, "hint"),
        consentRecords(conversation.consent),
      );
      conversations.append(row);
    }
    if (!detail.conversations.length) conversations.append(node("p", "현재 조회에서 표시할 대화가 없습니다.", "hint"));
    const identityRequest = requestId;
    const identityLinks = createContactIdentityLinks({
      api,
      node,
      contact,
      isCurrent: () =>
        identityRequest === requestId && generation === contactsGeneration && details.isConnected && details.open,
    });
    content.replaceChildren(facts, fields, pause, consent, conversations, identityLinks);
  }
  async function load(next = false) {
    const id = ++requestId;
    const current = () => id === requestId && generation === contactsGeneration && details.isConnected && details.open;
    const cursor = next ? after : null;
    after = null;
    content.replaceChildren();
    more.hidden = true;
    refresh.disabled = true;
    details.setAttribute("aria-busy", "true");
    status.textContent = "상세 정보를 불러오고 있습니다…";
    try {
      const detail = await api(
        `/api/connections/${contact.connection_id}/contacts/${encodeURIComponent(contact.sender_id)}${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (!current()) return;
      render(detail);
      after = detail.after;
      more.hidden = !after;
      status.textContent = `${next ? "다음 대화 페이지" : "현재 저장된 정보"} · 대화 ${detail.conversations.length}개. 편집 중인 내용은 저장 후 상세 새로고침으로 확인해 주세요.`;
    } catch (error) {
      if (current()) status.textContent = `${error.message} 상세 새로고침으로 다시 시도할 수 있습니다.`;
    } finally {
      if (current()) {
        refresh.disabled = false;
        details.removeAttribute("aria-busy");
      }
    }
  }
  details.addEventListener("toggle", () => {
    if (details.open) void load();
    else {
      requestId++;
      content.replaceChildren();
      status.textContent = "";
      details.removeAttribute("aria-busy");
    }
  });
  refresh.addEventListener("click", () => {
    void load();
  });
  more.addEventListener("click", () => {
    if (after) void load(true);
  });
  return details;
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
function contactActivityControls() {
  const fields = byId("contacts-filter").elements;
  const mode = fields.activity_mode.value;
  const relative = mode === "relative",
    calendar = mode === "calendar";
  byId("contact-activity-days").hidden = !relative;
  fields.last_comment_days.disabled = !relative;
  fields.last_comment_days.required = relative;
  byId("contact-activity-period").hidden = !calendar;
  fields.last_comment_period.disabled = !calendar;
  for (const key of ["from", "before"]) {
    byId(`contact-activity-${key}`).hidden = mode !== "fixed";
    fields[`last_comment_${key}`].disabled = mode !== "fixed";
  }
}
const calendarPeriodLabels = { today: "오늘", yesterday: "어제", this_month: "이번 달", last_month: "지난달" };
function contactActivityWindow() {
  const fields = byId("contacts-filter").elements;
  if (fields.activity_mode.value === "calendar") {
    const period = fields.last_comment_period.value;
    if (!Object.hasOwn(calendarPeriodLabels, period)) throw new Error(errors.invalid_contact_activity);
    return { last_comment_period: period };
  }
  if (fields.activity_mode.value === "relative") {
    const days = fields.last_comment_days.value;
    if (!/^[1-9][0-9]{0,2}$/.test(days) || !fields.last_comment_days.validity.valid || Number(days) > 366)
      throw new Error(errors.invalid_contact_activity);
    return { last_comment_days: Number(days) };
  }
  const from = fields.last_comment_from.value,
    before = fields.last_comment_before.value;
  if (!from && !before) return null;
  const start = new Date(`${from}Z`),
    end = new Date(`${before}Z`);
  if (
    !from ||
    !before ||
    !fields.last_comment_from.validity.valid ||
    !fields.last_comment_before.validity.valid ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start >= end
  )
    throw new Error(errors.invalid_contact_activity);
  return { last_comment_from: start.toISOString(), last_comment_before: end.toISOString() };
}
// label names the window in its text: empty for comment activity, "DM " for the recent received DM window.
function relativeActivitySummary(window, days, label = "") {
  if (!days) return "";
  const valid = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value);
  const milliseconds = (value) => Date.parse(value.slice(0, -4) + "Z");
  if (
    !valid(window?.from) ||
    !valid(window?.before) ||
    milliseconds(window.before) - milliseconds(window.from) !== Number(days) * 86400000
  )
    throw new Error(`최근 ${label}활동의 조회 기간을 확인할 수 없습니다.`);
  return ` 이번 ${label}조회 기간(UTC): ${window.from} 이상, ${window.before} 미만. 조회와 다음 페이지마다 다시 계산합니다.`;
}
function calendarActivitySummary(window, period) {
  if (!period) return "";
  const valid = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value);
  if (
    !Object.hasOwn(calendarPeriodLabels, period) ||
    !valid(window?.from) ||
    !valid(window?.before) ||
    window.from >= window.before ||
    typeof window.time_zone !== "string" ||
    !window.time_zone
  )
    throw new Error("달력 기간의 조회 경계를 확인할 수 없습니다.");
  return (
    ` 이번 조회 기간: ${window.time_zone} 시간대의 ${calendarPeriodLabels[period]}, UTC ${window.from} 이상 ${window.before} 미만.` +
    " 조회와 다음 페이지마다 작업 공간 시간대로 다시 계산합니다."
  );
}
function contactTagInputs() {
  const fields = byId("contacts-filter").elements;
  return contactTagInputNames.map((name) => fields[name]);
}
// The distinct tags on screen, compared the way the server normalizes them; the first spelling is kept.
function contactFilterTags() {
  const seen = new Set();
  const tags = [];
  for (const input of contactTagInputs()) {
    const value = input.value.trim();
    const key = value.normalize("NFC").toLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      tags.push(value);
    }
  }
  return tags;
}
// Shows the next tag input once the one before it has a value, and the mode only for two or more tags.
function contactTagControls() {
  const inputs = contactTagInputs();
  inputs.forEach((input, index) => {
    input.closest("label").hidden = index > 0 && !input.value.trim() && !inputs[index - 1].value.trim();
  });
  const fields = byId("contacts-filter").elements;
  fields.tag_mode.disabled = contactFilterTags().length < 2;
  if (fields.tag_mode.disabled) fields.tag_mode.value = "all";
}
// The comment consent pair and the DM consent pair: clearing a purpose clears and disables its state.
function contactConsentControls() {
  const fields = byId("contacts-filter").elements;
  for (const prefix of ["", "dm_"]) {
    fields[`${prefix}consent_state`].disabled = !fields[`${prefix}consent_purpose`].value;
    if (!fields[`${prefix}consent_purpose`].value) fields[`${prefix}consent_state`].value = "";
  }
}
function contactConsentCondition() {
  const fields = byId("contacts-filter").elements;
  const purpose = fields.consent_purpose.value,
    state = fields.consent_state.value;
  if (!purpose && !state) return null;
  if (!["service_reply", "marketing"].includes(purpose) || !["granted", "revoked", "no_record"].includes(state))
    throw new Error(errors.invalid_contact_consent);
  return { consent_purpose: purpose, consent_state: state };
}
// The recorded state of the contact's verified DM conversations; the server checks the same pair.
function contactDmConsentCondition() {
  const fields = byId("contacts-filter").elements;
  const purpose = fields.dm_consent_purpose.value,
    state = fields.dm_consent_state.value;
  if (!purpose && !state) return null;
  if (!["service_reply", "marketing"].includes(purpose) || !["granted", "revoked", "no_record"].includes(state))
    throw new Error(errors.invalid_contact_consent);
  return { dm_consent_purpose: purpose, dm_consent_state: state };
}
// Recent received DMs of the contact's verified DM conversations; an empty field means no condition. A number
// input reads as empty for text it cannot parse, so badInput refuses that instead of dropping the condition.
function contactDmActivityCondition() {
  const input = byId("contacts-filter").elements.last_dm_days;
  const days = input.value;
  if (!days && !input.validity.badInput) return null;
  if (!/^[1-9][0-9]{0,2}$/.test(days) || !input.validity.valid || Number(days) > 366)
    throw new Error("최근 받은 DM 일수는 1~366 사이의 정수로 입력하거나 비워 주세요.");
  return { last_dm_days: Number(days) };
}
function contactDraftQuery() {
  const fields = byId("contacts-filter").elements;
  // A tree replaces the tag and field conditions and their operator; the limits below still apply. An incomplete
  // tree throws its reason, so no request is sent for it.
  const tree = conditionTreeRequest();
  const fieldKeys = draftConditionTree ? {} : contactFieldConditionKeys();
  const activity = contactActivityWindow();
  const consent = contactConsentCondition();
  const dmConsent = contactDmConsentCondition();
  const dmActivity = contactDmActivityCondition();
  const query = new URLSearchParams();
  if (fields.connection_id.value) query.set("connection_id", fields.connection_id.value);
  const tags = draftConditionTree ? [] : contactFilterTags();
  for (const value of tags) query.append("tag", value);
  if (tags.length > 1) query.set("tag_mode", fields.tag_mode.value);
  if (!draftConditionTree && fields.condition_operator.value === "or") query.set("condition_operator", "or");
  if (tree) query.set("condition_tree", JSON.stringify(tree));
  if (activity) for (const [key, value] of Object.entries(activity)) query.set(key, value);
  if (consent) for (const [key, value] of Object.entries(consent)) query.set(key, value);
  if (dmConsent) for (const [key, value] of Object.entries(dmConsent)) query.set(key, value);
  if (dmActivity) query.set("last_dm_days", dmActivity.last_dm_days);
  for (const [key, value] of Object.entries(fieldKeys))
    query.set(key, key === "field_value" || key === "field_conditions" ? JSON.stringify(value) : value);
  return query;
}
async function loadContacts(more = false) {
  if (contactsSaving || (more && (contactsBusy || !contactsAfter))) return;
  let query;
  if (!more) {
    try {
      query = activeSegmentId ? new URLSearchParams({ segment_id: activeSegmentId }) : contactDraftQuery();
    } catch (error) {
      // As before the field rows, an empty or unknown first field clears the list; a later row clears it only for an unknown field.
      const rows = fieldFilterRows();
      if (
        !contactFields.some((field) => field.id === rows[0].field.value) ||
        rows.some((row) => row.shown && row.field.value && !contactFields.some((field) => field.id === row.field.value))
      ) {
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
    contactsQuery = query.toString();
    byId("contacts-list").replaceChildren();
    byId("contacts-more").hidden = true;
  }
  const generation = contactsGeneration;
  contactsBusy = true;
  byId("contacts-more").disabled = true;
  byId("contacts-status").textContent = "연락처를 불러오고 있습니다…";
  query = new URLSearchParams(contactsQuery);
  if (more) query.set("after", contactsAfter);
  try {
    const page = await api(`/api/contacts?${query}`);
    if (generation !== contactsGeneration) return;
    const segment = contactSegments.find((s) => s.id === query.get("segment_id"));
    const days = query.get("last_comment_days") || segment?.last_comment_days;
    const calendar = query.get("last_comment_period") || segment?.last_comment_period;
    const dmDays = query.get("last_dm_days") || segment?.last_dm_days;
    const period =
      relativeActivitySummary(page.activity_window, days) +
      calendarActivitySummary(page.activity_window, calendar) +
      relativeActivitySummary(page.dm_activity_window, dmDays, "DM ");
    for (const contact of page.contacts)
      if (!purgedContactConnections.has(contact.connection_id)) byId("contacts-list").append(contactCard(contact));
    contactsAfter = page.after;
    byId("contacts-more").hidden = !contactsAfter;
    byId("contacts-status").textContent =
      `연락처 ${byId("contacts-list").children.length}명을 표시합니다. 같은 계정의 반복 댓글은 한 명으로 묶습니다.` +
      period;
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

function invalidateSegmentPreview() {
  segmentPreviewRequest++;
  byId("segment-preview").removeAttribute("aria-disabled");
  byId("segment-preview").removeAttribute("aria-busy");
  byId("segment-preview-status").textContent = "";
  byId("segment-preview-exclusions").replaceChildren();
  byId("segment-preview-list").replaceChildren();
}
byId("segment-preview").addEventListener("click", async () => {
  const button = byId("segment-preview");
  if (button.getAttribute("aria-disabled") === "true") return;
  invalidateSegmentPreview();
  const request = segmentPreviewRequest;
  const generation = segmentsGeneration;
  const current = () => request === segmentPreviewRequest && generation === segmentsGeneration;
  const status = byId("segment-preview-status");
  // Keep keyboard focus while preventing duplicate requests.
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("aria-busy", "true");
  try {
    const query = contactDraftQuery();
    query.set("preview", "true");
    status.textContent = "현재 조건에 맞는 연락처를 확인하고 있습니다…";
    const page = await api(`/api/contacts?${query}`);
    if (!current()) return;
    const period =
      relativeActivitySummary(page.activity_window, query.get("last_comment_days")) +
      calendarActivitySummary(page.activity_window, query.get("last_comment_period")) +
      relativeActivitySummary(page.dm_activity_window, query.get("last_dm_days"), "DM ");
    const activityCount =
      query.has("last_comment_from") || query.has("last_comment_days") || query.has("last_comment_period")
        ? page.excluded?.activity
        : "0";
    const consentCount = query.has("consent_purpose") ? page.excluded?.consent : "0";
    const dmIdentityCount =
      query.has("dm_consent_purpose") || query.has("last_dm_days") ? page.excluded?.dm_identity : "0";
    const dmConsentCount = query.has("dm_consent_purpose") ? page.excluded?.dm_consent : "0";
    const dmActivityCount = query.has("last_dm_days") ? page.excluded?.dm_activity : "0";
    // A tree has one reason after the limits; the other forms split tag and field mismatches.
    const conditionReasons = query.has("condition_tree")
      ? [[page.excluded?.conditions, "그룹 조건 불일치"]]
      : [
          [page.excluded?.tag, "태그 조건만 불일치"],
          [page.excluded?.field, "추가 정보 조건만 불일치"],
          [page.excluded?.both, "태그·추가 정보 조건 모두 불일치"],
        ];
    const counts = [
      page.total,
      page.evaluated,
      ...conditionReasons.map(([count]) => count),
      activityCount,
      consentCount,
      dmIdentityCount,
      dmConsentCount,
      dmActivityCount,
    ];
    if (counts.some((value) => typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)))
      throw new Error("대상 수와 제외 사유를 확인할 수 없습니다.");
    const excludedTotal =
      BigInt(activityCount) +
      BigInt(consentCount) +
      BigInt(dmIdentityCount) +
      BigInt(dmConsentCount) +
      BigInt(dmActivityCount) +
      conditionReasons.reduce((total, [count]) => total + BigInt(count), 0n);
    if (BigInt(page.evaluated) !== BigInt(page.total) + excludedTotal)
      throw new Error("대상 수와 제외 사유를 확인할 수 없습니다.");
    status.textContent =
      `조회 시점의 대상은 총 ${page.total}명입니다. 선택 계정 범위 ${page.evaluated}명 중 ${excludedTotal}명이 조건과 맞지 않습니다.` +
      (page.total === "0" ? " 조건에 맞는 연락처가 없습니다." : " 아래에 최대 5명의 예시를 표시합니다.") +
      period;
    for (const [count, label] of [
      [activityCount, "활동 기간 밖 (먼저 제외)"],
      [consentCount, "동의 기록 조건 불일치"],
      [dmIdentityCount, "확인된 DM 대화 없음"],
      [dmConsentCount, "DM 동의 기록 조건 불일치"],
      [dmActivityCount, "최근 받은 DM 없음"],
      ...conditionReasons,
    ]) {
      if (count !== "0") byId("segment-preview-exclusions").append(node("li", `${label}: ${count}명`));
    }
    for (const contact of page.contacts.slice(0, 5)) {
      const item = node("li");
      item.append(
        node(
          "p",
          `참여자 ${contact.sender_id} · 연결 계정 ${contact.username ? `@${contact.username}` : "이름 확인 전"}`,
        ),
      );
      byId("segment-preview-list").append(item);
    }
  } catch (error) {
    if (current()) status.textContent = `${error.message} 조건을 확인하고 다시 미리보기해 주세요.`;
  } finally {
    if (current()) {
      button.removeAttribute("aria-disabled");
      button.removeAttribute("aria-busy");
    }
  }
});

function segmentControls() {
  // Choosing another saved segment would overwrite the conditions being edited.
  byId("contact-segment").disabled = segmentBusy || Boolean(editingSegment);
  byId("segment-archive").disabled = segmentBusy || !activeSegmentId;
  byId("segment-edit").hidden = currentRole !== "owner" && currentRole !== "admin";
  byId("segment-edit").disabled = segmentBusy || !activeSegmentId || Boolean(editingSegment);
  conditionTreeControls();
  byId("segment-save").elements.name.disabled = segmentBusy;
  byId("segment-save").querySelector("button").disabled = segmentBusy;
  // While a save is in flight, action() shows the loading label; the trailing segmentControls() call restores it.
  if (!segmentBusy)
    byId("segment-save").querySelector("button").textContent = editingSegment ? "변경 저장" : "필터 저장";
  byId("segment-edit-cancel").hidden = !editingSegment;
  byId("segment-edit-cancel").disabled = segmentBusy;
  byId("segment-edit-reload").disabled = segmentBusy;
  // A segment request sends the conditions on screen; holding them until it ends keeps the saved and shown values equal.
  // The fieldset leaves each control's own disabled state alone, so conditional states come back unchanged.
  byId("contacts-filter-fields").disabled = segmentBusy;
  contactExportControls();
  // Like the segment export, a freeze uses the saved definition, so an unsaved edit must be saved or cancelled first.
  segmentSnapshots.sync(
    contactSegments.find((segment) => segment.id === activeSegmentId) ?? null,
    segmentBusy || Boolean(editingSegment && segmentEditChanged()),
  );
}
// Leaves edit mode. By default the operator's draft stays: the filter form keeps its conditions, the name field keeps
// its value, and a changed draft stays marked unsaved, because segmentEditChanged() ends with edit mode.
// Pass discard only where the operator chose to drop the draft (cancel, archive after its confirmation) or where
// nothing unsaved can remain (a successful save, a session reset).
function leaveSegmentEdit({ discard = false } = {}) {
  segmentNameDirty = segmentNameDirty || segmentEditChanged();
  editingSegment = null;
  byId("segment-edit-status").textContent = "";
  byId("segment-edit-conflict").hidden = true;
  byId("segment-edit-saved").textContent = "";
  if (discard) {
    byId("segment-save").reset();
    segmentNameDirty = false;
  }
}
// While a tree is part of the draft, the tag and field inputs are disabled and the group editor is shown instead.
// The three mode selects keep their own state functions, which every path that removes the tree runs again, so they
// are only forced off here. The editor's own controls are rebuilt by renderConditionTree, not here, so typing keeps
// its focus; this only refreshes the reason the draft cannot be sent yet.
function conditionTreeControls() {
  const tree = Boolean(draftConditionTree);
  const fields = byId("contacts-filter").elements;
  for (const input of contactTagInputs()) input.disabled = tree;
  for (const row of fieldFilterRows())
    row.field.disabled = row.operator.disabled = row.value.disabled = row.boolean.disabled = tree;
  for (const id of ["field-filter-add", "field-filter-remove-2", "field-filter-remove-3"]) byId(id).disabled = tree;
  if (tree) for (const name of ["tag_mode", "field_mode", "condition_operator"]) fields[name].disabled = true;
  byId("contact-condition-tree").hidden = !tree;
  byId("contact-condition-tree-start").hidden = tree;
  byId("contact-condition-tree-clear").disabled = segmentBusy;
  byId("contact-condition-tree-status").textContent = tree
    ? segmentTreeBuild(draftConditionTree, contactFields).error
    : "";
}
// The tree of the draft for a request, or null without one; an incomplete draft throws the model's reason.
function conditionTreeRequest() {
  const { tree, error } = segmentTreeBuild(draftConditionTree, contactFields);
  if (error) throw new Error(error);
  return tree;
}
const conditionTreeKindLabels = { tag: "태그 있음", no_tag: "태그 없음", field: "추가 정보 조건" };
// An operator's label for a field type, the words of the field rows.
function conditionTreeOperatorLabel(type, operator) {
  return (
    { eq: "값이 같음", is_set: "입력됨", is_unset: "미입력" }[operator] ??
    orderedOperatorLabels(type)[operator] ??
    operator
  );
}
function conditionTreeSelect(label, options, value, data) {
  const wrapper = node("label", label);
  const select = document.createElement("select");
  for (const [optionValue, text] of options) select.add(new Option(text, optionValue));
  select.value = value;
  Object.assign(select.dataset, data);
  wrapper.append(select);
  return wrapper;
}
function conditionTreeButton(text, label, data, disabled = false, reasonId = "") {
  const button = node("button", text, "secondary");
  button.type = "button";
  button.setAttribute("aria-label", label);
  Object.assign(button.dataset, data);
  button.disabled = disabled;
  if (reasonId) button.setAttribute("aria-describedby", reasonId);
  return button;
}
// One leaf row: its kind, its tag or its field, operator and value with the field rows' per-type behaviour, and its
// move and remove controls. Controls carry no name, so the filter form's named elements stay the existing ones.
function conditionTreeLeafRow(group, groupIndex, leaf, leafIndex) {
  const place = `그룹 ${groupIndex + 1} 조건 ${leafIndex + 1}`;
  const data = { treeGroup: String(groupIndex), treeLeaf: String(leafIndex) };
  const row = node("div", "", "condition-tree-leaf");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", place);
  row.append(
    conditionTreeSelect(`조건 ${leafIndex + 1}`, Object.entries(conditionTreeKindLabels), leaf.kind, {
      ...data,
      treeInput: "kind",
    }),
  );
  if (leaf.kind === "field") {
    const field = contactFields.find((definition) => definition.id === leaf.field_id);
    const fieldOptions = [["", "필드 선택"], ...contactFields.map((definition) => [definition.id, definition.name])];
    if (leaf.field_id && !field) fieldOptions.push([leaf.field_id, "사용할 수 없는 필드"]);
    row.append(conditionTreeSelect("추가 정보", fieldOptions, leaf.field_id, { ...data, treeInput: "field_id" }));
    if (leaf.field_id) {
      const operators = segmentTreeOperators(field?.type);
      if (!operators.includes(leaf.field_operator)) operators.push(leaf.field_operator);
      row.append(
        conditionTreeSelect(
          "조건",
          operators.map((operator) => [operator, conditionTreeOperatorLabel(field?.type, operator)]),
          leaf.field_operator,
          { ...data, treeInput: "field_operator" },
        ),
      );
    }
    if (leaf.field_id && segmentTreeNeedsValue(leaf.field_operator)) {
      if (field?.type === "boolean")
        row.append(
          conditionTreeSelect(
            "찾을 값",
            [
              ["true", "예"],
              ["false", "아니요"],
            ],
            leaf.boolean,
            { ...data, treeInput: "boolean" },
          ),
        );
      else {
        const wrapper = node("label", "찾을 값");
        const input = document.createElement("input");
        configureFieldInput(input, field);
        input.value = leaf.value;
        Object.assign(input.dataset, { ...data, treeInput: "value" });
        wrapper.append(input);
        row.append(wrapper);
      }
    }
  } else {
    const wrapper = node("label", "태그");
    const input = document.createElement("input");
    input.maxLength = 40;
    input.value = leaf.tag;
    Object.assign(input.dataset, { ...data, treeInput: "tag" });
    wrapper.append(input);
    row.append(wrapper);
  }
  const last = group.conditions.length - 1;
  row.append(
    conditionTreeButton("위로", `${place} 위로 이동`, { ...data, treeAction: "leaf-up" }, leafIndex === 0),
    conditionTreeButton("아래로", `${place} 아래로 이동`, { ...data, treeAction: "leaf-down" }, leafIndex === last),
    conditionTreeButton("삭제", `${place} 삭제`, { ...data, treeAction: "leaf-remove" }),
  );
  return row;
}
function conditionTreeGroupBox(draft, group, groupIndex) {
  const title = `그룹 ${groupIndex + 1}`;
  const data = { treeGroup: String(groupIndex) };
  const box = document.createElement("fieldset");
  box.className = "condition-tree-group";
  box.append(node("legend", title));
  box.append(
    conditionTreeSelect(
      `${title} 안의 조건 결합`,
      [
        ["all", "모두 만족"],
        ["any", "하나 이상 만족"],
      ],
      group.mode,
      { ...data, treeInput: "group-mode" },
    ),
  );
  group.conditions.forEach((leaf, leafIndex) => box.append(conditionTreeLeafRow(group, groupIndex, leaf, leafIndex)));
  if (!group.conditions.length) box.append(node("p", "아직 조건이 없습니다. 조건을 추가해 주세요.", "hint"));
  const addBlock = segmentTreeAddLeafBlock(draft, groupIndex);
  const removeBlock = segmentTreeRemoveGroupBlock(draft);
  const reasonId = `contact-condition-tree-group-${groupIndex + 1}-reason`;
  const actions = node("div", "", "condition-tree-actions");
  actions.append(
    conditionTreeButton(
      "조건 추가",
      `${title}에 조건 추가`,
      { ...data, treeAction: "leaf-add" },
      Boolean(addBlock),
      addBlock ? reasonId : "",
    ),
    conditionTreeButton("그룹 위로", `${title} 위로 이동`, { ...data, treeAction: "group-up" }, groupIndex === 0),
    conditionTreeButton(
      "그룹 아래로",
      `${title} 아래로 이동`,
      { ...data, treeAction: "group-down" },
      groupIndex === draft.groups.length - 1,
    ),
    conditionTreeButton(
      "그룹 삭제",
      `${title} 삭제`,
      { ...data, treeAction: "group-remove" },
      Boolean(removeBlock),
      removeBlock ? reasonId : "",
    ),
  );
  box.append(actions);
  const reasons = [addBlock, removeBlock].filter(Boolean);
  if (reasons.length) {
    const reason = node("p", reasons.join(" "), "hint");
    reason.id = reasonId;
    box.append(reason);
  }
  return box;
}
// Rebuilds the group editor from the draft; call it after every structural change, never on a keystroke.
function renderConditionTree() {
  const groups = byId("contact-condition-tree-groups");
  groups.replaceChildren();
  const draft = draftConditionTree;
  if (!draft) return;
  byId("contact-condition-tree-mode").value = draft.mode;
  draft.groups.forEach((group, groupIndex) => groups.append(conditionTreeGroupBox(draft, group, groupIndex)));
  const block = segmentTreeAddGroupBlock(draft);
  byId("contact-condition-tree-add-group").disabled = Boolean(block);
  byId("contact-condition-tree-add-group-reason").textContent = block;
  byId("contact-condition-tree-add-group-reason").hidden = !block;
}
// Focuses the first enabled editor control matching one of the selectors, so focus survives a rebuild.
function focusConditionTree(...selectors) {
  for (const selector of selectors) {
    const control = byId("contact-condition-tree").querySelector(selector);
    if (control && !control.disabled) {
      control.focus();
      return;
    }
  }
}
// Marks an editor change as a condition edit: the filter form's input listener clears the selection and the
// preview and refreshes the controls, as typing does, without counting it as an input (segmentEditChanged compares
// the tree instead).
function conditionTreeEdited() {
  byId("contact-condition-tree").dispatchEvent(new Event("input", { bubbles: true }));
}
function fillSegmentConditions(segment) {
  const fields = byId("contacts-filter").elements;
  draftConditionTree = segmentTreeFromSaved(segment?.condition_tree);
  renderConditionTree();
  conditionTreeControls();
  fields.connection_id.value = segment?.connection_id || "";
  const savedTags = segment?.tags ?? (segment?.tag ? [segment.tag] : []);
  contactTagInputs().forEach((input, index) => {
    input.value = savedTags[index] ?? "";
  });
  fields.tag_mode.value = segment?.tag_mode || "all";
  contactTagControls();
  const savedFields = segmentFieldConditions(segment);
  showFieldRows(Math.max(1, savedFields.length));
  const rows = fieldFilterRows();
  rows.forEach((row, index) => {
    row.field.value = savedFields[index]?.field_id || "";
    row.operator.value = savedFields[index]?.field_operator || "eq";
  });
  fields.field_mode.value = segment?.field_mode || "all";
  fields.condition_operator.value = segment?.condition_operator || "and";
  fields.last_comment_from.value = segment?.last_comment_from?.slice(0, -1) || "";
  fields.last_comment_before.value = segment?.last_comment_before?.slice(0, -1) || "";
  fields.activity_mode.value = segment?.last_comment_period
    ? "calendar"
    : segment?.last_comment_days
      ? "relative"
      : "fixed";
  fields.last_comment_days.value = segment?.last_comment_days || "7";
  fields.last_comment_period.value = segment?.last_comment_period || "today";
  contactActivityControls();
  fields.consent_purpose.value = segment?.consent_purpose || "";
  fields.consent_state.value = segment?.consent_state || "";
  fields.dm_consent_purpose.value = segment?.dm_consent_purpose || "";
  fields.dm_consent_state.value = segment?.dm_consent_state || "";
  contactConsentControls();
  fields.last_dm_days.value = segment?.last_dm_days || "";
  fieldFilterControls();
  rows.forEach((row, index) => {
    const saved = savedFields[index];
    row.value.value = fieldConditionNeedsValue(saved?.field_operator) ? String(saved.field_value) : "";
    row.boolean.value = saved?.field_value === false ? "false" : "true";
  });
}
// A segment's field conditions as a list: its set, its one legacy condition, or none.
function segmentFieldConditions(segment) {
  if (segment?.field_conditions) return segment.field_conditions;
  return segment?.field_id
    ? [{ field_id: segment.field_id, field_operator: segment.field_operator, field_value: segment.field_value }]
    : [];
}
function optionLabel(select, value) {
  return [...select.options].find((option) => option.value === value)?.textContent ?? String(value);
}
// One field condition as text, with the field's name and the operator label of its type.
function fieldConditionSummary(condition) {
  const field = contactFields.find((value) => value.id === condition.field_id);
  return (
    `${field?.name || "확인할 수 없는 필드"} ${orderedOperatorLabels(field?.type)[condition.field_operator] ?? optionLabel(byId("contacts-filter").elements.field_operator, condition.field_operator)}` +
    (fieldConditionNeedsValue(condition.field_operator) ? ` ${displayFieldValue(condition.field_value)}` : "")
  );
}
// The saved values of a segment as one line of text, shown after a conflicting edit.
function segmentSummary(segment) {
  const fields = byId("contacts-filter").elements;
  const account = connections.find((connection) => connection.id === segment.connection_id);
  const parts = [
    `이름 ${segment.name}`,
    `계정 ${segment.connection_id ? account?.username || account?.account_id || "확인할 수 없는 계정" : "모든 계정"}`,
    segment.condition_tree
      ? `그룹 조건 ${segmentTreeSummary(segment.condition_tree, fieldConditionSummary)}`
      : segment.tags
        ? `태그 ${segment.tags.join(", ")} (${segment.tag_mode === "any" ? "하나 이상 포함" : "모두 포함"})`
        : `태그 ${segment.tag || "조건 없음"}`,
  ];
  const savedFields = segmentFieldConditions(segment).map(fieldConditionSummary);
  if (savedFields.length > 1)
    parts.push(
      `추가 정보 ${savedFields.join(", ")} (${segment.field_mode === "any" ? "하나 이상 만족" : "모두 만족"})`,
    );
  else if (savedFields.length) parts.push(`추가 정보 ${savedFields[0]}`);
  if (segment.condition_operator === "or") parts.push("태그와 추가 정보 중 하나만 맞아도 포함");
  if (segment.last_comment_period)
    parts.push(
      `달력 기간 ${calendarPeriodLabels[segment.last_comment_period] ?? segment.last_comment_period} (작업 공간 시간대)`,
    );
  else if (segment.last_comment_days) parts.push(`최근 ${segment.last_comment_days}일 활동`);
  else if (segment.last_comment_from)
    parts.push(`활동 기간(UTC) ${segment.last_comment_from} 이상 ${segment.last_comment_before} 미만`);
  if (segment.consent_purpose)
    parts.push(
      `동의 기록 ${optionLabel(fields.consent_purpose, segment.consent_purpose)} ${optionLabel(fields.consent_state, segment.consent_state)}`,
    );
  if (segment.dm_consent_purpose)
    parts.push(
      `DM 동의 기록 ${optionLabel(fields.dm_consent_purpose, segment.dm_consent_purpose)} ${optionLabel(fields.dm_consent_state, segment.dm_consent_state)}`,
    );
  if (segment.last_dm_days) parts.push(`최근 ${segment.last_dm_days}일 안에 받은 DM`);
  return parts.join(" · ");
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
    if (editingSegment && !contactSegments.some((segment) => segment.id === editingSegment.id)) {
      leaveSegmentEdit();
      byId("segment-edit-status").textContent = "수정하던 필터가 보관되었거나 삭제되어 수정을 마쳤습니다.";
    }
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
byId("contacts-filter").addEventListener("input", (event) => {
  // The group editor's changes are compared as a tree by segmentEditChanged instead of counted. A select change
  // rebuilds the editor before this listener runs, so its detached control is recognized by its data attribute.
  if (!event.target.closest("#contact-condition-tree") && !("treeInput" in event.target.dataset))
    segmentConditionInputs++;
  invalidateSegmentPreview();
  activeSegmentId = "";
  byId("contact-segment").value = "";
  if (contactTagInputNames.includes(event.target.name)) {
    contactTagControls();
    fieldFilterControls();
  }
  if (event.target.name === "activity_mode") contactActivityControls();
  if (event.target.name === "consent_purpose" || event.target.name === "dm_consent_purpose") contactConsentControls();
  segmentControls();
});
byId("contact-condition-tree-clear").addEventListener("click", () => {
  // A tree with conditions that no saved filter holds cannot be brought back by selecting a filter again, so
  // clearing it needs the same confirmation as discarding a typed filter name.
  if (!draftConditionTree || segmentBusy || !canDropConditionTree()) return;
  draftConditionTree = null;
  renderConditionTree();
  conditionTreeControls();
  contactTagControls();
  fieldFilterControls();
  // Removing the tree is a condition edit: it clears the selection and the preview, as typing does.
  conditionTreeEdited();
  byId("contacts-filter").elements.tag.focus();
});
// Starts an empty tree in place of the tag and field inputs, which keep their values for when the tree is removed.
byId("contact-condition-tree-start").addEventListener("click", () => {
  if (draftConditionTree || segmentBusy) return;
  draftConditionTree = segmentTreeEmpty();
  renderConditionTree();
  conditionTreeControls();
  conditionTreeEdited();
  focusConditionTree('[data-tree-action="leaf-add"]');
});
// Runs before the form's input listener, which then marks the edit with the new mode in the draft.
byId("contact-condition-tree-mode").addEventListener("input", (event) => {
  if (!draftConditionTree || segmentBusy) return;
  draftConditionTree = segmentTreeSetMode(draftConditionTree, null, event.currentTarget.value).draft;
});
byId("contact-condition-tree-add-group").addEventListener("click", () => {
  if (!draftConditionTree || segmentBusy) return;
  const result = segmentTreeAddGroup(draftConditionTree);
  if (result.error) {
    byId("contact-condition-tree-status").textContent = result.error;
    return;
  }
  draftConditionTree = result.draft;
  renderConditionTree();
  conditionTreeEdited();
  const last = draftConditionTree.groups.length - 1;
  focusConditionTree(`[data-tree-action="leaf-add"][data-tree-group="${last}"]`);
});
// Text inputs change the draft in place; selects rebuild the editor, since a kind, field or operator decides which
// controls the leaf shows. This listener runs before the form's input listener, which then marks the edit.
byId("contact-condition-tree-groups").addEventListener("input", (event) => {
  const control = event.target;
  const key = control.dataset.treeInput;
  if (!key || !draftConditionTree || segmentBusy) return;
  const group = Number(control.dataset.treeGroup);
  if (key === "group-mode") {
    draftConditionTree = segmentTreeSetMode(draftConditionTree, group, control.value).draft;
    return;
  }
  const leafIndex = Number(control.dataset.treeLeaf);
  const leaf = draftConditionTree.groups[group]?.conditions[leafIndex];
  if (!leaf) return;
  const changes = { [key]: control.value };
  if (key === "field_id") {
    // A field of another type starts with an empty value and an operator that type takes, as a field row does.
    const before = contactFields.find((field) => field.id === leaf.field_id);
    const after = contactFields.find((field) => field.id === control.value);
    if (before?.type !== after?.type) changes.value = "";
    if (!segmentTreeOperators(after?.type).includes(leaf.field_operator)) changes.field_operator = "eq";
  }
  draftConditionTree = segmentTreeSetLeaf(draftConditionTree, group, leafIndex, changes).draft;
  if (control.tagName === "SELECT") {
    renderConditionTree();
    focusConditionTree(
      `[data-tree-group="${group}"][data-tree-leaf="${leafIndex}"][data-tree-input="${key}"]`,
      `[data-tree-group="${group}"][data-tree-leaf="${leafIndex}"][data-tree-input="kind"]`,
    );
  }
});
byId("contact-condition-tree-groups").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-tree-action]");
  if (!button || !draftConditionTree || segmentBusy) return;
  const action = button.dataset.treeAction;
  const group = Number(button.dataset.treeGroup);
  const leaf = Number(button.dataset.treeLeaf);
  const operations = {
    "leaf-add": () => segmentTreeAddLeaf(draftConditionTree, group),
    "leaf-up": () => segmentTreeMoveLeaf(draftConditionTree, group, leaf, -1),
    "leaf-down": () => segmentTreeMoveLeaf(draftConditionTree, group, leaf, 1),
    "leaf-remove": () => segmentTreeRemoveLeaf(draftConditionTree, group, leaf),
    "group-up": () => segmentTreeMoveGroup(draftConditionTree, group, -1),
    "group-down": () => segmentTreeMoveGroup(draftConditionTree, group, 1),
    "group-remove": () => segmentTreeRemoveGroup(draftConditionTree, group),
  };
  if (!Object.hasOwn(operations, action)) return;
  const result = operations[action]();
  if (result.error) {
    byId("contact-condition-tree-status").textContent = result.error;
    return;
  }
  draftConditionTree = result.draft;
  renderConditionTree();
  conditionTreeEdited();
  // Focus follows the moved item, or stays near the place of an added or removed one.
  const leafAt = (index, selector) => `[data-tree-group="${group}"][data-tree-leaf="${index}"]${selector}`;
  const groupAt = (index, selector) => `[data-tree-group="${index}"]${selector}`;
  const focus = {
    "leaf-add": [leafAt(draftConditionTree.groups[group]?.conditions.length - 1, '[data-tree-input="kind"]')],
    "leaf-up": [leafAt(leaf - 1, '[data-tree-action="leaf-up"]'), leafAt(leaf - 1, '[data-tree-action="leaf-down"]')],
    "leaf-down": [leafAt(leaf + 1, '[data-tree-action="leaf-down"]'), leafAt(leaf + 1, '[data-tree-action="leaf-up"]')],
    "leaf-remove": [
      leafAt(leaf, '[data-tree-input="kind"]'),
      leafAt(leaf - 1, '[data-tree-input="kind"]'),
      groupAt(group, '[data-tree-action="leaf-add"]'),
    ],
    "group-up": [
      groupAt(group - 1, '[data-tree-action="group-up"]'),
      groupAt(group - 1, '[data-tree-action="group-down"]'),
    ],
    "group-down": [
      groupAt(group + 1, '[data-tree-action="group-down"]'),
      groupAt(group + 1, '[data-tree-action="group-up"]'),
    ],
    "group-remove": [
      groupAt(Math.min(group, draftConditionTree.groups.length - 1), '[data-tree-action="leaf-add"]'),
      "#contact-condition-tree-add-group",
    ],
  }[action];
  focusConditionTree(...focus, "#contact-condition-tree-mode");
});
byId("contact-segment").addEventListener("change", (event) => {
  // Selecting a filter replaces the draft's tree with the filter's, so an unsaved tree is asked about first.
  if (!canReloadContacts() || !canDropConditionTree()) {
    event.currentTarget.value = activeSegmentId;
    return;
  }
  const segment = contactSegments.find((value) => value.id === event.currentTarget.value);
  activeSegmentId = segment?.id || "";
  fillSegmentConditions(segment);
  segmentControls();
  void loadContacts();
});
byId("segment-edit").addEventListener("click", () => {
  const segment = contactSegments.find((value) => value.id === activeSegmentId);
  if (!segment || segmentBusy || editingSegment || (currentRole !== "owner" && currentRole !== "admin")) return;
  // Editing replaces the name field with the saved name, so a name typed for a new filter needs a confirmation.
  if (segmentNameDirty && !confirm("입력한 새 필터 이름을 버리고 저장된 필터를 수정할까요?")) return;
  editingSegment = {
    id: segment.id,
    version: segment.version,
    saved: segment,
    inputs: segmentConditionInputs,
    loadedName: segment.name,
    loadedTree: segmentTreeFromSaved(segment.condition_tree),
  };
  invalidateSegmentPreview();
  fillSegmentConditions(segment);
  byId("segment-save").elements.name.value = segment.name;
  segmentNameDirty = false;
  byId("segment-save").closest("details").open = true;
  byId("segment-edit-status").textContent =
    `"${segment.name}" 필터를 수정하고 있습니다. 위 조건과 이름을 바꾼 뒤 변경 저장을 눌러 주세요.`;
  segmentControls();
  byId("segment-save").elements.name.focus();
});
byId("segment-edit-cancel").addEventListener("click", () => {
  if (segmentBusy || !editingSegment) return;
  leaveSegmentEdit({ discard: true });
  segmentControls();
  notice("필터 수정을 취소했습니다. 저장된 필터는 바뀌지 않았습니다.");
});
// After a conflict, only this control takes the saved values and their version; until then a save stays stale.
byId("segment-edit-reload").addEventListener("click", () => {
  if (segmentBusy || !editingSegment) return;
  const saved = editingSegment.saved;
  editingSegment.version = saved.version;
  editingSegment.inputs = segmentConditionInputs;
  editingSegment.loadedName = saved.name;
  editingSegment.loadedTree = segmentTreeFromSaved(saved.condition_tree);
  invalidateSegmentPreview();
  fillSegmentConditions(saved);
  byId("segment-save").elements.name.value = saved.name;
  segmentNameDirty = false;
  byId("segment-edit-conflict").hidden = true;
  byId("segment-edit-saved").textContent = "";
  byId("segment-edit-status").textContent =
    `저장된 "${saved.name}" 필터 값을 불러왔습니다. 필요한 부분을 다시 바꾼 뒤 변경 저장을 눌러 주세요.`;
  segmentControls();
});
async function saveSegmentEdit(editing, payload, generation) {
  try {
    const saved = await api(`/api/contact-segments/${editing.id}`, "PUT", {
      ...payload,
      expected_version: editing.version,
    });
    if (generation !== segmentsGeneration || editingSegment !== editing) return;
    leaveSegmentEdit({ discard: true });
    activeSegmentId = saved.id;
    await loadContactSegments(true);
    if (generation !== segmentsGeneration) return;
    if (activeSegmentId === saved.id) {
      fillSegmentConditions(saved);
      if (!contactsDirty.size && !contactsSaving) void loadContacts();
    }
    notice("필터 변경을 저장했습니다. 이 필터로 조회하는 연락처는 다음 조회부터 바뀐 조건으로 계산합니다.");
  } catch (error) {
    if (generation !== segmentsGeneration || editingSegment !== editing) return;
    if (error.code === "segment_conflict" && error.segment) {
      // Keep the operator's values and the old version, so saving again cannot overwrite the newer change.
      editing.saved = error.segment;
      byId("segment-edit-saved").textContent = `지금 저장된 값: ${segmentSummary(error.segment)}`;
      byId("segment-edit-conflict").hidden = false;
      byId("segment-edit-status").textContent =
        "다른 변경이 먼저 저장되었습니다. 입력한 값은 그대로 두었습니다. 저장된 값을 확인하고 불러온 뒤 다시 저장해 주세요.";
      return;
    }
    if (error.code === "segment_not_found") {
      leaveSegmentEdit();
      if (activeSegmentId === editing.id) activeSegmentId = "";
      await loadContactSegments(true);
      notice(
        "수정하던 필터가 보관되었거나 삭제되었습니다. 입력한 이름과 조건은 남아 있으니 새 필터로 저장할 수 있습니다.",
        true,
      );
      return;
    }
    throw error;
  }
}
byId("segment-save").addEventListener("input", () => {
  segmentNameDirty = Boolean(byId("segment-save").elements.name.value);
  // A changed name is an unsaved edit too, which holds the segment export and invalidates a comparison.
  segmentControls();
});
byId("segment-save").addEventListener("submit", (event) => {
  event.preventDefault();
  if (segmentBusy) return;
  const generation = segmentsGeneration;
  const editing = editingSegment;
  const fields = byId("contacts-filter").elements;
  const name = byId("segment-save").elements.name.value;
  const tags = contactFilterTags();
  const payload = { name, connection_id: fields.connection_id.value || null };
  // A tree is sent alone in place of the tag and field conditions and their operator (below, once it builds).
  // One tag keeps the legacy shape; two or more go as a set with the chosen mode.
  if (!draftConditionTree) {
    if (tags.length > 1) Object.assign(payload, { tags, tag_mode: fields.tag_mode.value });
    else payload.tag = tags[0] ?? null;
    if (fields.condition_operator.value === "or") payload.condition_operator = "or";
  }
  try {
    // An incomplete tree throws its reason here, before any request.
    if (draftConditionTree) payload.condition_tree = conditionTreeRequest();
    else Object.assign(payload, contactFieldConditionKeys());
    Object.assign(payload, contactActivityWindow());
    Object.assign(payload, contactConsentCondition());
    Object.assign(payload, contactDmConsentCondition());
    Object.assign(payload, contactDmActivityCondition());
  } catch (error) {
    notice(error.message, true);
    return;
  }
  void action(event.currentTarget.querySelector("button"), async () => {
    segmentBusy = true;
    segmentControls();
    try {
      if (editing) return await saveSegmentEdit(editing, payload, generation);
      const created = await api("/api/contact-segments", "POST", payload);
      if (generation !== segmentsGeneration) return;
      byId("segment-save").reset();
      segmentNameDirty = false;
      await loadContactSegments(true);
      if (generation !== segmentsGeneration) return;
      // The editor takes the tree as the server stored it (tags normalized), so the saved draft matches the new
      // filter and is not reported as unsaved. The fieldset was locked, so the draft is still the one sent.
      if (draftConditionTree && created.condition_tree) {
        draftConditionTree = segmentTreeFromSaved(created.condition_tree);
        renderConditionTree();
        conditionTreeControls();
      }
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
      if (contactsExportSegmentId === id)
        invalidateContactExport("필터가 보관되어 진행 중인 내보내기를 취소했습니다. 연락처와 태그는 유지됩니다.");
      if (segment && new URLSearchParams(contactsQuery).get("segment_id") === id) {
        const query = new URLSearchParams();
        if (segment.connection_id) query.set("connection_id", segment.connection_id);
        for (const value of segment.tags ?? (segment.tag ? [segment.tag] : [])) query.append("tag", value);
        if (segment.tags) query.set("tag_mode", segment.tag_mode);
        if (segment.condition_operator === "or") query.set("condition_operator", "or");
        if (segment.last_comment_from) {
          query.set("last_comment_from", segment.last_comment_from);
          query.set("last_comment_before", segment.last_comment_before);
        }
        if (segment.last_comment_days) query.set("last_comment_days", segment.last_comment_days);
        if (segment.last_comment_period) query.set("last_comment_period", segment.last_comment_period);
        if (segment.consent_purpose) {
          query.set("consent_purpose", segment.consent_purpose);
          query.set("consent_state", segment.consent_state);
        }
        if (segment.dm_consent_purpose) {
          query.set("dm_consent_purpose", segment.dm_consent_purpose);
          query.set("dm_consent_state", segment.dm_consent_state);
        }
        if (segment.last_dm_days) query.set("last_dm_days", segment.last_dm_days);
        if (segment.condition_tree) query.set("condition_tree", JSON.stringify(segment.condition_tree));
        if (segment.field_conditions) {
          query.set("field_conditions", JSON.stringify(segment.field_conditions));
          query.set("field_mode", segment.field_mode);
        } else if (segment.field_id) {
          query.set("field_id", segment.field_id);
          query.set("field_operator", segment.field_operator);
          if (fieldConditionNeedsValue(segment.field_operator))
            query.set("field_value", JSON.stringify(segment.field_value));
        }
        contactsQuery = query.toString();
      }
      if (activeSegmentId === id) activeSegmentId = "";
      // An archive ends an edit; only the selected segment can be both edited and archived.
      if (editingSegment) leaveSegmentEdit({ discard: true });
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
function fieldFilterRows() {
  const fields = byId("contacts-filter").elements;
  return fieldRowSuffixes.map((suffix, index) => {
    const id = index ? `-${index + 1}` : "";
    return {
      field: fields[`field_id${suffix}`],
      operator: fields[`field_operator${suffix}`],
      value: fields[`field_value${suffix}`],
      boolean: fields[`field_boolean${suffix}`],
      operatorLabel: byId(`field-filter-operator${id}`),
      valueLabel: byId(`field-filter-value${id}`),
      shown: index === 0 || !byId(`field-filter-field${id}`).hidden,
    };
  });
}
// Shows the first count rows and clears and hides the others.
function showFieldRows(count) {
  fieldFilterRows().forEach((row, index) => {
    if (!index) return;
    const shown = index < count;
    byId(`field-filter-field-${index + 1}`).hidden = !shown;
    byId(`field-filter-remove-${index + 1}`).hidden = !shown;
    if (!shown) {
      row.field.value = "";
      row.operator.value = "eq";
      row.value.value = "";
      row.boolean.value = "true";
    }
  });
}
function fieldFilterControls() {
  invalidateSegmentPreview();
  const fields = byId("contacts-filter").elements;
  const rows = fieldFilterRows();
  const selectedRows = rows.filter((row) => row.shown && row.field.value).length;
  fields.condition_operator.disabled = !selectedRows || !contactFilterTags().length;
  if (fields.condition_operator.disabled) fields.condition_operator.value = "and";
  fields.field_mode.disabled = selectedRows < 2;
  if (fields.field_mode.disabled) fields.field_mode.value = "all";
  const shownRows = rows.filter((row) => row.shown).length;
  byId("field-filter-add").hidden = shownRows >= rows.length || !rows[shownRows - 1].field.value;
  for (const row of rows) {
    const selected = row.shown && Boolean(row.field.value);
    row.operatorLabel.hidden = !selected;
    const field = contactFields.find((field) => field.id === row.field.value);
    const orderedLabels = orderedOperatorLabels(field?.type);
    for (const option of row.operator.options) {
      if (!["gt", "gte", "lt", "lte"].includes(option.value)) continue;
      option.textContent = orderedLabels[option.value];
      option.hidden = option.disabled = !["number", "date"].includes(field?.type);
    }
    if (row.operator.selectedOptions[0]?.disabled) row.operator.value = "eq";
    const needsValue = fieldConditionNeedsValue(row.operator.value);
    row.valueLabel.hidden = !selected || !needsValue;
    configureFieldInput(row.value, field);
    row.value.required = selected && needsValue && Boolean(field && !["text", "boolean"].includes(field.type));
    row.value.hidden = field?.type === "boolean";
    row.boolean.hidden = field?.type !== "boolean";
  }
  // Rows typed before the group editor started keep their values, so the mode selects stay off while it is shown.
  if (draftConditionTree) for (const name of ["field_mode", "condition_operator"]) fields[name].disabled = true;
}
function fieldConditionNeedsValue(operator) {
  return ["eq", "gt", "gte", "lt", "lte"].includes(operator);
}
// The ordered operator labels of a field type; eq, is_set and is_unset read the same for every type.
function orderedOperatorLabels(type) {
  return type === "date"
    ? { gte: "당일 포함 이후", gt: "당일 제외 이후", lte: "당일 포함 이전", lt: "당일 제외 이전" }
    : { gte: "이상", gt: "초과", lte: "이하", lt: "미만" };
}
// The conditions of the shown rows that name a field, in row order.
function contactFieldConditions() {
  const conditions = [];
  for (const row of fieldFilterRows()) {
    if (!row.shown || !row.field.value) continue;
    const field = contactFields.find((item) => item.id === row.field.value);
    if (!field) throw new Error(errors.field_not_found);
    if (conditions.some((condition) => condition.field_id === field.id))
      throw new Error("같은 추가 정보 필드는 한 번만 조건으로 고를 수 있습니다.");
    conditions.push({
      field_id: field.id,
      field_operator: row.operator.value,
      ...(fieldConditionNeedsValue(row.operator.value)
        ? { field_value: typedFieldValue(field, field.type === "boolean" ? row.boolean.value : row.value.value) }
        : {}),
    });
  }
  return conditions;
}
// The request keys of the conditions on screen: one row keeps the legacy keys, two or three a set with its mode.
function contactFieldConditionKeys() {
  const conditions = contactFieldConditions();
  if (conditions.length > 1)
    return { field_conditions: conditions, field_mode: byId("contacts-filter").elements.field_mode.value };
  return conditions[0] ?? {};
}
// Marks a row change as a condition edit, as typing in the form does.
function fieldRowsChanged() {
  fieldFilterControls();
  byId("contacts-filter").dispatchEvent(new Event("input", { bubbles: true }));
}
byId("field-filter-add").addEventListener("click", () => {
  const shown = fieldFilterRows().filter((row) => row.shown).length;
  showFieldRows(shown + 1);
  fieldRowsChanged();
  fieldFilterRows()[shown]?.field.focus();
});
for (const index of [1, 2])
  byId(`field-filter-remove-${index + 1}`).addEventListener("click", () => {
    const rows = fieldFilterRows();
    // Later rows move up one place, so the shown rows stay contiguous.
    for (let next = index; next < rows.length - 1; next++) {
      rows[next].field.value = rows[next + 1].field.value;
      rows[next].operator.value = rows[next + 1].operator.value;
      // The input takes the moved field's type first, so a number input does not drop a moved text value.
      configureFieldInput(
        rows[next].value,
        contactFields.find((field) => field.id === rows[next].field.value),
      );
      rows[next].value.value = rows[next + 1].value.value;
      rows[next].boolean.value = rows[next + 1].boolean.value;
    }
    showFieldRows(rows.filter((row) => row.shown).length - 1);
    fieldRowsChanged();
  });
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
    for (const { field: select } of fieldFilterRows()) {
      const previous = select.value;
      select.replaceChildren(new Option("조건 없음", ""));
      for (const field of contactFields) select.add(new Option(field.name, field.id));
      if (previous && !contactFields.some((field) => field.id === previous))
        select.add(new Option("사용할 수 없는 필드", previous));
      select.value = previous;
    }
    // The group editor's field selects list the same definitions, with the same fallback for an unknown field.
    renderConditionTree();
    conditionTreeControls();
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
  const selects = fieldFilterRows().map((row) => row.field);
  const filterNotice =
    selects.some((select) => select.value === field.id) || segmentTreeRemoveField(draftConditionTree, field.id).removed
      ? " 이 필드의 검색 조건은 해제됩니다."
      : "";
  if (!canReloadContacts() || !confirm(`${field.name} 필드를 보관할까요? 저장한 값은 유지됩니다.${filterNotice}`))
    return;
  const generation = fieldsGeneration;
  void action(button, async () => {
    fieldBusy = true;
    fieldControls();
    try {
      await api(`/api/contact-fields/${field.id}`, "DELETE");
      if (generation !== fieldsGeneration) return;
      for (const select of selects) {
        if (select.value === field.id) select.value = "";
        [...select.options].find((option) => option.value === field.id)?.remove();
      }
      contactFields = contactFields.filter((definition) => definition.id !== field.id);
      button.closest(".field-definition")?.remove();
      // The group editor drops this field's conditions; a group they empty stays and makes the tree incomplete.
      const tree = segmentTreeRemoveField(draftConditionTree, field.id);
      let treeNotice = "";
      if (tree.removed) {
        draftConditionTree = tree.draft;
        renderConditionTree();
        conditionTreeEdited();
        const incomplete = segmentTreeBuild(draftConditionTree, contactFields).error;
        treeNotice =
          ` 그룹 조건에서 이 필드를 쓰던 조건 ${tree.removed}개를 지웠습니다.` +
          (incomplete ? ` 그룹 조건을 완성해야 조회할 수 있습니다. ${incomplete}` : "");
      }
      fieldFilterControls();
      clearContactResults();
      const loaded = await loadContactFields(true);
      if (generation !== fieldsGeneration) return;
      if (loaded) await loadContacts();
      notice(
        (loaded
          ? "필드를 보관했습니다. 저장한 값은 유지됩니다."
          : "필드를 보관했지만 목록을 갱신하지 못했습니다. 새로고침으로 다시 불러와 주세요.") + treeNotice,
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
  getTimeZone: () => workspaceTimeZone,
});
function resetInbox() {
  inbox.reset();
}
const flowEditor = createFlowEditor({
  api,
  node,
  badge,
  action,
  notice,
  getRole: () => currentRole,
  getConnections: () => connections,
  fieldTypeLabels,
});
function initializeInbox() {
  inbox.initialize();
}
function loadInbox(more = false) {
  return inbox.loadList(more);
}
function loadInboxMessages(older = false) {
  return inbox.loadConversation(older);
}
