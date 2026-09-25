const rateLimitCodes = new Set([4, 17, 32, 613]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readMetaGraphError(
  response: Response,
): Promise<{ code: number | null; transient: boolean } | null> {
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const code = Number.isSafeInteger(body.error.code) && Number(body.error.code) >= 0 ? Number(body.error.code) : null;
  return { code, transient: body.error.is_transient === true || (code !== null && rateLimitCodes.has(code)) };
}
