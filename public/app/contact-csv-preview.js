function createContactCsvPreview({ api, node }) {
  const byId = (id) => document.getElementById(id);
  const section = byId("contacts-import");
  const form = byId("contacts-import-form");
  const input = byId("contacts-import-file");
  const button = byId("contacts-import-check");
  const status = byId("contacts-import-status");
  const list = byId("contacts-import-rows");
  const more = byId("contacts-import-more");
  const labels = {
    changed: "태그 변경 예상",
    unchanged: "변경 없음",
    invalid: "형식·범위·태그 오류",
    duplicate: "중복 연락처",
    not_found: "조회할 수 없는 연락처",
  };
  let generation = 0,
    allowed = false,
    rows = [],
    shown = 0;
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
  function invalidate(clearFile = false) {
    generation++;
    rows = [];
    shown = 0;
    list.replaceChildren();
    status.textContent = "";
    more.hidden = true;
    button.disabled = !allowed;
    button.removeAttribute("aria-busy");
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
    for (const row of next) {
      const item = node("li", `${row.row}행 · ${labels[row.status]}`);
      if (row.status === "changed" || row.status === "unchanged") {
        item.append(node("p", `계정 ${row.connection_id} · 참여자 ${row.sender_id}`, "hint"));
        item.append(
          node(
            "p",
            `현재: ${row.current_tags.join(", ") || "태그 없음"} → 예상: ${row.proposed_tags.join(", ") || "태그 없음"}`,
            "hint",
          ),
        );
      }
      list.append(item);
    }
    shown += next.length;
    more.hidden = shown >= rows.length;
    more.textContent = `검사 결과 더 보기 (${shown}/${rows.length}행)`;
  }
  input.addEventListener("change", () => invalidate());
  more.addEventListener("click", showMore);
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
      const counts = result?.counts;
      const keys = Object.keys(labels);
      if (
        !counts ||
        !Array.isArray(result.rows) ||
        result.rows.length > 500 ||
        counts.total !== result.rows.length ||
        !keys.every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
        keys.reduce((sum, key) => sum + counts[key], 0) !== counts.total ||
        !Number.isFinite(Date.parse(result.checked_at)) ||
        !result.rows.every(
          (row, i) =>
            row.row === i + 1 &&
            keys.includes(row.status) &&
            (!["changed", "unchanged"].includes(row.status) ||
              (typeof row.connection_id === "string" &&
                typeof row.sender_id === "string" &&
                [row.current_tags, row.proposed_tags].every(
                  (tags) => Array.isArray(tags) && tags.every((tag) => typeof tag === "string"),
                ))),
        ) ||
        !keys.every((key) => result.rows.filter((row) => row.status === key).length === counts[key])
      )
        throw new Error("CSV 검사 결과를 확인할 수 없습니다. 다시 검사해 주세요.");
      rows = result.rows;
      status.textContent = `전체 ${counts.total}행 · 변경 예상 ${counts.changed} · 변경 없음 ${counts.unchanged} · 오류 ${counts.invalid} · 중복 ${counts.duplicate} · 조회 불가 ${counts.not_found}. 저장된 변경은 없습니다. 검사 시각: ${result.checked_at}.`;
      showMore();
    } catch (error) {
      if (request === generation) status.textContent = error.message;
    } finally {
      if (request === generation) {
        button.disabled = !allowed;
        button.removeAttribute("aria-busy");
      }
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
