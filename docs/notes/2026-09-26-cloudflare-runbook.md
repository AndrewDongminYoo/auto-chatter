# Cloudflare + Supabase 배포 절차

## 현재 상태

Cloudflare 어댑터와 로컬 검증 경로를 구현했습니다.
2026-09-26 승인된 개인 계정에서 Supabase 프로젝트와 Cloudflare 리소스를 생성하고 workers.dev에 배포했습니다.
발송은 `SEND_ENABLED=false`로 유지합니다.
`INSTAGRAM_APP_SECRET`과 `INSTAGRAM_VERIFY_TOKEN`의 등록을 확인했습니다.
Instagram Login 제품 설정에서 `comments` 구독이 활성화된 화면을 확인했고, 대시보드 테스트 직후 수신된 POST의 HTTP 200 응답을 Worker 로그로 확인했습니다.
첫 대시보드 테스트 당시에는 workspace·Instagram 연결·규칙이 없어 이벤트와 outbox도 0건이었습니다.
이후 운영자가 지정한 `ai.you.wanted`의 수신 연결을 등록했습니다.
실제 댓글 저장·발송 검증은 남아 있습니다.
아래 신규 DB 초기화와 리소스 생성 절차는 다른 환경을 준비할 때 사용하는 절차이며, 이미 생성한 환경에 다시 실행하지 않습니다.

| 리소스            | 현재 값                                                       |
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
수신 계정 ID와 연결 ID를 Worker 설정에 반영하고 Graph 버전은 제품 화면의 구독 버전과 같은 `v26.0`으로 지정합니다.
대시보드 예제의 계정 ID가 등록 계정과 다르면 HTTP 200이어도 저장 대상이 아니므로, 실제 댓글 저장 검증과 구분합니다.

## 구성

| 구성 요소                    | 역할                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| Workers `fetch`              | `/webhooks/instagram` 구독 확인, 원문 서명 검사, DB 저장    |
| Queue `auto-chatter-replies` | 연결 ID만 담는 처리 알림                                    |
| Workers `queue`              | 알림당 한 행 claim, 기존 정책 검사·발송, 다음 due 작업 알림 |
| 매분 Cron                    | 중단된 발송을 `unknown`으로 정리하고 due 작업 알림 복구     |
| Supabase PostgreSQL          | 이벤트·규칙·outbox·연결 cooldown의 영속 상태                |
| Hyperdrive                   | 이벤트별 DB 연결 중개, 조회 캐시는 비활성화                 |

Cloudflare 경로는 Instagram Login 연결 하나를 처리합니다.
다른 연결을 DB에 등록해도 해당 연결의 발송 소비자가 자동으로 생기지 않습니다.
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

제품 테이블 다섯 개에 RLS를 켜고 `PUBLIC`, `anon`, `authenticated`, `service_role`의 접근 권한을 회수합니다.
`auto_chatter_server`에만 SELECT·INSERT·UPDATE 정책과 필요한 sequence 접근을 허용합니다.
이 역할은 전체 서비스 데이터를 처리하는 신뢰된 서버 역할이며 클라이언트 사용자별 격리를 제공하지 않습니다.
`PUBLIC`의 public 스키마 CREATE도 회수하므로 공유 프로젝트에는 그대로 적용하지 않습니다.
새 테이블은 이 권한 파일에도 등록해야 합니다.
기존에 같은 이름의 역할에 관리자 속성, 다른 역할 membership, DB·스키마·테이블·시퀀스 소유권이 있으면 SQL은 중단합니다.

역할은 처음에 NOLOGIN으로 생성됩니다.
관리자 psql에서 아래 SQL을 실행한 뒤 `\password auto_chatter_server` 명령으로 비밀번호를 대화형 설정합니다.

```sql
ALTER ROLE auto_chatter_server LOGIN;
```

