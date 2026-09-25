# Messaging Automation Platform

ManyChat 유료 기능에 대응하는 자체 운영형 메시징 자동화 서비스를 만드는 저장소입니다.
현재는 Instagram 웹훅 수신, PostgreSQL 이벤트 저장, 댓글 키워드에 따른 개인 답장 요청 보관까지 구현했습니다.
외부 서비스 계정과 실제 메시지 발송은 연결하지 않았습니다.

## 문서

- [시장·API·오픈소스 조사](docs/notes/2026-09-25-manychat-research.md): ManyChat 요금제, 공식 연동 경로, 비용과 재사용 후보를 정리했습니다.
- [ChatbotX 채택 검증](docs/notes/2026-09-25-chatbotx-validation.md): 고정 커밋의 라이선스·설치·검사 결과와 직접 구현으로 전환한 근거를 기록했습니다.
- [Instagram 수신 검증](docs/notes/2026-09-25-ingress-validation.md): 실제 PostgreSQL 통합 테스트와 적대적 검토 결과를 기록했습니다.
- [제품·기술 명세](docs/specs/2026-09-25-messaging-automation-platform.md): 목표와 비목표, 기술 스택, 아키텍처, 과금과 AI 에이전트 경계를 정의했습니다.
- [구현 계획](docs/plans/2026-09-25-delivery-plan.md): 검증 순서, 단계별 완료 조건, 개발 에이전트 워크플로를 기록했습니다.

## 현재 결정

공식 플랫폼 API만 사용하고, 채널별 제한을 발송 직전에 검사합니다.
ChatbotX Community Edition의 현재 고정 커밋은 채택을 보류하고 최소 기능을 직접 구현합니다.
현재 수신기는 구독 확인과 원본 본문 서명을 검증하고, 활성 연결의 댓글만 저장합니다.
같은 댓글은 하나의 이벤트로 기록하고 같은 계정·게시물·발신자에게는 개인 답장 요청을 하나만 보관합니다.
요청은 `pending` 상태로만 남으며, 실제 발송은 계정 권한, 채널 정책, 재시도 경계를 구현한 뒤 연결합니다.

## 로컬 실행

Node.js 24, pnpm 10, PostgreSQL 17이 필요합니다.
개발용 일회성 DB는 다음처럼 시작하고 초기 스키마를 적용할 수 있습니다.

```bash
docker run --rm -d --name automations-postgres -p 127.0.0.1:5433:5432 -e POSTGRES_PASSWORD=local-dev -e POSTGRES_DB=automations postgres:17-alpine
docker exec -i automations-postgres psql -U postgres -d automations < db/schema.sql
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
```
