# 사용자 정의 필드 구현 계획

## 범위와 순서

1. API·DB 실패 테스트를 작성합니다. 필드 목록의 404와 값·검색 계약의 실패를 확인합니다.
2. 필드 정의·값 테이블과 migration 010을 추가합니다. 기존 관리자 트랜잭션과 제한된 서버 접근에 포함합니다.
3. src/app/contact-fields.ts에서 정의 생성·목록·보관·값 저장·조건 검증을 구현합니다. contacts.ts의 조회·저장 필터와 api.ts를 확장합니다.
4. 설정 화면에 필드 관리와 연락처 값 편집, 필드 검색을 추가합니다. 기존 초안·세션 경계를 유지합니다.
5. 실제 로컬 DB·workerd·브라우저에서 계약을 검증하고 독립적인 서버/UI 적대적 리뷰를 실행합니다.
6. 기능·화면·문서를 작은 커밋으로 나누고 PR을 올립니다. 현재 커밋의 CI·코드·보안 리뷰와 화면 승인을 확인한 뒤 운영자에게 병합을 요청합니다.

## 확인 명령과 판정

- API와 validation: corepack pnpm test, corepack pnpm check-types
- 실제 저장·검색·경쟁·마이그레이션: 로컬 automations_test의 corepack pnpm test:db
- 서버 역할·인증·실행 환경: 같은 별도 로컬 DB의 corepack pnpm test:cloudflare
- 실제 화면: 합성 연락처로 저장·제거·실패·조건·늦은 응답을 검증하고 desktop/mobile 이미지를 생성합니다.
- 품질: 변경 경로에 한정한 trunk fmt/check, JavaScript 문법 검사와 git diff --check

## 소유 경로

루트 에이전트가 contact-fields.ts, contacts.ts, api.ts, schema·migration·서버 접근, 기존 API·DB·workerd 테스트, public/app의 HTML·JS·CSS와 관련 docs를 수정합니다.
새 의존성·기존 RLS 완화·기존 전송 코드 변경은 필요하지 않습니다.
리뷰 에이전트는 읽기 전용이며 스테이징·커밋은 루트가 수행합니다.
