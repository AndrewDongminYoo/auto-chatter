// The flow section (#30): list, step-list editor of the draft, read-only graph and test run. The pure
// parts live in flow-editor-model.js. Admins and owners edit; agents see the list and a read-only view and
// send no request that needs admin. Nothing typed here is kept in browser storage.
function createFlowEditor({ api, node, badge, action, notice, getRole, getConnections, fieldTypeLabels }) {
  const byId = (id) => document.getElementById(id);
  const svgNs = "http://www.w3.org/2000/svg";
  let epoch = 0;
  let listRequest = 0;
  let openRequest = 0;
  let flows = [];
  let current = null;
  let draft = null;
  let changes = 0;
  let savedChanges = 0;
  let busy = false;
  let fields = [];
  let endpoints = [];
  let placed = [];
  let general = [];
  let generalHeading = "";
  let path = new Set();
  let pathEdges = new Set();
  let pathRan = null;
  let numbers = {};
  const openMenus = new Set();
  const isAdmin = () => ["owner", "admin"].includes(getRole());
  const dirty = () => current !== null && changes !== savedChanges;
  const sameId = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();
  const names = {
    field: (id) => fields.find((field) => sameId(field.id, id))?.name ?? null,
    endpoint: (id) => endpoints.find((endpoint) => sameId(endpoint.id, id))?.name ?? null,
    connection: (id) => {
      const account = getConnections().find((connection) => connection.id === id);
      return account ? (account.username ?? account.account_id) : null;
    },
  };
  const stepName = (id) => {
    const target = draft && flowNodeById(draft, id);
    return target ? `${numbers[id] ?? "?"}. ${flowTypeLabel(target.type)}` : "없는 단계";
  };

  function canLeave() {
    return !dirty() || confirm("저장하지 않은 플로 변경 사항을 버릴까요?");
  }

  // Runs one editor request. action() restores the disabled state it found, so the editor controls are
  // applied again afterwards.
  async function run(button, task) {
    await action(button, async () => {
      // Set inside the task: action() returns at once for a button that is already disabled.
      busy = true;
      if (current) controls();
      try {
        await task();
      } catch (error) {
        if (flowKnownError(error.code)) error.message = flowErrorMessage(error.code);
        throw error;
      } finally {
        busy = false;
      }
    });
    if (current) controls();
  }

  // List

  function flowItem(flow) {
    const item = node("div", "", "item");
    const badges = node("div", "", "badges");
    badges.append(
      badge(flow.published_version_no ? `발행 v${flow.published_version_no}` : "미발행"),
      badge(flow.enabled ? "켜짐" : "꺼짐", flow.enabled ? "success" : ""),
    );
    const open = node("button", "열기", "secondary");
    open.type = "button";
    open.setAttribute("aria-label", `${flow.name} 플로 열기`);
    open.addEventListener("click", () => openFlow(flow.id, open));
    item.append(
      node("strong", flow.name),
      badges,
      node("p", `${new Date(flow.updated_at).toLocaleString("ko-KR")} 수정`, "hint"),
      open,
    );
    return item;
  }
  function renderList() {
    byId("flow-count").textContent = flows.length;
    byId("flows").replaceChildren(
      ...(flows.length
        ? flows.map(flowItem)
        : [
            node(
              "p",
              isAdmin()
                ? "아직 만든 플로가 없습니다. 아래에서 이름을 정해 첫 플로를 만들어 보세요."
                : "아직 만든 플로가 없습니다.",
              "hint",
            ),
          ]),
    );
  }
  async function loadList() {
    const session = epoch;
    const request = ++listRequest;
    try {
      const result = await api("/api/flows");
      if (session !== epoch || request !== listRequest) return;
      flows = result.flows;
      renderList();
    } catch (error) {
      if (session === epoch && request === listRequest) notice(error.message, true);
    }
  }

  // Opening and closing

  // Only the latest open shows its flow: an earlier open that resolves later is dropped. Edits made while
  // the flow loads are confirmed again, since the check before the request did not see them.
  async function load(id) {
    const session = epoch;
    const request = ++openRequest;
    const before = changes;
    const [flow, fieldList, endpointList] = await Promise.all([
      api(`/api/flows/${id}`),
      api("/api/contact-fields"),
      // The endpoint list needs admin; agents see a neutral label instead.
      isAdmin() ? api("/api/webhooks/endpoints") : Promise.resolve({ endpoints: [] }),
    ]);
    if (session !== epoch || request !== openRequest) return false;
    if (dirty() && changes !== before && !canLeave()) return false;
    fields = fieldList.fields;
    endpoints = endpointList.endpoints;
    show(flow);
    byId("flow-editor").hidden = false;
    byId("flow-editor-title").focus();
    return true;
  }
  function show(flow) {
    current = {
      id: flow.id,
      name: flow.name,
      revision: flow.draft_revision,
      published: flow.published_version_no,
      enabled: flow.enabled,
    };
    draft = JSON.parse(JSON.stringify(flow.draft));
    changes = 0;
    savedChanges = 0;
    placed = [];
    general = [];
    path = new Set();
    pathEdges = new Set();
    pathRan = null;
    openMenus.clear();
    byId("flow-name").value = flow.name;
    byId("flow-conflict").hidden = true;
    byId("flow-test-result").replaceChildren();
    resetTestForm();
    renderEditor();
  }
  function openFlow(id, button) {
    if (current?.id === id) {
      // Staying on the open flow drops an open of another flow that is still loading.
      openRequest++;
      byId("flow-editor-title").focus();
      return;
    }
    if (!canLeave()) return;
    void run(button, () => load(id));
  }
  function close() {
    // Closing also drops an open that is still loading.
    openRequest++;
    current = null;
    draft = null;
    changes = 0;
    savedChanges = 0;
    byId("flow-editor").hidden = true;
    byId("flow-test-result").replaceChildren();
  }

  // Editor frame

  function controls() {
    const unsaved = dirty();
    // An archived flow stays open only to copy edits from it; the server refuses every request about it.
    const archived = current.archived === true;
    byId("flow-save").disabled = busy || archived || !unsaved;
    byId("flow-publish").disabled = busy || archived || unsaved;
    byId("flow-toggle").textContent = current.enabled ? "끄기" : "켜기";
    byId("flow-toggle").disabled = busy || archived || (!current.enabled && !current.published);
    byId("flow-archive").disabled = busy || archived;
    byId("flow-test-run").disabled = busy || archived;
    byId("flow-status").textContent = !isAdmin()
      ? "플로는 관리자와 소유자만 바꿀 수 있어 읽기 전용으로 보여 줍니다."
      : archived
        ? "보관한 플로입니다. 저장할 수 없으니 필요한 내용을 옮긴 뒤 닫아 주세요."
        : unsaved
          ? "저장하지 않은 변경 사항이 있습니다. 발행과 초안 테스트는 저장한 초안으로 하므로 먼저 저장해 주세요."
          : current.published
            ? `저장한 초안입니다. 발행 버전은 v${current.published}이며, 초안을 발행해야 실행에 반영됩니다.`
            : "저장한 초안입니다. 발행하고 켜야 새 댓글에 실행됩니다.";
    byId("flow-badges").replaceChildren(
      badge(current.published ? `발행 v${current.published}` : "미발행"),
      badge(current.enabled ? "켜짐" : "꺼짐", current.enabled ? "success" : ""),
      ...(unsaved ? [badge("저장 전", "warning")] : []),
    );
  }
  function renderEditor() {
    const admin = isAdmin();
    byId("flow-editor-title").textContent = current.name;
    byId("flow-name-row").hidden = !admin;
    byId("flow-actions").hidden = !admin;
    byId("flow-test").hidden = !admin;
    controls();
    // The outline numbers the steps the error summary names, so it renders first.
    renderOutline();
    renderErrors();
    renderGraph();
  }
  // The last test run's path is marked only while the draft is still the document that ran (see
  // renderTestResult); the first edit that makes it another document drops the mark.
  function pathStale() {
    if (!path.size || flowSameDocument(pathRan, draft)) return false;
    path = new Set();
    pathEdges = new Set();
    pathRan = null;
    return true;
  }
  function change(next, focus) {
    if (next) draft = next;
    changes++;
    pathStale();
    controls();
    renderOutline();
    renderErrors();
    renderGraph();
    if (focus) byId("flow-outline").querySelector(focus)?.focus();
  }
  // A config edit changes the draft in place and keeps the focus where it is, so a dropped test path is
  // unmarked in the outline without rendering it again.
  function configChanged(item, summary) {
    changes++;
    if (pathStale()) {
      const outline = byId("flow-outline");
      for (const element of outline.querySelectorAll(".on-path")) element.classList.remove("on-path");
      for (const element of outline.querySelectorAll("[data-path-badge]")) element.remove();
      byId("flow-path-legend").hidden = true;
    }
    controls();
    summary.textContent = flowSummary(item, names);
    renderGraph();
  }

  // Errors from publish, enable and test run

  // Without `published` the errors are about the saved draft on screen. Errors about the published version
  // (`published` is { version_no, definition }, or null when it could not be read) are placed on the
  // draft's steps only when the draft is the same document; otherwise their step IDs may name other steps.
  // `checked` is the document the errors are about when it may differ from the draft on screen: a published
  // version ({ version_no, definition }), the draft as a test run sent it ({ label, definition }), or null
  // when the published version could not be read.
  function showErrors(errors, heading, checked) {
    if (checked === undefined || flowSameDocument(checked?.definition, draft))
      ({ placed, general } = flowPlaceErrors(draft, errors));
    else {
      placed = [];
      general = flowErrorsElsewhere(
        checked?.definition,
        errors,
        checked?.label ?? (checked ? `발행 버전 v${checked.version_no}` : "발행 버전"),
      );
    }
    generalHeading = heading;
    renderOutline();
    renderErrors();
    renderGraph();
    byId("flow-errors").focus();
  }
  // The published version as it was read for a test run (its number) or the enable check (the current one),
  // or null when it cannot be read.
  async function publishedVersion(id, versionNo) {
    try {
      const number =
        versionNo ?? (await api(`/api/flows/${id}/versions`)).versions.find((version) => version.current)?.version_no;
      if (!number) return null;
      return { version_no: number, definition: (await api(`/api/flows/${id}/versions/${number}`)).definition };
    } catch {
      return null;
    }
  }
  function renderErrors() {
    const box = byId("flow-errors");
    const total = placed.length + general.length;
    box.hidden = total === 0;
    if (!total) return;
    const list = node("ul", "");
    for (const error of general) list.append(node("li", error.message));
    for (const error of placed) {
      const item = node("li", "");
      const link = node("a", stepName(error.node_id));
      link.href = `#flow-step-${error.node_id}`;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        byId(`flow-step-title-${error.node_id}`)?.focus();
      });
      item.append(link, `: ${error.message}`);
      list.append(item);
    }
    box.replaceChildren(node("strong", `${generalHeading} 문제 ${total}개`), list);
  }
  function clearErrors() {
    placed = [];
    general = [];
    renderErrors();
  }

  // Config forms

  function labelled(text, control, hint) {
    const label = node("label", text);
    label.append(control);
    if (hint) label.append(node("span", hint, "hint flow-hint"));
    return label;
  }
  function select(options, value) {
    const element = document.createElement("select");
    for (const [optionValue, text] of options) element.add(new Option(text, optionValue));
    // Without a value the first option stays selected.
    if (value === undefined || value === null) return element;
    if (![...element.options].some((option) => option.value === value))
      element.add(new Option("사용할 수 없는 항목", value));
    element.value = value;
    return element;
  }
  function fieldSelect(filter, value, emptyLabel) {
    const options = fields.filter(filter).map((field) => [field.id, `${field.name} · ${fieldTypeLabels[field.type]}`]);
    const element = select(
      emptyLabel ? [["", emptyLabel], ...options] : options,
      value || (emptyLabel ? "" : undefined),
    );
    for (const option of element.options)
      if (option.text === "사용할 수 없는 항목") option.text = "사용할 수 없는 필드";
    return element;
  }
  const fieldOf = (id) => fields.find((field) => sameId(field.id, id));
  // A typed input for one field's value; boolean fields use a select.
  function valueControl(field, value) {
    if (field?.type === "boolean")
      return select(
        [
          ["true", "예"],
          ["false", "아니오"],
        ],
        value === false ? "false" : "true",
      );
    const input = document.createElement("input");
    input.type = field?.type === "number" ? "number" : field?.type === "date" ? "date" : "text";
    if (field?.type === "number") input.step = "any";
    input.maxLength = 1000;
    input.value = value === undefined || value === null ? "" : String(value);
    return input;
  }
  // Wrong values are kept as typed, so publish names the step instead of the editor dropping them.
  function readValue(field, control) {
    if (field?.type === "boolean") return control.value === "true";
    if (field?.type === "number") return flowTypedNumber(control.value);
    return control.value;
  }
  // A stored duration as the input shows it, wrong values included.
  function shown(value) {
    return typeof value === "number" || typeof value === "string" ? String(value) : "";
  }

  function configForm(item, summary) {
    const box = node("div", "", "flow-config");
    const config = item.config;
    const update = (values) => {
      item.config = flowConfig(item.type, values);
      configChanged(item, summary);
    };
    switch (item.type) {
      case "instagram_comment": {
        const account = select(
          getConnections().map((connection) => [connection.id, connection.username ?? connection.account_id]),
          config.connection_id || undefined,
        );
        if (!config.connection_id) {
          account.add(new Option("계정 선택", ""), 0);
          account.value = "";
        }
        const media = document.createElement("input");
        media.inputMode = "numeric";
        media.maxLength = 40;
        media.value = config.media_id ?? "";
        const mode = select(
          [
            ["contains", "키워드 포함"],
            ["exact", "정확히 일치"],
            ["all", "모든 댓글"],
          ],
          config.match_mode,
        );
        const keywords = document.createElement("textarea");
        keywords.rows = 3;
        keywords.value = flowStoredList(config.keywords).join("\n");
        const excluded = document.createElement("textarea");
        excluded.rows = 2;
        excluded.value = flowStoredList(config.excluded_keywords).join("\n");
        const keywordLabel = labelled("키워드", keywords, "한 줄에 하나씩 최대 20개, 각각 100자까지");
        const sync = () => (keywordLabel.hidden = mode.value === "all");
        sync();
        box.addEventListener("input", () => {
          sync();
          update({
            connection_id: account.value,
            media_id: media.value.trim(),
            keywords: flowLines(keywords.value),
            match_mode: mode.value,
            excluded_keywords: flowLines(excluded.value),
          });
        });
        box.append(
          labelled("Instagram 계정", account),
          labelled("게시물 ID", media, "자동화할 게시물의 숫자 ID입니다."),
          labelled("댓글 조건", mode),
          keywordLabel,
          labelled("제외 키워드", excluded, "이 단어가 들어간 댓글에는 실행하지 않습니다."),
        );
        break;
      }
      case "instagram_message": {
        const text = document.createElement("textarea");
        text.rows = 4;
        text.maxLength = flowLimit("messageLength");
        text.value = config.text ?? "";
        const variables = select([
          ["{{comment.text}}", "댓글 본문"],
          ...fields
            .filter((field) => field.type !== "boolean")
            .map((field) => [`{{field:${field.id}}}`, `${field.name} 필드 값`]),
        ]);
        const insert = node("button", "넣기", "secondary");
        insert.type = "button";
        insert.addEventListener("click", () => {
          text.setRangeText(variables.value, text.selectionStart, text.selectionEnd, "end");
          text.focus();
          update({ text: text.value });
        });
        const variableRow = node("div", "", "flow-slot-form");
        variableRow.append(labelled("변수", variables), insert);
        text.addEventListener("input", () => update({ text: text.value }));
        box.append(
          labelled("보낼 메시지", text, "최대 1,000자입니다. 변수는 보내기 전에 한 번만 채웁니다."),
          variableRow,
        );
        break;
      }
      case "has_tag":
      case "add_tag":
      case "remove_tag": {
        const tag = document.createElement("input");
        tag.maxLength = 40;
        tag.value = config.tag ?? "";
        tag.addEventListener("input", () => update({ tag: tag.value }));
        box.append(labelled("태그", tag, "40자까지, 대소문자는 구분하지 않습니다."));
        break;
      }
      case "field_equals":
      case "set_field": {
        const condition = item.type === "field_equals";
        const field = fieldSelect(() => true, config.field_id, "필드 선택");
        const operator = select(
          [
            ["is_set", "값이 있음"],
            ["is_unset", "값이 없음"],
            ["eq", "값이 같음"],
          ],
          config.field_operator,
        );
        const valueSlot = node("div", "");
        let value;
        let valueField;
        const buildValue = () => {
          // The stored value fills the first control. A rebuild for another field keeps what is typed now
          // when both fields have the same type, and otherwise starts from the new field's default.
          const before = fieldOf(valueField);
          const chosen = fieldOf(field.value);
          const typed = !value
            ? condition
              ? config.field_value
              : config.value
            : before?.type === chosen?.type
              ? readValue(before, value)
              : flowFieldDefault(chosen);
          valueField = field.value;
          value = valueControl(chosen, typed);
          valueSlot.replaceChildren(labelled(condition ? "비교할 값" : "저장할 값", value));
          valueSlot.hidden = condition && operator.value !== "eq";
        };
        buildValue();
        const read = () =>
          update(
            condition
              ? {
                  field_id: field.value,
                  field_operator: operator.value,
                  field_value: readValue(fieldOf(field.value), value),
                }
              : { field_id: field.value, value: readValue(fieldOf(field.value), value) },
          );
        field.addEventListener("change", () => {
          buildValue();
          read();
        });
        operator.addEventListener("change", () => {
          valueSlot.hidden = operator.value !== "eq";
          read();
        });
        valueSlot.addEventListener("input", read);
        valueSlot.addEventListener("change", read);
        box.append(labelled("필드", field), ...(condition ? [labelled("조건", operator)] : []), valueSlot);
        break;
      }
      case "delay": {
        const minutes = document.createElement("input");
        minutes.type = "number";
        minutes.min = "1";
        minutes.max = String(flowLimit("delayMinutes"));
        minutes.step = "1";
        minutes.value = shown(config.minutes);
        minutes.addEventListener("input", () => update({ minutes: flowTypedNumber(minutes.value) }));
        box.append(labelled("기다릴 시간(분)", minutes, "1분부터 10,020분(7일에서 1시간을 뺀 시간)까지입니다."));
        break;
      }
      case "wait_until": {
        const time = document.createElement("input");
        time.type = "time";
        time.value = config.time ?? "";
        time.addEventListener("input", () => update({ time: time.value }));
        box.append(labelled("기다릴 시각", time, "작업 공간 시간대의 다음 이 시각에 이어 갑니다."));
        break;
      }
      case "wait_for_reply": {
        const timeout = document.createElement("input");
        timeout.type = "number";
        timeout.min = "1";
        timeout.max = String(flowLimit("replyWaitMinutes"));
        timeout.step = "1";
        timeout.value = shown(config.timeout_minutes);
        const save = fieldSelect((field) => field.type === "text", config.save_field_id, "저장하지 않음");
        const read = () => update({ timeout_minutes: flowTypedNumber(timeout.value), save_field_id: save.value });
        timeout.addEventListener("input", read);
        save.addEventListener("change", read);
        box.append(
          labelled("응답을 기다릴 시간(분)", timeout, "1분부터 10,080분(7일)까지입니다."),
          labelled("응답을 저장할 텍스트 필드", save),
        );
        break;
      }
      case "webhook": {
        const endpoint = select(
          [
            ["", "주소 선택"],
            ...endpoints.map((candidate) => [candidate.id, `${candidate.name}${candidate.active ? "" : " (꺼짐)"}`]),
          ],
          config.endpoint_id || "",
        );
        const chosen = new Set(flowStoredList(config.field_ids).map((id) => String(id).toLowerCase()));
        const checks = document.createElement("fieldset");
        checks.className = "flow-checks";
        checks.append(node("legend", "보낼 필드"));
        const checkbox = (value, checked, text) => {
          const check = document.createElement("input");
          check.type = "checkbox";
          check.value = value;
          check.checked = checked;
          const label = node("label", "");
          label.append(check, text);
          checks.append(label);
          return check;
        };
        const boxes = fields.map((field) =>
          checkbox(field.id, chosen.has(field.id.toLowerCase()), `${field.name} · ${fieldTypeLabels[field.type]}`),
        );
        // Fields the list no longer has (archived) stay checked so publish names this step; unchecking one
        // removes it from the step.
        const unknown = flowUnavailableFieldIds(config.field_ids, fields).map((id, index) =>
          checkbox(id, true, `사용할 수 없는 필드 ${index + 1} · 보관됐거나 없음`),
        );
        if (unknown.length)
          checks.append(node("p", "사용할 수 없는 필드는 보낼 수 없습니다. 선택을 해제하고 저장해 주세요.", "hint"));
        if (!fields.length) checks.append(node("p", "만든 필드가 없습니다.", "hint"));
        const tags = document.createElement("input");
        tags.type = "checkbox";
        tags.checked = config.include_tags === true;
        const tagLabel = node("label", "", "flow-check");
        tagLabel.append(tags, "연락처 태그도 보내기");
        const read = () =>
          update({
            endpoint_id: endpoint.value,
            field_ids: flowCheckedFieldIds([...unknown, ...boxes]),
            include_tags: tags.checked,
          });
        box.addEventListener("change", read);
        box.append(
          labelled("보낼 주소", endpoint, "외부 전송 영역에서 등록한 주소입니다. 꺼진 주소로는 발행할 수 없습니다."),
          checks,
          tagLabel,
          node("p", `필드는 최대 ${flowLimit("webhookFields")}개까지 보낼 수 있습니다.`, "hint"),
        );
        break;
      }
      default:
        box.append(node("p", "이 화면에서 편집할 수 없는 단계입니다. 필요하면 삭제해 주세요.", "hint"));
    }
    return box;
  }

  // Outline

  function defaults(type) {
    return flowConfig(type, {
      field_id: fields[0]?.id ?? "",
      value: flowFieldDefault(fields[0]),
      endpoint_id: endpoints.find((endpoint) => endpoint.active)?.id ?? "",
      connection_id: getConnections()[0]?.id ?? "",
    });
  }
  // The form that adds a step on an empty slot or in front of the step a port leads to.
  function addForm(from, ports, labelText) {
    const form = node("form", "", "flow-slot-form");
    const portSelect = ports.length > 1 ? select(ports.map((port) => [port, `${flowPortLabel(port)} 가지`])) : null;
    const typeSelect = document.createElement("select");
    const fill = () => {
      const types = flowSlotTypes(draft, from, portSelect ? portSelect.value : ports[0]);
      typeSelect.replaceChildren(...types.map((type) => new Option(flowTypeLabel(type), type)));
      add.disabled = !types.length;
    };
    const add = node("button", "추가", "secondary");
    add.type = "submit";
    fill();
    portSelect?.addEventListener("change", fill);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const port = portSelect ? portSelect.value : ports[0];
      const type = typeSelect.value;
      if (!type) return;
      const { document: next, id } = flowInsert(draft, from, port, type, defaults(type));
      openMenus.add(id);
      change(next, `#flow-step-${id} .flow-config :is(input, select, textarea)`);
    });
    form.append(...(portSelect ? [labelled("가지", portSelect)] : []), labelled(labelText, typeSelect), add);
    return form;
  }
  function linkForm(from, port) {
    const targets = flowLinkTargets(draft, from);
    if (!targets.length) return null;
    const form = node("form", "", "flow-slot-form");
    const target = select(targets.map((id) => [id, stepName(id)]));
    const connect = node("button", "연결", "secondary");
    connect.type = "submit";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      change(flowConnect(draft, from, port, target.value), `[data-link="${from}:${port}"] a`);
    });
    form.append(labelled("기존 단계로 연결", target), connect);
    return form;
  }
  function slotName(from, port) {
    const item = flowNodeById(draft, from);
    return flowPorts(item?.type).length > 1
      ? `${stepName(from)}의 ${flowPortLabel(port)} 가지`
      : `${stepName(from)} 뒤`;
  }
  function emptyItem(entry) {
    const item = node("li", "", "flow-slot");
    item.dataset.slot = `${entry.from}:${entry.port}`;
    item.append(
      node("p", entry.port === "next" ? "여기서 끝납니다." : "이 가지는 비어 있어 여기서 끝납니다.", "flow-slot-text"),
    );
    if (!isAdmin()) return item;
    const types = flowSlotTypes(draft, entry.from, entry.port);
    if (types.length)
      item.append(addForm(entry.from, [entry.port], `${slotName(entry.from, entry.port)}에 추가할 단계`));
    const link = linkForm(entry.from, entry.port);
    if (link) item.append(link);
    return item;
  }
  function linkItem(entry) {
    const onPath = pathEdges.has(`${entry.from}:${entry.port}:${entry.id}`);
    const item = node("li", "", `flow-link${onPath ? " on-path" : ""}`);
    item.dataset.link = `${entry.from}:${entry.port}`;
    const link = node("a", `${stepName(entry.id)}(으)로 이어집니다`);
    link.href = `#flow-step-${entry.id}`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      byId(`flow-step-title-${entry.id}`)?.focus();
    });
    item.append(node("span", "→ ", "flow-link-arrow"), link);
    if (isAdmin()) {
      const unlink = node("button", "연결 끊기", "secondary");
      unlink.type = "button";
      unlink.setAttribute("aria-label", `${slotName(entry.from, entry.port)}의 연결 끊기`);
      unlink.addEventListener("click", () =>
        change(flowDisconnect(draft, entry.from, entry.port), `[data-slot="${entry.from}:${entry.port}"] select`),
      );
      item.append(unlink);
    }
    return item;
  }
  function stepItem(entry) {
    const item = flowNodeById(draft, entry.id);
    const errors = placed.filter((error) => error.node_id === entry.id);
    const element = node(
      "li",
      "",
      `flow-step${path.has(entry.id) ? " on-path" : ""}${errors.length ? " has-error" : ""}`,
    );
    element.id = `flow-step-${entry.id}`;
    const title = node("p", "", "flow-step-title");
    title.id = `flow-step-title-${entry.id}`;
    title.tabIndex = -1;
    title.append(node("strong", stepName(entry.id)));
    if (path.has(entry.id)) {
      const mark = badge("테스트 경로", "success");
      mark.dataset.pathBadge = "";
      title.append(mark);
    }
    if (errors.length) title.append(badge(`문제 ${errors.length}개`, "danger"));
    const summary = node("p", flowSummary(item, names), "flow-step-summary");
    element.append(title, summary);
    if (errors.length) {
      const list = node("ul", "", "flow-step-errors");
      for (const error of errors) list.append(node("li", error.message));
      element.append(list);
    }
    if (isAdmin()) element.append(stepMenu(item, summary));
    if (entry.branches.length) {
      const branches = node("div", "", "flow-branches");
      for (const branch of entry.branches) {
        const box = node("div", "", "flow-branch");
        box.append(node("p", `${flowPortLabel(branch.port)} 가지`, "flow-branch-label"), sequence(branch.items));
        branches.append(box);
      }
      element.append(branches);
    }
    return element;
  }
  function stepMenu(item, summary) {
    const menu = document.createElement("details");
    menu.className = "flow-step-menu";
    menu.open = openMenus.has(item.id);
    menu.addEventListener("toggle", () => (menu.open ? openMenus.add(item.id) : openMenus.delete(item.id)));
    menu.append(node("summary", `${stepName(item.id)} 편집`));
    menu.append(configForm(item, summary));
    // In front of the step a port already leads to; empty ports have their own slot in the outline.
    const occupied = flowPorts(item.type).filter((port) => flowEdge(draft, item.id, port));
    const insertable = occupied.filter((port) => flowSlotTypes(draft, item.id, port).length);
    if (insertable.length)
      menu.append(
        addForm(
          item.id,
          insertable,
          insertable.length > 1
            ? "넣을 단계"
            : flowPorts(item.type).length > 1
              ? `${slotName(item.id, insertable[0])} 맨 앞에 넣을 단계`
              : `${stepName(item.id)} 바로 뒤에 넣을 단계`,
        ),
      );
    if (flowRemovable(draft, item.id)) {
      const remove = node("button", "단계 삭제", "secondary danger");
      remove.type = "button";
      remove.addEventListener("click", () => {
        const children = flowChildCount(draft, item.id);
        if (
          children &&
          !confirm(
            `${stepName(item.id)} 단계를 삭제할까요? 뒤에 이어진 단계 ${children}개는 남지만 트리거에서 이어지지 않게 되어, 다시 연결하거나 삭제해야 발행할 수 있습니다.`,
          )
        )
          return;
        const incoming = draft.edges.find((edge) => edge.to === item.id);
        openMenus.delete(item.id);
        // A later step may take this ID again, so its publish errors go with it; change() drops the test path.
        placed = placed.filter((error) => error.node_id !== item.id);
        change(flowRemove(draft, item.id), incoming ? `[data-slot="${incoming.from}:${incoming.port}"] select` : null);
        if (!incoming) byId("flow-steps-title").focus();
      });
      menu.append(remove);
    }
    return menu;
  }
  function sequence(items) {
    const list = node("ol", "", "flow-sequence");
    for (const entry of items)
      list.append(entry.kind === "step" ? stepItem(entry) : entry.kind === "link" ? linkItem(entry) : emptyItem(entry));
    return list;
  }
  function renderOutline() {
    const outline = flowOutline(draft);
    numbers = flowStepNumbers(outline);
    const parts = [];
    if (!outline.trigger) {
      if (isAdmin()) {
        const start = node("button", "댓글 트리거 만들기");
        start.type = "button";
        start.addEventListener("click", () => {
          const { document: next, id } = flowAddTrigger(draft, defaults("instagram_comment"));
          openMenus.add(id);
          change(next, `#flow-step-${id} .flow-config select`);
        });
        parts.push(node("p", "플로는 댓글 트리거 하나에서 시작합니다.", "hint"), start);
      } else parts.push(node("p", "아직 댓글 트리거가 없습니다.", "hint"));
    }
    if (outline.steps.length) parts.push(sequence(outline.steps));
    if (outline.unreachable.length) {
      const group = node("div", "", "flow-unreachable");
      group.append(
        node("h5", "트리거에서 이어지지 않는 단계"),
        node("p", "실행되지 않는 단계입니다. 발행하려면 위의 빈 자리에 연결하거나 삭제해 주세요.", "hint"),
        ...outline.unreachable.map(sequence),
      );
      parts.push(group);
    }
    byId("flow-outline").replaceChildren(...parts);
    byId("flow-path-legend").hidden = path.size === 0;
  }

  // Graph

  function svg(tag, attributes, text) {
    const element = document.createElementNS(svgNs, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function clip(text, length) {
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
  }
  function renderGraph() {
    const layout = flowLayout(draft);
    const box = byId("flow-graph");
    if (!layout.nodes.length) {
      box.replaceChildren(node("p", "아직 단계가 없습니다.", "hint"));
      return;
    }
    const graph = svg("svg", {
      width: layout.width,
      height: layout.height,
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      "aria-hidden": "true",
      focusable: "false",
    });
    const marker = svg("marker", {
      id: "flow-arrow",
      viewBox: "0 0 8 8",
      refX: 8,
      refY: 4,
      markerWidth: 8,
      markerHeight: 8,
      orient: "auto",
    });
    marker.append(svg("path", { d: "M0,0 L8,4 L0,8 z", class: "flow-graph-arrow" }));
    const defs = svg("defs", {});
    defs.append(marker);
    graph.append(defs);
    for (const edge of layout.edges) {
      const bend = Math.max(24, Math.abs(edge.x2 - edge.x1) / 2);
      const onPath = pathEdges.has(`${edge.from}:${edge.port}:${edge.to}`);
      graph.append(
        svg("path", {
          d: `M${edge.x1},${edge.y1} C${edge.x1 + bend},${edge.y1} ${edge.x2 - bend},${edge.y2} ${edge.x2},${edge.y2}`,
          class: `flow-graph-edge${onPath ? " on-path" : ""}`,
          "marker-end": "url(#flow-arrow)",
        }),
      );
      if (edge.port !== "next")
        graph.append(
          svg(
            "text",
            // On the side the curve leaves from, so the label does not sit on the line.
            { x: edge.x1 + 6, y: edge.y1 + (edge.y2 >= edge.y1 ? -6 : 14), class: "flow-graph-port" },
            flowPortLabel(edge.port),
          ),
        );
    }
    const erroneous = new Set(placed.map((error) => error.node_id));
    for (const position of layout.nodes) {
      const item = flowNodeById(draft, position.id);
      const group = svg("g", {
        class: `flow-graph-node${path.has(position.id) ? " on-path" : ""}${erroneous.has(position.id) ? " has-error" : ""}${position.reachable ? "" : " unreachable"}`,
      });
      group.append(
        svg("rect", { x: position.x, y: position.y, width: layout.nodeWidth, height: layout.nodeHeight, rx: 6 }),
        svg("text", { x: position.x + 10, y: position.y + 22 }, clip(stepName(position.id), 18)),
        svg(
          "text",
          { x: position.x + 10, y: position.y + 42, class: "flow-graph-detail" },
          clip(flowSummary(item, names), 20),
        ),
      );
      graph.append(group);
    }
    box.replaceChildren(graph);
  }

  // Test run

  const testFields = new Map();
  function resetTestForm() {
    const form = byId("flow-test-form");
    form.reset();
    testFields.clear();
    byId("flow-test-fields").replaceChildren();
    form.elements.field_pick.replaceChildren(
      ...fields.map((field) => new Option(`${field.name} · ${fieldTypeLabels[field.type]}`, field.id)),
    );
    byId("flow-test-add-field").disabled = !fields.length;
  }
  function addTestField() {
    const id = byId("flow-test-form").elements.field_pick.value;
    const field = fieldOf(id);
    if (!field) return;
    if (testFields.has(field.id)) {
      testFields.get(field.id).control.focus();
      return;
    }
    const row = node("div", "", "flow-slot-form");
    const control = valueControl(field, undefined);
    const remove = node("button", "빼기", "secondary");
    remove.type = "button";
    remove.setAttribute("aria-label", `${field.name} 필드 값 빼기`);
    remove.addEventListener("click", () => {
      testFields.delete(field.id);
      row.remove();
      byId("flow-test-form").elements.field_pick.focus();
    });
    row.append(labelled(`${field.name} 값`, control), remove);
    testFields.set(field.id, { field, control });
    byId("flow-test-fields").append(row);
    control.focus();
  }
  function testRunBody() {
    const values = byId("flow-test-form").elements;
    return {
      source: values.source.value,
      comment_text: values.comment_text.value,
      tags: flowLines(values.tags.value),
      fields: Object.fromEntries(
        [...testFields.values()].map(({ field, control }) => [field.id, readValue(field, control)]),
      ),
      ...(values.reply_text.value ? { reply_text: values.reply_text.value } : {}),
      reply_branch: values.reply_branch.value,
    };
  }
  // A run names the steps of the document that ran: the published version, or the draft as it was when the
  // run was sent (`tested`). Its path is marked on the draft on screen only when that is still the same
  // document, because a draft edited since may use the same step IDs for other steps.
  function renderTestResult(result, published, tested) {
    const ran = result.source === "published" ? published?.definition : tested;
    const same = flowSameDocument(ran, draft);
    path = same ? new Set(flowPathIds(result.steps)) : new Set();
    pathEdges = same ? new Set(flowPathEdges(result.steps)) : new Set();
    pathRan = same ? ran : null;
    clearErrors();
    renderOutline();
    renderGraph();
    const label = same ? stepName : flowStepLabels(ran);
    const box = byId("flow-test-result");
    const source = result.source === "published" ? `발행 버전 v${result.version_no}` : "저장한 초안";
    const status = node(
      "p",
      `${source} · ${flowTestStatus(result.status)}${result.failure_code ? ` ${flowFailureMessage(result.failure_code)}` : ""}`,
      `flow-test-status${result.status === "failed" ? " form-error" : ""}`,
    );
    status.setAttribute("role", "status");
    const parts = [node("h5", "테스트 결과"), status];
    if (!same)
      parts.push(
        node(
          "p",
          result.source !== "published"
            ? "테스트하는 동안 초안이 바뀌어 단계 목록과 그래프에는 경로를 표시하지 않았습니다. 아래 단계 번호는 테스트한 초안 기준입니다."
            : ran
              ? `발행 버전 v${result.version_no}이 지금 화면의 초안과 달라 단계 목록과 그래프에는 경로를 표시하지 않았습니다. 아래 단계 번호는 발행 버전 기준입니다.`
              : "발행 버전을 불러오지 못해 단계 목록과 그래프에는 경로를 표시하지 않았습니다.",
          "hint",
        ),
      );
    if (result.steps.length) {
      const steps = node("ol", "", "flow-test-steps");
      for (const step of result.steps) steps.append(node("li", `${label(step.node_id)}: ${flowOutcome(step.outcome)}`));
      parts.push(node("h6", "지난 단계"), steps);
    }
    if (result.messages.length) {
      parts.push(node("h6", "보낼 메시지"));
      for (const message of result.messages)
        parts.push(
          node("p", label(message.node_id), "hint"),
          node("p", message.text, "bubble outgoing flow-test-message"),
        );
    }
    if (result.waits.length) {
      const waits = node("ul", "");
      for (const wait of result.waits) waits.append(node("li", `${label(wait.node_id)}: ${flowWaitText(wait)}`));
      parts.push(node("h6", "기다림"), waits);
    }
    const tagChanges = Object.entries(result.changes.tags);
    const fieldChanges = Object.entries(result.changes.fields);
    const changesList = node("ul", "");
    for (const [tag, member] of tagChanges) changesList.append(node("li", `태그 "${tag}" ${member ? "추가" : "제거"}`));
    for (const [id, value] of fieldChanges)
      changesList.append(node("li", `${names.field(id) ?? "사용할 수 없는 필드"} 필드: ${flowValueText(value)}`));
    parts.push(
      node("h6", "태그·필드 변경"),
      tagChanges.length || fieldChanges.length ? changesList : node("p", "바뀌는 태그와 필드 값이 없습니다.", "hint"),
    );
    if (result.webhooks.length) {
      parts.push(node("h6", "외부 전송 미리보기"));
      for (const webhook of result.webhooks)
        parts.push(
          node("p", `${label(webhook.node_id)} → ${names.endpoint(webhook.endpoint_id) ?? "등록한 주소"}`, "hint"),
          node("pre", JSON.stringify(webhook.payload, null, 2), "flow-test-payload"),
        );
    }
    parts.push(
      node(
        "p",
        "실제로 보내거나 저장한 것은 없습니다. 저장된 연락처, 동의, 상담 상태와 7일 댓글 답장 기간은 확인하지 않았습니다.",
        "hint",
      ),
    );
    box.replaceChildren(...parts);
  }

  // Events

  byId("flows-refresh").addEventListener("click", (event) => run(event.currentTarget, loadList));
  byId("flow-create").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!canLeave()) return;
    void run(form.querySelector("button"), async () => {
      const session = epoch;
      const openId = current?.id;
      const before = changes;
      const created = await api("/api/flows", "POST", { name: form.elements.name.value });
      if (session !== epoch) return;
      form.reset();
      // The check above did not see edits made while the request was in flight, or a flow opened meanwhile.
      if (dirty() && (current.id !== openId || changes !== before) && !canLeave()) {
        notice("플로를 만들었습니다. 열려 있는 플로를 저장한 뒤 목록에서 새 플로를 열어 주세요.");
        await loadList();
        return;
      }
      close();
      void loadList();
      if (await load(created.id)) notice("플로를 만들었습니다. 댓글 트리거부터 단계를 추가해 주세요.");
    });
  });
  byId("flow-close").addEventListener("click", () => {
    if (!canLeave()) return;
    close();
    byId("flows-title").focus();
  });
  byId("flow-name").addEventListener("input", () => {
    changes++;
    controls();
  });
  byId("flow-save").addEventListener("click", (event) =>
    run(event.currentTarget, async () => {
      const session = epoch;
      // The response belongs to this editor only: closing and opening the same flow again, or loading the
      // latest draft, starts another one with its own revision and change count.
      const editing = current;
      const id = current.id;
      const counted = changes;
      const name = byId("flow-name").value;
      try {
        const saved = await api(`/api/flows/${id}`, "PUT", {
          expected_revision: current.revision,
          draft,
          ...(name !== current.name ? { name } : {}),
        });
        if (session !== epoch || current !== editing) return;
        current.revision = saved.draft_revision;
        current.name = name.trim();
        savedChanges = counted;
        byId("flow-conflict").hidden = true;
        byId("flow-editor-title").textContent = current.name;
        notice("초안을 저장했습니다. 발행해야 실행에 반영됩니다.");
        void loadList();
      } catch (error) {
        if (session !== epoch || current !== editing) return;
        if (error.code !== "revision_conflict") throw error;
        showConflict();
      }
    }),
  );
  function showConflict() {
    byId("flow-conflict").hidden = false;
    byId("flow-reload").focus();
  }
  byId("flow-reload").addEventListener("click", (event) =>
    run(event.currentTarget, async () => {
      const session = epoch;
      // An editor opened since (the same flow closed and opened again) keeps its own edits.
      const editing = current;
      const id = current.id;
      const flow = await api(`/api/flows/${id}`);
      if (session !== epoch || current !== editing) return;
      show(flow);
      notice("최신 초안을 불러왔습니다. 이 화면에서 저장하지 않은 변경 사항은 버렸습니다.");
      byId("flow-editor-title").focus();
    }),
  );
  byId("flow-publish").addEventListener("click", (event) =>
    run(event.currentTarget, async () => {
      const session = epoch;
      const editing = current;
      const id = current.id;
      // Publish needs a saved draft, so this is the document the server checks; edits made while the
      // request is in flight must not receive its errors.
      const checked = flowCopy(draft);
      try {
        const published = await api(`/api/flows/${id}/publish`, "POST", { expected_revision: current.revision });
        if (session !== epoch || current?.id !== id) return;
        current.published = published.version_no;
        clearErrors();
        renderOutline();
        renderGraph();
        notice(
          published.replayed
            ? `이미 발행한 초안입니다. 발행 버전은 v${published.version_no}입니다.`
            : `v${published.version_no}을 발행했습니다. ${current.enabled ? "켜져 있으므로 새 댓글부터 이 버전으로 실행합니다." : "켜야 새 댓글에 실행됩니다."}`,
        );
        void loadList();
      } catch (error) {
        if (session !== epoch || current?.id !== id) return;
        // The revision it sent was this editor's; an editor opened since has its own.
        if (error.code === "revision_conflict") return current === editing ? showConflict() : undefined;
        if (error.status === 422 && Array.isArray(error.errors))
          return showErrors(error.errors, "발행할 수 없습니다. 표시한 단계를 고친 뒤 저장하고 다시 발행해 주세요.", {
            label: "발행하려던 초안",
            definition: checked,
          });
        throw error;
      }
    }),
  );
  byId("flow-toggle").addEventListener("click", (event) => {
    const enable = !current.enabled;
    if (
      !enable &&
      !confirm(
        "이 플로를 끌까요? 새 댓글로 실행을 시작하지 않고, 기다리는 중인 실행은 재개할 때 취소되며, 대기열의 답장도 보내지 않습니다. 다시 켜도 취소된 실행은 되살아나지 않습니다.",
      )
    )
      return;
    void run(event.currentTarget, async () => {
      const session = epoch;
      const id = current.id;
      try {
        const result = await api(`/api/flows/${id}/${enable ? "enable" : "disable"}`, "POST");
        if (session !== epoch || current?.id !== id) return;
        current.enabled = result.enabled;
        clearErrors();
        notice(result.enabled ? "플로를 켰습니다. 새 댓글부터 발행 버전으로 실행합니다." : "플로를 껐습니다.");
        void loadList();
      } catch (error) {
        if (session !== epoch || current?.id !== id) return;
        if (error.status === 422 && Array.isArray(error.errors)) {
          // The enable check reads the published version, not the draft.
          const published = await publishedVersion(id);
          if (session !== epoch || current?.id !== id) return;
          return showErrors(error.errors, "발행 버전을 켤 수 없습니다.", published);
        }
        throw error;
      }
    });
  });
  byId("flow-archive").addEventListener("click", (event) => {
    if (
      !confirm(
        `"${current.name}" 플로를 보관할까요? 꺼지고 발행 버전이 해제되며 목록에서 사라집니다. 기다리는 중인 실행은 재개할 때 취소됩니다. 보관한 플로는 이 화면에서 다시 열 수 없습니다.`,
      )
    )
      return;
    void run(event.currentTarget, async () => {
      const session = epoch;
      const id = current.id;
      const before = changes;
      await api(`/api/flows/${id}`, "DELETE");
      if (session !== epoch) return;
      // Another flow opened while the request was in flight stays open with its edits.
      if (current?.id !== id) {
        notice("플로를 보관했습니다.");
        return loadList();
      }
      // Edits made while the request was in flight cannot be saved to an archived flow; on a refusal the
      // editor stays open so they can be copied.
      if (dirty() && changes !== before && !canLeave()) {
        current.archived = true;
        current.enabled = false;
        notice("플로를 보관했습니다. 보관한 플로는 저장할 수 없으니 필요한 내용을 옮긴 뒤 닫아 주세요.");
        return loadList();
      }
      close();
      notice("플로를 보관했습니다.");
      await loadList();
      byId("flows-title").focus();
    });
  });
  byId("flow-test-add-field").addEventListener("click", addTestField);
  byId("flow-test-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const body = testRunBody();
    if (body.source === "draft" && dirty()) {
      notice("저장하지 않은 변경 사항이 있습니다. 초안을 테스트하려면 먼저 저장해 주세요.", true);
      return;
    }
    // The step inputs stay editable while the run is in flight; the draft that ran is the saved draft as it
    // is now. The revision makes the server refuse to run a draft saved elsewhere since this editor's copy.
    const tested = body.source === "draft" ? flowCopy(draft) : undefined;
    if (body.source === "draft") body.expected_revision = current.revision;
    void run(byId("flow-test-run"), async () => {
      const session = epoch;
      const editing = current;
      const id = current.id;
      try {
        const result = await api(`/api/flows/${id}/test-run`, "POST", body);
        if (session !== epoch || current?.id !== id) return;
        // Versions never change, so this is the document that ran.
        const published = result.source === "published" ? await publishedVersion(id, result.version_no) : undefined;
        if (session !== epoch || current?.id !== id) return;
        renderTestResult(result, published, tested);
      } catch (error) {
        if (session !== epoch || current?.id !== id) return;
        if (error.code === "revision_conflict") {
          // The revision it sent was this editor's; an editor opened since has its own.
          if (current !== editing) return;
          byId("flow-test-result").replaceChildren(
            node(
              "p",
              "다른 곳에서 초안을 먼저 저장해 테스트하지 않았습니다. 최신 초안을 불러온 뒤 다시 실행해 주세요.",
              "form-error",
            ),
          );
          return showConflict();
        }
        if (error.status === 422 && Array.isArray(error.errors)) {
          const published =
            body.source === "published" ? await publishedVersion(id) : { label: "테스트한 초안", definition: tested };
          if (session !== epoch || current?.id !== id) return;
          byId("flow-test-result").replaceChildren(
            node("p", "테스트할 수 없습니다. 위에 표시한 문제를 고친 뒤 다시 실행해 주세요.", "form-error"),
          );
          return showErrors(
            error.errors,
            error.code === "flow_not_executable"
              ? "실행할 수 없는 단계가 있습니다."
              : "발행 검증을 통과하지 못했습니다.",
            published,
          );
        }
        throw error;
      }
    });
  });

  return {
    initialize() {
      const admin = isAdmin();
      byId("flow-create").hidden = !admin;
      byId("flows-readonly").hidden = admin;
      void loadList();
      if (current) renderEditor();
    },
    reset() {
      epoch++;
      flows = [];
      fields = [];
      endpoints = [];
      close();
      byId("flows").replaceChildren();
      byId("flow-count").textContent = "0";
      byId("flow-create").reset();
      byId("flow-create").hidden = true;
      byId("flows-readonly").hidden = true;
    },
    hasChanges: dirty,
  };
}
