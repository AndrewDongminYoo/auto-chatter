import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const entrypoint = new URL("./worker-main.ts", import.meta.url);

for (const mode of ["--check-permissions", "--run"]) {
  test(`${mode} refuses to start without Meta credentials`, () => {
    const result = spawnSync(process.execPath, [entrypoint.pathname, mode], {
      env: {},
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /META_APP_ACCESS_TOKEN/);
    assert.match(result.stderr, /META_USER_ACCESS_TOKEN/);
    assert.doesNotMatch(result.stdout, /verified|started/);
  });
}

for (const mode of ["--check-permissions", "--run"]) {
  test(`${mode} in Instagram Login mode requires an Instagram token`, () => {
    const result = spawnSync(process.execPath, [entrypoint.pathname, mode], {
      env: { META_LOGIN_MODE: "instagram", META_GRAPH_VERSION: "v25.0", META_INSTAGRAM_ACCOUNT_ID: "789" },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /META_INSTAGRAM_ACCESS_TOKEN/);
    assert.doesNotMatch(result.stderr, /META_APP_ACCESS_TOKEN/);
    if (mode === "--run") assert.match(result.stderr, /META_INSTAGRAM_CONNECTION_ID/);
    else assert.doesNotMatch(result.stderr, /META_INSTAGRAM_CONNECTION_ID/);
  });
}

test("an unsupported login mode is rejected before any Meta call", () => {
  const result = spawnSync(process.execPath, [entrypoint.pathname, "--check-permissions"], {
    env: { META_LOGIN_MODE: "other" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /META_LOGIN_MODE must be facebook or instagram/);
});
