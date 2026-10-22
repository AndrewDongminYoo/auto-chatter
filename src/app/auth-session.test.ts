import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tabs(options: { locks?: boolean; storage?: boolean; readOnlyStorage?: boolean } = {}) {
  const source = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  const start = source.includes("function authSessionRevision(")
    ? source.indexOf("function authSessionRevision(")
    : source.indexOf("async function api(");
  const block = source.slice(start, source.indexOf("\nasync function action(", start));
  const values = new Map<string, string>();
  let tail = Promise.resolve();
  const locks = {
    request: (
      _name: string,
      options: { mode: string } | (() => Promise<unknown>),
      callback?: () => Promise<unknown>,
    ) => {
      const run = typeof options === "function" ? options : callback!;
      const result = tail.then(run);
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
  const requests: string[] = [];
  let principal: string | null = "A";
  const make = (fetcher?: (path: string) => Promise<Response>, failWrite = 0) => {
    let writes = 0;
    const context = vm.createContext({
      navigator: options.locks === false ? {} : { locks },
      localStorage: {
        getItem: (key: string) => {
          if (options.storage === false) throw new Error("Storage denied");
          return values.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          if (++writes === failWrite || options.storage === false || options.readOnlyStorage)
            throw new Error("Storage denied");
          values.set(key, value);
        },
      },
      crypto,
      workspaceGeneration: 0,
      refreshPromise: undefined,
      errors: {},
      invalidateContactSession: () => {
        context.workspaceGeneration++;
      },
      contactCsvPreview: { sessionChanged: () => {} },
      resetSession: () => {
        context.workspaceGeneration++;
      },
      fetch: async (path: string) => {
        requests.push(path);
        if (fetcher) return fetcher(path);
        principal = path.endsWith("login") ? "B" : path.endsWith("refresh") ? "A" : null;
        return Response.json({});
      },
    });
    vm.runInContext(block, context);
    return context;
  };
  return { make, requests, principal: () => principal };
}

test("cookie-changing auth requests wait for an earlier refresh across documents", async () => {
  for (const mutation of ["login", "logout", "reset-password"]) {
    const h = tabs();
    const started = deferred(),
      release = deferred();
    const a = h.make(async () => {
      started.resolve();
      await release.promise;
      return Response.json({});
    });
    const b = h.make();
    const refresh = a.api("/api/auth/refresh", "POST");
    await started.promise;
    const change = b.api(`/api/auth/${mutation}`, "POST", {});
    await setImmediate();
    try {
      assert.deepEqual(h.requests, ["/api/auth/refresh"], `${mutation} must wait for refresh response`);
    } finally {
      release.resolve();
      await Promise.allSettled([refresh, change]);
    }
    assert.equal(h.principal(), mutation === "login" ? "B" : null);
  }
});

test("a refresh queued behind another document's login is rejected without sending", async () => {
  const h = tabs();
  const started = deferred(),
    release = deferred();
  const b = h.make(async () => {
    started.resolve();
    await release.promise;
    return Response.json({});
  });
  const a = h.make();
  const login = b.api("/api/auth/login", "POST", {});
  await started.promise;
  const refresh = a.api("/api/auth/refresh", "POST");
  const rejected = assert.rejects(refresh, /로그인 상태가 변경/);
  release.resolve();
  await Promise.all([login, rejected]);
  assert.deepEqual(h.requests, ["/api/auth/login"]);
});

test("automatic refresh fails closed without cross-document locks or shared storage", async () => {
  for (const options of [{ locks: false }, { storage: false }, { readOnlyStorage: true }]) {
    const h = tabs(options);
    const tab = h.make(async () => Response.json({ error: "login_required" }, { status: 401 }));
    await assert.rejects(tab.api("/api/me"), /다시 로그인/);
    assert.deepEqual(h.requests, ["/api/me"]);
  }
});

test("an auth network failure releases the lock for a subsequent login", async () => {
  const h = tabs();
  const a = h.make(async () => {
    throw new TypeError("network failure");
  });
  const b = h.make();
  await assert.rejects(a.api("/api/auth/refresh", "POST"), /서버에 연결/);
  await b.api("/api/auth/login", "POST", {});
  assert.equal(h.principal(), "B");
});

test("a document that cannot publish its login intent does not change shared cookies", async () => {
  const h = tabs();
  const b = h.make(undefined, 1);
  await assert.rejects(b.api("/api/auth/login", "POST", {}), /저장소/);
  assert.deepEqual(h.requests, []);
  assert.equal(h.principal(), "A");
});

test("failed login completion publication keeps other documents' refresh blocked", async () => {
  const h = tabs();
  const b = h.make(undefined, 2);
  const a = h.make();
  await assert.rejects(b.api("/api/auth/login", "POST", {}), /저장소/);
  assert.equal(h.principal(), "B", "response cookie has already been applied");
  await assert.rejects(a.api("/api/auth/refresh", "POST"), /로그인 상태가 변경/);
  assert.deepEqual(h.requests, ["/api/auth/login"]);
});

test("explicit login remains available without Web Locks while refresh is disabled", async () => {
  const h = tabs({ locks: false });
  await h.make().api("/api/auth/login", "POST", {});
  assert.equal(h.principal(), "B");
});

test("a protected replay waits for a queued login and rejects its retired input", async () => {
  const h = tabs();
  const loginStarted = deferred(),
    releaseLogin = deferred();
  const b = h.make(async () => {
    loginStarted.resolve();
    await releaseLogin.promise;
    return Response.json({});
  });
  let login: Promise<unknown>;
  const a = h.make(async (path) => {
    if (path === "/api/auth/refresh") {
      login = b.api("/api/auth/login", "POST", {});
      return Response.json({});
    }
    return Response.json({ error: "login_required" }, { status: 401 });
  });
  const pending = a.api("/api/protected-write", "POST", { text: "A-only input" });
  const rejected = assert.rejects(pending, /로그인 상태가 변경/);
  await loginStarted.promise;
  await setImmediate();
  releaseLogin.resolve();
  await Promise.all([login!, rejected]);
  assert.equal(h.requests.filter((path) => path === "/api/protected-write").length, 1);
});

test("initial protected writes wait for account transitions and reject without sending", async () => {
  for (const mutation of ["login", "logout", "reset-password"]) {
    const h = tabs();
    const started = deferred(),
      release = deferred();
    const b = h.make(async () => {
      started.resolve();
      await release.promise;
      return Response.json({});
    });
    const a = h.make();
    const transition = b.api(`/api/auth/${mutation}`, "POST", {});
    await started.promise;
    const write = a.api("/api/protected-write", "POST", { text: "old account input" });
    const rejected = assert.rejects(write, /로그인 상태가 변경/);
    void rejected.catch(() => {});
    await setImmediate();
    try {
      assert.deepEqual(h.requests, [`/api/auth/${mutation}`], "initial write must wait for cookie transition");
    } finally {
      release.resolve();
      await Promise.allSettled([transition, rejected]);
    }
    await rejected;
  }
});

test("successful protected JSON and text bodies are discarded after an account transition", async () => {
  for (const asText of [false, true]) {
    const h = tabs();
    const started = deferred();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const a = h.make(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      });
      started.resolve();
      return new Response(stream);
    });
    const b = h.make();
    const read = a.api("/api/protected-profile", "GET", undefined, true, asText);
    const rejected = assert.rejects(read, /로그인 상태가 변경/);
    void rejected.catch(() => {});
    await started.promise;
    await b.api("/api/auth/login", "POST", {});
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ marker: "old account data" })));
    controller.close();
    await rejected;
  }
});

