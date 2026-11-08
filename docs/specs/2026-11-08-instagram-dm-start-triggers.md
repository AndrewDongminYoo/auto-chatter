# Instagram DM 시작 트리거

## 상태와 근거

2026-11-08 [#33](https://github.com/AndrewDongminYoo/auto-chatter/issues/33)의 계획이 승인되었습니다.
#33은 여러 PR로 나눕니다: ① 서버의 시작 기록(이 문서의 구현 범위), [#291](https://github.com/AndrewDongminYoo/auto-chatter/issues/291) 발송 worker, [#292](https://github.com/AndrewDongminYoo/auto-chatter/issues/292) 편집기, [#293](https://github.com/AndrewDongminYoo/auto-chatter/issues/293) 실계정 확인, [#294](https://github.com/AndrewDongminYoo/auto-chatter/issues/294) 스토리 응답·멘션.
이 PR은 아무것도 보내지 않습니다: Graph 호출, transport, outbox 행, 큐 메시지, cron 단계가 없습니다.
#33은 이 PR 뒤에도 열린 상태로 남습니다.
migration 068은 코드 배포 전에 전체 실행기(`deploy/migrate-multi-user.sql`)로 적용해야 합니다.
이 문서는 로컬 검사의 범위만 기록합니다. 운영 적용과 실계정 확인은 하지 않았습니다.

## 트리거 종류

받은 일반 텍스트 DM 하나가 발행되고 켜진 DM 트리거 플로 하나를 시작할 수 있습니다.
트리거 노드는 두 종류이며, 둘 다 포트 `next` 하나를 가집니다.

- `instagram_dm_keyword`: `{connection_id, keywords, match_mode, excluded_keywords}`입니다. 댓글 트리거와 같은 모양입니다. `match_mode`는 `contains`, `exact`, `all`이며, `all`이 아니면 키워드가 하나 이상 있어야 합니다. `all`은 제외 키워드가 든 DM을 뺀 모든 DM에 맞습니다.
- `instagram_dm_default`: `{connection_id}`입니다. 어떤 키워드 트리거에도 맞지 않은 DM에 답합니다.

키워드 비교는 댓글 규칙과 같은 정규화(`normalizeMatchText`: NFC, 앞뒤 공백 제거, 소문자)를 씁니다.
한 플로에는 댓글 트리거와 DM 트리거를 합쳐 트리거가 정확히 하나 있어야 합니다(`trigger_count`).

## DM 플로의 단계 제한

DM으로 시작한 실행에는 댓글이 없고, 댓글 7일 답장 기간과 비공개 답장 outbox도 쓰지 않습니다.
보내는 사람은 메시징 sender ID이며 댓글 연락처와 연결하지 않습니다(아래 [신원](#신원과-발송-제한)).
그래서 이 PR에서 DM 트리거 플로는 트리거와 메시지 보내기(`instagram_message`)만 가질 수 있습니다.

승인된 계획이 거절하라고 한 것은 세 가지입니다: `{{comment.text}}`, 응답 대기(`wait_for_reply`), 지연 단계.
이 PR은 그보다 넓게 거절합니다. 아래의 추가 거절은 계획에 적혀 있지 않았지만, DM 발신자를 댓글 연락처와 잇지 않는다는 결정 2를 지키기 위해 따라 나온 범위 축소입니다.

| 거절 대상                                                                  | 근거                   | 이유                                                                                                                                  |
| -------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `{{comment.text}}`, `wait_for_reply`, `delay`                              | 승인된 계획            | 댓글 7일 답장 기간과 비공개 답장 outbox를 전제합니다.                                                                                 |
| 시각 대기(`wait_until`)                                                    | 추가 거절(지연과 같음) | 실행을 `waiting`으로 멈추는 지연 단계입니다. 재개 경로는 댓글 실행만 이어 갑니다.                                                     |
| 태그·필드 조건(`has_tag`, 필드 조건)과 동작(태그·필드 쓰기), `{{field:…}}` | 추가 거절              | 태그와 필드는 댓글 보낸 사람으로 저장됩니다. 메시징 ID로 읽으면 빈 값으로 판단하고, 쓰면 메시징 ID가 댓글 연락처로 섞입니다(결정 2).  |
| 외부 전송(`webhook`)                                                       | 추가 거절              | 전달 행의 `sender_id`는 사람 데이터 삭제가 댓글 보낸 사람으로 찾는 값이고, 보낼 태그·필드도 위와 같은 이유로 읽을 수 없습니다.        |
| 팔로우 확인(`follows_account`)                                             | 추가 거절              | 댓글 플로에서도 실행기가 지원하지 않는 단계입니다(`flowExecutionErrors`가 켜기를 거절). 발행 단계에서 미리 거절할 뿐 동작은 같습니다. |

- 다른 단계는 `dm_trigger_unsupported_node`, 메시지 본문의 변수는 `dm_trigger_unsupported_variable`로 발행을 거절합니다.
- 이후 PR이 메시징 ID 신원과 함께 이 단계들을 다시 허용합니다.

실행 시에도 같은 제한을 지킵니다: 연락처를 바꾸거나, 외부 전송을 쌓거나, 대기에서 멈추는 걸음은 아무것도 쓰지 않고 `failed`/`unsupported_node`로 끝납니다.

## 발행과 켜기 검사

한 연결에서 켜진 DM 트리거 플로끼리는 다음을 지켜야 합니다.

- 기본 응답 플로는 연결당 하나만 켤 수 있습니다(`dm_default_conflict`).
- 키워드가 겹치는 키워드 플로는 함께 켤 수 없습니다(`dm_keyword_conflict`).

겹침 규칙은 정규화한 키워드로 판정하며 제외 키워드는 보지 않습니다.

| 한쪽       | 다른 쪽    | 겹치는 경우                                              |
| ---------- | ---------- | -------------------------------------------------------- |
| `exact`    | `exact`    | 같은 키워드가 있을 때                                    |
| `exact`    | `contains` | `exact` 키워드 하나가 `contains` 키워드 하나를 포함할 때 |
| `contains` | `contains` | 한쪽 키워드가 다른 쪽 키워드를 포함할 때                 |
| `all`      | 키워드     | 항상 겹침(`all` 두 개도 겹침)                            |
| 키워드     | 기본 응답  | 겹치지 않음(키워드가 이김)                               |
| 기본 응답  | 기본 응답  | 항상 겹침                                                |

표의 "키워드"는 `contains`, `exact`, `all` 세 모드를 모두 뜻합니다.
`all` 트리거는 제외 키워드와 상관없이 다른 모든 키워드 트리거와 겹칩니다. 그래서 한 연결에서 `all` 트리거가 켜져 있으면 다른 키워드 트리거를 켤 수 없습니다.
`all`은 키워드 트리거라서 기본 응답보다 먼저 맞습니다. 제외 키워드가 없는 `all` 트리거가 켜져 있으면 그 연결의 기본 응답 플로는 시작하지 않습니다. 제외 키워드가 있으면 그 키워드가 든 DM만 기본 응답 플로로 갑니다.
`contains` 두 개는 이 규칙을 통과해도 한 DM에 두 키워드가 함께 있으면 둘 다 맞을 수 있습니다. 그때는 아래 순서대로 가장 오래된 플로 하나만 시작합니다.

검사는 발행과 켜기 두 곳에서 합니다.
발행은 이 플로가 꺼져 있어도 같은 연결의 켜진 DM 플로와 비교하고, 켜기는 켜는 순간 다시 비교합니다.
둘 다 플로 행 다음에 연결 행을 `FOR NO KEY UPDATE`로 잠근 뒤 읽으므로, 겹치는 두 플로가 동시에 켜지지 않습니다.
댓글 플로의 검사(`legacy_rule_conflict`, `flow_trigger_conflict`)와 동작은 바뀌지 않습니다.

## 버전 키

`flow_versions.trigger_type`이 트리거 종류(`instagram_comment`, `instagram_dm_keyword`, `instagram_dm_default`)를 저장합니다.
댓글 버전은 지금처럼 `(trigger_connection_id, trigger_media_id)`를 키로 쓰고, DM 버전은 `trigger_media_id`가 NULL입니다.
CHECK `flow_versions_trigger_key`가 댓글 버전에만 게시물 ID가 있도록 묶습니다. 기존 행은 `instagram_comment`로 채워집니다.

## 수신 시 시작

`ingestMessages`가 DM마다 다음 순서로 처리합니다.

1. 받은 메시지함 저장(켜진 연결만).
2. 응답 대기(`resumeRepliedFlowRun`)와 팔로우 확인(`offerMessage`)에 DM을 넘깁니다. 둘 중 하나가 가져가면 여기서 끝납니다.
3. 가져간 곳이 없으면 발송 중 응답 보관(`keepUnmatched`)을 거칩니다.
4. 그다음 `startDmTriggerFlow`(`src/instagram/dm-start-trigger.ts`)가 DM 트리거를 시도합니다.

버튼 postback, 저장할 수 없는 값(41자리 이상의 sender ID, 512자를 넘는 메시지 ID, NUL이 든 본문)은 시작하지 않습니다.
메시지 파서(`parseMessageEvents`)는 `reply_to`를 읽지 않으므로, 본문이 있는 스토리 응답은 #294 전까지 일반 텍스트 DM과 구별되지 않고 같은 트리거를 시작할 수 있습니다.
본문(`text`)이 없는 메시지는 파서가 건너뜁니다.
일치는 연결의 켜진 DM 플로를 키워드 플로 먼저, 그 안에서 플로 생성 시각과 ID 순으로 보고, 처음 맞는 플로 하나만 고릅니다.
키워드 플로가 하나도 맞지 않을 때만 기본 응답 플로가 시작합니다. 한 DM은 실행을 많아야 하나 시작합니다.
플로와 버전 행은 잠그지 않고 읽습니다. 발행과 켜기가 플로 다음에 연결을 잠그므로, 수신 쪽이 플로를 잠그면 교착이 생길 수 있습니다.
수신 쪽은 연결을 `FOR SHARE`로 잠근 뒤 씁니다.
그보다 먼저, 수신 트랜잭션은 배치의 메시지 ID마다 잠금을 잡습니다(아래 반대 방향 배제 참고).

시작 기록은 DM 하나의 시작만 남깁니다. 같은 사람의 다음 DM도 아래 우선순위의 차단 조건에 걸리지 않으면 다시 일치를 시도합니다.

## 우선순위: 기존 소비자가 이깁니다

응답 대기나 팔로우 확인이 가져간 DM은 트리거를 시작하지 않습니다.
같은 연결에서 같은 보낸 사람에게 다음 중 하나가 있으면, 그 보낸 사람의 DM은 트리거를 시작하지 않습니다.

- 이 보낸 사람이 아직 이어 갈 수 있는 실행: 비공개 답장이 이 사람에게 보내졌고 응답 대기 기한이 남은 `awaiting_reply` 실행, 또는 이 사람의 DM으로 시작해 `waiting`/`awaiting_reply`인 실행.
- 대기 중인 팔로우 확인: 규칙이 켜져 있고 상태가 `waiting`, `pending`, `sending`인 팔로우 대화. 팔로우하지 않은 사람에게 안내를 보낸 대화는 `waiting`으로 돌아가므로, 규칙을 끄거나 대화가 끝날 때까지 그 사람의 DM 트리거를 막습니다.
- 수신 후 15분 안의 보관된 DM: 아직 연결되지 않았고 본문이 남은 `instagram_unmatched_replies` 행.

보관된 DM 조건이 필요한 이유는 이렇습니다.
비공개 답장이 발송 중일 때 받은 DM은 수신자가 아직 기록되지 않아 응답 대기와 맞출 수 없으므로 보관되고, 답장이 보내진 뒤 수신 후 15분까지 기다리는 실행에 연결될 수 있습니다.
그래서 수신 시점에 가져간 곳이 없다는 결과만으로는 그 DM이 기존 대기의 응답이 아니라고 판단할 수 없습니다.
발송 중인 답장이 있는 연결에서는 보관된 DM 자체도 트리거를 시작하지 않습니다.

같은 메시지 ID의 재전송도 막습니다: 팔로우 수신 기록(`instagram_message_receipts`), 응답 대기가 끝난 실행의 `reply_message_id`, 보관된 DM 중 하나에 이미 있는 메시지 ID는 시작하지 않습니다.
시작 기록은 `(connection_id, message_id)`가 고유하므로 같은 DM의 두 번째 전송도 아무것도 시작하지 않습니다.
차단된 DM은 시작 기록을 남기지 않습니다. 시작 기록과 실행은 일대일입니다.

반대 방향도 막습니다(#291).
수신은 최대 60초 미래 시각의 DM을 받으므로, DM이 트리거를 시작한 뒤에 그 보낸 사람에게 비공개 답장이 보내지고 Meta가 같은 DM을 다시 보낼 수 있습니다.
그 연결의 시작 기록(`instagram_dm_start_events`)에 이미 있는 메시지 ID는 팔로우 확인(`offerMessage`)도, 응답 대기(`resumeRepliedFlowRun`)도 가져가지 않고, 보관된 DM(`keepUnmatched`)으로도 남지 않습니다.
그래서 수신 기록, 실행의 `reply_message_id`, 보관 행 중 어느 것도 쓰이지 않습니다.
같은 보낸 사람의 다른 메시지 ID는 전과 같이 맞춥니다.
각 소비자는 자기 문장 안에서 시작 기록을 읽습니다.
보관된 DM을 나중에 연결하는 경로도 `offerMessage`를 거치므로 같은 확인을 받습니다.
같은 메시지가 동시에 다시 와도 이 확인이 빠지지 않도록, 수신 트랜잭션은 다른 어떤 잠금보다 먼저 배치의 (계정 ID, 메시지 ID)마다 트랜잭션 advisory 잠금(`'instagram-message:'` 키, `src/instagram/follow-flow.ts`의 `lockMessageIds`)을 키 순서대로 잡습니다.
그래서 두 번째 전송은 첫 전송이 커밋할 때까지 기다린 뒤 커밋된 시작 기록을 봅니다.
받은 메시지함 저장이 꺼져 대화 잠금이 없는 연결도 같습니다.
이 잠금을 기다리는 트랜잭션은 그보다 앞서는 메시지 잠금만 쥐고 있으므로, 연결·대화 잠금이나 발행·켜기, 삭제 함수와 교착을 만들지 않습니다.
메시지 ID가 다른 DM은 서로 기다리지 않습니다.

## 신원과 발송 제한

DM으로만 들어온 보낸 사람은 메시징 sender ID로 식별하며, 댓글 연락처와 연결하지 않습니다. 기존 명세처럼 두 ID가 같다고 가정하지 않습니다.
이 PR은 시작 여부를 정할 때 다음을 지킵니다.

- 채널 수신 거부(`messagingRecipientOptedOut`, `src/instagram/channel-consent.ts`): 다음 중 하나의 `service_reply` 철회가 있으면 시작하지 않습니다.
  - 이 메시징 ID(`dm_recipient`) 자신.
  - Meta가 받았다고 확인한(`sent`이고 `provider_message_id`가 있는) 비공개 답장이 이 메시징 ID에 닿은 댓글 보낸 사람. 그 댓글 보낸 사람마다 `deliveryRecipientOptedOutSql`로 확인하므로, 그 사람 자신(`comment_sender`)의 철회와 같은 사람에게 이어진 다른 메시징 ID(`dm_recipient`)의 철회도 막습니다.
  - 이 연결은 발송 경로가 쓰는 확인된 답장 연결을 수신자 쪽에서 읽은 것입니다. 두 ID가 같다고 가정하지 않으며, 연락처 데이터를 잇지도 않습니다. 확인되지 않은 답장(`unknown` 등)은 연결로 보지 않습니다.
- 받은 메시지함의 상담 전환: 이 연결과 수신자(`instagram_inbox_handoffs.recipient_id`)의 상담 전환이 켜져 있으면 시작하지 않습니다.

메시징 ID 단위의 자동화 일시 중지는 이 PR에 없습니다. 지금의 일시 중지(`instagram_contact_automation`)는 댓글 보낸 사람으로 저장되므로 메시징 ID에 쓸 수 없습니다.
#291이 발송 직전 재검사와 함께 메시징 ID 일시 중지를 추가합니다. 그 전까지 이 공백이 남으며, 이 PR의 행은 보내지지 않으므로 발송으로 이어지지 않습니다.

## 저장

- `instagram_dm_start_events`: 트리거를 시작한 DM 하나당 한 행입니다. `(connection_id, message_id)`가 고유하고, 메시지 ID, 메시징 sender ID, DM 시각, 일치한 플로·버전·트리거 종류만 저장합니다. DM 본문은 저장하지 않습니다. 받은 메시지함(`inbox_enabled`)이 꺼져 있어도 씁니다.
- `flow_runs`: 시작 원천이 댓글 이벤트(`event_id`) 또는 DM 시작 기록(`dm_start_event_id`) 중 정확히 하나입니다(CHECK `flow_runs_source`). 원천마다 중복 방지 고유 조건이 하나씩 있습니다(`(flow_id, event_id)`, `(flow_id, dm_start_event_id)`).
- `flow_dm_deliveries`: DM으로 시작한 실행의 첫 메시지입니다. 수신자는 메시징 sender ID이고 상태는 `pending`뿐입니다. `private_reply_outbox`에는 쓰지 않습니다. outbox는 댓글 ID와 게시물 ID가 NOT NULL이고, `(connection, media, sender)` 고유 조건이 맞지 않으며, 그 claim 쿼리가 행을 가져가기 때문입니다. 실행 기록(`listFlowRuns`)과 실행 보고서(`flowRunReport`)는 이 행의 상태를 그 실행의 발송 상태로 읽으므로, DM으로 시작한 실행이 "연결된 답장 없음"으로 세어지지 않습니다.
- `flow_step_runs`: 댓글 실행과 같은 방식으로 트리거와 메시지 단계를 기록합니다.

이 PR에서는 비공개 답장 claim, 팔로우·캠페인·수동 답장 worker, 실행 재개, Cloudflare cron과 큐 어느 것도 `flow_dm_deliveries`를 읽지 않습니다.
#291이 발송 상태, claim, 24시간 창 검사, 삭제 함수의 발송 중 잠금을 추가합니다.

## 재개 경로

`CLAIMED_RUN`(`src/instagram/store.ts`)은 두 원천을 모두 조인하며, DM으로 시작한 실행의 보낸 사람은 시작 기록의 메시징 sender ID입니다.
발행이 대기와 지연을 막으므로 DM 실행은 멈추지 않습니다. 그래도 멈춘 DM 실행이 재개되면 아무것도 쓰지 않고 `cancelled`/`unsupported_trigger`로 끝납니다.

## 편집기

편집기는 DM 트리거 단계를 편집할 수 없습니다(#292).
DM 트리거가 있는 플로는 관리자에게도 읽기 전용으로 열리며, 저장·발행·켜기 버튼과 단계 편집 메뉴를 보여 주지 않습니다(`flowReadOnlyReason`).
그래서 편집기에서 저장해 DM 트리거 플로를 망가뜨릴 수 없습니다. DM 트리거 플로는 API로만 만들고 발행하고 켭니다.
받은 메시지함에는 새 `kind`를 추가하지 않습니다. 수동 답장과 캠페인의 24시간 창은 `kind='text'`를 읽습니다.

## 삭제, 내보내기, 권한

- 연결 데이터 삭제와 작업 공간 삭제는 두 새 테이블을 지웁니다. 순서는 발송 행, 실행 단계, 실행, 시작 기록이며, 작업 공간 삭제는 시작 기록을 플로 버전보다 먼저 지웁니다.
- 사람 데이터 삭제는 `dm_recipient` 신원(과 그 신원에 이어진 메시징 ID)으로 발송 행, DM으로 시작한 실행과 그 단계, 시작 기록을 지웁니다. 같은 숫자의 `comment_sender` 삭제는 메시징 신원에 닿지 않습니다.
- 작업 공간 내보내기는 두 테이블을 모두 내보냅니다. 시작 기록에는 DM 본문이 없습니다.
- 두 테이블 모두 연결 행을 참조하므로, 작업 공간 이동 검사는 기존의 연결 존재 검사가 이미 덮습니다.
- `deploy/supabase-access.sql`이 두 테이블에 RLS를 켜고 서버 역할에 SELECT·INSERT·UPDATE만 줍니다. 기본 키가 uuid라서 시퀀스 권한은 필요하지 않습니다.

## 검증 범위

`src/app/dm-start-trigger-schema.test.ts`가 트리거 설정, DM 플로 단계 제한, 겹침 규칙, 댓글 플로의 변하지 않은 검사를 확인합니다.
`src/instagram/dm-start-trigger.db.test.ts`가 키워드(`all` 포함)·기본 응답 시작, 재전송, 응답 대기·팔로우 확인 우선, 이어 갈 수 있는 실행·대기 중인 팔로우 확인·보관된 DM 차단, 수신 거부(확인된 답장 연결을 거친 철회 포함)와 상담 전환, 실행 기록과 실행 보고서의 발송 상태, worker와 재개가 발송 행을 읽지 않음, 발행·켜기 충돌, 세 삭제 함수, migration 068 재실행을 확인합니다.
`src/cloudflare/worker.db.test.ts`가 웹훅 DM으로 시작한 발송 행을 cron과 큐가 건드리지 않는 것을 확인합니다.
이 검사들은 로컬 일회용 PostgreSQL과 workerd에서만 실행했으며, 운영 migration, 배포된 Worker, 실계정 수신을 증명하지 않습니다(#293).
