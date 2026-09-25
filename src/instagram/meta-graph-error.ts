import { ProviderRateLimitedError, ProviderRejectedError } from "./reply-worker.ts";

const rateLimitCodes = new Set([4, 17, 32, 613]);
// Accept provider delays only within this service's seven-day private-reply window.
const maxRetryAfterSeconds = 7 * 24 * 60 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readMetaGraphError(
  response: Response,
): Promise<{ code: number | null; transient: boolean; rateLimited: boolean } | null> {
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const code = Number.isSafeInteger(body.error.code) && Number(body.error.code) >= 0 ? Number(body.error.code) : null;
  const rateLimited = code !== null && rateLimitCodes.has(code);
  return { code, transient: body.error.is_transient === true || rateLimited, rateLimited };
}

export function retryAfterSeconds(header: string | null, now: Date): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds <= maxRetryAfterSeconds ? seconds : null;
  }
  if (!value.endsWith("GMT")) return null;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  const seconds = Math.ceil((date - now.getTime()) / 1000);
  return seconds >= 0 && seconds <= maxRetryAfterSeconds ? seconds : null;
}

// Returns the error to throw for a non-2xx, non-5xx Graph response, or null when the caller should treat it as no data.
export async function classifyMetaGraphFailure(response: Response, method: string, now: Date): Promise<Error | null> {
  if (response.status < 400 || response.status >= 500) return new Error(`Meta Graph HTTP ${response.status}`);
  const error = await readMetaGraphError(response);
  const transient = new Error(`Meta Graph transient error${error?.code == null ? "" : ` code ${error.code}`}`);
  if (method !== "POST") {
    if (response.status === 429) return new Error("Meta Graph HTTP 429");
    return error?.transient ? transient : null;
  }
  // Only an allowlisted throttle code in a 4xx body qualifies for a delayed retry.
  if (error?.rateLimited && error.code !== null) {
    return new ProviderRateLimitedError(error.code, retryAfterSeconds(response.headers.get("retry-after"), now));
  }
  if (error?.transient) return transient;
  if (response.status === 429) return new Error("Meta Graph HTTP 429");
  if (error?.code != null) return new ProviderRejectedError(error.code);
  return null;
}
