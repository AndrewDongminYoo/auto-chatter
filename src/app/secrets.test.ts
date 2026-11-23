import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { test } from "node:test";
import { currentKeyPrefix, openSecret, sealSecret, tokenKeys } from "./secrets.ts";

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
  for (const key of ["", "short", Buffer.alloc(16).toString("base64")]) assert.throws(() => sealSecret("token", key, "scope"));
  // An invalid previous key fails as early as an invalid current key, also when sealing.
  assert.throws(() => sealSecret("token", { current: key, previous: "short" }, "scope"), /Invalid token encryption key/);
});

const previous = Buffer.alloc(32, 9).toString("base64");
const other = Buffer.alloc(32, 8).toString("base64");

// The envelope written before #61, with no key identifier.
function sealV1(value: string, masterKey: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(masterKey, "base64"), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

test("secrets are sealed with the current key only, under its identifier", () => {
  const sealed = sealSecret("token", { current: key, previous }, "scope");
  assert.equal(sealed.startsWith(currentKeyPrefix(key)), true);
  assert.equal(sealed.startsWith(currentKeyPrefix(previous)), false);
  assert.notEqual(currentKeyPrefix(key), currentKeyPrefix(previous));
  assert.equal(currentKeyPrefix({ current: key, previous }), currentKeyPrefix(key));
  assert.equal(openSecret(sealed, key, "scope"), "token");
  assert.throws(() => openSecret(sealed, previous, "scope"), /Unknown token encryption key/);
  // The identifier says nothing about the key bytes.
  assert.equal(sealed.includes(key), false);
});

test("a ring opens secrets sealed with the previous key, in either envelope", () => {
  const ringKeys = { current: key, previous };
  const v2 = sealSecret("old-token", previous, "scope");
  const v1 = sealV1("old-token", previous, "scope");
  assert.equal(openSecret(v2, ringKeys, "scope"), "old-token");
  assert.equal(openSecret(v1, ringKeys, "scope"), "old-token");
  assert.equal(openSecret(sealV1("token", key, "scope"), ringKeys, "scope"), "token");
  // Without the previous key, and with a key that sealed neither, they stay closed.
  assert.throws(() => openSecret(v2, key, "scope"), /Unknown token encryption key/);
  assert.throws(() => openSecret(v1, key, "scope"));
  assert.throws(() => openSecret(v1, { current: other, previous: key }, "scope"));
  // The context still binds both envelopes under a ring.
  assert.throws(() => openSecret(v2, ringKeys, "other-scope"));
  assert.throws(() => openSecret(v1, ringKeys, "other-scope"));
  // A swapped identifier or a tampered ciphertext does not open.
  const parts = v2.split(".");
  assert.throws(() => openSecret([parts[0], currentKeyPrefix(key).split(".")[1], ...parts.slice(2)].join("."), ringKeys, "scope"));
  assert.throws(() => openSecret(v2.slice(0, -4) + "AAAA", ringKeys, "scope"));
  for (const malformed of ["v2.a.b.c", "v3.a.b.c.d", "v1.a.b.c.d", ""]) assert.throws(() => openSecret(malformed, ringKeys, "scope"), /Invalid encrypted token/);
});

test("the environment ring needs a current key and ignores an empty previous key", () => {
  assert.equal(tokenKeys({}), undefined);
  assert.equal(tokenKeys({ TOKEN_ENCRYPTION_KEY: "", TOKEN_ENCRYPTION_KEY_PREVIOUS: previous }), undefined);
  assert.deepEqual(tokenKeys({ TOKEN_ENCRYPTION_KEY: key }), { current: key, previous: undefined });
  assert.deepEqual(tokenKeys({ TOKEN_ENCRYPTION_KEY: key, TOKEN_ENCRYPTION_KEY_PREVIOUS: "" }), { current: key, previous: undefined });
  assert.deepEqual(tokenKeys({ TOKEN_ENCRYPTION_KEY: key, TOKEN_ENCRYPTION_KEY_PREVIOUS: previous }), { current: key, previous });
});
