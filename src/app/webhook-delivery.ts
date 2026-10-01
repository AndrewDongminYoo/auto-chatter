import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { isRecord } from "./auth.ts";
import { logOperation } from "./operations-log.ts";
import { openSecret } from "./secrets.ts";

// Outbound webhook delivery (#47, docs/specs/2026-10-01-flow-webhook-delivery.md). Only the Cloudflare cron
// calls deliverDueWebhooks; the Node worker never delivers webhooks. Every limit below is service policy.
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
// A failed attempt is retried after these delays; the attempt after the last delay ends the delivery as dead.
export const WEBHOOK_RETRY_DELAYS_MINUTES = [1, 5, 30, 120, 360] as const;
export const WEBHOOK_STALE_MINUTES = 10;
// One cron run attempts at most this many deliveries and claims no new one after the time budget. An
// endpoint that has used its own budget in a run gets no further attempt in that run, so one slow endpoint
// costs one timeout and the other endpoints keep the rest of the run. Each attempt makes up to three
// subrequests (two DNS-over-HTTPS lookups and the POST), and the whole cron invocation, including token
// refresh and queue sends, shares the Workers per-invocation subrequest limit (50 on Workers Free).
export const WEBHOOK_MAX_DELIVERIES_PER_RUN = 10;
export const WEBHOOK_RUN_BUDGET_MS = 20_000;
export const WEBHOOK_ENDPOINT_BUDGET_MS = 5_000;
export const WEBHOOK_USER_AGENT = "auto-chatter-webhook/1";
const DNS_TIMEOUT_MS = 5_000;
const DNS_RESOLVER = "https://cloudflare-dns.com/dns-query";

// The sealing context of a signing secret: its workspace, endpoint and key.
export function signingKeyContext(workspaceId: string, endpointId: string, keyId: string): string {
  return `webhook-signing-key:${workspaceId}:${endpointId}:${keyId}`.toLowerCase();
}

// The URL rules shared by endpoint creation and delivery: https on port 443 only, no userinfo, no IP-literal
// host, and no localhost or name under .localhost, .local or .internal. The WHATWG parser has already turned
// every IPv4 spelling (decimal, hex, short forms) into dotted decimal and bracketed every IPv6 literal.
export function parseWebhookUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  if (url.href.length > 2048) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return null;
  if (host === "localhost" || [".localhost", ".local", ".internal"].some((suffix) => host.endsWith(suffix)))
    return null;
  return url;
}

