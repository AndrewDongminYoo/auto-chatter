import assert from "node:assert/strict";
import { test } from "node:test";
import { appApi } from "./api.ts";
const config = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key" };

test("API rejects unauthenticated and cross-origin requests before opening a database", async () => {
  const open = () => {
    throw new Error("DB must not be opened");
  };
  const userResponse = await appApi(new Request("https://app.test/api/rules"), config, open);
  assert.equal(userResponse.status, 401);
  const crossOrigin = await appApi(
    new Request("https://app.test/api/rules", { method: "PUT", headers: { origin: "https://attacker.test" } }),
    config,
    open,
  );
  assert.equal(crossOrigin.status, 403);
});
