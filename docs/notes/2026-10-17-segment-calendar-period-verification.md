# 작업 공간 시간대 달력 기간 검증

## 결과와 범위

[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 [달력 기간 조건](../specs/2026-10-16-segment-relative-activity.md#달력-기간)을 로컬에서 검증했습니다.
기준 커밋은 `e17e1a4`이며, 검증한 것은 이 작업 트리의 미커밋 변경입니다.
이 기록은 운영 적용이나 #26 전체 완료를 뜻하지 않습니다.

## 자동 검사

| 검사                            | 읽는 대상과 확인 결과                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `corepack pnpm check-types`     | TypeScript 타입과 모듈 계약, 통과                                                                      |
| `corepack pnpm test`            | 모의 요청·정책·API 입력 계약, 316개 통과                                                               |
| `corepack pnpm test:db`         | UTF-8 PostgreSQL 17의 실제 쿼리·제약 계약, 671개 통과                                                  |
| `corepack pnpm test:cloudflare` | 실제 workerd와 제한된 `auto_chatter_server` 역할, 78개 통과                                            |
| 전체 migration 실행기           | 테스트 DB에서 `last_comment_period` 열을 지우고 기존 행을 넣은 뒤 `deploy/migrate-multi-user.sql` 실행 |
| `trunk fmt`, `trunk check --ci` | prettier·markdownlint·yamllint·osv-scanner·trufflehog 형식과 정적 검사, 문제 없음                      |

단위 검사는 DB에 닿기 전의 입력 계약을 확인합니다.

- GET query의 네 값은 200이며, 미리보기와 일반 목록 모두 DB가 돌려준 `activity_window`를 그대로 반환합니다.
- 달력 값은 15번째 SQL 인수로 추가되어 기존 인수 위치가 바뀌지 않습니다.
- 빈 query 값은 조건 없음이며 응답에 `activity_window`가 없습니다.
- 대소문자·공백이 다른 값, `this_week`, 최근 일수·고정 기간(한쪽만 포함)과의 혼합, `segment_id`와의 혼합, 중복 키는 DB에 닿기 전에 400입니다.
- 세그먼트 JSON은 네 문자열과 `null`·생략만 받고, 빈 문자열·다른 문자열·숫자·불리언·배열·다른 활동 형태와의 혼합은 생성과 수정 모두 DB에 닿기 전에 `400 invalid_contact_activity`입니다.

DB 검사는 실제 집계 SQL에서 `statement_timestamp()` 한 곳만 고정한 시각으로 바꾸고 다음을 비교합니다.

- `Asia/Seoul` 작업 공간에서 2026-10-17 12:00(현지)의 네 기간마다, 마지막 댓글이 `from`과 같은 연락처와 `before` 1마이크로초 전인 연락처는 포함하고, `from` 1마이크로초 전과 `before`와 같은 연락처는 제외합니다.
  미리보기의 전체 수·평가 수·`excluded.activity`·예시와 일반 목록의 연락처·`activity_window`가 모두 같은 경계를 따릅니다.
- 같은 검사를 DB 세션 시간대 `America/New_York`에서 반복해도 결과가 같습니다.
- 같은 시각에서 `Asia/Seoul`과 `America/Los_Angeles`의 `today`가 서로 다른 연락처를 고르며, 작업 공간 시간대를 바꾼 다음 조회가 바뀐 시간대를 따릅니다.
- 2027-01-01 09:30(서울)의 `this_month`·`last_month`·`yesterday`, 2026년 마지막 마이크로초의 `this_month`·`today`, `UTC` 작업 공간의 2월 말 `last_month`·`yesterday`가 월·연 경계를 넘습니다.
- `America/Santiago`의 2026-09-06은 0시가 없으며, `today`는 `[2026-09-06T04:00Z, 2026-09-07T03:00Z)`의 23시간, `yesterday`는 `[2026-09-05T04:00Z, 2026-09-06T04:00Z)`, `this_month`는 `[2026-09-01T04:00Z, 2026-10-01T03:00Z)`입니다.
  `America/Los_Angeles`의 2026-11-01 `today`는 `[07:00Z, 다음 날 08:00Z)`의 25시간입니다.
  같은 값을 `psql`의 `timestamp '2026-09-06 00:00' AT TIME ZONE 'America/Santiago'`(결과 `04:00Z`, 01:00 입력과 같은 값)로 먼저 확인했습니다.
- 구간 안 과거 댓글과 구간 밖 최신 댓글이 있는 연락처는 제외하고, 구간 밖 과거 댓글과 구간 안 최신 댓글이 있는 연락처는 포함하며 댓글 수와 첫 댓글 시각을 자르지 않습니다.
  제외 순서는 활동, 동의, 태그 순서입니다.
- 빈 결과도 `activity_window`를 반환하고, 다른 작업 공간은 평가 수 0이며, 같은 작업 공간의 `agent`는 같은 결과를 읽습니다.
  활동 조건이 없는 응답은 `activity_window`가 없고, 최근 일수 응답은 `{from, before}` 그대로입니다.
- 세그먼트 생성·목록·수정(값 변경, 같은 정의 재전송 시 버전 유지, 최근 일수로 전환 시 키 제거, 다시 달력으로 전환)과 `segment_id` 조회가 저장한 기간을 유지합니다.
  실제 시계 조회는 서울 하루 24시간 경계와 요청 시각 포함을 확인하고, 시간대 변경 뒤 저장 필터 조회가 `America/Los_Angeles`를 반환합니다.
- DB에 직접 쓴 `this_week`, 달력 기간과 최근 일수·고정 기간의 동시 저장은 `contact_segment_calendar_period` 제약(23514)으로 거부됩니다.
- migration 055를 같은 트랜잭션에서 두 번 적용하면 기존 행은 `NULL`이고, `last_month`로 바꾼 값은 재적용 뒤에도 유지되며, 제약도 다시 생깁니다.
- 음성 대조로 SQL의 현지 시각 계산 `as_of AT TIME ZONE time_zone`을 세션 시간대를 쓰는 `as_of::timestamp`로 바꾸면 달력 DB 검사 7개 중 3개(세션 시간대, 작업 공간 시간대 변경, 일광 절약 시간)가 실패했고, 되돌린 뒤 통과했습니다.

전체 실행기 검사는 `last_comment_period` 열을 지우고 최근 일수 7의 기존 세그먼트 1건을 넣은 테스트 DB에서 `psql -f deploy/migrate-multi-user.sql`을 실행했습니다.
실행기는 종료 코드 0으로 끝났고, 기존 행은 일수 7과 `last_comment_period IS NULL`을 유지했으며, 제약이 생성되었고 `auto_chatter_server`와 `automations_app`은 새 열을 INSERT·UPDATE할 수 있었습니다.
확인 뒤 넣은 행과 작업 공간을 지웠습니다.

Worker 검사는 실제 제한 역할로 `last_month` 세그먼트 생성, 작업 공간 시간대의 지난달 첫 시각에 저장된 댓글의 포함과 응답 `time_zone`, 직접 조건 `this_month`의 활동 제외, 두 기간의 경계 연결(`this_month.from`이 `last_month.before`와 같음), 보관을 확인합니다.

최소 재검증 명령은 다음과 같습니다.

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5434/automations_test node --test --test-concurrency=1 --test-name-pattern='calendar' src/app/settings.db.test.ts
node --test --test-name-pattern='calendar period' src/app/api.test.ts
```

위 주소는 이번 검증에서 사용한 폐기 가능한 로컬 DB입니다.
다시 실행할 때는 별도로 준비한 로컬 `automations_test` 주소를 사용해야 합니다.

## 화면

`public/app/app.js`의 연락처 필터 화면을 실행하는 테스트 도구는 저장소에 없습니다.
화면 코드는 `node --check public/app/app.js` 문법 검사와 `trunk check`를 통과했습니다.
작업 디렉터리 밖의 임시 스크립트로 `calendarActivitySummary`와 기간 이름 표를 `node:vm`에서 실행해, 정상 응답의 문구와 빈 시간대·역전된 경계·모르는 기간·경계 없음의 오류를 확인했습니다.
이 스크립트는 커밋하지 않았습니다.

[UNVERIFIED: real browser] 저장소에 Playwright가 설치되어 있지 않고 대시보드를 띄우려면 인증과 workerd가 필요해 실제 브라우저로 실행하지 않았습니다.
운영자가 확인할 항목은 다음과 같습니다.

- 댓글 활동 기간에서 "달력 기간 (작업 공간 시간대)"를 고르면 기간 선택(오늘·어제·이번 달·지난달)만 보이고, 고정 UTC 입력과 최근 일수는 숨겨지고 비활성화됩니다.
- 미리보기와 목록 상태 문구에 응답의 시간대와 UTC 경계가 보이고, 제외 사유의 "활동 기간 밖"이 집계됩니다.
- 달력 기간으로 필터 저장, 선택, 수정 모드 진입·변경 저장·충돌 뒤 저장된 값 표시, 보관 뒤 직접 조건 전환에서 기간이 유지됩니다.
- 세그먼트 요청 중 조건 폼 잠금, 수정 중 초안 보호, 조건 변경 시 미리보기 무효화, 로그아웃 뒤 초기화(고정 UTC 기간 모드로 복귀)가 이전과 같습니다.

## 확인하지 않은 것

운영 DB, 운영 마이그레이션 055 적용, 배포된 Worker, 실제 사용자 인증과 운영 데이터, 운영 규모 성능은 확인하지 않았습니다.
기존 DB는 코드 배포 전에 migration 055를 전체 실행기로 적용해야 합니다.
