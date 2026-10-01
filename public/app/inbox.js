function createInbox({ api, node, getConnections, getRole, getUserId }) {
  const byId = (id) => document.getElementById(id);
  const states = new Map();
  let epoch = 0,
    listRequest = 0,
    selected = null,
    after = null,
    listBusy = false,
    assignees = [],
    expiryTimer;
  const reasons = {
    global_send_disabled: "전체 발송이 중지되어 있습니다.",
    connection_disabled: "이 계정의 수신·DM 보관·발송 설정을 확인해 주세요.",
    token_unavailable: "Instagram 계정을 다시 연결해 주세요.",
    connection_paused: "Instagram 요청 제한으로 잠시 발송을 기다립니다.",
    handoff_changed: "상담을 시작하면 자동화를 잠시 멈추고 직접 답장할 수 있습니다.",
    handoff_identity_unverified: "이 대화와 댓글 사용자의 연결을 확인할 수 없습니다.",
    handoff_conflict: "다른 요청으로 상담 상태가 바뀌었습니다. 새로고침해 주세요.",
    reply_window_closed: "최근 텍스트 DM으로 열린 답장 가능 시간이 끝났거나 확인되지 않습니다.",
    invalid_recipient: "이 사용자에게 답장을 보낼 수 없습니다.",
    reply_not_retryable: "안전하게 다시 예약할 수 없거나 이미 재예약한 메시지입니다.",
    reply_not_unresolved: "이미 검토를 마쳤거나 검토 대상이 아닌 메시지입니다.",
    idempotency_conflict: "접수 확인 요청이 일치하지 않습니다. 대화 이력을 확인해 주세요.",
    verification_unavailable: "발송 전 확인에 실패했습니다. 잠시 후 다시 검사합니다.",
    delivery_changed: "발송 전에 연결 상태가 바뀌어 메시지를 보내지 않았습니다.",
    conversation_conflict: "다른 요청으로 대화 상태나 담당자가 먼저 바뀌어 최신 상태를 다시 불러왔습니다.",
    assignee_unavailable: "작업 공간에서 제거되었거나 다른 작업 공간의 멤버에게는 배정할 수 없습니다.",
    role_forbidden: "상담원은 미배정 대화를 맡거나 자신의 담당만 해제할 수 있습니다.",
  };
  const failure = (code) => reasons[code] || "전송 조건을 확인하지 못했습니다. 상태를 새로고침해 주세요.";
  const date = (value) => new Date(value).toLocaleString("ko-KR");
  const base = (state) => `/api/connections/${state.row.connection_id}/inbox/${state.row.recipient_id}`;
  const current = (state, session) => epoch === session && selected === state;
  const expired = (state) => !state.deadline || performance.now() >= state.deadline;
  const isAdmin = () => ["owner", "admin"].includes(getRole());
  const person = (member) => (member.user_id === getUserId() ? "나" : member.email || "이메일 미기록 멤버");
  const summary = (convo) =>
    `${convo.status === "closed" ? "완료" : "진행 중"} · ${convo.assignee ? `담당 ${person(convo.assignee)}` : "미배정"}`;

  function conversationControls() {
    const state = selected;
    byId("inbox-conversation-controls").hidden = !state?.convo;
    if (!state?.convo) return;
    const convo = state.convo,
      mine = convo.assignee?.user_id === getUserId(),
      locked = state.loading || state.stateBusy;
    const changed = !convo.version
      ? ""
      : convo.updated_by
        ? ` · 마지막 변경 ${person(convo.updated_by)}, ${date(convo.updated_at)}`
        : ` · 새 DM으로 다시 열림, ${date(convo.updated_at)}`;
    byId("inbox-conversation-state").textContent = `${summary(convo)}${changed}`;
    const claim = byId("inbox-claim");
    claim.textContent = mine ? "담당 해제" : "내가 담당";
    claim.hidden = !mine && Boolean(convo.assignee) && !isAdmin();
    claim.disabled = locked;
    const close = byId("inbox-close");
    close.textContent = convo.status === "closed" ? "다시 열기" : "완료 처리";
    close.disabled = locked;
    byId("inbox-assign-label").hidden = !isAdmin();
    const select = byId("inbox-assign");
    if (isAdmin()) {
      const options = [new Option("미배정", "")];
      for (const member of assignees) options.push(new Option(person(member), member.user_id));
      if (convo.assignee && !assignees.some((member) => member.user_id === convo.assignee.user_id))
        options.push(new Option(person(convo.assignee), convo.assignee.user_id));
      select.replaceChildren(...options);
      select.value = convo.assignee?.user_id ?? "";
      select.disabled = locked;
    }
    byId("inbox-state-status").textContent = state.stateNotice || "";
  }

  async function changeConversation(change) {
    const state = selected;
    if (!state?.convo || state.stateBusy || state.loading) return;
    const session = epoch;
    state.stateBusy = true;
    state.stateNotice = "대화 상태를 바꾸고 있습니다…";
    conversationControls();
    try {
      state.convo = await api(
        `/api/inbox/conversations/${state.row.connection_id}/${state.row.recipient_id}/state`,
        "PUT",
        { expected_version: state.convo.version, ...change },
      ).finally(() => {
        // A conversation read that overlapped this write may hold the older state; loadConversation drops it.
        state.convoWrites++;
      });
      if (epoch !== session) return;
      state.stateNotice = "대화 상태를 변경했습니다.";
      void loadList();
    } catch (error) {
      if (epoch !== session) return;
      state.stateNotice =
        error.status >= 400 && error.status < 500
          ? failure(error.code)
          : "변경 여부를 확인하지 못했습니다. 대화를 새로고침해 현재 상태를 확인해 주세요.";
      // A conflict or refusal shows the state another member left, including who changed it.
      if (error.status === 409 || error.status === 403) void loadConversation();
    } finally {
      if (epoch === session) {
        state.stateBusy = false;
        if (selected === state) conversationControls();
      }
    }
  }

  function controls() {
    const state = selected;
    conversationControls();
    byId("inbox-composer").hidden = !state;
    byId("inbox-handoff-controls").hidden = !state;
    if (!state) return;
    const status = state.status,
      blocked = !status?.allowed || expired(state) || status.blocked_by_unknown;
    const textarea = byId("inbox-reply-text");
    if (textarea.value !== state.draft) textarea.value = state.draft;
    textarea.disabled = state.busy || Boolean(state.operation);
    byId("inbox-reply-count").textContent = `${state.draft.length} / 1,000`;
    byId("inbox-send").disabled =
      state.busy || state.loading || Boolean(state.operation) || blocked || !state.draft.trim();
    byId("inbox-send").textContent = state.busy && state.operation?.kind === "create" ? "접수 중…" : "답장 예약";
    byId("inbox-composer").setAttribute("aria-busy", String(state.busy));
    byId("inbox-reply-status").textContent =
      state.notice || (state.draft ? "작성 중 · 초안은 이 대화에 보관됩니다." : "문구를 작성한 뒤 답장을 예약하세요.");
    const check = byId("inbox-request-check");
    check.hidden = !state.operation || state.busy;
    check.textContent = "같은 요청의 접수 확인";
    check.disabled = state.busy;
    byId("inbox-eligibility").textContent = !status
      ? "답장 가능 상태를 확인해 주세요."
      : status.blocked_by_unknown
        ? "확인 필요 메시지가 있습니다. Instagram에서 결과를 확인하고 해결 기록을 남겨 주세요."
        : !status.allowed
          ? failure(status.failure_code)
          : expired(state)
            ? "답장 가능 시간이 끝났습니다. 새 DM을 받았다면 새로고침해 주세요."
            : `답장 가능 · ${date(status.window_expires_at)}까지 (서버 확인 기준)`;
    const handoff = byId("inbox-handoff");
    handoff.textContent = status?.handoff_active ? "자동화 재개" : "상담 시작";
    handoff.disabled =
      state.busy ||
      state.loading ||
      Boolean(state.operation) ||
      !status ||
      (!status.handoff_active && state.context?.mapping_status !== "verified");
    byId("inbox-handoff-state").textContent = status?.handoff_active
      ? "상담 중 · 이 사용자의 자동 답장은 중지됩니다. 상담 시작 전에 이미 발송 중이던 자동 답장은 취소되지 않습니다."
      : "자동화 상태 · 직접 답장하려면 상담을 시작하세요. 이미 발송 중인 자동 답장은 상담을 시작해도 취소되지 않습니다.";
    byId("inbox-thread-refresh").disabled = state.loading;
    byId("inbox-older").disabled = state.loading;
    byId("inbox-older").hidden = !state.beforeMessages && !state.beforeReplies;
    for (const button of byId("inbox-messages").querySelectorAll("button[data-mutation]"))
      button.disabled = state.busy || Boolean(state.operation) || (button.dataset.mutation === "retry" && blocked);
    for (const item of byId("inbox-messages").querySelectorAll("[data-reply-id]"))
      for (const input of item.querySelectorAll("textarea, input"))
        input.disabled = state.operation?.replyId === item.dataset.replyId;
  }

  function replyCard(state, reply) {
    const item = node("article", "", "inbox-message outgoing-message");
    item.dataset.replyId = reply.id;
    const labels = {
      pending: "예약됨",
      sending: "발송 중",
      sent: "발송 완료",
      failed: "발송 거부",
      unknown: "확인 필요",
    };
    const label =
      reply.status === "unknown" && reply.resolved_at
        ? "검토 완료 · 재전송 안 함"
        : labels[reply.status] || "상태 확인 필요";
    item.append(
      node("p", reply.text, "bubble outgoing"),
      node(
        "p",
        `${label} · ${date(reply.sent_at || reply.created_at)}`,
        `hint ${["failed", "unknown"].includes(reply.status) ? "reply-warning" : ""}`,
      ),
    );
    if (reply.failure_code) item.append(node("p", failure(reply.failure_code), "hint"));
    if (reply.status === "unknown" && !reply.resolved_at)
      item.append(
        node("p", "이미 도착했을 수 있어 다시 보내지 않습니다. Instagram 대화에서 결과를 확인해 주세요.", "hint"),
      );
    const retryable =
      reply.status === "failed" &&
      reply.safe_to_retry &&
      ![...state.replies.values()].some((r) => r.retry_of === reply.id);
    if (retryable || (reply.status === "unknown" && !reply.resolved_at)) {
      const kind = retryable ? "retry" : "resolution",
        action = node("form", "", "reply-decision");
      const inputId = `reason-${reply.id}`,
        input = node("textarea");
      input.id = inputId;
      input.required = true;
      input.maxLength = 500;
      input.rows = 2;
      input.value = state.notes.get(reply.id) || "";
      input.addEventListener("input", () => state.notes.set(reply.id, input.value));
      const title = node("label", retryable ? "다시 예약하는 사유" : "확인한 결과와 처리 사유");
      title.htmlFor = inputId;
      action.append(title, input);
      if (!retryable) {
        const label = node("label", "", "toggle");
        const check = node("input");
        check.type = "checkbox";
        check.required = true;
        label.append(check, node("span", "Instagram에서 결과를 확인했습니다. 재전송하지 않습니다."));
        action.append(label);
      }
      const button = node("button", retryable ? "안전하게 다시 예약" : "재전송하지 않고 검토 완료", "secondary");
      button.type = "submit";
      button.dataset.mutation = kind;
      action.append(button);
      action.addEventListener("submit", (event) => {
        event.preventDefault();
        if (selected !== state || state.busy || state.operation || !action.reportValidity() || !input.value.trim())
          return;
        if (retryable && (!state.status?.allowed || expired(state) || state.status.blocked_by_unknown)) return;
        const body = {
          request_key: crypto.randomUUID(),
          reason: input.value.trim(),
          ...(retryable ? { expected_handoff_version: state.status.handoff_version } : { decision: "no_retry" }),
        };
        void submitOperation(state, {
          kind,
          path: `${base(state)}/replies/${reply.id}/${kind}`,
          body,
          method: "POST",
          replyId: reply.id,
        });
      });
      item.append(action);
    }
    if (reply.events?.length) {
      const details = node("details", "", "reply-audit");
      details.append(node("summary", "처리 기록"));
      const titles = {
        queued: "예약 접수",
        retry_requested: "재예약 접수",
        sending: "발송 시작",
        sent: "발송 완료",
        failed: "미발송 실패",
        deferred: "검사 지연",
        unknown: "결과 확인 필요",
        no_retry: "재전송 없이 검토 완료",
      };
      for (const event of reply.events)
        details.append(
          node(
            "p",
            `${date(event.created_at)} · ${titles[event.kind] || "처리 기록"}${event.reason ? ` · ${event.reason}` : ""}`,
            "hint",
          ),
        );
      item.append(details);
    }
    return item;
  }

  function timeline(state) {
    const rows = [
      ...[...state.messages.values()].map((message) => ({ time: message.message_at, id: `m:${message.id}`, message })),
      ...[...state.replies.values()].map((reply) => ({ time: reply.created_at, id: `r:${reply.id}`, reply })),
    ].sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.id.localeCompare(b.id));
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      if (row.reply) {
        fragment.append(replyCard(state, row.reply));
        continue;
      }
      const item = node("article", "", "inbox-message incoming-message");
      item.append(
        node("p", row.message.text, "bubble incoming"),
        node("p", `${row.message.kind === "postback" ? "버튼 응답 · " : "수신 · "}${date(row.time)}`, "hint"),
      );
      fragment.append(item);
    }
    if (!rows.length) fragment.append(node("p", "보관한 메시지가 없습니다.", "hint"));
    byId("inbox-messages").replaceChildren(fragment);
  }

  async function loadConversation(older = false) {
    const state = selected;
    if (!state || (older && (state.loading || (!state.beforeMessages && !state.beforeReplies)))) return;
    const session = epoch,
      request = ++state.readRequest,
      writes = state.convoWrites;
    state.loading = true;
    byId("inbox-message-status").textContent = "대화와 발송 상태를 불러오고 있습니다…";
    controls();
    try {
      const [messages, replies, status, context] = await Promise.all([
        older && !state.beforeMessages
          ? { messages: [], before: null }
          : api(`${base(state)}${older ? `?before=${encodeURIComponent(state.beforeMessages)}` : ""}`),
        older && !state.beforeReplies
          ? { replies: [], before: null }
          : api(`${base(state)}/replies${older ? `?before=${encodeURIComponent(state.beforeReplies)}` : ""}`),
        api(`${base(state)}/reply-status`),
        api(`${base(state)}/context`),
      ]);
      if (!current(state, session) || request !== state.readRequest) return;
      if (!older) {
        state.messages.clear();
        state.replies.clear();
      }
      for (const row of messages.messages) state.messages.set(row.id, row);
      if (messages.state && writes === state.convoWrites) state.convo = messages.state;
      for (const row of replies.replies) state.replies.set(row.id, row);
      for (const id of state.notes.keys()) {
        const reply = state.replies.get(id);
        if (
          reply &&
          !(
            (reply.status === "unknown" && !reply.resolved_at) ||
            (reply.status === "failed" &&
              reply.safe_to_retry &&
              ![...state.replies.values()].some((row) => row.retry_of === id))
          )
        )
          state.notes.delete(id);
      }
      state.beforeMessages = messages.before;
      state.beforeReplies = replies.before;
      state.status = status;
      state.context = context;
      const remaining = Date.parse(status.window_expires_at) - Date.parse(status.checked_at);
      state.deadline = Number.isFinite(remaining) && remaining > 0 ? performance.now() + remaining : 0;
      clearTimeout(expiryTimer);
      if (remaining > 0)
        expiryTimer = setTimeout(
          () => {
            if (current(state, session)) controls();
          },
          Math.min(remaining + 10, 2147483647),
        );
      timeline(state);
      byId("inbox-message-status").textContent =
        "수신과 수동 답장 이력입니다. 새로고침으로 최신 발송 상태를 확인하세요.";
    } catch (error) {
      if (!current(state, session) || request !== state.readRequest) return;
      state.status = null;
      byId("inbox-message-status").textContent = `${error.message} 대화 새로고침으로 다시 확인해 주세요.`;
    } finally {
      if (current(state, session) && request === state.readRequest) {
        state.loading = false;
        controls();
      }
    }
  }

  async function submitOperation(state, operation) {
    if (state.busy || selected !== state) return;
    const session = epoch;
    state.operation = operation;
    state.busy = true;
    state.notice = "요청을 접수하고 있습니다…";
    controls();
    try {
      await api(operation.path, operation.method, operation.body);
      if (epoch !== session) return;
      state.operation = null;
      if (operation.kind === "create") state.draft = "";
      if (operation.replyId) state.notes.delete(operation.replyId);
      state.notice =
        operation.kind === "resolution"
          ? "검토 결과를 기록했습니다. 메시지는 다시 보내지 않습니다."
          : operation.kind === "handoff"
            ? "상담 상태를 변경했습니다."
            : "예약을 접수했습니다. 발송 완료는 이력에서 확인해 주세요.";
    } catch (error) {
      if (epoch !== session) return;
      if (error.status >= 400 && error.status < 500) {
        state.operation = null;
        state.notice = failure(error.code);
      } else
        state.notice = "요청의 접수 여부를 확인하지 못했습니다. 문구를 변경하지 않고 같은 요청의 접수를 확인해 주세요.";
    } finally {
      if (epoch === session) {
        state.busy = false;
        if (selected === state) {
          controls();
          if (!state.operation) await loadConversation();
        }
      }
    }
  }

  function choose(row) {
    clearTimeout(expiryTimer);
    const key = `${row.connection_id}:${row.recipient_id}`;
    if (!states.has(key))
      states.set(key, {
        row,
        draft: "",
        notes: new Map(),
        messages: new Map(),
        replies: new Map(),
        readRequest: 0,
        loading: false,
        busy: false,
        operation: null,
        convo: row.state,
        stateBusy: false,
        convoWrites: 0,
        stateNotice: "",
      });
    selected = states.get(key);
    byId("inbox-conversation-title").textContent = `@${row.username || "연결 계정"} · DM 사용자 ${row.recipient_id}`;
    byId("inbox-thread-refresh").hidden = false;
    for (const button of byId("inbox-conversations").children)
      button.setAttribute("aria-pressed", String(button.dataset.key === key));
    timeline(selected);
    controls();
    void loadConversation();
  }

  async function loadList(more = false) {
    if (more && (listBusy || !after)) return;
    const session = epoch,
      request = more ? listRequest : ++listRequest;
    if (!more) {
      byId("inbox-conversations").replaceChildren();
      after = null;
    }
    listBusy = true;
    byId("inbox-more").disabled = true;
    byId("inbox-status").textContent = "대화를 불러오고 있습니다…";
    const query = new URLSearchParams();
    if (byId("inbox-account").value) query.set("connection_id", byId("inbox-account").value);
    // 내 대화 and 미배정 show open conversations; 완료 shows closed ones of every assignee.
    const filter = byId("inbox-filter").value;
    if (filter === "mine") query.set("assignee", "me");
    if (filter === "unassigned") query.set("assignee", "none");
    if (filter) query.set("status", filter === "closed" ? "closed" : "open");
    if (more) query.set("after", after);
    try {
      const page = await api(`/api/inbox?${query}`);
      if (epoch !== session || request !== listRequest) return;
      for (const row of page.conversations) {
        const button = node(
          "button",
          `@${row.username || "연결 계정"}\nDM 사용자 ${row.recipient_id}\n${row.message_count}개 · ${date(row.last_message_at)}\n${summary(row.state)}`,
          "secondary",
        );
        button.dataset.key = `${row.connection_id}:${row.recipient_id}`;
        button.setAttribute(
          "aria-pressed",
          String(selected?.row.connection_id === row.connection_id && selected?.row.recipient_id === row.recipient_id),
        );
        button.addEventListener("click", () => choose(row));
        byId("inbox-conversations").append(button);
      }
      after = page.after;
      byId("inbox-status").textContent = byId("inbox-conversations").children.length
        ? "대화를 선택하세요. 초안은 대화마다 따로 보관됩니다."
        : byId("inbox-filter").value
          ? "이 보기에 해당하는 대화가 없습니다."
          : "보관한 DM이 없습니다. 계정에서 DM 보관을 켠 뒤 새 DM을 받아 주세요.";
    } catch (error) {
      if (epoch === session && request === listRequest) byId("inbox-status").textContent = error.message;
    } finally {
      if (epoch === session && request === listRequest) {
        listBusy = false;
        byId("inbox-more").disabled = false;
        byId("inbox-more").hidden = !after;
      }
    }
  }

  function reset() {
    epoch++;
    listRequest++;
    states.clear();
    selected = null;
    after = null;
    listBusy = false;
    assignees = [];
    clearTimeout(expiryTimer);
    byId("inbox-account").replaceChildren(new Option("모든 계정", ""));
    byId("inbox-filter").value = "";
    for (const id of ["inbox-conversations", "inbox-messages"]) byId(id).replaceChildren();
    for (const id of ["inbox-status", "inbox-message-status", "inbox-reply-status", "inbox-state-status"])
      byId(id).textContent = "";
    byId("inbox-reply-text").value = "";
    byId("inbox-conversation-title").textContent = "대화를 선택하세요";
    for (const id of ["inbox-more", "inbox-older", "inbox-thread-refresh"]) byId(id).hidden = true;
    controls();
  }
  byId("inbox-filter").addEventListener("change", () => void loadList());
  byId("inbox-claim").addEventListener("click", () => {
    if (!selected?.convo || byId("inbox-claim").disabled) return;
    const mine = selected.convo.assignee?.user_id === getUserId();
    void changeConversation({ assignee_user_id: mine ? null : getUserId() });
  });
  byId("inbox-close").addEventListener("click", () => {
    if (!selected?.convo || byId("inbox-close").disabled) return;
    void changeConversation({ status: selected.convo.status === "closed" ? "open" : "closed" });
  });
  byId("inbox-assign").addEventListener("change", (event) => {
    if (!selected?.convo) return;
    const value = event.target.value || null;
    if (value === (selected.convo.assignee?.user_id ?? null)) return;
    void changeConversation({ assignee_user_id: value });
  });
  byId("inbox-account").addEventListener("change", () => {
    selected = null;
    byId("inbox-messages").replaceChildren();
    byId("inbox-conversation-title").textContent = "대화를 선택하세요";
    byId("inbox-thread-refresh").hidden = true;
    clearTimeout(expiryTimer);
    controls();
    void loadList();
  });
  byId("inbox-refresh").addEventListener("click", () => {
    void loadList();
    if (selected) void loadConversation();
  });
  byId("inbox-more").addEventListener("click", () => void loadList(true));
  byId("inbox-older").addEventListener("click", () => void loadConversation(true));
  byId("inbox-thread-refresh").addEventListener("click", () => void loadConversation());
  byId("inbox-reply-text").addEventListener("input", (event) => {
    if (selected && !selected.operation && !selected.busy) {
      selected.draft = event.target.value;
      selected.notice = "";
      controls();
    }
  });
  byId("inbox-reply-text").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      if (!byId("inbox-send").disabled) byId("inbox-composer").requestSubmit();
    }
  });
  byId("inbox-composer").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!selected || byId("inbox-send").disabled || !event.currentTarget.reportValidity()) return;
    const state = selected;
    if (!state.status?.allowed || expired(state) || state.status.blocked_by_unknown) return;
    void submitOperation(state, {
      kind: "create",
      path: `${base(state)}/replies`,
      method: "POST",
      body: {
        request_key: crypto.randomUUID(),
        expected_handoff_version: state.status.handoff_version,
        text: state.draft,
      },
    });
  });
  byId("inbox-request-check").addEventListener("click", () => {
    if (selected?.operation) void submitOperation(selected, selected.operation);
  });
  byId("inbox-handoff").addEventListener("click", () => {
    if (!selected || byId("inbox-handoff").disabled) return;
    const state = selected;
    void submitOperation(state, {
      kind: "handoff",
      path: `${base(state)}/handoff`,
      method: "PUT",
      body: { active: !state.status.handoff_active, expected_version: state.status.handoff_version },
    });
  });
  reset();
  return {
    reset,
    // Drops drafts and the open conversation of a connection whose data was deleted, then reloads the list.
    forgetConnection(connectionId) {
      for (const key of states.keys()) if (key.startsWith(`${connectionId}:`)) states.delete(key);
      if (selected?.row.connection_id === connectionId) {
        selected = null;
        byId("inbox-messages").replaceChildren();
        byId("inbox-conversation-title").textContent = "대화를 선택하세요";
        byId("inbox-thread-refresh").hidden = true;
        clearTimeout(expiryTimer);
      }
      controls();
      void loadList();
    },
    loadList,
    loadConversation,
    hasDrafts: () =>
      [...states.values()].some((state) => state.draft || state.operation || [...state.notes.values()].some(Boolean)),
    initialize() {
      const select = byId("inbox-account"),
        previous = select.value;
      select.replaceChildren(new Option("모든 계정", ""));
      for (const account of getConnections())
        select.append(new Option(account.username || account.account_id, account.id));
      if (getConnections().some((account) => account.id === previous)) select.value = previous;
      void loadList();
      if (isAdmin()) {
        const session = epoch;
        api("/api/inbox/assignees")
          .then((result) => {
            if (epoch !== session) return;
            assignees = result.assignees;
            conversationControls();
          })
          .catch(() => undefined);
      }
    },
  };
}
