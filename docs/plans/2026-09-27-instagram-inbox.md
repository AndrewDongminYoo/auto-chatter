# Instagram 수신 인박스 구현 계획

## 작업 순서와 소유 경로

1. `src/app/settings.db.test.ts`에 보관·중복·역순·소유권 API 실패 테스트를 추가하고 실패를 관찰합니다.
2. `db/schema.sql`, migration 012, 관리자 runner와 서버 접근 스크립트에 인박스 저장소와 기본 꺼짐 설정을 추가합니다.
3. `src/instagram/inbox.ts`, `src/app/inbox.ts`, `src/app/api.ts`, `src/app/settings.ts`와 `follow-flow.ts`에 선택 저장·페이지 조회를 연결합니다.
4. `public/app/{index.html,app.js}`에 계정별 보관 설정과 대화 조회를 추가하고 세션·선택 변경 뒤 늦은 응답을 차단합니다.
5. 공개 개인정보 문구와 CLAUDE에 본문 보관 및 미구현 범위를 기록합니다.
6. 실제 DB·workerd·브라우저 검증과 독립된 데이터·보안 및 화면 리뷰를 수행합니다.
7. 의미 단위 커밋·PR·현재 커밋 CI와 호스팅 리뷰를 완료하고 화면 승인과 운영자 머지를 요청합니다.

## 검증 명령과 한계

- `corepack pnpm check-types`는 strict TypeScript 계약을 검사합니다.
- `corepack pnpm test`는 파서·인증 등 DB 없는 계약을 검사합니다.
- 로컬 `automations_test`를 지정한 `corepack pnpm test:db`는 실제 PostgreSQL 소유권·저장·중복·페이지를 검사합니다.
- 같은 격리 DB에서 `corepack pnpm test:cloudflare`는 실제 workerd·Hyperdrive·제한된 역할을 검사합니다.
- 변경 경로를 지정한 Trunk와 실제 브라우저에서 렌더링·세션·390px 가로 넘침을 확인합니다.

인박스 선택 활성화와 기존 수동 삭제 정책을 권장 기본값으로 사용합니다.
배포·운영 DB 변경·실발송은 이 계획에 포함하지 않습니다.
