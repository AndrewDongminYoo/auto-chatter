import { createHmac, timingSafeEqual } from "node:crypto";

export interface InstagramComment {
  accountId: string;
  commentId: string;
  postId: string;
  senderId: string;
  text: string;
  parentId?: string;
}

function singleParameter(query: URLSearchParams, name: string): string | null {
  const values = query.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

function equalSecrets(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function verifySubscription(query: URLSearchParams, verifyToken: string): string | null {
  if (!verifyToken || singleParameter(query, "hub.mode") !== "subscribe") return null;
  const suppliedToken = singleParameter(query, "hub.verify_token");
  const challenge = singleParameter(query, "hub.challenge");
  if (!suppliedToken || !challenge || !equalSecrets(suppliedToken, verifyToken)) return null;
  return challenge;
}

export function verifySignature(body: Uint8Array, signatureHeader: string | null, appSecret: string): boolean {
  if (!appSecret || !signatureHeader) return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader);
  if (!match) return false;
  const suppliedDigest = Buffer.from(match[1]!, "hex");
  const expectedDigest = createHmac("sha256", appSecret).update(body).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseComment(value: unknown, accountId: string): InstagramComment {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isRecord(value.from) ||
    !isNonEmptyString(value.from.id) ||
    !isRecord(value.media) ||
    !isNonEmptyString(value.media.id) ||
    typeof value.text !== "string"
  ) {
    throw new Error("Invalid Instagram comment event");
  }
  if (value.parent_id !== undefined && !isNonEmptyString(value.parent_id)) {
    throw new Error("Invalid Instagram comment event");
  }

  return {
    accountId,
    commentId: value.id,
    postId: value.media.id,
    senderId: value.from.id,
    text: value.text,
    ...(value.parent_id === undefined ? {} : { parentId: value.parent_id }),
  };
}

export function parseCommentEvents(body: Uint8Array): InstagramComment[] {
  const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if (!isRecord(payload) || payload.object !== "instagram" || !Array.isArray(payload.entry)) {
    throw new Error("Invalid Instagram webhook payload");
  }

  const comments: InstagramComment[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !isNonEmptyString(entry.id)) {
      throw new Error("Invalid Instagram webhook entry");
    }
    if (entry.field === "comments") {
      comments.push(parseComment(entry.value, entry.id));
    }
    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        if (isRecord(change) && change.field === "comments") {
          comments.push(parseComment(change.value, entry.id));
        }
      }
    }
  }
  return comments;
}
