# Instagram 장기 토큰 자동 갱신 구현 계획

## 순서

1. 기존 계정 테이블에 토큰 취득·갱신 시도 시각을 추가하는 마이그레이션과 신규 설치용 스키마를 수정합니다.
1. 격리된 DB 테스트에 활성·토큰 나이·만료일 선별, 실패 후 재시도, 경합과 재연결 중 갱신 결과 폐기를 먼저 작성하고 실패를 확인합니다.
1. 토큰 갱신 함수를 추가하고 Cloudflare 예약 작업에서 전체 발송 스위치와 독립적으로 호출합니다.
1. OAuth 재연결 시 갱신 제한을 초기화하고 계정 안내 문구를 현재 동작에 맞게 바꿉니다.
1. 타입 검사, 단위 테스트, 격리된 DB 테스트, Cloudflare 빌드와 로컬 리뷰를 완료한 뒤 작은 커밋과 PR을 준비합니다.

## 수정 범위

`db/schema.sql`, 새 `db/migrations/015_*.sql`, `src/app/instagram-oauth.ts`, `src/app/instagram-token-refresh.ts`, `src/cloudflare/index.ts`, `public/app/app.js`와 해당 테스트 및 배포 문서만 수정합니다.
운영 DB와 Cloudflare의 실제 설정은 변경하지 않습니다.

## 확인 방법

```bash
corepack pnpm check-types
corepack pnpm test
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:db
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:cloudflare
corepack pnpm build:cloudflare
```

DB 테스트는 임시 로컬 PostgreSQL에서만 실행합니다.
화면 변경은 로그인된 계정 예시에서 안내 문구를 렌더링해 검토합니다.
