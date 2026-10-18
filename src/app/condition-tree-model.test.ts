import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { CONDITION_TREE_GROUP_LEAF_LIMIT, CONDITION_TREE_GROUP_LIMIT, CONDITION_TREE_LEAF_LIMIT } from "./contacts.ts";

type Kind = "tag" | "no_tag" | "field";
type DraftLeaf = { kind: Kind; tag: string; field_id: string; field_operator: string; value: string; boolean: string };
type Draft = { mode: string; groups: { mode: string; conditions: DraftLeaf[] }[] };
type Tree = { mode: string; groups: { mode: string; conditions: Record<string, unknown>[] }[] };
type Result = { draft: Draft; error: string };
interface TreeModel {
  segmentTreeLimits: { groups: number; groupLeaves: number; leaves: number };
  segmentTreeEmpty(): Draft;
  segmentTreeLeaf(kind?: string): DraftLeaf;
  segmentTreeFromSaved(tree: Tree | null | undefined): Draft | null;
  segmentTreeLeafCount(draft: Draft): number;
  segmentTreeAddGroupBlock(draft: Draft): string;
  segmentTreeAddLeafBlock(draft: Draft, group: number): string;
  segmentTreeRemoveGroupBlock(draft: Draft): string;
  segmentTreeAddGroup(draft: Draft): Result;
  segmentTreeRemoveGroup(draft: Draft, group: number): Result;
  segmentTreeAddLeaf(draft: Draft, group: number, kind?: string): Result;
  segmentTreeRemoveLeaf(draft: Draft, group: number, leaf: number): Result;
  segmentTreeMoveGroup(draft: Draft, group: number, delta: number): Result;
  segmentTreeMoveLeaf(draft: Draft, group: number, leaf: number, delta: number): Result;
  segmentTreeSetMode(draft: Draft, group: number | null, mode: string): Result;
  segmentTreeSetLeaf(draft: Draft, group: number, leaf: number, changes: Record<string, unknown>): Result;
  segmentTreeOperators(type: string | undefined): string[];
  segmentTreeNeedsValue(operator: string): boolean;
  segmentTreeBuild(draft: Draft | null, fields: { id: string; type: string }[]): { tree: Tree | null; error: string };
  segmentTreeSame(left: Draft | null, right: Draft | null, fields?: { id: string; type: string }[]): boolean;
  segmentTreeUnsaved(
    draft: Draft | null,
    savedTrees: (Tree | null | undefined)[],
    fields?: { id: string; type: string }[],
  ): boolean;
  segmentTreeRemoveField(draft: Draft | null, fieldId: string): { draft: Draft | null; removed: number };
  segmentTreeSummary(tree: Tree, fieldText: (leaf: Record<string, unknown>) => string): string;
}

// public/app/condition-tree-model.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/condition-tree-model.js", import.meta.url), "utf8"), context);
const model = context as unknown as TreeModel;
// Values built in the vm context have that realm's prototypes; a JSON round trip makes them comparable.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const textField = "22222222-2222-4222-8222-222222222222";
const numberField = "33333333-3333-4333-8333-333333333333";
const booleanField = "44444444-4444-4444-8444-444444444444";
const dateField = "55555555-5555-4555-8555-555555555555";
const fields = [
  { id: textField, type: "text" },
  { id: numberField, type: "number" },
  { id: booleanField, type: "boolean" },
  { id: dateField, type: "date" },
];

const tagLeaf = (tag: string, kind: Kind = "tag"): DraftLeaf => ({ ...model.segmentTreeLeaf(kind), tag });
const fieldLeaf = (field_id: string, field_operator: string, value = "", boolean = "true"): DraftLeaf => ({
  ...model.segmentTreeLeaf("field"),
  field_id,
  field_operator,
  value,
  boolean,
});
// A draft of the given group sizes; every leaf is a distinct tag, so the draft builds.
function draftOf(...sizes: number[]): Draft {
  let next = 0;
  return {
    mode: "all",
    groups: sizes.map((size) => ({
      mode: "all",
      conditions: Array.from({ length: size }, () => tagLeaf(`t${++next}`)),
    })),
  };
}
const tags = (draft: Draft) => plain(draft.groups.map((group) => group.conditions.map((leaf) => leaf.tag)));

