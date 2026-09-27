# DM 문맥 조회 구현 계획

## 승인된 방향과 범위

운영자가 승인한 ManyChat 대체 PR 루프의 다음 단계로, 수동 답장 전에 [식별자·상담 전환 계약](../specs/2026-09-27-inbox-handoff-contract.md)을 확정합니다.
기존 작업 공간과 `codex/inbox-handoff-contract` 브랜치를 사용합니다.
새 의존성·테이블·화면·외부 발송은 추가하지 않습니다.
상담 전환 쓰기와 수동 답장은 이 조회 계약을 사용하는 다음 이슈입니다.

## 파일 소유권

루트가 `src/app/inbox.ts`, `src/app/api.ts`, 기존 `src/app/settings.db.test.ts`, `src/app/api.test.ts`, `src/cloudflare/runtime.db.test.mjs`와 관련 명세·계획·검증 기록을 수정합니다.
기존 문서 드리프트 수정은 앞선 별도 문서 커밋에 보존합니다.
검토자는 읽기 전용이며 루트가 스테이징·커밋·최종 검증을 수행합니다.

## 순서와 검증

1. 실제 API와 격리된 PostgreSQL에 성공 발송·수신 대화 fixture를 만들고 `/context`가 없는 상태의 404를 관찰합니다.
   검증: 저장된 대화의 문맥 조회가 200이어야 한다는 테스트의 실패입니다.
2. 한 SQL snapshot으로 연결·대화·원본 댓글·성공한 outbox·현재 중지 상태를 조회합니다.
   검증: 소유권·동일 숫자 미확인·다른 계정·미발송·미래·오래된 근거·중복·충돌·중지 변경 DB 사례입니다.
3. 기존 인증과 읽기 경로에 문맥 라우트를 추가합니다.
   검증: 미인증 요청이 DB를 열지 않고 거부되며 잘못된 ID·query도 거부됩니다.
4. 전체 타입·단위·DB·로컬 workerd 테스트와 Trunk를 실행합니다.
   검증: `corepack pnpm check-types`, `corepack pnpm test`, 격리된 `TEST_DATABASE_URL`의 `corepack pnpm test:db`와 `corepack pnpm test:cloudflare`입니다.
5. 인증·근거 판정과 계약 누락을 독립적으로 검토하고 작은 커밋으로 PR을 올립니다.
   검증: 현재 head의 CI·호스팅 리뷰와 남은 이슈 목록입니다.

## 위험과 다음 작업

조회와 발송 사이에 DB 상태는 바뀔 수 있습니다.
읽기 응답을 상담 전환 또는 발송 승인으로 사용하지 않으며 다음 수동 답장 구현에서 최종 guard를 다시 검사합니다.
현재 보관 시작 시각 이전의 실제 연결도 `stale`로 표시할 수 있습니다.
이는 자동 추정을 줄이기 위한 기본 정책이며 실제 고객 사용에서 필요한 재검증 경로는 별도 구현합니다.
이번 PR로 운영 배포·수동 메시지 수신·상담 전환이 검증됐다고 표시하지 않습니다.
