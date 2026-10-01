import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { Pool } from "pg";
import {
  deliverDueWebhooks,
  recoverStaleWebhookDeliveries,
  WEBHOOK_MAX_DELIVERIES_PER_RUN,
  WEBHOOK_MAX_RESPONSE_BYTES,
  WEBHOOK_USER_AGENT,
  type WebhookDeliveryOptions,
} from "./webhook-delivery.ts";
import { createWebhookEndpoint, retireWebhookKey, rotateWebhookKey, setWebhookEndpointActive } from "./webhooks.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for database tests");
const testUrl = new URL(databaseUrl);
if (testUrl.pathname !== "/automations_test" || !["127.0.0.1", "localhost"].includes(testUrl.hostname))
  throw new Error("Database tests require a local automations_test database");

const pool = new Pool({ connectionString: databaseUrl });
const user = { id: "11111111-1111-4111-8111-111111111111", email: "admin@example.test" };
const workspaceId = "33333333-3333-4333-8333-333333333333";
const connectionId = "55555555-5555-4555-8555-555555555555";
const flowId = "77777777-7777-4777-8777-777777777777";
const versionId = "88888888-8888-4888-8888-888888888888";
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const env = { TOKEN_ENCRYPTION_KEY: encryptionKey };
const publicAddress = "93.184.216.34";
let runId: string;
let nodeNumber: number;
let logCalls: unknown[][];

before(async () => {
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  nodeNumber = 0;
  logCalls = [];
  for (const method of ["log", "warn", "error"] as const)
    mock.method(console, method, (...args: unknown[]) => {
      logCalls.push(args);
    });
  await pool.query("TRUNCATE workspaces CASCADE");
  await pool.query("INSERT INTO workspaces(id) VALUES($1)", [workspaceId]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id) VALUES($1,$2)", [workspaceId, user.id]);
  await pool.query(
    "INSERT INTO instagram_connections(id,workspace_id,account_id,active) VALUES($1,$2,'owned-account',true)",
    [connectionId, workspaceId],
  );
  await pool.query("INSERT INTO flows(id,workspace_id,name,draft) VALUES($1,$2,'Notify','{}')", [flowId, workspaceId]);
  await pool.query(
    `INSERT INTO flow_versions(id,flow_id,workspace_id,version_no,draft_revision,definition,trigger_connection_id,trigger_media_id,published_by)
     VALUES($1,$2,$3,1,0,'{}',$4,'1789',$5)`,
    [versionId, flowId, workspaceId, connectionId, user.id],
  );
  const event = await pool.query<{ id: string }>(
    `INSERT INTO instagram_comment_events(workspace_id,connection_id,comment_id,media_id,sender_id,comment_text)
     VALUES($1,$2,'comment-1','1789','sender-1','COMMENT-SENTINEL') RETURNING id`,
    [workspaceId, connectionId],
  );
  runId = (
    await pool.query<{ id: string }>(
      `INSERT INTO flow_runs(workspace_id,connection_id,flow_id,flow_version_id,event_id,status)
       VALUES($1,$2,$3,$4,$5,'ended') RETURNING id`,
      [workspaceId, connectionId, flowId, versionId, event.rows[0]!.id],
    )
  ).rows[0]!.id;
});

afterEach(() => mock.restoreAll());
after(async () => pool.end());

async function endpoint(name = "crm", url = "https://hooks.example.test/in?token=URL-SENTINEL") {
  const created = await createWebhookEndpoint(pool, user, { name, url }, env);
  return { id: created.id as string, keyId: created.key.id, secret: created.key.secret };
}

