# 계정별 발송 한도와 Cron 깨우기 순서

## 범위

[이슈 #60](https://github.com/AndrewDongminYoo/auto-chatter/issues/60)의 일부입니다.
연결(Instagram 전문가 계정)마다 시간당 비공개 답장 예산을 두고, Cron이 발송할 일이 있는 연결을 깨우는 순서를 돌아가며 공평하게 바꿉니다.
앱 전체가 나눠 쓰는 공유 한도, 캠페인 발송, 비용 상한, 웹훅 전달의 공평성(#167)은 이 문서의 범위가 아닙니다.
이미 있는 사후 대응(`ProviderRateLimitedError`, 연결의 `send_paused_until`, `src/instagram/reply-worker.ts`의 재시도 간격)과 발송 결과의 의미는 바꾸지 않습니다.
migration 042가 열 두 개와 인덱스 하나를 더하며, 운영 DB 적용과 배포는 이 PR의 범위가 아닙니다.
데이터 삭제 뒤에도 예산의 셈을 이어 가는 이월([이슈 #189](https://github.com/AndrewDongminYoo/auto-chatter/issues/189))은 migration 044가 더하며, 그 운영 적용과 배포도 그 PR의 범위가 아닙니다.

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
- 세는 대상: `private_reply_outbox.provider_called_at`이 최근 1시간 안인 그 연결의 행 수에, 연결에 이월된 호출 수를 그 이월이 끝나기 전까지 더한 값입니다([삭제한 행의 호출 이월](#삭제한-행의-호출-이월)). 이 시각은 claim한 답장을 transport의 `send()`에 넘기기 직전에, claim을 확인하는 조건부 UPDATE(`status='sending' AND attempt_id=$n`)로 기록합니다. 다음 시도가 덮어쓰고, 지우지 않습니다.
- 막는 곳: `processNextPrivateReply`의 claim(Node와 Cloudflare가 함께 씀)과 `wakeDueReplies`의 비공개 답장 조건입니다. 예산을 다 쓴 연결의 비공개 답장은 claim하지 않으므로 `pending`으로 남고, `next_attempt_at`, `rate_limit_retries`, `failure_code`는 바뀌지 않습니다. 1시간 창에서 호출이 빠져나가면 다음 claim이 다시 보냅니다.
- 깨우기: 예산을 다 쓴 연결은 비공개 답장 때문에는 Queue에 넣지 않습니다. 그렇지 않으면 Queue 메시지를 처리한 뒤의 연결 단위 깨우기가 같은 연결을 계속 다시 넣어, 동시 처리 수가 1인 Queue를 그 연결이 차지합니다. 수동 답장과 팔로우 응답이 기다리면 그 연결도 깨웁니다.
- 세지 않는 것: 수동 답장과 팔로우 응답(Send API DM)은 예산을 쓰지도, 예산에 막히지도 않습니다. 팔로우 조건 규칙의 첫 DM은 비공개 답장 행 그 자체이므로 셉니다.
- 운영 지표: `oldest_due_pending_seconds`는 예산에 막힌 비공개 답장을 세지 않습니다([운영 지표](2026-10-01-operations-health.md#지표와-api)). 연결 일시 중지와 달리 끝나는 시각이 없으므로, 예산이 풀린 답장은 자기 `next_attempt_at`부터 세어 바로 경보 기준을 넘을 수 있습니다. 새 경보나 로그 코드는 두지 않습니다.

### 삭제한 행의 호출 이월

연결 데이터 삭제(`delete_connection_data`)와 사람 데이터 삭제(`delete_person_data`)는 `private_reply_outbox` 행을 지우고, OAuth 재연결은 같은 `instagram_connections` 행을 다시 씁니다(`src/app/instagram-oauth.ts`의 `ON CONFLICT(account_id)`). 이월이 없으면 관리자가 연결을 끊고 데이터를 삭제한 뒤 1시간 안에 다시 연결할 때 셈이 0부터 시작해, 그 계정이 같은 1시간 안에 700회를 넘을 수 있습니다.

- 기록: `private_reply_outbox`의 문장 단위 `AFTER DELETE` 트리거(`carry_deleted_private_reply_calls`)가, 지운 행 가운데 `provider_called_at`이 최근 1시간 안인 행을 연결마다 셉니다. 그런 행이 있는 연결만 고칩니다. 이월된 호출 수는 기존 이월이 아직 끝나지 않았으면 그 수에 더하고, 끝났으면 0에 더합니다. 이월이 끝나는 시각은 끝나지 않은 기존 시각과, 지운 행 가운데 가장 늦은 `provider_called_at`에 1시간을 더한 시각 가운데 늦은 쪽입니다. 시각은 예산 조건과 같이 `now()`로 비교합니다.
- 읽기: `privateReplyBudgetOpenSql`이 행 수에 `private_reply_carried_calls`를 `private_reply_carried_until > now()`인 동안만 더합니다. 조건은 여전히 SQL 조건 하나이므로 claim, 깨우기, 운영 지표가 함께 씁니다.
- 실행 주체: 서버 역할에는 이 테이블의 DELETE 권한이 없으므로, 트리거는 관리자 삭제 함수 안에서만 실행됩니다. 트리거 함수는 SECURITY INVOKER이고 `search_path`를 `public, pg_temp`로 고정합니다. `delete_connection_data`(SECURITY DEFINER) 안에서는 그 함수의 관리자 소유자로, 다른 두 함수 안에서는 호출한 관리자로 실행됩니다.
- 잠금: 트리거의 UPDATE는 키가 아닌 열만 바꿉니다. `delete_connection_data`와 `delete_workspace_data`는 연결 행을 `FOR UPDATE`로, `delete_person_data`는 `FOR NO KEY UPDATE`로 이미 잡고 있으므로 트리거가 새 잠금을 더하지 않습니다.
- 작업 공간 삭제: `delete_workspace_data`는 발송 행을 연결보다 먼저 지우므로 트리거가 쓴 이월은 곧 연결과 함께 지워지고, 함수는 그대로 성공합니다.
- `TRUNCATE`는 트리거를 실행하지 않습니다. DB 테스트는 이것에 기대어 테스트 사이에 표를 비웁니다.

### 셈의 오차

- 많이 세는 경우(이월): 이월은 호출마다의 시각을 남기지 않으므로, 이월이 끝날 때까지 이월된 호출을 모두 셉니다. 그 가운데 더 일찍 한 호출이 있어도 1시간 창에서 빠지지 않으므로, 연결을 조금 더 오래 멈출 뿐 예산을 넘게 하지는 않습니다.
- 적게 세는 경우(작업 공간 삭제): 작업 공간 삭제는 연결 행을 지우므로 이월도 함께 사라집니다. 같은 Instagram 계정을 1시간 안에 다른 작업 공간에 새로 연결하면 새 연결 행의 셈은 0부터 시작합니다. 작업 공간 삭제는 API가 없는 관리자 전용 절차이므로 이 경우를 그대로 둡니다.
- 많이 세는 경우: transport가 `send()` 안에서 POST 전에 멈추면(`PreSendVerificationError`, 예: Cloudflare의 마지막 확인이나 transport의 읽기 확인) 보내지 않은 호출이 1시간 동안 셉니다. 예산이 일찍 멈추는 쪽이므로 그대로 둡니다.
- 적게 세는 경우: 한 행을 1시간 안에 두 번 POST하면(Meta가 호출 제한으로 거절한 뒤 15분 뒤의 재시도) 시각을 덮어써 한 번만 셉니다. 이 경우는 이미 연결 일시 중지를 걸어 다른 답장도 멈춥니다.
- 동시 claim: claim은 개수를 읽은 뒤 행을 잡고, 호출 시각은 그 뒤에 기록합니다. 그래서 한 연결을 동시에 claim하는 수만큼, 정확히는 그 수에서 하나를 뺀 만큼까지 예산을 넘을 수 있습니다. Cloudflare Queue 소비자는 `max_concurrency: 1`, `max_batch_size: 1`(`wrangler.json`)이고, Node 작업자는 환경 변수로 정한 연결 하나를 순서대로 처리하며, 두 경로는 같은 연결을 맡지 않습니다(OAuth 연결은 Cloudflare만 보냄). 지금 구성에서는 넘지 않으며, 동시 처리 수를 늘려도 연결당 동시 claim이 50을 넘지 않는 한 Meta 한도 안입니다. 같은 행은 `FOR UPDATE SKIP LOCKED`와 `attempt_id` 확인 때문에 두 번 보내지 않습니다.
- 배포 직후: migration 전의 행은 `provider_called_at`이 없으므로, 배포 뒤 첫 1시간은 배포 전에 보낸 호출을 세지 않습니다. 이 사이에 Meta가 거절하면 기존 사후 대응이 연결을 멈춥니다.

## 우선순위

한 Queue 메시지는 한 연결의 행을 하나만 처리하며, 수동 답장, 팔로우 응답, 비공개 답장 순서로 먼저 있는 것을 보냅니다(`src/cloudflare/index.ts`의 `queue`). DM으로 시작한 플로의 첫 메시지(#291)는 팔로우 응답과 비공개 답장 사이에 들어가며 예산을 쓰지도, 예산에 막히지도 않습니다([DM 시작 트리거](2026-11-08-instagram-dm-start-triggers.md#발송)). Node 작업자는 한 바퀴마다 팔로우 응답 하나, 그다음 비공개 답장 하나를 처리합니다.
예산은 이 순서를 바꾸지 않고 비공개 답장만 건너뜁니다.

## Cron 깨우기의 공평성

- 연결 사이: 한 Queue 메시지는 한 행만 처리하고 그 연결만 다시 깨우므로, 연결마다 쌓인 일이 Queue에서 번갈아 처리됩니다. 한 연결에 쌓인 답장이 많아도, 같은 Cron 실행이 넣은 다른 연결의 첫 답장은 그 앞에 있던 메시지만 기다립니다.
- Cron: 범위 없는 `wakeDueReplies`는 발송할 일이 있는 연결을 `send_woken_at`이 비었거나 오래된 순서(같으면 ID 순서)로 최대 100개 골라 Queue에 넣은 뒤, 발행에 성공한 연결의 `send_woken_at`만 현재 시각으로 기록합니다. 그래서 100개를 넘으면 다음 실행은 이번에 넣지 않은 연결을 먼저 넣고, 발송할 일이 있는 연결이 N개이면 한 연결은 대략 ⌈N/100⌉번의 실행(1분마다 한 번) 안에 들어갑니다. 그 사이 새로 발송할 일이 생긴 연결이 더 오래전에 깨워졌다면 먼저 들어가므로, 이 수는 그동안 발송할 일이 있었던 연결 모두로 셉니다.
- 기록: `send_woken_at`은 순서에만 씁니다. Queue 발행이 중간에 실패해도 그때까지 발행한 연결만 기록하므로, 들어가지 못한 연결은 다음 실행에서 앞에 남고 `wake` 단계는 실패로 남습니다. 기록은 ID 순서로 `FOR NO KEY UPDATE SKIP LOCKED`를 잡으므로, 다른 트랜잭션이 잡고 있는 연결은 Queue에 들어갔어도 기록을 건너뛰고(다음 실행에서도 앞에 남음) 기다리거나 교착하지 않습니다.
- 범위 있는 깨우기: 웹훅이 받은 계정 ID와 Queue 메시지 뒤 한 연결의 깨우기는 지금처럼 ID 순서이고 `send_woken_at`을 기록하지 않습니다.
- 비용: 범위 없는 깨우기는 고르는 문장과, Queue에 넣은 연결이 있을 때만 기록하는 문장 하나를 씁니다. 발송할 일이 있는 연결이 있는 Cron 실행에서만 쿼리가 하나 늘고, 범위 있는 깨우기의 쿼리 수는 그대로입니다.

## DM 시작 한도

[이슈 #400](https://github.com/AndrewDongminYoo/auto-chatter/issues/400)에서 더했습니다.
DM으로 시작한 플로의 첫 메시지는 위 예산을 쓰지 않으므로, 메시지 하나짜리 플로는 DM마다 새 실행을 만들 수 있었습니다.
그래서 발송이 아니라 실행의 시작을 막습니다.

- 값: 한 연결에서 같은 메시징 ID(DM 보낸 사람)는 10분에 실행 하나까지(`DM_START_SENDER_COOLDOWN_MINUTES`), 한 연결은 최근 60분 동안 700개까지(`DM_START_HOURLY_LIMIT`, 비공개 답장 예산과 같은 이동 창) 시작합니다. 두 값은 `src/instagram/send-quota.ts`에 있습니다. Meta는 Send API의 시간당 한도를 문서로 정하지 않았으므로(위 [Meta의 공식 한도](#meta의-공식-한도)) 두 값은 Meta 한도가 아니라 서비스 정책입니다.
- 확인 위치: `startDmTriggerFlow`(`src/instagram/dm-start-trigger.ts`)가 플로를 고르고 기존 우선 규칙(`startBlocked`: 재개할 실행, 대기 중인 팔로우 응답, 15분 안의 보관 DM, 수신 거부, 활성 핸드오프)을 통과한 뒤, 실행을 만들기 전에 확인합니다. 우선 규칙에 막힌 DM은 지금처럼 행을 쓰지 않습니다. 조건은 `dmStartSkipCodeSql` 한 곳에 있습니다. 둘 다 걸리면 `sender_cooldown`이 이깁니다.
- 건너뛴 행: 한도를 넘은 DM은 `instagram_dm_start_events` 행을 `skip_code`(`sender_cooldown` 또는 `connection_hourly_limit`)와 함께 쓰고, `flow_runs`, `flow_dm_deliveries`, `flow_step_runs` 행은 만들지 않습니다. 두 한도는 `skip_code IS NULL`인 행만, 데이터베이스 시각(`created_at`과 `clock_timestamp()`)으로 셉니다. `created_at`을 쓰는 시계와 같은 시계를 쓰며, 트랜잭션 시작에 고정되는 `now()`를 쓰면 잠금을 기다렸거나 배치 안에서 뒤에 온 DM이 더 이른 창으로 판정됩니다. 판정마다 `clock_timestamp()`를 한 번 읽어(`decided_at` 부분 질의) 두 조건에 넘기므로, 인덱스가 `created_at` 범위로 좁혀 읽습니다. 조건 안에 `clock_timestamp()`를 직접 쓰면 volatile 함수라서 인덱스 범위 조건이 되지 못하고 연결의 시작 기록 전체를 읽습니다. 정확히 10분 전의 시작은 막지 않습니다. 같은 메시지 ID의 재전달은 지금처럼 `ON CONFLICT(connection_id,message_id) DO NOTHING`으로 아무것도 쓰지 않습니다. 건너뛴 행의 메시지 ID도 시작한 행과 같이 재전달 때 응답 대기, 팔로우 응답, 보관 DM이 가져가지 않으며, DM 플로의 24시간 창은 건너뛴 행도 받은 DM으로 봅니다.
- 동시성: 수신 트랜잭션은 메시지 잠금(`lockMessageIds`) 바로 뒤에, 배치의 보낸 사람마다 트랜잭션 advisory 잠금(`'dm-start-sender:'` 키, 계정 ID와 보낸 사람 ID, `lockDmStartSenders`)을 키 순서로 한 문장에서 잡습니다. 그래서 같은 보낸 사람의 동시 DM 두 개는 차례로 확인되고 하나만 시작합니다. 기다리는 트랜잭션은 메시지 잠금과 그보다 앞선 보낸 사람 잠금만 가지고 있고 다른 곳은 이 키를 잡지 않으므로 교착을 만들지 않습니다. 받은 편지함의 대화 잠금(`lockConversation`)은 받은 편지함이 켜진 연결에서만 잡히므로 쓰지 않았습니다.
- 시간당 한도의 오차: 연결 전체를 잠그지 않습니다. 한 배치는 커밋된 시작과 자기 시작만 세므로, 같은 연결을 동시에 처리하는 다른 보낸 사람의 배치들이 있으면 그 배치들의 시작 수만큼 700을 넘을 수 있습니다.
- 운영 상태: `GET /api/workspace/health`의 연결별 `dm_start_cooldown_24h`와 `dm_start_hourly_limit_24h`가 최근 24시간에 건너뛴 시작을 코드별로 셉니다([운영 상태 문서](2026-10-01-operations-health.md#지표와-api)). 운영 상태 화면이 두 수를 보여 줍니다.
- Claim과 깨우기: 한도를 넘은 DM은 실행도 발송 행도 만들지 않으므로 claim 문장과 `wakeDueReplies`는 바꾸지 않았습니다.
- 연결 사이의 혼잡: Queue 메시지를 합치는 장치는 더하지 않았습니다. 이 한도가 한 연결의 DM 시작 부하를 시간당 실행 700개로 묶고, Cron은 이미 `send_woken_at` 순서로 연결을 돌아가며 깨웁니다([Cron 깨우기의 공평성](#cron-깨우기의-공평성)).
- 저장: `instagram_dm_start_events.skip_code text`(두 값만 허용하는 CHECK)와 세 부분 인덱스(`skip_code IS NULL`인 `(connection_id, sender_id, created_at)`과 `(connection_id, created_at)`, `skip_code IS NOT NULL`인 `(connection_id, created_at)`)를 migration 075가 더합니다. 기존 행은 시작한 행이므로 `NULL`로 둡니다. 삭제 함수와 작업 공간 내보내기는 이미 이 테이블을 다루므로 건너뛴 행과 새 열도 함께 지우고 내보냅니다.
- 배포 순서: migration 075(`deploy/migrate-multi-user.sql`로 적용)를 코드보다 먼저 적용합니다. 지금 코드는 이 열을 읽지 않고 `NULL`만 쓰므로 그 사이에 바뀌는 것은 내보내기에 `skip_code: null`이 생기는 것뿐입니다. 코드를 먼저 배포하면 DM 시작 플로와 맞는 DM의 수신 트랜잭션과 운영 지표 문장이 `42703`(열 없음)으로 실패합니다.

## 저장

- `private_reply_outbox.provider_called_at timestamptz`: 위의 호출 시각입니다. `(connection_id, provider_called_at)`에 `provider_called_at IS NOT NULL`인 부분 인덱스가 있습니다.
- `instagram_connections.send_woken_at timestamptz`: Cron이 마지막으로 그 연결을 Queue에 넣은 시각이며 순서에만 씁니다.
- `instagram_connections.private_reply_carried_calls integer NOT NULL DEFAULT 0`(`>= 0` CHECK)과 `instagram_connections.private_reply_carried_until timestamptz`: 위의 이월된 호출 수와 이월이 끝나는 시각입니다(migration 044). 트리거만 씁니다.
- 이 열들은 기존 테이블의 열이므로 서버 역할의 권한(SELECT·INSERT·UPDATE)은 그대로이고 DELETE는 없습니다. 작업 공간 내보내기는 두 테이블을 이미 내보내므로 이 열들도 함께 나갑니다. 모두 비밀 값이 아닙니다.

## 배포 순서

migration 042(`deploy/migrate-multi-user.sql`로 적용)를 코드보다 먼저 적용합니다.
지금 코드는 두 열을 읽지 않으므로, migration을 먼저 적용해 바뀌는 것은 작업 공간 내보내기뿐입니다. 내보내기는 행 전체를 `to_jsonb`로 내보내므로 두 열이 그때부터 값 없이(`null`) 나갑니다.
코드를 먼저 배포하면 다음 문장이 `42703`(열 없음)으로 실패합니다.

- 비공개 답장 claim(`processNextPrivateReply`): Node 작업자와 Cloudflare Queue 모두 비공개 답장을 보내지 못합니다.
- 호출 시각 기록: claim이 먼저 실패하므로 닿지 않습니다.
- `wakeDueReplies`(모든 범위): 웹훅의 깨우기는 저장을 끝낸 뒤 실패해 `reply_notification_failed`를 남기고, Queue 메시지는 비공개 답장 claim이나 마지막 깨우기에서 실패해 `retry`가 되며, Cron의 `wake` 단계가 실패합니다. 이 문장이 수동 답장과 팔로우 응답의 깨우기도 맡으므로 그것들도 Cron이 깨우지 못합니다.
- Cron 깨우기의 `send_woken_at` 기록: 고르는 문장이 먼저 실패하므로 닿지 않습니다.
- 운영 지표(`GET /api/workspace/health`와 Cron의 `alerts` 단계): 지표 문장이 실패합니다.

### migration 044(이월)

migration 044(`deploy/migrate-multi-user.sql`로 적용)도 코드보다 먼저 적용합니다.
migration을 먼저 적용하면 그때부터 삭제 함수가 이월을 기록하지만, 지금 코드는 이월을 읽지 않으므로 바뀌는 것은 작업 공간 내보내기뿐입니다. 두 열이 그때부터 `0`과 `null`(또는 기록된 이월)로 나갑니다.
코드를 먼저 배포하면 `privateReplyBudgetOpenSql`을 쓰는 문장(비공개 답장 claim, `wakeDueReplies`, 운영 지표)이 `42703`(열 없음)으로 실패하며, 그 결과는 위 migration 042의 목록과 같습니다.

## #60에 남은 완료 조건

- 캠페인 발송(#35, #36)과 비용 상한(#52)이 생기면 같은 연결별 한도와 이 예산을 써야 합니다.
- 초당 한도(Send API, Conversations API, 라이브 댓글 비공개 답장)는 미리 막지 않습니다. 지금은 Queue가 한 번에 한 행만 보내므로 닿지 않습니다.
- 앱 전체 공유 한도는 Meta가 문서로 정하지 않았으므로 두지 않았습니다. 문서가 바뀌면 다시 봅니다.

## 검증

- `src/instagram/send-quota.test.ts`: 예산 값과 SQL 조건.
- `src/instagram/send-quota.db.test.ts`: 699회와 700회의 경계, 1시간 창이 비는 것, 다른 연결은 그대로 보냄, 재시도를 쓰지 않음, 동시 claim이 같은 행을 두 번 보내지 않음, POST 전에 멈춘 시도도 셈, migration 재적용. 이월(#189): 연결 데이터 삭제와 재연결 뒤에도 예산에 막힘과 이월이 끝나면 풀림, 사람 데이터 삭제도 셈, 두 번의 삭제가 더해지고 끝난 이월은 바뀜, 1시간이 지났거나 호출하지 않은 행은 이월하지 않음, 작업 공간 삭제가 그대로 성공함, migration 044 재적용.
- `src/instagram/dm-start-trigger.db.test.ts`(#400): 9분 59초와 10분의 보낸 사람 간격 경계, 700번째와 701번째 시작, 60분보다 오래된 행과 건너뛴 행은 세지 않음, 다른 보낸 사람과 다른 연결은 막히지 않음, 두 한도가 겹치면 `sender_cooldown`, 같은 보낸 사람의 동시 DM 두 개는 실행 하나, 기존 우선 규칙이 먼저 막고 건너뛴 행을 쓰지 않음, 운영 지표의 코드별 수, 삭제 함수와 내보내기, migration 075 재적용.
- `src/cloudflare/worker.db.test.ts`: 예산에 막힌 연결을 Queue와 Cron이 다시 넣지 않음, 지운 행의 이월에 막힌 연결도 이월이 끝날 때까지 다시 넣지 않음, 같은 연결의 수동 답장과 팔로우 응답은 보냄, 100개가 넘는 연결을 Cron이 돌아가며 깨움, 발행에 실패한 연결은 기록하지 않음, Cron과 Queue를 거쳐 한 연결에 쌓인 답장 200개가 다른 연결의 첫 답장을 늦추지 않음.
