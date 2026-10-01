// Operations log lines (#59). Every runtime log goes through logOperation, which keeps only the allow-listed
// fields below and only values of a fixed shape, so request bodies, tokens, emails, comment or DM text and
// raw provider or SQL errors can never reach the logs, even when a caller passes them by mistake.
// Each entry is written as one JSON string line, so line-based collectors (the Node worker's stdout under Compose)
// can parse it; a plain object would be printed by Node as a multi-line inspected block.

export const OPERATION_STEPS = [
  "kept_reply_cleanup",
  "token_refresh",
  "early_reply_reconcile",
  "flow_resume",
  "stale_recovery",
  "wake",
  "webhook_delivery",
  "alerts",
] as const;
export type OperationStep = (typeof OPERATION_STEPS)[number];

export interface OperationLogFields {
  event: string;
  code: string;
  correlation_id?: string | undefined;
  connection_id?: string | undefined;
  step?: OperationStep | undefined;
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CORRELATION_ID = /^[A-Za-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEPS: ReadonlySet<string> = new Set(OPERATION_STEPS);
const ALLOWED: Record<string, (value: string) => boolean> = {
  event: (value) => NAME.test(value),
  code: (value) => NAME.test(value),
  correlation_id: (value) => CORRELATION_ID.test(value),
  connection_id: (value) => UUID.test(value),
  step: (value) => STEPS.has(value),
};

// Returns the fields that may be logged: unknown keys and values of the wrong shape are dropped.
export function operationLogEntry(fields: Readonly<Record<string, unknown>>): Record<string, string> {
  const entry: Record<string, string> = {};
  for (const [key, accept] of Object.entries(ALLOWED)) {
    const value = fields[key];
    if (typeof value === "string" && accept(value)) entry[key] = value;
  }
  return entry;
}

export function logOperation(fields: OperationLogFields, level: "info" | "warn" | "error" = "error"): void {
  const entry = operationLogEntry(fields as unknown as Record<string, unknown>);
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

// At least one due Instagram token could not be refreshed; the provider response is never kept.
export class TokenRefreshFailedError extends Error {
  constructor() {
    super("Instagram token refresh failed");
    this.name = "TokenRefreshFailedError";
  }
}

// A fixed failure code for an error, read from its class and error code only; the message is never used
// because SQL and provider messages can carry submitted content.
export function failureCode(error: unknown): string {
  if (error instanceof ConfigurationError) return "not_configured";
  if (error instanceof TokenRefreshFailedError) return "token_refresh_failed";
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code))
    // SQLSTATE classes 08 (connection exception) and 57 (operator intervention) mean the database is unreachable.
    return code.startsWith("08") || code.startsWith("57") ? "database_unavailable" : "database_error";
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return "connection_unavailable";
  return "unexpected_error";
}