// One queued delivery of the fixture run; each call uses another node, as one node has one delivery per run.
async function delivery(endpointId: string, dueSecondsAgo = 1): Promise<string> {
  const eventId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO webhook_deliveries(event_id,workspace_id,endpoint_id,connection_id,flow_id,flow_run_id,node_id,sender_id,payload,next_attempt_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'sender-1',$8,now()-make_interval(secs=>$9))`,
    [
      eventId,
      workspaceId,
      endpointId,
      connectionId,
      flowId,
      runId,
      `hook-${++nodeNumber}`,
      JSON.stringify({ event_id: eventId, type: "flow.webhook", fields: { city: "PAYLOAD-SENTINEL" } }),
      dueSecondsAgo,
    ],
  );
  return eventId;
}

type Row = {
  status: string;
  attempt_count: number;
  failure_code: string | null;
  last_status_code: number | null;
  payload: unknown;
  sent: boolean;
  wait_seconds: number;
};

async function row(eventId: string): Promise<Row> {
  return (
    await pool.query<Row>(
      `SELECT status,attempt_count,failure_code,last_status_code,payload,sent_at IS NOT NULL AS sent,
         round(extract(epoch FROM next_attempt_at-now()))::int AS wait_seconds
       FROM webhook_deliveries WHERE event_id=$1`,
      [eventId],
    )
  ).rows[0]!;
}

async function makeDue() {
  await pool.query("UPDATE webhook_deliveries SET next_attempt_at=now()-interval '1 second' WHERE status='retry'");
}

type Call = { url: string; init: RequestInit };

// A fetch that records each request and answers with what the test supplies.
function recorder(answer: (call: Call) => Response | Promise<Response> = () => new Response("ok")) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function deliver(fetchImpl: typeof fetch, options: WebhookDeliveryOptions = {}) {
  return deliverDueWebhooks(pool, encryptionKey, { fetchImpl, resolve: async () => [publicAddress], ...options });
}

function signatureOf(call: Call) {
  const header = new Headers(call.init.headers).get("x-autochatter-signature") ?? "";
  const parts = header.split(",");
  assert.match(parts[0]!, /^t=\d+$/, header);
  assert.equal(parts.length % 2, 1, header);
  const pairs: { k: string; v1: string }[] = [];
  for (let index = 1; index < parts.length; index += 2) {
    assert.match(parts[index]!, /^k=[0-9a-f-]{36}$/, header);
    assert.match(parts[index + 1]!, /^v1=[0-9a-f]{64}$/, header);
    pairs.push({ k: parts[index]!.slice(2), v1: parts[index + 1]!.slice(3) });
  }
  return { t: parts[0]!.slice(2), pairs };
}

function hmac(secret: string, timestamp: string, body: unknown): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${String(body)}`)
    .digest("hex");
}

