# 저장 필터 이름·조건 수정 검증

## 결과와 범위

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 [저장 필터 이름·조건 수정](../specs/2026-09-27-contact-segments.md#이름과-조건-수정)을 로컬에서 검증했습니다.
기준 커밋은 `6eb83c4`이며, 검증한 것은 이 작업 트리의 미커밋 변경입니다.
이 기록은 운영 적용이나 #26 전체 완료를 뜻하지 않습니다.

## 자동 검사

| 검사                            | 읽는 대상과 확인 결과                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `corepack pnpm check-types`     | TypeScript 타입과 모듈 계약, 통과                                                        |
| `corepack pnpm test`            | 모의 요청·정책·API 입력 계약, 314개 통과                                                 |
| `corepack pnpm test:db`         | UTF-8 PostgreSQL 17의 실제 쿼리·잠금·제약 계약, 664개 통과                               |
| `corepack pnpm test:cloudflare` | 실제 workerd와 제한된 `auto_chatter_server` 역할, 78개 통과                              |
| 전체 migration 실행기           | 격리 DB에서 `version` 열을 지우고 기존 행을 넣은 뒤 `deploy/migrate-multi-user.sql` 실행 |
| `trunk fmt`, `trunk check --ci` | prettier·markdownlint·yamllint·osv-scanner·trufflehog 형식과 정적 검사, 문제 없음        |

단위 검사는 DB에 닿으면 실패하는 가짜 연결로 다음을 확인합니다.

- `expected_version`이 없거나 0·음수·소수·문자열·`null`·안전한 정수 범위 밖이면 DB에 닿기 전에 `400 invalid_segment`입니다.
- 모르는 키, 빈 이름·61자 이름·제어 문자 이름, 이름 없는 본문, UUID가 아닌 ID도 같은 코드로 거부합니다.
- 조건 값 오류는 생성과 같은 세부 코드(`invalid_field_condition`, `invalid_contact_activity`, `invalid_contact_consent`, `invalid_contact_condition`)로 거부합니다.
- 생성 본문의 `expected_version`은 `400 invalid_segment`입니다.
- 생성이 받아들이는 정의 4개를 수정도 받아들여 DB에 닿으며, 두 경로의 파싱 결과가 같습니다.
- 동일 출처가 아닌 `PUT /api/contact-segments/<id>`는 DB를 열기 전에 403입니다.

DB 검사는 다음을 비교합니다.

- 이름, 계정, 태그, 필드 비교, OR 결합, 최근 일수, 동의 기록, 고정 기간, 입력됨 조건을 차례로 바꿀 때마다 응답, 목록 항목, `version` 1 증가가 일치합니다.
  마지막에 선택 키를 생략하면 저장된 행의 모든 조건 열이 비워집니다.
- 매 수정 뒤 `GET /api/contacts?segment_id=<id>`가 새 정의로 연락처를 계산합니다.
- 공백과 대소문자만 다른 같은 정의를 보내면 버전이 그대로이고, 테이블 전체(`to_jsonb`)가 전후로 같습니다.
  숫자 필드 값(jsonb)·OR 결합·최근 일수·동의 기록을 모두 쓴 정의와, 같음 비교·고정 기간(timestamptz)을 쓴 정의를 다시 보내도 같습니다.
  음성 대조로 SQL의 `IS DISTINCT FROM` 조건을 항상 참인 조건으로 바꾸면 이 검사가 `version` 6(기대 5)으로 실패했고, 되돌린 뒤 통과했습니다.
- 오래된 `expected_version`은 `409 segment_conflict`와 현재 목록 항목을 반환합니다.
  다른 작업 공간, 없는 ID, 보관된 세그먼트는 `404 segment_not_found`입니다.
  각 경우에 테이블 전체가 전후로 같습니다.
- 다른 활성 세그먼트와 정규화한 이름이 같으면 `409 segment_name_exists`이고, 보관된 세그먼트의 이름은 쓸 수 있습니다.
- `agent`는 `403 role_forbidden`, 제거된 관리자는 `403 workspace_required`이며 아무것도 쓰지 않습니다.
  역할 검사에서도 관리자는 허용되고 `agent`는 거부됩니다.
- 보관된 필드와 다른 작업 공간의 필드는 `404 field_not_found`, 다른 작업 공간의 계정은 `404 connection_not_found`입니다.
- 필드 보관과의 경쟁은 두 순서를 다른 연결의 잠금으로 고정합니다.
  (a) 수정이 새 계정의 외래 키 확인에서 기다리는 동안(필드는 이미 `FOR SHARE`) 보관을 시작하면, 보관은 잠금을 기다린 뒤 `409 field_in_use`이고 수정은 200입니다.
  (b) 수정이 작업 공간 잠금에서 기다리는 동안 보관이 먼저 커밋하면, 수정은 `404 field_not_found`이고 행은 그대로입니다.
  대기 상태는 `pg_stat_activity`의 잠금 대기 수로 확인하며 고정 대기 시간을 쓰지 않습니다.
- 음성 대조로 수정 경로의 필드 `FOR SHARE`를 잠시 빼면 (a)가 보관 200(기대 409)으로 실패했고, 잠금을 되돌린 뒤 통과했습니다.
- 같은 버전의 서로 다른 수정 두 개를 동시에 보내면 하나만 200이고, 다른 하나는 `409 segment_conflict`와 이긴 쪽의 세그먼트를 받습니다.
- 마이그레이션 054를 같은 트랜잭션에서 두 번 적용하면 기존 행이 1에서 시작하고, 3으로 바꾼 값은 재적용 뒤에도 유지됩니다.
  `version=0`과 `NULL`은 제약으로 거부됩니다.

전체 실행기 검사는 `version` 열을 지우고 기존 세그먼트 1건을 넣은 테스트 DB에서 `psql -f deploy/migrate-multi-user.sql`을 실행했습니다.
실행기는 종료 코드 0으로 끝났고, 기존 행은 `version=1`, 제약은 `CHECK ((version >= 1))`이며, `auto_chatter_server`는 이 테이블과 `version` 열을 UPDATE할 수 있었습니다.

Worker 검사는 실제 제한 역할로 수정 200과 `version=2` 응답, 수정된 태그에 따른 연락처 수 변화, 오래된 버전의 409, `agent`의 `403 role_forbidden`, 역할 복구 뒤 수정 200을 확인합니다.

최소 재검증 명령은 다음과 같습니다.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5434/automations_test node --test --test-concurrency=1 --test-name-pattern='segment edit|field archive|same version|segment version migration' src/app/settings.db.test.ts
```

위 주소는 이번 검증에서 사용한 폐기 가능한 로컬 DB입니다.
다시 실행할 때는 별도로 준비한 로컬 `automations_test` 주소를 사용해야 합니다.

## 화면

`public/app/app.js`의 저장 필터 화면을 실행하는 테스트 도구는 저장소에 없습니다.
다른 화면 모듈은 `vm`으로 실행하는 단위 테스트가 있지만, `app.js`는 여러 전역 상태와 다른 모듈에 기대므로 이 변경을 위해 새 도구를 만들지 않았습니다.
화면 코드는 `node --check public/app/app.js` 문법 검사와 `trunk check`만 통과했습니다.

[UNVERIFIED: real browser] 이 환경에는 Playwright가 설치되어 있지 않아 실제 브라우저에서 수정 시작, 변경 저장, 충돌 표시와 저장된 값 불러오기, 수정 취소를 실행하지 않았습니다.
운영자가 확인할 항목은 다음과 같습니다.

- 소유자·관리자에게만 "필터 수정"이 보이고, 저장 필터를 선택했을 때만 누를 수 있습니다.
- 수정을 시작하면 조건 폼과 이름에 저장된 값이 채워지고, 저장 버튼이 "변경 저장"으로 바뀌며, 저장 필터 선택 목록이 잠깁니다.
- 새 필터 이름을 입력한 뒤 "필터 수정"을 누르면 이름을 버릴지 묻고, 취소하면 입력한 이름과 생성 모드가 그대로 남습니다.
- 필터 저장·변경 저장·필터 보관 요청이 끝나기 전에는 조건 폼을 바꿀 수 없고, 요청이 성공하거나 실패한 뒤에는 다시 바꿀 수 있으며 태그·정보 결합, 최근 일수, 동의 기록 상태의 조건부 비활성 상태가 이전과 같습니다.
- 다른 탭에서 먼저 저장한 뒤 변경 저장을 누르면 입력값이 남고 저장된 값이 텍스트로 보이며, "저장된 값 불러오기"를 누르기 전에는 다시 저장해도 충돌합니다.
- 다른 탭에서 보관한 뒤 변경 저장을 누르면 수정 모드가 끝나고 목록이 다시 불러와지며 입력이 남습니다.
- 수정 중에 이름은 그대로 두고 조건만 바꾼 뒤 새로고침하거나 로그아웃하면 저장하지 않은 변경을 버릴지 묻습니다. "저장된 값 불러오기" 뒤에는 다시 바꾸기 전까지 묻지 않습니다.
- 수정 중에 조건이나 이름을 바꾼 뒤 규칙 저장이나 계정 발송·수신 전환으로 작업 공간을 다시 불러오면 수정 모드는 끝나지만 이름과 조건이 남고, 새로고침이나 로그아웃 때 저장하지 않은 변경을 버릴지 묻습니다.
- 수정 취소, 필터 보관, 로그아웃 뒤에는 저장 버튼이 "필터 저장"으로 돌아옵니다.
- 기존 생성·보관·초안 미리보기와 연락처 필터 동작이 그대로입니다.

## 확인하지 않은 것

운영 DB, 운영 마이그레이션 054 적용, 배포된 Worker, 실제 사용자 인증과 운영 데이터는 확인하지 않았습니다.
기존 DB는 코드 배포 전에 migration 054를 전체 실행기로 적용해야 합니다.
