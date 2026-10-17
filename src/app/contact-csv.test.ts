import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { CONTACT_CSV_HEADER, ContactCsvBuffer, contactCsvRow, contactCsvScalar } from "./contact-csv.ts";
import { decodeContactScalar, parseContactCsv } from "./contact-csv-test-utils.ts";
import { parseImportCsv, CONTACT_IMPORT_BYTES } from "./contact-csv-preview.ts";

function previewHarness(api: () => Promise<unknown>, channels: BroadcastChannel[], channelAvailable = true) {
  class Element extends EventTarget {
    textContent = "";
    value = "selected.csv";
    disabled = false;
    hidden = false;
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
  });
  controller.configure("admin");
  return {
    controller,
    get,
    window,
    submit: () => get("contacts-import-form").dispatchEvent(new Event("submit", { cancelable: true })),
  };
}
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
