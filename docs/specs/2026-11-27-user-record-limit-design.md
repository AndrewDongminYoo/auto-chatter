# 사용자 기록 저장량 상한 설계

이슈: [#52](https://github.com/AndrewDongminYoo/auto-chatter/issues/52) (#167에서 넘어온 "메모와 동의 이벤트 같은 추가만 되는 기록의 저장량 총량 상한").
선행 작업: [요금제 권한](2026-10-12-plan-entitlements.md), [API 기본 요청 한도](2026-10-12-api-request-limits.md#요금제별-작업-공간-한도).

## 의도

멤버가 쓰는 추가만 되는 기록은 지금까지 개수 상한 없이 늘었습니다.
작업 공간 쓰기 한도(`api_writes_per_hour`)는 쓰는 속도만 묶고 쌓이는 총량은 묶지 않습니다.
이 설계는 요금제마다 작업 공간이 저장할 수 있는 기록 수의 상한을 둡니다.
운영 DB 적용과 배포는 이 PR의 범위가 아닙니다.

## 상한 값

`src/app/plans.ts`의 `PLANS`에 `user_records_per_workspace`를 더합니다.
같은 값을 아래 기록 종류마다 따로 적용합니다.
이 값은 지금의 집행 값이며 출시 가격의 약속이 아닙니다.

| 키          | `user_records_per_workspace` |
| ----------- | ---------------------------- |
| `free`      | 1,000                        |
| `essential` | 10,000                       |
| `pro`       | 50,000                       |
| `business`  | 150,000                      |
| `advanced`  | 500,000                      |

## 상한을 두는 기록

- 받은 편지함 내부 메모: `addInboxNote`(`src/app/inbox-notes.ts`)가 쓰는 `instagram_inbox_notes` 행.
- 대시보드 API로 기록하는 동의: `POST /api/connections/:connectionId/channel-consent-events`(`recordConsentEvent`, `src/app/channel-consent.ts`)가 쓰는 `channel_consent_events` 행 가운데 새 `grant`.

## 세는 방법

기록 종류마다 그 작업 공간의 행 전체를 셉니다.
메모는 `instagram_inbox_notes`의 `workspace_id` 행 전체, 동의는 `channel_consent_events`의 `workspace_id` 행 전체입니다.

동의는 `grant`와 `revoke`, 데이터 삭제가 남기는 철회 이월 행을 모두 셉니다.
스키마에는 행이 어느 경로에서 왔는지 표시하는 열이 없습니다.
코드에서 이 표에 쓰는 곳은 대시보드 API(`recordChannelConsentEvent`의 유일한 호출자)와 삭제 함수의 철회 이월(`data_deletion_bridge:` 근거, 항상 `revoke`)뿐입니다.
그래서 작업 공간의 모든 행을 세는 것이 저장량을 그대로 나타내며, 출처 열을 더하는 migration이 필요 없습니다.
철회는 거절하지 않으므로 철회로 수가 상한을 넘을 수 있고, 그 뒤에도 새 `grant`만 거절합니다.

삭제 함수(`delete_connection_data`, `delete_person_data`, `delete_workspace_data`)가 지운 행은 더 이상 세지 않습니다.
요금제를 낮춰도 아무것도 지우지 않습니다.
이미 상한을 넘은 작업 공간은 기록을 그대로 두고 새 기록만 거절합니다.

## 거절 규칙

새 기록을 쓰기 전에 작업 공간 행을 잠그고 그 종류의 수를 셉니다.
수가 요금제 값 이상이면 `409 user_record_limit_reached`로 거절하고 아무것도 쓰지 않습니다.
검사는 `requireUserRecordSlot`(`src/app/plans.ts`) 하나가 맡습니다.

동의에서 다음은 상한으로 거절하지 않습니다.

- `revoke`(목적 `all` 포함).
- 이미 저장된 `request_key`의 재요청.
  같은 내용이면 지금처럼 `200`과 `applied: false`를 돌려주고, 다른 내용이면 `409 consent_request_conflict`입니다.
  동의 경로는 INSERT(`ON CONFLICT DO NOTHING`) 뒤에 셉니다.
  행이 실제로 들어갔을 때만 새 행을 뺀 수로 판단하고, 거절하면 트랜잭션을 되돌려 새 행도 남지 않습니다.
  그래서 재요청인지는 충돌 자체가 정하며, 먼저 조회한 뒤 다른 연결의 데이터 삭제가 그 행을 지우는 사이에 검사 없이 새 행이 들어가는 일이 없습니다.
- 대시보드 API가 아닌 호출자.
  `recordChannelConsentEvent`는 `enforceUserRecordLimit: true`를 받을 때만 검사하며, 이 값을 넘기는 곳은 대시보드 API뿐입니다.
  지금은 수집 경로에서 동의를 자동으로 기록하는 TypeScript 호출자가 없고, 삭제 함수의 철회 이월은 SQL 안에서 바로 씁니다.

## 잠금

두 경로 모두 작업 공간 행을 `FOR NO KEY UPDATE`로 잠근 뒤 셉니다.
같은 작업 공간의 두 쓰기는 이 행에서 차례로 지나가므로, 상한 바로 아래에서 동시에 온 두 요청 가운데 하나만 들어갑니다.

`FOR UPDATE`가 아니라 `FOR NO KEY UPDATE`를 씁니다.
`FOR UPDATE`는 `workspaces(id)`를 참조하는 표에 INSERT할 때 잡는 키 공유 잠금과도 충돌합니다.
메모 경로는 작업 공간 다음에 연결 행을 잠그므로, 연결 행을 잡은 채 작업 공간을 참조하는 행을 넣는 트랜잭션과 교착될 수 있습니다.
`FOR NO KEY UPDATE`는 다른 개수 검사 쓰기와 `FOR SHARE`를 기다리게 하면서 키 공유 잠금은 막지 않습니다.
초대 수락과 OAuth 완료가 같은 잠금으로 한도를 셉니다.

- 메모: 기존 잠금 순서(작업 공간, 호출자의 멤버 행, 연결)를 그대로 두고 첫 잠금만 `FOR SHARE`에서 `FOR NO KEY UPDATE`로 올렸습니다.
  같은 작업 공간의 다른 대화 쓰기(`FOR SHARE`)는 메모 쓰기가 끝날 때까지 기다립니다.
- 동의: 새 `grant`일 때만 연결 행 `FOR UPDATE` 앞에 작업 공간 행을 잠급니다.
  작업 공간 다음에 연결을 잠그는 순서는 다른 쓰기와 같습니다.
  `revoke`는 지금처럼 연결 행만 잠급니다.

작업 공간 행을 `FOR SHARE`로 잠그는 다른 경로(`removeMember`, 대화 상태·라벨·리마인더·읽음 쓰기, 직접 답장 예약)는 모두 트랜잭션의 첫 행 잠금으로 작업 공간 행을 잡습니다(2026-11-27에 `src/app/`의 `FROM workspaces ... FOR SHARE`를 모두 확인).
그래서 메모 경로의 더 강한 잠금은 그 경로들을 기다리게 할 뿐 잠금 순서를 뒤집지 않습니다.

## 측정

새 표나 열 없이 쓰기마다 `count(*)`로 셉니다.
판단 기준은 가장 큰 상한(500,000행)에서 따뜻한 캐시로 쓰기 하나에 100 ms 이내입니다.
`advanced`의 작업 공간 쓰기 한도가 시간당 6,000회(초당 약 1.7회)이므로, 이 안이면 작업 공간 행 잠금은 대부분 비어 있습니다.

2026-11-27에 일회용 PostgreSQL 17 클러스터에서 한 작업 공간에 메모 500,000행(다른 작업 공간 200,000행)과 동의 500,000행을 넣고 `EXPLAIN ANALYZE`로 쟀습니다.
측정하는 동안 부하 평균은 코어 10개에서 7~13이었습니다.

| 실행 계획                                                | 메모 500,000행 | 동의 500,000행 |
| -------------------------------------------------------- | -------------- | -------------- |
| 병렬 순차 스캔(플래너 기본 선택)                         | 14~20 ms       | 14~16 ms       |
| 단일 순차 스캔                                           | 34~43 ms       | 28~59 ms       |
| 인덱스 전용 스캔(`VACUUM` 뒤, heap fetch 0), 따뜻한 캐시 | 28 ms          | 27~36 ms       |
| 인덱스 전용 스캔, 세션의 첫 실행                         | 165~275 ms     | 33 ms          |

한 작업 공간이 표의 대부분을 가진 상태라 플래너는 순차 스캔을 골랐습니다.
작업 공간이 많아지면 `workspace_id`로 시작하는 기존 인덱스(메모는 `instagram_inbox_notes_conversation_idx`, 동의는 `(workspace_id,request_key)` 고유 인덱스)의 인덱스 전용 스캔을 씁니다.
인덱스 전용 스캔의 heap fetch 0은 `VACUUM`이 가시성 맵을 채운 뒤의 값이며, 그 전에는 heap을 함께 읽습니다.
메모 인덱스를 세션에서 처음 읽은 실행(165~275 ms)은 기준을 넘지만, 쓰기마다 같은 인덱스를 읽으므로 상한 가까이 쓰는 작업 공간에서는 인덱스가 캐시에 남고 첫 쓰기 한 번만 느립니다.
따뜻한 캐시의 모든 값이 기준 안이므로 트리거로 유지하는 카운터(migration `080_*`)는 만들지 않습니다.
그래서 이 변경은 새 표와 열을 더하지 않고, 삭제 함수, `EXPORTED_TABLES`·`EXCLUDED_TABLES`, `db/schema.sql`, `deploy/migrate-multi-user.sql`에 등록할 것이 없습니다.

## 사용량과 화면

`workspaceEntitlements`의 `usage`에 `user_records`(`inbox_notes`, `consent_events`)를 더하며, `POST /api/workspace`와 `GET /api/workspace/members`가 돌려줍니다.
`limits`에는 `user_records_per_workspace`가 함께 나갑니다.
두 경로는 요청 한도를 쓰지 않습니다(`POST /api/workspace`는 멤버에게 [쓰기 한도의 예외](2026-10-12-api-request-limits.md#한도)이고, GET은 받은 편지함 목록 말고는 한도가 없음).
그래서 이 두 수는 요청 수의 상한 없이 읽히며, 한 번의 비용은 위 [측정](#측정)의 따뜻한 캐시 값(500,000행에서 두 수를 합해 수십 ms)입니다.
이 읽기에 한도를 두는 것은 #167의 예외를 바꾸는 별도의 결정으로 남깁니다.

```json
{
  "limits": { "user_records_per_workspace": 50000 },
  "usage": { "user_records": { "inbox_notes": 1234, "consent_events": 0 } }
}
```

설정의 요금제 카드는 `저장한 메모 1,234/50,000건 · 동의 기록 0/50,000건` 한 줄을 보여 줍니다(`planUserRecords`, `public/app/plan-labels.js`).
수나 상한이 없는 이전 서버의 응답에서는 줄을 숨깁니다.
`user_record_limit_reached`는 `errors` 표의 한국어 문구로 보이며, 메모 입력과 동의 기록이 같은 문구를 씁니다.
메모를 남긴 뒤, 메모가 `user_record_limit_reached`로 거절된 뒤, 연결 데이터 삭제가 성공한 뒤에는 `POST /api/workspace`로 요금제 카드를 다시 읽어, 문구가 가리키는 설정의 수가 지금 수와 같습니다.
이 읽기는 멤버에게 쓰기 한도를 쓰지 않으며, 실패하면 이전 수를 그대로 둡니다.
지금 대시보드에는 동의 이벤트를 기록하는 양식이 없어, 이 API를 부르는 화면이 생기면 같은 표의 문구가 그대로 보입니다.

## 상한을 두지 않는 기록

상태 변경과 함께 쓰는 감사 표(라벨, 담당 전환, 리마인더, 대화 이벤트, 식별자 연결, 캠페인 승인 이벤트, 웹훅 재전송 이벤트)에는 상한을 두지 않습니다.
상한으로 감사 행을 거절하면 그 상태 변경 자체를 막기 때문입니다.
이 표들은 [API 기본 요청 한도](2026-10-12-api-request-limits.md)로만 묶입니다.
AI 예산, 초과 사용 승인, 결제([#54](https://github.com/AndrewDongminYoo/auto-chatter/issues/54))도 이 설계의 범위가 아닙니다.

## 검증

- `src/app/user-record-limit.db.test.ts`: 요금제별 값, 상한에서 메모와 새 `grant`의 `409`와 아무것도 쓰지 않음, 상한의 마지막 자리, 다른 종류와 다른 작업 공간의 영향 없음, 상한에서도 `revoke`·재요청이 통과하고 바뀐 재요청은 `consent_request_conflict`, 대시보드 API가 아닌 호출의 기록이 통과함, 서로 다른 연결에서 상한 바로 아래로 동시에 온 두 쓰기 가운데 하나만 들어감(메모와 동의 각각), 요금제를 낮춘 뒤 기록을 유지하고 새 기록을 거절함, `workspaceEntitlements`와 두 API 응답의 사용량.
- 동시성 테스트는 다른 세션이 두 연결 행을 `FOR UPDATE`로 잡은 채 두 쓰기를 시작합니다.
  작업 공간 잠금이 없으면 두 쓰기가 각자 연결 행에서 기다렸다가 둘 다 상한 아래의 수를 보고 들어가므로 테스트가 실패합니다.
  구현 전 실행에서 두 테스트 모두 `[201, 201]`로 실패했습니다.
- `plans.db.test.ts`, `api.test.ts`: `limits`와 `usage`의 새 키.
- `plan-labels.test.ts`: 목록의 새 키, 요금제 카드 문구, 이전 서버 응답에서 줄을 숨김, 오류 코드의 한국어 문구.