test("a 2xx answer marks the delivery sent, removes its payload and signs the exact request body", async () => {
  const target = await endpoint();
  const eventId = await delivery(target.id);
  const stored = (await row(eventId)).payload;
  const { calls, fetchImpl } = recorder(() => new Response(null, { status: 204 }));
  assert.deepEqual(await deliver(fetchImpl, { now: () => 1_790_000_000_500 }), { attempted: 1, sent: 1 });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call!.url, "https://hooks.example.test/in?token=URL-SENTINEL");
  assert.equal(call!.init.method, "POST");
  assert.equal(call!.init.redirect, "manual");
  const headers = new Headers(call!.init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("user-agent"), WEBHOOK_USER_AGENT);
  assert.equal(headers.get("x-autochatter-event-id"), eventId);
  assert.deepEqual(JSON.parse(String(call!.init.body)), stored);
  const signature = signatureOf(call!);
  assert.equal(signature.t, "1790000000");
  assert.deepEqual(signature.pairs, [{ k: target.keyId, v1: hmac(target.secret, signature.t, call!.init.body) }]);
  const { wait_seconds: _wait, ...sent } = await row(eventId);
  assert.deepEqual(sent, {
    status: "sent",
    attempt_count: 1,
    failure_code: null,
    last_status_code: 204,
    payload: null,
    sent: true,
  });
  // A sent delivery is not attempted again.
  assert.deepEqual(await deliver(fetchImpl), { attempted: 0, sent: 0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(logCalls, []);
});

test("a stored URL that breaks the URL rules is refused without a lookup or a request", async () => {
  const target = await endpoint();
  for (const url of [
    "https://127.0.0.1/in",
    "https://203.0.113.10/in",
    "https://2130706433/in",
    "https://[::1]/in",
    "https://[2606:4700:4700::1111]/in",
    "https://user:secret@hooks.example.test/in",
    "https://hooks.example.test:8443/in",
    "https://localhost/in",
    "https://app.localhost/in",
    "https://printer.local/in",
    "https://metadata.google.internal/in",
  ]) {
    await pool.query("UPDATE webhook_endpoints SET url=$2 WHERE id=$1", [target.id, url]);
    const eventId = await delivery(target.id);
    const { calls, fetchImpl } = recorder();
    let lookups = 0;
    const result = await deliver(fetchImpl, {
      resolve: async () => {
        lookups++;
        return [publicAddress];
      },
    });
    assert.deepEqual(result, { attempted: 1, sent: 0 }, url);
    assert.equal(calls.length, 0, url);
    assert.equal(lookups, 0, url);
    const stored = await row(eventId);
    assert.deepEqual([stored.status, stored.failure_code, stored.attempt_count], ["retry", "url_refused", 1], url);
    await pool.query("UPDATE webhook_deliveries SET status='dead' WHERE event_id=$1", [eventId]);
  }
});

test("a name that resolves to any address that is not public is refused without a request", async () => {
  const target = await endpoint();
  const classes: [string, string[]][] = [
    ["loopback", ["127.0.0.1"]],
    ["loopback IPv6", ["::1"]],
    ["private", ["10.0.0.5"]],
    ["private 172", ["172.16.0.1"]],
    ["private 192", ["192.168.0.10"]],
    ["unique local IPv6", ["fd00::1"]],
    ["link-local", ["169.254.169.254"]],
    ["link-local IPv6", ["fe80::1"]],
    ["CGNAT", ["100.64.0.1"]],
    ["multicast", ["224.0.0.1"]],
    ["multicast IPv6", ["ff02::1"]],
    ["unspecified", ["0.0.0.0"]],
    ["unspecified IPv6", ["::"]],
    ["reserved", ["240.0.0.1"]],
    ["documentation", ["192.0.2.1"]],
    ["IPv4-mapped private", ["::ffff:10.0.0.5"]],
    ["NAT64 private", ["64:ff9b::a00:5"]],
    ["one private address among public ones", [publicAddress, "10.0.0.5", "2606:4700::1"]],
    ["not an address", ["hooks.example.test"]],
  ];
  for (const [label, addresses] of classes) {
    const eventId = await delivery(target.id);
    const { calls, fetchImpl } = recorder();
    assert.deepEqual(await deliver(fetchImpl, { resolve: async () => addresses }), { attempted: 1, sent: 0 }, label);
    assert.equal(calls.length, 0, label);
    const stored = await row(eventId);
    assert.deepEqual([stored.status, stored.failure_code], ["retry", "address_refused"], label);
    await pool.query("UPDATE webhook_deliveries SET status='dead' WHERE event_id=$1", [eventId]);
  }
  for (const [code, resolve] of [
    ["dns_no_address", async () => []],
    [
      "dns_failed",
      async () => {
        throw new Error("lookup failed for hooks.example.test");
      },
    ],
  ] as const) {
    const eventId = await delivery(target.id);
    const { calls, fetchImpl } = recorder();
    assert.deepEqual(await deliver(fetchImpl, { resolve }), { attempted: 1, sent: 0 }, code);
    assert.equal(calls.length, 0, code);
    assert.equal((await row(eventId)).failure_code, code);
    await pool.query("UPDATE webhook_deliveries SET status='dead' WHERE event_id=$1", [eventId]);
  }
});

test("the name is resolved again immediately before every request, also for a URL accepted at creation", async () => {
  // Creation applies the URL rules only; this name is accepted although it later points at a private address.
  const target = await endpoint("rebind", "https://rebind.example.test/in");
  const order: string[] = [];
  let addresses = [publicAddress];
  const fetchImpl = (async () => {
    order.push("request");
    return new Response("ok");
  }) as typeof fetch;
  const resolve = async (hostname: string) => {
    order.push(`resolve ${hostname}`);
    return addresses;
  };
  const first = await delivery(target.id);
  assert.deepEqual(await deliver(fetchImpl, { resolve }), { attempted: 1, sent: 1 });
  assert.equal((await row(first)).status, "sent");
  addresses = ["10.0.0.5"];
  const second = await delivery(target.id);
  assert.deepEqual(await deliver(fetchImpl, { resolve }), { attempted: 1, sent: 0 });
  assert.deepEqual([(await row(second)).status, (await row(second)).failure_code], ["retry", "address_refused"]);
  // The retry resolves the name once more instead of reusing an earlier answer.
  addresses = [publicAddress];
  await makeDue();
  assert.deepEqual(await deliver(fetchImpl, { resolve }), { attempted: 1, sent: 1 });
  assert.deepEqual(order, [
    "resolve rebind.example.test",
    "request",
    "resolve rebind.example.test",
    "resolve rebind.example.test",
    "request",
  ]);
});

test("a redirect is a failure and is never followed", async () => {
  const target = await endpoint();
  for (const status of [301, 302, 303, 307, 308]) {
    const eventId = await delivery(target.id);
    const { calls, fetchImpl } = recorder(
      () => new Response(null, { status, headers: { location: "https://127.0.0.1/internal" } }),
    );
    assert.deepEqual(await deliver(fetchImpl), { attempted: 1, sent: 0 });
    assert.equal(calls.length, 1, String(status));
    assert.equal(calls[0]!.init.redirect, "manual");
    const stored = await row(eventId);
    assert.deepEqual(
      [stored.status, stored.failure_code, stored.last_status_code],
      ["retry", "redirect_refused", status],
    );
    await pool.query("UPDATE webhook_deliveries SET status='dead' WHERE event_id=$1", [eventId]);
  }
});

test("the timeout covers the wait for the response and the read of its body", async () => {
  const target = await endpoint();
  const noAnswer = await delivery(target.id);
  let aborted = false;
  const silent = ((_input: URL | RequestInfo, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch;
  const started = Date.now();
  assert.deepEqual(await deliver(silent, { timeoutMs: 40 }), { attempted: 1, sent: 0 });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(aborted, true);
  assert.deepEqual([(await row(noAnswer)).status, (await row(noAnswer)).failure_code], ["retry", "timeout"]);
  await pool.query("UPDATE webhook_deliveries SET status='dead' WHERE event_id=$1", [noAnswer]);

  // The headers arrive at once with status 200, but the body never ends: still a timeout, not a success.
  const slowBody = await delivery(target.id);
  let bodyAborted = false;
  const stalling = (async (_input: URL | RequestInfo, init?: RequestInit) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
          init!.signal!.addEventListener("abort", () => {
            bodyAborted = true;
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      }),
    )) as typeof fetch;
  assert.deepEqual(await deliver(stalling, { timeoutMs: 40 }), { attempted: 1, sent: 0 });
  assert.equal(bodyAborted, true);
  const stored = await row(slowBody);
  assert.deepEqual([stored.status, stored.failure_code, stored.sent], ["retry", "timeout", false]);
  assert.notEqual(stored.payload, null);
});

test("a request made without an injected timeout gets the 10-second limit", async () => {
  const target = await endpoint();
  await delivery(target.id);
  // Records the delay of every timer set from the DNS answer until the request starts; the delivery sets
  // exactly one there, the request's own. The timers themselves stay real.
  const realSetTimeout = globalThis.setTimeout;
  const delays: unknown[] = [];
  let recording = false;
  mock.method(globalThis, "setTimeout", ((handler: () => void, delay?: number) => {
    if (recording) delays.push(delay);
    return realSetTimeout(handler, delay);
  }) as unknown as typeof setTimeout);
  const fetchImpl = (async () => {
    recording = false;
    return new Response("ok");
  }) as typeof fetch;
  const resolve = async () => {
    recording = true;
    return [publicAddress];
  };
  assert.deepEqual(await deliverDueWebhooks(pool, encryptionKey, { fetchImpl, resolve }), { attempted: 1, sent: 1 });
  assert.deepEqual(delays, [10_000]);
});

test("at most 64 KB of the response is read and none of it is kept", async () => {
  assert.equal(WEBHOOK_MAX_RESPONSE_BYTES, 64 * 1024);
  const target = await endpoint();
  const eventId = await delivery(target.id);
  const chunk = 16 * 1024;
  let produced = 0;
  let cancelled = false;
  const endless = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          produced += chunk;
          controller.enqueue(new TextEncoder().encode("R".repeat(chunk)));
        },
        cancel() {
          cancelled = true;
        },
      }),
    )) as typeof fetch;
  assert.deepEqual(await deliver(endless), { attempted: 1, sent: 1 });
  assert.equal(cancelled, true);
  // The stream may have one chunk queued ahead of the reader.
  assert.ok(produced >= 64 * 1024, String(produced));
  assert.ok(produced <= 64 * 1024 + 2 * chunk, String(produced));
  const stored = await pool.query("SELECT to_jsonb(d)::text AS text FROM webhook_deliveries d WHERE event_id=$1", [
    eventId,
  ]);
  assert.ok(!stored.rows[0].text.includes("RRRR"));
  assert.equal((await row(eventId)).status, "sent");
});

