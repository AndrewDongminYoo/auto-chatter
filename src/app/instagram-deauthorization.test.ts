import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { DEAUTHORIZE_BODY_LIMIT, parseDeauthorizeBody, verifySignedRequest } from "./instagram-deauthorization.ts";

const secret = "synthetic-secret";
const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64url");
// Signs the encoded payload string as given, so a malformed payload still carries a valid signature and the
// rejection under test cannot come from a signature mismatch.
const sign = (encodedPayload: string, key = secret) =>
  `${createHmac("sha256", key).update(encodedPayload).digest("base64url")}.${encodedPayload}`;
const valid = { algorithm: "HMAC-SHA256", issued_at: 1_760_000_000, user_id: "17841400000000001" };
const form = (signedRequest: string) =>
  new TextEncoder().encode(new URLSearchParams({ signed_request: signedRequest }).toString());

const verified = { userId: "17841400000000001", issuedAt: 1_760_000_000 };

test("a signed request verified with the app secret yields its user ID and issue time", () => {
  assert.deepEqual(verifySignedRequest(sign(encode(valid)), secret), verified);
  assert.deepEqual(parseDeauthorizeBody(form(sign(encode(valid))), secret), verified);
  // The algorithm name is compared without case, and a safe integer user ID becomes a digit string.
  assert.deepEqual(verifySignedRequest(sign(encode({ ...valid, algorithm: "hmac-sha256" })), secret), verified);
  assert.deepEqual(verifySignedRequest(sign(encode({ ...valid, user_id: 12345 })), secret), {
    ...verified,
    userId: "12345",
  });
  // Meta does not document the payload, so a request without issued_at is accepted without an issue time.
  assert.deepEqual(verifySignedRequest(sign(encode({ ...valid, issued_at: undefined })), secret), {
    ...verified,
    issuedAt: null,
  });
  // Base64url padding is accepted.
  const padded = Buffer.from(JSON.stringify({ ...valid, user_id: "1" })).toString("base64");
  assert.ok(padded.endsWith("="));
  assert.deepEqual(verifySignedRequest(sign(padded.replaceAll("+", "-").replaceAll("/", "_")), secret), {
    ...verified,
    userId: "1",
  });
});

test("a tampered payload, a tampered signature or another secret is refused", () => {
  const signed = sign(encode(valid));
  const [signature, payload] = signed.split(".") as [string, string];
  assert.equal(verifySignedRequest(`${signature}.${encode({ ...valid, user_id: "999" })}`, secret), null);
  const flipped = Buffer.from(signature, "base64url");
  flipped[0] = flipped[0]! ^ 1;
  assert.equal(verifySignedRequest(`${flipped.toString("base64url")}.${payload}`, secret), null);
  assert.equal(verifySignedRequest(signed, "other-secret"), null);
  assert.equal(verifySignedRequest(signed, ""), null);
  // A signature of the wrong length is refused before the comparison, which would throw.
  assert.equal(verifySignedRequest(`${Buffer.alloc(16).toString("base64url")}.${payload}`, secret), null);
});

test("a correctly signed payload with the wrong algorithm, user ID or issue time is refused", () => {
  for (const payload of [
    { ...valid, algorithm: "HMAC-SHA1" },
    { user_id: "1" },
    { ...valid, user_id: undefined },
    { ...valid, user_id: "" },
    { ...valid, user_id: "12a" },
    { ...valid, user_id: "-1" },
    { ...valid, user_id: 0 },
    { ...valid, user_id: 1.5 },
    // Above 2^53 the parser has already rounded the number.
    { ...valid, user_id: 2 ** 53 },
    { ...valid, user_id: "1".repeat(65) },
    // A present issued_at must be whole positive seconds.
    { ...valid, issued_at: "1760000000" },
    { ...valid, issued_at: 1_760_000_000.5 },
    { ...valid, issued_at: 0 },
    { ...valid, issued_at: -1 },
    { ...valid, issued_at: null },
  ])
    assert.equal(verifySignedRequest(sign(encode(payload)), secret), null, JSON.stringify(payload));
  for (const encoded of [encode([valid]), encode("text"), Buffer.from("{not json").toString("base64url")])
    assert.equal(verifySignedRequest(sign(encoded), secret), null, encoded);
});

test("a request without a dot or with characters outside base64url is refused", () => {
  const signed = sign(encode(valid));
  const [signature, payload] = signed.split(".") as [string, string];
  assert.equal(verifySignedRequest(signature + payload, secret), null);
  assert.equal(verifySignedRequest(`.${payload}`, secret), null);
  assert.equal(verifySignedRequest(`${signature}.`, secret), null);
  // The payload is signed as written, so only the alphabet check can refuse it.
  for (const encoded of [`${payload}!`, `${payload}+`, `${payload}/`, `${payload}.x`])
    assert.equal(verifySignedRequest(sign(encoded), secret), null, encoded);
  assert.equal(verifySignedRequest(`${signature.slice(0, -1)}*.${payload}`, secret), null);
});

test("a callback body must hold exactly one signed_request and stay within the size limit", () => {
  const signed = sign(encode(valid));
  const encoder = new TextEncoder();
  assert.equal(parseDeauthorizeBody(new Uint8Array(), secret), null);
  assert.equal(parseDeauthorizeBody(encoder.encode(`other=${signed}`), secret), null);
  assert.equal(parseDeauthorizeBody(encoder.encode(`signed_request=${signed}&signed_request=${signed}`), secret), null);
  assert.equal(parseDeauthorizeBody(encoder.encode(JSON.stringify({ signed_request: signed })), secret), null);
  assert.equal(parseDeauthorizeBody(new Uint8Array([0xff, 0xfe]), secret), null);
  // Padding with another field keeps the signed request valid, so only the size can refuse it.
  const atLimit = `signed_request=${signed}&pad=`;
  const fits = encoder.encode(atLimit + "x".repeat(DEAUTHORIZE_BODY_LIMIT - atLimit.length));
  assert.equal(fits.byteLength, DEAUTHORIZE_BODY_LIMIT);
  assert.deepEqual(parseDeauthorizeBody(fits, secret), verified);
  const oversized = encoder.encode(atLimit + "x".repeat(DEAUTHORIZE_BODY_LIMIT - atLimit.length + 1));
  assert.equal(parseDeauthorizeBody(oversized, secret), null);
});
