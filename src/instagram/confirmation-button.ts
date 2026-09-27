import { PreSendVerificationError } from "./reply-worker.ts";

export function confirmationMessage(text: string, title?: string, replyId?: string) {
  if (!title) return { text };
  if (
    !text.trim() ||
    text.length > 640 ||
    !title.trim() ||
    title.length > 20 ||
    !replyId ||
    !/^[1-9][0-9]{0,18}$/.test(replyId)
  )
    throw new PreSendVerificationError("block", "invalid_confirmation_button");
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text,
        buttons: [{ type: "postback", title, payload: `auto-chatter:confirm:${replyId}` }],
      },
    },
  };
}
