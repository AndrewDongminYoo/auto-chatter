import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

interface DisplayValues {
  errorMessage(error: unknown): string;
  formatCount(value: unknown, options?: { useGrouping?: boolean }): string;
  formatText(value: unknown): string;
  formatDateTime(value: unknown, options?: Intl.DateTimeFormatOptions): string;
  formatDate(value: unknown, options?: Intl.DateTimeFormatOptions): string;
  formatTime(value: unknown, options?: Intl.DateTimeFormatOptions): string;
}

const fallback = "화면을 처리하는 중 문제가 생겼습니다. 새로고침한 뒤 다시 시도해 주세요.";
const logged: unknown[] = [];
// public/app/display-values.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({ console: { error: (value: unknown) => logged.push(value) } });
vm.runInContext(readFileSync(new URL("../../public/app/display-values.js", import.meta.url), "utf8"), context);
const values = context as unknown as DisplayValues;
// Errors are built inside the context, because errorMessage compares constructors of the script's own realm.
const inContext = (source: string) => vm.runInContext(source, context) as unknown;
const directory = new URL("../../public/app/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, directory), "utf8");

test("a plain Error passes its message through without logging", () => {
  logged.length = 0;
  assert.equal(values.errorMessage(inContext('new Error("요청을 처리하지 못했습니다.")')), "요청을 처리하지 못했습니다.");
  assert.equal(logged.length, 0);
});

test("browser and runtime errors, subclasses, empty messages and non-errors fall back and are logged", () => {
  const cases = [
    inContext("new TypeError(\"Cannot read properties of undefined (reading 'total')\")"),
    inContext('new TypeError("Failed to fetch")'),
    inContext('new RangeError("Invalid time value")'),
    inContext('new (class ApiFailure extends Error {})("subclass")'),
    inContext('new Error("")'),
    // A DOMException-like object: an Error-shaped value whose constructor is not Error.
    inContext('Object.assign(Object.create(Error.prototype, { constructor: { value: function DOMException() {} } }), { name: "AbortError", message: "The operation was aborted." })'),
    { message: "plain object" },
    "string failure",
    undefined,
    null,
    // An Error from another realm is not one of the dashboard's own errors.
    new Error("other realm"),
  ];
  for (const error of cases) {
    logged.length = 0;
    assert.equal(values.errorMessage(error), fallback, String(error));
    assert.deepEqual(logged, [error]);
  }
});

test("counts format finite numbers and show a dash for anything else", () => {
  assert.equal(values.formatCount(0), "0");
  assert.equal(values.formatCount(1234567), "1,234,567");
  assert.equal(values.formatCount(-12.5), "-12.5");
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, "wrong", "", {}, true, 12n]) assert.equal(values.formatCount(value), "–", String(value));
});

test("date helpers format valid dates exactly like the calls they replace", () => {
  const iso = "2026-11-15T03:04:05.000Z";
  const date = new Date(iso);
  const options = { timeZone: "Asia/Seoul" };
  assert.equal(values.formatDateTime(iso), date.toLocaleString("ko-KR"));
  assert.equal(values.formatDateTime(iso, options), date.toLocaleString("ko-KR", options));
  assert.equal(values.formatDateTime(date.getTime(), options), date.toLocaleString("ko-KR", options));
  assert.equal(values.formatDateTime(inContext(`new Date(${JSON.stringify(iso)})`), options), date.toLocaleString("ko-KR", options));
  assert.equal(values.formatDate(iso, options), date.toLocaleDateString("ko-KR", options));
  assert.equal(values.formatTime(iso, options), date.toLocaleTimeString("ko-KR", options));
});

test("date helpers show a dash for invalid, missing and non-date values", () => {
  for (const format of [values.formatDateTime, values.formatDate, values.formatTime]) {
    for (const value of ["not a date", "", undefined, null, true, Number.NaN, Number.POSITIVE_INFINITY, inContext("new Date(Number.NaN)"), {}]) assert.equal(format(value), "–", `${format.name}(${String(value)})`);
  }
});

test("an invalid time zone still throws, so callers keep their own fallback", () => {
  assert.throws(() => values.formatDateTime("2026-11-15T03:04:05.000Z", { timeZone: "Not/AZone" }), { name: "RangeError" });
});