test("the model mirrors the server's tree limits", () => {
  assert.deepEqual(plain(model.segmentTreeLimits), {
    groups: CONDITION_TREE_GROUP_LIMIT,
    groupLeaves: CONDITION_TREE_GROUP_LEAF_LIMIT,
    leaves: CONDITION_TREE_LEAF_LIMIT,
  });
});

test("an empty draft is one all group with no leaf yet, and it does not build", () => {
  const draft = model.segmentTreeEmpty();
  assert.deepEqual(plain(draft), { mode: "all", groups: [{ mode: "all", conditions: [] }] });
  assert.deepEqual(plain(model.segmentTreeBuild(draft, fields)), {
    tree: null,
    error: "그룹 1에 조건을 하나 이상 추가해 주세요.",
  });
  // Each call returns a new draft.
  assert.notEqual(model.segmentTreeEmpty(), model.segmentTreeEmpty());
  assert.deepEqual(plain(model.segmentTreeLeaf()), {
    kind: "tag",
    tag: "",
    field_id: "",
    field_operator: "eq",
    value: "",
    boolean: "true",
  });
  assert.equal(model.segmentTreeLeaf("field").kind, "field");
  assert.equal(model.segmentTreeLeaf("unknown").kind, "tag");
});

test("adding groups stops at five groups and at ten leaves, with the reason", () => {
  let draft = draftOf(1);
  for (let count = 2; count <= 5; count++) {
    assert.equal(model.segmentTreeAddGroupBlock(draft), "");
    const result = model.segmentTreeAddGroup(draft);
    assert.equal(result.error, "");
    assert.equal(result.draft.groups.length, count);
    assert.deepEqual(plain(result.draft.groups[count - 1]), { mode: "all", conditions: [] });
    draft = result.draft;
  }
  const refused = model.segmentTreeAddGroup(draft);
  assert.equal(refused.error, "그룹은 최대 5개까지 만들 수 있습니다.");
  assert.equal(model.segmentTreeAddGroupBlock(draft), refused.error);
  assert.equal(refused.draft.groups.length, 5);
  // Ten leaves leave nothing to put in a new group.
  const full = draftOf(5, 5);
  assert.equal(
    model.segmentTreeAddGroup(full).error,
    "조건은 모든 그룹을 합쳐 최대 10개이므로 그룹을 더 추가할 수 없습니다.",
  );
  assert.equal(model.segmentTreeAddGroup(full).draft.groups.length, 2);
  assert.equal(model.segmentTreeAddGroup(draftOf(5, 4)).error, "");
  // The input draft is never changed.
  const before = plain(draftOf(1));
  const input = draftOf(1);
  model.segmentTreeAddGroup(input);
  assert.deepEqual(plain(input), before);
});

test("removing a group keeps at least one group", () => {
  const draft = draftOf(1, 2, 3);
  const removed = model.segmentTreeRemoveGroup(draft, 1);
  assert.equal(removed.error, "");
  assert.deepEqual(tags(removed.draft), [["t1"], ["t4", "t5", "t6"]]);
  assert.equal(model.segmentTreeRemoveGroupBlock(draft), "");
  const single = draftOf(2);
  const refused = model.segmentTreeRemoveGroup(single, 0);
  assert.equal(
    refused.error,
    "그룹은 하나 이상 있어야 합니다. 그룹 조건을 쓰지 않으려면 그룹 조건 지우기를 눌러 주세요.",
  );
  assert.equal(model.segmentTreeRemoveGroupBlock(single), refused.error);
  assert.deepEqual(tags(refused.draft), [["t1", "t2"]]);
  assert.equal(model.segmentTreeRemoveGroup(draft, 3).error, "그룹을 찾을 수 없습니다.");
  assert.equal(model.segmentTreeRemoveGroup(draft, -1).error, "그룹을 찾을 수 없습니다.");
});

