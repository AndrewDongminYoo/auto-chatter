# Messaging Automation Platform

ManyChat 유료 기능에 대응하는 자체 운영형 메시징 자동화 서비스를 만드는 저장소입니다.
Instagram 댓글·DM 웹훅 수신, 사용자별 로그인·계정 연결·규칙 설정, 댓글 키워드별 첫 DM과 응답 후 팔로우 조건별 후속 DM을 구현했습니다.
다중 사용자 코드와 DB 마이그레이션은 2026-09-26에 운영 배포했으며 발송은 비활성화했습니다.
운영자의 이메일 인증·작업 공간 소유권 배정·Instagram OAuth 연결과 실제 첫 비공개 답장 1건의 발송·수신을 확인했습니다.
이후 승인된 새 게시물에서 첫 DM → 미팔로우 안내 → 팔로우 후 완료 DM의 실제 수신과 DB 상태를 확인하고 발송을 다시 중지했습니다.
여러 실제 사용자 간 격리·Advanced Access 검증은 남아 있습니다.
Instagram Login과 Facebook Login용 Meta Graph 어댑터와 별도 발송 워커 명령이 있습니다.
운영자는 Meta 개발자 대시보드에서 일반 DM 발송에 성공했다고 보고했습니다.
운영자가 실행한 `meta:check`에서 토큰의 Instagram 계정 ID와 설정값이 일치하는 것도 확인했습니다.
실제 댓글 조회와 이 저장소의 Cloudflare 워커를 통한 댓글 비공개 답장 1건의 발송·수신도 확인했습니다.

## 문서

- [시장·API·오픈소스 조사](docs/notes/2026-09-25-manychat-research.md): ManyChat 요금제, 공식 연동 경로, 비용과 재사용 후보를 정리했습니다.
- [ChatbotX 채택 검증](docs/notes/2026-09-25-chatbotx-validation.md): 고정 커밋의 라이선스·설치·검사 결과와 직접 구현으로 전환한 근거를 기록했습니다.
- [Instagram 수신 검증](docs/notes/2026-09-25-ingress-validation.md): 실제 PostgreSQL 통합 테스트와 적대적 검토 결과를 기록했습니다.
- [Meta 권한과 발송 워커](docs/notes/2026-09-25-meta-permissions-and-worker.md): 공식 권한 조건, 발송 상태, 실제 계정 확인에 남은 조건을 기록했습니다.
- [제품·기술 명세](docs/specs/2026-09-25-messaging-automation-platform.md): 목표와 비목표, 기술 스택, 아키텍처, 과금과 AI 에이전트 경계를 정의했습니다.
- [다중 사용자 자동화](docs/specs/2026-09-26-multi-user-automations.md): 사용자별 계정 연결과 응답 후 팔로우 확인 흐름입니다.
- [다중 사용자 배포 전환](docs/notes/2026-09-26-multi-user-cutover.md): 검증 결과, 외부 설정, 마이그레이션과 수동 삭제 절차입니다.
- [첫 실발송 테스트](docs/notes/2026-09-26-first-live-reply-test.md): 실제 수신·공급자 응답 대조, 소유권 ID 수정과 테스트 후 발송 중지 결과입니다.
- [팔로우 분기 실발송 테스트](docs/notes/2026-09-26-live-follow-test.md): 승인한 문구, 대상 게시물, 진행 단계와 종료 후 중지 절차입니다.
- [구현 계획](docs/plans/2026-09-25-delivery-plan.md): 검증 순서, 단계별 완료 조건, 개발 에이전트 워크플로를 기록했습니다.

## 현재 결정

공식 플랫폼 API만 사용하고, 채널별 제한을 발송 직전에 검사합니다.
ChatbotX Community Edition의 현재 고정 커밋은 채택을 보류하고 최소 기능을 직접 구현합니다.
현재 수신기는 구독 확인과 원본 본문 서명을 검증하고, 활성 연결의 댓글만 저장합니다.
같은 댓글은 하나의 이벤트로 기록하고 같은 계정·게시물·발신자에게는 개인 답장 요청을 하나만 보관합니다.
Facebook Login 어댑터는 토큰 권한, Page와 Instagram 계정 연결, 댓글 생성 시각과 미디어 소유를 발송 직전에 확인합니다.
Instagram Login 어댑터는 Instagram 사용자 토큰의 계정 ID와 댓글·미디어 소유를 확인하고 `graph.instagram.com`에 개인 답장을 요청합니다.
`corepack pnpm start`는 웹훅 수신기만 시작합니다.
`corepack pnpm worker:instagram`은 설정된 단일 연결에 대해 실제 발송을 수행하므로 Meta 앱과 테스트 계정에서 권한을 확인한 뒤에 실행해야 합니다.

