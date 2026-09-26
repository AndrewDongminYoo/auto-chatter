const byId = (id) => document.getElementById(id);
const form = byId("rule-form");
let connections = [];
let refreshPromise;
let editingRuleId;
function resetSession() {
  connections = [];
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
}

function notice(message, error = false) {
  byId("notice").textContent = message;
  byId("notice").classList.toggle("error", error);
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
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401 && retry && !path.startsWith("/api/auth/")) {
    refreshPromise ??= api("/api/auth/refresh", "POST", undefined, false).finally(() => {
      refreshPromise = undefined;
    });
    await refreshPromise;
    return api(path, method, body, false);
  }
  if (response.status === 401) resetSession();
  const result = await response.json();
  if (!response.ok) throw new Error(errors[result.error] ?? "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  return result;
}

async function action(button, task) {
  button.disabled = true;
  try {
    await task();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function node(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}
function list(text) {
  return text
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

function followSettings() {
  byId("follow-settings").hidden = !form.elements.follow_gate_enabled.checked;
}
form.elements.follow_gate_enabled.addEventListener("change", followSettings);

async function loadWorkspace() {
  const me = await api("/api/me");
  await api("/api/workspace", "POST");
  const [accounts, settings] = await Promise.all([api("/api/connections"), api("/api/rules")]);
  connections = accounts.connections;
  await loadActivity();
  byId("auth").hidden = true;
  byId("workspace").hidden = false;
  byId("logout").hidden = false;
  byId("delivery-status").textContent = me.global_send_enabled
    ? "계정별로 발송을 켜고 규칙을 활성화하면 자동화를 시작합니다."
    : "현재 서비스의 전체 발송이 중지돼 있습니다. 설정 저장과 계정 연결은 가능합니다.";
  byId("connections").replaceChildren();
  form.elements.connection_id.replaceChildren();
  if (!connections.length)
    byId("connections").append(node("p", "연결한 계정이 없습니다. Instagram 전문 계정을 연결해 주세요."));
  for (const account of connections) {
    const item = node("div", "");
    item.className = "item";
    item.append(node("strong", account.username ?? account.account_id));
    item.append(
      node(
        "p",
        `${account.active ? "수신 켜짐" : "수신 꺼짐"} · ${account.send_enabled ? "계정 발송 켜짐" : "계정 발송 꺼짐"}`,
      ),
    );
    item.append(
      node(
        "p",
        account.token_registered
          ? `연동 토큰 만료: ${new Date(account.token_expires_at).toLocaleString()} · 만료 전 계정을 다시 연결하세요.`
          : "발송용 연결이 없습니다. 계정을 다시 연결해 주세요.",
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
    disconnect.className = "secondary";
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
  byId("rules").replaceChildren();
  if (!settings.rules.length)
    byId("rules").append(node("p", "아직 규칙이 없습니다. 계정을 연결한 뒤 첫 규칙을 만들어 보세요."));
  for (const rule of settings.rules) {
    const item = node("div", "");
    item.className = "item";
    item.append(node("strong", `게시물 ${rule.media_id}`));
    item.append(
      node("p", `${rule.enabled ? "활성" : "중지"} · ${rule.follow_gate_enabled ? "팔로우 확인" : "바로 답장"}`),
    );
    const button = node("button", "수정");
    button.className = "secondary";
    button.addEventListener("click", () => {
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
      followSettings();
      form.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    item.append(button);
    byId("rules").append(item);
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
    const result = await api("/api/instagram/connect", "POST");
    const url = new URL(result.url);
    if (url.protocol !== "https:" || url.hostname !== "www.instagram.com" || url.pathname !== "/oauth/authorize")
      throw new Error("계정 연결 주소를 확인할 수 없습니다.");
    location.assign(url.href);
  }),
);
byId("new-rule").addEventListener("click", () => {
  editingRuleId = undefined;
  form.elements.connection_id.disabled = false;
  form.elements.media_id.readOnly = false;
  form.reset();
  followSettings();
  form.elements.media_id.focus();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  action(form.querySelector("button[type=submit]"), async () => {
    const data = Object.fromEntries(new FormData(form));
    await api("/api/rules", "PUT", {
      ...data,
      ...(editingRuleId ? { id: editingRuleId } : {}),
      connection_id: form.elements.connection_id.value,
      keywords: list(data.keywords),
      excluded_keywords: list(data.excluded_keywords),
      enabled: form.elements.enabled.checked,
      follow_gate_enabled: form.elements.follow_gate_enabled.checked,
    });
    await loadWorkspace();
    notice("규칙을 저장했습니다. 설정은 새로 수신하는 댓글부터 적용됩니다.");
  });
});
loadWorkspace().catch(() => {
  /* An anonymous visitor starts at the login form. */
});

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
  if (!result.activity.length) byId("activity").append(node("p", "아직 처리한 댓글이 없습니다."));
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
