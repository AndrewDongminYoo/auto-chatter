# 인박스 답장 화면 구현 계획

## 작업 순서

1. `src/app/settings.db.test.ts`에 reply-status의 소유권과 정책 사례를 먼저 실패시킵니다.
2. `src/instagram/manual-reply-worker.ts`의 판정을 공유하는 읽기 결과와 `src/app/manual-replies.ts`, `src/app/api.ts`의 소유권 적용 GET을 추가합니다.
3. 기존 인박스 영역을 `public/app/inbox.js`로 분리하고 `public/app/app.js`, `index.html`, `styles.css`에 작성기와 이력을 연결합니다.
4. 합성 브라우저에서 작성기가 없는 실패를 확인한 뒤 대화별 상태·UUID 재사용·후속 작업·페이지 로딩을 구현합니다.
5. 관련 테스트와 실제 브라우저 검증, 적대적 리뷰의 수정, 의미별 커밋과 PR, CI·호스팅 리뷰를 순서대로 진행합니다.
6. 현재 커밋의 데스크톱·모바일 화면 승인을 요청하고 운영자의 병합을 기다립니다.

## 완료 검사

- `corepack pnpm check-types`, `corepack pnpm test`.
- 격리된 `automations_test` DB에서 `corepack pnpm test:db`와 `corepack pnpm test:cloudflare`.
- 수정한 경로의 Trunk 검사와 staged diff 확인.
- 이름을 지정한 agent-browser 세션에서 합성 API만 사용한 UI 시나리오·스크린샷과 종료 확인.
- PR의 현재 head에 연결된 CI, 코드·보안 리뷰와 전체 리뷰 스레드 확인.

## 주요 위험

접수 응답 유실을 공급자 `unknown`과 혼동하지 않아야 합니다.
접수 확인은 동일 UUID·payload를 재사용하고, 공급자 `unknown`에는 재전송을 제공하지 않습니다.
서버 조회 이후 제한이 바뀔 수 있으므로 실제 예약·발송의 검사를 유지합니다.
대화와 세션이 바뀌어도 늦은 응답이 현재 작성기를 바꾸지 않도록 요청 소유권을 검사합니다.
