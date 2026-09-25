import { Pool } from "pg";
import { FacebookPrivateReplyTransport, type FacebookPrivateReplyConfig } from "./facebook-private-reply.ts";
import { runPrivateReplyWorker } from "./reply-worker.ts";

const mode = process.argv[2];
if (mode !== "--check-permissions" && mode !== "--run") {
  process.stderr.write("Usage: worker-main.ts --check-permissions|--run\n");
  process.exitCode = 2;
} else {
  const names = [
    "META_GRAPH_VERSION",
    "META_APP_ID",
    "META_APP_ACCESS_TOKEN",
    "META_USER_ACCESS_TOKEN",
    "META_PAGE_ID",
    "META_INSTAGRAM_ACCOUNT_ID",
    "META_INSTAGRAM_CONNECTION_ID",
    ...(mode === "--run" ? ["DATABASE_URL"] : []),
  ];
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    process.stderr.write(`Missing environment variables: ${missing.join(", ")}\n`);
    process.exitCode = 2;
  } else {
    const config: FacebookPrivateReplyConfig = {
      graphVersion: process.env.META_GRAPH_VERSION!,
      appId: process.env.META_APP_ID!,
      appAccessToken: process.env.META_APP_ACCESS_TOKEN!,
      userAccessToken: process.env.META_USER_ACCESS_TOKEN!,
      pageId: process.env.META_PAGE_ID!,
      accountId: process.env.META_INSTAGRAM_ACCOUNT_ID!,
      connectionId: process.env.META_INSTAGRAM_CONNECTION_ID!,
    };
    try {
      const transport = new FacebookPrivateReplyTransport(config);
      const inspection = await transport.inspectPermissions();
      if (!inspection.verified) {
        const missingPermissions = inspection.missingPermissions?.join(", ");
        process.stderr.write(`Meta access not verified: ${inspection.reason}${missingPermissions ? ` (${missingPermissions})` : ""}\n`);
        process.exitCode = 1;
      } else if (mode === "--check-permissions") {
        process.stdout.write("Meta token scopes, Page link, and MESSAGING task verified. App Review and Human Agent status require separate confirmation.\n");
      } else {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
        try {
          const connection = await pool.query<{ account_id: string; active: boolean }>(
            "SELECT account_id, active FROM instagram_connections WHERE id = $1",
            [config.connectionId],
          );
          if (connection.rows[0]?.account_id !== config.accountId || connection.rows[0].active !== true) {
            process.stderr.write("Configured Instagram connection is inactive or mismatched\n");
            process.exitCode = 1;
          } else {
            const controller = new AbortController();
            const stop = (): void => controller.abort();
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            try {
              process.stdout.write(`Instagram private reply worker started for connection ${config.connectionId}\n`);
              await runPrivateReplyWorker(pool, transport, controller.signal, 1000, config.connectionId);
            } finally {
              process.off("SIGINT", stop);
              process.off("SIGTERM", stop);
            }
          }
        } finally {
          await pool.end();
        }
      }
    } catch (error) {
      const message = error instanceof Error && /^(Invalid Meta|Meta Graph)/.test(error.message)
        ? error.message : "Instagram worker failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
