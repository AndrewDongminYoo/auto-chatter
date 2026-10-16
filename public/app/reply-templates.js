function createReplyTemplates({ api, node, getRole, getComposer, appendToDraft }) {
  const byId = (id) => document.getElementById(id);
  const endpoint = "/api/inbox/reply-templates";
  const form = byId("reply-template-form");
  const select = byId("inbox-template-select");
  let templates = [],
    session = 0,
    listRequest = 0,
    previewRequest = 0;
  let editing = null,
    saving = false,
    loading = false,
    previewing = false,
    preview = null;
  const isAdmin = () => ["owner", "admin"].includes(getRole());
  const chosen = () => templates.find((item) => item.id === select.value);
  const locked = () => {
    const state = getComposer();
    return !state || state.busy || state.loading || Boolean(state.operation);
  };
  const errors = {
    invalid_reply_template: "이름은 60자 이내로 입력해 주세요. 줄바꿈이나 제어 문자는 사용할 수 없습니다.",
    invalid_template_body: "본문과 변수 문법을 확인해 주세요. 본문은 1,000자, 서로 다른 변수는 10개까지입니다.",
    invalid_template_values: "모든 변수에 공백이 아닌 문구를 입력해 주세요.",
    template_text_too_long: "완성된 문구가 1,000자를 넘습니다. 변수 값을 줄여 주세요.",
    template_conflict:
      "다른 멤버가 템플릿을 수정했습니다. 편집 내용은 유지됩니다. 목록을 새로고침하고 다시 선택해 주세요.",
    template_archived: "보관된 템플릿입니다. 목록을 새로고침하고 다른 템플릿을 선택해 주세요.",
    template_not_found: "사용할 수 없는 템플릿입니다. 목록을 새로고침해 주세요.",
    template_name_exists: "같은 이름의 템플릿이 있습니다. 다른 이름을 입력해 주세요.",
    template_limit_reached: "템플릿은 50개까지 사용할 수 있습니다. 사용하지 않는 템플릿을 보관해 주세요.",
    role_forbidden: "관리자와 소유자만 템플릿을 관리할 수 있습니다.",
    rate_limited: "요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  };
  const failure = (error) =>
    errors[error.code] || "요청 결과를 확인하지 못했습니다. 입력 내용은 유지됩니다. 새로고침 후 확인해 주세요.";

  function controls() {
    const disabled = locked();
    select.disabled = disabled || loading;
    for (const input of byId("inbox-template-values").querySelectorAll("input")) input.disabled = disabled;
    byId("inbox-template-preview").disabled = disabled || loading || previewing || !chosen();
    byId("inbox-template-preview").textContent = previewing ? "미리보기 중…" : "미리보기";
    byId("inbox-template-apply").disabled = disabled || loading || !preview;
    byId("reply-templates-section").hidden = !isAdmin();
    for (const input of form.elements) input.disabled = saving || !isAdmin();
    for (const button of byId("reply-template-list").querySelectorAll("button")) button.disabled = saving;
    byId("reply-template-refresh").disabled = saving || loading;
  }

  function invalidate() {
    previewRequest++;
    previewing = false;
    preview = null;
    byId("inbox-template-output").textContent = "";
    byId("inbox-template-output").hidden = true;
    byId("inbox-template-status").textContent = "";
    controls();
  }

  function selectTemplate() {
    invalidate();
    const fields = byId("inbox-template-values");
    fields.replaceChildren();
    for (const variable of chosen()?.variables || []) {
      const label = node("label", variable);
      const input = node("input");
      input.name = variable;
      input.autocomplete = "off";
      input.maxLength = 1000;
      input.addEventListener("input", invalidate);
      label.append(input);
      fields.append(label);
    }
    controls();
  }

  function conversationChanged() {
    select.value = "";
    selectTemplate();
  }

  function clearEditor() {
    editing = null;
    form.reset();
    byId("reply-template-save").textContent = "템플릿 추가";
    byId("reply-template-cancel").hidden = true;
  }

  function renderList() {
    const list = byId("reply-template-list");
    list.replaceChildren();
    byId("reply-template-count").textContent = `${templates.length} / 50`;
    if (!templates.length) list.append(node("p", "등록된 템플릿이 없습니다.", "hint"));
    for (const template of templates) {
      const card = node("article", "", "reply-template-card");
      const heading = node("div", "", "section-heading");
      heading.append(node("h3", template.name));
      const actions = node("div", "", "form-actions");
      const edit = node("button", "수정", "secondary");
      edit.type = "button";
      edit.setAttribute("aria-label", `${template.name} 수정`);
      edit.addEventListener("click", () => {
        if (saving) return;
        editing = { id: template.id, version: template.version };
        form.elements.name.value = template.name;
        form.elements.body.value = template.body;
        byId("reply-template-save").textContent = "수정 저장";
        byId("reply-template-cancel").hidden = false;
        byId("reply-template-status").textContent = "";
        form.elements.name.focus();
      });
      const archive = node("button", "보관", "secondary");
      archive.type = "button";
      archive.setAttribute("aria-label", `${template.name} 보관`);
      archive.addEventListener("click", () => void save(template.id));
      actions.append(edit, archive);
      heading.append(actions);
      card.append(heading, node("p", template.body, "template-text"));
      list.append(card);
    }
    const previous = select.value;
    select.replaceChildren(new Option("템플릿 선택", ""));
    for (const template of templates) select.append(new Option(template.name, template.id));
    if (templates.some((item) => item.id === previous)) select.value = previous;
    selectTemplate();
    controls();
  }

  async function load() {
    const request = ++listRequest,
      currentSession = session;
    loading = true;
    invalidate();
    try {
      const result = await api(endpoint);
      if (session !== currentSession || request !== listRequest) return;
      templates = result.templates;
      renderList();
    } catch (error) {
      if (session !== currentSession || request !== listRequest) return;
      templates = [];
      renderList();
      byId("inbox-template-status").textContent = failure(error);
      byId("reply-template-status").textContent = failure(error);
    } finally {
      if (session === currentSession && request === listRequest) {
        loading = false;
        controls();
      }
    }
  }

  async function save(archiveId) {
    if (saving || !isAdmin()) return;
    if (!archiveId && !form.reportValidity()) return;
    const currentSession = session,
      target = editing;
    const body = archiveId
      ? undefined
      : {
          name: form.elements.name.value,
          body: form.elements.body.value,
          ...(target ? { expected_version: target.version } : {}),
        };
    saving = true;
    listRequest++;
    loading = false;
    invalidate();
    controls();
    try {
      await api(
        `${endpoint}${archiveId || target ? `/${archiveId || target.id}` : ""}`,
        archiveId ? "DELETE" : target ? "PATCH" : "POST",
        body,
      );
      if (session !== currentSession) return;
      if (!archiveId || editing?.id === archiveId) clearEditor();
      byId("reply-template-status").textContent = archiveId ? "템플릿을 보관했습니다." : "템플릿을 저장했습니다.";
      await load();
    } catch (error) {
      if (session === currentSession) byId("reply-template-status").textContent = failure(error);
    } finally {
      if (session === currentSession) {
        saving = false;
        controls();
      }
    }
  }

  async function showPreview() {
    const template = chosen();
    if (locked() || loading || previewing || !template) return;
    invalidate();
    const request = previewRequest,
      currentSession = session;
    const values = Object.fromEntries(
      [...byId("inbox-template-values").querySelectorAll("input")].map((input) => [input.name, input.value]),
    );
    previewing = true;
    controls();
    try {
      const result = await api(`${endpoint}/${template.id}/preview`, "POST", {
        expected_version: template.version,
        values,
      });
      if (session !== currentSession || request !== previewRequest) return;
      preview = result.text;
      byId("inbox-template-output").textContent = preview;
      byId("inbox-template-output").hidden = false;
      byId("inbox-template-status").textContent =
        `${preview.length} / 1,000 · 작성 내용에 추가한 뒤 문구를 확인하세요.`;
    } catch (error) {
      if (session === currentSession && request === previewRequest)
        byId("inbox-template-status").textContent = failure(error);
    } finally {
      if (session === currentSession && request === previewRequest) {
        previewing = false;
        controls();
      }
    }
  }

  select.addEventListener("change", selectTemplate);
  byId("inbox-template-preview").addEventListener("click", () => void showPreview());
  byId("inbox-template-panel").addEventListener("keydown", (event) => {
    // Enter in a variable must never submit the enclosing reply composer.
    if (event.key === "Enter" && event.target.tagName === "INPUT") {
      event.preventDefault();
      void showPreview();
    }
  });
  byId("inbox-template-apply").addEventListener("click", () => {
    if (locked() || loading || !preview) return;
    if (!appendToDraft(preview)) {
      byId("inbox-template-status").textContent =
        "기존 문구와 합치면 1,000자를 넘습니다. 작성 내용을 줄인 뒤 다시 추가해 주세요.";
      return;
    }
    invalidate();
    byId("inbox-template-status").textContent = "작성 내용에 추가했습니다. 답장을 예약하기 전에 확인해 주세요.";
    byId("inbox-reply-text").focus();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });
  byId("reply-template-cancel").addEventListener("click", clearEditor);
  byId("reply-template-refresh").addEventListener("click", () => void load());
  return {
    load,
    controls,
    conversationChanged,
    hasDrafts: () => Boolean(form.elements.name.value || form.elements.body.value),
    reset() {
      session++;
      listRequest++;
      templates = [];
      saving = false;
      loading = false;
      clearEditor();
      renderList();
      byId("reply-template-status").textContent = "";
      byId("reply-templates-section").hidden = true;
    },
  };
}
