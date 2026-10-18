# 세그먼트 DM 동의 기록 조건 검증

## 결과와 범위

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 [DM 동의 기록](../specs/2026-10-16-segment-consent-state.md#dm-동의-기록) 조건을 로컬에서 검증했습니다.
기준 커밋은 `289f069`이며, 검증한 것은 이 작업 트리의 미커밋 변경입니다.
이 기록은 운영 마이그레이션·배포나 #26 전체 완료를 뜻하지 않습니다.
마이그레이션 058을 추가했고 운영 DB에는 적용하지 않았습니다.

## 자동 검사

| 검사                            | 읽는 대상과 확인 결과                                                             |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `corepack pnpm check-types`     | TypeScript 타입과 모듈 계약, 통과                                                 |
| `corepack pnpm test`            | 모의 요청·정책·API 입력 계약, 323개 통과                                          |
| `corepack pnpm test:db`         | UTF-8 PostgreSQL 17의 실제 쿼리·스냅샷 계약, 692개 통과                           |
| `corepack pnpm test:cloudflare` | 실제 workerd와 제한된 `auto_chatter_server` 역할, 79개 통과                       |
| `trunk fmt`, `trunk check --ci` | prettier·markdownlint·yamllint·osv-scanner·trufflehog 형식과 정적 검사, 문제 없음 |

확인된 DM 대화의 정의는 `verifiedDmRecipientsSql` 하나로 옮겼고, 연락처 상세는 그 결과에서 자기 댓글 참여자의 행만 읽습니다.
옮긴 뒤 `src/app/contact-details.db.test.ts` 7개를 수정 없이 실행해 모두 통과했습니다.
기존 테스트 중 바뀐 것은 매개변수 위치를 직접 적은 곳뿐입니다.
목록 술어의 값 개수 15→17(`src/app/api.test.ts` 세 곳)과 내보내기 시계 위치 `$17`→`$19`(`src/app/contact-csv.db.test.ts` 세 곳)입니다.

단위 검사는 DB를 열기 전의 요청 계약을 확인합니다.

- 두 목적·세 상태 쌍은 술어 값의 16·17번째 위치로 전달되고, 댓글 동의 위치는 비어 있습니다.
  응답 제외 키 순서는 `dm_identity`·`dm_consent`·태그·필드·둘 다이며, 댓글 동의를 함께 지정하면 `consent`가 앞에 옵니다.
- 한 키 누락·빈 값·`all`·허용되지 않은 상태·대문자는 `400 invalid_contact_consent`, 중복 키는 400이며 DB를 열지 않습니다.
  `segment_id`와 섞으면 `400 invalid_contact_request`입니다.
- 생성·수정 파서는 쌍을 같은 값으로 읽고, 둘 다 생략하거나 null이면 조건이 없으며, 한쪽만 있거나 잘못된 값이면 거절합니다.

DB 검사(`src/app/segment-dm-consent.db.test.ts`)는 한 계정의 댓글 참여자 9명, 같은 작업 공간의 두 번째 계정, 받은 메시지함을 켠 적 없는 계정, 다른 작업 공간으로 다음을 확인합니다.

- 확인된 DM 대화가 없는 경우마다 `excluded.dm_identity`로 세고 `no_record`에 넣지 않습니다.
  보낸 답장 없음, 받은 메시지함 활성화 전에만 보낸 답장, 오래된 답장을 포함해 두 참여자에게 연결된 DM 상대, 저장된 DM이 없는 상대, 다른 계정에서만 연결된 같은 숫자 ID(같은 숫자의 DM 상대 기록 포함), 받은 메시지함을 켠 적 없는 계정이 해당합니다.
- 두 목적·세 상태마다 목록·미리보기의 일치 연락처와 제외 수를 비교합니다.
  철회 뒤 재동의는 현재 허용으로, `all` 철회는 두 목적의 철회로 비교하고, 확인된 대화 두 개 중 하나만 맞아도 포함합니다.
- 활성화 시각을 앞당기면 오래된 답장이 확인된 대화가 되고, DM을 저장하면 그 상대가 확인됩니다.
  활성화 시각이 없으면(켠 적 없는 계정과 같은 상태) 모든 연락처가 `dm_identity`로 빠집니다.
  받은 메시지함을 끄는 설정은 활성화 시각을 지우지 않으므로, 끄기만 한 계정의 확인된 대화는 이 검사가 다루지 않습니다.
- 최근 1일 활동과 댓글 동의를 함께 쓰면 제외 순서가 기간, 댓글 동의, DM 대화 없음, DM 동의 불일치입니다.
  태그/필드 OR에서도 태그가 맞는 DM 미확인·철회 연락처는 DM 제한으로 빠지며, AND의 0명 결과도 요약을 유지합니다.
  모든 미리보기에서 `evaluated = total + 제외 수 합계`입니다.
- 세그먼트 생성·목록 응답에 쌍이 있고 기존 세그먼트는 키를 생략합니다.
  `segment_id` 조회는 같은 수동 조건과 응답이 같습니다.
  1행 묶음 CSV 내보내기는 목록과 같은 연락처를 v1 열로 내보내고 DM 상대 ID가 없습니다.
  변경 없는 수정은 버전을 유지하고, 상태 변경·쌍 제거는 버전을 올리며, 오래된 버전은 현재 세그먼트와 충돌로 답합니다.
  다른 작업 공간과 보관 뒤 조회는 404입니다.
- 마이그레이션 058은 열을 지운 뒤 두 번 적용해도 기존 행과 댓글 동의 값을 보존하고, 다시 적용해도 저장한 쌍을 바꾸지 않으며, 한쪽만 있는 쌍·허용되지 않은 값·빈 문자열을 `23514`로 거절합니다.

음성 대조로 공용 관계에서 새 근거 조건(`bool_or(fresh)`), 한 참여자 조건(`count(DISTINCT sender_id)=1`), 저장된 DM 조건을 각각 지우면 이 파일의 검사 5개 중 4개가 실패했습니다.
현재 구현의 목록 술어에서 DM 동의 조건을 빼도 4개가 실패했습니다.
되돌린 뒤 모두 통과했습니다.

Worker 검사는 실제 제한 역할로 `marketing`·`no_record` DM 동의 세그먼트를 만들고, 세그먼트 목록 응답과 같은지 확인합니다.
`segment_id` 조회는 확인된 대화가 있는 `sender-1`만 반환하고 응답에 DM 상대 ID가 없습니다.
같은 계정의 `granted` 미리보기는 0명이며 `dm_consent` 1명이고, 마지막에 세그먼트를 보관합니다.

최소 재검증 명령은 다음과 같습니다.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5434/automations_test node --test --test-concurrency=1 src/app/segment-dm-consent.db.test.ts src/app/contact-details.db.test.ts
node --test --test-name-pattern='DM consent' src/app/api.test.ts
```

위 주소는 이번 검증에서 사용한 폐기 가능한 로컬 DB입니다.
다시 실행할 때는 별도로 준비한 로컬 `automations_test` 주소를 사용해야 합니다.

## 비용

아래 수치는 참고용입니다.
측정 스크립트는 저장소에 넣지 않았고, 조건마다 한 번만 실행했으며, 같은 로컬 PostgreSQL 17 클러스터(5434)를 다른 세션이 동시에 쓰고 있었을 수 있습니다.
다시 측정하려면 아래 방법을 따라 같은 모양의 데이터를 만들어야 합니다.

- 데이터: `db/schema.sql`을 적용한 격리 `automations_test` DB에 작업 공간 하나와 계정 하나(`inbox_enabled`, 활성화 시각은 하루 전)를 만듭니다.
- 연락처 N명마다 미디어 `m<n>`에 댓글 2개를 넣습니다.
- 앞쪽 B명(연결된 연락처)마다 그 미디어의 댓글 규칙, 첫 댓글에 대한 `sent` 비공개 답장(한 시간 전, 연락처마다 다른 `recipient_id`), 그 `recipient_id`가 보낸 받은 편지함 텍스트 DM 1개(현재 시각)를 넣고 `ANALYZE`합니다.
- 측정: 실제 `listContacts`에 풀을 감싼 객체를 넘기고, `evaluation AS MATERIALIZED`가 들어간 문장만 같은 바인딩으로 `EXPLAIN (ANALYZE, COSTS OFF, TIMING ON, SUMMARY ON)`을 실행해 `Execution Time`을 읽었습니다.
- 요청: `preview=true`, `preview=true&dm_consent_purpose=marketing&dm_consent_state=no_record`, `dm_consent_purpose=marketing&dm_consent_state=no_record`입니다.

| 연락처 / 연결된 연락처 | DM 조건 없는 미리보기 | DM `no_record` 미리보기 | DM `no_record` 목록 |
| ---------------------- | --------------------- | ----------------------- | ------------------- |
| 2,000 / 500            | 3.1 ms                | 3.3 ms                  | 1.4 ms              |
| 20,000 / 5,000         | 17.4 ms               | 37.3 ms                 | 17.2 ms             |

처음 구현은 연락처의 댓글 행마다 연결의 모든 후보 답장을 다시 묶는 상관 하위 질의였고, 같은 방법으로 2,000 / 500에서 미리보기가 3,990 ms였습니다.
그 구현은 이 변경에 남아 있지 않으므로 이 수치는 다시 만들 수 없습니다.
지금은 DM 동의 조건이 있을 때만 한 문장에서 확인된 대화를 한 번 계산(`dm_verified`)하고 연락처를 상관 없는 `IN` 목록과 비교합니다.
이 수치는 로컬 Mac mini의 합성 데이터이며 운영 규모의 시간이나 페이지 크기로 비용이 제한된다는 뜻이 아닙니다.

## 화면

`public/app/app.js`를 실행하는 테스트 도구는 저장소에 없습니다.
화면 코드는 `node --check public/app/app.js` 문법 검사와 `trunk check`만 통과했으며, 선택 상자와 미리보기 문구는 실행해 보지 않았습니다.

[UNVERIFIED: real browser] 실제 브라우저로는 실행하지 않았습니다.
대시보드를 띄우려면 실제 Supabase 인증 세션과 workerd 실행 환경이 필요하고, 저장소의 `node_modules`에는 Playwright가 없습니다.
운영자가 확인할 항목은 다음과 같습니다.

- 댓글 동의 선택 옆에 "DM 동의 목적"과 "DM 동의 기록 상태"가 보이고, 목적을 지우면 상태도 지워지고 잠깁니다.
- 안내 문구가 확인된 DM 대화의 조건과 발송 가능 여부를 뜻하지 않는다는 점을 설명합니다.
- 미리보기가 "확인된 DM 대화 없음"과 "DM 동의 기록 조건 불일치"를 표시하고, 합계가 맞지 않는다는 오류 없이 결과를 보여 줍니다.
- 저장·선택·수정·충돌 뒤 저장된 값 표시·보관 뒤 직접 조건 전환에서 DM 쌍이 유지됩니다.
- 모바일 폭에서 늘어난 선택 상자가 겹치지 않습니다.

## 확인하지 않은 것

운영 DB, 배포된 Worker, 실제 사용자 인증과 운영 데이터, 운영 규모의 조회 시간은 확인하지 않았습니다.
전송 guard(`deliveryRecipientOptedOut`)와 동의 기록 쓰기는 바꾸지 않았으므로 다시 검증하지 않았습니다.
