# Instagram 게시물 선택기 구현 계획

## 승인된 방향

게시물 선택기를 먼저 구현하고 PR로 검토합니다.
기존 발송 설정은 변경하지 않습니다.

## 순서와 소유 범위

1. `src/app/api.test.ts`에 인증된 목록과 계정 격리 회귀 테스트를 추가하고 기존 404 실패를 관찰합니다.
2. `src/app/instagram-media.ts`, `src/app/api.ts`에 계정에 묶인 목록·상세 조회와 신규 규칙 검증을 구현합니다.
3. `public/app/{index.html,app.js,styles.css}`에 선택 목록, 다음 페이지, 재시도와 규칙 대상 표시를 구현합니다.
4. 필요한 DB 격리 테스트를 기존 `src/app/settings.db.test.ts`에 추가합니다.
5. 타입 검사, unit/DB 테스트, Worker 번들, 브라우저 상태 점검과 로컬 적대적 리뷰를 실행합니다.
6. 서버 기능, 화면 기능, 문서를 의미 단위로 커밋하고 PR을 올립니다.
7. 현재 PR head의 CI와 호스팅 리뷰를 확인한 뒤 화면 승인과 운영자 병합을 기다립니다.

## 최소 검증

```bash
corepack pnpm check-types
corepack pnpm test
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:db
corepack pnpm build:cloudflare
```

브라우저 fixture에서 선택·다음 페이지·계정 변경·오류 재시도·빈 목록·기존 규칙 수정·모바일·키보드를 확인합니다.
PR 화면 승인은 구현 결과와 head SHA에 대해 별도로 받습니다.