test("a failed delivery is retried after 1, 5, 30, 120 and 360 minutes and then ends as dead", async () => {
  const target = await endpoint();
  const eventId = await delivery(target.id);
  const { calls, fetchImpl } = recorder(() => new Response("RESPONSE-SENTINEL", { status: 500 }));
  for (const [index, minutes] of [1, 5, 30, 120, 360].entries()) {
    assert.deepEqual(await deliver(fetchImpl), { attempted: 1, sent: 0 });
    const stored = await row(eventId);
    assert.deepEqual(
      [stored.status, stored.attempt_count, stored.failure_code, stored.last_status_code],
      ["retry", index + 1, "http_error", 500],
    );
    assert.ok(Math.abs(stored.wait_seconds - minutes * 60) <= 2, `${minutes} minutes, got ${stored.wait_seconds}s`);
    // Not due yet: nothing is attempted.
    assert.deepEqual(await deliver(fetchImpl), { attempted: 0, sent: 0 });
    await makeDue();
  }
  assert.deepEqual(await deliver(fetchImpl), { attempted: 1, sent: 0 });
  const dead = await row(eventId);
  assert.deepEqual([dead.status, dead.attempt_count, dead.failure_code, dead.sent], ["dead", 6, "http_error", false]);
  assert.notEqual(dead.payload, null);
  assert.equal(calls.length, 6);
  await pool.query("UPDATE webhook_deliveries SET next_attempt_at=now()-interval '1 day'");
  assert.deepEqual(await deliver(fetchImpl), { attempted: 0, sent: 0 });
  assert.equal(calls.length, 6);
  // Every attempt carried the same event ID.
  assert.deepEqual(
    [...new Set(calls.map((call) => new Headers(call.init.headers).get("x-autochatter-event-id")))],
    [eventId],
  );
});

