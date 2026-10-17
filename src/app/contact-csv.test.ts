import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { CONTACT_CSV_HEADER, ContactCsvBuffer, contactCsvRow, contactCsvScalar } from "./contact-csv.ts";
import { decodeContactScalar, parseContactCsv } from "./contact-csv-test-utils.ts";
import {
  parseImportCsv,
  CONTACT_IMPORT_BYTES,
  CONTACT_IMPORT_REQUEST_BYTES,
  CONTACT_IMPORT_ROWS,
} from "./contact-csv-preview.ts";
import { applyContactCsv, CONTACT_IMPORT_APPLY_REQUEST_BYTES, parseImportApplyRequest } from "./contact-csv-import.ts";
import { readJson } from "./auth.ts";
import { CONTACT_TAG_LENGTH, CONTACT_TAG_LIMIT } from "./contacts.ts";

function previewHarness(
  api: (path: string, method?: string, body?: unknown) => Promise<unknown>,
  channels: BroadcastChannel[],
  channelAvailable = true,
  reloadContacts?: () => unknown,
) {
  class Element extends EventTarget {
    textContent = "";
    value = "selected.csv";
    disabled = false;
    hidden = false;
    checked = false;
    children: Element[] = [];
    files = [{ size: 5, arrayBuffer: async () => new TextEncoder().encode("dummy").buffer }];
    append(...items: Element[]) {
      this.children.push(...items);
    }
    replaceChildren() {
      this.children = [];
    }
    setAttribute() {}
    removeAttribute() {}
  }
  const nodes = new Map<string, Element>();
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id)!;
  };
  const window = new EventTarget();
  const context = vm.createContext({
    document: { getElementById: get },
    window,
    TextDecoder,
    BroadcastChannel: channelAvailable
      ? class extends BroadcastChannel {
          constructor(name: string) {
            super(name);
            channels.push(this);
          }
        }
      : undefined,
  });
  vm.runInContext(readFileSync(new URL("../../public/app/contact-csv-preview.js", import.meta.url), "utf8"), context);
  const controller = context.createContactCsvPreview({
    api,
    node: (_tag: string, text = "") => {
      const element = new Element();
      element.textContent = text;
      return element;
    },
    reloadContacts,
  });
  controller.configure("admin");
  return {
    controller,
    get,
    window,
    submit: () => get("contacts-import-form").dispatchEvent(new Event("submit", { cancelable: true })),
    acknowledge: () => {
      get("contacts-import-acknowledge").checked = true;
      get("contacts-import-acknowledge").dispatchEvent(new Event("change"));
    },
    apply: () => get("contacts-import-apply-form").dispatchEvent(new Event("submit", { cancelable: true })),
  };
}
const appliedRows = {
  applied_at: "2026-10-17T00:01:00Z",
  counts: { total: 1, applied: 1, unchanged: 0 },
  rows: [
    { row: 1, status: "applied", connection_id: "dummy", sender_id: "private-A", previous_tags: ["private"], tags: [] },
  ],
};
const previewRows = {
  checked_at: "2026-10-17T00:00:00Z",
  counts: { total: 1, changed: 1, unchanged: 0, invalid: 0, duplicate: 0, not_found: 0 },
  rows: [
    {
      row: 1,
      status: "changed",
      connection_id: "dummy",
      sender_id: "private-A",
      current_tags: ["private"],
      proposed_tags: [],
    },
  ],
};
async function waitForPreview(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("CSV preview clears another tab's file and rows when the authenticated session changes", async () => {
  const channels: BroadcastChannel[] = [];
  try {
    const a = previewHarness(async () => previewRows, channels);
    const b = previewHarness(async () => previewRows, channels);
    a.submit();
    await waitForPreview(() => a.get("contacts-import-rows").children.length === 1);
    assert.equal(a.get("contacts-import-rows").children.length, 1, "fixture must render private data first");
    const sender = new BroadcastChannel("auto-chatter-session");
    channels.push(sender);
    sender.postMessage("changed");
    await waitForPreview(() => a.get("contacts-import-rows").children.length === 0);
    assert.equal(
      a.get("contacts-import-rows").children.length,
      0,
      "session change must erase the previous account's rows",
    );
    assert.equal(a.get("contacts-import-file").value, "");
    assert.equal(a.get("contacts-import").hidden, true);
    b.controller.configure("admin");
    a.controller.configure("admin");
    a.submit();
    await waitForPreview(() => a.get("contacts-import-rows").children.length === 1);
    b.controller.sessionChanged();
    await waitForPreview(() => a.get("contacts-import-rows").children.length === 0);
    assert.equal(a.get("contacts-import-rows").children.length, 0);
  } finally {
    for (const channel of channels) channel.close();
  }
});

test("CSV preview refuses to read a file when cross-tab session notifications are unavailable", async () => {
  let calls = 0;
  const h = previewHarness(
    async () => {
      calls++;
      return previewRows;
    },
    [],
    false,
  );
  h.submit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(h.get("contacts-import").hidden, true);
  assert.equal(h.get("contacts-import-check").disabled, true);
});

test("CSV preview ignores an old response after a session signal and a restored page", async () => {
  const channels: BroadcastChannel[] = [];
  try {
    let complete!: (value: unknown) => void;
    const a = previewHarness(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      channels,
    );
    a.submit();
    await waitForPreview(() => complete !== undefined);
    const sender = new BroadcastChannel("auto-chatter-session");
    channels.push(sender);
    sender.postMessage("changed");
    await waitForPreview(() => a.get("contacts-import").hidden);
    complete(previewRows);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(a.get("contacts-import-rows").children.length, 0);
    assert.equal(a.get("contacts-import-status").textContent, "");
    a.controller.configure("admin");
    a.submit();
    await new Promise((resolve) => setImmediate(resolve));
    complete(previewRows);
    await waitForPreview(() => a.get("contacts-import-rows").children.length === 1);
    assert.equal(a.get("contacts-import-rows").children.length, 1);
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    a.window.dispatchEvent(restored);
    assert.equal(a.get("contacts-import-rows").children.length, 0);
    assert.equal(a.get("contacts-import-file").value, "");
  } finally {
    for (const channel of channels) channel.close();
  }
});

test("CSV apply control is offered only for a clean preview with changes and withdrawn by every invalidation", async () => {
  const channels: BroadcastChannel[] = [];
  try {
    let preview: unknown = previewRows;
    const calls: string[] = [];
    const h = previewHarness(async (path) => {
      calls.push(path);
      return preview;
    }, channels);
    const applyForm = h.get("contacts-import-apply-form");
    assert.equal(applyForm.hidden, true);
    h.submit();
    await waitForPreview(() => applyForm.hidden === false);
    assert.match(h.get("contacts-import-acknowledge-text").textContent, /^1행의 태그를 파일의 값으로 교체합니다/);
    assert.equal(h.get("contacts-import-apply").disabled, true, "the apply button needs the acknowledgement");
    h.acknowledge();
    assert.equal(h.get("contacts-import-apply").disabled, false);
    const invalidations = [
      () => h.get("contacts-import-file").dispatchEvent(new Event("change")),
      () => h.controller.invalidate(),
      () => h.controller.reset(),
      () => {
        const restored = new Event("pageshow");
        Object.defineProperty(restored, "persisted", { value: true });
        h.window.dispatchEvent(restored);
      },
      () => h.controller.sessionChanged(),
    ];
    for (const invalidate of invalidations) {
      h.controller.configure("admin");
      h.submit();
      await waitForPreview(() => applyForm.hidden === false);
      h.acknowledge();
      invalidate();
      assert.equal(applyForm.hidden, true);
      assert.equal(h.get("contacts-import-acknowledge").checked, false);
      assert.equal(h.get("contacts-import-apply").disabled, true);
      calls.length = 0;
      h.apply();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, [], "an invalidated preview must not send an apply");
    }
    h.controller.configure("admin");
    for (const dirty of [
      {
        ...previewRows,
        counts: { ...previewRows.counts, changed: 0, unchanged: 1 },
        rows: [{ ...previewRows.rows[0], status: "unchanged" }],
      },
      {
        ...previewRows,
        counts: { ...previewRows.counts, total: 2, not_found: 1 },
        rows: [...previewRows.rows, { row: 2, status: "not_found" }],
      },
    ]) {
      preview = dirty;
      h.submit();
      await waitForPreview(() => h.get("contacts-import-rows").children.length > 0);
      assert.equal(applyForm.hidden, true, "no apply without changes or with a row to fix");
    }
  } finally {
    for (const channel of channels) channel.close();
  }
});

