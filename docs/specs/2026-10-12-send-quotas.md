# 계정별 발송 한도와 Cron 깨우기 순서

## 범위

[이슈 #60](https://github.com/AndrewDongminYoo/auto-chatter/issues/60)의 일부입니다.
연결(Instagram 전문가 계정)마다 시간당 비공개 답장 예산을 두고, Cron이 발송할 일이 있는 연결을 깨우는 순서를 돌아가며 공평하게 바꿉니다.
앱 전체가 나눠 쓰는 공유 한도, 캠페인 발송, 비용 상한, 웹훅 전달의 공평성(#167)은 이 문서의 범위가 아닙니다.
이미 있는 사후 대응(`ProviderRateLimitedError`, 연결의 `send_paused_until`, `src/instagram/reply-worker.ts`의 재시도 간격)과 발송 결과의 의미는 바꾸지 않습니다.
migration 042가 열 두 개와 인덱스 하나를 더하며, 운영 DB 적용과 배포는 이 PR의 범위가 아닙니다.

## Meta의 공식 한도

2026-10-12에 읽은 [Instagram Platform 개요](https://developers.facebook.com/docs/instagram-platform/overview/)는 메시지 한도를 모두 Instagram 전문가 계정 단위로 적습니다.

| 호출                                  | 한도                            |
| ------------------------------------- | ------------------------------- |
| 게시물·릴스 댓글에 보내는 비공개 답장 | 계정당 시간당 750회             |
| 라이브 댓글에 보내는 비공개 답장      | 초당 100회                      |
| Send API(텍스트·링크·반응·스티커)     | 초당 100회                      |
| Send API(오디오·비디오)               | 초당 10회                       |
| Conversations API                     | 초당 2회                        |
| 그 밖의 엔드포인트(앱과 앱 사용자 쌍) | 24시간 호출 수 = 4800 × 노출 수 |

[Messenger Platform 호출 한도 문서](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting)는 같은 시간당 750회 비공개 답장 한도를 Facebook 페이지 단위로 적고, Send API는 초당 300회로 적습니다.
두 문서의 Send API 값이 다르다는 것만 기록하며, 이 변경은 Send API의 초당 한도를 미리 막지 않습니다(아래 [#60에 남은 완료 조건](#60에-남은-완료-조건)).
여러 계정이 함께 쓰는 앱 전체의 메시지 한도는 두 문서 어디에도 없으므로, 이 변경은 앱 전체 한도를 두지 않습니다.
앱 단위로 세는 것은 위 표의 마지막 줄뿐이며, 이것도 앱과 앱 사용자 쌍마다 따로 셉니다.

## 비공개 답장 예산

- 값: 연결마다 최근 1시간(현재 시각부터 거꾸로 60분) 동안 700회입니다. Meta의 750회보다 50회 적게 잡아, 아래에 적은 초과와 셈의 오차가 이 여유 안에 들게 합니다. 값은 `PRIVATE_REPLY_HOURLY_BUDGET`(`src/instagram/send-quota.ts`) 하나에만 있습니다.
- 세는 대상: `private_reply_outbox.provider_called_at`이 최근 1시간 안인 그 연결의 행 수입니다. 이 시각은 claim한 답장을 transport의 `send()`에 넘기기 직전에, claim을 확인하는 조건부 UPDATE(`status='sending' AND attempt_id=$n`)로 기록합니다. 다음 시도가 덮어쓰고, 지우지 않습니다.
- 막는 곳: `processNextPrivateReply`의 claim(Node와 Cloudflare가 함께 씀)과 `wakeDueReplies`의 비공개 답장 조건입니다. 예산을 다 쓴 연결의 비공개 답장은 claim하지 않으므로 `pending`으로 남고, `next_attempt_at`, `rate_limit_retries`, `failure_code`는 바뀌지 않습니다. 1시간 창에서 호출이 빠져나가면 다음 claim이 다시 보냅니다.
- 깨우기: 예산을 다 쓴 연결은 비공개 답장 때문에는 Queue에 넣지 않습니다. 그렇지 않으면 Queue 메시지를 처리한 뒤의 연결 단위 깨우기가 같은 연결을 계속 다시 넣어, 동시 처리 수가 1인 Queue를 그 연결이 차지합니다. 수동 답장과 팔로우 응답이 기다리면 그 연결도 깨웁니다.
- 세지 않는 것: 수동 답장과 팔로우 응답(Send API DM)은 예산을 쓰지도, 예산에 막히지도 않습니다. 팔로우 조건 규칙의 첫 DM은 비공개 답장 행 그 자체이므로 셉니다.
- 운영 지표: `oldest_due_pending_seconds`는 예산에 막힌 비공개 답장을 세지 않습니다([운영 지표](2026-10-01-operations-health.md#지표와-api)). 연결 일시 중지와 달리 끝나는 시각이 없으므로, 예산이 풀린 답장은 자기 `next_attempt_at`부터 세어 바로 경보 기준을 넘을 수 있습니다. 새 경보나 로그 코드는 두지 않습니다.

### 셈의 오차

- 많이 세는 경우: transport가 `send()` 안에서 POST 전에 멈추면(`PreSendVerificationError`, 예: Cloudflare의 마지막 확인이나 transport의 읽기 확인) 보내지 않은 호출이 1시간 동안 셉니다. 예산이 일찍 멈추는 쪽이므로 그대로 둡니다.
- 적게 세는 경우: 한 행을 1시간 안에 두 번 POST하면(Meta가 호출 제한으로 거절한 뒤 15분 뒤의 재시도) 시각을 덮어써 한 번만 셉니다. 이 경우는 이미 연결 일시 중지를 걸어 다른 답장도 멈춥니다.
- 동시 claim: claim은 개수를 읽은 뒤 행을 잡고, 호출 시각은 그 뒤에 기록합니다. 그래서 한 연결을 동시에 claim하는 수만큼, 정확히는 그 수에서 하나를 뺀 만큼까지 예산을 넘을 수 있습니다. Cloudflare Queue 소비자는 `max_concurrency: 1`, `max_batch_size: 1`(`wrangler.json`)이고, Node 작업자는 환경 변수로 정한 연결 하나를 순서대로 처리하며, 두 경로는 같은 연결을 맡지 않습니다(OAuth 연결은 Cloudflare만 보냄). 지금 구성에서는 넘지 않으며, 동시 처리 수를 늘려도 연결당 동시 claim이 50을 넘지 않는 한 Meta 한도 안입니다. 같은 행은 `FOR UPDATE SKIP LOCKED`와 `attempt_id` 확인 때문에 두 번 보내지 않습니다.
- 배포 직후: migration 전의 행은 `provider_called_at`이 없으므로, 배포 뒤 첫 1시간은 배포 전에 보낸 호출을 세지 않습니다. 이 사이에 Meta가 거절하면 기존 사후 대응이 연결을 멈춥니다.

## 우선순위

한 Queue 메시지는 한 연결의 행을 하나만 처리하며, 수동 답장, 팔로우 응답, 비공개 답장 순서로 먼저 있는 것을 보냅니다(`src/cloudflare/index.ts`의 `queue`). Node 작업자는 한 바퀴마다 팔로우 응답 하나, 그다음 비공개 답장 하나를 처리합니다.
예산은 이 순서를 바꾸지 않고 비공개 답장만 건너뜁니다.

## Cron 깨우기의 공평성

- 연결 사이: 한 Queue 메시지는 한 행만 처리하고 그 연결만 다시 깨우므로, 연결마다 쌓인 일이 Queue에서 번갈아 처리됩니다. 한 연결에 쌓인 답장이 많아도, 같은 Cron 실행이 넣은 다른 연결의 첫 답장은 그 앞에 있던 메시지만 기다립니다.
- Cron: 범위 없는 `wakeDueReplies`는 발송할 일이 있는 연결을 `send_woken_at`이 비었거나 오래된 순서(같으면 ID 순서)로 최대 100개 골라 Queue에 넣은 뒤, 발행에 성공한 연결의 `send_woken_at`만 현재 시각으로 기록합니다. 그래서 100개를 넘으면 다음 실행은 이번에 넣지 않은 연결을 먼저 넣고, 발송할 일이 있는 연결이 N개이면 한 연결은 대략 ⌈N/100⌉번의 실행(1분마다 한 번) 안에 들어갑니다. 그 사이 새로 발송할 일이 생긴 연결이 더 오래전에 깨워졌다면 먼저 들어가므로, 이 수는 그동안 발송할 일이 있었던 연결 모두로 셉니다.
- 기록: `send_woken_at`은 순서에만 씁니다. Queue 발행이 중간에 실패해도 그때까지 발행한 연결만 기록하므로, 들어가지 못한 연결은 다음 실행에서 앞에 남고 `wake` 단계는 실패로 남습니다. 기록은 ID 순서로 `FOR NO KEY UPDATE SKIP LOCKED`를 잡으므로, 다른 트랜잭션이 잡고 있는 연결은 Queue에 들어갔어도 기록을 건너뛰고(다음 실행에서도 앞에 남음) 기다리거나 교착하지 않습니다.
- 범위 있는 깨우기: 웹훅이 받은 계정 ID와 Queue 메시지 뒤 한 연결의 깨우기는 지금처럼 ID 순서이고 `send_woken_at`을 기록하지 않습니다.
- 비용: 범위 없는 깨우기는 고르는 문장과, Queue에 넣은 연결이 있을 때만 기록하는 문장 하나를 씁니다. 발송할 일이 있는 연결이 있는 Cron 실행에서만 쿼리가 하나 늘고, 범위 있는 깨우기의 쿼리 수는 그대로입니다.

## 저장

- `private_reply_outbox.provider_called_at timestamptz`: 위의 호출 시각입니다. `(connection_id, provider_called_at)`에 `provider_called_at IS NOT NULL`인 부분 인덱스가 있습니다.
- `instagram_connections.send_woken_at timestamptz`: Cron이 마지막으로 그 연결을 Queue에 넣은 시각이며 순서에만 씁니다.
- 두 열은 기존 테이블의 열이므로 서버 역할의 권한(SELECT·INSERT·UPDATE)은 그대로이고 DELETE는 없습니다. 작업 공간 내보내기는 두 테이블을 이미 내보내므로 두 열도 함께 나갑니다. 둘 다 비밀 값이 아닙니다.

## 배포 순서

migration 042(`deploy/migrate-multi-user.sql`로 적용)를 코드보다 먼저 적용합니다.
지금 코드는 두 열을 읽지 않으므로, migration을 먼저 적용해 바뀌는 것은 작업 공간 내보내기뿐입니다. 내보내기는 행 전체를 `to_jsonb`로 내보내므로 두 열이 그때부터 값 없이(`null`) 나갑니다.
코드를 먼저 배포하면 다음 문장이 `42703`(열 없음)으로 실패합니다.

- 비공개 답장 claim(`processNextPrivateReply`): Node 작업자와 Cloudflare Queue 모두 비공개 답장을 보내지 못합니다.
- 호출 시각 기록: claim이 먼저 실패하므로 닿지 않습니다.
- `wakeDueReplies`(모든 범위): 웹훅의 깨우기는 저장을 끝낸 뒤 실패해 `reply_notification_failed`를 남기고, Queue 메시지는 비공개 답장 claim이나 마지막 깨우기에서 실패해 `retry`가 되며, Cron의 `wake` 단계가 실패합니다. 이 문장이 수동 답장과 팔로우 응답의 깨우기도 맡으므로 그것들도 Cron이 깨우지 못합니다.
- Cron 깨우기의 `send_woken_at` 기록: 고르는 문장이 먼저 실패하므로 닿지 않습니다.
- 운영 지표(`GET /api/workspace/health`와 Cron의 `alerts` 단계): 지표 문장이 실패합니다.

## #60에 남은 완료 조건

- 캠페인 발송(#35, #36)과 비용 상한(#52)이 생기면 같은 연결별 한도와 이 예산을 써야 합니다.
- 초당 한도(Send API, Conversations API, 라이브 댓글 비공개 답장)는 미리 막지 않습니다. 지금은 Queue가 한 번에 한 행만 보내므로 닿지 않습니다.
- 앱 전체 공유 한도는 Meta가 문서로 정하지 않았으므로 두지 않았습니다. 문서가 바뀌면 다시 봅니다.

## 검증

- `src/instagram/send-quota.test.ts`: 예산 값과 SQL 조건.
- `src/instagram/send-quota.db.test.ts`: 699회와 700회의 경계, 1시간 창이 비는 것, 다른 연결은 그대로 보냄, 재시도를 쓰지 않음, 동시 claim이 같은 행을 두 번 보내지 않음, POST 전에 멈춘 시도도 셈, migration 재적용.
- `src/cloudflare/worker.db.test.ts`: 예산에 막힌 연결을 Queue와 Cron이 다시 넣지 않음, 같은 연결의 수동 답장과 팔로우 응답은 보냄, 100개가 넘는 연결을 Cron이 돌아가며 깨움, 발행에 실패한 연결은 기록하지 않음, Cron과 Queue를 거쳐 한 연결에 쌓인 답장 200개가 다른 연결의 첫 답장을 늦추지 않음.
