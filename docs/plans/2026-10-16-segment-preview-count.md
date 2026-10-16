# 필터 초안의 전체 대상 수 계획

## 범위와 계약

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 [초안 미리보기 계약](../specs/2026-10-16-segment-draft-preview.md)에 정확한 조회 시점의 대상 수를 추가합니다.
기존 `GET /api/contacts`의 명시적인 `preview=true`만 전체 수를 집계하고 `total`을 10진수 문자열로 반환합니다.
미리보기에는 페이지 커서를 허용하지 않으며 일반 목록의 질의와 응답 형태를 유지합니다.
스키마·의존성·발송 경계는 바꾸지 않습니다.

## 순서와 검증

1. 기존 API·DB 테스트에 strict preview 요청과 0·1·50·51명 초과·중복 댓글·필터·작업 공간 격리를 추가하고 구현 전 실패를 확인합니다.
2. `src/app/contacts.ts`에서 같은 단일 SQL 문장의 그룹별 집계와 제한된 목록을 반환합니다.
   SQL 결과가 비어 있으면 `total`은 `"0"`이며 행 내부의 집계용 필드는 응답 연락처에 노출하지 않습니다.
3. `public/app/app.js`의 독립 미리보기만 새 모드를 사용하고 전체 수와 최대 5명 예시를 구분합니다.
   적용된 목록·편집값·기존 요청 무효화 처리는 유지합니다.
4. 로컬 PostgreSQL의 대표 합성 데이터로 일반·미리보기 질의의 `EXPLAIN (ANALYZE, BUFFERS)`를 비교합니다.
   측정은 해당 표본의 비용만 보여 주며 운영 지연 시간을 보증하지 않습니다.
5. 타입·단위·DB·workerd 검사를 실행하고 실제 브라우저에서 전체 수·빈 결과·실패·늦은 응답·모바일 화면을 확인합니다.
6. `CLAUDE.md`, `README.md`, `AGENTS.md`와 직접 관련 명세·매트릭스를 대조해 구현으로 바뀐 주장을 같은 PR에서 고칩니다.
7. 전체 diff를 검토하고 현재 커밋의 CI·호스팅 리뷰를 확인한 뒤 보이는 화면 자료로 운영자의 시각 승인을 받습니다.

## 담당 파일과 완료 조건

구현은 연락처 조회·초안 미리보기, 검사는 기존 API·settings DB·workerd 파일에 한정합니다.
관련 문서는 연락처·세그먼트·초안 미리보기 명세, 수용 매트릭스와 이번 계획·검증 기록입니다.
최소 명령은 `corepack pnpm check-types`, `corepack pnpm test`, 격리된 `TEST_DATABASE_URL`의 `corepack pnpm test:db`·`corepack pnpm test:cloudflare`, 변경 파일의 `trunk check --no-fix`입니다.
정확한 전체 수 이외의 제외 사유·동의/활동 조건·캠페인 대상 고정과 운영 검증은 #26에 남깁니다.
