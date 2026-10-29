# 캠페인 발송 worker 검증

## 범위와 기준

[캠페인 실행 계약](../specs/2026-10-27-campaign-runs.md)의 PR ②([발송 worker](../specs/2026-10-27-campaign-runs.md#발송-worker))를 구현했습니다.
구현 범위는 migration 066, `src/instagram/campaign-delivery-worker.ts`, Queue 경로와 깨우기, 오래된 `sending` 복구와 실행 완료, 연결당 시간당 1,000회 캠페인 예산, 실행된 초안 버전의 재승인 거절, 응답의 `delivery_available: true`, 승인 화면 문구, 운영 상태 지표입니다.
기준 HEAD는 `72fb4c6`이며 아래 로컬 검사는 커밋 전 작업 변경을 대상으로 수행했습니다.
실행 진행률·취소 화면(PR ③), 템플릿, 일일 상한, 삭제한 행의 호출 이월은 포함하지 않습니다.
의존성 변경은 없습니다.
실제 발송은 하지 않았습니다. 모든 Graph 요청은 `fetchImpl`, 전역 `fetch` mock 또는 Miniflare `outboundService`가 받았고, 운영 DB·실계정·Meta는 사용하지 않았습니다. 저장소의 `SEND_ENABLED`는 `false` 그대로입니다.
이 검증은 [#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36)이나 [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35)의 완료나 운영 적용을 뜻하지 않습니다(Refs #36).

## 검사와 읽는 대상

새 DB 검사는 `src/instagram/campaign-delivery-worker.db.test.ts`(34개)입니다.
실제 `startDueCampaignRuns`로 실행을 시작하고, Cloudflare와 같은 조합(`InstagramFollowTransport`, mock `fetchImpl`, `beforeSend`의 `assertCampaignDeliveryAllowed`)으로 `processNextCampaignDelivery`를 부릅니다. 이 PR용 일회용 PostgreSQL 17 클러스터(포트 5446)를 사용합니다.
두 트랜잭션의 순서는 테스트 pool이 지정한 문장 직후 트랜잭션 안에서 멈추게 하고, 다른 쪽이 `pg_stat_activity`에서 잠금 대기에 들어간 것을 확인한 뒤 풀어서 정합니다.

- 성공: 저장된 수신자에게 승인 본문 사본을 `{"recipient":{"id":"2001"},"message":{"text":…}}` 하나로 보냅니다. 행은 `sent`, `provider_message_id`, `sent_at`, `provider_called_at`을 갖고, 마지막 행이므로 실행이 `completed`(버전 2)가 됩니다. Graph 호출은 계정 읽기 하나와 POST 하나뿐입니다.
- 가져오기 순서: `next_attempt_at`이 가장 이른 행을 먼저 가져가고, 아직 기한이 아닌 행과 댓글 작성자가 일시 중지된 행은 가져가지 않습니다. 취소된 실행의 행은 가져가지 않습니다.
- `SKIP LOCKED`: 다른 트랜잭션이 잡은 행은 기다리지 않고 건너뛰어 다음 행을 보냅니다. 동시에 실행한 worker 둘은 행을 하나씩 보냅니다.
- 최종 guard(계정 확인 읽기 중에 바꾼 조건을 두 번째 guard가 봄): 창 닫힘 `reply_window_closed`, 마케팅 동의 없음 `marketing_consent_required`, 마케팅 동의 철회·댓글 작성자 수신 거부·같은 작성자와 연결된 다른 DM 수신자의 수신 거부 `recipient_opted_out`, DM 식별 모호 `no_dm_identity`, 연결 발송 꺼짐·토큰 만료 `connection_unavailable`, 승인자 제거·`agent` 강등 `approver_unavailable`은 차단입니다. 대상 일시 중지·상담 전환 중지 `contact_paused`, 연결 일시 중지 `connection_paused`, 토큰 교체 `token_rotated`는 시도 열을 비우고 1분 뒤로 미룹니다. 어떤 경우에도 POST가 없고 호출 수도 늘지 않습니다.
- 다른 수신자의 수신 거부 검사는 선택되지 않은 두 번째 수신자를 철회시키므로, 미리보기의 단계 4만으로는 통과하지 못합니다.
- 차단 우선: 대상 일시 중지와 창 닫힘이 함께 있으면 `reply_window_closed` 차단입니다.
- POST 직전 guard: 두 번째 guard 뒤 호출 수를 기록하는 순간 창이 닫히면 `beforeSend`의 guard가 막아 POST가 없고, 행은 `reply_window_closed` 차단이며 호출 수는 남습니다.
- 실행 취소: 가져온 뒤 POST 전에 실행을 취소하면 가져온 행은 `cancelled`/`run_cancelled`, 나머지 행은 취소 API가 `cancelled`로 바꿉니다.
- 전역 스위치: `globalSendEnabled`가 거짓이면 Graph 호출 없이 `global_send_disabled`로 미룹니다.
- 동의 읽기 실패: `channel_consent_state` 읽기가 실패하면 `consent_unavailable`로 미룹니다.
- 계정 확인: 다른 계정이면 `authorization_unverified` 차단, 읽기 실패면 `verification_unavailable`로 미룹니다.
- 결과 분류: HTTP 400 코드 100은 `failed`/`meta_error_100`, HTTP 502는 `unknown`/`send_outcome_unknown`이며 다시 가져가지 않습니다.
- 속도 제한: HTTP 400 코드 4와 `Retry-After: 1200`이면 행은 `pending`, 시도 열이 비고, `next_attempt_at`이 연결의 `send_paused_until`과 마이크로초까지 같고, 일시 중지는 약 1,200초입니다. 그동안 다른 행은 가져가지 않습니다. `Retry-After`가 없는 코드 613은 900초 일시 중지입니다.
- 예산: 최근 1시간 호출 1,000회인 연결은 가져가지 않고, 그중 하나가 1시간을 벗어나면 가져갑니다.
- 오래된 `sending`과 완료: 11분 된 `sending` 행은 `unknown`/`worker_interrupted`(시도 열 유지), 방금 시작한 행은 그대로입니다. cron 완료는 그 실행과 후보 없는 실행을 `completed`로 바꾸고 취소된 실행과 진행 중인 실행은 바꾸지 않습니다. 행 둘인 실행은 두 번째 행이 끝난 뒤에야 완료되고, 완료된 실행의 취소는 `campaign_run_completed`입니다.
- 취소와 결과 쓰기의 경합: 취소가 실행을 먼저 잡으면 결과 쓰기는 `FOR SHARE`로 기다립니다. 보낸 행은 `sent`, 미룰 행은 `cancelled`/`run_cancelled`가 되고 실행은 `cancelled`입니다. 결과 쓰기가 먼저 잡으면 취소가 `FOR UPDATE`로 기다린 뒤 `pending`으로 돌아간 행을 취소합니다(`cancelled_delivery_count` "1"). 마지막 행을 보낸 경우 실행은 `completed`(취소는 `campaign_run_completed`)이거나, 완료 문장이 취소가 쥔 실행을 건너뛰면 `cancelled`입니다. 모든 경우 교착이 없고 취소된 실행에 `pending` 행이 남지 않습니다.
- 운영 상태: 기한이 20분 지난 캠페인 행이 대기 지표에 들어가고, 대상 일시 중지로 묶인 행은 빠집니다. `sending` 체류, 24시간 `unknown`·`failed`·`blocked` 수, `unknown` 경보의 전체 수(`alert_seen_count` "1")에 캠페인 행이 들어갑니다.
- 예산에 묶인 실행의 대기 지표: 기한이 65분 지난 행이 있어도, 예산이 1분 전에 풀렸으면(1,000번째 최근 호출이 61분 전) 대기는 60초 남짓이고 `oldest_pending` 경보가 켜지지 않습니다. 마지막 호출이 10초 전이면 대기는 60초 미만입니다. 모든 호출이 2시간 전이면(예산이 1시간 전에 풀린 뒤 멈춘 큐) 대기는 3,599초 이상이고 경보가 켜집니다.

기존 검사도 새 동작을 읽습니다.

- `src/cloudflare/worker.db.test.ts`: 수동 답장, 비공개 답장, 캠페인 행이 모두 있으면 큐 메시지 셋이 그 순서로 하나씩 보내고, 남은 일이 있는 동안만 연결을 다시 깨웁니다. 대기 중인 팔로우 확인 DM도 캠페인 행보다 먼저 나갑니다. 캠페인 예산을 다 쓴 연결은 캠페인 행 때문에 깨우지도 가져가지도 않지만, 같은 연결의 수동 답장과 비공개 답장은 보냅니다. 호출 하나가 1시간을 벗어나면 cron이 깨우고 큐가 보냅니다. `SEND_ENABLED`가 거짓이면 cron이 깨우지 않고 큐는 보내지 않습니다. cron은 오래된 `sending` 행을 `unknown`으로 바꾸고 같은 실행에서 그 실행을 완료합니다. 후보 없는 실행은 시작한 같은 cron에서 `completed`가 됩니다. guard를 지난 뒤 `graphFetch`의 POST 직전 검사에서야 연결 일시 중지가 보이면 POST 없이 행은 `pending`/`connection_paused`이고 실행은 `running`입니다.
- `src/cloudflare/runtime.db.test.mjs`: workerd에서 제한된 서버 역할로 cron이 시작한 실행의 행 하나를 큐 메시지 하나가 보냅니다. 새 Graph 요청은 `/v24.0/me`와 `/v24.0/123/messages` 둘뿐이고, POST 본문은 `{"recipient":{"id":"9001"},"message":{"text":"Hello"}}`이며, 실행은 `completed`입니다. 승인 응답의 `delivery_available`은 참입니다.
- `src/app/campaign-runs.db.test.ts`: 실행된 초안 버전의 재승인은 `409 campaign_version_executed`와 실행된 승인이고 승인 행이 늘지 않습니다. 초안을 수정한 버전 2는 201이고, 실행된 승인을 만든 요청의 재전송은 200입니다. migration 066을 두 번 다시 적용해도 행이 `pending`, 기한 도래, 호출 없음으로 남고 색인 셋이 있으며 시도 열 있는 `pending`은 `23514`입니다. 실행기에서 066은 065 뒤, 접근 스크립트 앞입니다.
- `src/app/campaign-approvals.db.test.ts`: 공용 fixture의 실행된 승인이 버전 1을 실행했으므로, 승인 경계 검사는 초안을 버전 2로 수정한 뒤 승인합니다. 승인 응답과 목록의 `delivery_available`은 참입니다.
- `src/app/campaign-draft-preview.db.test.ts`와 시작 검사는 바꾸지 않고 통과합니다. 조각으로 나눈 뒤 `EVALUATION_SQL` 문자열이 원래와 바이트 단위로 같음을 따로 비교했습니다.
- `src/app/campaign-drafts.test.ts`: 유효한 승인의 안내, 실행된 승인의 상태 문구, 승인 영역 마크업이 새 문구이고 "아직 지원하지 않습니다"와 "발송 가능"이 없습니다. `campaign_version_executed` 충돌은 실행된 승인으로 다시 표시하고 초안 잠금을 풉니다.

검사가 실제로 실패할 수 있는지 확인하려고 구현을 하나씩 바꿔 해당 검사를 실행했고, 실행 뒤 파일을 되돌렸습니다.

- 가져오기에서 `SKIP LOCKED`를 지우면 worker 둘 검사가 잡힌 행을 5초 동안 기다려 실패했습니다.
- guard에서 창 단계를 지우면 창 닫힘 검사가 실패했습니다.
- `deliveryRecipientOptedOut` 호출을 막으면 다른 DM 수신자의 수신 거부 검사가 실패했습니다.
- 승인자 검사를 지우면 승인자 제거와 강등 검사 둘이 실패했습니다.
- 재시도 사유를 차단 사유보다 먼저 던지면 차단 우선 검사가 실패했습니다.
- 취소된 실행에서 되돌아갈 행을 `cancelled`로 두는 처리를 지우면 취소 우선·미룸 경합 검사가 실패했습니다.
- 가져오기에서 예산 조건을 지우면 예산 검사가 실패했습니다.
- 깨우기에서 예산 조건을 지우면 Worker 예산 검사가 실패했습니다.
- 큐에서 캠페인을 자동화보다 먼저 처리하게 하면 우선순위 검사가 실패했습니다.
- 캠페인 조건에서 팔로우 확인 처리 여부만 빼면 팔로우 확인 우선순위 검사가 실패했습니다.
- 재승인 거절을 지우면 실행된 승인 검사가 실패했습니다.
- 운영 상태 결과 수에서 캠페인 행을 빼면 운영 상태 검사가 실패했습니다.
- `stale_recovery`에서 캠페인 복구를 지우면 cron 복구 검사가 실패했습니다.
- 대기 지표의 캠페인 시작 시각을 `next_attempt_at`과 일시 중지 종료만으로 되돌리면 예산 지표 검사가 대기 3,900초로 실패했습니다.
- 캠페인 transport의 `fetchImpl`을 공용 `graphFetch`로 되돌리면 POST 직전 일시 중지 검사가 `blocked`/`connection_changed`로 실패했습니다.

## 실행 결과

`automations_test`를 새로 만든 뒤 아래 순서로 한 번씩 실행했습니다. 그 뒤 팔로우 확인 우선순위 검사를 추가하고 `campaign_start` 단계의 완료 호출이 시작 실패 코드를 가리지 않게 고쳤으므로, `check-types`, `test`, `test:cloudflare`를 같은 DB에서 다시 실행했습니다(`test:cloudflare`는 `test:db` 뒤 순서 그대로). 검토 뒤 대기 지표의 캠페인 시작 시각과 POST 직전 일시 중지 처리를 고치고 검사 둘을 추가했으므로, 네 명령을 같은 DB(다시 만들지 않음)에서 이 순서로 다시 실행했습니다. 표는 마지막 실행 결과입니다.

| 명령                                                                                                  | 결과               |
| ----------------------------------------------------------------------------------------------------- | ------------------ |
| `corepack pnpm check-types`                                                                           | 종료 0             |
| `corepack pnpm test`                                                                                  | 480개 통과, 실패 0 |
| `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5446/automations_test corepack pnpm test:db`         | 821개 통과, 실패 0 |
| `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5446/automations_test corepack pnpm test:cloudflare` | 87개 통과, 실패 0  |

`test:cloudflare` 안의 `pnpm build:cloudflare`는 PATH의 pnpm을 부릅니다. 이 기계의 Homebrew pnpm 12는 corepack 아래에서 `packageManager`의 10.34.9로 바꾸지 않고 `ERR_PNPM_BAD_PM_VERSION`으로 멈추므로, `corepack pnpm`으로 넘기는 임시 shim을 PATH 앞에 두고 같은 명령을 실행했습니다. 코드나 설정 문제가 아니라 이 기계의 도구 배치 문제입니다.

## 검증하지 않은 것

- 운영 migration 066 적용, 배포된 Worker 동작, 실제 Meta 권한과 실제 발송은 확인하지 않았습니다.
- Meta의 Instagram Send API 한도(초당 100회, 시간당·앱 전체 한도 없음)는 운영자가 승인한 계획에 기록된 2026-10-29 확인 결과입니다. 이 구현 작업 중에는 문서를 다시 열어 보지 않았고, 실제 계정에서도 확인하지 않았습니다.
- 5,000명 실행이 약 5시간에 끝난다는 수는 예산에서 계산한 값이며, 실제 처리 속도는 큐 소비와 cron 깨우기 간격에 따라 달라집니다.
