# 인박스 일회성 예약 답장 구현 계획

## 계약과 소유 범위

[예약 답장 계약](../specs/2026-10-16-inbox-scheduled-replies.md)을 현재 메인 작업 공간에서 구현합니다.
새 의존성이나 작업 트리는 만들지 않습니다.
PR #210의 병합 커밋 `bc6fd8ef7b5fffcc3fc03775215f9e2c9192aee3`을 기준으로 합니다.

## 순서와 완료 검사

1. 기존 `settings.db.test.ts` 수동 답장 픽스처에 시각 지정·중복·수정·취소·권한·발송 경합 회귀를 추가하고 구현 전 의도한 실패를 확인합니다.
2. `db/schema.sql`, migration 049와 전체 실행기에 예약 필드·취소 상태·감사 메타데이터를 추가합니다.
3. `src/app/manual-replies.ts`, `api.ts`에 기존 API와 호환되는 예약 생성·수정·취소를 구현합니다.
4. `src/instagram/manual-reply-worker.ts`와 `src/cloudflare/index.ts`의 예정 시각·대화 순서·생성자 권한 검사를 일치시킵니다.
5. `public/app/inbox.js`, `index.html`과 필요한 범위의 스타일에 시각 선택·수정·취소·처리 사유를 추가합니다.
6. 실제 DB/workerd 테스트로 미래 예약과 즉시 답장, 취소와 선점, 창 만료·수신 거부·멤버 제거 및 기존 즉시 답장 회귀를 확인합니다.
7. CLAUDE·README·수동 답장 서버/화면 계약·수용 매트릭스와 직접 영향받는 문서를 같은 PR에서 맞춥니다.
8. 실제 브라우저로 데스크톱·모바일 동작을 확인하고 보이는 검토 디렉터리에 화면과 한계를 기록합니다.
9. 전체 검사와 범위에 맞는 독립 리뷰를 완료한 뒤 의미별 커밋·PR·현재 커밋 CI/코드/보안 리뷰를 진행합니다.

## 검증 명령과 경계

최소 변경 검사는 `corepack pnpm check-types`, `node --test --test-name-pattern='scheduled manual reply' src/app/settings.db.test.ts`입니다.
최종 검사는 `corepack pnpm test`, 격리된 UTF8 PostgreSQL의 `corepack pnpm test:db`, `corepack pnpm test:cloudflare`, 변경 파일을 지정한 Trunk 검사입니다.
예약 시각 전에 발송하지 않음·성공한 취소 후 POST 없음·실제 POST 직전 권한 재검사는 실제 워커를 호출하는 테스트로 검증합니다.
화면 검증은 합성 API이며 운영 DB·Meta 권한·실제 DM 도착을 증명하지 않습니다.
병합과 배포는 별도 권한이며 새 PR의 화면 승인은 운영자에게 받습니다.
