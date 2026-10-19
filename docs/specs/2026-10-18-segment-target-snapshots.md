# 저장된 세그먼트의 고정 대상

## 범위

[#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35)의 첫 완료 항목 가운데 대상 확정만 구현하고, 메시지·템플릿 검증은 포함하지 않습니다.
[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 세 번째 완료 항목인 실행 시 재평가와 고정 캠페인 대상의 차이는 이 문서와 [세그먼트 계약](2026-09-27-contact-segments.md#재평가와-고정-대상)이 설명합니다.
관리자는 저장된 세그먼트에 지금 맞는 댓글 작성자를 한 시점(`as_of`)의 명단으로 고정하고, 그 명단을 목록·상세·CSV로 확인합니다.
고정은 아무것도 발송하지 않습니다.

## 재평가와 고정 대상

저장된 세그먼트는 조건이며, 연락처 목록·미리보기·세그먼트 CSV는 요청할 때마다 그 시점의 데이터로 다시 평가합니다.
그래서 같은 세그먼트라도 태그·필드·동의 기록·활동이 바뀌면 다음 요청의 대상이 달라집니다.
고정 대상은 한 `as_of`의 평가 결과를 저장하고 다시 평가하지 않습니다.
고정한 뒤에 세그먼트를 수정·보관하거나 연락처가 바뀌어도 명단과 집계 건수는 바뀌지 않습니다.
이후 발송 단계(#35의 후속 항목, #36)는 이 명단을 대상으로 참조할 수 있지만, 발송할 때 24시간 응답 창·수신 거부·동의를 다시 확인합니다.

## 범위 밖

- outbox 행, 메시지, 템플릿
- 발송 가능 여부(24시간 응답 창, 수신 거부, 동의)의 판정과 저장
- 비용·요금제 한도([#52](https://github.com/AndrewDongminYoo/auto-chatter/issues/52))
- 예약·실행 승인(#35의 후속 항목)
- 일괄 발송([#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36))
- 만료 작업, 고정 대상의 수정

## 저장 형태(migration 061)

`instagram_segment_snapshots`는 고정 대상 하나입니다.

| 열             | 내용                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`           | UUID                                                                                                                    |
| `workspace_id` | 작업 공간                                                                                                               |
| `segment_id`   | 같은 작업 공간의 세그먼트(`(segment_id, workspace_id)` 외래 키)                                                         |
| `created_by`   | 고정한 관리자의 사용자 ID                                                                                               |
| `created_at`   | 저장 시각                                                                                                               |
| `as_of`        | 평가 시각                                                                                                               |
| `definition`   | 그 시점의 세그먼트 조건 사본: 세그먼트 API 목록 항목에서 `id`와 `name`을 뺀 객체이며 `connection_id`와 `version`을 포함 |
| `segment_name` | 그 시점의 세그먼트 이름                                                                                                 |
| `counts`       | 미리보기와 같은 `{total, evaluated, excluded}` 객체이며 값은 십진수 문자열                                              |
| `member_count` | 저장한 명단 행 수(0~5,000)                                                                                              |

`instagram_segment_snapshot_members`는 명단 행 하나이며 `snapshot_id`, `workspace_id`, `connection_id`, `sender_id`만 가집니다.
기본 키는 `(snapshot_id, connection_id, sender_id)`이고, 고정 대상과 같은 작업 공간의 연결을 외래 키로 참조합니다.
DM 수신자 ID, 댓글 본문, 계정 이름 사본, 태그·필드 값, 발송 가능 여부 열은 없습니다.
세그먼트 외래 키를 위해 `instagram_contact_segments`에 `(id, workspace_id)` 고유 인덱스(`instagram_contact_segments_id_workspace`)를 추가하며, 외래 키는 이 인덱스를 참조합니다.
고유 제약(`ADD CONSTRAINT ... UNIQUE`)이 아니라 인덱스로 만드는 이유는 [배포 순서](#배포-순서)에 있습니다.

서버 역할(`auto_chatter_server`, Compose의 `automations_app`)은 두 테이블에 SELECT와 INSERT만 가지며 UPDATE와 DELETE는 없습니다.
`deploy/supabase-access.sql`이 두 테이블에 RLS를 켜고 `server_update` 정책을 지우며, `deploy/init-app-user.sh`가 UPDATE를 회수합니다.

## 만들기

`POST /api/contact-segments/<id>/snapshots`는 활성 `owner` 또는 `admin`만 사용할 수 있습니다.
동일 출처 검사와 기본 쓰기 한도를 다른 쓰기와 같이 적용합니다.
본문은 비어 있거나 정확히 `{}`이어야 합니다.
길이 0인 본문은 Content-Type 없이 받고, 그 밖의 본문에 키가 하나라도 있거나 객체가 아니면 400 `invalid_snapshot_request`입니다.
UUID가 아닌 세그먼트 ID도 데이터베이스를 읽기 전에 400 `invalid_snapshot_request`입니다.

한 READ COMMITTED 트랜잭션에서 다음 순서로 잠그고 읽습니다.

1. 작업 공간 행을 세그먼트 생성처럼 `lockWorkspaceForMember`로 `FOR UPDATE` 잠그고 호출자의 활성 관리자 역할을 다시 확인합니다.
2. 활성 세그먼트를 `FOR SHARE`로 잠급니다. 보관됐거나 없거나 다른 작업 공간의 세그먼트는 404 `segment_not_found`입니다. 이 잠금 때문에 같은 세그먼트의 수정과 보관은 고정이 끝날 때까지 기다립니다.
3. `savedSegmentConditions`로 조건을 읽고 목록·CSV와 같이 필드 조건마다 `validateFieldCondition`을 실행합니다.
4. 평가에 들어갈 수 있는 연결(세그먼트의 연결, 또는 작업 공간의 모든 연결)을 ID 순서로 `FOR SHARE` 잠급니다.
5. 작업 공간의 고정 대상 수와 지금 남아 있는 명단 행 수를 한 문장으로 셉니다. 고정 대상이 200개 이상이면 409 `snapshot_limit_reached`입니다.
6. 한 SQL 문장으로 평가합니다. 명단은 세그먼트 CSV 내보내기와 같은 선택(`segmentConditionSql`의 `contactScope`, `matches`, `HAVING activityMatches`, `(connection_id, sender_id COLLATE "C")` 순서)이고, 집계는 연락처 목록 미리보기와 같은 `segmentPreviewSql`의 요약입니다. 두 결과가 같은 문장의 스냅샷과 같은 `evaluation` 시각을 씁니다.
7. 명단이 5,000명을 넘으면 409 `snapshot_too_large`로 아무것도 쓰지 않습니다. 남아 있는 명단 행과 새 명단을 합쳐 20,000행을 넘으면 409 `snapshot_members_limit_reached`로 아무것도 쓰지 않습니다([저장 한도](#저장-한도)). 대상이 없으면 명단 0명인 고정 대상을 저장합니다.
8. 고정 대상 행과 명단 행을 INSERT하고 커밋합니다.

응답은 201과 요약 `{id, segment_id, segment_name, as_of, counts, member_count, created_at}`이며 명단은 포함하지 않습니다.
`as_of`는 마이크로초까지의 UTC 문자열입니다.

### 저장 한도

한 작업 공간은 고정 대상을 200개까지, 명단 행을 모든 고정 대상을 합쳐 20,000행까지 저장합니다(`SEGMENT_SNAPSHOT_LIMITS`의 `perWorkspace`와 `maxStoredMembers`).
명단 행 한도는 [작업 공간 내보내기](2026-09-30-workspace-export.md#요청-한도와-크기-한도)를 지키기 위한 것입니다.
내보내기는 명단 행도 50,000행·20 MiB 한도에 함께 세는데, 서버 역할은 명단 행을 지울 수 없고 만료도 없으므로, 이 한도가 없으면 5,000명짜리 고정 대상 10개만으로 내보내기가 삭제 함수를 실행하기 전까지 계속 거절됩니다.
명단 행 하나는 내보내기에서 약 200바이트(UUID 세 개와 17자리 작성자 ID를 담은 JSON 202바이트, 2026-10-18 테스트 DB에서 측정)이므로, 20,000행은 행 한도의 40%, 약 4 MB로 바이트 한도의 4분의 1 미만입니다.
한도는 `member_count`의 합이 아니라 지금 남아 있는 명단 행으로 셉니다. 연결·이용자 단위 삭제가 지운 행은 더 세지 않습니다.
고정 대상 행 200개와 그 조건 사본은 이 계산에 넣지 않았으며, 나머지 작업 공간 데이터와 함께 기존 한도 안에서 셉니다.

### 격리 수준과 평가 시각

브리프는 REPEATABLE READ를 제안했지만 READ COMMITTED를 씁니다.
REPEATABLE READ는 첫 문장(작업 공간 잠금)에서 스냅샷을 고정하므로, 그 뒤에 잠금을 기다린 사이 커밋된 변경을 보지 못합니다.
연결 삭제가 먼저 연결을 잠근 경우 고정은 연결 잠금을 기다렸다가 삭제 전의 댓글을 읽어 지워진 사람의 명단 행을 남기고, 두 관리자가 동시에 고정하면 둘 다 199개를 세어 200개 한도를 넘깁니다.
READ COMMITTED에서 잠금을 모두 얻은 뒤 한 문장으로 평가하면 그 문장의 스냅샷이 잠금 이후에 잡히므로 두 문제가 생기지 않습니다.
DB 테스트는 두 순서를 모두 검사하고, REPEATABLE READ로 바꾸면 두 테스트가 실패하는 것을 확인했습니다.

평가 시각은 평가 문장의 `statement_timestamp()`입니다.
READ COMMITTED에서는 그 문장의 스냅샷이 읽는 데이터의 시점이므로, 트랜잭션 시작 시각(`transaction_timestamp()`)보다 명단과 가깝습니다.
연락처 목록이 같은 함수를 쓰므로, 같은 시각으로 고정한 테스트에서 명단은 `GET /api/contacts?segment_id=`와, 집계는 같은 요청의 `preview=true`와 같습니다.

### 동시성

연결 잠금은 `delete_connection_data`(연결 `FOR UPDATE`)와 `delete_person_data`(연결 `FOR NO KEY UPDATE`)와 충돌합니다.
고정이 먼저 잠그면 삭제는 고정의 커밋을 기다렸다가 새 명단 행까지 지웁니다.
삭제가 먼저 잠그면 고정은 삭제의 커밋을 기다렸다가 삭제 뒤의 데이터로 평가합니다.
`delete_workspace_data`는 작업 공간 행을 먼저 잠그므로 고정과 같은 순서로 직렬화합니다.
고정은 작업 공간 행을 `FOR UPDATE`로 잡은 채 연결을 기다리므로, 연결을 `FOR UPDATE`나 `FOR NO KEY UPDATE`로 잠근 뒤 `workspaces(id)`를 참조하는 행을 넣는 경로가 있으면 교착이 생길 수 있습니다. 2026-10-18 기준 코드에서 그런 경로는 찾지 못했습니다(삭제 함수, 규칙 저장, 플로 발행, 수동 답장, 상담 전환, 동의 기록, 발송 경로를 확인).

## 현재 세그먼트와 비교

관리자는 상세 화면에서 지금 남아 있는 명단과 현재 저장된 활성 세그먼트의 추가·제외·유지 인원 수를 비교할 수 있습니다.
원래 인원 수와 남은 기준 명단 수를 구분하며, 삭제된 식별자를 복원하지 않습니다.
고정 당시와 현재 필터의 버전이 다르면 필터 수정도 차이에 영향을 줄 수 있습니다.
조회 API·읽기 스냅샷·화면 무효화 계약은 [비교 명세](2026-10-19-segment-snapshot-comparison.md)가 소유합니다.

## 조회

모든 조회는 활성 `owner` 또는 `admin`만 사용할 수 있습니다.

- `GET /api/contact-segments/<id>/snapshots`는 그 세그먼트의 고정 대상 요약을 최신순으로 반환합니다(`{snapshots: [...]}`). 보관한 세그먼트도 목록을 반환하고, 없거나 다른 작업 공간의 세그먼트는 404 `segment_not_found`입니다.
- `GET /api/segment-snapshots/<snapshot_id>`는 `{snapshot, members, after}`를 반환합니다. `snapshot`은 요약에 `definition`, `created_by`, 지금 남아 있는 명단 행 수 `stored_member_count`를 더한 객체입니다. `members`는 `(connection_id, sender_id COLLATE "C")` 순서의 50행이고 각 행은 `connection_id`와 `sender_id`만 가집니다. 다음 페이지는 불투명한 커서 `after`로 읽으며, `after` 외의 키·중복 키·잘못된 커서는 400 `invalid_snapshot_request`입니다.
- `GET /api/segment-snapshots/<snapshot_id>/members.csv`는 명단 CSV입니다.
- `GET /api/segment-snapshots`는 작업 공간의 모든 고정 대상과 사용량을 반환합니다(`{snapshots: [...], usage: {snapshots, stored_members, max_snapshots, max_stored_members}}`, [#233](https://github.com/AndrewDongminYoo/auto-chatter/issues/233)). `snapshots`는 세그먼트별 목록과 같은 요약에 지금 세그먼트가 보관됐는지를 나타내는 `segment_archived`를 더한 항목을 최신순(`created_at`, `id` 내림차순)으로 담으며, 보관한 세그먼트의 고정 대상도 포함하고 다른 작업 공간의 고정 대상은 포함하지 않습니다. 작업 공간의 고정 대상은 200개를 넘지 않으므로 페이지를 나누지 않습니다. `usage.stored_members`는 [만들기](#만들기)의 한도 검사와 같은 SQL 조각으로 지금 남아 있는 명단 행을 셉니다. `usage.snapshots`는 반환한 목록의 개수이며, 고정 대상의 `(segment_id, workspace_id)` 외래 키가 모든 고정 대상의 세그먼트를 같은 작업 공간에 두므로 한도 검사가 세는 작업 공간의 고정 대상 행 수와 같습니다. `max_snapshots`와 `max_stored_members`는 `SEGMENT_SNAPSHOT_LIMITS`의 값입니다. 네 값은 모두 작은 정수이므로 JSON 숫자입니다. 목록과 사용량은 한 SQL 문장으로 읽으므로 같은 스냅샷을 쓰고, `snapshots`의 개수는 `usage.snapshots`와 같습니다. 질의 문자열에 키가 하나라도 있으면 데이터베이스를 읽기 전에 400 `invalid_snapshot_request`입니다. 읽기 전용이며 쓰기 한도를 쓰지 않습니다.

서버는 계정 이름을 반환하지 않습니다.
화면은 이미 불러온 연결 목록의 현재 계정 이름(`@username`)으로 연결 ID를 표시하며, 이름은 고정 대상에 저장하지 않습니다.
없거나 다른 작업 공간의 고정 대상은 404 `snapshot_not_found`입니다.

### CSV

UTF-8 BOM과 모든 칸을 큰따옴표로 감싸는 v1 연락처 CSV의 행 형식을 씁니다.
헤더는 `format_version, snapshot_id, segment_id, as_of, workspace_id, channel, identity_kind, connection_id, sender_id`이고 `format_version`은 `1`, `channel`은 `instagram`, `identity_kind`는 `comment_sender`입니다.
`sender_id`는 v1 연락처 CSV의 식별자 칸처럼 앞에 작은따옴표 하나를 붙입니다.
파일 이름은 `auto-chatter-segment-snapshot-<snapshot id>-<as_of의 UTC 날짜>.csv`입니다.
연락처 CSV와 같은 사용자별 허용량(`CONTACT_EXPORT_LIMIT`)을 데이터베이스를 열기 전에 사용하며, 허용량이 없거나 응답하지 않으면 503, 다 쓰면 429입니다.
질의 문자열이 있으면 허용량을 쓰기 전에 400 `invalid_snapshot_request`입니다.

## 변경 불가와 삭제

고정 대상과 명단 행은 만든 뒤 바뀌지 않습니다.
저장한 `counts`와 `member_count`는 `as_of`에 평가가 찾은 결과의 증거입니다.
연결 단위·이용자 단위 삭제는 해당 명단 행을 지우지만 집계를 다시 계산하지 않으므로 `member_count`가 남은 행 수보다 클 수 있으며, 상세 응답의 `stored_member_count`와 화면이 그 차이를 보여 줍니다.

- `delete_connection_data`는 모든 고정 대상에서 그 연결의 명단 행을 지우고 `deleted_counts.instagram_segment_snapshot_members`로 셉니다.
- `delete_person_data`는 대상자 연결 고리(closure)에서 찾은 모든 댓글 작성자의 그 연결 명단 행을 지우고 같은 키로 셉니다.
- `delete_workspace_data`는 명단 행, 고정 대상 순서로 세그먼트보다 먼저 지우고 두 테이블을 모두 셉니다.

만료는 없습니다.
고정 대상은 위 삭제 함수 가운데 하나가 지울 때까지 남습니다.
[개인정보처리방침](../../src/cloudflare/public-pages.ts)의 `/privacy`는 관리자가 저장된 필터의 대상 명단(식별자만)을 고정할 수 있다는 것, 계정·이용자·작업 공간 데이터를 삭제할 때까지 보관한다는 것, 고정만으로는 발송하지 않는다는 것을 설명합니다.
방침의 시행일은 배포 시점에 맞춰 바꿉니다.

두 테이블은 [작업 공간 내보내기](2026-09-30-workspace-export.md)의 `EXPORTED_TABLES`에 있고 제외하는 열은 없으며, 명단 행이 내보내기 한도에서 차지하는 몫은 [저장 한도](#저장-한도)가 제한합니다.
작업 공간 이동 검사(`currentWorkspaceMovable`과 `deploy/assign-workspace-owner.sql`)는 고정 대상이 있는 작업 공간을 비어 있지 않은 것으로 봅니다.

### 관리자 삭제와 만료를 두지 않는 결정

2026-10-19 운영자 결정([#233](https://github.com/AndrewDongminYoo/auto-chatter/issues/233))에 따라 지금은 관리자가 고정 대상을 지우는 경로와 만료 작업을 두지 않고, 한도와 그 이유만 화면에 밝힙니다.
한 작업 공간은 고정 대상 200개와 명단 행 20,000행까지 저장하며, 이유와 계산은 [저장 한도](#저장-한도)에 있습니다.
명단 행은 작업 공간 내보내기에 함께 담기고 서버 역할은 지울 수 없으므로, 한도에 닿은 작업 공간은 더 고정할 수 없습니다.
용량을 되돌리는 경로는 위 세 삭제 함수뿐입니다.
연결·이용자 단위 삭제는 명단 행만 지우므로 명단 행 한도만 되돌리고, 작업 공간 삭제는 고정 대상과 명단 행을 모두 지웁니다.
보존 정책이 바뀌지 않으므로 `/privacy` 문구는 바꾸지 않습니다.

## 화면

소유자와 관리자는 연락처의 저장된 필터 선택 아래에서 "대상 고정"을 사용합니다.
안내 문구는 지금 맞는 사람을 기록하고, 아무것도 보내지 않으며, 발송할 때 수신 가능 여부를 다시 확인한다는 것을 알립니다.
선택한 세그먼트의 고정 대상 목록은 작업 공간 시간대의 기준 시각, 대상 인원, 검사한 연락처 수를 표시합니다.
"명단 보기"는 요약과 50행씩의 명단, "명단 더 보기", "명단 CSV"를 표시하며, 삭제로 빠진 행이 있으면 남은 인원과 함께 알립니다.
세그먼트 내보내기 버튼처럼 세그먼트 요청이 진행 중이거나 수정 중인 필터에 저장하지 않은 변경이 있으면 고정할 수 없습니다.
저장된 필터를 고르지 않았으면 소유자와 관리자에게 작업 공간의 모든 고정 대상 목록(`GET /api/segment-snapshots`)을 보여 줍니다.
각 항목은 고정 대상에 저장한 세그먼트 이름, 지금 보관된 세그먼트이면 "보관됨" 표시, 작업 공간 시간대의 기준 시각, 대상 인원, 검사한 연락처 수를 표시하며, "명단 보기"로 같은 상세·"명단 더 보기"·"명단 CSV"를 엽니다.
선택한 세그먼트를 보관하면 선택이 풀리므로 이 목록에서 보관한 세그먼트의 고정 대상을 계속 볼 수 있습니다.
저장된 필터를 고르면 지금처럼 그 세그먼트의 목록만 보여 줍니다.
작업 공간 목록과 고정 시도 뒤에는 사용량을 "고정한 대상 N/200개 · 저장한 명단 M/20,000행" 형식의 텍스트로 보여 줍니다.
세그먼트별 목록 응답에는 사용량이 없으므로, 고정에 성공했거나 두 한도 가운데 하나로 거절된 뒤 `GET /api/segment-snapshots`를 한 번 더 읽습니다.
`snapshot_limit_reached`와 `snapshot_members_limit_reached` 안내는 한도의 이유(명단이 데이터 내보내기에 함께 담기고 관리자도 지울 수 없음)를 알립니다.
`snapshot_limit_reached` 안내는 고정 대상이 작업 공간 데이터를 삭제할 때만 지워진다고 알리고, `snapshot_members_limit_reached` 안내는 저장한 명단이 계정·이용자·작업 공간 데이터를 삭제할 때만 지워진다고 알립니다.
세션 변경, 작업 공간 재로딩, 세그먼트 선택 변경과 보관은 목록·상세·사용량·진행 중인 요청을 무효화하고 늦은 응답을 무시합니다.
화면은 텍스트로만 값을 쓰고 새 `confirm`·`alert`·`prompt`를 추가하지 않습니다.

## 배포 순서

migration 061을 전체 `deploy/migrate-multi-user.sql` 실행기로 적용한 뒤 코드를 배포합니다.
migration은 두 테이블과 세그먼트 고유 인덱스를 없을 때만 만들고 세 삭제 함수를 교체하므로 다시 실행해도 안전합니다.
실행기는 전체를 한 트랜잭션으로 감싸므로, 아래 잠금은 `supabase-access.sql`까지 끝나 `COMMIT`할 때까지 유지됩니다.

- migration 061은 `instagram_contact_segments`에 고유 인덱스로 `SHARE`, 외래 키로 `SHARE ROW EXCLUSIVE`를 잡습니다. 061부터 `COMMIT`까지 세그먼트 생성·수정·보관은 기다리고, 세그먼트 목록, `GET /api/contacts?segment_id=`, 세그먼트 CSV 같은 읽기는 계속됩니다.
- 고유 제약(`ADD CONSTRAINT ... UNIQUE`)은 `ACCESS EXCLUSIVE`를 잡아 061부터 읽기까지 막으므로 쓰지 않았습니다.
- 그 뒤의 `supabase-access.sql`은 이번 변경과 관계없이 실행할 때마다 모든 제품 테이블에 RLS를 켜고 정책을 다시 만들며 `ACCESS EXCLUSIVE`를 잡습니다. 그 단계부터 `COMMIT`까지는 세그먼트를 포함한 모든 제품 테이블의 읽기도 기다립니다.

2026-10-18 테스트 DB에서 되돌리는 트랜잭션으로 061 전체를 실행한 뒤 `pg_locks`를 읽어 세그먼트 테이블의 잠금이 `AccessShareLock`, `ShareLock`, `ShareRowExclusiveLock`뿐인 것을, `supabase-access.sql`만 실행했을 때는 `AccessExclusiveLock`이 잡히는 것을 확인했습니다.
운영 적용과 배포는 이 PR에서 수행하지 않습니다.
