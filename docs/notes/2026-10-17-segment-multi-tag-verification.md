# 다중 태그 조건 검증

## 결과와 범위

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 [다중 태그 조건](../specs/2026-09-27-contact-segments.md#다중-태그-조건)을 로컬에서 검증했습니다.
기준 커밋은 `0cfbb6a`이며, 검증한 것은 이 작업 트리의 미커밋 변경입니다.
이 기록은 운영 적용이나 #26 전체 완료를 뜻하지 않습니다.

## 자동 검사

| 검사                            | 읽는 대상과 확인 결과                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `corepack pnpm check-types`     | TypeScript 타입과 모듈 계약, 통과                                                                |
| `corepack pnpm test`            | 모의 요청·정책·API 입력 계약, 318개 통과                                                         |
| `corepack pnpm test:db`         | UTF-8 PostgreSQL 17의 실제 쿼리·제약 계약, 675개 통과                                            |
| `corepack pnpm test:cloudflare` | 실제 workerd와 제한된 `auto_chatter_server` 역할, 78개 통과                                      |
| 전체 migration 실행기           | 테스트 DB에서 `tags`·`tag_mode` 열을 지우고 기존 OR 행을 넣은 뒤 `deploy/migrate-multi-user.sql` |
| `trunk fmt`, `trunk check --ci` | prettier·markdownlint·yamllint·osv-scanner·trufflehog 형식과 정적 검사, 문제 없음                |

단위 검사는 DB에 닿기 전의 입력 계약을 확인합니다.

- `tag` 하나와 `tag_mode` 없는 GET은 이전 응답 그대로이며, SQL 인수는 15개 그대로이고 세 번째 인수만 정규화한 태그 배열입니다.
- `tag` 2개와 5개는 정렬한 배열로 전달되고, `all`·생략은 포함(`@>`), `any`는 겹침(`&&`) 조건을 씁니다.
  정규화하면 같은 값은 합치며, 하나로 합쳐지면 `any`를 보내도 단일 태그 조건입니다.
- `tag` 6개(같은 값 6개 포함), 빈 태그, 41자 태그, 모르는 모드(대문자·빈 값 포함)는 `400 invalid_contact_tags`입니다.
  태그 없는 `tag_mode`와 필드 없는 다중 태그 OR는 `400 invalid_contact_condition`입니다.
  `tag_mode` 반복, 다른 키 반복, `segment_id`와 `tag`·`tag_mode`의 혼합은 `400 invalid_contact_request`입니다.
  모두 DB에 닿기 전에 거부합니다.
- 세그먼트 JSON은 기존 `tag`, `tags` 배열과 모드를 받고, 모드 기본값은 `all`입니다.
  `tag`와 `tags`를 함께 보내면 `invalid_segment`이고, 빈 배열·배열 아닌 값·6개·`null` 원소·빈 문자열·41자·모르는 모드는 `invalid_contact_tags`입니다.
  생성과 수정이 같은 코드로 거부합니다.
- 새 단위 검사 2개는 변경 전 `src/app/contacts.ts`에서 모두 실패했습니다.

DB 검사는 태그 행이 없는 연락처, 빈 태그 행, 집합 `{a,b,c}`의 일부·전부·다른 태그만 가진 연락처 6명으로 다음을 비교합니다.

- `all`은 세 태그를 모두 가진 연락처만, `any`는 하나 이상 가진 연락처를 고릅니다.
  태그 행이 없는 연락처와 빈 태그 행의 연락처는 둘 다 태그 없음으로 판정합니다.
- 두 모드를 숫자 필드 조건과 AND·OR로 결합한 네 경우에서, 일반 목록과 미리보기의 연락처가 같고 미리보기의 전체 수·평가 수·`excluded.tag`·`field`·`both`가 직접 계산한 값과 같습니다.
- 다른 작업 공간은 평가 수 0이고, HTTP 경로도 반복한 `tag`를 같은 결과로 읽으며 6번째 태그를 거부합니다.
- 세그먼트 생성은 정렬한 `tags`와 `tag_mode`를 반환하고 `tag` 키가 없으며, 행에는 `tag`가 `NULL`입니다.
  `segment_id` 조회와 미리보기는 같은 조건의 직접 조회와 같은 결과를 냅니다.
- 순서와 대소문자만 다른 같은 집합을 수정으로 다시 보내면 버전이 유지되고, 모드만 바꾸면 버전이 오르며 조회 결과가 바뀝니다.
  하나로 합쳐지는 집합으로 바꾸면 `tag` 열과 `tag` 키로 돌아가고, 같은 태그를 기존 `tag`로 다시 보내도 버전이 유지됩니다.
  다중 태그와 필드의 OR 세그먼트를 저장하고 그 조건으로 조회합니다.
- 기존 단일 태그 세그먼트의 생성 응답은 이전 형태이며, 다른 작업 공간은 세그먼트를 읽거나 수정할 수 없습니다.
- 관리자 연결로 직접 넣은 1개·6개·`NULL` 원소·빈 문자열·41자 원소, 모르는 모드, 모드 없는 집합, 집합 없는 모드, `tag`와 `tags` 동시 저장, 빈 배열, 2차원 배열, 하한이 0인 배열은 모두 `contact_segment_multi_tag` 제약(23514)으로 거부됩니다.
  태그 조건 없는 OR는 `contact_segment_condition_operator`로 거부되고, `tags`와 필드의 OR는 저장됩니다.
- migration 056을 같은 트랜잭션에서 두 번 적용하면 두 제약이 다시 생기고 기존 단일 태그 OR 행은 바뀌지 않습니다.
  다중 태그로 바꾼 값은 재적용 뒤에도 유지되며, 1개 집합·`tag` 동시 저장·태그 조건 없는 OR는 거부됩니다.
- 두 행동 검사는 변경 전 `src/app/contacts.ts`와 `db/schema.sql`에서 실패했습니다.
  제약과 migration 검사는 이 대조에서 통과했는데, 앞선 실행에서 테스트 DB에 이미 열과 제약이 생겼고 migration 검사는 056 파일을 직접 읽기 때문입니다.
  대신 롤백하는 `psql` 세션에서 제약을 `tag_mode IS NOT NULL` 없이 다시 만들면 모드가 `NULL`인 2개 집합이 저장되는 것을 확인했고, 롤백 뒤 원래 제약이 남아 있었습니다.
- 음성 대조로 SQL 연산자를 모드와 관계없이 `@>`로 고정하면 새 DB 검사 4개 중 2개가 실패했고, 되돌린 뒤 통과했습니다.
- 기존 검사 "contact keyset pages visit every stable identity once and reject malformed requests"는 `tag=x&tag=y`를 400으로 기대했습니다.
  이 변경으로 허용되는 입력이므로 6개 태그를 거부하는 경우로 바꿨습니다.

전체 실행기 검사는 `tags`·`tag_mode` 열을 지운(두 제약도 함께 사라짐) 테스트 DB에 `tag='lead'`와 필드의 OR 세그먼트 1건을 넣고 `psql -f deploy/migrate-multi-user.sql`을 실행했습니다.
실행기는 종료 코드 0으로 끝났고, 기존 행은 `tag='lead'`, `tags`·`tag_mode`가 `NULL`, `condition_operator='or'`를 유지했으며 두 제약이 생성되었습니다.
`auto_chatter_server`와 `automations_app`은 두 새 열을 SELECT·INSERT·UPDATE할 수 있었습니다.
확인 뒤 넣은 행과 작업 공간을 지웠습니다.

Worker 검사는 실제 제한 역할로 다중 태그 `any` 세그먼트 생성과 응답 형태, `segment_id` 조회, 직접 조건 `tag=lead&tag=vip&tag_mode=all`의 태그 제외, 보관을 확인합니다.

최소 재검증 명령은 다음과 같습니다.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5434/automations_test node --test --test-concurrency=1 --test-name-pattern='tag sets match|multi-tag' src/app/settings.db.test.ts
node --test --test-name-pattern='tag filters repeat|legacy tag or a set' src/app/api.test.ts
```

위 주소는 이번 검증에서 사용한 폐기 가능한 로컬 DB입니다.
다시 실행할 때는 별도로 준비한 로컬 `automations_test` 주소를 사용해야 합니다.

## 화면

`public/app/app.js`의 연락처 필터 화면을 실행하는 테스트 도구는 저장소에 없습니다.
화면 코드는 `node --check public/app/app.js` 문법 검사와 `trunk check`를 통과했습니다.
작업 디렉터리 밖의 임시 스크립트로 `contactFilterTags`, `contactTagControls`, `contactDraftQuery`, `fillSegmentConditions`를 가짜 폼 요소와 함께 `node:vm`에서 실행했습니다.
태그 하나의 기존 query, 정규화한 중복 제거, 쉼표가 든 태그, 두 개 이상일 때만 모드 활성화와 `tag_mode` 전송, 하나로 줄면 모드가 모두 포함으로 돌아감, 다중·단일·없는 세그먼트를 폼에 채울 때의 입력칸 값과 표시를 확인했습니다.
이 스크립트는 커밋하지 않았습니다.

[UNVERIFIED: real browser] 실제 브라우저로는 실행하지 않았습니다.
저장소의 `node_modules`에는 Playwright가 없습니다.
이 컴퓨터에는 전역 `@playwright/cli@0.1.15`가 Playwright 라이브러리를 함께 설치해 두었지만, 이 라이브러리가 요구하는 Chromium revision 1229가 캐시에 없고 캐시에는 revision 1248만 있어 `executablePath`를 따로 지정하지 않으면 실행되지 않습니다.
그보다 큰 이유는 대시보드를 띄우려면 실제 인증 세션과 workerd 실행 환경이 필요하다는 점입니다.
운영자가 확인할 항목은 다음과 같습니다.

- 태그 입력칸에 값을 넣으면 다음 칸이 나타나고 최대 5칸까지 보이며, 서로 다른 태그가 두 개 이상일 때만 "여러 태그 결합"을 고를 수 있습니다.
- 미리보기와 목록이 고른 모드를 따르고, 태그 제외 사유가 집계됩니다.
- 다중 태그로 필터 저장, 선택, 수정 모드 진입·변경 저장·충돌 뒤 저장된 값 표시, 보관 뒤 직접 조건 전환에서 태그 집합과 모드가 유지됩니다.
- 세그먼트 요청 중 조건 폼 잠금, 수정 중 초안 보호, 조건 변경 시 미리보기 무효화, 로그아웃 뒤 초기화(입력칸 하나, 모드 비활성)가 이전과 같습니다.
- 모바일 폭에서 늘어난 입력칸이 겹치지 않습니다.

## 확인하지 않은 것

운영 DB, 운영 마이그레이션 056 적용, 배포된 Worker, 실제 사용자 인증과 운영 데이터, 운영 규모 성능은 확인하지 않았습니다.
기존 DB는 코드 배포 전에 migration 056을 전체 실행기로 적용해야 합니다.
