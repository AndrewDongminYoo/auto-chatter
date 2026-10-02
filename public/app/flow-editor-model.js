// Pure helpers for the flow editor (#30): node catalog, outline, layered layout, edits and Korean text.
// Classic script with top-level functions only: src/app/flow-editor-model.test.ts runs it in a node:vm
// context, and every name starts with "flow" so it cannot collide with app.js in the shared global scope.
// src/app/flow-schema.ts owns the node types, configs, ports and limits; this file mirrors them for the screen.

// The node types the editor offers: those flowExecutionErrors accepts (no follows_account), trigger first.
var flowTypeCatalog = [
  { type: "instagram_comment", label: "댓글 트리거", ports: ["next"] },
  { type: "instagram_message", label: "메시지 보내기", ports: ["next"] },
  { type: "wait_for_reply", label: "응답 기다리기", ports: ["replied", "timeout"] },
  { type: "has_tag", label: "태그 조건", ports: ["true", "false"] },
  { type: "field_equals", label: "필드 조건", ports: ["true", "false"] },
  { type: "add_tag", label: "태그 추가", ports: ["next"] },
  { type: "remove_tag", label: "태그 제거", ports: ["next"] },
  { type: "set_field", label: "필드 값 저장", ports: ["next"] },
  { type: "delay", label: "지연", ports: ["next"] },
  { type: "wait_until", label: "시각까지 기다리기", ports: ["next"] },
  { type: "webhook", label: "외부 전송", ports: ["next"] },
];
var flowPortNames = { next: "다음", true: "예", false: "아니오", replied: "응답 받음", timeout: "시간 초과" };
// Limits from src/app/flow-schema.ts.
var flowLimits = {
  delayMinutes: 7 * 24 * 60 - 60,
  replyWaitMinutes: 7 * 24 * 60,
  messageLength: 1000,
  webhookFields: 20,
};

function flowCatalogEntry(type) {
  return flowTypeCatalog.find((entry) => entry.type === type);
}
function flowTypes() {
  return flowTypeCatalog.map((entry) => entry.type);
}
function flowTypeLabel(type) {
  return flowCatalogEntry(type)?.label ?? `지원하지 않는 단계(${type})`;
}
// The editor does not offer follows_account, but a draft saved through the API may hold one; its ports
// keep the outline following both branches.
var flowOtherPorts = { follows_account: ["true", "false"] };
function flowPorts(type) {
  return (flowCatalogEntry(type)?.ports ?? (Object.hasOwn(flowOtherPorts, type) ? flowOtherPorts[type] : [])).slice();
}
function flowPortLabel(port) {
  return Object.hasOwn(flowPortNames, port) ? flowPortNames[port] : port;
}
function flowLimit(name) {
  return flowLimits[name];
}

// The config a node type stores, from already typed form values. Optional keys are left out rather
// than stored empty, because the publish check accepts exactly the required and optional keys.
function flowConfig(type, values) {
  switch (type) {
    case "instagram_comment":
      return {
        connection_id: values.connection_id ?? "",
        media_id: values.media_id ?? "",
        keywords: values.keywords ?? [],
        match_mode: values.match_mode ?? "contains",
        excluded_keywords: values.excluded_keywords ?? [],
      };
    case "instagram_message":
      return { text: values.text ?? "" };
    case "has_tag":
    case "add_tag":
    case "remove_tag":
      return { tag: values.tag ?? "" };
    case "field_equals": {
      const operator = values.field_operator ?? "is_set";
      return {
        field_id: values.field_id ?? "",
        field_operator: operator,
        ...(operator === "eq" ? { field_value: values.field_value ?? "" } : {}),
      };
    }
    case "set_field":
      return { field_id: values.field_id ?? "", value: values.value ?? "" };
    case "delay":
      return { minutes: values.minutes ?? 60 };
    case "wait_until":
      return { time: values.time ?? "09:00" };
    case "wait_for_reply":
      return {
        timeout_minutes: values.timeout_minutes ?? 1440,
        ...(values.save_field_id ? { save_field_id: values.save_field_id } : {}),
      };
    case "webhook":
      return {
        endpoint_id: values.endpoint_id ?? "",
        field_ids: values.field_ids ?? [],
        include_tags: values.include_tags === true,
      };
    default:
      return {};
  }
}

