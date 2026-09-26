const contact = '<a href="mailto:ydm2790@gmail.com">ydm2790@gmail.com</a>';

const privacy = `
<h1>개인정보처리방침</h1>
<p class="meta">auto-chatter · 시행일: 2026년 9월 26일</p>
<p>auto-chatter는 운영자가 연결한 Instagram 전문 계정의 댓글을 확인하고, 설정한 규칙에 따라 비공개 답장을 제공하는 서비스입니다. Meta 개발자 화면의 앱 이름은 AutoMessage - IG입니다. 이 방침은 이 서비스가 처리하는 개인정보에 적용됩니다.</p>
<h2>1. 운영자와 문의처</h2>
<p>운영자 및 개인정보 보호 담당자: 유동민(Dongmin Yu)<br>개인정보 문의 및 권리 행사: ${contact}</p>
<h2>2. 처리하는 정보와 목적</h2>
<ul>
  <li><strong>Instagram 연동 정보:</strong> 연결한 계정의 식별자와 연동용 인증정보를 계정 확인 및 Meta API 이용에 사용합니다.</li>
  <li><strong>댓글 정보:</strong> 댓글·게시물·댓글 작성자의 Instagram 식별자, 댓글 내용, 서비스 수신 시각을 댓글 처리와 규칙 적용에 사용합니다.</li>
  <li><strong>답장 처리 정보:</strong> 설정된 답장 내용, 처리 상태·시각, Meta 메시지 식별자, 오류·재시도 정보를 답장 제공, 중복 발송 방지 및 장애 대응에 사용합니다. 답장 기능이 활성화된 경우에 처리합니다.</li>
  <li><strong>문의 정보:</strong> 이메일 주소와 문의 내용을 개인정보 요청 확인과 답변에 사용합니다.</li>
  <li><strong>접속 정보:</strong> 웹사이트·웹훅 요청의 IP 주소와 HTTP 요청 정보가 호스팅 제공자에 의해 서비스 제공 및 보안을 위해 처리될 수 있습니다.</li>
</ul>
<p>Instagram 정보는 운영자가 승인한 Meta API와 웹훅을 통해 수신합니다. 웹훅에는 다른 정보가 포함될 수 있으나, 현재 서비스는 댓글 기능에 필요한 항목만 데이터베이스에 기록하며 수신 DM 내용을 데이터베이스에 보관하지 않습니다. 개인정보를 판매하거나 광고 프로파일링 또는 AI 모델 학습에 사용하지 않습니다.</p>
<h2>3. 보유기간과 삭제</h2>
<p>연동 운영 중 댓글 처리, 중복 발송 방지 및 장애 대응에 필요한 기간 동안 정보를 보관합니다. 연동 종료, 서비스 종료 또는 본인 확인을 거친 삭제 요청으로 보관 필요가 없어지면 운영자가 관련 정보를 수동 삭제합니다. 문의 기록은 요청 처리 완료 후 삭제합니다.</p>
<p>현재 자동 만료·자동 삭제 기능은 제공하지 않습니다. 삭제 요청을 받으면 필요한 범위에서 요청 권한을 확인한 뒤 운영 데이터베이스의 관련 기록과 더 이상 필요하지 않은 연동 인증정보를 삭제하고 결과를 이메일로 안내합니다. 법령상 보관이 필요한 경우에는 해당 근거와 기간을 안내하고 다른 목적으로 사용하지 않습니다.</p>
<h2>4. 처리 위탁과 외부 서비스</h2>
<ul>
  <li><strong>Cloudflare:</strong> 웹사이트·웹훅 서버 운영, 작업 전달 및 데이터베이스 연결 중개에 사용합니다. 요청 데이터가 Cloudflare의 글로벌 네트워크에서 처리됩니다. <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare 개인정보처리방침</a></li>
  <li><strong>Supabase:</strong> 댓글·연동·답장 처리 기록의 데이터베이스 호스팅에 사용합니다. 현재 운영 데이터베이스 리전은 대한민국 서울입니다. <a href="https://supabase.com/privacy">Supabase 개인정보처리방침</a></li>
  <li><strong>Google(Gmail):</strong> 개인정보 문의와 삭제 요청 이메일의 송수신에 사용합니다. 이메일 주소와 문의 내용이 처리됩니다. <a href="https://policies.google.com/privacy?hl=ko">Google 개인정보처리방침</a></li>
  <li><strong>Meta / Instagram:</strong> 연동 정보와 댓글을 수신하고, 답장 기능이 활성화되면 대상 식별자와 답장 내용을 API로 전달합니다. Instagram 서비스 자체의 처리는 <a href="https://privacycenter.instagram.com/policy/">Instagram 개인정보처리방침</a>도 적용됩니다.</li>
</ul>
<p>Cloudflare의 글로벌 요청 처리와 외부 제공자의 운영·지원 과정에는 국외 처리가 포함될 수 있습니다. 운영 데이터베이스가 서울에 있다는 사실이 모든 처리가 국내에서 이루어짐을 뜻하지는 않습니다. 제공자가 자체 관리하는 보안 로그·백업의 보유와 삭제는 해당 제공자의 정책 및 적용 계약에 따르며, 삭제 요청 시 관련 범위를 확인해 안내합니다.</p>
<h2>5. 이용자의 권리와 행사 방법</h2>
<p>본인 또는 적법한 대리인은 ${contact}로 개인정보 열람, 정정, 삭제 또는 처리정지를 요청할 수 있습니다. 관련 Instagram 계정명과 게시물·댓글 링크 등 대상 기록을 찾는 데 필요한 최소한의 정보를 알려 주세요. 본인 또는 대리인 권한 확인을 위해 추가 정보를 요청할 수 있습니다. 비밀번호, 앱 시크릿, 액세스 토큰은 보내지 마세요.</p>
<p>자세한 요청 절차는 <a href="/data-deletion">데이터 삭제 안내</a>에서 확인할 수 있습니다. auto-chatter에서 정보를 삭제해도 Instagram에 게시한 원본 댓글이나 이미 전달된 메시지가 자동으로 삭제되는 것은 아닙니다.</p>
<h2>6. 보호 조치와 쿠키</h2>
<p>암호화된 통신, 서버 인증정보 분리 보관, 데이터베이스 접근 권한 제한과 웹훅 서명 검증을 사용합니다. 이 안내 페이지에는 광고·분석 스크립트가 없고 애플리케이션 쿠키를 설정하지 않습니다.</p>
<h2>7. 방침 변경</h2>
<p>처리 목적, 항목, 보유 기준 또는 제공자가 변경되면 이 페이지의 내용과 시행일을 갱신합니다. 필요한 경우 적용 법령에 따른 별도 안내 또는 동의 절차를 진행합니다.</p>`;

