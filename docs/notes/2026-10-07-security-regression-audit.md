# 보안 회귀 점검 1차 (#62)

## 범위

[#62](https://github.com/AndrewDongminYoo/auto-chatter/issues/62)의 첫 번째 완료 조건에 적힌 공격 시나리오 일곱 가지를 2026-10-07 `main` `413a95d` 기준 코드와 자동 테스트에 대응시켰습니다.
각 시나리오의 방어 위치, 그 공격을 실제로 시도하는 테스트, 그리고 테스트가 없던 변형을 기록하고, 빠진 변형에는 회귀 테스트를 추가했습니다.
가입·연결·API·발송·AI 자원의 남용 제한과 관리자·서버 권한, 비밀 노출 점검은 두 번째 PR에서 다룹니다.
기능별 불변 조건은 [CLAUDE.md](../../CLAUDE.md)가 소유하므로 여기서 다시 적지 않습니다.

이번에 추가한 테스트는 모두 기존 방어를 지키는 회귀 테스트이므로, 처음부터 통과합니다.
그래서 테스트마다 방어 코드를 일시적으로 제거하거나 결함을 심어 실패를 한 번 확인한 뒤 원래 코드로 되돌렸습니다. 되돌린 뒤 제품 코드의 diff는 없습니다.

## 시나리오별 결과

### 1. 소유권·역할 우회

`workspaceFor`(`src/app/settings.ts`)가 요청마다 멤버십과 역할을 다시 읽고, 각 모듈은 `workspace_id`로 걸러 다른 작업 공간의 ID에는 404를 반환합니다.
기존 테스트는 `workspace-roles.db.test.ts`의 역할 거부(19개 라우트)와 작업 공간 간 읽기·쓰기 거부, 그리고 기능별 DB 테스트의 교차 작업 공간 사례가 다룹니다.
추가한 테스트는 다음과 같습니다.

- `settings.db.test.ts` "another workspace cannot retry, resolve or read the delivery state of a manual reply": 다른 작업 공간 사용자가 수동 답장의 `/retry`, `/resolution`, `reply-status`를 요청하면 404이고, 답장 행과 감사 행이 바뀌지 않습니다. `manual-replies.ts`의 작업 공간 조건을 무력화하면 404 대신 409가 나와 실패합니다.
- `inbox-labels-notes.db.test.ts` "notes of another workspace's conversation are neither listed nor written": 다른 작업 공간의 대화 메모 조회와 작성은 `404 connection_not_found`, 소속 없는 사용자는 `403 workspace_required`입니다. `inbox-notes.ts`의 조회 소유 확인을 무력화하면 다른 작업 공간의 메모 목록이 200으로 응답해 실패합니다.

### 2. CSRF

`appApi`(`src/app/api.ts`)는 GET이 아닌 모든 `/api/*` 요청에 `requireSameOrigin`을 먼저 적용합니다. Origin이 없거나 `null`이면 요청 URL의 origin과 같지 않으므로 거부되고, Referer는 읽지 않습니다. 세션 쿠키는 `__Host-` 접두사와 `SameSite=Lax; HttpOnly; Secure`를 씁니다.
기존 테스트는 단위 수준의 `requireSameOrigin`과 일부 라우트의 다른 출처 요청을 다룹니다.
추가한 `api.test.ts` "state-changing routes refuse a null, missing or foreign Origin before any provider or database call"은 작업 공간 설정, 상담 전환, 로그아웃, 토큰 갱신, 비밀번호 재설정에 Origin 없음, `null`, 다른 출처, 접미사가 붙은 호스트, `http` 스킴을 보내 모두 403이고 DB와 인증 공급자를 호출하지 않는지 확인합니다. `requireSameOrigin` 호출을 빼면 실패합니다.
GET은 설계상 검사하지 않습니다. 상태를 바꾸는 GET은 OAuth 콜백뿐이며, 3번의 state 검사가 막습니다.

### 3. OAuth state

`finishInstagramOAuth`(`src/app/instagram-oauth.ts`)는 `state` 파라미터가 정확히 하나인지, 형식과 쿠키 일치(timing-safe)를 확인한 뒤 관리자 역할을 확인하고, 그다음 사용자·작업 공간·만료·미사용 조건으로 state를 한 번만 소비합니다. 공급자 호출은 그 뒤입니다.
기존 테스트는 재사용, 만료, 다른 사용자, 쿠키 불일치, state와 쿠키가 모두 없는 경우를 다룹니다.
추가한 `instagram-oauth.db.test.ts` "a repeated or missing state parameter and a role lost mid-flow make no provider call"은 `state`가 두 번 온 요청, 쿠키만 있고 `state`가 없는 요청을 `invalid_oauth_state`로 거부하고, 연결을 시작한 뒤 agent로 강등된 사용자를 `role_forbidden`으로 거부하며 state를 소비하지 않는지 확인합니다. 중복 검사나 역할 검사를 각각 빼면 요청이 공급자 호출까지 가서 실패합니다.

### 4. XSS

대시보드 스크립트(`public/app/*.js`)는 사용자 데이터를 `textContent`로만 씁니다. 이미지와 게시물 링크는 서버가 허용 목록으로 거르고, CSP는 `script-src 'self'`입니다(`public/_headers`). 공개 페이지는 사용자 데이터를 쓰지 않습니다.
기존 workerd 테스트의 CSP 확인은 `script-src 'self'` 문자열이 포함됐는지만 보므로, `'unsafe-inline'`이 추가돼도 통과했습니다.
추가한 `static-security.test.ts`(`test` 스크립트에 등록)는 다음을 확인합니다. 세 테스트 모두 결함을 심으면 실패합니다.

- CSP 지시어를 나눠 `script-src`가 정확히 `'self'`이고, 어느 지시어에도 `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, `data:`, `*`가 없는지 확인합니다.
- `public/app/*.js`에 `innerHTML`·`outerHTML` 대입, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, `srcdoc` 대입이 없는지 확인합니다.
- `index.html`에 인라인 스크립트, `on*=` 이벤트 속성, `javascript:` URL이 없는지 확인합니다.

이 검사는 정적 패턴 검사이므로, 저장된 악성 텍스트를 실제 브라우저에서 렌더링하는 확인을 대신하지 않습니다.

### 5. 웹후크 재전송

두 수신 경로(Cloudflare, Node)는 본문을 파싱하기 전에 원본 바이트의 `x-hub-signature-256` HMAC을 확인합니다(`verifySignature`, `src/instagram/webhook.ts`).
요청에 시각이나 nonce 검사는 없으므로, 가로챈 서명 요청을 다시 보내면 200을 받습니다. 재전송 방어는 unique 제약에 의한 중복 제거와 7일·24시간 창입니다. 운영 DB의 제약 확인과 실제 Meta 재전송을 관찰하지 못한 한계는 [#13 기록](2026-09-29-issue13-production-verification.md#웹훅-재전송-중복-차단)에 있습니다.
기존 HTTP 수준 테스트는 0으로 채운 서명만 보냈습니다. 이번에 Node 경로(`http.db.test.ts`)에는 서명 헤더 없음, 다른 비밀 키의 서명, `sha1=` 접두사, 접두사 없는 다이제스트, 빈 다이제스트를, Worker 경로(`worker.db.test.ts`)에는 서명 헤더 없음과 접두사 없는 다이제스트를 추가해 모두 403이고 행이 생기지 않는지 확인합니다. 헤더가 없을 때 통과하도록 `verifySignature`를 바꾸면 두 테스트가 실패합니다.

### 6. 세션 만료와 취소

`AuthClient.user`(`src/app/auth.ts`)는 요청마다 Supabase `/user`를 호출해 세션을 확인합니다. 공급자의 4xx는 401, 5xx와 연결 실패는 503입니다. 비밀번호 재설정은 `logout?scope=global`을 호출합니다.
기존 세션 확인 테스트는 쿠키가 없는 경우, 성공한 경우, 이메일이 확인되지 않은 사용자를 다뤘고, `/user`의 오류 응답은 다루지 않았습니다. 추가한 `auth.test.ts` "an expired, revoked or unverifiable session is refused instead of trusted"는 공급자가 401·403·404를 반환하면 401, 500·503이나 네트워크 오류면 503으로 거부하는지 확인합니다. 4xx와 5xx 매핑을 바꾸면 실패합니다.
전역 로그아웃 뒤에 이미 발급된 액세스 토큰을 Supabase가 거부하는지는 공급자 동작이므로 모의 테스트로 증명할 수 없습니다. 2026-10-06 운영 브라우저 확인에서 비밀번호 재설정 뒤 다른 창의 세션이 로그인 화면으로 돌아간 것이 지금까지의 실제 근거입니다([#15](https://github.com/AndrewDongminYoo/auto-chatter/issues/15)).

### 7. 권한 철회

멤버 제거와 역할 변경은 요청마다 멤버십을 다시 읽으므로 다음 요청부터 적용되며, `workspace-invites.db.test.ts`가 확인합니다. 연결 해제는 토큰과 수신·발송 스위치를 지우고 규칙과 플로를 끄며, 워커는 발송 직전에 연결과 토큰 버전을 다시 확인합니다.
이번에는 테스트를 추가하지 않았습니다.

## 확인한 의심 사항

- Meta 쪽에서 토큰이 취소된 경우: 신원 조회 GET이 일시적이지 않은 4xx(코드 190 포함)를 받으면 `classifyMetaGraphFailure`가 `null`을 반환하고, `verify()`가 `authorizationVerified: false`를 돌려줘 정책이 `authorization_unverified`로 막습니다. 따라서 발송 행은 매분 재시도되지 않고 `blocked`로 끝납니다. 다만 연결은 `active`로 남고 Meta의 권한 해제 웹후크도 받지 않으므로, 연결 상태와 재인증 안내는 [#16](https://github.com/AndrewDongminYoo/auto-chatter/issues/16)에서 다룹니다.
- 다른 작업 공간의 연결 ID로 연결 해제를 요청하면 `disconnectConnection`(`src/app/settings.ts`)이 아무것도 바꾸지 않고 200 `{disconnected:true}`를 반환합니다. 정보가 새지는 않지만 다른 라우트의 404와 다릅니다. 멱등한 200을 유지할지 404로 바꿀지는 공개 API 동작의 결정이므로, 이 PR은 어느 쪽도 테스트로 고정하지 않았습니다.

## 남은 항목

- 저장된 악성 텍스트의 실제 브라우저 렌더링 확인
- 실제 Meta 웹후크 재전송 관찰
- 두 실제 사용자 사이의 운영 작업 공간 격리 확인([#13](https://github.com/AndrewDongminYoo/auto-chatter/issues/13))
- 남용 제한, 관리자·서버 권한, 비밀 노출 점검(#62 두 번째 PR)
