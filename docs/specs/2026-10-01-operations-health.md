# 운영 지표·경보·지원 진단

## 범위

[이슈 #59](https://github.com/AndrewDongminYoo/auto-chatter/issues/59)의 구현입니다.
작업 공간 관리자는 설정 화면에서 자기 작업 공간 연결의 발송 지표와 경보를 봅니다.
운영자 전용 경로는 없으며, 경보는 화면 경고와 고정 코드 로그 줄로만 남기고 외부로 보내지 않습니다.
지표는 기존 테이블과 `scheduled_steps`를 읽을 때 계산하며, 시계열 저장소는 없습니다.
운영 DB의 migration 030 적용과 배포는 이 범위에 포함하지 않습니다.

## 로그

모든 런타임 로그는 `src/app/operations-log.ts`의 `logOperation`을 거칩니다.
한 항목은 `JSON.stringify`로 만든 JSON 문자열 한 줄이며 `event`, `code`, `correlation_id`, `connection_id`, `step` 다섯 필드만 남깁니다.
그래서 Node 워커와 Compose의 표준 출력에서도 줄 단위 수집기가 한 줄씩 JSON으로 읽을 수 있습니다.
`event`와 `code`는 `^[a-z][a-z0-9_]{0,63}$`, `connection_id`는 UUID, `correlation_id`는 영문·숫자·`-` 64자 이하, `step`은 정해진 단계 이름이어야 하며, 그 밖의 키와 형식이 맞지 않는 값은 버립니다.
그래서 요청 본문, 토큰, 이메일, 댓글·DM 본문, Meta·SQL 오류 원문은 호출자가 실수로 넘겨도 기록되지 않습니다.
실패 코드는 `failureCode`가 오류 클래스와 오류 코드만 보고 정합니다(`not_configured`, `token_refresh_failed`, `database_unavailable`, `database_error`, `connection_unavailable`, `unexpected_error`). 오류 메시지는 읽지 않습니다.
상관 ID는 웹훅·API 요청이면 Cloudflare의 `cf-ray` 헤더(없으면 새 UUID), Queue 메시지 묶음과 Cron 실행마다 새 UUID입니다. Worker는 요청마다 한 번 정한 ID를 `appApi`와 그 요청의 DB 연결 풀에도 넘기므로 풀 오류 줄도 같은 ID를 가집니다.
Node 워커의 `worker-main.ts`·`main.ts`가 터미널에 쓰는 사용법·설정 안내는 운영 로그가 아니므로 바꾸지 않았습니다.

| `event`                         | `code`                                                         | 남기는 곳                               |
| ------------------------------- | -------------------------------------------------------------- | --------------------------------------- |
| `request_failed`                | 실패 코드                                                      | 웹훅·API 요청이 503으로 끝날 때         |
| `queue_publish_failed`          | `reply_notification_failed`·`manual_reply_notification_failed` | DB 커밋 뒤 Queue 발행 실패              |
| `queue_message_failed`          | 실패 코드                                                      | Queue 소비 실패(재시도)                 |
| `database_connection_error`     | `database_unavailable`                                         | 연결 풀 오류                            |
| `early_reply_reconcile_failed`  | 실패 코드                                                      | 발송 직후의 이른 DM 연결 실패           |
| `cron_step_failed`              | 실패 코드                                                      | Cron 단계 실패, `step`에 단계 이름      |
| `cron_run_failed`               | 실패 코드                                                      | Cron의 DB 연결 풀 열기·닫기 실패        |
| `cron_step_record_failed`       | 실패 코드                                                      | 단계 결과 기록 실패, `step`에 단계 이름 |
| `cron_record_failed`            | 실패 코드                                                      | `cron` 행 기록 실패                     |
| `alert_started`·`alert_cleared` | `alert_<경보 이름>`                                            | 경보 상태가 바뀐 Cron 실행              |
| `alert_new_occurrence`          | `alert_unknown_outcome`                                        | 경보가 켜진 동안 새 `unknown` 발생      |
| `webhook_delivery_failed`       | [전달](2026-10-01-flow-webhook-delivery.md#전달)의 실패 코드   | 외부 전송 실패, 다시 시도할 때          |
| `webhook_delivery_dead`         | 같은 실패 코드                                                 | 외부 전송이 `dead`로 끝날 때            |
| `webhook_delivery_claim_lost`   | `claim_lost`                                                   | 외부 전송 시도가 claim을 잃었을 때      |

## 정기 작업 기록

`scheduled_steps`(migration 030)는 이름 하나에 한 행입니다.
Cron 단계 `kept_reply_cleanup`, `token_refresh`, `early_reply_reconcile`, `flow_resume`, `stale_recovery`, `wake`, `webhook_delivery`, `alerts`는 마지막 성공·실패 시각과 고정 실패 코드를 남깁니다.
`cron` 행은 실행한 모든 단계(`alerts` 포함)가 성공한 실행의 시각이며, 한 단계라도 실패하면 실패 코드 `step_failed`를 남깁니다. 그래서 `cron` 행은 `alerts` 단계 뒤에 씁니다. 앞 단계가 모두 성공한 실행은 `alerts` 단계에서 `cron_stale`을 꺼진 것으로 계산하므로, 복구한 실행이 그 실행 안에서 경보를 해제합니다.
`alert_<이름>` 행은 경보가 켜져 있는지와 마지막으로 바뀐 시각을 남깁니다. `alert_unknown_outcome` 행의 `alert_seen_count`는 마지막 평가가 본 `unknown` 결과의 전체 수입니다.
전역 발송이 꺼져 있으면 `stale_recovery`, `wake`, `webhook_delivery`는 실행하지 않고 이전 기록을 그대로 둡니다.
`token_refresh`는 갱신 대상 연결을 모두 시도한 뒤, 토큰 복호화 실패, Meta 호출 실패·시간 초과, 잘못된 갱신 응답, 계정이 다른 프로필이 하나라도 있으면 `token_refresh_failed`로 실패합니다. 더 새 토큰이나 수신 중지에 밀린 갱신은 실패가 아닙니다. 한 연결은 하루에 한 번만 갱신을 시도하므로 계속 실패해도 실패는 시도한 실행에만 남고 다음 실행은 성공으로 기록됩니다. 지속 실패의 신호는 연결마다 하루 한 번 남는 `cron_step_failed`(`step = token_refresh`) 줄이고, 만료 7일 전부터는 `token_expiring` 경보입니다.
한 단계가 실패해도 다음 단계는 계속 실행하고, 실행 끝에 고정 메시지 `Cloudflare scheduled recovery failed`의 오류를 던져 Cloudflare가 실패로 기록하게 합니다. DB 연결 풀을 열거나 닫다 실패해도 원래 오류 메시지는 던지지 않고 `cron_run_failed` 줄과 같은 고정 메시지만 남깁니다. 이전에는 토큰 갱신 실패나 `TOKEN_ENCRYPTION_KEY` 누락이 이후 단계를 모두 멈췄습니다.
기록 쓰기 자체가 실패하면 단계가 성공했어도 `cron_step_record_failed`(`cron` 행이면 `cron_record_failed`) 줄을 남기고 그 실행을 실패로 봅니다. 저장된 결과가 낡았으므로 `cron` 행에도 `step_failed`를 남기며, DB가 중단되면 단계마다 단계 실패 줄과 기록 실패 줄이 함께 남습니다.
단계 결과는 실행 중 메모리에 모았다가 두 문장으로 씁니다.
`alerts` 앞 단계들의 결과를 한 문장으로 쓴 뒤 `alerts` 단계를 실행하므로 이 쓰기의 실패도 `alerts` 단계가 봅니다.
그다음 `alerts`·`cron` 행을 한 문장으로 씁니다([#142](https://github.com/AndrewDongminYoo/auto-chatter/issues/142)).
한 문장이 실패하면 그 실행을 실패로 보고, 저장된 결과가 최신이 되도록 그 행들을 하나씩 다시 씁니다.
실패 뒤에 쓰는 `cron` 행에는 `step_failed`가 남습니다.
하나씩 다시 쓰기도 실패한 행은 그 행의 기록 실패 줄을 남깁니다.
다시 쓰기에서 모든 행이 저장되면, 실패한 문장의 행마다 그 문장의 실패 코드로 기록 실패 줄을 남깁니다.
따라서 기록 쓰기로 실패한 실행에는 기록 실패 줄이 하나 이상 남습니다.
이 테이블에는 작업 공간 데이터가 없으므로 [작업 공간 내보내기](2026-09-30-workspace-export.md)에서 제외하고, 삭제 함수의 대상도 아닙니다.
서버 역할은 SELECT·INSERT·UPDATE만 가지며 DELETE는 없습니다.

## 지표와 API

`GET /api/workspace/health`는 `workspaceFor(..., "admin")`을 통과한 관리자와 소유자만 호출하며, 상담원은 `403 role_forbidden`을 받습니다.
응답은 확인 시각, 전역 발송 여부, 경보 기준, 서비스 전체의 마지막 `cron` 성공 시각과 서비스 경보, 작업 공간 연결별 지표를 담습니다.
연결별 지표는 다음과 같습니다.

- `oldest_due_pending_seconds`(큐 지연): Cron의 wake가 Queue에 넣을 대기 답장 가운데 가장 오래전에 발송 시각이 된 것의 경과 초입니다. 비공개 답장·팔로우 응답·수동 답장을 모두 보며, 조건은 `wakeDueReplies`와 같습니다. 연락처 자동화 중지, 연결 일시 중지, 계정 발송 꺼짐, 유효 토큰 없음으로 묶인 답장은 세지 않고, 일시 중지가 끝난 답장은 중지가 끝난 시각부터 셉니다.
- `longest_sending_seconds`(발송 체류): `sending` 상태로 가장 오래 남은 답장의 claim 이후 경과 초입니다.
- `unknown_24h`, `failed_24h`, `blocked_24h`: 최근 24시간의 결과 수입니다. 행에 결과 확정 시각이 없으므로 마지막 claim 시각, claim하지 않은 행은 생성 시각(팔로우 응답은 확인 시각)으로 근사합니다.
  팔로우 응답도 비공개 답장처럼 `pending`으로 돌아갈 때만 claim 시각을 지우므로 결과 행은 마지막 claim 시각을 유지하며, 이 변경 전에 결과가 된 팔로우 응답은 claim 시각이 없어 확인 시각을 씁니다.
  해결 처리한 수동 답장의 `unknown`은 세지 않습니다.
- `token_expires_in_days`: 토큰 만료까지 남은 일수(내림, 만료되면 음수, 토큰이 없으면 `null`)입니다.
- `send_paused_until`: Meta 발송 제한으로 연결이 일시 중지돼 있으면 그 끝 시각입니다.

응답에는 메시지 본문, 댓글 작성자·DM 수신자 ID, 이메일, 토큰이 없습니다.

## 경보

기준은 서비스 정책이며 `ALERT_THRESHOLDS`(`src/app/operations-health.ts`)가 소유하고 API 응답의 `thresholds`로 화면에 전달합니다.

- `oldest_pending`: 큐 지연이 기준을 넘음. 전역 발송이 꺼져 있으면 대기가 정상이므로 켜지지 않습니다.
- `sending_dwell`: 발송 체류가 기준을 넘음.
- `unknown_outcome`: 최근 24시간에 `unknown` 결과가 있음. 마지막 `unknown`이 24시간 창을 벗어나면 꺼집니다. 이미 켜진 동안 새 `unknown`이 생기면 Cron이 `alert_new_occurrence`를 한 번 더 남깁니다. 결과 행에는 `unknown`이 된 시각이 없으므로, 세 발송 테이블의 `unknown` 전체 수(해결 처리한 수동 답장 포함)가 저장된 `alert_seen_count`보다 커지면 새 발생으로 봅니다. 데이터 삭제로 수가 줄면 기록 없이 낮추며, 같은 Cron 간격 안에 삭제와 새 `unknown`이 함께 생겨 수가 늘지 않으면 그 발생은 따로 기록되지 않습니다.
- `token_expiring`: 수신 중인 연결의 토큰이 기준 일수 안에 만료되거나 이미 만료됨. 토큰 갱신은 만료 30일 전부터 시도하므로 이 경보는 갱신이 계속 실패한다는 뜻입니다.
- `cron_stale`: 마지막 `cron` 성공이 기준 시간보다 오래됨(기록이 없어도 켜짐).

화면은 같은 계산으로 연결별 경보와 서비스 경보를 보여 줍니다.
Cron은 매 실행 끝에 모든 연결의 경보를 합친 서비스 전체 상태를 `scheduled_steps`와 비교하고, 바뀐 경보만 `alert_started`(warn) 또는 `alert_cleared`(info)로 한 번 남깁니다.
경보 평가는 모든 연결의 지표, `cron` 행, `unknown` 전체 수와 저장된 수, 켜진 경보 행을 한 문장으로 읽고, 저장된 상태와 다른 경보만 씁니다.
바뀐 경보가 없는 실행은 이 읽기 하나만 실행합니다.
상태 전환은 조건부 쓰기이므로 겹쳐 실행된 두 Cron 가운데 하나만 기록합니다.
시작과 해제는 그 실행이 지표를 읽기 전(DB 시각)에 바뀐 상태에만 적용되므로, 더 오래된 지표를 읽은 실행이 더 새 실행의 시작이나 해제를 되돌리지 못하고 그 경보는 다음 실행이 판단합니다.
`alert_seen_count`도 `unknown` 전체 수와 같은 문장에서 읽은 값일 때만 바꾸므로, 오래된 수를 읽은 실행이 더 새 수를 낮춰 같은 발생을 두 번 기록하게 하지 못합니다.
Cron이 아예 돌지 않으면 `cron_stale`의 시작은 로그에 남을 수 없고 화면에서만 보이며, 다음 Cron이 성공하면 `alert_cleared`가 남습니다.
DB에 접속할 수 없으면 경보 상태를 읽을 수 없으므로 매 실행의 `cron_step_failed`·`cron_step_record_failed` 줄과 Cron 실패가 신호입니다.

## 화면

설정 화면의 작업 공간 설정 아래 "운영 상태" 영역에 서비스 경보, 마지막 정기 작업 성공 시각, 연결별 경보 배지와 지표를 보여 주며 "다시 확인"으로 다시 불러옵니다.
API가 상담원을 거부하므로 상담원에게는 영역을 숨기고 요청도 보내지 않습니다.
확인 기록은 [화면 검증](../notes/2026-10-01-operations-health-ui-verification.md)에 있습니다.

## 검증

로컬 테스트가 확인하는 범위입니다.

- 로그 단위 테스트: 허용하지 않은 키, 형식이 맞지 않는 허용 키 값, 오류 메시지 기반 코드가 버려집니다.
- Cloudflare DB 테스트(`worker.db.test.ts`): Queue 발행 실패 뒤 Cron 복구, Cron 단계의 DB 실패(실패 기록, `alert_cron_stale` 한 번, 다른 단계 계속, 복구 후 해제 한 번), `alerts` 단계 실패가 `cron` 행을 실패로 남김, 풀 닫기 실패가 원래 오류 메시지를 내보내지 않음, Meta 발송 제한(health의 일시 중지 표시, 로그 없음). 이 파일의 모든 테스트가 콘솔 호출을 가로채고, 각 호출이 허용 필드만 가진 객체 하나인지 `afterEach`에서 확인합니다. workerd 테스트는 별도 프로세스라 이 확인 밖입니다.
- DB 테스트(`operations-health.db.test.ts`): 관리자 지표·경보 계산, 상담원 거부, 응답의 비밀·본문·ID 부재, 경보 전환 한 번 기록, 켜진 경보의 새 `unknown` 한 번 기록, `cf-ray`가 없는 API 요청의 UUID 상관 ID(풀에도 같은 ID).
- 권한 테스트(`access.db.test.ts`)와 workerd 테스트(`runtime.db.test.mjs`): 서버 역할의 upsert 허용과 DELETE 차단, API 역할 차단, 제한된 서버 역할로 실행한 Cron의 단계 기록.

운영 Workers Logs의 실제 기록·검색과 운영 데이터의 경보는 확인하지 않았습니다.
migration 030은 2026-10-02 운영 DB에 적용했지만([운영 적용 기록](../notes/2026-09-26-cloudflare-runbook.md)), 이 계약을 포함한 Worker는 2026-10-02 `main` 커밋 `2e45865`로 배포했으며, 운영 데이터의 경보와 Workers Logs 검색은 아직 확인하지 않았습니다.
