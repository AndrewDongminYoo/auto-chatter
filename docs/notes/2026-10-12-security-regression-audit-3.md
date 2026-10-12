# 보안 회귀 점검 3차 (#62)

## 범위

[1차와 2차 점검](2026-10-07-security-regression-audit.md) 뒤에 합쳐진 기능을 2026-10-12 `main` `c2d6e88` 기준 코드와 자동 테스트에 대응시켰습니다.
대상은 #175(만료된 OAuth state 정리), #177·#187(재연결 필요 표시), #180(Meta 권한 해제 콜백), #183(웹후크 구독 확인), #188·#192(비공개 답장 시간당 예산과 이월), #190(웹훅 전달 순서), #193(기본 API 요청 한도), #195(요금제 좌석·연결 한도)입니다.
각 기능마다 누가 호출할 수 있는지, 악의적인 호출자가 무엇을 시도할 수 있는지, 방어가 어디에 있는지, 그 공격을 실제로 시도하는 테스트가 무엇인지를 적고, 테스트가 없던 변형에는 회귀 테스트를 추가했습니다.
AI 자원(#55~#57)은 아직 구현되지 않아 이번에도 제외했습니다.
기능별 불변 조건은 [CLAUDE.md](../../CLAUDE.md)와 각 명세가 소유하므로 여기서 다시 적지 않습니다.

방법은 1차와 같습니다.
추가한 테스트는 기존 방어를 지키는 회귀 테스트이므로 처음부터 통과합니다.
그래서 테스트마다 방어 코드를 일시적으로 제거하거나 결함을 심어 실패를 한 번 확인한 뒤 원래 코드로 되돌렸고, 되돌린 뒤 `git diff --stat`에 테스트 파일만 남는 것을 확인했습니다.

## 기능별 결과

### 1. 만료된 OAuth state 정리 (#175, migration 038)

호출자는 Cloudflare cron의 `oauth_state_cleanup` 단계뿐입니다.
`scheduled` 처리기는 HTTP로 부를 수 없고, 서버 역할에는 테이블 DELETE가 없으므로 정리는 관리자 소유의 SECURITY DEFINER 함수 `public.delete_expired_oauth_states`로만 일어납니다.
악의적인 호출자가 시도할 수 있는 것은 아직 유효한 state를 지워 다른 사용자의 연결을 끊는 것, API 역할로 이 함수를 부르는 것, 그리고 definer 함수의 `search_path`를 이용해 소유자 권한으로 다른 객체를 실행하게 하는 것입니다.
방어는 함수 안의 `expires_at<=now()` 조건과 한 번에 1,000행 상한, `REVOKE ALL ... FROM PUBLIC`, 그리고 고정된 `search_path = public, pg_temp`입니다.
기존 테스트는 `instagram-oauth.db.test.ts`의 "expired OAuth state cleanup removes only expired states, consumed or not"와 "... removes at most 1,000 rows per call", `access.db.test.ts`의 API 역할 거부(`42501`)와 서버 역할의 만료 state만 삭제·테이블 DELETE 거부, `worker.db.test.ts`의 cron 단계 기록입니다.
빈틈은 definer 함수의 위생 검사가 함수 이름을 손으로 적은 호출 검사뿐이었다는 점입니다.
`search_path`를 빼거나 새 definer 함수를 추가해도 실패하는 테스트가 없었으므로, 카탈로그 전체를 읽는 테스트를 추가했습니다(아래 "추가한 회귀 테스트").

### 2. 재연결 필요 표시 (#177, #187, migration 039)

표시를 쓰는 것은 cron의 토큰 갱신(`refresh_rejected`), Cloudflare 발송 전 계정 확인(`token_rejected`), 그리고 웹후크 구독 확인(cron과 수동 확인, `token_rejected`)입니다.
사용자가 표시를 직접 쓰는 API는 없으며, 표시는 화면 표시용이고 발송 판단에 쓰이지 않습니다.
시도할 수 있는 공격은 옛 토큰의 거부로 새 토큰에 표시를 남기는 것, 정해지지 않은 사유 코드를 쓰는 것, 그리고 다른 작업 공간의 연결에 표시를 쓰게 하는 것입니다.
방어는 `reauth_token_obtained_at`을 저장된 `token_obtained_at`과 비교하는 조건과 두 CHECK 제약(`instagram_connections_reauth_reason`, `instagram_connections_reauth_marker`)입니다.
기존 테스트는 `instagram-reauth.db.test.ts` 일곱 개, `worker.db.test.ts`의 "a rejected Cloudflare identity read marks the token without changing the reply outcome"와 "an accepted Cloudflare identity read keeps a refresh_rejected marker and its first time"(#187), `instagram-subscription-check.db.test.ts`의 "a Meta rejection records the reconnect marker ..."와 "an accepted identity keeps a refresh_rejected marker and its first time"입니다.
다른 작업 공간의 연결에 쓰게 하는 경로는 수동 확인 하나뿐이며, 4번에서 다룹니다.

### 3. Meta 권한 해제 콜백 (#180, migration 040)

`POST /instagram/deauthorize`는 인증 없이 누구나 부를 수 있습니다.
시도할 수 있는 공격은 서명 위조, 다른 비밀 키나 알고리즘으로 서명한 요청, base64url 밖의 문자, `signed_request` 필드 중복, 큰 본문, 가로챈 요청의 재전송으로 재연결한 계정 끊기, 로그를 통한 Instagram 사용자 ID 노출입니다.
방어는 `src/app/instagram-deauthorization.ts`의 `verifySignedRequest`(base64url 알파벳 확인, 32바이트 서명, `timingSafeEqual`, `HMAC-SHA256`만 허용, 사용자 ID와 `issued_at` 형식 확인)와 `parseDeauthorizeBody`(8 KiB 상한, 필드 정확히 하나)입니다.
DB에는 서명을 확인한 뒤에만 닿고, 끊기 UPDATE는 `issued_at`이 저장된 토큰을 얻은 초보다 앞서면 아무것도 바꾸지 않습니다(`disconnectInTransaction`, `src/app/settings.ts`).
로그에는 내부 연결 ID만 남습니다.
기존 테스트는 `instagram-deauthorization.test.ts` 다섯 개, `instagram-deauthorization.db.test.ts` 여섯 개("a delayed or replayed callback cannot undo a reconnect that followed it" 포함), `worker.db.test.ts`의 "the deauthorize callback answers unverified or unconfigured requests without touching the database"와 "a verified deauthorize callback disconnects the matching connection and logs only its connection ID"입니다.
빈틈은 찾지 못했습니다.

### 4. 웹후크 구독 확인 (#183, migration 041)

cron 단계 `subscription_check`와, `agent` 이상이 부르는 수동 확인 `GET /api/connections/<id>/health`가 같은 기록을 씁니다.
수동 확인은 사용자별 한도(`AUTH_IP_LIMIT`의 `connection-health:<사용자 ID>` 키, 닫힌 쪽으로 실패)를 씁니다.
시도할 수 있는 공격은 다른 작업 공간의 연결 ID로 그 토큰의 Meta 호출을 쓰게 하거나 그 연결의 기록과 재연결 표시를 바꾸는 것, 저장된 계정이 아닌 계정을 조회하게 하는 것, 토큰이나 계정 ID를 로그나 응답에 남기는 것입니다.
방어는 `connectionHealth`(`src/app/instagram-connection-health.ts`)가 기록을 쓰기 전에 `id`와 `workspace_id`로 연결을 읽는 조건, `subscribed_apps` 경로를 저장된 계정 ID로만 만드는 `checkInstagramSubscription`, 그리고 토큰을 `Authorization` 헤더로만 보내는 요청입니다.
기존 테스트는 `api.test.ts`의 "connection health is workspace scoped and never probes another account"와 "connection health rate limit prevents Meta requests", `instagram-subscription-check.test.ts`의 "the shared check reads me first and subscribed_apps only for the stored account", 그리고 `instagram-subscription-check.db.test.ts`의 기록 테스트입니다.
빈틈은 교차 작업 공간 테스트가 모의 풀로만 404를 확인해서, `workspace_id` 조건이 빠져도 실패하지 않았다는 점입니다.
DB 수준의 테스트를 추가했습니다.

### 5. 비공개 답장 시간당 예산과 이월 (#188, #192, migration 042, 044)

예산은 작업자와 cron이 내부에서 적용하며, 사용자가 부르는 경로는 없습니다.
시도할 수 있는 공격은 카운터 초기화(연결 데이터 삭제, 개인 데이터 삭제, OAuth 재연결), 한 연결의 밀린 답장으로 다른 연결 굶기기, 예산 경계의 동시 claim으로 한도를 넘기는 것입니다.
방어는 claim과 wake의 예산 조건(`PRIVATE_REPLY_HOURLY_BUDGET`, `src/instagram/send-quota.ts`), 삭제 문장마다 최근 호출 수를 연결 행으로 옮기는 트리거 `carry_deleted_private_reply_calls`, 그리고 `send_woken_at` 순서의 cron wake입니다.
기존 테스트는 `send-quota.db.test.ts` 열두 개("concurrent claims at the budget edge send each reply at most once", "connection data deletion and a reconnect keep the deleted rows' recent calls counted until they expire", "person data deletion keeps the person's recent calls counted" 포함)와 `worker.db.test.ts`의 "a connection at its private reply budget is neither claimed nor queued again until the hour frees", "recent calls of deleted rows still hold the claim and the wake until their carry expires", "with more than 100 due connections the cron wake reaches every one in rotation", "the cron wake moves only the connections it published to the back of the rotation"입니다.
빈틈은 찾지 못했습니다.

### 6. 웹훅 전달 순서 (#190, migration 043)

전달은 cron만 하며, 사용자가 순서를 바꾸는 경로는 없습니다.
시도할 수 있는 공격은 한 작업 공간이 밀린 전달이나 느린 엔드포인트로 다른 작업 공간의 전달을 막는 것입니다.
방어는 `deliverDueWebhooks`(`src/app/webhook-delivery.ts`)의 작업 공간별 차례와 엔드포인트별 실행 예산입니다.
기존 테스트는 `webhook-delivery.db.test.ts`의 "a workspace with a backlog does not hold back another workspace's later due delivery", "consecutive runs reach every workspace when more workspaces have due work than one run attempts", "a slow endpoint gets one attempt per run and the other endpoints keep the rest of the run", "an endpoint that used its budget stays skipped when its workspace's turn comes again", "overlapping runs attempt each due delivery of several workspaces once"입니다.
빈틈은 찾지 못했습니다.

### 7. 기본 API 요청 한도 (#193)

로그인한 사용자 누구나 대상입니다.
시도할 수 있는 공격은 인증 경로 접두어, 시작 요청(`POST /api/workspace`), 멤버 제거 예외, 작업 공간이 없는 사용자, 처리기가 거절할 요청으로 한도를 우회하는 것, 그리고 한도가 없는 다른 경로로 같은 부하를 만드는 것입니다.
방어는 `appApi`(`src/app/api.ts`)의 순서입니다.
쓰기는 DB 풀을 열기 전에 사용자 한도를, 경로 처리기 전에 작업 공간 한도를 쓰며, `GET /api/inbox`는 `listInbox` 전에 목록 한도를 씁니다.
기존 테스트는 `api.test.ts`의 #167 테스트 아홉 개, `auth-limiter.test.ts`의 한도 이름·횟수·창 길이, `runtime.db.test.mjs`의 workerd 121번째 쓰기 거절입니다.
세 한도가 열린 쪽으로 실패하는 것은 [API 요청 한도 명세](../specs/2026-10-12-api-request-limits.md#한도-객체를-쓸-수-없을-때)의 설계 결정이므로 발견 사항으로 보지 않았습니다.
빈틈은 한도가 없는 무거운 GET인 연락처 CSV 내보내기입니다.
제품 변경이 필요하므로 별도 이슈로 적었습니다([#196](https://github.com/AndrewDongminYoo/auto-chatter/issues/196)).

### 8. 요금제 좌석·연결 한도 (#195, migration 045)

좌석은 소유자의 초대와 초대받은 사용자의 수락이, 연결은 `admin` 이상의 OAuth 완료가 씁니다.
시도할 수 있는 공격은 동시 초대·수락·연결로 한도를 넘기는 것, 다른 작업 공간이 가진 계정을 가져오는 것, 서버가 `plan` 열을 쓰게 하는 것, 그리고 OAuth를 거치지 않는 다른 경로로 연결을 다시 켜는 것입니다.
방어는 `src/app/plans.ts`의 `requireInviteSeat`·`requireMemberSeat`·`requireConnectionSlot`과 그 호출부의 작업 공간 행 잠금, 그리고 `deploy/supabase-access.sql`의 열 권한(서버 역할은 `workspaces`에 `id`, `time_zone`만 INSERT하고 `time_zone`만 UPDATE)입니다.
기존 테스트는 `plans.db.test.ts`(경쟁 테스트 세 개와 "an account held by another workspace is refused even when that row is deleted before the insert" 포함)와 `access.db.test.ts`의 `UPDATE workspaces SET plan` 거부(`42501`)입니다.
빈틈은 연결을 켜는 다른 쓰기 경로인 연결 스위치(`PATCH /api/connections/<id>`, `updateConnection`)와, `workspaces`를 쓰는 유일한 API인 설정 저장(`PUT /api/workspace/settings`)을 시도하는 테스트가 없었다는 점입니다.
기능별 DB 테스트는 슈퍼유저로 실행되고 열 권한은 슈퍼유저에게 적용되지 않으므로, `access.db.test.ts`의 열 권한 테스트만으로는 설정 저장 경로를 증명하지 못합니다.
두 경로를 시도하는 테스트를 추가했습니다.

## 확인한 의심 사항

- 1차 점검의 "상태를 바꾸는 GET은 OAuth 콜백뿐"이라는 문장은 #183 이후 맞지 않습니다. 수동 구독 확인(`GET /api/connections/<id>/health`)도 확인 시각, 구독 기록, `token_rejected` 표시를 씁니다. 세션 쿠키는 `SameSite=Lax`라서 다른 사이트의 최상위 이동에 실립니다. 그래도 발견 사항으로 보지 않았습니다. 공격자는 추측할 수 없는 연결 UUID를 알아야 하고, 기록되는 것은 Meta가 실제로 돌려준 결과뿐이며, 사용자별 한도가 Meta 호출 수를 묶고, 최악의 영향은 그 토큰의 예약 확인이 한 주기(6시간) 미뤄지는 것입니다.
- 권한 해제 요청에 `issued_at`이 없으면 시점을 정할 수 없으므로, 가로챈 요청을 재연결 뒤에 다시 보내면 다시 끊깁니다. 이것은 명세의 결정이며 `instagram-deauthorization.db.test.ts`가 고정합니다. 요청을 가로채려면 Meta와 Worker 사이의 HTTPS나 운영 로그에 접근해야 하는데, 로그에는 서명된 요청을 남기지 않습니다.
- 권한 해제 콜백은 `account_id`와 `instagram_user_id` 어느 쪽이든 맞으면 끊습니다. 두 값은 모두 Meta가 OAuth 교환에서 준 것이고 사용자가 정할 수 없으므로, 다른 사용자의 연결과 겹치게 만들 수 없습니다.
- 권한 해제 콜백에는 요청 한도가 없습니다. 서명을 확인하기 전에는 DB에 닿지 않고, 본문은 8 KiB로 묶여 있어 HMAC 한 번이 비용의 전부입니다.
- 예산 카운터를 초기화하는 남은 경로는 작업 공간 전체 삭제 뒤에 같은 계정을 새 작업 공간에서 연결하는 것과 TRUNCATE입니다. `delete_workspace_data`는 관리자만 실행할 수 있고 API가 없으며, 서버 역할에는 TRUNCATE가 없습니다(`access.db.test.ts`). `src`에서 `private_reply_carried_*` 열을 읽는 곳은 예산 조건(`src/instagram/send-quota.ts`)뿐이고 쓰는 코드는 없습니다(`grep -rn "private_reply_carried" src`, 테스트 제외).
- `carry_deleted_private_reply_calls`와 `enforce_channel_consent_state_event`는 PUBLIC에 EXECUTE가 남아 있지만 SECURITY INVOKER인 트리거 함수이므로 직접 호출할 수 없습니다. `inbox_label_ids_valid`와 `inbox_label_rule_keywords_valid`는 `boolean`을 돌려주는 IMMUTABLE INVOKER 함수로, 호출자 권한으로만 실행됩니다(`pg_proc`의 `prorettype`, `provolatile`, `prosecdef`로 확인).
- 연결 한도를 우회해 연결을 켜는 다른 코드는 없습니다. `src/app`에서 `active=true`를 쓰는 곳은 OAuth 활성화 하나이고, 연결 스위치는 유효한 토큰이 있을 때만 켭니다. 토큰이 있는 행은 이미 한도에 셉니다.
- 멤버 제거 요청은 역할과 관계없이 작업 공간 한도를 쓰지 않습니다. 사용자 한도는 쓰고 소유자가 아니면 처리기가 아무것도 쓰지 않으므로, 명세가 적은 대로입니다.

## 추가한 회귀 테스트

각 테스트는 아래 방법으로 방어를 빼거나 결함을 심어 한 번 실패하는 것을 확인했고, 되돌린 뒤 제품 코드의 diff는 없습니다.

- `access.db.test.ts`: `pg_proc`에서 public의 SECURITY DEFINER 함수를 모두 읽어, 목록이 `delete_connection_data`와 `delete_expired_oauth_states`로 정확히 같은지, 각 함수가 `search_path`를 고정하는지, 서버 역할이나 API 역할이 소유하지 않는지, PUBLIC과 API 역할에 EXECUTE가 없는지 확인합니다. `db/schema.sql`의 `delete_expired_oauth_states`에서 `SET search_path` 줄을 빼면 "must pin search_path"로, `search_path` 없는 definer 함수를 `db/schema.sql`에 하나 추가하면 목록 비교로 실패했습니다.
- `instagram-subscription-check.db.test.ts` "another workspace or a user without one cannot run the manual check on this connection": 다른 작업 공간의 사용자는 `404 connection_not_found`, 작업 공간이 없는 사용자는 `403 workspace_required`이고, Meta 호출, 연결 행의 변경, 로그가 모두 없는지 확인합니다. `connectionHealth`의 조회에서 `workspace_id` 조건을 빼면 거절 대신 확인이 진행돼 실패했습니다.
- `plans.db.test.ts` "neither the connection switch nor the settings route raises the plan or reactivates a disconnected account": 무료 요금제에서 연결을 끊은 계정을 연결 스위치로 다시 켜면 `409 connection_unavailable`이고 연결된 계정이 그대로인지, 설정 저장 본문에 `plan`과 `limits`를 넣어도 시간대만 바뀌고 요금제는 `free`로 남는지 확인합니다. `updateConnection`의 토큰 조건을 빼면 거절이 사라져 실패했고, 설정 저장이 `plan`도 쓰게 하면 요금제가 `advanced`가 되어 실패했습니다.

## 테스트하지 않은 항목

- 권한 해제 콜백과 OAuth 재연결이 동시에 일어나는 경우는 테스트하지 않았습니다. 끊기 UPDATE가 같은 문장에서 `token_obtained_at`을 다시 읽고, OAuth 활성화는 저장한 암호문이 그대로일 때만 연결을 켜므로(`instagram_connection_changed`), 어느 순서로 커밋해도 끊긴 연결이 다시 켜지지 않고, `issued_at`이 있는 요청은 새 토큰을 끊지 않습니다.
- 운영 Worker에서 실제 Meta가 보내는 권한 해제 요청의 `issued_at` 유무와 실제 재전송은 확인하지 않았습니다. 모의 요청 테스트는 Meta의 실제 동작을 증명하지 않습니다.
- 운영 Durable Object의 한도 동작과 운영 DB의 열 권한은 확인하지 않았습니다. 이 점검의 테스트는 모두 로컬 DB와 workerd에서 실행합니다.

## 별도 이슈

| 이슈                                                                | 내용                                                                                                                                                                      | 출시 판단(운영자가 정함)                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [#196](https://github.com/AndrewDongminYoo/auto-chatter/issues/196) | 연락처 CSV 내보내기(`GET /api/contacts/export.csv`)에 요청 빈도 한도가 없습니다. 작업 공간 내보내기는 #166의 사용자별 한도를 쓰지만, 이 경로는 어느 한도도 쓰지 않습니다. | 차단 아님으로 보임: 관리자만 호출하고, 요청 하나의 크기·시간은 이미 묶여 있습니다. |

## 저장된 악성 텍스트의 브라우저 렌더링 확인

로그인 없이 대시보드를 그리기 위해, 커밋하지 않는 로컬 하네스를 썼습니다. 하네스는 실제 `public/app/index.html`과 `public/app/*.js`를 그대로 불러오고, `/api/*`의 `fetch`만 가짜 서버로 바꿉니다. 가짜 서버는 사용자가 입력할 수 있는 모든 필드에 XSS 페이로드를 넣어 돌려줍니다(댓글·DM 본문, 사용자 이름, 태그, 필드 값, 세그먼트, 라벨, 라벨 규칙, 메모, 알림, 멤버와 초대 이메일, 플로 이름과 메시지, 웹훅 엔드포인트, 전달 실패 코드, 운영 경보, 삭제 기록, 요금제 키 등). 페이로드는 `<img src=x onerror=...>`, `<script>`, `javascript:` URL, 큰따옴표·작은따옴표 속성 탈출, HTML 엔티티, `<svg onload>`, `<iframe srcdoc>`입니다. 페이로드가 실행되면 `window.__xss`가 켜지고, 페이로드가 요소나 `on*` 속성으로 DOM에 들어가면 하네스가 따로 기록합니다. CSP는 걸지 않았으므로, 운영의 `script-src 'self'`가 없는 상태에서 `textContent` 계층만 시험했습니다.

- 확인 일시와 브라우저: 2026-10-12 13:34Z부터 13:42Z 사이, 로컬 Chrome(Claude in Chrome 확장으로 조작), `python3 -m http.server`로 `127.0.0.1`에서 제공한 `main` `c2d6e88`의 `public/app/`.
- 렌더링한 화면: `#home`, `#accounts`, `#automation`, `#inbox`, `#contacts`, `#settings` 여섯 화면입니다. 각 화면에서 보이는 버튼·링크·요약 요소를 차례로 눌러 항목과 편집기를 열었습니다(13, 11, 31, 31, 22, 22개, 모두 130개). 삭제·제거·해제·로그아웃 문구가 있는 요소는 누르지 않았고, 확인 대화상자는 미리 막았습니다. 화면에 페이로드 문자열이 텍스트로 보인 수는 6, 1, 11, 16, 11, 14였습니다.
- `window.__xss` 표시와 DOM 검사 결과: 모든 화면을 연 뒤에도 `window.__xss`는 `false`였습니다. 페이로드가 요소나 `on*` 속성으로 DOM에 들어간 경우는 없었습니다. 하네스가 기록한 항목은 하나였고, 브라우저 확장 프로그램이 페이지에 넣은 `<script id="globalVarsDetection" src="chrome-extension://…/js/wrs_env.js">`였습니다. 이것은 대시보드나 페이로드와 관계없는 오탐입니다. 열린 항목 안에서 다시 여는 대화상자처럼 두 단계 이상 들어가는 화면은 이 순회에 포함되지 않았을 수 있습니다.
- 서버가 거르는 필드(`permalink`, `image_url`)의 결과: 하네스의 가짜 서버는 이 필터를 거치지 않으므로, 여기서 보이는 위험한 값은 발견 사항이 아닙니다. 서버 필터는 `api.test.ts`의 "unsafe display URLs are removed and unsupported posts cannot be selected"가 확인합니다.

## 남은 항목

- 실제 Meta 웹후크와 권한 해제 요청의 재전송 관찰
- 두 실제 사용자 사이의 운영 작업 공간 격리 확인([#13](https://github.com/AndrewDongminYoo/auto-chatter/issues/13))
- 별도 이슈 [#196](https://github.com/AndrewDongminYoo/auto-chatter/issues/196)의 결정
