import { parseMessageEvents } from "../instagram/message-events.ts";
import { ingestMessages, processNextFollowReply, recoverStaleFollowReplies } from "../instagram/follow-flow.ts";
export interface Env extends AuthEnv, InstagramOAuthEnv {
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

async function wakeDueReplies(
  pool: Pool,
  env: Env,
  scope?: { connectionId: string } | { accountIds: string[] },
): Promise<void> {
  if (env.SEND_ENABLED !== "true") return;
  const due = await pool.query<{ id: string }>(
    `SELECT c.id FROM instagram_connections c
     WHERE ($1::uuid IS NULL OR c.id=$1) AND ($2::text[] IS NULL OR c.account_id=ANY($2))
       AND c.send_enabled AND c.access_token_encrypted IS NOT NULL AND c.token_expires_at>now()
       AND (c.send_paused_until IS NULL OR c.send_paused_until<=now())
       AND (EXISTS(SELECT 1 FROM private_reply_outbox reply WHERE reply.connection_id=c.id AND reply.status='pending' AND reply.next_attempt_at<=now()
         AND NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
           AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND automation.paused))
       OR EXISTS(SELECT 1 FROM instagram_follow_conversations flow JOIN private_reply_outbox reply ON reply.id=flow.reply_id
         WHERE flow.connection_id=c.id AND flow.status='pending' AND flow.next_attempt_at<=now()
         AND NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
           AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND automation.paused)))
     ORDER BY c.id LIMIT 100`,
    [
      scope && "connectionId" in scope ? scope.connectionId : null,
      scope && "accountIds" in scope ? scope.accountIds : null,
    ],
  );
  for (const row of due.rows) await env.REPLY_QUEUE.send({ connectionId: row.id });
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
  if (url.pathname.startsWith("/api/")) return appApi(request, env, () => openPool(env));
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
  let messages;
  try {
    comments = parseCommentEvents(body);
    messages = parseMessageEvents(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  const pool = openPool(env);
  try {
    await ingestComments(pool, comments);
    await ingestMessages(pool, messages);
    try {
      await wakeDueReplies(pool, env, {
        accountIds: [...new Set([...comments, ...messages].map((event) => event.accountId))],
      });
    } catch {
      // The commit is durable. Cron repairs the DB-to-Queue publication gap.
      console.error("Reply notification failed; scheduled recovery required");
    }
    return new Response(null, { status: 200 });
  } finally {
    await pool.end();
  }
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
      if (env.SEND_ENABLED !== "true" || !isRecord(message.body) || !isUuid(message.body.connectionId)) {
        message.ack();
        continue;
      }
      try {
        const connectionId = (message.body as { connectionId: string }).connectionId;
        const pool = openPool(env);
        try {
          const result = await pool.query(
            "SELECT id,workspace_id,account_id,access_token_encrypted FROM instagram_connections WHERE id=$1 AND send_enabled AND token_expires_at>now() AND access_token_encrypted IS NOT NULL",
            [connectionId],
          );
          const connection = result.rows[0];
          if (connection) {
            if (!env.TOKEN_ENCRYPTION_KEY) throw new Error("Token encryption not configured");
            const accessToken = openSecret(
              connection.access_token_encrypted,
              env.TOKEN_ENCRYPTION_KEY,
              `${connection.workspace_id}:${connection.account_id}`,
            );
            const rawGraphFetch: typeof fetch = async (input, init) => {
              const response = await fetch(input, { ...init, redirect: "manual" });
              if (response.status >= 300 && response.status < 400) {
                await response.body?.cancel();
                throw new Error("Meta Graph redirect refused");
              }
              return response;
            };
            const graphFetch: typeof fetch = async (input, init) => {
              if (init?.method === "POST") {
                const current = await pool.query(
                  "SELECT 1 FROM instagram_connections WHERE id=$1 AND active AND send_enabled AND token_expires_at>now() AND access_token_encrypted=$2 AND (send_paused_until IS NULL OR send_paused_until<=now())",
                  [connectionId, connection.access_token_encrypted],
                );
                if (!current.rowCount) throw new PreSendVerificationError("block", "connection_changed");
                const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
                if (body?.recipient?.comment_id) {
                  const rule = await pool.query(
                    `SELECT NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
                      AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND automation.paused) AS automation_active
                     FROM private_reply_outbox reply JOIN instagram_comment_rules rule ON rule.id=reply.rule_id
                    WHERE reply.connection_id=$1 AND reply.comment_id=$2 AND rule.enabled AND reply.status='sending'`,
                    [connectionId, body.recipient.comment_id],
                  );
                  if (rule.rows[0]?.automation_active === false)
                    throw new PreSendVerificationError("retry", "contact_paused");
                  if (!rule.rowCount) throw new PreSendVerificationError("block", "inactive_rule");
                }
              }
              return rawGraphFetch(input, init);
            };
            const config = {
              graphVersion: env.META_GRAPH_VERSION,
              accessToken,
              accountId: connection.account_id,
              connectionId,
              fetchImpl: graphFetch,
            };
            // Follow confirmations have a shorter delivery window than comment private replies.
            if (
              !(await processNextFollowReply(
                pool,
                connectionId,
                new InstagramFollowTransport({
                  ...config,
                  fetchImpl: rawGraphFetch,
                  beforeSend: async (context) => {
                    const permitted = await pool.query(
                      `SELECT NOT EXISTS(SELECT 1 FROM instagram_contact_automation automation WHERE automation.workspace_id=reply.workspace_id
                  AND automation.connection_id=reply.connection_id AND automation.sender_id=reply.sender_id AND automation.paused) AS automation_active
                FROM instagram_follow_conversations flow
                JOIN private_reply_outbox reply ON reply.id=flow.reply_id JOIN instagram_comment_rules rule ON rule.id=reply.rule_id
                JOIN instagram_connections c ON c.id=flow.connection_id
                WHERE flow.reply_id=$1 AND flow.attempt_id=$2 AND flow.status='sending' AND flow.confirmed_at>now()-interval '24 hours'
                  AND rule.enabled AND c.id=$3 AND c.active AND c.send_enabled AND c.token_expires_at>now() AND c.access_token_encrypted=$4
                  AND (c.send_paused_until IS NULL OR c.send_paused_until<=now())`,
                      [context.replyId, context.attemptId, connectionId, connection.access_token_encrypted],
                    );
                    if (permitted.rows[0]?.automation_active === false)
                      throw new PreSendVerificationError("retry", "contact_paused");
                    if (!permitted.rowCount) throw new PreSendVerificationError("block", "delivery_not_permitted");
                  },
                }),
              ))
            )
              await processNextPrivateReply(
                pool,
                new InstagramLoginPrivateReplyTransport(config),
                () => new Date(),
                connectionId,
              );
          }
          await wakeDueReplies(pool, env, { connectionId });
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
        await pool.query(
          "UPDATE private_reply_outbox SET status='unknown',failure_code='worker_interrupted' WHERE status='sending' AND attempt_started_at<now()-interval '10 minutes'",
        );
        await recoverStaleFollowReplies(pool, new Date(Date.now() - 10 * 60_000));
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
import { processNextPrivateReply, PreSendVerificationError } from "../instagram/reply-worker.ts";
import { InstagramLoginPrivateReplyTransport } from "../instagram/instagram-login-private-reply.ts";
import { publicPage } from "./public-pages.ts";
import { appApi } from "../app/api.ts";
import type { AuthEnv } from "../app/auth.ts";
import type { InstagramOAuthEnv } from "../app/instagram-oauth.ts";

import { openSecret } from "../app/secrets.ts";
import { isRecord, isUuid } from "../app/auth.ts";
import { InstagramFollowTransport } from "../instagram/follow-transport.ts";
