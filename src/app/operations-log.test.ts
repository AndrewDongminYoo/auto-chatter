import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mock, test } from "node:test";
import { Client } from "pg";
import { ConfigurationError, failureCode, logOperation, operationLogEntry, SubscriptionCheckFailedError, TokenRefreshFailedError } from "./operations-log.ts";

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

test("operation logs keep a part only when it names a campaign_start part", () => {
  for (const part of ["start", "sweep", "complete"] as const) assert.deepEqual(operationLogEntry({ event: "cron_step_part_failed", code: "database_error", step: "campaign_start", part }), { event: "cron_step_part_failed", code: "database_error", step: "campaign_start", part });
  for (const part of ["bogus", "Start", "start ", "", "campaign_start"])
    assert.deepEqual(operationLogEntry({ event: "cron_step_part_failed", code: "database_error", step: "campaign_start", part }), { event: "cron_step_part_failed", code: "database_error", step: "campaign_start" });
  assert.deepEqual(operationLogEntry({ event: "x", part: { toString: () => "start" } }), { event: "x" });
});

test("log levels map to the matching console method", () => {
  const seen: string[] = [];
  const restore = ["log", "warn", "error"].map((method) => mock.method(console, method as "log", () => seen.push(method)));
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
  assert.equal(failureCode(new SubscriptionCheckFailedError()), "subscription_check_failed");
  assert.equal(failureCode(Object.assign(new Error("terminating connection"), { code: "57P01" })), "database_unavailable");
  assert.equal(failureCode(Object.assign(new Error("connection failure"), { code: "08006" })), "database_unavailable");
  assert.equal(failureCode(Object.assign(new Error("duplicate key (secret text)"), { code: "23505" })), "database_error");
  assert.equal(failureCode(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), "connection_unavailable");
  assert.equal(failureCode(new Error("owner@example.test")), "unexpected_error");
  assert.equal(failureCode("thrown string"), "unexpected_error");
  // The fixed pg messages count only on a plain Error without a code and only as an exact match.
  assert.equal(failureCode(new Error("Query read timeout (owner@example.test)")), "unexpected_error");
  assert.equal(failureCode(new TypeError("Query read timeout")), "unexpected_error");
  assert.equal(failureCode(Object.assign(new Error("Connection terminated unexpectedly"), { code: "XX000" })), "database_error");
  assert.equal(failureCode({ message: "Query read timeout" }), "unexpected_error");
});

// A minimal PostgreSQL server for one real pg client: it accepts the startup message without a password
// (AuthenticationOk, then ReadyForQuery) and hands each later client message to onMessage.
async function fakePostgres(onMessage: (socket: Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let started = false;
    socket.on("data", () => {
      if (started) return onMessage(socket);
      started = true;
      const authenticationOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
      const readyForQuery = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
      socket.write(Buffer.concat([authenticationOk, readyForQuery]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function realPgQueryError(onMessage: (socket: Socket) => void): Promise<unknown> {
  const server = await fakePostgres(onMessage);
  const client = new Client({ host: "127.0.0.1", port: server.port, user: "test", database: "test", query_timeout: 50, ssl: false });
  // A dropped connection is also emitted on the client; the query's rejection is what the callers see.
  client.on("error", () => {});
  try {
    await client.connect();
    return await client.query("SELECT 1").then(
      () => assert.fail("the query should fail"),
      (error: unknown) => error,
    );
  } finally {
    await server.close();
    await client.end().catch(() => {});
  }
}

test("failure codes classify the query timeout and dropped connection errors a real pg client raises", async () => {
  // The server never answers the query, so pg's query_timeout fires.
  const timeout = await realPgQueryError(() => {});
  assert.equal(failureCode(timeout), "database_timeout");
  // The server closes the socket on the query, as a dropped database connection does.
  const dropped = await realPgQueryError((socket) => socket.destroy());
  assert.equal(failureCode(dropped), "database_unavailable");
});
