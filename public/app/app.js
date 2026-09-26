const byId = (id) => document.getElementById(id);
const form = byId("rule-form");
let connections = [];
let refreshPromise;
let editingRuleId;
let dirty = false;
function editorState(
  message = dirty ? "저장하지 않은 변경 사항이 있습니다." : "새 댓글부터 저장한 설정이 적용됩니다.",
) {
  byId("editor-title").textContent = editingRuleId ? "규칙 수정" : "새 규칙 만들기";
  byId("edit-state").textContent = dirty ? "저장 전" : editingRuleId ? "저장됨" : "작성 전";
  byId("edit-state").className = `badge${dirty ? " warning" : ""}`;
  if (byId("save-status").textContent !== message) byId("save-status").textContent = message;
}
function canDiscard() {
  return !dirty || confirm("저장하지 않은 변경 사항을 버릴까요?");
}
function focusEditor() {
  const target =
    form.elements[
      editingRuleId ? (form.elements.match_mode.value === "all" ? "private_reply_text" : "keywords") : "media_id"
    ];
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
  const all = form.elements.match_mode.value === "all";
  byId("include-keywords").hidden = all;
  form.elements.keywords.required = !all;
  form.elements.keywords.setCustomValidity("");
  form.elements.excluded_keywords.setCustomValidity("");
  byId("message-count").textContent =
    `${form.elements.private_reply_text.value.length.toLocaleString("ko-KR")} / 1,000`;
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
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
function resetSession() {
  connections = [];
  dirty = false;
  byId("startup").hidden = true;
  editingRuleId = undefined;
  form.reset();
  form.elements.connection_id.disabled = false;
  form.elements.media_id.readOnly = false;
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
  invalid_keywords: "키워드는 최대 20개, 각각 100자까지 입력할 수 있습니다.",
  invalid_rule: "게시물 ID, 답장 문구와 팔로우 조건을 확인해 주세요.",
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
  const me = await api("/api/me");
  await api("/api/workspace", "POST");
  const [accounts, settings] = await Promise.all([api("/api/connections"), api("/api/rules")]);
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
    item.append(node("strong", `게시물 ${rule.media_id}`));
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
      if (!canDiscard()) return;
      dirty = false;
      editingRuleId = rule.id;
      form.elements.connection_id.disabled = true;
      form.elements.media_id.readOnly = true;
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
      form.elements.keywords.value = (rule.keywords.length ? rule.keywords : [rule.keyword]).join("\n");
      form.elements.excluded_keywords.value = rule.excluded_keywords.join("\n");
      form.elements.enabled.checked = rule.enabled;
      form.elements.follow_gate_enabled.checked = rule.follow_gate_enabled;
      formConditions();
      editorState("계정과 게시물은 고정됩니다. 댓글 조건과 문구를 수정하세요.");
      for (const element of byId("rules").children)
        element.classList.toggle("active-rule", element.dataset.ruleId === rule.id);
      focusEditor();
    });
    item.append(button);
    byId("rules").append(item);
  }
  formConditions();
  try {
    await loadActivity();
  } catch (error) {
    if (error.status === 401) throw error;
    byId("activity").replaceChildren(
      emptyState(
        "처리 내역을 불러오지 못했습니다",
        "새로고침을 눌러 다시 시도해 주세요. 계정과 규칙 설정은 계속할 수 있습니다.",
      ),
    );
  }
}

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
  if (!canDiscard()) return;
  dirty = false;
  editingRuleId = undefined;
  form.elements.connection_id.disabled = false;
  form.elements.media_id.readOnly = false;
  form.reset();
  formConditions();
  editorState("새 규칙을 작성하고 저장하세요.");
  for (const element of byId("rules").children) element.classList.remove("active-rule");
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
  };
  action(byId("save-rule"), async () => {
    byId("rule-fields").disabled = true;
    editorState("규칙을 저장하고 있습니다…");
    try {
      const saved = await api("/api/rules", "PUT", payload);
      editingRuleId = saved.id;
      dirty = false;
      form.elements.connection_id.disabled = true;
      form.elements.media_id.readOnly = true;
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
  const result = await api("/api/activity");
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