test("CSV apply sends the held CSV and checked rows then renders the applied rows and reloads contacts", async () => {
  const channels: BroadcastChannel[] = [];
  try {
    const calls: { path: string; body: unknown }[] = [];
    let reloads = 0;
    const h = previewHarness(
      async (path, _method, body) => {
        calls.push({ path, body });
        return path === "/api/contacts/import" ? appliedRows : previewRows;
      },
      channels,
      true,
      () => reloads++,
    );
    h.get("contacts-import-file").value = "selected.csv";
    h.submit();
    await waitForPreview(() => h.get("contacts-import-apply-form").hidden === false);
    h.acknowledge();
    h.apply();
    await waitForPreview(() => reloads === 1);
    assert.equal(reloads, 1, "an applied import reloads the contacts list once");
    // The body is built inside the vm context, so compare values rather than prototypes.
    assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), {
      path: "/api/contacts/import",
      body: { csv: "dummy", expected: [{ row: 1, current_tags: ["private"] }] },
    });
    assert.equal(h.get("contacts-import-rows").children.length, 1);
    assert.match(h.get("contacts-import-rows").children[0]!.textContent, /^1행 · 태그 교체 완료/);
    assert.match(h.get("contacts-import-status").textContent, /적용 1 · 변경 없음 0.*2026-10-17T00:01:00Z/);
    assert.equal(h.get("contacts-import-apply-form").hidden, true, "a new check is required before another apply");
    assert.equal(h.get("contacts-import-file").value, "selected.csv", "the file stays selected");
    assert.equal(h.get("contacts-import-check").disabled, false);
    assert.doesNotMatch(h.get("contacts-import-status").textContent, /새로 고치지 않았습니다/);
  } finally {
    for (const channel of channels) channel.close();
  }
});

