# 세그먼트 CSV 내보내기 검증

## 결과와 범위

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 [저장된 세그먼트 내보내기](../specs/2026-10-04-contact-csv-export.md#저장된-세그먼트-내보내기)를 로컬에서 검증했습니다.
기준 커밋은 `baca76f`이며, 검증한 것은 이 작업 트리의 미커밋 변경입니다.
이 기록은 운영 배포나 #26 전체 완료를 뜻하지 않습니다.
마이그레이션은 추가하지 않았습니다.

## 자동 검사

| 검사                            | 읽는 대상과 확인 결과                                                             |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `corepack pnpm check-types`     | TypeScript 타입과 모듈 계약, 통과                                                 |
| `corepack pnpm test`            | 모의 요청·정책·API 입력 계약, 321개 통과                                          |
| `corepack pnpm test:db`         | UTF-8 PostgreSQL 17의 실제 쿼리·스냅샷 계약, 687개 통과                           |
| `corepack pnpm test:cloudflare` | 실제 workerd와 제한된 `auto_chatter_server` 역할, 78개 통과                       |
| `trunk fmt`, `trunk check --ci` | prettier·markdownlint·yamllint·osv-scanner·trufflehog 형식과 정적 검사, 문제 없음 |

먼저 `listContacts`에서 세그먼트 해석(`savedSegmentConditions`)과 SQL 조건(`segmentConditionSql`)만 꺼낸 상태로, 기존 `src/app/settings.db.test.ts`와 `src/app/contact-csv.db.test.ts` 159개를 수정 없이 실행해 모두 통과했습니다.
꺼낸 SQL 조각은 원래 줄과 한 줄씩 비교했고, 다른 줄은 평가 시각 식 하나(`statement_timestamp()`를 인수로 받음)뿐입니다.
목록의 WHERE에서 커서 조건이 태그 조건 앞으로 옮겨졌을 뿐, AND로 묶인 조건은 같습니다.

단위 검사는 DB를 열기 전의 요청 계약을 확인합니다.

- 빈 `segment_id`, 값 없는 키, UUID가 아닌 값, 반복한 `segment_id`, `tag`·`connection_id`·`preview`와의 혼합, 다른 키 이름(대문자 포함)은 `400 invalid_contact_export_request`이며 첨부 헤더가 없고 사용자 허용 횟수를 쓰지 않습니다.
- 소문자·대문자 UUID 하나는 검증을 통과해 전체 내보내기와 같은 `CONTACT_EXPORT_LIMIT`에 닿습니다(거절하는 제한기로 `429 contact_export_rate_limited`, DB 미사용).
- 이 단위 검사의 유효한 경우는 변경 전 라우트에서 400을 받으므로 실패합니다.

DB 검사는 활동 시각·태그·숫자/텍스트 필드·마케팅 동의 기록을 서로 다르게 가진 연락처 7명(두 번째 계정 1명 포함)으로 다음을 확인합니다.

- 단일 태그, 태그 집합 `all`·`any`, 단일 필드, 필드 집합 `all`·`any`, 태그와 필드의 OR, 고정 기간, 최근 3일, 오늘(Asia/Seoul), 동의 `granted`·`no_record`, 계정을 지정한 세그먼트 13개를 고정 시각에서 비교합니다.
  각 세그먼트마다 `listContacts(segment_id)`의 연락처를 직접 계산한 기대값과 비교하고, 내보낸 행의 계정·작성자 쌍이 그 목록과 같습니다.
  기준 시각과 같은 시각의 댓글은 최근 N일에서 빠지고 오늘에는 들어가며, 고정 기간의 끝은 포함하지 않습니다.
- 세그먼트 파일의 행은 같은 시각의 전체 내보내기 행을 같은 순서로 걸러낸 것과 셀 단위로 같습니다.
- 내보내기는 2행 묶음으로 여러 번 조회하며, 모든 묶음의 기준 시각 인수(`$17`)가 그 파일의 `exported_at`과 같습니다.
  고정하지 않은 실제 시계로 1행 묶음 8번을 조회하는 동안 묶음 사이에 지연을 넣어도 기준 시각은 하나입니다.
- 보관한 세그먼트, 없는 ID, 다른 작업 공간의 세그먼트는 `404 segment_not_found`이며 첨부 헤더가 없습니다.
  상담원은 있는 세그먼트와 없는 ID 모두 `403 role_forbidden`이고, 제거된 관리자는 `403 workspace_required`입니다.
  세그먼트 조회는 `BEGIN` 다음, 같은 트랜잭션 안에서 실행됩니다.
- 행 한도(2행)와 바이트 한도(700바이트)를 넘으면 `422 contact_export_too_large`로 전체를 거절하고 `COMMIT`하지 않습니다. 3행 한도에서는 같은 세그먼트가 3행으로 성공합니다.
- 맞는 연락처가 없는 세그먼트는 헤더만 반환하고, 파일명은 `auto-chatter-contacts-v1-segment-<소문자 ID>-YYYY-MM-DD.csv`이며 대문자 ID로 요청해도 소문자입니다.
  응답 헤더는 전체 내보내기와 같고, 본문에는 댓글 원문과 세그먼트 이름이 없습니다.
- 내보내기 전후 모든 공개 테이블의 내용이 같고 큐 알림이 없습니다.

음성 대조로 내보내기의 세그먼트 조건을 항상 참으로 바꾸면 조건별 비교 검사가 실패했고, 되돌린 뒤 통과했습니다.

Worker 검사는 실제 제한 역할로 태그 세그먼트를 만들고 `segment_id` 내보내기의 첨부 파일명과 행(모두 `lead` 태그, `sender-1` 포함, 전체 행 수 이하)을 확인한 뒤 세그먼트를 보관합니다.
상담원의 세그먼트 내보내기는 `403 role_forbidden`입니다.
전체·세그먼트 내보내기와 두 역할 거절이 같은 사용자 허용 횟수 5회 중 4회를 쓰고, 다섯 번째 뒤에 `429`가 됩니다.

최소 재검증 명령은 다음과 같습니다.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5434/automations_test node --test --test-concurrency=1 --test-name-pattern='segment export' src/app/contact-csv.db.test.ts
node --test --test-name-pattern='segment CSV export' src/app/api.test.ts
```

위 주소는 이번 검증에서 사용한 폐기 가능한 로컬 DB입니다.
다시 실행할 때는 별도로 준비한 로컬 `automations_test` 주소를 사용해야 합니다.

## 화면

`public/app/app.js`를 실행하는 테스트 도구는 저장소에 없습니다.
화면 코드는 `node --check public/app/app.js` 문법 검사와 `trunk check`만 통과했으며, 버튼 상태와 다운로드는 실행해 보지 않았습니다.

[UNVERIFIED: real browser] 실제 브라우저로는 실행하지 않았습니다.
대시보드를 띄우려면 실제 Supabase 인증 세션과 workerd 실행 환경이 필요하고, 저장소의 `node_modules`에는 Playwright가 없습니다.
운영자가 확인할 항목은 다음과 같습니다.

- 소유자·관리자에게만 "전체 연락처 CSV" 옆에 "선택한 필터로 내보내기"와 안내 문구가 보입니다.
- 저장된 필터를 고르지 않았을 때, 조건을 직접 바꿔 선택이 풀렸을 때, 필터 수정 중 조건이나 이름을 바꿨을 때, 필터 저장·보관 중, 다른 내보내기 중에는 버튼을 누를 수 없습니다.
- 내려받은 파일 이름에 세그먼트 ID가 들어가고, 행이 그 필터의 연락처 목록과 같습니다.
- 진행 중 로그아웃·작업 공간 재조회·연결 데이터 삭제·그 필터 보관은 다운로드를 취소하고 버튼을 되돌립니다.
- 모바일 폭에서 늘어난 버튼이 겹치지 않습니다.

## 확인하지 않은 것

운영 DB, 배포된 Worker, 실제 사용자 인증과 운영 데이터, 운영 규모의 내보내기 시간은 확인하지 않았습니다.
세그먼트 조건은 묶음마다 다시 평가하므로, 연락처가 많으면 전체 내보내기보다 10초 한도에 먼저 닿을 수 있습니다.