## 로컬 실행

운영 배포 방향은 **Cloudflare Workers + Queues + Supabase PostgreSQL**입니다.
Hyperdrive를 통해 DB에 연결하며, 매분 예약 실행으로 누락된 처리 알림과 지연 작업을 복구합니다.
현재 구현은 여러 Instagram Login 연결의 암호화 토큰을 DB에서 읽고 계정별로 처리하며 발송은 기본 비활성화입니다.
`/app/`에서 사용자별 계정을 연결하고 게시물을 사진·본문·날짜로 선택해 키워드·답장·팔로우 조건과 최근 처리 상태를 관리합니다.
게시물 선택기의 검증 범위와 남은 확인은 [사용성 검증 기록](docs/notes/2026-09-26-media-picker-usability.md)에 정리했습니다.
Supabase Auth 및 OAuth secrets와 마이그레이션은 아래 배포 전환 문서에 따라 설정해야 합니다.
설정과 전환 순서는 [Cloudflare 배포 절차](docs/notes/2026-09-26-cloudflare-runbook.md), 구현 범위는 [전환 계획](docs/plans/2026-09-26-cloudflare-supabase.md)을 따릅니다.
2026-09-26 Supabase 서울 리전 프로젝트와 Cloudflare Queue·Hyperdrive를 생성하고 Worker를 workers.dev에 배포했습니다.
발송 기본값과 현재 배포의 규칙·계정·전역 스위치는 모두 비활성화입니다.
웹훅 secrets 두 개의 등록과 잘못된 검증 토큰·서명 없는 요청의 거부를 확인했습니다.
Meta 대시보드에서 전송한 테스트 웹훅의 HTTP 200 응답도 확인했습니다.
운영 DB의 두 테스트 규칙과 해당 계정의 발송은 비활성화 상태이며 미완료 outbox·팔로우 대화는 없습니다.
실제 테스트 댓글 저장, 첫 비공개 답장과 미팔로우·팔로워 후속 DM 수신을 2026-09-26에 확인했습니다.

로컬 통합 환경과 단일 서버 대체 배포에는 `Dockerfile`과 `compose.yaml`을 사용합니다.
기본 실행은 DB와 수신기만 시작하며, 실제 발송과 공개 HTTPS는 각각 `send`와 `public` 프로필로 활성화합니다.
환경 설정, 백업·복원과 업데이트 절차는 [배포 운영 절차](docs/notes/2026-09-26-deployment-runbook.md)를 따릅니다.

Node.js 24, pnpm 10, PostgreSQL 17이 필요합니다.
개발용 일회성 DB는 다음처럼 시작하고 초기 스키마를 적용할 수 있습니다.

```bash
docker run --rm -d --name automations-postgres -p 127.0.0.1:5433:5432 -e POSTGRES_PASSWORD=local-dev -e POSTGRES_DB=automations postgres:17-alpine
docker exec -i automations-postgres psql -U postgres -d automations < db/schema.sql
```

기존 스키마로 만든 DB에는 아직 적용하지 않은 001·002 마이그레이션을 먼저 적용합니다.
이후 003–006과 서버 접근 정책은 전용 실행 파일로 한 트랜잭션에서 적용합니다.
오류가 나면 전체 트랜잭션이 롤백되며, 성공하기 전에는 새 수신기와 워커를 배포하지 않습니다.

```bash
docker exec -i automations-postgres psql -v ON_ERROR_STOP=1 -U postgres -d automations < db/migrations/001_reply_worker.sql
docker exec -i automations-postgres psql -v ON_ERROR_STOP=1 -U postgres -d automations < db/migrations/002_rate_limit_backoff.sql
# 저장소 루트에서 PostgreSQL 클라이언트(psql)로 실행합니다.
psql postgres://postgres:local-dev@127.0.0.1:5433/automations -f deploy/migrate-multi-user.sql
```

