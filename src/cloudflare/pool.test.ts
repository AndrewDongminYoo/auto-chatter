import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { openPool } from "./pool.ts";

// The pools below never connect: the address is never dialled, because no test runs a query.
const env = { HYPERDRIVE: { connectionString: "postgres://user:password@127.0.0.1:9/automations_test" } };
const correlationId = "8c1f2e3d4b5a6978-ICN";
let lines: { level: string; entry: unknown }[];

beforeEach(() => {
  lines = [];
  for (const level of ["log", "warn", "error"] as const)
    mock.method(console, level, (line: string) => lines.push({ level, entry: JSON.parse(line) }));
});
afterEach(() => mock.restoreAll());

test("a pool error while the invocation still uses the pool logs database_connection_error", async () => {
  const pool = openPool(env, correlationId);
  pool.emit("error", new Error("Connection terminated unexpectedly"));
  await pool.end();
  assert.deepEqual(lines, [
    {
      level: "error",
      entry: { event: "database_connection_error", code: "database_unavailable", correlation_id: correlationId },
    },
  ]);
});

test("a pool error once the pool started ending is not logged (#319)", async () => {
  const pool = openPool(env, correlationId);
  // pg-pool resolves end() before the socket close finishes, so on workerd the close-time rejection arrives both
  // while end() runs and after it resolved.
  const ending = pool.end();
  pool.emit("error", new Error("Stream was cancelled."));
  await ending;
  pool.emit("error", new Error("Stream was cancelled."));
  assert.deepEqual(lines, []);
});
