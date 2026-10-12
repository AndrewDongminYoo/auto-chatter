# 요금제 권한: 멤버 자리와 계정 연결 한도

## 범위

[이슈 #52](https://github.com/AndrewDongminYoo/auto-chatter/issues/52)의 첫 단계입니다.
결제 공급자와 무관한 서버 쪽 요금제 계약을 두고, 그 위에 멤버 자리 한도와 Instagram 계정 연결 한도를 적용합니다.
활성 연락처([#51](https://github.com/AndrewDongminYoo/auto-chatter/issues/51)), AI 예산, 대량 발송, 초과 사용 승인, 청구월과 결제를 통한 요금제 변경([#54](https://github.com/AndrewDongminYoo/auto-chatter/issues/54))은 이 문서의 범위가 아닙니다(아래 [#52에 남은 일](#52에-남은-일)).
migration 045가 열 하나와 CHECK 하나를 더하며, 운영 DB 적용과 배포는 이 PR의 범위가 아닙니다.

## 요금제 목록

요금제 키와 한도는 코드의 상수 하나(`src/app/plans.ts`의 `PLANS`)에만 있습니다.
DB에는 같은 키를 나열한 CHECK(`workspaces_plan`) 하나만 있으며, `plans.db.test.ts`가 두 목록이 같은지 확인합니다.

| 키          | 화면 이름  | 멤버 자리 | Instagram 계정 연결 |
| ----------- | ---------- | --------- | ------------------- |
| `free`      | 무료       | 1         | 1                   |
| `essential` | 에센셜     | 2         | 2                   |
| `pro`       | 프로       | 3         | 3                   |
| `business`  | 비즈니스   | 5         | 5                   |
| `advanced`  | 어드밴스드 | 10        | 10                  |

멤버 자리는 ManyChat 2026 요금제의 사용자 좌석을 따릅니다([ManyChat 조사](../notes/2026-09-25-manychat-research.md)의 기준 표).
ManyChat은 채널 종류의 수를 세지만 이 서비스의 채널은 Instagram 하나이므로, 연결 한도는 연결된 Instagram 계정 수를 셉니다.
기존 작업 공간은 `advanced`, 새로 만드는 작업 공간은 `free`로 시작합니다.

## 무엇을 세는가

- **멤버 자리** = 작업 공간의 활성 멤버(`removed_at IS NULL`, 소유자 포함) + 열린 초대(수락·취소되지 않았고 만료되지 않은 초대, `expires_at > now()`). 초대를 취소하거나 만료되거나 멤버를 제거하면 그 자리는 바로 비며, 수락된 초대는 멤버로 한 번만 셉니다.
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

## 요금제를 낮출 때

이미 있는 멤버, 열린 초대, 연결된 계정은 한도를 넘어도 그대로 남고, 새로 더하는 것만 거절합니다.
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
{ "plan": "pro", "limits": { "seats": 3, "connections": 3 }, "usage": { "seats": 2, "connections": 1 } }
```

`usage.seats`는 멤버와 열린 초대의 합, `usage.connections`는 연결된 계정 수이며 위 정의와 같은 SQL로 셉니다.
설정 화면은 요금제 이름과 두 사용량을 한 줄로 보여 줍니다(`public/app/plan-labels.js`).
멤버 자리가 다 차도 초대 버튼은 그대로 두고, 새 이메일은 초대할 수 없지만 이미 초대한 이메일로는 새 링크를 만들 수 있다고 자리를 비우는 방법과 함께 안내합니다. 연결 한도에서도 연결 버튼을 그대로 두고 재연결은 되지만 새 계정은 안 된다고 안내합니다.
초대받은 사람이 수락에서 `seat_limit_reached`를 받으면 소유자용 문구 대신, 소유자에게 자리를 요청한 뒤 받은 초대 링크를 다시 열라는 문구를 보여 줍니다. 거절된 초대는 열린 채로 남으므로 그 링크는 만료나 취소 전까지 다시 쓸 수 있습니다.
두 오류 코드는 `errors` 표의 한국어 문구로 보여 주며, 콜백에서 돌아온 `connection_limit_reached`도 같은 문구로 알립니다.
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
- 대량 발송(브로드캐스트) 한도.
- 초과 사용 상한과 경고, 초과 승인.
- 청구월과 결제를 통한 요금제 변경([#54](https://github.com/AndrewDongminYoo/auto-chatter/issues/54)).

## 검증

1. `plans.db.test.ts`: CHECK와 `PLANS` 키 일치, 새 작업 공간의 `free`, migration 045의 기존 행 `advanced`와 반복 적용 시 바뀐 요금제 유지, 초대 생성·수락의 경계, 같은 이메일 재초대·취소·만료·멤버 제거로 비는 자리, 요금제를 낮춘 뒤 남는 멤버와 연결, 연결 한도(새 계정 거절, 재인증 허용, 해제한 행의 재연결은 셈, 다른 작업 공간 영향 없음), API 응답의 `plan`·`limits`·`usage`, 콜백의 `303` 복귀를 확인합니다.
2. 동시성: 한 초대 생성(또는 수락, OAuth 완료)이 수를 센 뒤 INSERT에서 멈춘 동안 시작한 두 번째 요청은 작업 공간 행에서 기다렸다가 자리가 찬 것을 보고 거절됩니다. 초대 생성은 커밋하지 않은 다른 트랜잭션이 같은 이메일의 취소된 초대를 다시 열어 둔 채로 멈춥니다. 수락과 OAuth 완료의 잠금을 `FOR SHARE`로 되돌리거나 초대 생성의 `FOR UPDATE`를 빼면 두 요청이 모두 성공해 해당 테스트가 실패합니다.
   다른 작업 공간이 가진 계정의 행을 커밋하지 않은 삭제로 붙잡은 채 그 계정의 OAuth 완료를 시작하면 바로 `instagram_account_already_connected`로 거절됩니다. 거절을 INSERT에 맡기면 삭제가 커밋된 뒤 한도를 넘는 연결이 생겨 그 테스트가 실패합니다.
3. `access.db.test.ts`: 두 서버 역할이 `plan`을 쓰지 못하고(`42501`), `time_zone`을 바꾸고 행을 잠글 수 있는지 확인합니다.
4. `plan-labels.test.ts`: 목록의 모양, 요금제 이름, 사용량 문구, 한도 안내, 두 오류 코드의 한국어 문구, 초대받은 사람의 수락 거절 문구, 자리가 다 차도 초대 버튼을 끄지 않는 것을 확인합니다.
