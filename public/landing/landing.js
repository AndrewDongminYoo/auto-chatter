// Example conversation for the landing page. It runs only in the browser and sends nothing.
const dialog = document.getElementById("demo-dialog");
const chat = document.getElementById("demo-chat");
const controls = document.getElementById("demo-controls");

const followerReply = "요청하신 자료 링크입니다.";
const nonFollowerReply = "팔로우한 뒤 ‘확인’이라고 다시 답장해 주세요.";

function say(from, text, mine = false) {
  const bubble = document.createElement("div");
  bubble.className = mine ? "msg user" : "msg";
  const label = document.createElement("span");
  label.className = "msg-from";
  label.textContent = from;
  bubble.append(label, text);
  chat.append(bubble);
}

function offer(...choices) {
  controls.replaceChildren();
  for (const [text, next] of choices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "opt";
    button.textContent = text;
    button.addEventListener("click", next);
    controls.append(button);
  }
  controls.querySelector("button")?.focus();
}

function finish() {
  offer(["처음부터 다시 보기", start]);
}

function pressConfirm() {
  say("팔로워", "확인", true);
  offer(
    [
      "팔로우한 상태라면",
      () => {
        say("첫 DM에 이어서", followerReply);
        finish();
      },
    ],
    [
      "아직 팔로우하지 않았다면",
      () => {
        say("첫 DM에 이어서", nonFollowerReply);
        offer([
          "팔로우하고 다시 ‘확인’ 보내기",
          () => {
            say("팔로워", "확인", true);
            say("팔로우 확인 뒤", followerReply);
            finish();
          },
        ]);
      },
    ],
  );
}

function start() {
  chat.replaceChildren();
  say("게시물", "자료가 필요하면 댓글에 “자료”라고 남겨 주세요.");
  offer([
    "“자료” 댓글 남기기",
    () => {
      say("팔로워의 댓글", "자료", true);
      say("첫 DM", "관심 가져 주셔서 감사합니다. 계정을 팔로우한 뒤 아래 ‘확인’ 버튼을 눌러 주세요.");
      offer(["‘확인’ 버튼 누르기", pressConfirm]);
    },
  ]);
}

document.getElementById("demo-open").addEventListener("click", () => {
  start();
  dialog.showModal();
});
document.getElementById("demo-close").addEventListener("click", () => dialog.close());
