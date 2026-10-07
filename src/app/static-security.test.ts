import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const publicDir = new URL("../../public/", import.meta.url);
const appDir = new URL("app/", publicDir);
const repoDir = new URL("../../", import.meta.url);

test("only the operation log and the Node command entry points write to the console or standard streams", async () => {
  // Runtime logs must go through logOperation, which keeps an allow-listed shape; the two Node entry points print
  // fixed CLI messages. This is a text guard over src/ (an alias of console is left to review); the shape itself
  // is enforced by operations-log.ts and its tests.
  const allowed = ["app/operations-log.ts", "instagram/main.ts", "instagram/worker-main.ts"];
  const srcDir = fileURLToPath(new URL("src/", repoDir));
  const entries = await readdir(srcDir, { recursive: true, withFileTypes: true });
  const sources = entries
    .filter((entry) => entry.isFile() && /\.(?:ts|mjs|js)$/.test(entry.name) && !/\.test\.(?:ts|mjs)$/.test(entry.name))
    .map((entry) => relative(srcDir, join(entry.parentPath, entry.name)).split(sep).join("/"));
  assert.ok(sources.length > 0);
  const writers = [];
  for (const path of sources)
    if (/\bconsole\b|\bprocess\s*\.\s*std(?:out|err)\b/.test(await readFile(join(srcDir, path), "utf8")))
      writers.push(path);
  assert.deepEqual(writers.sort(), allowed);
});

test("the committed Worker configuration keeps sending and public connection off and holds no secret", async () => {
  // Secrets are Worker secrets, never vars; an exact key set means a new var is reviewed on purpose.
  const config = JSON.parse(await readFile(new URL("wrangler.json", repoDir), "utf8")) as {
    vars: Record<string, string>;
    env?: unknown;
  };
  assert.deepEqual(Object.keys(config.vars).sort(), [
    "APP_ORIGIN",
    "INSTAGRAM_OAUTH_APP_ID",
    "INSTAGRAM_PUBLIC_CONNECT_ENABLED",
    "META_GRAPH_VERSION",
    "SEND_ENABLED",
    "SUPABASE_URL",
  ]);
  assert.equal(config.vars.SEND_ENABLED, "false");
  assert.equal(config.vars.INSTAGRAM_PUBLIC_CONNECT_ENABLED, "false");
  assert.equal(config.env, undefined, "no environment may override the committed vars");
});

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

test("public/ holds no file the sink scan does not read that a browser could run", async () => {
  // Wrangler serves all of public/ same-origin, so any other script there could be loaded through a script tag, a
  // static or dynamic import or a worker without being scanned. Every served file must match this allowlist.
  const allowed = [/^_headers$/, /^app\/[a-z0-9-]+\.(?:js|html|css)$/, /^icons\/[a-z0-9-]+\.png$/];
  const entries = await readdir(publicDir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  assert.ok(files.length > 0);
  for (const entry of files) {
    const path = relative(fileURLToPath(publicDir), join(entry.parentPath, entry.name)).split(sep).join("/");
    assert.ok(
      allowed.some((pattern) => pattern.test(path)),
      `unexpected public file: ${path}`,
    );
  }
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
