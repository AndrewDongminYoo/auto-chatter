# 캠페인 실행과 수신자별 발송 행 검증

## 범위와 기준

[캠페인 실행 계약](../specs/2026-10-27-campaign-runs.md)의 PR ①을 구현했습니다: migration 065(`campaign_runs`, `campaign_deliveries`, 승인의 `executed` 상태), `campaign_start` cron 단계, 실행 조회·취소 API, Cloudflare OAuth 표면의 마케팅 capability 지원입니다.
기준 HEAD는 `bb089a1`이며 아래 로컬 검사는 커밋 전 작업 변경을 대상으로 수행했습니다.
발송 worker(PR ②), 실행 화면(PR ③), 템플릿, 일일 상한은 포함하지 않습니다.
의존성 변경은 없습니다.
운영 DB·실계정·공급자 호출은 사용하지 않았습니다.
이 검증은 [#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36)이나 [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35)의 완료나 운영 적용을 뜻하지 않습니다(Refs #36).

## 검사와 읽는 대상

DB 검사는 `src/app/campaign-runs.db.test.ts`(16개)이며 실제 API(`appApi`), `startDueCampaignRuns`, 이 PR용 일회용 PostgreSQL 17 클러스터(포트 5445)를 사용합니다.
두 트랜잭션의 순서는 테스트 pool이 지정한 문장 직후 트랜잭션 안에서 멈추게 하고, 다른 쪽이 `pg_stat_activity`에서 잠금 대기에 들어간 것을 확인한 뒤 풀어서 정합니다.

- 기한: 즉시 승인과 예약 시각이 지난 승인만 시작합니다. 미래 예약, 취소된 승인, 이미 실행된 승인은 시작하지 않습니다. 실행마다 후보 한 명에 `pending` 행 하나이며, 두 번째 단계는 아무것도 시작하지 않습니다.
- 상한과 순서: 기한이 다른 승인 네 개에서 `limit` 2는 가장 오래된 두 개(즉시 승인의 마지막 일정 쓰기 시각과 예약 시각을 함께 비교)를 시작하고, 다음 `limit` 1은 그다음 하나를 시작합니다.
- 실패 격리: 초안 버전이 승인과 다른 승인 하나는 고정 코드 `campaign_start_failed`/`unexpected_error`와 correlation ID만 기록하고 승인 상태 그대로 남으며, 뒤의 승인은 시작합니다. 단계는 `CampaignStartFailedError`로 실패합니다.
- 실패 순환: 가장 오래된 두 승인이 실패하면 `limit` 2의 첫 단계는 두 승인에 `start_failed_at`을 남기고 세 번째 승인을 시작하지 않습니다. 다음 단계는 실패한 적 없는 세 번째 승인을 시작하고, 실패한 둘 중 마지막 실패가 오래된 쪽만 다시 시도합니다.
- 작업 공간 단위 고유성: 두 작업 공간이 같은 승인 ID를 가지면 한 단계에서 각자 실행을 시작합니다.
- 멱등성: 두 단계를 동시에 실행하면 실행 하나와 대상당 행 하나입니다. 같은 대상의 두 번째 행은 `campaign_deliveries_member`, 같은 승인의 두 번째 실행은 `campaign_runs_approval`로 `23505`입니다.
- 승인 변경과의 경합: 취소와 예약 변경이 먼저면 시작은 작업 공간 잠금을 기다린 뒤 건너뛰고 실행이 없습니다. 시작이 먼저면 취소와 예약 변경이 기다린 뒤 `409 campaign_approval_executed`와 `run_id`가 채워진 현재 승인을 받습니다. 네 경우를 모두 확인했습니다.
- 재평가: 승인 뒤 한 수신자가 마케팅 수신을 거부하고 다른 대상이 일시 중지되면, 실행의 시작 수는 `opted_out` 1·`contact_paused` 1·`candidate` 0이고 행이 없으며, 승인의 저장된 미리보기는 `candidate` 2 그대로입니다.
- 수신자 선택과 수: 확인된 수신자 셋 중 마케팅 동의가 있는 둘은 3시간 전과 2시간 전에, 동의가 없는 하나는 10분 전에 DM을 보낸 대상에게는 2시간 전 수신자가 선택됩니다. 네 대상(후보 둘, DM 식별자 없음 하나, 창 닫힘 하나)에서 `candidate` 2와 행 2개가 같고, `started_at`은 평가 시각입니다.
- 취소와 조회: `agent`는 조회·취소 모두 403입니다. 조회는 `running`, 시작 수, 일곱 상태의 행 수를 돌려주며 응답에 댓글 작성자·DM 수신자 ID가 없습니다. 승인 상세와 목록에 `run_id`·`run_status`가 있습니다. 잘못된 본문은 400, 이전 버전은 `campaign_run_conflict`, 취소는 `pending` 두 행을 `cancelled`로 바꾸고 테스트가 넣은 `sending` 행은 그대로 둡니다(`cancelled_delivery_count` "2", `sending_recalled: false`). 재취소는 `campaign_run_cancelled`, 완료된 실행은 `campaign_run_completed`, 없는 ID·UUID 형식이 아닌 ID·다른 작업 공간은 404, 쿼리 문자열은 400입니다. 모든 응답은 `no-store`입니다.
- 실행된 승인: 예약 변경과 취소가 `campaign_approval_executed`이고 승인은 `executed`로 남습니다. 승인의 버전은 1, 감사 행은 1개 그대로입니다. 초안은 더 이상 고정되지 않아 수정됩니다.
- 쓰기 없음: 시작과 취소 전후로 `private_reply_outbox`, `instagram_manual_replies`, `instagram_follow_conversations`, `channel_consent_events`, `channel_consent_state`, `webhook_deliveries`의 내용 해시가 같습니다.
- 삭제: 개인 삭제는 댓글 작성자 기준과 DM 수신자 기준으로 각각 해당 행 하나를 지우고, 그 대상 행이 `sending`이거나 다른 트랜잭션이 그 행을 잡고 있으면(`NOWAIT`) `sending_in_progress`입니다. 연결 삭제는 `sending` 행이 있거나 다른 트랜잭션이 행을 잡고 있으면(`NOWAIT`) `sending_in_progress`이고, 아니면 행을 지우고 실행을 남깁니다. 작업 공간 삭제는 `sending`이면 거절하고, 아니면 행·실행·승인을 지우고 삭제 수를 기록합니다.
- 연결 잠금: 평가 직후 멈춘 시작이 있는 동안 개인 삭제는 연결 잠금을 기다리고, 시작이 커밋한 뒤 그 행을 지웁니다.
- 내보내기와 이동: 내보내기는 두 테이블을 포함합니다. 실행 행만, 발송 행만 있는 작업 공간은 초대 수락과 `deploy/assign-workspace-owner.sql` 모두에서 이동이 거절됩니다.
- CHECK: 시도 열 없는 `sending`, 시도 열 있는 `pending`, 공급자 ID 없는 `sent`, 실패 코드 없는 `failed`, `sent` 아닌 행의 공급자 ID, 숫자가 아닌 수신자 ID는 `23514`, 다른 작업 공간의 연결은 `23503`입니다.
- migration: 065를 두 번 다시 적용해도 실행·행·승인 상태가 유지되고 세 삭제 함수 정의가 `db/schema.sql`과 같습니다. 실행된 승인에 취소 열을 채우면 `23514`입니다. 실행기에서 065는 064 뒤, 접근 스크립트 앞입니다. 이전 migration 재적용 검사들은 065를 마지막에 함께 적용합니다.

기존 검사도 새 동작을 읽습니다.

- `src/cloudflare/worker.db.test.ts`: `SEND_ENABLED`가 거짓이면 cron 뒤에도 승인이 `approved`이고 실행과 `campaign_start` 기록이 없습니다. 참이면 승인이 `executed`, 실행 하나, 단계 성공 기록이 생기고 발송 호출은 0입니다. 단계 목록 두 곳에 `campaign_start`가 추가되었습니다.
- `src/cloudflare/runtime.db.test.mjs`: workerd에서 제한된 서버 역할로 cron이 후보 한 명의 실행을 시작합니다(잠금, 실행·`pending` 행 쓰기, 승인 `executed`). 같은 역할로 실행 조회와 취소가 200이고 `agent` 조회는 403입니다.
- `src/cloudflare/access.db.test.ts`: 세 역할 설정 모두에서 두 테이블의 DELETE를 거절하고 API 역할의 SELECT를 거절합니다.
- `src/app/campaign-draft-preview.db.test.ts`: 기존 미리보기 검사는 바꾸지 않고 통과하며, `channel_marketing_supported`만 참으로 바뀌었습니다. `src/instagram/channel-adapter.test.ts`는 `cloudflare_oauth`에서만 마케팅 텍스트가 지원이고 첨부는 미지원인지 봅니다.
- `src/app/campaign-drafts.test.ts`: 관리 화면이 `campaign_approval_executed` 충돌의 실행된 승인을 오류 없이 표시하고 초안 잠금을 풉니다.
- `workspace-fixture.ts`가 실행된 승인·실행·행을 넣으므로 내보내기·작업 공간 삭제 검사가 두 테이블을 포함합니다.

검사가 실제로 실패할 수 있는지 확인하려고 구현을 하나씩 바꿔 `campaign-runs.db.test.ts`를 실행했습니다.

- 잠근 뒤의 기한 재확인을 지우면 경합 검사와 동시 시작 검사가 실패했습니다.
- 취소의 `status='pending'` 조건을 지우면 취소 검사가 실패했습니다.
- 수신자 선택을 오래된 DM 순으로 바꾸면 수신자 선택 검사가 실패했습니다.
- 연결 `FOR SHARE`를 지우면 연결 잠금 검사가 `no transaction waited for a lock`으로 실패했습니다.
  같은 변형에서 경합 검사의 시작 우선 경우는 처음에 시간 제한 없이 멈췄습니다(`test:db`에는 테스트별 시간 제한이 없습니다). 그래서 테스트 pool의 대기 지점이 10초 안에 해당 문장을 만나지 못하면 실패하게 바꿨고, 다시 실행한 같은 변형은 10.2초 만에 `no query matched /FOR SHARE/ within 10000 ms`로 실패했습니다.
- 실패 순서(`start_failed_at NULLS FIRST`)를 지우면 실패 순환 검사가 실패했습니다.
- 테스트 DB의 `campaign_runs_approval`을 `UNIQUE(approval_id)`로 되돌리면 작업 공간 단위 고유성 검사가 실패했습니다.
- 개인 삭제의 발송 행 잠금에서 `NOWAIT`를 지우면 삭제 검사가 10초 뒤 `the person deletion waited for the held row`로 실패했습니다.

원래대로 되돌린 뒤 14개 모두 통과했습니다.

## 실행 결과

```log
corepack pnpm check-types                                                                            exit 0
corepack pnpm test                                                                                   exit 0  tests 479 pass 479 fail 0
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5445/automations_test corepack pnpm test:db          exit 0  tests 784 pass 784 fail 0
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5445/automations_test corepack pnpm test:cloudflare  exit 0  tests 81 pass 81 fail 0
```

## 검증하지 않은 것

로컬 DB와 workerd 검사는 운영 migration 상태, 배포된 Worker 동작, 실계정 권한, 실제 발송을 증명하지 않습니다.
Meta 정책 내용은 승인된 계획의 기록을 인용했으며, 이 작업 중 Meta 문서를 다시 열어 확인하지 않았습니다.
`campaign_start`는 운영에서 `SEND_ENABLED`가 거짓인 동안 실행되지 않습니다.
작업 공간 내보내기의 50,000행 한도와 쌓이는 발송 행의 관계는 계약의 알려진 한계에 적었고, 큰 실행 여러 번으로 한도에 닿는 상황은 실행해 보지 않았습니다.
`candidate`와 `pending` 행은 시작 시점에 기록된 조건을 통과했다는 뜻이며 발송할 수 있다는 뜻이 아닙니다.
