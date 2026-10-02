import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { type Env } from "./index.ts";

const unavailableEnv = new Proxy({} as Env, {
  get() {
    throw new Error("Public pages must not access secrets or database bindings");
  },
});

for (const [pathname, title] of [
  ["/privacy", "개인정보처리방침"],
  ["/data-deletion", "데이터 삭제 안내"],
  ["/service", "서비스 이용약관"],
]) {
  test(`${pathname} serves a public HTML document without runtime credentials`, async () => {
    const response = await worker.fetch(
      new Request(`https://example.test${pathname}?token=never-reflect-this-value`),
      unavailableEnv,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html; charset=utf-8$/);
    assert.equal(response.headers.get("set-cookie"), null);
    const html = await response.text();
    assert.match(html, /<html lang="ko">/);
    assert.ok(html.includes(`<h1>${title}</h1>`));
    assert.match(html, /href="\/service"/);
    assert.match(html, /href="mailto:ydm2790@gmail.com"/);
    assert.doesNotMatch(html, /never-reflect-this-value/);
    if (pathname !== "/service") assert.ok(html.includes("수신 거부(동의 철회) 기록은"));
    assert.match(html, /설정 화면에서[^<]*직접 삭제/);
    if (pathname === "/data-deletion") assert.ok(html.includes("Instagram 계정 ID를 다시 입력"));
    if (pathname !== "/service")
      assert.ok(html.includes("작업 공간과 로그인 계정 전체의 삭제를 요청하면 수신 거부 기록과"));
    if (pathname === "/privacy") assert.ok(html.includes("'데이터 내보내기'에서 작업 공간의 기록을 JSON 파일로"));
    if (pathname === "/privacy")
      assert.ok(html.includes("작업 공간 멤버와 초대 정보:</strong> 작업 공간 소유자가 초대한 사람의 이메일 주소"));
    if (pathname === "/privacy")
      assert.ok(html.includes("초대 기록은 취소·만료·사용된 것을 포함해 작업 공간을 삭제할 때까지 보관합니다"));
    if (pathname === "/privacy") assert.ok(html.includes("시행일: 2026년 10월 2일"));
    if (pathname === "/privacy")
      assert.ok(
        html.includes("응답 DM의 본문을 그 사용자 정의 필드에 저장하며, 이 저장은 수신 인박스 설정과 관계없이"),
      );
    if (pathname === "/privacy") assert.ok(html.includes("플로가 저장하도록 지정한 응답을 제외하고 보관하지 않으며"));
    if (pathname === "/privacy")
      assert.ok(
        html.includes(
          "인박스를 끄면, 플로가 저장하도록 지정한 응답과 연결을 위해 임시로 보관하는 응답을 제외하고 이후 DM 본문 보관을 중지하며",
        ),
      );
    if (pathname === "/privacy")
      assert.ok(
        html.includes(
          "발송 기록을 마치기 전에 도착한 응답 DM은 그 메시지와 연결하기 위해 인박스 설정과 관계없이 임시로 보관할 수 있으며, 받은 지 15분이 지나면 연결에 쓰지 않고 그 뒤 처음 실행되는 정기 정리 작업에서 본문을 지웁니다",
        ),
      );
    if (pathname === "/privacy")
      assert.ok(html.includes("응답 DM의 본문을 받은 지 15분이 지난 뒤 정기 정리 작업에서 지우는 것 외에는"));
    if (pathname === "/privacy") assert.ok(!html.includes("최대 15분"));
    if (pathname === "/privacy") assert.ok(html.includes("그 브라우저 탭이 수락할 때까지 링크를 임시로 보관하며"));
    if (pathname === "/privacy")
      assert.ok(
        html.includes(
          "<p>계정 관리자가 플로에 외부 전송을 설정하면, 지정한 태그·사용자 정의 필드 값과 처리 식별자를 관리자가 지정한 외부 주소로 전송합니다. 댓글·DM 본문과 Instagram 식별자는 전송하지 않습니다.</p>",
        ),
      );
  });

  test(`${pathname} supports HEAD and rejects write methods`, async () => {
    const head = await worker.fetch(new Request(`https://example.test${pathname}`, { method: "HEAD" }), unavailableEnv);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const post = await worker.fetch(new Request(`https://example.test${pathname}`, { method: "POST" }), unavailableEnv);
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  });
}

test("public routes do not bypass webhook verification", async () => {
  const env = { INSTAGRAM_APP_SECRET: "test-secret", INSTAGRAM_VERIFY_TOKEN: "test-verify" } as Env;
  const response = await worker.fetch(
    new Request("https://example.test/webhooks/instagram", { method: "POST", body: "{}" }),
    env,
  );
  assert.equal(response.status, 403);
  assert.equal((await worker.fetch(new Request("https://example.test/unknown"), unavailableEnv)).status, 404);
});
