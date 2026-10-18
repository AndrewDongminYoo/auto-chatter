// Frozen target lists of a saved segment (#35). Freezing records who matches now and sends nothing; the list, its
// member pages and its CSV show identifiers only. app.js calls sync() from segmentControls() with the selected saved
// segment and whether a freeze must wait (a segment request in flight or an unsaved edit of that segment).
function createSegmentSnapshots({ api, node, connectionLabel }) {
  const byId = (id) => document.getElementById(id);
  const section = byId("segment-snapshots");
  const create = byId("segment-snapshot-create");
  const status = byId("segment-snapshot-status");
  const list = byId("segment-snapshot-list");
  const detail = byId("segment-snapshot-detail");
  const summary = byId("segment-snapshot-summary");
  const members = byId("segment-snapshot-members");
  const more = byId("segment-snapshot-more");
  const download = byId("segment-snapshot-download");
  const messages = {
    snapshot_too_large: "필터에 맞는 연락처가 5,000명을 넘어 고정하지 않았습니다. 조건을 좁혀 다시 시도해 주세요.",
    snapshot_limit_reached: "작업 공간에 고정한 대상이 최대 200개라 더 고정할 수 없습니다.",
    snapshot_members_limit_reached:
      "작업 공간에 저장한 명단이 모두 합쳐 20,000명을 넘게 되어 고정하지 않았습니다. 데이터 내보내기를 계속 쓸 수 있도록 둔 한도입니다.",
    snapshot_not_found: "고정한 대상을 찾을 수 없습니다. 목록을 다시 불러와 주세요.",
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
  }
  function closeDetail() {
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
  }
  function sync(selected, mustWait) {
    blocked = mustWait;
    if ((selected?.id ?? "") !== (segment?.id ?? "")) {
      segment = selected;
      invalidate(segment ? "" : "저장된 필터를 고르면 그 필터로 고정한 대상을 볼 수 있습니다.");
      if (segment && permitted) void load();
      return;
    }
    // The same segment, possibly renamed by a saved edit.
    segment = selected;
    controls();
  }
  function render(snapshots) {
    list.replaceChildren(
      ...snapshots.map((snapshot) => {
        const item = node("li", "");
        item.append(
          node(
            "span",
            `${time(snapshot.as_of)} 기준 · 대상 ${count(snapshot.member_count)}명 · 검사한 연락처 ${count(snapshot.counts.evaluated)}명 `,
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
  async function load(message) {
    const current = generation;
    const id = segment.id;
    if (!message) status.textContent = "고정한 대상을 불러오고 있습니다…";
    try {
      const result = await api(`/api/contact-segments/${id}/snapshots`);
      if (current !== generation) return;
      render(result.snapshots);
      status.textContent =
        message ??
        (result.snapshots.length
          ? `이 필터로 고정한 대상 ${count(result.snapshots.length)}개. 고정한 명단은 바뀌지 않습니다.`
          : "이 필터로 고정한 대상이 아직 없습니다.");
    } catch (error) {
      if (current === generation) status.textContent = messages[error.code] || error.message;
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
      await load(
        `${time(saved.as_of)} 기준으로 ${count(saved.member_count)}명을 고정했습니다. 메시지는 보내지 않았으며, 발송할 때 수신 가능 여부를 다시 확인합니다.`,
      );
    } catch (error) {
      if (current === generation) status.textContent = messages[error.code] || error.message;
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