test("a delivery left in sending for over 10 minutes returns to retry and counts as an attempt", async () => {
  const target = await endpoint();
  const stale = await delivery(target.id);
  const fresh = await delivery(target.id);
  const lastAttempt = await delivery(target.id);
  const claim = (eventId: string, minutes: number, attempts: number) =>
    pool.query(
      `UPDATE webhook_deliveries SET status='sending',attempt_id=gen_random_uuid(),attempt_count=$3,
         attempt_started_at=now()-make_interval(mins=>$2) WHERE event_id=$1`,
      [eventId, minutes, attempts],
    );
  await claim(stale, 11, 0);
  await claim(fresh, 9, 0);
  await claim(lastAttempt, 11, 5);
  assert.equal(await recoverStaleWebhookDeliveries(pool), 2);
  const recovered = await row(stale);
  assert.deepEqual(
    [recovered.status, recovered.attempt_count, recovered.failure_code],
    ["retry", 1, "worker_interrupted"],
  );
  assert.ok(Math.abs(recovered.wait_seconds - 60) <= 2, String(recovered.wait_seconds));
  assert.equal((await row(fresh)).status, "sending");
  const exhausted = await row(lastAttempt);
  assert.deepEqual([exhausted.status, exhausted.attempt_count], ["dead", 6]);
  // The cron step recovers stale rows itself before it claims work.
  await claim(fresh, 11, 0);
  const { calls, fetchImpl } = recorder();
  assert.deepEqual(await deliver(fetchImpl), { attempted: 0, sent: 0 });
  assert.equal((await row(fresh)).status, "retry");
  assert.equal(calls.length, 0);
});