function ipv4Value(address: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

// Unspecified, private, CGNAT, loopback, link-local, multicast and reserved IPv4 ranges (IANA special-purpose
// registry), as [network, prefix length].
const BLOCKED_IPV4 = (
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const
).map(([network, bits]) => [ipv4Value(network)! >>> (32 - bits), bits] as const);

function publicIpv4(value: number): boolean {
  return !BLOCKED_IPV4.some(([prefix, bits]) => value >>> (32 - bits) === prefix);
}

function ipv6Groups(address: string): number[] | null {
  let text = address;
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const embedded = ipv4Value(tail[2]!);
    if (embedded === null) return null;
    text = `${tail[1]}${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  return missing < 1 ? null : [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function publicIpv6(groups: number[]): boolean {
  const embedded = ((groups[6]! << 16) | groups[7]!) >>> 0;
  // An IPv4-mapped (::ffff:0:0/96) or NAT64 (64:ff9b::/96) address reaches the IPv4 address it carries.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return publicIpv4(embedded);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0))
    return publicIpv4(embedded);
  // Only global unicast (2000::/3) is public. That leaves out unspecified, loopback, unique local, link-local,
  // multicast and every other reserved block; inside it, protocol assignments (2001::/23, which holds Teredo),
  // documentation (2001:db8::/32, 3fff::/20) and 6to4 (2002::/16) are refused.
  if ((groups[0]! & 0xe000) !== 0x2000) return false;
  if (groups[0] === 0x2001 && (groups[1]! < 0x0200 || groups[1] === 0x0db8)) return false;
  if (groups[0] === 0x2002) return false;
  if (groups[0] === 0x3fff && groups[1]! < 0x1000) return false;
  return true;
}

// Whether a resolved address is a public unicast address. Text that is not an IP address is not public.
export function isPublicAddress(address: string): boolean {
  const ipv4 = ipv4Value(address);
  if (ipv4 !== null) return publicIpv4(ipv4);
  const groups = address.includes(":") ? ipv6Groups(address) : null;
  return groups !== null && publicIpv6(groups);
}

// Returns every A and AAAA address of a host name. It throws when the lookup itself fails.
export type WebhookResolver = (hostname: string) => Promise<string[]>;

// DNS-over-HTTPS (JSON API). NXDOMAIN and an empty answer are "no address"; any other failure throws.
export function dohResolver(fetchImpl: typeof fetch): WebhookResolver {
  return async (hostname) => {
    const lookup = async (type: "A" | "AAAA", recordType: number): Promise<string[]> => {
      const response = await fetchImpl(`${DNS_RESOLVER}?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        redirect: "manual",
        signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error("DNS lookup failed");
      }
      const answer: unknown = await response.json();
      if (!isRecord(answer) || (answer.Status !== 0 && answer.Status !== 3)) throw new Error("DNS lookup failed");
      return (Array.isArray(answer.Answer) ? answer.Answer : []).flatMap((record: unknown) =>
        isRecord(record) && record.type === recordType && typeof record.data === "string" ? [record.data] : [],
      );
    };
    return (await Promise.all([lookup("A", 1), lookup("AAAA", 28)])).flat();
  };
}

// The X-AutoChatter-Signature value: one timestamp, then one key ID and HMAC-SHA256 pair per valid key. The
// signed string is "<t>.<raw request body>" and the HMAC key is the UTF-8 text of the secret.
export function webhookSignature(
  body: string,
  keys: readonly { id: string; secret: string }[],
  unixSeconds: number,
): string {
  return [
    `t=${unixSeconds}`,
    ...keys.map(
      (key) => `k=${key.id},v1=${createHmac("sha256", key.secret).update(`${unixSeconds}.${body}`).digest("hex")}`,
    ),
  ].join(",");
}

type Attempt = { sent: true; status: number } | { sent: false; code: string; status?: number };

