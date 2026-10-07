import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthLimiter, durableLimits, type LimiterNamespace } from "./auth-limiter.ts";

// A Durable Object storage stand-in with the calls AuthLimiter uses.
function fakeState() {
  const values = new Map<string, unknown>();
  const state = {
    alarm: null as number | null,
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
      setAlarm: async (time: number) => {
        state.alarm = time;
      },
      deleteAll: async () => {
        values.clear();
      },
    },
  };
  return { state, values };
}

// One AuthLimiter per name, as Durable Objects are, behind the namespace shape durableLimits uses.
function fakeNamespace(): LimiterNamespace & { names: string[] } {
  const objects = new Map<string, AuthLimiter>();
  const names: string[] = [];
  return {
    names,
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = String(id);
      if (!objects.has(name)) {
        names.push(name);
        objects.set(name, new AuthLimiter(fakeState().state));
      }
      const object = objects.get(name)!;
      return { fetch: (input: string, init?: RequestInit) => object.fetch(new Request(input, init)) };
    },
  };
}

async function hit(limiter: AuthLimiter, limit: number, period: number): Promise<boolean> {
  const response = await limiter.fetch(
    new Request("https://auth-limiter/hit", { method: "POST", body: JSON.stringify({ limit, period }) }),
  );
  assert.equal(response.status, 200);
  return ((await response.json()) as { success: boolean }).success;
}

test("one limiter object counts every request for its key, then refuses past the limit (#148)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { state } = fakeState();
  const limiter = new AuthLimiter(state);
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await hit(limiter, 5, 60_000));
  assert.deepEqual(results, [true, true, true, true, true, false, false]);
  assert.equal(state.alarm, 1_060_000);
});

test("a new window starts once the period has passed, and the alarm removes the stored window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
  const { state, values } = fakeState();
  const limiter = new AuthLimiter(state);
  for (let i = 0; i < 3; i++) await hit(limiter, 2, 60_000);
  assert.equal(await hit(limiter, 2, 60_000), false);
  t.mock.timers.tick(60_000);
  assert.equal(await hit(limiter, 2, 60_000), true);
  assert.equal(state.alarm, 2_120_000);
  t.mock.timers.tick(60_000);
  await limiter.alarm();
  assert.equal(values.size, 0);
});

test("an alarm delivered again after the next window opened keeps that window and its alarm", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 3_000_000 });
  const { state, values } = fakeState();
  const limiter = new AuthLimiter(state);
  await hit(limiter, 2, 60_000);
  t.mock.timers.tick(60_000);
  await limiter.alarm();
  assert.equal(values.size, 0);
  // The next window opens, then the first window's alarm arrives a second time.
  await hit(limiter, 2, 60_000);
  await hit(limiter, 2, 60_000);
  await limiter.alarm();
  assert.equal(await hit(limiter, 2, 60_000), false);
  assert.equal(state.alarm, 3_120_000);
});

test("the limiter refuses a malformed request instead of counting it", async () => {
  const limiter = new AuthLimiter(fakeState().state);
  for (const body of ["{}", '{"limit":0,"period":60000}', '{"limit":5,"period":-1}', "not json"]) {
    const response = await limiter.fetch(new Request("https://auth-limiter/hit", { method: "POST", body }));
    assert.equal(response.status, 400);
  }
});

test("durableLimits keeps IP and email keys in separate objects with their own limits", async () => {
  const namespace = fakeNamespace();
  const limits = durableLimits(namespace);
  const ip = [];
  for (let i = 0; i < 31; i++) ip.push((await limits.AUTH_IP_LIMIT!.limit({ key: "k" })).success);
  assert.deepEqual(ip.slice(29), [true, false]);
  const email = [];
  for (let i = 0; i < 6; i++) email.push((await limits.AUTH_EMAIL_LIMIT!.limit({ key: "k" })).success);
  assert.deepEqual(email.slice(4), [true, false]);
  assert.deepEqual(namespace.names, ["ip:k", "email:k"]);
});

test("durableLimits gives the mail allowances an hourly window: 10 per IP and 20 for the project (#165)", async () => {
  const calls: { name: string; limit: number; period: number }[] = [];
  const limits = durableLimits({
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: async (_input: string, init?: RequestInit) => {
        calls.push({ name: String(id), ...(JSON.parse(String(init?.body)) as { limit: number; period: number }) });
        return Response.json({ success: true });
      },
    }),
  });
  await limits.AUTH_MAIL_IP_LIMIT!.limit({ key: "k" });
  await limits.AUTH_MAIL_LIMIT!.limit({ key: "project" });
  assert.deepEqual(calls, [
    { name: "mail-ip:k", limit: 10, period: 3_600_000 },
    { name: "mail:project", limit: 20, period: 3_600_000 },
  ]);
  // The project allowance stays below Supabase's custom-SMTP default of 30 mails per hour.
  assert.ok(calls[1]!.limit < 30);
});

test("durableLimits fails closed when the limiter object does not answer", async () => {
  const limits = durableLimits({
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => new Response(null, { status: 500 }) }),
  });
  await assert.rejects(limits.AUTH_EMAIL_LIMIT!.limit({ key: "k" }));
});
