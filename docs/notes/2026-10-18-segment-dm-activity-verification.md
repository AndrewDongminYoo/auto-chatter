# 세그먼트 DM 활동 조건 검증

## 결과와 범위

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 [DM 활동](../specs/2026-10-16-segment-consent-state.md#dm-활동) 조건을 로컬에서 검증했습니다.
기준 커밋은 `2c91f20`이며, 검증한 것은 이 작업 트리의 미커밋 변경입니다.
이 기록은 운영 마이그레이션·배포나 #26 전체 완료를 뜻하지 않습니다.
마이그레이션 059를 추가했고 운영 DB에는 적용하지 않았습니다.

## 자동 검사

| 검사                            | 읽는 대상과 확인 결과                                                             |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `corepack pnpm check-types`     | TypeScript 타입과 모듈 계약, 통과                                                 |
| `corepack pnpm test`            | 모의 요청·정책·API 입력 계약, 325개 통과                                          |
| `corepack pnpm test:db`         | UTF-8 PostgreSQL 17의 실제 쿼리·스냅샷 계약, 697개 통과                           |
| `corepack pnpm test:cloudflare` | 실제 workerd와 제한된 `auto_chatter_server` 역할, 79개 통과                       |
| `trunk fmt`, `trunk check --ci` | prettier·markdownlint·yamllint·osv-scanner·trufflehog 형식과 정적 검사, 문제 없음 |

기존 테스트는 두 가지만 바뀌었습니다.
하나는 매개변수 위치를 직접 적은 단언으로, 목록 술어의 값 개수 17→18(`src/app/api.test.ts` 세 곳)과 내보내기 시계 위치 `$19`→`$20`(`src/app/contact-csv.db.test.ts` 네 줄)입니다.
다른 하나는 `src/app/api.test.ts`의 기존 검사 두 개에 사례를 더한 것입니다.
수정 거절 검사에 `last_dm_days` 거절 사례 세 개를, 생성·수정 공용 파서 검사에 정의 두 개를 추가했습니다.
기존 연락처·세그먼트·미리보기·DM 동의·연락처 상세 검사의 다른 단언은 바꾸지 않았고 모두 통과했습니다.

단위 검사는 DB를 열기 전의 요청 계약을 확인합니다.

- `last_dm_days` 1·30·366은 술어 값의 18번째 위치로 전달되고, 미리보기 제외 키는 `dm_identity`·`dm_activity`·태그·필드·둘 다 순서입니다.
  모든 DM·댓글 제한을 함께 지정하면 `activity`·`consent`·`dm_identity`·`dm_consent`·`dm_activity` 순서가 앞에 옵니다.
  목록과 미리보기는 `dm_activity_window`의 `from`·`before`만 반환하고, 조건이 없으면 키와 값을 생략합니다.
- 0·367·999·1000·앞자리 0·부호·소수점·지수·공백·빈 값·음수·문자는 `400 invalid_contact_activity`, 중복 키와 `segment_id` 혼합은 `400 invalid_contact_request`이며 DB를 열지 않습니다.
- 생성·수정 파서는 1–366 정수를 받고, 생략이나 null이면 조건이 없으며, 범위 밖·문자열·불리언·배열·소수·NaN은 거절합니다.
  댓글 활동의 세 형태와 함께 지정해도 두 조건을 모두 유지합니다.

DB 검사(`src/app/segment-dm-activity.db.test.ts`)는 고정 평가 시각 `2026-10-10T03:00:00.000000Z`에서 한 계정의 댓글 참여자 11명, 받은 메시지함을 켠 적 없는 계정, 다른 작업 공간으로 다음을 확인합니다.
목록은 `statement_timestamp()`를, 내보내기는 `transaction_timestamp()`를 같은 고정 시각으로 바꿔 실행했습니다.

- 3일 조건에서 시작 경계와 정확히 같은 DM은 포함하고, 1마이크로초 이전 DM과 평가 시각과 같은 DM은 제외합니다.
  버튼 응답(`postback`)만 있는 대화도 포함합니다.
  기간 밖의 오래된 DM 뒤에 기간 안 DM이 있으면 포함하고, 기간 안 DM 뒤에 평가 시각 이후 DM이 있으면 마지막 DM만 비교하므로 제외합니다.
- 보낸 답장 없음, 받은 메시지함 활성화 전에만 보낸 답장, 두 참여자에게 연결된 상대, 받은 메시지함을 켠 적 없는 계정은 최근 DM이 있어도 `excluded.dm_identity`이며 `dm_activity`로 세지 않습니다.
- 확인된 대화 두 개 중 하나만 최근 DM이 있어도 포함합니다.
  DM 동의 허용이 오래된 대화에, 최근 DM이 다른 대화에 있는 연락처도 두 조건을 함께 만족합니다.
- 최근 3일 댓글·고정 UTC 기간·이번 달 달력 기간과 함께 쓰면 기간 제외가 먼저이고, 댓글 동의와 함께 쓰면 그 다음, 이어서 DM 대화 없음과 최근 받은 DM 없음입니다.
  태그/필드 OR에서도 태그가 맞는 DM 미확인·오래된 DM 연락처는 DM 제한으로 빠지며, AND의 0명 결과도 요약을 유지합니다.
  모든 미리보기에서 `evaluated = total + 제외 수 합계`입니다.
- 응답에 DM 상대 ID와 DM 시각이 없습니다.
- 세그먼트 생성·목록 응답에 `last_dm_days`가 있고 기존 세그먼트는 키를 생략합니다.
  `segment_id` 조회는 같은 수동 조건과 응답이 같습니다.
  1행 묶음 CSV 내보내기는 모든 묶음을 `exported_at` 하나로 평가하고, 목록과 같은 연락처를 v1 열로 내보내며 DM 상대 ID가 없습니다.
  변경 없는 수정은 버전을 유지하고, 일수 변경·조건 제거는 버전을 올리며, 오래된 버전은 현재 세그먼트와 충돌로 답합니다.
  다른 작업 공간과 보관 뒤 조회는 404입니다.
- 마이그레이션 059는 열과 `instagram_inbox_messages_latest_idx`를 지운 뒤 두 번 적용해도 기존 행과 DM 동의·최근 댓글 일수 값을 보존하고 그 색인을 같은 정의로 다시 만들며, 1·366을 저장한 뒤 다시 적용해도 값을 바꾸지 않고, 0·367·-1을 `23514`로 거절합니다.

음성 대조로 `src/app/contacts.ts`를 하나씩 바꿔 이 파일의 검사 5개를 실행했습니다.
마지막 DM 대신 모든 DM 비교, 시작 경계 제외, 끝 경계 포함, DM 대화 없음 판정을 DM 동의에만 연결, 확인된 대화 계산을 DM 동의에만 연결, 목록 술어에서 DM 활동 제외의 여섯 경우 모두 3~4개가 실패했습니다.
되돌린 뒤 파일이 원본과 같음을 `cmp`로 확인했고 모두 통과했습니다.

전체 실행기도 확인했습니다.
`test:cloudflare` 뒤의 같은 폐기 가능 DB에 `psql -v ON_ERROR_STOP=1 -f deploy/migrate-multi-user.sql`을 적용하고, `last_dm_days=5` 세그먼트를 넣은 뒤 다시 적용했습니다.
두 번 모두 종료 코드 0이었고, 값과 CHECK `contact_segment_dm_activity` 하나가 남았으며, 367로 바꾸는 UPDATE는 그 CHECK로 거절되었습니다.

Worker 검사는 실제 제한 역할로 `last_dm_days=1` 세그먼트를 만들고, 세그먼트 목록 응답과 같은지 확인한 뒤 7일로 수정합니다.
`segment_id` 조회는 이번 실행에서 DM이 저장된 `sender-1`만 반환하고, `dm_activity_window`는 `from`·`before` 두 키뿐이며 응답에 DM 상대 ID가 없습니다.
같은 계정의 7일 미리보기는 1명이고 `dm_activity` 0명이며, 마지막에 세그먼트를 보관합니다.

최소 재검증 명령은 다음과 같습니다.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5434/automations_test node --test --test-concurrency=1 src/app/segment-dm-activity.db.test.ts src/app/segment-dm-consent.db.test.ts
node --test --test-name-pattern='DM activity|last_dm_days' src/app/api.test.ts
```

위 주소는 이번 검증에서 사용한 폐기 가능한 로컬 DB입니다.
다시 실행할 때는 별도로 준비한 로컬 `automations_test` 주소를 사용해야 합니다.

## 비용

아래 수치는 참고용입니다.
측정 스크립트는 저장소에 넣지 않았고, 조건마다 세 번 실행했으며, 같은 로컬 PostgreSQL 17 클러스터(5434)를 다른 세션이 동시에 쓰고 있었을 수 있습니다(측정 직전 부하 평균 5.4).
다시 측정하려면 아래 방법을 따라 같은 모양의 데이터를 만들어야 합니다.

- 데이터: `db/schema.sql`을 적용한 격리 `automations_test` DB에 작업 공간 하나와 계정 하나(`inbox_enabled`, 활성화 시각은 하루 전)를 만듭니다.
- 연락처 N명마다 미디어 `m<n>`에 댓글 2개(한 시간 전)를 넣습니다.
- 앞쪽 B명(연결된 연락처)마다 그 미디어의 댓글 규칙, 첫 댓글에 대한 `sent` 비공개 답장(한 시간 전, 연락처마다 다른 `recipient_id`), 그 상대의 받은 텍스트 DM 1개(한 시간 전)를 넣습니다.
  그중 절반의 상대에는 30일 전 DM 1개를 더 넣고 `ANALYZE`합니다.
- 측정: 실제 `listContacts`에 풀을 감싼 객체를 넘기고, `evaluation AS MATERIALIZED`가 들어간 문장만 같은 바인딩으로 `EXPLAIN (ANALYZE, COSTS OFF, TIMING ON, SUMMARY ON)`을 실행해 `Execution Time`을 읽었습니다.
- 요청: `preview=true`, `preview=true&last_dm_days=7`, `last_dm_days=7`입니다.

| 연락처 / 연결된 연락처 | DM 조건 없는 미리보기 | 7일 DM 미리보기 | 7일 DM 목록  |
| ---------------------- | --------------------- | --------------- | ------------ |
| 2,000 / 500            | 1.6–4.3 ms            | 5.0–5.1 ms      | 2.4–2.5 ms   |
| 20,000 / 5,000         | 15.4–15.8 ms          | 41.5–42.0 ms    | 19.8–20.2 ms |

2,000 / 500의 7일 DM 목록 실행계획에서 상대별 받은 DM 최댓값은 hashed SubPlan 안의 `instagram_inbox_messages_conversation_idx` 비트맵 색인 검색이었고, 문장마다 한 번 계산되었습니다.
위 표는 첫 커밋 `be9a73c`(대화마다 `max(message_at)`, 새 색인 없음)에서 잰 값입니다.
이 수치는 로컬 Mac mini의 합성 데이터이며 운영 규모의 시간이나 페이지 크기로 비용이 제한된다는 뜻이 아닙니다.

### 긴 대화 기록 (리뷰 라운드 2)

[#228 리뷰](https://github.com/AndrewDongminYoo/auto-chatter/pull/228#discussion_r4305482605)는 대화마다 `max(message_at)`을 구하면 대화 기록 전체를 읽고, 세그먼트 CSV 내보내기가 이를 25명 배치마다 반복한다고 지적했습니다.
위 데이터는 대화마다 DM이 1~2개뿐이라 이 경우를 재지 못하므로, 대화 기록이 긴 데이터로 변경 전후를 다시 쟀습니다.
측정 방법과 참고용이라는 한계는 위와 같고, 조건마다 세 번 실행했습니다.

- 데이터: 위와 같되 계정의 받은 DM 활성화 시각을 400일 전으로 두고, 연결된 연락처의 상대마다 8~207일 전의 DM 200개를 넣고, 홀수 번째 상대에만 한 시간 전 DM 1개를 더 넣은 뒤 `ANALYZE`합니다.
- 변경 전: `be9a73c`의 `max(message_at)` 술어입니다.
- 변경 후: `ORDER BY message_at DESC LIMIT 1` 술어와 마이그레이션 059의 `instagram_inbox_messages_latest_idx`입니다.

| 연락처 / 연결된 연락처 × 대화별 DM | 요청                          | 변경 전        | 변경 후      |
| ---------------------------------- | ----------------------------- | -------------- | ------------ |
| 2,000 / 500 × 200                  | `last_dm_days=7`              | 26.9–34.3 ms   | 4.2–5.9 ms   |
| 2,000 / 500 × 200                  | `preview=true&last_dm_days=7` | 51.2–52.5 ms   | 7.0–13.6 ms  |
| 2,000 / 2,000 × 200                | `last_dm_days=7`              | 106.7–173.4 ms | 14.7–24.8 ms |
| 2,000 / 2,000 × 200                | `preview=true&last_dm_days=7` | 186.2–212.9 ms | 21.1–22.3 ms |

변경 전후의 대상 수와 제외 사유는 같았습니다(500명 연결 데이터는 대상 250명·`dm_identity` 1,500명·`dm_activity` 250명, 2,000명 연결 데이터는 대상 1,000명·`dm_activity` 1,000명).
변경 후 실행계획은 `instagram_inbox_messages_latest_idx`를 사용했습니다.
내보내기는 배치마다 이 문장을 다시 실행하므로, 변경 전 2,000명 연결 데이터의 목록 시간에 배치 수를 곱하면 10초 제한에 닿을 수 있습니다. 내보내기 자체의 시간은 재지 않았습니다.
배치마다 `dm_verified`를 다시 만드는 비용은 그대로이며 [#229](https://github.com/AndrewDongminYoo/auto-chatter/issues/229)에서 다룹니다.

## 화면

`public/app/app.js`를 실행하는 테스트 도구는 저장소에 없습니다.
화면 코드는 `node --check public/app/app.js` 문법 검사와 `trunk check`만 통과했으며, 입력과 미리보기 문구는 실행해 보지 않았습니다.

[UNVERIFIED: real browser] 실제 브라우저로는 실행하지 않았습니다.
대시보드를 띄우려면 실제 Supabase 인증 세션과 workerd 실행 환경이 필요하고, 저장소의 `node_modules`에는 Playwright가 없으며 새 의존성은 추가하지 않았습니다.
운영자가 확인할 항목은 다음과 같습니다.

- DM 동의 선택 옆에 "최근 N일 안에 받은 DM" 숫자 입력이 비어 있는 상태로 보이고, 안내 문구가 확인된 DM 대화만 평가하며 텍스트와 버튼 응답을 모두 세고 발송 가능 여부나 24시간 답장 가능 시간을 뜻하지 않는다고 설명합니다.
- 0·367·숫자가 아닌 값을 넣으면 요청 전에 안내하고 보내지 않습니다.
- 목록과 미리보기 상태 문구에 "이번 DM 조회 기간(UTC)"이 표시되고, 미리보기가 "최근 받은 DM 없음"을 표시하며 합계 오류가 나지 않습니다.
- 저장·선택·수정·충돌 뒤 저장된 값 표시·보관 뒤 직접 조건 전환에서 일수가 유지되고, 입력을 바꾸면 수정 중 변경으로 표시됩니다.
- 모바일 폭에서 늘어난 입력이 겹치지 않습니다.

## 확인하지 않은 것

운영 DB, 배포된 Worker, 실제 사용자 인증과 운영 데이터, 운영 규모의 조회 시간은 확인하지 않았습니다.
확인된 DM 대화 관계(`verifiedDmRecipientsSql`), 전송 guard(`deliveryRecipientOptedOut`)와 받은 DM 저장은 바꾸지 않았으므로 다시 검증하지 않았습니다.
