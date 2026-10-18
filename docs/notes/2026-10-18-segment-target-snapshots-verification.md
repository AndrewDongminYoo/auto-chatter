# 저장된 세그먼트 고정 대상 검증

## 범위

[고정 대상 계약](../specs/2026-10-18-segment-target-snapshots.md)의 로컬 검증 기록입니다.
[#35](https://github.com/AndrewDongminYoo/auto-chatter/issues/35)의 대상 고정과 [#26](https://github.com/AndrewDongminYoo/auto-chatter/issues/26)의 재평가·고정 대상 차이 설명을 다룹니다.
기준 커밋은 `0e9e8bb`이며, 이 기록은 커밋하기 전 작업 트리에서 실행한 결과입니다.
운영 마이그레이션, 배포한 Worker, 실제 인증, Meta 호출은 검증하지 않았습니다.

## 실행한 검사

PostgreSQL 17 로컬 클러스터(`127.0.0.1:5434`, `automations_test`)에서 실행했습니다.

| 명령                                    | 결과                 |
| --------------------------------------- | -------------------- |
| `corepack pnpm check-types`             | 통과                 |
| `corepack pnpm test`                    | 352개 통과, 실패 0   |
| `corepack pnpm test:db`                 | 714개 통과, 실패 0   |
| `corepack pnpm test:cloudflare`         | 80개 통과, 실패 0    |
| `psql -f deploy/migrate-multi-user.sql` | 연속 2회 종료 코드 0 |

전체 실행기를 두 번 적용한 뒤 세 삭제 함수의 `pg_get_functiondef` 해시가 `db/schema.sql`을 적용한 뒤의 해시와 같았습니다.

## DB 테스트가 확인하는 것

`src/app/segment-snapshots.db.test.ts`가 다음을 확인합니다.

- 같은 시각으로 고정한 평가에서 명단이 `listContacts`의 `segment_id` 목록과 같고, 집계가 같은 요청의 `preview=true` 결과와 같습니다. 조건 없음, 태그, 다중 태그, 필드, 최근 일수, 달력 기간, 댓글 동의, DM 동의(허용·기록 없음), 중첩 조건 그룹, 계정 한정, 빈 대상 12가지를 비교합니다.
- `member_count`는 `counts.total`과 같고, `definition`은 세그먼트 API 항목에서 `id`와 `name`을 뺀 객체입니다.
- HTTP 경로의 201 응답 키, 빈 본문과 `{}`, 다른 본문의 400, 최신순 목록, 상세의 50행 페이지와 커서, CSV의 헤더·BOM·식별자 표식·파일 이름을 확인합니다. CSV에 댓글·DM 본문, 세그먼트 이름, 계정 이름, DM 수신자 ID가 없습니다.
- 고정해도 outbox와 웹훅 전달 행이 늘지 않습니다.
- 5,001명이면 409 `snapshot_too_large`로 아무것도 쓰지 않고, 5,000명은 저장합니다. 빈 대상은 0명으로 저장합니다.
- 199개가 있을 때 두 고정 요청이 작업 공간 잠금 뒤에서 경쟁하면 하나만 성공하고 하나는 409 `snapshot_limit_reached`입니다.
- 기본 명단 행 한도는 20,000행입니다. 한도를 4행으로 낮춘 테스트에서, 남은 행과 새 명단의 합이 한도를 넘으면 409 `snapshot_members_limit_reached`로 아무것도 쓰지 않고, 한도와 같으면 저장하며, 빈 대상은 한도가 찬 뒤에도 저장합니다. 다른 작업 공간의 명단 행과 삭제로 지운 행은 세지 않습니다. 이 테스트는 코드보다 먼저 작성해 기본값 단언에서 실패하는 것을 확인했습니다.
- 보관·없음·다른 작업 공간의 세그먼트는 404 `segment_not_found`, 다른 작업 공간·없는 고정 대상은 404 `snapshot_not_found`입니다. 보관한 세그먼트도 목록을 반환합니다. 상담원은 네 경로 모두 403 `role_forbidden`이고, 역할 확인과 잠금 사이에 제거된 멤버는 403 `workspace_required`입니다.
- 고정이 연결 잠금을 가진 채 멈춘 동안 `delete_connection_data`가 기다리고, 고정이 커밋한 뒤 삭제가 그 연결의 명단 행을 지웁니다. 저장한 `member_count`는 남습니다.
- `delete_connection_data`가 연결 잠금을 먼저 가진 경우, 고정은 기다렸다가 삭제 뒤의 데이터로 평가해 그 연결의 명단 행을 하나도 저장하지 않습니다.
- 이용자 단위 삭제는 DM 수신자에서 발송이 확인된 답장으로 이어진 댓글 작성자의 명단 행을 모든 고정 대상에서 지우고, 다른 사람의 행은 남깁니다. 연결 단위 삭제는 그 연결의 행만, 작업 공간 삭제는 명단과 고정 대상을 지우며 다른 작업 공간의 고정 대상은 남깁니다. 집계 건수는 다시 계산하지 않습니다.
- 두 테이블이 `EXPORTED_TABLES`에 있고, 고정 대상만 있는 작업 공간은 초대 수락과 관리자 소유권 스크립트에서 비어 있지 않습니다.
- migration 061은 테이블과 세그먼트 고유 인덱스가 없는 상태에서 두 번 적용되고, 저장된 고정 대상을 유지하며, 세 삭제 함수를 스키마 정의와 같게 남깁니다.

기존 테스트도 고쳤습니다.
마이그레이션 031~035를 다시 적용해 삭제 함수 본문을 비교하는 다섯 테스트는 마지막에 061을 적용합니다.
테이블을 `CASCADE`로 지우는 일곱 테스트의 목록에 두 테이블을 넣어, 다시 만든 스키마에 외래 키가 남게 했습니다.
`settings.db.test.ts`의 세그먼트 마이그레이션 테스트는 되돌리는 트랜잭션 안에서 두 테이블을 함께 지웁니다.

## 실패를 확인한 검사

- 만들기 트랜잭션을 `BEGIN ISOLATION LEVEL REPEATABLE READ`로 바꾸면 200개 경쟁 테스트와 삭제 우선 테스트, 두 개만 실패했습니다. 되돌린 뒤 모두 통과했습니다.
- 본문 검사(`parseSnapshotRequest`) 호출을 지우면 단위 테스트 두 개가, CSV 허용량 사용을 건너뛰면 허용량 테스트 하나가 실패했습니다. 되돌린 뒤 모두 통과했습니다.
- `listContacts`가 만드는 SQL 문자열을 기준 커밋과 비교하는 일회성 검사에서 미리보기 4개와 목록 2개가 같았습니다. 기준 쪽의 열 이름 하나를 바꾸면 이 검사가 다르다고 보고했습니다.

대부분의 테스트는 코드를 쓴 뒤에 작성했으므로, 아래 변형을 하나씩 적용해 해당 테스트가 실패하는 것을 확인하고 되돌렸습니다.
되돌린 뒤 작업 트리의 diff 해시가 변형 전과 같았고, 두 테스트 파일을 다시 실행해 모두 통과했습니다.

| 변형                                                              | 실패한 테스트                                   |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| `db/schema.sql`의 이용자 단위 삭제에서 명단 행 `DELETE` 제거      | 삭제 함수 테스트, migration 061 재적용 테스트   |
| `currentWorkspaceMovable`에서 고정 대상 `EXISTS` 제거             | 내보내기·이동 검사 테스트(초대 수락 단계)       |
| `deploy/assign-workspace-owner.sql`에서 고정 대상 `EXISTS` 제거   | 내보내기·이동 검사 테스트(관리자 스크립트 단계) |
| `deploy/supabase-access.sql`에서 두 테이블의 `REVOKE UPDATE` 제거 | `access.db.test.ts`의 권한 테스트               |
| `deploy/init-app-user.sh`에서 두 테이블의 `REVOKE UPDATE` 제거    | `access.db.test.ts`의 권한 테스트               |
| 명단 선택에서 `HAVING ${sql.activityMatches}` 제거                | 목록·미리보기와 같은지 비교하는 테스트          |
| 명단 한도 비교를 `> maxMembers + 1`로 완화                        | 5,000명 한도 테스트                             |
| 명단 행 한도 비교를 `> maxStoredMembers + 1`로 완화               | 명단 행 한도 테스트                             |

migration 061의 잠금은 되돌리는 트랜잭션에서 061 전체를 실행한 뒤 `pg_locks`로 확인했습니다. 세그먼트 테이블에는 `AccessShareLock`, `ShareLock`, `ShareRowExclusiveLock`만 잡혔습니다. 같은 확인을 이전의 `ADD CONSTRAINT ... UNIQUE`로 하면 `AccessExclusiveLock`이 잡혔고(리뷰 확인), `supabase-access.sql`만 실행해도 `AccessExclusiveLock`이 잡힙니다.

변형으로 확인하지 않은 테스트는 workerd 테스트(`runtime.db.test.mjs`)와 `/privacy` 문구 테스트입니다.

## Cloudflare

`src/cloudflare/runtime.db.test.mjs`의 workerd 테스트가 제한된 `auto_chatter_server` 역할로 세그먼트를 만들고, 본문 없이와 `{}`로 고정하고, 목록·상세·CSV를 읽습니다.
서버 역할은 두 테이블에 SELECT와 INSERT만 있고 UPDATE와 DELETE가 없습니다.
상담원은 네 경로에서 403이고, 다른 작업 공간의 사용자는 404입니다.
`src/cloudflare/access.db.test.ts`는 Compose와 Supabase 권한 스크립트 뒤의 세 역할 구간에서 두 테이블의 UPDATE·DELETE 거부와 API 역할의 SELECT 거부를 확인합니다.

## 화면

`public/app/segment-snapshots.js`와 `app.js`의 연결 코드를 실행하는 테스트 도구는 없습니다.
정적 보안 테스트(`static-security.test.ts`)는 새 스크립트도 읽어 HTML·코드 싱크가 없음을 확인합니다.
`[UNVERIFIED: real browser]`: 이 Mac에는 Playwright 브라우저 바이너리만 캐시되어 있고 Playwright 라이브러리가 설치되어 있지 않습니다. 새 의존성을 추가할 수 없어 브라우저 검사를 실행하지 않았습니다.
화면에서 확인할 것은 대상 고정 버튼의 비활성 조건(선택 없음, 세그먼트 요청 중, 저장하지 않은 수정), 목록의 작업 공간 시간대 표시, 명단 더 보기, CSV 저장, 세그먼트 보관·로그아웃 뒤 목록 초기화입니다.

## 남은 범위

메시지·템플릿 검증, 발송 가능 여부와 비용 미리보기, 승인·예약, 일괄 발송은 #35의 후속 항목과 #36에 남아 있습니다.
`/privacy`의 시행일은 배포할 때 바꿉니다.
