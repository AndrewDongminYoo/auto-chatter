# 세그먼트 통합 수용 검증 계획

## 계약

[통합 수용 명세](../specs/2026-10-20-segment-integrated-acceptance.md)를 구현합니다.
기존 기능 계약을 유지하고, 검사에서 확인한 결함만 수정합니다.

## 작업 순서

1. `scripts/segment-acceptance.mjs`에 기존 Miniflare·제한된 DB 역할·합성 인증을 사용하는 검증 서버를 추가합니다.
   원격 DB, 다른 DB 이름, 사용 중인 스키마 거절을 확인한 뒤 빈 임시 DB에서 시작합니다.
2. 이름을 지정한 `agent-browser` 세션에서 전체 대시보드를 조작합니다.
   로그인·필터 저장·미리보기·고정·비교·CSV를 수행하고 실제 DB와 다운로드 내용을 대조합니다.
3. 권한·보관·삭제·오류·필터 수정·선택 전환·좁은 화면을 확인합니다.
   늦은 응답은 기존 클라이언트 회귀와 실제 페이지의 지연 요청을 통해 확인합니다.
   결함이 있으면 기존 해당 테스트에 실패 사례를 먼저 추가하고 최소 수정합니다.
4. 검증 기록과 기존 수용 매트릭스에 검사 대상·결과·한계를 반영하고 `CLAUDE.md`에 실행 방법을 연결합니다.
   `README.md`와 `AGENTS.md`의 관련 안내가 여전히 정확한지도 확인합니다.
5. 후보 변경을 검토하고 형식·타입·단위 검사와 관련 DB/workerd 검사를 실행합니다.
   커밋·PR·호스팅 리뷰를 진행한 뒤 화면 승인과 운영자 병합을 기다립니다.

## 소유 파일과 범위

- `scripts/segment-acceptance.mjs`: 재현 서버입니다.
- 이 명세와 계획, `docs/notes/2026-10-20-segment-integrated-acceptance-verification.md`: 계약과 실제 결과입니다.
- `docs/notes/2026-09-27-manychat-acceptance-matrix.md`, `CLAUDE.md`: 수용 상태와 실행 안내입니다.
- 결함 재현 시에만 직접 관련된 기존 소스와 테스트를 수정하고 검증 기록에 경로를 남깁니다.

## 검증 명령과 한계

```bash
corepack pnpm check-types
corepack pnpm test
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:<임시 포트>/automations_test corepack pnpm test:db
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:<임시 포트>/automations_test corepack pnpm test:cloudflare
corepack pnpm build:cloudflare
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:<별도 빈 DB 포트>/automations_test node scripts/segment-acceptance.mjs
```

자동 검사는 타입·모의 외부 경계·실제 로컬 DB·workerd 계약을 검사합니다.
브라우저는 합성 인증과 로컬 DB를 사용하는 실제 대시보드 흐름을 검사합니다.
두 검사 모두 공급자 승인·실계정·운영 배포를 증명하지 않습니다.
검사 서버와 브라우저, 임시 DB는 작업 후 종료합니다.