test("adding leaves stops at five per group and ten in all, with the reason", () => {
  const four = model.segmentTreeAddLeaf(draftOf(4), 0);
  assert.equal(four.error, "");
  assert.equal(four.draft.groups[0].conditions.length, 5);
  assert.deepEqual(plain(four.draft.groups[0].conditions[4]), plain(model.segmentTreeLeaf()));
  const groupFull = model.segmentTreeAddLeaf(four.draft, 0);
  assert.equal(groupFull.error, "그룹 하나에는 조건을 최대 5개까지 넣을 수 있습니다.");
  assert.equal(model.segmentTreeAddLeafBlock(four.draft, 0), groupFull.error);
  assert.equal(groupFull.draft.groups[0].conditions.length, 5);
  // Nine leaves take a tenth; ten refuse an eleventh even in a group with room.
  const nine = draftOf(5, 3, 1);
  assert.equal(model.segmentTreeAddLeafBlock(nine, 2), "");
  const ten = model.segmentTreeAddLeaf(nine, 2, "field");
  assert.equal(ten.error, "");
  assert.equal(model.segmentTreeLeafCount(ten.draft), 10);
  assert.equal(ten.draft.groups[2].conditions[1].kind, "field");
  const eleven = model.segmentTreeAddLeaf(ten.draft, 1);
  assert.equal(eleven.error, "조건은 모든 그룹을 합쳐 최대 10개까지 넣을 수 있습니다.");
  assert.equal(model.segmentTreeAddLeafBlock(ten.draft, 1), eleven.error);
  assert.equal(model.segmentTreeLeafCount(eleven.draft), 10);
  assert.equal(model.segmentTreeAddLeaf(nine, 5).error, "그룹을 찾을 수 없습니다.");
});

test("removing a leaf may empty its group, which then does not build", () => {
  const draft = draftOf(2, 1);
  const first = model.segmentTreeRemoveLeaf(draft, 0, 0);
  assert.equal(first.error, "");
  assert.deepEqual(tags(first.draft), [["t2"], ["t3"]]);
  const emptied = model.segmentTreeRemoveLeaf(first.draft, 1, 0);
  assert.equal(emptied.error, "");
  assert.deepEqual(tags(emptied.draft), [["t2"], []]);
  assert.equal(model.segmentTreeBuild(emptied.draft, fields).error, "그룹 2에 조건을 하나 이상 추가해 주세요.");
  assert.equal(model.segmentTreeRemoveLeaf(draft, 0, 2).error, "조건을 찾을 수 없습니다.");
  assert.equal(model.segmentTreeRemoveLeaf(draft, 2, 0).error, "그룹을 찾을 수 없습니다.");
});

