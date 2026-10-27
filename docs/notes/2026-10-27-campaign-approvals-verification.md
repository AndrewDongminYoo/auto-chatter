# 캠페인 실행 승인 기록 검증

## 범위와 기준

[승인된 계약](../specs/2026-10-21-campaign-drafts.md#실행-승인)의 관리자 전용 실행 승인 API와 migration 064(`campaign_approvals`, `campaign_approval_events`)를 구현했습니다.
기준 HEAD는 `9b184fc`이며 아래 로컬 검사는 커밋 전 작업 변경을 대상으로 수행했습니다.
화면·템플릿 치환·발송·outbox 생성·cron 단계·요금제 한도는 포함하지 않습니다.
의존성 변경은 없습니다.
운영 DB·실계정·공급자 호출은 사용하지 않았습니다.
이 검증은 [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35) 전체의 완료나 운영 적용을 뜻하지 않습니다.

## 검사와 읽는 대상

DB 검사는 `src/app/campaign-approvals.db.test.ts`이며 실제 API(`appApi`)와 이 PR용으로 만든 일회용 PostgreSQL 17 클러스터(포트 5441)를 사용합니다.
예약 문장의 `clock_timestamp()`와 미리보기 문장의 `statement_timestamp()`는 각각 한 번만 나오며, 테스트 pool이 그 하나를 고정 시각으로 바꿉니다.

- 권한: `agent`는 다섯 경로 모두 403이며 UUID 형식이 아닌 ID도 403입니다. 제거된 관리자는 403입니다.
- ID와 본문: 다른 작업 공간·없는 ID·UUID 형식이 아닌 ID는 초안과 승인 모두 같은 404입니다. 추가 키, 빠진 키, 잘못된 버전·시각·시간대, 쿼리 문자열은 400입니다. 모든 응답은 `no-store`입니다.
- 같은 작업 공간: 다른 작업 공간의 초안이나 고정 대상을 가리키는 행은 복합 외래 키로 `23503`입니다. 예약 짝과 취소 열 CHECK는 `23514`, 초안당 두 번째 유효 승인은 `23505`입니다.
- 재시도: 대문자 ID로 만든 뒤 취소하고 같은 요청을 다시 보내면 200과 취소된 현재 상태(버전 2)입니다. 같은 ID의 다른 시간대·버전·초안은 409이고, 같은 요청 두 개를 동시에 보내면 201 하나와 200 하나, 행 하나입니다.
- 버전과 동시성: 수정된 초안의 이전 버전 승인과 보관된 초안 승인은 `campaign_draft_conflict`이고, 응답의 `draft`는 같은 시점의 `GET /api/campaign-drafts/:id`와 같으며 승인 행이 생기지 않습니다. 다른 ID 두 개의 동시 승인은 201 하나와 `approval_exists` 하나이며, 409 응답의 `approval`은 만들어진 승인이고 이후 재요청의 `approval`은 그 승인의 `GET` 응답과 같습니다. 예약 변경·취소의 이전 버전은 `campaign_approval_conflict`와 현재 상태이고, 취소된 승인의 재취소·예약 변경은 `campaign_approval_cancelled`와 현재 상태입니다.
- 초안 고정: 승인 중 초안 수정·보관은 `approval_active`입니다. 취소, 수정, 재승인 뒤 새 승인은 버전 2의 사본을 갖고 이전 승인은 처음 사본을 유지합니다. 작업 공간 행을 잡은 연결 뒤에 두 요청을 차례로 대기시켜 수정과 보관 각각 두 순서를 모두 확인했습니다: 승인이 먼저면 수정·보관이 `approval_active`이고 초안은 버전 1·보관 안 됨 그대로이며, 수정·보관이 먼저면 승인이 `campaign_draft_conflict`이고 승인 행이 없습니다.
- 예약 범위: 고정 시각 기준 1분 뒤 정확히는 접수, 1마이크로초 모자라면 400이며 생성과 예약 변경 모두 확인했습니다. 과거·현재 시각은 400입니다. 고정 상한이 없으므로 30일 뒤 생성과 1년 뒤 예약 변경이 접수됩니다.
- 시간대: 기대 시간대가 다르면 즉시 승인과 예약 모두 409입니다. `America/New_York`의 봄 공백 `2026-03-08T02:30`은 `07:30Z`(벽시계 03:30), 가을 겹침 `2026-11-01T01:30`은 나중 시점 `06:30Z`입니다. 작업 공간 시간대를 `Asia/Seoul`로 바꾼 뒤에도 저장된 시각·시간대는 그대로이고, 이전 기대 시간대의 변경은 409입니다.
- 미리보기: 같은 고정 시각에서 미리보기 API와 저장된 미리보기(`as_of`, 원래·남은 수, 일곱 사유)가 같습니다. 이후 명단 행을 지우면 실시간 미리보기만 줄고 저장값은 승인 시점 그대로입니다.
- 쓰기 없음: fixture 작업 공간에서 승인 생성·예약 변경·취소 전후로 `private_reply_outbox`, `instagram_manual_replies`, `channel_consent_events`, `channel_consent_state`, `instagram_segment_snapshots`, `instagram_segment_snapshot_members`, `webhook_deliveries`의 행 수와 내용 해시가 같고, 각 테이블에 fixture 행이 있는지 먼저 확인합니다.
- 삭제와 이동: 개인·연결 삭제 뒤 두 테이블의 내용 해시가 같습니다. 작업 공간 삭제는 두 테이블을 지우고 삭제 수를 기록합니다. 내보내기는 두 테이블을 포함하고 `create_request_hash`를 제외합니다. 승인 행만, 감사 행만 있는 작업 공간은 초대 수락과 `deploy/assign-workspace-owner.sql` 모두에서 이동이 거절됩니다.
- migration: 064를 두 번 다시 적용해도 승인이 유지되고 `delete_workspace_data` 정의가 `db/schema.sql`과 같습니다. 이전 migration 재적용 검사들은 064를 마지막에 함께 적용합니다.

기존 검사도 새 테이블을 읽습니다.
`workspace-fixture.ts`가 승인과 감사 행을 넣으므로 내보내기·작업 공간 삭제 검사가 두 테이블을 포함합니다.
`src/cloudflare/access.db.test.ts`는 세 역할 설정 모두에서 두 테이블의 DELETE와 감사 테이블의 UPDATE를 거절하고 API 역할의 SELECT를 거절하는지 봅니다.
`src/cloudflare/runtime.db.test.mjs`는 제한된 서버 역할로 workerd에서 승인 생성, 승인 중 초안 수정 409, 예약 변경, 취소를 실행하고 감사 행 3개와 `agent` 403을 확인합니다.

검사가 실제로 실패할 수 있는지 확인하려고 초안 수정의 `approval_active` 거절을 지우고 `SCHEDULE_MIN_AHEAD`를 59초로 바꿨을 때 초안 고정·두 순서 경합·예약 범위 검사 세 개가 실패했습니다.
따로 24시간 상한을 넣었을 때는 예약 범위 검사 하나가 실패했습니다.
원래대로 되돌린 뒤 16개 모두 통과했습니다.

## 실행 결과

```log
corepack pnpm check-types                                   exit 0
corepack pnpm test                                          exit 0  tests 434 pass 434 fail 0
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5441/automations_test corepack pnpm test:db          exit 0  tests 770 pass 770 fail 0
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5441/automations_test corepack pnpm test:cloudflare  exit 0  tests 80 pass 80 fail 0
```

## 검증하지 않은 것

로컬 DB와 workerd 검사는 운영 migration 상태, 배포된 Worker 동작, 실계정 권한, 실제 발송을 증명하지 않습니다.
`scheduled_at`에 도달해도 바뀌는 것이 없다는 점은 그 시각을 읽는 코드가 없다는 구현 사실이며, cron을 실제 시각까지 실행해 확인하지는 않았습니다.
상담 예약 답장의 상한인 수신자별 답장 창은 승인에 적용하지 않으며, #36이 발송 시점에 적용해야 합니다. 캠페인 단위 예약 상한을 둘지는 운영자가 정할 후속 결정입니다.
기존 초안 편집기는 `409 approval_active`에 전용 안내가 없어 일반 오류 문구를 보이며, 이는 다음 화면 PR에서 다룹니다.
저장된 미리보기의 `candidate` 수는 승인 시점에 기록된 조건의 통과 수이며 발송 가능 인원이 아닙니다.