연결·규칙의 `active`와 `enabled`는 테스트 준비가 끝날 때까지 false로 유지합니다.
기존 DB 이전에는 별도의 백업·복원이 필요하며 현재 구현은 기존 데이터를 자동 복사하지 않습니다.

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
corepack pnpm exec wrangler secret put META_INSTAGRAM_ACCESS_TOKEN --env-file /dev/null
```

| 값                             | 설정                                  |
| ------------------------------ | ------------------------------------- |
| `META_GRAPH_VERSION`           | 실제 앱에서 사용할 Graph 버전         |
| `META_INSTAGRAM_ACCOUNT_ID`    | 토큰에 대응하는 전문 계정의 `user_id` |
| `META_INSTAGRAM_CONNECTION_ID` | 해당 계정의 DB 연결 UUID              |
| `SEND_ENABLED`                 | 최초 배포는 문자열 `false`            |

비밀이 아닌 Meta 설정 세 개는 `wrangler.json`의 `vars`에 추가합니다.
`META_LOGIN_MODE`는 이 어댑터에서 사용하지 않습니다.
Node 명령과 Docker는 기존 환경 설정을 유지합니다.
빌드는 `--env-file /dev/null`로 로컬 비밀 파일 자동 로드를 피합니다.

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

실제 바인딩과 운영 승인을 확인하고 배포합니다.

```bash
corepack pnpm exec wrangler deploy --env-file /dev/null
```

`SEND_ENABLED=false`에서 공개 주소의 구독 확인, 잘못된 서명 거부, 실제 댓글 event/outbox 저장, 중복 이벤트 제거를 먼저 확인합니다.
DB 저장 실패는 503을 반환합니다.
DB 커밋 뒤 Queue 발행 실패는 200을 반환하고 고정 오류 문구를 남기며, 발송 활성화 후 Cron이 due 작업을 복구합니다.

## 5. 발송 전환과 복구

댓글 관리 권한과 실제 비공개 답장 발송은 아직 검증되지 않았습니다.
첫 발송을 별도로 승인한 뒤 기존 Compose 발송 워커를 중지하고 `SEND_ENABLED=true`로 전환합니다.
Cron은 기존 pending 행도 처리하므로 활성화 전에 backlog를 검토합니다.

기존 발송 상태와 속도 제한 backoff를 유지합니다.
Queue 알림 재시도와 Meta 발송 재시도는 별개입니다.
소비자 오류로 다시 전달된 알림도 DB의 `sending`·완료 행을 다시 claim하지 않습니다.
알림 소실과 Queue 재시도 소진은 Cron이 복구하며 `unknown`은 수동 검토 대상으로 남습니다.
비활성 연결의 due 작업도 기존 워커 정책을 거쳐 `blocked`로 정리됩니다.
연결 cooldown이 있으면 기존 claim 정책대로 만료 후 처리합니다.
Queue 동시 실행 수는 1이며 이미 발송에 들어간 요청은 설정 변경으로 취소되지 않습니다.

장애 시 `SEND_ENABLED=false`로 배포하고 진행 중 요청 종료를 확인합니다.
DB 상태와 고정 오류 로그를 확인하고 `unknown`을 일괄 pending으로 되돌리지 않습니다.
롤백 때도 같은 DB를 유지하며 Cloudflare와 Node 발송 워커를 동시에 켜지 않습니다.
백업·복구 옵션과 요금은 선택한 Supabase 프로젝트 플랜에서 별도 확인합니다.

## 검증 경계

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
발송을 꺼 둔 상태이므로 실제 Cron 복구 실행, 댓글 저장, Meta 발송 권한과 실발송은 아직 검증하지 않았습니다.

2026-09-26 로컬에서 타입 검사, 기존 단위 테스트 46건, 기존 PostgreSQL 테스트 36건, Cloudflare 관련 테스트 15건, Docker 이미지 빌드를 통과했습니다.
발송 안전성과 DB 접근 권한에 대한 독립적 정적 리뷰를 수행했고, 비활성 연결의 정체·API 역할 권한 잔존·기존 역할 소유권 우회를 수정한 뒤 두 리뷰 모두 승인됐습니다.
