# Instagram 장기 토큰 자동 갱신

## 문제

Instagram Login으로 연결한 계정은 장기 액세스 토큰의 만료일만 표시하고 있으며, 운영자가 만료 전에 직접 다시 연결해야 합니다.
연결이 여러 개로 늘어나면 만료를 놓쳐 댓글 자동화와 인박스 답장이 중단될 수 있습니다.

## 이번 범위

- 수신 중인 계정의 유효한 장기 토큰을 발급 후 24시간이 지나고 만료까지 30일 이하가 남았을 때 예약 작업에서 갱신합니다.
- 동일한 연결에 대한 중복 갱신을 제한하고, OAuth 재연결이나 암호화 키 교체가 갱신 중에 발생하면 오래된 결과로 새 토큰을 덮어쓰지 않습니다.
- 갱신 요청이 실패하면 기존 토큰을 유지하고 하루 뒤에 다시 시도합니다.
- 수신이 중지됐거나 만료됐거나 암호화된 토큰이 없는 계정은 갱신을 시도하지 않습니다.
- OAuth 교환에서 24시간 안에 만료되는 토큰은 연결 성공으로 저장하지 않습니다.
- 계정 화면에는 자동 갱신 예정과 실제 만료일을 함께 안내합니다.

## 이번 범위에 포함하지 않는 작업

