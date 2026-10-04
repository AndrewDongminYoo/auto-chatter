function createInbox({ api, node, getConnections, getRole, getUserId, getTimeZone }) {
  const byId = (id) => document.getElementById(id);
  const states = new Map();
  // Listed conversation buttons by key, so a read mark can update its unread badge without reloading the list.
  const listed = new Map();
  let epoch = 0,
    searchText = "",
    listRequest = 0,
    selected = null,
    after = null,
    listBusy = false,
    assignees = [],
    // The workspace's inbox labels, archived ones included, as GET /api/inbox/labels lists them.
    labels = [],
    labelsRequest = 0,
    labelsBusy = false,
    // Counts applied read marks, so a list response can tell which marks landed after its request started.
    readSeq = 0,
    expiryTimer,
    // The reminder filter (reminder=due), the caller's due reminder count from the last list load, the server time
    // that count was taken at, and the server clock minus the local one at that load, so due states can be
    // re-rendered without asking the server.
    reminderFilter = false,
    dueCount = 0,
    dueCheckedAt = 0,
    clockOffset = 0,
    reminderTimer,
    // Counts workspace time zone changes saved in this tab. A reminder returned by a write that started before a
    // change holds due_local in the old zone, so the write's response is replaced by a conversation read.
    zoneChanges = 0;
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
  const filtered = () =>
    Boolean(
      searchText ||
      byId("inbox-status-filter").value ||
      byId("inbox-assignee-filter").value ||
      byId("inbox-label-filter").value ||
      byId("inbox-unread").checked ||
      reminderFilter,
    );
  const conversationPath = (state) => `/api/inbox/conversations/${state.row.connection_id}/${state.row.recipient_id}`;
  const labelText = (label) => (label.archived ? `${label.name} (보관됨)` : label.name);
  const serverNow = () => Date.now() + clockOffset;
  const isDue = (reminder) => serverNow() >= Date.parse(reminder.due_at);
  // A stored "YYYY-MM-DDTHH:MM" wall-clock value as Korean text, with the year only when it is not this year.
  const reminderLabel = (local) => {
    const [day, time] = local.split("T");
    const [year, month, date] = day.split("-");
    const prefix = year === String(new Date(serverNow()).getFullYear()) ? "" : `${year}년 `;
    return `${prefix}${Number(month)}월 ${Number(date)}일 ${time}`;
  };
  const reminderZone = () => selected?.reminder?.time_zone || getTimeZone() || "Asia/Seoul";
  // An instant as the "YYYY-MM-DDTHH:MM" a datetime-local input takes, in the workspace time zone.
  function wallClock(ms, zone) {
    let format;
    try {
      format = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      return "";
    }
    const part = Object.fromEntries(format.formatToParts(new Date(ms)).map((item) => [item.type, item.value]));
    return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}`;
  }
  // The earliest due time the picker offers: one minute ahead, lowered by a backward clock shift (a daylight-saving
  // end) within the next three hours, because PostgreSQL reads a repeated wall-clock time as the later instant, which
  // can still be ahead. The server checks the real instant against the 1-minute bound.
  function earliestDue(zone) {
    const start = serverNow() + 60000;
    const offset = (ms) => Date.parse(`${wallClock(ms, zone)}Z`) - Math.floor(ms / 60000) * 60000;
    return wallClock(start - Math.max(0, offset(start) - offset(start + 3 * 3600000)), zone);
  }
  // A new reminder starts an hour ahead, rounded up to ten minutes.
  const defaultDue = (zone) => wallClock(Math.ceil((serverNow() + 3600000) / 600000) * 600000, zone);
  const sameIds = (ids, set) => ids.size === set.size && [...ids].every((id) => set.has(id));

  function rowContent(button, row) {
    const head = node("span", "", "conversation-head");
    head.append(node("span", `@${row.username || "연결 계정"}`));
    if (row.unread_count > 0) head.append(node("span", `안 읽음 ${row.unread_count}`, "unread-badge"));
    button.replaceChildren(
      head,
      node("span", `DM 사용자 ${row.recipient_id}`, "conversation-line"),
      node("span", `${row.message_count}개 · ${date(row.last_message_at)}`, "conversation-line"),
      node("span", summary(row.state), "conversation-line"),
    );
    const chips = node("span", "", "label-chips");
    if (row.reminder) {
      const due = isDue(row.reminder);
      button.dataset.reminderDue = String(due);
      chips.append(
        node(
          "span",
          `${due ? "리마인더 기한" : "리마인더"} · ${reminderLabel(row.reminder.due_local)}`,
          `reminder-chip${due ? " due" : ""}`,
        ),
      );
    } else delete button.dataset.reminderDue;
    for (const label of row.label_set?.labels ?? [])
      chips.append(node("span", labelText(label), `label-chip${label.archived ? " archived" : ""}`));
    if (chips.children.length) button.append(chips);
  }

  function labelFilterOptions() {
    const select = byId("inbox-label-filter"),
      previous = select.value;
    const options = [new Option("전체", "")];
    for (const label of labels) options.push(new Option(labelText(label), label.id));
    select.replaceChildren(...options);
    select.value = options.some((option) => option.value === previous) ? previous : "";
  }

  // Several loads can overlap in one session (the first load, a refresh, a label change), so only the latest applies.
  async function loadLabels() {
    const session = epoch,
      request = ++labelsRequest;
    try {
      const result = await api("/api/inbox/labels");
      if (epoch !== session || request !== labelsRequest) return;
      labels = result.labels;
      labelFilterOptions();
      labelControls();
      labelAdmin();
    } catch (error) {
      if (epoch === session && request === labelsRequest) byId("inbox-labels-status").textContent = error.message;
    }
  }

  // The labels a conversation shows in its editor: the ones it has (archived ones too, so they can stay or be
  // removed) and every active label it could add. The workspace list is newer than a loaded set for a rename.
  function labelChoices(state) {
    const options = new Map(state.labelSet.labels.map((label) => [label.id, label]));
    for (const label of labels) if (!label.archived || options.has(label.id)) options.set(label.id, label);
    return [...options.values()].sort((a, b) => a.name.localeCompare(b.name, "ko") || a.id.localeCompare(b.id));
  }
  const labelChosen = (state) => state.labelDraft ?? new Set(state.labelSet.labels.map((label) => label.id));

  function labelControls() {
    const state = selected,
      form = byId("inbox-label-editor");
    form.hidden = !state;
    if (!state) return;
    const choices = labelChoices(state),
      chosen = labelChosen(state),
      attached = new Set(state.labelSet.labels.map((label) => label.id));
    const container = byId("inbox-label-options");
    const key = `${conversationKey(state)}|${choices.map((label) => `${label.id}:${label.name}:${label.archived}`).join("|")}`;
    // Rebuilt only when the choices change, so a checkbox keeps keyboard focus while the rest re-renders.
    if (container.dataset.key !== key) {
      const focused = document.activeElement?.dataset?.labelId;
      container.dataset.key = key;
      container.replaceChildren(
        ...choices.map((label) => {
          const item = node("label", "", "toggle label-option");
          const input = node("input");
          input.type = "checkbox";
          input.value = label.id;
          input.dataset.labelId = label.id;
          input.addEventListener("change", () => toggleLabel(label.id, input.checked));
          item.append(input, node("span", labelText(label)));
          return item;
        }),
      );
      if (!choices.length)
        container.append(
          node(
            "p",
            isAdmin()
              ? "아직 라벨이 없습니다. 인박스 라벨 설정에서 추가해 주세요."
              : "아직 라벨이 없습니다. 관리자에게 라벨 추가를 요청해 주세요.",
            "hint",
          ),
        );
      if (focused) container.querySelector(`[data-label-id="${focused}"]`)?.focus();
    }
    for (const input of container.querySelectorAll("input")) {
      input.checked = chosen.has(input.value);
      // Ten is the most a conversation holds.
      input.disabled = state.labelBusy || (!input.checked && chosen.size >= 10);
    }
    const dirty = !sameIds(chosen, attached);
    const save = byId("inbox-label-save");
    save.disabled = state.labelBusy || !dirty;
    save.textContent = state.labelBusy ? "저장 중…" : "라벨 저장";
    byId("inbox-label-status").textContent =
      state.labelNotice || (dirty ? `저장하지 않은 변경 · ${chosen.size} / 10` : `${chosen.size} / 10`);
  }

  function toggleLabel(id, checked) {
    const state = selected;
    if (!state || state.labelBusy) return;
    const next = new Set(labelChosen(state));
    if (checked) next.add(id);
    else next.delete(id);
    // A draft keeps the version it was built on: a later conversation read can replace labelSet, and saving the
    // draft against that newer version would silently undo another member's change instead of answering 409.
    if (!state.labelDraft) state.labelBase = state.labelSet.version;
    state.labelDraft = sameIds(next, new Set(state.labelSet.labels.map((label) => label.id))) ? null : next;
    state.labelNotice = "";
    labelControls();
  }

  function showLabelSet(state, labelSet) {
    state.labelSet = labelSet;
    if (state.labelDraft && sameIds(state.labelDraft, new Set(labelSet.labels.map((label) => label.id))))
      state.labelDraft = null;
    const entry = listed.get(conversationKey(state));
    if (entry) {
      entry.row.label_set = labelSet;
      rowContent(entry.button, entry.row);
    }
  }

  async function saveLabels() {
    const state = selected;
    if (!state || state.labelBusy || !state.labelDraft) return;
    const session = epoch;
    state.labelBusy = true;
    state.labelNotice = "라벨을 저장하고 있습니다…";
    labelControls();
    try {
      const saved = await api(`${conversationPath(state)}/labels`, "PUT", {
        expected_version: state.labelBase,
        label_ids: [...state.labelDraft],
      }).finally(() => {
        // A conversation read that overlapped this write may hold the older set; loadConversation drops it.
        state.labelWrites++;
      });
      if (epoch !== session) return;
      state.labelDraft = null;
      showLabelSet(state, saved);
      state.labelNotice = "라벨을 저장했습니다.";
      if (byId("inbox-label-filter").value) void loadList();
    } catch (error) {
      if (epoch !== session) return;
      if (error.status >= 400 && error.status < 500) {
        state.labelDraft = null;
        state.labelNotice =
          error.code === "label_conflict"
            ? "다른 멤버가 먼저 라벨을 바꿔 최신 라벨을 다시 불러왔습니다. 확인한 뒤 다시 저장해 주세요."
            : error.message;
        if (["label_archived", "label_not_found"].includes(error.code)) void loadLabels();
        if (selected === state) void loadConversation();
      } else state.labelNotice = "저장 여부를 확인하지 못했습니다. 대화를 새로고침해 현재 라벨을 확인해 주세요.";
    } finally {
      if (epoch === session) {
        state.labelBusy = false;
        if (selected === state) labelControls();
      }
    }
  }

  // The badge counts the caller's reminders the last list load found due, plus listed ones that became due since.
  // "Since" is the count's own server time, not a row's due flag: rows from an earlier page or a conversation read
  // carry flags taken at other times, so a flag would count a reminder the count already holds or miss one it does not.
  function reminderBadge() {
    const later = [...listed.values()].filter(
      ({ row }) => row.reminder && Date.parse(row.reminder.due_at) > dueCheckedAt && isDue(row.reminder),
    ).length;
    const count = dueCount + later,
      button = byId("inbox-reminder-filter");
    byId("inbox-reminder-count").textContent = count.toLocaleString("ko-KR");
    button.classList.toggle("has-due", count > 0);
    button.setAttribute("aria-pressed", String(reminderFilter));
    button.setAttribute("aria-label", `리마인더: 기한이 된 내 리마인더 ${count}개, 누르면 그 대화만 봅니다`);
  }

  // Keeps the open conversation's pending reminder and its list row in step; anything not pending clears both.
  function showReminder(state, reminder) {
    state.reminder = reminder?.status === undefined || reminder.status === "pending" ? reminder : null;
    // Every caller passes a reminder from a request that started after the last time zone change in this tab (null,
    // or a conversation read newer than the change), so its due_local is in the current time zone.
    state.reminderZoneStale = false;
    // A draft equal to the newer reminder is no draft, so the next edit starts from that reminder's version.
    if (state.reminderDraft && !reminderDirty(state)) state.reminderDraft = null;
    const entry = listed.get(conversationKey(state));
    if (entry) {
      const shown = state.reminder;
      entry.row.reminder = shown
        ? {
            id: shown.id,
            due_at: shown.due_at,
            due_local: shown.due_local,
            due: isDue(shown),
            version: shown.version,
            note: shown.note,
          }
        : null;
      rowContent(entry.button, entry.row);
    }
  }

  const reminderNoteLength = (value) => [...value.trim()].length;

  // Whether the editor holds a change the member would lose: a draft that differs from the stored reminder or, with
  // none stored, a note or a due time other than the default shown. A closed conversation without a reminder disables
  // the editor, so a draft left there cannot be cleared and does not count.
  function reminderDirty(state) {
    const draft = state.reminderDraft,
      reminder = state.reminder;
    if (!draft) return false;
    if (reminder) return draft.due !== reminder.due_local || draft.note.trim() !== (reminder.note ?? "");
    if (state.convo?.status === "closed") return false;
    return Boolean(draft.note.trim()) || draft.due !== state.reminderDefault;
  }

  function reminderControls() {
    const state = selected,
      form = byId("inbox-reminder-editor");
    form.hidden = !state;
    if (!state) return;
    const reminder = state.reminder,
      zone = reminderZone(),
      saving = state.reminderBusy,
      // A state change in flight may close the conversation and cancel the reminder, so the editor waits for it.
      busy = saving || state.stateBusy,
      closed = !reminder && state.convo?.status === "closed",
      stale = Boolean(reminder && state.reminderZoneStale);
    const dueInput = byId("inbox-reminder-due"),
      noteInput = byId("inbox-reminder-note");
    const draft = state.reminderDraft ?? {
      due: reminder ? reminder.due_local : defaultDue(zone),
      note: reminder?.note ?? "",
    };
    if (!state.reminderDraft && !reminder) state.reminderDefault = draft.due;
    if (dueInput.value !== draft.due) dueInput.value = draft.due;
    if (noteInput.value !== draft.note) noteInput.value = draft.note;
    // The picker offers 1 minute to 90 days ahead; an unchanged due time (a note-only change of a due reminder) is
    // not checked, since the server keeps it as it is.
    if (reminder && draft.due === reminder.due_local) {
      dueInput.removeAttribute("min");
      dueInput.removeAttribute("max");
    } else {
      dueInput.min = earliestDue(zone);
      dueInput.max = wallClock(serverNow() + 90 * 86400000, zone);
    }
    dueInput.disabled = noteInput.disabled = busy || closed || stale;
    // The server counts code points like PostgreSQL length(); maxlength would count UTF-16 units.
    const length = reminderNoteLength(draft.note);
    noteInput.setCustomValidity(length > 200 ? "리마인더 메모는 200자까지 입력할 수 있습니다." : "");
    byId("inbox-reminder-note-count").textContent = `${length.toLocaleString("ko-KR")} / 200`;
    byId("inbox-reminder-zone").textContent = `작업 공간 시간대(${zone})`;
    const due = Boolean(reminder && isDue(reminder));
    form.classList.toggle("due", due);
    byId("inbox-reminder-state").textContent = stale
      ? "작업 공간 시간대가 바뀌어 리마인더를 새 시간대로 다시 불러오고 있습니다."
      : reminder
        ? `${due ? "기한이 지났습니다" : "기한 전"} · ${reminderLabel(reminder.due_local)}${reminder.note ? ` · ${reminder.note}` : ""}`
        : closed
          ? "완료한 대화에는 리마인더를 둘 수 없습니다. 대화를 다시 열면 정할 수 있습니다."
          : "아직 내 리마인더가 없습니다.";
    const dirty = reminder ? reminderDirty(state) : Boolean(draft.due);
    const save = byId("inbox-reminder-save");
    save.textContent = saving ? "저장 중…" : reminder ? "리마인더 변경" : "리마인더 저장";
    save.disabled = busy || closed || stale || !draft.due || !dirty;
    for (const id of ["inbox-reminder-done", "inbox-reminder-cancel"]) {
      byId(id).hidden = !reminder;
      byId(id).disabled = busy;
    }
    byId("inbox-reminder-status").textContent =
      state.reminderNotice || (reminder && dirty ? "저장하지 않은 변경이 있습니다." : "");
  }

  function reminderInput() {
    const state = selected;
    if (!state || state.reminderBusy) return;
    // A draft keeps the reminder it was started on, like labelBase: a later conversation read can replace the stored
    // reminder, and saving the draft against that newer version would overwrite another screen's change, not get 409.
    if (!state.reminderDraft) state.reminderBase = state.reminder;
    state.reminderDraft = { due: byId("inbox-reminder-due").value, note: byId("inbox-reminder-note").value };
    // A draft equal to the stored reminder, or to the empty editor when none is stored, is no draft.
    if (!reminderDirty(state)) state.reminderDraft = null;
    state.reminderNotice = "";
    reminderControls();
  }

  // Creates the reminder or changes the existing one with the values in the editor.
  async function saveReminder() {
    const state = selected;
    if (!state || state.reminderBusy || state.stateBusy) return;
    const due = byId("inbox-reminder-due").value,
      note = byId("inbox-reminder-note").value;
    const session = epoch,
      zone = zoneChanges,
      reminder = state.reminderDraft ? state.reminderBase : state.reminder;
    state.reminderBusy = true;
    state.reminderNotice = "리마인더를 저장하고 있습니다…";
    reminderControls();
    conversationControls();
    try {
      const body = { note: note.trim() ? note : null };
      const saved = await (
        reminder
          ? api(`/api/inbox/reminders/${reminder.id}`, "PATCH", {
              expected_version: reminder.version,
              ...(due === reminder.due_local ? {} : { due_local: due }),
              ...body,
            })
          : api(`${conversationPath(state)}/reminders`, "POST", { due_local: due, ...body })
      ).finally(() => {
        // A conversation read that overlapped this write may hold the older reminder; loadConversation drops it.
        state.reminderWrites++;
      });
      if (epoch !== session) return;
      state.reminderDraft = null;
      if (zone === zoneChanges) showReminder(state, saved);
      else if (selected === state) void loadConversation();
      state.reminderNotice = reminder ? "리마인더를 변경했습니다." : "리마인더를 저장했습니다.";
      void loadList();
    } catch (error) {
      if (epoch !== session) return;
      if (error.status >= 400 && error.status < 500) {
        state.reminderNotice = error.message;
        // An existing or newer reminder comes back with the refusal; the editor keeps the values to save onto it,
        // unless the time zone changed since, which makes both the values and the returned reminder old-zone times.
        if (error.reminder && zone === zoneChanges) {
          state.reminderDraft = { due, note };
          showReminder(state, error.reminder);
          state.reminderBase = state.reminder;
        } else if (
          error.reminder ||
          ["reminder_not_found", "reminder_not_pending", "conversation_closed"].includes(error.code)
        ) {
          state.reminderDraft = null;
          if (selected === state) void loadConversation();
        }
      } else state.reminderNotice = "저장 여부를 확인하지 못했습니다. 대화를 새로고침해 리마인더를 확인해 주세요.";
    } finally {
      if (epoch === session) {
        state.reminderBusy = false;
        if (selected === state) {
          reminderControls();
          conversationControls();
        }
      }
    }
  }

  async function finishReminder(action) {
    const state = selected,
      reminder = state?.reminder;
    if (!reminder || state.reminderBusy || state.stateBusy) return;
    const session = epoch,
      zone = zoneChanges;
    state.reminderBusy = true;
    state.reminderNotice = action === "complete" ? "완료로 표시하고 있습니다…" : "리마인더를 취소하고 있습니다…";
    reminderControls();
    conversationControls();
    try {
      await api(`/api/inbox/reminders/${reminder.id}/${action}`, "POST", {
        expected_version: reminder.version,
      }).finally(() => {
        state.reminderWrites++;
      });
      if (epoch !== session) return;
      state.reminderDraft = null;
      showReminder(state, null);
      state.reminderNotice = action === "complete" ? "리마인더를 완료로 표시했습니다." : "리마인더를 취소했습니다.";
      void loadList();
    } catch (error) {
      if (epoch !== session) return;
      if (error.status >= 400 && error.status < 500) {
        state.reminderNotice = error.message;
        if (error.reminder && zone === zoneChanges) showReminder(state, error.reminder);
        else if (selected === state) void loadConversation();
      } else state.reminderNotice = "처리 여부를 확인하지 못했습니다. 대화를 새로고침해 리마인더를 확인해 주세요.";
    } finally {
      if (epoch === session) {
        state.reminderBusy = false;
        if (selected === state) {
          reminderControls();
          conversationControls();
        }
      }
    }
  }

  // Once a minute: re-renders the due state from the loaded due_at values, without a request.
  function tickReminders() {
    for (const { row, button } of listed.values())
      if (row.reminder && button.dataset.reminderDue !== String(isDue(row.reminder))) rowContent(button, row);
    reminderBadge();
    reminderControls();
  }

  function memoControls() {
    const state = selected;
    byId("inbox-notes").hidden = !state;
    if (!state) return;
    const textarea = byId("inbox-note-text");
    if (textarea.value !== state.memoDraft) textarea.value = state.memoDraft;
    textarea.disabled = state.memoBusy;
    const length = [...state.memoDraft.trim()].length;
    byId("inbox-note-count").textContent = `${length.toLocaleString("ko-KR")} / 2,000`;
    const add = byId("inbox-note-add");
    add.disabled = state.memoBusy || !length || length > 2000;
    add.textContent = state.memoBusy ? "남기는 중…" : "메모 남기기";
    byId("inbox-notes-status").textContent = state.memoNotice;
    byId("inbox-notes-older").hidden = !state.memoBefore;
    byId("inbox-notes-older").disabled = state.memoLoading;
  }

  function renderMemos(state) {
    const list = byId("inbox-note-list");
    if (!state.memoLoaded) return list.replaceChildren();
    if (!state.memos.length) return list.replaceChildren(node("p", "아직 남긴 메모가 없습니다.", "hint"));
    list.replaceChildren(
      ...state.memos.map((memo) => {
        const item = node("article", "", "note-item");
        item.append(
          node("p", `${person(memo.author)} · ${date(memo.created_at)}`, "hint note-meta"),
          node("p", memo.body, "note-body"),
        );
        return item;
      }),
    );
  }

  // Newest first; `older` appends the next page below.
  async function loadMemos(older = false) {
    const state = selected;
    if (!state || (older && (state.memoLoading || !state.memoBefore))) return;
    const session = epoch,
      request = ++state.memoRequest;
    state.memoLoading = true;
    memoControls();
    try {
      const page = await api(
        `${conversationPath(state)}/notes${older ? `?before=${encodeURIComponent(state.memoBefore)}` : ""}`,
      );
      if (!current(state, session) || request !== state.memoRequest) return;
      state.memos = older ? [...state.memos, ...page.notes] : page.notes;
      state.memoBefore = page.before;
      state.memoLoaded = true;
      renderMemos(state);
    } catch (error) {
      if (current(state, session) && request === state.memoRequest) state.memoNotice = error.message;
    } finally {
      if (current(state, session) && request === state.memoRequest) {
        state.memoLoading = false;
        memoControls();
      }
    }
  }

  async function addMemo() {
    const state = selected;
    if (!state || state.memoBusy || !state.memoDraft.trim()) return;
    const session = epoch;
    state.memoBusy = true;
    state.memoNotice = "메모를 남기고 있습니다…";
    memoControls();
    try {
      const memo = await api(`${conversationPath(state)}/notes`, "POST", { body: state.memoDraft });
      if (epoch !== session) return;
      state.memoDraft = "";
      state.memoNotice = "메모를 남겼습니다.";
      // A list request still in flight may have been read before this note committed; drop it and reload.
      const stale = state.memoLoading;
      if (stale) {
        state.memoRequest++;
        state.memoLoading = false;
      }
      if (!state.memos.some((item) => item.id === memo.id)) state.memos = [memo, ...state.memos];
      state.memoLoaded = true;
      if (selected === state) {
        renderMemos(state);
        if (stale) void loadMemos();
      }
    } catch (error) {
      if (epoch !== session) return;
      const refused = error.status >= 400 && error.status < 500;
      // The draft stays, so a refused or unconfirmed note can be sent again after checking the list.
      state.memoNotice = refused
        ? error.message
        : "메모가 저장됐는지 확인하지 못했습니다. 메모 목록을 확인한 뒤 필요하면 다시 남겨 주세요.";
      if (!refused && selected === state) void loadMemos();
    } finally {
      if (epoch === session) {
        state.memoBusy = false;
        if (selected === state) memoControls();
      }
    }
  }

  // The server counts code points like PostgreSQL length(); HTML maxlength counts UTF-16 units.
  function checkLabelName(input) {
    input.setCustomValidity([...input.value.trim()].length > 30 ? "라벨 이름은 30자까지 입력할 수 있습니다." : "");
  }

  function labelAdmin() {
    byId("inbox-labels-section").hidden = !isAdmin();
    if (!isAdmin()) return;
    byId("inbox-label-count").textContent = `${labels.filter((label) => !label.archived).length} / 50`;
    const list = byId("inbox-label-list");
    if (!labels.length) return list.replaceChildren(node("p", "아직 라벨이 없습니다.", "hint"));
    list.replaceChildren(
      ...labels.map((label) => {
        const item = node("div", "", "item");
        if (label.archived) {
          const badges = node("div", "", "badges");
          badges.append(node("span", "보관됨", "badge"));
          item.append(node("strong", label.name), badges);
          return item;
        }
        const form = node("form", "", "label-rename");
        const input = node("input");
        input.name = "name";
        input.required = true;
        input.autocomplete = "off";
        input.addEventListener("input", () => checkLabelName(input));
        input.value = label.name;
        input.setAttribute("aria-label", `${label.name} 라벨 이름`);
        const save = node("button", "이름 저장", "secondary");
        save.type = "submit";
        form.append(input, save);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          if (input.value.trim() === label.name) return;
          void manageLabels(async () => {
            await api(`/api/inbox/labels/${label.id}`, "PATCH", { name: input.value });
            return "라벨 이름을 바꿨습니다. 이 라벨이 붙은 대화에 새 이름이 보입니다.";
          });
        });
        const archive = node("button", "보관", "secondary danger");
        archive.type = "button";
        archive.addEventListener("click", () => {
          if (
            !confirm(
              `"${label.name}" 라벨을 보관할까요? 보관한 라벨은 대화에 새로 붙일 수 없고, 이미 붙은 대화에는 보관됨으로 남습니다. 보관은 되돌릴 수 없습니다.`,
            )
          )
            return;
          void manageLabels(async () => {
            await api(`/api/inbox/labels/${label.id}`, "DELETE");
            return "라벨을 보관했습니다.";
          });
        });
        item.append(form, archive);
        return item;
      }),
    );
  }

  async function manageLabels(task) {
    if (labelsBusy) return;
    const session = epoch,
      section = byId("inbox-labels-section");
    labelsBusy = true;
    for (const button of section.querySelectorAll("button")) button.disabled = true;
    byId("inbox-labels-status").textContent = "처리하고 있습니다…";
    try {
      const message = await task();
      if (epoch !== session) return;
      byId("inbox-labels-status").textContent = message;
      await loadLabels();
      // List rows carry label names, so a rename or an archive shows on the next list.
      void loadList();
    } catch (error) {
      if (epoch === session) byId("inbox-labels-status").textContent = error.message;
    } finally {
      if (epoch === session) {
        labelsBusy = false;
        for (const button of section.querySelectorAll("button")) button.disabled = false;
      }
    }
  }

  // A list row and a read response each count the messages above the read position they were taken against, and
  // the server never moves that position backward. The count against the higher position is the current one; two
  // counts against the same position differ only by DMs that arrived between them, so the larger is the later.
  function reconcile(row, position) {
    const listed = row.last_read_message_id == null ? -1n : BigInt(row.last_read_message_id),
      read = BigInt(position.last_read_message_id);
    if (listed < read) {
      row.last_read_message_id = position.last_read_message_id;
      row.unread_count = position.unread_count;
    } else if (listed === read) row.unread_count = Math.max(row.unread_count, position.unread_count);
  }

  // Marks the open conversation read up to its newest loaded message. The server keeps the higher position, so
  // a repeated or late request cannot move it backward there; two requests can still be in flight, so a response
  // below the position already shown is dropped instead of bringing back an older unread count.
  async function markRead(state, session, newest) {
    if (state.readMark && BigInt(state.readMark) >= BigInt(newest)) return;
    try {
      const position = await api(
        `/api/inbox/conversations/${state.row.connection_id}/${state.row.recipient_id}/read`,
        "POST",
        { message_id: newest },
      );
      // No position means a deletion removed the conversation after the mark committed; the next list drops it.
      if (epoch !== session || position.last_read_message_id == null) return;
      if (state.readMark && BigInt(position.last_read_message_id) < BigInt(state.readMark)) return;
      state.readMark = position.last_read_message_id;
      state.readUnread = position.unread_count;
      state.readSeq = ++readSeq;
      const entry = listed.get(`${state.row.connection_id}:${state.row.recipient_id}`);
      if (entry) {
        reconcile(entry.row, position);
        rowContent(entry.button, entry.row);
      }
    } catch {
      // The badge stays as it was; the next open or refresh tries again.
    }
  }

  function conversationControls() {
    const state = selected;
    byId("inbox-conversation-controls").hidden = !state?.convo;
    if (!state?.convo) return;
    const convo = state.convo,
      mine = convo.assignee?.user_id === getUserId(),
      // A close cancels the pending reminders it finds, so a reminder write and a state change never overlap: a save
      // response arriving after the close would otherwise show a cancelled reminder as pending.
      locked = state.loading || state.stateBusy || state.reminderBusy;
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
    if (!state?.convo || state.stateBusy || state.loading || state.reminderBusy) return;
    const session = epoch;
    state.stateBusy = true;
    state.stateNotice = "대화 상태를 바꾸고 있습니다…";
    conversationControls();
    reminderControls();
    try {
      state.convo = await api(
        `/api/inbox/conversations/${state.row.connection_id}/${state.row.recipient_id}/state`,
        "PUT",
        { expected_version: state.convo.version, ...change },
      ).finally(() => {
        // A conversation read that overlapped this write may hold the older state, or a pending reminder a close
        // cancelled; loadConversation drops both.
        state.convoWrites++;
        state.reminderWrites++;
      });
      if (epoch !== session) return;
      state.stateNotice = "대화 상태를 변경했습니다.";
      // Closing cancelled every pending reminder on the conversation, the caller's included.
      if (state.convo.status === "closed") {
        state.reminderDraft = null;
        showReminder(state, null);
      }
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
        if (selected === state) {
          conversationControls();
          // The reminder editor depends on the status: a closed conversation holds no reminder.
          reminderControls();
        }
      }
    }
  }

  function controls() {
    const state = selected;
    conversationControls();
    labelControls();
    reminderControls();
    memoControls();
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
      writes = state.convoWrites,
      labelWrites = state.labelWrites,
      reminderWrites = state.reminderWrites;
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
      if (messages.label_set && labelWrites === state.labelWrites) showLabelSet(state, messages.label_set);
      if ("reminder" in messages && reminderWrites === state.reminderWrites) showReminder(state, messages.reminder);
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
      // Messages arrive newest first, so the first one of a fresh load is the newest stored message.
      if (!older && messages.messages.length) void markRead(state, session, messages.messages[0].id);
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

  function conversationKey(state) {
    return `${state.row.connection_id}:${state.row.recipient_id}`;
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
        readMark: null,
        readUnread: null,
        readSeq: 0,
        labelSet: row.label_set ?? { version: 0, labels: [] },
        labelDraft: null,
        labelBase: 0,
        labelBusy: false,
        labelNotice: "",
        labelWrites: 0,
        memos: [],
        memoBefore: null,
        memoLoaded: false,
        memoLoading: false,
        memoRequest: 0,
        memoDraft: "",
        memoBusy: false,
        memoNotice: "",
        reminder: row.reminder ?? null,
        reminderDraft: null,
        // The stored reminder a draft was started on; saveReminder sends its ID and version, not the latest read's.
        reminderBase: null,
        // Set when this tab saved a new workspace time zone, until a reread returns due_local in that zone.
        reminderZoneStale: false,
        // The default due time the editor showed when the member started a draft with no stored reminder.
        reminderDefault: "",
        reminderBusy: false,
        reminderNotice: "",
        reminderWrites: 0,
      });
    selected = states.get(key);
    byId("inbox-conversation-title").textContent = `@${row.username || "연결 계정"} · DM 사용자 ${row.recipient_id}`;
    byId("inbox-thread-refresh").hidden = false;
    for (const button of byId("inbox-conversations").children)
      button.setAttribute("aria-pressed", String(button.dataset.key === key));
    timeline(selected);
    renderMemos(selected);
    controls();
    void loadConversation();
    void loadMemos();
  }

  async function loadList(more = false) {
    if (more && (listBusy || !after)) return;
    const session = epoch,
      request = more ? listRequest : ++listRequest;
    if (!more) {
      byId("inbox-conversations").replaceChildren();
      listed.clear();
      after = null;
    }
    listBusy = true;
    byId("inbox-more").disabled = true;
    byId("inbox-status").textContent = "대화를 불러오고 있습니다…";
    const query = new URLSearchParams();
    if (byId("inbox-account").value) query.set("connection_id", byId("inbox-account").value);
    if (byId("inbox-status-filter").value) query.set("status", byId("inbox-status-filter").value);
    if (byId("inbox-assignee-filter").value) query.set("assignee", byId("inbox-assignee-filter").value);
    if (byId("inbox-label-filter").value) query.set("label", byId("inbox-label-filter").value);
    if (byId("inbox-unread").checked) query.set("unread", "true");
    if (reminderFilter) query.set("reminder", "due");
    if (searchText) query.set("q", searchText);
    if (more) query.set("after", after);
    const reads = readSeq,
      unreadOnly = query.has("unread");
    try {
      const page = await api(`/api/inbox?${query}`);
      if (epoch !== session || request !== listRequest) return;
      dueCheckedAt = Date.parse(page.checked_at);
      clockOffset = dueCheckedAt - Date.now();
      dueCount = page.due_reminder_count;
      for (const row of page.conversations) {
        // A read mark applied after this request started may have committed after the list snapshot; the row's
        // read position shows which came first, so an older count cannot bring the badge back and a newer DM
        // counted after the mark is kept.
        const known = states.get(`${row.connection_id}:${row.recipient_id}`);
        if (known?.readSeq > reads && known.readMark)
          reconcile(row, { last_read_message_id: known.readMark, unread_count: known.readUnread });
        if (unreadOnly && row.unread_count === 0) continue;
        const button = node("button", "", "secondary");
        rowContent(button, row);
        button.dataset.key = `${row.connection_id}:${row.recipient_id}`;
        listed.set(button.dataset.key, { row, button });
        button.setAttribute(
          "aria-pressed",
          String(selected?.row.connection_id === row.connection_id && selected?.row.recipient_id === row.recipient_id),
        );
        button.addEventListener("click", () => choose(row));
        byId("inbox-conversations").append(button);
      }
      after = page.after;
      reminderBadge();
      byId("inbox-status").textContent = byId("inbox-conversations").children.length
        ? "대화를 선택하세요. 초안은 대화마다 따로 보관됩니다."
        : reminderFilter && !searchText
          ? "기한이 된 내 리마인더가 없거나 다른 보기 조건에 맞지 않습니다."
          : filtered()
            ? "검색어나 보기 조건에 맞는 대화가 없습니다."
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
    labels = [];
    labelsBusy = false;
    searchText = "";
    listed.clear();
    clearTimeout(expiryTimer);
    clearInterval(reminderTimer);
    reminderTimer = undefined;
    reminderFilter = false;
    dueCount = 0;
    dueCheckedAt = 0;
    clockOffset = 0;
    reminderBadge();
    byId("inbox-account").replaceChildren(new Option("모든 계정", ""));
    byId("inbox-status-filter").value = "";
    byId("inbox-assignee-filter").value = "";
    assigneeOptions();
    byId("inbox-unread").checked = false;
    byId("inbox-search").value = "";
    byId("inbox-label-filter").replaceChildren(new Option("전체", ""));
    byId("inbox-labels-section").hidden = true;
    byId("inbox-label-form").reset();
    byId("inbox-label-options").dataset.key = "";
    for (const id of [
      "inbox-conversations",
      "inbox-messages",
      "inbox-label-list",
      "inbox-label-options",
      "inbox-note-list",
    ])
      byId(id).replaceChildren();
    for (const id of [
      "inbox-status",
      "inbox-message-status",
      "inbox-reply-status",
      "inbox-state-status",
      "inbox-labels-status",
    ])
      byId(id).textContent = "";
    byId("inbox-reply-text").value = "";
    byId("inbox-note-text").value = "";
    byId("inbox-reminder-editor").reset();
    byId("inbox-reminder-status").textContent = "";
    byId("inbox-conversation-title").textContent = "대화를 선택하세요";
    for (const id of ["inbox-more", "inbox-older", "inbox-thread-refresh"]) byId(id).hidden = true;
    controls();
  }
  // Admins can also pick a member; agents filter by themselves or unassigned only.
  function assigneeOptions() {
    const select = byId("inbox-assignee-filter"),
      previous = select.value;
    const options = [new Option("전체", ""), new Option("나", "me"), new Option("미배정", "none")];
    for (const member of assignees)
      if (member.user_id !== getUserId()) options.push(new Option(person(member), member.user_id));
    select.replaceChildren(...options);
    select.value = options.some((option) => option.value === previous) ? previous : "";
  }
  for (const id of ["inbox-status-filter", "inbox-assignee-filter", "inbox-label-filter", "inbox-unread"])
    byId(id).addEventListener("change", () => void loadList());
  byId("inbox-reminder-filter").addEventListener("click", () => {
    reminderFilter = !reminderFilter;
    reminderBadge();
    void loadList();
  });
  byId("inbox-reminder-due").addEventListener("input", reminderInput);
  byId("inbox-reminder-note").addEventListener("input", reminderInput);
  byId("inbox-reminder-editor").addEventListener("submit", (event) => {
    event.preventDefault();
    if (byId("inbox-reminder-save").disabled || !event.currentTarget.reportValidity()) return;
    void saveReminder();
  });
  byId("inbox-reminder-done").addEventListener("click", () => void finishReminder("complete"));
  byId("inbox-reminder-cancel").addEventListener("click", () => void finishReminder("cancel"));
  byId("inbox-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    searchText = byId("inbox-search").value.trim();
    void loadList();
  });
  // Clearing the box (including its clear button) shows every conversation again.
  byId("inbox-search").addEventListener("input", (event) => {
    if (!event.target.value && searchText) {
      searchText = "";
      void loadList();
    }
  });
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
    void loadLabels();
    void loadList();
    if (selected) {
      void loadConversation();
      void loadMemos();
    }
  });
  byId("inbox-more").addEventListener("click", () => void loadList(true));
  byId("inbox-older").addEventListener("click", () => void loadConversation(true));
  byId("inbox-thread-refresh").addEventListener("click", () => {
    void loadConversation();
    void loadMemos();
  });
  byId("inbox-label-editor").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!byId("inbox-label-save").disabled) void saveLabels();
  });
  byId("inbox-note-text").addEventListener("input", (event) => {
    if (selected && !selected.memoBusy) {
      selected.memoDraft = event.target.value;
      selected.memoNotice = "";
      memoControls();
    }
  });
  byId("inbox-note-text").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      if (!byId("inbox-note-add").disabled) byId("inbox-note-form").requestSubmit();
    }
  });
  byId("inbox-note-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!byId("inbox-note-add").disabled) void addMemo();
  });
  byId("inbox-notes-older").addEventListener("click", () => void loadMemos(true));
  byId("inbox-label-form").elements.name.addEventListener("input", (event) => checkLabelName(event.target));
  byId("inbox-label-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (labelsBusy || !form.reportValidity()) return;
    void manageLabels(async () => {
      await api("/api/inbox/labels", "POST", { name: form.elements.name.value });
      form.reset();
      return "라벨을 추가했습니다.";
    });
  });
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
    // After this tab saves a new workspace time zone: stored due_local values and draft due times are in the old zone,
    // while the server reads a sent due_local in the new one. Drafts are dropped, edits of a stored reminder wait for
    // a reread, and the open conversation and the list are read again.
    timeZoneChanged() {
      zoneChanges++;
      for (const state of states.values()) {
        if (reminderDirty(state))
          state.reminderNotice =
            "작업 공간 시간대가 바뀌어 편집하던 리마인더를 지웠습니다. 새 시간대로 다시 정해 주세요.";
        state.reminderDraft = null;
        state.reminderZoneStale = Boolean(state.reminder);
      }
      if (selected) {
        reminderControls();
        void loadConversation();
      }
      if (listed.size) void loadList();
    },
    hasDrafts: () =>
      [...states.values()].some(
        (state) =>
          state.draft ||
          state.operation ||
          state.memoDraft.trim() ||
          state.labelDraft ||
          reminderDirty(state) ||
          [...state.notes.values()].some(Boolean),
      ),
    initialize() {
      const select = byId("inbox-account"),
        previous = select.value;
      select.replaceChildren(new Option("모든 계정", ""));
      for (const account of getConnections())
        select.append(new Option(account.username || account.account_id, account.id));
      if (getConnections().some((account) => account.id === previous)) select.value = previous;
      byId("inbox-labels-section").hidden = !isAdmin();
      clearInterval(reminderTimer);
      reminderTimer = setInterval(tickReminders, 60000);
      void loadLabels();
      void loadList();
      if (isAdmin()) {
        const session = epoch;
        api("/api/inbox/assignees")
          .then((result) => {
            if (epoch !== session) return;
            assignees = result.assignees;
            assigneeOptions();
            conversationControls();
          })
          .catch(() => undefined);
      }
    },
  };
}
