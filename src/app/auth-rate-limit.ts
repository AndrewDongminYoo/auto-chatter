import { ApiError, isRecord } from "./auth.ts";

interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface AuthRateLimitEnv {
  AUTH_IP_LIMIT?: RateLimitBinding;
  AUTH_EMAIL_LIMIT?: RateLimitBinding;
  // Hourly allowances for requests that make Supabase send mail, per client IP and for the whole project (#165).
  AUTH_MAIL_IP_LIMIT?: RateLimitBinding;
  AUTH_MAIL_LIMIT?: RateLimitBinding;
}

// The routes whose Supabase call sends an auth mail.
const MAIL_PATHS = new Set(["/api/auth/signup", "/api/auth/recover", "/api/auth/resend-confirmation"]);

async function rateLimitKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function limitAuthRequest(
  request: Request,
  pathname: string,
  input: unknown,
  env: AuthRateLimitEnv,
): Promise<void> {
  if (!env.AUTH_IP_LIMIT || !env.AUTH_EMAIL_LIMIT) throw new ApiError(503, "auth_unavailable");
  const mail = MAIL_PATHS.has(pathname);
  if (mail && (!env.AUTH_MAIL_IP_LIMIT || !env.AUTH_MAIL_LIMIT)) throw new ApiError(503, "auth_unavailable");
  const ip = request.headers.get("CF-Connecting-IP") ?? "unattributed";
  const email = isRecord(input) && typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  try {
    const ipResult = await env.AUTH_IP_LIMIT.limit({ key: await rateLimitKey(`${pathname}:${ip}`) });
    if (!ipResult.success) throw new ApiError(429, "auth_rate_limited");
    if (email) {
      const purpose = pathname === "/api/auth/login" ? "login" : "mail";
      const emailResult = await env.AUTH_EMAIL_LIMIT.limit({ key: await rateLimitKey(`${purpose}:${email}`) });
      if (!emailResult.success) throw new ApiError(429, "auth_rate_limited");
    }
    if (mail) {
      // The project-wide Supabase mail quota is one budget for every user, and refused auth calls answer success,
      // so a mail that never leaves is invisible. Each client spends at most its own hourly share of the project
      // allowance: the per-IP check comes first and a client over it spends nothing project-wide.
      const ipMail = await env.AUTH_MAIL_IP_LIMIT!.limit({ key: await rateLimitKey(`mail-ip:${ip}`) });
      if (!ipMail.success) throw new ApiError(429, "auth_rate_limited");
      const projectMail = await env.AUTH_MAIL_LIMIT!.limit({ key: "project" });
      if (!projectMail.success) throw new ApiError(429, "auth_rate_limited");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "auth_unavailable");
  }
}
