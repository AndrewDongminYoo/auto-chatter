// Pure helpers for the contact filter's condition tree editor (#26): draft operations, limits, build and Korean text.
// Classic script with top-level functions only: src/app/condition-tree-model.test.ts runs it in a node:vm context,
// and every name starts with "segmentTree" so it cannot collide with app.js in the shared global scope.
// src/app/contacts.ts (parseConditionTree) owns the tree contract and stays the authority for normalization and
// validation; this file mirrors its limits so the screen can refuse an operation instead of sending it.
//
// A draft has the tree's shape, and each leaf holds the raw input of one condition row:
// { kind: "tag" | "no_tag" | "field", tag, field_id, field_operator, value, boolean }. Every operation returns a new
// draft and leaves its input unchanged; a refused operation returns an unchanged copy with the reason.

// Limits from src/app/contacts.ts (CONDITION_TREE_*).
var segmentTreeLimits = { groups: 5, groupLeaves: 5, leaves: 10 };
var segmentTreeKinds = ["tag", "no_tag", "field"];
var segmentTreeLeafKeys = ["kind", "tag", "field_id", "field_operator", "value", "boolean"];

function segmentTreeCopy(draft) {
  return JSON.parse(JSON.stringify(draft));
}
function segmentTreeEmpty() {
  return { mode: "all", groups: [{ mode: "all", conditions: [] }] };
}
function segmentTreeLeaf(kind) {
  return {
    kind: segmentTreeKinds.includes(kind) ? kind : "tag",
    tag: "",
    field_id: "",
    field_operator: "eq",
    value: "",
    boolean: "true",
  };
}
function segmentTreeNeedsValue(operator) {
  return ["eq", "gt", "gte", "lt", "lte"].includes(operator);
}
// The operators a field type takes, in the order of the field rows; ordered comparisons need a number or a date.
function segmentTreeOperators(type) {
  return type === "number" || type === "date"
    ? ["eq", "gte", "gt", "lte", "lt", "is_set", "is_unset"]
    : ["eq", "is_set", "is_unset"];
}
// A saved tree (the server's response shape) as a draft, read the way the field rows read a saved condition.
function segmentTreeFromSaved(tree) {
  if (!tree) return null;
  return {
    mode: tree.mode,
    groups: tree.groups.map((group) => ({
      mode: group.mode,
      conditions: group.conditions.map((leaf) => {
        if ("tag" in leaf) return { ...segmentTreeLeaf(leaf.negate ? "no_tag" : "tag"), tag: leaf.tag };
        const valued = segmentTreeNeedsValue(leaf.field_operator);
        return {
          ...segmentTreeLeaf("field"),
          field_id: leaf.field_id,
          field_operator: leaf.field_operator,
          value: valued && typeof leaf.field_value !== "boolean" ? String(leaf.field_value) : "",
          boolean: leaf.field_value === false ? "false" : "true",
        };
      }),
    })),
  };
}
function segmentTreeLeafCount(draft) {
  return draft.groups.reduce((total, group) => total + group.conditions.length, 0);
}
function segmentTreeResult(draft, error = "") {
  return { draft: segmentTreeCopy(draft), error };
}
function segmentTreeHasGroup(draft, group) {
  return Number.isInteger(group) && group >= 0 && group < draft.groups.length;
}
function segmentTreeHasLeaf(draft, group, leaf) {
  return Number.isInteger(leaf) && leaf >= 0 && leaf < draft.groups[group].conditions.length;
}
// The reason a control is disabled, or "" when the operation is allowed. A new group starts empty, so a tree that
// already holds ten leaves could never fill it.
function segmentTreeAddGroupBlock(draft) {
  if (draft.groups.length >= segmentTreeLimits.groups) return "그룹은 최대 5개까지 만들 수 있습니다.";
  if (segmentTreeLeafCount(draft) >= segmentTreeLimits.leaves)
    return "조건은 모든 그룹을 합쳐 최대 10개이므로 그룹을 더 추가할 수 없습니다.";
  return "";
}
function segmentTreeAddLeafBlock(draft, group) {
  if (!segmentTreeHasGroup(draft, group)) return "그룹을 찾을 수 없습니다.";
  if (draft.groups[group].conditions.length >= segmentTreeLimits.groupLeaves)
    return "그룹 하나에는 조건을 최대 5개까지 넣을 수 있습니다.";
  if (segmentTreeLeafCount(draft) >= segmentTreeLimits.leaves)
    return "조건은 모든 그룹을 합쳐 최대 10개까지 넣을 수 있습니다.";
  return "";
}
function segmentTreeRemoveGroupBlock(draft) {
  return draft.groups.length > 1
    ? ""
    : "그룹은 하나 이상 있어야 합니다. 그룹 조건을 쓰지 않으려면 그룹 조건 지우기를 눌러 주세요.";
}
function segmentTreeAddGroup(draft) {
  const block = segmentTreeAddGroupBlock(draft);
  if (block) return segmentTreeResult(draft, block);
  const next = segmentTreeCopy(draft);
  next.groups.push({ mode: "all", conditions: [] });
  return { draft: next, error: "" };
}
function segmentTreeRemoveGroup(draft, group) {
  if (!segmentTreeHasGroup(draft, group)) return segmentTreeResult(draft, "그룹을 찾을 수 없습니다.");
  const block = segmentTreeRemoveGroupBlock(draft);
  if (block) return segmentTreeResult(draft, block);
  const next = segmentTreeCopy(draft);
  next.groups.splice(group, 1);
  return { draft: next, error: "" };
}
function segmentTreeAddLeaf(draft, group, kind = "tag") {
  const block = segmentTreeAddLeafBlock(draft, group);
  if (block) return segmentTreeResult(draft, block);
  const next = segmentTreeCopy(draft);
  next.groups[group].conditions.push(segmentTreeLeaf(kind));
  return { draft: next, error: "" };
}
// A group may become empty; the build then refuses it until a leaf is added or the group is removed.
function segmentTreeRemoveLeaf(draft, group, leaf) {
  if (!segmentTreeHasGroup(draft, group)) return segmentTreeResult(draft, "그룹을 찾을 수 없습니다.");
  if (!segmentTreeHasLeaf(draft, group, leaf)) return segmentTreeResult(draft, "조건을 찾을 수 없습니다.");
  const next = segmentTreeCopy(draft);
  next.groups[group].conditions.splice(leaf, 1);
  return { draft: next, error: "" };
}
// Moves one item of a list by one place (delta -1 or 1), in place.
function segmentTreeSwap(list, index, delta) {
  if (delta !== -1 && delta !== 1) return "한 칸씩만 옮길 수 있습니다.";
  if (index + delta < 0) return "더 위로 옮길 수 없습니다.";
  if (index + delta >= list.length) return "더 아래로 옮길 수 없습니다.";
  [list[index], list[index + delta]] = [list[index + delta], list[index]];
  return "";
}
function segmentTreeMoveGroup(draft, group, delta) {
  if (!segmentTreeHasGroup(draft, group)) return segmentTreeResult(draft, "그룹을 찾을 수 없습니다.");
  const next = segmentTreeCopy(draft);
  const error = segmentTreeSwap(next.groups, group, delta);
  return error ? segmentTreeResult(draft, error) : { draft: next, error };
}
// A leaf moves only within its group.
function segmentTreeMoveLeaf(draft, group, leaf, delta) {
  if (!segmentTreeHasGroup(draft, group)) return segmentTreeResult(draft, "그룹을 찾을 수 없습니다.");
  if (!segmentTreeHasLeaf(draft, group, leaf)) return segmentTreeResult(draft, "조건을 찾을 수 없습니다.");
  const next = segmentTreeCopy(draft);
  const error = segmentTreeSwap(next.groups[group].conditions, leaf, delta);
  return error ? segmentTreeResult(draft, error) : { draft: next, error };
}
// group null sets the root mode.
function segmentTreeSetMode(draft, group, mode) {
  if (group !== null && !segmentTreeHasGroup(draft, group)) return segmentTreeResult(draft, "그룹을 찾을 수 없습니다.");
  if (mode !== "all" && mode !== "any") return segmentTreeResult(draft, "결합 방식을 확인할 수 없습니다.");
  const next = segmentTreeCopy(draft);
  (group === null ? next : next.groups[group]).mode = mode;
  return { draft: next, error: "" };
}
// Changes the raw input of one leaf. A kind change keeps the other inputs, so switching back restores them.
function segmentTreeSetLeaf(draft, group, leaf, changes) {
  if (!segmentTreeHasGroup(draft, group)) return segmentTreeResult(draft, "그룹을 찾을 수 없습니다.");
  if (!segmentTreeHasLeaf(draft, group, leaf)) return segmentTreeResult(draft, "조건을 찾을 수 없습니다.");
  for (const [key, value] of Object.entries(changes))
    if (!segmentTreeLeafKeys.includes(key) || typeof value !== "string")
      return segmentTreeResult(draft, "조건 값을 확인할 수 없습니다.");
  if ("kind" in changes && !segmentTreeKinds.includes(changes.kind))
    return segmentTreeResult(draft, "조건 종류를 확인할 수 없습니다.");
  const next = segmentTreeCopy(draft);
  Object.assign(next.groups[group].conditions[leaf], changes);
  return { draft: next, error: "" };
}
// One draft leaf as the server's leaf, or a Korean reason it is incomplete. Values are typed as the field rows type
// them (typedFieldValue in app.js); the server checks the field, operator and value again.
function segmentTreeBuildLeaf(leaf, fields, place) {
  if (leaf.kind === "tag" || leaf.kind === "no_tag") {
    if (!leaf.tag.trim()) return { error: `${place}에 태그를 입력해 주세요.` };
    return { leaf: leaf.kind === "no_tag" ? { tag: leaf.tag, negate: true } : { tag: leaf.tag } };
  }
  if (leaf.kind !== "field") return { error: "조건 종류를 확인할 수 없습니다." };
  if (!leaf.field_id) return { error: `${place}에서 추가 정보 필드를 선택해 주세요.` };
  const field = fields.find((definition) => definition.id === leaf.field_id);
  if (!field) return { error: `${place}의 필드를 사용할 수 없습니다. 다른 필드를 선택하거나 조건을 삭제해 주세요.` };
  if (!segmentTreeOperators(field.type).includes(leaf.field_operator))
    return { error: `${place}에서 이 필드에 쓸 수 없는 비교 방식을 골랐습니다.` };
  const condition = { field_id: field.id, field_operator: leaf.field_operator };
  if (!segmentTreeNeedsValue(leaf.field_operator)) return { leaf: condition };
  if (field.type === "number") {
    if (!leaf.value.trim() || !Number.isFinite(Number(leaf.value)))
      return { error: `${place}에 숫자 값을 입력해 주세요.` };
    return { leaf: { ...condition, field_value: Number(leaf.value) } };
  }
  if (field.type === "boolean") {
    if (leaf.boolean !== "true" && leaf.boolean !== "false")
      return { error: `${place}에서 예 또는 아니요를 골라 주세요.` };
    return { leaf: { ...condition, field_value: leaf.boolean === "true" } };
  }
  if (field.type === "date" && !leaf.value) return { error: `${place}에 날짜를 입력해 주세요.` };
  // Empty text is a set value.
  return { leaf: { ...condition, field_value: leaf.value } };
}
// The canonical condition_tree for a request, or the first reason the draft cannot be sent. Tags go as typed; the
// server normalizes them. fields are the workspace's active field definitions ({ id, type }).
function segmentTreeBuild(draft, fields) {
  if (!draft) return { tree: null, error: "" };
  const modeError = "결합 방식을 확인할 수 없습니다.";
  if (![draft.mode, ...draft.groups.map((group) => group.mode)].every((mode) => mode === "all" || mode === "any"))
    return { tree: null, error: modeError };
  if (
    !draft.groups.length ||
    draft.groups.length > segmentTreeLimits.groups ||
    draft.groups.some((group) => group.conditions.length > segmentTreeLimits.groupLeaves) ||
    segmentTreeLeafCount(draft) > segmentTreeLimits.leaves
  )
    return { tree: null, error: "그룹 조건은 그룹 1~5개, 그룹마다 조건 1~5개, 모두 합쳐 조건 10개까지입니다." };
  const groups = [];
  for (const [groupIndex, group] of draft.groups.entries()) {
    if (!group.conditions.length)
      return { tree: null, error: `그룹 ${groupIndex + 1}에 조건을 하나 이상 추가해 주세요.` };
    const conditions = [];
    for (const [leafIndex, leaf] of group.conditions.entries()) {
      const built = segmentTreeBuildLeaf(leaf, fields, `그룹 ${groupIndex + 1}의 조건 ${leafIndex + 1}`);
      if (built.error) return { tree: null, error: built.error };
      conditions.push(built.leaf);
    }
    groups.push({ mode: group.mode, conditions });
  }
  return { tree: { mode: draft.mode, groups }, error: "" };
}
// The inputs of a draft that a request would carry, in order; input a leaf of its kind does not send is left out.
function segmentTreeKey(draft) {
  if (!draft) return null;
  return JSON.stringify([
    draft.mode,
    draft.groups.map((group) => [
      group.mode,
      group.conditions.map((leaf) =>
        leaf.kind === "field"
          ? [
              leaf.kind,
              leaf.field_id,
              leaf.field_operator,
              ...(segmentTreeNeedsValue(leaf.field_operator) ? [leaf.value, leaf.boolean] : []),
            ]
          : [leaf.kind, leaf.tag],
      ),
    ]),
  ]);
}
// True when two drafts (or two absent drafts) carry the same conditions. Order matters, as in the server's unchanged
// check, so a move is a change and moving back undoes it. Unlike the server, a case-only tag change counts.
function segmentTreeSame(left, right) {
  return segmentTreeKey(left) === segmentTreeKey(right);
}
// True when discarding the draft would lose conditions: it has at least one, and no saved tree (the condition_tree
// values of the saved filters, absent for a filter without one) is the same, so selecting a filter cannot bring it back.
function segmentTreeUnsaved(draft, savedTrees) {
  if (!draft || segmentTreeLeafCount(draft) === 0) return false;
  return !savedTrees.some((tree) => tree && segmentTreeSame(draft, segmentTreeFromSaved(tree)));
}
// Removes every field leaf of an archived field; a group it empties stays, so the draft becomes incomplete.
function segmentTreeRemoveField(draft, fieldId) {
  if (!draft) return { draft: null, removed: 0 };
  const id = String(fieldId).toLowerCase();
  const next = segmentTreeCopy(draft);
  let removed = 0;
  for (const group of next.groups) {
    const kept = group.conditions.filter((leaf) => !(leaf.kind === "field" && leaf.field_id.toLowerCase() === id));
    removed += group.conditions.length - kept.length;
    group.conditions = kept;
  }
  return { draft: next, removed };
}
// A saved or built tree as one line: each group in parentheses, joined by the root mode, its leaves by the group
// mode. fieldText describes one field leaf, since field names and operator labels live with the screen.
function segmentTreeSummary(tree, fieldText) {
  const join = (mode) => (mode === "any" ? " 또는 " : " 그리고 ");
  return tree.groups
    .map(
      (group) =>
        `(${group.conditions
          .map((leaf) => ("tag" in leaf ? `태그 ${leaf.tag} ${leaf.negate ? "없음" : "있음"}` : fieldText(leaf)))
          .join(join(group.mode))})`,
    )
    .join(join(tree.mode));
}
