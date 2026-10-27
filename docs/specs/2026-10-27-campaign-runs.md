# 캠페인 실행과 수신자별 발송 행

## 상태와 근거

2026-10-27 운영자가 계획을 승인했습니다.
결정은 다음과 같습니다.

- [#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36)의 서버부터 시작합니다.
- 캠페인 발송은 24시간 표준 메시지 창 안에서, 정확한 명시적 마케팅 동의가 있을 때만 허용합니다.
- Cloudflare OAuth 표면에서 Instagram 마케팅 capability를 지원으로 선언하고, 아래 Meta 정책을 근거로 인용합니다.

#36은 세 PR로 나눕니다: ① 실행과 발송 행(이 문서의 구현 범위), ② 발송 worker, ③ 화면.
이 PR은 아무것도 보내지 않습니다: Graph 호출, transport, outbox 행, 큐 메시지가 없습니다.
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
- CHECK가 상태와 열을 묶습니다: `pending`은 시도 열이 비어 있고, `sending`·`sent`·`failed`·`blocked`·`unknown`은 `attempt_id`와 `attempt_started_at`이 있으며, `provider_message_id`와 `sent_at`은 `sent`일 때만 있고, `failed`·`blocked`는 `failure_code`가 있습니다.
- `recipient_id`는 숫자 DM 수신자 ID이며, 연결은 같은 작업 공간의 연결이어야 합니다(복합 외래 키).

### 승인의 실행 상태

`campaign_approvals.status`에 `executed`가 추가됩니다.
실행된 승인은 행을 유지하며 예약 변경과 취소가 `409 campaign_approval_executed`와 현재 승인으로 거절됩니다.
실행 전환은 승인의 `version`을 올리지 않고 감사 행도 쓰지 않습니다. 감사 행은 행위자가 필요한데 cron 단계에는 행위자가 없으므로, 실행 기록은 `campaign_runs` 행입니다.
실행된 승인은 초안을 더 이상 고정하지 않으므로, 초안을 수정하고 다시 승인할 수 있으며 새 승인은 자기 실행을 시작합니다.
초안을 수정하지 않고 같은 버전을 다시 승인할 수도 있습니다. 그 승인은 같은 고정 대상으로 두 번째 실행을 시작하고, 중복 키는 실행마다 따로이므로 같은 사람에게 두 번째 발송 행이 생깁니다.
같은 초안 버전의 재승인을 막을지, 실행 사이의 중복 발송을 막을지는 PR ②가 실제로 보내기 전에 운영자가 정할 결정입니다.
승인 목록과 상세 응답에는 `run_id`와 `run_status`가 추가됩니다(실행이 없으면 `null`). 기존 키의 의미는 바뀌지 않으며 `delivery_available`은 계속 거짓입니다.

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

`GET /api/campaign-runs/:id`(`admin`)는 실행 열, 저장된 시작 수(`start: {as_of, original_member_count, remaining_member_count, counts}`), 상태별 발송 행 수(`delivery_counts`, 일곱 상태 모두 10진 문자열), `delivery_available: false`를 돌려줍니다.
댓글 작성자·DM 수신자 식별자는 응답에 없습니다.
화면(PR ③)은 승인의 `run_id`로 실행을 찾습니다.

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
- 시작은 승인한 관리자의 현재 멤버 자격을 다시 확인하지 않습니다. 보내기 직전 검사에 이를 넣을지는 PR ②에서 정합니다.
- 실행 화면은 PR ③입니다. 이 PR은 관리 화면이 실행된 승인을 오류로 처리하지 않도록 상태 문구와 `campaign_approval_executed` 안내만 추가했습니다.

## PR ②와 ③의 계획

PR ②(발송 worker)는 다음을 맡습니다.

- `pending` 행을 `FOR UPDATE SKIP LOCKED`와 새 `attempt_id`로 가져와 `sending`으로 바꿉니다. 이후 모든 변경은 `status='sending' AND attempt_id=$n`을 조건으로 합니다.
- 취소는 실행 행을 잠근 뒤 발송 행을 바꾸므로, worker가 발송 행을 쥔 채 실행 행을 잠그면 교착이 생깁니다. worker는 실행 상태를 잠그지 않고 읽거나 행보다 실행을 먼저 잠가야 합니다.
- 세 삭제 함수는 연결을 잡은 채 발송 행을 `NOWAIT`로 잠그므로, 발송을 마무리하는 트랜잭션이 행을 쥔 채 연결 잠금을 기다려도 교착 대신 삭제가 `sending_in_progress`로 거절됩니다.
- 보내기 직전에 실행 상태, 전역 발송 스위치, 연결의 토큰·발송 설정·일시 중지, 대상 일시 중지와 상담 전환, 확인된 DM 연결, 수신 거부, 정확한 명시적 마케팅 동의, 24시간 창을 모두 다시 검사합니다.
- 승인에 저장된 본문 사본을 태그 없는 일반 텍스트로 보냅니다.
- 예산, 재시도, 오래된 `sending`의 복구, 실행 완료(`completed`)를 다룹니다.

PR ③(화면)은 승인 상세에서 실행을 찾아 진행률과 상태별 수를 보이고 취소를 제공합니다.

범위 밖은 템플릿([#265](https://github.com/AndrewDongminYoo/auto-chatter/issues/265)), 일일 상한([#52](https://github.com/AndrewDongminYoo/auto-chatter/issues/52)), [#262](https://github.com/AndrewDongminYoo/auto-chatter/issues/262)입니다.
