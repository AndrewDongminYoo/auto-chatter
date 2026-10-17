function createContactCsvPreview({ api, node, reloadContacts }) {
  const byId = (id) => document.getElementById(id);
  const section = byId("contacts-import");
  const form = byId("contacts-import-form");
  const input = byId("contacts-import-file");
  const button = byId("contacts-import-check");
  const status = byId("contacts-import-status");
  const list = byId("contacts-import-rows");
  const more = byId("contacts-import-more");
  const applyForm = byId("contacts-import-apply-form");
  const acknowledge = byId("contacts-import-acknowledge");
  const acknowledgeText = byId("contacts-import-acknowledge-text");
  const applyButton = byId("contacts-import-apply");
  const labels = {
    changed: "태그 변경 예상",
    unchanged: "변경 없음",
    invalid: "형식·범위·태그 오류",
    duplicate: "중복 연락처",
    not_found: "조회할 수 없는 연락처",
    applied: "태그 교체 완료",
  };
  const previewKeys = ["changed", "unchanged", "invalid", "duplicate", "not_found"];
  const detailKeys = ["changed", "unchanged", "applied"];
  let generation = 0,
    allowed = false,
    rows = [],
    shown = 0,
    held = null;
  let sessionChannel;
  try {
    sessionChannel = new BroadcastChannel("auto-chatter-session");
    sessionChannel.addEventListener("message", () => configure(undefined));
  } catch {
    // Preview is unavailable when the browser cannot receive cross-tab session changes.
  }
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) configure(undefined);
  });
  // Every invalidation also withdraws the apply offer and the held CSV, so an apply never follows a stale check.
  function invalidate(clearFile = false) {
    generation++;
    rows = [];
    shown = 0;
    held = null;
    list.replaceChildren();
    status.textContent = "";
    more.hidden = true;
    button.disabled = !allowed;
    button.removeAttribute("aria-busy");
    applyForm.hidden = true;
    acknowledge.checked = false;
    acknowledge.disabled = false;
    acknowledgeText.textContent = "";
    applyButton.disabled = true;
    applyButton.removeAttribute("aria-busy");
    if (clearFile) input.value = "";
  }
  function configure(role) {
    allowed = Boolean(sessionChannel) && (role === "owner" || role === "admin");
    invalidate(true);
    section.hidden = !allowed;
    input.disabled = !allowed;
    if (!allowed) section.open = false;
  }
  function showMore() {
    const next = rows.slice(shown, shown + 20);
    const tags = (value) => value.join(", ") || "태그 없음";
    for (const row of next) {
      const item = node("li", `${row.row}행 · ${labels[row.status]}`);
      if (detailKeys.includes(row.status)) {
        item.append(node("p", `계정 ${row.connection_id} · 참여자 ${row.sender_id}`, "hint"));
        item.append(
          node(
            "p",
            row.status === "applied"
              ? `이전: ${tags(row.current_tags)} → 현재: ${tags(row.proposed_tags)}`
              : `현재: ${tags(row.current_tags)} → 예상: ${tags(row.proposed_tags)}`,
            "hint",
          ),
        );
      }
      list.append(item);
    }
    shown += next.length;
    more.hidden = shown >= rows.length;
    more.textContent = `결과 더 보기 (${shown}/${rows.length}행)`;
  }
  const stringArray = (value) => Array.isArray(value) && value.every((tag) => typeof tag === "string");
  function isPreviewResult(result) {
    const counts = result?.counts;
    return Boolean(
      counts &&
      Array.isArray(result.rows) &&
      result.rows.length <= 500 &&
      counts.total === result.rows.length &&
      previewKeys.every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0) &&
      previewKeys.reduce((sum, key) => sum + counts[key], 0) === counts.total &&
      Number.isFinite(Date.parse(result.checked_at)) &&
      result.rows.every(
        (row, i) =>
          row.row === i + 1 &&
          previewKeys.includes(row.status) &&
          (!["changed", "unchanged"].includes(row.status) ||
            (typeof row.connection_id === "string" &&
              typeof row.sender_id === "string" &&
              stringArray(row.current_tags) &&
              stringArray(row.proposed_tags))),
      ) &&
      previewKeys.every((key) => result.rows.filter((row) => row.status === key).length === counts[key]),
    );
  }
  function isApplyResult(result) {
    const counts = result?.counts;
    const keys = ["applied", "unchanged"];
    return Boolean(
      counts &&
      Array.isArray(result.rows) &&
      result.rows.length <= 500 &&
      counts.total === result.rows.length &&
      keys.every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0) &&
      counts.applied + counts.unchanged === counts.total &&
      Number.isFinite(Date.parse(result.applied_at)) &&
      result.rows.every(
        (row, i) =>
          row.row === i + 1 &&
          keys.includes(row.status) &&
          typeof row.connection_id === "string" &&
          typeof row.sender_id === "string" &&
          stringArray(row.previous_tags) &&
          stringArray(row.tags),
      ) &&
      keys.every((key) => result.rows.filter((row) => row.status === key).length === counts[key]),
    );
  }
  function showPreview(result, lead) {
    const counts = result.counts;
    rows = result.rows;
    status.textContent =
      `${lead}전체 ${counts.total}행 · 변경 예상 ${counts.changed} · 변경 없음 ${counts.unchanged} · 오류 ${counts.invalid} · 중복 ${counts.duplicate} · 조회 불가 ${counts.not_found}. ` +
      `저장된 변경은 없습니다. 검사 시각: ${result.checked_at}.`;
    showMore();
  }
  // The apply is offered only for a clean check with changes; it sends the same CSV string and the checked rows.
  function offerApply(csv, result) {
    const counts = result.counts;
    if (!counts.changed || counts.invalid + counts.duplicate + counts.not_found) return;
    held = {
      csv,
      expected: result.rows
        .filter((row) => row.status === "changed")
        .map((row) => ({ row: row.row, current_tags: row.current_tags })),
    };
    acknowledgeText.textContent = `${counts.changed}행의 태그를 파일의 값으로 교체합니다. 다른 열과 동의·추가 정보·중지 상태는 바꾸지 않습니다.`;
    applyForm.hidden = false;
  }
  input.addEventListener("change", () => invalidate());
  more.addEventListener("click", showMore);
  acknowledge.addEventListener("change", () => {
    applyButton.disabled = !(held && acknowledge.checked);
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!allowed || button.disabled) return;
    invalidate();
    const request = generation;
    const file = input.files?.[0];
    if (!file) {
      status.textContent = "검사할 CSV 파일을 선택해 주세요.";
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    status.textContent = "파일과 기존 연락처를 확인하고 있습니다. 변경 사항은 저장하지 않습니다.";
    try {
      if (file.size > 128 * 1024) throw new Error("CSV 파일은 128KiB, 500행까지 검사할 수 있습니다.");
      const bytes = await file.arrayBuffer();
      if (request !== generation) return;
      let csv;
      try {
        csv = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new Error("UTF-8 CSV 파일을 선택해 주세요.");
      }
      const result = await api("/api/contacts/import-preview", "POST", { csv });
      if (request !== generation) return;
      if (!isPreviewResult(result)) throw new Error("CSV 검사 결과를 확인할 수 없습니다. 다시 검사해 주세요.");
      showPreview(result, "");
      offerApply(csv, result);
    } catch (error) {
      if (request === generation) status.textContent = error.message;
    } finally {
      if (request === generation) {
        button.disabled = !allowed;
        button.removeAttribute("aria-busy");
      }
    }
  });
  applyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!allowed || !held || !acknowledge.checked || applyButton.disabled) return;
    const request = generation;
    const { csv, expected } = held;
    applyButton.disabled = true;
    applyButton.setAttribute("aria-busy", "true");
    acknowledge.disabled = true;
    button.disabled = true;
    status.textContent = "검사한 행의 태그를 교체하고 있습니다…";
    try {
      const result = await api("/api/contacts/import", "POST", { csv, expected });
      if (request !== generation) return;
      if (!isApplyResult(result))
        throw new Error("태그 적용 결과를 확인할 수 없습니다. 연락처 목록에서 현재 태그를 확인해 주세요.");
      invalidate();
      rows = result.rows
        .filter((row) => row.status === "applied")
        .map((row) => ({
          row: row.row,
          status: "applied",
          connection_id: row.connection_id,
          sender_id: row.sender_id,
          current_tags: row.previous_tags,
          proposed_tags: row.tags,
        }));
      status.textContent = `태그 교체 완료 · 전체 ${result.counts.total}행 · 적용 ${result.counts.applied} · 변경 없음 ${result.counts.unchanged}. 적용 시각: ${result.applied_at}. 다시 적용하려면 파일을 다시 검사해 주세요.`;
      showMore();
      // The host skips the reload over an unsaved contact draft; say so, or the list below shows the old tags silently.
      if (reloadContacts && reloadContacts() === false)
        status.textContent +=
          " 편집 중인 연락처가 있어 목록은 새로 고치지 않았습니다. 편집을 마친 뒤 목록을 다시 불러오면 바뀐 태그가 보입니다.";
    } catch (error) {
      if (request !== generation) return;
      invalidate();
      // A rejected or stale file carries the server's fresh rows; nothing was written, and a new check is required.
      if (
        ["contact_import_rejected", "contact_import_stale"].includes(error.code) &&
        isPreviewResult({ counts: error.counts, rows: error.rows, checked_at: error.checked_at })
      )
        showPreview({ counts: error.counts, rows: error.rows, checked_at: error.checked_at }, `${error.message} `);
      else status.textContent = error.message;
    }
  });
  return {
    configure,
    reset: () => configure(undefined),
    invalidate: () => invalidate(true),
    sessionChanged() {
      configure(undefined);
      sessionChannel?.postMessage("changed");
    },
  };
}
