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
  // Keywords, schemes and hosts match ASCII case-insensitively, so 'UNSAFE-INLINE' and DATA: count as the lowercase forms.
  return new Map(
    parsed.map((tokens) => [tokens[0]!.toLowerCase(), tokens.slice(1).map((source) => source.toLowerCase())]),
  );
}

test("the dashboard CSP allows only same-origin scripts, with no inline or eval escape", async () => {
  const file = await readFile(new URL("_headers", publicDir), "utf8");
  // A "! Name" line in any block removes a header that a more general rule added, so no rule may detach the CSP.
  assert.doesNotMatch(file, /^\s*!\s*content-security-policy\b/im, "no rule may detach the CSP");
  const headers = blockHeaders(file, "/app/*");
  const csp = headers.filter((header) => /^content-security-policy\s*:/i.test(header));
  assert.equal(csp.length, 1, "the /app/* block must set exactly one Content-Security-Policy");
  const policy = directives(csp[0]!.slice(csp[0]!.indexOf(":") + 1));
  // An allowlist of directive names, so any new directive (script-src-elem, script-src-attr, worker-src, ...)
  // that could override or widen script-src fails here and has to be reviewed on purpose.
  assert.deepEqual([...policy.keys()].sort(), [
    "base-uri",
    "connect-src",
    "default-src",
    "form-action",
    "frame-ancestors",
    "img-src",
    "script-src",
    "style-src",
  ]);
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

// The dashboard scripts the sink scan reads; the page test refuses any script that is not one of them.
const scannedScripts = async () => (await readdir(appDir)).filter((name) => name.endsWith(".js"));

test("public/app holds only the page, the stylesheet and scanned scripts", async () => {
  // Any other file, a subdirectory or a module such as payload.mjs could be loaded same-origin without being scanned.
  for (const entry of await readdir(appDir, { withFileTypes: true }))
    assert.ok(entry.isFile() && /^[a-z0-9-]+\.(?:js|html|css)$/.test(entry.name), `unexpected entry: ${entry.name}`);
});

test("dashboard scripts write user data as text, never through an HTML or code sink", async () => {
  const files = await scannedScripts();
  assert.ok(files.length > 0);
  // The sink names are refused as words in any notation (dot, optional chaining, bracket or string), and
  // document.write in any of those forms; dynamic import() is refused so no unscanned module is loaded.
  // This is a best-effort text guard, not a parser: an alias such as `const d = document; d.write(x)` is outside it
  // and is left to code review. Script execution itself is enforced by the CSP test above.
  const sinks =
    /\b(?:innerHTML|outerHTML|insertAdjacentHTML|srcdoc|writeln|eval|Function|createContextualFragment|parseFromString|setHTMLUnsafe|parseHTMLUnsafe)\b|\bdocument\s*(?:\?\.|\.)?\s*(?:\[\s*["'`]\s*)?write\b|\bimport\s*\(/;
  for (const name of files) {
    const source = await readFile(new URL(name, appDir), "utf8");
    assert.doesNotMatch(source, sinks, `${name} must not use an HTML or code sink`);
  }
});

test("the dashboard page carries no inline script or inline event handler", async () => {
  const html = await readFile(new URL("index.html", appDir), "utf8");
  const scanned = await scannedScripts();
  // Every script must be exactly one of the files the sink scan reads: no inline body, no other host, no other
  // directory and no name that only matches the scan in a different letter case.
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    const src = /\ssrc="\.\/([^"/]+)"/.exec(tag)?.[1];
    assert.ok(src && scanned.includes(src), `only scanned dashboard script files are allowed: ${tag}`);
  }
  // Quoted attribute values are blanked first, so a ">" inside an earlier value cannot hide a later handler.
  const unquoted = html.replace(/"[^"]*"|'[^']*'/g, '""');
  assert.doesNotMatch(unquoted, /<[^>]+\son[a-z]+\s*=/i, "inline event handlers are not allowed");
  assert.doesNotMatch(html, /\bjavascript:/i);
});
