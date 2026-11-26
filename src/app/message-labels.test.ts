import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { ATTACHMENT_TYPES } from "../instagram/message-events.ts";

type Message = { kind: string; text: string; attachments?: { type: string; title?: string }[] | null; deleted_at?: string | null };
interface MessageLabels {
  messageContent(message: Message): { body: string; note: string; notice: "attachment" | "unsupported" | "deleted" | null };
  messagePreview(kind: string | null | undefined, preview: string | null | undefined): string;
}

// public/app/message-labels.js is a classic browser script; its top-level functions become context globals.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../../public/app/message-labels.js", import.meta.url), "utf8"), context);
const labels = context as unknown as MessageLabels;
// Values built inside the vm context carry its prototypes, so they are compared through JSON.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("a typed DM keeps its text and names its attachments under it (#20)", () => {
  assert.deepEqual(plain(labels.messageContent({ kind: "text", text: "안녕하세요", attachments: null })), { body: "안녕하세요", note: "", notice: null });
  assert.deepEqual(plain(labels.messageContent({ kind: "text", text: "사진 보내요", attachments: [{ type: "image" }] })), { body: "사진 보내요", note: "첨부: 사진 · Instagram 앱에서 확인하세요.", notice: null });
  assert.deepEqual(plain(labels.messageContent({ kind: "postback", text: "자료 받기" })), { body: "자료 받기", note: "", notice: null });
});

test("an attachment-only DM shows its kinds and titles and points to Instagram", () => {
  assert.deepEqual(plain(labels.messageContent({ kind: "attachment", text: "", attachments: [{ type: "ig_reel", title: "<b>릴스</b>" }, { type: "video" }, { type: "other" }] })), {
    body: "릴스 공유(<b>릴스</b>) · 동영상 · 첨부",
    note: "Instagram 앱에서 확인하세요.",
    notice: "attachment",
  });
  // Every stored type has a name; an unknown or prototype key falls back to the generic name.
  for (const type of ATTACHMENT_TYPES) assert.notEqual(labels.messageContent({ kind: "attachment", text: "", attachments: [{ type }] }).body, "", type);
  for (const type of ["toString", "__proto__", "sticker"]) assert.equal(labels.messageContent({ kind: "attachment", text: "", attachments: [{ type }] }).body, "첨부");
});

test("an unsupported or withdrawn message shows a notice instead of any stored text", () => {
  assert.deepEqual(plain(labels.messageContent({ kind: "unsupported", text: "" })), { body: "Instagram에서만 볼 수 있는 메시지입니다.", note: "", notice: "unsupported" });
  for (const message of [
    { kind: "deleted", text: "", deleted_at: "2026-11-26T00:00:00Z" },
    { kind: "text", text: "", deleted_at: "2026-11-26T00:00:00Z" },
    { kind: "attachment", text: "", attachments: null, deleted_at: "2026-11-26T00:00:00Z" },
  ])
    assert.deepEqual(plain(labels.messageContent(message)), { body: "보낸 사람이 취소한 메시지입니다.", note: "", notice: "deleted" });
});

test("the list preview keeps stored text and names a message that has none", () => {
  assert.equal(labels.messagePreview("text", "안녕하세요"), "안녕하세요");
  assert.equal(labels.messagePreview("attachment", ""), "첨부를 보냈습니다");
  assert.equal(labels.messagePreview("unsupported", ""), "Instagram에서만 볼 수 있는 메시지");
  assert.equal(labels.messagePreview("deleted", ""), "취소된 메시지");
  assert.equal(labels.messagePreview(undefined, null), "");
});
