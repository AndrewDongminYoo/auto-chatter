// @ts-check
// Text for received inbox messages that are not plain text (#20). Pure functions only: src/app/message-labels.test.ts
// runs this classic script in a node:vm context. The values come from GET /api/inbox and its messages route. The
// service never stores the media, so every attachment points the reader to the Instagram app.
const attachmentNames = {
  audio: "음성 메시지",
  ephemeral: "사라지는 미디어",
  file: "파일",
  ig_post: "게시물 공유",
  ig_reel: "릴스 공유",
  ig_story: "스토리 공유",
  image: "사진",
  reel: "릴스 공유",
  share: "게시물 공유",
  story: "스토리 공유",
  story_mention: "스토리 멘션",
  video: "동영상",
};

const deletedNotice = "보낸 사람이 취소한 메시지입니다.";
const unsupportedNotice = "Instagram에서만 볼 수 있는 메시지입니다.";
const openInInstagram = "Instagram 앱에서 확인하세요.";

/** @param {string} type */
function attachmentName(type) {
  return Object.hasOwn(attachmentNames, type) ? attachmentNames[/** @type {keyof typeof attachmentNames} */ (type)] : "첨부";
}

const titleLength = 40;

/**
 * A shared post's title is its whole caption, often several lines long (#20), so only its first non-blank line is
 * shown, with runs of whitespace collapsed and at most 40 code points followed by an ellipsis. The stored title is
 * not changed.
 * @param {string} title
 */
function shortTitle(title) {
  const line = (title.split(/\r?\n/).find((part) => part.trim()) ?? "").replace(/\s+/g, " ").trim();
  const points = [...line];
  return points.length > titleLength ? `${points.slice(0, titleLength).join("").trimEnd()}…` : line;
}

/** @param {{ type: string, title?: string }[] | null | undefined} attachments */
function attachmentSummary(attachments) {
  return (attachments ?? [])
    .map((item) => {
      const title = item.title ? shortTitle(item.title) : "";
      return title ? `${attachmentName(item.type)}(${title})` : attachmentName(item.type);
    })
    .join(" · ");
}

/**
 * The bubble text, an optional note under it, and the notice kind of one stored message. A notice ("attachment",
 * "unsupported" or "deleted") is service text, not words the sender wrote, so the screen draws it apart from a
 * message with an icon; null is the sender's own text.
 * @param {{ kind: string, text: string, attachments?: { type: string, title?: string }[] | null, deleted_at?: string | null }} message
 * @returns {{ body: string, note: string, notice: "attachment" | "unsupported" | "deleted" | null }}
 */
function messageContent(message) {
  if (message.deleted_at || message.kind === "deleted") return { body: deletedNotice, note: "", notice: "deleted" };
  if (message.kind === "unsupported") return { body: unsupportedNotice, note: "", notice: "unsupported" };
  const attachments = attachmentSummary(message.attachments);
  if (message.kind === "attachment") return { body: attachments || "첨부", note: openInInstagram, notice: "attachment" };
  return { body: message.text, note: attachments ? `첨부: ${attachments} · ${openInInstagram}` : "", notice: null };
}

/**
 * The list line for a conversation's newest message: its stored text, or a short notice when it has none.
 * @param {string | null | undefined} kind
 * @param {string | null | undefined} preview
 */
function messagePreview(kind, preview) {
  if (kind === "deleted") return "취소된 메시지";
  if (preview) return preview;
  if (kind === "attachment") return "첨부를 보냈습니다";
  if (kind === "unsupported") return "Instagram에서만 볼 수 있는 메시지";
  return "";
}