test("the dashboard loads the display helpers before every script that uses them", () => {
  const html = read("index.html");
  const position = (name: string) => html.indexOf(`<script src="./${name}" defer></script>`);
  assert.ok(position("display-values.js") > 0, "display-values.js is not loaded with defer");
  const users = readdirSync(directory).filter((name) => name.endsWith(".js") && name !== "display-values.js" && /\b(?:errorMessage|formatText|formatCount|formatDateTime|formatDate|formatTime)\(/.test(read(name)));
  assert.ok(users.length > 0);
  for (const name of users) assert.ok(position(name) > position("display-values.js"), `${name} loads before the display helpers`);
});

// Server validation lists keep error.message: their entries are response objects, not caught Errors. Every other
// display of a caught error goes through errorMessage.
const allowedErrorMessageLines: Record<string, RegExp[]> = {
  "flow-editor-model.js": [/^ {2}return \[\.\.\.general\.map\(\(error\) => \(\{ code: error\.code, message: `\$\{source\}: \$\{error\.message\}` \}\)\), \.\.\.placed\.map\(/],
  "flow-editor.js": [
    /^ {8}if \(flowKnownError\(error\.code\)\) error\.message = flowErrorMessage\(error\.code\);$/,
    /^ {4}for \(const error of general\) list\.append\(node\("li", error\.message\)\);$/,
    /^ {6}item\.append\(link, `: \$\{error\.message\}`\);$/,
    /^ {6}for \(const error of errors\) list\.append\(node\("li", error\.message\)\);$/,
  ],
};

test("no dashboard script shows a caught error's message without errorMessage", () => {
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".js") && file !== "display-values.js")) {
    const allowed = allowedErrorMessageLines[name] ?? [];
    const lines = read(name)
      .split("\n")
      .filter((line) => /\berror\.message\b/.test(line));
    assert.equal(lines.length, allowed.length, `${name} reads error.message outside the allowed validation lists: ${lines.join("\n")}`);
    for (const pattern of allowed)
      assert.ok(
        lines.some((line) => pattern.test(line)),
        `${name} no longer has the allowed line ${pattern}`,
      );
  }
});

test("plain counts preserve existing grouping and precision", () => {
  assert.equal(values.formatCount(1234, { useGrouping: false }), "1234");
  assert.equal(values.formatCount("9007199254740993", { useGrouping: false }), "9007199254740993");
  assert.equal(values.formatCount("9007199254740993"), "9,007,199,254,740,993");
});

test("text display preserves strings and replaces absent or wrong types", () => {
  assert.equal(values.formatText("12345678901234567890"), "12345678901234567890");
  assert.equal(values.formatText("상점"), "상점");
  for (const value of [undefined, null, "", 123, NaN, {}, true]) assert.equal(values.formatText(value), "–");
});

// Inspect syntax, rather than a field-name regex: identifiers and labels need guards too.
// Local array lengths and already-formatted limit strings are the bounded exceptions.
function unguardedDisplayValues(source: string): string[] {
  const ast = ts.createSourceFile("dashboard.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isTemplateExpression(node) && /[가-힣]/.test(node.head.text + node.templateSpans.map((span) => span.literal.text).join(""))) {
      for (const span of node.templateSpans) {
        const expression = span.expression;
        const text = expression.getText(ast);
        if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && !/\.length$/.test(text) && !/^counts\[[0-3]\]$/.test(text)) found.push(text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

test("the display interpolation reader rejects missing values and accepts guarded values", () => {
  assert.deepEqual(unguardedDisplayValues("`댓글 ${contact.comment_count}개 · ${contact.sender_id}`"), ["contact.comment_count", "contact.sender_id"]);
  assert.deepEqual(unguardedDisplayValues("`댓글 ${formatCount(contact.comment_count)}개 · ${formatText(contact.sender_id)}`"), []);
});

test("UI templates guard direct API properties beyond count field names", () => {
  for (const name of ["app", "campaign-drafts", "deletion-labels", "flow-editor", "inbox", "contact-csv-preview", "webhook-labels", "contact-identity-links", "manual-reply-reports", "flow-run-reports", "campaign-run-reports", "handoff-reports"]) {
    assert.deepEqual(unguardedDisplayValues(read(`${name}.js`)), [], name);
  }
});

test("report metrics guard absent decimal counts instead of coercing null to zero", () => {
  for (const name of ["manual-reply-reports", "handoff-reports", "flow-run-reports", "campaign-run-reports"]) assert.doesNotMatch(read(`${name}.js`), /BigInt\((?:report|group)/);
  assert.equal(values.formatCount(null), "–");
  assert.equal(values.formatCount("0"), "0");
});

test("contact field display keeps booleans and zero without leaking invalid values", () => {
  const source = read("app.js");
  const start = source.indexOf("function displayFieldValue(");
  const end = source.indexOf("function typedFieldValue(", start);
  const local = vm.createContext({ formatText: values.formatText, formatCount: values.formatCount });
  vm.runInContext(source.slice(start, end), local);
  const show = local.displayFieldValue as (value: unknown) => string;
  for (const value of [undefined, null, NaN, Infinity, {}]) assert.equal(show(value), "–");
  assert.equal(show(false), "아니요");
  assert.equal(show(0), "0");
  assert.equal(show(""), "빈 텍스트");
});
