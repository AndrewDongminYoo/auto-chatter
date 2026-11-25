# 활성 연락처 한도 집행 구현 계획

[설계](../specs/2026-11-25-active-contact-limit-design.md)를 [이슈 #52](https://github.com/AndrewDongminYoo/auto-chatter/issues/52)의 활성 연락처 한도 항목에 맞춰 구현하는 순서입니다.
PR 두 개로 나눕니다.
PR ①은 포함량, 판정, 발송 경로와 API의 집행이며 화면 변경이 없습니다.
PR ②는 요금제 카드와 버튼, 오류 문구입니다.
migration은 필요 없을 것으로 봅니다(설계의 "운영 영향").
배포는 각 PR이 병합된 뒤 CI의 Deploy 워크플로가 맡으며, 운영 DB 작업이 생기면 조회·백업·적용·배포를 명시한 별도 승인을 받습니다.

## 판정을 넣는 지점

| 경로                      | 현재 가드                                                                                    | 넣을 판정과 결과                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 비공개 답장(Cloudflare)   | `src/cloudflare/index.ts`의 최종 가드(`automation_active` 검사 옆)                           | `PreSendVerificationError("block", "active_contact_limit")` → `blocked` |
| 비공개 답장·팔로우(Node)  | `src/instagram/node-delivery.ts`의 두 가드                                                   | 같음                                                                    |
| 비공개 답장 worker 공통   | `src/instagram/reply-worker.ts`의 claim 뒤 검사                                              | 같음                                                                    |
| 팔로우 확인과 후속 DM     | `src/instagram/follow-flow.ts`의 발송 허가 판정                                              | `blocked` / `active_contact_limit`                                      |
| DM 플로우                 | `src/instagram/dm-flow-delivery-worker.ts`의 block/retry 목록                                | block 목록에 추가                                                       |
| 캠페인 발송               | `src/instagram/campaign-delivery-worker.ts`의 최종 가드와 `endUnreachableCampaignDeliveries` | block 목록에 추가, 정리 쿼리에도 같은 조각                              |
| 수동 답장 발송            | `src/cloudflare/index.ts`의 수동 답장 가드                                                   | `failed`, `safe_to_retry = true`, `active_contact_limit`                |
| 수동 답장 생성·재시도 API | `src/app/manual-replies.ts`                                                                  | `409 active_contact_limit_reached`, 쓰기 없음                           |
| 캠페인 승인 생성 API      | `src/app/campaign-drafts.ts`의 승인 생성(작업 공간 `FOR UPDATE` 뒤)                          | 초과 상태이면 `409 active_contact_limit_reached`, 쓰기 없음             |
| 캠페인 시작               | `campaign_start`의 월 캠페인 한도 검사 옆                                                    | 초과 상태이면 발송 행 없는 `completed` 실행과 표시 키                   |

위 표의 함수 위치는 grep으로 찾은 것이며, 구현할 때 각 경로의 실제 가드 함수를 읽고 확정합니다.

## 단계

### PR ① 집행

1. `PLANS`에 `active_contacts_per_month`(25 / 250 / 2,500 / 7,500 / 25,000)를 더합니다.
   → 검증: `plan-labels.test.ts`의 목록 모양 검사를 새 키에 맞게 바꾸고 `corepack pnpm test`.
2. 판정 SQL 조각과 TypeScript 함수를 `src/app/plans.ts`에 둡니다. 입력은 작업 공간, 연결, 받는 사람의 원장 키(댓글 작성자 ID 또는 DM 받는 사람 ID)이고, 출력은 "허용 / 초과 상태 / 새 사람이라 막힘"입니다. 이번 달과 숫자는 `ACTIVE_CONTACT_USAGE_SQL`과 같은 규칙으로 읽고, DM 받는 사람의 키는 `active_contact_linked_sender`로 정합니다.
   → 검증: 새 DB 테스트에서 `count = 포함량 - 1 / 포함량 / 포함량 + 1` 각각에 대해 이미 센 사람과 새 사람의 판정을 확인하고, 확인된 신원 연결이 있는 DM 받는 사람을 이미 센 사람으로 보는지 확인합니다. 판정을 일부러 `>=`로 바꾸면 경계 테스트가 실패하는지도 한 번 확인합니다.
3. 표의 각 발송 경로에 판정을 넣습니다. 막는 판정은 재시도 판정보다 우선하고, 판정 조회 오류는 기존 재시도로 보냅니다.
   → 검증: 경로마다 DB 테스트 하나씩. 초과 작업 공간의 행이 claim 뒤 지정한 상태와 `active_contact_limit`으로 끝나고 transport의 `send()`가 호출되지 않음을 확인합니다. 초과 상태에서도 `ingestComments`와 `ingestMessages`가 저장과 원장 기록에 성공함을 확인합니다.
4. 수동 답장 생성·재시도 API와 캠페인 승인 API에 `409`를 넣습니다.
   → 검증: `409`와 쓰인 행이 없음, 요금제를 올린 뒤의 성공, 다음 달 경계(설계의 `reference` 고정 시각 사용)에서 풀림.
5. 캠페인 시작에 초과 상태 판정을 넣습니다.
   → 검증: `campaign-runs.db.test.ts`에 발송 행 없는 `completed` 실행과 표시 키, 승인 `executed`를 확인하는 사례를 더합니다.
6. `docs/agents/feature-invariants.md`의 "Plan entitlements" 절에 집행 규칙을 더하고, `docs/specs/2026-10-12-plan-entitlements.md`의 "#52에 남은 일"에서 활성 연락처 한도를 이 설계로 옮겼다고 적습니다.
7. 전체 관문: `corepack pnpm check-types`, `corepack pnpm lint`, `corepack pnpm test`, 별도 임시 클러스터에서 `test:db`와 `test:cloudflare`, `trunk check --all`.

### PR ② 화면

1. 요금제 카드의 이번 달 숫자를 `N / 포함량`으로 바꾸고 초과 상태 문장을 더합니다.
2. 초과 상태에서 수동 답장 보내기와 캠페인 승인 버튼을 끄고 이유를 보여 줍니다. `409 active_contact_limit_reached`의 한국어 문구를 더합니다.
   → 검증: `plan-labels.test.ts`와 해당 화면 모듈의 단위 테스트, 로컬 mock API 미리보기로 화면을 확인한 뒤 PR(`scripts/check-preview.sh`).
3. 전체 관문은 PR ①과 같습니다.

## 범위 밖

- 결제, 초과 승인과 상한, 사용량 경고(#54).
- 고객 웹훅 전달(`webhook_deliveries`)은 멈추지 않습니다(설계).
- AI 예산, API 요청 한도와 저장량 상한의 요금제별 값.

## 2026-11-25 정정

구현하면서 위 단계 중 몇 곳을 바꿨습니다. 이유는 [설계](../specs/2026-11-25-active-contact-limit-design.md)의 "경로별 동작"과 "검사 위치"에 있습니다.

- 오류 코드: `409 active_contact_limit_reached` 대신 행의 `failure_code`와 같은 `409 active_contact_limit`을 씁니다. 수동 답장 API가 발송 가드의 실패 코드를 그대로 돌려주기 때문입니다.
- 단계 2: SQL 조각 대신 판정 함수 `activeContactLimitBlocks`를 각 가드가 부릅니다. 캠페인 승인 API는 `src/app/campaign-approvals.ts`에 있습니다.
- 단계 5와 표의 캠페인 정리 쿼리: 캠페인 시작과 `endUnreachableCampaignDeliveries`는 바꾸지 않고, 발송 행을 claim한 뒤 최종 가드가 막습니다.
- 판정 순서: 각 가드에서 판정을 수신 거부 검사 뒤에 둡니다.
