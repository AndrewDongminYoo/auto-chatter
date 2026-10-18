# 세그먼트 중첩 조건 그룹 검증

## 결과와 범위

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 [중첩 조건 그룹](../specs/2026-09-27-contact-segments.md#중첩-조건-그룹) PR A(서버, 저장, 평가, 마이그레이션 060, 화면의 안전한 처리)를 로컬에서 검증했습니다.
기준 커밋은 `64ed390`이며, 검증한 것은 이 작업 트리의 미커밋 변경입니다.
이 기록은 운영 마이그레이션·배포나 #26 전체 완료를 뜻하지 않습니다.
마이그레이션 060을 추가했고 운영 DB에는 적용하지 않았습니다.
그룹 편집 화면은 PR B이고, 발송 대상 지정은 별도로 승인받을 후속 범위입니다.

## 자동 검사

| 검사                            | 읽는 대상과 확인 결과                                                             |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `corepack pnpm check-types`     | TypeScript 타입과 모듈 계약, 통과                                                 |
| `corepack pnpm test`            | 모의 요청·정책·API 입력 계약, 329개 통과                                          |
| `corepack pnpm test:db`         | UTF-8 PostgreSQL 17의 실제 쿼리·스냅샷 계약, 703개 통과                           |
| `corepack pnpm test:cloudflare` | 실제 workerd와 제한된 `auto_chatter_server` 역할, 79개 통과                       |
| `trunk fmt`, `trunk check --ci` | prettier·markdownlint·yamllint·osv-scanner·trufflehog 형식과 정적 검사, 문제 없음 |

기존 테스트는 두 가지만 바뀌었습니다.
하나는 매개변수 위치를 직접 적은 단언으로, 목록 술어의 값 개수 18→19(`src/app/api.test.ts` 네 곳)와 내보내기 시계 위치 `$20`→`$21`(`src/app/contact-csv.db.test.ts` 네 줄)입니다.
다른 하나는 `src/cloudflare/runtime.db.test.mjs`의 기존 workerd 연락처 API 검사에 트리 세그먼트 단계를 더한 것입니다.
기존 연락처·세그먼트·미리보기·DM·연락처 상세 검사의 다른 단언은 바꾸지 않았고 모두 통과했습니다.
새 검사는 `src/app/api.test.ts`의 검사 세 개와 새 DB 검사 파일 `src/app/segment-condition-tree.db.test.ts`의 검사 여섯 개입니다.
새 DB 검사 파일은 `test:db` 스크립트에 추가했습니다.

단위 검사(`src/app/api.test.ts`)는 DB를 열기 전의 요청 계약을 확인합니다.

- 트리는 술어 값의 19번째 위치로 전달되고, 태그·필드·연산자 위치는 `NULL`·`NULL`·`and`입니다.
  트리가 없으면 19번째 값은 `NULL`입니다.
- 태그 정규화, 필드 ID 소문자화, `negate: false` 생략, 그룹·조건 순서 유지, 같은 태그·필드 반복을 확인하고, 필드 조건은 조건 순서대로 반복을 포함해 확인합니다.
- 그룹 1·5개와 그룹별 조건 1·5개, 조건 합계 10개는 받고, 그룹 0·6개, 조건 0·6개, 합계 11개는 `400 invalid_contact_condition`입니다.
- 모르는 키(루트·그룹·태그 조건·필드 조건), 모르는 모드와 대문자 모드, 모드 누락, 배열·문자열·JSON `null`·잘못된 JSON·빈 값, 디코딩 16,385자, `negate`의 `"true"`·1·`null`·`"yes"`는 `400 invalid_contact_condition`입니다.
  16,384자는 받습니다.
- 빈 태그, 41자 태그, 문자열이 아닌 태그, 제어 문자, JSON 이스케이프로 만든 짝 없는 서로게이트는 `400 invalid_contact_tags`이고, 필드 조건 규칙 위반은 `400 invalid_field_condition`입니다.
- `tag`, `tag_mode`, 기존 필드 키 각각, `field_conditions`, `field_mode`, `condition_operator=and`와 `or`를 트리와 섞으면 `400 invalid_contact_condition`, `segment_id`와 섞거나 키를 반복하면 `400 invalid_contact_request`이며 모두 DB를 열지 않습니다.
- 트리 미리보기의 제외 키는 `activity`와 `conditions`이고 `tag`·`field`·`both`가 없습니다.
- 생성·수정 공용 파서는 `null`·빈 기존 키를 조건 없음으로 보고, 실제 값이 있는 기존 키나 `condition_operator`(`null` 포함)와 섞이면 거절합니다.
  생성은 모든 필드 조건을 반복까지 `field_id` 순으로 조회하되 서로 다른 필드마다 첫 조건에서만 `FOR SHARE`로 잡고, 트리를 22번째 값으로 저장하며, 응답에 태그·필드 키가 없습니다.
- 파서가 받는 가장 큰 정의의 본문(31,681바이트)은 기본 한도 16,384바이트를 넘지만 생성(`POST`)과 수정(`PUT`) 경로에서 413 없이 관리자 권한 확인(`403 role_forbidden`)까지 가고, 65,537바이트 본문은 두 경로 모두 `413 request_too_large`입니다.

DB 검사(`src/app/segment-condition-tree.db.test.ts`)는 고정 평가 시각 `2026-10-10T03:00:00.000000Z`에서 한 계정의 연락처 6명, 같은 작업 공간의 두 번째 계정 1명, 다른 작업 공간 1명과 텍스트·숫자·불리언·날짜 필드로 다음을 확인합니다.
목록은 `statement_timestamp()`를, 내보내기는 `transaction_timestamp()`를 같은 고정 시각으로 바꿔 실행했습니다.
기대 결과는 검사 파일 주석의 연락처 표에서 손으로 계산했습니다.

- 루트와 그룹 각각의 `all`·`any`, 태그 있음·없음(태그 행이 없는 연락처와 빈 태그 행 포함), 텍스트 `eq`·`is_set`·`is_unset`, 숫자 `gte`·`lt`, 불리언 `eq`, 날짜 `gte`·`lt`, 두 그룹의 같은 필드를 평가합니다.
  다른 작업 공간은 자기 연락처만 보고, 이 작업 공간 필드를 쓴 트리는 `404 field_not_found`입니다.
- 계정, 최근 댓글 일수, 고정 UTC 기간, 댓글 동의, DM 동의, DM 활동 제한은 트리와 AND로 묶입니다.
- 미리보기는 제한 사유 뒤에 `conditions`를 두며, 모든 제한을 함께 쓰면 `activity`·`consent`·`dm_identity`·`dm_consent`·`dm_activity`·`conditions` 순서입니다.
  모든 경우에 `evaluated = total + 제외 수 합계`이고, 0명 결과도 요약을 유지합니다.
  트리가 없으면 `tag`·`field`·`both` 키가 그대로입니다.
- 트리 세그먼트 생성·목록 응답은 `condition_tree`만 있고 태그·필드 키가 없으며, 저장 행의 태그·필드 열은 모두 `NULL`, 연산자는 `and`입니다.
  기존 태그 세그먼트의 응답은 바뀌지 않습니다.
  `segment_id` 조회는 같은 수동 조건과 응답이 같습니다.
  1행 묶음 CSV 내보내기는 모든 묶음을 `exported_at` 하나로 평가하고 목록과 같은 연락처를 내보냅니다.
  대소문자·공백·`negate: false`만 다른 같은 트리는 버전을 유지하고, 그룹 순서 변경, 조건 순서 변경, 모드 변경은 각각 버전을 올리며, 오래된 버전은 현재 세그먼트와 충돌로 답합니다.
  기존 태그로 바꾸면 트리 열이 `NULL`이 됩니다.
  형태를 섞은 생성은 거절되고 아무것도 쓰지 않습니다.
  보관 뒤 조회는 404입니다.
- 트리 안에서만 참조한 필드의 보관은 `409 field_in_use`이고, 트리가 참조하지 않는 필드와 보관한 트리 세그먼트의 필드는 보관됩니다.
  보관된 필드를 쓴 트리는 `404 field_not_found`입니다.
- 두 번째 계정을 다른 연결이 `FOR UPDATE`로 잡은 동안 트리 세그먼트 생성은 필드를 잡은 뒤 외래 키 확인에서 기다리고, 그 사이 시작한 필드 보관은 필드 잠금에서 기다린 뒤 `409 field_in_use`로 답합니다.
- 마이그레이션 060은 열을 지운 뒤 두 번 적용해도 기존 행을 보존하고, 트리 행을 넣은 뒤 060과 `db/schema.sql`을 다시 적용해도 값을 바꾸지 않습니다.
  배열·문자열·숫자·빈 객체, `groups` 누락, `mode` 누락, 모르는 모드, 그룹 0개·6개, 배열이 아닌 `groups`, 추가 루트 키는 `contact_segment_condition_tree`로, 태그·태그 집합·필드 집합이 함께 있는 트리 행은 CHECK(`23514`)로 거절합니다.
  트리 행의 `condition_operator='or'`도 `23514`입니다.
  태그와 필드가 없는 행의 OR는 `contact_segment_condition_operator`도 거절하므로, 이 경우 어느 제약이 거절했는지는 확인하지 않았습니다.

검사는 코드를 쓴 뒤에 작성했으므로, 음성 대조로 실패할 수 있음을 확인했습니다.
`src/app/contacts.ts`, `src/app/contact-fields.ts`, `db/migrations/060_segment_condition_tree.sql`을 한 번에 하나씩 바꾸고 해당 검사를 실행했습니다.
루트 `any`를 `bool_and`로, 그룹 `any`를 `bool_and`로, `negate` 무시, 목록 술어에서 트리 제외, 미리보기의 `conditions` 0 고정, 필드 보관의 트리 검사 제거, 세그먼트 쓰기의 트리 필드 잠금 제거, 060의 추가 루트 키 허용, 조건 11개 허용, GET 혼합 허용, 저장 본문 혼합 허용, `negate` 임의 값 허용, 태그 서로게이트 허용의 13개 변경 모두 1~3개 검사가 실패했습니다.
변경은 매번 원본 사본으로 되돌렸습니다.
리뷰 반영 뒤 같은 방법으로 필드 조건의 모르는 키를 `invalid_field_condition`으로 되돌리기, 반복 필드도 매번 잠그기, 생성 경로와 수정 경로 각각의 기본 본문 한도 복원의 4개 변경을 하나씩 확인했고, 모두 해당 검사가 실패했습니다.

전체 실행기도 확인했습니다.
`test:cloudflare` 뒤의 같은 폐기 가능 DB에 `psql -v ON_ERROR_STOP=1 -f deploy/migrate-multi-user.sql`을 적용하고, 트리 세그먼트 한 행을 넣은 뒤 다시 적용했습니다.
두 번 모두 종료 코드 0이었고, 트리 값과 `condition_operator='and'`, CHECK `contact_segment_condition_operator`와 `contact_segment_condition_tree`가 남았으며, 그 행에 `tag`를 넣는 UPDATE는 `contact_segment_condition_tree`로 거절되었습니다.
확인용 행은 지웠습니다.

Worker 검사는 실제 제한 역할로 트리 세그먼트(태그 `lead`와 `Plan` 필드 `eq "pro"`의 그룹, 아무도 없는 태그의 그룹)를 만들고 세그먼트 목록 응답과 같은지 확인한 뒤 그룹 순서를 바꿔 버전 2로 수정합니다.
`segment_id` 조회는 `sender-1`만 반환하고, 같은 트리의 미리보기는 1명이며 제외 키가 `conditions`뿐이고 합계가 맞으며, 마지막에 세그먼트를 보관합니다.

화면(`public/app/app.js`, `public/app/index.html`)을 실행하는 검사 도구는 저장소에 없습니다.
`[UNVERIFIED: real browser]` Playwright 브라우저 실행 파일은 이 Mac의 캐시에 있지만 Playwright 라이브러리가 프로젝트와 Python 어디에도 설치되어 있지 않고, 설치는 새 의존성이므로 실제 브라우저 확인은 하지 않았습니다.
`node --check public/app/app.js`로 구문만 확인했습니다.
트리 세그먼트 선택, 입력 비활성화와 요약, 그룹 조건 지우기, 미리보기 사유와 합계, 새 필터 저장, 수정 비활성화와 안내, 보관 뒤 직접 조건 전환은 실제 화면에서 확인해야 합니다.

최소 재검증 명령은 다음과 같습니다.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5434/automations_test node --test --test-concurrency=1 src/app/segment-condition-tree.db.test.ts
node --test --test-name-pattern='condition tree' src/app/api.test.ts
```

위 주소는 이번 검증에서 사용한 폐기 가능한 로컬 DB입니다.
다시 실행할 때는 별도로 준비한 로컬 `automations_test` 주소를 사용해야 합니다.

## 비용

아래 수치는 참고용입니다.
측정 스크립트는 저장소에 넣지 않았고, 요청마다 세 번 실행했으며, 같은 로컬 PostgreSQL 17 클러스터(5434)를 다른 세션이 동시에 쓰고 있었을 수 있습니다(측정 직전과 직후 부하 평균 약 18, 10코어).
부하가 높아 같은 요청의 세 번 사이에도 최대 세 배 차이가 났습니다.
다시 측정하려면 아래 방법을 따라 같은 모양의 데이터를 만들어야 합니다.

- 데이터: `db/schema.sql`을 적용한 격리 `automations_test` DB에 작업 공간 하나, 계정 하나, 숫자 필드 `score` 하나를 만듭니다.
- 연락처 N명(`s1`~`sN`)마다 댓글 2개(한 시간 전)를 넣습니다.
  짝수 번째는 `vip`, 4의 배수 번째는 `vip`과 `event`, 나머지는 `lead` 태그를 두고, 모든 연락처의 `score`를 n×100으로 둔 뒤 `ANALYZE`합니다.
- 측정: 실제 `listContacts`에 풀을 감싼 객체를 넘기고, `evaluation AS MATERIALIZED`가 들어간 문장만 같은 바인딩으로 `EXPLAIN (ANALYZE, COSTS OFF, TIMING ON, SUMMARY ON)`을 실행해 `Execution Time`을 읽었습니다.
- 요청: 기존 형태 `tag=vip&field_id=<score>&field_operator=gte&field_value=100000`와 트리 `(vip 그리고 score ≥ 100000) 또는 event`를 각각 미리보기(`preview=true`)와 목록으로 보냈습니다.

| 연락처 | 기존 형태 미리보기 | 트리 미리보기  | 기존 형태 목록 | 트리 목록      |
| ------ | ------------------ | -------------- | -------------- | -------------- |
| 2,000  | 15.6–46.7 ms       | 37.3–44.8 ms   | 7.1–14.2 ms    | 24.3–33.7 ms   |
| 20,000 | 164.6–243.6 ms     | 407.4–783.7 ms | 82.3–99.5 ms   | 252.7–276.4 ms |

트리 미리보기의 대상 수는 2,000명에서 750명, 20,000명에서 9,750명으로 손 계산과 같았습니다.
트리 조건은 평가하는 행마다(목록은 댓글 이벤트 행, 미리보기는 연락처 행) jsonb 트리를 다시 펼칩니다.
20,000명 데이터에서 트리 목록은 기존 형태 목록의 약 2.5~3.4배였고, 미리보기는 부하에 따른 편차가 커서 배수를 말할 수 없습니다.
트리를 문장마다 한 번 펼쳐 두는 최적화는 이 PR에서 하지 않았습니다.
세그먼트 CSV 내보내기는 배치마다 이 술어를 다시 평가하지만, 내보내기 자체의 시간은 재지 않았습니다.
이 수치는 로컬 Mac mini의 합성 데이터이며 운영 규모의 시간이나 페이지 크기로 비용이 제한된다는 뜻이 아닙니다.