test("CSV apply says so when the host skipped the contacts reload over an unsaved draft", async () => {
  const channels: BroadcastChannel[] = [];
  try {
    const h = previewHarness(
      async (path) => (path === "/api/contacts/import" ? appliedRows : previewRows),
      channels,
      true,
      () => false,
    );
    h.submit();
    await waitForPreview(() => h.get("contacts-import-apply-form").hidden === false);
    h.acknowledge();
    h.apply();
    await waitForPreview(() => h.get("contacts-import-status").textContent.startsWith("태그 교체 완료"));
    assert.match(
      h.get("contacts-import-status").textContent,
      /적용 1 · 변경 없음 0.*편집 중인 연락처가 있어 목록은 새로 고치지 않았습니다/,
    );
    assert.equal(h.get("contacts-import-rows").children.length, 1, "the applied rows are still listed");
  } finally {
    for (const channel of channels) channel.close();
  }
});

test("CSV apply ignores a late response and shows the server's fresh rows on a rejected or stale file", async () => {
  const channels: BroadcastChannel[] = [];
  try {
    let complete!: (value: unknown) => void;
    let fail!: (error: unknown) => void;
    let reloads = 0;
    const h = previewHarness(
      (path) =>
        path === "/api/contacts/import"
          ? new Promise((resolve, reject) => {
              complete = resolve;
              fail = reject;
            })
          : Promise.resolve(previewRows),
      channels,
      true,
      () => reloads++,
    );
    h.submit();
    await waitForPreview(() => h.get("contacts-import-apply-form").hidden === false);
    h.acknowledge();
    h.apply();
    await waitForPreview(() => complete !== undefined);
    assert.equal(h.get("contacts-import-apply").disabled, true);
    h.get("contacts-import-file").dispatchEvent(new Event("change"));
    complete(appliedRows);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.get("contacts-import-rows").children.length, 0);
    assert.equal(h.get("contacts-import-status").textContent, "");
    assert.equal(reloads, 0);
    for (const code of ["contact_import_rejected", "contact_import_stale"]) {
      h.submit();
      await waitForPreview(() => h.get("contacts-import-apply-form").hidden === false);
      h.acknowledge();
      h.apply();
      await waitForPreview(() => h.get("contacts-import-apply").disabled);
      const error = Object.assign(new Error(`${code} message`), {
        code,
        status: code === "contact_import_stale" ? 409 : 422,
        checked_at: "2026-10-17T00:02:00Z",
        counts: { total: 1, changed: 0, unchanged: 0, invalid: 0, duplicate: 0, not_found: 1 },
        rows: [{ row: 1, status: "not_found" }],
      });
      fail(error);
      await waitForPreview(() => h.get("contacts-import-status").textContent.startsWith(code));
      assert.equal(h.get("contacts-import-rows").children.length, 1);
      assert.match(h.get("contacts-import-rows").children[0]!.textContent, /조회할 수 없는 연락처/);
      assert.match(h.get("contacts-import-status").textContent, new RegExp(`^${code} message .*조회 불가 1`));
      assert.equal(h.get("contacts-import-apply-form").hidden, true);
      assert.equal(reloads, 0);
    }
  } finally {
    for (const channel of channels) channel.close();
  }
});

