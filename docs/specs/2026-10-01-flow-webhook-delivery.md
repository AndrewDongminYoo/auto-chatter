# 플로 외부 전송(서명된 outbound webhook)

## 범위

[이슈 #47](https://github.com/AndrewDongminYoo/auto-chatter/issues/47)의 서버 구현입니다.
관리자가 등록한 HTTPS 주소로, 플로의 `webhook` 노드가 지정한 항목만 서명해서 보냅니다.
범위는 플로 노드 하나입니다. 연락처 이벤트 webhook, 외부에서 들어오는 요청, 응답을 플로에서 쓰는 기능은 없습니다.
응답은 결과(HTTP 상태 코드와 고정 실패 코드)만 기록하고 본문은 저장하지 않습니다.
서버 구현과 함께 들어간 화면 변경은 연결 삭제 기록에 새 삭제 건수 두 항목의 이름을 붙인 것뿐이며, 관리자 설정 화면은 후속 PR에서 [설정 화면](#설정-화면)으로 추가했습니다.
운영 DB의 migration 031 적용, 배포, 실제 외부 전송은 이 범위에 포함하지 않습니다.

## 데이터

migration 031(`db/migrations/031_flow_webhooks.sql`)이 네 테이블을 추가합니다.
서버 역할은 네 테이블 모두 DELETE 권한이 없고, 감사 테이블은 UPDATE 권한도 없습니다.

- `webhook_endpoints`: 작업 공간별 전송 주소입니다. 이름, `https://`로 시작하는 URL, 활성 여부, 생성·수정 시각을 가집니다. 작업 공간의 활성 주소는 `MAX_ACTIVE_WEBHOOK_ENDPOINTS`(`src/app/webhooks.ts`)개까지이며, 작업 공간 행을 잠근 뒤 세므로 동시에 만들어도 넘지 않습니다.
- `webhook_signing_keys`: 주소의 서명 키입니다. 키 ID, `sealSecret`으로 봉인한 비밀, `created_at`, `retired_at`을 가집니다. 봉인 문맥은 작업 공간·주소·키 ID(`signingKeyContext`)이므로 다른 주소나 다른 키의 봉인값으로는 열리지 않습니다. `slot`(1 또는 2)의 부분 유일 인덱스가 폐기하지 않은 키를 주소당 두 개로 제한합니다. 키를 폐기하면 봉인한 비밀도 지웁니다.
- `webhook_deliveries`: 전송 outbox입니다. `event_id`(UUID, 기본 키), 작업 공간, 주소, 연결, 플로, 플로 실행, 노드 ID, 댓글 작성자 ID, `payload`, 상태(`pending`·`sending`·`sent`·`retry`·`dead`), 시도 횟수, 시도 ID, `next_attempt_at`, 마지막 HTTP 상태 코드, 고정 실패 코드, 시각을 가집니다. `(flow_run_id, node_id)`가 유일하므로 한 실행의 한 노드는 전송 하나만 만듭니다. 댓글 작성자 ID는 이용자 단위 삭제가 행을 찾는 데만 쓰며 전송하지 않습니다.
- `webhook_redelivery_events`: 수동 재전송의 추가 전용 감사 기록입니다. 요청한 사용자 ID, 전송, 시각을 가집니다.

`payload`는 요청 본문 그대로이며, 전송이 `sent`가 되는 같은 UPDATE에서 지웁니다(CHECK 제약이 `sent`와 `payload IS NULL`을 묶습니다).
`dead`로 끝난 전송의 `payload`는 수동 재전송에 필요하므로 삭제 함수가 지울 때까지 남습니다.

## 플로 노드

`webhook` 노드의 config는 `{endpoint_id, field_ids, include_tags}`이고 포트는 `next` 하나입니다.
`field_ids`는 중복 없는 UUID 배열이며 `MAX_WEBHOOK_FIELDS`(`src/app/flow-schema.ts`)개까지입니다.

- 초안 저장은 문서 형태만 확인합니다.
- 발행은 주소가 같은 작업 공간의 활성 주소인지(`endpoint_unavailable`), 각 필드가 있고 보관되지 않았는지(`unknown_field`) 확인합니다. 발행 뒤에 주소를 끄는 것은 막지 않으며, 그때의 전송은 아래처럼 `dead`로 끝납니다.
- 발행은 응답 저장 필드를 보내는 노드를 거부합니다(`reply_field_not_sendable`). 자세한 규칙은 [응답 저장 필드](#응답-저장-필드)에 있습니다.
- 발행된 버전의 `field_ids`에 이 노드의 필드도 들어가므로, 기존 `field_in_use` 보관 차단이 그대로 적용됩니다.
- 노드는 답장 가능 시간 합계에 시간을 더하지 않습니다. 메시지 뒤에는 여전히 `wait_for_reply`만 올 수 있습니다.

실행이 노드에 도달하면 그 실행의 트랜잭션(댓글 수집, 지연·시각 대기 재개, 응답 대기 재개 모두)이 전송 행을 넣고 기다리지 않고 `next`로 갑니다.
`payload`는 그 시점의 연락처 사실로 만듭니다. 앞선 태그·필드 액션의 결과가 반영되고, 뒤 노드가 실패해도 이미 도달한 노드의 전송은 남습니다.
`flow_step_runs`에는 `queued`를 남기고, 주소가 작업 공간에 없어 행을 넣지 못하면 `not_queued`를 남깁니다.
전송의 성공·실패는 실행 상태, 뒤 노드, 비공개·팔로우·수동 답장 행을 바꾸지 않습니다.

## 전송 내용

관리자가 고른 항목만 보냅니다.

```json
{
  "event_id": "2f0c3c1e-6c0a-4c53-9a53-0d6f3c0f4f6e",
  "type": "flow.webhook",
  "created_at": "2026-10-01T03:00:00.000Z",
  "flow_id": "7d0f6a52-5d2a-4b0e-8a39-0a4b0b1d2c3e",
  "flow_version": 3,
  "run_id": "b1f5c2d4-3c1a-4e7b-9d2e-5f6a7b8c9d0e",
  "node_id": "notify",
  "tags": ["vip"],
  "fields": { "8d7c6b5a-4e3f-4a2b-9c1d-0e9f8a7b6c5d": "Seoul" }
}
```

- `tags`는 `include_tags`가 `true`일 때만 있습니다.
- `fields`는 고른 필드 ID가 키이고, 값이 없는 필드는 `null`입니다.
- 처리 식별자는 이벤트 ID, 플로 ID, 플로 버전 번호, 실행 ID, 노드 ID, 생성 시각입니다.
- 댓글 본문, DM 본문, 사용자 이름, Instagram 식별자(댓글 작성자 ID, DM 수신자 ID, 계정 ID, 미디어 ID, 댓글 ID)는 넣지 않습니다.

### 응답 저장 필드

`wait_for_reply`의 `save_field_id`는 응답 DM 본문을 필드에 저장합니다([응답 대기](2026-09-30-flow-runs.md#응답-대기)).
그 필드를 `webhook` 노드가 보내면 DM 본문이 나가므로, 작업 공간의 발행된 버전 가운데 하나라도 응답을 저장하는 필드(응답 저장 필드)는 보내지 않습니다.
현재 버전이 아니거나 보관한 플로의 버전도 셉니다. 버전은 바뀌지 않고, 그 버전이 저장한 응답이 필드에 남아 있을 수 있기 때문입니다.
그래서 한 번 응답 저장 필드가 된 필드는 계속 보낼 수 없습니다.

- 발행은 `webhook` 노드의 `field_ids`에 응답 저장 필드가 있으면 그 노드를 `reply_field_not_sendable`로 거부합니다. 같은 초안의 `wait_for_reply`가 저장하는 필드도 포함하며, 노드가 그래프의 어디에 있는지는 보지 않습니다.
- 반대로, 다른 플로의 현재 발행 버전이 `webhook` 노드로 보내는 필드를 `save_field_id`로 지정한 초안도 그 `wait_for_reply` 노드를 `reply_field_not_sendable`로 거부합니다.
- 실행은 발행 검사와 별개로, `webhook` 노드에 도달할 때마다 응답 저장 필드를 `fields`에서 뺍니다(`planFlowRun`). 키 자체가 없으며 `null`로 보내지 않습니다. 단계 기록은 그대로 `queued`입니다.

발행 검사는 잠금 없이 읽으므로 두 발행이 동시에 통과할 수 있고, 이전 버전에 고정된 채 대기 중인 실행도 있습니다.
이런 경우에도 실행 시점의 제외가 적용되므로 DM 본문은 나가지 않습니다.
실행은 연락처 값을 읽은 뒤에 응답 저장 필드를 조회합니다. 응답을 저장한 버전은 그 응답보다 먼저 발행되었으므로, 저장된 응답을 읽은 실행은 그 버전도 봅니다.
관리자가 화면이나 API로 직접 입력한 필드 값은 이 규칙의 대상이 아닙니다.

## 전달

전달은 Cloudflare Worker의 Cron 단계 `webhook_delivery`만 합니다(`deliverDueWebhooks`, `src/app/webhook-delivery.ts`).
Node 워커는 전송하지 않으므로, Cloudflare Cron 없이 운영하는 Compose 배포에서는 전송 행이 `pending`으로 남습니다.
이 단계는 메시지 관련 단계(`stale_recovery`, `wake`) 뒤에 실행하고 결과를 [`scheduled_steps`](2026-10-01-operations-health.md#정기-작업-기록)에 남깁니다.
전역 발송 스위치(`SEND_ENABLED`)가 꺼져 있으면 실행하지 않으므로, 그동안에는 아무것도 나가지 않습니다.
이 결합은 이슈의 계획에 없던 구현 선택이며 운영자 확인이 필요합니다. 스위치가 꺼진 동안 외부로 나가는 것이 없도록 보수적으로 골랐습니다.
그 결과는 메시지 발송 행과 같습니다. 꺼진 동안에도 플로는 실행되어 `pending` 전송이 `payload`와 함께 쌓이고, 스위치를 켜면 실행당 한도 안에서 오래된 것부터 나갑니다.
오래된 `sending` 복구도 이 단계 안에 있으므로, 꺼지기 직전에 중단된 전송이 `sending`으로 남아 있으면 스위치를 다시 켤 때까지 삭제 함수가 `sending_in_progress`로 거부합니다.
주소 하나의 실패는 전송 행의 결과일 뿐 단계 실패가 아니며, 단계가 DB 오류로 실패해도 앞 단계는 이미 끝난 뒤입니다.

한 전송의 시도 순서입니다.

1. `FOR UPDATE SKIP LOCKED`로 기한이 된 `pending`·`retry` 행 하나를 `sending`으로 바꾸고 새 시도 ID를 줍니다. 이후의 상태 변경은 `status = 'sending'`과 그 시도 ID가 조건이므로, 겹친 실행이 서로의 시도를 끝내지 못합니다.
2. 주소를 다시 읽습니다. 꺼져 있으면 요청 없이 `dead`(`endpoint_inactive`)로 끝냅니다.
3. URL을 다시 검사합니다. `https:`이고 포트가 443이어야 하며, 사용자 정보, IP 리터럴 호스트, `localhost`, `.localhost`·`.local`·`.internal` 아래 이름은 거부합니다(`url_refused`).
4. 폐기하지 않은 키의 비밀을 열어 서명을 만듭니다. 열 수 없으면 보내지 않습니다(`signing_unavailable`).
5. 요청 직전에 DNS-over-HTTPS로 A와 AAAA를 조회합니다. 조회 실패(`dns_failed`), 주소 없음(`dns_no_address`), 주소 가운데 하나라도 loopback·사설·link-local·CGNAT·multicast·미지정·예약 대역이거나 그 대역의 IPv4-mapped·NAT64 표현이면(`address_refused`) 보내지 않습니다. 시도마다 다시 조회하므로, 생성 때 통과한 이름이 나중에 사설 주소를 가리키면 거부합니다.
6. `POST`를 `redirect: "manual"`로 보냅니다. 헤더는 `content-type: application/json`, 고정 `user-agent`, 아래 두 서명 헤더입니다. 제한 시간 10초는 응답 본문 읽기까지 포함하고(`timeout`), 응답은 64 KB까지만 읽고 버립니다.
7. 2xx이면 `sent`입니다. 3xx는 따라가지 않고 실패(`redirect_refused`)이며, 그 밖의 상태(`http_error`)와 연결 오류(`request_failed`)도 실패입니다.

실패한 전송은 1분, 5분, 30분, 2시간, 6시간 뒤에 다시 시도하고, 그 다음 실패에서 `dead`가 됩니다(거부된 목적지도 같은 일정입니다).
`sending`으로 10분 넘게 남은 행은 `retry`로 돌아가고 시도 한 번으로 셉니다(`worker_interrupted`).
그래서 전달은 at-least-once이며, 수신자는 이벤트 ID로 중복을 제거해야 합니다.
한 Cron 실행은 행 수와 시간 예산(`WEBHOOK_MAX_DELIVERIES_PER_RUN`, `WEBHOOK_RUN_BUDGET_MS`) 안에서만 시도합니다.
행 수 한도는 Workers의 호출당 subrequest 한도에 맞춘 값입니다. 시도 한 번은 DNS-over-HTTPS 조회 두 번과 `POST` 한 번으로 subrequest를 최대 3개(`WEBHOOK_SUBREQUESTS_PER_ATTEMPT`) 씁니다.
[Workers 한도 문서](https://developers.cloudflare.com/workers/platform/limits/)(2026-10-02 확인)는 호출당 subrequest를 Workers Free 50개, Workers Paid 기본 10,000개로 안내합니다.
이 서비스의 Cloudflare 계정이 어느 플랜인지는 저장소에 기록되어 있지 않으므로 Free 기준으로 정했습니다.
같은 문서는 Cloudflare 서비스로 보내는 요청을 별도 한도("Subrequests to internal services", Free 1,000개)로 둡니다. 그래서 wake 단계의 Queue 발행은 이 50개에 넣어 계산하지 않습니다. 다만 문서는 Queues와 Hyperdrive를 이름으로 지목하지 않습니다.
같은 Cron 호출의 `fetch`는 모두 한 카운터를 거치고, 토큰 갱신(연결 10개까지, 연결마다 Graph 호출 2번)과 웹훅 전송이 호출당 예산 `CRON_SUBREQUEST_BUDGET`(45개)을 나눠 씁니다.
45개는 Free 한도 50개에서 카운터가 보지 못하는 요청(데이터베이스 연결 비용 등)을 위해 5개를 남긴 값이며 서비스 정책입니다.
남은 예산이 시도 한 번에 필요한 3개보다 적으면 그 실행은 전송을 더 점유하지 않으므로, 점유하지 않은 전송은 시도 횟수를 쓰지 않고 `pending` 또는 `retry`로 다음 실행을 기다립니다.
카운터가 보지 못하는 요청이 남겨 둔 5개를 넘으면 한도를 넘을 수 있고, 그때는 조회나 요청이 예외로 끝나 그 시도가 `dns_failed` 또는 `request_failed`로 기록되고 재시도 횟수를 하나 씁니다.
한 실행에서 주소별 예산(`WEBHOOK_ENDPOINT_BUDGET_MS`)을 쓴 주소는 그 실행에서 더 시도하지 않으므로, 느린 주소 하나가 실행 전체를 쓰지 못합니다.
이 값들은 모두 서비스 정책입니다.

## 서명

모든 요청은 두 헤더를 가집니다.

```plaintext
X-AutoChatter-Event-Id: <event id>
X-AutoChatter-Signature: t=<unix seconds>,k=<key id>,v1=<hex HMAC-SHA256>
```

서명 대상 문자열은 `<t>.<요청 본문 원문>`이고, HMAC 키는 발급된 비밀 문자열(`whsec_` 접두사 포함)의 UTF-8 바이트입니다.
유효한 키가 두 개인 동안에는 `t` 하나 뒤에 키마다 `k=<id>,v1=<sig>` 쌍이 하나씩 붙으므로, 둘 중 어느 비밀을 가진 수신자도 검증할 수 있습니다.
재시도는 새 `t`로 다시 서명하지만 이벤트 ID와 본문은 같습니다. 수동 재전송도 같은 이벤트 ID를 씁니다.
`t`의 허용 오차와 중복 제거 기간은 수신자가 정합니다.

## 관리자 API

모든 경로는 `workspaceFor(..., "admin")`을 통과해야 하며(상담원은 `403 role_forbidden`), GET이 아닌 요청에는 same-origin 규칙이 적용되고, 자기 작업 공간의 행만 다룹니다.

| 경로                                                 | 동작                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/webhooks/endpoints`                        | 주소 목록과 유효한 키의 ID·생성 시각. 비밀은 없습니다.                                                                       |
| `POST /api/webhooks/endpoints`                       | `{name, url}`로 주소와 첫 키를 만듭니다. 비밀은 이 응답에만 한 번 있습니다. 전달과 같은 URL 규칙을 DNS 조회 없이 적용합니다. |
| `POST /api/webhooks/endpoints/<id>/rotate`           | 두 번째 유효 키를 만들고 그 비밀을 한 번 돌려줍니다. 유효 키가 이미 둘이면 `409 webhook_rotation_in_progress`입니다.         |
| `POST /api/webhooks/endpoints/<id>/retire`           | 두 유효 키 가운데 오래된 키를 폐기합니다. 유효 키가 하나면 `409 webhook_key_required`입니다.                                 |
| `POST /api/webhooks/endpoints/<id>/enable`·`disable` | 주소를 켜거나 끕니다. 켤 때 활성 주소 한도를 다시 확인합니다.                                                                |
| `GET /api/webhooks/deliveries`                       | 최근 전송의 상태·시도 횟수·결과 코드. `payload`와 댓글 작성자 ID는 없습니다.                                                 |
| `POST /api/webhooks/deliveries/<event id>/redeliver` | `dead`인 전송을 같은 이벤트 ID로 다시 `pending`으로 만들고 시도 일정을 초기화하며 감사 행을 남깁니다.                        |

주소 URL은 경로나 쿼리에 수신 측 인증값을 담을 수 있으므로 목록도 관리자만 봅니다.
`TOKEN_ENCRYPTION_KEY`가 없으면 주소 생성과 키 교체는 `503 webhooks_unavailable`입니다. 역할 검사가 먼저이므로 상담원은 이때도 `403 role_forbidden`을 받습니다.
`dead`가 아닌 전송의 재전송은 `409 webhook_delivery_not_dead`, 꺼진 주소로의 재전송은 `409 webhook_endpoint_inactive`입니다.
재전송은 연결 행을 `FOR SHARE`로 잠근 뒤 전송 행을 잠그므로 삭제 함수와 순서가 같습니다.

## 설정 화면

작업 공간 설정 아래의 "외부 전송" 영역(`webhooks-section`, `public/app/app.js`)이 위 API를 씁니다.
소유자와 관리자에게만 보이며, 상담원에게는 영역을 숨기고 `/api/webhooks` 요청도 보내지 않습니다.

- 주소 목록은 이름, URL, 켜짐 여부, 유효한 키의 ID와 발급 시각을 보여 줍니다. 유효 키가 둘이면 "키 교체 중"으로 표시하고 "키 교체"를 비활성화하며, 하나면 "이전 키 폐기"를 비활성화합니다.
- 주소 추가 양식은 `{name, url}`만 보냅니다. 입력 칸의 안내는 참고용이고, 허용 여부는 서버가 정합니다.
- 주소 추가와 키 교체의 응답에 든 비밀은 닫을 수 있는 영역의 읽기 전용 입력 칸에 한 번 보여 주고 복사 버튼을 둡니다. 비밀은 그 입력 칸 값에만 두며 알림 문장, 속성, `localStorage`·`sessionStorage`에 넣지 않습니다. 닫기, 새로 고침, 세션 초기화(로그아웃·401)에서 지웁니다.
- 이전 키 폐기와 주소 끄기는 확인 창을 거칩니다. 끄면 그 주소로 보낼 전송이 `dead`로 끝나고 다시 켜도 자동으로 다시 보내지 않는다는 점을 확인 창에서 알립니다.
- 최근 전송은 주소 이름(목록의 `endpoint_id`로 찾음), 상태, 시도 횟수, 마지막 HTTP 상태 코드, 실패 코드의 한국어 이름, 생성·전송 시각을 보여 줍니다. "다시 보내기"는 `dead` 행에만 있고 확인 창을 거칩니다. `payload`와 댓글 작성자 ID는 API가 돌려주지 않으므로 화면에도 없습니다.
- 상태와 실패 코드의 이름, 결과 줄은 `public/app/webhook-labels.js`의 순수 함수가 만들고 `src/app/webhook-labels.test.ts`가 확인합니다. 이 테스트는 `webhook-delivery.ts`가 저장할 수 있는 실패 코드마다 이름이 있는지도 확인합니다.
- 이 기능의 모든 API 오류 코드는 `app.js`의 오류 문구 표에 한국어 문구가 있습니다.

브라우저 확인은 [외부 전송 설정 화면 검증](../notes/2026-10-02-webhook-settings-ui-verification.md)에 있습니다.

## 삭제와 내보내기

- `delete_connection_data`: 그 연결의 전송과 재전송 감사를 지웁니다. 주소와 키는 작업 공간 설정이므로 남습니다.
- `delete_person_data`: 그 사람(댓글 작성자)의 전송과 그 감사를 지웁니다.
- `delete_workspace_data`: 전송, 감사, 키, 주소를 모두 지웁니다.

세 함수 모두 기존 잠금 순서(연결, 그 다음 발송 행)를 유지하고, 범위 안의 전송이 `sending`이면 기존 `sending_in_progress`로 거부합니다.
[작업 공간 내보내기](2026-09-30-workspace-export.md)는 네 테이블을 포함하되 `webhook_signing_keys.secret_encrypted`는 뺍니다.
아직 보내지 않은 전송의 `payload`는 내보내기에 들어갑니다.

## 로그와 개인정보

전달 로그는 [`logOperation`](2026-10-01-operations-health.md#로그)의 고정 코드만 남기며 URL, 호스트, payload, 비밀, 응답은 기록하지 않습니다.
`/privacy`에는 외부 전송을 설정하면 지정한 태그·필드 값과 처리 식별자를 관리자가 지정한 주소로 보낸다는 문장을 추가했습니다.

## 남은 한계

Workers의 `fetch`는 호스트 이름을 스스로 다시 조회합니다.
그래서 DNS-over-HTTPS 검사와 실제 요청은 원자적이지 않고, 검사 직후 다른 주소를 답하는 이름(DNS rebinding)은 이 검사로 막지 못합니다.
검사에 쓴 조회 서버와 `fetch`가 쓰는 조회 경로가 다른 답을 줄 수도 있습니다.
이 PR은 이 간격을 닫지 않으며, 리다이렉트 거부·응답 미저장·고정 헤더로 요청이 닿았을 때의 영향을 줄일 뿐입니다.

## 검증

로컬 테스트가 확인하는 범위입니다.

- 단위 테스트(`webhook-delivery.test.ts`, `flow-schema.test.ts`, `flow-runtime.test.ts`): URL 거부 유형, 주소 대역 판정, 서명 형식, DNS-over-HTTPS 응답 처리, 노드 형태·발행 검증·실행 계획.
- DB 테스트(`webhook-delivery.db.test.ts`): 거부 유형별 요청 없음, 시도마다 다시 조회, 리다이렉트 거부, 본문 읽기까지의 제한 시간과 그 기본값, 응답 크기 한도, 재시도 일정과 `dead`, 오래된 `sending` 복구, 잃은 claim, 겹친 실행, 키 교체 중 두 서명과 폐기 뒤 한 서명, 꺼진 주소, 실행당 한도, 로그 내용.
- DB 테스트(`webhooks.db.test.ts`): 역할·작업 공간·same-origin 검사, 암호화 키가 없을 때의 역할 검사 순서, 비밀 한 번 반환과 봉인, 활성 주소 한도, 키 교체, 발행 검증과 `field_in_use`, 응답 저장 필드의 발행 거부(같은 초안, 다른 플로, 보관한 플로, 반대 방향)와 실행 시점 제외(응답 대기 직후, 다른 플로의 시작과 지연 뒤), 실행·노드당 전송 하나와 payload 내용, 지연·시각 대기·응답 대기 뒤의 노드, 실패하는 주소가 답장 행과 뒤 노드를 바꾸지 않음, 재전송의 이벤트 ID 유지와 감사, 세 삭제 함수, migration 031 재실행.
- Cloudflare 테스트(`worker.db.test.ts`, `access.db.test.ts`, `runtime.db.test.mjs`): Cron 단계의 순서·전역 스위치·실패 격리, 서버 역할의 DELETE·감사 UPDATE 차단과 API 역할 차단, 제한된 서버 역할로 workerd에서 실행한 서명 전송.

이 테스트들은 `fetch`와 조회 서버를 대체하므로 실제 DNS 조회, 실제 외부 주소로의 요청, Workers 네트워크의 동작은 확인하지 않습니다.

## 운영 적용

적용하지 않았습니다.
운영 DB의 migration 031, 배포, 실제 외부 주소로의 전송은 이 PR의 범위 밖이며 확인하지 않았습니다.
