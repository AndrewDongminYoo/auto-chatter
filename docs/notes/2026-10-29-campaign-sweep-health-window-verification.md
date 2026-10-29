# 캠페인 정리와 운영 상태 복구 시각 검증

## 범위와 기준

[#273](https://github.com/AndrewDongminYoo/auto-chatter/issues/273)(도달할 수 없는 캠페인 행의 정리)과 [#274](https://github.com/AndrewDongminYoo/auto-chatter/issues/274)(오래된 `sending` 복구 결과의 24시간 창)를 구현했습니다.
계약은 [도달할 수 없는 행의 정리](../specs/2026-10-27-campaign-runs.md#도달할-수-없는-행의-정리)와 [운영 상태 지표](../specs/2026-10-01-operations-health.md#지표와-api)에 있습니다.
기준 HEAD는 `e0e6726`이며 아래 로컬 검사는 커밋 전 작업 변경을 대상으로 수행했습니다.
실제 발송은 하지 않았습니다. 운영 DB·실계정·Meta는 사용하지 않았고, 저장소의 `SEND_ENABLED`는 `false` 그대로입니다. 의존성 변경은 없습니다.
이 검증은 migration 067의 운영 적용이나 Worker 배포를 뜻하지 않으며, [#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36)과 [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35)는 열린 채로 둡니다(Refs #36).

## 검사

이 작업용 일회용 PostgreSQL 17 클러스터(포트 5448)를 사용했고, 매 실행 전에 `automations_test`를 지우고 다시 만들었습니다.

### #273 정리

`src/instagram/campaign-delivery-worker.db.test.ts`에 22개를 추가했습니다.

- guard와 같은 결과: 최종 guard 검사 표(`guardCases`) 15개를 그대로 다시 쓰고, 각 조건에 대상 일시 중지를 더한 뒤 정리를 실행합니다. 차단 기대값인 11개는 guard와 같은 코드(`reply_window_closed`, `marketing_consent_required`, `recipient_opted_out` 세 경우, `no_dm_identity`, `connection_unavailable` 두 경우, `approver_unavailable` 두 경우, 차단 우선)로 `blocked`가 되고, 시도 열이 없고, 호출 수가 없으며, 이어지는 완료 문장이 실행을 `completed`(버전 2)로 바꿉니다. 재시도 기대값인 4개(대상 일시 중지, 상담 전환 중지, 연결 일시 중지, 토큰 교체)는 행이 정리 전과 같은 `pending`이고 실행은 `running`입니다.
- 보낼 수 없는 연결: 비활성, 발송 꺼짐, 토큰 없음, 토큰 만료 각각에서 대상 일시 중지 없이 두 행이 `connection_unavailable`로 끝납니다. 두 행 모두 승인자가 `agent`로 바뀌었고 한 행은 창도 닫혔으므로, guard의 첫 사유인 연결이 이기는 순서도 확인합니다.
- 닿는 행과 끝난 실행: 창이 닫혔지만 일시 중지가 없는 행은 정리가 건드리지 않고, 그 뒤 worker의 guard가 `reply_window_closed`로 끝냅니다. `cancelled`와 `completed` 실행에 남긴 `pending` 행도 건드리지 않습니다.
- 한도: 일시 중지만 있는(단계 7) 가장 오래된 행 하나와 창이 닫힌 행 셋에서 한도 2는 창이 닫힌 오래된 두 행을 끝내고, 다음 실행이 나머지 하나를 끝내며, 그다음은 0입니다.
- 잠금: 다른 트랜잭션이 실행 행과 연결 행을 `FOR UPDATE`로, 발송 행 하나를 `FOR UPDATE`로 쥔 동안 정리는 5초 안에 끝나며, 쥔 행은 건너뛰고 다른 행을 끝냅니다. 잠금이 풀린 뒤 다음 정리가 그 행을 끝냅니다.

`src/cloudflare/worker.db.test.ts`에 1개를 추가했습니다: 일시 중지된 대상의 창이 닫힌 행을 Cron 한 번이 `blocked` / `reply_window_closed`(시도 열 없음)로 끝내고 같은 `campaign_start` 단계에서 실행을 `completed`로 바꾸며, 단계는 성공으로 기록되고, 발송과 큐 메시지는 없습니다.

미리보기, 시작, guard, `deliveryRecipientOptedOut`, `campaignDeliveryDueSql`의 SQL 문자열은 조각을 나누기 전과 뒤에 SHA-256이 같았습니다(가짜 클라이언트로 각 함수가 보내는 문자열을 모아 비교). 기존 미리보기·승인·시작·guard 검사도 모두 통과했습니다.

### #274 복구 시각

- `src/app/operations-health.db.test.ts`에 3개: 비공개 답장, 팔로우 응답, 수동 답장마다 시도가 25시간 전인 `sending` 행을 해당 복구 함수(`recoverStalePrivateReplies`, `recoverStaleFollowReplies`, `recoverStaleManualReplies`)로 `unknown`으로 바꾸면 `unknown_24h`가 0에서 1이 되고 `unknown_outcome` 경보가 켜집니다. 같은 나이의 일반 `unknown`(`send_outcome_unknown`)은 세지 않습니다.
- `src/instagram/campaign-delivery-worker.db.test.ts`에 1개: 캠페인 발송 행의 같은 경우입니다. 일반 `unknown` 행의 `updated_at`도 24시간 안이므로, `updated_at`을 `worker_interrupted` 행에만 쓰는지도 확인합니다.
- `src/cloudflare/worker.db.test.ts`의 기존 검사 하나에 Cron의 비공개 답장 복구 문장이 `recovered_at`을 쓰는지 확인을 더했습니다.

### migration 067

`HEAD`의 `db/schema.sql`(066 상태)을 새 DB에 적용한 뒤 067을 단일 트랜잭션으로 두 번 적용하고 새 `db/schema.sql`을 다시 적용했습니다. 모두 오류 없이 끝났고, `campaign_delivery_attempt`는 `blocked`를 시도 열 없이 허용하는 정의가 되었으며 `recovered_at`은 두 테이블에 하나씩 있습니다.
운영 DB에는 적용하지 않았습니다.

## 실패를 먼저 확인한 변경

각 새 검사가 그 코드를 되돌리면 실패하는지, 한 번에 하나씩 소스를 바꾸고 해당 검사만 실행한 뒤 되돌려 확인했습니다. 19개 변경 모두 하나 이상의 새 검사가 실패했습니다.

| 되돌린 코드                                         | 실패한 새 검사                                  |
| --------------------------------------------------- | ----------------------------------------------- |
| 정리가 아무것도 하지 않음                           | 정리 검사 17개                                  |
| 067의 CHECK 완화 없음(`schema.sql`)                 | 정리 검사 17개(CHECK 위반)                      |
| 승인자 사유를 연결 사유보다 먼저 봄                 | 보낼 수 없는 연결 4개                           |
| 단계 4를 보지 않음                                  | 마케팅 동의 철회                                |
| 연결된 DM 수신자의 수신 거부를 보지 않음            | 같은 작성자와 연결된 다른 DM 수신자의 수신 거부 |
| 행 잠금(`FOR UPDATE OF d SKIP LOCKED`) 없음         | 쥔 행 건너뛰기(쥔 행을 기다림)                  |
| 한도를 사유 판정 전에 적용                          | 한도                                            |
| 실행 상태를 보지 않음                               | 닿는 행과 끝난 실행                             |
| 대상 일시 중지를 범위에서 뺌                        | 일시 중지된 대상의 차단 9개, 한도, 쥔 행        |
| 모든 `pending` 행을 범위에 넣음                     | 닿는 행과 끝난 실행                             |
| 운영 상태가 캠페인 행을 시도 시각으로 셈            | 캠페인 복구 시각                                |
| 복구 시각을 `worker_interrupted`가 아닌 결과에도 씀 | 캠페인 복구 시각(일반 `unknown`도 셈)           |
| 운영 상태가 비공개 답장을 시도 시각으로 셈          | 비공개 답장 복구 시각                           |
| 운영 상태가 팔로우 응답을 시도 시각으로 셈          | 팔로우 응답 복구 시각                           |
| 수동 답장의 복구 이벤트를 찾지 못함                 | 수동 답장 복구 시각                             |
| Node 비공개 답장 복구가 `recovered_at`을 쓰지 않음  | 비공개 답장 복구 시각                           |
| 팔로우 응답 복구가 `recovered_at`을 쓰지 않음       | 팔로우 응답 복구 시각                           |
| Cron 비공개 답장 복구가 `recovered_at`을 쓰지 않음  | Cron 복구 검사                                  |
| `campaign_start`가 정리를 부르지 않음               | Cron 정리 검사                                  |

## 실행한 게이트

- `corepack pnpm check-types`: 통과.
- `corepack pnpm test`: 502개 통과.
- `corepack pnpm test:db`: 847개 통과(새 DB).
- `corepack pnpm test:cloudflare`: 88개 통과(새 DB).

## 확인하지 않은 것

- 운영 DB의 migration 067 적용과 Worker 배포, 운영 데이터에서의 정리 결과와 경보.
- 실행 중인 실행의 `pending` 행이 많을 때 정리 문장의 실제 실행 시간과 Worker CPU 시간. 정리는 한도와 관계없이 대상 행을 모두 읽습니다.
- 정리와 취소·삭제 함수가 실제로 겹쳐 실행되는 경우의 순서. 검사는 잠금을 쥔 다른 트랜잭션을 기다리지 않는 것만 확인합니다.
