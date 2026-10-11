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

// Whether Meta rejected the access token itself or the app's permission for it: HTTP 401, or Graph error code
// 10, 190 or 200-299. Only a 400 or 403 body is read for the code. Timeouts, network errors, 5xx, rate limits
// and other bodies are not rejections. The diagnostics route and the reconnect marker share this definition.
export function isMetaTokenRejection(status: number, code: unknown): boolean {
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;
  return code === 10 || code === 190 || (typeof code === "number" && code >= 200 && code <= 299);
}

// Reads the error code of a 400 or 403 response, or returns undefined without reading the body.
export async function readMetaGraphErrorCode(response: Response): Promise<unknown> {
  if (response.status !== 400 && response.status !== 403) return undefined;
  try {
    const body: unknown = await response.json();
    return isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

// The outcome of a pre-send identity read (me) that a transport reports to its optional observer: the token
// was accepted for the configured account, or Meta rejected it. Other outcomes are not reported.
export type IdentityCheck = "verified" | "rejected";
export type IdentityObserver = (check: IdentityCheck) => Promise<void>;

// Reports to an observer; the observer is best effort and can never change the caller's outcome.
export async function reportIdentity(observer: IdentityObserver | undefined, check: IdentityCheck): Promise<void> {
  try {
    await observer?.(check);
  } catch {
    // The observer logs its own failures.
  }
}

// Classifies a non-2xx response without consuming its body, so the caller can still read it.
export async function metaTokenRejected(response: Response): Promise<boolean> {
  if (response.ok) return false;
  if (response.status === 401) return true;
  if (response.status !== 400 && response.status !== 403) return false;
  return isMetaTokenRejection(response.status, await readMetaGraphErrorCode(response.clone()));
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
