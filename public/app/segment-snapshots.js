// Frozen target lists of a saved segment (#35). Freezing records who matches now and sends nothing; the list, its
// member pages and its CSV show identifiers only. app.js calls sync() from segmentControls() with the selected saved
// segment and whether a freeze must wait (a segment request in flight or an unsaved edit of that segment).
// With no saved segment selected, the list shows every snapshot of the workspace, archived segments' included, with
// the usage the freeze limits count (#233); archiving the selected segment clears the selection and so lands here.
function createSegmentSnapshots({ api, node, connectionLabel }) {
  const byId = (id) => document.getElementById(id);
  const section = byId("segment-snapshots");
  const create = byId("segment-snapshot-create");
  const status = byId("segment-snapshot-status");
  const usage = byId("segment-snapshot-usage");
  const list = byId("segment-snapshot-list");
  const detail = byId("segment-snapshot-detail");
  const summary = byId("segment-snapshot-summary");
  const members = byId("segment-snapshot-members");
  const more = byId("segment-snapshot-more");
  const download = byId("segment-snapshot-download");
  const compare = byId("segment-snapshot-compare");
  const comparison = byId("segment-snapshot-comparison");
  const messages = {
    snapshot_too_large: "필터에 맞는 연락처가 5,000명을 넘어 고정하지 않았습니다. 조건을 좁혀 다시 시도해 주세요.",
    snapshot_limit_reached:
      "작업 공간에 고정한 대상이 최대 200개라 더 고정할 수 없습니다. 고정한 명단은 데이터 내보내기에 함께 담기고 관리자도 지울 수 없어 둔 한도입니다. 고정한 대상은 작업 공간 데이터를 삭제할 때만 지워집니다.",
    snapshot_members_limit_reached:
      "작업 공간에 저장한 명단이 모두 합쳐 20,000행을 넘게 되어 고정하지 않았습니다. 고정한 명단은 데이터 내보내기에 함께 담기고 관리자도 지울 수 없어 둔 한도입니다. 저장한 명단은 계정·이용자·작업 공간 데이터를 삭제할 때만 지워집니다.",
    snapshot_not_found: "고정한 대상을 찾을 수 없습니다. 목록을 다시 불러와 주세요.",
    segment_not_found:
      "원래 필터가 보관되었거나 찾을 수 없어 비교하지 못했습니다. 고정한 명단과 CSV는 계속 볼 수 있습니다.",
    role_forbidden: "소유자와 관리자만 대상을 고정하고 볼 수 있습니다.",
  };
  let generation = 0;
  let permitted = false;
  let timeZone;
  let segment = null;
  let blocked = false;
  let busy = false;
  // The snapshot shown in the detail view and the cursor of its next member page.
  let opened = null;
  let after = null;
  // Only the latest "명단 보기" request may fill the detail view.
  let openRequest = 0;
  // Only the latest list request may fill the list, so a list read before a freeze never replaces the one read after it.
  let listRequest = 0;
  // Only the latest usage request may fill the usage line.
  let usageRequest = 0;
  let comparisonRequest = 0;
  let comparing = false;

  function time(value) {
    try {
      return new Date(value).toLocaleString("ko-KR", { timeZone });
    } catch {
      return `${value} (UTC)`;
    }
  }
  const count = (value) => Number(value).toLocaleString("ko-KR");
  function controls() {
    create.disabled = !permitted || !segment || blocked || busy;
    more.disabled = busy;
    download.disabled = !opened || busy;
    compare.disabled = !opened || busy || blocked || comparing;
  }
  function clearComparison() {
    comparisonRequest++;
    if (comparing) status.textContent = "";
    comparing = false;
    comparison.textContent = "";
    compare.removeAttribute("aria-busy");
  }
  function closeDetail() {
    clearComparison();
    opened = null;
    after = null;
    detail.hidden = true;
    summary.textContent = "";
    members.replaceChildren();
    more.hidden = true;
  }
  // Every response is checked against the generation it started in, so a late answer never shows on a changed screen.
  function invalidate(message = "") {
    generation++;
    busy = false;
    create.textContent = "대상 고정";
    create.removeAttribute("aria-busy");
    closeDetail();
    list.replaceChildren();
    usage.textContent = "";
    status.textContent = message;
    controls();
  }
  function reset() {
    permitted = false;
    timeZone = undefined;
    segment = null;
    blocked = false;
    section.hidden = true;
    invalidate();
  }
  function configure(role, zone) {
    reset();
    permitted = role === "owner" || role === "admin";
    timeZone = zone;
    section.hidden = !permitted;
    controls();
    // No segment is selected after a reset, and sync() loads only on a change, so the workspace list starts here.
    if (permitted) void load();
  }
  function sync(selected, mustWait) {
    if (mustWait || selected?.version !== segment?.version) clearComparison();
    blocked = mustWait;
    if ((selected?.id ?? "") !== (segment?.id ?? "")) {
      segment = selected;
      invalidate();
      if (permitted) void load();
      return;
    }
    // The same segment, possibly renamed by a saved edit.
    segment = selected;
    controls();
  }
  // The workspace list names each snapshot by the segment name stored in it and marks a segment archived now.
  function render(snapshots, workspaceWide) {
    list.replaceChildren(
      ...snapshots.map((snapshot) => {
        const item = node("li", "");
        const origin = workspaceWide
          ? `"${snapshot.segment_name}" 필터${snapshot.segment_archived ? " · 보관됨" : ""} · `
          : "";
        item.append(
          node(
            "span",
            `${origin}${time(snapshot.as_of)} 기준 · 대상 ${count(snapshot.member_count)}명 · 검사한 연락처 ${count(snapshot.counts.evaluated)}명 `,
          ),
        );
        const view = node("button", "명단 보기", "secondary");
        view.type = "button";
        view.addEventListener("click", () => void open(snapshot.id));
        item.append(view);
        return item;
      }),
    );
  }
  function showUsage(value) {
    usage.textContent = `고정한 대상 ${count(value.snapshots)}/${count(value.max_snapshots)}개 · 저장한 명단 ${count(value.stored_members)}/${count(value.max_stored_members)}행`;
  }
  // The usage line after a freeze attempt; the per-segment list carries no usage. A failure leaves the line empty.
  async function loadUsage() {
    const current = generation;
    const request = ++usageRequest;
    try {
      const result = await api("/api/segment-snapshots");
      if (current === generation && request === usageRequest) showUsage(result.usage);
    } catch {
      if (current === generation && request === usageRequest) usage.textContent = "";
    }
  }
  async function loadWorkspace(current, request) {
    const result = await api("/api/segment-snapshots");
    if (current !== generation || request !== listRequest) return;
    render(result.snapshots, true);
    usageRequest++;
    showUsage(result.usage);
    status.textContent = result.snapshots.length
      ? `작업 공간에 고정한 대상 ${count(result.snapshots.length)}개. 보관한 필터의 대상도 볼 수 있으며, 새로 고정하려면 저장된 필터를 고르세요.`
      : "작업 공간에 고정한 대상이 아직 없습니다. 저장된 필터를 고르면 그 필터에 지금 맞는 연락처를 고정할 수 있습니다.";
  }
  async function load(message) {
    const current = generation;
    const request = ++listRequest;
    const id = segment?.id;
    if (!message) status.textContent = "고정한 대상을 불러오고 있습니다…";
    try {
      if (!id) return await loadWorkspace(current, request);
      const result = await api(`/api/contact-segments/${id}/snapshots`);
      if (current !== generation || request !== listRequest) return;
      render(result.snapshots, false);
      status.textContent =
        message ??
        (result.snapshots.length
          ? `이 필터로 고정한 대상 ${count(result.snapshots.length)}개. 고정한 명단은 바뀌지 않습니다.`
          : "이 필터로 고정한 대상이 아직 없습니다.");
    } catch (error) {
      if (current === generation && request === listRequest) status.textContent = messages[error.code] || error.message;
    }
  }
  function appendMembers(page) {
    for (const member of page)
      members.append(node("li", `${connectionLabel(member.connection_id)} · 댓글 작성자 ${member.sender_id}`));
  }
  async function open(id) {
    if (busy) return;
    const current = generation;
    const request = ++openRequest;
    closeDetail();
    status.textContent = "명단을 불러오고 있습니다…";
    try {
      const result = await api(`/api/segment-snapshots/${id}`);
      if (current !== generation || request !== openRequest) return;
      const { snapshot } = result;
      opened = snapshot;
      after = result.after;
      const removed = snapshot.member_count - snapshot.stored_member_count;
      summary.textContent =
        `${time(snapshot.as_of)} 기준 "${snapshot.segment_name}" 필터에 맞은 ${count(snapshot.member_count)}명을 고정했습니다. ` +
        (removed > 0
          ? `계정이나 이용자 데이터 삭제로 ${count(removed)}명이 명단에서 빠져 ${count(snapshot.stored_member_count)}명이 남았습니다. 기록한 인원 수는 바꾸지 않습니다.`
          : `명단에 ${count(snapshot.stored_member_count)}명이 있습니다.`);
      appendMembers(result.members);
      more.hidden = !after;
      detail.hidden = false;
      status.textContent = "";
      controls();
    } catch (error) {
      if (current === generation && request === openRequest) status.textContent = messages[error.code] || error.message;
    }
  }
  compare.addEventListener("click", async () => {
    if (compare.disabled || !opened) return;
    clearComparison();
    const current = generation;
    const id = opened.id;
    const request = comparisonRequest;
    comparing = true;
    compare.setAttribute("aria-busy", "true");
    controls();
    status.textContent = "현재 저장된 필터와 비교하고 있습니다…";
    try {
      const result = await api(`/api/segment-snapshots/${id}/comparison`);
      if (current !== generation || opened?.id !== id || request !== comparisonRequest) return;
      const counts = result.counts;
      comparison.textContent =
        `${time(result.snapshot_as_of)} 고정 당시 버전 ${result.snapshot_segment_version} · 원래 ${count(counts.original)}명, 남은 기준 명단 ${count(counts.baseline)}명. ` +
        `${time(result.compared_at)} 현재 저장된 필터 버전 ${result.segment_version} · 현재 대상 ${count(counts.current)}명. ` +
        `추가 ${count(counts.added)}명 · 제외 ${count(counts.removed)}명 · 유지 ${count(counts.retained)}명. ` +
        (result.snapshot_segment_version !== result.segment_version
          ? "필터 버전이 달라 비교에는 필터 수정의 영향도 포함될 수 있습니다. "
          : "") +
        "삭제 후 남은 명단과 현재 저장된 필터를 비교한 결과입니다. 발송 가능한 인원 수가 아닙니다.";
      status.textContent = "";
    } catch (error) {
      if (current === generation && opened?.id === id && request === comparisonRequest)
        status.textContent = messages[error.code] || error.message;
    } finally {
      if (current === generation && request === comparisonRequest) {
        comparing = false;
        compare.removeAttribute("aria-busy");
        controls();
      }
    }
  });
  create.addEventListener("click", async () => {
    if (create.disabled || !segment) return;
    const current = generation;
    const target = segment;
    busy = true;
    openRequest++;
    closeDetail();
    controls();
    create.textContent = "고정하는 중…";
    create.setAttribute("aria-busy", "true");
    status.textContent = `저장된 "${target.name}" 필터에 지금 맞는 연락처를 고정하고 있습니다…`;
    try {
      const saved = await api(`/api/contact-segments/${target.id}/snapshots`, "POST");
      if (current !== generation) return;
      await Promise.all([
        load(
          `${time(saved.as_of)} 기준으로 ${count(saved.member_count)}명을 고정했습니다. 메시지는 보내지 않았으며, 발송할 때 수신 가능 여부를 다시 확인합니다.`,
        ),
        loadUsage(),
      ]);
    } catch (error) {
      if (current !== generation) return;
      status.textContent = messages[error.code] || error.message;
      // A refused freeze shows how much of each limit is in use.
      if (error.code === "snapshot_limit_reached" || error.code === "snapshot_members_limit_reached") await loadUsage();
    } finally {
      if (current === generation) {
        busy = false;
        create.textContent = "대상 고정";
        create.removeAttribute("aria-busy");
        controls();
      }
    }
  });
  more.addEventListener("click", async () => {
    if (!opened || !after || busy) return;
    const current = generation;
    const id = opened.id;
    busy = true;
    controls();
    try {
      const result = await api(`/api/segment-snapshots/${id}?${new URLSearchParams({ after })}`);
      if (current !== generation || opened?.id !== id) return;
      after = result.after;
      appendMembers(result.members);
      more.hidden = !after;
    } catch (error) {
      if (current === generation) status.textContent = messages[error.code] || error.message;
    } finally {
      if (current === generation) {
        busy = false;
        controls();
      }
    }
  });
  // The same download as the contact CSV: the server's text with exactly one UTF-8 BOM.
  download.addEventListener("click", async () => {
    if (!opened || busy) return;
    const current = generation;
    const snapshot = opened;
    busy = true;
    controls();
    status.textContent = "명단 CSV를 만들고 있습니다…";
    try {
      const text = await api(`/api/segment-snapshots/${snapshot.id}/members.csv`, "GET", undefined, true, true);
      if (current !== generation) return;
      const url = URL.createObjectURL(new Blob(["﻿" + text.replace(/^﻿/, "")], { type: "text/csv;charset=utf-8" }));
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `auto-chatter-segment-snapshot-${snapshot.id}-${snapshot.as_of.slice(0, 10)}.csv`;
        link.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      status.textContent = "명단 CSV를 저장했습니다. 식별자만 들어 있지만 안전하게 보관하세요.";
    } catch (error) {
      if (current === generation) status.textContent = messages[error.code] || error.message;
    } finally {
      if (current === generation) {
        busy = false;
        controls();
      }
    }
  });
  return { configure, reset, sync };
}
