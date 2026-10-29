# 고정 대상에 메시지를 붙이는 캠페인 초안 API

## 상태와 근거

2026-10-21 운영자가 방향을 승인했고 저장·API를 구현했습니다.
API 검증 결과는 [구현 검증](../notes/2026-10-21-campaign-drafts-verification.md)에 기록합니다.
2026-10-22에는 연락처 메뉴에 관리자용 초안 관리 화면을 추가했습니다.
화면 검증은 [관리 화면 검증](../notes/2026-10-22-campaign-draft-ui-verification.md)에 기록합니다.
초기 API 설계의 기준 코드는 PR #241 병합 커밋 `325abd3d8748cd14b5e935fdc5f7059029040aa8`입니다.
주요 근거는 [#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35), [고정 대상 계약](2026-10-18-segment-target-snapshots.md), [요금제 권한 계약](2026-10-12-plan-entitlements.md)입니다.
초기 API 설계 시점에는 고정 명단만 저장되었으며, 그 명단에 메시지를 붙여 초안으로 보관하는 기능은 없었습니다.
요금제 계약은 현재 멤버 자리·연결 한도만 다루므로 캠페인 실행 권한이나 가격을 추정하지 않습니다.

## 구현 범위

관리자가 기존 고정 대상 하나를 참조하는 캠페인 초안을 만들고 조회·수정·보관하는 서버 API를 추가합니다.
초안은 계획 자료이며 발송 요청이 아닙니다.
저장했다고 Instagram에서 대량 발송할 수 있거나 대상자에게 동의·응답 창이 있다는 뜻이 아닙니다.
기존 대상 명단·식별자 연결·동의·발송 guard를 바꾸지 않습니다.

이번 단계의 메시지는 변수 치환 없는 일반 텍스트만 지원합니다.
이름은 NFC 정규화 후 1–60자, 본문은 기존 상담 답장 템플릿과 같은 1–1,000 UTF-16 코드 단위 제한을 적용하며 빈 내용과 NUL을 거절합니다.
`{{` 또는 `}}`가 있는 본문은 미해결 템플릿으로 거절합니다.
이 길이는 로컬 초안 저장 제약이며 공급자별 발송 가능성 검증을 대신하지 않습니다.
2026-10-27에 최종 실행 승인과 예약 시각 기록을 [실행 승인](#실행-승인) API로 추가했습니다.
템플릿 선택·치환, 수신자별 개인화, outbox 생성, 일괄 발송은 후속 범위입니다.
승인 화면과 초안 편집기의 `409 approval_active` 안내는 2026-10-27에 [실행 승인 화면](#실행-승인-화면)으로 추가했고, 캠페인 단위 예약 상한을 둘지는 운영자가 정할 후속 결정입니다.
요금·동의·응답 창 미리보기는 2026-10-26에 읽기 전용 API로 추가했으며 [발송 조건·비용 미리보기](#발송-조건비용-미리보기)를 따릅니다.
초기 API 변경에는 화면을 포함하지 않았습니다.
이후 추가한 관리 화면은 아래 계약을 따릅니다.

## 저장과 권한

새 `campaign_drafts` 테이블은 작업 공간, 고정 대상 ID, 이름, 본문, 양의 정수 버전, 생성·변경 시각, 생성·변경 운영자와 보관 여부를 저장합니다.
고정 대상과 작업 공간의 복합 외래 키로 다른 작업 공간의 명단을 참조하지 못하게 합니다.
대상 식별자를 복사하지 않고 기존 명단만 참조합니다.
원래 대상 수와 현재 남아 있는 명단 수는 조회 시 구분하며, 개인·연결 삭제 후 줄어든 명단을 복원하지 않습니다.
초안 생성 이후 원본 세그먼트가 보관돼도 고정 대상은 기존 계약대로 유지됩니다.

모든 API는 활성 `admin` 이상만 허용합니다.
기존 세션·동일 출처 검사·쓰기 한도와 `no-store` 응답을 사용합니다.
서버 역할은 SELECT·INSERT·UPDATE만, 외부 API 역할은 직접 접근 불가로 설정합니다.
초안은 내부 재시도 해시를 제외하고 작업 공간 내보내기에 포함하고 작업 공간 삭제 시 고정 대상보다 먼저 제거합니다.
작업 공간 이동의 비어 있음 판정도 새 테이블을 반영합니다.

저장 폭증을 막기 위해 보관된 초안을 포함해 작업 공간당 100개로 제한합니다.
이는 요금제 상품 권한이 아닌 초기 저장 한도이며, 보관으로 한도를 되돌리지 않습니다.
생성 시 작업 공간 잠금 안에서 한도를 검사합니다.

## API

- `POST /api/campaign-drafts`: 클라이언트가 만든 UUID `id`, `snapshot_id`, `name`, `body`를 받습니다. 같은 ID·같은 최초 요청의 재시도는 중복 생성하지 않아야 합니다. UUID는 소문자, 이름은 NFC·앞뒤 공백 제거, 본문은 입력 그대로인 네 필드를 고정 순서로 JSON 직렬화한 SHA-256 해시를 보존하고 재시도 때 대조합니다.
  재시도는 현재 초안을 반환하며 수정·보관 상태를 되돌리지 않습니다. 수정된 현재 본문으로 최초 요청을 판별하지 않습니다.
- `GET /api/campaign-drafts`: 최대 100개 요약을 반환하며 본문·대상 식별자는 제외합니다.
- `GET /api/campaign-drafts/:id`: 본문, 버전, 보관 상태와 원래·현재 남은 대상 수를 반환합니다.
- `PUT /api/campaign-drafts/:id`: `expected_version`, `snapshot_id`, `name`, `body`를 받습니다. 버전이 다르면 409이며 보관된 초안은 수정하지 못합니다. 성공한 수정은 내용이 같아도 버전을 1 증가시킵니다.
- `POST /api/campaign-drafts/:id/archive`: `expected_version`으로 보관하고 버전을 1 증가시키며 이후 수정·재보관은 409로 거절합니다.

생성은 201, 성공한 재시도·조회·수정·보관은 200을 사용합니다.
잘못된 요청은 400, 권한 부족은 403, 없거나 다른 작업 공간의 대상은 같은 404, 버전·상태·ID 충돌과 저장 한도는 409로 구분합니다.
재시도·버전 검사·한도·참조 확인은 한 트랜잭션으로 처리합니다.
기존 공개 API는 변경하지 않습니다.

## 발송 조건·비용 미리보기

2026-10-26 운영자가 계획을 승인했습니다(마케팅 목적과 별도의 채널 미지원 표시, 공급자 호출 수와 정의되지 않은 한도, API만).
검증 결과는 [미리보기 검증](../notes/2026-10-26-campaign-draft-preview-verification.md)에 기록합니다.

`GET /api/campaign-drafts/:id/preview`는 초안 하나의 고정 대상 중 지금 남아 있는 명단이 기록된 발송 조건을 몇 명 통과하는지와 발송에 필요한 공급자 호출 수를 반환합니다.
아무것도 보내거나 쓰지 않으며, `private_reply_outbox`, `instagram_manual_replies`, `channel_consent_events`, `channel_consent_state`, `instagram_segment_snapshot_members`, `campaign_drafts`를 바꾸지 않습니다.
새 테이블과 migration은 없습니다.
활성 `admin` 이상만 허용하며 기존 세션·동일 출처·요청 한도 처리와 `no-store` 응답을 다른 초안 API와 같이 사용합니다.
쿼리 문자열이 있으면 400입니다.
없거나 다른 작업 공간의 초안, UUID 형식이 아닌 ID는 같은 `404 campaign_draft_not_found`입니다.
역할 검사가 ID 확인보다 먼저이므로 `agent`는 어떤 ID로도 403을 받습니다.
보관된 초안도 미리볼 수 있습니다.

### 평가

관리자 멤버십 조회를 포함한 하나의 `REPEATABLE READ READ ONLY` 트랜잭션 안에서 SQL 한 문장으로 평가합니다.
평가 시각은 그 문장의 `statement_timestamp()` 하나이며 응답의 `as_of`(마이크로초 UTC ISO 문자열)로 반환합니다.
대상은 호출자 작업 공간에서 초안의 `snapshot_id`에 남아 있는 `instagram_segment_snapshot_members` 행입니다.
개인·연결 삭제로 줄어든 명단은 복원하지 않으며, 사유별 수의 합은 항상 `remaining_member_count`와 같습니다.

각 대상은 아래 순서에서 처음 해당하는 사유 하나만 받습니다.

1. `connection_unavailable`: 대상의 연결이 `active`가 아니거나, `send_enabled`가 거짓이거나, 저장된 토큰(`access_token_encrypted`)이 없거나, `token_expires_at`이 `as_of` 이하이거나 비어 있습니다. Cloudflare 수동 답장·팔로우 발송 guard가 읽는 연결 열과 같습니다. 연결별 일시 중지(`send_paused_until`)와 수동 답장의 `inbox_enabled`는 발송 시점에 다시 검사하므로 미리보기 사유에 넣지 않습니다.
2. `contact_paused`: (작업 공간, 연결, 댓글 작성자)의 `instagram_contact_automation.paused` 또는 `handoff_paused`가 참입니다.
3. `no_dm_identity`: `src/app/inbox-identity.ts`의 `verifiedDmRecipientsSql`이 같은 연결에서 이 댓글 작성자의 확인된 DM 수신자를 하나도 반환하지 않습니다. 두 작성자가 나눠 쓰는 수신자는 모호하므로 어느 쪽에도 확인되지 않습니다. 이 함수는 근거 최신성 판정에 자체 시계 `now()`를 사용하며, 같은 트랜잭션 안에서 읽습니다.
4. `opted_out`: 수신자별로, `channel_consent_state`에 `purpose`가 `marketing` 또는 `service_reply`이고 `decision='revoke'`인 현재 상태가 그 DM 수신자(`dm_recipient`) 또는 댓글 작성자(`comment_sender`)에 있으면 그 수신자는 수신 거부입니다. `purpose=all` 철회는 투영에서 두 목적 행으로 저장되므로 같은 검사로 잡힙니다. 따라서 댓글 작성자의 철회는 모든 수신자를 막고, 수신자 하나의 철회는 그 수신자만 막습니다. 이 판정은 발송 guard(`deliveryRecipientOptedOut`)와 범위가 다릅니다. guard는 확인 여부와 무관하게 연결된 모든 수신자의 `service_reply` 철회 하나로 댓글 작성자 전체를 막고, 미리보기는 확인된 수신자별로 두 목적의 철회를 봅니다. 발송 guard는 발송 시점에 따로 적용됩니다.
5. `marketing_consent_required`: 그 DM 수신자에게 `purpose='marketing'`, `decision='grant'`, `evidence_kind='explicit'`인 현재 상태가 없습니다. `evaluateChannelConsent`의 정확한 범위 규칙에 따라 메시지를 받을 `dm_recipient` 식별자만 보며, 댓글 작성자의 마케팅 동의나 `import`·`comment` 근거의 동의는 인정하지 않습니다.
6. `reply_window_closed`: 그 DM 수신자의 가장 최근에 저장된 `kind='text'` 받은 DM이 `as_of` 이전 24시간 안에 없습니다. `as_of - message_at`이 정확히 24시간이면 닫힌 것이고, 가장 최근 텍스트 DM이 `as_of`보다 미래이면 그보다 이른 DM이 24시간 안에 있어도 닫힌 것으로 봅니다. 버튼 응답(`postback`)은 창을 열지 않습니다. `manual-reply-worker.ts`와 `evaluateWindow`의 규칙과 같습니다.
7. `candidate`: 위 검사를 모두 통과했습니다.

확인된 DM 수신자가 여럿인 댓글 작성자는 수신자마다 4–6단계를 평가하고, 가장 멀리 간 수신자의 단계를 대상의 단계로 삼습니다.
따라서 수신자 하나라도 4–6을 모두 통과하면 `candidate`이며, 그렇지 않으면 가장 멀리 간 수신자가 처음 실패한 사유를 받습니다.
예를 들어 한 수신자가 수신 거부이고 다른 수신자가 동의는 있지만 창이 닫혔다면 `reply_window_closed`입니다.

### 응답

```json
{
  "draft_id": "…",
  "draft_version": 1,
  "snapshot_id": "…",
  "archived": false,
  "as_of": "2026-10-26T09:00:00.000000Z",
  "original_member_count": "13",
  "remaining_member_count": "13",
  "counts": {
    "connection_unavailable": "1",
    "contact_paused": "2",
    "no_dm_identity": "2",
    "opted_out": "3",
    "marketing_consent_required": "3",
    "reply_window_closed": "1",
    "candidate": "1"
  },
  "candidate_meaning": "passed_recorded_conditions_at_as_of",
  "sendability_claimed": false,
  "estimated_provider_calls": "1",
  "plan_broadcast_limit": null,
  "channel_marketing_supported": true,
  "global_send_enabled": false
}
```

모든 수는 10진수 문자열입니다.
`candidate`는 `as_of`에 기록된 조건을 통과했다는 뜻이며 발송할 수 있다는 뜻이 아닙니다. 응답은 이를 `candidate_meaning`과 `sendability_claimed: false`로 함께 표시합니다.
발송 guard는 발송 시점에 모든 조건을 다시 검사합니다.
`channel_marketing_supported`는 `instagramCapabilities("cloudflare_oauth").operations.marketing.supported`이며 2026-10-27부터 참입니다([캠페인 실행 계약](2026-10-27-campaign-runs.md#채널-capability)).
참이어도 발송할 수 있다는 뜻은 아니며, 캠페인 발송에는 24시간 창과 정확한 명시적 마케팅 동의가 모두 필요합니다.
`global_send_enabled`는 Worker의 `SEND_ENABLED`가 정확히 `"true"`인지입니다.
두 표시는 사유별 수와 따로 반환하며 수를 바꾸지 않습니다.

### 비용

`estimated_provider_calls`는 `candidate` 수와 같습니다(후보 한 명당 발송 호출 한 번).
`plan_broadcast_limit`은 `null`입니다. 어떤 요금제도 방송 한도를 정의하지 않으며 [#52](https://github.com/AndrewDongminYoo/auto-chatter/issues/52)·[#60](https://github.com/AndrewDongminYoo/auto-chatter/issues/60)이 그 정의를 맡습니다.
이 API는 한도나 일일 상한을 적용하지 않습니다.
Instagram 공급자 메시지 요금은 인용할 Meta 출처를 확인하지 않았으므로 알 수 없음으로 둡니다.

## 실행 승인

2026-10-27 운영자가 계획을 승인했습니다(기록 전용 승인, 템플릿 제외와 후속 분리, 서버 먼저·화면은 다음 PR).
검증 결과는 [실행 승인 검증](../notes/2026-10-27-campaign-approvals-verification.md)에 기록합니다.
migration 064는 코드 배포 전에 전체 실행기(`deploy/migrate-multi-user.sql`)로 적용해야 합니다.

관리자가 초안 한 버전의 최종 실행 승인을 기록합니다.
승인은 무엇을 승인했는지(초안 버전, 고정 대상, 이름·본문 사본, 승인 시점 미리보기)와 언제 실행할지(즉시 또는 작업 공간 현지 시각)만 저장합니다.
아무것도 보내거나 큐에 넣거나 발송 예약을 만들지 않습니다.
승인 API는 outbox 행·큐 메시지·발송을 만들지 않고, 응답은 ~~항상 `delivery_available: false`입니다~~ `delivery_available`을 담습니다.
2026-10-27부터 기한이 된 승인은 `campaign_start` cron 단계가 실행 하나를 시작하고 `executed`로 바꿉니다. 실행은 대기 중 발송 행만 쓰고 아무것도 보내지 않으며, 계약은 [캠페인 실행](2026-10-27-campaign-runs.md)이 맡습니다.
~~실제 발송은 [#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36)의 발송 worker(PR ②)가 그 행을 읽어 맡을 범위입니다.~~
2026-10-29 정정(#36 PR ②): 발송 worker가 실행의 행을 보내며, 승인 응답의 `delivery_available`은 `true`입니다. 계약은 [발송 worker](2026-10-27-campaign-runs.md#발송-worker)가 맡고, 이 문서의 해당 문장보다 앞섭니다.
Cloudflare OAuth 표면의 Instagram 마케팅 capability는 2026-10-27부터 지원(`channel_marketing_supported: true`)이며, Meta 정책 근거와 발송 조건은 캠페인 실행 계약이 맡습니다.

### 승인 저장

`campaign_approvals`는 작업 공간, 클라이언트 UUID `id`, `draft_id`, `draft_version`, `snapshot_id`, 승인 시점 초안 `name`·`body` 사본, `schedule_kind`(`immediate`·`scheduled`), 절대 시각 `scheduled_at`과 해석한 시간대 `schedule_time_zone`(즉시이면 둘 다 NULL), 승인 시점 미리보기, `status`(`approved`·`cancelled`, 065부터 `executed`), 양의 정수 `version`, `approved_by`·`approved_at`, `cancelled_by`·`cancelled_at`, `updated_at`, 생성 요청 해시를 저장합니다.
미리보기는 `preview_as_of`(timestamptz)와 `preview_counts` jsonb 객체 하나로 저장합니다.
객체에는 `original_member_count`, `remaining_member_count`와 일곱 사유의 수가 미리보기 API와 같은 10진 문자열로 들어 있으며, 응답은 이를 그대로 돌려줍니다.
복합 외래 키로 초안과 고정 대상이 같은 작업 공간에 있어야 합니다.
CHECK 제약으로 예약 종류·시각·시간대의 짝과, 취소 상태일 때만 취소 열이 채워지는 것을 강제합니다.
`(workspace_id, draft_id) WHERE status='approved'` 부분 유일 색인으로 초안마다 유효한 승인은 최대 하나입니다.

`campaign_approval_events`는 버전마다 한 행인 추가 전용 감사 기록입니다.
생성(`created`)·예약 변경(`schedule_changed`)·취소(`cancelled`)마다 행위자, 종류, 만들어진 버전과 변경 후 예약 값을 남깁니다.
서버 역할은 승인 테이블에 SELECT·INSERT·UPDATE, 감사 테이블에 SELECT·INSERT만 가지며, 두 테이블 모두 DELETE가 없고 RLS를 켜며 외부 API 역할은 접근할 수 없습니다.
승인 수에는 별도 저장 한도를 두지 않습니다.
목록은 최신 100개로 제한합니다.

### 승인 API

모든 API는 활성 `admin` 이상만 허용하며, 기존 동일 출처 검사·쓰기 한도·`no-store`를 초안 API와 같이 사용합니다.
역할 검사가 ID 확인보다 먼저이므로 `agent`는 어떤 ID로도 403입니다.
없거나 다른 작업 공간의 ID와 UUID 형식이 아닌 ID는 같은 404, 형식이 틀린 본문과 쿼리 문자열은 400입니다.

- `POST /api/campaign-drafts/:id/approvals`: `{id, expected_version, schedule_local | null, expected_time_zone}`. 생성은 201입니다. 소문자 `id`, 초안 ID, `expected_version`, `schedule_local`, `expected_time_zone`을 고정 순서로 JSON 직렬화한 SHA-256 해시를 저장하고, 같은 `id`의 같은 요청 재시도는 200과 현재 상태를 반환하며 이후 변경·취소를 되돌리지 않습니다. 같은 `id`의 다른 요청은 `409 campaign_approval_id_conflict`입니다.
- `GET /api/campaign-approvals`: 최신 승인 순(`approved_at DESC, id`) 최대 100개 요약이며 본문과 감사 기록은 제외합니다.
- `GET /api/campaign-approvals/:id`: 본문과 감사 기록(`events`)을 포함한 상세입니다.
- `PUT /api/campaign-approvals/:id/schedule`: `{expected_version, schedule_local | null, expected_time_zone}`로 `approved` 승인의 예약만 바꾸고 버전을 1 올립니다. 승인한 초안 버전·사본·미리보기는 바뀌지 않습니다.
- `POST /api/campaign-approvals/:id/cancel`: `{expected_version}`으로 취소하고 버전을 1 올립니다.

버전이 다르면 `409 campaign_approval_conflict`, 취소된 승인에 대한 변경·재취소는 `409 campaign_approval_cancelled`이며 둘 다 응답의 `approval`에 현재 상태를 담습니다.
응답에는 `preview: {as_of, original_member_count, remaining_member_count, counts}`, 예약 시각을 그 시간대의 벽시계로 보인 `schedule_local`, ~~`delivery_available: false`~~ `delivery_available`(2026-10-29 #36 PR ②부터 `true`)이 포함됩니다.
065부터는 실행의 `run_id`와 `run_status`(실행 전에는 `null`)도 포함하며, 실행된 승인의 예약 변경·취소는 `409 campaign_approval_executed`와 현재 승인입니다([캠페인 실행](2026-10-27-campaign-runs.md#승인의-실행-상태)).

### 승인 규칙

승인 트랜잭션은 작업 공간 행(`lockWorkspaceForMember`)과 초안 행을 잠급니다.
같은 `id`의 기존 승인을 가장 먼저 확인하므로 재시도는 이후 초안·시간대·시각이 바뀌어도 현재 상태를 돌려줍니다.
보관되지 않았고 현재 버전이 `expected_version`과 같은 초안만 승인할 수 있으며, 아니면 `409 campaign_draft_conflict`이고 응답의 `draft`에 `GET /api/campaign-drafts/:id`와 같은 현재 초안을 담습니다.
유효한 승인이 이미 있으면 `409 approval_exists`이고 응답의 `approval`에 그 승인의 상세를 담습니다.
두 경우 모두 아무것도 쓰지 않습니다.
같은 `id`의 다른 요청(`campaign_approval_id_conflict`)은 버전 충돌이 아니므로 오류 코드만 반환합니다.
같은 트랜잭션 안에서 [미리보기](#발송-조건비용-미리보기)와 같은 평가(`src/app/campaign-drafts.ts`의 `PREVIEW_SQL`)를 실행해 그 결과를 저장하므로, 저장된 미리보기는 그 순간의 미리보기 API와 같습니다.
이후 개인·연결 삭제로 명단이 줄어도 저장된 미리보기는 승인 시점 값을 유지합니다.

### 예약 시각

`schedule_local`은 `YYYY-MM-DDTHH:mm`이며 PostgreSQL이 현재 작업 공간 `time_zone`으로 해석합니다(`localDueSql`, `timestamp AT TIME ZONE`, 상담 예약 답장·리마인더와 같은 규칙).
일광 절약 시간 공백에 걸린 시각은 변경 전 오프셋으로 읽어 벽시계로 한 시간 뒤에 저장되고, 겹치는 시각은 나중 시점으로 읽습니다.
`expected_time_zone`이 현재 작업 공간 시간대와 다르면 즉시 승인이든 예약이든 `409 campaign_schedule_timezone_changed`입니다.
`null`은 즉시이며 `scheduled_at`과 `schedule_time_zone`을 비웁니다.
이후 작업 공간 시간대를 바꿔도 저장된 `scheduled_at`과 `schedule_time_zone`은 움직이지 않습니다.

허용 범위는 [상담 예약 답장](2026-10-16-inbox-scheduled-replies.md) 계약을 따릅니다.
그 계약의 고정 경계는 현재보다 최소 1분 뒤(포함)라는 하한 하나이며, 승인도 같은 상수(`src/app/manual-replies.ts`의 `SCHEDULE_MIN_AHEAD`)를 씁니다.
그 계약의 상한은 수신자 한 명의 답장 창 종료(미포함)입니다.
승인에는 수신자 한 명이 없으므로 이 상한은 승인 시점에 미리보기의 `reply_window_closed` 수로만 나타나며, 고정 상한을 새로 두지 않습니다.
수신자별 창은 [#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36)이 발송 시점에 대상마다 적용해야 합니다.
1분 하한보다 이른 시각은 `400 campaign_schedule_out_of_range`입니다.

### 초안 변경

유효한 승인이 있는 초안의 `PUT /api/campaign-drafts/:id`와 보관은 `409 approval_active`입니다.
내용을 바꾸려면 승인을 취소하고 수정한 뒤 다시 승인합니다.
초안 수정·보관과 승인 생성은 같은 작업 공간 잠금과 초안 행 잠금 아래에서 검사하므로 섞이지 않습니다.
승인이 먼저면 수정이 `approval_active`, 수정이 먼저면 승인이 `campaign_draft_conflict`를 받습니다.

### 데이터 경계

작업 공간 삭제(`delete_workspace_data`)는 외래 키 순서대로 감사 기록, 승인, 초안, 고정 대상 순으로 지웁니다.
065부터는 그 앞에 캠페인 발송 행과 실행을 지웁니다([캠페인 실행의 데이터 경계](2026-10-27-campaign-runs.md#데이터-경계)).
연결·개인 삭제는 두 테이블을 건드리지 않습니다.
두 테이블에는 댓글 작성자·DM 수신자 같은 대상 식별자나 연결 ID가 없고 고정 대상 ID와 집계만 있습니다.
작업 공간 내보내기는 두 테이블을 포함하고 승인의 `create_request_hash`는 제외합니다.
두 작업 공간 이동 검사(`currentWorkspaceMovable`, `deploy/assign-workspace-owner.sql`)는 두 테이블의 행을 비어 있지 않음으로 셉니다.

### 실행 승인 화면

2026-10-27 운영자가 계획을 승인했습니다(위 API를 쓰는 관리자 초안 상세의 화면, 서버·스키마·migration·의존성 변경 없음).
검증 결과는 [승인 화면 검증](../notes/2026-10-27-campaign-approval-ui-verification.md)에 기록합니다.
템플릿 선택·치환, 실제 발송([#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36)), 캠페인 단위 예약 상한, 별도 승인 목록 화면은 후속 범위입니다.

저장된 초안을 열면 발송 조건 미리보기 아래에 ‘실행 승인’ 영역이 나타납니다.
열린 초안의 승인은 `GET /api/campaign-approvals` 목록 순서(최신 승인 먼저)에서 그 초안의 첫 항목이며, 새 API를 추가하지 않습니다.
목록은 최신 100개까지이므로 더 오래된 유효 승인은 찾지 못할 수 있습니다. 이때 승인 요청은 `409 approval_exists`로 그 승인을 받아 표시합니다.
조회가 끝나기 전에는 승인 상태를 알 수 없으므로 승인 버튼을 끄고 초안 입력을 잠급니다.
이 화면에서 새로 저장한 초안(결과 불명 생성의 재시도 성공 포함)도 저장 뒤 승인 상태를 한 번 읽은 다음 승인 버튼을 켭니다.
조회에 실패하면 승인 버튼을 끈 채 ‘승인 상태 새로고침’을 안내하며, 초안 저장은 서버의 `409 approval_active`에 맡깁니다.

승인 버튼은 보관되지 않았고 저장하지 않은 변경·대기 중이거나 결과 불명인 요청·유효한 승인이 없으며 승인 상태 조회가 끝난 초안에서만 켜집니다.
관리자는 실행 시점으로 ‘즉시’ 또는 ‘예약’을 고르며, 예약은 작업 공간 현지 날짜와 시각(`datetime-local`, 분 단위)입니다.
버튼을 누르면 먼저 확인 단계가 열려 승인할 초안 버전, 고정 대상, 실행 시점(예약이면 화면이 아는 시간대와 함께)과 ~~실제 발송은 아직 지원하지 않으며 승인은 기록만 한다는~~ 실행 시점에 서비스 전체 발송이 켜져 있을 때만 실행이 시작되고 보내기 직전마다 모든 조건을 다시 확인한다는(2026-10-29 #36 PR ②) 안내를 보여 줍니다.
확인 단계는 보여 준 요청을 고정하고, ‘승인 기록’을 눌러야 클라이언트 UUID, 표시한 초안 `expected_version`, `schedule_local` 또는 `null`, 화면이 아는 `expected_time_zone`으로 `POST /api/campaign-drafts/:id/approvals`를 보냅니다.

유효한 승인과 가장 최근의 취소된 승인은 상태, 승인한 초안 이름·버전, 실행 시점(‘즉시’ 또는 승인에 저장된 `schedule_time_zone`으로 표시한 시각과 그 시간대), 승인·취소한 사람과 시각, 승인 시점의 원래·남은 인원과 조건 기준 시각, 미리보기 표와 같은 사유 이름의 조건별 인원 표를 보여 줍니다.
`candidate`는 ‘조건 통과’로 표시하며, 화면 어디에도 ‘발송 가능’이라는 표현을 쓰지 않습니다.
~~`delivery_available: false`인 유효한 승인에는 실제 발송을 아직 지원하지 않는다는 경고를 둡니다.~~
2026-10-29 정정(#36 PR ②): 응답이 항상 `delivery_available: true`이므로 그 경고와 분기를 없앴습니다. 유효한 승인에는 실행 시점에 서비스 전체 발송이 켜져 있을 때만 실행이 시작되고 보내기 직전마다 조건을 다시 확인한다는 안내를 둡니다. 문구는 `public/app/campaign-drafts.js`와 [발송 worker의 화면 항목](2026-10-27-campaign-runs.md#응답-화면-운영-상태)이 맡습니다.
사람은 현재 로그인한 사용자이면 ‘나’, 아니면 ‘다른 멤버’와 사용자 ID 앞 8자리로 표시합니다. 관리자는 멤버 목록을 읽을 수 없기 때문입니다.
유효한 승인이 있으면 초안 입력·저장·보관을 잠그고, 수정하려면 먼저 승인을 취소하라고 안내합니다.
취소된 승인은 조회만 하며 초안 잠금을 풉니다.
실행된 승인(065)은 상태를 ‘실행 시작됨 · 발송 대상만 기록함’으로 보이고 초안 잠금을 풀며, 예약 변경·취소가 `campaign_approval_executed`로 거절되면 전용 안내를 보입니다. 실행 화면은 [#36](https://github.com/AndrewDongminYoo/auto-chatter/issues/36)의 PR ③입니다.

유효한 승인에는 ‘예약 변경’과 ‘승인 취소’가 있으며, 둘 다 표시한 승인의 `expected_version`을 보냅니다.
예약 입력은 승인의 시간대가 현재 작업 공간 시간대와 같을 때만 저장된 시각으로 채우고, 바뀌지 않은 예약은 보내지 않습니다.
취소는 브라우저 확인을 거칩니다.
현재 승인이나 초안을 담은 409(`approval_exists`, `campaign_approval_conflict`, `campaign_approval_cancelled`, 승인 요청의 `campaign_draft_conflict`)는 그 상태로 다시 표시하며 자동으로 재시도하지 않습니다. 초안 충돌 뒤에는 이전 버전으로 조회한 발송 조건 미리보기를 지우고 승인 상태를 다시 읽습니다.
공용 API 래퍼는 이 409 응답의 `approval`과 `draft`를 오류 객체에 전달합니다.
`409 campaign_schedule_timezone_changed`는 페이지를 새로고침해 바뀐 시간대를 확인하라고 안내합니다.

응답을 잃은 승인 요청은 같은 UUID와 본문을 유지하고 ‘같은 요청 재시도’만 허용하며, 그동안 확인 단계를 닫거나 다른 초안을 열거나 새 초안을 시작할 수 없습니다.
응답을 잃은 예약 변경·취소도 같은 요청만 다시 보낼 수 있습니다. 같은 `id`의 재시도는 현재 상태를 돌려주고, 이미 반영된 변경·취소의 재시도는 현재 승인을 담은 409를 받습니다.
429는 이전 시도의 결과를 알려 주지 않으므로 대기 중인 요청을 유지합니다.
그 밖의 4xx는 요청을 버리고 오류 안내를 표시합니다.

다른 초안 열기, 새 초안 시작, 세션 초기화, 작업 공간 변경, 시간대 변경은 표시한 승인과 확인 단계를 지우고 늦은 조회 응답을 버립니다.
기존 세대(`generation`)와 목록·상세·미리보기와 같은 방식의 승인 조회 요청 번호를 쓰며, 시간대 변경은 승인 상태를 다시 읽습니다.
승인 쓰기 응답은 세대가 바뀌면 버리며, 시간대 변경 뒤에 도착한 쓰기 응답은 저장된 시간대로 그립니다.
결과 불명인 승인 요청은 시간대 변경 뒤에도 유지되며, 재시도는 처음 보낸 `expected_time_zone`을 그대로 보냅니다.
다른 탭이 승인한 초안을 저장하거나 보관해 `409 approval_active`를 받으면 입력을 유지한 채 안내하고 승인 영역을 다시 읽습니다.
쓰기 중인 버튼과 승인 영역은 `aria-busy`를 표시하고, 안내는 영역의 `role="status"` 실시간 영역에 표시합니다.
확인 단계를 열면 확인 제목으로, 승인 기록이나 취소로 누른 버튼이 사라지면 표시한 승인의 제목으로 포커스를 옮깁니다.
결과 불명인 승인 요청이 있는 동안에는 시간대 변경이나 초안 입력 이벤트가 확인 요약을 지우지 않습니다.

## 수용 기준

1. 실제 PostgreSQL에서 관리자만 같은 작업 공간의 고정 대상으로 초안을 만들 수 있습니다.
2. 생성 응답을 잃어 재시도해도 한 초안만 생기며, 다른 내용으로 같은 ID를 재사용하면 충돌합니다.
3. 동시 수정 중 한 버전만 저장되고 한도 경합이 초과 저장을 만들지 않습니다.
4. 개인·연결 삭제 후 현재 명단 수는 감소하지만 원래 수와 초안은 보존하며 삭제된 식별자가 복원되지 않습니다.
5. 작업 공간 내보내기·삭제·이동·서버 역할 테스트에 실제 초안 행을 넣어 경계를 검사합니다.
6. 초안 작업 전후 outbox·동의 원장·고정 명단이 바뀌지 않습니다.
7. #35 전체, #36 발송, #52 방송 권한의 완료나 운영 배포로 보고하지 않습니다.

## 관리 화면

연락처 메뉴에서 소유자와 관리자가 고정 대상 선택, 일반 텍스트 초안 생성·목록·조회·수정·보관을 사용할 수 있습니다.
대상이 없으면 저장된 필터에서 명단을 고정한 뒤 목록을 새로고침하도록 안내합니다.
보관된 필터의 고정 명단도 선택할 수 있으며, 상세에 원래 인원과 현재 남은 인원을 구분합니다.
이 인원은 발송 가능 인원이나 동의 확인 결과가 아닙니다.
보관된 초안은 조회만 하며 100개 저장 한도에 계속 포함됩니다.

생성 응답을 잃으면 UUID와 최초 본문을 유지하고 입력·다른 초안 선택을 잠급니다.
운영자가 같은 요청을 재시도해 결과를 확인할 수 있습니다.
재시도가 요청 한도에 막혀도 원래 요청의 결과가 확인된 것은 아니므로 동일 UUID와 본문을 유지합니다.
수정·보관의 결과가 불명인 경우에도 동일 요청만 재시도하며, 충돌 응답 뒤에는 자동으로 다시 저장하지 않습니다.
버전 충돌은 입력을 보존하고 저장 버튼을 막으며, 명시적으로 저장된 값을 다시 읽은 뒤 수정합니다.
다른 초안을 열거나 새 초안을 시작할 때, 저장하지 않은 입력이 있으면 버릴지 확인합니다.
목록 새로고침은 편집 내용을 덮어쓰지 않습니다.

세션·작업 공간 변경과 권한 거절은 이전 입력·목록을 지우고 늦은 응답을 폐기합니다.
다른 탭의 세션 변경과 뒤로 가기 복원 신호에서도 내용을 지우며, 기존 ‘다시 불러오기’ 동작으로 서버 권한을 다시 확인해야 화면이 돌아옵니다.
무효화 이전에 시작한 작업 공간 조회는 신원·멤버십 응답 뒤에 화면을 다시 구성하지 못합니다.
같은 문서가 보낸 세션 알림은 새 로그인 조회를 취소하지 않도록 구분하며, 로컬 로그인 직후에는 먼저 보호된 데이터를 지운 뒤 다른 문서에 알립니다.
상세 조회에 성공하면 편집기 제목으로 포커스를 옮겨 긴 목록 아래의 편집기를 찾을 수 있게 합니다.
템플릿 치환·실제 발송은 이 화면에 포함하지 않습니다. 예약과 승인 기록은 [실행 승인 화면](#실행-승인-화면)을 따릅니다.

### 발송 조건 미리보기 화면

2026-10-26 운영자가 계획을 승인했습니다(명시적 버튼으로만 조회, 상단 경고와 사유별 표).
검증 결과는 [미리보기 화면 검증](../notes/2026-10-26-campaign-draft-preview-ui-verification.md)에 기록합니다.

저장된 초안을 열면 상세 아래에 ‘발송 조건 미리보기’ 버튼이 나타나며, 누를 때마다 [발송 조건·비용 미리보기](#발송-조건비용-미리보기) API를 한 번 조회합니다.
초안을 열 때 자동으로 조회하지 않습니다.
보관된 초안도 미리볼 수 있습니다.
미리보기는 저장된 초안을 읽으므로 저장하지 않은 입력이 있거나, 조회·저장 중이거나, 버전 충돌·결과 불명 요청이 남아 있으면 버튼을 비활성화합니다.
조회 중에는 버튼을 비활성화하고 `aria-busy`를 표시합니다.

결과 위에 두 사실을 사유별 수와 분리한 경고로 표시합니다: `channel_marketing_supported`가 거짓이면 ‘Instagram 마케팅 발송은 아직 지원하지 않습니다.’, `global_send_enabled`가 거짓이면 ‘서비스 전체 발송이 꺼져 있습니다.’입니다.
2026-10-27부터 `channel_marketing_supported`가 참이므로 첫 경고는 표시되지 않습니다.
경고 영역은 문서에 미리 둔 `role="status"` 실시간 영역이며, 기존 카드의 상태 줄과 같은 방식으로 안내됩니다.
요약은 원래 인원, 현재 남은 인원, 예상 공급자 호출 수(`estimated_provider_calls`), 요금제 일괄 발송 한도(`null`이면 ‘정해지지 않음’)와 작업 공간 시간대로 표시한 기준 시각(`as_of`)입니다.
사유별 표는 열 머리글(조건·인원)과 행 머리글이 있는 표이며, API 순서대로 연결 발송 불가·자동화 중지·확인된 DM 대화 없음·수신 거부·마케팅 동의 없음·24시간 응답 창 닫힘·조건 통과의 일곱 행을 보여 줍니다.
`candidate`는 항상 ‘조건 통과’로 표시하며, 미리보기 화면 어디에도 ‘발송 가능’이라는 표현을 쓰지 않습니다.
표 아래에는 실제로 보낼 때 모든 조건을 다시 확인한다는 안내를 둡니다.
수는 API의 10진 문자열을 `BigInt`로 자릿수 구분만 더해 표시하므로 2^53을 넘어도 반올림하지 않으며, 10진 문자열이 아니거나 기준 시각을 읽을 수 없는 응답은 아무것도 그리지 않고 일반 조회 실패 안내를 표시합니다.

입력 변경, 저장, 보관, 다른 초안 열기, 새 초안 시작, 세션·작업 공간 변경, 다른 탭의 세션 신호와 뒤로 가기 복원은 미리보기를 지우고 늦은 응답을 버립니다.
기존 화면의 세대(`generation`)와 요청별 번호(목록·상세와 같은 방식의 미리보기 요청 번호)를 사용하며, 세션 계열 신호는 기존 초기화(`reset`)를 거칩니다.
응답의 `draft_id`가 지금 열린 초안이 아니거나 `draft_version`이 열린 초안의 버전과 다르면 그리지 않고 저장된 값을 다시 불러오도록 안내합니다.
401·403은 기존 권한 상실 처리로 화면 전체를 지우며, 404·429·네트워크 오류는 기존 초안 화면의 안내 문구를 미리보기 상태 줄에 표시합니다.
조회이므로 결과 불명을 잠그지 않으며 다시 누르면 새로 조회합니다.
화면 변경에는 서버·스키마·migration·의존성 변경이 없습니다.

## 승인 경계

새 저장 모델과 API 범위에 대한 방향 승인을 받았습니다.
운영 DB·배포·실계정·발송·가격 정책은 이번 `pr-loop` 구현 범위에서 제외합니다.
초기 API 변경은 화면이 없었으며, 후속 관리 화면의 로컬 검증과 전체 이슈의 운영 수용은 구분합니다.

## 선례 조회

개인 `auto-chatter`의 `campaign draft`, `plan entitlements` 및 축소 검색에서 관련 Oracle 결과는 \[no precedent found\]였습니다.
Provider sourceCommit은 `c1681868ac634e4b2414874716bb75a7864113c4`이며 원본 최신성은 미확인입니다.
현재 이슈·고정 대상·요금제 계약을 제안 근거로 사용하며 선례 조회를 방향 승인으로 취급하지 않습니다.

The shared API wrapper checks the captured workspace generation before starting authentication refresh after a 401 and before replaying the original request.
A session invalidated in either interval must reject the retired request without replaying its original input; an unchanged session retains the existing one-refresh retry.
Cookie-changing authentication requests take an exclusive Web Lock; all protected requests, including initial attempts, take a shared lock. Protected requests recheck their session before sending and after reading all parsed JSON responses (including errors) or successful text bodies, while same-session protected requests can run concurrently. A document-local accepted revision also rejects new input from an old UI after another tab completes login, even before its broadcast arrives. Explicit reload replaces the document instead of adopting another account inside an existing UI. A localStorage pending/ready revision rejects queued work from an older or incomplete account transition before it sends. Automatic refresh is disabled without Web Locks or usable shared storage; explicit login remains available when Web Locks is unsupported, while storage publication failures prevent coordinated cookie-changing requests. This protects the tested active-document schedule; it does not establish server-side fencing of requests from closed or older clients. See [verification and limits](../notes/2026-10-22-auth-cookie-response-order.md).