test("groups and leaves move one place within their parent and refuse at the ends", () => {
  const draft = draftOf(2, 1, 1);
  assert.deepEqual(tags(model.segmentTreeMoveGroup(draft, 0, 1).draft), [["t3"], ["t1", "t2"], ["t4"]]);
  assert.deepEqual(tags(model.segmentTreeMoveGroup(draft, 2, -1).draft), [["t1", "t2"], ["t4"], ["t3"]]);
  assert.equal(model.segmentTreeMoveGroup(draft, 0, -1).error, "더 위로 옮길 수 없습니다.");
  assert.equal(model.segmentTreeMoveGroup(draft, 2, 1).error, "더 아래로 옮길 수 없습니다.");
  assert.deepEqual(tags(model.segmentTreeMoveGroup(draft, 2, 1).draft), tags(draft));
  assert.equal(model.segmentTreeMoveGroup(draft, 3, -1).error, "그룹을 찾을 수 없습니다.");
  assert.deepEqual(tags(model.segmentTreeMoveLeaf(draft, 0, 0, 1).draft), [["t2", "t1"], ["t3"], ["t4"]]);
  assert.deepEqual(tags(model.segmentTreeMoveLeaf(draft, 0, 1, -1).draft), [["t2", "t1"], ["t3"], ["t4"]]);
  assert.equal(model.segmentTreeMoveLeaf(draft, 0, 0, -1).error, "더 위로 옮길 수 없습니다.");
  assert.equal(model.segmentTreeMoveLeaf(draft, 0, 1, 1).error, "더 아래로 옮길 수 없습니다.");
  // A leaf never moves into another group.
  assert.equal(model.segmentTreeMoveLeaf(draft, 1, 0, 1).error, "더 아래로 옮길 수 없습니다.");
  assert.equal(model.segmentTreeMoveLeaf(draft, 1, 0, -1).error, "더 위로 옮길 수 없습니다.");
  assert.equal(model.segmentTreeMoveLeaf(draft, 0, 2, -1).error, "조건을 찾을 수 없습니다.");
  assert.equal(model.segmentTreeMoveGroup(draft, 0, 2).error, "한 칸씩만 옮길 수 있습니다.");
});

test("modes are set on the root or one group, and only to all or any", () => {
  const draft = draftOf(1, 1);
  const root = model.segmentTreeSetMode(draft, null, "any");
  assert.equal(root.error, "");
  assert.equal(root.draft.mode, "any");
  assert.deepEqual(plain(root.draft.groups.map((group) => group.mode)), ["all", "all"]);
  const group = model.segmentTreeSetMode(root.draft, 1, "any");
  assert.deepEqual(plain(group.draft.groups.map((value) => value.mode)), ["all", "any"]);
  assert.equal(model.segmentTreeSetMode(draft, null, "ANY").error, "결합 방식을 확인할 수 없습니다.");
  assert.equal(model.segmentTreeSetMode(draft, 0, "or").error, "결합 방식을 확인할 수 없습니다.");
  assert.equal(model.segmentTreeSetMode(draft, 2, "any").error, "그룹을 찾을 수 없습니다.");
});

test("a leaf takes only its known keys as strings and a known kind", () => {
  const draft = draftOf(1);
  const changed = model.segmentTreeSetLeaf(draft, 0, 0, { kind: "field", field_id: textField, value: "pro" });
  assert.equal(changed.error, "");
  assert.deepEqual(plain(changed.draft.groups[0].conditions[0]), {
    kind: "field",
    tag: "t1",
    field_id: textField,
    field_operator: "eq",
    value: "pro",
    boolean: "true",
  });
  assert.equal(model.segmentTreeSetLeaf(draft, 0, 0, { kind: "not" }).error, "조건 종류를 확인할 수 없습니다.");
  assert.equal(model.segmentTreeSetLeaf(draft, 0, 0, { negate: true }).error, "조건 값을 확인할 수 없습니다.");
  assert.equal(model.segmentTreeSetLeaf(draft, 0, 0, { tag: 1 }).error, "조건 값을 확인할 수 없습니다.");
  assert.equal(model.segmentTreeSetLeaf(draft, 0, 1, { tag: "x" }).error, "조건을 찾을 수 없습니다.");
  assert.deepEqual(tags(model.segmentTreeSetLeaf(draft, 0, 0, { kind: "not" }).draft), [["t1"]]);
});

test("operators follow the field type, as in the field rows", () => {
  assert.deepEqual(plain(model.segmentTreeOperators("number")), ["eq", "gte", "gt", "lte", "lt", "is_set", "is_unset"]);
  assert.deepEqual(plain(model.segmentTreeOperators("date")), ["eq", "gte", "gt", "lte", "lt", "is_set", "is_unset"]);
  assert.deepEqual(plain(model.segmentTreeOperators("text")), ["eq", "is_set", "is_unset"]);
  assert.deepEqual(plain(model.segmentTreeOperators("boolean")), ["eq", "is_set", "is_unset"]);
  assert.deepEqual(plain(model.segmentTreeOperators(undefined)), ["eq", "is_set", "is_unset"]);
  for (const operator of ["eq", "gt", "gte", "lt", "lte"]) assert.equal(model.segmentTreeNeedsValue(operator), true);
  for (const operator of ["is_set", "is_unset", ""]) assert.equal(model.segmentTreeNeedsValue(operator), false);
});

