# Instagram 연락처 구현 계획

## 범위

기존 TypeScript·PostgreSQL·정적 대시보드를 사용하며 새 의존성을 도입하지 않습니다.
댓글 집계는 기존 이벤트를 읽고 태그만 별도 테이블에 저장합니다.

## 순서와 검증

1. API와 DB 회귀 테스트를 먼저 작성하고 연락처 경로 부재·빈 결과 실패를 관찰합니다.
2. 태그 테이블·마이그레이션·서버 전용 접근 권한·작업 공간 조건을 구현합니다.
3. 계정·태그 필터·페이지와 수동 태그 편집 UI를 구현하고 실제 브라우저로 확인합니다.
4. 타입·단위·DB·workerd·Trunk 검사와 독립 적대적 리뷰를 완료합니다.
5. 백엔드·화면·문서를 의미별로 커밋하고 PR을 만들어 CI·코드·보안 리뷰와 화면 승인을 확인합니다.

검증 명령은 `corepack pnpm check-types`, `corepack pnpm test`, 로컬 `TEST_DATABASE_URL`의 `corepack pnpm test:db`와 `corepack pnpm test:cloudflare`입니다.
수신·발송 로직과 전역 발송 스위치를 변경하지 않습니다.
