function createCampaignDrafts({ api, node }) {
  const byId = (id) => document.getElementById(id);
  const form = byId("campaign-draft-form");
  const fields = form.elements;
  const endpoint = "/api/campaign-drafts";
  let generation = 0,
    listRequest = 0,
    detailRequest = 0,
    previewRequest = 0;
  let permitted = false,
    workspace,
    timeZone;
  let drafts = [],
    snapshots = [],
    editing = null,
    operation = null;
  let loading = false,
    reading = false,
    saving = false,
    conflict = false,
    unavailable = false,
    previewing = false;
  // The preview reasons in the API's evaluation order. "조건 통과" only means the recorded conditions passed at as_of.
  const previewReasons = [
    ["connection_unavailable", "연결 발송 불가"],
    ["contact_paused", "자동화 중지"],
    ["no_dm_identity", "확인된 DM 대화 없음"],
    ["opted_out", "수신 거부"],
    ["marketing_consent_required", "마케팅 동의 없음"],
    ["reply_window_closed", "24시간 응답 창 닫힘"],
    ["candidate", "조건 통과"],
  ];
  const messages = {
    invalid_campaign_draft:
      "이름은 60자 이내, 본문은 1,000자 이내로 입력해 주세요. 변수 문법과 제어 문자는 사용할 수 없습니다.",
    campaign_draft_conflict:
      "다른 곳에서 초안이 변경되었거나 보관되었습니다. 입력은 유지됩니다. 저장된 값을 다시 불러온 뒤 수정해 주세요.",
    campaign_draft_not_found: "초안을 찾을 수 없습니다. 목록을 새로고침하고 다시 선택해 주세요.",
    snapshot_not_found: "고정한 대상을 찾을 수 없습니다. 목록을 새로고침하고 다른 대상을 선택해 주세요.",
    campaign_draft_limit_reached:
      "초안은 보관된 항목을 포함해 100개까지 저장할 수 있습니다. 보관해도 한도가 늘어나지 않습니다. 기존 초안을 수정해 주세요.",
    role_forbidden: "소유자와 관리자만 캠페인 초안을 관리할 수 있습니다. 작업 공간 소유자에게 권한을 확인해 주세요.",
    rate_limited: "요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  };
  const message = (error) => messages[error.code] || "불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
  function hasChanges() {
    if (operation || saving) return true;
    return editing
      ? fields.name.value !== editing.name ||
          fields.body.value !== editing.body ||
          fields.snapshot_id.value !== editing.snapshot_id
      : Boolean(fields.name.value || fields.body.value || fields.snapshot_id.value);
  }
  const canDiscard = () => !hasChanges() || confirm("저장하지 않은 캠페인 초안 변경 사항을 버릴까요?");
  function controls() {
    const busy = loading || reading || saving;
    const locked = !permitted || busy || Boolean(operation) || Boolean(editing?.archived) || unavailable;
    for (const key of ["name", "body", "snapshot_id"]) fields[key].disabled = locked;
    byId("campaign-draft-save").disabled =
      !permitted ||
      busy ||
      conflict ||
      unavailable ||
      Boolean(editing?.archived) ||
      (!editing && !operation && drafts.length >= 100);
    byId("campaign-draft-save").textContent = saving
      ? "저장 중…"
      : operation
        ? "같은 요청 재시도"
        : editing
          ? "수정 저장"
          : "초안 저장";
    byId("campaign-draft-archive").hidden = !editing || editing.archived;
    byId("campaign-draft-archive").disabled = !permitted || busy || Boolean(operation) || conflict || unavailable;
    byId("campaign-draft-reload").hidden = !editing;
    byId("campaign-draft-reload").disabled = !permitted || busy || Boolean(operation);
    byId("campaign-draft-new").disabled = !permitted || busy || Boolean(operation);
    byId("campaign-draft-refresh").disabled = !permitted || busy || Boolean(operation);
    byId("campaign-drafts-section").hidden = !permitted;
    for (const button of byId("campaign-draft-list").querySelectorAll("button"))
      button.disabled = busy || Boolean(operation);
    byId("campaign-draft-form").setAttribute("aria-busy", String(reading || saving));
    byId("campaign-draft-count").textContent = `${fields.body.value.length.toLocaleString("ko-KR")} / 1,000`;
    // The preview reads the stored draft, so it waits for unsaved edits to be saved.
    const previewButton = byId("campaign-draft-preview-run");
    byId("campaign-draft-preview").hidden = !editing;
    previewButton.disabled =
      !permitted || !editing || reading || saving || previewing || conflict || unavailable || hasChanges();
    previewButton.textContent = previewing ? "확인하는 중…" : "발송 조건 미리보기";
    previewButton.setAttribute("aria-busy", String(previewing));
  }
  // Retires any pending preview read through its request counter, like the list and detail reads.
  function clearPreview() {
    previewRequest++;
    previewing = false;
    byId("campaign-draft-preview-warnings").replaceChildren();
    byId("campaign-draft-preview-status").textContent = "";
    byId("campaign-draft-preview-summary").replaceChildren();
    byId("campaign-draft-preview-rows").replaceChildren();
    byId("campaign-draft-preview-result").hidden = true;
  }
  // Counts arrive as decimal strings; BigInt keeps values beyond 2^53 exact.
  function decimal(value) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("invalid preview count");
    return BigInt(value).toLocaleString("ko-KR");
  }
  function renderPreview(preview) {
    // Build every node first so a malformed response changes nothing on screen.
    const warnings = [];
    if (preview.channel_marketing_supported !== true)
      warnings.push(node("p", "Instagram 마케팅 발송은 아직 지원하지 않습니다."));
    if (preview.global_send_enabled !== true) warnings.push(node("p", "서비스 전체 발송이 꺼져 있습니다."));
    const asOf = new Date(preview.as_of);
    if (Number.isNaN(asOf.getTime())) throw new Error("invalid preview time");
    const summary = [
      ["원래 인원", `${decimal(preview.original_member_count)}명`],
      ["현재 남은 인원", `${decimal(preview.remaining_member_count)}명`],
      ["예상 공급자 호출 수", `${decimal(preview.estimated_provider_calls)}회`],
      [
        "요금제 일괄 발송 한도",
        preview.plan_broadcast_limit === null ? "정해지지 않음" : `${decimal(preview.plan_broadcast_limit)}명`,
      ],
      ["기준 시각", `${asOf.toLocaleString("ko-KR", { timeZone })} (${timeZone})`],
    ].map(([label, value]) => {
      const item = node("div", "");
      item.append(node("dt", label), node("dd", value));
      return item;
    });
    const rows = previewReasons.map(([reason, label]) => {
      const row = node("tr", "");
      const header = node("th", label);
      header.setAttribute("scope", "row");
      row.append(header, node("td", `${decimal(preview.counts?.[reason])}명`));
      return row;
    });
    byId("campaign-draft-preview-warnings").replaceChildren(...warnings);
    byId("campaign-draft-preview-summary").replaceChildren(...summary);
    byId("campaign-draft-preview-rows").replaceChildren(...rows);
    byId("campaign-draft-preview-result").hidden = false;
  }
  function clearEditor() {
    clearPreview();
    editing = null;
    operation = null;
    conflict = false;
    unavailable = false;
    form.reset();
    fields.snapshot_id.value = "";
    byId("campaign-draft-editor-title").textContent = "새 초안";
    byId("campaign-draft-summary").textContent = "";
    byId("campaign-draft-status").textContent = "";
    controls();
  }
  function options(previous = fields.snapshot_id.value) {
    const placeholder = node(
      "option",
      snapshots.length ? "고정한 대상 선택" : "먼저 위에서 필터를 선택하고 대상을 고정해 주세요.",
    );
    placeholder.value = "";
    const choices = snapshots.map((snapshot) => {
      const date = new Date(snapshot.as_of).toLocaleString("ko-KR", { timeZone });
      const option = node(
        "option",
        `${snapshot.segment_name}${snapshot.segment_archived ? " · 필터 보관됨" : ""} · ${date} · 고정 당시 ${snapshot.member_count}명`,
      );
      option.value = snapshot.id;
      return option;
    });
    // Keep a loaded draft's reference visible if a refresh cannot find that snapshot in the list.
    if (previous && !snapshots.some((snapshot) => snapshot.id === previous)) {
      const missing = node("option", "기존 고정 대상 · 목록에서 찾을 수 없음");
      missing.value = previous;
      choices.push(missing);
    }
    fields.snapshot_id.replaceChildren(placeholder, ...choices);
    fields.snapshot_id.value = previous;
  }
  function renderList() {
    const list = byId("campaign-draft-list");
    list.replaceChildren();
    byId("campaign-draft-capacity").textContent = `보관된 초안 포함 ${drafts.length} / 100개`;
    if (!drafts.length)
      list.append(node("p", "저장한 초안이 없습니다. 고정한 대상을 선택하고 메시지를 작성해 주세요.", "hint"));
    for (const draft of drafts) {
      const card = node("article", "", "campaign-draft-card");
      const label = node("h3", `${draft.name}${draft.archived ? " · 보관됨" : ""}`);
      const open = node("button", "초안 보기", "secondary");
      open.type = "button";
      open.setAttribute("aria-label", `${draft.name} 초안 보기`);
      open.addEventListener("click", () => openDraft(draft.id));
      card.append(label, open);
      list.append(card);
    }
    controls();
  }
  function showDraft(draft) {
    editing = draft;
    operation = null;
    conflict = false;
    unavailable = false;
    fields.name.value = draft.name;
    fields.body.value = draft.body;
    options(draft.snapshot_id);
    byId("campaign-draft-editor-title").textContent = draft.archived ? "보관된 초안" : "초안 수정";
    byId("campaign-draft-summary").textContent =
      `원래 ${draft.original_member_count}명 · 현재 ${draft.stored_member_count}명 · 버전 ${draft.version}${draft.archived ? " · 보관됨" : ""}. 계정·이용자 데이터 삭제로 명단이 줄어들 수 있습니다. 발송 가능한 인원 수는 아닙니다.`;
    controls();
  }
  function authorizationLost(error) {
    if (error.status !== 401 && error.status !== 403) return false;
    reset();
    return true;
  }
  async function load() {
    if (!permitted || saving || reading || operation) return;
    const session = generation,
      request = ++listRequest;
    loading = true;
    controls();
    byId("campaign-draft-list-status").textContent = "목록을 불러오는 중…";
    try {
      const [list, targets] = await Promise.all([api(endpoint), api("/api/segment-snapshots")]);
      if (session !== generation || request !== listRequest) return;
      drafts = list.drafts;
      snapshots = targets.snapshots;
      options();
      renderList();
      byId("campaign-draft-list-status").textContent = "";
    } catch (error) {
      if (session !== generation || request !== listRequest || authorizationLost(error)) return;
      drafts = [];
      snapshots = [];
      renderList();
      options();
      byId("campaign-draft-list-status").textContent = message(error);
    } finally {
      if (session === generation && request === listRequest) {
        loading = false;
        controls();
      }
    }
  }
  async function openDraft(id) {
    if (!permitted || loading || saving || reading || operation || !canDiscard()) return;
    const session = generation,
      request = ++detailRequest;
    clearEditor();
    reading = true;
    controls();
    byId("campaign-draft-status").textContent = "초안을 불러오는 중…";
    try {
      const draft = await api(`${endpoint}/${id}`);
      if (session !== generation || request !== detailRequest) return;
      showDraft(draft);
      byId("campaign-draft-status").textContent = "";
      byId("campaign-draft-editor-title").focus();
    } catch (error) {
      if (session !== generation || request !== detailRequest || authorizationLost(error)) return;
      unavailable = true;
      byId("campaign-draft-status").textContent = message(error);
    } finally {
      if (session === generation && request === detailRequest) {
        reading = false;
        controls();
      }
    }
  }
  function valid() {
    const name = fields.name.value.normalize("NFC").trim();
    const body = fields.body.value;
    return (
      form.reportValidity() &&
      fields.snapshot_id.value &&
      name &&
      [...name].length <= 60 &&
      !/[\u0000-\u001f\u007f]/.test(name) &&
      body.trim() &&
      body.length <= 1000 &&
      !body.includes("\u0000") &&
      !body.includes("{{") &&
      !body.includes("}}")
    );
  }
  async function save(archive = false) {
    if (!permitted || loading || reading || saving || conflict || unavailable || editing?.archived) return;
    if (
      archive &&
      (!editing ||
        operation ||
        !canDiscard() ||
        !confirm("이 초안을 보관할까요? 보관한 초안은 다시 수정할 수 없으며 저장 한도에 포함됩니다."))
    )
      return;
    if (!operation) {
      if (!archive && !valid()) {
        byId("campaign-draft-status").textContent = messages.invalid_campaign_draft;
        return;
      }
      operation = {
        path: `${endpoint}${editing ? `/${editing.id}${archive ? "/archive" : ""}` : ""}`,
        method: editing && !archive ? "PUT" : "POST",
        body: archive
          ? { expected_version: editing.version }
          : {
              ...(editing ? { expected_version: editing.version } : { id: crypto.randomUUID() }),
              snapshot_id: fields.snapshot_id.value,
              name: fields.name.value,
              body: fields.body.value,
            },
        archive,
      };
    }
    clearPreview();
    const session = generation,
      pending = operation;
    saving = true;
    controls();
    try {
      const draft = await api(pending.path, pending.method, pending.body);
      if (session !== generation) return;
      showDraft(draft);
      byId("campaign-draft-status").textContent = draft.archived
        ? "초안을 보관했습니다."
        : "초안을 저장했습니다. 메시지는 전송되지 않았습니다.";
      saving = false;
      await load();
    } catch (error) {
      if (session !== generation || authorizationLost(error)) return;
      if (!error.status || error.status >= 500) {
        byId("campaign-draft-status").textContent =
          "저장 결과를 확인하지 못했습니다. 입력을 잠시 잠갔습니다. 같은 요청 재시도로 결과를 확인해 주세요.";
      } else if (error.status === 429) {
        // A throttled retry says nothing about the previous attempt's acceptance.
        byId("campaign-draft-status").textContent =
          "요청이 많습니다. 입력을 유지하고 있습니다. 잠시 후 같은 요청을 재시도해 주세요.";
      } else {
        operation = null;
        conflict = error.code === "campaign_draft_conflict";
        byId("campaign-draft-status").textContent = message(error);
      }
    } finally {
      if (session === generation) {
        saving = false;
        controls();
      }
    }
  }
  // A read: an unknown outcome only allows another click, so nothing here locks the editor or the button.
  async function preview() {
    if (
      !permitted ||
      !editing ||
      reading ||
      saving ||
      previewing ||
      operation ||
      conflict ||
      unavailable ||
      hasChanges()
    )
      return;
    clearPreview();
    const session = generation,
      request = previewRequest,
      draft = editing;
    previewing = true;
    controls();
    byId("campaign-draft-preview-status").textContent = "발송 조건을 확인하는 중…";
    try {
      const result = await api(`${endpoint}/${draft.id}/preview`);
      if (session !== generation || request !== previewRequest) return;
      if (result.draft_id !== editing?.id || result.draft_version !== editing.version) {
        byId("campaign-draft-preview-status").textContent =
          "초안이 다른 곳에서 변경되었습니다. 저장된 값을 다시 불러온 뒤 미리보기를 다시 눌러 주세요.";
        return;
      }
      renderPreview(result);
      byId("campaign-draft-preview-status").textContent = "";
    } catch (error) {
      if (session !== generation || request !== previewRequest || authorizationLost(error)) return;
      byId("campaign-draft-preview-status").textContent = message(error);
    } finally {
      if (session === generation && request === previewRequest) {
        previewing = false;
        controls();
      }
    }
  }
  function reset() {
    generation++;
    listRequest++;
    detailRequest++;
    permitted = false;
    workspace = undefined;
    loading = reading = saving = false;
    drafts = [];
    snapshots = [];
    clearEditor();
    options();
    byId("campaign-draft-list").replaceChildren();
    byId("campaign-draft-capacity").textContent = "";
    byId("campaign-draft-list-status").textContent = "";
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    return save();
  });
  form.addEventListener("input", () => {
    clearPreview();
    controls();
  });
  byId("campaign-draft-preview-run").addEventListener("click", preview);
  byId("campaign-draft-archive").addEventListener("click", () => save(true));
  byId("campaign-draft-reload").addEventListener("click", () => editing && openDraft(editing.id));
  byId("campaign-draft-new").addEventListener("click", () => {
    if (!permitted || loading || reading || saving || operation || !canDiscard()) return;
    clearEditor();
    fields.name.focus();
  });
  byId("campaign-draft-refresh").addEventListener("click", load);
  return {
    reset,
    hasChanges,
    configure(role, workspaceId, zone) {
      const allowed = ["owner", "admin"].includes(role);
      if (!allowed || workspace !== workspaceId) reset();
      permitted = allowed;
      workspace = workspaceId;
      timeZone = zone;
      controls();
      if (permitted) return load();
    },
  };
}