test("a complete draft builds the canonical tree with typed values, in order", () => {
  const draft: Draft = {
    mode: "any",
    groups: [
      {
        mode: "all",
        conditions: [
          tagLeaf(" VIP "),
          fieldLeaf(numberField, "gte", "100000"),
          fieldLeaf(textField, "eq", ""),
          fieldLeaf(booleanField, "eq", "ignored", "false"),
        ],
      },
      {
        mode: "any",
        conditions: [
          tagLeaf("event", "no_tag"),
          fieldLeaf(dateField, "lt", "2026-10-01"),
          fieldLeaf(textField, "is_unset", "stale"),
          tagLeaf("VIP"),
        ],
      },
    ],
  };
  assert.deepEqual(plain(model.segmentTreeBuild(draft, fields)), {
    tree: {
      mode: "any",
      groups: [
        {
          mode: "all",
          conditions: [
            { tag: " VIP " },
            { field_id: numberField, field_operator: "gte", field_value: 100000 },
            { field_id: textField, field_operator: "eq", field_value: "" },
            { field_id: booleanField, field_operator: "eq", field_value: false },
          ],
        },
        {
          mode: "any",
          conditions: [
            { tag: "event", negate: true },
            { field_id: dateField, field_operator: "lt", field_value: "2026-10-01" },
            { field_id: textField, field_operator: "is_unset" },
            { tag: "VIP" },
          ],
        },
      ],
    },
    error: "",
  });
  assert.deepEqual(plain(model.segmentTreeBuild(null, fields)), { tree: null, error: "" });
});

test("an incomplete leaf refuses the build and names its place", () => {
  const build = (leaf: DraftLeaf, list = fields) =>
    model.segmentTreeBuild({ mode: "all", groups: [draftOf(1).groups[0], { mode: "all", conditions: [leaf] }] }, list)
      .error;
  assert.equal(build(tagLeaf("  ")), "그룹 2의 조건 1에 태그를 입력해 주세요.");
  assert.equal(build(tagLeaf("", "no_tag")), "그룹 2의 조건 1에 태그를 입력해 주세요.");
  assert.equal(build(fieldLeaf("", "eq")), "그룹 2의 조건 1에서 추가 정보 필드를 선택해 주세요.");
  assert.equal(
    build(fieldLeaf(textField, "eq"), []),
    "그룹 2의 조건 1의 필드를 사용할 수 없습니다. 다른 필드를 선택하거나 조건을 삭제해 주세요.",
  );
  assert.equal(
    build(fieldLeaf(textField, "gt", "a")),
    "그룹 2의 조건 1에서 이 필드에 쓸 수 없는 비교 방식을 골랐습니다.",
  );
  assert.equal(build(fieldLeaf(numberField, "eq", " ")), "그룹 2의 조건 1에 숫자 값을 입력해 주세요.");
  assert.equal(build(fieldLeaf(numberField, "eq", "1e999")), "그룹 2의 조건 1에 숫자 값을 입력해 주세요.");
  assert.equal(build(fieldLeaf(numberField, "eq", "abc")), "그룹 2의 조건 1에 숫자 값을 입력해 주세요.");
  assert.equal(build(fieldLeaf(dateField, "gte", "")), "그룹 2의 조건 1에 날짜를 입력해 주세요.");
  assert.equal(build(fieldLeaf(booleanField, "eq", "", "maybe")), "그룹 2의 조건 1에서 예 또는 아니요를 골라 주세요.");
  // A value is not needed by is_set and is_unset.
  assert.equal(build(fieldLeaf(numberField, "is_set", "")), "");
  assert.equal(build(fieldLeaf(dateField, "is_unset", "")), "");
});