활성 Instagram 연결과 키워드 규칙은 `db/schema.sql`의 테이블에 별도로 등록해야 합니다.
실제 계정 ID와 Meta 앱 비밀값을 준비한 뒤 환경 변수를 설정하고 서버를 시작합니다.

```bash
export DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations
export INSTAGRAM_APP_SECRET=your-app-secret
export INSTAGRAM_VERIFY_TOKEN=your-verify-token
corepack pnpm install --frozen-lockfile
corepack pnpm start
```

수신 경로는 `GET/POST /webhooks/instagram`입니다.
기본 주소는 `127.0.0.1:3000`이며 배포 프록시에서 접근할 때는 `HOST`와 `PORT`를 설정합니다.
개발용 DB 종료는 `docker stop automations-postgres`입니다.

## Meta 권한 확인과 발송 워커

다음 환경 변수는 서버에서만 설정합니다.
토큰 값은 저장소나 검사 결과에 기록하지 않습니다.

| 변수                                                                             | 용도                                                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `META_LOGIN_MODE`                                                                | `instagram`은 현재 앱의 Instagram Login 경로입니다. 생략하면 기존 `facebook` 경로를 사용합니다.     |
| `META_GRAPH_VERSION`                                                             | 앱에서 사용할 명시적 Graph API 버전입니다.                                                          |
| `META_INSTAGRAM_ACCESS_TOKEN`                                                    | Instagram Login 경로의 Instagram 사용자 토큰입니다.                                                 |
| `META_APP_ID`, `META_APP_ACCESS_TOKEN`, `META_USER_ACCESS_TOKEN`, `META_PAGE_ID` | Facebook Login 경로에서만 앱 권한과 Page 연결을 확인합니다.                                         |
| `META_INSTAGRAM_ACCOUNT_ID`                                                      | 전문 계정의 `user_id`입니다. Meta 앱 ID나 Instagram 앱 ID와 다릅니다.                               |
| `META_INSTAGRAM_CONNECTION_ID`                                                   | 발송 워커가 처리할 DB 연결 하나입니다. Instagram Login의 읽기 전용 계정 확인에는 필요하지 않습니다. |
| `DATABASE_URL`                                                                   | 발송 워커가 outbox에 접근할 때 필요합니다.                                                          |

현재 앱은 Instagram Login 사용 사례를 설정했으므로 `META_LOGIN_MODE=instagram`을 지정합니다.
이 경로에서 `corepack pnpm meta:check`는 토큰의 전문 계정 ID만 읽기 전용으로 확인하며, 부여된 권한 범위와 실제 발송 가능 여부는 증명하지 않습니다.
패키지 명령은 로컬 환경 변수 파일을 자동으로 읽지 않으므로, 실행 전에 필수 변수를 현재 셸로 내보내야 합니다.
Facebook Login 경로에서는 토큰 범위, Page 연결과 `MESSAGING` 작업을 확인합니다.
앱 검수와 실제 발송 성공은 어느 경로에서도 별도 확인이 필요합니다.
전문 계정과 토큰을 준비하고 권한을 확인한 뒤 `corepack pnpm worker:instagram`을 실행합니다.
발송 결과가 불명확한 요청은 `unknown`으로 남기며 자동으로 재발송하지 않습니다.

## 로컬 확인

일반 테스트는 DB가 필요하지 않습니다.
DB 통합 테스트는 별도의 로컬 `automations_test` DB만 사용하며 해당 DB의 제품 테이블을 초기화합니다.
위 개발용 컨테이너를 사용한다면 테스트 DB를 한 번 생성합니다.

```bash
docker exec automations-postgres createdb -U postgres automations_test
```

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check-types
corepack pnpm test
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:db
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:cloudflare
```

`test:cloudflare`는 배포하지 않고 번들을 만든 뒤 로컬 workerd·PostgreSQL·가짜 Graph 응답으로 검증합니다.
Supabase 권한 SQL 테스트는 격리된 테스트 DB 서버에서만 실행합니다.
