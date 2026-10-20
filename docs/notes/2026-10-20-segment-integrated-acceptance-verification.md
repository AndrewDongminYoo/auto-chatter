# 세그먼트 통합 수용 검증

## 대상과 결과

기준 `main`은 `31f9bb0cbb291f9ee4b6501d6d03fdb35f98f370`입니다.
[#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 기존 기능을 [통합 수용 명세](../specs/2026-10-20-segment-integrated-acceptance.md)에 따라 확인했습니다.
제품 소스·DB 스키마·의존성을 변경하지 않고 [로컬 재현 서버](../../scripts/segment-acceptance.mjs)를 추가했습니다.

실제 `public/app/` 전체 화면, 번들된 Worker, Hyperdrive와 `auto_chatter_server` 역할을 거치는 PostgreSQL을 사용했습니다.
Supabase의 로그인·토큰 갱신·사용자 조회·로그아웃 응답만 합성 계정으로 대체했고, 다른 외부 HTTP 요청은 거절했습니다.
합성 인증은 실제 Supabase나 Meta의 승인·계정·세션 동작을 검증한 것이 아닙니다.

## 재현 방법

Node.js와 고정 의존성을 준비하고 `corepack pnpm build:cloudflare`를 실행합니다.
다른 테스트와 공유하지 않는 새 PostgreSQL 클러스터에 빈 `automations_test` DB를 만듭니다.
아래는 이 Mac의 PostgreSQL 17 바이너리를 사용하는 예시이며, 다른 환경에서는 `acceptance_pg`를 해당 설치 경로로 바꿉니다.
포트가 이미 사용 중이면 사용하지 않는 포트를 선택합니다.

```bash
acceptance_pg=/opt/homebrew/Cellar/postgresql@17/17.11_1/bin
acceptance_root=$(mktemp -d /tmp/ac-segment-XXXXXX)
acceptance_port=55436
"$acceptance_pg/initdb" -D "$acceptance_root/data" -U postgres --auth=trust --no-locale --encoding=UTF8
"$acceptance_pg/pg_ctl" -D "$acceptance_root/data" -l "$acceptance_root/postgres.log" \
  -o "-h 127.0.0.1 -p $acceptance_port -k $acceptance_root" -w start
"$acceptance_pg/createdb" -h 127.0.0.1 -p "$acceptance_port" -U postgres automations_test
TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$acceptance_port/automations_test" \
  node scripts/segment-acceptance.mjs
```

서버가 출력한 HTTPS URL을 이름을 지정한 브라우저 세션에서 엽니다.
로컬 인증서에 한해 인증서 오류를 허용합니다.
합성 계정은 `owner@example.test`, `agent@example.test`, `foreign@example.test`이며 비밀번호는 모두 `acceptance-only`입니다.
이 값은 실제 서비스 자격 증명이 아닙니다.
개별 실행의 HTTPS 포트는 자동으로 선택됩니다.

검사 뒤 브라우저를 닫고 서버를 Ctrl+C로 종료한 다음, 같은 셸에서 아래 명령으로 직접 만든 클러스터를 멈춥니다.
서버는 DB를 지우지 않으며, 다시 시작할 때도 새 빈 클러스터가 필요합니다.

```bash
"$acceptance_pg/pg_ctl" -D "$acceptance_root/data" -m fast -w stop
```

## 브라우저에서 확인한 흐름

`agent-browser`의 `ac26-integrated` 세션으로 실제 로그인 폼에 소유자 계정을 입력했습니다.
브라우저가 발급받은 Secure 쿠키로 `/api/me`와 작업 공간 API를 호출하고 연락처 화면을 열었습니다.
스크립트로 로그인 화면을 생략하거나 업무 API 응답을 합성 값으로 바꾸지 않았습니다.

| 시나리오                     | 실제 확인 결과                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 태그 `vip` 미리보기          | 작업 공간의 58명 중 대상 2명, 태그 제외 56명을 표시했습니다.                                                                                                                       |
| 필터 저장과 대상 고정        | `Acceptance VIP` 필터를 저장하고 선택한 뒤 `{1001,1002}` 명단을 고정했습니다.                                                                                                      |
| 필터 수정                    | 태그를 `prospect`로 바꾸는 동안 비교를 비활성화했고, 저장 뒤 버전 2가 됐습니다.                                                                                                    |
| 현재 필터와 비교             | 현재 `{1002,1003}`에 대해 원래 2명·기준 2명·현재 2명, 추가 1명·제외 1명·유지 1명을 표시했습니다.                                                                                   |
| 두 CSV 다운로드              | 실제 버튼이 내려준 고정 CSV는 `{1001,1002}`, 현재 필터 CSV는 `{1002,1003}`이었습니다.                                                                                              |
| 늦은 비교 응답               | 실제 `fetch` 응답의 반환만 보류하고 필터를 전환한 뒤 해제했습니다. 상세와 이전 결과가 다시 나타나지 않았습니다. 응답 내용은 바꾸지 않았습니다.                                     |
| 이용자 삭제                  | 로컬 관리자로 실제 `delete_person_data`를 실행해 `1001`을 삭제했습니다. 다시 조회한 명단은 1명이었고 비교는 원래 2명·기준 1명·현재 2명, 추가 1명·제외 0명·유지 1명을 표시했습니다. |
| 화면 상태를 유지한 필터 보관 | 화면을 유지한 채 실제 보관 API를 호출했습니다. 다음 비교는 `segment_not_found`를 안내하고 이전 비교 결과를 지웠으며, 명단과 CSV는 계속 조회했습니다.                               |
| 명단 페이지                  | 별도 `bulk` 필터를 API로 만들고 화면에서 고정했습니다. 첫 50명 다음 5명이 추가됐고 총 55명이 중복 없이 표시되며 더 보기 버튼이 사라졌습니다.                                       |
| 상담원 로그인                | 실제 로그아웃과 로그인 폼을 거친 뒤 고정 명단 영역이 숨겨지고 이전 비교 결과가 비워졌습니다.                                                                                       |
| 키보드                       | 명단 CSV에서 Tab으로 비교 버튼에 이동했고 Enter로 비교를 실행했습니다.                                                                                                             |
| 좁은 화면                    | 390×844 화면에서 문서 너비가 390px임을 측정하고 삭제 후 결과와 보관 오류 캡처를 직접 확인했습니다.                                                                                 |

권한 API 검사는 같은 로컬 HTTPS 서버에 합성 계정 쿠키를 보냈습니다.
상담원의 명단·비교 요청은 403 `role_forbidden`, 다른 작업 공간의 같은 요청은 404 `snapshot_not_found`였습니다.
소유자의 보관된 필터 비교는 404 `segment_not_found`였으며 명단과 CSV는 200이었습니다.

## 실패 확인과 검사 경계

- 원격 주소, 다른 DB 이름, URL query로 연결 대상을 바꾸려는 입력은 DB 연결 전에 거절됐습니다.
- 직접 만든 임시 테이블이 있는 스키마는 초기화를 거절했습니다.
- 빈 스키마여도 기존 `auto_chatter_server` 역할이 있으면 스키마를 준비하기 전에 거절했습니다.
- 첫 Miniflare 구성에서는 정적 파일은 열렸지만 API가 404였습니다.
  `assets.routerConfig.has_user_worker=true`를 지정한 뒤 실제 API와 로그인 흐름이 동작했습니다.
  재현 서버 시작 시 정적 화면 200과 비인증 `/api/me` 401을 검사해 같은 구성 오류를 드러냅니다.
  별도 임시 복사본에서 `has_user_worker=false`로 바꾸자 이 시작 검사가 `404 !== 401`로 실패했습니다.
- 다운로드 검사는 고의로 틀린 기대 식별자를 넣었을 때 `Downloaded members differ from expected fixture`로 실패했고, 실제 두 명단으로 검사했을 때 통과했습니다.
- 개발 서버를 `src/`에 두었을 때 운영 로그 검사에서 실패했습니다.
  운영 코드의 로그 예외를 늘리지 않고 `scripts/`로 옮겼습니다.

첫 PR 커밋 `f9c4d0e`의 자동 검사 결과는 다음과 같습니다.

| 명령                                          | 결과               |
| --------------------------------------------- | ------------------ |
| `corepack pnpm check-types`                   | 통과               |
| `corepack pnpm test`                          | 361개 통과, 실패 0 |
| `corepack pnpm test:db`                       | 727개 통과, 실패 0 |
| `corepack pnpm test:cloudflare`               | 80개 통과, 실패 0  |
| `node --check scripts/segment-acceptance.mjs` | 통과               |

타입 검사는 TypeScript 호출 계약을, 단위 검사는 모의 외부 경계와 클라이언트 상태를, DB 검사는 실제 질의·권한·동시성을, workerd 검사는 로컬 Worker·Hyperdrive·제한된 DB 역할을 검사합니다.
새 재현 서버는 수동 검증 도구이며 기존 `test` 명령의 실행 목록에 포함되지 않습니다.
최종 파일을 새 클러스터에서 다시 실행해 시작 검사를 통과했고, 종료 후 HTTPS 포트가 닫히며 DB 연결이 남지 않는 것도 확인했습니다.
Miniflare의 종료 훅은 SIGTERM에 종료 코드 143을 반환하므로 이를 정상 종료 결과로 구분했습니다.

## 호스팅 리뷰 수정

첫 코드 리뷰는 빈 스키마 검사가 `pg_class`만 읽어 함수·타입처럼 관계 객체가 아닌 항목을 놓친다고 지적했습니다.
함수 하나만 있는 임시 `public` 스키마에서 기존 서버가 시작되고 제품 테이블까지 생성되는 것을 확인해 문서 계약 위반을 재현했습니다.
스키마 객체의 의존성을 기록하는 [`pg_depend`](https://www.postgresql.org/docs/17/catalog-pg-depend.html)에서 `public` 네임스페이스를 참조하는 객체를 확인하도록 변경했습니다.

수정 후 테이블·함수·프로시저·enum·domain·collation을 하나씩 별도 입력으로 준비했습니다.
여섯 경우 모두 제품 테이블이나 서버 역할을 만들기 전에 거절했고, 기존 객체는 직접 제거할 때까지 남아 있었습니다.
빈 스키마에서는 최종 서버 시작 검사를 통과했으며 종료 후 포트와 DB 연결도 남지 않았습니다.
실패와 통과 기록은 `schema-guard-red.log`, `schema-guard-green.log`에 보존합니다.
이 변경은 로컬 재현 서버의 초기화 전 검사에 한정되므로 앞의 화면·제품 API 검증 범위는 변하지 않습니다.

## 증거와 남은 조건

캡처·다운로드·API 결과·명령 로그는 아래 살아 있는 작업 공간의 형제 디렉터리에 보존합니다.

```plaintext
/Users/dongminyu/Development/01_personal/pr-loop-reviews/auto-chatter/2026-10-20-segment-integrated-acceptance/
```

운영자 화면 승인은 아직 받지 않았습니다.
이번 브라우저 경로는 태그 기반 필터와 페이지 처리에 한정하며, 모든 AND/OR·필드 타입·동의·활동 기간의 화면 조합을 전수 검사하지 않았습니다.
복합 질의·5,000명을 넘는 비교·동시 수정과 삭제의 일관성·세션 변경 후 늦은 응답은 기존 DB·workerd·클라이언트 회귀의 범위와 함께 판단합니다.
새 기능이 없는 이번 작업만으로 기존 기능의 공급자·운영 수용이나 #26 전체 완료를 선언하지 않습니다.
#25의 식별자 병합·분리, #27의 외부 검증, #35의 발송 가능 여부·비용·승인·예약은 남아 있습니다.

Oracle 선례 `wiki/concepts/plan-audit-verify-against-code.md`는 이슈 표시보다 현재 코드와 실제 검사 근거를 우선하는 방향을 확인했습니다.
프로젝트 전용 세그먼트 선례는 `[no precedent found]`이며 위키 최신성은 미확인입니다.
