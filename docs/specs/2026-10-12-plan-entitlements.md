# 요금제 권한: 멤버 자리, 계정 연결, 월 캠페인 발송 한도

## 범위

[이슈 #52](https://github.com/AndrewDongminYoo/auto-chatter/issues/52)의 첫 단계입니다.
결제 공급자와 무관한 서버 쪽 요금제 계약을 두고, 그 위에 멤버 자리 한도와 Instagram 계정 연결 한도를 적용합니다.
활성 연락처([#51](https://github.com/AndrewDongminYoo/auto-chatter/issues/51)), AI 예산, 초과 사용 승인, 청구월과 결제를 통한 요금제 변경([#54](https://github.com/AndrewDongminYoo/auto-chatter/issues/54))은 이 문서의 범위가 아닙니다(아래 [#52에 남은 일](#52에-남은-일)).
migration 045가 열 하나와 CHECK 하나를 더하며, 운영 DB 적용과 배포는 이 PR의 범위가 아닙니다.
2026-11-09에 두 번째 단계로 [월 캠페인 발송 한도](#월-캠페인-발송-한도)를 더했습니다. 이 단계는 migration을 더하지 않습니다.

## 요금제 목록

요금제 키와 한도는 코드의 상수 하나(`src/app/plans.ts`의 `PLANS`)에만 있습니다.
DB에는 같은 키를 나열한 CHECK(`workspaces_plan`) 하나만 있으며, `plans.db.test.ts`가 두 목록이 같은지 확인합니다.

| 키          | 화면 이름  | 멤버 자리 | Instagram 계정 연결 | 월 캠페인 발송 (`campaign_sends_per_month`) |
| ----------- | ---------- | --------- | ------------------- | ------------------------------------------- |
| `free`      | 무료       | 1         | 1                   | 0 (캠페인 승인 불가)                        |
| `essential` | 에센셜     | 2         | 2                   | 1,000                                       |
| `pro`       | 프로       | 3         | 3                   | 5,000                                       |
| `business`  | 비즈니스   | 5         | 5                   | 20,000                                      |
| `advanced`  | 어드밴스드 | 10        | 10                  | 50,000                                      |

멤버 자리는 ManyChat 2026 요금제의 사용자 좌석을 따릅니다([ManyChat 조사](../notes/2026-09-25-manychat-research.md)의 기준 표).
ManyChat은 채널 종류의 수를 세지만 이 서비스의 채널은 Instagram 하나이므로, 연결 한도는 연결된 Instagram 계정 수를 셉니다.
기존 작업 공간은 `advanced`, 새로 만드는 작업 공간은 `free`로 시작합니다.

## 무엇을 세는가

- **멤버 자리** = 작업 공간의 활성 멤버(`removed_at IS NULL`, 소유자 포함) + 열린 초대(수락·취소되지 않았고 만료되지 않은 초대, `expires_at > now()`). 초대를 취소하거나 만료되거나 멤버를 제거하면 그 자리는 바로 비며, 수락된 초대는 멤버로 한 번만 셉니다.
- **월 캠페인 발송**은 [아래 절](#월-캠페인-발송-한도)에서 정의합니다.
- **연결된 계정** = 작업 공간의 `instagram_connections` 가운데 토큰을 가졌거나(`access_token_encrypted IS NOT NULL`) 활성인(`active`) 행. 연결 해제와 Meta 권한 해제 콜백은 둘 다 지우므로 그 행은 세지 않습니다. 토큰이 만료됐거나 재연결이 필요한 계정, 웹훅 구독에 실패해 비활성으로 남은 계정은 토큰을 가지고 있으므로 연결 해제 전까지 셉니다.

## 적용 위치

모든 검사는 작업 공간 행을 잠근 트랜잭션 안에서 세고, 한도에 닿으면 `409`로 거절하며 아무것도 쓰지 않습니다.

| 경로                                      | 거절 조건                                                               | 코드                           | 작업 공간 행 잠금                           |
| ----------------------------------------- | ----------------------------------------------------------------------- | ------------------------------ | ------------------------------------------- |
| `POST /api/workspace/invites`             | 멤버 + 열린 초대 ≥ 멤버 자리                                            | `409 seat_limit_reached`       | `FOR UPDATE`(기존 `lockWorkspaceForMember`) |
| `POST /api/invites/accept`                | 멤버 ≥ 멤버 자리                                                        | `409 seat_limit_reached`       | `FOR NO KEY UPDATE`(전에는 `FOR SHARE`)     |
| `GET /api/instagram/callback`(OAuth 완료) | 이 작업 공간에 연결되지 않은 계정이고, 그 계정을 뺀 연결 수 ≥ 연결 한도 | `409 connection_limit_reached` | `FOR NO KEY UPDATE`(전에는 `FOR SHARE`)     |

- 초대 생성은 같은 이메일의 열린 초대를 취소한 뒤 세므로, 이미 초대한 이메일에 새 링크를 만들 때는 자리가 더 들지 않습니다. 작업 공간마다 열린 초대 20개 한도(`invite_limit_reached`)는 그대로 두지만, 가장 큰 요금제의 자리가 10개라 지금 목록으로는 닿지 않습니다.
- 수락은 초대가 만들어질 때 이미 세었지만, 요금제를 낮춘 뒤나 한도가 생기기 전에 만든 초대가 자리보다 많으면 넘칠 수 있어 다시 셉니다. 확인 순서는 응답을 잃은 재시도의 성공, 사용·취소·만료, 이메일 불일치, `already_member`, `workspace_not_empty` 다음입니다. 거절된 초대는 쓰이지 않고 열린 채로 남습니다.
- OAuth 완료는 이미 이 작업 공간에 연결된 계정의 재인증을 거절하지 않습니다. 연결이 해제된 행을 다시 연결하는 것은 새 연결로 셉니다. 다른 작업 공간이 가진 계정은 기존대로 `409 instagram_account_already_connected`를 받으며, 다른 작업 공간의 연결은 이 작업 공간의 수에 들어가지 않습니다. 이 거절은 INSERT의 `ON CONFLICT`에 맡기지 않고 그 계정의 행을 읽은 직후에 합니다. 그 행은 잠그지 않으므로, 읽은 뒤 행의 삭제가 커밋되면 INSERT가 한도 확인 없이 새 연결을 만들 수 있기 때문입니다.
- 콜백은 브라우저 이동이므로 `connection_limit_reached`도 권한 거부와 같이 `303`으로 `/app/?instagram=connection_limit_reached`에 돌아오고 OAuth 쿠키를 지웁니다.

### 잠금

잠금 순서는 바뀌지 않았고, 수락과 OAuth 완료가 작업 공간 행에 거는 잠금의 세기만 바뀌었습니다.
수락이 먼저 잡는 사용자별 advisory 잠금을 빼면 작업 공간 행 잠금은 어느 경로에서든 처음 잡는 행 잠금이므로(`delete_workspace_data`, 멤버 제거, 인박스 상태 변경도 같음), 세기를 올려도 새로운 교착 순서가 생기지 않습니다.
`FOR NO KEY UPDATE`는 같은 잠금, `FOR UPDATE`, `FOR SHARE`와 충돌하므로 두 수락, 두 OAuth 완료, 수락과 초대 생성이 차례로 실행되어 둘 다 같은 수를 보고 통과할 수 없습니다.
`FOR UPDATE`와 달리 외래 키 검사의 `FOR KEY SHARE`와는 충돌하지 않으므로, 연결 행을 `FOR SHARE`로 잡은 채 작업 공간을 참조하는 행을 쓰는 수신 처리와 교착하지 않습니다.
OAuth 완료는 공급자 호출로 계정 ID를 알게 된 뒤에만 셀 수 있으므로, 토큰 교환 전에 미리 거절하면 한도에서 연결된 계정의 재인증까지 막게 됩니다. 그래서 OAuth 시작(`beginInstagramOAuth`)은 한도로 거절하지 않고, 화면도 연결 버튼을 끄지 않고 안내만 합니다.

## 월 캠페인 발송 한도

2026-11-09에 결정한 한도입니다. 위 [요금제 목록](#요금제-목록)의 `campaign_sends_per_month`가 값이며, `free`는 0이므로 캠페인을 승인할 수 없습니다.

### 발송 수를 세는 방법

- **달**은 작업 공간의 현재 시간대(`workspaces.time_zone`)로 본 달력 달입니다. 경계는 그 시간대의 1일 0시이며, 연락처 필터의 달력 기간과 같은 `date_trunc('month', … AT TIME ZONE 시간대)` 계산입니다.
- **사용한 발송**(`used`) = 그 달 안에 `started_at`이 있는 실행의 `campaign_deliveries` 행 수입니다. 공급자를 한 번도 호출하지 않고 취소된 행(`status='cancelled' AND provider_called_at IS NULL`)은 빼고, 그 밖의 모든 상태(대기, 보내는 중, 보냄, 실패, 차단, 결과 불명, 공급자 호출 뒤 취소)는 셉니다. 다른 것은 세지 않습니다.
- **예약된 발송**(`reserved`) = 유효한 승인(`status='approved'`)들의 저장된 `preview_counts.candidate` 합입니다. 승인은 기한이 되는 달에 셉니다. 즉시 승인과, 예약 시각이 지났지만 아직 시작하지 않은 승인은 지금 달에 셉니다(`greatest(coalesce(scheduled_at, now()), now())`). 승인은 지난 달에 시작할 수 없기 때문입니다.
- 한 SQL(`src/app/plans.ts`의 `campaignSendAllowance`)이 승인, 예약 변경, 실행 시작, 미리보기, 설정 화면의 수를 모두 셉니다.

### 검사 위치

| 경로                                               | 거절 조건                                                                                        | 결과                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `POST /api/campaign-drafts/:id/approvals`          | 한도가 0이거나, 기한 달의 `used` + 다른 유효한 승인의 `reserved` + 이 승인의 후보 수 > 한도      | `409 broadcast_limit_reached`, 아무것도 쓰지 않음                          |
| `PUT /api/campaign-approvals/:id/schedule`         | 기한 달이 바뀔 때만, 새 달에서 위와 같은 조건(이 승인은 `reserved`에서 빼고 저장된 후보 수로 셈) | `409 broadcast_limit_reached`와 바뀌지 않은 `approval`, 아무것도 쓰지 않음 |
| `campaign_start` cron 단계(`startDueCampaignRuns`) | 한도가 0이거나, 시작 달의 `used` + 다른 유효한 승인의 `reserved` + 이번 시작의 후보 수 > 한도    | 실행 전체를 시작하지 않음(아래)                                            |

- 승인의 후보 수는 같은 트랜잭션에서 평가한 미리보기의 `candidate`입니다. 후보가 0명인 승인도 한도 0에서는 거절합니다.
- 같은 달 안에서 예약 시각만 바꾸는 변경은 다시 세지 않습니다. 그래서 요금제를 낮춘 뒤에도 유효한 승인의 시각은 같은 달 안에서 바꿀 수 있습니다.
- 실행 시작은 승인과 같은 수를 다시 셉니다. 시작하는 승인 자신은 `reserved`에서 빼고, 같은 달에 기한이 되는 다른 유효한 승인의 `reserved`는 더합니다. 그래서 후보가 늘어난 실행은 다른 승인이 승인받은 몫을 쓰지 못합니다.
- 거절 본문은 `{"error":"broadcast_limit_reached","broadcast_limit":{"month","limit","used","reserved","remaining","requested"}}`입니다. 예약 변경 거절은 `approval`도 담습니다. 수는 10진 문자열이고 `remaining`은 0보다 작아지지 않습니다.

### 한도로 시작하지 않은 실행

시작 시점에 후보가 남은 수를 넘으면 실행은 발송 행을 하나도 쓰지 않습니다. 일부만 보내지 않습니다.
migration 없이 기존 표에 기록합니다.

- `campaign_runs` 행을 `status='completed'`, `version=1`로 만들고, `start_counts`는 그 시작에서 평가한 아홉 수를 그대로 두되 `candidate`를 `"0"`으로 바꾸고 표시 키 네 개를 더합니다: `plan_limit_exceeded`(평가된 후보 수), `plan_limit`(시작 시점의 한도), `plan_limit_used`(시작 시점의 `used`), `plan_limit_reserved`(시작 시점에 다른 승인이 예약한 `reserved`). 기존 `?&` CHECK는 아홉 키만 요구하므로 그대로 통과합니다. 일곱 사유와 `plan_limit_exceeded`의 합은 `remaining_member_count`와 같고, `candidate`는 발송 행 수(0)와 같습니다.
- 승인은 보통 시작과 같이 `executed`가 되므로 다시 시작하지 않습니다. 그 초안 버전도 실행된 버전이므로, 같은 버전을 다시 승인하면 `409 campaign_version_executed`입니다. 다시 보내려면 초안을 수정하고 다시 승인합니다.
- 승인 목록과 상세 응답의 `run_limited`는 이 실행이면 `true`, 다른 실행이면 `false`, 실행이 없으면 `null`입니다. 승인 영역은 이 실행의 승인을 ‘실행을 시작하지 않음 · 이번 달 캠페인 발송 한도 초과’로 보이고, 같은 버전의 재승인 거절에는 아무에게도 보내지 않았다는 문구를 보입니다.
- `GET /api/campaign-runs/:id`는 `start.broadcast_limit_exceeded: {candidate, limit, used, reserved}`로 이유를 돌려주고, 다른 실행은 `null`입니다. 실행 현황 화면은 상태를 ‘시작하지 않음 · 이번 달 캠페인 발송 한도 초과’로 보이고 이유를 한 줄로 보여 줍니다.

### 캠페인 한도의 잠금

승인 생성, 예약 변경, 실행 시작은 모두 작업 공간 행을 `FOR UPDATE`로 가장 먼저 잡은 트랜잭션 안에서 셉니다(승인 API는 `lockWorkspaceForMember`, 시작은 `startOne`의 첫 문장). 새 잠금이나 새 잠금 순서는 없습니다.
그래서 두 승인, 또는 승인과 시작이 같은 수를 보고 둘 다 통과할 수 없습니다.

### 알려진 경계

- 연결·사람·작업 공간 데이터 삭제 함수는 `campaign_deliveries` 행을 지우므로, 삭제한 행만큼 그 달의 `used`가 줄어듭니다. 개인 답장의 시간당 예산처럼 지운 행을 이월하는 기록은 없으며, 이월하려면 migration이 필요해 이 단계에서 다루지 않습니다.
- 작업 공간 시간대를 바꾸면 달의 경계도 바로 바뀝니다. 저장된 시각은 움직이지 않습니다.
- 승인의 `reserved`는 승인 시점의 후보 수이므로, 시작 시점의 후보 수와 다를 수 있습니다. 시작 검사가 최종입니다.
- 시작 검사는 기한 순서로 몫을 나누지 않습니다. 예를 들어 한도를 낮춘 뒤 같은 달의 두 승인이 각각 600을 예약했고 새 한도가 1,000이면, 먼저 기한이 된 승인은 다른 승인의 600 때문에 시작하지 않고, 나중 승인은 앞 승인이 `executed`가 되어 `reserved`에서 빠진 뒤 시작할 수 있습니다.

## 요금제를 낮출 때

이미 있는 멤버, 열린 초대, 연결된 계정은 한도를 넘어도 그대로 남고, 새로 더하는 것만 거절합니다.
유효한 캠페인 승인도 그대로 남고 같은 달 안의 시각 변경과 취소를 할 수 있으며, 실행 시작 검사가 보낼지 정합니다. 기존 데이터는 지우지 않습니다.
연결된 계정의 재인증과 멤버 제거, 초대 취소, 연결 해제는 계속 할 수 있습니다.

## 요금제 변경

요금제를 바꾸는 API와 화면은 없습니다. 관리자 연결로 다음 문장을 실행합니다.

```sql
UPDATE public.workspaces SET plan = 'pro' WHERE id = '<workspace uuid>';
```

CHECK에 없는 키는 `23514`로 거절됩니다.
서버 역할(`auto_chatter_server`, Compose의 `automations_app`)은 `workspaces`에 표 단위 INSERT·UPDATE 대신 열 단위 권한만 받습니다: INSERT는 `id`와 `time_zone`, UPDATE는 `time_zone`(`deploy/supabase-access.sql`, `deploy/init-app-user.sh`).
그래서 서버 역할은 `plan`을 정하거나 바꿀 수 없고(`42501`), 행 잠금(`FOR UPDATE`·`FOR NO KEY UPDATE`·`FOR SHARE`)은 `time_zone`의 UPDATE 권한으로 계속 걸 수 있습니다. 서버가 쓰는 `workspaces` 열을 새로 더하면 두 파일의 열 권한에도 더해야 합니다.

## API와 화면

`POST /api/workspace`(모든 역할)와 `GET /api/workspace/members`(소유자)의 응답에 다음이 더해집니다.

```json
{
  "plan": "pro",
  "limits": { "seats": 3, "connections": 3, "campaign_sends_per_month": 5000 },
  "usage": { "seats": 2, "connections": 1, "campaign_sends": 120 }
}
```

`usage.seats`는 멤버와 열린 초대의 합, `usage.connections`는 연결된 계정 수이며 위 정의와 같은 SQL로 셉니다. `usage.campaign_sends`는 지금 달의 `used`이며 `reserved`를 더하지 않습니다.
설정 화면은 요금제 이름과 세 사용량을 한 줄로 보여 줍니다(`public/app/plan-labels.js`). 한도가 0인 요금제는 ‘캠페인 발송 불가’로 보이고, 요금제를 낮춘 달에 발송한 행이 있으면 그 수를 함께 보입니다.
캠페인 미리보기의 `plan_broadcast_limit`과 승인·실행 화면의 문구는 [캠페인 초안 계약](2026-10-21-campaign-drafts.md#비용)과 [캠페인 실행 계약](2026-10-27-campaign-runs.md#실행-현황-화면)에 있습니다.
멤버 자리가 다 차도 초대 버튼은 그대로 두고, 새 이메일은 초대할 수 없지만 이미 초대한 이메일로는 새 링크를 만들 수 있다고 자리를 비우는 방법과 함께 안내합니다. 연결 한도에서도 연결 버튼을 그대로 두고 재연결은 되지만 새 계정은 안 된다고 안내합니다.
초대받은 사람이 수락에서 `seat_limit_reached`를 받으면 소유자용 문구 대신, 소유자에게 자리를 요청한 뒤 받은 초대 링크를 다시 열라는 문구를 보여 줍니다. 거절된 초대는 열린 채로 남으므로 그 링크는 만료나 취소 전까지 다시 쓸 수 있습니다.
세 오류 코드(`seat_limit_reached`, `connection_limit_reached`, `broadcast_limit_reached`)는 `errors` 표의 한국어 문구로 보여 주며, 콜백에서 돌아온 `connection_limit_reached`도 같은 문구로 알립니다.
Supabase 로그인이 없는 로컬 환경에서는 실제 브라우저로 이 화면을 확인하지 않았습니다. 문구와 한도 판단은 `plan-labels.test.ts`가 확인합니다.
작업 공간 내보내기는 `workspaces` 행 전체를 내보내므로 `plan`도 함께 나갑니다.

## 배포 순서

migration 045(`deploy/migrate-multi-user.sql`로 적용)를 코드보다 먼저 적용합니다.
migration을 먼저 적용하면 기존 작업 공간은 `advanced`가 되고, 그 뒤 지금 코드가 만드는 작업 공간은 `free`로 시작합니다. 지금 코드는 열을 읽지 않으므로 바뀌는 것은 작업 공간 내보내기에 `plan`이 더해지는 것과 서버 역할의 `workspaces` 권한이 열 단위로 좁아지는 것뿐이며, 지금 코드가 쓰는 열은 `id`와 `time_zone`뿐입니다.
코드를 먼저 배포하면 `plan`을 읽는 다음 문장이 `42703`(열 없음)으로 실패합니다.

- `POST /api/workspace`(`currentWorkspace`): 모든 사용자의 대시보드가 열리지 않습니다.
- `GET /api/workspace/members`: 소유자의 멤버 화면이 열리지 않습니다.
- 초대 생성과 수락: 둘 다 실패합니다.
- OAuth 완료: 이 작업 공간에 연결되지 않은 계정의 연결이 공급자 호출 뒤에 실패합니다. 이미 연결된 계정의 재인증은 `plan`을 읽지 않으므로 성공합니다.

## API 기본 요청 한도와의 관계

[API 기본 요청 한도](2026-10-12-api-request-limits.md)(#193)는 이 변경으로 바뀌지 않으며 요금제와 무관하게 같은 값입니다.
요금제별 요청 한도는 이후 단계에서 정합니다.

## #52에 남은 일

- 활성 연락처 계량과 한도([#51](https://github.com/AndrewDongminYoo/auto-chatter/issues/51)).
- AI 사용 예산.
- 초과 사용 상한과 경고, 초과 승인.
- 청구월과 결제를 통한 요금제 변경([#54](https://github.com/AndrewDongminYoo/auto-chatter/issues/54)).

## 검증

1. `plans.db.test.ts`: CHECK와 `PLANS` 키 일치, 새 작업 공간의 `free`, migration 045의 기존 행 `advanced`와 반복 적용 시 바뀐 요금제 유지, 초대 생성·수락의 경계, 같은 이메일 재초대·취소·만료·멤버 제거로 비는 자리, 요금제를 낮춘 뒤 남는 멤버와 연결, 연결 한도(새 계정 거절, 재인증 허용, 해제한 행의 재연결은 셈, 다른 작업 공간 영향 없음), API 응답의 `plan`·`limits`·`usage`, 콜백의 `303` 복귀를 확인합니다.
2. 동시성: 한 초대 생성(또는 수락, OAuth 완료)이 수를 센 뒤 INSERT에서 멈춘 동안 시작한 두 번째 요청은 작업 공간 행에서 기다렸다가 자리가 찬 것을 보고 거절됩니다. 초대 생성은 커밋하지 않은 다른 트랜잭션이 같은 이메일의 취소된 초대를 다시 열어 둔 채로 멈춥니다. 수락과 OAuth 완료의 잠금을 `FOR SHARE`로 되돌리거나 초대 생성의 `FOR UPDATE`를 빼면 두 요청이 모두 성공해 해당 테스트가 실패합니다.
   다른 작업 공간이 가진 계정의 행을 커밋하지 않은 삭제로 붙잡은 채 그 계정의 OAuth 완료를 시작하면 바로 `instagram_account_already_connected`로 거절됩니다. 거절을 INSERT에 맡기면 삭제가 커밋된 뒤 한도를 넘는 연결이 생겨 그 테스트가 실패합니다.
3. `access.db.test.ts`: 두 서버 역할이 `plan`을 쓰지 못하고(`42501`), `time_zone`을 바꾸고 행을 잠글 수 있는지 확인합니다.
4. `plan-labels.test.ts`: 목록의 모양(월 캠페인 발송 키 포함), 요금제 이름, 캠페인 발송을 포함한 사용량 문구, 한도 안내, 세 오류 코드의 한국어 문구, 초대받은 사람의 수락 거절 문구, 자리가 다 차도 초대 버튼을 끄지 않는 것을 확인합니다.
5. 월 캠페인 발송 한도: `campaign-approvals.db.test.ts`는 한도를 넘는 승인의 `409`와 아무것도 쓰지 않음, 정확히 한도까지의 승인, 공급자 호출 없이 취소된 행의 제외, 같은 달 유효한 승인의 `reserved`, 다음 달 예약, 다른 달로 옮기는 예약 변경의 거절과 같은 달 안의 변경 허용, `free`의 거절(후보 0명 포함), 작업 공간 행을 기다린 두 승인 중 하나만 통과함을 확인합니다. `campaign-runs.db.test.ts`는 후보가 늘어난 시작과 요금제를 낮춘 뒤의 시작이 발송 행 없는 `completed` 실행과 표시 키를 남기고 승인을 `executed`로 바꾸는 것을 확인합니다. `campaign-draft-preview.db.test.ts`는 `Asia/Seoul` 달 경계(1일 0시 1µs 전의 실행은 지난달, 0시의 실행은 이번 달)와 미리보기의 `plan_broadcast_limit`을, `plans.db.test.ts`는 설정의 `usage.campaign_sends`를 확인합니다. `campaign-drafts.test.ts`는 미리보기·승인 거절·실행 현황 문구를 확인합니다.
