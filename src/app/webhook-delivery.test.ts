import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  dohResolver,
  isPublicAddress,
  parseWebhookUrl,
  signingKeyContext,
  webhookSignature,
} from "./webhook-delivery.ts";

test("a webhook URL is https on port 443 with a public-looking host name", () => {
  assert.equal(
    parseWebhookUrl("https://hooks.example.com/in?source=flow")?.href,
    "https://hooks.example.com/in?source=flow",
  );
  assert.equal(parseWebhookUrl("https://hooks.example.com:443/in")?.href, "https://hooks.example.com/in");
  assert.equal(parseWebhookUrl("https://HOOKS.example.com")?.hostname, "hooks.example.com");
});

test("every refused class of webhook URL is rejected", () => {
  const refused: [string, unknown][] = [
    ["not a string", 1],
    ["not a URL", "hooks.example.com/in"],
    ["plain http", "http://hooks.example.com/in"],
    ["another scheme", "ftp://hooks.example.com/in"],
    ["another port", "https://hooks.example.com:8443/in"],
    ["port 80", "https://hooks.example.com:80/in"],
    ["a user name", "https://user@hooks.example.com/in"],
    ["a user name and password", "https://user:secret@hooks.example.com/in"],
    ["an IPv4 literal", "https://203.0.113.10/in"],
    ["a loopback IPv4 literal", "https://127.0.0.1/in"],
    ["an IPv4 literal with a trailing dot", "https://127.0.0.1./in"],
    ["a decimal IPv4 literal", "https://2130706433/in"],
    ["a hexadecimal IPv4 literal", "https://0x7f.0.0.1/in"],
    ["a short IPv4 literal", "https://127.1/in"],
    ["an IPv6 literal", "https://[2606:4700:4700::1111]/in"],
    ["a loopback IPv6 literal", "https://[::1]/in"],
    ["an IPv4-mapped IPv6 literal", "https://[::ffff:127.0.0.1]/in"],
    ["localhost", "https://localhost/in"],
    ["localhost with a trailing dot", "https://localhost./in"],
    ["localhost in another case", "https://LOCALHOST/in"],
    ["a name under .localhost", "https://app.localhost/in"],
    ["a name under .local", "https://printer.local/in"],
    ["a name under .internal", "https://metadata.google.internal/in"],
    ["a name under .internal with a trailing dot", "https://db.internal./in"],
    ["a URL over 2048 characters", `https://hooks.example.com/${"a".repeat(2048)}`],
  ];
  for (const [label, value] of refused) assert.equal(parseWebhookUrl(value), null, label);
});

test("only public unicast addresses pass, for every blocked class and its embedded IPv4 forms", () => {
  const blocked: Record<string, string[]> = {
    loopback: ["127.0.0.1", "127.255.255.254", "::1"],
    private: ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "fc00::1", "fd12:3456::1"],
    "link-local": ["169.254.169.254", "fe80::1"],
    CGNAT: ["100.64.0.1", "100.127.255.255"],
    multicast: ["224.0.0.1", "239.255.255.255", "ff02::1"],
    unspecified: ["0.0.0.0", "0.1.2.3", "::"],
    reserved: [
      "240.0.0.1",
      "255.255.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.1",
      "2001:db8::1",
      "2001::1",
      "2002:7f00:1::1",
      "3fff::1",
      "100::1",
      "::2",
      "4000::1",
    ],
    "IPv4-mapped": [
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "::ffff:100.64.0.1",
    ],
    NAT64: ["64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "64:ff9b::c0a8:101", "64:ff9b:1::1"],
    "not an address": [
      "",
      "hooks.example.com",
      "1.2.3",
      "999.1.1.1",
      "1.2.3.4.5",
      "fe80::1%eth0",
      "1::2::3",
      "12345::1",
    ],
  };
  for (const [label, addresses] of Object.entries(blocked))
    for (const address of addresses) assert.equal(isPublicAddress(address), false, `${label}: ${address}`);
  for (const address of [
    "1.1.1.1",
    "8.8.8.8",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.255.255",
    "192.167.255.255",
    "198.17.255.255",
    "198.20.0.1",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:1.1.1.1",
    "64:ff9b::808:808",
  ])
    assert.equal(isPublicAddress(address), true, address);
});

