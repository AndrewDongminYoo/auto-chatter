export interface AuthEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}

export interface User {
  id: string;
  email: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export function requireSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new ApiError(403, "origin_rejected");
}

export async function readJson(request: Request): Promise<unknown> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    throw new ApiError(415, "json_required");
  if (!request.body) throw new ApiError(400, "invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new ApiError(413, "request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

export function cookie(request: Request, name: string): string | null {
  const matches = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(name + "="));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9._~-]{1,8192}$/.test(value) ? value : null;
}

function setSession(response: Response, name: string, value: string, seconds: number): void {
  response.headers.append("Set-Cookie", `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`);
}

export class AuthClient {
  private readonly origin: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;

  constructor(env: AuthEnv, fetchImpl: typeof fetch = fetch) {
    if (
      !env.SUPABASE_URL ||
      !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(env.SUPABASE_URL) ||
      !env.SUPABASE_PUBLISHABLE_KEY
    )
      throw new ApiError(503, "auth_not_configured");
    this.origin = new URL(env.SUPABASE_URL).origin;
    this.key = env.SUPABASE_PUBLISHABLE_KEY;
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

  private async call(
    path: string,
    method: string,
    body?: unknown,
    accessToken?: string,
    clientErrorStatus: 400 | 401 = 401,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.origin + "/auth/v1" + path, {
        method,
        headers: {
          apikey: this.key,
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
    } catch {
      throw new ApiError(503, "auth_unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(
        response.status === 429
          ? 429
          : response.status >= 500 || response.status < 400
            ? 503
            : (response.status === 400 || response.status === 422) && clientErrorStatus === 400
              ? 400
              : 401,
        "authentication_failed",
      );
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new ApiError(503, "auth_unavailable");
    }
  }

  async user(request: Request): Promise<User> {
    const token = cookie(request, "__Host-ac-access");
    if (!token) throw new ApiError(401, "login_required");
    const value = await this.call("/user", "GET", undefined, token);
    if (
      !isRecord(value) ||
      !isUuid(value.id) ||
      typeof value.email !== "string" ||
      typeof value.email_confirmed_at !== "string" ||
      !value.email_confirmed_at
    )
      throw new ApiError(401, "confirmed_email_required");
    return { id: value.id, email: value.email };
  }

  private credentials(value: unknown): { email: string; password: string } {
    if (
      !isRecord(value) ||
      typeof value.email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) ||
      value.email.length > 254 ||
      typeof value.password !== "string" ||
      value.password.length < 8 ||
      value.password.length > 256
    )
      throw new ApiError(400, "invalid_credentials");
    return { email: value.email.trim(), password: value.password };
  }

  private session(value: unknown): Response {
    if (
      !isRecord(value) ||
      typeof value.access_token !== "string" ||
      !/^[A-Za-z0-9._~-]{1,3500}$/.test(value.access_token) ||
      typeof value.refresh_token !== "string" ||
      !/^[A-Za-z0-9._~-]{1,3500}$/.test(value.refresh_token) ||
      typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0
    )
      throw new ApiError(503, "auth_unavailable");
    const response = json({ authenticated: true });
    setSession(response, "__Host-ac-access", value.access_token, Math.min(3600, Math.floor(value.expires_in)));
    setSession(response, "__Host-ac-refresh", value.refresh_token, 7 * 86400);
    return response;
  }

  async login(input: unknown): Promise<Response> {
    return this.session(await this.call("/token?grant_type=password", "POST", this.credentials(input)));
  }

  async signup(input: unknown): Promise<Response> {
    await this.call("/signup", "POST", this.credentials(input));
    return json({ confirmation_required: true });
  }

  async recover(input: unknown): Promise<Response> {
    if (
      !isRecord(input) ||
      typeof input.email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) ||
      input.email.length > 254
    )
      throw new ApiError(400, "invalid_recovery_email");
    try {
      await this.call("/recover", "POST", { email: input.email.trim() });
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 429)) throw error;
    }
    return json({ recovery_requested: true });
  }

  async resetPassword(input: unknown): Promise<Response> {
    if (
      !isRecord(input) ||
      typeof input.access_token !== "string" ||
      !/^[A-Za-z0-9._~-]{1,3500}$/.test(input.access_token) ||
      typeof input.password !== "string" ||
      input.password.length < 8 ||
      input.password.length > 256
    )
      throw new ApiError(400, "invalid_recovery_link");
    try {
      await this.call("/user", "PUT", { password: input.password }, input.access_token, 400);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw new ApiError(401, "recovery_link_invalid");
      if (error instanceof ApiError && error.status === 400) throw new ApiError(400, "password_rejected");
      throw error;
    }
    try {
      await this.call("/logout?scope=global", "POST", undefined, input.access_token);
    } catch {
      return clearSession(json({ error: "password_updated_logout_unconfirmed" }, 503));
    }
    return clearSession(json({ password_updated: true }));
  }

  async refresh(request: Request): Promise<Response> {
    try {
      const token = cookie(request, "__Host-ac-refresh");
      if (!token) throw new ApiError(401, "login_required");
      return this.session(await this.call("/token?grant_type=refresh_token", "POST", { refresh_token: token }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return clearSession(json({ error: error.message }, 401));
      throw error;
    }
  }

  async logout(request: Request): Promise<Response> {
    let token = cookie(request, "__Host-ac-access");
    const refresh = cookie(request, "__Host-ac-refresh");
    try {
      // Refresh first when possible: the access cookie may exist but already be expired.
      if (refresh) {
        const value = await this.call("/token?grant_type=refresh_token", "POST", { refresh_token: refresh });
        if (!isRecord(value) || typeof value.access_token !== "string" || !value.access_token)
          throw new ApiError(503, "auth_unavailable");
        token = value.access_token;
      }
      if (token) await this.call("/logout?scope=local", "POST", undefined, token);
      return clearSession(json({ authenticated: false }));
    } catch {
      return clearSession(json({ error: "remote_logout_unconfirmed" }, 503));
    }
  }
}

function clearSession(response: Response): Response {
  setSession(response, "__Host-ac-access", "", 0);
  setSession(response, "__Host-ac-refresh", "", 0);
  return response;
}
