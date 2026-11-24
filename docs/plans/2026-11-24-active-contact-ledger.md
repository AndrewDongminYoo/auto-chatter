# 청구월 활성 연락처 원장 구현 계획

[설계](../specs/2026-11-24-active-contact-ledger-design.md)를 [이슈 #51](https://github.com/AndrewDongminYoo/auto-chatter/issues/51)에 맞춰 구현하는 순서입니다.
PR 두 개로 나눕니다. PR ①은 원장과 기록, 삭제, 내보내기, 재계산 테스트이며 화면 변경이 없습니다. PR ②는 사용량 API와 요금제 카드 표시입니다.
운영 DB 적용과 배포는 각 PR이 병합된 뒤 조회·백업·migration 적용·배포를 명시한 별도 승인으로 진행합니다.

## 원장을 쓰는 지점

| 활동                                         | 쓰는 곳                                                                                                         | 이유                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 댓글 수신                                    | `instagram_comment_events`의 AFTER INSERT 트리거                                                                | 수집 경로가 여러 곳이어도 저장은 이 표 하나입니다.                                                    |
| 수신 DM                                      | `src/instagram/follow-flow.ts`의 `recordLastInboundDms`와 같은 트랜잭션에서 메시지 묶음 전체를 한 문장으로 기록 | 인박스 설정과 관계없이 모든 수신 텍스트 DM이 이 함수를 거치지만, 그 표는 상대별 최신 시각만 남깁니다. |
| 비공개 답장, 수동 답장, 캠페인, DM 플로 발송 | 각 표의 AFTER UPDATE 트리거, 상태가 `sent`로 바뀔 때                                                            | Node 워커와 Cloudflare 경로가 같은 표를 씁니다. 경로마다 INSERT를 넣으면 빠뜨리기 쉽습니다.           |
| 팔로우 확인 메시지                           | `instagram_follow_messages`의 AFTER INSERT 트리거                                                               | 발송에 성공한 메시지만 이 표에 들어갑니다.                                                            |

- 트리거 함수는 원장 INSERT를 `ON CONFLICT DO NOTHING`으로 하고, 예외를 잡아 `WARNING`만 남긴 뒤 원천 쓰기를 계속합니다(설계의 anti-goal: 원장 실패가 수신·발송을 실패시키지 않음). 수신 DM 기록도 같은 이유로 savepoint 안에서 실행하고 실패하면 고정 코드로 `logOperation`만 남깁니다.
- 확인 버튼 응답처럼 `recordLastInboundDms`가 24시간 창 계산에서 빼는 메시지도 사람이 보낸 DM이므로 원장에는 셉니다. 원장 기록은 그 함수의 필터와 별도로 받은 메시지 전체를 씁니다.

## 단계

### PR ① 원장

1. migration 077과 `db/schema.sql`: 원장 표(외래 키 없음, 작업 공간·청구월·연결·사람 키 종류·사람 키·최초 활동 시각·활동 종류·쓴 시간대), 고유 제약(작업 공간, 청구월, 연결, 사람 키 종류, 사람 키), 사람 키를 정하는 SQL 함수(현재 유효한 신원 연결 규칙), 트리거 다섯 개, 이번 청구월 초부터의 채우기. `deploy/migrate-multi-user.sql`에 넣고 `deploy/supabase-access.sql`과 `deploy/init-app-user.sh`의 권한을 맞춥니다(SELECT·INSERT·UPDATE, DELETE 없음).
   → 검증: 빈 클러스터에 `db/schema.sql`, main 스키마에 077을 각각 적용해 `pg_get_functiondef`, 열, 색인, 트리거가 같은지 비교합니다.
2. 수신 DM 기록을 `recordLastInboundDms` 옆에 추가합니다.
   → 검증: 인박스가 꺼진 연결의 DM, 확인 버튼 응답, 같은 웹훅 재전송, 역순 도착을 다루는 DB 테스트.
3. 삭제 함수 세 개가 원장 행을 지우지 않고 사람 키를 NULL로 바꿉니다. `EXPORTED_TABLES`에 등록하고, 작업 공간 이동 검사에 해당하는지 확인합니다.
   → 검증: 각 삭제 뒤 그 달 숫자가 그대로이고 원장에 Instagram ID가 남지 않는다는 DB 테스트, `src/app/workspace-export.ts`의 목록 테스트.
4. 재계산: 원천 활동과 원장 행에 저장된 시간대·사람 키로 원장을 다시 만드는 쿼리와, 저장된 원장과 비교하는 DB 테스트.
   → 검증: 중복·지연·역순 이벤트, 시간대가 다른 두 작업 공간의 월말 자정 전후, 신원 연결 전후(소급 없음), 실패·차단·취소 발송은 세지 않음, 원장 기록 실패가 원천 쓰기를 막지 않음을 각각 한 번 실패시켜 본 뒤 통과시킵니다.
5. `docs/agents/feature-invariants.md`에 원장 절을 추가하고 `CLAUDE.md`의 "Rules for every change" 등록 목록에 해당 내용이 필요한지 확인합니다. 설계 문서의 "빌더에게 맡기는 것"에서 정한 내용을 spec에 적습니다.
   → 검증: `corepack pnpm check-types`, `lint`, `test`, `test:db`, `test:cloudflare`, `trunk check --all`.

### PR ② 표시

6. 사용량 API: 작업 공간의 이번 청구월과 지난 청구월 활성 연락처 수를 돌려줍니다. 집계는 원장에서 읽고, 청구월은 작업 공간의 현재 시간대로 정합니다. 기존 요금제 응답에 붙일지 별도 경로로 둘지는 기존 응답 구조를 보고 정합니다.
   → 검증: API 단위 테스트와 역할 검사, DB 테스트.
7. 설정의 요금제·사용량 카드에 두 숫자를 더합니다.
   → 검증: 로컬 모의 API 미리보기를 보여 드리고 승인받은 뒤 커밋합니다. 밝은 테마와 어두운 테마, 좁은 화면을 확인합니다.

## 범위 밖

요금제 포함량과 초과 사용 처리(#52), 결제(#54), 월별 보고서와 CSV, 운영 반영.

## 2026-11-24 정정

PR ① 구현에서 위 단계와 다르게 정한 것입니다.
단계 본문은 승인된 기록이므로 고치지 않습니다.

- 권한: 서버 역할에는 원장 표의 SELECT와 INSERT, 원장 함수 `active_contact_linked_sender`와 `record_active_contacts`의 EXECUTE만 줍니다.
  1단계의 SELECT·INSERT·UPDATE에서 UPDATE를 뺐습니다.
  사람 키는 쓸 때 정하고 삭제 함수만 지우기 때문입니다.
- 댓글 기록: "원장을 쓰는 지점" 표의 `instagram_comment_events` AFTER INSERT 트리거 대신 `ingestComments`의 마지막 문장에서 savepoint 안에 기록합니다.
  트리거는 같은 작성자의 새 댓글 수집과 이전 답장의 발송 마무리 사이에 교착을 만들었고, DB 테스트가 이를 재현했습니다.
  트리거 다섯 개가 아니라 발송 트리거 다섯 개(비공개 답장, 수동 답장, 캠페인, DM 플로, 팔로우 메시지)를 둡니다.
- 발송 경로: 모든 발송 마무리에서 `sent` 갱신(팔로우는 메시지 INSERT)이 잠금을 잡는 마지막 문장임을 확인했으므로 발송 경로 코드는 바꾸지 않았습니다.
  경로별 결과는 [설계](../specs/2026-11-24-active-contact-ledger-design.md)의 "PR ①에서 정한 것"에 있습니다.
- 이번 달 채우기: 1단계의 "이번 청구월 초부터의 채우기"는 migration 077에서 빼서, 코드 배포 뒤에 한 번만 실행하는 `deploy/backfill-active-contacts.sql`로 옮깁니다.
  실행기가 배포마다 모든 migration을 다시 실행하므로, 077 안의 채우기는 그때의 신원 연결과 시간대로 지난 활동을 다시 기록해 같은 사람을 한 달에 두 번 셀 수 있기 때문입니다.
  배포 뒤에 실행하므로 migration과 배포 사이에 들어온 댓글과 수신 DM도 원천 표에 남아 있으면 기록됩니다.
- 대기 한도: 모든 원장 쓰기는 서버에서 `lock_timeout` 2초까지만 다른 트랜잭션의 원장 키를 기다립니다(트리거 함수의 함수 속성, 수집 경로 savepoint 안의 `SET LOCAL`).
- 시간대: `record_active_contacts`는 `AT TIME ZONE`이 거부하는 시간대의 작업 공간 활동만 건너뛰고 같은 호출의 다른 작업 공간은 기록합니다.
- 내보내기: 3단계의 "`EXPORTED_TABLES`에 등록"과 달리 원장 행은 내보내지 않고(`EXCLUDED_TABLES`), 청구월과 연결별 행 수만 `active_contact_months`로 내보냅니다(운영자 결정).
- PR ②: 삭제 기록의 원장 개수와 그 라벨을 더합니다.
