# 마지막 댓글 저장 기간 필터 구현 계획

## 목표와 소유 범위

[활동 기간 계약](../specs/2026-10-16-segment-comment-activity.md)을 저장된 세그먼트·일반 목록·미리보기에 적용합니다.
계정 범위 다음에 기간 밖 연락처를 먼저 제외하고 기간 안에서 기존 태그/필드 사유를 구분합니다.
기존 요청과 응답의 형태는 기간을 지정하지 않으면 유지합니다.
새 의존성과 운영 작업은 추가하지 않습니다.

## 순서와 성공 기준

1. `src/app/api.test.ts`, `src/app/settings.db.test.ts`, `src/cloudflare/runtime.db.test.mjs`에 기간 계약 회귀 검사를 작성합니다.
   검증: 기존 구현에서 기간 키 거절이나 저장 컬럼 부재로 실패한 뒤, 유효한 UTC 구간·경계·분류·저장 조건을 통과합니다.
2. `db/schema.sql`, `db/migrations/046_contact_segment_activity.sql`, `deploy/migrate-multi-user.sql`에 nullable 구간과 쌍·순서·유한값 제약을 추가합니다.
   검증: 기존 데이터 유지, 반복 실행, 잘못된 구간 거절과 제한된 서버 역할의 접근을 확인합니다.
3. `src/app/contacts.ts`에 하나의 기간 입력 검증과 공유 SQL 판정을 추가합니다.
   검증: 마지막 댓글 그룹에 필터를 적용하고 OR 우회·다른 작업 공간 누출·중복 집계 없이 목록/미리보기/저장 결과가 맞습니다.
4. `public/app/app.js`·`index.html`에 UTC 기간 입력과 제외 사유를 연결합니다.
   검증: 실제 브라우저에서 UTC 변환·기간 보존·누락 요약 실패·기존 편집값 및 늦은 응답 보호를 확인하고 데스크톱·모바일 화면을 보존합니다.
5. 합성 로컬 데이터에서 실제 SQL의 `EXPLAIN (ANALYZE, BUFFERS)`를 기록합니다.
   검증: 최근 댓글 판정과 미리보기 집계의 비용 및 제한을 문서로 남깁니다.
6. `CLAUDE.md`, 기존 연락처·세그먼트·미리보기 명세, 수용 매트릭스와 새 검증 기록을 같은 PR에서 맞춥니다.
   README·AGENTS는 해당 설명을 대조하고 기존 검증 이력은 보존합니다.
7. 타입·단위·격리된 UTF-8 DB·Cloudflare·변경 경로 Trunk 검사와 독립 로컬 리뷰를 마친 뒤 커밋·PR·호스팅 CI/리뷰를 진행합니다.
   병합 전 운영자의 화면 승인을 받고 병합은 운영자에게 맡깁니다.

최소 검사 명령은 `corepack pnpm check-types`, `corepack pnpm test`, 격리된 로컬 `automations_test`의 `corepack pnpm test:db`·`corepack pnpm test:cloudflare`, `trunk check --no-fix <변경 경로>`입니다.

## 결정 근거

Advisor의 의견에 따라 상대 일수 대신 고정 UTC `[from,before)` 구간으로 한정합니다.
기존 `last_comment_at`의 저장 시각 의미를 그대로 사용하며 공급자 작성 시각으로 표현하지 않습니다.
세 개 조건의 모든 불일치 조합을 추가하는 대신 기간 제외를 먼저 분류하는 계약으로 중복을 막습니다.
Oracle의 정확한 주제 검색은 `[no precedent found]`, 확대 lexical 검색은 11개 중 10개로 `[PARTIAL]`이었습니다.
