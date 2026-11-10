import { Pool } from "pg";
import { logOperation } from "../app/operations-log.ts";

// The one place every Worker database pool is created: webhook, deauthorize, API, Queue and Cron.
export function openPool(env: { HYPERDRIVE: { connectionString: string } }, correlationId?: string): Pool {
  // Connections belong to one invocation; Hyperdrive owns the upstream pool.
  const pool = new Pool({
    connectionString: env.HYPERDRIVE.connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
  // Once end() starts, an error is the close of a connection this invocation already finished with (#319): pg-pool
  // resolves end() before the socket closes, and closing a workerd socket rejects its pending read with an error that
  // pg's connection does not treat as a disconnect, so it reaches this listener during or after end(). A query never
  // reports here: pg-pool detaches this listener from a checked-out client, so a query error goes to that query.
  pool.on("error", () => {
    if (pool.ending) return;
    logOperation({ event: "database_connection_error", code: "database_unavailable", correlation_id: correlationId });
  });
  return pool;
}