test("the signature carries one timestamp and one key and HMAC pair per valid key", () => {
  const body = '{"event_id":"e-1"}';
  const expected = (secret: string) => createHmac("sha256", secret).update(`1790000000.${body}`).digest("hex");
  assert.equal(
    webhookSignature(body, [{ id: "key-1", secret: "whsec_one" }], 1_790_000_000),
    `t=1790000000,k=key-1,v1=${expected("whsec_one")}`,
  );
  assert.equal(
    webhookSignature(
      body,
      [
        { id: "key-1", secret: "whsec_one" },
        { id: "key-2", secret: "whsec_two" },
      ],
      1_790_000_000,
    ),
    `t=1790000000,k=key-1,v1=${expected("whsec_one")},k=key-2,v1=${expected("whsec_two")}`,
  );
  // Another body or timestamp gives another signature.
  assert.notEqual(
    webhookSignature(`${body} `, [{ id: "key-1", secret: "whsec_one" }], 1_790_000_000),
    webhookSignature(body, [{ id: "key-1", secret: "whsec_one" }], 1_790_000_000),
  );
  assert.notEqual(
    webhookSignature(body, [{ id: "key-1", secret: "whsec_one" }], 1_790_000_001).split(",")[2],
    `v1=${expected("whsec_one")}`,
  );
});

test("the sealing context of a signing secret names its workspace, endpoint and key", () => {
  assert.equal(signingKeyContext("W", "E", "K"), "webhook-signing-key:w:e:k");
  assert.notEqual(signingKeyContext("w", "e1", "k"), signingKeyContext("w", "e2", "k"));
});

test("the DNS-over-HTTPS resolver returns every A and AAAA address and skips other records", async () => {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const resolve = dohResolver((async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    return url.searchParams.get("type") === "A"
      ? Response.json({
          Status: 0,
          Answer: [
            { name: "hooks.example.com", type: 5, data: "edge.example.net." },
            { name: "edge.example.net", type: 1, data: "203.0.113.7" },
            { name: "edge.example.net", type: 1, data: "8.8.8.8" },
          ],
        })
      : Response.json({ Status: 0, Answer: [{ name: "hooks.example.com", type: 28, data: "2606:4700::1" }] });
  }) as typeof fetch);
  assert.deepEqual(await resolve("hooks.example.com"), ["203.0.113.7", "8.8.8.8", "2606:4700::1"]);
  assert.deepEqual(requests.map(({ url }) => `${url.origin}${url.pathname}`).sort(), [
    "https://cloudflare-dns.com/dns-query",
    "https://cloudflare-dns.com/dns-query",
  ]);
  assert.deepEqual(requests.map(({ url }) => url.searchParams.get("type")).sort(), ["A", "AAAA"]);
  for (const { url, init } of requests) {
    assert.equal(url.searchParams.get("name"), "hooks.example.com");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("accept"), "application/dns-json");
  }
});

test("a name that does not exist or has no address resolves to no address", async () => {
  const nxdomain = dohResolver((async () => Response.json({ Status: 3 })) as typeof fetch);
  assert.deepEqual(await nxdomain("missing.example.com"), []);
  const empty = dohResolver((async () => Response.json({ Status: 0 })) as typeof fetch);
  assert.deepEqual(await empty("empty.example.com"), []);
});

test("a failed DNS lookup throws instead of reporting no address", async () => {
  for (const answer of [
    () => Response.json({ Status: 2 }),
    () => Response.json({ Status: 0 }, { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/dns-query" } }),
    () => new Response("not json"),
    () => Response.json([]),
  ])
    await assert.rejects(dohResolver((async () => answer()) as typeof fetch)("hooks.example.com"));
  await assert.rejects(
    dohResolver((async () => {
      throw new Error("network down");
    }) as typeof fetch)("hooks.example.com"),
  );
});
