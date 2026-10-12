import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInstagramSubscription, classifySubscribedApps } from "./instagram-subscription-check.ts";
import { sealSecret } from "./secrets.ts";

const key = Buffer.alloc(32, 3).toString("base64");
const workspaceId = "11111111-1111-4111-8111-111111111111";
const connection = {
  workspaceId,
  accountId: "123",
  encryptedToken: sealSecret("stored-token", key, `${workspaceId}:123`),
};
const allFields = { data: [{ id: "app", subscribed_fields: ["comments", "messages", "messaging_postbacks"] }] };

// Answers me and subscribed_apps from the given responses and records the paths it was asked for.
function graph(me: () => Response | Promise<Response>, subscriptions?: () => Response | Promise<Response>) {
  const paths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "graph.instagram.com");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer stored-token");
    assert.equal(init?.redirect, "manual");
    paths.push(url.pathname);
    if (url.pathname === "/v26.0/me") return me();
    assert.equal(url.pathname, "/v26.0/123/subscribed_apps");
    return subscriptions ? subscriptions() : Response.json(allFields);
  }) as typeof fetch;
  return { fetchImpl, paths };
}

test("subscribed_apps is present only when one entry holds every required field, and missing only without a next page", () => {
  assert.equal(classifySubscribedApps(allFields), "fields_present");
  assert.equal(
    classifySubscribedApps({
      data: [
        { id: "a", subscribed_fields: ["comments"] },
        { id: "b", subscribed_fields: ["messaging_postbacks", "messages", "comments", "mentions"] },
      ],
    }),
    "fields_present",
  );
  // The fields spread over two entries are not one subscription.
  assert.equal(
    classifySubscribedApps({
      data: [
        { id: "a", subscribed_fields: ["comments", "messages"] },
        { id: "b", subscribed_fields: ["messaging_postbacks"] },
      ],
    }),
    "fields_missing",
  );
  assert.equal(classifySubscribedApps({ data: [] }), "fields_missing");
  assert.equal(
    classifySubscribedApps({
      data: [{ id: "a", subscribed_fields: ["comments"] }],
      paging: { next: "https://graph.instagram.com/next" },
    }),
    "unverified",
  );
  for (const shape of [null, [], "text", {}, { data: "x" }, { data: [{ id: "a" }] }, { data: [null] }])
    assert.equal(classifySubscribedApps(shape), "unverified", JSON.stringify(shape));
});

test("the shared check reads me first and subscribed_apps only for the stored account", async () => {
  const cases: Array<[string, ReturnType<typeof graph>, string, boolean, number]> = [
    ["present", graph(() => Response.json({ user_id: "123" })), "fields_present", true, 2],
    ["present in data", graph(() => Response.json({ data: [{ user_id: "123" }] })), "fields_present", true, 2],
    [
      "missing",
      graph(
        () => Response.json({ user_id: "123" }),
        () => Response.json({ data: [{ id: "a", subscribed_fields: ["comments", "messages"] }] }),
      ),
      "fields_missing",
      true,
      2,
    ],
    [
      "missing with next page",
      graph(
        () => Response.json({ user_id: "123" }),
        () => Response.json({ data: [], paging: { next: "https://graph.instagram.com/next" } }),
      ),
      "unverified",
      true,
      2,
    ],
    ["mismatch", graph(() => Response.json({ user_id: "999" })), "account_mismatch", false, 1],
    ["me 401", graph(() => new Response("denied", { status: 401 })), "token_rejected", false, 1],
    ["me code 190", graph(() => Response.json({ error: { code: 190 } }, { status: 400 })), "token_rejected", false, 1],
    ["me code 200", graph(() => Response.json({ error: { code: 200 } }, { status: 403 })), "token_rejected", false, 1],
    [
      "subscribed_apps code 10",
      graph(
        () => Response.json({ user_id: "123" }),
        () => Response.json({ error: { code: 10 } }, { status: 403 }),
      ),
      "token_rejected",
      true,
      2,
    ],
    ["me throttled", graph(() => Response.json({ error: { code: 4 } }, { status: 400 })), "unverified", false, 1],
    ["me 429", graph(() => new Response("busy", { status: 429 })), "unverified", false, 1],
    ["me 5xx", graph(() => Response.json({ error: { code: 190 } }, { status: 500 })), "unverified", false, 1],
    ["me network", graph(() => Promise.reject(new TypeError("fetch failed"))), "unverified", false, 1],
    ["me shape", graph(() => Response.json({ id: "123" })), "unverified", false, 1],
    [
      "me redirect",
      graph(() => new Response(null, { status: 302, headers: { Location: "https://other.test" } })),
      "unverified",
      false,
      1,
    ],
    [
      "subscribed_apps 5xx",
      graph(
        () => Response.json({ user_id: "123" }),
        () => new Response("down", { status: 503 }),
      ),
      "unverified",
      true,
      2,
    ],
    [
      "subscribed_apps timeout",
      graph(
        () => Response.json({ user_id: "123" }),
        () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      ),
      "unverified",
      true,
      2,
    ],
  ];
  for (const [label, provider, status, identityAccepted, calls] of cases) {
    assert.deepEqual(
      await checkInstagramSubscription(connection, key, "v26.0", provider.fetchImpl),
      { status, identityAccepted },
      label,
    );
    assert.equal(provider.paths.length, calls, label);
  }
});

test("a token that does not decrypt makes no Meta request", async () => {
  const provider = graph(() => Response.json({ user_id: "123" }));
  for (const changed of [
    { ...connection, accountId: "999" },
    { ...connection, encryptedToken: "not-a-token" },
  ])
    assert.deepEqual(await checkInstagramSubscription(changed, key, "v26.0", provider.fetchImpl), {
      status: "undecryptable",
      identityAccepted: false,
    });
  assert.deepEqual(
    await checkInstagramSubscription(connection, Buffer.alloc(32, 4).toString("base64"), "v26.0", provider.fetchImpl),
    { status: "undecryptable", identityAccepted: false },
  );
  assert.deepEqual(provider.paths, []);
});
