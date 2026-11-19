import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { ApiError } from "./auth.ts";
import { connectionMedia, isMissingMediaError } from "./instagram-media.ts";
import { sealSecret } from "./secrets.ts";

const user = { id: "11111111-1111-4111-8111-111111111111", email: "a@example.test" };
const workspaceId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const key = Buffer.alloc(32, 7).toString("base64");
const env = { TOKEN_ENCRYPTION_KEY: key, META_GRAPH_VERSION: "v26.0" };
const deleted = { error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100, error_subcode: 33 } };

// Answers the membership and connection reads of connectionMedia without a database.
const pool = {
  query: async (sql: string) => {
    if (sql.includes("FROM workspace_members")) return { rows: [{ workspace_id: workspaceId, role: "agent" }] };
    if (sql.includes("FROM instagram_connections")) {
      return { rows: [{ account_id: "123", access_token_encrypted: sealSecret("media-token", key, `${workspaceId}:123`), token_expires_at: new Date(Date.now() + 86_400_000) }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
} as unknown as Pool;

// The identity read succeeds; every other Graph request gets the given answer.
function graph(answer: () => Response) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    return url.pathname.endsWith("/me") ? Response.json({ id: "999", user_id: "123" }) : answer();
  }) as typeof fetch;
}

async function rejection(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError);
    return { status: error.status, code: error.message };
  }
  assert.fail("expected a rejection");
}

test("only a 4xx Graph error with code 100 and subcode 33 counts as a missing object", () => {
  assert.equal(isMissingMediaError(400, deleted), true);
  assert.equal(isMissingMediaError(404, deleted), true);
  assert.equal(isMissingMediaError(500, deleted), false);
  assert.equal(isMissingMediaError(400, { error: { code: 100 } }), false);
  assert.equal(isMissingMediaError(400, { error: { code: 100, error_subcode: 2018001 } }), false);
  assert.equal(isMissingMediaError(400, { error: { code: "100", error_subcode: "33" } }), false);
  assert.equal(isMissingMediaError(400, { error: { code: 190, error_subcode: 33 } }), false);
  assert.equal(isMissingMediaError(400, undefined), false);
  assert.equal(isMissingMediaError(400, [deleted]), false);
});

test("a single-media lookup answers 404 media_not_found for a deleted post", async () => {
  assert.deepEqual(
    await rejection(
      connectionMedia(
        pool,
        user,
        connectionId,
        env,
        { mediaId: "1789" },
        graph(() => Response.json(deleted, { status: 400 })),
      ),
    ),
    { status: 404, code: "media_not_found" },
  );
});

test("every other single-media failure stays 502 media_unavailable", async () => {
  const answers: [string, () => Response][] = [
    ["code 100 without subcode", () => Response.json({ error: { code: 100 } }, { status: 400 })],
    ["another 4xx code", () => Response.json({ error: { code: 10, error_subcode: 33 } }, { status: 403 })],
    ["a non-JSON 4xx", () => new Response("not json", { status: 400 })],
    ["an oversized 4xx", () => new Response(JSON.stringify({ ...deleted, padding: "x".repeat(20_000) }), { status: 400 })],
    ["a 5xx with the deleted body", () => Response.json(deleted, { status: 500 })],
    ["a 503", () => new Response(null, { status: 503 })],
  ];
  for (const [name, answer] of answers) {
    assert.deepEqual(await rejection(connectionMedia(pool, user, connectionId, env, { mediaId: "1789" }, graph(answer))), { status: 502, code: "media_unavailable" }, name);
  }
});

test("the media list keeps 502 media_unavailable for the deleted-object answer", async () => {
  assert.deepEqual(
    await rejection(
      connectionMedia(
        pool,
        user,
        connectionId,
        env,
        {},
        graph(() => Response.json(deleted, { status: 400 })),
      ),
    ),
    { status: 502, code: "media_unavailable" },
  );
});

test("the identity read keeps 502 media_unavailable for the deleted-object answer", async () => {
  const fetchImpl = (async () => Response.json(deleted, { status: 400 })) as typeof fetch;
  assert.deepEqual(await rejection(connectionMedia(pool, user, connectionId, env, { mediaId: "1789" }, fetchImpl)), { status: 502, code: "media_unavailable" });
});