test("the build refuses a draft outside the limits as well", () => {
  const limit = "그룹 조건은 그룹 1~5개, 그룹마다 조건 1~5개, 모두 합쳐 조건 10개까지입니다.";
  assert.equal(model.segmentTreeBuild(draftOf(5, 5), fields).error, "");
  assert.equal(model.segmentTreeBuild(draftOf(1, 1, 1, 1, 1), fields).error, "");
  assert.equal(model.segmentTreeBuild(draftOf(1, 1, 1, 1, 1, 1), fields).error, limit);
  assert.equal(model.segmentTreeBuild(draftOf(6), fields).error, limit);
  assert.equal(model.segmentTreeBuild(draftOf(5, 5, 1), fields).error, limit);
  assert.equal(model.segmentTreeBuild({ mode: "all", groups: [] }, fields).error, limit);
  assert.equal(model.segmentTreeBuild({ ...draftOf(1), mode: "or" }, fields).error, "결합 방식을 확인할 수 없습니다.");
});

test("a saved tree becomes a draft that builds back to the same tree", () => {
  const saved: Tree = {
    mode: "any",
    groups: [
      {
        mode: "all",
        conditions: [
          { tag: "vip" },
          { field_id: numberField, field_operator: "gte", field_value: 100000 },
          { field_id: booleanField, field_operator: "eq", field_value: false },
          { field_id: textField, field_operator: "eq", field_value: "" },
        ],
      },
      {
        mode: "any",
        conditions: [
          { tag: "event", negate: true },
          { field_id: dateField, field_operator: "is_set" },
        ],
      },
    ],
  };
  const draft = model.segmentTreeFromSaved(saved)!;
  assert.deepEqual(plain(draft.groups[0].conditions[1]), fieldLeaf(numberField, "gte", "100000"));
  assert.deepEqual(plain(draft.groups[0].conditions[2]), fieldLeaf(booleanField, "eq", "", "false"));
  assert.deepEqual(plain(draft.groups[1].conditions[0]), tagLeaf("event", "no_tag"));
  assert.deepEqual(plain(model.segmentTreeBuild(draft, fields)), { tree: saved, error: "" });
  assert.equal(model.segmentTreeFromSaved(null), null);
  assert.equal(model.segmentTreeFromSaved(undefined), null);
  // Two reads of one tree are separate drafts.
  assert.notEqual(model.segmentTreeFromSaved(saved), model.segmentTreeFromSaved(saved));
});

test("comparison is order sensitive, like the server's unchanged check", () => {
  const draft = draftOf(2, 1);
  assert.equal(model.segmentTreeSame(draft, draftOf(2, 1)), true);
  assert.equal(model.segmentTreeSame(null, null), true);
  assert.equal(model.segmentTreeSame(draft, null), false);
  assert.equal(model.segmentTreeSame(null, draft), false);
  const swappedGroups = model.segmentTreeMoveGroup(draft, 0, 1).draft;
  assert.equal(model.segmentTreeSame(draft, swappedGroups), false);
  // Moving back restores equality: a move pair is not a change.
  assert.equal(model.segmentTreeSame(draft, model.segmentTreeMoveGroup(swappedGroups, 1, -1).draft), true);
  assert.equal(model.segmentTreeSame(draft, model.segmentTreeMoveLeaf(draft, 0, 0, 1).draft), false);
  assert.equal(model.segmentTreeSame(draft, model.segmentTreeSetMode(draft, null, "any").draft), false);
  assert.equal(model.segmentTreeSame(draft, model.segmentTreeSetMode(draft, 1, "any").draft), false);
  assert.equal(model.segmentTreeSame(draft, model.segmentTreeSetLeaf(draft, 0, 0, { kind: "no_tag" }).draft), false);
  assert.equal(model.segmentTreeSame(draft, model.segmentTreeSetLeaf(draft, 0, 0, { tag: "T1" }).draft), false);
  // Text that a leaf does not send is not compared.
  const field = { mode: "all", groups: [{ mode: "all", conditions: [fieldLeaf(textField, "is_set")] }] };
  const hidden = model.segmentTreeSetLeaf(field, 0, 0, { value: "typed", tag: "unused" }).draft;
  assert.equal(model.segmentTreeSame(field, hidden), true);
  assert.equal(
    model.segmentTreeSame(field, model.segmentTreeSetLeaf(field, 0, 0, { field_operator: "eq" }).draft),
    false,
  );
  const valued = { mode: "all", groups: [{ mode: "all", conditions: [fieldLeaf(numberField, "eq", "1")] }] };
  assert.equal(model.segmentTreeSame(valued, model.segmentTreeSetLeaf(valued, 0, 0, { value: "2" }).draft), false);
  const tag = draftOf(1);
  assert.equal(model.segmentTreeSame(tag, model.segmentTreeSetLeaf(tag, 0, 0, { field_id: textField }).draft), true);
});

