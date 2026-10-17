# 다중 필드 조건 검증

## 결과와 범위

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 [다중 필드 조건](../specs/2026-09-27-contact-segments.md#다중-필드-조건)을 로컬에서 검증했습니다.
기준 커밋은 `8fdb6fe`이며, 검증한 것은 이 작업 트리의 미커밋 변경입니다.
이 기록은 운영 적용이나 #26 전체 완료를 뜻하지 않습니다.

## 자동 검사

| 검사                            | 읽는 대상과 확인 결과                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm check-types`     | TypeScript 타입과 모듈 계약, 통과                                                                              |
| `corepack pnpm test`            | 모의 요청·정책·API 입력 계약, 320개 통과                                                                       |
| `corepack pnpm test:db`         | UTF-8 PostgreSQL 17의 실제 쿼리·제약 계약, 683개 통과                                                          |
| `corepack pnpm test:cloudflare` | 실제 workerd와 제한된 `auto_chatter_server` 역할, 78개 통과                                                    |
| 전체 migration 실행기           | 테스트 DB에서 `field_conditions`·`field_mode` 열을 지우고 기존 OR 행을 넣은 뒤 `deploy/migrate-multi-user.sql` |
| `trunk fmt`, `trunk check --ci` | prettier·markdownlint·yamllint·osv-scanner·trufflehog 형식과 정적 검사, 문제 없음                              |

단위 검사는 DB에 닿기 전의 입력 계약을 확인합니다.

- 기존 `field_id`·`field_operator`·`field_value`만 쓴 GET은 이전 응답 그대로이며, SQL 인수는 15개 그대로입니다.
  6~8번째 인수는 정렬한 필드 ID 배열, 모드, 정규화한 조건 집합 JSON이며 기존 조건은 조건 하나인 집합으로 전달됩니다.
- `field_conditions`의 조건 1개는 모드와 관계없이 단일 조건이고, 2개와 3개는 `field_id` 순으로 정렬해 전달하며, 대문자 ID는 소문자로 바꿉니다.
  필드 확인 조회도 같은 순서로 한 번씩 실행됩니다.
- 따옴표 1,000개인 텍스트 값을 포함한 집합과 공백으로 8,192자를 채운 값은 통과하고, 8,193자는 거부합니다.
- 4개 조건, 같은 필드 두 번(대소문자만 다른 ID 포함), 빈 배열, 배열이 아닌 값, JSON `null`, `null`·문자열 원소, `field_id` 없는 원소, 허용하지 않은 키, 값 없는 `eq`, 값 있는 `is_unset`, 잘못된 UUID·연산자, 잘못된 JSON, 빈 값, 기존 필드 키와의 혼합, 모르는 모드(대문자·빈 값 포함), 조건 없는 `field_mode`, JSON 이스케이프로 만든 짝 없는 서로게이트가 든 문자열 값(기존 `field_value` 키 포함)은 `400 invalid_field_condition`입니다.
  `field_conditions`·`field_mode` 반복과 `segment_id`와의 혼합은 `400 invalid_contact_request`, 태그 없는 다중 필드 OR는 `400 invalid_contact_condition`입니다.
  모두 DB에 닿기 전에 거부합니다.
- 세그먼트 JSON은 기존 필드 키와 `field_conditions` 배열·모드를 받고, 둘을 함께 보내면 GET과 같은 `invalid_field_condition`입니다.
  생성과 수정이 같은 코드로 거부하고, 받아들인 다중 필드 정의는 DB까지 갑니다.
  짝 없는 서로게이트가 든 값은 집합과 기존 키 모두 DB에 닿기 전에 `invalid_field_condition`으로 거부합니다.
  `parseFieldCondition`을 고치기 전에는 서로게이트 사례를 더한 두 단위 시험이 첫 서로게이트 사례에서 실패했습니다(GET은 200, 세그먼트 파싱은 예외 없음).
- 새 단위 검사 2개는 변경 전 `src/app/contacts.ts`에서 모두 실패했습니다.

DB 검사는 텍스트·숫자·날짜·참/거짓 필드 네 개와, 값을 모두·일부·하나도 갖지 않은 연락처 4명으로 다음을 비교합니다.

- 텍스트 `eq`, 숫자 `gt`, 날짜 `lte`, 참/거짓 `eq`, `is_set`, `is_unset`을 섞은 2개·3개 집합 13개를 `all`과 `any`로 조회해, 일반 목록과 미리보기의 연락처가 같고 미리보기의 전체 수·평가 수·제외 사유가 직접 계산한 값과 같습니다.
- 6개 조건 각각을 조건 하나인 `field_conditions`로 보낸 결과가 기존 키로 보낸 결과와 같습니다.
  기존 단일 필드 시험은 수정 없이 모두 통과했습니다.
- 다른 작업 공간의 필드는 `404 field_not_found`이고, HTTP 경로도 같은 결과를 내며 4번째 조건과 같은 필드 반복을 거부합니다.
  텍스트 필드의 순서 비교는 `400 invalid_field_condition`, 숫자 필드의 문자열 값은 `400 invalid_field_value`입니다.
- 다중 태그 `any`·`all`과 다중 필드 `all`·`any`를 AND·OR로 결합한 6개 경우에서 목록·미리보기·제외 사유(`excluded.tag`·`field`·`both`)가 같습니다.
- 세그먼트 생성은 정렬하고 소문자로 바꾼 `field_conditions`와 `field_mode`를 반환하고 기존 필드 키가 없으며, 행의 기존 필드 열은 `NULL`입니다.
  `segment_id` 조회와 미리보기는 같은 조건의 직접 조회와 같은 결과를 내고, `segment_id`와 `field_conditions`·`field_mode`의 혼합은 400입니다.
- 순서와 ID 대소문자만 다른 같은 집합은 버전을 유지하고, 모드만 바꾸면 버전이 오르며 조회 결과가 바뀝니다.
  조건 3개(`is_unset` 포함)로 바꾼 뒤 조건 하나로 바꾸면 기존 필드 열과 키로 돌아가고, 같은 조건을 기존 키로 다시 보내도 버전이 유지됩니다.
  다중 태그와 다중 필드의 OR 세그먼트를 저장하고 그 조건으로 조회합니다.
- `field_conditions` 안에서만 참조하는 두 필드의 보관은 `409 field_in_use`이고, 세그먼트를 보관한 뒤에는 필드를 보관할 수 있습니다.
- 보관된 필드나 다른 작업 공간의 필드를 담은 집합은 생성과 수정 모두 `404 field_not_found`이며 세그먼트 행이 바뀌지 않습니다.
  다른 작업 공간은 세그먼트를 읽거나 수정할 수 없습니다.
- 동시성 검사 두 개는 프로젝트의 앞선 경쟁 검사와 같은 차단 연결을 씁니다.
  세그먼트 생성이 두 필드를 `FOR SHARE`로 잡은 뒤 외래 키 확인에서 기다리는 동안, 정렬상 마지막 필드의 보관을 시작하면 보관이 기다렸다가 `409 field_in_use`로 끝나고 생성은 201입니다.
  반대로 수정이 작업 공간 잠금에서 기다리는 동안 보관이 먼저 끝나면 수정은 `404 field_not_found`이고 아무것도 쓰지 않습니다.
- 관리자 연결로 직접 넣은 1개·4개 원소, 객체·문자열·빈 배열, 모르는 모드, 모드 없는 집합, 집합 없는 모드, 기존 필드 열과 집합 동시 저장, 객체가 아닌 원소, 허용하지 않은 키, 값 없는 `eq`, 값 있는 `is_set`, 참/거짓 값의 순서 비교, 모르는 연산자, `field_id` 없는 원소, 숫자 `field_id`, 대문자 ID, 정렬되지 않은 ID, 같은 ID 두 번은 모두 `contact_segment_multi_field` 제약(23514)으로 거부됩니다.
  필드 집합만 있고 태그가 없는 OR는 `contact_segment_condition_operator`로 거부되고, 태그와 필드 집합의 OR는 저장됩니다.
- migration 057을 같은 트랜잭션에서 두 번 적용하면 두 제약이 다시 생기고 기존 단일 필드 OR 행은 바뀌지 않습니다.
  다중 필드로 바꾼 값은 재적용 뒤에도 유지되며, 1개 집합·기존 필드 열 동시 저장·필드 조건 없는 OR는 거부됩니다.
- `tag`·`tags`와 필드 집합을 OR로 묶은 세그먼트가 있을 때 전체 실행기 순서대로 056과 057을 한 트랜잭션에서 두 번씩 적용하거나 `db/schema.sql`을 다시 적용해도 오류가 없고, 행과 `field_conditions`를 읽는 OR 규칙이 그대로 남습니다.
  수정 전 056은 이 경우 `contact_segment_condition_operator`(23514)로 실패했고, `db/schema.sql`의 같은 블록만 되돌려도 같은 오류로 실패하는 것을 확인했습니다.

음성 대조는 잠금마다 하나씩 실행했습니다.

- 세그먼트 쓰기의 필드 확인을 `lock = false`로 바꾸면 첫 동시성 검사가 `200 !== 409` 값 비교로 실패했습니다.
- 필드 보관의 jsonb 포함 검사를 지우면 세그먼트 검사와 첫 동시성 검사가 실패했습니다.
- 두 경우 모두 되돌린 뒤 통과했습니다.

전체 실행기 검사는 `field_conditions`·`field_mode` 열을 지운(두 제약도 함께 사라짐) 테스트 DB에 `tag='lead'`와 필드 `is_set`의 OR 세그먼트 1건을 넣고 `psql -f deploy/migrate-multi-user.sql`을 실행했습니다.
실행기는 종료 코드 0으로 끝났고, 기존 행은 기존 필드 열과 `condition_operator='or'`를 유지했으며 새 열은 `NULL`이었고 두 제약이 생성되었습니다.
`auto_chatter_server`와 `automations_app`은 두 새 열을 SELECT·INSERT·UPDATE할 수 있었습니다.
확인 뒤 넣은 행과 작업 공간을 지웠습니다.

Worker 검사는 실제 제한 역할로 다중 필드 `all` 세그먼트 생성과 응답 형태, `segment_id` 조회, 직접 조건 `field_conditions` 미리보기의 필드 제외, `field_conditions` 안에서만 참조하는 필드의 보관 거부, 세그먼트 보관 뒤의 필드 보관을 확인합니다.

최소 재검증 명령은 다음과 같습니다.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5434/automations_test node --test --test-concurrency=1 --test-name-pattern='field set|multi-field|field sets' src/app/settings.db.test.ts
node --test --test-name-pattern='field_conditions set|one to three field conditions' src/app/api.test.ts
```

위 주소는 이번 검증에서 사용한 폐기 가능한 로컬 DB입니다.
다시 실행할 때는 별도로 준비한 로컬 `automations_test` 주소를 사용해야 합니다.

## 화면

`public/app/app.js`의 연락처 필터 화면을 실행하는 테스트 도구는 저장소에 없습니다.
화면 코드는 `node --check public/app/app.js` 문법 검사와 `trunk check`를 통과했습니다.
작업 디렉터리 밖의 임시 스크립트로 필드 행 함수(`fieldFilterRows`, `showFieldRows`, `fieldFilterControls`, `contactFieldConditions`, `contactFieldConditionKeys`, `fillSegmentConditions`, `segmentSummary`, `contactDraftQuery`)와 추가·삭제 버튼 처리기를 가짜 폼 요소와 함께 `node:vm`에서 실행했습니다.
조건 하나의 기존 query, 행 추가 뒤 필드를 고를 때까지 다음 추가 숨김, 두 행부터 모드 활성화와 `field_conditions`·`field_mode` 전송, 숫자·날짜 필드에만 순서 비교 선택지, 참/거짓 값, 세 행 상한, 같은 필드 두 번의 요청 전 안내, 2행 삭제 때 3행이 올라오는 것, 다시 한 행이 되면 모드가 모두 만족으로 돌아가는 것, 다중·단일·없는 세그먼트를 폼에 채울 때의 행 표시와 보낼 값, 요약 문자열을 확인했습니다.
같은 스크립트는 변경 전 `app.js`에서 함수를 찾지 못해 실패했습니다.
이 스크립트는 커밋하지 않았습니다.

[UNVERIFIED: real browser] 실제 브라우저로는 실행하지 않았습니다.
저장소의 `node_modules`에는 Playwright가 없고, 이 컴퓨터의 Playwright 캐시에는 Chromium revision 1248만 있습니다.
그보다 큰 이유는 대시보드를 띄우려면 실제 Supabase 인증 세션과 workerd 실행 환경이 필요하다는 점입니다.
운영자가 확인할 항목은 다음과 같습니다.

- 첫 행에 필드를 고르면 "추가 정보 조건 추가"가 나타나고 최대 3행까지 열리며, 필드를 고른 행이 두 개 이상일 때만 "여러 정보 결합"을 고를 수 있습니다.
- 행마다 필드 타입에 맞는 조건 선택지와 값 입력이 보이고, 2·3행 삭제가 뒤 행을 올립니다.
- 미리보기와 목록이 고른 모드를 따르고, 추가 정보 제외 사유가 집계됩니다.
- 다중 필드로 필터 저장, 선택, 수정 모드 진입·변경 저장·충돌 뒤 저장된 값 표시, 보관 뒤 직접 조건 전환에서 조건 집합과 모드가 유지되며 다중 태그와 함께 동작합니다.
- 세그먼트 요청 중 조건 폼 잠금(추가·삭제 버튼 포함), 수정 중 초안 보호, 조건 변경 시 미리보기 무효화, 로그아웃 뒤 초기화(한 행, 모드 비활성)가 이전과 같습니다.
- 모바일 폭에서 늘어난 행과 버튼이 겹치지 않습니다.
- 충돌 뒤 저장된 값 요약은 조건마다 그 조건의 필드 타입으로 순서 비교 이름을 고르므로, 2·3행의 날짜 조건도 "당일 포함 이전"처럼 보입니다.

리뷰 뒤 두 가지 화면 수정을 같은 방식의 `node:vm` 임시 스크립트로 다시 확인했습니다.

- 요약은 날짜·숫자·찾을 수 없는 필드가 섞인 세 조건을 "가입일 당일 포함 이전 2026-10-18, 점수 초과 3, 확인할 수 없는 필드 입력됨"으로 표시합니다.
  1행 선택지의 이름만 읽던 이전 형태는 같은 날짜 조건을 "이하"로 표시해 실패했습니다.
- 직접 조건을 만들 수 없을 때 목록 지우기는 변경 전처럼 1행에 필드가 없거나 찾을 수 없으면 목록을 지우고, 2·3행은 찾을 수 없는 필드를 고른 경우에만 지웁니다.
  예를 들어 필드를 고르지 않고 동의 목적만 고른 조회는 이전처럼 목록을 비우고 안내를 보입니다.
  1행이 빈 경우를 빼면 이 검사가 실패했습니다.

조회 문자열 길이도 확인하지 않았습니다.
서버가 받는 디코딩 길이 상한([스펙](../specs/2026-09-27-contact-segments.md#다중-필드-연락처-조회)) 안이라도, 퍼센트 인코딩한 한국어 텍스트 값은 글자당 약 9자이므로 긴 한국어 값 세 개는 Cloudflare가 받는 URL 길이에 먼저 걸릴 수 있습니다.

연락처 CSV 내보내기(`GET /api/contacts/export.csv`)는 필터 조건을 받지 않고 저장된 전체 연락처를 내보내므로 이 변경의 영향을 받지 않습니다.

## 확인하지 않은 것

운영 DB, 운영 마이그레이션 057 적용, 배포된 Worker, 실제 사용자 인증과 운영 데이터, 운영 규모 성능은 확인하지 않았습니다.
기존 DB는 코드 배포 전에 migration 057을 전체 실행기로 적용해야 합니다.