test("CSV apply request shape is checked with the derived body limit and the shared parser", async () => {
  const valid = { csv: "x", expected: [{ row: 1, current_tags: ["b", "a"] }] };
  assert.deepEqual([...parseImportApplyRequest(valid).expected], [[1, ["a", "b"]]]);
  assert.deepEqual([...parseImportApplyRequest({ csv: "x", expected: [] }).expected], []);
  for (const input of [
    { csv: "x" },
    { ...valid, apply: true },
    { csv: 1, expected: [] },
    { csv: "x", expected: {} },
    { csv: "x", expected: [{ row: "1", current_tags: [] }] },
    { csv: "x", expected: [{ row: 1.5, current_tags: [] }] },
    { csv: "x", expected: [{ row: 0, current_tags: [] }] },
    { csv: "x", expected: [{ row: CONTACT_IMPORT_ROWS + 1, current_tags: [] }] },
    {
      csv: "x",
      expected: [
        { row: 1, current_tags: [] },
        { row: 1, current_tags: [] },
      ],
    },
    { csv: "x", expected: [{ row: 1, current_tags: ["a", 2] }] },
    { csv: "x", expected: [{ row: 1, current_tags: "a" }] },
    { csv: "x", expected: [{ row: 1, current_tags: Array.from({ length: CONTACT_TAG_LIMIT + 1 }, () => "t") }] },
    { csv: "x", expected: [{ row: 1, current_tags: [], extra: 1 }] },
    { csv: "x", expected: [{ row: 1 }] },
    {
      csv: "x",
      expected: Array.from({ length: CONTACT_IMPORT_ROWS + 1 }, (_, i) => ({ row: i + 1, current_tags: [] })),
    },
  ])
    assert.throws(() => parseImportApplyRequest(input), { status: 400, message: "invalid_contact_import_request" });
  // The limit admits a maximal CSV plus 500 fully escaped expected rows, and is derived, not typed in.
  assert.equal(
    CONTACT_IMPORT_APPLY_REQUEST_BYTES,
    CONTACT_IMPORT_REQUEST_BYTES + 32 + CONTACT_IMPORT_ROWS * (32 + CONTACT_TAG_LIMIT * (6 * CONTACT_TAG_LENGTH + 3)),
  );
  const escaped = "\u0001".repeat(CONTACT_TAG_LENGTH);
  const maximal = JSON.stringify({
    csv: "\u0001".repeat(CONTACT_IMPORT_BYTES),
    expected: Array.from({ length: CONTACT_IMPORT_ROWS }, (_, i) => ({
      row: i + 1,
      current_tags: Array.from({ length: CONTACT_TAG_LIMIT }, () => escaped),
    })),
  });
  assert.ok(Buffer.byteLength(maximal) > CONTACT_IMPORT_REQUEST_BYTES, "the preview limit alone must not fit it");
  const request = (body: string) =>
    new Request("https://app.test/api/contacts/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  assert.equal(
    ((await readJson(request(maximal), CONTACT_IMPORT_APPLY_REQUEST_BYTES)) as { csv: string }).csv.length,
    CONTACT_IMPORT_BYTES,
  );
  await assert.rejects(
    readJson(request("x".repeat(CONTACT_IMPORT_APPLY_REQUEST_BYTES + 1)), CONTACT_IMPORT_APPLY_REQUEST_BYTES),
    {
      status: 413,
      message: "request_too_large",
    },
  );
  // A broken CSV is refused by the shared parser before any connection is taken.
  let connected = 0;
  const pool = {
    query: async () => ({ rows: [{ workspace_id: "11111111-1111-4111-8111-111111111111", role: "owner" }] }),
    connect: async () => {
      connected++;
      throw new Error("must not connect");
    },
  } as unknown as import("pg").Pool;
  const user = { id: "user", email: "a@example.test" };
  await assert.rejects(applyContactCsv(pool, user, { csv: '"broken', expected: [] }), {
    status: 400,
    message: "invalid_contact_import_format",
  });
  await assert.rejects(applyContactCsv(pool, user, { csv: "x".repeat(CONTACT_IMPORT_BYTES + 1), expected: [] }), {
    status: 422,
    message: "contact_import_too_large",
  });
  await assert.rejects(
    applyContactCsv(pool, user, { csv: contactCsvRow(CONTACT_CSV_HEADER), expected: [{ row: 1, current_tags: [] }] }),
    { status: 400, message: "invalid_contact_import_request" },
  );
  assert.equal(connected, 0);
});