test("comparison reads only the value input of the field's type", () => {
  const saved: Tree = {
    mode: "all",
    groups: [
      {
        mode: "all",
        conditions: [
          { field_id: numberField, field_operator: "eq", field_value: 5 },
          { field_id: booleanField, field_operator: "eq", field_value: false },
        ],
      },
    ],
  };
  const loaded = model.segmentTreeFromSaved(saved)!;
  // A number leaf that visited a boolean field and "아니요", then came back to the same value, sends the loaded tree.
  let edited = model.segmentTreeSetLeaf(loaded, 0, 0, { field_id: booleanField, value: "" }).draft;
  edited = model.segmentTreeSetLeaf(edited, 0, 0, { boolean: "false" }).draft;
  edited = model.segmentTreeSetLeaf(edited, 0, 0, { field_id: numberField, value: "5" }).draft;
  // A boolean leaf whose hidden value input holds text sends the loaded tree too.
  edited = model.segmentTreeSetLeaf(edited, 0, 1, { value: "typed" }).draft;
  assert.deepEqual(plain(model.segmentTreeBuild(edited, fields)), plain(model.segmentTreeBuild(loaded, fields)));
  assert.equal(model.segmentTreeSame(edited, loaded, fields), true);
  assert.equal(model.segmentTreeUnsaved(edited, [saved], fields), false);
  // The input of the field's type is still compared.
  assert.equal(
    model.segmentTreeSame(model.segmentTreeSetLeaf(loaded, 0, 0, { value: "6" }).draft, loaded, fields),
    false,
  );
  assert.equal(
    model.segmentTreeSame(model.segmentTreeSetLeaf(loaded, 0, 1, { boolean: "true" }).draft, loaded, fields),
    false,
  );
  // Without the field's type, both inputs are compared.
  assert.equal(model.segmentTreeSame(edited, loaded, []), false);
  assert.equal(model.segmentTreeSame(edited, loaded), false);
});

test("a tree is unsaved when it has a condition that no saved tree holds in the same order", () => {
  const saved: Tree = {
    mode: "all",
    groups: [
      { mode: "all", conditions: [{ tag: "t1" }, { tag: "t2" }] },
      { mode: "all", conditions: [{ tag: "t3" }] },
    ],
  };
  const draft = draftOf(2, 1);
  // No tree, or a tree without a condition, holds nothing that a discard could lose.
  assert.equal(model.segmentTreeUnsaved(null, []), false);
  assert.equal(model.segmentTreeUnsaved(model.segmentTreeEmpty(), []), false);
  assert.equal(model.segmentTreeUnsaved(model.segmentTreeRemoveLeaf(draftOf(1), 0, 0).draft, []), false);
  // A tree that a saved filter holds comes back by selecting that filter, wherever it is in the list.
  assert.equal(model.segmentTreeUnsaved(draft, [undefined, null, saved]), false);
  assert.equal(model.segmentTreeUnsaved(draft, []), true);
  assert.equal(model.segmentTreeUnsaved(draft, [undefined, null]), true);
  // Order is part of the tree, so a moved group is not the saved one.
  assert.equal(model.segmentTreeUnsaved(model.segmentTreeMoveGroup(draft, 0, 1).draft, [saved]), true);
  assert.equal(model.segmentTreeUnsaved(model.segmentTreeSetLeaf(draft, 1, 0, { tag: "t4" }).draft, [saved]), true);
  // The comparison does not normalize as the server does; the screen reloads the stored tree after a save instead.
  assert.equal(model.segmentTreeUnsaved(model.segmentTreeSetLeaf(draft, 0, 0, { tag: "T1" }).draft, [saved]), true);
});