// A number input's value as typed: a number when it reads as one, otherwise the text itself (an empty input
// stays ""). flowConfig applies a duration's default only when the key is missing, so a wrong value is
// stored as typed and publish names its step instead of a default replacing it.
function flowTypedNumber(text) {
  const value = String(text).trim();
  return value && Number.isFinite(Number(value)) ? Number(value) : String(text);
}

// One line per keyword, trimmed, empty lines dropped.
function flowLines(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
// A list a step's config stores (keywords, field IDs), as the editor shows it. A draft save checks only the
// document shape, so the value may be any JSON: a single string or number is shown as one item, and
// anything else that is not an array as none. Editing the step stores the list the editor shows.
function flowStoredList(value) {
  if (Array.isArray(value)) return value;
  return typeof value === "string" || typeof value === "number" ? [value] : [];
}

function flowNodeById(document, id) {
  return document.nodes.find((node) => node.id === id);
}
function flowTrigger(document) {
  return document.nodes.find((node) => node.type === "instagram_comment");
}
// The edge a run follows from a port: the first one, as planFlowRun reads it.
function flowEdge(document, from, port) {
  return document.edges.find((edge) => edge.from === from && edge.port === port);
}
// One more than the highest s<number> in use, so a gap left by a deleted step is not reused. Deleting the
// highest step frees its ID; the editor drops that step's test-path mark and errors when it deletes it.
function flowNextId(document) {
  const numbers = document.nodes
    .map((node) => /^s(\d+)$/.exec(node.id))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return `s${Math.max(document.nodes.length, ...numbers) + 1}`;
}
function flowCopy(document) {
  return JSON.parse(JSON.stringify(document));
}

// Nodes reachable from a start node along the edges, the start included.
function flowReachable(document, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift();
    for (const edge of document.edges)
      if (edge.from === id && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
  }
  return seen;
}
// Nodes after a reply wait, where the publish check refuses a message (message_after_wait).
function flowAfterWait(document) {
  const after = new Set();
  for (const node of document.nodes)
    if (node.type === "wait_for_reply")
      for (const id of flowReachable(document, node.id)) if (id !== node.id) after.add(id);
  return after;
}
function flowHasMessageFrom(document, start) {
  return [...flowReachable(document, start)].some((id) => flowNodeById(document, id)?.type === "instagram_message");
}

// Whether a node of `type` may sit on the slot (from, port) and lead to `to` (undefined for an empty slot):
// a message is followed only by a reply wait, a reply wait follows only a message, and no message comes
// after a reply wait (wait_requires_message, unsupported_after_message, message_after_wait).
function flowFits(document, from, type, to) {
  const source = flowNodeById(document, from);
  if (!source || type === "instagram_comment" || !flowCatalogEntry(type)) return false;
  if ((source.type === "instagram_message") !== (type === "wait_for_reply")) return false;
  const afterWait = source.type === "wait_for_reply" || flowAfterWait(document).has(from);
  if (type === "instagram_message" && afterWait) return false;
  if (to === undefined) return true;
  const target = flowNodeById(document, to);
  if (!target) return false;
  if ((type === "instagram_message") !== (target.type === "wait_for_reply")) return false;
  if (type === "wait_for_reply" && flowHasMessageFrom(document, to)) return false;
  return true;
}
// The types the picker offers for a slot; an occupied slot keeps its step after the new one.
function flowSlotTypes(document, from, port) {
  const to = flowEdge(document, from, port)?.to;
  return flowTypes().filter((type) => flowFits(document, from, type, to));
}
// The existing steps an empty slot may connect to, without a cycle and within the same rules.
function flowLinkTargets(document, from) {
  const source = flowNodeById(document, from);
  if (!source) return [];
  const afterWait = source.type === "wait_for_reply" || flowAfterWait(document).has(from);
  return document.nodes
    .filter((node) => {
      if (node.id === from || node.type === "instagram_comment") return false;
      if (flowReachable(document, node.id).has(from)) return false;
      if ((source.type === "instagram_message") !== (node.type === "wait_for_reply")) return false;
      if (afterWait && flowHasMessageFrom(document, node.id)) return false;
      return true;
    })
    .map((node) => node.id);
}

function flowAddTrigger(document, config) {
  const next = flowCopy(document);
  const id = flowNextId(next);
  next.nodes.unshift({ id, type: "instagram_comment", config });
  return { document: next, id };
}
// Adds a node on (from, port). When the slot already leads somewhere, the new node takes that place and
// continues to it on its first port.
function flowInsert(document, from, port, type, config) {
  const next = flowCopy(document);
  const id = flowNextId(next);
  next.nodes.push({ id, type, config });
  const existing = flowEdge(next, from, port);
  if (existing) {
    next.edges.push({ from: id, port: flowPorts(type)[0], to: existing.to });
    existing.to = id;
  } else next.edges.push({ from, port, to: id });
  return { document: next, id };
}
function flowConnect(document, from, port, to) {
  const next = flowCopy(document);
  next.edges = next.edges.filter((edge) => !(edge.from === from && edge.port === port));
  next.edges.push({ from, port, to });
  return next;
}
function flowDisconnect(document, from, port) {
  const next = flowCopy(document);
  next.edges = next.edges.filter((edge) => !(edge.from === from && edge.port === port));
  return next;
}
// Removes a node with its incoming and outgoing edges; the steps after it stay, unconnected.
function flowRemove(document, id) {
  const next = flowCopy(document);
  next.nodes = next.nodes.filter((node) => node.id !== id);
  next.edges = next.edges.filter((edge) => edge.from !== id && edge.to !== id);
  return next;
}
function flowChildCount(document, id) {
  return new Set(document.edges.filter((edge) => edge.from === id).map((edge) => edge.to)).size;
}
// Any step but the only trigger may be deleted. A draft save does not count triggers (only publish reports
// trigger_count), so a stored draft can carry several, and every one of them must stay removable.
function flowRemovable(document, id) {
  const node = flowNodeById(document, id);
  if (!node) return false;
  return node.type !== "instagram_comment" || document.nodes.filter((other) => other.type === node.type).length > 1;
}

// The outline from the trigger. A sequence is a list of items: a step ("step"), a link to a step shown
// elsewhere ("link"), or the empty end of a port ("empty"). A one-port step continues in the same
// sequence; a step with several ports carries one branch per port and ends its sequence. A node reached
// again (a second parent or a cycle) is shown once in full and as a link everywhere else. Steps the
// trigger does not reach follow in `unreachable`, each with what comes after it.
function flowOutline(document) {
  const shown = new Set();
  const sequence = (startId, from, port) => {
    const items = [];
    let id = startId;
    let slot = { from, port };
    while (true) {
      const node = id === undefined ? undefined : flowNodeById(document, id);
      if (!node) {
        if (slot.from !== undefined) items.push({ kind: "empty", from: slot.from, port: slot.port });
        return items;
      }
      if (shown.has(node.id)) {
        items.push({ kind: "link", id: node.id, from: slot.from, port: slot.port });
        return items;
      }
      shown.add(node.id);
      const ports = flowPorts(node.type);
      if (ports.length === 1) {
        items.push({ kind: "step", id: node.id, branches: [] });
        slot = { from: node.id, port: ports[0] };
        id = flowEdge(document, node.id, ports[0])?.to;
        continue;
      }
      const item = { kind: "step", id: node.id, branches: [] };
      items.push(item);
      for (const branchPort of ports)
        item.branches.push({
          port: branchPort,
          items: sequence(flowEdge(document, node.id, branchPort)?.to, node.id, branchPort),
        });
      return items;
    }
  };
  const trigger = flowTrigger(document);
  const steps = trigger ? sequence(trigger.id, undefined, undefined) : [];
  const unreachable = [];
  for (const node of document.nodes) if (!shown.has(node.id)) unreachable.push(sequence(node.id, undefined, undefined));
  return { trigger: trigger?.id ?? null, steps, unreachable };
}
// Step numbers in outline order, from 1.
function flowStepNumbers(outline) {
  const numbers = {};
  let next = 1;
  const visit = (items) => {
    for (const item of items)
      if (item.kind === "step") {
        if (!Object.hasOwn(numbers, item.id))
          Object.defineProperty(numbers, item.id, { value: next++, enumerable: true });
        for (const branch of item.branches) visit(branch.items);
      }
  };
  visit(outline.steps);
  for (const group of outline.unreachable) visit(group);
  return numbers;
}

// A layered layout for the read-only graph: the layer is the shortest depth from the trigger, steps the
// trigger does not reach take the layer after the last one, and rows follow document order in each layer.
function flowLayout(document) {
  const size = { width: 168, height: 56, gapX: 56, gapY: 24, pad: 16 };
  const depth = new Map();
  const trigger = flowTrigger(document);
  if (trigger) {
    depth.set(trigger.id, 0);
    const queue = [trigger.id];
    while (queue.length) {
      const id = queue.shift();
      for (const edge of document.edges)
        if (edge.from === id && !depth.has(edge.to) && flowNodeById(document, edge.to)) {
          depth.set(edge.to, depth.get(id) + 1);
          queue.push(edge.to);
        }
    }
  }
  const last = Math.max(-1, ...depth.values());
  const rows = [];
  const nodes = document.nodes.map((node) => {
    const layer = depth.has(node.id) ? depth.get(node.id) : last + 1;
    rows[layer] = (rows[layer] ?? 0) + 1;
    const row = rows[layer] - 1;
    return {
      id: node.id,
      type: node.type,
      layer,
      row,
      reachable: depth.has(node.id),
      x: size.pad + layer * (size.width + size.gapX),
      y: size.pad + row * (size.height + size.gapY),
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = document.edges
    .filter((edge) => byId.has(edge.from) && byId.has(edge.to))
    .map((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      return {
        from: edge.from,
        to: edge.to,
        port: edge.port,
        x1: from.x + size.width,
        y1: from.y + size.height / 2,
        x2: to.x,
        y2: to.y + size.height / 2,
      };
    });
  const layers = Math.max(0, ...nodes.map((node) => node.layer + 1));
  const height = Math.max(0, ...rows.filter((count) => count !== undefined));
  return {
    nodes,
    edges,
    nodeWidth: size.width,
    nodeHeight: size.height,
    width: layers ? size.pad * 2 + layers * size.width + (layers - 1) * size.gapX : 0,
    height: height ? size.pad * 2 + height * size.height + (height - 1) * size.gapY : 0,
  };
}

// A duration as the outline reads it. A stored wrong value (kept as typed) is named as such, never as a
// number of minutes.
function flowMinutes(minutes) {
  if (minutes === undefined || minutes === null || String(minutes).trim() === "") return "시간 미입력";
  if (!Number.isInteger(minutes) || minutes < 1) return "잘못된 시간";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return [days ? `${days}일` : "", hours ? `${hours}시간` : "", rest || (!days && !hours) ? `${rest}분` : ""]
    .filter(Boolean)
    .join(" ");
}
function flowValueText(value) {
  if (value === true) return "예";
  if (value === false) return "아니오";
  if (value === "") return "빈 텍스트";
  if (value === undefined || value === null) return "미입력";
  return String(value);
}

// One line that says what a step does. names maps IDs to display names: field(id), endpoint(id),
// connection(id); each returns null when the ID is unknown to the viewer.
function flowSummary(node, names) {
  const config = node.config ?? {};
  const field = (id) => (id ? (names.field(id) ?? "사용할 수 없는 필드") : "필드 미선택");
  switch (node.type) {
    case "instagram_comment": {
      const account = config.connection_id
        ? (names.connection(config.connection_id) ?? "알 수 없는 계정")
        : "계정 미선택";
      const media = config.media_id ? `게시물 ${config.media_id}` : "게시물 미입력";
      const keywords = flowStoredList(config.keywords);
      const match =
        config.match_mode === "all"
          ? "모든 댓글"
          : `${config.match_mode === "exact" ? "정확히 일치" : config.match_mode === "contains" ? "키워드 포함" : "조건 미선택"}: ${keywords.length ? keywords.join(", ") : "키워드 미입력"}`;
      const excluded = flowStoredList(config.excluded_keywords);
      return `${account} · ${media} · ${match}${excluded.length ? ` · 제외 ${excluded.join(", ")}` : ""}`;
    }
    case "instagram_message":
      return typeof config.text === "string" && config.text.trim() ? config.text : "메시지 미입력";
    case "has_tag":
      return config.tag ? `태그 "${config.tag}"가 있는지` : "태그 미입력";
    case "add_tag":
      return config.tag ? `태그 "${config.tag}" 추가` : "태그 미입력";
    case "remove_tag":
      return config.tag ? `태그 "${config.tag}" 제거` : "태그 미입력";
    case "field_equals": {
      const name = field(config.field_id);
      if (config.field_operator === "is_set") return `${name} 값이 있는지`;
      if (config.field_operator === "is_unset") return `${name} 값이 없는지`;
      return `${name} = ${flowValueText(config.field_value)}`;
    }
    case "set_field":
      return `${field(config.field_id)}에 ${flowValueText(config.value)} 저장`;
    case "delay":
      return `${flowMinutes(config.minutes)} 기다림`;
    case "wait_until":
      return config.time ? `작업 공간 시간대로 다음 ${config.time}까지 기다림` : "시각 미입력";
    case "wait_for_reply":
      return `${flowMinutes(config.timeout_minutes)} 동안 응답을 기다림${config.save_field_id ? ` · 응답을 ${field(config.save_field_id)}에 저장` : ""}`;
    case "webhook": {
      const endpoint = config.endpoint_id ? (names.endpoint(config.endpoint_id) ?? "등록한 주소") : "주소 미선택";
      const ids = Array.isArray(config.field_ids) ? config.field_ids : [];
      const sent = [...(config.include_tags === true ? ["태그"] : []), ...ids.map(field)];
      return `${endpoint}로 ${sent.length ? sent.join(", ") : "처리 정보만"} 전송`;
    }
    default:
      return "이 화면에서 편집할 수 없는 단계입니다.";
  }
}

// Every code validateFlowForPublish, flowExecutionErrors and the enable check return.
var flowErrorMessages = {
  invalid_document: "플로 문서 형식이 올바르지 않습니다. 최신 초안을 불러온 뒤 다시 편집해 주세요.",
  too_many_nodes: "단계는 최대 100개까지 만들 수 있습니다.",
  too_many_edges: "단계 사이의 연결은 최대 200개까지 만들 수 있습니다.",
  document_too_large: "플로가 너무 큽니다. 메시지나 단계를 줄여 주세요.",
  invalid_node: "단계의 형식이 올바르지 않습니다.",
  duplicate_node_id: "같은 ID를 쓰는 단계가 둘 이상 있습니다.",
  invalid_edge: "단계 사이의 연결 형식이 올바르지 않습니다.",
  unknown_node_type: "지원하지 않는 종류의 단계입니다. 삭제해 주세요.",
  invalid_config: "이 단계의 설정을 모두 채우고 형식과 범위를 확인해 주세요.",
  unknown_field: "보관됐거나 없는 필드를 사용합니다. 다른 필드를 선택해 주세요.",
  invalid_field_value: "선택한 필드의 종류에 맞는 값을 입력해 주세요.",
  invalid_field_type: "응답은 텍스트 필드에만 저장할 수 있습니다.",
  reply_field_not_sendable:
    "응답을 저장하는 필드는 외부로 보낼 수 없습니다. 이 플로나 다른 플로에서 응답 저장과 외부 전송에 같은 필드를 쓰고 있습니다.",
  endpoint_unavailable: "켜져 있는 외부 전송 주소를 선택해 주세요.",
  invalid_variable: "메시지 변수는 {{comment.text}}와 {{field:필드 ID}}만 쓸 수 있습니다.",
  trigger_count: "댓글 트리거가 정확히 하나 있어야 합니다.",
  missing_reference: "없는 단계로 이어지는 연결이 있습니다.",
  invalid_port: "이 단계에 없는 가지로 연결되어 있습니다.",
  duplicate_port: "한 가지에 연결이 둘 이상 있습니다.",
  trigger_has_incoming: "댓글 트리거 앞에는 단계를 연결할 수 없습니다.",
  wait_requires_message: "응답 기다리기는 메시지 보내기 바로 뒤에만 둘 수 있습니다.",
  unreachable_node: "댓글 트리거에서 이어지지 않는 단계입니다. 연결하거나 삭제해 주세요.",
  message_after_wait: "응답 기다리기 뒤에는 메시지를 보낼 수 없습니다.",
  immediate_cycle: "단계가 돌아서 다시 이어지는 연결이 있습니다. 순환을 끊어 주세요.",
  delay_exceeds_reply_window: "메시지 앞의 지연과 시각 대기를 합치면 댓글 답장 기간(7일)을 넘습니다.",
  connection_unavailable: "트리거의 Instagram 계정이 연결되어 있고 수신이 켜져 있는지 확인해 주세요.",
  login_mode_required: "이 계정은 Instagram 로그인으로 다시 연결해야 플로를 켤 수 있습니다.",
  legacy_rule_conflict: "같은 게시물에 켜진 댓글 자동화 규칙이 있습니다. 규칙을 끄거나 다른 게시물을 선택해 주세요.",
  flow_trigger_conflict: "같은 게시물을 쓰는 다른 발행 플로가 있습니다. 다른 게시물을 선택해 주세요.",
  unsupported_node: "지금은 실행할 수 없는 종류의 단계입니다. 삭제해 주세요.",
  unsupported_message: "확인 버튼이 있는 메시지는 지금 실행할 수 없습니다.",
  unsupported_variable: "예/아니요 필드는 메시지 변수로 쓸 수 없습니다.",
  unsupported_after_message: "메시지 보내기 뒤에는 응답 기다리기만 이어질 수 있습니다.",
};
function flowErrorMessage(code) {
  return Object.hasOwn(flowErrorMessages, code) ? flowErrorMessages[code] : `확인이 필요한 문제가 있습니다(${code}).`;
}
function flowKnownError(code) {
  return Object.hasOwn(flowErrorMessages, code);
}

// Places publish and test-run errors on the steps they name. An edge error goes to the step at the end
// its path names (`.to`), otherwise to the step it leaves; a node path without node_id uses the index.
// What names no existing step stays general.
function flowPlaceErrors(document, errors) {
  const placed = [];
  const general = [];
  const exists = (id) => typeof id === "string" && document.nodes.some((node) => node.id === id);
  for (const error of errors) {
    let id = error.node_id;
    if (!exists(id) && Number.isInteger(error.edge_index)) {
      const edge = document.edges[error.edge_index];
      if (edge)
        id = /\.to$/.test(error.path ?? "") && exists(edge.to) ? edge.to : exists(edge.from) ? edge.from : edge.to;
    }
    if (!exists(id)) {
      const index = /^nodes\[(\d+)\]/.exec(error.path ?? "");
      if (index) id = document.nodes[Number(index[1])]?.id;
    }
    if (exists(id)) placed.push({ node_id: id, code: error.code, message: flowErrorMessage(error.code) });
    else general.push({ code: error.code, message: flowErrorMessage(error.code) });
  }
  return { placed, general };
}

// Whether two flow documents hold the same content. The server returns jsonb, which reorders object keys,
// while the editor builds keys in insertion order, so keys are compared sorted and arrays in order.
function flowCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(flowCanonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${flowCanonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function flowSameDocument(left, right) {
  return Boolean(left && right) && flowCanonical(left) === flowCanonical(right);
}
function flowReadable(document) {
  return Boolean(document) && Array.isArray(document.nodes) && Array.isArray(document.edges);
}
// Step names ("<number>. <type>") in the outline order of one document, such as the published version a
// test run or the enable check read. Without a readable document the step ID is all there is.
function flowStepLabels(document) {
  if (!flowReadable(document)) return (id) => `단계 ${id}`;
  const numbers = flowStepNumbers(flowOutline(document));
  return (id) => {
    const node = flowNodeById(document, id);
    return node ? `${numbers[id] ?? "?"}. ${flowTypeLabel(node.type)}` : "없는 단계";
  };
}
// Errors about a document other than the draft on screen (a published version, or a draft that was
// edited while it was checked) cannot be placed on the draft's steps, whose IDs may name other steps; they all stay general, start with
// `source` (such as "발행 버전 v2") and name the step in that document.
function flowErrorsElsewhere(document, errors, source) {
  const label = flowStepLabels(document);
  const { placed, general } = flowPlaceErrors(flowReadable(document) ? document : { nodes: [], edges: [] }, errors);
  return [
    ...general.map((error) => ({ code: error.code, message: `${source}: ${error.message}` })),
    ...placed.map((error) => ({ code: error.code, message: `${source}의 ${label(error.node_id)}: ${error.message}` })),
  ];
}
// The value a new "set field" step stores for its first field: a yes/no field starts at yes, as its
// select shows; other types start empty, as their inputs show.
function flowFieldDefault(field) {
  return field?.type === "boolean" ? true : "";
}

// The field IDs a webhook step names that the field list no longer has (archived or deleted), in their
// stored spelling and order and without repeats. The editor shows each as a checked box the user can
// uncheck, so the step can be repaired without deleting it.
function flowUnavailableFieldIds(ids, fields) {
  const known = new Set(fields.map((field) => String(field.id).toLowerCase()));
  const seen = new Set();
  return flowStoredList(ids).filter((id) => {
    const key = String(id).toLowerCase();
    if (known.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
// The field_ids a webhook step stores: the checked boxes only, unavailable ones included while checked.
function flowCheckedFieldIds(boxes) {
  return boxes.filter((box) => box.checked).map((box) => box.value);
}

var flowTestStatuses = {
  not_matched: "댓글이 트리거 조건에 맞지 않아 실행을 만들지 않습니다.",
  ended: "마지막 단계까지 진행했습니다.",
  delivering: "마지막 메시지를 발송 대기열에 넣는 데까지 진행합니다.",
  failed: "실행이 실패로 끝납니다.",
};
// Failure codes a test run returns: planFlowRun's and the test-run step limit.
var flowFailureMessages = {
  invalid_definition: "단계 설정을 읽을 수 없습니다.",
  field_unavailable: "값을 저장할 필드가 보관됐거나 없습니다.",
  variable_missing: "메시지 변수에 쓸 필드 값이 없습니다.",
  unsupported_variable: "예/아니요 필드는 메시지 변수로 쓸 수 없습니다.",
  message_empty: "변수를 채운 메시지가 비어 있습니다.",
  message_too_long: "변수를 채운 메시지가 1,000자를 넘습니다.",
  unsupported_node: "실행할 수 없는 단계를 만났습니다.",
  step_limit: "단계 수 한도를 넘었습니다.",
  test_run_limit: "테스트 실행의 재개 횟수나 단계 수 한도를 넘었습니다.",
};
// Step outcomes as planFlowRun records them.
var flowOutcomes = {
  next: "다음으로 진행",
  true: "예로 진행",
  false: "아니오로 진행",
  added: "태그 추가",
  removed: "태그 제거",
  absent: "없는 태그라 그대로",
  already_present: "이미 있는 태그라 그대로",
  tag_limit: "태그가 20개라 추가하지 않음",
  set: "값 저장",
  unchanged: "같은 값이라 그대로",
  queued: "대기열에 넣음",
  waiting: "기다림",
  replied: "응답 받음으로 진행",
  timeout: "시간 초과로 진행",
  reply_invalid: "응답을 저장할 수 없는 값이라 저장하지 않음",
  // A reply wait records this and still continues; a field step fails with the same outcome.
  field_unavailable: "저장할 필드가 보관됐거나 없음",
};
function flowTestStatus(status) {
  return Object.hasOwn(flowTestStatuses, status) ? flowTestStatuses[status] : `알 수 없는 결과(${status})`;
}
function flowFailureMessage(code) {
  if (!code) return "";
  return Object.hasOwn(flowFailureMessages, code) ? flowFailureMessages[code] : `기타 실패(${code})`;
}
function flowOutcome(outcome) {
  if (Object.hasOwn(flowOutcomes, outcome)) return flowOutcomes[outcome];
  if (Object.hasOwn(flowFailureMessages, outcome)) return `실패: ${flowFailureMessages[outcome]}`;
  return `기타 결과(${outcome})`;
}
// How the test run continued after a delay, a time wait or a reply wait.
function flowWaitText(wait) {
  if (wait.node_type === "delay") return `${flowMinutes(wait.delay_minutes)} 지난 것으로 보고 다음으로 이어 갔습니다.`;
  if (wait.node_type === "wait_until") return `${wait.until_time}이 된 것으로 보고 다음으로 이어 갔습니다.`;
  return `${flowPortLabel(wait.port)} 가지로 이어 갔습니다.`;
}
// The node IDs on a test-run path, in order and without repeats.
function flowPathIds(steps) {
  return [...new Set(steps.map((step) => step.node_id))];
}
// The edges a test-run path followed, as `from:port:to` keys. A step with several ports records the port it
// took as its outcome (a reply wait may add a second step for the saved reply); a one-port step leaves by
// that port. Two branches of a step that lead to the same step therefore stay apart.
function flowPathEdges(steps) {
  const visits = [];
  for (const step of steps) {
    let visit = visits[visits.length - 1];
    if (visit?.id !== step.node_id) {
      const ports = flowPorts(step.node_type);
      visit = { id: step.node_id, ports, port: ports.length === 1 ? ports[0] : undefined };
      visits.push(visit);
    }
    if (visit.port === undefined && visit.ports.includes(step.outcome)) visit.port = step.outcome;
  }
  const edges = [];
  for (let index = 1; index < visits.length; index++) {
    const from = visits[index - 1];
    if (from.port !== undefined) edges.push(`${from.id}:${from.port}:${visits[index].id}`);
  }
  return edges;
}
