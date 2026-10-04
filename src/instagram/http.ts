import { instagramAdapter, partitionInstagramEvents } from "./channel-adapter.ts";
import { ingestMessages } from "./follow-flow.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Pool } from "pg";
import { ingestComments } from "./store.ts";
import { verifySignature, verifySubscription } from "./webhook.ts";

const maxBodyBytes = 1024 * 1024;

export interface InstagramWebhookServerConfig {
  pool: Pool;
  appSecret: string;
  verifyToken: string;
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: InstagramWebhookServerConfig,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/webhooks/instagram") {
    response.writeHead(404).end();
    return;
  }

  if (request.method === "GET") {
    const challenge = verifySubscription(url.searchParams, config.verifyToken);
    if (challenge === null) response.writeHead(403).end();
    else response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(challenge);
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "GET, POST" }).end();
    return;
  }

  const body = await readBody(request);
  if (body === null) {
    response.writeHead(413).end();
    return;
  }
  const signature = request.headers["x-hub-signature-256"];
  if (!verifySignature(body, typeof signature === "string" ? signature : null, config.appSecret)) {
    response.writeHead(403).end();
    return;
  }

  let comments;
  let messages;
  try {
    ({ comments, messages } = partitionInstagramEvents(instagramAdapter.decodeWebhook(body)));
  } catch {
    response.writeHead(400).end();
    return;
  }

  await ingestComments(config.pool, comments);
  await ingestMessages(config.pool, messages);
  response.writeHead(200).end();
}

export function createInstagramWebhookServer(config: InstagramWebhookServerConfig): Server {
  if (!config.appSecret || !config.verifyToken) throw new Error("Instagram webhook secrets are required");
  return createServer((request, response) => {
    void handleRequest(request, response, config).catch(() => {
      if (!response.headersSent) response.writeHead(503).end();
      else response.destroy();
    });
  });
}