test("an attempt that lost its claim changes nothing", async () => {
  const target = await endpoint();
  const eventId = await delivery(target.id);
  const other = crypto.randomUUID();
  // While the request is in flight another run recovers and claims the row again.
  const { fetchImpl } = recorder(async () => {
    await pool.query("UPDATE webhook_deliveries SET attempt_id=$2 WHERE event_id=$1", [eventId, other]);
    return new Response("ok");
  });
  assert.deepEqual(await deliver(fetchImpl, { correlationId: "run-1" }), { attempted: 1, sent: 0 });
  const stored = (
    await pool.query("SELECT status,attempt_id::text,payload IS NOT NULL AS kept FROM webhook_deliveries")
  ).rows[0];
  assert.deepEqual(stored, { status: "sending", attempt_id: other, kept: true });
  assert.deepEqual(
    logCalls.map(([line]) => JSON.parse(String(line))),
    [
      {
        event: "webhook_delivery_claim_lost",
        code: "claim_lost",
        correlation_id: "run-1",
        connection_id: connectionId,
      },
    ],
  );
});

test("overlapping runs attempt each due delivery once", async () => {
  const target = await endpoint();
  for (let index = 0; index < 6; index++) await delivery(target.id);
  const { calls, fetchImpl } = recorder(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response("ok");
  });
  const results = await Promise.all([deliver(fetchImpl), deliver(fetchImpl), deliver(fetchImpl)]);
  assert.equal(
    results.reduce((sum, result) => sum + result.sent, 0),
    6,
  );
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls.map((call) => new Headers(call.init.headers).get("x-autochatter-event-id"))).size, 6);
});

test("while two keys are valid every delivery carries both signatures, and one after the older is retired", async () => {
  const target = await endpoint();
  const rotated = await rotateWebhookKey(pool, user, target.id, env);
  const { calls, fetchImpl } = recorder();
  await delivery(target.id);
  assert.deepEqual(await deliver(fetchImpl), { attempted: 1, sent: 1 });
  const both = signatureOf(calls[0]!);
  assert.deepEqual(both.pairs, [
    { k: target.keyId, v1: hmac(target.secret, both.t, calls[0]!.init.body) },
    { k: rotated.key.id, v1: hmac(rotated.key.secret, both.t, calls[0]!.init.body) },
  ]);
  assert.notEqual(both.pairs[0]!.v1, both.pairs[1]!.v1);

  assert.deepEqual(await retireWebhookKey(pool, user, target.id), {
    retired_key_id: target.keyId,
    key_id: rotated.key.id,
  });
  await delivery(target.id);
  assert.deepEqual(await deliver(fetchImpl), { attempted: 1, sent: 1 });
  const one = signatureOf(calls[1]!);
  assert.deepEqual(one.pairs, [{ k: rotated.key.id, v1: hmac(rotated.key.secret, one.t, calls[1]!.init.body) }]);
});

test("a delivery to a disabled endpoint ends as dead without a lookup or a request", async () => {
  const target = await endpoint();
  const eventId = await delivery(target.id);
  await setWebhookEndpointActive(pool, user, target.id, false);
  const { calls, fetchImpl } = recorder();
  let lookups = 0;
  const result = await deliver(fetchImpl, {
    resolve: async () => {
      lookups++;
      return [publicAddress];
    },
  });
  assert.deepEqual(result, { attempted: 1, sent: 0 });
  assert.equal(calls.length + lookups, 0);
  const stored = await row(eventId);
  assert.deepEqual([stored.status, stored.failure_code, stored.attempt_count], ["dead", "endpoint_inactive", 0]);
});

test("a signing secret that cannot be opened sends nothing", async () => {
  const target = await endpoint();
  const eventId = await delivery(target.id);
  const { calls, fetchImpl } = recorder();
  const otherKey = Buffer.alloc(32, 9).toString("base64");
  assert.deepEqual(await deliverDueWebhooks(pool, otherKey, { fetchImpl, resolve: async () => [publicAddress] }), {
    attempted: 1,
    sent: 0,
  });
  assert.equal(calls.length, 0);
  assert.deepEqual([(await row(eventId)).status, (await row(eventId)).failure_code], ["retry", "signing_unavailable"]);
});

