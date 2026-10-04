import assert from "node:assert/strict";

// Strict test-only parser for our all-quoted CSV; catches broken quoting/extra records without relying on split(',').
export function parseContactCsv(text: string): string[][] {
  if (text.startsWith("\ufeff")) text = text.slice(1);
  const rows: string[][] = [];
  let at = 0;
  while (at < text.length) {
    const row: string[] = [];
    while (true) {
      assert.equal(text[at++], '"');
      let value = "";
      while (true) {
        assert.ok(at < text.length, "unterminated quoted CSV cell");
        const char = text[at++];
        if (char !== '"') value += char;
        else if (text[at] === '"') {
          value += '"';
          at++;
        } else break;
      }
      row.push(value);
      if (text[at] === ",") {
        at++;
        continue;
      }
      assert.equal(text.slice(at, at + 2), "\r\n");
      at += 2;
      break;
    }
    rows.push(row);
  }
  return rows;
}
export function decodeContactScalar(value: string): string {
  return value.startsWith("'") ? value.slice(1) : value;
}
