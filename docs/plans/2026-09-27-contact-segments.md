# 세그먼트 구현 계획

## 순서와 검증

1. API 경로 회귀를 작성합니다. → 검증: `node --test src/app/api.test.ts`에서 기능 부재의 404 실패를 관찰합니다.
2. 저장·보관·읽기와 필터 결합을 구현하고 migration 009를 준비합니다. → 검증: `corepack pnpm test:db`에서 실제 DB의 격리·동시 생성·최신 조건·업그레이드 재실행을 확인합니다.
3. 제한된 서버 역할 접근과 workerd API를 검사합니다. → 검증: `corepack pnpm test:cloudflare`.
4. 연락처 구역에 저장된 필터 선택·저장·보관을 추가합니다. → 검증: 이름 있는 agent-browser 세션에서 성공·실패·취소·모바일·로그아웃 경로를 실행합니다.
5. 현재 후보를 로컬 적대적 리뷰하고 수정합니다. → 검증: 타입·단위·DB·workerd·명시적 파일 Trunk 검사.
6. 스토리지/API, UI, 검증 문서를 의미별로 커밋하고 PR을 엽니다. → 검증: 현재 head의 CI·코드·보안 리뷰와 명시적 화면 승인 뒤 운영자 병합.

## 파일 범위와 권한

서버 범위는 `src/app/contacts.ts`, `src/app/api.ts`, 기존 API·DB·workerd 테스트, `db/schema.sql`, migration 009와 배포 접근·마이그레이션 스크립트입니다.
UI 범위는 `public/app/app.js`, `index.html`, `styles.css`입니다.
문서는 `docs/{specs,plans,notes}`와 필요한 `CLAUDE.md` 명령·경계만 갱신합니다.
워크스페이스 잠금으로 생성 수 제한과 중복을 보호하며 공개 API 역할이나 기존 테이블의 권한을 완화하지 않습니다.
변경은 현재 작업 공간에서 순차적으로 작성하고 리뷰 에이전트는 읽기 전용으로 실행합니다.
운영 DB·배포·외부 발송·PR 병합·메모리 변경 권한은 없습니다.