test("archiving a field removes its leaves, counts them and keeps emptied groups", () => {
  const draft: Draft = {
    mode: "all",
    groups: [
      {
        mode: "all",
        conditions: [fieldLeaf(numberField, "gte", "1"), tagLeaf("vip"), fieldLeaf(numberField, "is_set")],
      },
      { mode: "any", conditions: [fieldLeaf(numberField, "lt", "5")] },
    ],
  };
  const result = model.segmentTreeRemoveField(draft, numberField.toUpperCase());
  assert.equal(result.removed, 3);
  assert.deepEqual(plain(result.draft), {
    mode: "all",
    groups: [
      { mode: "all", conditions: [tagLeaf("vip")] },
      { mode: "any", conditions: [] },
    ],
  });
  assert.equal(model.segmentTreeBuild(result.draft, fields).error, "그룹 2에 조건을 하나 이상 추가해 주세요.");
  // Field IDs compare without case, as the server stores them in lower case.
  const lettered = "abcdef12-3456-4789-8abc-def123456789";
  const mixed = { mode: "all", groups: [{ mode: "all", conditions: [fieldLeaf(lettered, "is_set"), tagLeaf("vip")] }] };
  assert.equal(model.segmentTreeRemoveField(mixed, lettered.toUpperCase()).removed, 1);
  const upper = model.segmentTreeSetLeaf(mixed, 0, 0, { field_id: lettered.toUpperCase() }).draft;
  assert.equal(model.segmentTreeRemoveField(upper, lettered).removed, 1);
  const none = model.segmentTreeRemoveField(draft, textField);
  assert.equal(none.removed, 0);
  assert.deepEqual(plain(none.draft), plain(draft));
  // A tag leaf keeps a hidden field ID typed before its kind changed; only field leaves are removed.
  const hidden = model.segmentTreeSetLeaf(draftOf(1), 0, 0, { field_id: numberField }).draft;
  assert.equal(model.segmentTreeRemoveField(hidden, numberField).removed, 0);
  assert.deepEqual(plain(model.segmentTreeRemoveField(null, numberField)), { draft: null, removed: 0 });
});

test("the summary puts groups in parentheses, joined by their modes", () => {
  const fieldText = (leaf: Record<string, unknown>) => `필드 ${String(leaf.field_id)} ${String(leaf.field_operator)}`;
  assert.equal(
    model.segmentTreeSummary(
      {
        mode: "any",
        groups: [
          {
            mode: "all",
            conditions: [{ tag: "VIP" }, { field_id: numberField, field_operator: "gte", field_value: 100000 }],
          },
          { mode: "any", conditions: [{ tag: "event", negate: true }, { tag: "lead" }] },
        ],
      },
      fieldText,
    ),
    `(태그 VIP 있음 그리고 필드 ${numberField} gte) 또는 (태그 event 없음 또는 태그 lead 있음)`,
  );
  assert.equal(
    model.segmentTreeSummary(
      {
        mode: "all",
        groups: [
          { mode: "all", conditions: [{ tag: "a" }] },
          { mode: "all", conditions: [{ tag: "b" }] },
        ],
      },
      fieldText,
    ),
    "(태그 a 있음) 그리고 (태그 b 있음)",
  );
});
