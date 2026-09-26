# Cloudflare + Supabase 배포 절차

## 현재 상태

Cloudflare 어댑터와 로컬 검증 경로를 구현했습니다.
2026-09-26 승인된 개인 계정에서 Supabase 프로젝트와 Cloudflare 리소스를 생성하고 workers.dev에 배포했습니다.
발송은 `SEND_ENABLED=false`로 유지합니다.
`INSTAGRAM_APP_SECRET`과 `INSTAGRAM_VERIFY_TOKEN`의 등록을 확인했습니다.
Instagram Login 제품 설정에서 `comments` 구독이 활성화된 화면을 확인했고, 대시보드 테스트 직후 수신된 POST의 HTTP 200 응답을 Worker 로그로 확인했습니다.
첫 대시보드 테스트 당시에는 workspace·Instagram 연결·규칙이 없어 이벤트와 outbox도 0건이었습니다.
이후 운영자가 지정한 `ai.you.wanted`의 수신 연결을 등록했습니다.
실제 테스트 댓글 저장은 2026-09-26에 확인했으며 실제 비공개 답장 발송은 아직 검증하지 않았습니다.
이후 구현한 다중 사용자 기능은 아직 운영에 배포하지 않았습니다.
아래 운영 구성 안내는 현재 코드 기준이며, 기존 운영 DB와 Worker의 전환은 [다중 사용자 배포 전환](2026-09-26-multi-user-cutover.md)의 마이그레이션·Auth·OAuth·소유권 배정 절차를 따릅니다.
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

웹훅 주소는 `https://auto-chatter.auto-chatter-ydm2790.workers.dev/webhooks/instagram`입니다.
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
Meta의 개인정보처리방침 URL에는 `https://auto-chatter.auto-chatter-ydm2790.workers.dev/privacy`를 사용합니다.
서비스 약관 URL에는 `https://auto-chatter.auto-chatter-ydm2790.workers.dev/service`를 사용합니다.
사용자 데이터 삭제 안내 URL을 요구하는 항목에는 `https://auto-chatter.auto-chatter-ydm2790.workers.dev/data-deletion`을 사용합니다.
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

이 서비스 전용 프로젝트를 사용합니다.
관리자 psql 연결은 비밀 관리 도구나 로컬 `PGSERVICE` 설정으로 제공하고 비밀번호를 명령 이력에 쓰지 않습니다.
신규 DB에는 두 파일을 한 트랜잭션으로 적용합니다.
`SUPABASE_ADMIN_SERVICE`는 비밀번호가 아닌 로컬 psql 서비스 이름입니다.

```bash
PGSERVICE="$SUPABASE_ADMIN_SERVICE" psql -X --set ON_ERROR_STOP=1 --single-transaction \
  --file db/schema.sql --file deploy/supabase-access.sql
```

현재 제품 테이블 아홉 개에 RLS를 켜고 `PUBLIC`, `anon`, `authenticated`, `service_role`의 접근 권한을 회수합니다.
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
이 실행 스크립트가 003–006 마이그레이션과 접근 권한 갱신을 한 트랜잭션으로 처리하며, 자세한 순서는 [다중 사용자 배포 전환](2026-09-26-multi-user-cutover.md)을 따릅니다.
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

| 이름                         | 위치                     | 용도                                                    |
| ---------------------------- | ------------------------ | ------------------------------------------------------- |
| `APP_ORIGIN`                 | `wrangler.json`의 `vars` | 경로·끝 슬래시 없는 정확한 HTTPS 서비스 origin          |
| `SUPABASE_URL`               | `wrangler.json`의 `vars` | Supabase 프로젝트 URL                                   |
| `INSTAGRAM_OAUTH_APP_ID`     | `wrangler.json`의 `vars` | Instagram 비즈니스 로그인 앱 ID, 메인 Meta 앱 ID와 구별 |
| `META_GRAPH_VERSION`         | `wrangler.json`의 `vars` | 실제 앱에서 사용할 Graph 버전                           |
| `SEND_ENABLED`               | `wrangler.json`의 `vars` | 전역 발송 스위치, 최초 배포는 문자열 `false`            |
| `SUPABASE_PUBLISHABLE_KEY`   | Worker secret            | Supabase Auth 호출용 공개 키                            |
| `INSTAGRAM_OAUTH_APP_SECRET` | Worker secret            | Instagram OAuth 앱 secret                               |
| `TOKEN_ENCRYPTION_KEY`       | Worker secret            | 32바이트 무작위 키의 canonical base64                   |
| `INSTAGRAM_APP_SECRET`       | Worker secret            | 웹훅 서명 검증                                          |
| `INSTAGRAM_VERIFY_TOKEN`     | Worker secret            | 웹훅 URL 구독 확인                                      |

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

댓글 관리 권한과 실제 비공개 답장 발송은 아직 검증되지 않았습니다.
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