test("CSV import parser counts quoted records and preserves escapes Unicode and identifier text", () => {
  const rows = [
    Array.from({ length: 14 }, () => ""),
    Array.from({ length: 14 }, (_, i) => (i === 6 ? "'0000123" : i === 7 ? '한글\r\n"quoted", 😀' : "x")),
  ];
  const text = "\ufeff" + contactCsvRow(CONTACT_CSV_HEADER) + rows.map(contactCsvRow).join("");
  assert.deepEqual(parseImportCsv(text), rows);
  assert.deepEqual(parseImportCsv(CONTACT_CSV_HEADER.join(",") + "\n"), []);
  assert.deepEqual(parseImportCsv(text.slice(0, -2)), rows);
  assert.deepEqual(parseImportCsv(contactCsvRow(CONTACT_CSV_HEADER) + "a,b,"), [["a", "b", ""]]);
  for (const value of ['"unclosed', 'bad"quote', '"closed"tail', "a\rb", "\0", "\ud800"])
    assert.throws(() => parseImportCsv(contactCsvRow(CONTACT_CSV_HEADER) + value), {
      status: 400,
      message: "invalid_contact_import_format",
    });
  assert.throws(() => parseImportCsv("\ufeff\ufeff" + contactCsvRow(CONTACT_CSV_HEADER)), { status: 400 });
  assert.throws(() => parseImportCsv(contactCsvRow([...CONTACT_CSV_HEADER].reverse())), { status: 400 });
});

test("CSV import parser accepts exact byte and record caps and rejects one over without truncation", () => {
  const header = contactCsvRow(CONTACT_CSV_HEADER);
  const exact = header + '"' + "x".repeat(CONTACT_IMPORT_BYTES - Buffer.byteLength(header) - 2) + '"';
  assert.equal(Buffer.byteLength(exact), CONTACT_IMPORT_BYTES);
  assert.equal(parseImportCsv(exact).length, 1);
  assert.throws(() => parseImportCsv(exact + "x"), { status: 422, message: "contact_import_too_large" });
  const rows = header + contactCsvRow(["row"]).repeat(500);
  assert.equal(parseImportCsv(rows).length, 500);
  assert.throws(() => parseImportCsv(rows + contactCsvRow(["extra"])), {
    status: 422,
    message: "contact_import_too_large",
  });
});

test("CSV v1 has one fixed header and every cell is quoted with doubled quotes and CRLF records", () => {
  assert.deepEqual(CONTACT_CSV_HEADER, [
    "format_version",
    "exported_at",
    "workspace_id",
    "channel",
    "identity_kind",
    "connection_id",
    "sender_id",
    "connection_username",
    "first_comment_recorded_at",
    "last_comment_recorded_at",
    "comment_count",
    "automation_paused",
    "tags_json",
    "fields_json",
  ]);
  const values = ["comma,a", '";=SUM(1,2)', "semi;colon", "line\r\nnext", "한글\ttext", "<script>bad()</script>"];
  assert.equal(contactCsvRow(["a", '"b']), '"a","""b"\r\n');
  assert.deepEqual(parseContactCsv(contactCsvRow(values)), [values]);
});

test("IDs always get a reversible text marker, retaining leading zeroes and values above 2^53", () => {
  for (const value of ["0000123", "900719925474099312345678901234567890", "sender-1", "'original", "=formula"]) {
    assert.equal(contactCsvScalar(value, true), "'" + value);
    assert.equal(decodeContactScalar(contactCsvScalar(value, true)), value);
  }
});

