import { Pool } from "pg";
import { createInstagramWebhookServer } from "./http.ts";

const databaseUrl = process.env.DATABASE_URL;
const appSecret = process.env.INSTAGRAM_APP_SECRET;
const verifyToken = process.env.INSTAGRAM_VERIFY_TOKEN;
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "3000");

if (!databaseUrl || !appSecret || !verifyToken) {
  throw new Error("DATABASE_URL, INSTAGRAM_APP_SECRET, and INSTAGRAM_VERIFY_TOKEN are required");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  await pool.query("SELECT 1 FROM instagram_connections LIMIT 0");
  await pool.query("SELECT 1 FROM instagram_comment_events LIMIT 0");
  await pool.query("SELECT 1 FROM private_reply_outbox LIMIT 0");
  const server = createInstagramWebhookServer({ pool, appSecret, verifyToken });
  server.listen(port, host, () => {
    process.stdout.write(`Instagram webhook listening on ${host}:${port}\n`);
  });

  const shutdown = (): void => {
    server.close(() => {
      void pool.end();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  await pool.end();
  throw error;
}
