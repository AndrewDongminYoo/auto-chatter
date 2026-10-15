# 연락처 CSV 내보내기 요청 한도 구현 계획

## 계약과 범위

[#196](https://github.com/AndrewDongminYoo/auto-chatter/issues/196)의 사용자별 1시간 고정 창 5회 제한을 적용합니다.
기존 [CSV 명세](../specs/2026-10-04-contact-csv-export.md)와 [API 요청 한도 명세](../specs/2026-10-12-api-request-limits.md)를 갱신합니다.
작업 공간 JSON 내보내기와 별도 한도를 사용하고, 제한기를 사용할 수 없으면 요청을 거절합니다.
CSV 내용, 관리자 권한, DB 스키마, 의존성, 운영 배포는 변경하지 않습니다.

## 구현 순서와 소유 파일

1. `src/app/api.test.ts`에 한도 초과·바인딩 누락·제한기 예외 시 DB 풀을 열지 않는 회귀 테스트를 추가하고 기존 코드에서 실패를 확인합니다.
2. `src/cloudflare/auth-limiter.test.ts`에서 여섯 번째 요청 거절, 다른 사용자와 JSON 내보내기의 독립성, 한 시간 뒤 재개를 검증합니다.
3. `src/app/auth-rate-limit.ts`, `src/cloudflare/auth-limiter.ts`, `src/app/api.ts`에 `CONTACT_EXPORT_LIMIT`를 추가합니다.
   세션 확인과 쿼리 매개변수 검증 뒤, DB 풀을 열기 전에 한도를 검사합니다.
   허용된 요청은 기존 내보내기 처리기의 역할·소유권 검증을 거칩니다.
4. `public/app/app.js`의 기존 오류 사전에 한도 초과와 일시 불가 문구를 추가합니다.
5. `src/cloudflare/runtime.db.test.mjs`에서 실제 Durable Object를 거친 여섯 번째 CSV 요청 거절과 JSON 내보내기의 독립성을 검증합니다.
   `src/app/contact-csv.db.test.ts`의 허용된 요청 설정에 새 바인딩을 전달하여 기존 CSV 내용·권한 검증을 유지합니다.
6. 명세와 최종 diff를 검토하고 아래 검증을 마친 뒤 하나의 수정 커밋으로 PR을 만듭니다.

## 검증

- 최소 회귀 명령: `node --test src/app/api.test.ts src/cloudflare/auth-limiter.test.ts`.
- 전체 단위 테스트: `corepack pnpm test`.
- 타입 검사: `corepack pnpm check-types`.
- 변경 파일만 명시하여 `trunk fmt`와 `trunk check --no-fix`를 실행합니다.
- CI의 `test:db`와 `test:cloudflare`에서 실제 PostgreSQL 권한과 Worker 바인딩을 확인합니다.
- CI 및 호스팅 리뷰가 끝나면 병합을 요청합니다.
  운영 배포, 운영 DB 접근, 실발송, 브랜치 삭제, 메모리 기록은 포함하지 않습니다.
