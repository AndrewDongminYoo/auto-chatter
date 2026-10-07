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

- `_headers` 어디에도 `! Content-Security-Policy`로 CSP를 떼어내는 규칙이 없는지 확인합니다. `/app/*` 블록에서 CSP가 정확히 하나인지, 지시어 이름이 허용 목록과 정확히 같은지(`script-src-elem`처럼 `script-src`를 덮어쓰는 지시어가 생기면 실패) 확인하고, 지시어를 나눠 `script-src`가 정확히 `'self'`이며 어느 지시어에도 `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`, `data:`, `*`가 없는지 확인합니다. 브라우저는 같은 지시어가 두 번 나오면 첫 번째만 적용하므로, 중복 지시어는 그 자체로 거부합니다.
- `public/app/*.js`에 `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `srcdoc`, `document.write`, `eval`, `Function`과 HTML 파서(`createContextualFragment`, `parseFromString`, `setHTMLUnsafe`, `parseHTMLUnsafe`) 같은 sink 이름이 점·대괄호·문자열 어느 표기로도 나오지 않는지 확인합니다.
- Wrangler는 `public/` 전체를 같은 출처로 제공하므로, `public/`의 모든 파일이 허용 목록(`_headers`, `app/*.js`·`.html`·`.css`, `icons/*.png`)에 맞아야 합니다. 그래서 검사하지 않은 실행 파일은 스크립트 태그, 정적·동적 import, worker 어느 경로로도 실릴 수 없습니다. 대시보드 JS는 동적 `import()`도 쓰지 않아야 합니다.
- `index.html`의 스크립트가 모두 위 검사가 읽는 파일인지, 인라인 스크립트, `on*=` 이벤트 속성(따옴표 안의 값을 지운 뒤 검사), `javascript:` URL이 없는지 확인합니다.

스크립트 실행을 실제로 막는 것은 브라우저가 강제하는 CSP이고, 그 정책은 첫 번째 테스트가 정확한 값으로 고정합니다. sink와 HTML 문자열 검사는 그 위의 이중 방어이며 최선의 노력입니다. PR #162의 호스티드 리뷰는 다섯 라운드 동안 이 문자열 검사에서만 표기 우회 9건을 지적했고 모두 고쳤습니다. 이후에도 같은 종류의 표기 우회는 이 범위를 근거로 따로 다루지 않습니다.

CSP 출처 값은 대소문자를 구분하지 않고 비교하며, sink 이름은 단어 자체를 거부하므로 옵셔널 체이닝(`document?.write`)이나 대괄호 표기도 잡습니다.
이 검사는 구문을 해석하지 않는 문자열 검사이므로, `const d = document; d.write(x)` 같은 별칭은 잡지 못하고 코드 리뷰에 맡깁니다. 또한 저장된 악성 텍스트를 실제 브라우저에서 렌더링하는 확인을 대신하지 않습니다.

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
- 다른 작업 공간의 연결 ID로 연결 해제를 요청하면 `disconnectConnection`(`src/app/settings.ts`)이 아무것도 바꾸지 않고 200 `{disconnected:true}`를 반환합니다. 정보가 새지는 않지만 다른 라우트의 404와 다릅니다. 멱등한 200을 유지할지 404로 바꿀지는 공개 API 동작의 결정이므로, PR #162는 어느 쪽도 테스트로 고정하지 않았습니다. 2026-10-07 운영자가 404로 정했고, 이후 PR에서 다른 작업 공간이나 없는 연결 ID는 잠금을 잡기 전에 `404 connection_not_found`를 반환하도록 바꿨습니다(`settings.db.test.ts` "disconnect clears only owned credentials and disables its rules").

## 2차 점검: 남용 제한·권한·비밀 노출

#62의 두 번째 완료 조건을 같은 날 `main` `d01fae6` 기준으로 점검했습니다. AI 자원(#55~#57)은 아직 구현되지 않아 제외했습니다.

### 발견 사항과 이슈

| 이슈                                                                | 내용                                                                                                                                                           | 출시 판단(운영자, 2026-10-07) |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| [#164](https://github.com/AndrewDongminYoo/auto-chatter/issues/164) | Worker가 Supabase에 사용자 IP(`Sb-Forwarded-For`)를 넘기지 않아, Supabase의 IP별 제한(`/user`·가입·복구 등 5분에 30회)이 Cloudflare 출구 IP 기준으로 걸립니다. | 출시 차단                     |
| [#165](https://github.com/AndrewDongminYoo/auto-chatter/issues/165) | 한 IP가 주소를 바꿔 가며 프로젝트 전체의 인증 메일 한도(시간당 30통)를 1분 안에 소진할 수 있고, 화면은 성공으로 안내합니다.                                    | 출시 차단                     |
| [#166](https://github.com/AndrewDongminYoo/auto-chatter/issues/166) | 게시물 목록 조회, 작업 공간 내보내기, OAuth 시작에 상한이 없습니다.                                                                                            | 차단 아님                     |
| [#167](https://github.com/AndrewDongminYoo/auto-chatter/issues/167) | 사용자·작업 공간별 API 제한과 웹훅 전달의 작업 공간 간 공정성(설계 결정)입니다.                                                                                | 차단 아님                     |

#164를 수정하면서 supabase/auth 소스를 확인한 결과, 세션 확인에 쓰는 `GET /user`에는 IP별 제한이 없고 `PUT /user`에만 있었습니다. 그래서 출구 IP 기준 제한이 실제로 문제가 되는 곳은 로그인·세션 갱신·로그아웃이 호출하는 `/token`(5분에 150회)입니다. Worker의 로그인 제한(분당 30회)이 5분 동안 정확히 이 한도와 같았고, 갱신과 로그아웃에는 Worker 제한이 없었습니다. 수정은 비밀 키와 `Sb-Forwarded-For`로 사용자 IP를 넘기고, 갱신과 로그아웃에도 IP별 제한을 둡니다([인증 스펙](../specs/2026-09-28-auth-completion.md)).

[Meta 요청 제한 문서](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)(2026-10-07 확인)는 Instagram 한도를 앱과 사용자 쌍마다 세므로, 게시물 조회 남용은 그 작업 공간 계정의 한도만 씁니다. 앱 전체 발송 한도는 [#60](https://github.com/AndrewDongminYoo/auto-chatter/issues/60)이 다룹니다.

### 추가한 회귀 테스트

각 테스트는 방어를 빼거나 결함을 심어 한 번 실패하는 것을 확인했고, 제품 코드는 바꾸지 않았습니다.

- `access.db.test.ts`: 기존 손 목록과 별도로 `pg_class`에서 public 테이블 전체를 읽어, 모든 테이블이 RLS를 켜고 API 역할(`anon`, `authenticated`, `service_role`)에 권한이 없으며 서버 역할에 DELETE·TRUNCATE가 없는지 확인합니다. `deploy/supabase-access.sql`의 RLS 목록에서 `instagram_contact_tags`를 빼거나 DELETE 권한을 주면 실패합니다. 이 테이블과 `instagram_contact_segments`는 기존 손 목록에 없던 테이블입니다.
- `auth.test.ts`: `readJson`이 16,384바이트까지 받고 16,385바이트에서 `413 request_too_large`, 플로 라우트의 허용치(69,632바이트)에서도 1바이트 초과를 거부하며, JSON이 아닌 형식은 `415 json_required`로 거부하는지 확인합니다.
- `workspace-invites.db.test.ts`: 역할 변경과 초대로 `owner`(대소문자 변형 포함)를 줄 수 없고(`400 invalid_role`), 열린 초대 21번째가 `409 invite_limit_reached`인지 확인합니다.
- `flows.db.test.ts`: 51번째 활성 플로가 `409 flow_limit_reached`이고, 보관한 플로는 세지 않는지 확인합니다.
- `static-security.test.ts`: `src/`에서 `console`이나 표준 출력에 쓰는 파일이 `operations-log.ts`와 Node 진입점 두 파일뿐인지, `wrangler.json`의 `vars` 키 집합이 정확히 정해진 6개이고 `SEND_ENABLED`와 `INSTAGRAM_PUBLIC_CONNECT_ENABLED`가 `"false"`이며 환경별 덮어쓰기가 없는지 확인합니다.

### 테스트하지 않은 항목

- 플로 테스트 실행의 단계·재개 상한은 발행 검증이 순환과 100개 초과 노드를 거부하므로 API로 도달할 수 없는 안전장치라 테스트하지 않았습니다.
- `delete_connection_data`는 전달받은 작업 공간과 실행자를 그대로 신뢰합니다. 호출 전에 앱이 소유와 역할을 확인하며(`src/app/data-deletion.ts`), 이 함수를 실행할 수 있는 것은 신뢰된 서버 역할뿐입니다.
- trufflehog와 osv-scanner는 CI에서 작업 트리를 검사하며 git 기록은 검사하지 않습니다.

## 남은 항목

- 저장된 악성 텍스트의 실제 브라우저 렌더링 확인
- 실제 Meta 웹후크 재전송 관찰
- 두 실제 사용자 사이의 운영 작업 공간 격리 확인([#13](https://github.com/AndrewDongminYoo/auto-chatter/issues/13))
- 출시 차단 이슈 #164, #165의 수정