const deletion = `
<h1>데이터 삭제 안내</h1>
<p class="meta">auto-chatter / AutoMessage - IG</p>
<p>서비스가 보관하는 본인의 Instagram 댓글 관련 기록이나 계정 연동 정보를 삭제하도록 요청할 수 있습니다. 삭제는 운영자가 확인한 뒤 수동으로 처리합니다.</p>
<ol>
  <li>${contact}로 제목을 <strong>auto-chatter 데이터 삭제 요청</strong>으로 하여 이메일을 보내 주세요.</li>
  <li>관련 Instagram 계정명과 게시물·댓글 링크, 삭제를 요청하는 범위를 알려 주세요. 비밀번호, 앱 시크릿, 액세스 토큰은 보내지 마세요.</li>
  <li>운영자 유동민(Dongmin Yu)이 대상 기록과 요청 권한을 확인합니다. 본인 또는 대리인 확인이 필요한 경우 추가 정보를 요청할 수 있습니다.</li>
  <li>확인이 완료되면 관련 댓글·답장 처리 기록을 삭제하고 결과를 이메일로 안내합니다. 계정 연동 전체의 종료를 요청하면 해당 연결의 추가 수신·발송을 중지하고 관련 기록과 더 이상 필요하지 않은 연동 인증정보를 삭제합니다.</li>
</ol>
<p>Instagram 원본 댓글과 이미 전달된 메시지는 이 서비스의 데이터 삭제와 별개입니다. 외부 제공자의 보안 로그·백업이나 법령상 보관이 필요한 기록은 해당 범위와 제한을 확인해 안내합니다.</p>
<p><a href="/privacy">개인정보처리방침 보기</a></p>`;

function document(title: string, content: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | auto-chatter</title>
<style>
body{margin:0;background:#f6f7f9;color:#202634;font:16px/1.8 system-ui,sans-serif;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:760px;margin:40px auto;padding:32px;background:#fff;border:1px solid #e0e4eb;border-radius:12px}
nav{display:flex;gap:20px;flex-wrap:wrap;font-size:14px}h1{font-size:30px;line-height:1.4}h2{font-size:21px;margin-top:32px}
a{color:#174ba3;text-underline-offset:3px}.meta{color:#596475}li{margin:10px 0}
@media(max-width:600px){main{margin:0;padding:24px;border:0;border-radius:0}h1{font-size:26px}ul,ol{padding-left:24px}}
</style>
</head>
<body><main><nav aria-label="문서 안내"><a href="/privacy">개인정보처리방침</a><a href="/data-deletion">데이터 삭제 안내</a></nav>${content}</main></body>
</html>`;
}

export function publicPage(request: Request): Response | null {
  const pathname = new URL(request.url).pathname;
  if (pathname !== "/privacy" && pathname !== "/data-deletion") return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const title = pathname === "/privacy" ? "개인정보처리방침" : "데이터 삭제 안내";
  return new Response(
    request.method === "HEAD" ? null : document(title, pathname === "/privacy" ? privacy : deletion),
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}
