const byId = (id) => document.getElementById(id);
const form = byId("rule-form");
let connections = [];
let contactsGeneration = 0;
let contactsAfter = null;
let contactsBusy = false;
let contactsSaving = false;
let contactsQuery = "";
const contactsDirty = new Set();
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
    (!dirty && !contactsDirty.size && !segmentNameDirty && !fieldNameDirty) ||
    confirm("저장하지 않은 규칙·연락처·필터 변경 사항을 버릴까요?")
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
  if (dirty || contactsDirty.size || segmentNameDirty || fieldNameDirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
function resetSession() {
  connections = [];
  contactsGeneration++;
  contactsDirty.clear();
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
  if (error && message) byId("notice").focus({ preventScroll: false });
}

const errors = {
  authentication_failed: "로그인 정보를 확인하거나 잠시 후 다시 시도해 주세요.",
  auth_not_configured: "로그인 서비스를 준비 중입니다.",
  confirmed_email_required: "이메일 인증을 완료해 주세요.",
  login_required: "다시 로그인해 주세요.",
  origin_rejected: "이 페이지에서 다시 시도해 주세요.",
  connection_not_found: "접근할 수 있는 Instagram 계정을 선택해 주세요.",
  connection_unavailable: "계정 연결 상태와 토큰 유효기간을 확인해 주세요.",
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
  invalid_credentials: "이메일과 8자 이상의 비밀번호를 입력해 주세요.",
};

async function api(path, method = "GET", body, retry = true) {
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
    return api(path, method, body, false);
  }
  if (response.status === 401) resetSession();
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("서버 응답을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.");
  }
  if (!response.ok) {
    const error = new Error(errors[result.error] ?? "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    error.status = response.status;
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

async function loadWorkspace() {
  const generation = segmentsGeneration;
  const me = await api("/api/me");
  if (generation !== segmentsGeneration) return;
  await api("/api/workspace", "POST");
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
  byId("delivery-status").textContent = me.global_send_enabled
    ? "계정별로 발송을 켜고 규칙을 활성화하면 자동화를 시작합니다."
    : "계정 연결과 규칙 저장은 가능합니다. 전체 발송이 재개되기 전에는 메시지가 전송되지 않습니다.";
  byId("connections").replaceChildren();
  form.elements.connection_id.replaceChildren();
  if (!connections.length)
    byId("connections").append(
      emptyState("첫 Instagram 계정을 연결하세요", "관리하는 전문 계정을 연결하면 댓글 자동화를 만들 수 있습니다."),
    );
  for (const account of connections) {
    const item = node("div", "");
    item.className = "item";
    item.append(node("strong", account.username ?? account.account_id));
    const state = node("div", "", "badges");
    state.append(
      badge(account.active ? "수신 중" : "수신 중지", account.active ? "success" : ""),
      badge(account.send_enabled ? "계정 발송 켜짐" : "계정 발송 꺼짐", account.send_enabled ? "success" : ""),
    );
    item.append(state);
    item.append(
      node(
        "p",
        account.token_registered
          ? `연결 유효기간: ${new Date(account.token_expires_at).toLocaleDateString("ko-KR")} · 만료 전에 다시 연결해 주세요.`
          : "계정을 다시 연결해야 수신과 발송을 시작할 수 있습니다.",
        "hint",
      ),
    );
    for (const [label, active, send_enabled] of [
      [account.send_enabled ? "발송 끄기" : "발송 켜기", true, !account.send_enabled],
      [account.active ? "수신 중지" : "수신 재개", !account.active, false],
    ]) {
      const button = node("button", label);
      button.className = "secondary";
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
            "이 계정의 수신·발송을 중지하고 저장한 토큰을 삭제할까요? 기존 기록은 데이터 삭제 안내에 따라 요청할 수 있습니다.",
          )
        )
          return;
        await api(`/api/connections/${account.id}`, "DELETE");
        await loadWorkspace();
      }),
    );
    item.append(disconnect);
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
    await loadWorkspace();
    notice("로그인했습니다.");
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
  byId("retry-load").hidden = true;
  byId("startup").hidden = false;
  try {
    if (location.protocol === "file:")
      throw new Error("미리보기에서는 로그인할 수 없습니다. 서비스 웹사이트에서 이용해 주세요.");
    await loadWorkspace();
  } catch (error) {
    if (error.status !== 401) {
      notice(error.message, true);
      byId("retry-load").hidden = location.protocol !== "file:" ? false : true;
    }
    byId("auth").hidden = false;
  } finally {
    byId("startup").hidden = true;
  }
}
byId("retry-load").addEventListener("click", (event) => action(event.currentTarget, start));
formConditions();
void start();

async function loadActivity() {
  const generation = segmentsGeneration;
  const result = await api("/api/activity");
  if (generation !== segmentsGeneration) return;
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
    for (const contact of page.contacts) byId("contacts-list").append(contactCard(contact));
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
