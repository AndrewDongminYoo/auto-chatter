# Cloudflare + Supabase 배포 절차

## 현재 상태

Cloudflare 어댑터와 로컬 검증 경로를 구현했습니다.
2026-09-26 승인된 개인 계정에서 Supabase 프로젝트와 Cloudflare 리소스를 생성하고 workers.dev에 배포했습니다.
2026-09-28 `auto-chat.donminzzi.kr`를 같은 계정의 기존 `auto-chatter` Worker에 Custom Domain으로 연결했습니다.
새 도메인의 `/app/`, `/privacy`, `/service`, `/data-deletion`은 HTTPS 200, 로그인하지 않은 `/api/me`는 401로 응답했습니다.
도메인 루트 `/`에만 적용되는 Cloudflare Redirect Rule은 `/app/`로 302 이동시키며 쿼리 문자열을 보존합니다.
기존 workers.dev 주소의 `/service`도 200으로 유지했습니다.
Supabase Auth의 Site URL을 `https://auto-chat.donminzzi.kr/app/`로 변경하고 저장 후 재조회로 확인했습니다.
확인 이메일의 실제 복귀는 아직 실사용 계정으로 검증하지 않았습니다.
Meta Instagram Login의 OAuth 콜백에는 새 도메인 주소를 추가하고 기존 workers.dev 주소도 유지했습니다.
동일한 Worker 코드의 설정 버전 `29e958e0-57bb-47b6-b4c4-753a0df4783c`을 100% 활성화해 운영 `APP_ORIGIN`을 `https://auto-chat.donminzzi.kr`로 바꿨으며 `SEND_ENABLED=false`를 유지했습니다.
운영자가 Meta 웹훅 콜백을 새 도메인으로 변경했고, 2026-09-28 Meta 설정 재조회에서 새 주소와 `comments`·`messages` 구독 및 `ai.you.wanted` 계정 구독을 확인했습니다.
2026-09-28 새 도메인 로그인 후 게시한 `auto-chatter 도메인 수신 테스트` 댓글이 운영 `instagram_comment_events`에 `2026-09-28 03:53:26.961295+00` 시각으로 저장된 것을 Supabase Table Editor에서 확인했습니다.
2026-09-28 운영자가 `ai.you.wanted`에 테스트 DM을 보낸 직후 Worker 실시간 로그에서 `POST /webhooks/instagram`의 HTTP 200 응답을 확인했습니다.
현재 운영 코드는 일반 DM 본문을 저장하지 않으므로 이 로그만으로 개별 메시지 내용까지 대조하지는 못했습니다.
기본 배포 설정은 `SEND_ENABLED=false`입니다.
승인된 단일 게시물의 첫 DM 테스트에서 실제 수신과 DB의 `sent` 행·공급자 메시지 ID를 확인한 뒤 전역·계정·규칙 발송을 모두 중지했습니다.
테스트 승인 범위와 중지 절차는 [첫 실발송 테스트 기록](2026-09-26-first-live-reply-test.md)에 있습니다.
이후 승인된 새 게시물에서 미팔로우 안내와 팔로우 후 완료 DM의 수신·DB 상태를 확인하고 전역·계정·규칙 발송을 다시 중지했습니다.
검증 결과와 중지 절차는 [팔로우 분기 실발송 테스트](2026-09-26-live-follow-test.md)에 있습니다.
`INSTAGRAM_APP_SECRET`과 `INSTAGRAM_VERIFY_TOKEN`의 등록을 확인했습니다.
Instagram Login 제품 설정에서 `comments` 구독이 활성화된 화면을 확인했고, 대시보드 테스트 직후 수신된 POST의 HTTP 200 응답을 Worker 로그로 확인했습니다.
첫 대시보드 테스트 당시에는 workspace·Instagram 연결·규칙이 없어 이벤트와 outbox도 0건이었습니다.
이후 운영자가 지정한 `ai.you.wanted`의 수신 연결을 등록했습니다.
실제 테스트 댓글 저장과 비공개 답장 1건의 발송·수신은 2026-09-26에 확인했습니다.
다중 사용자 코드와 003–006 DB 마이그레이션은 2026-09-26에 발송을 비활성화한 상태로 운영 배포했습니다.
2026-09-26 다중 사용자 전환에서 확인한 Worker 버전은 `dfa763f7-742d-497a-8e58-6eeb737837bd`이며 배포 코드 태그는 `6d71ef7`입니다.
이 식별자는 최신 배포 버전 확인을 대신하지 않습니다.
2026-09-28에는 migration 014까지를 운영 DB에 적용하고 병합된 Worker를 배포했습니다.
이 문장은 CLAUDE.md에 기록되어 있던 내용을 옮긴 것이며, 적용 시각·Worker 버전 같은 원래 근거는 이 저장소에 따로 남아 있지 않습니다.
이후 스키마 조회 결과는 [#13 운영 검증 기록](2026-09-29-issue13-production-verification.md)에 있습니다.
팔로우 조건 테스트를 마친 뒤 전역 `SEND_ENABLED=false`를 배포하고 실제 버전 조회로 확인했습니다.
실행 코드 변경 없이 이전에 검증한 소유권 수정 버전을 사용합니다.
운영 로그인 요청의 503 해소를 확인했고, 운영자가 회원가입 완료를 보고한 뒤 DB에서 이메일 인증·로그인 완료를 확인했습니다.
관리자 스크립트로 확인된 운영자를 기존 수신 전용 작업 공간에 배정했습니다.
메일 수신 화면과 확인 링크의 복귀는 직접 관찰하지 않았습니다.
재현과 검증 결과는 [인증 런타임 수정 기록](2026-09-26-auth-fetch-runtime-fix.md)에 있습니다.
배포된 앱 ID `1822350878757042`와 secrets 다섯 개의 등록을 확인했습니다.
이후 운영자가 Instagram OAuth 연결을 완료했고, 저장된 암호화 토큰을 복호화해 조회한 Meta 프로필이 `ai.you.wanted`와 일치함을 확인했습니다.
Meta 구독 조회에서 `comments`·`messages`를 확인했으며 토큰 만료는 `2026-11-24T12:20:10.423Z`입니다.
OAuth 연결 확인 시점에는 계정 수신 활성화·발송 비활성화·규칙과 outbox 0개였습니다.
이후 실제 OAuth 수신 테스트 댓글을 DB에서 확인했습니다.
이메일 확인 링크 복귀·여러 실제 사용자 간 격리·Advanced Access·팔로우 조회 불가와 실제 중복 이벤트 검증은 남아 있습니다.
아래 운영 구성 안내는 현재 코드 기준이며, 완료한 DB·Worker 전환·소유권 배정과 남은 Auth·OAuth 검증은 [다중 사용자 배포 전환](2026-09-26-multi-user-cutover.md)에 기록합니다.
아래 신규 DB 초기화와 리소스 생성 절차는 다른 환경을 준비할 때 사용하는 절차이며, 이미 생성한 환경에 다시 실행하지 않습니다.

| 리소스            | 최초 배포 시 확인한 값                                        |
| ----------------- | ------------------------------------------------------------- |
| Supabase 조직     | `hvpqangvavstdhyqkfww` (`second projects`, 생성 시 Free 확인) |
| Supabase 프로젝트 | `auto-chatter`, `asjjftrioaxzspkbtebf`, 서울 `ap-northeast-2` |
| Cloudflare 계정   | `dd47bef237425c1e64a1bc9a2aa64310`                            |
| Hyperdrive        | `auto-chatter-db`, `026b7ba593a24852bbfd182456ff1c03`         |
| 원본 DB 연결      | Direct endpoint, `auto_chatter_server`, 최대 5개 연결         |
| 원본 TLS          | `verify-full`, Supabase Root 2021 CA 등록                     |
| CA 등록 ID        | `041172f1-77cf-4683-8577-6afc644027e0`                        |
| Queue             | `auto-chatter-replies`, 메시지 보관 86,400초                  |
| 최초 Worker 버전  | `b4760d1d-4b21-4207-96da-52e0e4a881d7`                        |

현재 Meta 웹훅 주소는 `https://auto-chat.donminzzi.kr/webhooks/instagram`입니다.
두 웹훅 secrets 등록 후 검증 매개변수 누락·잘못된 Verify token·서명 없는 POST 요청이 모두 403으로 거부되는 것을 확인했습니다.
정상 구독 확인은 Meta 대시보드에 같은 Verify token을 입력하고 Verify and Save를 실행해 확인합니다.
Instagram Login 경로는 공통 Webhooks 메뉴 대신 **Instagram 로그인이 포함된 API 설정 → Webhooks 구성**에서 설정합니다.
해당 제품 화면의 `comments` 구독과 대상 계정의 Webhook 구독을 함께 확인합니다.
관리자·서버 DB 비밀번호는 새로 생성했으며 로컬 `deploy/secrets/supabase-provisioning.json`에만 저장했습니다.
디렉터리는 0700, 파일은 0600으로 생성했고 전체 디렉터리를 Git에서 제외했습니다.
운영자가 비밀번호 관리 도구에 보관하기 전까지 이 파일을 삭제하지 않습니다.

### 수신 계정

운영자 승인과 Instagram 제품 화면의 계정 ID를 기준으로 `ai.you.wanted` (`17841437471464257`)를 등록했습니다.
workspace ID는 `eedede37-b94a-4afe-b072-c728932e7c04`, connection ID는 `a5df4215-fb1e-46d4-93f4-13c0176fb031`입니다.
연결의 `active=true`는 댓글 저장을 허용하며, 실제 메시지 발송은 별도 `SEND_ENABLED=false`로 차단합니다.
등록 직후 조회에서 연결 한 개와 발송 규칙·outbox 0건을 확인했습니다.
현재 코드에서는 계정 ID와 연결 ID를 DB의 연결 행에서 읽으며 Worker 전역 환경 변수로 지정하지 않습니다.
Graph 버전은 `wrangler.json`의 `META_GRAPH_VERSION=v26.0`으로 지정되어 있습니다.
대시보드 예제의 계정 ID가 등록 계정과 다르면 HTTP 200이어도 저장 대상이 아니므로, 실제 댓글 저장 검증과 구분합니다.

### 개인정보 안내와 Meta 게시

운영자가 Meta 앱은 아직 개발·미게시 상태이며 개인정보처리방침 URL 누락으로 게시가 막혔다고 확인했습니다.
이후 개인정보 안내 페이지 배포를 마친 뒤 운영자가 Meta 앱 게시 완료를 알렸습니다.
2026-09-28 Meta 앱 설정 재조회에서 개인정보처리방침 URL은 `https://auto-chat.donminzzi.kr/privacy`, 서비스 약관 URL은 `https://auto-chat.donminzzi.kr/service`, 사용자 데이터 삭제 안내 URL은 `https://auto-chat.donminzzi.kr/data-deletion`로 확인했습니다.
삭제 안내 페이지는 이메일 기반 수동 요청 절차이며 자동 삭제 콜백 URL이 아닙니다.
세 페이지는 로그인·DB·Meta secrets 없이 열리고, 승인된 운영자 연락처와 보관·삭제 정책 및 서비스 이용 조건을 안내합니다.
구현 범위와 수동 삭제 절차는 [개인정보 안내 페이지 계획](../plans/2026-09-26-public-privacy-pages.md)에 기록합니다.
이 URL 준비만으로 앱이 공개되거나 다른 Meta 심사 요건을 충족한 것으로 간주하지 않습니다.

## 구성

| 구성 요소                    | 역할                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| Workers `fetch`              | 웹훅 구독 확인·원문 서명 검사·댓글과 DM 이벤트 처리, 인증된 `/api/` 요청 처리            |
| 정적 자산 `/app/`            | Supabase Auth 로그인, Instagram OAuth 연결, 계정별 규칙 설정                             |
| Queue `auto-chatter-replies` | 연결 ID만 담는 처리 알림                                                                 |
| Workers `queue`              | 연결별 확인 응답 우선 처리, 알림당 최대 한 행 claim·발송, 같은 연결의 다음 due 작업 알림 |
| 매분 Cron                    | 중단된 발송을 `unknown`으로 정리하고 due 작업 알림 복구                                  |
| Supabase PostgreSQL          | 작업 공간·소유권·암호화 토큰·이벤트·규칙·outbox·팔로우 대화·cooldown 저장                |
| Hyperdrive                   | 이벤트별 DB 연결 중개, 조회 캐시는 비활성화                                              |

Cloudflare 경로는 여러 사용자의 Instagram Login 연결을 처리합니다.
Queue의 연결 ID로 DB에서 해당 계정의 암호화 토큰과 만료 시각·발송 스위치를 확인하며 `TOKEN_ENCRYPTION_KEY`로 토큰을 복호화합니다.
웹훅은 수신 이벤트에 포함된 계정만, 소비자는 처리 중인 연결만 깨우며 Cron은 전체 연결의 due 작업을 찾습니다.
전역 `SEND_ENABLED=true` 외에도 계정별 `send_enabled`, 유효한 저장 토큰과 연결·규칙의 활성 상태가 필요합니다.
Facebook Login은 기존 Node 워커 경로에서만 지원합니다.
기존 `pg`를 재사용하며 ORM이나 Supabase JavaScript SDK를 추가하지 않습니다.

## 1. Supabase 준비

인증 요청의 Worker 제한은 `wrangler.json`의 `AUTH_IP_LIMIT`(IP·경로별 분당 30회)와 `AUTH_EMAIL_LIMIT`(이메일 해시별 분당 5회)를 사용합니다.
가입·복구·인증 메일 재전송은 이메일 제한을 공유하고 로그인은 별도로 집계합니다.
이 제한은 Cloudflare 접속 위치별로 집계되며 공유 IP 사용자에게 함께 적용될 수 있습니다.
Supabase Auth의 자체 이메일·IP 제한은 별도로 적용됩니다.
운영 브라우저에서 가입 메일, 인증 링크, 만료 링크, 복구 메일, 이전 세션 폐기를 확인하고 결과를 이 문서에 기록해야 합니다.

이 서비스 전용 프로젝트를 사용합니다.
관리자 psql 연결은 비밀 관리 도구나 로컬 `PGSERVICE` 설정으로 제공하고 비밀번호를 명령 이력에 쓰지 않습니다.
신규 DB에는 두 파일을 한 트랜잭션으로 적용합니다.
`SUPABASE_ADMIN_SERVICE`는 비밀번호가 아닌 로컬 psql 서비스 이름입니다.

```bash
PGSERVICE="$SUPABASE_ADMIN_SERVICE" psql -X --set ON_ERROR_STOP=1 --single-transaction \
  --file db/schema.sql --file deploy/supabase-access.sql
```

`deploy/supabase-access.sql`에 열거한 제품 테이블에 RLS를 켜고 `PUBLIC`, `anon`, `authenticated`, `service_role`의 접근 권한을 회수합니다.
`auto_chatter_server`와 기존 Compose 역할 `automations_app`이 있으면 해당 역할에 SELECT·INSERT·UPDATE 정책과 필요한 sequence 접근을 허용합니다.
이 역할들은 전체 서비스 데이터를 처리하는 신뢰된 서버 역할이며 사용자별 격리는 서버의 세션·workspace 검사로 수행합니다.
`PUBLIC`의 public 스키마 CREATE도 회수하므로 공유 프로젝트에는 그대로 적용하지 않습니다.
새 테이블은 이 권한 파일에도 등록해야 합니다.
기존에 같은 이름의 역할에 관리자 속성, 다른 역할 membership, DB·스키마·테이블·시퀀스 소유권이 있으면 SQL은 중단합니다.

역할은 처음에 NOLOGIN으로 생성됩니다.
관리자 psql에서 아래 SQL을 실행한 뒤 `\password auto_chatter_server` 명령으로 비밀번호를 대화형 설정합니다.

```sql
ALTER ROLE auto_chatter_server LOGIN;
```

연결의 `active`는 수신 허용 여부입니다.
발송 준비 전에는 연결의 `send_enabled`, 규칙의 `enabled`와 전역 `SEND_ENABLED`를 false로 유지합니다.
기존 DB에는 신규 초기화 명령 대신 백업 후 `deploy/migrate-multi-user.sql`을 관리자 연결로 실행합니다.
이 실행 스크립트가 003–019 마이그레이션과 접근 권한 갱신을 한 트랜잭션으로 처리하며, 자세한 순서는 [다중 사용자 배포 전환](2026-09-26-multi-user-cutover.md)을 따릅니다.
운영 DB에는 2026-09-29에 015까지 적용했습니다.
015 적용 전에 연결 테이블의 기존 1행을 Git에서 제외된 `deploy/secrets/backups/2026-09-29-pr72/instagram-connections.json`에 보관했고, 적용 후 두 신규 컬럼을 운영 DB에서 재조회했습니다.
전체 DB 덤프는 로컬 Docker가 실행 중이지 않아 생성하지 못했습니다.
PR #72 병합 커밋 `f4511c0bd9375dc2237945db1280016444b3da12`은 Worker 버전 `9b1df9ee-39c1-401a-ac77-0b90ca4860c2`로 배포했습니다.
배포 확인에서 전역 `SEND_ENABLED=false`, 활성 규칙 0개, 공개 페이지 200, 로그인하지 않은 `/api/me` 401, `/app/app.js`의 로컬 파일과 원격 파일의 SHA-256 일치를 확인했습니다.
PR #73 병합 커밋 `6c7f91421d817acc06ab50fb7ac1f52a7b5d00aa`은 2026-09-29에 Worker 버전 `9c424163-508b-460e-9b36-fb8f167deb71`로 배포하고 100% 활성 상태를 조회했습니다.
이 배포에는 DB 마이그레이션이 없으며 `SEND_ENABLED=false`입니다.
`/service`, `/privacy`, `/data-deletion`, `/app/`는 200, 로그인하지 않은 `/api/me`와 임의 연결 상태 조회는 401을 반환했고 `/app/app.js`의 운영 응답과 로컬 파일 SHA-256이 일치했습니다.
2026-09-30에는 PR #84 병합 커밋 `100e5f175ae8db3315656dc182623ad4de43db18`까지를 운영에 적용했습니다.
적용 전 운영 DB는 015까지 적용된 상태였고, 활성 연결 1개·발송 비활성·활성 규칙 0개·발송 중 행 0개였습니다.
public 스키마 전체를 Homebrew `pg_dump` 17로 Git에서 제외된 `deploy/secrets/backups/2026-09-30-pr84/public-before-016-018.dump`에 백업했으며 데이터 테이블 19개가 들어 있습니다.
관리자 연결은 로컬 Direct endpoint 대신 Session pooler `aws-0-ap-northeast-2.pooler.supabase.com`을 TLS `verify-full`로 사용했습니다.
`deploy/migrate-multi-user.sql`을 실행해 migration 016–018을 적용했습니다.
적용 후 새 테이블 5개의 RLS, 삭제 함수의 `SECURITY DEFINER`와 `postgres` 소유, `auto_chatter_server`에만 있는 함수 실행 권한을 조회했습니다.
서버 역할의 제품 테이블 DELETE 권한은 0개였고, `flow_versions` UPDATE, 삭제 증적 INSERT·UPDATE, 동의 이벤트 UPDATE 권한도 없었습니다.
기존 행 수(연결 1, 댓글 9, outbox 3)와 발송 비활성 상태는 유지됐습니다.
Worker 버전 `a5b205b7-b5c8-4c38-9502-ef62085512d2`를 배포하고 100% 활성 상태를 조회했으며 `SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지했습니다.
공개 페이지 4개는 200이었고 `/privacy`와 `/data-deletion`에서 보관 예외 문장을 확인했습니다.
로그인하지 않은 `/api/me`와 삭제 API는 401, 서명 없는 웹훅은 403이었으며 `/app/app.js`의 운영 응답과 로컬 파일 SHA-256이 일치했습니다.
배포 직후 cron 1회가 예외 없이 완료된 것을 Worker 실시간 로그로 확인했습니다.
동의 guard, 플로 발행, 연결 데이터 삭제의 실계정 동작은 검증하지 않았습니다.
같은 날 PR #86 병합 커밋 `3aa3f0f949c0a94fdd8eb95e9742de14a6851afd`까지를 운영에 적용했습니다.
적용 전 운영 DB는 018까지 적용된 상태였고, 활성 연결 1개·발송 비활성·발송 중 행 0개였습니다.
public 스키마 전체를 Git에서 제외된 `deploy/secrets/backups/2026-09-30-pr86/public-before-019.dump`에 백업했으며 데이터 테이블 24개가 들어 있습니다.
관리자 연결은 앞과 같은 Session pooler를 TLS `verify-full`로 사용했고, `deploy/migrate-multi-user.sql`을 실행해 migration 019를 적용했습니다.
적용 후 삭제 증적의 `scope` 컬럼 기본값이 `connection`인 것을 조회했습니다.
`delete_person_data`는 `SECURITY INVOKER`이고 `postgres`가 소유하며, `auto_chatter_server`, `anon`, `authenticated`, `service_role`, PUBLIC 어느 쪽에도 실행 권한이 없었습니다.
`delete_connection_data`의 서버 역할 실행 권한은 유지됐고, 서버 역할의 제품 테이블 DELETE 권한은 0개였습니다.
기존 행 수(연결 1, 댓글 9, outbox 3, 삭제 증적 0)는 유지됐습니다.
Worker 버전 `37a5b991-f658-4930-8c8a-9f481edbc4f8`를 배포하고 100% 활성 상태를 조회했으며 `SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지했습니다.
공개 페이지 4개는 200이었고 `/privacy`와 `/data-deletion`에서 이용자 단위 삭제에도 수신 거부 기록을 남긴다는 문장을 확인했습니다.
로그인하지 않은 `/api/me`와 삭제 증적 목록 API는 401, 서명 없는 웹훅은 403이었으며 `/app/app.js`의 운영 응답과 로컬 파일 SHA-256이 일치했습니다.
배포 후 cron 2회가 예외 없이 완료됐습니다.
이용자 단위 삭제 함수는 운영 데이터에 실행하지 않았습니다.
같은 날 PR #88 병합 커밋 `926f5a7c473f3f401865930fe9564917ed175439`(연결 데이터 삭제 화면)을 Worker 버전 `15eba181-5bbe-416b-8f03-09ea9eb09954`로 배포하고 100% 활성 상태를 조회했습니다.
이 배포에는 DB 마이그레이션이 없으며 `SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지했습니다.
공개 페이지 3개와 `/app/`은 200이었고, `/privacy`, `/data-deletion`, `/service`에서 설정 화면의 직접 삭제 경로 문장을 확인했습니다.
로그인하지 않은 `/api/me`와 삭제 기록 조회는 401, 서명 없는 웹훅은 403이었으며 `/app/`의 `app.js`, `inbox.js`, `styles.css`는 운영 응답과 로컬 파일의 SHA-256이 일치했습니다.
배포 후 cron 2회가 예외 없이 완료됐습니다.
실제 해제된 연결에서의 삭제와 기록 표시는 검증하지 않았습니다.
같은 날 PR #91 병합 커밋 `f5d7362d5b389baf7718fb87814d58a2c04b6118`까지를 운영에 적용했습니다. 이 커밋에는 PR #90의 작업 공간 내보내기가 포함됩니다.
적용 전 운영 DB는 019까지 적용된 상태였고, 연결 1개(수신 켜짐·발송 꺼짐)·활성 규칙 0개·발송 중 행 0개였습니다.
public 스키마 전체를 Git에서 제외된 `deploy/secrets/backups/2026-09-30-pr91/public-before-020.dump`에 백업했으며 데이터 테이블 24개가 들어 있습니다.
관리자 연결은 앞과 같은 Session pooler를 TLS `verify-full`로 사용했고, 해당 커밋의 `deploy/migrate-multi-user.sql`을 실행해 migration 020을 적용했습니다.
적용 후 `workspace_deletion_records`의 RLS, `delete_workspace_data`의 `SECURITY INVOKER`와 `postgres` 소유를 조회했습니다.
`auto_chatter_server`, `anon`, `authenticated`, `service_role`은 새 함수를 실행하거나 새 증적을 읽을 수 없었고, 서버 역할의 연결 삭제 함수 실행 권한은 유지됐으며 제품 테이블 DELETE 권한은 0개였습니다.
기존 행 수(작업 공간 2, 연결 1, 댓글 9, outbox 3, 삭제 증적 0)는 유지됐습니다.
Worker 버전 `4528cdc8-d42e-496a-a14b-84de27735b24`를 해당 커밋에서 배포하고 100% 활성 상태를 조회했으며 `SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지했습니다.
공개 페이지 3개와 `/app/`은 200이었고 `/privacy`와 `/data-deletion`에서 작업 공간 전체 삭제 문장을, `/privacy`에서 데이터 내보내기 경로를 확인했습니다.
로그인하지 않은 `/api/me`, 삭제 기록 조회, `/api/workspace/export`는 401, 서명 없는 웹훅은 403이었으며 `/app/`의 `app.js`, `inbox.js`, `styles.css`는 운영 응답과 배포 커밋 파일의 SHA-256이 일치했습니다.
배포 후 cron 2회가 예외 없이 완료됐습니다.
작업 공간 전체 삭제 함수와 내보내기는 운영 데이터에 실행하지 않았습니다.
이후 `main`에 병합된 PR #92(migration 021, 플로 실행)는 운영에 적용하거나 배포하지 않았으며, 그 Worker 코드는 021이 먼저 적용되어야 합니다.
같은 날 이어서 PR #92(migration 021, 플로 실행)를 포함한 `main` 커밋 `79606e5b0c93908bf2f325131d5c7c132caa679f`을 운영에 적용했습니다.
적용 전 운영 DB는 020까지 적용된 상태였고, 연결 1개(수신 켜짐·발송 꺼짐)·활성 규칙 0개·플로 0개·발송 중 행 0개였습니다.
public 스키마 전체를 Git에서 제외된 `deploy/secrets/backups/2026-09-30-pr92/public-before-021.dump`에 백업했으며 데이터 테이블 25개가 들어 있습니다.
관리자 연결은 앞과 같은 Session pooler를 TLS `verify-full`로 사용했고, 해당 커밋의 `deploy/migrate-multi-user.sql`을 실행해 migration 021을 적용했습니다.
적용 후 `flow_runs`와 `flow_step_runs`의 RLS를 조회했습니다. 서버 역할은 두 테이블을 조회·삽입할 수 있고 `flow_runs`만 수정할 수 있으며, `anon`과 `authenticated`는 조회할 수 없었습니다.
`flows.enabled`의 기본값은 false이고, `private_reply_outbox.rule_id`는 NULL을 허용하며 `flow_run_id` 열이 추가됐습니다.
연결·작업 공간 삭제 함수는 플로 실행 기록을 삭제하도록 바뀌었고 세 삭제 함수의 실행 권한은 그대로였으며, 서버 역할의 제품 테이블 DELETE 권한은 0개였습니다.
기존 행 수(작업 공간 2, 연결 1, 댓글 9, outbox 3)는 유지됐습니다.
Worker 버전 `a2b8908d-80db-474f-920b-61398d7c6eb5`를 해당 커밋에서 배포하고 100% 활성 상태를 조회했으며 `SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지했습니다.
공개 페이지 3개와 `/app/`은 200이었고, 로그인하지 않은 `/api/me`, 삭제 기록 조회, 내보내기, `/api/flows`는 401, 서명 없는 웹훅은 403이었으며 `/app/`의 정적 파일 세 개는 배포 커밋 파일과 SHA-256이 일치했습니다.
배포 후 cron 2회가 예외 없이 완료됐습니다.
켜진 플로가 없으므로 플로 실행과 발송은 운영에서 동작하지 않았습니다.
같은 날 이어서 PR #96(migration 022, 작업 공간 역할), PR #95(migration 023, 삭제 전 발송 행 잠금), PR #98을 포함한 `main` 커밋 `beb6bbe7a86ca047a2828d30487b244021126267`을 운영에 적용했습니다.
적용 전 운영 DB는 021까지 적용된 상태였고, 연결 1개(수신 켜짐·발송 꺼짐)·활성 규칙 0개·켜진 플로 0개·발송 중 행 0개·멤버 1명이었습니다.
public 스키마 전체를 Git에서 제외된 `deploy/secrets/backups/2026-09-30-pr98/public-before-022-023.dump`에 백업했으며 데이터 테이블 27개가 들어 있습니다.
관리자 연결은 앞과 같은 Session pooler를 TLS `verify-full`로 사용했고, 해당 커밋의 `deploy/migrate-multi-user.sql`을 실행해 migration 022와 023을 적용했습니다.
적용 후 `workspace_members.role`의 기본값이 `owner`이고 기존 멤버 1명이 `owner`인 것, 작업 공간당 멤버 한 명 제약이 사라지고 작업 공간 인덱스와 소유자 한 명 부분 고유 인덱스가 생긴 것을 조회했습니다.
`delete_connection_data`와 `delete_workspace_data`의 정의에는 `NOWAIT` 잠금이 들어 있었고, 세 삭제 함수의 소유자와 `SECURITY DEFINER` 여부, 실행 권한(`auto_chatter_server`는 연결 삭제 함수만)은 그대로였으며 서버 역할의 제품 테이블 DELETE 권한은 0개였습니다.
기존 행 수(작업 공간 2, 멤버 1, 연결 1, 댓글 9, outbox 3, 플로 0, 플로 실행 0, 삭제 증적 0)와 발송 꺼짐 상태는 유지됐습니다.
Worker 버전 `1b798c51-2c9d-492a-9f53-9e59b376ca9e`를 해당 커밋에서 배포하고 100% 활성 상태를 조회했으며 `SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지했습니다.
공개 페이지 3개와 `/app/`은 200이었고, 로그인하지 않은 `/api/me`, `/api/flows`, 내보내기는 401, 서명 없는 웹훅은 403이었으며 `/app/`의 정적 파일 세 개는 배포 커밋 파일과 SHA-256이 일치했습니다.
배포 후 cron 3회가 예외와 오류 로그 없이 완료됐습니다.
운영 작업 공간에는 소유자 한 명만 있으므로 상담원·관리자 권한 검사와 삭제 잠금은 운영 데이터로 실행하지 않았습니다.
같은 날 이어서 PR #100(#31 첫 구현, 플로 태그·필드 동작과 메시지 변수) 병합 커밋 `f7c6c72748ba2049cdd301ae8b00c8e9cedef771`을 Worker 버전 `99bbdca3-6d60-4849-8c6c-e1f2c510aae0`로 배포하고 100% 활성 상태를 조회했습니다.
배포 전 활성 버전은 `1b798c51-2c9d-492a-9f53-9e59b376ca9e`였습니다.
이 배포에는 DB 마이그레이션이 없으며 `SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지했습니다.
공개 페이지 3개와 `/app/`은 200이었고, 로그인하지 않은 `/api/me`, `/api/flows`, 내보내기는 401, 서명 없는 웹훅은 403이었으며 `/app/`의 정적 파일 세 개는 배포 커밋 파일과 SHA-256이 일치했습니다.
배포 후 cron 2회가 예외와 오류 로그 없이 완료됐습니다.
운영 DB는 조회하지 않았으며, 플로 동작과 연락처 잠금은 운영 데이터로 실행하지 않았습니다.
2026-10-01에는 PR #102(#21 초대와 멤버 관리, migration 024)와 PR #103(`/privacy`의 멤버·초대 정보 안내)을 포함한 `main` 커밋 `9299c634b66e8cd8f5b225a7b01b6b65292e7413`을 운영에 적용했습니다.
적용 전 운영 DB는 023까지 적용된 상태였고, 연결 1개(발송 꺼짐)·켜진 플로 0개·발송 중 행 0개·멤버 1명이었습니다.
public 스키마 전체를 Git에서 제외된 `deploy/secrets/backups/2026-10-01-pr102/public-before-024.dump`에 백업했으며 데이터 테이블 27개가 들어 있습니다.
PR #102를 포함한 `main` 커밋 `f69bc12`의 `deploy/migrate-multi-user.sql`을 관리자 연결로 실행해 migration 024를 적용했습니다. PR #103은 이 러너를 바꾸지 않았습니다.
적용 후 `workspace_members`에 `email`, `removed_at`, `removed_by` 열이 생기고 `workspace_invites`의 RLS가 켜진 것을 조회했습니다.
서버 역할은 초대 테이블을 조회·삽입·수정할 수 있지만 삭제할 수 없고, `anon`과 `authenticated`는 조회할 수 없었습니다.
`delete_workspace_data`의 정의에는 초대 테이블이 들어 있었고, 서버 역할의 삭제 함수 실행 권한(연결 삭제 함수만)은 그대로였으며 서버 역할의 제품 테이블 DELETE 권한은 0개였습니다.
기존 행 수(작업 공간 2, 멤버 1, 연결 1, 댓글 9, outbox 3)는 유지됐고 초대는 0건입니다.
기존 멤버 1명의 `email`은 비어 있으며, 코드상 그 사용자의 다음 로그인 요청에서 기록되지만 운영에서는 아직 확인하지 않았습니다.
Worker 버전 `c792df2c-b4a9-4713-9607-6725e14d6caf`를 해당 커밋에서 배포하고 100% 활성 상태를 조회했습니다. 배포 전 활성 버전은 `99bbdca3-6d60-4849-8c6c-e1f2c510aae0`였습니다.
`SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지했습니다.
공개 페이지 3개와 `/app/`은 200이었고, `/privacy`에는 멤버·초대 정보 항목과 시행일 2026년 10월 1일이 표시됐습니다.
로그인하지 않은 `/api/me`, 삭제 기록 조회, 내보내기, 멤버 목록은 401, 다른 출처에서 보낸 초대 수락 요청과 서명 없는 웹훅은 403이었으며 `/app/`의 정적 파일 세 개는 배포 커밋 파일과 SHA-256이 일치했습니다.
배포 후 cron 3회가 예외와 오류 로그 없이 완료됐습니다.
운영 작업 공간에는 소유자 한 명만 있고 초대가 없으므로 초대 발급·수락과 멤버 제거는 운영 데이터로 실행하지 않았습니다.
같은 날 이어서 PR #105(#32 첫 구현, 지연 노드와 cron 재개, migration 025)의 병합 커밋 `e0e5ea2a6d05e250f3170c95304bb8b3c6d823cb`을 운영에 적용했습니다.
적용 전 운영 DB는 024까지 적용된 상태였고, 연결 1개(발송 꺼짐)·플로 0개·플로 실행 0개·발송 중 행 0개였습니다.
`flow_runs`에는 이름이 자동으로 붙은 상태 검사 제약 `flow_runs_check`와 `flow_runs_status_check`가 있었습니다.
public 스키마 전체를 Git에서 제외된 `deploy/secrets/backups/2026-10-01-pr105/public-before-025.dump`에 백업했으며 데이터 테이블 28개가 들어 있습니다.
해당 커밋의 `deploy/migrate-multi-user.sql`을 관리자 연결로 실행해 migration 025를 적용했습니다.
적용 후 두 상태 검사 제약이 사라지고 `flow_runs_state` 제약, `resume_at`·`resume_node_id` 열, `flow_runs_due_idx` 부분 인덱스가 생긴 것을 조회했습니다.
서버 역할은 `flow_runs`를 수정할 수 있지만 삭제할 수 없고, `anon`은 조회할 수 없었으며, 서버 역할의 제품 테이블 DELETE 권한은 0개였습니다.
기존 행 수(작업 공간 2, 멤버 1, 연결 1, 댓글 9, outbox 3, 플로 0, 플로 실행 0)는 유지됐습니다.
Worker 버전 `bd87ed0e-b0a4-4d5f-940a-ff5223af9945`를 해당 커밋에서 배포하고 100% 활성 상태를 조회했습니다. 배포 전 활성 버전은 `c792df2c-b4a9-4713-9607-6725e14d6caf`였습니다.
`SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지했습니다.
공개 페이지 3개와 `/app/`은 200이었고, 로그인하지 않은 `/api/me`, 삭제 기록 조회, 내보내기, `/api/flows`, 멤버 목록은 401, 서명 없는 웹훅은 403이었으며 `/app/`의 정적 파일 세 개는 배포 커밋 파일과 SHA-256이 일치했습니다.
배포 후 새 버전에서 cron 2회가 예외와 오류 로그 없이 완료됐습니다.
운영에는 플로가 없으므로 지연과 재개는 운영 데이터로 실행하지 않았습니다.
같은 날 이어서 PR #107(응답 대기, migration 026), PR #109(`/privacy`의 플로 응답 정보 안내), PR #110(작업 공간 시간대와 시각 대기, migration 027)을 포함한 `main` 커밋 `f59a5693c25352962751708aad22c9a340cb314d`을 운영에 적용했습니다.
재부팅으로 임시 디렉터리의 관리자 연결 보조 스크립트가 지워져, 같은 Session pooler와 TLS `verify-full`(Git에서 제외된 `deploy/secrets/supabase-ca.crt`)로 다시 만들었습니다.
적용 전 운영 DB는 025까지 적용된 상태였고, 연결 1개(발송 꺼짐)·플로 0개·플로 실행 0개·발송 중 행 0개였습니다.
public 스키마 전체를 Git에서 제외된 `deploy/secrets/backups/2026-10-01-pr110/public-before-026-027.dump`에 백업했으며 데이터 테이블 28개가 들어 있습니다.
해당 커밋의 `deploy/migrate-multi-user.sql`을 관리자 연결로 실행해 migration 026과 027을 적용했습니다.
적용 후 `flow_runs_state` 제약에 `awaiting_reply`가 들어가고 `reply_message_id` 열과 응답 대기 인덱스 2개가 생긴 것, `workspaces.time_zone`이 NOT NULL에 기본값 `Asia/Seoul`이고 작업 공간 2개가 모두 `Asia/Seoul`인 것을 조회했습니다.
서버 역할은 `workspaces.time_zone`을 수정할 수 있고 `flow_runs`를 삭제할 수 없으며, `anon`은 `workspaces`를 조회할 수 없었고, 서버 역할의 제품 테이블 DELETE 권한은 0개였습니다.
기존 행 수(작업 공간 2, 멤버 1, 연결 1, 댓글 9, outbox 3, 플로 0, 플로 실행 0)는 유지됐습니다.
Worker 버전 `94be1bcd-d527-464c-a7a3-fb8dda6470fe`를 해당 커밋에서 배포하고 100% 활성 상태를 조회했습니다. 배포 전 활성 버전은 `bd87ed0e-b0a4-4d5f-940a-ff5223af9945`였습니다.
`SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지했습니다.
공개 페이지 3개와 `/app/`은 200이었고, `/privacy`에는 플로 응답 정보 항목, 인박스 설정의 예외 문장 2개와 시행일 2026년 10월 1일이 표시됐습니다.
로그인하지 않은 `/api/me`, `/api/flows`, 멤버 목록, 내보내기, 삭제 기록 조회는 401, 다른 출처에서 보낸 작업 공간 설정 변경과 서명 없는 웹훅은 403이었으며 `/app/`의 정적 파일 세 개는 배포 커밋 파일과 SHA-256이 일치했습니다.
배포 전 같은 점검에서는 `app.js`·`styles.css` 해시와 새 `/privacy` 문구가 일치하지 않아, 점검이 배포 전후를 구별하는 것을 확인했습니다.
배포 후 새 버전에서 cron 3회가 예외와 오류 로그 없이 완료됐습니다.
운영에는 플로가 없으므로 응답 대기와 시각 대기는 운영 데이터로 실행하지 않았고, 시간대 설정 화면도 운영에서 조작하지 않았습니다.
같은 날 이어서 PR #111(시각 대기를 비공개 답장 창 합계에서 1,560분으로 세는 발행 검증 변경)과 PR #112(문서)를 포함한 `main` 커밋 `d23cef2e6795c91db213f75c953407f409cb9a31`을 Worker 버전 `01e7f0b9-9bf9-478c-9fe1-3ca35824ee52`로 배포하고 100% 활성 상태를 조회했습니다.
배포 전 활성 버전은 `94be1bcd-d527-464c-a7a3-fb8dda6470fe`였습니다.
이 배포에는 DB 마이그레이션이 없으며 `SEND_ENABLED=false`, `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`를 유지했습니다.
앞과 같은 점검(공개 페이지, 로그인하지 않은 API와 다른 출처 요청 거부, 서명 없는 웹훅 거부, 정적 파일 해시, `/privacy` 문구와 시행일)을 모두 통과했고, 배포 후 새 버전에서 cron 3회가 예외와 오류 로그 없이 완료됐습니다.
운영에는 플로가 없으므로 바뀐 발행 검증은 운영 데이터로 실행하지 않았습니다.
예약 갱신은 수신 중인 계정에서 취득한 지 24시간 이상 지난 유효한 토큰만 만료 30일 전부터 시도합니다.
연락처·필터·필드·자동화 중지·수신 인박스의 실계정 검증은 별도로 수행해야 합니다.
다른 DB로 이전할 때의 데이터 복사는 자동화되어 있지 않습니다.

## 2. Cloudflare 준비

Queue `auto-chatter-replies`를 생성합니다.
Hyperdrive에는 Supabase의 Direct connection과 `auto_chatter_server` 자격 증명을 설정합니다.
[공식 Supabase 연결 안내](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/)에 따라 pooled endpoint 대신 Direct 연결을 사용합니다.
관리자 `postgres` 역할을 애플리케이션에 연결하지 않습니다.

Hyperdrive 조회 캐시는 반드시 끄고 원본 TLS 검증을 설정합니다.
Wrangler의 대응 옵션은 `--caching-disabled`, `--sslmode verify-full`이며, `verify-full`에는 먼저 등록한 CA 인증서 ID도 필요합니다.
[TLS 설정 문서](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)에 따라 Supabase 공식 CA를 등록한 뒤 `--ca-certificate-id`로 지정합니다.
배포 전에 API 또는 대시보드에서 캐시 비활성화와 TLS 설정을 확인합니다.
로컬 에뮬레이션으로 원격 캐시 설정을 검증할 수는 없습니다.
[조회 캐시 문서](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)와 [Wrangler 옵션](https://developers.cloudflare.com/hyperdrive/reference/wrangler-commands/)을 참고합니다.

`wrangler.json`에는 현재 개인 계정 ID와 실제 Hyperdrive ID가 반영되어 있습니다.
`workers_dev`는 true이고 `preview_urls`는 false입니다.
다른 환경에 배포할 때는 계정 ID, Hyperdrive ID, Queue와 공개 주소를 먼저 교체합니다.
계정·환경이 다르면 Queue와 DB도 분리합니다.

## 3. Workers 환경 값

비밀값은 Worker secrets에 대화형으로 입력합니다.
`INSTAGRAM_VERIFY_TOKEN`은 Meta에서 발급받는 값이 아니라 운영자가 생성하는 임의의 비밀 문자열입니다.
Worker secret과 Meta 대시보드의 Verify token에 같은 값을 저장합니다.
등록된 secret 이름을 조회하는 것으로 값이 올바르다는 사실까지 확인할 수는 없습니다.

```bash
corepack pnpm exec wrangler secret put INSTAGRAM_APP_SECRET --env-file /dev/null
corepack pnpm exec wrangler secret put INSTAGRAM_VERIFY_TOKEN --env-file /dev/null
corepack pnpm exec wrangler secret put SUPABASE_PUBLISHABLE_KEY --env-file /dev/null
corepack pnpm exec wrangler secret put INSTAGRAM_OAUTH_APP_SECRET --env-file /dev/null
corepack pnpm exec wrangler secret put TOKEN_ENCRYPTION_KEY --env-file /dev/null
```

검수용 이메일의 Meta 앱 역할을 확인했다면 #14 연결 제한 코드 배포 전에 다음 secret을 등록합니다.

```bash
corepack pnpm exec wrangler secret put INSTAGRAM_INTERNAL_EMAILS --env-file /dev/null
```

| 이름                               | 위치                     | 용도                                                                       |
| ---------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `APP_ORIGIN`                       | `wrangler.json`의 `vars` | 경로·끝 슬래시 없는 정확한 HTTPS 서비스 origin                             |
| `SUPABASE_URL`                     | `wrangler.json`의 `vars` | Supabase 프로젝트 URL                                                      |
| `INSTAGRAM_OAUTH_APP_ID`           | `wrangler.json`의 `vars` | Instagram 비즈니스 로그인 앱 ID, 메인 Meta 앱 ID와 구별                    |
| `META_GRAPH_VERSION`               | `wrangler.json`의 `vars` | 실제 앱에서 사용할 Graph 버전                                              |
| `SEND_ENABLED`                     | `wrangler.json`의 `vars` | 전역 발송 스위치, 최초 배포는 문자열 `false`                               |
| `INSTAGRAM_PUBLIC_CONNECT_ENABLED` | `wrangler.json`의 `vars` | 일반 사용자 OAuth 연결 허용 스위치, 승인·실계정 검증 전에는 문자열 `false` |
| `SUPABASE_PUBLISHABLE_KEY`         | Worker secret            | Supabase Auth 호출용 공개 키                                               |
| `INSTAGRAM_OAUTH_APP_SECRET`       | Worker secret            | Instagram OAuth 앱 secret                                                  |
| `INSTAGRAM_INTERNAL_EMAILS`        | Worker secret            | 검수용으로 허용할 확인된 이메일의 쉼표 구분 목록                           |
| `TOKEN_ENCRYPTION_KEY`             | Worker secret            | 32바이트 무작위 키의 canonical base64                                      |
| `INSTAGRAM_APP_SECRET`             | Worker secret            | 웹훅 서명 검증                                                             |
| `INSTAGRAM_VERIFY_TOKEN`           | Worker secret            | 웹훅 URL 구독 확인                                                         |

`INSTAGRAM_INTERNAL_EMAILS`는 #14 일반 사용자 연결 제한 코드를 운영에 배포하기 전에 검수용 사용자 이메일만 쉼표로 구분해 등록합니다.
등록한 이메일의 Meta 앱 역할은 별도로 확인해야 합니다.
이 비밀값이 없으면 `INSTAGRAM_PUBLIC_CONNECT_ENABLED=false`에서 모든 새 OAuth 연결이 제한됩니다.
일반 사용자 공개 스위치는 [연결 공개 조건](../specs/2026-09-29-instagram-public-access.md)의 실계정·승인 확인 전에는 바꾸지 않습니다.

`TOKEN_ENCRYPTION_KEY`는 `openssl rand -base64 32`로 생성하고 안전하게 백업합니다.
키를 잃거나 교체하면 기존 계정 토큰을 복호화할 수 없어 재연결 또는 별도 키 이전이 필요합니다.
Instagram 계정 토큰은 OAuth 연결을 통해 암호화하여 DB에 저장합니다.
Cloudflare는 `META_INSTAGRAM_ACCESS_TOKEN`, `META_INSTAGRAM_ACCOUNT_ID`, `META_INSTAGRAM_CONNECTION_ID`, `META_LOGIN_MODE`를 런타임 설정으로 사용하지 않습니다.
DB 연결은 `HYPERDRIVE`, 작업 알림은 `REPLY_QUEUE` 바인딩을 사용하므로 `DATABASE_URL`도 Worker secret으로 등록하지 않습니다.

저장소 루트의 `.env.example`은 Node 환경 변수와 위 Cloudflare 설정을 구분한 참고 템플릿입니다.
Node package scripts는 환경 파일을 자동으로 읽지 않으므로 필요한 값을 shell에 export하거나 Node의 `--env-file`로 명시적으로 불러옵니다.
Node 단일 계정 워커는 환경 변수 토큰을 계속 사용하며 Cloudflare 전용 `SEND_ENABLED=false`로 중지되지 않습니다.
Compose는 `deploy/environment.example`을 `deploy/runtime.env`로 복사하고 `--env-file deploy/runtime.env`로 전달합니다.
Cloudflare의 비밀이 아닌 값은 `wrangler.json`, secrets는 위 명령으로 설정하며 루트 템플릿을 그대로 배포하지 않습니다.
Wrangler 빌드·배포 명령은 `--env-file /dev/null`로 로컬 비밀 파일 자동 로드를 피합니다.

## 4. 검증과 배포

테스트는 격리된 로컬 PostgreSQL의 `automations_test` DB와 관리자 역할이 필요합니다.
제품 테이블을 초기화하고 테스트 역할·스키마 권한을 바꾸므로 운영 DB에서는 실행하지 않습니다.
두 DB 검사 명령을 같은 DB에서 동시에 실행하지 않습니다.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check-types
corepack pnpm test
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:db
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:cloudflare
```

Wrangler 4.116.0·Miniflare 4.20260730.0을 함께 고정했습니다.
조사한 Miniflare v4와 v5 alpha에는 타입 선언 누락이 있어 런타임 검증 도구는 `.mjs`로 실행합니다.
애플리케이션의 strict TypeScript 설정은 유지합니다.
Trunk 보안 검사에서 발견한 개발 도구의 전이 의존성은 `pnpm-workspace.yaml`에서 같은 버전 계열로 보정했습니다.
실제 설치 결과는 sharp 0.35.4, undici 7.30.0이며 패치 근거는 [sharp 보안 공지](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c), [undici 보안 공지](https://github.com/advisories/GHSA-4cwx-7wf7-3272)입니다.
override 주석에 관련 공지를 기록했으며 도구 업데이트 시 제거 가능 여부를 다시 확인합니다.
Workers가 지원하지 않는 Fetch `redirect: error`는 어댑터에서 `manual` 요청과 3xx 거부로 대체합니다.
토큰을 다른 호스트로 전달하지 않는 transport 계약을 유지합니다.

실제 바인딩과 운영 승인을 확인하고 [다중 사용자 배포 전환](2026-09-26-multi-user-cutover.md)의 DB 마이그레이션·Auth·OAuth 설정을 마친 뒤 배포합니다.

```bash
corepack pnpm exec wrangler deploy --env-file /dev/null
```

`SEND_ENABLED=false`에서 공개 주소의 구독 확인, 잘못된 서명 거부, 실제 댓글 event/outbox 저장, 중복 이벤트 제거를 먼저 확인합니다.
DB 저장 실패는 503을 반환합니다.
DB 커밋 뒤 Queue 발행 실패는 200을 반환하고 고정 오류 문구를 남기며, 발송 활성화 후 Cron이 due 작업을 복구합니다.

## 5. 발송 전환과 복구

실제 댓글 조회와 승인된 첫 비공개 답장 발송·수신 1건을 확인했습니다.
첫 발송을 별도로 승인한 뒤 기존 Compose 발송 워커를 중지하고 `SEND_ENABLED=true`로 전환합니다.
OAuth로 연결한 계정의 유효한 토큰, `active=true`, `send_enabled=true`와 대상 규칙의 `enabled=true`도 확인합니다.
Cron은 기존 pending 행도 처리하므로 활성화 전에 backlog를 검토합니다.

기존 발송 상태와 속도 제한 backoff를 유지합니다.
Queue 알림 재시도와 Meta 발송 재시도는 별개입니다.
소비자 오류로 다시 전달된 알림도 DB의 `sending`·완료 행을 다시 claim하지 않습니다.
알림 소실과 Queue 재시도 소진은 Cron이 복구하며 `unknown`은 수동 검토 대상으로 남습니다.
계정 발송이 켜져 있고 유효한 저장 토큰이 있는 연결은 수신이 비활성이어도 기존 워커 정책을 거쳐 due 작업이 `blocked`로 정리됩니다.
발송 중지·토큰 누락·만료 연결은 소비자가 건너뛰므로 이 정리를 보장하지 않습니다.
연결 cooldown이 있으면 기존 claim 정책대로 만료 후 처리합니다.
Queue 동시 실행 수는 1이며 이미 발송에 들어간 요청은 설정 변경으로 취소되지 않습니다.

장애 시 `SEND_ENABLED=false`로 배포하고 진행 중 요청 종료를 확인합니다.
DB 상태와 고정 오류 로그를 확인하고 `unknown`을 일괄 pending으로 되돌리지 않습니다.
롤백 때도 같은 DB를 유지하며 Cloudflare와 Node 발송 워커를 동시에 켜지 않습니다.
백업·복구 옵션과 요금은 선택한 Supabase 프로젝트 플랜에서 별도 확인합니다.

## 검증 경계

### 최초 배포 당시 확인

아래 리소스·권한 조회와 테스트 건수는 다중 사용자 전환 이전의 최초 배포 기록입니다.
현재 스키마의 권한과 OAuth·사용자 격리는 배포 전환 절차에서 다시 확인해야 합니다.

로컬 workerd 테스트는 pg TCP 연결, 서명, Queue·Cron 호출, 전용 서버 역할의 로그인과 RLS 적용을 확인합니다.
Graph 응답은 테스트용이며 외부 네트워크 호출을 대신 처리합니다.
실제 Hyperdrive 생성 시 Supabase Direct 연결과 서버 역할 인증에 성공했고, 반환된 설정에서 캐시 비활성화와 `verify-full`을 확인했습니다.
Supabase에서 제품 테이블 5개의 RLS, 서버 역할의 SELECT·INSERT·UPDATE 허용 및 DELETE 차단, API 역할 3개의 SELECT 차단을 조회했습니다.
Worker 배포 명령은 Queue 생산자·소비자와 매분 Cron 등록을 확인했습니다.
공개 HTTPS 요청에서 루트의 404를 확인했습니다.
웹훅은 최초 secrets 미등록 상태에서 503을 반환했고, 두 secrets 등록 후 잘못된 검증 토큰과 서명 없는 요청을 403으로 거부했습니다.
이는 거부 동작의 검증이며 정상 토큰으로 구독 확인에 성공했거나 실제 Meta 서명을 검증했다는 증거는 아닙니다.
이후 운영자가 대시보드 테스트를 전송한 직후 웹훅 POST 한 건이 HTTP 200으로 처리됐고 오류 로그·예외는 없었습니다.
이 요청은 서버의 서명 검사와 파서를 통과했지만, 원문을 기록하지 않았으므로 댓글 포함 여부와 DB 처리 경로는 이 로그만으로 단정하지 않습니다.
별도 DB 조회에서 workspace·연결·규칙·이벤트·outbox가 모두 0건임을 확인했으며, 이 테스트로 댓글 저장을 검증했다고 간주하지 않습니다.
이후 수신 연결을 등록하고 실제 테스트 댓글 저장을 2026-09-26에 확인했습니다.
실제 Cron 복구 실행, Meta 발송 권한과 실발송은 아직 검증하지 않았습니다.

2026-09-26 로컬에서 타입 검사, 기존 단위 테스트 46건, 기존 PostgreSQL 테스트 36건, Cloudflare 관련 테스트 15건, Docker 이미지 빌드를 통과했습니다.
발송 안전성과 DB 접근 권한에 대한 독립적 정적 리뷰를 수행했고, 비활성 연결의 정체·API 역할 권한 잔존·기존 역할 소유권 우회를 수정한 뒤 두 리뷰 모두 승인됐습니다.
