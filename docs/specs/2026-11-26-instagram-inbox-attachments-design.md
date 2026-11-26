# Instagram 인박스 첨부·미지원·취소 메시지 수신 설계

[#20](https://github.com/AndrewDongminYoo/auto-chatter/issues/20)의 첫 PR 설계입니다.
지금 인박스는 텍스트 DM과 확인 버튼 응답만 받습니다.
이번 PR은 첨부 DM, 지원하지 않는 메시지, 보낸 사람이 취소한 메시지를 받아 인박스에 안전하게 표시합니다.
발신 echo와 수정 이벤트는 실계정으로 payload와 구독 필드 이름을 확인한 뒤 뒤 PR에서 다룹니다.

## 결정 (2026-11-26)

- 첫 PR은 첨부·미지원·취소 수신과 원장 반영, 공식 문서 조사 결과를 다룹니다. echo와 수정은 뒤로 미룹니다.
- 첨부는 종류와 제목만 저장합니다. 미디어 URL과 파일은 저장하지 않습니다.
- 보낸 사람이 메시지를 취소하면 인박스에 저장한 본문을 비우고 취소 표시를 남깁니다.
- 첨부 DM은 24시간 응답 창을 열고 활성 연락처 원장에 기록합니다. 키워드 트리거, 라벨 규칙, 플로 응답 대기, 팔로우 확인, 조기 응답 보관에는 넘기지 않습니다.

## 공식 문서 확인 (2026-11-26 조회)

아래 내용은 developers.facebook.com 문서를 요약 도구로 읽은 결과입니다. 인용은 요약본이며 원문 그대로가 아닙니다.
실계정 웹훅으로 확인하기 전까지 이 절의 내용은 문서상의 계약일 뿐입니다.

- 첨부 종류: [Instagram 메시징 웹훅](https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook)은 `audio`, `file`, `image`(이미지 또는 스티커), `share`, `story_mention`, `video`, `ig_reel`, `reel`을 적습니다. [웹훅 예시](https://developers.facebook.com/docs/instagram-platform/webhooks/examples)는 `ig_post`, `story`, `ig_story`도 적고, `share`는 2026년 2월 이후 사용 중단으로 표시합니다. 사라지는 미디어가 `ephemeral` 종류로 온다는 설명은 첫 조회에서만 나왔고, 다시 읽었을 때는 확인되지 않았습니다.
- 같은 Instagram 페이지는 GIF나 스티커를 보내면 웹훅이 오지 않는다고도 적어서, 위 목록과 맞지 않습니다. 문서는 이 불일치를 풀지 않습니다.
- 한 `message`에 `text`와 `attachments`가 함께 올 수 있습니다(웹훅 예시와 [Messenger 메시지 참조](https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages)).
- 첨부 URL의 유효 기간, 인증, 받은 미디어의 크기 제한, 바로 내려받으라는 안내는 문서에 없습니다.
- [Conversations API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api)의 메시지 조회(`GET /<MESSAGE_ID>`)는 `id`, `created_time`, `from`, `to`, `message` 필드만 적고, 대화의 최근 20건만 조회할 수 있습니다. 첨부를 나중에 다시 가져오는 방법은 문서에 없습니다.
- 보낸 사람이 메시지를 취소하면 `messages` 필드로 `is_deleted: true`가 옵니다. 예시 본문에는 `mid`만 있습니다. 취소된 메시지의 저장 본문을 지울 의무는 메시징 문서에 없고, [Platform Terms](https://developers.facebook.com/terms/?locale=en_US) 3.d는 사용자나 Meta의 요청을 받으면 Platform Data를 지우라고 일반적으로 정합니다.
- 지원하지 않는 미디어에는 `is_unsupported: true`가 옵니다. 화면에 무엇을 보여 줄지는 문서에 없습니다.
- 발신 echo(`is_echo`)는 `messages` 필드로 온다는 문서와 별도 `message_echoes` 필드가 있다는 [필드 표](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields)가 서로 다릅니다. 어느 앱이 보냈는지 구분하는 방법은 Instagram 문서에 없습니다.
- 수정 이벤트의 payload는 `message_edit {mid, text, num_edit}`이지만, Instagram의 구독 필드 이름은 문서에 없습니다(Messenger는 `message_edits`).
- 웹훅은 과거 이벤트를 다시 조회할 수 없고, 전달에 실패한 이벤트는 36시간 동안 다시 보냅니다([웹훅 설정](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup)).

## 수신 해석

`parseMessageEvents`(`src/instagram/message-events.ts`)는 지금처럼 서명 검증 뒤에 한 번 읽고, 기존 검사(계정·보낸 사람·받는 사람·`mid`·시각)를 그대로 씁니다.
echo와 `is_self`는 지금처럼 버립니다.

| 입력                                                   | 결과 종류     | 저장 본문                 |
| ------------------------------------------------------ | ------------- | ------------------------- |
| `text`가 있는 메시지(첨부가 함께 있어도)               | `text`        | `text`, 첨부 목록도 저장  |
| `text`가 없고 `attachments`가 1개 이상                 | `attachment`  | 빈 문자열, 첨부 목록 저장 |
| `is_unsupported: true`이고 `text`와 `attachments` 없음 | `unsupported` | 빈 문자열                 |
| `is_deleted: true`                                     | 취소 이벤트   | 아래 [취소](#취소) 참고   |
| 확인 버튼 postback                                     | `postback`    | 지금과 같음               |
| 그 밖의 형식                                           | 버림          | 지금과 같음               |

- 첨부 항목은 `type`과 선택적인 `title`만 읽습니다. `payload.url`, `reel_video_id`, `sticker_id`, 스토리 ID와 URL은 읽지 않습니다.
- 허용하는 `type`은 위 문서의 목록(`audio`, `file`, `image`, `share`, `story_mention`, `video`, `ig_reel`, `reel`, `ig_post`, `story`, `ig_story`, `ephemeral`)입니다. 목록에 없는 문자열은 `other`로 저장합니다.
- `title`은 1자 이상 200자(코드 포인트 기준) 이하이고 NUL이 없을 때만 저장합니다. 그 밖의 값은 버립니다.
- 한 메시지의 첨부는 처음 10개까지만 저장합니다.
- 기존 텍스트 메시지의 동작은 바뀌지 않습니다. 첨부가 함께 있는 텍스트 메시지도 지금처럼 키워드 트리거와 응답 대기에 넘깁니다.

채널 계약(`src/channels/contract.ts`)에는 `attachment_message`, `unsupported_message`, `message_deleted` 이벤트를 더합니다.
`text_message`의 `text`에 빈 문자열을 넣어 재사용하지 않습니다. 빈 문자열이 `contains` 규칙에 걸리거나 응답 대기를 빈 값으로 재개할 수 있기 때문입니다.

## 저장

migration 079가 `instagram_inbox_messages`를 바꿉니다.

- `kind` CHECK에 `attachment`, `unsupported`, `deleted`를 더합니다.
- `attachments jsonb`(NULL 허용)을 더합니다. 값은 `{type, title?}` 객체의 배열이며 1개 이상 10개 이하입니다. CHECK로 배열 형태와 길이를 강제합니다.
- `deleted_at timestamptz`(NULL 허용)을 더합니다.

새 표가 없으므로 삭제 함수 3개와 작업 공간 내보내기 목록은 바뀌지 않습니다. 두 곳 모두 표 단위로 행을 지우거나 내보내기 때문에 새 열도 함께 처리됩니다.
서버 역할의 권한도 표 단위이므로 바뀌지 않습니다.

## 배포 순서

migration 079를 코드보다 먼저 적용합니다.
새 코드는 모든 DM의 INSERT에 `attachments` 열을 적으므로, 코드가 먼저 배포되면 첨부 DM뿐 아니라 모든 DM 배치가 `42703`(열 없음) 오류로 롤백됩니다. 그동안 Meta가 실패한 전달을 최대 36시간 다시 보내므로 DM 수신 전체가 멈춥니다.
배포 워크플로의 migration 가드(`scripts/deploy-migration-guard.sh`)는 `db/migrations/`가 바뀐 커밋을 자동 배포하지 않습니다.
그래서 머지 뒤에 `deploy/migrate-multi-user.sql`로 079를 적용하고, `migrations_applied=true`로 배포 워크플로를 수동 실행합니다.
migration이 먼저 적용되고 이전 코드가 도는 동안에는 이전 코드가 새 열 없이 텍스트와 postback 행만 쓰므로 그대로 동작합니다.

## 다른 기능과의 관계

| 경로                                                        | `attachment`  | `unsupported` | 취소 표시 행 |
| ----------------------------------------------------------- | ------------- | ------------- | ------------ |
| 인박스 저장(보관 스위치·활성화 시각 조건)                   | 저장          | 저장          | 아래 참고    |
| 대화 다시 열기(완료한 대화)                                 | 다시 엶       | 다시 엶       | 열지 않음    |
| 라벨 규칙                                                   | 적용 안 함    | 적용 안 함    | 적용 안 함   |
| 플로 응답 대기, 팔로우 확인, 조기 응답 보관, DM 시작 트리거 | 넘기지 않음   | 넘기지 않음   | 넘기지 않음  |
| 24시간 창(직접 답장, DM 플로, 캠페인 후보)                  | 엶            | 엶            | 바꾸지 않음  |
| `instagram_dm_last_inbound`(#300)                           | 기록          | 기록          | 기록 안 함   |
| 활성 연락처 원장(#51)                                       | `dm_received` | `dm_received` | 기록 안 함   |
| 세그먼트와 연락처 목록의 DM 활동 조건                       | 셈            | 셈            | 세지 않음    |
| 인박스 목록·안 읽음 수, 연락처 상세, 신원 후보, 프로필 조회 | 메시지로 셈   | 메시지로 셈   | 메시지로 셈  |

- 24시간 창을 읽는 세 쿼리(`manual-reply-worker.ts`, `dm-flow-delivery-worker.ts`의 `WINDOW_ANCHOR`, `campaign-drafts.ts`의 `latestTextSql`)는 `kind='text'` 대신 `kind IN ('text','attachment','unsupported')`를 읽습니다. 확인 버튼 postback은 지금처럼 창을 열지 않습니다.
- 원본보다 먼저 온 취소가 남긴 `deleted` 행의 시각은 받은 DM의 시각이 아니라 취소 이벤트의 시각입니다. 그래서 "그 기간에 DM을 받았다"고 읽는 DM 활동 조건(`contacts.ts`)은 이 행을 건너뜁니다. 인박스 목록, 안 읽음 수, 연락처 상세의 메시지 수, 신원 후보, 프로필 조회는 이 행을 화면에 보이는 "취소된 메시지" 한 건으로 셉니다. 그래서 이 행이 생긴 대화는 목록 위로 올라가고 안 읽음 1이 붙습니다.
- 지금은 첨부만 있는 DM이 원장에서 빠지므로, #51의 "모든 수신 DM을 셈" 규칙보다 활성 연락처 수가 낮게 나옵니다. 이번 변경으로 이 빈틈이 닫히고 #52의 한도 판정 숫자가 조금 늘 수 있습니다.

## 취소

서버 역할은 DELETE 권한이 없으므로 행을 지우지 않고 UPDATE로 본문을 비웁니다.

- 같은 `(connection_id, message_id)` 행이 있으면 `text`를 빈 문자열로, `attachments`를 NULL로 바꾸고 `deleted_at`을 처음 한 번만 기록합니다. `kind`와 `message_at`은 유지하므로, 이미 열린 24시간 창은 그대로입니다.
- 행이 없고 이벤트에 보낸 사람이 있으며 인박스 저장 조건을 만족하면, `kind='deleted'`, 빈 본문, `deleted_at`이 있는 행을 먼저 넣습니다. 그러면 원본이 늦게 도착해도 기존 `ON CONFLICT DO NOTHING`에 걸려 저장되지 않습니다. `storeInboxMessage`는 이 충돌을 알려 주고, `ingestMessages`는 그 원본을 응답 대기, 팔로우 확인, 조기 응답 보관, DM 시작 트리거에 넘기지 않습니다. 원장과 마지막 수신 시각에는 받은 DM으로 기록합니다. 인박스 저장이 꺼진 연결에는 이 행이 없으므로 늦은 원본은 자동화로 넘어갑니다. 이 행의 `message_at`은 취소 이벤트의 시각입니다.
- 인박스를 켜기 전에 받은 DM을 켠 뒤에 취소하면, 원본의 시각을 알 수 없으므로 취소 시각의 `deleted` 행이 새로 생기고 목록에 "취소된 메시지" 대화로 나타납니다.
- 이벤트에 보낸 사람이 없으면 행을 먼저 넣지 못합니다. 이 경우 늦게 도착한 원본은 저장됩니다. Meta 예시가 봉투의 `sender`를 생략했는지 실제로 없는지는 확인하지 않았습니다.
- 취소 이벤트는 대화를 다시 열지 않고, 원장·마지막 수신 시각·자동화에 넘기지 않습니다.
- 취소 처리는 같은 메시지 ID 잠금(`lockMessageIds`)과 대화 잠금을 다른 DM과 같은 순서로 잡습니다.
- 인박스 밖의 복사본(플로 응답 대기가 사용자 정의 필드에 저장한 값, 조기 응답 보관 본문, 고객 웹훅으로 이미 보낸 값)은 지우지 않습니다. 이 범위는 [#58](https://github.com/AndrewDongminYoo/auto-chatter/issues/58)이 정합니다.
- 검색(`q`)은 빈 본문을 찾지 못하므로 취소한 메시지는 검색 결과에서 빠집니다.

## API와 화면

- `GET /api/connections/<연결>/inbox/<받는 사람>`의 각 메시지에 `attachments`(배열 또는 `null`)와 `deleted_at`(문자열 또는 `null`)을 더합니다. `kind`는 새 값을 가질 수 있습니다.
- `GET /api/inbox`의 대화에 `last_message_kind`를 더합니다. `last_message_preview`는 지금처럼 본문 앞 80자이며, 첨부만 있는 메시지와 취소한 메시지는 빈 문자열입니다.
- 화면은 본문을 텍스트로만 그립니다. 첨부는 "사진", "동영상", "음성 메시지", "파일", "게시물 공유", "릴스 공유", "스토리 멘션", "스토리 공유", "사라지는 미디어", "첨부" 같은 종류 이름과 제목을 보이고, "Instagram 앱에서 확인하세요"를 덧붙입니다. 문구는 `public/app/message-labels.js`가 가지고 있습니다.
- 목록의 두 값은 SELECT 목록의 스칼라 하위 쿼리로 읽습니다. 2026-11-26 대화 3,000개로 `EXPLAIN ANALYZE`를 실행했을 때, LATERAL 조인으로 쓰면 색인 조회가 3,000번 실행되었고 스칼라 하위 쿼리는 목록에 실리는 51번만 실행되었습니다.
- 지원하지 않는 메시지는 "Instagram에서만 볼 수 있는 메시지입니다", 취소한 메시지는 "보낸 사람이 취소한 메시지입니다"를 보입니다.
- 목록 미리보기는 본문이 비어 있으면 같은 문구를 짧게 보입니다.

## 구독 필드

이번 PR은 구독 필드를 바꾸지 않습니다. 첨부, 미지원, 취소는 모두 이미 구독한 `messages` 필드로 옵니다.

## 공개 문구

`/privacy`의 수신 인박스 문장에 첨부 종류와 제목, 취소 표시를 보관한다는 내용을 더하고, 미디어 자체는 보관하지 않는다고 적습니다.

## 수락 기준

1. 첨부만 있는 DM, 텍스트와 첨부가 함께 있는 DM, 미지원 DM, 취소 이벤트가 위 표대로 해석되고, URL과 미디어 식별자는 저장되지 않습니다.
2. 같은 메시지를 다시 받아도 한 행만 남습니다. 취소가 원본보다 먼저 와도 원본은 저장되지 않고, 취소가 두 번 와도 `deleted_at`은 처음 값을 유지합니다.
3. 첨부 DM과 미지원 DM은 24시간 창을 열고 원장과 마지막 수신 시각에 기록되며, 라벨 규칙·트리거·응답 대기·팔로우 확인·조기 응답 보관은 실행되지 않습니다.
4. 인박스가 꺼졌거나 활성화 전이거나 연결이 비활성이면 첨부와 취소 표시 행을 저장하지 않습니다.
5. 화면은 첨부 종류, 미지원, 취소를 텍스트로 보이고, 밝음·어두움 테마와 좁은 화면에서 깨지지 않습니다.
6. migration 079는 기존 행을 바꾸지 않고, `deploy/migrate-multi-user.sql`로 다시 실행해도 안전합니다.

## 검증 범위

단위 테스트, 격리된 DB 테스트, workerd 테스트, 로컬 화면 미리보기로 확인합니다.
완료 조건 1과 3의 "실제 권한으로 받는 이벤트"는 이 PR로 확인되지 않습니다. 운영 배포 뒤 실계정으로 첨부·미지원·취소 DM을 보내 인박스에 표시되는지 확인해야 하며, 웹훅 본문은 로그에 남지 않으므로 화면과 DB 행으로 관찰합니다. 이 확인은 운영 반영 승인과 별도로 진행합니다.
