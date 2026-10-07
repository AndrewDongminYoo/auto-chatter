import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const publicDir = new URL("../../public/", import.meta.url);
const appDir = new URL("app/", publicDir);

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map((tokens) => [tokens[0], tokens.slice(1)]),
  );
}

test("the dashboard CSP allows only same-origin scripts, with no inline or eval escape", async () => {
  const headers = await readFile(new URL("_headers", publicDir), "utf8");
  const line = headers.split("\n").find((value) => value.trim().startsWith("Content-Security-Policy:"));
  assert.ok(line, "the /app/* block must set a Content-Security-Policy");
  const policy = directives(line.trim().slice("Content-Security-Policy:".length));
  assert.deepEqual(policy.get("default-src"), ["'none'"]);
  assert.deepEqual(policy.get("script-src"), ["'self'"]);
  assert.deepEqual(policy.get("base-uri"), ["'none'"]);
  assert.deepEqual(policy.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(policy.get("form-action"), ["'self'"]);
  for (const [name, sources] of policy)
    for (const source of sources)
      assert.ok(
        !["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "data:", "*"].includes(source),
        `${name} must not allow ${source}`,
      );
});

test("dashboard scripts write user data as text, never through an HTML or code sink", async () => {
  const files = (await readdir(appDir)).filter((name) => name.endsWith(".js"));
  assert.ok(files.length > 0);
  const sinks =
    /\.(?:innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(|\beval\s*\(|new\s+Function\s*\(|\.srcdoc\s*=/;
  for (const name of files) {
    const source = await readFile(new URL(name, appDir), "utf8");
    assert.doesNotMatch(source, sinks, `${name} must not use an HTML or code sink`);
  }
});

test("the dashboard page carries no inline script or inline event handler", async () => {
  const html = await readFile(new URL("index.html", appDir), "utf8");
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? [])
    assert.match(tag, /\ssrc="[^"]+"/, `inline script is not allowed: ${tag}`);
  assert.doesNotMatch(html, /<[^>]+\son[a-z]+\s*=/i, "inline event handlers are not allowed");
  assert.doesNotMatch(html, /\bjavascript:/i);
});
