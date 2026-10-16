# 목적별 동의 기록 필터 구현 계획

## 계약과 소유 범위

[동의 기록 필터 계약](../specs/2026-10-16-segment-consent-state.md)을 기존 세 소비 경로에 적용합니다.
`src/app/contacts.ts`의 입력 검증과 SQL 판정을 공유하고 발송·원장 쓰기·DM 식별자 연결 코드는 바꾸지 않습니다.
제외 사유는 기존 활동 기간 우선순위를 보존한 뒤 동의 기록, 태그·필드 순서로 계산합니다.

## 순서와 검사

1. `src/app/api.test.ts`와 `settings.db.test.ts`에 실패하는 입력·범위·현재 상태·분류 회귀 검사를 작성합니다.
   기존 구현이 새 키를 거절하는 의도한 실패를 먼저 확인합니다.
2. `db/schema.sql`, `db/migrations/047_contact_segment_consent.sql`, `deploy/migrate-multi-user.sql`에 목적·상태의 nullable 쌍과 허용값 제약을 추가합니다.
   기존 행 보존·반복 실행·잘못된 쌍과 enum 거절을 확인합니다.
3. `src/app/contacts.ts`에 한 입력 검증과 정확한 comment_sender 범위 판정을 구현합니다.
   목록·미리보기·저장 필터의 동일 결과, 작업 공간 격리, 다른 목적/DM 무시, 철회와 재동의 반영, 50+5 페이지를 실제 DB로 검사합니다.
4. `public/app/app.js`·`index.html`에 두 선택 입력과 제외 요약을 연결합니다.
   실제 브라우저에서 초안·저장·선택·보관·0명·오류·무효화·편집값 보존을 검사합니다.
5. `src/cloudflare/runtime.db.test.mjs`에서 제한된 DB 역할의 HTTP 저장·조회·보관을 검증합니다.
   합성 데이터의 실제 SQL 실행계획과 읽기 비용을 기록합니다.
6. CLAUDE·기존 연락처/세그먼트/활동/미리보기 명세·수용 매트릭스와 검증 기록을 맞춥니다.
   PR208 감사에서 확인한 수용표 서두의 활동 조건 잔여 범위도 명확히 합니다.
7. 타입·단위·격리 DB·workerd·Trunk 검사와 독립 리뷰 후 커밋·PR·CI·호스팅 코드/보안 리뷰를 완료합니다.
   운영자의 시각 승인 뒤 병합은 운영자에게 맡깁니다.

최소 검증은 `corepack pnpm check-types`, `corepack pnpm test`, 로컬 격리 `automations_test`의 `corepack pnpm test:db`·`corepack pnpm test:cloudflare`, `trunk check --no-fix <변경 경로>`입니다.
새 의존성·운영 작업·추가 채널 정책은 도입하지 않습니다.

## 결정 근거

Advisor의 제안에 따라 상태 enum은 `granted|revoked|no_record`로 한정하고 유효한 발송 동의라는 의미를 부여하지 않습니다.
기존 contact-details의 정확한 식별자별 기록 조회를 따르되 DM 기록은 이 필터로 옮기지 않습니다.
Oracle의 `consent filter`, `comment_sender` 검색에서는 관련 선례를 찾지 못했습니다.
