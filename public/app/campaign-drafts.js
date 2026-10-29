function createCampaignDrafts({ api, node, userId = () => undefined }) {
  const byId = (id) => document.getElementById(id);
  const form = byId("campaign-draft-form");
  const fields = form.elements;
  const endpoint = "/api/campaign-drafts";
  let generation = 0,
    listRequest = 0,
    detailRequest = 0,
    previewRequest = 0,
    approvalRequest = 0;
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
  // The open draft's execution approval. Until a read for this draft succeeds the state is unknown, which keeps the
  // approve control off; `approval` is then the draft's newest approval in the list order (in force or cancelled).
  let approvalLoaded = false,
    approval = null,
    approvalReading = false,
    approving = false,
    // An approval write whose outcome is unknown or throttled: only this exact request may be sent again.
    approvalOperation = null,
    // The approval request shown in the confirmation step before it is sent.
    staged = null;
  // The executed approval's run (#36). It is read when the approval is shown and on an explicit refresh only; there is
  // no polling. `runRequest` retires a pending read or cancel response, like the other request counters.
  let runRequest = 0,
    run = null,
    runReading = false,
    cancelling = false,
    // A cancel whose outcome is unknown or throttled: only this exact request may be sent again.
    runOperation = null,
    // The cancel request shown in the confirmation step before it is sent.
    runStaged = null;
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
    approval_active:
      "다른 곳에서 이 초안의 실행 승인이 기록되었습니다. 입력은 유지됩니다. 수정하거나 보관하려면 먼저 승인을 취소해 주세요.",
  };
  const message = (error) => messages[error.code] || "불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
  const approvalMessages = {
    approval_exists: "다른 곳에서 이 초안의 실행 승인이 먼저 기록되었습니다. 현재 승인을 표시합니다.",
    campaign_draft_conflict:
      "다른 곳에서 초안이 변경되었거나 보관되었습니다. 저장된 초안을 다시 표시했습니다. 내용을 확인한 뒤 다시 승인해 주세요.",
    campaign_approval_conflict:
      "다른 곳에서 승인이 변경되었습니다. 현재 승인을 표시합니다. 확인한 뒤 다시 시도해 주세요.",
    campaign_approval_cancelled: "이미 취소된 승인입니다. 현재 상태를 표시합니다.",
    campaign_approval_executed: "이미 실행이 시작된 승인이라 바꾸거나 취소할 수 없습니다. 현재 상태를 표시합니다.",
    campaign_version_executed:
      "이 초안 버전은 이미 실행되었습니다. 다시 보내려면 초안을 수정해 저장한 뒤 승인해 주세요. 실행된 승인을 표시합니다.",
    campaign_schedule_timezone_changed:
      "작업 공간 시간대가 다른 곳에서 바뀌었습니다. 페이지를 새로고침해 바뀐 시간대를 확인한 뒤 다시 시도해 주세요.",
    campaign_schedule_out_of_range: "예약 시각은 현재보다 1분 이상 뒤여야 합니다. 시각을 다시 선택해 주세요.",
    invalid_campaign_approval: "실행 시점을 확인해 주세요. 예약은 날짜와 시각을 모두 선택해야 합니다.",
    campaign_approval_not_found: "승인을 찾을 수 없습니다. 승인 상태를 새로고침해 주세요.",
    campaign_approval_id_conflict: "승인 요청을 확인하지 못했습니다. 승인 상태를 새로고침한 뒤 다시 시도해 주세요.",
  };
  const approvalMessage = (error) => approvalMessages[error.code] || message(error);
  const runMessages = {
    campaign_run_conflict:
      "다른 곳에서 실행 상태가 바뀌었습니다. 현재 실행 현황을 표시합니다. 확인한 뒤 다시 시도해 주세요.",
    campaign_run_cancelled: "이미 취소된 실행입니다. 현재 실행 현황을 표시합니다.",
    campaign_run_completed: "이미 완료된 실행이라 취소할 수 없습니다. 현재 실행 현황을 표시합니다.",
    campaign_run_not_found: "실행을 찾을 수 없습니다. 승인 상태를 새로고침해 주세요.",
    invalid_campaign_run: "실행 취소 요청을 확인하지 못했습니다. 실행 현황을 새로고침한 뒤 다시 시도해 주세요.",
  };
  const runMessage = (error) => runMessages[error.code] || message(error);
  const runStatuses = [
    ["running", "진행 중"],
    ["cancelled", "취소됨"],
    ["completed", "완료"],
  ];
  // The run API's seven delivery statuses. "보냄" is Meta's acceptance only; "결과 불명" is never retried automatically.
  const deliveryStatuses = [
    ["pending", "대기"],
    ["sending", "보내는 중"],
    ["sent", "보냄"],
    ["failed", "실패"],
    ["blocked", "차단"],
    ["unknown", "결과 불명"],
    ["cancelled", "취소"],
  ];
  function draftChanged() {
    return editing
      ? fields.name.value !== editing.name ||
          fields.body.value !== editing.body ||
          fields.snapshot_id.value !== editing.snapshot_id
      : Boolean(fields.name.value || fields.body.value || fields.snapshot_id.value);
  }
  function hasChanges() {
    if (operation || saving || approvalOperation || approving || runOperation || cancelling) return true;
    return draftChanged();
  }
  const canDiscard = () => !hasChanges() || confirm("저장하지 않은 캠페인 초안 변경 사항을 버릴까요?");
  const approvalActive = () => approval?.status === "approved";
  const timing = () => byId("campaign-approval-timing");
  const scheduleInput = () => byId("campaign-approval-schedule");
  // null is "즉시"; a scheduled time is the datetime-local value the server parses (YYYY-MM-DDTHH:MM, no seconds).
  const scheduleChoice = () => (timing().value === "later" ? scheduleInput().value : null);
  const scheduleReady = () => {
    const choice = scheduleChoice();
    return choice === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(choice);
  };
  // A schedule change that equals the approval in force would only bump its version.
  const scheduleChanged = () => {
    const choice = scheduleChoice();
    if (choice === null) return approval.schedule_kind !== "immediate";
    return !(
      approval.schedule_kind === "scheduled" &&
      approval.schedule_time_zone === timeZone &&
      approval.schedule_local === choice
    );
  };
  function controls() {
    const busy = loading || reading || saving || approving || cancelling;
    const pending = Boolean(operation || approvalOperation || runOperation);
    // A draft with an approval in force, or whose approval is being read or written, is read-only.
    const approvalLock =
      Boolean(editing) && (approvalActive() || approvalReading || Boolean(approvalOperation) || approving);
    const locked = !permitted || busy || pending || Boolean(editing?.archived) || unavailable || approvalLock;
    for (const key of ["name", "body", "snapshot_id"]) fields[key].disabled = locked;
    byId("campaign-draft-approval-lock").hidden = !editing || !approvalActive();
    byId("campaign-draft-save").disabled =
      !permitted ||
      busy ||
      conflict ||
      unavailable ||
      Boolean(editing?.archived) ||
      approvalLock ||
      (!editing && !operation && drafts.length >= 100);
    byId("campaign-draft-save").textContent = saving
      ? "저장 중…"
      : operation
        ? "같은 요청 재시도"
        : editing
          ? "수정 저장"
          : "초안 저장";
    byId("campaign-draft-archive").hidden = !editing || editing.archived;
    byId("campaign-draft-archive").disabled = !permitted || busy || pending || conflict || unavailable || approvalLock;
    byId("campaign-draft-reload").hidden = !editing;
    byId("campaign-draft-reload").disabled = !permitted || busy || pending;
    byId("campaign-draft-new").disabled = !permitted || busy || pending;
    byId("campaign-draft-refresh").disabled = !permitted || busy || pending;
    byId("campaign-drafts-section").hidden = !permitted;
    for (const button of byId("campaign-draft-list").querySelectorAll("button")) button.disabled = busy || pending;
    byId("campaign-draft-form").setAttribute("aria-busy", String(reading || saving));
    byId("campaign-draft-count").textContent = `${fields.body.value.length.toLocaleString("ko-KR")} / 1,000`;
    // The preview reads the stored draft, so it waits for unsaved edits to be saved.
    const previewButton = byId("campaign-draft-preview-run");
    byId("campaign-draft-preview").hidden = !editing;
    previewButton.disabled =
      !permitted || !editing || reading || saving || previewing || conflict || unavailable || hasChanges();
    previewButton.textContent = previewing ? "확인하는 중…" : "발송 조건 미리보기";
    previewButton.setAttribute("aria-busy", String(previewing));
    approvalControls(busy);
  }
  function approvalControls(busy) {
    const kind = approvalOperation?.kind;
    const active = approvalActive();
    const idle = permitted && Boolean(editing) && !busy && !approvalReading && !approvalOperation && !runOperation;
    byId("campaign-approval").hidden = !editing;
    byId("campaign-approval").setAttribute("aria-busy", String(approvalReading || approving));
    // The approve control needs the stored, unarchived, unchanged draft and a read that found no approval in force.
    const canApprove =
      idle &&
      !editing.archived &&
      !operation &&
      !conflict &&
      !unavailable &&
      !draftChanged() &&
      approvalLoaded &&
      !active &&
      !staged &&
      scheduleReady();
    const inputsLocked = !idle || Boolean(staged) || !approvalLoaded || (!active && Boolean(editing?.archived));
    timing().disabled = inputsLocked;
    scheduleInput().disabled = inputsLocked;
    byId("campaign-approval-schedule-fields").hidden = timing().value !== "later";
    byId("campaign-approval-schedule-help").textContent =
      `${timeZone || ""} 기준 작업 공간 현지 시각입니다. 현재보다 1분 이상 뒤의 시각을 선택해 주세요.`;
    const confirmVisible = Boolean(staged) || kind === "create";
    const start = byId("campaign-approval-start");
    start.hidden = active || confirmVisible;
    start.disabled = !canApprove;
    const submit = byId("campaign-approval-submit");
    byId("campaign-approval-confirm").hidden = !confirmVisible;
    submit.disabled = !permitted || busy || approvalReading || (kind !== "create" && !staged);
    submit.textContent =
      approving && kind === "create" ? "승인 기록 중…" : kind === "create" ? "같은 요청 재시도" : "승인 기록";
    submit.setAttribute("aria-busy", String(approving && kind === "create"));
    byId("campaign-approval-back").hidden = kind === "create";
    byId("campaign-approval-back").disabled = approving;
    for (const [id, action, label, busyLabel] of [
      ["campaign-approval-reschedule", "schedule", "예약 변경", "변경하는 중…"],
      ["campaign-approval-cancel", "cancel", "승인 취소", "취소하는 중…"],
    ]) {
      const button = byId(id);
      button.hidden = !active && kind !== action;
      button.disabled =
        kind === action
          ? !permitted || busy || approvalReading
          : !idle || !active || (action === "schedule" && (!scheduleReady() || !scheduleChanged()));
      button.textContent = approving && kind === action ? busyLabel : kind === action ? "같은 요청 재시도" : label;
      button.setAttribute("aria-busy", String(approving && kind === action));
    }
    // An unresolved run cancel keeps its request; reading the approval again would drop it with the run panel.
    byId("campaign-approval-refresh").disabled =
      !permitted || !editing || busy || approvalReading || Boolean(runOperation);
    runControls(busy);
  }
  function runControls(busy) {
    const confirmVisible = Boolean(runStaged || runOperation);
    byId("campaign-run").hidden = !editing || !approval?.run_id;
    byId("campaign-run").setAttribute("aria-busy", String(runReading || cancelling));
    byId("campaign-run-refresh").disabled = !permitted || !editing || !approval?.run_id || busy || runReading;
    const start = byId("campaign-run-cancel");
    start.hidden = run?.status !== "running" || confirmVisible;
    start.disabled = !permitted || busy || runReading || run?.status !== "running";
    byId("campaign-run-confirm").hidden = !confirmVisible;
    const submit = byId("campaign-run-cancel-submit");
    submit.disabled = !permitted || busy || runReading || !confirmVisible;
    submit.textContent = cancelling ? "취소하는 중…" : runOperation ? "같은 요청 재시도" : "실행 취소 확정";
    submit.setAttribute("aria-busy", String(cancelling));
    // An unresolved request cannot be abandoned; only its retry is offered.
    byId("campaign-run-cancel-back").hidden = Boolean(runOperation);
    byId("campaign-run-cancel-back").disabled = cancelling;
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
  // One table row per reason, in the API order, with a row header; the preview and the stored approval share it.
  const reasonRows = (counts) =>
    previewReasons.map(([reason, label]) => {
      const row = node("tr", "");
      const header = node("th", label);
      header.setAttribute("scope", "row");
      row.append(header, node("td", `${decimal(counts?.[reason])}명`));
      return row;
    });
  const definitions = (entries) =>
    entries.map(([label, value]) => {
      const item = node("div", "");
      item.append(node("dt", label), node("dd", value));
      return item;
    });
  function instant(value, zone) {
    const date = new Date(value);
    if (typeof value !== "string" || Number.isNaN(date.getTime())) throw new Error("invalid approval time");
    return `${date.toLocaleString("ko-KR", { timeZone: zone })} (${zone})`;
  }
  const member = (id) => (id && id === userId() ? "나" : `다른 멤버 (${String(id).slice(0, 8)})`);
  const snapshotLabel = (id) => {
    const snapshot = snapshots.find((item) => item.id === id);
    return snapshot
      ? `${snapshot.segment_name} · ${new Date(snapshot.as_of).toLocaleString("ko-KR", { timeZone })} · 고정 당시 ${snapshot.member_count}명`
      : "목록에서 찾을 수 없는 고정 대상";
  };
  // Scheduled times show in the zone the approval stored, which a later workspace zone change does not move.
  const scheduleText = (value) =>
    value.schedule_kind === "immediate" ? "즉시" : instant(value.scheduled_at, value.schedule_time_zone);
  function renderApproval(value) {
    // Build every node first so a malformed response changes nothing on screen.
    if (
      !["approved", "cancelled", "executed"].includes(value?.status) ||
      !Number.isInteger(value.version) ||
      (value.run_id != null && typeof value.run_id !== "string")
    )
      throw new Error("invalid approval");
    const active = value.status === "approved";
    // An executed approval started its run (#36), which the delivery worker sends; the run panel below the approval
    // shows it.
    const executed = value.status === "executed";
    const entries = [
      [
        "상태",
        active
          ? "승인됨 · 실행 시점에 서비스 발송이 켜져 있으면 시작"
          : executed
            ? "실행 시작됨 · 보내기 직전에 조건을 다시 확인해 발송"
            : "취소됨",
      ],
      ["승인한 초안", `${value.name} · 버전 ${value.draft_version}`],
      ["실행 시점", scheduleText(value)],
      ["승인", `${instant(value.approved_at, timeZone)} · ${member(value.approved_by)}`],
    ];
    if (value.status === "cancelled")
      entries.push(["취소", `${instant(value.cancelled_at, timeZone)} · ${member(value.cancelled_by)}`]);
    entries.push(
      ["승인 시점 원래 인원", `${decimal(value.preview?.original_member_count)}명`],
      ["승인 시점 남은 인원", `${decimal(value.preview?.remaining_member_count)}명`],
      ["조건 기준 시각", instant(value.preview?.as_of, timeZone)],
    );
    const summary = definitions(entries);
    const rows = reasonRows(value.preview?.counts);
    const warnings = active
      ? [
          node(
            "p",
            "실행 시점이 되면 서비스 전체 발송이 켜져 있을 때만 실행이 시작됩니다. 보내기 직전마다 모든 조건을 다시 확인하며, 조건을 통과하지 못한 사람에게는 보내지 않습니다.",
          ),
        ]
      : [];
    // Another approval, or the same one now carrying a run, retires the run shown and any response for it.
    if (approval?.id !== value.id || (approval?.run_id ?? null) !== (value.run_id ?? null)) clearRun();
    approval = value;
    approvalLoaded = true;
    byId("campaign-approval-current-title").textContent = active
      ? "유효한 승인"
      : executed
        ? "최근 승인 · 실행 시작됨"
        : "최근 승인 · 취소됨";
    byId("campaign-approval-warnings").replaceChildren(...warnings);
    byId("campaign-approval-summary").replaceChildren(...summary);
    byId("campaign-approval-rows").replaceChildren(...rows);
    byId("campaign-approval-current").hidden = false;
    // The schedule inputs start from the approval in force; a time in another zone is not offered as this zone's.
    const sameZone = value.schedule_kind === "scheduled" && value.schedule_time_zone === timeZone;
    timing().value = active && value.schedule_kind === "scheduled" ? "later" : "now";
    scheduleInput().value = active && sameZone ? value.schedule_local : "";
  }
  // Forgets the shown run and retires a pending run read or cancel response. Callers that can hold an unresolved cancel
  // (draft switch, new draft, approval reload, zone change) are blocked while it exists; a session reset drops it.
  function clearRun() {
    runRequest++;
    run = null;
    runReading = false;
    cancelling = false;
    runOperation = null;
    runStaged = null;
    byId("campaign-run-current").hidden = true;
    byId("campaign-run-summary").replaceChildren();
    byId("campaign-run-rows").replaceChildren();
    byId("campaign-run-deliveries").replaceChildren();
    byId("campaign-run-confirm-summary").replaceChildren();
    byId("campaign-run-status").textContent = "";
  }
  function renderRun(value) {
    // Build every node first so a malformed response changes nothing on screen.
    const status = runStatuses.find(([key]) => key === value?.status);
    if (!status || typeof value.id !== "string" || !Number.isInteger(value.version)) throw new Error("invalid run");
    const entries = [["상태", status[1]]];
    if (value.status === "cancelled") entries.push(["취소 시각", instant(value.cancelled_at, timeZone)]);
    entries.push(
      ["시작 시각", instant(value.start?.as_of, timeZone)],
      ["시작 시점 원래 인원", `${decimal(value.start?.original_member_count)}명`],
      ["시작 시점 남은 인원", `${decimal(value.start?.remaining_member_count)}명`],
    );
    const summary = definitions(entries);
    const rows = reasonRows(value.start?.counts);
    const deliveries = definitions(
      deliveryStatuses.map(([key, label]) => [label, `${decimal(value.delivery_counts?.[key])}건`]),
    );
    run = value;
    byId("campaign-run-summary").replaceChildren(...summary);
    byId("campaign-run-rows").replaceChildren(...rows);
    byId("campaign-run-deliveries").replaceChildren(...deliveries);
    byId("campaign-run-current").hidden = false;
  }
  // Reads the shown approval's run. A read never changes a frozen cancel request: its retry stays the only cancel.
  async function loadRun() {
    if (!permitted || !editing || !approval?.run_id || cancelling) return;
    const session = generation,
      request = ++runRequest,
      draftId = editing.id,
      approvalId = approval.id,
      runId = approval.run_id;
    run = null;
    // An unsent confirmation used the old version; an unresolved cancel keeps its summary for the retry.
    runStaged = null;
    if (!runOperation) byId("campaign-run-confirm-summary").replaceChildren();
    byId("campaign-run-current").hidden = true;
    runReading = true;
    controls();
    byId("campaign-run-status").textContent = "실행 현황을 불러오는 중…";
    const current = () =>
      session === generation && request === runRequest && editing?.id === draftId && approval?.id === approvalId;
    try {
      const result = await api(`/api/campaign-runs/${runId}`);
      if (!current()) return;
      if (result?.id !== runId) {
        byId("campaign-run-status").textContent =
          "다른 실행의 응답이라 표시하지 않았습니다. ‘실행 현황 새로고침’을 눌러 주세요.";
        return;
      }
      renderRun(result);
      byId("campaign-run-status").textContent = "";
    } catch (error) {
      if (!current() || authorizationLost(error)) return;
      byId("campaign-run-status").textContent =
        `실행 현황을 불러오지 못했습니다. ${runMessage(error)} ‘실행 현황 새로고침’을 눌러 주세요.`;
    } finally {
      if (current()) {
        runReading = false;
        controls();
      }
    }
  }
  // The confirmation step freezes the run and the version it shows; sending it never rereads the run.
  function startRunCancel() {
    if (byId("campaign-run-cancel").disabled || !run || run.status !== "running") return;
    runStaged = {
      runId: run.id,
      path: `/api/campaign-runs/${run.id}/cancel`,
      body: { expected_version: run.version },
    };
    byId("campaign-run-confirm-summary").replaceChildren(
      ...definitions([
        ["실행 시작 시각", instant(run.start.as_of, timeZone)],
        ["표시된 대기 행", `${decimal(run.delivery_counts.pending)}건`],
        ["표시된 보내는 중 행", `${decimal(run.delivery_counts.sending)}건`],
      ]),
    );
    byId("campaign-run-status").textContent = "";
    controls();
    byId("campaign-run-confirm-title").focus();
  }
  async function cancelRun() {
    if (!permitted || !editing || !approval?.run_id || cancelling || runReading) return;
    if (!runOperation) {
      if (!runStaged) return;
      runOperation = runStaged;
    }
    // A read started before this write could otherwise render the state from before it.
    const session = generation,
      request = ++runRequest,
      pending = runOperation,
      draftId = editing.id,
      approvalId = approval.id;
    runReading = false;
    let reload = false,
      done = false;
    cancelling = true;
    controls();
    byId("campaign-run-status").textContent = "실행을 취소하는 중…";
    const current = () =>
      session === generation && request === runRequest && editing?.id === draftId && approval?.id === approvalId;
    try {
      const result = await api(pending.path, "POST", pending.body);
      if (!current()) return;
      if (result?.id !== pending.runId) throw new Error("invalid run");
      // A malformed body throws before the request is released, so it stays an unknown outcome with its retry.
      const sending = decimal(result.delivery_counts?.sending);
      const cancelled = decimal(result.cancelled_delivery_count);
      renderRun(result);
      runOperation = null;
      runStaged = null;
      done = true;
      byId("campaign-run-status").textContent =
        `실행을 취소했습니다. 대기 중이던 ${cancelled}건을 취소했습니다.` +
        (result.delivery_counts.sending !== "0" ? ` 이미 보내는 중이던 ${sending}건은 되돌릴 수 없습니다.` : "");
    } catch (error) {
      if (!current() || authorizationLost(error)) return;
      if (!error.status || error.status >= 500) {
        byId("campaign-run-status").textContent =
          "처리 결과를 확인하지 못했습니다. 같은 요청 재시도로 결과를 확인해 주세요. 다른 요청은 보낼 수 없습니다.";
      } else if (error.status === 429) {
        // A throttled retry says nothing about the previous attempt's acceptance.
        byId("campaign-run-status").textContent =
          "요청이 많습니다. 요청을 유지하고 있습니다. 잠시 후 같은 요청을 재시도해 주세요.";
      } else {
        // A refusal is final for this request; a 409 shows the run the server sent and never retries.
        runOperation = null;
        runStaged = null;
        byId("campaign-run-confirm-summary").replaceChildren();
        // Without a usable carried run the screen reads the run again instead of keeping the old state.
        reload = true;
        if (error.run?.id === pending.runId) {
          try {
            renderRun(error.run);
            reload = false;
          } catch {
            // The read below replaces it.
          }
        }
        byId("campaign-run-status").textContent = runMessage(error);
      }
    } finally {
      if (session === generation) {
        cancelling = false;
        controls();
      }
    }
    // A cancelled run hides the pressed button; keep keyboard focus on the result.
    if (done && current()) byId("campaign-run-title").focus();
    if (reload && current()) {
      const notice = byId("campaign-run-status").textContent;
      await loadRun();
      const stillShown = session === generation && editing?.id === draftId && approval?.id === approvalId;
      if (stillShown && !byId("campaign-run-status").textContent) byId("campaign-run-status").textContent = notice;
    }
  }
  // Forgets the shown approval and retires a pending approval read; a pending write keeps its own request.
  function clearApproval() {
    clearRun();
    approvalRequest++;
    approvalReading = false;
    approvalLoaded = false;
    approval = null;
    // An unsent confirmation used the old draft state or zone; an unresolved create keeps its summary for the retry.
    staged = null;
    if (approvalOperation?.kind !== "create") byId("campaign-approval-confirm-summary").replaceChildren();
    byId("campaign-approval-current").hidden = true;
    byId("campaign-approval-current-title").textContent = "";
    byId("campaign-approval-warnings").replaceChildren();
    byId("campaign-approval-summary").replaceChildren();
    byId("campaign-approval-rows").replaceChildren();
    byId("campaign-approval-status").textContent = "";
  }
  function renderPreview(preview) {
    // Build every node first so a malformed response changes nothing on screen.
    const warnings = [];
    if (preview.channel_marketing_supported !== true)
      warnings.push(node("p", "Instagram 마케팅 발송은 아직 지원하지 않습니다."));
    if (preview.global_send_enabled !== true) warnings.push(node("p", "서비스 전체 발송이 꺼져 있습니다."));
    const asOf = new Date(preview.as_of);
    if (Number.isNaN(asOf.getTime())) throw new Error("invalid preview time");
    const summary = definitions([
      ["원래 인원", `${decimal(preview.original_member_count)}명`],
      ["현재 남은 인원", `${decimal(preview.remaining_member_count)}명`],
      ["예상 공급자 호출 수", `${decimal(preview.estimated_provider_calls)}회`],
      [
        "요금제 일괄 발송 한도",
        preview.plan_broadcast_limit === null ? "정해지지 않음" : `${decimal(preview.plan_broadcast_limit)}명`,
      ],
      ["기준 시각", `${asOf.toLocaleString("ko-KR", { timeZone })} (${timeZone})`],
    ]);
    const rows = reasonRows(preview.counts);
    byId("campaign-draft-preview-warnings").replaceChildren(...warnings);
    byId("campaign-draft-preview-summary").replaceChildren(...summary);
    byId("campaign-draft-preview-rows").replaceChildren(...rows);
    byId("campaign-draft-preview-result").hidden = false;
  }
  function clearEditor() {
    clearPreview();
    approvalOperation = null;
    clearApproval();
    timing().value = "now";
    scheduleInput().value = "";
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
    if (!permitted || saving || reading || operation || approving) return;
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
    if (
      !permitted ||
      loading ||
      saving ||
      reading ||
      operation ||
      approvalOperation ||
      approving ||
      runOperation ||
      cancelling ||
      !canDiscard()
    )
      return;
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
    if (session === generation && request === detailRequest && editing?.id === id) await loadApproval();
  }
  // The approval list (newest first) holds the summaries with the stored counts; the draft's first entry is its
  // newest approval. An approval older than the list's 100 entries is not found here; approving then answers
  // approval_exists with it.
  async function loadApproval() {
    if (!permitted || !editing || approving || cancelling || runOperation) return;
    clearApproval();
    const session = generation,
      request = approvalRequest,
      draftId = editing.id;
    approvalReading = true;
    controls();
    byId("campaign-approval-status").textContent = "승인 상태를 불러오는 중…";
    const current = () => session === generation && request === approvalRequest && editing?.id === draftId;
    try {
      const result = await api("/api/campaign-approvals");
      if (!current()) return;
      const found = result.approvals.find((item) => item.draft_id === draftId);
      if (found) renderApproval(found);
      else approvalLoaded = true;
      byId("campaign-approval-status").textContent = "";
    } catch (error) {
      if (!current() || authorizationLost(error)) return;
      approvalLoaded = false;
      approval = null;
      byId("campaign-approval-current").hidden = true;
      byId("campaign-approval-status").textContent =
        `승인 상태를 확인하지 못해 승인할 수 없습니다. ${message(error)} ‘승인 상태 새로고침’을 눌러 주세요.`;
    } finally {
      if (current()) {
        approvalReading = false;
        controls();
      }
    }
    // An executed approval's run is read once here; later reads need the refresh button.
    if (current() && approval?.run_id) await loadRun();
  }
  // The confirmation step freezes the request it shows; sending it never rereads the inputs or the zone.
  function startApproval() {
    if (byId("campaign-approval-start").disabled) return;
    staged = {
      path: `${endpoint}/${editing.id}/approvals`,
      body: { expected_version: editing.version, schedule_local: scheduleChoice(), expected_time_zone: timeZone },
    };
    byId("campaign-approval-confirm-summary").replaceChildren(
      ...definitions([
        ["초안", `${editing.name} · 버전 ${editing.version}`],
        ["고정 대상", snapshotLabel(editing.snapshot_id)],
        [
          "실행 시점",
          staged.body.schedule_local === null
            ? "즉시"
            : `${staged.body.schedule_local.replace("T", " ")} (${staged.body.expected_time_zone})`,
        ],
      ]),
    );
    byId("campaign-approval-status").textContent = "";
    controls();
    byId("campaign-approval-confirm-title").focus();
  }
  // An unresolved create keeps its summary: the retry panel must still show what it sends.
  function closeConfirmation() {
    staged = null;
    if (approvalOperation?.kind !== "create") byId("campaign-approval-confirm-summary").replaceChildren();
  }
  async function sendApproval(kind) {
    if (!permitted || !editing || approving || approvalReading || cancelling || runOperation) return;
    if (approvalOperation) {
      if (approvalOperation.kind !== kind) return;
    } else if (kind === "create") {
      if (!staged) return;
      approvalOperation = {
        kind,
        path: staged.path,
        method: "POST",
        body: { id: crypto.randomUUID(), ...staged.body },
      };
    } else {
      if (byId(kind === "schedule" ? "campaign-approval-reschedule" : "campaign-approval-cancel").disabled) return;
      if (kind === "cancel" && !confirm("이 실행 승인을 취소할까요? 취소한 승인은 다시 되돌릴 수 없습니다.")) return;
      approvalOperation =
        kind === "schedule"
          ? {
              kind,
              path: `/api/campaign-approvals/${approval.id}/schedule`,
              method: "PUT",
              body: {
                expected_version: approval.version,
                schedule_local: scheduleChoice(),
                expected_time_zone: timeZone,
              },
            }
          : {
              kind,
              path: `/api/campaign-approvals/${approval.id}/cancel`,
              method: "POST",
              body: { expected_version: approval.version },
            };
    }
    // A read started before this write could otherwise render the state from before it.
    approvalRequest++;
    approvalReading = false;
    const session = generation,
      pending = approvalOperation;
    let reload = false,
      done = false;
    approving = true;
    controls();
    byId("campaign-approval-status").textContent =
      kind === "create" ? "승인을 기록하는 중…" : kind === "schedule" ? "예약을 변경하는 중…" : "승인을 취소하는 중…";
    try {
      const result = await api(pending.path, pending.method, pending.body);
      if (session !== generation) return;
      renderApproval(result);
      approvalOperation = null;
      closeConfirmation();
      done = true;
      byId("campaign-approval-status").textContent =
        kind === "create"
          ? "실행 승인을 기록했습니다. 메시지는 전송되지 않았습니다."
          : kind === "schedule"
            ? "예약을 변경했습니다. 메시지는 전송되지 않았습니다."
            : "승인을 취소했습니다. 이제 초안을 수정할 수 있습니다.";
    } catch (error) {
      if (session !== generation || authorizationLost(error)) return;
      if (!error.status || error.status >= 500) {
        byId("campaign-approval-status").textContent =
          "처리 결과를 확인하지 못했습니다. 같은 요청 재시도로 결과를 확인해 주세요. 다른 요청은 보낼 수 없습니다.";
      } else if (error.status === 429) {
        // A throttled retry says nothing about the previous attempt's acceptance.
        byId("campaign-approval-status").textContent =
          "요청이 많습니다. 요청을 유지하고 있습니다. 잠시 후 같은 요청을 재시도해 주세요.";
      } else {
        // A refusal is final for this request; conflicts show the state the server sent and never retry.
        approvalOperation = null;
        closeConfirmation();
        if (error.code === "campaign_draft_conflict" && error.draft) {
          // The preview on screen was read for the older version.
          clearPreview();
          showDraft(error.draft);
          reload = true;
        } else if (error.approval) {
          try {
            renderApproval(error.approval);
          } catch {
            reload = true;
          }
        }
        byId("campaign-approval-status").textContent = approvalMessage(error);
      }
    } finally {
      if (session === generation) {
        approving = false;
        controls();
      }
    }
    // A recorded or cancelled approval hides the pressed button; keep keyboard focus on the result.
    if (done && kind !== "schedule" && session === generation) byId("campaign-approval-current-title").focus();
    if (reload && session === generation) {
      const notice = byId("campaign-approval-status").textContent;
      await loadApproval();
      if (session === generation && !byId("campaign-approval-status").textContent)
        byId("campaign-approval-status").textContent = notice;
    }
    // A refusal can carry an executed approval (campaign_approval_executed, campaign_version_executed): show its run.
    else if (session === generation && approval?.run_id && !run && !runReading) await loadRun();
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
      editing &&
      (approvalActive() || approvalReading || approvalOperation || approving || runOperation || cancelling)
    )
      return;
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
    let approvalChanged = false,
      saved = null;
    saving = true;
    controls();
    try {
      const draft = await api(pending.path, pending.method, pending.body);
      if (session !== generation) return;
      showDraft(draft);
      // Every edit and archive moves the version, so a confirmation opened before it shows a version the server refuses.
      closeConfirmation();
      saved = draft.id;
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
        // Another tab approved this draft: the edits stay on screen and the approval area shows that approval.
        approvalChanged = error.code === "approval_active";
        byId("campaign-draft-status").textContent = message(error);
      }
    } finally {
      if (session === generation) {
        saving = false;
        controls();
      }
    }
    if (approvalChanged && session === generation) await loadApproval();
    // A draft created here (or by a retried create) has no approval read yet; until one succeeds approving stays off.
    else if (saved && session === generation && editing?.id === saved && !approvalLoaded && !approvalReading)
      await loadApproval();
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
    loading = reading = saving = approving = false;
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
    closeConfirmation();
    controls();
  });
  // A zone change retires the approval shown in the old zone and reads it again; a pending write renders its own result.
  function zoneChanged() {
    closeConfirmation();
    if (editing && !approving) void loadApproval();
  }
  for (const [element, event] of [
    [timing(), "change"],
    [scheduleInput(), "input"],
    [scheduleInput(), "change"],
  ])
    element.addEventListener(event, () => controls());
  byId("campaign-approval-start").addEventListener("click", startApproval);
  byId("campaign-approval-submit").addEventListener("click", () => sendApproval("create"));
  byId("campaign-approval-back").addEventListener("click", () => {
    if (approving || approvalOperation) return;
    closeConfirmation();
    controls();
    byId("campaign-approval-start").focus();
  });
  byId("campaign-approval-reschedule").addEventListener("click", () => sendApproval("schedule"));
  byId("campaign-approval-cancel").addEventListener("click", () => sendApproval("cancel"));
  byId("campaign-approval-refresh").addEventListener("click", () => {
    if (!byId("campaign-approval-refresh").disabled) return loadApproval();
  });
  byId("campaign-run-refresh").addEventListener("click", () => {
    if (!byId("campaign-run-refresh").disabled) return loadRun();
  });
  byId("campaign-run-cancel").addEventListener("click", startRunCancel);
  byId("campaign-run-cancel-submit").addEventListener("click", () => {
    if (!byId("campaign-run-cancel-submit").disabled) return cancelRun();
  });
  byId("campaign-run-cancel-back").addEventListener("click", () => {
    if (cancelling || runOperation) return;
    runStaged = null;
    byId("campaign-run-confirm-summary").replaceChildren();
    controls();
    byId("campaign-run-cancel").focus();
  });
  byId("campaign-draft-preview-run").addEventListener("click", preview);
  byId("campaign-draft-archive").addEventListener("click", () => save(true));
  byId("campaign-draft-reload").addEventListener("click", () => editing && openDraft(editing.id));
  byId("campaign-draft-new").addEventListener("click", () => {
    if (
      !permitted ||
      loading ||
      reading ||
      saving ||
      operation ||
      approvalOperation ||
      approving ||
      runOperation ||
      cancelling ||
      !canDiscard()
    )
      return;
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
      // A same-workspace reload can bring a zone another admin stored; the preview's as_of text used the old one.
      const changed = timeZone !== zone;
      if (changed) clearPreview();
      permitted = allowed;
      workspace = workspaceId;
      timeZone = zone;
      if (changed) zoneChanged();
      controls();
      if (permitted) return load();
    },
    // A saved zone change: the preview's as_of, the snapshot option dates and the approval times used the old zone.
    // The draft list is not reloaded; the approval state is read again.
    timeZoneChanged(zone) {
      timeZone = zone;
      clearPreview();
      options();
      zoneChanged();
      controls();
    },
  };
}
