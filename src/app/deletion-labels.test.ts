import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

type Counts = Record<string, number>;
interface DeletionLabels {
  deletedLabels: Record<string, string>;
  retainedLabels: Record<string, string>;
  countTotal(counts: Counts | null | undefined): number;
  countSummary(counts: Counts | null | undefined, labels: Record<string, string>): string;
}

// public/app/deletion-labels.js is a classic browser script. Its top-level functions become context globals, and
// its top-level const declarations are read by evaluating their names in the same context.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/display-values.js", import.meta.url), "utf8"), context);
vm.runInContext(readFileSync(new URL("../../public/app/deletion-labels.js", import.meta.url), "utf8"), context);
const labels = vm.runInContext("({ deletedLabels, retainedLabels, countTotal, countSummary })", context) as DeletionLabels;

const schema = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");

// The body of one deletion function, from its CREATE statement to the REVOKE that follows it.
function functionBody(name: string): string {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.notEqual(start, -1, `${name} is missing from db/schema.sql`);
  const end = schema.indexOf(`REVOKE ALL ON FUNCTION public.${name}(`, start);
  assert.notEqual(end, -1, `the REVOKE after ${name} is missing from db/schema.sql`);
  return schema.slice(start, end);
}

// Every key the function adds to deleted_counts. Each assignment must use the one recognized shape, so a new
// shape fails here instead of hiding a key.
function deletedKeys(name: string): string[] {
  const body = functionBody(name);
  const keys = [...body.matchAll(/deleted := deleted \|\| jsonb_build_object\('([a-z_]+)', affected\);/g)].map((match) => match[1]!);
  assert.ok(keys.length > 0, `no deleted_counts keys found in ${name}`);
  assert.equal(keys.length, [...body.matchAll(/deleted :=/g)].length, `${name} adds to deleted_counts in an unrecognized shape`);
  return keys;
}

// Every key of the retained_counts object: the quoted names that start a line inside its jsonb_build_object.
function retainedKeys(name: string): string[] {
  const body = functionBody(name);
  const blocks = [...body.matchAll(/retained := jsonb_build_object\(\n([\s\S]*?)\n {2}\);/g)];
  assert.equal(blocks.length, 1, `expected one retained_counts object in ${name}`);
  const keys = [...blocks[0]![1]!.matchAll(/^ {4}'([a-z_]+)',/gm)].map((match) => match[1]!);
  assert.ok(keys.length > 0, `no retained_counts keys found in ${name}`);
  return keys;
}

// The dashboard shows connection and person deletion records only; workspace deletion records are not displayed.
const shownFunctions = ["delete_connection_data", "delete_person_data"];

test("every deleted_counts key of a shown deletion record has a label", () => {
  for (const name of shownFunctions) {
    const missing = deletedKeys(name).filter((key) => !Object.hasOwn(labels.deletedLabels, key));
    assert.deepEqual(missing, [], `${name} deleted_counts keys without a label`);
  }
});

test("every retained_counts key of a shown deletion record has a label", () => {
  for (const name of shownFunctions) {
    const keys = retainedKeys(name);
    assert.deepEqual([...keys].sort(), ["active_contacts", "carried_comment_sender_revokes", "channel_consent_events", "channel_consent_state"]);
    const missing = keys.filter((key) => !Object.hasOwn(labels.retainedLabels, key));
    assert.deepEqual(missing, [], `${name} retained_counts keys without a label`);
  }
});

test("the summary of a full deletion record shows labels, never a raw table key", () => {
  for (const name of shownFunctions) {
    const deleted = Object.fromEntries(deletedKeys(name).map((key) => [key, 1]));
    const summary = labels.countSummary(deleted, labels.deletedLabels);
    for (const key of Object.keys(deleted)) assert.ok(!summary.includes(key), `${name}: ${key} is shown raw`);
    assert.doesNotMatch(summary, /[a-z_]{3,}/);
    const retained = Object.fromEntries(retainedKeys(name).map((key) => [key, 2]));
    assert.doesNotMatch(labels.countSummary(retained, labels.retainedLabels), /[a-z_]{3,}/);
  }
  assert.equal(labels.countSummary({ instagram_dm_start_events: 3 }, labels.deletedLabels), "DM 플로 시작 기록 3건");
  assert.equal(labels.countSummary({ active_contacts: 4 }, labels.retainedLabels), "식별자를 지운 활성 연락처 기록 4건");
});

test("the summary skips zero counts, totals every count and keeps an unknown key visible", () => {
  assert.equal(labels.countSummary({ instagram_comment_events: 2, flow_runs: 0, new_table: 1200 }, labels.deletedLabels), "댓글 2건, new_table 1,200건");
  assert.equal(labels.countSummary(null, labels.deletedLabels), "");
  assert.equal(labels.countTotal({ instagram_comment_events: 2, flow_runs: 0, new_table: 1200 }), 1202);
  assert.equal(labels.countTotal(undefined), 0);
});
