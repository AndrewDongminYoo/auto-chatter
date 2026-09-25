import { Pool } from "pg";
import { FacebookPrivateReplyTransport, type FacebookPrivateReplyConfig } from "./facebook-private-reply.ts";
import {
  InstagramLoginPrivateReplyTransport,
  type InstagramLoginPrivateReplyConfig,
} from "./instagram-login-private-reply.ts";
import { runPrivateReplyWorker } from "./reply-worker.ts";

const mode = process.argv[2];
const loginMode = process.env.META_LOGIN_MODE ?? "facebook";
if (mode !== "--check-permissions" && mode !== "--run") {
  process.stderr.write("Usage: worker-main.ts --check-permissions|--run\n");
  process.exitCode = 2;
} else if (loginMode !== "facebook" && loginMode !== "instagram") {
  process.stderr.write("META_LOGIN_MODE must be facebook or instagram\n");
  process.exitCode = 2;
} else {
  const names = [
    "META_GRAPH_VERSION",
    "META_INSTAGRAM_ACCOUNT_ID",
    ...(loginMode === "facebook"
      ? [
          "META_APP_ID",
          "META_APP_ACCESS_TOKEN",
          "META_USER_ACCESS_TOKEN",
          "META_PAGE_ID",
          "META_INSTAGRAM_CONNECTION_ID",
        ]
      : ["META_INSTAGRAM_ACCESS_TOKEN"]),
    ...(mode === "--run" && loginMode === "instagram" ? ["META_INSTAGRAM_CONNECTION_ID"] : []),
    ...(mode === "--run" ? ["DATABASE_URL"] : []),
  ];
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    process.stderr.write(`Missing environment variables: ${missing.join(", ")}\n`);
    process.exitCode = 2;
  } else {
    try {
      const transport =
        loginMode === "instagram"
          ? new InstagramLoginPrivateReplyTransport({
              graphVersion: process.env.META_GRAPH_VERSION!,
              accessToken: process.env.META_INSTAGRAM_ACCESS_TOKEN!,
              accountId: process.env.META_INSTAGRAM_ACCOUNT_ID!,
              ...(mode === "--run" ? { connectionId: process.env.META_INSTAGRAM_CONNECTION_ID! } : {}),
            } satisfies InstagramLoginPrivateReplyConfig)
          : new FacebookPrivateReplyTransport({
              graphVersion: process.env.META_GRAPH_VERSION!,
              appId: process.env.META_APP_ID!,
              appAccessToken: process.env.META_APP_ACCESS_TOKEN!,
              userAccessToken: process.env.META_USER_ACCESS_TOKEN!,
              pageId: process.env.META_PAGE_ID!,
              accountId: process.env.META_INSTAGRAM_ACCOUNT_ID!,
              connectionId: process.env.META_INSTAGRAM_CONNECTION_ID!,
            } satisfies FacebookPrivateReplyConfig);
      const inspection =
        loginMode === "instagram"
          ? await (transport as InstagramLoginPrivateReplyTransport).inspectAccount()
          : await (transport as FacebookPrivateReplyTransport).inspectPermissions();
      if (!inspection.verified) {
        const missingPermissions =
          "missingPermissions" in inspection && Array.isArray(inspection.missingPermissions)
            ? inspection.missingPermissions.join(", ")
            : undefined;
        process.stderr.write(
          `Meta access not verified: ${inspection.reason}${missingPermissions ? ` (${missingPermissions})` : ""}\n`,
        );
        process.exitCode = 1;
      } else if (mode === "--check-permissions") {
        process.stdout.write(
          loginMode === "instagram"
            ? "Instagram token account ID verified. Granted permissions, App Review, and live send require separate confirmation.\n"
            : "Meta token scopes, Page link, and MESSAGING task verified. App Review and Human Agent status require separate confirmation.\n",
        );
      } else {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
        try {
          const connection = await pool.query<{ account_id: string; active: boolean }>(
            "SELECT account_id, active FROM instagram_connections WHERE id = $1",
            [process.env.META_INSTAGRAM_CONNECTION_ID],
          );
          if (
            connection.rows[0]?.account_id !== process.env.META_INSTAGRAM_ACCOUNT_ID ||
            connection.rows[0].active !== true
          ) {
            process.stderr.write("Configured Instagram connection is inactive or mismatched\n");
            process.exitCode = 1;
          } else {
            const controller = new AbortController();
            const stop = (): void => controller.abort();
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            try {
              process.stdout.write(
                `Instagram private reply worker started for connection ${process.env.META_INSTAGRAM_CONNECTION_ID}\n`,
              );
              await runPrivateReplyWorker(
                pool,
                transport,
                controller.signal,
                1000,
                process.env.META_INSTAGRAM_CONNECTION_ID!,
              );
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
      const message =
        error instanceof Error &&
        (/^(Invalid Meta|Meta Graph)/.test(error.message) || error.message === "Invalid Instagram account ID")
          ? error.message
          : "Instagram worker failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
