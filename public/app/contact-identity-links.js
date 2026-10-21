// This confirmation never changes provider identity evidence, consent or delivery eligibility.
function createContactIdentityLinks({ api, node, contact, isCurrent }) {
  const section = node("section", "", "contact-identity-links");
  const status = node("p", "", "hint");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const list = node("div");
  const refresh = node("button", "연결 상태 새로고침", "secondary");
  const more = node("button", "다음 연결 보기", "secondary");
  refresh.type = more.type = "button";
  more.hidden = true;
  const controls = node("div", "", "contact-detail-controls");
  controls.append(refresh, more);
  section.append(
    node("h4", "운영자가 확인한 식별자 연결"),
    node(
      "p",
      "확인과 해제는 운영자의 기록만 바꿉니다. 기존 대화·공급자 연결 근거·수신 거부는 유지되며, 동의나 발송 권한을 부여하지 않습니다.",
      "hint",
    ),
    status,
    controls,
    list,
  );
  const base = `/api/connections/${contact.connection_id}/contacts/${encodeURIComponent(contact.sender_id)}/identity-links`;
  let requestId = 0;
  let after = null;
  let busy = false;
  async function load(cursor = null, message = "") {
    const id = ++requestId;
    const current = () => id === requestId && isCurrent();
    after = null;
    list.replaceChildren();
    refresh.disabled = true;
    more.hidden = true;
    status.textContent = "연결 상태를 불러오고 있습니다…";
    try {
      const result = await api(base + (cursor ? `?after=${encodeURIComponent(cursor)}` : ""));
      if (!current()) return;
      for (const link of result.links) {
        const row = node("article", "", "contact-detail-conversation");
        const state =
          link.state === "confirmed"
            ? "운영자 확인됨"
            : link.state === "detached"
              ? "운영자 확인 해제됨"
              : "운영자 확인 없음";
        row.append(
          node("h5", `DM 상대 ${link.recipient_id}`),
          node("p", state),
          node(
            "p",
            link.current_evidence_reply_id
              ? `현재 공급자 근거 ${link.current_evidence_reply_id}`
              : "현재 유효한 공급자 근거 없음",
            "hint",
          ),
        );
        if (link.state === "confirmed" && !link.evidence_valid)
          row.append(
            node("p", "확인 당시의 근거가 달라졌거나 유효하지 않습니다. 과거 확인 기록으로만 표시합니다.", "hint"),
          );
        if (link.blocked) row.append(node("p", "다른 댓글 연락처의 확인을 먼저 해제해야 합니다.", "hint"));
        const buttons = [];
        function actionButton(action, label) {
          const button = node("button", label, "secondary");
          button.type = "button";
          // Keep this body after an uncertain failure: a retry cannot create another event.
          let body;
          button.addEventListener("click", async () => {
            if (busy || !current()) return;
            const explanation =
              action === "confirm"
                ? "이 두 식별자의 연결을 확인하시겠습니까? 수신 동의나 발송 권한은 바뀌지 않습니다."
                : "운영자의 확인을 해제하시겠습니까? 기존 대화·공급자 근거·수신 거부는 유지됩니다.";
            if (
              !confirm(
                `연결 ${contact.connection_id}\n댓글 ${contact.sender_id} · DM ${link.recipient_id}\n${explanation}`,
              )
            )
              return;
            body ??= {
              action,
              request_key: crypto.randomUUID(),
              expected_version: link.version,
              ...(action === "confirm" ? { evidence_reply_id: link.current_evidence_reply_id } : {}),
            };
            busy = true;
            refresh.disabled = more.disabled = true;
            buttons.forEach((item) => {
              item.disabled = true;
            });
            status.textContent = "확인 기록을 저장하고 있습니다…";
            try {
              await api(`${base}/${encodeURIComponent(link.recipient_id)}`, "POST", body);
              if (!current()) return;
              await load(
                null,
                action === "confirm"
                  ? "연결 확인을 기록했습니다."
                  : "운영자 확인을 해제했습니다. 기존 공급자 근거는 유지됩니다.",
              );
            } catch (error) {
              if (!current()) return;
              if (error.status === 409) {
                await load(null, "연결 상태나 근거가 변경됐습니다. 최신 내용을 확인한 뒤 다시 선택해 주세요.");
              } else {
                status.textContent = error.message || "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
                if ([400, 403, 404].includes(error.status)) {
                  body = undefined;
                  list.replaceChildren();
                }
              }
            } finally {
              busy = false;
              if (isCurrent()) {
                refresh.disabled = more.disabled = false;
                buttons.forEach((item) => {
                  item.disabled = false;
                });
              }
            }
          });
          buttons.push(button);
          row.append(button);
        }
        if (result.can_edit === true) {
          if (link.current_evidence_reply_id && !link.evidence_valid && !link.blocked)
            actionButton("confirm", "연결 확인");
          if (link.state === "confirmed") actionButton("detach", "확인 해제");
        }
        list.append(row);
      }
      if (!result.links.length) list.append(node("p", "확인할 공급자 근거나 저장된 확인 기록이 없습니다.", "hint"));
      after = result.after;
      more.hidden = !after;
      status.textContent = message || `연결 ${result.links.length}개를 표시합니다.`;
    } catch (error) {
      if (current()) status.textContent = error.message || "연결 상태를 불러오지 못했습니다.";
    } finally {
      if (current()) refresh.disabled = false;
    }
  }
  refresh.addEventListener("click", () => {
    if (!busy) return load();
  });
  more.addEventListener("click", () => {
    if (!busy && after) return load(after);
  });
  void load();
  return section;
}
