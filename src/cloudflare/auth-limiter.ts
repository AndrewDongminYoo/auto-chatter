import type { AuthRateLimitEnv } from "../app/auth-rate-limit.ts";

// Exact counters for the auth request limits (#148). Cloudflare's rate-limit binding caches its counters on the
// machine that runs the Worker, so requests on new connections spread over machines and never reached the limit.
// One Durable Object per limiter key sees every request for that key, wherever it arrives.

interface LimiterState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    setAlarm(time: number): Promise<void>;
    deleteAll(): Promise<void>;
  };
}

export interface LimiterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

type Window = { start: number; count: number };

// A fixed window per key: the first request opens it and sets an alarm at its end, every request is counted,
// refused ones included, and the alarm removes the stored window so keys that are never seen again keep no data.
export class AuthLimiter {
  private readonly state: LimiterState;

  constructor(state: LimiterState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }
    const { limit, period } = (input ?? {}) as { limit?: unknown; period?: unknown };
    if (!Number.isInteger(limit) || Number(limit) < 1 || !Number.isInteger(period) || Number(period) < 1)
      return new Response(null, { status: 400 });
    const now = Date.now();
    let window = await this.state.storage.get<Window>("window");
    if (!window || now - window.start >= Number(period)) {
      window = { start: now, count: 0 };
      await this.state.storage.setAlarm(now + Number(period));
    }
    window.count++;
    await this.state.storage.put("window", window);
    return Response.json({ success: window.count <= Number(limit) });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

// The two limits limitAuthRequest reads, each a namespace of its own inside the one Durable Object class.
export function durableLimits(namespace: LimiterNamespace): Required<AuthRateLimitEnv> {
  const limiter = (name: string, limit: number, period: number) => ({
    async limit({ key }: { key: string }): Promise<{ success: boolean }> {
      const response = await namespace.get(namespace.idFromName(`${name}:${key}`)).fetch("https://auth-limiter/hit", {
        method: "POST",
        body: JSON.stringify({ limit, period }),
      });
      if (!response.ok) throw new Error("Auth limiter unavailable");
      return { success: ((await response.json()) as { success?: unknown }).success === true };
    },
  });
  return { AUTH_IP_LIMIT: limiter("ip", 30, 60_000), AUTH_EMAIL_LIMIT: limiter("email", 5, 60_000) };
}
