export interface Env {
  HYPERDRIVE: { connectionString: string };
  REPLY_QUEUE: { send(body: { connectionId: string }): Promise<void> };
  INSTAGRAM_APP_SECRET: string;
  INSTAGRAM_VERIFY_TOKEN: string;
  META_INSTAGRAM_CONNECTION_ID: string;
  META_INSTAGRAM_ACCOUNT_ID: string;
  META_GRAPH_VERSION: string;
  META_INSTAGRAM_ACCESS_TOKEN: string;
  SEND_ENABLED: string;
}

export interface ReplyBatch {
  messages: readonly { body: unknown; ack(): void; retry(options: { delaySeconds: number }): void }[];
}

function openPool(env: Env): Pool {
  // Connections belong to one invocation; Hyperdrive owns the upstream pool.
  const pool = new Pool({
    connectionString: env.HYPERDRIVE.connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
  });
  pool.on("error", () => console.error("Cloudflare database connection failed"));
  return pool;
}

async function wakeDueReplies(pool: Pool, env: Env): Promise<void> {
  if (env.SEND_ENABLED !== "true") return;
  const due = await pool.query(
    `SELECT 1 FROM private_reply_outbox AS reply
     JOIN instagram_connections AS connection ON connection.id = reply.connection_id
     WHERE reply.connection_id = $1 AND reply.status = 'pending' AND reply.next_attempt_at <= now()
       AND (connection.send_paused_until IS NULL OR connection.send_paused_until <= now())
     LIMIT 1`,
    [env.META_INSTAGRAM_CONNECTION_ID],
  );
  if (due.rowCount) await env.REPLY_QUEUE.send({ connectionId: env.META_INSTAGRAM_CONNECTION_ID });
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function receive(request: Request, env: Env): Promise<Response> {
  const page = publicPage(request);
  if (page) return page;
  const url = new URL(request.url);
  if (url.pathname !== "/webhooks/instagram") return new Response(null, { status: 404 });
  if (!env.INSTAGRAM_APP_SECRET || !env.INSTAGRAM_VERIFY_TOKEN) throw new Error("Webhook secrets missing");
  if (request.method === "GET") {
    const challenge = verifySubscription(url.searchParams, env.INSTAGRAM_VERIFY_TOKEN);
    return new Response(challenge, { status: challenge === null ? 403 : 200 });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  const body = await readBody(request);
  if (body === null) return new Response(null, { status: 413 });
  if (!verifySignature(body, request.headers.get("x-hub-signature-256"), env.INSTAGRAM_APP_SECRET))
    return new Response(null, { status: 403 });
  let comments;
  try {
    comments = parseCommentEvents(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  const pool = openPool(env);
  try {
    await ingestComments(pool, comments);
    try {
      await wakeDueReplies(pool, env);
    } catch {
      // The commit is durable. Cron repairs the DB-to-Queue publication gap.
      console.error("Reply notification failed; scheduled recovery required");
    }
    return new Response(null, { status: 200 });
  } finally {
    await pool.end();
  }
}

function isWakeForConnection(body: unknown, connectionId: string): boolean {
  return typeof body === "object" && body !== null && "connectionId" in body && body.connectionId === connectionId;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await receive(request, env);
    } catch {
      console.error("Cloudflare webhook failed");
      return new Response(null, { status: 503 });
    }
  },
  async queue(batch: ReplyBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (env.SEND_ENABLED !== "true" || !isWakeForConnection(message.body, env.META_INSTAGRAM_CONNECTION_ID)) {
        message.ack();
        continue;
      }
      try {
        // Validate all send configuration before claiming a row.
        if (!env.META_INSTAGRAM_CONNECTION_ID) throw new Error("Connection ID missing");
        const transport = new InstagramLoginPrivateReplyTransport({
          graphVersion: env.META_GRAPH_VERSION,
          accessToken: env.META_INSTAGRAM_ACCESS_TOKEN,
          accountId: env.META_INSTAGRAM_ACCOUNT_ID,
          connectionId: env.META_INSTAGRAM_CONNECTION_ID,
          // Workers supports manual/follow only. Preserve the transport's redirect refusal.
          fetchImpl: async (input, init) => {
            const response = await fetch(input, { ...init, redirect: "manual" });
            if (response.status >= 300 && response.status < 400) {
              await response.body?.cancel();
              throw new Error("Meta Graph redirect refused");
            }
            return response;
          },
        });
        const pool = openPool(env);
        try {
          await processNextPrivateReply(pool, transport, () => new Date(), env.META_INSTAGRAM_CONNECTION_ID);
          await wakeDueReplies(pool, env);
        } finally {
          await pool.end();
        }
        message.ack();
      } catch {
        console.error("Cloudflare reply consumer failed");
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    if (env.SEND_ENABLED !== "true") return;
    try {
      const pool = openPool(env);
      try {
        await recoverStalePrivateReplies(pool, new Date(Date.now() - 10 * 60_000), env.META_INSTAGRAM_CONNECTION_ID);
        await wakeDueReplies(pool, env);
      } finally {
        await pool.end();
      }
    } catch {
      throw new Error("Cloudflare scheduled recovery failed");
    }
  },
};
import { Pool } from "pg";
import { ingestComments } from "../instagram/store.ts";
import { parseCommentEvents, verifySignature, verifySubscription } from "../instagram/webhook.ts";
import { processNextPrivateReply, recoverStalePrivateReplies } from "../instagram/reply-worker.ts";
import { InstagramLoginPrivateReplyTransport } from "../instagram/instagram-login-private-reply.ts";
import { publicPage } from "./public-pages.ts";
