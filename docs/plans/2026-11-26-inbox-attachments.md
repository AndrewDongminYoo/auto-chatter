# #20 인박스 첨부·미지원·취소 수신 계획

설계: [Instagram 인박스 첨부·미지원·취소 메시지 수신 설계](../specs/2026-11-26-instagram-inbox-attachments-design.md).
2026-11-26 승인 범위는 구현, 로컬 검증, 로컬 화면 미리보기, 커밋, push, PR 생성까지입니다. 머지와 운영 반영(조회·백업·migration 079 적용·배포)은 따로 승인받습니다.

## 단계

1. `parseMessageEvents`가 첨부·미지원·취소를 해석하고, 채널 계약과 어댑터가 새 이벤트 종류를 전달합니다.
   검증: `node --test src/instagram/follow-flow.test.ts src/instagram/channel-adapter.test.ts` (파서 테스트는 `follow-flow.test.ts`에 있습니다)
2. migration 079가 `instagram_inbox_messages`의 `kind` CHECK를 넓히고 `attachments`, `deleted_at` 열을 더합니다. `db/schema.sql`과 `deploy/migrate-multi-user.sql`을 함께 고칩니다.
   검증: 격리된 PostgreSQL에서 runner를 두 번 실행합니다.
3. `ingestMessages`가 첨부·미지원 DM을 저장하고 원장과 마지막 수신 시각에 기록하며, 자동화 경로에는 넘기지 않습니다. 취소 이벤트는 본문을 비우거나 취소 표시 행을 먼저 넣습니다.
   검증: `corepack pnpm test:db`의 인박스·플로·원장 테스트
4. 24시간 창을 읽는 세 쿼리가 `attachment`와 `unsupported`를 포함합니다.
   검증: 직접 답장, DM 플로, 캠페인 후보의 DB 테스트
5. 인박스 API가 `attachments`, `deleted_at`, `last_message_kind`를 돌려주고, 화면이 종류 이름과 안내를 텍스트로 보입니다. `/privacy` 문구를 고칩니다.
   검증: 단위 테스트와 `scripts/check-preview.sh`를 쓴 로컬 미리보기(밝음·어두움·좁은 화면)
6. `docs/agents/feature-invariants.md`의 Received inbox와 Manual replies 절을 고칩니다.
   검증: `corepack pnpm check-types`, `corepack pnpm lint`, `corepack pnpm test`, `test:db`, `test:cloudflare`, `trunk check --all`