test("an old document cannot send new protected input after another document completes auth", async () => {
  for (const mutation of ["login", "logout", "reset-password"]) {
    const h = tabs();
    const a = h.make(),
      b = h.make();
    await b.api(`/api/auth/${mutation}`, "POST", {});
    await assert.rejects(a.api("/api/protected-write", "POST", { text: "old UI input" }), /로그인 상태가 변경/);
    assert.deepEqual(h.requests, [`/api/auth/${mutation}`]);
  }
});

test("a successful local login accepts its own new revision for protected requests", async () => {
  const h = tabs();
  const tab = h.make();
  await tab.api("/api/auth/login", "POST", {});
  await tab.api("/api/protected-profile");
  assert.deepEqual(h.requests, ["/api/auth/login", "/api/protected-profile"]);
});

test("explicit reload replaces a stale document instead of adopting the new session in its UI", async () => {
  const h = tabs();
  const a = h.make(),
    b = h.make();
  await b.api("/api/auth/login", "POST", {});
  const source = readFileSync(new URL("../../public/app/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function start(");
  const end = source.indexOf("\n}\n", start);
  let reloads = 0;
  a.location = {
    reload: () => {
      reloads++;
    },
  };
  vm.runInContext(source.slice(start, end + 3), a);
  await a.start();
  assert.equal(reloads, 1);
  await assert.rejects(a.api("/api/protected-write", "POST", {}), /로그인 상태가 변경/);
});

test("late protected error bodies do not expose another session's structured data", async () => {
  for (const status of [409, 422, 401]) {
    const h = tabs();
    const started = deferred();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const a = h.make(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      });
      started.resolve();
      return new Response(stream, { status });
    });
    const b = h.make();
    const pending = a.api("/api/protected-write", "POST", {}, false);
    const rejected = assert.rejects(pending, (error: unknown) => {
      assert.ok(error && typeof error === "object");
      assert.match((error as Error).message, /로그인 상태가 변경/);
      for (const key of ["segment", "reminder", "rows", "counts"]) assert.equal(Reflect.get(error, key), undefined);
      return true;
    });
    void rejected.catch(() => {});
    await started.promise;
    await b.api("/api/auth/login", "POST", {});
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          error: "version_conflict",
          segment: { name: "A-private" },
          reminder: { text: "A-private" },
          rows: [{ value: "A-private" }],
          counts: { total: 1 },
        }),
      ),
    );
    controller.close();
    await rejected;
  }
});

test("unchanged protected error responses retain their status and structured fields", async () => {
  for (const status of [401, 409, 422]) {
    const h = tabs();
    const tab = h.make(async () =>
      Response.json({ error: "version_conflict", segment: { name: "current session" } }, { status }),
    );
    await assert.rejects(tab.api("/api/protected-write", "POST", {}, false), (error: unknown) => {
      assert.ok(error && typeof error === "object");
      assert.equal(Reflect.get(error, "status"), status);
      assert.equal(Reflect.get(error, "segment").name, "current session");
      return true;
    });
  }
});
