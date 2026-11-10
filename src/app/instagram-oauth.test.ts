import assert from "node:assert/strict";
import { test } from "node:test";
import { oauthProviderFailureCode, providerErrorParts, type OAuthProviderStep } from "./instagram-oauth.ts";
import { operationLogEntry } from "./operations-log.ts";

const sentinels = {
  message: "SENTINEL message text",
  error_user_msg: "SENTINEL user message",
  error_user_title: "SENTINEL title",
  fbtrace_id: "SENTINEL-trace",
};

test("a Graph error body gives its type, code and subcode", () => {
  const parts = providerErrorParts({
    error: { type: "OAuthException", code: 100, error_subcode: 33, ...sentinels },
  });
  assert.deepEqual(parts, ["oauthexception", "100", "33"]);
  assert.equal(
    oauthProviderFailureCode("code_exchange", "http_400", parts),
    "code_exchange_http_400_oauthexception_100_33",
  );
  assert.deepEqual(providerErrorParts({ error: { type: "OAuthException", code: 100 } }), ["oauthexception", "100"]);
});

test("the documented Instagram code-exchange error body gives its error type and code", () => {
  // https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
  const parts = providerErrorParts({
    error_type: "OAuthException",
    code: 400,
    error_message: "Matching code was not found or was already used",
  });
  assert.deepEqual(parts, ["oauthexception", "400"]);
  assert.equal(
    oauthProviderFailureCode("code_exchange", "http_400", parts),
    "code_exchange_http_400_oauthexception_400",
  );
});

test("a body with both shapes uses the Graph error object, and an invalid one falls back to the Instagram fields", () => {
  assert.deepEqual(
    providerErrorParts({ error: { type: "GraphMethodException", code: 190 }, error_type: "OAuthException", code: 400 }),
    ["graphmethodexception", "190"],
  );
  assert.deepEqual(providerErrorParts({ error: { type: "", code: 190 }, error_type: "OAuthException", code: 400 }), [
    "oauthexception",
    "400",
  ]);
});

test("provider error parts are read only from fields of the strict shape", () => {
  const rejected: unknown[] = [
    undefined,
    null,
    "OAuthException",
    [{ error: { type: "OAuthException", code: 100 } }],
    { error: "OAuthException" },
    { error: { type: "OAuthException", code: "100" } },
    { error: { type: "OAuthException", code: -1 } },
    { error: { type: "OAuthException", code: 1.5 } },
    { error: { type: "OAuthException", code: 2 ** 53 } },
    { error: { type: "OAuthException" } },
    { error: { code: 100 } },
    { error: { type: 7, code: 100 } },
    { error: { type: "!!!", code: 100 } },
    { error: { type: "OAuthException", code: 100, error_subcode: "33" } },
    { error: { type: "OAuthException", code: 100, error_subcode: null } },
    { error_type: "OAuthException" },
    { error_type: "OAuthException", code: "400" },
    { code: 400 },
    { error_message: "Matching code was not found", ...sentinels },
    { error: { message: "SENTINEL", error_user_msg: "SENTINEL", fbtrace_id: "SENTINEL" } },
  ];
  for (const body of rejected) assert.deepEqual(providerErrorParts(body), [], JSON.stringify(body));
});

test("the provider type is lowercased, keeps only letters and digits, and is capped at 24 characters", () => {
  assert.deepEqual(providerErrorParts({ error: { type: "OAuth Exception (#100)!", code: 1 } }), [
    "oauthexception100",
    "1",
  ]);
  assert.deepEqual(providerErrorParts({ error: { type: "A".repeat(40), code: 1 } }), ["a".repeat(24), "1"]);
  assert.deepEqual(providerErrorParts({ error: { type: "é OAuth-Exception ñ", code: 1 } }), ["oauthexception", "1"]);
});

test("every composed code passes the operations log rule, dropping optional parts from the end", () => {
  const steps: OAuthProviderStep[] = ["code_exchange", "long_lived_exchange", "profile", "subscribe"];
  const failures = [
    "network",
    "http_599",
    "invalid_json",
    "invalid_shape",
    "invalid_shape_missing_token",
    "invalid_shape_expires_in_type",
    "invalid_shape_expires_in_range",
    "not_success",
  ];
  const big = Number.MAX_SAFE_INTEGER;
  const worst = providerErrorParts({ error: { type: "X".repeat(64), code: big, error_subcode: big } });
  assert.deepEqual(worst, ["x".repeat(24), String(big), String(big)]);
  for (const step of steps)
    for (const failure of failures)
      for (const parts of [[], ["oauthexception", "100", "33"], worst]) {
        const code = oauthProviderFailureCode(step, failure, parts);
        assert.ok(code.length <= 64, code);
        assert.equal(
          operationLogEntry({ event: "instagram_oauth_provider_failed", code }).code,
          code,
          `${code} is dropped by logOperation`,
        );
        assert.ok(code.startsWith(`${step}_${failure}`), code);
      }
  // The type fits, the 16-digit code does not, so the code and the subcode after it are both dropped.
  assert.equal(
    oauthProviderFailureCode("long_lived_exchange", "http_599", worst),
    `long_lived_exchange_http_599_${"x".repeat(24)}`,
  );
  assert.equal(oauthProviderFailureCode("profile", "http_400", worst), `profile_http_400_${"x".repeat(24)}_${big}`);
});
