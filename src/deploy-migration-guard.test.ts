import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

// scripts/deploy-migration-guard.sh runs in the deploy workflow against Cloudflare; here a fake Wrangler
// serves the active deployment and a throwaway git repository supplies the commit range.
const guard = fileURLToPath(new URL("../scripts/deploy-migration-guard.sh", import.meta.url));
const versionId = "1a319e19-e02b-472f-8dbf-ae83b6cabfde";
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "guard@example.com",
  GIT_AUTHOR_NAME: "guard",
  GIT_COMMITTER_EMAIL: "guard@example.com",
  GIT_COMMITTER_NAME: "guard",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

let dir = "";
let repo = "";
let fakeWrangler = "";
let fakeBin = "";
const commits = { base: "", chore: "", migration: "" };

function git(...args: string[]): string {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: gitEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(path: string, content: string, message: string): string {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
  git("add", path);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

function runGuard(sha: string, options: { tag?: string; applied?: boolean; deployment?: string; version?: string }) {
  const summary = join(dir, `summary-${Math.random().toString(36).slice(2)}.md`);
  const deployment = options.deployment ?? JSON.stringify({ versions: [{ version_id: versionId, percentage: 100 }] });
  const annotations: Record<string, string> = { "workers/triggered_by": "version_upload" };
  if (options.tag) annotations["workers/tag"] = options.tag;
  const result = spawnSync("bash", [guard, sha], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...gitEnv,
      FAKE_DEPLOYMENT: deployment,
      FAKE_VERSION: options.version ?? JSON.stringify({ id: versionId, annotations }),
      GITHUB_STEP_SUMMARY: summary,
      MIGRATIONS_APPLIED: options.applied ? "true" : "false",
      // A jq that always fails comes first, so any use of jq by the guard fails these tests.
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      WRANGLER: fakeWrangler,
    },
  });
  let summaryText = "";
  try {
    summaryText = readFileSync(summary, "utf8");
  } catch {
    // The guard writes a summary only when it stops or proceeds by override.
  }
  return { status: result.status, output: result.stdout + result.stderr, summary: summaryText };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "deploy-guard-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  fakeWrangler = join(dir, "fake-wrangler");
  writeFileSync(
    fakeWrangler,
    [
      "#!/usr/bin/env bash",
      'case "$1" in',
      '  deployments) printf "%s\\n" "$FAKE_DEPLOYMENT" ;;',
      `  versions) [ "$3" = ${versionId} ] || exit 9; printf "%s\\n" "$FAKE_VERSION" ;;`,
      "  *) exit 7 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(fakeWrangler, 0o755);
  fakeBin = join(dir, "bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "jq"), "#!/bin/sh\necho 'jq must not be used' >&2\nexit 127\n");
  chmodSync(join(fakeBin, "jq"), 0o755);
  git("init", "-q");
  commits.base = commit("README.md", "base\n", "base");
  commits.chore = commit("package.json", "{}\n", "chore");
  commits.migration = commit("db/migrations/070_example.sql", "SELECT 1;\n", "migration");
});

after(() => {
  rmSync(dir, { force: true, recursive: true });
});

test("the migration guard lets a range without database files deploy", () => {
  const result = runGuard(commits.chore, { tag: commits.base });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /no database change/);
});

test("the migration guard stops a range that changes a migration and names the file", () => {
  const result = runGuard(commits.migration, { tag: commits.chore });
  assert.equal(result.status, 1, result.output);
  assert.match(result.summary, /Deploy stopped by the migration guard/);
  assert.match(result.summary, /`db\/migrations\/070_example\.sql`/);
  assert.match(result.summary, /migrations_applied: true/);
});

function assertStops(result: ReturnType<typeof runGuard>, reason: RegExp) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, reason);
  assert.match(result.summary, /Deploy stopped by the migration guard/);
}

test("the migration guard stops when the active version has no usable tag", () => {
  assertStops(runGuard(commits.chore, {}), /version \S+ has no workers\/tag/);
  assertStops(runGuard(commits.chore, { tag: "main" }), /is not a full commit SHA/);
  assertStops(runGuard(commits.chore, { tag: "0".repeat(40) }), /is not in this repository/);
  // A tag that is not an ancestor of the deploy commit.
  assertStops(runGuard(commits.base, { tag: commits.chore }), /is not an ancestor of/);
  assertStops(runGuard(commits.chore, { version: "warning\n{" }), /output for version \S+ is not JSON/);
});

test("the migration guard stops when the active deployment is split or unreadable", () => {
  const split = JSON.stringify({
    versions: [
      { version_id: versionId, percentage: 60 },
      { version_id: "other", percentage: 40 },
    ],
  });
  assertStops(runGuard(commits.chore, { tag: commits.base, deployment: split }), /not one version at 100%/);
  assertStops(
    runGuard(commits.chore, { tag: commits.base, deployment: "warning\n{" }),
    /deployment output is not JSON/,
  );
});

test("the migration guard names a missing git or node instead of guessing a cause", () => {
  const empty = join(dir, "empty-path");
  mkdirSync(empty, { recursive: true });
  const result = spawnSync("/bin/bash", [guard, commits.chore], {
    cwd: repo,
    encoding: "utf8",
    env: { ...gitEnv, PATH: empty, WRANGLER: fakeWrangler },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /git is required/);
});

test("a manual run with migrations_applied proceeds past a stop", () => {
  const untagged = runGuard(commits.chore, { applied: true });
  assert.equal(untagged.status, 0, untagged.output);
  assert.match(untagged.summary, /proceeding because `migrations_applied` is true/);
  assert.equal(runGuard(commits.migration, { tag: commits.chore, applied: true }).status, 0);
});
