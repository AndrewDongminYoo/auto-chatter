# 캠페인 실행과 수신자별 발송 행

## 상태와 근거

2026-10-27 운영자가 계획을 승인했습니다.
결정은 다음과 같습니다.

- [#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36)의 서버부터 시작합니다.
- 캠페인 발송은 24시간 표준 메시지 창 안에서, 정확한 명시적 마케팅 동의가 있을 때만 허용합니다.
- Cloudflare OAuth 표면에서 Instagram 마케팅 capability를 지원으로 선언하고, 아래 Meta 정책을 근거로 인용합니다.

#36은 세 PR로 나눕니다: ① 실행과 발송 행(이 문서의 구현 범위), ② 발송 worker, ③ 화면.
이 PR은 아무것도 보내지 않습니다: Graph 호출, transport, outbox 행, 큐 메시지가 없습니다.

2026-10-29 정합 기록: PR ②가 [발송 worker](#발송-worker) 절을 구현했습니다.
이 문서의 PR ① 절에 있는 "보내지 않는다"는 서술은 PR ①의 범위를 기록한 것입니다. 현재 동작은 발송 worker 절과 그 코드(`src/instagram/campaign-delivery-worker.ts`)가 기준입니다.
PR ②로 바뀐 줄은 지우지 않고 취소선으로 표시하고, 그 옆에 바뀐 내용을 적었습니다.
2026-10-29 운영자가 PR ②의 계획을 승인했습니다: Queue 경로, 최종 guard, 결과 분류, 연결당 시간당 1,000회 캠페인 예산, 실행된 초안 버전 재승인의 409 거절, 승인 화면 문구.
migration 066은 코드 배포 전에 전체 실행기로 적용해야 합니다. PR ②의 검증 결과는 [캠페인 발송 검증](../notes/2026-10-29-campaign-delivery-verification.md)에 기록합니다.
#36과 [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35)는 이 PR 뒤에도 열린 상태로 남습니다.
검증 결과는 [캠페인 실행 검증](../notes/2026-10-27-campaign-runs-verification.md)에 기록합니다.
migration 065는 코드 배포 전에 전체 실행기(`deploy/migrate-multi-user.sql`)로 적용해야 합니다.
승인 기록의 계약은 [캠페인 초안 계약의 실행 승인](2026-10-21-campaign-drafts.md#실행-승인)이 맡습니다.

## Meta 정책 근거

아래 내용은 운영자가 승인한 계획에 기록된 확인 결과이며, 출처는 [Messenger Platform 정책](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy)과 [메시지 보내기 문서](https://developers.facebook.com/docs/messenger-platform/send-messages)입니다(2026-10-27 접근).
이 구현 작업 중에는 두 문서를 다시 열어 보지 않았습니다.

- 24시간 표준 메시지 창 안의 메시지에는 홍보 내용을 담을 수 있습니다.
- 메시지 태그로는 홍보 내용을 보낼 수 없습니다.
- Sponsored Messages와 One-Time Notification은 Instagram Messaging API에서 쓸 수 없습니다.

그래서 캠페인은 수신자의 24시간 창 안에서만, 태그 없이 일반 텍스트로 보냅니다.
제품 정책은 바뀌지 않습니다: 발송에는 24시간 창과 정확한 명시적 마케팅 동의(`dm_recipient`, `purpose='marketing'`, `decision='grant'`, `evidence_kind='explicit'`)가 모두 필요하고, PR ②가 보낼 때마다 직전에 모든 조건을 다시 검사합니다.

## 채널 capability

`src/instagram/channel-adapter.ts`의 `marketing` 작업은 `cloudflare_oauth` 표면에서만 지원(텍스트)입니다.
`node_instagram`·`node_facebook` 표면은 계속 미지원이며, Node 환경 토큰 worker는 캠페인을 보내지 않습니다.
capability는 지원 여부를 알리는 값일 뿐이며 자격 검사나 최종 guard를 대신하지 않습니다.
미리보기 API의 `channel_marketing_supported`는 이 값을 그대로 읽으므로 이제 참입니다.

## 저장

### campaign_runs

실행된 승인 하나에 실행 하나입니다(`(workspace_id, approval_id)` 고유). 승인 ID는 클라이언트가 정하고 작업 공간 안에서만 고유하므로, 고유 제약도 작업 공간 단위입니다.
열은 작업 공간, `id`, `approval_id`, 승인에서 복사한 `draft_id`·`draft_version`·`snapshot_id`, `started_at`, `start_counts`, `status`, `version`, `cancelled_by`·`cancelled_at`, `updated_at`입니다.

- `start_counts`는 시작 시점에 다시 평가한 미리보기 수입니다. 키 아홉 개(`original_member_count`, `remaining_member_count`, 일곱 사유)와 10진 문자열 형식은 `campaign_approvals.preview_counts`와 같고, 저장 뒤 다시 계산하지 않습니다.
- `started_at`은 그 평가 문장의 `as_of`입니다.
- `status`는 `running`·`cancelled`·`completed`입니다. 이 PR은 `running`과 `cancelled`만 씁니다. `completed`는 PR ②가 모든 행이 끝났을 때 씁니다. 후보가 없는 실행도 PR ②가 완료할 때까지 `running`입니다.
- 취소 열은 `cancelled`일 때만 채워집니다(CHECK).

### campaign_deliveries

시작 시점의 후보 한 명당 한 행입니다.
열은 작업 공간, `id`, `run_id`, `connection_id`, `sender_id`(댓글 작성자), `recipient_id`(선택한 DM 수신자), `status`, `attempt_id`, `attempt_started_at`, `failure_code`, `provider_message_id`, `sent_at`, `created_at`, `updated_at`입니다.

- 중복 키는 `(run_id, connection_id, sender_id)`입니다.
- `status`는 `pending`·`sending`·`sent`·`failed`·`blocked`·`unknown`·`cancelled`입니다. 이 PR은 `pending`과 `cancelled`만 씁니다.
- CHECK가 상태와 열을 묶습니다: `pending`은 시도 열이 비어 있고, `sending`·`sent`·`failed`·`blocked`·`unknown`은 `attempt_id`와 `attempt_started_at`이 있으며, `provider_message_id`와 `sent_at`은 `sent`일 때만 있고, `failed`·`blocked`는 `failure_code`가 있습니다. migration 067부터 `blocked`는 시도 열이 없어도 됩니다([정리](#도달할-수-없는-행의-정리)).
- `recipient_id`는 숫자 DM 수신자 ID이며, 연결은 같은 작업 공간의 연결이어야 합니다(복합 외래 키).

### 승인의 실행 상태

`campaign_approvals.status`에 `executed`가 추가됩니다.
실행된 승인은 행을 유지하며 예약 변경과 취소가 `409 campaign_approval_executed`와 현재 승인으로 거절됩니다.
실행 전환은 승인의 `version`을 올리지 않고 감사 행도 쓰지 않습니다. 감사 행은 행위자가 필요한데 cron 단계에는 행위자가 없으므로, 실행 기록은 `campaign_runs` 행입니다.
실행된 승인은 초안을 더 이상 고정하지 않으므로, 초안을 수정하고 다시 승인할 수 있으며 새 승인은 자기 실행을 시작합니다.
초안을 수정하지 않고 같은 버전을 다시 승인할 수도 있습니다. 그 승인은 같은 고정 대상으로 두 번째 실행을 시작하고, 중복 키는 실행마다 따로이므로 같은 사람에게 두 번째 발송 행이 생깁니다.
~~같은 초안 버전의 재승인을 막을지, 실행 사이의 중복 발송을 막을지는 PR ②가 실제로 보내기 전에 운영자가 정할 결정입니다.~~
2026-10-29 운영자 결정(PR ②): 실행된 초안 버전은 다시 승인하지 않습니다. [재승인 거절](#재승인-거절)을 봅니다. 초안을 수정한 새 버전은 다시 승인할 수 있으며, 실행 사이의 중복 발송은 막지 않습니다.
승인 목록과 상세 응답에는 `run_id`와 `run_status`가 추가됩니다(실행이 없으면 `null`). 기존 키의 의미는 바뀌지 않으며 ~~`delivery_available`은 계속 거짓입니다~~ `delivery_available`은 PR ②부터 참입니다.

## 시작: cron 단계 campaign_start

Cloudflare cron에 `campaign_start` 단계를 추가합니다.
다른 단계처럼 `scheduled_steps`에 결과를 기록하고, 실패해도 뒤 단계는 계속 실행됩니다.
`SEND_ENABLED`가 정확히 `"true"`일 때만 실행되며, 아니면 `wake`·`webhook_delivery`처럼 건너뛰고 새 기록을 남기지 않습니다.
위치는 발송 단계 묶음의 마지막(`webhook_delivery` 다음)입니다.

### 대상과 순서

유효한 승인(`approved`) 중 즉시 승인이거나 `scheduled_at <= now()`인 것이 기한이 된 승인입니다.
한 번의 실행에서 최대 `CAMPAIGN_START_LIMIT`(`src/app/campaign-runs.ts`, 5)개를 시작합니다.
시작마다 최대 5,000명(고정 대상 상한)을 한 문장으로 평가하므로, 한 번의 단계가 몇 개의 문장 안에 끝나도록 작은 수로 둡니다.
시작에 실패한 적이 없는 승인(`start_failed_at`이 비어 있음)이 먼저이고, 그 안에서는 기한이 오래된 것부터입니다: 예약 승인은 `scheduled_at`, 즉시 승인은 마지막 일정 쓰기 시각(`updated_at`)이고 동률은 ID 순입니다.
시작에 실패한 승인은 그 뒤에 마지막 실패가 오래된 것부터 옵니다.
부분 색인 `campaign_approvals_due_idx`가 이 순서를 읽습니다.

### 한 승인의 트랜잭션

승인마다 자기 트랜잭션에서 다음 순서로 진행합니다.

1. 작업 공간 행 `FOR UPDATE`, 승인 행 `FOR UPDATE`, 초안 행 `FOR UPDATE` 순으로 잠급니다. 승인 API의 잠금 순서와 같으므로 시작과 예약 변경·취소·초안 수정이 섞이지 않습니다.
2. 같은 문장에서 승인이 아직 `approved`이고 기한이 되었는지 다시 확인합니다. 아니면 아무것도 쓰지 않고 건너뜁니다.
3. 고정 대상의 연결을 ID 순서로 `FOR SHARE` 잠급니다. 고정 대상 생성과 같은 방식이며, 연결 삭제(`FOR UPDATE`)와 개인 삭제(`FOR NO KEY UPDATE`)가 시작을 기다리거나 시작이 삭제를 기다립니다. 그래서 삭제가 커밋된 뒤 그 대상의 발송 행이 생기지 않습니다.
4. 미리보기 평가(`src/app/campaign-drafts.ts`의 `EVALUATION_SQL`)를 다시 실행합니다. 미리보기 API와 같은 SQL 본문에 후보 키를 덧붙인 한 문장이므로, 저장하는 수와 쓰는 행이 같은 스냅숏과 같은 시각에서 나옵니다.
5. 실행 행 하나와 `candidate`인 대상마다 `pending` 발송 행 하나를 넣고, 승인을 `executed`로 바꿉니다.

후보가 아닌 대상에는 행이 없으며, 그 수는 실행의 `start_counts`에만 남습니다.
승인 시점 이후 사실이 바뀌었다면 `start_counts`는 승인의 `preview_counts`와 다를 수 있습니다.
동시에 두 단계가 같은 승인을 보면 두 번째는 작업 공간 잠금을 기다린 뒤 실행된 승인을 보고 건너뜁니다. `(workspace_id, approval_id)` 고유 제약과 행의 중복 키가 이를 한 번 더 막습니다.

한 승인이 실패하면 고정 코드(`campaign_start_failed` 이벤트와 오류 분류 코드)만 기록하고 나머지 승인을 계속 시작합니다.
실패한 시작은 롤백되므로, 롤백 뒤 별도 문장이 그 승인의 `start_failed_at`을 현재 시각으로 씁니다. 버전, 기한 시각, 감사 행은 바뀌지 않으며, 이 쓰기가 실패하면 승인은 순서를 유지합니다.
그 뒤 단계는 `campaign_start_failed`로 실패합니다.
실패한 승인이 상한 이상이어도 다음 단계에서는 실패한 적 없는 승인이 먼저 선택되고, 실패한 승인끼리는 돌아가며 다시 시도되므로, 계속 실패하는 승인이 다른 승인을 막지 않습니다.

### 수신자 선택

후보의 DM 수신자는 그 댓글 작성자의 확인된 DM 수신자(`verifiedDmRecipientsSql`) 중 수신자 단위 검사를 모두 통과한 사람입니다: 수신 거부 없음, 정확한 명시적 마케팅 동의, 열린 24시간 텍스트 창.
그중 가장 최근에 저장된 수신 텍스트 DM의 수신자를 고르고, 같으면 ID가 작은 쪽을 고릅니다.
미리보기는 수신자별 단계를 `recipient_stages`로 계산한 뒤 대상의 단계를 그 최댓값으로 정하며, 선택한 수신자는 같은 CTE에서 나옵니다. 조건은 한 곳에만 있습니다.
미리보기 API의 응답은 바뀌지 않습니다.

## 취소

`POST /api/campaign-runs/:id/cancel`은 `admin`, 같은 출처, 쓰기 한도 아래에서 동작하며 `no-store`로 응답합니다.
본문은 `{"expected_version": n}` 하나입니다.
`running`인 실행은 `cancelled`가 되고, 그 실행의 `pending` 행은 같은 트랜잭션에서 모두 `cancelled`가 됩니다.
잠금 순서는 작업 공간, 실행 행, 그 실행의 발송 행입니다.

- 이미 `sending`인 행은 되돌릴 수 없으며 상태를 유지합니다. 응답은 `cancelled_delivery_count`(취소한 행 수, 10진 문자열)와 `sending_recalled: false`를 함께 돌려줍니다.
- 이전 버전은 `409 campaign_run_conflict`와 현재 실행입니다.
- 이미 취소된 실행은 `409 campaign_run_cancelled`, 완료된 실행은 `409 campaign_run_completed`이며 둘 다 현재 실행을 돌려줍니다.
- 다른 작업 공간·없는 ID·UUID 형식이 아닌 ID는 `404 campaign_run_not_found`, 잘못된 본문과 쿼리 문자열은 `400 invalid_campaign_run`입니다.

## 조회

`GET /api/campaign-runs/:id`(`admin`)는 실행 열, 저장된 시작 수(`start: {as_of, original_member_count, remaining_member_count, counts}`), 상태별 발송 행 수(`delivery_counts`, 일곱 상태 모두 10진 문자열), ~~`delivery_available: false`~~ `delivery_available`(PR ②부터 `true`)을 돌려줍니다.
댓글 작성자·DM 수신자 식별자는 응답에 없습니다.
화면(PR ③)은 승인의 `run_id`로 실행을 찾습니다.

## 발송 worker

PR ②(2026-10-29)의 계약입니다.
`pending` 발송 행 하나를 저장된 DM 수신자(`recipient_id`)에게 승인에 저장된 본문 사본으로 보냅니다. 태그와 버튼이 없는 일반 텍스트 DM 하나(`{"recipient":{"id":…},"message":{"text":…}}`)입니다.
코드는 `src/instagram/campaign-delivery-worker.ts`이고, Cloudflare Queue 소비자만 이를 부릅니다. Node 환경 토큰 worker는 캠페인을 보내지 않습니다.
테스트는 Meta를 호출하지 않으며, 저장소의 `SEND_ENABLED`는 계속 `false`입니다.

### 저장: migration 066

- `next_attempt_at`(기본값 `now()`): 대기 행을 다시 가져갈 수 있는 시각입니다. 미룬 행은 `pending`으로 남고 이 시각이 뒤로 갑니다.
- `provider_called_at`: 공급자 요청 직전에 씁니다. 캠페인 예산이 이 열로 호출을 셉니다.
- 색인 세 개: 가져오기와 깨우기용 `campaign_deliveries_due_idx`(`(connection_id,next_attempt_at,created_at,id) WHERE status='pending'`), 예산용 `campaign_deliveries_called_idx`(`(connection_id,provider_called_at) WHERE provider_called_at IS NOT NULL`), 오래된 `sending` 복구용 `campaign_deliveries_sending_idx`입니다.
- 기존 CHECK는 바꾸지 않습니다. `pending`으로 돌아가는 행은 `attempt_id`와 `attempt_started_at`을 비웁니다. `cancelled`는 시도 열을 가져도 됩니다.
- 권한은 표 단위이므로 접근 스크립트는 바뀌지 않습니다.

### 가져오기

한 연결의 `pending` 행 중 `next_attempt_at`이 지났고, 실행이 `running`이고, 댓글 작성자의 자동화 일시 중지와 상담 전환 중지가 없고, 연결이 일시 중지되지 않았고, 캠페인 예산이 남은 행 하나를 가져옵니다.
순서는 `next_attempt_at`, `created_at`, `id`이고 `FOR UPDATE OF d SKIP LOCKED`입니다. 행을 `sending`으로 바꾸고 새 `attempt_id`와 `attempt_started_at`을 씁니다.
이후 모든 변경은 `status='sending' AND attempt_id=$n`을 조건으로 하며, 가져온 행을 잃으면 예외를 던집니다.
실행 상태는 잠그지 않고 읽습니다. 취소는 실행 행을 잠근 뒤 발송 행을 바꾸므로, worker가 행을 쥔 채 실행 잠금을 기다리지 않습니다.
가져오기, 깨우기, 운영 상태의 대기 지표는 같은 SQL 조각(`campaignDeliveryDueSql`)을 읽습니다.

### 최종 guard

가져온 뒤, 계정 확인 읽기 뒤, 그리고 transport의 `beforeSend`에서 POST 직전에 다시 검사합니다. 모두 데이터베이스에서 읽으며, `graphFetch`의 기존 연결 검사도 POST마다 한 번 더 실행됩니다.
수신자 단위 조건은 미리보기와 시작이 쓰는 같은 SQL 조각(`src/app/campaign-drafts.ts`의 `RECIPIENT_STAGE`와 `LATEST_TEXT`, 연결과 대상 조건은 `CONNECTION_SENDABLE`과 `CONTACT_PAUSED`)을 읽습니다.
guard는 저장된 수신자의 단계만 봅니다. 다른 수신자를 고르지 않습니다. 미리보기, 승인, 시작 결과는 바뀌지 않습니다(조각으로 나눈 뒤에도 `EVALUATION_SQL` 문자열이 바이트 단위로 같음을 확인했습니다).

| 조건                                                                                          | 결과                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------- |
| 가져온 행을 잃음                                                                              | 차단 `delivery_changed`                 |
| 실행이 `running`이 아님(취소됨)                                                               | 행을 `cancelled` / `run_cancelled`로 둠 |
| 전역 `SEND_ENABLED`가 `true`가 아님                                                           | 재시도 `global_send_disabled`           |
| 연결이 비활성·발송 꺼짐·토큰 없음·토큰 만료                                                   | 차단 `connection_unavailable`           |
| 연결은 보낼 수 있으나 토큰이 바뀜                                                             | 재시도 `token_rotated`                  |
| 연결 일시 중지(`send_paused_until`)                                                           | 재시도 `connection_paused`              |
| 승인한 사용자가 그 작업 공간의 활성 `owner`·`admin`이 아님                                    | 차단 `approver_unavailable`             |
| 댓글 작성자의 수동 중지 또는 상담 전환 중지                                                   | 재시도 `contact_paused`                 |
| 저장된 수신자가 지금 그 댓글 작성자의 확인된 DM 수신자가 아님                                 | 차단 `no_dm_identity`                   |
| 수신자나 댓글 작성자의 마케팅·서비스 답장 철회, 또는 그 작성자와 연결된 DM 수신자의 수신 거부 | 차단 `recipient_opted_out`              |
| 정확한 명시적 마케팅 동의 없음                                                                | 차단 `marketing_consent_required`       |
| 열린 24시간 텍스트 창 없음                                                                    | 차단 `reply_window_closed`              |
| 동의·확인 읽기 실패                                                                           | 재시도 `consent_unavailable`            |

수신 거부는 미리보기의 단계 4(그 수신자와 그 작성자)와 다른 worker의 `deliveryRecipientOptedOut`(그 작성자와 연결된 모든 DM 수신자의 서비스 답장 철회)를 모두 검사합니다.
차단 사유가 하나라도 있으면 재시도 사유보다 앞섭니다. 그래서 일시 중지가 길어져도 창이 닫히거나 동의가 없어진 행은 끝납니다. 같은 종류 안에서는 위 표의 순서로 첫 사유를 기록합니다.
재시도는 행을 `pending`으로 되돌리고 시도 열을 비우며, `next_attempt_at`을 1분 뒤로 미룹니다. 차단은 행을 `blocked`와 사유로 끝냅니다.
승인자 검사는 예약 수동 답장의 작성자 검사보다 엄격합니다. 예약 수동 답장은 작성자가 관리자에서 상담원으로 바뀌어도 보내지만, 캠페인 발송 행은 승인자가 지금도 활성 `owner`·`admin`이어야 하므로 상담원으로 바뀐 승인자의 행은 `approver_unavailable`로 차단됩니다. 승인 자체가 관리자 권한이므로 운영자가 승인한 계획의 역할 목록을 따랐습니다. 이 검사로 [알려진 한계](#알려진-한계)의 승인자 항목이 해결됩니다.
연결 일시 중지가 guard를 지난 뒤 `graphFetch`의 POST 직전 검사에서야 보이면(다른 큐 호출의 속도 제한), 그 검사는 다른 worker처럼 `connection_changed` 차단을 던집니다. 캠페인 transport는 이것을 받아, 연결이 일시 중지만 되어 있고 활성·발송 켜짐·유효 토큰이면 재시도 `connection_paused`로 바꿉니다.

### 결과

결과 분류는 수동 답장 worker와 같이 `instagramAdapter.classifySendError`와 `classifyMetaGraphFailure`를 씁니다.

- 성공: `sent`, `provider_message_id`, `sent_at`.
- 계정 확인이 다른 계정을 가리킴: 차단 `authorization_unverified`. 계정 확인 읽기 실패: 재시도 `verification_unavailable`.
- 보내기 전 재시도(`PreSendVerificationError` `retry`): `pending`, 1분 뒤. 보내기 전 차단: `blocked`.
- 공급자의 명확한 거절: `failed` / `meta_error_<code>`.
- 공급자의 속도 제한: 행은 `pending`으로 돌아가고 시도 열을 비우며 `next_attempt_at`은 일시 중지가 끝나는 시각입니다. 연결의 `send_paused_until`은 수동 답장처럼 `max(900초, Retry-After)`만큼 밀립니다. 일시 중지 동안 그 연결의 다른 캠페인 행도 가져가지 않습니다.
- 그 밖의 `send()` 오류: `unknown`이며 자동으로 다시 시도하지 않습니다.

결과를 쓰는 트랜잭션은 실행 행을 `FOR SHARE`로 먼저 잠그고, 속도 제한이면 연결을 `FOR NO KEY UPDATE`로 잠근 뒤 발송 행을 바꿉니다.
실행을 먼저 잠그는 순서는 취소의 순서(실행, 그다음 행)와 같습니다. 그래서 취소는 이 트랜잭션을 기다린 뒤 `pending`으로 돌아간 행을 취소합니다.
취소가 먼저 실행을 잡았다면 결과 트랜잭션이 기다린 뒤 취소된 실행을 보고, `pending`으로 돌아갈 행을 `cancelled` / `run_cancelled`로 둡니다. 따라서 취소된 실행에 `pending` 행이 남지 않습니다.
세 삭제 함수는 연결을 잡은 채 발송 행을 `NOWAIT`로 잠그고 `sending` 행이 있으면 거절하므로, 결과 트랜잭션과 교착하지 않습니다. 새 열이 생겨도 세 함수는 바뀌지 않습니다.

### 예산

`src/instagram/send-quota.ts`의 `CAMPAIGN_HOURLY_BUDGET`은 연결당 최근 1시간 동안 1,000회입니다. `campaignBudgetOpenSql`이 그 연결의 발송 행 중 `provider_called_at`이 최근 1시간 안인 행을 셉니다.
이 값은 서비스 정책이며 Meta의 한도가 아닙니다. Meta는 Instagram 프로페셔널 계정당 텍스트 Send API 호출을 초당 100회로 문서화하고, 시간당 한도나 앱 전체 메시지 한도는 문서화하지 않습니다([Instagram Platform 개요](https://developers.facebook.com/docs/instagram-platform/overview/)). 이 내용은 운영자가 승인한 계획에 기록된 2026-10-29 확인 결과이며, 이 구현 작업 중에는 문서를 다시 열어 보지 않았습니다.
1,000회로 두면 5,000명(고정 대상 상한) 실행이 약 5시간에 끝나서, 대부분의 수신자가 24시간 창 안에 받습니다.
비공개 답장 예산 700회([비공개 답장 예산](2026-10-12-send-quotas.md#비공개-답장-예산))와는 따로 셉니다. 캠페인 예산을 다 쓴 연결도 비공개 답장, 수동 답장, 팔로우 확인 DM은 계속 보냅니다.
호출 수는 POST 직전에 셉니다. 그래서 나가지 않은 요청도 호출로 세며, 예산은 일찍 멈추는 쪽으로 틀립니다.
반대로 적게 세는 경우가 하나 있습니다. 셈은 호출이 아니라 행 단위이므로, Meta가 호출 제한으로 거절한 행을 1시간 안에 다시 보내면 `provider_called_at`을 덮어써 두 POST를 한 번으로 셉니다. 이 재시도는 이미 연결을 최소 900초 일시 중지하므로 그대로 둡니다. 비공개 답장 예산도 같은 오차를 받아들입니다([셈의 오차](2026-10-12-send-quotas.md#셈의-오차)).

### 우선순위와 깨우기

큐 메시지 하나는 기존 순서대로 수동 답장, 팔로우 확인, 비공개 답장을 처리하고, 셋 중 아무것도 행을 가져가지 않았을 때만 캠페인 행 하나를 처리합니다. 그래서 자동화가 우선입니다.
캠페인 행은 `InstagramFollowTransport`와 기존 `graphFetch`로 보내며, `beforeSend`가 최종 guard를 실행합니다.
`wakeDueReplies`는 발송이 켜져 있고 유효한 토큰이 있고 일시 중지되지 않았고 캠페인 예산이 남은 연결에 기한이 된 캠페인 행(`running` 실행)이 있으면 그 연결을 깨웁니다. 메시지 하나가 행 하나를 처리한 뒤 남은 일이 있으면 같은 연결을 다시 깨웁니다.

### 완료와 오래된 sending

행이 최종 상태가 되면, 행 잠금을 놓은 뒤 별도 문장이 그 실행을 완료합니다: `running`이고 `pending`·`sending` 행이 없으면 `completed`가 되고 `version`이 1 오르며 `updated_at`이 바뀝니다.
최종 상태를 떠난 행은 다시 `pending`이나 `sending`이 되지 않으므로, 비어 있는 실행은 계속 비어 있습니다. 완료 문장은 실행 행만 `FOR NO KEY UPDATE SKIP LOCKED`로 잠그고, 다른 트랜잭션이 쥔 실행은 건너뜁니다.
`campaign_start` cron 단계는 시작 뒤에 [도달할 수 없는 행의 정리](#도달할-수-없는-행의-정리)를 실행하고, 그다음 `pending`·`sending` 행이 없는 모든 `running` 실행을 완료합니다. 시작이나 정리가 실패해도 뒤의 부분은 실행하며, 단계는 첫 실패로 실패합니다(두 번째 이후 부분 실패의 로그는 [운영 상태](2026-10-01-operations-health.md#정기-작업-기록)). 그래서 후보가 없는 실행과 마지막 행이 정리된 실행은 같은 cron에서 완료됩니다. 취소된 실행은 바꾸지 않습니다.
`stale_recovery` 단계는 10분 넘게 `sending`인 행을 `unknown` / `worker_interrupted`로 바꾸고 시도 열은 유지합니다. 같은 cron의 `campaign_start` 단계가 그 실행을 완료합니다. 운영 상태는 이 결과를 복구 시각(`updated_at`)으로 셉니다([운영 상태 문서](2026-10-01-operations-health.md#지표와-api)).
완료된 실행을 취소하면 기존처럼 `409 campaign_run_completed`입니다.

### 도달할 수 없는 행의 정리

2026-10-29 [#273](https://github.com/AndrewDongminYoo/auto-chatter/issues/273)의 계약입니다. 코드는 `src/instagram/campaign-delivery-worker.ts`의 `endUnreachableCampaignDeliveries`입니다.
가져오기와 깨우기는 대상이 일시 중지된 행과 보낼 수 없는 연결의 행을 가져가지 않습니다. 그래서 그 행이 다시 보낼 수 없게 되어도(창 닫힘, 수신 거부 등) `pending`으로 남고, 실행은 `running`으로 남았습니다.
정리는 `campaign_start` 단계 안에서 시작 뒤, 완료 앞에 실행하며, 전역 `SEND_ENABLED`가 `true`일 때만 실행합니다(단계 자체가 그렇습니다).

- 대상: `running` 실행의 `pending` 행 가운데 가져오기와 깨우기가 닿지 않는 행입니다. 댓글 작성자의 수동 중지나 상담 전환 중지(`CONTACT_PAUSED`)가 있거나, 연결이 보낼 수 없는(`CONNECTION_SENDABLE`이 거짓: 비활성, 발송 꺼짐, 토큰 없음, 토큰 만료) 행입니다. `next_attempt_at`은 보지 않습니다. 닿을 수 있는 행은 worker의 최종 guard가 판단하므로 건드리지 않습니다.
- 판정: 대상 행마다 최종 guard의 차단 사유를 guard의 순서대로 보고, 첫 사유로 `blocked`와 그 코드를 씁니다. 순서는 `connection_unavailable`, `approver_unavailable`, `no_dm_identity`, `recipient_opted_out`, `marketing_consent_required`, `reply_window_closed`입니다. 그래서 같은 행에 guard와 같은 코드를 씁니다.
- 재시도 사유(대상 일시 중지, 연결 일시 중지, 토큰 교체, 동의 읽기 실패)만 있는 행은 끝내지 않고 `pending`으로 둡니다. 읽기가 실패하면 문장 전체가 실패하고 아무것도 쓰지 않습니다.
- 같은 SQL 조각: 수신자 단계는 미리보기와 guard의 `recipientStageSql`·`latestTextSql`(작업 공간 식을 인자로 받도록 나눈 `RECIPIENT_STAGE`·`LATEST_TEXT`)과 `verifiedDmRecipientsSql`, 연결은 `CONNECTION_SENDABLE`, 승인자는 guard의 `APPROVER_ACTIVE`, 수신 거부는 `deliveryRecipientOptedOut`의 쿼리를 나눈 `deliveryRecipientOptedOutSql`(그 작성자와 연결된 모든 DM 수신자)를 읽습니다. 미리보기, 시작, guard, `deliveryRecipientOptedOut`의 SQL 문자열은 나눈 뒤에도 바이트 단위로 같습니다(검증 기록 참조).
- 쓰기: 행을 가져가지 않고, `attempt_id`를 쓰지 않고, 공급자를 호출하지 않고, 큐 메시지를 보내지 않습니다. `status='blocked'`, `failure_code`, `updated_at`만 쓰며 `status='pending'`을 조건으로 합니다. 그래서 정리로 끝난 `blocked` 행에는 시도 열이 없고, migration 067이 이를 위해 `campaign_delivery_attempt` CHECK를 넓혔습니다(아래).
- 잠금: 한 문장, 한 시계입니다. 실행, 승인, 연결, 대상 행은 잠그지 않고 읽고, 발송 행만 `created_at`, `id` 순으로 `FOR UPDATE OF d SKIP LOCKED`로 잠급니다. 마지막 UPDATE는 외래 키 열을 바꾸지 않으므로 실행이나 연결에 키 잠금도 걸지 않습니다. 그래서 취소(실행, 그다음 행)와도, 삭제 함수(연결, 그다음 행 `NOWAIT`)와도 교착하지 않습니다. 다른 트랜잭션이 쥔 행은 건너뛰며, 그 짧은 동안 삭제 함수가 행을 잠그지 못하면 지금처럼 `sending_in_progress`로 거절합니다.
- 한도: 한 번에 최대 `CAMPAIGN_SWEEP_LIMIT`(500)행, 오래된 행부터입니다. 한도는 차단 사유를 정한 뒤에 적용하므로, 재시도 사유만 있어 남는 오래된 행이 뒤의 행을 막지 않습니다. 대상 행은 한도와 관계없이 모두 읽으므로 비용은 실행 중인 실행의 일시 중지된 대상과 보낼 수 없는 연결의 `pending` 행 수에 비례합니다.
- 결과: 운영 상태의 `blocked_24h`는 정리된 행을 시도 시각이 없으므로 생성 시각으로 셉니다([운영 상태 문서](2026-10-01-operations-health.md#지표와-api)).

migration 067은 `blocked` 행에 시도 열이 없어도 되도록 `campaign_delivery_attempt`를 다시 만듭니다. 나머지 규칙(`pending`은 시도 열 없음, 두 시도 열은 함께 비거나 함께 참)은 그대로입니다.
이 완화는 계획이 067에 정한 `recovered_at` 열 밖의 계약 변경이며, 정리가 `attempt_id`를 쓰지 않으려면 피할 수 없습니다.
완화는 정리가 끝낸 행만이 아니라 모든 `blocked` 행에 적용됩니다. worker는 행을 가져간 뒤에만 차단하므로 그 `blocked` 행은 여전히 시도 열을 갖지만, 이제 CHECK가 아니라 worker의 DB 검사(최종 guard 검사와 POST 직전 guard 검사의 `attempted`)가 이를 확인합니다.
같은 migration이 [운영 상태](2026-10-01-operations-health.md#지표와-api)의 `recovered_at` 열도 추가합니다.
배포 순서는 066과 같습니다: 067을 전체 실행기(`deploy/migrate-multi-user.sql`)로 적용한 뒤 코드를 배포합니다. 067 없이 이 코드가 돌면 정리의 UPDATE가 CHECK 위반으로 실패해 `campaign_start` 단계가 실패하고(완료는 계속 실행), 복구 문장과 운영 상태의 지표·경보 읽기는 없는 `recovered_at` 열 때문에 실패합니다.

### 재승인 거절

`POST /api/campaign-drafts/:id/approvals`는 같은 초안 버전에 `executed` 승인이 있으면 `409 campaign_version_executed`와 그 승인(가장 최근 것)을 돌려주고 아무것도 쓰지 않습니다. 그래서 초안을 수정하지 않고는 같은 고정 대상이 두 번 시작되지 않습니다.
검사 순서는 요청 ID 재전송, 초안 버전, 유효한 승인, 그다음 이 검사입니다. 실행된 승인을 만든 요청을 다시 보내면 지금처럼 그 승인을 200으로 돌려줍니다.
화면은 다른 409처럼 응답의 승인으로 다시 표시하고, 초안을 수정해 저장한 뒤 승인하라고 안내합니다.
PR ② 이전에 기록된 데이터에는 같은 버전에 실행된 승인과 유효한 승인이 함께 있을 수 있습니다. 이 검사는 새 승인만 막고 기존 승인은 바꾸지 않습니다.

### 응답, 화면, 운영 상태

- 승인과 실행 응답의 `delivery_available`은 `true`입니다. 전역 발송 스위치가 실행 여부를 계속 정합니다.
- 승인 화면은 "실행 시점이 되면 서비스 전체 발송이 켜져 있을 때만 실행이 시작되고, 보내기 직전마다 모든 조건을 다시 확인한다"고 안내합니다. 실행된 승인의 상태 문구는 "실행 시작됨 · 보내기 직전에 조건을 다시 확인해 발송"입니다. ~~실행 진행률과 취소 화면은 PR ③입니다.~~ 2026-10-29 PR ③이 [실행 현황 화면](#실행-현황-화면)으로 구현했습니다.
- 운영 상태(`src/app/operations-health.ts`)는 연결별 대기 지표(가져오기와 같은 조건, 캠페인 예산 포함, 시작 시각은 [운영 상태 문서](2026-10-01-operations-health.md#지표와-api)), `sending` 체류, 최근 24시간 `unknown`·`failed`·`blocked` 수와 `unknown` 경보의 전체 수에 캠페인 발송 행을 넣습니다.

### 배포 순서

1. migration 066을 전체 실행기(`deploy/migrate-multi-user.sql`)로 적용합니다. 066은 열과 색인만 추가합니다.
2. 코드를 배포합니다. `SEND_ENABLED`가 `false`인 동안에는 실행도 발송도 시작되지 않습니다.
3. `SEND_ENABLED`를 `true`로 바꾸기 전에 [이미 있는 승인과 배포 순서](#이미-있는-승인과-배포-순서)의 조회를 합니다. 이제 실행된 승인의 행은 바로 발송 대상이 됩니다.

## 실행 현황 화면

2026-10-29 운영자가 PR ③의 계획을 승인했고, 자동 갱신 없이 명시적 새로고침만 쓰기로 했습니다.
서버 동작, 스키마, migration, `SEND_ENABLED`는 바꾸지 않았습니다. 기존 `GET /api/campaign-runs/:id`와 취소 API만 씁니다.
검증 결과는 [실행 현황 화면 검증](../notes/2026-10-29-campaign-run-screen-verification.md)에 기록합니다.

### 읽는 시점

초안 상세의 실행 승인 영역(관리자만)이 `run_id`가 있는 승인을 표시하면, 그 아래 ‘실행 현황’ 패널이 그 실행을 한 번 읽습니다.
그 뒤에는 ‘실행 현황 새로고침’을 누를 때와, 취소 거절에 쓸 수 있는 실행이 없을 때만 다시 읽습니다. 타이머와 폴링은 없습니다.
`run_id`가 없는 승인(유효한 승인, 취소된 승인)이나 승인이 없는 초안에서는 실행을 읽지 않고 패널을 숨깁니다.
조회 중에는 새로고침 버튼을 끄며, 조회에 실패하면 안내와 새로고침만 남기고 취소는 제공하지 않습니다.

### 표시와 문구

- 상태는 `running` 진행 중, `cancelled` 취소됨, `completed` 완료입니다. 취소된 실행은 취소 시각을 함께 보입니다. 승인 상태의 기존 문구는 바꾸지 않습니다.
- 시작 시각(`start.as_of`)과 취소 시각은 화면이 일정 표시에 쓰는 작업 공간 시간대로 보입니다.
- 저장된 시작 수: 원래 인원, 남은 인원, 미리보기와 같은 사유 이름의 조건별 인원 표입니다. `candidate`는 ‘조건 통과’이며 화면 어디에도 ‘발송 가능’이라고 쓰지 않습니다.
- 발송 행의 일곱 상태를 대기, 보내는 중, 보냄, 실패, 차단, 결과 불명, 취소로 보입니다. 수는 10진 문자열을 `BigInt`로 읽어 2^53을 넘어도 정확합니다.
- 수 아래에 한 번, 모든 행은 보내기 직전에 조건을 다시 확인하며 서비스 전체 발송이 켜져 있을 때만 발송이 진행된다고 안내합니다. 보냄은 Meta가 요청을 받았다는 뜻일 뿐 상대가 읽었다는 뜻이 아니며, 결과 불명은 자동으로 다시 보내지 않는다고 적습니다.
- 수신자, 댓글 작성자, 연결의 식별자는 API에 없으므로 표시하지 않습니다. 취소한 멤버도 표시하지 않습니다.

### 실행 취소 흐름

- `running`인 실행에만 ‘실행 취소’가 보입니다. 누르면 확인 단계가 열려 실행 ID와 표시한 `version`(`expected_version`)을 고정하고, 대기 중인 행은 모두 취소되며 이미 보내는 중인 행은 되돌릴 수 없다고 안내합니다. 확인 전에는 아무것도 보내지 않습니다.
- ‘실행 취소 확정’이 `POST /api/campaign-runs/:id/cancel`에 `{expected_version}`을 보냅니다. 성공하면 응답의 실행으로 다시 표시하고 `cancelled_delivery_count`를 보이며, `delivery_counts.sending`이 `"0"`이 아니면 그 행은 되돌릴 수 없다고 덧붙입니다.
- `409 campaign_run_conflict`, `campaign_run_cancelled`, `campaign_run_completed`는 응답이 담은 실행으로 다시 표시하고 코드마다 안내를 보입니다. 자동으로 재시도하지 않습니다. 쓸 수 있는 실행이 없는 거절(404 포함)은 실행을 다시 읽습니다. 공용 API 래퍼는 409 본문의 `run`을 `error.run`으로 전달합니다.
- 네트워크 오류, 5xx, 잘못된 성공 본문은 결과 불명이고, 429는 이전 시도의 결과를 알려 주지 않습니다. 두 경우 모두 고정한 요청을 유지하고 ‘같은 요청 재시도’만 허용하며, 확인 단계를 닫을 수 없습니다.
- 결과 불명인 취소가 있는 동안에는 다른 초안 열기, 새 초안, 승인 상태 새로고침, 시간대 변경의 승인 다시 읽기를 막아 그 요청을 잃지 않습니다. 실행 현황 새로고침은 허용하며, 다시 읽어도 고정한 요청의 `expected_version`은 바뀌지 않습니다.

### 늦은 응답

모듈의 세대(`generation`)와 실행 요청 번호를 씁니다.
실행 조회나 취소 응답은 다른 초안 열기, 새 초안, 승인 변경(승인 다시 읽기 포함), 세션 초기화, 작업 공간 변경, 더 새로운 실행 조회 뒤에 도착하면 버립니다. 요청한 실행과 ID가 다른 응답도 버립니다.
세션이나 작업 공간이 바뀌면 패널을 지웁니다. 403과 401은 기존처럼 화면을 초기화합니다.

## 데이터 경계

- 작업 공간 삭제(`delete_workspace_data`)는 발송 행, 실행, 그다음 승인 순으로 지웁니다.
- 연결 삭제(`delete_connection_data`)는 그 연결의 발송 행을 지우고 실행과 시작 수는 남깁니다.
- 개인 삭제(`delete_person_data`)는 기존 식별자 closure의 댓글 작성자나 DM 수신자에 해당하는 발송 행을 지우고 실행과 시작 수는 남깁니다.
- 세 함수 모두 해당 범위의 발송 행이 `sending`이면 `sending_in_progress`로 거절합니다.
  세 함수 모두 발송 행을 `FOR UPDATE NOWAIT`로 잠그며, 다른 트랜잭션이 쥔 행(진행 중인 실행 취소 포함)이 있으면 기다리지 않고 같은 코드로 거절합니다.
  개인 삭제의 다른 발송 테이블은 기존처럼 기다리는 `FOR UPDATE`이고, 발송 행만 `NOWAIT`입니다.
- 작업 공간 내보내기는 두 테이블을 포함합니다. 비밀 열은 없습니다.
- 두 작업 공간 이동 검사(`currentWorkspaceMovable`, `deploy/assign-workspace-owner.sql`)는 두 테이블의 행을 비어 있지 않음으로 셉니다.
- 서버 역할은 두 테이블에 SELECT·INSERT·UPDATE만 갖고 DELETE가 없습니다. RLS가 켜져 있고 API 역할은 접근할 수 없습니다.
- outbox, 수동 답장, 동의, 외부 전송 테이블에는 쓰지 않습니다.

## 이미 있는 승인과 배포 순서

migration 064와 승인 화면은 "기록만 하며 발송하지 않음" 계약으로 이미 운영에 배포됐습니다([Cloudflare runbook](../notes/2026-09-26-cloudflare-runbook.md)의 2026-10-27 Worker `cb7e7d5e` 배포 기록, `SEND_ENABLED=false` 유지).
065는 기존 `approved` 행을 그대로 두고, 기한 조건에는 승인 시각의 하한이 없습니다.
따라서 이 코드가 배포된 뒤 `SEND_ENABLED`를 처음 `true`로 바꾸면, 첫 cron부터 그때까지 남은 즉시 승인과 기한이 지난 예약 승인이 분당 `CAMPAIGN_START_LIMIT`개씩 실행을 시작하고 `executed`가 됩니다.
그 뒤에는 그 승인의 취소와 예약 변경이 `409 campaign_approval_executed`로 거절되고, 실행 취소만 남습니다. PR ②가 들어오면 그 실행의 `pending` 행이 발송 대상이 됩니다.

그래서 배포 절차는 다음 순서를 지킵니다.

1. 065를 적용하기 전에 관리자 연결로 `approved` 승인을 조회합니다: `SELECT workspace_id, id, draft_id, draft_version, schedule_kind, scheduled_at, approved_at FROM campaign_approvals WHERE status='approved' ORDER BY approved_at;`
2. 운영자가 각 승인을 유지할지, 승인 화면이나 `POST /api/campaign-approvals/:id/cancel`로 취소할지 정합니다.
3. `SEND_ENABLED`를 `true`로 바꾸기 직전에 같은 조회를 다시 하고, 남은 승인이 모두 운영자가 실행하기로 정한 것인지 확인합니다.

기존 승인에 나이 제한을 둘지(예: 065 이전 승인은 실행하지 않음)는 운영자 결정이며, 이 PR은 위 절차로 다룹니다.

## 알려진 한계

- 작업 공간 내보내기는 50,000행(`WORKSPACE_EXPORT_LIMITS.maxRows`)을 넘으면 전체를 거절합니다. 발송 행은 실행마다 최대 5,000개이고 서버 역할이 지울 수 없으므로, 고정 대상 명단 행(최대 20,000개)과 함께 쌓이면 몇 번의 큰 실행 뒤 내보내기가 거절될 수 있습니다. 발송 행 상한이나 보존 기간은 운영자가 정할 후속 결정입니다.
- 시작은 승인한 관리자의 현재 멤버 자격을 다시 확인하지 않습니다. ~~보내기 직전 검사에 이를 넣을지는 PR ②에서 정합니다.~~ PR ②가 보내기 직전 검사에 넣었습니다(`approver_unavailable`).
- ~~(PR ②) 발송이 꺼졌거나 토큰이 없거나 만료된 연결의 행은 깨우지도 가져가지도 않으므로 그 실행은 `running`으로 남습니다. 연결이 다시 보낼 수 있게 되면 행을 가져가 창이 닫힌 행은 차단으로 끝나고, 그 전에는 실행 취소로 끝낼 수 있습니다.~~ 2026-10-29 [#273](https://github.com/AndrewDongminYoo/auto-chatter/issues/273)의 [정리](#도달할-수-없는-행의-정리)가 그런 행과 일시 중지된 대상의 행을 차단 사유가 있으면 `blocked`로 끝냅니다. 재시도 사유만 있는 일시 중지된 대상의 행은 일시 중지가 풀리거나 차단 사유가 생길 때까지 `pending`이고, 그동안 실행은 `running`입니다.
- (PR ②) 캠페인 예산은 삭제한 행의 호출을 이월하지 않습니다. 개인·연결 삭제로 지운 행의 최근 호출은 셈에서 빠집니다.
- (PR ②) 마지막 guard와 Meta POST는 원자적이지 않습니다. guard를 지난 뒤의 취소나 설정 변경은 이미 나간 요청을 되돌리지 못합니다. 결과를 쓸 때 실행이 취소되어 있어도 보낸 행은 `sent`로 남습니다.
- (PR ②) 같은 사람이 여러 실행에 들어 있으면 실행마다 따로 받습니다. 실행 사이의 중복은 막지 않습니다.
- ~~실행 화면은 PR ③입니다.~~ 이 PR(①)은 관리 화면이 실행된 승인을 오류로 처리하지 않도록 상태 문구와 `campaign_approval_executed` 안내만 추가했습니다. 2026-10-29 PR ③이 [실행 현황 화면](#실행-현황-화면)을 구현했습니다.
- (PR ③) 실행 현황은 자동으로 갱신하지 않습니다. 화면의 수는 마지막으로 읽은 시점의 값이며, 운영자가 ‘실행 현황 새로고침’을 눌러야 바뀝니다.

## PR ②와 ③의 계획

PR ②(발송 worker)는 다음을 맡습니다.

- `pending` 행을 `FOR UPDATE SKIP LOCKED`와 새 `attempt_id`로 가져와 `sending`으로 바꿉니다. 이후 모든 변경은 `status='sending' AND attempt_id=$n`을 조건으로 합니다.
- 취소는 실행 행을 잠근 뒤 발송 행을 바꾸므로, worker가 발송 행을 쥔 채 실행 행을 잠그면 교착이 생깁니다. worker는 실행 상태를 잠그지 않고 읽거나 행보다 실행을 먼저 잠가야 합니다.
- 세 삭제 함수는 연결을 잡은 채 발송 행을 `NOWAIT`로 잠그므로, 발송을 마무리하는 트랜잭션이 행을 쥔 채 연결 잠금을 기다려도 교착 대신 삭제가 `sending_in_progress`로 거절됩니다.
- 보내기 직전에 실행 상태, 전역 발송 스위치, 연결의 토큰·발송 설정·일시 중지, 대상 일시 중지와 상담 전환, 확인된 DM 연결, 수신 거부, 정확한 명시적 마케팅 동의, 24시간 창을 모두 다시 검사합니다.
- 승인에 저장된 본문 사본을 태그 없는 일반 텍스트로 보냅니다.
- 예산, 재시도, 오래된 `sending`의 복구, 실행 완료(`completed`)를 다룹니다.

2026-10-29 정합 기록: 위 PR ② 계획은 이 저장소의 PR ②가 구현했습니다. 구현의 기준은 [발송 worker](#발송-worker) 절과 `src/instagram/campaign-delivery-worker.ts`이며, 검증은 [캠페인 발송 검증](../notes/2026-10-29-campaign-delivery-verification.md)입니다.
계획에 없던 결정은 승인자 검사, 차단 사유의 우선, 취소된 실행에서 되돌아갈 행의 `cancelled` 처리, 연결당 시간당 1,000회 예산, 실행된 버전의 재승인 거절입니다.

PR ③(화면)은 승인 상세에서 실행을 찾아 진행률과 상태별 수를 보이고 취소를 제공합니다.

2026-10-29 정합 기록: 위 PR ③ 계획은 이 저장소의 PR ③이 구현했습니다. 구현의 기준은 [실행 현황 화면](#실행-현황-화면) 절과 `public/app/campaign-drafts.js`이며, 검증은 [실행 현황 화면 검증](../notes/2026-10-29-campaign-run-screen-verification.md)입니다.
계획에 없던 결정은 새로고침만으로 다시 읽기(자동 갱신 없음)와, 결과 불명인 취소가 있는 동안 초안 전환과 승인 다시 읽기를 막는 것입니다.

범위 밖은 템플릿([#265](https://github.com/AndrewDongminYoo/auto-chatter/issues/265)), 일일 상한([#52](https://github.com/AndrewDongminYoo/auto-chatter/issues/52)), [#262](https://github.com/AndrewDongminYoo/auto-chatter/issues/262)입니다.