test("account text markers cover hidden and full-width formula prefixes while safe names stay unchanged", () => {
  for (const prefix of ["=", "+", "-", "@", "＝", "＋", "－", "＠"]) {
    for (const leading of ["", " ", "\t", "\r\n", "\ufeff", "\u200b\u0001 ", "\u00a0"]) {
      const value = `${leading}${prefix}SUM(1,2)`;
      assert.equal(contactCsvScalar(value), "'" + value);
      assert.equal(decodeContactScalar(contactCsvScalar(value)), value);
    }
  }
  for (const value of ["\tname", " \rname", "\nname", "'name", "''name", ""]) {
    assert.equal(contactCsvScalar(value), "'" + value);
    assert.equal(decodeContactScalar(contactCsvScalar(value)), value);
  }
  assert.equal(contactCsvScalar(null), "");
  for (const value of ["shop", "한글상점", " normal-name", 'safe,\";=next', "name\nline"])
    assert.equal(contactCsvScalar(value), value);
});

test("JSON cells retain typed zero false empty strings and quoted injection-like nested values", () => {
  const tags = ["=SUM(1,2)", '\r\n";=next', "한글"];
  const fields = {
    a: { name: "=name", type: "number", value: 0 },
    b: { name: "flag", type: "boolean", value: false },
    c: { name: "empty", type: "text", value: "" },
    d: { name: "date", type: "date", value: "2026-10-04" },
  };
  const cells = parseContactCsv(contactCsvRow([JSON.stringify(tags), JSON.stringify(fields)]))[0]!;
  assert.equal(cells.length, 2);
  assert.deepEqual(JSON.parse(cells[0]!), tags);
  assert.deepEqual(JSON.parse(cells[1]!), fields);
});

test("buffer counts exact UTF-8 BOM quoting and row bytes, allows the cap, rejects one byte over", () => {
  const header = "\ufeff" + contactCsvRow(CONTACT_CSV_HEADER);
  const cells = ["한글", '"\r\n😀'];
  const full = header + contactCsvRow(cells);
  const bytes = Buffer.byteLength(full, "utf8");
  const exact = new ContactCsvBuffer(1, bytes);
  exact.add(cells);
  assert.equal(exact.finish(), full);
  const short = new ContactCsvBuffer(1, bytes - 1);
  assert.throws(() => short.add(cells), { status: 422, message: "contact_export_too_large" });
  assert.equal(short.finish(), header);
  assert.throws(() => new ContactCsvBuffer(1, Buffer.byteLength(header) - 1), {
    status: 422,
    message: "contact_export_too_large",
  });
});

test("buffer includes every admitted row and refuses excess rows instead of returning a truncated success", () => {
  const buffer = new ContactCsvBuffer(1, 1024 * 1024);
  buffer.add(["first"]);
  assert.throws(() => buffer.add(["second"]), { status: 422, message: "contact_export_too_large" });
  const empty = new ContactCsvBuffer(0, 1024 * 1024);
  assert.equal(empty.finish(), "\ufeff" + contactCsvRow(CONTACT_CSV_HEADER));
});

test("connection acquisition deadline releases a late client instead of leaking it", async () => {
  const { exportContactCsv } = await import("./contact-csv.ts");
  let giveClient!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    giveClient = resolve;
  });
  const released: unknown[] = [];
  const pool = { connect: () => pending } as unknown as import("pg").Pool;
  await assert.rejects(exportContactCsv(pool, { id: "user", email: "a@example.test" }, { timeoutMs: 5 }), {
    status: 503,
    message: "contact_export_timeout",
  });
  giveClient({ release: (destroy: unknown) => released.push(destroy) });
  await pending;
  await Promise.resolve();
  assert.deepEqual(released, [true]);
});

test("an acquisition rejection after the absolute budget reports export timeout", async (context) => {
  const { exportContactCsv } = await import("./contact-csv.ts");
  let elapsed = 0;
  context.mock.method(performance, "now", () => elapsed);
  const pool = {
    connect: () => {
      elapsed = 20;
      return Promise.reject(new Error("connection timeout"));
    },
  } as unknown as import("pg").Pool;
  await assert.rejects(exportContactCsv(pool, { id: "user", email: "a@example.test" }, { timeoutMs: 10 }), {
    status: 503,
    message: "contact_export_timeout",
  });
});
