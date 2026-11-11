import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

interface FakeElement {
  name: string;
  tag: string;
  tagName: string;
  hidden: boolean;
  isConnected: boolean;
  parentElement: FakeElement | null;
  closest(selector: string): FakeElement | null;
}

interface NoticePlacement {
  viewChangeClearsMessages(previous: string | undefined, next: string): boolean;
  actionErrorPlacement(button: FakeElement | null): { owner: FakeElement; row: FakeElement } | null;
  noticeCloseFocusTarget(focusInNotice: boolean, view: string | undefined): string | null;
}

// public/app/notice-placement.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/notice-placement.js", import.meta.url), "utf8"), context);
const placement = context as unknown as NoticePlacement;

// Supports the two selectors the module uses: "[hidden]" and "form, section".
function element(name: string, tag: string, parent: FakeElement | null = null, hidden = false): FakeElement {
  const self: FakeElement = {
    name,
    tag,
    tagName: tag.toUpperCase(),
    hidden,
    isConnected: true,
    parentElement: parent,
    closest(selector) {
      const matches = (candidate: FakeElement) => (selector === "[hidden]" ? candidate.hidden : selector.split(", ").includes(candidate.tag));
      for (let current: FakeElement | null = self; current; current = current.parentElement) if (matches(current)) return current;
      return null;
    },
  };
  return self;
}
const where = (button: FakeElement | null) => {
  const result = placement.actionErrorPlacement(button);
  return result ? `${result.owner.name}>${result.row.name}` : null;
};

test("only a change from a shown menu to another menu clears the notice and the action errors", () => {
  assert.equal(placement.viewChangeClearsMessages("home", "settings"), true);
  assert.equal(placement.viewChangeClearsMessages("settings", "settings"), false, "same menu again");
  assert.equal(placement.viewChangeClearsMessages(undefined, "home"), false, "first display after loading");
});

test("an action error goes right after the form child that holds the button", () => {
  const main = element("main", "main");
  const form = element("invite-form", "form", element("settings-section", "section", main));
  const actions = element("actions", "div", form);
  assert.equal(where(element("submit", "button", actions)), "invite-form>actions");
  assert.equal(where(element("direct", "button", form)), "invite-form>direct", "a button that is a child of the form");
});

test("a button in a list item or table cell places the error inside that item, next to its row", () => {
  const section = element("accounts", "section", element("main", "main"));
  const item = element("item", "li", element("list", "ul", section));
  assert.equal(where(element("disconnect", "button", element("row", "div", item))), "accounts>row");
  assert.equal(where(element("remove", "button", item)), "accounts>remove", "a button that is a child of the item");
  const cell = element("cell", "td", element("tr", "tr", element("table", "table", section)));
  assert.equal(where(element("retry", "button", cell)), "accounts>retry");
});

test("an action error has no inline place without a visible owner, so it goes to the page notice", () => {
  const main = element("main", "main");
  assert.equal(where(element("retry-load", "button", main)), null, "no form or section");
  const auth = element("auth", "section", main, true);
  assert.equal(where(element("login", "button", element("login-form", "form", auth))), null, "hidden after login");
  const removed = element("archive", "button", element("form", "form", main));
  removed.isConnected = false;
  assert.equal(where(removed), null, "removed by the task");
  assert.equal(where(null), null);
});

test("closing a focused notice moves focus to the shown menu, or to main on the sign-in screen", () => {
  assert.equal(placement.noticeCloseFocusTarget(true, "contacts"), "view-contacts");
  assert.equal(placement.noticeCloseFocusTarget(true, undefined), "main");
  assert.equal(placement.noticeCloseFocusTarget(false, "contacts"), null, "focus elsewhere stays where it is");
});

test("the dashboard wires the notice and action errors through these decisions", () => {
  const read = (name: string) => readFileSync(new URL(`../../public/app/${name}`, import.meta.url), "utf8");
  const html = read("index.html");
  assert.ok(html.indexOf("./notice-placement.js") < html.indexOf("./app.js"), "notice-placement.js loads first");
  const bar = html.match(/<div class="notice-bar">[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
  assert.match(bar, /<div id="notice" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"><\/div>/);
  assert.match(bar, /<button id="notice-close" type="button" class="secondary" hidden>닫기<\/button>/);
  assert.doesNotMatch(bar, /<div id="notice"[^>]*>[^<]*<button/, "the close button is outside the live region");

  const app = read("app.js");
  const notice = app.match(/function notice\(message, error = false\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(notice, /setAttribute\("aria-live", error \? "assertive" : "polite"\)/);
  assert.match(notice, /byId\("notice-close"\)\.hidden = !message;/);
  assert.match(notice, /if \(error && message\) byId\("notice"\)\.focus\(\{ preventScroll: false \}\);/);

  const showView = app.match(/function showView\(name, focus\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(
    showView,
    /^ {2}if \(viewChangeClearsMessages\(currentView, name\)\) \{\n {4}notice\(""\);\n {4}clearActionErrors\(\);\n {2}\}\n {2}currentView = name;/m,
    "a menu change clears the notice and the action errors, comparing with the previous view before replacing it",
  );
  const reset = app.match(/function resetSession\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(reset, /\n {2}clearActionErrors\(\);\n/, "a sign-out or session expiry clears the action errors");
  const clearAll = app.match(/function clearActionErrors\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(clearAll, /document\.querySelectorAll\("\.action-error"\)\) element\.remove\(\);/);

  const action = app.match(/async function action\(button, task\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const clearAt = action.indexOf("clearActionError(button)");
  assert.ok(clearAt >= 0 && clearAt < action.indexOf("await task()"), "a new run clears the error");
  assert.match(action, /catch \(error\) \{\n(?: {4}\/\/.*\n)* {4}if \(showActionError\(button, error\.message\)\) notice\(""\);\n {4}else notice\(error\.message, true\);/, "an inline error replaces an earlier page notice; a failure without an owner still goes to the notice");
  const show = app.match(/function showActionError\(button, message\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(show, /setAttribute\("role", "alert"\)/);
  assert.doesNotMatch(show, /focus|scroll/, "an inline error moves neither focus nor the page");
});