async function discardBody(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (size < WEBHOOK_MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// One POST. A redirect is a failure and is never followed; the timeout covers the response body, of which at
// most WEBHOOK_MAX_RESPONSE_BYTES are read and none is kept.
async function postWebhook(
  url: URL,
  body: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Attempt> {
  const controller = new AbortController();
  const timedOut = Symbol("timed out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(timedOut);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(url.href, { method: "POST", redirect: "manual", headers, body, signal: controller.signal }),
      deadline,
    ]);
    if (response === timedOut) return { sent: false, code: "timeout" };
    const status = response.status;
    if ((await Promise.race([discardBody(response), deadline])) === timedOut) return { sent: false, code: "timeout" };
    if (status >= 200 && status < 300) return { sent: true, status };
    return { sent: false, code: status >= 300 && status < 400 ? "redirect_refused" : "http_error", status };
  } catch {
    return { sent: false, code: controller.signal.aborted ? "timeout" : "request_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export interface WebhookDeliveryOptions {
  // fetch and the resolver are injectable so tests reach no network; the resolver defaults to DNS-over-HTTPS
  // through the same fetch.
  fetchImpl?: typeof fetch;
  resolve?: WebhookResolver;
  now?: () => number;
  timeoutMs?: number;
  correlationId?: string;
}

type Claimed = { event_id: string; workspace_id: string; endpoint_id: string; connection_id: string; payload: unknown };
type Destination = { url: string; active: boolean; keys: { id: string; secret: string }[] };

// A delivery left in sending by an interrupted run returns to retry and counts as an attempt, on the same
// schedule as a failed one; the receiver may see it twice and deduplicates by event ID.
export async function recoverStaleWebhookDeliveries(pool: Pool): Promise<number> {
  const recovered = await pool.query(
    `UPDATE webhook_deliveries SET attempt_count=attempt_count+1,
       status=CASE WHEN attempt_count>=cardinality($1::int[]) THEN 'dead' ELSE 'retry' END,
       next_attempt_at=CASE WHEN attempt_count>=cardinality($1::int[]) THEN next_attempt_at
         ELSE now()+make_interval(mins=>($1::int[])[attempt_count+1]) END,
       attempt_id=NULL,failure_code='worker_interrupted',last_status_code=NULL,updated_at=now()
     WHERE status='sending' AND attempt_started_at<now()-make_interval(mins=>$2)`,
    [[...WEBHOOK_RETRY_DELAYS_MINUTES], WEBHOOK_STALE_MINUTES],
  );
  return recovered.rowCount ?? 0;
}

async function attempt(
  pool: Pool,
  claimed: Claimed,
  encryptionKey: string,
  fetchImpl: typeof fetch,
  resolve: WebhookResolver,
  now: () => number,
  timeoutMs: number,
): Promise<Attempt | "endpoint_inactive"> {
  // The endpoint and its valid keys are read after the claim, immediately before the checks and the request.
  const destination = (
    await pool.query<Destination>(
      `SELECT endpoint.url,endpoint.active,coalesce((SELECT jsonb_agg(jsonb_build_object('id',key.id,'secret',key.secret_encrypted)
           ORDER BY key.created_at,key.id) FROM webhook_signing_keys key
         WHERE key.endpoint_id=endpoint.id AND key.retired_at IS NULL),'[]'::jsonb) AS keys
       FROM webhook_endpoints endpoint WHERE endpoint.id=$1`,
      [claimed.endpoint_id],
    )
  ).rows[0];
  if (!destination?.active) return "endpoint_inactive";
  const url = parseWebhookUrl(destination.url);
  if (!url) return { sent: false, code: "url_refused" };
  let keys: { id: string; secret: string }[];
  try {
    keys = destination.keys.map((key) => ({
      id: key.id,
      secret: openSecret(
        key.secret,
        encryptionKey,
        signingKeyContext(claimed.workspace_id, claimed.endpoint_id, key.id),
      ),
    }));
  } catch {
    keys = [];
  }
  if (!keys.length) return { sent: false, code: "signing_unavailable" };
  const body = JSON.stringify(claimed.payload);
  const headers = {
    "content-type": "application/json",
    "user-agent": WEBHOOK_USER_AGENT,
    "X-AutoChatter-Event-Id": claimed.event_id,
    "X-AutoChatter-Signature": webhookSignature(body, keys, Math.floor(now() / 1000)),
  };
  // The name is resolved again for every attempt, immediately before the request, so a name that passed the
  // URL rules at creation is still refused when it points at a private or reserved address now.
  let addresses: string[];
  try {
    addresses = await resolve(url.hostname.replace(/\.$/, ""));
  } catch {
    return { sent: false, code: "dns_failed" };
  }
  if (!addresses.length) return { sent: false, code: "dns_no_address" };
  if (!addresses.every(isPublicAddress)) return { sent: false, code: "address_refused" };
  return postWebhook(url, body, headers, fetchImpl, timeoutMs);
}

// Delivers due webhook deliveries one at a time. A row is claimed with FOR UPDATE SKIP LOCKED and a fresh
// attempt ID, and every later change requires status 'sending' and that attempt ID, so overlapping runs
// never finish each other's attempts. Delivery is at-least-once.
export async function deliverDueWebhooks(
  pool: Pool,
  encryptionKey: string,
  options: WebhookDeliveryOptions = {},
): Promise<{ attempted: number; sent: number }> {
  // Called as plain functions: workerd rejects its native fetch when it is invoked with an object as receiver.
  const injectedFetch = options.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = (input, init) => injectedFetch(input, init);
  const resolve = options.resolve ?? dohResolver(fetchImpl);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const log = (event: string, code: string, connectionId: string, level: "warn" | "error") =>
    logOperation({ event, code, correlation_id: options.correlationId, connection_id: connectionId }, level);
  await recoverStaleWebhookDeliveries(pool);
  const started = now();
  const spent = new Map<string, number>();
  const exhausted: string[] = [];
  let attempted = 0;
  let sent = 0;
  while (attempted < WEBHOOK_MAX_DELIVERIES_PER_RUN && now() - started < WEBHOOK_RUN_BUDGET_MS) {
    const attemptId = crypto.randomUUID();
    const claimed = (
      await pool.query<Claimed>(
        `UPDATE webhook_deliveries delivery SET status='sending',attempt_id=$1,attempt_started_at=now(),updated_at=now()
         WHERE delivery.event_id=(SELECT due.event_id FROM webhook_deliveries due
           WHERE due.status IN ('pending','retry') AND due.next_attempt_at<=now() AND NOT due.endpoint_id=ANY($2::uuid[])
           ORDER BY due.next_attempt_at,due.event_id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING delivery.event_id::text,delivery.workspace_id::text,delivery.endpoint_id::text,
           delivery.connection_id::text,delivery.payload`,
        [attemptId, exhausted],
      )
    ).rows[0];
    if (!claimed) break;
    attempted++;
    const attemptStarted = now();
    const result = await attempt(pool, claimed, encryptionKey, fetchImpl, resolve, now, timeoutMs);
    const used = (spent.get(claimed.endpoint_id) ?? 0) + (now() - attemptStarted);
    spent.set(claimed.endpoint_id, used);
    if (used >= WEBHOOK_ENDPOINT_BUDGET_MS && !exhausted.includes(claimed.endpoint_id))
      exhausted.push(claimed.endpoint_id);
    const mine = "WHERE event_id=$1 AND status='sending' AND attempt_id=$2";
    let finished;
    if (result === "endpoint_inactive") {
      finished = await pool.query<{ status: string }>(
        `UPDATE webhook_deliveries SET status='dead',attempt_id=NULL,failure_code='endpoint_inactive',
           last_status_code=NULL,updated_at=now() ${mine} RETURNING status`,
        [claimed.event_id, attemptId],
      );
    } else if (result.sent) {
      // The payload is removed with the same statement, so field values are not kept after delivery.
      finished = await pool.query<{ status: string }>(
        `UPDATE webhook_deliveries SET status='sent',payload=NULL,attempt_count=attempt_count+1,attempt_id=NULL,
           failure_code=NULL,last_status_code=$3,sent_at=now(),updated_at=now() ${mine} RETURNING status`,
        [claimed.event_id, attemptId, result.status],
      );
    } else {
      const status = result.status !== undefined && result.status >= 100 && result.status <= 599 ? result.status : null;
      finished = await pool.query<{ status: string }>(
        `UPDATE webhook_deliveries SET attempt_count=attempt_count+1,
           status=CASE WHEN attempt_count>=cardinality($5::int[]) THEN 'dead' ELSE 'retry' END,
           next_attempt_at=CASE WHEN attempt_count>=cardinality($5::int[]) THEN next_attempt_at
             ELSE now()+make_interval(mins=>($5::int[])[attempt_count+1]) END,
           attempt_id=NULL,failure_code=$3,last_status_code=$4,updated_at=now() ${mine} RETURNING status`,
        [claimed.event_id, attemptId, result.code, status, [...WEBHOOK_RETRY_DELAYS_MINUTES]],
      );
    }
    const outcome = finished.rows[0]?.status;
    // Only fixed codes are logged: never the URL, the host, the payload, a secret or the response.
    if (outcome === undefined) log("webhook_delivery_claim_lost", "claim_lost", claimed.connection_id, "warn");
    else if (outcome === "sent") sent++;
    else {
      const code = result === "endpoint_inactive" ? result : result.sent ? "unexpected_error" : result.code;
      if (outcome === "dead") log("webhook_delivery_dead", code, claimed.connection_id, "error");
      else log("webhook_delivery_failed", code, claimed.connection_id, "warn");
    }
  }
  return { attempted, sent };
}
