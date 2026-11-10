# Instagram 메시지 읽음 수집

## 범위

[#312](https://github.com/AndrewDongminYoo/auto-chatter/issues/312)의 첫 PR로, 서비스가 보낸 메시지를 받는이가 읽었다는 Meta의 `messaging_seen` 이벤트를 연결별로 저장합니다.
첫 PR은 수집과 저장만 다루며, 리포트·화면·API 응답과 발송 동작은 바꾸지 않았습니다.
두 번째 PR은 실제 이벤트로 `read.mid`가 저장된 `provider_message_id`와 같은 것을 확인한 뒤, 세 리포트에 읽음 확인 건수를 더해 #312를 완료합니다([리포트의 읽음 확인 건수](#리포트의-읽음-확인-건수)).

## Meta 근거

2026-11-10에 확인한 Meta 문서입니다.

- [Webhook fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields): `messaging_seen`은 Instagram Login과 Messaging API에서만 제공되며 Facebook Login에서는 제공되지 않습니다. 전달(delivery)을 알리는 필드는 없습니다.
- [Webhook examples](https://developers.facebook.com/documentation/instagram-platform/webhooks/examples.md): `messaging_seen` 페이로드는 `entry[].messaging[]`의 `sender.id`(읽은 사람의 Instagram 범위 ID), `recipient.id`(앱 사용자 계정 ID), `timestamp`(밀리초), `read.mid`로 이루어집니다. `watermark`는 없고, 한 이벤트는 메시지 하나를 가리킵니다.

`read.mid`가 서비스가 발송 응답에서 저장한 메시지 ID와 같은 값이라는 점은 문서에서 직접 확인하지 못했습니다.
2026-11-10 운영에서 팔로우 응답 하나의 읽음이 저장된 `provider_message_id`와 정확히 일치했습니다([근거](https://github.com/AndrewDongminYoo/auto-chatter/issues/312#issuecomment-6759964350)).
같은 시험에서 비공개 답장의 읽음 이벤트는 오지 않았습니다.
값이 다르면 읽음 행은 저장되지 않을 뿐 다른 동작에는 영향이 없습니다.

## 수집 계약

`src/instagram/message-reads.ts`의 `parseMessageReadEvents`가 서명 검증을 통과한 웹훅 본문에서 읽음 이벤트를 꺼냅니다.
Node 수신기(`src/instagram/http.ts`)와 Cloudflare Worker(`src/cloudflare/index.ts`)는 기존 댓글·메시지 해석과 같은 400 응답 범위 안에서 이 함수를 호출하고, 댓글과 메시지를 저장한 뒤 읽음을 저장합니다.
Cloudflare Worker는 댓글과 메시지의 계정을 발송 대기열에 깨운 뒤에 읽음을 저장합니다. 따라서 읽음 저장이 실패해도 댓글과 DM의 저장과 깨우기는 이미 끝났고, 503 응답으로 Meta가 본문을 다시 보내면 댓글과 DM은 중복 제거되고 읽음만 다시 저장됩니다.
읽음 이벤트는 채널 이벤트(`ChannelEvent`)로 바꾸지 않으므로 채널 계약은 바뀌지 않습니다.

이벤트 하나는 다음을 모두 만족할 때만 읽음 하나가 됩니다.

- `read`가 객체이고, `message`나 `postback`이 함께 있지 않으며, `is_self`가 참이 아닙니다.
- `read.mid`는 공백만이 아닌 문자열이고, 512자 이하이며, NUL 문자가 없습니다.
- `sender.id`는 1~40자리 숫자 문자열이고 항목(`entry.id`)의 계정과 다릅니다.
- `recipient.id`는 항목의 계정과 같습니다.
- `timestamp`는 양의 정수이고 9999-12-31T23:59:59.999Z 이하입니다. PostgreSQL은 그보다 늦은 시각의 ISO 문자열을 받지 않으므로, 이 범위를 넘는 이벤트 하나가 본문 전체를 실패시키지 않도록 건너뜁니다.

조건을 어긴 이벤트는 오류 없이 건너뜁니다.
본문 전체가 Instagram 웹훅 형식이 아니면 다른 해석기와 같이 400을 반환합니다.

읽음 이벤트에는 `message`나 `postback`이 없으므로 `parseMessageEvents`가 받은 DM으로 해석하지 않습니다.
따라서 인박스, 응답 대기 재개, 팔로우 확인, DM 시작 트리거, 보류 DM, 수신 동의 기록 중 어느 경로도 읽음 이벤트로 시작하지 않습니다.
읽음은 발송할 일을 만들지 않으므로 Cloudflare Worker는 읽음 계정을 발송 대기열에 깨우지 않습니다.
새 로그는 추가하지 않았고, 메시지 ID와 읽은 사람 ID는 로그에 남기지 않습니다.

## 저장과 중복

`instagram_message_reads`(migration 070)는 `workspace_id`, `connection_id`, `recipient_id`(읽은 사람의 메시징 ID, 발송 테이블의 DM 받는이와 같은 값), `message_id`(`read.mid`), `read_at`(Meta 이벤트 시각), `created_at`을 저장합니다.
기본 키는 `(connection_id, message_id, recipient_id)`이며 `ON CONFLICT DO NOTHING`으로 넣으므로, 다시 전달되거나 중복된 이벤트는 행을 추가하지 않고 처음 저장한 `read_at`이 남습니다.
서로 다른 메시지의 읽음은 도착 순서와 관계없이 각자 저장합니다.

읽음은 다음을 모두 만족할 때만 저장합니다.

- 이벤트의 계정(`recipient.id`)이 활성 연결의 계정입니다.
- `read.mid`가 그 연결에서 서비스가 저장한 `provider_message_id`입니다. 대상 발송 테이블은 `private_reply_outbox`, `instagram_follow_conversations`, `instagram_manual_replies`, `flow_dm_deliveries`, `campaign_deliveries`이며, 스키마에서 `provider_message_id`를 가진 Instagram 발송 테이블은 이 다섯 개뿐입니다.

Instagram 앱에서 사람이 직접 보낸 메시지, 다른 연결의 메시지, 비활성 연결의 메시지에 대한 읽음은 버리고 행을 남기지 않습니다.
읽은 사람이 그 메시지의 저장된 받는이와 같은지는 확인하지 않습니다. 비공개 답장 행은 받는이 ID가 비어 있을 수 있기 때문입니다.
발송 응답이 저장되기 전에 읽음 이벤트가 먼저 도착하면 그 읽음은 버려집니다.
`instagram_follow_conversations`는 한 행에 `provider_message_id`를 하나만 두고 새 발송이 성공하면 그 값을 바꾸므로, 같은 대화에서 앞서 보낸 팔로우 응답의 늦은 읽음은 저장되지 않습니다.

저장은 별도 트랜잭션에서 먼저 활성 연결 행을 `FOR SHARE`로 잠근 뒤, 다음 문장에서 발송 테이블을 조회해 넣습니다.
연결 삭제는 연결 행을 `FOR UPDATE`로 잠그므로, 삭제가 먼저 끝나면 그 연결은 비활성이어서 건너뛰고, 그렇지 않으면 삭제가 이 트랜잭션을 기다립니다.
읽음 조회를 위해 다섯 발송 테이블에 `(connection_id, provider_message_id)` 부분 인덱스를 의도적으로 추가했습니다.
인덱스가 없으면 읽음 이벤트 하나마다 그 연결의 발송 행을 모두 훑습니다.
대가로 migration 070의 `CREATE INDEX`(`CONCURRENTLY` 아님)는 실행기 트랜잭션 안에서 각 발송 테이블에 SHARE 잠금을 잡으므로, 실행기가 커밋할 때까지 그 테이블의 쓰기(웹훅 저장, 발송 기록)가 기다립니다.

## 데이터 경계

- 삭제: `public.delete_connection_data`와 `public.delete_workspace_data`는 연결 또는 작업 공간의 읽음을 모두 지우고, `public.delete_person_data`는 DM 받는이 신원 집합(`recipients`)의 읽음을 지웁니다. 세 함수 모두 `deleted_counts.instagram_message_reads`에 지운 행 수를 기록합니다.
- 내보내기: `EXPORTED_TABLES`에 `workspace` 범위로 등록했습니다. 식별자와 Meta 읽음 시각만 담깁니다.
- 작업 공간 이동 검사: 읽음 행은 `instagram_connections` 행을 외래 키로 요구하므로 두 이동 검사에 추가하지 않았습니다.
- 권한: `deploy/supabase-access.sql`의 테이블 목록에 추가해 RLS를 켜고 서버 역할에 SELECT·INSERT·UPDATE만 줍니다. DELETE는 없습니다. Compose의 `deploy/init-app-user.sh`는 이미 모든 테이블에 같은 권한을 주므로 바꾸지 않았습니다.

## 운영 적용

1. 운영 DB 조회와 백업 뒤 `deploy/migrate-multi-user.sql` 전체 실행기로 migration 070을 적용합니다. 070 파일만 따로 실행하지 않습니다. 코드 배포보다 먼저 적용해야 합니다. 발송 테이블 인덱스를 만드는 동안 그 테이블의 쓰기가 기다리므로, 조회 단계에서 다섯 발송 테이블의 행 수를 확인합니다.
2. Meta 앱 대시보드의 Instagram 웹훅 필드에서 `messaging_seen`이 구독 중이어야 합니다. 2026-11-10에 앱 AutoChatter(`1802833180713730`)의 "Instagram 로그인이 포함된 API 설정" → "Webhooks 구성"에서 `messaging_seen`이 v26.0으로 이미 "구독 중"인 것을 확인했습니다. 언제 켜졌는지는 화면에 나오지 않습니다. 이 필드가 꺼진 상태에서 새 OAuth 연결의 구독 요청이 거부되는지는 확인하지 않았으므로, Worker 배포 전에 상태를 다시 확인합니다.
3. Worker를 배포합니다.
4. 새 OAuth 연결은 `subscribed_fields`에 `messaging_seen`을 포함해 구독합니다. 이 변경 전에 연결한 계정은 OAuth로 다시 연결해야 읽음을 받습니다.

구독 상태 확인(`REQUIRED_SUBSCRIPTION_FIELDS`)에는 `messaging_seen`을 추가하지 않았습니다. 따라서 기존 연결이 `fields_missing`으로 바뀌지 않으며, 대신 기존 연결이 읽음을 받는지도 이 확인으로는 알 수 없습니다.
Facebook Login 연결은 읽음을 받지 않습니다.
첫 PR은 운영에 아무것도 적용하거나 배포하지 않았고, 병합 뒤 조회·백업·적용·배포는 별도 승인이 필요합니다.

## 검증

- 단위 테스트(`src/instagram/message-reads.test.ts`): 올바른 읽음과 잘못된 읽음의 해석, 읽음 이벤트가 메시지·포스트백·댓글 해석과 채널 이벤트에서 빠지는지.
- 구독 확인 단위 테스트: 필수 필드가 바뀌지 않았는지.
- DB 테스트(`src/instagram/message-reads.db.test.ts`): 다섯 발송 테이블 메시지의 읽음 저장, 알 수 없는 ID·다른 연결·비활성 연결·계정이 다른 받는이의 읽음 무시, 중복 이벤트와 첫 `read_at` 유지, 순서가 바뀐 읽음, 세 삭제 함수.
- 서명된 웹훅 종단 테스트: Node 수신기(`src/instagram/http.db.test.ts`)와 Cloudflare Worker(`src/cloudflare/worker.db.test.ts`)에서 읽음 하나를 저장하고 다른 이벤트와 같은 상태를 반환하는지, 인박스가 켜진 연결에서 인박스 메시지를 쓰지 않는지, 응답을 기다리는 플로 실행을 재개하지 않는지, Worker가 발송 대기열을 깨우지 않는지.
- 내보내기·작업 공간 삭제·권한: 기존 `workspace-export.db.test.ts`, `workspace-deletion.db.test.ts`, `src/cloudflare/access.db.test.ts`가 새 테이블을 포함하고, `contact-identity-links.db.test.ts`가 070 재실행 뒤 삭제 함수 정의가 `db/schema.sql`과 같은지 확인합니다.

이 테스트들은 운영 migration, 배포된 Worker, Meta 앱의 필드 구독, 실제 읽음 이벤트의 `read.mid` 값을 증명하지 않습니다.

## 리포트의 읽음 확인 건수

#312의 두 번째 PR은 세 리포트의 `sent` 옆에 `read` 건수(화면 이름 ‘읽음 확인’)와 `read_unavailable` 건수(화면 이름 ‘읽음 확인 불가’)를 더합니다.

- [수동 답장 리포트](2026-10-16-manual-reply-reports.md)의 `counts.read`: `status='sent'`이고 읽음이 있는 수동 답장입니다.
- [플로 실행 리포트](2026-10-16-flow-run-reports.md)의 `reply_counts.read`(전체와 `groups`의 각 행): 연결된 첫 메시지(`private_reply_outbox` 행 또는 `flow_dm_deliveries` 행)가 `status='sent'`이고 읽음이 있는 실행입니다.
- [캠페인 실행 리포트](2026-11-09-campaign-run-reports.md)의 `delivery_counts.read`: 코호트 실행의 발송 행 중 `status='sent'`이고 읽음이 있는 행입니다. 기존 실행별 LATERAL 집계 안에서 세며, 읽음을 평평하게 조인하지 않습니다.

읽음이 있다는 것은 같은 연결의 `instagram_message_reads`에 발송 행의 `provider_message_id`와 정확히 같은 `message_id`가 있다는 뜻입니다.
`EXISTS`로 확인하므로 한 메시지를 여러 `recipient_id`가 읽어도 한 번만 세고, 다른 건수를 늘리지 않습니다.
기본 키 `(connection_id, message_id, recipient_id)`가 이 조회를 받치므로 migration과 새 인덱스는 없습니다.

`read_unavailable`은 `sent`인 행(플로 실행은 연결된 첫 메시지가 `sent`인 실행) 중 읽음이 없고, 연결의 `instagram_user_id`가 `NULL`인 행입니다.
`instagram_user_id`는 Instagram Login OAuth 교환(`src/app/instagram-oauth.ts`)만 쓰고, 연결을 끊어도 지우지 않습니다(`src/app/settings.ts`).
Facebook Login은 OAuth 교환을 거치지 않는 환경 변수 관리 연결에서만 쓰이므로 그 값이 `NULL`입니다.
따라서 `NULL`은 Facebook Login 연결, 로그인 방식과 관계없는 환경 변수 관리 연결, migration 040 전에 연결한 뒤 다시 연결하지 않은 OAuth 연결을 가리키며, 어느 쪽도 `messaging_seen`을 받는다고 알려져 있지 않습니다.
연결은 발송 행의 `connection_id`(와 작업 공간)로 `EXISTS` 조회하므로 다른 건수를 늘리지 않으며, 리포트 시점의 연결 상태를 읽습니다.
이 연결에 읽음이 저장되어 있으면 그 행은 `read`로 세고 `read_unavailable`로 세지 않습니다.

`read`와 `read_unavailable`은 서로 겹치지 않는 `sent`의 부분집합이며, 합계가 되는 어느 분할에도 속하지 않습니다.
기존 분할과 그 합은 바뀌지 않습니다.
읽음을 추정하지 않습니다. 뒤 메시지의 읽음으로 앞 메시지를 읽음 처리하는 워터마크 계산을 하지 않고, ‘읽지 않음’ 건수나 읽음률도 내지 않습니다.

한계는 다음과 같습니다.

- Instagram Login으로 연결했지만 `messaging_seen` 구독 전에 연결한 계정은 `instagram_user_id`가 있어 `read_unavailable`로 세지 않으며, 다시 연결할 때까지 읽음이 오지 않습니다. 이 계정의 보낸 메시지는 어느 읽음 건수에도 들지 않고, 화면 안내로 다시 연결하도록 알립니다.
- 비공개 답장은 읽음이 적거나 없을 수 있습니다. 2026-11-10 운영 시험에서 비공개 답장의 읽음 이벤트는 오지 않았고, 이를 보정하지 않고 안내만 합니다.
- 팔로우 대화의 앞선 응답은 다음 응답을 보낼 때 메시지 ID를 잃습니다. 이 문제는 [#321](https://github.com/AndrewDongminYoo/auto-chatter/issues/321)에서 다루며, 팔로우 대화는 세 리포트 어디에도 포함되지 않습니다.

화면은 세 리포트의 `sent` 옆에 ‘읽음 확인’과 ‘읽음 확인 불가’를 차례로 표시하고 CSV에 `read`와 `read_unavailable` 행을 더합니다.
`sent`를 설명하는 안내 옆에는 그 메시지에 대해 Instagram이 알려 온 읽음만 센다는 점, ‘읽음 확인 불가’는 읽음을 알려 줄 수 없는 계정(Facebook 로그인이나 서버 설정으로 연결한 계정)의 보낸 메시지라는 점, 읽음이 없다고 읽지 않은 것은 아니라는 점, 읽음 수집 전에 연결한 계정은 다시 연결해야 한다는 점을 한 문단으로 설명합니다.

검증은 다음과 같습니다.

- DB 테스트(`manual-reply-reports.db.test.ts`, `flow-run-reports.db.test.ts`, `campaign-run-reports.db.test.ts`): 읽음 행을 직접 넣어, 정확히 일치하는 읽음이 있는 `sent` 행만 세는지, 한 메시지의 읽음 두 행을 한 번만 세는지, 다른 연결의 메시지 ID와 같은 읽음과 뒤 메시지의 읽음을 세지 않는지, 기존 분할의 합과 플로 실행 `groups`의 합(`read`와 `read_unavailable` 포함)이 유지되는지 확인합니다. `instagram_user_id`가 없는 연결의 `sent` 행은 `read_unavailable`로만 세고, 그 연결에 읽음이 저장된 행은 `read`로만 세고, `sent`가 아닌 행은 어느 쪽에도 세지 않고, `instagram_user_id`가 있는 연결의 행은 `read_unavailable`로 세지 않는지도 확인합니다. `sent`가 아닌 행의 일치하는 읽음은 수동 답장과 비공개 답장 행으로 확인합니다. `campaign_deliveries`와 `flow_dm_deliveries`는 CHECK 제약으로 `sent`가 아닌 행에 메시지 ID를 둘 수 없습니다.
- 단위 테스트(`*-reports.test.ts`): 세 화면이 ‘읽음 확인’과 ‘읽음 확인 불가’를 `sent` 바로 뒤에 표시하는지 확인하고, 플로 실행과 캠페인 실행 화면은 CSV에 두 행이 들어가는지도 확인합니다.

이 테스트들은 배포된 Worker, 실제 읽음 이벤트의 도착 빈도와 운영 데이터를 증명하지 않습니다.
이 PR은 운영에 아무것도 적용하거나 배포하지 않습니다.
