import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

interface FakeElement {
  name: string;
  isConnected: boolean;
}

interface FocusKeeper {
  focusRestoreTarget(previous: FakeElement | null, active: FakeElement | null, body: FakeElement): FakeElement | null;
}

// public/app/focus-keeper.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/focus-keeper.js", import.meta.url), "utf8"), context);
const keeper = context as unknown as FocusKeeper;

const element = (name: string, isConnected = true): FakeElement => ({ name, isConnected });
const body = element("body");
const target = (previous: FakeElement | null, active: FakeElement | null) =>
  keeper.focusRestoreTarget(previous, active, body)?.name ?? null;

test("focus returns to the re-enabled control when the browser dropped it on body or nothing", () => {
  const button = element("save");
  assert.equal(target(button, body), "save");
  assert.equal(target(button, null), "save");
});

test("an element that took focus on purpose meanwhile keeps it", () => {
  assert.equal(target(element("save"), element("notice")), null);
});

test("nothing is focused when nothing had focus before the request", () => {
  assert.equal(target(null, body), null);
  assert.equal(target(body, body), null);
});

test("a control that was removed from the document is not focused, and no other element is chosen instead", () => {
  assert.equal(target(element("archive", false), body), null);
});

test("the dashboard and the inbox restore focus after their busy controls", () => {
  const read = (name: string) => readFileSync(new URL(`../../public/app/${name}`, import.meta.url), "utf8");
  const html = read("index.html");
  assert.ok(
    html.indexOf("./focus-keeper.js") < html.indexOf("./inbox.js") &&
      html.indexOf("./focus-keeper.js") < html.indexOf("./app.js"),
    "focus-keeper.js loads before its consumers",
  );
  assert.match(html, /<h3 id="inbox-conversation-title" tabindex="-1">/);
  assert.match(html, /<button id="inbox-back-to-list" type="button" class="secondary" hidden>목록으로<\/button>/);
  const action = read("app.js").match(/async function action\(button, task\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(action.indexOf("holdFocus()") < action.indexOf("control.disabled = true"), "action holds focus first");
  assert.match(action, /finally \{[\s\S]*restoreFocus\(\);\n {2}\}/);
  const inbox = read("inbox.js");
  for (const name of [
    "saveLabels",
    "saveReminder",
    "finishReminder",
    "addMemo",
    "manageLabels",
    "manageRules",
    "changeConversation",
    "submitOperation",
  ]) {
    const body = inbox.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`))?.[0] ?? "";
    assert.match(body, /restoreFocus = holdFocus\(\)/, `${name} holds focus`);
    assert.match(body, /finally \{[\s\S]*restoreFocus\(\);/, `${name} restores focus after re-rendering`);
  }
  const submit = inbox.match(/async function submitOperation\([\s\S]*?\n {2}\}\n/)?.[0] ?? "";
  const reload = submit.indexOf("await loadConversation()");
  assert.ok(
    reload > 0 && reload < submit.lastIndexOf("restoreFocus();"),
    "an operation restores focus after the history reload re-renders",
  );
});
