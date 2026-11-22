// This confirmation never changes provider identity evidence, consent or delivery eligibility.
// `footers` maps a DM recipient to the footer of that recipient's conversation card; the link state and action go
// there. A link whose recipient has no card gets a card of the same shape, without metrics, in this section's list.
// `record` is the "기록 세부" list that receives each link's current reply evidence ID. The conversation pages and the
// link pages advance separately, so `conversationsPaged` tells a card-less link that its conversation may be on
// another page, and a card whose recipient is not on the loaded link page says so instead of keeping a stale state.
// `canStart` lets the page refuse a write while another contact save runs, and `onBusy` reports a write from its start
// until its reload ends, so the page can keep the selection on this contact until then.
function createContactIdentityLinks({ api, node, contact, isCurrent, footers = new Map(), record = null, conversationsPaged = false, canStart = () => true, onBusy = (_busy) => {} }) {
  const section = node("section", "", "contact-identity-links");
  const status = node("p", "", "hint");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const list = node("div", "", "contact-dm-cards");
  // The page's one detail refresh rebuilds this section, so the section keeps only its page control.
  const more = node("button", "다음 연결 보기", "secondary");
  more.type = "button";
  more.hidden = true;
  const controls = node("div", "", "contact-detail-controls");
  controls.append(more);
  section.append(list, status, controls);
  const base = `/api/connections/${contact.connection_id}/contacts/${encodeURIComponent(contact.sender_id)}/identity-links`;
  let requestId = 0;
  let after = null;
  let busy = false;
  // Every footer is emptied before each load, so a reload after a confirm, a detach or a conflict never stacks rows.
  function clearRows() {
    list.replaceChildren();
    record?.replaceChildren();
    for (const footer of footers.values()) footer.replaceChildren(node("span", "연결 상태 확인 전", "hint"));
  }
  function evidence(term, value) {
    if (!record) return;
    const entry = node("div");
    entry.append(node("dt", term), node("dd", value));
    record.append(entry);
  }
  async function load(cursor = null, message = "") {
    const id = ++requestId;
    const current = () => id === requestId && isCurrent();
    after = null;
    clearRows();
    more.hidden = true;
    status.textContent = "연결 상태를 불러오고 있습니다…";
    try {
      const result = await api(base + (cursor ? `?after=${encodeURIComponent(cursor)}` : ""));
      if (!current()) return;
      const shown = new Set();
      for (const link of result.links) {
        shown.add(link.recipient_id);
        let footer = footers.get(link.recipient_id);
        if (!footer) {
          const card = node("article", "", "contact-dm-card");
          footer = node("div", "", "contact-link-row");
          card.append(node("h5", `DM 상대 ${formatText(link.recipient_id)}`, "contact-dm-name"), node("p", conversationsPaged ? "다른 대화 페이지에 있거나 현재 조회에서 표시할 대화가 없습니다." : "현재 조회에서 표시할 대화가 없습니다.", "hint"), footer);
          list.append(card);
        }
        evidence(`DM 상대 ${formatText(link.recipient_id)} 연결`, link.current_evidence_reply_id ? `이 사람에게 보낸 답장 기록 ${formatText(link.current_evidence_reply_id)}` : "지금 확인된 답장 기록 없음");
        const confirmed = link.state === "confirmed";
        // A confirmation whose evidence is no longer valid is shown only as a past confirmation, not as a current link.
        const valid = confirmed && link.evidence_valid;
        const state = valid ? "확인됨" : confirmed ? "이전 확인" : link.state === "detached" ? "확인 해제됨" : "확인 없음";
        const label = node("span", "", "contact-link-state");
        label.append(node("b", "연결"), node("span", state, valid ? "badge status" : "badge status off"));
        footer.replaceChildren(label);
        if (!link.current_evidence_reply_id) footer.append(node("p", "지금 확인된 답장 기록이 없습니다.", "hint"));
        if (confirmed && !link.evidence_valid) footer.append(node("p", "확인할 때의 답장 기록이 바뀌었거나 더 이상 유효하지 않습니다. 이전 확인 기록으로만 표시합니다.", "hint"));
        if (link.blocked) footer.append(node("p", "이 DM 상대는 다른 댓글 연락처와 확인되어 있습니다. 그 확인을 먼저 해제해야 합니다.", "hint"));
        const buttons = [];
        function actionButton(action, label) {
          const button = node("button", label, "secondary");
          button.type = "button";
          // Keep this body after an uncertain failure: a retry cannot create another event.
          let body;
          button.addEventListener("click", async () => {
            if (busy || !current() || !canStart()) return;
            const explanation = action === "confirm" ? "이 두 식별자를 같은 사람으로 확인하시겠습니까? 수신 동의나 발송 권한은 바뀌지 않습니다." : "확인을 해제하시겠습니까? 기존 대화, 답장 기록, 수신 거부는 그대로 남습니다.";
            if (!confirm(`연결 ${formatText(contact.connection_id)}\n댓글 ${formatText(contact.sender_id)} · DM ${formatText(link.recipient_id)}\n${explanation}`)) return;
            body ??= {
              action,
              request_key: crypto.randomUUID(),
              expected_version: link.version,
              ...(action === "confirm" ? { evidence_reply_id: link.current_evidence_reply_id } : {}),
            };
            busy = true;
            onBusy(true);
            more.disabled = true;
            buttons.forEach((item) => {
              item.disabled = true;
            });
            status.textContent = "확인 기록을 저장하고 있습니다…";
            try {
              await api(`${base}/${encodeURIComponent(link.recipient_id)}`, "POST", body);
              if (!current()) return;
              await load(null, action === "confirm" ? "연결 확인을 기록했습니다." : "확인을 해제했습니다. 이 사람에게 보낸 답장 기록은 그대로 남습니다.");
            } catch (error) {
              if (!current()) return;
              if (error.status === 409) {
                await load(null, "연결 상태나 답장 기록이 변경되었습니다. 최신 내용을 확인한 뒤 다시 선택해 주세요.");
              } else {
                status.textContent = errorMessage(error);
                if ([400, 403, 404].includes(error.status)) {
                  body = undefined;
                  clearRows();
                }
              }
            } finally {
              busy = false;
              onBusy(false);
              if (isCurrent()) {
                more.disabled = false;
                buttons.forEach((item) => {
                  item.disabled = false;
                });
              }
            }
          });
          buttons.push(button);
          footer.append(button);
        }
        if (result.can_edit === true) {
          if (link.current_evidence_reply_id && !link.evidence_valid && !link.blocked) actionButton("confirm", "연결 확인");
          if (confirmed) actionButton("detach", "확인 해제");
        }
      }
      const paged = Boolean(cursor || result.after);
      for (const [recipient, footer] of footers) {
        if (!shown.has(recipient)) footer.replaceChildren(node("span", paged ? "이 연결 페이지에는 없습니다." : "연결 기록 없음", "hint"));
      }
      after = result.after;
      more.hidden = !after;
      // The cards and footers already show each state, so the line speaks only for a write result.
      status.textContent = message;
    } catch (error) {
      if (current()) status.textContent = errorMessage(error);
    }
  }
  more.addEventListener("click", () => {
    if (!busy && after) return load(after);
  });
  // For callers and tests that re-read in place; the detail page rebuilds the section instead.
  section.reload = () => (busy ? undefined : load());
  void load();
  return section;
}
