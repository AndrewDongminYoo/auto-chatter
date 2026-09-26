import assert from "node:assert/strict";
import { test } from "node:test";
import { sealSecret, openSecret } from "./secrets.ts";

const key = Buffer.alloc(32, 7).toString("base64");
test("encrypted tokens are randomized and bound to their workspace and Instagram account", () => {
  const context = "workspace-a:account-a";
  const encrypted = sealSecret("test-access-token", key, context);
  assert.notEqual(encrypted, sealSecret("test-access-token", key, context));
  assert.equal(encrypted.includes("test-access-token"), false);
  assert.equal(openSecret(encrypted, key, context), "test-access-token");
  assert.throws(() => openSecret(encrypted, key, "workspace-b:account-a"));
  assert.throws(() => openSecret(encrypted, key, "workspace-a:account-b"));
  assert.throws(() => openSecret(encrypted, Buffer.alloc(32, 8).toString("base64"), context));
  assert.throws(() => openSecret(encrypted.slice(0, -4) + "AAAA", key, context));
});
test("invalid encryption keys are rejected", () => {
  for (const key of ["", "short", Buffer.alloc(16).toString("base64")])
    assert.throws(() => sealSecret("token", key, "scope"));
});
