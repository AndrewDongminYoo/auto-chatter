# Cloudflare + Supabase 전환 계획

## 승인과 범위

2026-09-26 운영자가 Cloudflare + Supabase 방향을 승인했습니다.
이 계획은 로컬 구현과 검증을 다루며, 실제 리소스 생성·공개 배포·Meta 발송은 별도 운영 단계입니다.
기존 단일 서버 계획은 Compose 기반 로컬 검증과 대체 배포 경로로 유지합니다.

## 설계

- Workers `fetch`가 원문 서명과 1 MiB 제한을 검사하고 기존 `ingestComments` 트랜잭션을 호출합니다.
- PostgreSQL outbox가 발송 상태의 기준입니다. Queue는 연결 ID만 담은 처리 알림이며 개인정보나 토큰을 담지 않습니다.
- Queue 소비자는 알림당 최대 한 건을 기존 `processNextPrivateReply`로 처리합니다. 처리 가능한 다음 행이 있으면 알림을 다시 발행합니다.
- 매분 Cron이 10분 이상 중단된 `sending`을 `unknown`으로 정리하고, 처리 시각과 연결 cooldown을 통과한 `pending` 작업을 깨웁니다. DB 커밋 뒤 Queue 발행 실패도 이 경로로 복구합니다.
- Queue 중복 전달은 기존 claim과 상태 조건으로 처리합니다. `unknown`은 자동 재시도하지 않습니다.
- Hyperdrive는 이벤트별 `pg.Pool`을 사용하고 조회 캐시를 끕니다. 연결 활성 상태를 오래된 캐시로 판단해서는 안 됩니다.
- Supabase Direct 연결에 전용 서버 역할을 사용합니다. 제품 테이블에 RLS를 활성화하고 공개 역할의 권한을 회수합니다. 서버 역할에만 SELECT/INSERT/UPDATE 정책을 허용합니다.
- 초기 Cloudflare 배포는 Instagram Login 연결 하나를 처리합니다. `SEND_ENABLED` 기본값은 `false`입니다.

## 구현 순서와 검증

1. Workers 수신·Queue·Cron 어댑터와 회귀 테스트 → `corepack pnpm test:cloudflare`, `corepack pnpm check-types`.
2. Supabase 권한 SQL과 운영 절차 → 로컬 PostgreSQL에서 서버 DML 성공, 공개 역할 접근 실패, DELETE/DDL 거부 확인.
3. 기존 로컬 테스트와 CI 연결 → `corepack pnpm test`, `corepack pnpm test:db`, Workers dry-run, Trunk.
4. 독립적 로컬 리뷰의 확인된 결함을 수정하고 의미별로 커밋합니다.

## 비목표와 운영 경계

다중 계정 OAuth, UI, Supabase Auth, Realtime, D1, Durable Objects와 기존 발송 정책 개편은 포함하지 않습니다.
로컬 workerd 검증은 실제 Hyperdrive 캐시 설정, Supabase 네트워크 연결, Meta 권한이나 실제 발송 성공을 증명하지 않습니다.
전환 중 Compose 발송 워커와 Cloudflare 발송 소비자를 동시에 운영하지 않습니다.
Queue 알림 소실·중복 자체가 메시지 상태를 결정하지 않으므로 DB 복구와 지연 정책을 Queue 재시도 횟수에 의존시키지 않습니다.

## 근거

공식 문서는 2026-09-26 확인했습니다.

- [Hyperdrive와 node-postgres](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/): 기존 pg 드라이버와 `nodejs_compat`을 사용합니다.
- [Hyperdrive 조회 캐시](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/): 캐시는 기본 활성화이므로 배포 때 명시적으로 끕니다.
- [Queues 제한](https://developers.cloudflare.com/queues/platform/limits/): 소비자 실행은 유한하므로 무한 폴링 루프를 실행하지 않습니다.

운영자가 개인 LLM Wiki의 프로젝트 ID를 `auto-chatter`로 확인했습니다.
Oracle 런처는 `tomllib` 모듈 오류로 MCP 조회 전에 실패했으며, 개인 Wiki의 `wiki/entities/auto-chatter.md`와 `wiki/sources/auto-chatter--claude.md`를 로컬에서 직접 확인했습니다.
해당 기록은 `origin/main`의 `271c5dd` 기준으로, PostgreSQL outbox를 발송 상태의 기준으로 삼고 `unknown`을 자동 재발송하지 않으며 실계정 검증과 모의 테스트를 구분한다는 기존 결정을 확인합니다.
이 세 원칙을 전환 설계에도 유지합니다.
Wiki의 단일 서버 배포 설명은 이전 상태이므로 현재 승인된 Cloudflare + Supabase 방향을 대체하지 않습니다.
