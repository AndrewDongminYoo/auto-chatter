import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const publicDir = new URL("../../public/", import.meta.url);
const appDir = new URL("app/", publicDir);

// Headers of one path block in Cloudflare's _headers format: a path line followed by indented "Name: value" lines.
function blockHeaders(file: string, path: string): string[] {
  const lines = file.split("\n");
  const start = lines.findIndex((line) => line.trim() === path && !/^\s/.test(line));
  assert.notEqual(start, -1, `${path} block is missing`);
  const headers = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    headers.push(line.trim());
  }
  return headers;
}

// Browsers apply the first occurrence of a directive and ignore later ones, so a duplicate is refused outright.
function directives(policy: string): Map<string, string[]> {
  const parsed = policy
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .filter((tokens) => tokens[0]);
  const names = parsed.map((tokens) => tokens[0]!.toLowerCase());
  assert.equal(new Set(names).size, names.length, `duplicate CSP directive in: ${policy}`);
  return new Map(parsed.map((tokens) => [tokens[0]!.toLowerCase(), tokens.slice(1)]));
}

test("the dashboard CSP allows only same-origin scripts, with no inline or eval escape", async () => {
  const headers = blockHeaders(await readFile(new URL("_headers", publicDir), "utf8"), "/app/*");
  const csp = headers.filter((header) => /^content-security-policy\s*:/i.test(header));
  assert.equal(csp.length, 1, "the /app/* block must set exactly one Content-Security-Policy");
  const policy = directives(csp[0]!.slice(csp[0]!.indexOf(":") + 1));
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
  // The sink names are refused in any notation (dot, bracket or string), not only as a dotted assignment.
  const sinks =
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML|srcdoc|writeln)\b|\bdocument\s*(?:\.|\[\s*["'`])\s*write\b|\beval\b|\bFunction\s*\(/;
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