test("one run attempts a bounded number of deliveries and stops claiming after its time budget", async () => {
  const target = await endpoint();
  for (let index = 0; index < WEBHOOK_MAX_DELIVERIES_PER_RUN + 3; index++) await delivery(target.id);
  const { calls, fetchImpl } = recorder();
  assert.deepEqual(await deliver(fetchImpl), {
    attempted: WEBHOOK_MAX_DELIVERIES_PER_RUN,
    sent: WEBHOOK_MAX_DELIVERIES_PER_RUN,
  });
  // Three subrequests per attempt must stay under the 50 per invocation of Workers Free.
  assert.equal(calls.length, 10);
  // A run that has used its time budget claims nothing more; the rest waits for the next run.
  let clock = 0;
  const slow = recorder(() => {
    clock += 21_000;
    return new Response("ok");
  });
  assert.deepEqual(await deliver(slow.fetchImpl, { now: () => clock }), { attempted: 1, sent: 1 });
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM webhook_deliveries WHERE status='pending'")).rows[0].count,
    2,
  );
});

test("a slow endpoint gets one attempt per run and the other endpoints keep the rest of the run", async () => {
  const slow = await endpoint("slow", "https://slow.example.test/in");
  const fast = await endpoint("fast", "https://fast.example.test/in");
  // The slow endpoint's deliveries are the oldest, so they are claimed first.
  const slowDeliveries = [await delivery(slow.id, 300), await delivery(slow.id, 200), await delivery(slow.id, 100)];
  const fastDeliveries = [await delivery(fast.id, 20), await delivery(fast.id, 10)];
  let clock = 0;
  const { calls, fetchImpl } = recorder((call) => {
    clock += call.url.startsWith("https://slow.") ? 6_000 : 50;
    return call.url.startsWith("https://slow.") ? new Response(null, { status: 503 }) : new Response("ok");
  });
  assert.deepEqual(await deliver(fetchImpl, { now: () => clock }), { attempted: 3, sent: 2 });
  assert.deepEqual(
    calls.map((call) => new URL(call.url).hostname),
    ["slow.example.test", "fast.example.test", "fast.example.test"],
  );
  assert.deepEqual(await Promise.all(slowDeliveries.map(async (eventId) => (await row(eventId)).status)), [
    "retry",
    "pending",
    "pending",
  ]);
  assert.deepEqual(await Promise.all(fastDeliveries.map(async (eventId) => (await row(eventId)).status)), [
    "sent",
    "sent",
  ]);
});

test("delivery logs carry fixed codes only: no URL, host, payload, secret or response", async () => {
  const target = await endpoint();
  const eventId = await delivery(target.id);
  const { fetchImpl } = recorder(() => new Response("RESPONSE-SENTINEL", { status: 500 }));
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.deepEqual(await deliver(fetchImpl, { correlationId: "run-7" }), { attempted: 1, sent: 0 });
    await makeDue();
  }
  assert.equal((await row(eventId)).status, "dead");
  const refused = await delivery(target.id);
  await deliver(fetchImpl, { resolve: async () => ["10.0.0.5"] });
  assert.equal((await row(refused)).failure_code, "address_refused");
  const lines = logCalls.map((args) => {
    assert.equal(args.length, 1);
    assert.equal(typeof args[0], "string");
    return JSON.parse(args[0] as string) as Record<string, string>;
  });
  assert.deepEqual(
    lines.map((line) => `${line.event}:${line.code}`),
    [
      ...Array.from({ length: 5 }, () => "webhook_delivery_failed:http_error"),
      "webhook_delivery_dead:http_error",
      "webhook_delivery_failed:address_refused",
    ],
  );
  for (const line of lines)
    for (const key of Object.keys(line))
      assert.ok(["event", "code", "correlation_id", "connection_id"].includes(key), key);
  const text = JSON.stringify(logCalls);
  for (const forbidden of [
    "hooks.example.test",
    "https:",
    "URL-SENTINEL",
    "PAYLOAD-SENTINEL",
    "RESPONSE-SENTINEL",
    "COMMENT-SENTINEL",
    "sender-1",
    target.secret,
    "whsec_",
    eventId,
    "10.0.0.5",
  ])
    assert.ok(!text.includes(forbidden), forbidden);
});
