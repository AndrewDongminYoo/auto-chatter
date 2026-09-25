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
