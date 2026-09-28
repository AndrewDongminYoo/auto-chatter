# 비밀번호 복구 구현 계획

1. `src/app/auth.test.ts`와 `src/app/api.test.ts`에 복구 요청의 균일 응답, 토큰 검증, 비밀번호 변경, 실패 분류를 먼저 검사합니다.
   검증: 새 테스트가 구현 전 실패해야 합니다.
2. `src/app/auth.ts`와 `src/app/api.ts`에 복구 요청 및 비밀번호 변경 경로를 추가합니다.
   검증: 대상 테스트와 `corepack pnpm check-types`가 통과해야 합니다.
3. `public/app/index.html`, `public/app/app.js`, `public/app/styles.css`에 요청·변경 화면을 추가하고 URL 조각을 즉시 제거합니다.
   검증: 실제 브라우저에서 데스크톱·모바일 화면, 키보드 접근과 링크 오류를 확인합니다.
4. 관련 단위 검사와 번들 빌드를 실행하고, 변경분을 적대적으로 검토한 뒤 범위별로 커밋합니다.
   검증: `corepack pnpm test`, `corepack pnpm check-types`, `corepack pnpm build:cloudflare`와 변경분 검토 결과를 기록합니다.
