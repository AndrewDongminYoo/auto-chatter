import { ApiError, isRecord } from "./auth.ts";

interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface AuthRateLimitEnv {
  AUTH_IP_LIMIT?: RateLimitBinding;
  AUTH_EMAIL_LIMIT?: RateLimitBinding;
}

export async function limitAuthRequest(
  request: Request,
  pathname: string,
  input: unknown,
  env: AuthRateLimitEnv,
): Promise<void> {
  if (!env.AUTH_IP_LIMIT || !env.AUTH_EMAIL_LIMIT) throw new ApiError(503, "auth_unavailable");
  const ip = request.headers.get("CF-Connecting-IP") ?? "unattributed";
  const email = isRecord(input) && typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  try {
    const ipResult = await env.AUTH_IP_LIMIT.limit({ key: `${pathname}:${ip}` });
    if (!ipResult.success) throw new ApiError(429, "auth_rate_limited");
    if (email) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
      const emailHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const purpose = pathname === "/api/auth/login" ? "login" : "mail";
      const emailResult = await env.AUTH_EMAIL_LIMIT.limit({ key: `${purpose}:${emailHash}` });
      if (!emailResult.success) throw new ApiError(429, "auth_rate_limited");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "auth_unavailable");
  }
}
