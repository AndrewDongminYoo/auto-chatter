# 필터 제외 사유 미리보기 계획

## 범위와 계약

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 저장 전 제외 사유를 현재 태그·단일 필드 조건에 한정해 구현합니다.
선택 계정이 없으면 작업 공간 전체, 있으면 해당 계정의 저장된 댓글 연락처가 평가 범위입니다.
다른 계정은 제외 사유 집계에 넣지 않습니다.
같은 SQL 문장에서 `evaluated`, 기존 `total`, 상호 배타적인 `excluded.tag`, `excluded.field`, `excluded.both`와 최대 50명 샘플을 반환합니다.
모든 수는 10진수 문자열이며 `evaluated = total + tag + field + both`입니다.
AND는 태그만·필드만·둘 다 불일치를 구분하고 OR는 둘 다 불일치만 제외합니다.
없는 조건은 만족한 것으로 취급합니다.
일치 대상이 0명이어도 요약을 반환하며 일반 목록과 미리보기의 커서 거절 계약은 유지합니다.
스키마·조건 종류·발송 자격·동의·대상 고정은 바꾸지 않습니다.

## 작업과 검증

1. `src/app/api.test.ts`, `src/app/settings.db.test.ts`, `src/cloudflare/runtime.db.test.mjs`에 새 요약 계약 검사를 추가합니다.
   검증: 기존 구현에서 `evaluated`·`excluded` 누락으로 실패한 뒤 AND/OR·조건 없음·0명·중복 댓글·계정/작업 공간 범위와 큰 정수 문자열을 통과합니다.
2. `src/app/contacts.ts`의 조건 표현식을 공유하고 미리보기에서만 평가 집합의 요약과 기존 제한된 샘플을 단일 문장으로 읽습니다.
   검증: 일반 목록의 응답·페이지 처리가 유지되고 합계가 정확히 맞습니다.
3. `public/app/app.js`와 `public/app/index.html`에서 평가 범위·일치 수·제외 사유를 구분해 표시합니다.
   검증: 합성 응답을 쓰는 실제 브라우저에서 초안·편집값 보존, 잘못된 요약 실패, 늦은 응답 무효화, 모바일·키보드와 텍스트 렌더링을 확인합니다.
4. 실제 조회 SQL과 바인딩으로 로컬 합성 데이터의 `EXPLAIN (ANALYZE, BUFFERS)`를 기록합니다.
   필터를 통과하지 못한 대상도 읽는 비용을 명시하며 운영 지연 시간을 보증하지 않습니다.
5. 타입·단위·격리 DB·Cloudflare와 변경 파일의 Trunk 검사를 실행합니다.
   최소 명령은 `corepack pnpm check-types`, `corepack pnpm test`, 로컬 UTF-8 `automations_test`의 `corepack pnpm test:db`·`corepack pnpm test:cloudflare`, `trunk check --no-fix <변경 경로>`입니다.
6. 기존 명세·수용 매트릭스·CLAUDE·README·AGENTS에서 구현으로 바뀐 주장을 같은 PR에 반영하고 독립 리뷰와 호스팅 CI·리뷰를 완료합니다.
   화면 자료를 보존하고 병합 전 운영자 승인을 받습니다.

## 결정 근거와 한계

기존 `count(*) OVER()`만으로는 0명 일치일 때 제외 사유를 반환할 수 없어, 빈 입력에도 한 행을 반환하는 집계와 제한된 샘플의 결합이 필요합니다.
분류 집합에서는 연락처 상세 필드 JSON을 전부 만들지 않고 조건 판정만 계산합니다.
#26은 작은 PR 분할을 허용하며 이 계약은 제외 사유의 일부 범위입니다.
동의·활동 조건과 캠페인 대상 고정 등 남은 조건은 유지합니다.
Advisor의 범위 조정 의견을 반영했으며 Oracle의 정확 검색은 `[no precedent found]`, 확대 검색은 11개 후보 중 10개 반환으로 `[PARTIAL]`입니다.
