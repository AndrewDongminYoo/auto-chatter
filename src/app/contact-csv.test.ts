import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTACT_CSV_HEADER, ContactCsvBuffer, contactCsvRow, contactCsvScalar } from "./contact-csv.ts";
import { decodeContactScalar, parseContactCsv } from "./contact-csv-test-utils.ts";

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
