# #17 정책과 로컬 수용 근거 정리 계획

## 방향과 범위

[#17](https://github.com/AndrewDongminYoo/auto-chatter/issues/17)의 세 완료 조건을 기존 [식별자 계약](../specs/2026-09-27-inbox-handoff-contract.md)과 [상담 전환 계약](../specs/2026-09-27-inbox-human-handoff.md), 현재 구현과 회귀 테스트에 대조합니다.
동일한 기능을 다시 구현하거나 식별자 연결·동의·발송 정책을 변경하지 않습니다.
실계정·운영 검증과 이슈 전체 완료 상태는 로컬 수용 근거와 구분합니다.

## 작업과 검증

1. 기존 계약을 재사용해 DM 대화 키·연결 근거·상담 전환의 시작과 재개 조건을 정리합니다.
   검증: 각 완료 조건을 현재 코드와 실제 행·상태 전이를 검사하는 테스트 이름에 연결합니다.
2. 격리된 로컬 PostgreSQL에서 관련 식별자·상담 전환·발송 경계 테스트를 실행하고 결과와 한계를 검증 기록에 남깁니다.
   검증: `TEST_DATABASE_URL=<격리된 로컬 automations_test> node --test --test-concurrency=1 --test-name-pattern='inbox context|handoff' src/app/settings.db.test.ts src/instagram/reply-worker.db.test.ts src/app/inbox-conversations.db.test.ts`를 실행합니다.
   실제 공급자 호출은 대체하므로 실계정 성공으로 해석하지 않습니다.
3. 수용 현황표에서 기존 정책과 남은 식별자 병합·분리 설계의 관계를 분명히 하고, 원래 식별자 계약에서 새 근거 기록으로 연결합니다.
   검증: #17·#25의 실계정·운영 미완료 상태와 #26의 전체 의존성을 유지하는지 확인합니다.
4. 변경 문서만 서식·링크 검사하고 한 번의 구조화된 로컬 리뷰를 수행한 뒤 PR을 엽니다.
   검증: 명시한 네 경로의 `trunk check`, `git diff --check`, 누락 경로 음성 대조를 포함한 상대 링크 검사와 PR head의 CI·필수 리뷰를 확인합니다.

## 소유 경로와 제외 범위

변경 경로는 이 계획, `docs/notes/2026-10-19-issue17-policy-evidence.md`, `docs/specs/2026-09-27-inbox-handoff-contract.md`, `docs/notes/2026-09-27-manychat-acceptance-matrix.md`입니다.
소스·스키마·의존성·화면 변경이 없으므로 새 동작의 TDD와 시각 승인은 해당하지 않습니다.
기존 회귀 테스트의 실행은 현재 로컬 구현을 확인하며, 문서 문구를 반복하는 테스트는 추가하지 않습니다.
CLAUDE·README·AGENTS의 관련 경계도 확인하되 이번 변경 때문에 부정확해진 주장이 없다면 수정하지 않습니다.
운영 DB 조회·상담 전환 쓰기·실제 발송·배포·이슈 상태 변경은 이 계획의 실행 범위에 포함하지 않습니다.
