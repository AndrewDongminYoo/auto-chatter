import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { type Env } from "./index.ts";

const unavailableEnv = new Proxy({} as Env, {
  get() {
    throw new Error("Public pages must not access secrets or database bindings");
  },
});

for (const pathname of ["/privacy", "/data-deletion"]) {
  test(`${pathname} serves a public HTML document without runtime credentials`, async () => {
    const response = await worker.fetch(
      new Request(`https://example.test${pathname}?token=never-reflect-this-value`),
      unavailableEnv,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html; charset=utf-8$/);
    assert.equal(response.headers.get("set-cookie"), null);
    const html = await response.text();
    assert.match(html, /<html lang="ko">/);
    assert.match(html, /<h1>[^<]+<\/h1>/);
    assert.match(html, /href="mailto:ydm2790@gmail.com"/);
    assert.doesNotMatch(html, /never-reflect-this-value/);
  });

  test(`${pathname} supports HEAD and rejects write methods`, async () => {
    const head = await worker.fetch(new Request(`https://example.test${pathname}`, { method: "HEAD" }), unavailableEnv);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const post = await worker.fetch(new Request(`https://example.test${pathname}`, { method: "POST" }), unavailableEnv);
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  });
}

test("public routes do not bypass webhook verification", async () => {
  const env = { INSTAGRAM_APP_SECRET: "test-secret", INSTAGRAM_VERIFY_TOKEN: "test-verify" } as Env;
  const response = await worker.fetch(
    new Request("https://example.test/webhooks/instagram", { method: "POST", body: "{}" }),
    env,
  );
  assert.equal(response.status, 403);
  assert.equal((await worker.fetch(new Request("https://example.test/unknown"), unavailableEnv)).status, 404);
});