- Meta 권한 철회와 웹훅 구독 유실을 실시간으로 판별하는 기능은 추가하지 않습니다. 권한 철회는 이후 [권한 해제 콜백](#권한-해제-콜백-16)이 처리하고, 웹훅 구독 유실은 [웹후크 구독 유실 표시](#웹후크-구독-유실-표시-179)가 주기적으로 확인합니다.
- 공급자 오류만으로 계정을 끊거나 기존 토큰을 삭제하지 않습니다.
- 실제 메시지 발송과 운영 DB 마이그레이션·배포는 이 변경에 포함하지 않습니다.

## 수용 기준

1. 수신 중이며 발급 후 24시간이 지난 유효한 토큰이 만료까지 30일 이하이면 갱신되며, 반환된 토큰을 해당 연결의 암호화된 값으로 저장합니다.
1. 아직 갱신할 시기가 아닌 토큰, 발급 후 24시간이 지나지 않은 토큰, 수신 중지 계정의 토큰과 만료된 토큰은 공급자 API를 호출하지 않습니다.
1. 중복 예약 실행, 실패 후 재시도, OAuth 재연결, 암호화 키 불일치 상황에서 잘못된 토큰으로 교체하지 않습니다.
1. 전체 발송 스위치가 꺼져 있어도 예약 갱신은 실행되며, 자동 메시지는 발송되지 않습니다.

## 재연결 필요 표시 (#16)

Meta가 저장된 토큰을 거부하면 연결에 재연결 필요 표시를 남겨 운영자가 계정 화면에서 볼 수 있게 합니다.
이 표시는 화면 표시용이며, 위의 규칙대로 공급자 오류만으로 계정을 끊거나 토큰을 삭제하지 않습니다.

### 기록 신호

- 예약 토큰 갱신에서 Meta가 갱신 요청(`refresh_access_token`)을 거부하면 `refresh_rejected`를 기록합니다. 이 실행은 기존처럼 갱신 실패로 집계됩니다.
- Cloudflare 발송 경로(댓글 비공개 답장, 팔로우 확인 DM, 수동 답장)에서 발송 전 계정 확인(`me`)을 Meta가 거부하면 `token_rejected`를 기록합니다.
- [웹훅 구독 확인](#웹후크-구독-유실-표시-179)(예약 단계와 연결 상태 수동 확인)에서 Meta가 `me` 또는 `subscribed_apps` 요청의 토큰을 거부해도 `token_rejected`를 기록합니다. 계정 ID가 다른 응답은 거부가 아니므로 기록하지 않습니다.
- 거부 기준은 HTTP 401, 또는 400·403 응답의 Graph 오류 코드 10, 190, 200–299입니다. 연결 상태 수동 확인과 같은 정의(`isMetaTokenRejection`, `src/instagram/meta-graph-error.ts`)를 사용합니다.
- 시간 초과, 네트워크 오류, 5xx, 속도 제한, 형식을 알 수 없는 응답은 기록하지 않습니다.
- 갱신으로 받은 새 토큰의 계정 확인이 거부된 경우는 저장되지 않은 토큰이므로 기록하지 않습니다.
- Node 환경 토큰 워커는 기록하지 않습니다.

### 토큰 식별과 해제

- 기록과 해제는 호출에 사용한 암호문이 현재 저장된 암호문과 같을 때만 반영합니다. Cloudflare 최종 확인이 토큰 교체를 판별하는 방식과 같아서, 교체된 이전 토큰의 결과는 새 토큰에 남지 않습니다.
- `reauth_token_obtained_at`에는 거부된 토큰의 `token_obtained_at`을 남기며, 계정 목록은 현재 토큰과 일치하는 표시만 반환합니다.
- 같은 토큰이 다시 거부되면 처음 기록한 시각과 사유를 유지합니다.
- OAuth 재연결로 새 토큰을 저장하거나, 같은 토큰의 갱신이 성공하거나, 연결을 해제하면 사유와 관계없이 표시를 지웁니다.
- 같은 토큰의 발송 전 계정 확인이나 웹훅 구독 확인에서 Meta가 저장된 계정으로 토큰을 받아들이면 `token_rejected` 표시만 지우고 `refresh_rejected` 표시는 유지합니다(#184). `me` 요청의 수락은 그 토큰을 쓸 수 있다는 뜻이지 Meta가 갱신을 받아 준다는 뜻이 아니며, 하루 한 번 다시 기록되는 갱신 거부를 그사이의 확인이 지우면 표시가 사라졌다가 다시 나타나고 처음 기록한 시각도 유지되지 않습니다.

### 표시 전용

- 자동 claim, 깨우기 조회, 최종 확인은 이 표시를 읽지 않습니다. Meta가 토큰을 계속 거부하는 동안 대기 중인 답장은 기존처럼 발송 전 확인에서 하나씩 차단됩니다(`authorization_unverified`).
- 표시 기록이나 해제가 실패해도 답장 결과와 예약 단계 결과는 바뀌지 않으며, 고정 코드의 `reauth_record_failed` 운영 로그만 남깁니다.
- `GET /api/connections`는 `reauth_required_at`과 `reauth_reason`을 반환하고, 계정 화면은 "재연결 필요" 배지와 사유별 설명, 기록 시각을 보여 줍니다.
- 작업 공간 내보내기는 세 열을 포함합니다. 비밀 값이 아니므로 제외하지 않습니다.

### 배포 순서

마이그레이션 039(`db/migrations/039_connection_reauth_required.sql`)를 코드보다 먼저 적용합니다.
코드가 먼저 배포되면 새 열을 읽거나 쓰는 다음 작업이 `42703`(열 없음) 오류로 실패합니다.

- `GET /api/connections`가 실패해 계정·규칙 화면을 불러오지 못합니다.
- OAuth 연결·재연결의 저장과 연결 해제가 실패합니다.
- 토큰 갱신이 성공해도 저장하지 못해 `token_refresh` 예약 단계가 실패하고 토큰이 갱신되지 않습니다. 갱신 거부의 표시 기록은 실패 로그만 남깁니다.
- 발송 경로의 표시 기록·해제는 실패 로그만 남기며, 답장 claim과 발송 결과는 바뀌지 않습니다.

## 권한 해제 콜백 (#16)

계정 소유자가 Instagram에서 이 앱의 권한을 해제하면 Meta는 앱에 등록된 Deauthorize callback URL을 호출합니다.
서명이 확인된 콜백은 계정 화면의 연결 해제와 같은 처리를 합니다.
이 콜백은 Meta가 앱 비밀 값으로 서명한 별도의 신호이므로, 위의 "공급자 오류만으로 계정을 끊지 않는다"는 규칙과 충돌하지 않습니다.
발송·갱신 중의 토큰 거부는 계속 재연결 필요 표시만 남깁니다.

### 요청 형식과 검증

- 경로는 Cloudflare Worker의 `POST /instagram/deauthorize`뿐입니다. OAuth로 관리하는 연결은 Cloudflare 전용이므로 Node 수신기에는 이 경로가 없습니다. `public/instagram/` 아래에는 파일을 두지 않아 정적 자산이 이 경로를 가로채지 않습니다.
- 본문은 `application/x-www-form-urlencoded`이고 `signed_request` 필드 하나를 가집니다. 값은 `<base64url 서명>.<base64url JSON 페이로드>`입니다.
- 첫 번째 `.`에서 나누고, 인코딩된 페이로드 문자열을 `INSTAGRAM_OAUTH_APP_SECRET`으로 HMAC-SHA256 한 값과 32바이트 서명을 상수 시간으로 비교합니다. 두 부분 모두 base64url 문자만 허용합니다.
- 페이로드는 JSON 객체여야 하고, `algorithm`은 대소문자 구분 없이 `HMAC-SHA256`, `user_id`는 숫자 문자열이거나 안전한 정수(2^53 미만)여야 합니다. 더 큰 JSON 숫자는 파싱에서 이미 반올림됐으므로 거부합니다. OAuth가 `instagram_user_id`를 저장할 때도 같은 함수(`normalizedUserId`)로 정규화합니다.
- `issued_at`이 있으면 양의 정수 초(epoch)여야 합니다. Meta 문서가 Instagram Login 페이로드를 밝히지 않으므로 `issued_at`이 없는 요청도 받습니다.
- 본문은 8 KiB를 넘으면 읽기를 멈춥니다(`DEAUTHORIZE_BODY_LIMIT`, `src/app/instagram-deauthorization.ts`).

| 상황                                                                                   | 응답 | DB 접근         |
| -------------------------------------------------------------------------------------- | ---- | --------------- |
| `INSTAGRAM_OAUTH_APP_SECRET` 또는 DB 바인딩 없음                                       | 503  | 없음            |
| `POST`가 아닌 메서드                                                                   | 405  | 없음            |
| 8 KiB 초과 본문                                                                        | 413  | 없음            |
| 형식 오류, 서명 불일치, 다른 알고리즘, `user_id` 없음·형식 오류, `issued_at` 형식 오류 | 400  | 없음            |
| 검증 성공(일치하는 연결이 없거나 이미 해제된 경우 포함)                                | 200  | 있음            |
| 검증 성공, 저장된 토큰보다 먼저 발급된 요청                                            | 200  | 있음(변경 없음) |

### 처리

- `account_id` 또는 `instagram_user_id`가 `user_id`와 같은 모든 연결을 찾은 뒤, ID 순서로 연결마다 별도 트랜잭션에서 해제합니다.
- 해제는 계정 화면과 같은 함수(`disconnectInTransaction`, `src/app/settings.ts`)를 같은 잠금 순서로 실행합니다. 그 연결을 트리거로 게시한 플로우를 끄고, 토큰과 만료일을 지우고, 수신과 발송을 끄고, 댓글 규칙을 끄고, 재연결 필요 표시를 지웁니다.
- 콜백은 `deauthorized_at`에 처리 시각을 남깁니다. 이미 해제된 연결도 시각을 남기며, 다시 받으면 시각을 새로 씁니다. 계정 화면의 연결 해제와 OAuth 재연결은 이 값을 지웁니다.
- 저장된 토큰을 받은 초(`date_trunc('second', token_obtained_at)`)가 `issued_at`보다 뒤인 연결은 건너뛰고 아무것도 바꾸지 않습니다. 늦게 도착하거나 다시 전달된 요청이 그 뒤의 재연결을 되돌리지 못하게 하기 위해서입니다. `token_obtained_at`은 토큰 갱신에서도 바뀌므로, 이 조건은 "재연결 이전"이 아니라 "저장된 토큰 이전"에 발급된 요청을 뜻합니다. `issued_at`은 초 단위이므로 같은 초에 받은 토큰은 해제합니다. 이 비교는 연결 UPDATE의 조건에 있어, 행 잠금을 기다리는 동안 커밋된 재연결도 반영합니다. `issued_at`이 없는 요청은 비교 없이 해제합니다.
  Meta의 시계가 DB 시계보다 1초 넘게 늦으면 재연결 직후에 발급된 실제 해제 요청도 건너뜁니다. 이때 연결은 유지되며, 죽은 토큰은 다음 발송이나 갱신에서 [재연결 필요 표시](#재연결-필요-표시-16)로 드러납니다.
- `GET /api/connections`는 `deauthorized_at`을 반환하고, 계정 화면은 "Instagram에서 권한 해제됨" 배지와 시각, '계정 연결'로 다시 연결하라는 안내를 보여 줍니다.
- 일치한 연결마다 `instagram_deauthorized` 운영 로그를 `connection_id`와 함께 남깁니다. 해제했으면 `connection_disconnected`, 건너뛰었으면(저장된 토큰보다 먼저 발급된 요청이거나, 조회 뒤 연결이 작업 공간을 떠난 경우) `connection_skipped`입니다. 일치하는 연결이 없으면 `no_connection_matched` 한 줄을 남깁니다. 허용된 로그 필드에 개수 필드가 없으므로 개수 대신 연결별 줄을 남깁니다. Instagram 사용자 ID, `signed_request`, 페이로드는 기록하지 않습니다.
- 자동 claim, 깨우기 조회, 최종 확인은 바꾸지 않았습니다. 해제 뒤의 동작은 계정 화면에서 연결을 해제한 경우와 같습니다.

### 비교하는 ID

Meta 문서는 Instagram Login의 Deauthorize 콜백이 어떤 ID를 담는지 밝히지 않습니다.
그래서 `/me`의 `user_id`로 저장한 `account_id`와, OAuth 코드 교환 응답의 `user_id`(앱 범위 Instagram 사용자 ID)를 저장한 `instagram_user_id`를 모두 비교합니다.
`instagram_user_id`는 연결·재연결마다 그 교환 응답의 값으로 저장하며, 값이 없거나 형식이 맞지 않으면 연결을 실패시키지 않고 비워 둡니다.
마이그레이션 040 이전에 연결한 계정과 `instagram_user_id`가 비어 있는 계정은 `account_id`로만 일치합니다.

### 배포와 운영자 작업

마이그레이션 040(`db/migrations/040_instagram_deauthorization.sql`)을 코드보다 먼저 적용합니다.
코드가 먼저 배포되면 새 열을 읽거나 쓰는 다음 작업이 `42703`(열 없음) 오류로 실패합니다.

- `GET /api/connections`가 실패해 대시보드 시작(`loadWorkspace`, `public/app/app.js`)이 그 지점에서 멈춥니다. 오류 알림, 다시 불러오기 버튼과 함께 로그인 양식이 다시 나타나 로그아웃된 것처럼 보일 수 있습니다. 계정·규칙, 게시물, 연락처·세그먼트·필드, 받은 메시지함, 플로우 편집기, 처리 내역을 불러오지 않으며, 그보다 먼저 시작한 운영 상태·웹훅·멤버 조회는 계속됩니다.
- OAuth 연결·재연결의 저장이 실패합니다.
- 계정 화면의 연결 해제가 실패합니다.
- 권한 해제 콜백은 연결을 찾는 조회에서 실패해 503(`request_failed`, `database_error`)을 응답하고 아무것도 바꾸지 않습니다.

예약 작업, 웹훅 수신, 발송 경로는 새 열을 읽지 않습니다.
배포 뒤 운영자는 Meta 앱 대시보드의 Instagram > API setup with Instagram business login > Business login settings에서 Deauthorize callback URL에 `https://auto-chat.donminzzi.kr/instagram/deauthorize`를 등록합니다.
웹훅 구독 유실의 주기적 판별은 이 변경에 포함하지 않았으며, 이후 [웹후크 구독 유실 표시](#웹후크-구독-유실-표시-179)가 다룹니다.

## 웹후크 구독 유실 표시 (#179)

계정이 이 앱의 `comments`, `messages`, `messaging_postbacks` 웹훅 구독을 잃으면 댓글과 DM이 조용히 들어오지 않습니다.
예약 작업이 연결마다 구독을 주기적으로 조회하고, 유실을 기록해 운영자가 계정 화면에서 볼 수 있게 합니다([#179](https://github.com/AndrewDongminYoo/auto-chatter/issues/179), #16의 일부).
조회와 분류는 [연결 상태 수동 확인](2026-09-29-instagram-connection-diagnostics.md)과 같은 함수(`checkInstagramSubscription`, `src/app/instagram-subscription-check.ts`)를 사용하므로 두 경로의 판정이 같습니다.
자동으로 다시 구독하지 않습니다.

### 주기와 대상

- 예약 단계 `subscription_check`는 `token_refresh` 바로 뒤에 실행합니다. 전역 발송이 꺼져 있어도 수신은 구독에 달려 있으므로 실행합니다.
- 연결 하나는 `SUBSCRIPTION_CHECK_INTERVAL_HOURS`마다 한 번만 시도하고, 한 실행은 `SUBSCRIPTION_CHECKS_PER_RUN`개까지 확인합니다. 두 값은 운영자 결정(2026-10-11)이며 `src/app/instagram-subscription-check.ts`가 소유합니다. 확인 한 번은 Meta GET 두 번(`me?fields=user_id`, `subscribed_apps`)이며, 예약 작업의 [호출당 subrequest 예산](2026-10-01-flow-webhook-delivery.md#전달)을 함께 씁니다.
- 대상은 수신 중(`active`)이고 토큰이 있으며 만료되지 않았고 권한 해제 기록(`deauthorized_at`)이 없는 연결 가운데, 시도한 적이 없거나 마지막 시도에서 주기가 지난 연결입니다. 시도한 적이 없는 연결부터, 그다음 가장 오래전에 시도한 연결부터 고릅니다.
- claim은 `token_refresh`처럼 `FOR UPDATE SKIP LOCKED`로 한 행씩 고르고 같은 문장에서 `subscription_check_attempted_at`을 씁니다. 그래서 일시적인 실패가 계속돼도 매분이 아니라 주기마다 다시 시도합니다. 연결 상태 수동 확인도 이 시각을 쓰므로, 수동으로 확인한 토큰은 예약 작업이 한 주기 동안 다시 확인하지 않습니다.

### 기록 규칙

`instagram_connections`의 네 열(migration 041)에 기록합니다.
모든 쓰기는 확인에 사용한 암호문이 지금 저장된 암호문과 같을 때만 반영하므로, 교체된 토큰의 결과는 아무것도 바꾸지 않습니다.

- `fields_missing`: `subscription_checked_at`을 쓰고 `subscription_token_obtained_at`에 그 토큰의 `token_obtained_at`을 남깁니다. `subscription_missing_at`은 같은 토큰에 이미 기록된 유실이 있으면 처음 시각을 유지하고, 없으면 지금 시각을 씁니다.
- `fields_present`: `subscription_checked_at`과 토큰 식별을 쓰고 `subscription_missing_at`을 지웁니다.
- Meta의 토큰 거부: [재연결 필요 표시](#재연결-필요-표시-16)에 `token_rejected`를 기록하고 구독 열은 바꾸지 않습니다.
- Meta가 같은 토큰을 저장된 계정으로 받아들이면 `token_rejected` 재연결 필요 표시를 지웁니다. 그 뒤 `subscribed_apps` 조회가 일시적으로 실패해도 마찬가지입니다. `refresh_rejected` 표시는 [토큰 식별과 해제](#토큰-식별과-해제)에 적은 이유로 유지합니다.
- 시간 초과, 네트워크 오류, 5xx, 속도 제한, 형식을 알 수 없는 응답, 남은 다음 페이지, 계정 ID 불일치, 복호화되지 않는 토큰은 구독 열을 바꾸지 않습니다.
- 유실을 새로 기록하면 `instagram_subscription_check`(`subscription_lost`, warn), 유실을 지우면 같은 이벤트(`subscription_restored`, info)의 운영 로그를 `connection_id`와 그 실행이나 요청의 `correlation_id`로 한 번 남깁니다. 토큰, 계정 ID, Meta 응답은 기록하지 않습니다.
- 구독 열의 쓰기가 실패하면 `subscription_record_failed`, 재연결 필요 표시의 쓰기가 실패하면 `reauth_record_failed` 운영 로그를 고정 코드로 남깁니다. 수동 확인의 응답은 바뀌지 않습니다.
- 예약 단계는 claim한 연결을 모두 확인한 뒤, 복호화되지 않는 토큰이나 구독 열의 쓰기 실패가 하나라도 있으면 `subscription_check_failed`로 실패합니다. `token_refresh`가 복호화 실패를 실패로 세는 것과 같습니다. Meta의 일시적 오류, 토큰 거부, 계정 ID 불일치는 실패가 아닙니다. `TOKEN_ENCRYPTION_KEY`가 없거나 쓸 수 없는 값이거나 `META_GRAPH_VERSION`이 형식에 맞지 않으면 claim 전에 `not_configured`로 실패하므로 시도 시각을 쓰지 않습니다.
- OAuth 연결·재연결과 연결 해제(계정 화면과 권한 해제 콜백이 함께 쓰는 `disconnectInTransaction`)는 네 열을 모두 지웁니다. 재연결한 새 토큰은 다음 예약 실행에서 확인합니다.
- 토큰 갱신은 `token_obtained_at`을 바꾸지만 시도 시각은 지우지 않습니다. 그래서 갱신 전 토큰의 기록은 다음 확인까지 최대 한 주기 동안 목록에서 보이지 않습니다.

### 구독 기록의 표시

- 자동 claim, 깨우기 조회, 최종 확인, 웹훅 수신, 발송 판단과 경보는 이 기록을 읽지 않습니다.
- `GET /api/connections`는 토큰이 있고 `subscription_token_obtained_at`이 현재 토큰의 `token_obtained_at`과 같을 때만 `subscription_missing_at`과 `subscription_checked_at`을 반환합니다.
- 계정 화면은 "웹후크 구독 유실" 배지와 처음 기록한 시각, '계정 연결'로 다시 연결하거나 'Meta 상태 확인'을 실행하라는 안내, 마지막 확인 시각을 보여 줍니다. 유실이 없고 확인 기록이 있으면 마지막 확인 시각만 보여 줍니다. 'Meta 상태 확인'을 실행하면 결과를 남긴 채 계정 목록을 다시 불러와 배지를 맞춥니다.
- 작업 공간 내보내기는 네 열을 포함합니다. 비밀 값이 아니므로 제외하지 않습니다.

### 마이그레이션 041 배포 순서

마이그레이션 041(`db/migrations/041_instagram_subscription_check.sql`)을 코드보다 먼저 적용합니다.
코드가 먼저 배포되면 새 열을 읽거나 쓰는 다음 작업이 `42703`(열 없음) 오류로 실패합니다.

- `GET /api/connections`가 실패해 대시보드 시작이 [권한 해제 콜백의 배포](#배포와-운영자-작업)에서 설명한 지점에서 멈춥니다.
- OAuth 연결·재연결의 저장이 실패합니다. 새 계정의 첫 연결도 같은 문장을 쓰므로 실패합니다.
- 계정 화면의 연결 해제가 실패하고, 권한 해제 콜백은 해제에서 실패해 503(`request_failed`, `database_error`)을 응답하며 그 연결을 바꾸지 않습니다.
- `subscription_check` 예약 단계가 claim에서 매 실행 `database_error`로 실패합니다. 다른 단계는 계속 실행합니다.
- 연결 상태 수동 확인은 응답을 그대로 반환하고, 구독 열의 쓰기마다 `subscription_record_failed` 로그를 남깁니다. 재연결 필요 표시의 기록·해제는 migration 039의 열만 쓰므로 영향이 없습니다.

웹훅 수신과 발송 경로는 새 열을 읽지 않습니다.

## 근거

Meta의 [Instagram 장기 토큰 갱신 문서](https://developers.facebook.com/documentation/instagram-platform/reference/refresh_access_token)는 생성된 지 24시간 이상이고 아직 만료되지 않은 장기 토큰의 갱신을 허용하며, 갱신 시점부터 60일의 유효기간을 반환한다고 설명합니다.
30일 임계값은 장기 토큰을 발급 직후 다시 갱신하지 않으면서 실패 후 재시도할 시간을 남기기 위해 선택했습니다.
