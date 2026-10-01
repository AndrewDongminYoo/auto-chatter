import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  ConfigurationError,
  failureCode,
  logOperation,
  operationLogEntry,
  TokenRefreshFailedError,
} from "./operations-log.ts";

test("operation logs drop disallowed keys and allowed keys whose value has the wrong shape", () => {
  const lines: unknown[][] = [];
  const error = mock.method(console, "error", (...args: unknown[]) => lines.push(args));
  try {
    logOperation({
      event: "queue_publish_failed",
      code: "reply_notification_failed",
      correlation_id: "8c1f2e3d4b5a6978-ICN",
      connection_id: "22222222-2222-4222-8222-222222222222",
      step: "wake",
      // Disallowed keys passed by mistake must never be written.
      ...({
        body: '{"entry":[{"text":"hello"}]}',
        access_token: "EAAB-secret",
        email: "owner@example.test",
        text: "comment text",
        error: "Meta Graph says token EAAB-secret",
      } as object),
    });
    logOperation({
      event: "Request failed: owner@example.test",
      code: "duplicate key value (comment text)",
      correlation_id: "has spaces and @",
      connection_id: "not-a-uuid",
      step: "unknown_step" as "wake",
    });
  } finally {
    error.mock.restore();
  }
  // Each call writes one argument: a single-line JSON string that line-based collectors can parse.
  for (const args of lines) {
    assert.equal(args.length, 1);
    assert.equal(typeof args[0], "string");
    assert.ok(!(args[0] as string).includes("\n"));
  }
  assert.deepEqual(lines, [
    [
      JSON.stringify({
        event: "queue_publish_failed",
        code: "reply_notification_failed",
        correlation_id: "8c1f2e3d4b5a6978-ICN",
        connection_id: "22222222-2222-4222-8222-222222222222",
        step: "wake",
      }),
    ],
    ["{}"],
  ]);
  assert.deepEqual(operationLogEntry({ event: "x", code: 7, correlation_id: { toString: () => "y" } }), {
    event: "x",
  });
});

test("log levels map to the matching console method", () => {
  const seen: string[] = [];
  const restore = ["log", "warn", "error"].map((method) =>
    mock.method(console, method as "log", () => seen.push(method)),
  );
  try {
    logOperation({ event: "alert_cleared", code: "alert_cron_stale" }, "info");
    logOperation({ event: "alert_started", code: "alert_cron_stale" }, "warn");
    logOperation({ event: "cron_step_failed", code: "database_error" });
  } finally {
    for (const method of restore) method.mock.restore();
  }
  assert.deepEqual(seen, ["log", "warn", "error"]);
});

test("failure codes come from the error class and code, never from the message", () => {
  assert.equal(failureCode(new ConfigurationError("Token encryption not configured")), "not_configured");
  assert.equal(failureCode(new TokenRefreshFailedError()), "token_refresh_failed");
  assert.equal(
    failureCode(Object.assign(new Error("terminating connection"), { code: "57P01" })),
    "database_unavailable",
  );
  assert.equal(failureCode(Object.assign(new Error("connection failure"), { code: "08006" })), "database_unavailable");
  assert.equal(
    failureCode(Object.assign(new Error("duplicate key (secret text)"), { code: "23505" })),
    "database_error",
  );
  assert.equal(
    failureCode(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
    "connection_unavailable",
  );
  assert.equal(failureCode(new Error("owner@example.test")), "unexpected_error");
  assert.equal(failureCode("thrown string"), "unexpected_error");
});
