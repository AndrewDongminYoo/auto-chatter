# 보안 회귀 점검 4차: 발송 경로, 읽기·데이터 경로 (#62)

## 범위

[3차 점검](2026-10-12-security-regression-audit-3.md)(`c2d6e88`) 뒤에 합쳐진 기능을 두 부분으로 나눠 코드와 자동 테스트에 대응시켰습니다.
1부는 발송 경로를 2026-11-09 `main` `41951e7` 기준으로, 2부는 읽기·데이터 경로를 같은 날 `main` `05f803f`(1부를 합친 #307) 기준으로 점검했습니다.
1부의 대상은 다섯 묶음입니다.

1. 캠페인: 초안 #242와 화면 #243, 발송 조건 미리보기 #258과 화면 #261, 실행 승인 #264와 화면 #267, 실행 #269, 발송 worker #272, 실행 현황 화면 #276, 수정 #279·#282·#284, migration 063~067
2. DM 시작 트리거: 시작 기록 #295(migration 068), 재전달 제외와 advisory lock #297, DM 플로 발송 worker #298(migration 069), 계정 읽기 #303, 편집기 #304
3. 사용자 신원 연결 확인 #241
4. 일회성 예약 답장 #211(migration 049)
5. 세션 강화: 폐기된 세션의 요청 재전송 방지 #244, 인증 쿠키 전환 직렬화 #253

2부의 대상은 다섯 묶음이며, 기능별 결과의 8~14번입니다.

1. 연락처 CSV 내보내기 요청 한도 #202
2. 세그먼트: 저장 전 미리보기 #204, 정확한 수 #206, 제외 사유 #207, 마지막 댓글 활동 #208, 기록된 동의 #209, 상대 기간 #215, 저장된 필터 수정 #218, 달력 기간 #220, 여러 태그 #222, 여러 필드 조건 #224, 저장된 필터 CSV 내보내기 #226, 확인된 DM 동의 #227, 최근 DM #228, 두 단계 조건 그룹 #230과 화면 #231, 대상 고정 #232, CSV 내보내기당 한 번 평가 #236, 고정 대상 목록 #237, 고정 대상 비교 #238, migration 046·047, 053~061
3. 답장 템플릿 #210(migration 048)
4. 보고서: 수동 답장 현황과 CSV #212, 플로 실행 현황 #213, 상담 전환 이력 #214(migration 050~052)
5. CSV 태그 변경: 검사 #216, 검사한 CSV 적용 #217

AI 자원(#55~#57)은 아직 구현되지 않아 이번에도 제외했습니다.
기능별 불변 조건은 [CLAUDE.md](../../CLAUDE.md), [기능별 불변 조건](../agents/feature-invariants.md)과 각 명세가 소유하므로 여기서 다시 적지 않습니다.

방법은 1~3차와 같습니다.
각 기능마다 누가 호출할 수 있는지, 악의적인 호출자가 무엇을 시도할 수 있는지, 방어가 어디에 있는지, 그 공격을 실제로 시도하는 테스트가 무엇인지를 적고, 테스트가 없던 변형에는 그 영역을 소유한 기존 테스트 파일에 회귀 테스트를 추가했습니다.
추가한 테스트는 기존 방어를 지키는 회귀 테스트이므로 처음부터 통과합니다.
그래서 테스트마다 방어 코드를 일시적으로 제거하거나 결함을 심어 실패를 한 번 확인한 뒤 원래 코드로 되돌렸고, 되돌린 뒤 `git diff --stat`에 테스트 파일만 남는 것을 확인했습니다.
1부와 2부 모두 작은 수정으로 고칠 실제 결함은 찾지 못했으므로 제품 코드는 바꾸지 않았습니다.

## 기능별 결과

### 1. 캠페인 초안, 미리보기, 실행 승인 (#242, #243, #258, #261, #264, #267, migration 063·064)

모든 경로(`/api/campaign-drafts`, `/api/campaign-drafts/:id/preview`, `/api/campaign-drafts/:id/approvals`, `/api/campaign-approvals`)는 활성 `admin` 이상만 부를 수 있습니다.
시도할 수 있는 공격은 상담원이나 다른 작업 공간의 사용자가 초안·승인을 읽거나 쓰는 것, 다른 작업 공간의 고정 대상(snapshot)을 참조하는 것, 같은 요청 키를 다른 내용으로 재사용하거나 예전 요청을 다시 보내 나중의 수정을 되돌리는 것, 승인과 초안 수정·보관을 엇갈리게 실행해 승인하지 않은 본문이 실행되게 하는 것, 미리보기로 데이터를 쓰는 것, 큰 본문이나 제어 문자를 저장하는 것입니다.
방어는 `src/app/campaign-drafts.ts:52-54`의 `membershipFor(..., "admin")`와 쓰기 때의 `lockWorkspaceForMember`, 읽기의 `REPEATABLE READ READ ONLY` 트랜잭션, 요청 해시와 `expected_version` 확인, 승인이 유효한 동안 초안 수정·보관을 막는 `approval_active`(`campaign-drafts.ts:300`), 승인 쪽의 초안 `FOR UPDATE`(`src/app/campaign-approvals.ts:180`), 이미 실행한 버전의 재승인을 막는 `campaign_version_executed`(`campaign-approvals.ts:204`), 그리고 작업 공간을 포함한 외래 키입니다.
서버 역할은 `campaign_approval_events`를 UPDATE하거나 어느 캠페인 테이블도 DELETE할 수 없습니다(`deploy/supabase-access.sql`, `deploy/init-app-user.sh`).
기존 테스트는 `campaign-drafts.db.test.ts`의 "campaign writes reject agents, foreign snapshots and stale versions", "campaign creation replay preserves edited current state and rejects a different original payload", "campaign request validation rejects unresolved templates and malformed inputs", `campaign-draft-preview.db.test.ts`의 "only active admins of the draft's workspace preview it, archived drafts included"와 "counts sum to the remaining members after a person deletion, and the preview writes nothing", `campaign-approvals.db.test.ts`의 "only active admins reach every approval route, and an agent is refused before any ID is read", "missing, foreign and malformed IDs answer the same 404, and malformed requests 400", "the foreign keys keep an approval's draft and snapshot in its own workspace", "a retry of the original request returns the current state and never undoes later changes", "approval needs the draft's current version and no approval in force, also under concurrency", "an approval and a draft edit or archive serialize on the workspace lock in both orders", 그리고 `access.db.test.ts`의 DELETE·UPDATE 거부입니다.
빈틈은 찾지 못했습니다.

### 2. 캠페인 실행과 발송 (#269, #272, #276, #279, #282, #284, migration 065~067)

실행은 `SEND_ENABLED`가 켜진 동안 cron 단계 `campaign_start`만 시작하고, 발송은 Cloudflare 큐 소비자만 합니다.
사용자가 부르는 경로는 실행 읽기 `GET /api/campaign-runs/:id`와 취소 `POST /api/campaign-runs/:id/cancel`(`admin`, `expected_version`)뿐입니다.
시도할 수 있는 공격은 같은 행의 이중 발송, 취소·정지·수신 거부·상담 전환·연결 해제·승인자 제거와 발송 사이의 경쟁, 24시간 창 밖이나 마케팅 동의 없는 발송, 다른 작업 공간의 실행 읽기·취소, 실행 응답으로 수신자 식별자 얻기, 발송 중인 행이 있는데 데이터 삭제로 증거 지우기입니다.
방어는 `src/app/campaign-runs.ts:34-43`의 작업 공간·승인·초안 잠금 순서와 같은 트랜잭션의 재평가, `campaign_runs`의 `(workspace_id, approval_id)` 유일 제약, 발송 worker의 `FOR UPDATE OF d SKIP LOCKED` claim과 `attempt_id` 조건부 쓰기, 그리고 claim 뒤·계정 읽기 뒤·`beforeSend`(POST 직전)에 세 번 실행하는 최종 guard `assertCampaignDeliveryAllowed`(`src/instagram/campaign-delivery-worker.ts:69`)입니다.
guard는 미리보기의 `RECIPIENT_STAGE`, `CONNECTION_SENDABLE`, `CONTACT_PAUSED` 조각, 승인자의 활성 `owner`/`admin` 멤버십(`campaign-delivery-worker.ts:35-47`, `:81`), `deliveryRecipientOptedOut`(`:104`)을 읽습니다.
세 삭제 함수는 `sending` 행이 있으면 `sending_in_progress`로 거부합니다.
기존 테스트는 `campaign-delivery-worker.db.test.ts`의 최종 guard 표 테스트 15개("the final guard: ..."), "two workers claim one row each, and a held row is skipped rather than waited on", "a run cancelled between the claim and the POST lands the claimed row cancelled", "the guard immediately before the POST sees a change made after the second guard", "a consent read failure defers the row as consent_unavailable", "stale sending rows become unknown, and the cron completion then completes their run"와, `campaign-runs.db.test.ts`의 "two concurrent starts write one run and one row per member; the member key refuses a duplicate", "a start and an approval cancel or schedule change serialize in either order", "cancelling a run cancels its pending rows only, and the read returns counts without identifiers", "two workspaces that hold the same approval ID each start their run", "connection, person and workspace deletion remove delivery rows and refuse while one is sending"입니다.
"cancelling a run ..."은 상담원의 읽기·취소 `403`과 다른 작업 공간의 `404`도 확인합니다.
빈틈은 POST 직전 단계(`beforeSend`)를 시도하는 테스트가 24시간 창 하나뿐이었다는 점입니다.
CLAUDE.md는 모든 자동 발송 경로가 claim 뒤와 POST 직전에 연락처 정지와 서비스 수신 거부를 다시 확인하도록 요구하므로, 연락처 정지, 상담 전환 정지, 댓글 작성자의 수신 거부, 연결된 다른 DM 수신자의 수신 거부, 마케팅 동의 철회를 POST 직전에 시도하는 테스트를 추가했습니다.

### 3. DM 시작 트리거와 DM 플로 발송 (#295, #297, #298, #303, #304, migration 068·069)

시작은 서명된 웹후크의 메시지 수신(`ingestMessages`)만 하고, 발송은 Cloudflare 큐 소비자의 `processNextDmFlowDelivery`만 합니다.
플로 편집기의 쓰기·발행·켜기는 `admin` 이상(`src/app/flows.ts:92`, `:134`, `:271`, `:390`), 읽기는 `agent` 이상입니다.
시도할 수 있는 공격은 재전달·중복 전달로 두 번 시작하거나 다른 소비자(팔로우 확인, 응답 대기, 보관 DM)와 같은 메시지를 나눠 갖는 것, 다른 연결이나 다른 작업 공간의 플로를 시작하게 하는 것, 수신 거부·상담 전환·정지된 메시징 ID에 보내는 것, 오래된 대화에 24시간 창 밖으로 보내는 것, 다른 연결의 DM이나 postback으로 창을 다시 여는 것, 동시에 켜기로 같은 연결에 기본 응답 플로를 둘 켜는 것, 자기 계정의 echo로 자기에게 보내는 것, 같은 행의 이중 발송입니다.
방어는 `src/instagram/follow-flow.ts:53`의 메시지 ID별 advisory lock(`lockMessageIds`), `src/instagram/dm-start-trigger.ts`의 연결 `FOR SHARE` 조회와 `v.trigger_connection_id` 조건, `startBlocked`의 기존 소비자·재전달·수신 거부·상담 전환 확인, `instagram_dm_start_events`의 `(connection_id, message_id)` 유일 제약, `flow_versions`의 `(trigger_connection_id, workspace_id)` 외래 키, 발행·켜기의 연결 `FOR NO KEY UPDATE` 잠금과 `dmTriggerConflicts`(`flows.ts:405-430`), `src/instagram/message-events.ts`의 `is_echo`·`is_self`·자기 계정 발신자 제외, 그리고 `src/instagram/dm-flow-delivery-worker.ts`의 `SKIP LOCKED` claim, `attempt_id` 조건부 쓰기, `WINDOW_ANCHOR`(연결과 발신자로 묶은 시작 기록과 `kind='text'` 수신 메시지)와 `assertDmFlowDeliveryAllowed`입니다.
기존 테스트는 `dm-start-trigger.db.test.ts`의 "a redelivered DM, a disabled flow, a postback and a sender ID the tables cannot store start nothing", "a concurrent redelivery waits for the delivery that started a DM flow and is not taken", "a redelivered DM that started a DM flow is taken by neither the follow confirmation nor the kept-DM store", "an opted-out messaging identity and a handed-off conversation start nothing", "a comment sender's revoke blocks the messaging ID a provider-acknowledged reply bridged to it", "no claim of another send path, worker or resume selects a DM delivery row", "enable and publish refuse a second default reply and overlapping keywords on one connection", `dm-flow-delivery-worker.db.test.ts`의 최종 guard 표 테스트 12개, POST 직전 guard 테스트 4개, "the 24-hour window is anchored on the sender's latest inbound DM and read on the database clock", "stale sending rows become unknown and are never claimed again", "the deletion functions refuse while a DM flow row is sending or held, and remove the messaging-ID pause", `flows.db.test.ts`의 "publish checks connection ownership, activity and login mode", `follow-flow.test.ts`와 `channel-adapter.test.ts`의 echo·`is_self` 제외입니다.
빈틈은 네 가지였습니다.

- 시작 트리거가 메시지를 받은 연결의 플로만 고르는지(`v.trigger_connection_id=$2`)를 시도하는 테스트가 없었습니다. 같은 작업 공간의 다른 연결에 켜진 기본 응답 플로가 있어도 이 연결의 DM이 그 플로를 시작하지 않는지 확인하는 테스트를 추가했습니다.
- 켜기 경쟁은 순차 테스트만 있었습니다. 서로 다른 두 기본 응답 플로의 켜기는 서로 다른 플로 행을 잠그므로 둘을 직렬화하는 것은 연결 잠금뿐입니다. 동시 켜기에서 하나만 켜지는지 확인하는 테스트를 추가했습니다.
- POST 직전 guard 테스트에 응답 다리로 연결된 댓글 작성자의 수신 거부가 없었습니다. 추가했습니다.
- 창 기준의 연결 조건은 받은 메시지 쪽만 시험했고, 다른 연결에 생긴 같은 발신자의 시작 기록은 시험하지 않았습니다. 또 다른 worker가 잡은 행을 건너뛰는지(`SKIP LOCKED`)와 두 worker가 서로 다른 행을 하나씩 보내는지를 시도하는 테스트가 없었습니다. 둘 다 추가했습니다.

### 4. 사용자 신원 연결 확인 (#241, migration 062)

읽기는 `agent` 이상, 확인·분리는 `admin` 이상(`src/app/contact-identity-links.ts:62`, `:66`)이 표시된 버전과 요청 키로만 할 수 있습니다.
시도할 수 있는 공격은 숫자 ID나 사용자 입력만으로 다른 사람의 DM 신원을 연결해 동의·발송 대상을 넓히는 것, 다른 작업 공간의 연락처를 연결하는 것, 예전 요청으로 나중의 분리를 되돌리는 것, 같은 버전의 동시 확인, 개인 데이터 삭제와 경쟁해 기록을 남기는 것입니다.
방어는 확인 때 현재 `verifiedDmRecipientsSql` 증거 ID를 다시 요구하는 조건, `expected_version`과 요청 키, 작업 공간 잠금, 그리고 연결 기록이 동의를 옮기거나 발송 guard를 바꾸거나 삭제 범위를 넓히지 않는다는 설계입니다.
서버 역할은 `instagram_contact_identity_link_events`를 UPDATE할 수 없습니다.
기존 테스트는 `contact-identity-links.db.test.ts`의 열세 개("identity writes require admin ownership and reject unknown or malformed targets and bodies", "confirmation rechecks current unique fresh evidence rather than numeric identity or operator input", "same-version concurrent confirmations produce one event and one conflict", "identity requests are idempotent without reverting a later version", "a confirmation waiting behind personal deletion rereads the missing original", "all original product rows stay unchanged by confirmation and detachment" 포함)와 `access.db.test.ts`의 UPDATE 거부입니다.
빈틈은 찾지 못했습니다.

### 5. 일회성 예약 답장 (#211, migration 049)

예약 답장은 `agent` 이상이 만들고, 바꾸거나 취소하는 것은 만든 사람이나 활성 `admin` 이상만 할 수 있습니다(`src/app/manual-replies.ts:314-323`).
시도할 수 있는 공격은 다른 상담원의 예약을 바꾸거나 취소하는 것, 다른 작업 공간의 예약을 건드리는 것, 같은 요청 키를 다른 내용이나 다른 사용자로 재사용하는 것, 제거된 멤버가 만든 예약이 나중에 발송되는 것, 24시간 창 밖의 시각으로 예약하는 것, 발송 중인 예약을 바꾸는 것입니다.
방어는 위 역할 조건과 요청 지문·`actor_id` 비교, `schedule_version` 확인, 그리고 발송 worker가 POST 직전에 만든 사람의 활성 멤버십을 다시 읽는 조건(`src/instagram/manual-reply-worker.ts:107`)입니다.
기존 테스트는 `settings.db.test.ts`의 "scheduled manual reply changes are versioned idempotent scoped and cancelled without a send", "scheduled manual reply rechecks removed creators at the final provider guard", "scheduled manual reply rejects invalid wall times and times outside the current reply window", "scheduled manual reply claim prevents edit or cancellation while provider verification is in flight", "scheduled manual reply permits its creator and administrators and keeps valid agent permission", "scheduled manual reply edit and cancel race has one version winner", 계정 확인 뒤의 창 만료·상담 전환 변경·수신 거부를 시도하는 "scheduled manual reply blocks ${failureCode} after verification without a provider POST" 세 개와 `worker.db.test.ts`의 "scheduled manual reply rejects a removed creator in the Cloudflare provider guard", "Cloudflare opt-out final guards block private follow and manual POST"입니다.
예약 답장은 즉시 수동 답장과 같은 worker와 최종 guard를 쓰므로, CLAUDE.md가 요구하는 POST 직전의 서비스 수신 거부와 상담 전환(파생 정지) 재확인도 이 테스트들이 시도합니다. 수동 답장은 사람이 보내는 답장이라 연락처의 수동 정지가 아니라 유효한 상담 전환을 요구합니다([기능별 불변 조건](../agents/feature-invariants.md#inbox)).
빈틈은 두 가지였습니다.
다른 상담원과 다른 작업 공간의 사용자가 수정을 시도하는 테스트는 있었지만 취소를 시도하는 테스트는 없었습니다. 수정과 취소가 같은 처리기를 쓰지만, 취소 쪽에서만 조건이 빠지는 변경을 잡도록 테스트를 보탰습니다.
또 같은 요청 키를 다른 내용으로 재사용하는 테스트는 있었지만, 다른 멤버가 만든 사람의 요청 키를 그대로 다시 보내는 테스트는 없었습니다. 추가했습니다.

### 6. 세션 강화 (#244, #253)

두 PR은 대시보드 클라이언트(`public/app/app.js`)만 바꿨습니다. 서버의 세션 확인(`AuthClient.user`의 원격 사용자 확인과 쿠키 중복 거부)은 바뀌지 않았고 `auth.test.ts`가 계속 확인합니다.
시도할 수 있는 공격은 로그아웃하거나 다른 계정으로 로그인한 뒤 폐기된 세션의 대기 요청이 새 세션으로 자동 재전송되는 것, 한 문서의 새로 고침과 다른 문서의 로그인이 쿠키를 엇갈리게 바꾸는 것, 이전 세션의 늦은 응답이 새 세션 화면에 데이터를 보이는 것입니다.
방어는 `api()`(`app.js:530`)의 작업 공간 세대 확인, 쿠키를 바꾸는 요청의 배타적 Web Lock과 보호 요청의 공유 잠금(`app.js:607`), 문서가 받아들인 세션 revision 비교입니다.
기존 테스트는 `auth-session.test.ts` 열다섯 개("a protected replay waits for a queued login and rejects its retired input", "initial protected writes wait for account transitions and reject without sending", "late protected error bodies do not expose another session's structured data", "automatic refresh fails closed without cross-document locks or shared storage" 포함)입니다.
빈틈은 찾지 못했습니다.

### 7. SECURITY DEFINER 함수, 열 권한, 데이터 경로 등록

migration 063~069는 새 SECURITY DEFINER 함수를 추가하지 않았습니다.
`db/schema.sql`을 빈 DB에 적용하고 `pg_proc`에서 `prosecdef`인 public 함수를 읽으면 `delete_connection_data`와 `delete_expired_oauth_states` 둘뿐이고, 둘 다 `search_path=public, pg_temp`입니다.
`access.db.test.ts`의 카탈로그 전체 검사가 이미 이 목록을 정확히 비교하므로 그 테스트는 바꾸지 않았습니다.
새 테이블(`campaign_*` 다섯 개, `instagram_dm_start_events`, `flow_dm_deliveries`, `instagram_dm_automation`)은 모두 같은 테스트의 카탈로그 검사(RLS, API 역할 권한 없음, 서버 역할 DELETE·TRUNCATE 없음)를 받습니다.
열 단위 권한은 3차 점검의 `workspaces` 외에 새로 생긴 것이 없고, 표 단위 UPDATE 회수는 `campaign_approval_events`에 적용됐습니다.
새 테이블 여덟 개는 모두 `src/app/workspace-export.ts`의 `EXPORTED_TABLES`에 있고, `campaign_drafts`와 `campaign_approvals`는 `create_request_hash`를 뺍니다. `workspace-export.db.test.ts`의 "every public table is exported or explicitly excluded, and secret-like columns are omitted"가 이 등록을 강제합니다.
삭제 함수 등록은 `campaign-approvals.db.test.ts`의 "the export carries both tables without the request hash, and workspace deletion removes them", `campaign-runs.db.test.ts`의 "connection, person and workspace deletion remove delivery rows and refuse while one is sending", `dm-start-trigger.db.test.ts`의 "person, connection and workspace deletion remove the DM start events, runs and delivery rows", `dm-flow-delivery-worker.db.test.ts`의 "the deletion functions refuse while a DM flow row is sending or held, and remove the messaging-ID pause"가 확인합니다.
작업 공간 이동 확인은 연결 행 없이 존재할 수 있는 캠페인 테이블만 필요하며, `campaign-drafts.db.test.ts`의 "a draft alone blocks both workspace move paths", `campaign-approvals.db.test.ts`의 "an approval or its audit alone blocks both workspace move paths", `campaign-runs.db.test.ts`의 "the export carries runs and delivery rows, and either table alone blocks both workspace move paths"가 확인합니다. `instagram_dm_start_events`, `flow_dm_deliveries`, `instagram_dm_automation`은 `db/schema.sql`에서 `(connection_id, workspace_id)` 외래 키로 연결 행을 요구하므로 이동 확인에 넣을 필요가 없습니다.

### 8. 연락처 CSV 내보내기와 저장된 필터 CSV 내보내기 (#202, #226, #236)

`GET /api/contacts/export.csv`는 활성 `admin` 이상만 받을 수 있고, `segment_id` 하나를 붙이면 그 필터의 연락처만 내보냅니다.
시도할 수 있는 공격은 상담원이나 다른 작업 공간 사용자의 내보내기, 다른 작업 공간이나 보관된 필터의 `segment_id`, 다른 질의 키나 중복 키, 반복 요청으로 무거운 내보내기를 계속 돌리는 것, 행·크기 한도를 넘겨 잘린 파일을 받는 것, 그리고 계정 이름·태그·필드 값으로 스프레드시트 수식(셀이 `=`, `+`, `-`, `@`, 탭, CR로 시작)을 넣는 것입니다.
방어는 DB를 열기 전에 질의 모양을 확인하고 사용자별 `CONTACT_EXPORT_LIMIT`를 닫힌 쪽으로 쓰는 `src/app/api.ts:260-268`, 내보내기 트랜잭션 안에서 멤버십과 역할을 다시 읽는 `src/app/contact-csv.ts:150-158`, 같은 스냅숏에서 필터를 읽는 `savedSegmentConditions`(작업 공간과 `NOT archived` 조건), 행·바이트·시간 한도를 넘으면 파일 전체를 거절하는 `ContactCsvBuffer`, 그리고 앞쪽 공백·제어·서식 문자 뒤의 수식 문자(전각 포함)와 모든 식별자에 `'`를 붙이는 `contactCsvScalar`(`contact-csv.ts:25-29`)입니다.
태그와 필드는 `[`나 `{`로 시작하는 JSON 셀로만 들어갑니다.
기존 테스트는 `api.test.ts`의 "contact CSV export fails closed before opening the database (#196)", "contact CSV export validates the session and query before spending the user's allowance (#196)", "segment CSV export accepts exactly one UUID segment_id before spending the allowance", `contact-csv.test.ts`의 "account text markers cover hidden and full-width formula prefixes while safe names stay unchanged", "IDs always get a reversible text marker, retaining leading zeroes and values above 2^53", "JSON cells retain typed zero false empty strings and quoted injection-like nested values", `contact-csv.db.test.ts`의 "CSV GET returns fixed download headers and owner/admin empty files, never agent or missing/removed membership", "CSV GET rejects every query parameter including duplicates", "CSV deduplicates comments per connection, includes disconnected connections and preserves exact typed source values"(계정 이름 `" \u200b＝SUM(1,2)"`), "CSV excludes other workspaces and raw message/credential/evidence/private-note tables without changing rows or notifying", "production row cap responds with a JSON error and no attachment rather than a truncated CSV", "segment export answers segment_not_found for archived missing and foreign segments, and refuses agent and removed members", "segment export evaluates one as_of for all batches even while the clock moves"입니다.
빈틈은 찾지 못했습니다.

### 9. 세그먼트 조건과 미리보기 (#204~#209, #215, #218, #220, #222, #224, #227, #228, #230, #231, migration 046·047, 053~060)

연락처 목록과 미리보기(`GET /api/contacts`, `preview=true`)와 저장된 필터 목록은 `agent` 이상(`src/app/contacts.ts:753`, `:861`), 필터 만들기·수정·보관은 `admin` 이상(`:1119`, `:1159`, `:1203`, 만들기와 수정은 `lockWorkspaceForMember`로 다시 확인)입니다.
시도할 수 있는 공격은 다른 작업 공간의 계정·필드·필터 ID를 조건에 넣는 것, 사용자 조건으로 SQL 문장을 바꾸거나 `LIKE` 와일드카드·따옴표로 다른 연락처를 고르게 하는 것, 큰 조건 트리나 긴 질의로 DB 비용을 키우는 것, 잘못된 날짜나 시간대 경계로 기간을 넓히는 것, 상담원이 DM 동의·최근 DM 조건으로 볼 수 없는 데이터를 보는 것, 오래된 버전으로 다른 사람의 필터 수정을 덮는 것, 필터 이름에 제어·서식 문자를 넣어 다른 이름처럼 보이게 하는 것입니다.
방어는 다음과 같습니다.

- 조건 SQL은 고정 위치의 매개변수 `$1`~`$19`만 쓰고 SQL 문장은 조건 값에 따라 바뀌지 않습니다(`segmentConditionSql`, `contacts.ts:385-535`). 태그는 배열 포함(`@>`, `&&`), 필드 값은 `jsonb` 비교로 판정하며, 이 경로에 `LIKE`, 정규식, `new RegExp`는 없습니다(`grep -n "LIKE\|new RegExp\| ~ "`를 `contacts.ts`, `contact-csv*.ts`, `contact-fields.ts`, `segment-snapshots.ts`에 실행해 0건).
- 모든 술어는 `e.workspace_id=$1`로 시작하고, 필드 조건은 평가 전에 `validateFieldCondition`(작업 공간과 `NOT archived`)으로, 계정은 저장 때 `validateSegmentReferences`와 `(connection_id, workspace_id)` 외래 키로 확인합니다.
- 크기 한도: 태그 5개, 필드 조건 3개, 트리는 그룹 5개·그룹당 조건 5개·전체 10개, 질의 값 8,192·16,384자, 요청 본문 65,536바이트(`contacts.ts:40-106`). 날짜는 정규화된 UTC 문자열만, 상대 기간은 1~366일, 달력 기간은 네 값만 받고, 경계는 작업 공간 시간대로 한 문장 안에서 계산합니다.
- DM 동의와 최근 DM은 연락처 상세와 같은 확인된 응답 다리(`verifiedDmRecipientsSql`)만 읽고 발송 자격을 판단하지 않습니다.
- 필터 이름은 C0 제어 문자와 `\p{Cf}`를 거절합니다(`contacts.ts:995`). 수정은 `expected_version`과 행 잠금을 씁니다.

기존 테스트는 `api.test.ts`의 "contact condition trees take one bounded JSON tree in $19 and refuse other shapes before database access", "contact tag filters repeat tag up to five times with one mode and refuse other shapes before database access", "contact field filters take the legacy keys or a field_conditions set of up to three and refuse other shapes before database access", "contact activity validates canonical UTC bounds and preserves an exact exclusion count", "contact calendar periods accept four exact values and refuse mixing before database access", "segment create and edit read a body large enough for the largest tree the parser accepts", "segment writes reject cross-origin requests before opening the database", `settings.db.test.ts`의 "contact preview counts grouped identities with current filters and workspace isolation", "saved segments isolate workspace and evaluate current tags", "segments reject invalid names, duplicate normalized names and mixed filters", "stale, archived, missing and foreign segment edits write nothing", "segment edits keep active names unique, need an active admin and refuse foreign references", "two edits of the same version store exactly one and refuse the other with the current segment", "calendar comment activity takes PostgreSQL's daylight-saving rule for a missing midnight and a 25-hour day", `segment-condition-tree.db.test.ts`의 "condition trees evaluate all and any at both levels over tag and typed field leaves"(다른 작업 공간의 필드 `field_not_found` 포함), `segment-dm-consent.db.test.ts`의 "verified DM evidence follows the contact detail and never counts a missing identity as no_record"입니다.
빈틈은 두 가지였습니다.

- 따옴표와 `LIKE` 와일드카드가 든 태그·텍스트 값이 글자 그대로만 맞는지 시도하는 테스트가 없었습니다. 지금은 `LIKE`를 쓰지 않으므로 방어는 비교 방식 자체이며, 이 방식이 바뀌면 잡도록 테스트를 추가했습니다.
- 필터 이름의 서식 문자 거절은 테스트가 없었습니다(줄바꿈만 시도). 추가했습니다.

### 10. 대상 고정, 고정 대상 목록과 비교, 명단 CSV (#232, #237, #238, migration 061)

모든 경로(`POST /api/contact-segments/:id/snapshots`, `GET /api/contact-segments/:id/snapshots`, `GET /api/segment-snapshots`, `GET /api/segment-snapshots/:id`, `.../comparison`, `.../members.csv`)는 활성 `admin` 이상입니다(`src/app/segment-snapshots.ts:90`, `:174`, `:196`, `:233`, `:342`, 비교는 같은 읽기 트랜잭션에서 멤버십을 읽음).
시도할 수 있는 공격은 다른 작업 공간이나 보관된 필터의 고정, 다른 작업 공간 고정 대상의 명단·비교 읽기, 커서 조작으로 다른 고정 대상의 명단 읽기, 한도를 넘는 고정이나 동시 고정으로 한도 우회, 본문이나 질의로 다른 동작 끼워 넣기, 명단 CSV의 수식 주입, 고정 대상을 바꿔 승인된 캠페인 대상을 바꾸는 것, 삭제와 경쟁해 삭제된 사람을 명단에 남기는 것입니다.
방어는 UUID 검사와 빈 본문·빈 질의 요구, 고정 때의 작업 공간 잠금과 `lockActiveSegment`, 멤버 수 5,000·작업 공간당 200개·저장 행 예산, 명단 읽기의 `s.workspace_id=$1 AND s.id=$2`와 같은 고정 대상 안에서만 움직이는 커서, 식별자에 `'`를 붙이는 명단 CSV(`segment-snapshots.ts:361-374`), 서버 역할의 UPDATE 회수(`deploy/supabase-access.sql:191`, `deploy/init-app-user.sh:23-24`), 그리고 연결 행 잠금을 공유하는 삭제 함수입니다.
명단 CSV는 연락처 내보내기와 같은 사용자별 한도를 DB 전에 씁니다(`api.ts:269-276`).
기존 테스트는 `segment-snapshots.db.test.ts`의 "the HTTP routes create, list, read pages of and download a snapshot with identifiers only", "member pages follow (connection_id, sender_id) with an opaque cursor", "more than 5,000 members refuses the whole snapshot and an empty audience stores zero members", "at most 200 snapshots per workspace, counted under the workspace lock while two creations race", "archived, missing and foreign segments and snapshots are not found; agents and removed members are refused", "comparison rejects invalid queries, foreign or missing snapshots, non-admins, removed members and archived segments", "comparison scopes keys by connection and workspace and counts empty or large current sets without truncation", "a snapshot waiting behind delete_connection_data reads after the deletion and stores none of its members", "the deletion functions remove the right member rows, keep other people's and keep the stored counts", `api.test.ts`의 "segment snapshot routes refuse cross-origin writes, malformed IDs, queries and bodies before the database", "the segment snapshot CSV fails closed on the contact export allowance before opening the database", `access.db.test.ts`의 고정 대상 UPDATE 거부입니다.
빈틈은 찾지 못했습니다.

### 11. 답장 템플릿 (#210, migration 048)

목록과 미리보기는 `agent` 이상, 만들기·수정·보관은 `admin` 이상입니다(`src/app/reply-templates.ts:91`, `:102`, `:121`, `:147`, `:171`).
시도할 수 있는 공격은 다른 작업 공간의 템플릿 읽기·수정·미리보기, 상담원의 쓰기, 오래된 버전으로 덮기, 변수 값으로 다른 변수나 `$&` 같은 치환 문법을 실행하는 것, 표현식·속성 접근 변수(`{{x.y}}`, `{{constructor}}`), 긴 본문이나 정규식 역추적으로 비용 키우기, 이름·본문에 HTML을 저장해 화면에서 실행하는 것, 50개 한도를 동시 생성으로 넘는 것입니다.
방어는 `VARIABLE` 문법(`/\{\{([a-z][a-z0-9_]{0,31})\}\}/g`, 길이가 정해진 한 번의 매칭이라 역추적이 커지지 않음)과 남은 `{{`·`}}` 거절, 변수 10개·1,000자 한도, 자기 속성만 받는 값 확인과 함수 치환으로 값을 다시 해석하지 않는 `renderTemplate`, `expected_version`, 만들기의 작업 공간 잠금과 한도 조건, 이름의 C0·DEL 거절입니다.
기존 테스트는 `reply-templates.test.ts`의 두 개("template values are own string properties and never expressions or replacement syntax" 포함)와 `reply-templates.db.test.ts`의 "reply templates preserve workspace ownership, roles, optimistic edits and archive", "reply template preview renders once without customer lookup or delivery writes", "reply template validation rejects unsupported variables and retains literal text boundaries", "reply template active limit serializes concurrent creation and archive releases one slot", "reply templates are exported and removed only by whole workspace deletion", 그리고 `workspace-invites.db.test.ts`의 "active and archived reply templates keep a sole owner in their workspace"입니다.
빈틈은 두 가지였습니다.

- 이름의 제어 문자 거절을 시도하는 입력이 `{ name: "a\n", body: "a", extra: 1 }` 하나뿐이었는데, 이 입력은 모르는 키(`extra`)만으로도 거절되고 끝의 줄바꿈은 `trim()`이 지웁니다. 그래서 이름 검사가 빠져도 실패하는 테스트가 없었습니다. 이름 가운데의 제어 문자와 DEL만 다른 입력을 추가했습니다.
- 템플릿만 있는 작업 공간을 관리자 스크립트(`deploy/assign-workspace-owner.sql`)가 옮기지 않는지는 테스트가 없었습니다(초대 수락 경로만 시험). 추가했습니다.

### 12. 보고서 (#212, #213, #214, migration 050~052)

세 보고서(`GET /api/reports/manual-replies`, `/flow-runs`, `/handoffs`)는 활성 `admin` 이상이며, 처리기의 `workspaceFor`와 같은 집계 문장 안의 멤버십 재확인(`m.role IN ('owner','admin')`, 예: `src/app/flow-run-reports.ts:55`)을 둘 다 씁니다.
시도할 수 있는 공격은 다른 작업 공간의 계정·플로 ID로 필터해 그 수를 읽는 것, 상담원이나 제거된 멤버의 조회, 긴 기간이나 모호한 날짜·중복 키로 비용을 키우는 것, 시간대 변경과 경쟁해 잘못된 경계로 세는 것, 보고서 CSV로 수식이나 고객 텍스트를 내보내는 것입니다.
방어는 허용 키 목록과 키당 한 값, 1~366일과 실제 달력 날짜만 받는 기간, `expected_time_zone` 비교(`409 report_time_zone_changed`), 계정·플로가 작업 공간에 있는지 같은 문장에서 확인하는 조건(없으면 `404`), 그리고 생성 시각 인덱스(migration 050~052)입니다.
보고서 CSV는 브라우저가 만들며 고정 키, 10진수 수, 검증된 날짜, UUID, 작업 공간 시간대만 담고 계정·플로 이름이나 고객 텍스트를 넣지 않습니다.
기존 테스트는 `manual-reply-reports.db.test.ts`의 "manual report requires active admin membership and an owned connection", "manual report rejects ambiguous, invalid, unbounded or unsupported query input", "manual report follows workspace DST boundaries and rejects stale time zone", `flow-run-reports.db.test.ts`의 "flow report isolates workspace and combines owned account and flow filters across versions and archives", "flow report enforces active admins, current time zone, DST and unambiguous bounded input", "flow report bounds real aggregate index reads in all optional filter combinations", `handoff-reports.db.test.ts`의 "handoff report enforces active admins, owned accounts, DST, timezone and strict period input", 그리고 CSV 내용에 비밀 표지가 없는지 보는 `flow-run-reports.test.ts`와 `handoff-reports.test.ts`의 화면 테스트입니다.
빈틈은 찾지 못했습니다.

### 13. CSV 태그 변경 검사와 적용 (#216, #217)

검사(`POST /api/contacts/import-preview`)와 적용(`POST /api/contacts/import`)은 활성 `admin` 이상이며, 마지막 읽기(`readImportSnapshot`)가 같은 문장에서 역할을 다시 확인합니다.
시도할 수 있는 공격은 큰 파일·많은 행·잘못된 인코딩(NUL, 짝 없는 대리 문자), 다른 작업 공간의 내보내기 파일이나 그 작업 공간의 계정·연락처를 가리키는 행, 같은 연락처를 두 번 적는 중복 행, 검사한 뒤 바뀐 데이터에 오래된 검사 결과를 적용하는 것, 검사 결과의 행 번호·현재 태그를 조작한 적용 요청, 적용 중 역할 강등이나 연락처 삭제와의 경쟁, 업로드한 태그로 수식이나 HTML을 넣는 것입니다.
방어는 128 KiB·500행 한도와 인코딩 거절(`parseImportCsv`, `src/app/contact-csv-preview.ts:24-73`), 행마다 형식 버전·작업 공간 ID·채널·식별자 종류·계정 UUID·식별자 표지를 확인하고 중복을 소문자 계정 ID와 식별자로 세는 `classifyImportRecords`(`:77-118`), 작업 공간 소속 계정과 저장된 댓글 연락처만 찾는 `readImportSnapshot`, 적용의 작업 공간 advisory lock·계정 `FOR SHARE`·연락처별 잠금, 모든 바뀐 행의 현재 태그를 요청의 `expected`와 비교하는 낙관적 확인, 그리고 무효·중복·없는 행이 하나라도 있으면 아무것도 쓰지 않는 전부 아니면 무 동작입니다(`src/app/contact-csv-import.ts`).
태그는 `normalizeContactTags`로 다시 검증되고, 검사 결과 화면은 텍스트로만 그립니다.
기존 테스트는 `contact-csv.db.test.ts`의 "CSV tag preview separates all duplicate identities invalid scope and unavailable contacts", "CSV tag preview enforces admin same-origin shape file and record limits", "CSV preview rechecks a role downgrade and contact deletion in the final read", "CSV tag apply refuses a file with an invalid duplicate or unavailable row and writes nothing", "CSV tag apply refuses stale rows after an edit committed before its read or started after its locks", "CSV tag apply refuses when a changed contact disappears between its read and its write", "CSV tag apply enforces admin membership query shape and body limits without writes"와, `contact-csv.test.ts`의 "CSV import parser accepts exact byte and record caps and rejects one over without truncation"(NUL과 `\ud800` 포함)입니다.
빈틈은 세 가지였습니다.

- 같은 계정 ID를 대소문자만 다르게 적은 두 행을 시도하는 테스트가 없었습니다. 행 분류가 계정 ID를 소문자로 바꾸지 않으면 두 행이 서로 다른 연락처로 보여 검사가 둘 다 서로 다른 제안 태그의 `changed`로 보이고, 적용은 같은 연락처를 한 `INSERT ... ON CONFLICT DO UPDATE` 문장에서 두 번 쓰려다 DB 오류로 롤백되어 `503 service_unavailable`을 돌려줍니다(아래 변이 실행에서 관찰). 검사와 적용이 둘 다 `duplicate`로 거절하는지 확인하는 테스트를 추가했습니다.
- 다른 작업 공간의 내보내기 파일에서 온 행은 검사 테스트만 시도했습니다. 적용 쪽 거절 표에도 넣었습니다.
- 열 수 검사는 머리글만 시도했고(`"wrong,header"`), 데이터 행은 늘 14칸으로 만들었습니다. 13칸 행은 마지막 칸이 그대로 `tags_json`이라 열 수 검사만 막습니다. 한 칸이 모자란 행과 남는 행을 시도하는 테스트를 추가했습니다.

### 14. SECURITY DEFINER 함수, 열 권한, 데이터 경로 등록 (migration 046~061)

migration 046~061 가운데 새 테이블은 048의 `workspace_reply_templates`와 061의 `instagram_segment_snapshots`, `instagram_segment_snapshot_members`뿐입니다(049의 예약 답장은 1부에서 다뤘습니다).
061은 세 삭제 함수를 다시 정의했고 그중 SECURITY DEFINER는 기존의 `delete_connection_data` 하나이며 새 함수는 없습니다.
1부의 카탈로그 검사(`access.db.test.ts`)가 함수 목록과 새 테이블의 RLS·권한을 계속 비교합니다.
고정 대상 두 테이블은 서버 역할의 UPDATE도 회수했습니다.
세 테이블은 모두 `src/app/workspace-export.ts`의 `EXPORTED_TABLES`에 있습니다(`:34`, `:35`, `:45`).
삭제 함수 등록은 "reply templates are exported and removed only by whole workspace deletion"과 "the deletion functions remove the right member rows, keep other people's and keep the stored counts"가 확인합니다.
연결 행 없이 존재할 수 있는 템플릿과 고정 대상은 두 작업 공간 이동 확인(`src/app/workspace-members.ts:187`, `deploy/assign-workspace-owner.sql:36`)에 모두 들어 있습니다.
고정 대상은 "both tables are exported, and a snapshot alone keeps a workspace from moving in both move checks"가 두 경로를 확인했지만, 템플릿은 초대 수락 경로만 시험해서 관리자 스크립트 쪽 테스트를 추가했습니다(11번).
그 밖의 migration은 열, CHECK 제약, 인덱스만 더합니다.
046~061의 권한 문은 다시 정의한 삭제 함수의 `REVOKE ALL ... FROM PUBLIC` 네 개(048 하나, 061 셋)뿐이며, 테이블 권한은 `deploy/supabase-access.sql`과 `deploy/init-app-user.sh`가 소유합니다.

## 확인한 의심 사항

- 메시징 ID 정지(`instagram_dm_automation`)는 DM 시작을 막지 않고 발송만 붙잡습니다. 시작 기록과 실행은 생기고 첫 메시지 행은 `pending`으로 남습니다. 명세가 정한 동작이며, 붙잡힌 행은 claim·깨우기·운영 지표에서 같은 조건(`dmFlowDeliveryDueSql`)으로 빠지고 POST 직전에도 다시 확인됩니다.
- 시작 트리거는 플로와 버전을 잠그지 않고 읽으므로, 플로를 끄는 트랜잭션과 겹친 DM은 실행을 시작할 수 있습니다. 명세가 교착을 피하려고 정한 것이며, 그 행은 최종 guard의 `inactive_flow`로 막힙니다("the final guard after the claim: the flow was disabled").
- 서버 역할은 `instagram_dm_start_events`를 UPDATE할 수 있고, 이 표는 DM 플로의 24시간 창 기준입니다. 그러나 `src`에 이 표를 UPDATE하는 코드는 없고(`grep -rn "UPDATE instagram_dm_start_events" src`는 테스트 파일만 찾습니다), 수동 답장의 창 기준인 `instagram_inbox_messages`도 같은 권한을 가집니다. 서버 역할 자격 증명을 가진 사람은 이 표를 바꾸지 않고도 직접 보낼 수 있으므로 발견 사항으로 보지 않았습니다.
- 캠페인 행은 `beforeSend`에서 거절돼 실제 호출이 없어도 `provider_called_at`이 찍혀 시간당 캠페인 예산에 하나로 셉니다. 코드 주석과 명세가 "보내기 전에 센다"로 정한 보수적 동작입니다.
- DM 플로 발송에는 시간당 예산이 없습니다. 발송 한도 명세가 Send API DM을 예외로 정했습니다. 연결 정지는 적용됩니다.
- 캠페인 초안 이름은 C0 제어 문자와 DEL만 거절하므로, 양방향 서식 문자(예: U+202E)는 저장할 수 있습니다. 플로 이름은 `\p{Cf}`도 거절합니다. 화면은 이 값을 텍스트로만 그리고, 같은 작업 공간의 관리자만 쓰고 읽으므로 표시 혼동 이상의 영향은 없습니다.
- (2부) 답장 템플릿 이름도 C0 제어 문자와 DEL만 거절하고 서식 문자는 받습니다. 템플릿 본문은 NUL만 거절합니다. 세그먼트 이름은 `\p{Cf}`까지 거절하므로 기능마다 기준이 다르지만, 템플릿은 같은 작업 공간의 관리자만 쓰고 화면은 텍스트로만 그리므로(아래 렌더링 확인) 캠페인 이름과 같은 판단입니다. 본문은 상담원이 확인하고 보내는 수동 답장 초안이 됩니다.
- (2부) 연락처 목록 미리보기(`preview=true`), 고정 대상 비교, 세 보고서에는 별도 요청 한도가 없습니다. [기본 API 요청 한도 명세](../specs/2026-10-12-api-request-limits.md)가 `GET /api/inbox`와 별도 한도가 있는 경로 말고는 GET에 한도를 두지 않는다고 정했고, [저장 전 미리보기 명세](../specs/2026-10-16-segment-draft-preview.md)는 제외 사유 계산이 일반 첫 페이지보다 비쌀 수 있음을 적었습니다. 각 요청은 한 작업 공간의 데이터만 읽고, 조건 크기와 보고서 기간(366일)이 묶여 있습니다.
- (2부) 상담원은 연락처 목록에서 확인된 DM 동의 상태와 최근 DM으로 거를 수 있습니다. [작업 공간 역할](../agents/feature-invariants.md#workspace-roles)이 상담원에게 연락처와 동의 작업을 맡기고, 연락처 상세가 같은 사실을 상담원에게 이미 보여 줍니다.
- (2부) 템플릿 수정·보관은 처리기 앞의 `workspaceFor`로만 역할을 확인하고, 쓰기 트랜잭션 안에서 다시 확인하지 않습니다. 그 사이 강등된 관리자의 요청 하나가 끝까지 갈 수 있습니다. 받은 편지함 라벨 이름 바꾸기·보관(`src/app/inbox-labels.ts:86`, `:104`)과 필드 보관(`src/app/contact-fields.ts:157`)도 같은 형태라 이 코드베이스의 수정·보관 경로에 공통된 방식이며, 한도를 세는 만들기만 `lockWorkspaceForMember`로 다시 확인합니다.
- (2부) 보고서 CSV는 브라우저에서 만들고 수식 표지를 붙이지 않습니다. 셀은 고정 키, 10진수 수, 형식을 확인한 날짜, UUID, `pg_timezone_names`에 있는 시간대 이름뿐입니다. 로컬 PostgreSQL(포트 5437)에서 `pg_timezone_names` 598개 가운데 `=`, `+`, `-`, `@`, 공백으로 시작하는 이름은 0개였습니다. 운영 DB의 목록은 확인하지 않았습니다.

## 추가한 회귀 테스트

각 테스트는 아래 방법으로 방어를 빼거나 결함을 심어 한 번 실패하는 것을 확인했고, 되돌린 뒤 제품 코드의 diff는 없습니다.

- `campaign-delivery-worker.db.test.ts` "the guard immediately before the POST: ..." 다섯 개(마케팅 동의 철회, 댓글 작성자의 수신 거부, 연결된 다른 DM 수신자의 수신 거부, 연락처 정지, 상담 전환 정지): worker가 `provider_called_at`을 찍는 순간에 상태를 바꾸므로 transport의 `beforeSend` guard만 그 변경을 볼 수 있습니다. 보내지 않았는지, 행이 `blocked`(수신 거부·동의 철회) 또는 `pending`(정지)으로 끝나는지 확인합니다. `src/instagram/follow-transport.ts`에서 `beforeSend` 호출을 빼면 다섯 개와 기존 창 테스트가 모두 실패했습니다.
- `dm-flow-delivery-worker.db.test.ts` "the guard immediately before the POST: a comment sender bridged to the messaging ID opted out": 같은 방법으로 응답 다리를 거친 수신 거부를 POST 직전에 시도합니다. `beforeSend` 호출을 빼면 실패했습니다.
- `dm-flow-delivery-worker.db.test.ts` "a fresh DM start event of the same sender on another connection does not reopen the window": 25시간 전 시작 기록의 행이 있고 같은 발신자의 새 시작 기록이 다른 연결에 있을 때 `reply_window_closed`로 막히는지 확인합니다. `WINDOW_ANCHOR`에서 `start.connection_id=d.connection_id`를 빼면 이 단언이 실패했습니다.
- `dm-flow-delivery-worker.db.test.ts` "a held row is skipped rather than waited on, and two workers claim one row each": 다른 트랜잭션이 가장 오래된 행을 `FOR UPDATE`로 잡은 동안 worker가 기다리지 않고 다음 행을 보내는지, 그 뒤 두 worker가 동시에 서로 다른 행을 하나씩 보내는지 확인합니다. claim에서 `SKIP LOCKED`를 빼면 worker가 5초 동안 기다려 이 테스트 하나만 실패했습니다(`tests 32`, `fail 1`, deadlock 없음).
  테스트가 실패해도 `finally`에서 잡은 트랜잭션을 `ROLLBACK`하고, 잠금을 기다리던 claim이 끝날 때까지 기다립니다. 그래서 열린 잠금이 다음 테스트로 넘어가지 않습니다. 처음 작성한 형태는 `ROLLBACK` 없이 연결을 풀에 돌려주어, 같은 변이에서 뒤의 guard 테스트 두 개가 `deadlock detected`로 함께 실패했습니다.
- `dm-start-trigger.db.test.ts` "concurrent enables of two default-reply flows on one connection leave one enabled": 첫 켜기를 UPDATE 뒤·커밋 전에 붙잡고 두 번째 켜기를 보낸 뒤, 두 번째 요청이 첫 켜기의 backend에 막혀 연결 행(`FROM instagram_connections`)을 기다리는 것을 `pg_blocking_pids`로 확인하고 놓습니다. 결과가 `200`과 `422`이고 켜진 플로가 하나인지 확인합니다. 기다리지 않고 끝나거나 기다림이 보이지 않으면 실패하고, 실패해도 `finally`에서 붙잡은 켜기를 놓고 두 요청이 끝날 때까지 기다립니다. 이 테스트를 위해 같은 파일의 `request` 도우미에 풀을 바꿔 넣는 선택 인자를 더했습니다. 켜기의 연결 조회에서 `FOR NO KEY UPDATE`를 빼면 "the second request finished without waiting for the connection lock"으로 실패했습니다.
- `dm-start-trigger.db.test.ts` "a publish that overlaps an enable in flight waits for it and is refused": 같은 방법으로 키워드 플로의 켜기를 붙잡은 동안 겹치는 키워드의 꺼진 플로를 발행하면, 발행이 연결 행을 기다리고 켜기가 커밋된 뒤 `422 dm_keyword_conflict`로 거절되는지 확인합니다. 발행의 연결 조회에서 `FOR NO KEY UPDATE`를 빼면 이 테스트만 실패했고, 켜기의 잠금을 빼면 두 테스트가 모두 실패했습니다.
- `dm-start-trigger.db.test.ts` "a DM starts only the flows of the connection that received it": 같은 작업 공간의 다른 연결에 켜진 기본 응답 플로가 있을 때, 이 연결로 온 DM은 아무것도 시작하지 않고 다른 연결로 온 DM만 그 플로를 시작하는지 확인합니다. 후보 조회에서 `v.trigger_connection_id=$2`를 빼면 실패했습니다.
- `settings.db.test.ts` "scheduled manual reply changes are versioned idempotent scoped and cancelled without a send"에 두 줄을 보탰습니다. 만든 사람이 아닌 상담원의 취소는 `403`, 다른 작업 공간 사용자의 취소는 `404`이고, 두 거절 뒤에도 만든 사람의 버전 1 수정이 적용되는지 확인합니다. 역할 조건을 수정에만 적용하도록(`!cancel &&`) 바꾸면 실패했습니다.
- `settings.db.test.ts` "scheduled manual reply permits its creator and administrators and keeps valid agent permission"에 한 단계를 보탰습니다. 만든 사람(관리자)이 수정한 요청을 소유자가 같은 요청 키와 같은 본문으로 다시 보내면 `409 idempotency_conflict`인지 확인합니다. 재전송 확인에서 `previous.actor_id !== user.id` 조건을 빼면 이 단언이 실패했습니다.

2부에서 추가한 테스트도 같은 방법으로 확인했고, 되돌린 뒤 `git diff --stat`에는 테스트 파일 네 개만 남았습니다.

- `contact-csv.db.test.ts` "CSV duplicate detection compares account IDs without case in the preview and the apply": 글자가 든 계정 ID의 연락처 하나를 소문자와 대문자 계정 ID로 두 번 적은 파일을 검사하면 두 행이 모두 `duplicate`이고, 적용하면 `422 contact_import_rejected`로 아무것도 쓰지 않는지 확인합니다. `classifyImportRecords`에서 계정 ID의 `.toLowerCase()`를 빼면 이 테스트만 실패했습니다(검사 단언에서 실패). 검사 단언을 잠시 건너뛰고 같은 변이로 다시 실행하면 적용이 `422` 대신 `503 service_unavailable`을 돌려줘 실패했습니다.
- `contact-csv.db.test.ts` "CSV preview refuses a data row with one cell missing or one extra cell": 13칸 행과 15칸 행이 둘 다 `invalid`인지 확인합니다. 행 분류의 열 수 비교를 빼면 두 행이 같은 연락처의 `duplicate`로 바뀌어 이 테스트만 실패했습니다.
- `contact-csv.db.test.ts` "CSV tag apply refuses a file with an invalid duplicate or unavailable row and writes nothing"의 거절 표에 다른 작업 공간 ID를 적은 행을 더했습니다. 행 분류에서 작업 공간 ID 비교를 빼면 이 테스트와 기존 검사 테스트 "CSV tag preview separates all duplicate identities invalid scope and unavailable contacts"가 함께 실패했습니다.
- `segment-condition-tree.db.test.ts` "tag and text conditions compare stored values exactly, so quotes and LIKE wildcards stay literal": 태그와 텍스트 필드 값이 `50%_off'`인 연락처와 `50 percent off'`인 연락처를 두고, 태그 조건, 기존 필드 조건, 트리의 태그 조건과 필드 조건, 트리 미리보기의 수가 앞 연락처만 고르는지 확인합니다. `LIKE` 비교를 세 곳에 하나씩 심었고(태그 조건의 `@>`, 트리 태그 조건의 `@> ARRAY[c.tag]`, 필드 조건의 `eq`), 매번 뒤 연락처가 함께 골라져 실패했습니다. 심을 때는 커밋하지 않는 스크립트로 정확히 한 곳만 바꿨습니다.
- `settings.db.test.ts` "segments reject invalid names, duplicate normalized names and mixed filters"에 U+202E와 U+200B가 든 이름을 더했습니다. 이름 검사를 `[\p{Cc}]`로 좁히면 실패했습니다.
- `settings.db.test.ts` "administrator ownership assignment refuses to leave a workspace holding invites or settings"에 보관된 답장 템플릿만 남은 작업 공간을 더했습니다. 관리자 스크립트에서 `workspace_reply_templates` 줄을 빼면 "Missing expected rejection"으로 실패했습니다.
- `reply-templates.db.test.ts` "reply template validation rejects unsupported variables and retains literal text boundaries"에 이름 가운데의 BEL(U+0007)과 DEL만 다른 입력 두 개를 더했습니다. 이름의 제어 문자 검사를 빼면 `{"name":"a\u0007b","body":"a"}`에서 실패했습니다.

## 테스트하지 않은 항목

- `src/cloudflare/`의 파일은 바꾸지 않았으므로 `test:cloudflare`는 이번 게이트에 넣지 않았습니다. 큐 소비자에서 발송 경로의 순서(수동 답장, 팔로우 확인, DM 플로, 비공개 답장, 캠페인)는 기존 `worker.db.test.ts`가 확인합니다.
- 세션 강화의 여러 문서·여러 탭 동작은 이번에 브라우저에서 다시 실행하지 않았습니다. 기존 근거는 [쿠키 순서 검증 기록](2026-10-22-auth-cookie-response-order.md)과 `auth-session.test.ts`입니다.
- 운영 DB의 권한, 운영 Worker, 실제 Meta 발송은 확인하지 않았습니다. 이 점검의 테스트는 모두 로컬 PostgreSQL에서 실행합니다.
- (2부) 미리보기·내보내기·보고서의 운영 규모 실행 시간과 요청 빈도는 측정하지 않았습니다. 큰 작업 공간에서의 비용은 각 명세가 적은 로컬 측정과 인덱스 테스트("flow report bounds real aggregate index reads in all optional filter combinations" 등)가 근거입니다.
- (2부) 보고서 CSV 파일을 실제 스프레드시트에서 열어 보지 않았습니다. 셀 값의 범위로 판단했습니다(확인한 의심 사항).

## 별도 이슈

없습니다.
1부와 2부 모두 마이그레이션이나 넓은 변경이 필요한 결함은 찾지 못했습니다.

## 저장된 악성 텍스트의 브라우저 렌더링 확인

커밋하지 않는 로컬 하네스를 썼습니다. 하네스는 이 worktree의 실제 `public/` 파일과 실제 `appApi`를 로컬 PostgreSQL(포트 5437)의 일회용 DB(`automations_audit4ui`, `db/schema.sql` 적용, 확인 뒤 삭제)에 연결하고, Supabase는 세션 쿠키 값으로 사용자를 돌려주는 대역으로 바꿉니다. 다른 외부 요청은 막고 기록하며, 기록된 외부 요청은 0건이었습니다.
합성 데이터는 API 검증을 거치지 않도록 SQL로 넣었습니다. 세그먼트 이름, 고정 대상의 세그먼트 이름, 캠페인 초안 두 개의 이름과 본문, 두 승인의 이름·본문 사본(하나는 실행됨, 하나는 유효), 실행 중인 실행 하나, 발행한 DM 키워드 플로의 이름·키워드·제외 키워드·메시지 본문에 표지 문자열과 페이로드를 넣었습니다.
페이로드는 `<img src=x onerror=__xss=1>`, `<script>`, 큰따옴표 속성 탈출 뒤의 `<svg onload>`, `javascript:` URL, 작은따옴표 탈출 뒤의 `<iframe srcdoc>`, HTML 엔티티입니다.
페이지 스크립트보다 먼저 실행되는 감시 스크립트가 세 가지를 기록합니다. 페이로드가 실행되면 켜지는 `window.__xss`, 페이로드가 만들 요소(`src=x`인 `img`, `iframe`, `/app/` 밖의 `script`, `on*` 속성, `javascript:` 링크)가 DOM에 들어온 경우, 그리고 CSP 위반 이벤트입니다.

- 확인 일시와 브라우저: 2026-11-08 23:03Z~23:05Z(KST 2026-11-09 08:03~08:05), Playwright 1.62의 headless Chromium(chrome-headless-shell 1248), 너비 1280px, `main` `41951e7`의 `public/app/`.
- 렌더링한 화면: 관리자로 `#automation`의 DM 플로 편집기(접힌 `details`를 모두 펼침)와 `#contacts`의 캠페인 초안 두 개(각각 열고, 발송 조건 미리보기를 실행하고, 실행 현황이 보이면 새로 고침), 상담원으로 DM 플로 편집기를 열었습니다. 확인 창은 모두 닫았고, 대시보드 시작 요청(`POST /api/workspace`) 말고 쓰기 요청은 0건이었습니다.
- 결과: `public/_headers`의 CSP를 붙인 실행과 CSP를 뺀 실행 모두에서 `window.__xss`는 `false`, DOM에 들어온 페이로드 요소와 CSP 위반은 0건, 페이지 오류는 0건이었습니다. 표지 문자열은 플로 이름·키워드·제외 키워드·메시지(`XSS_FLOW`, `XSS_KW`, `XSS_EX`, `XSS_MSG`), 초안 이름, 승인 사본, 고정 대상과 세그먼트 이름의 표지가 화면에 텍스트로 보였고, 초안 본문은 입력란의 값으로 들어갔습니다. 실행 현황 영역은 실행이 있는 초안에서만 보였습니다.
- 감시가 결함을 잡는지 보려고 `public/app/campaign-drafts.js`의 초안 목록에서 제목을 `innerHTML`로 쓰도록 잠시 바꾸자, CSP를 뺀 실행에서는 `window.__xss`가 `1`이 되고 `<img src="x" onerror="__xss=1">`가 기록됐으며, CSP를 붙인 실행에서는 같은 요소와 `script-src-attr` 위반이 기록됐습니다. 파일을 되돌린 뒤 `git diff --stat`에 `public/`의 변경이 없는 것을 확인했습니다.
- 코드 읽기: `public/app/`의 스크립트에 `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `srcdoc`, `eval`이 없고, `static-security.test.ts`의 "dashboard scripts write user data as text, never through an HTML or code sink"가 이를 계속 확인합니다. `flow-editor.js`의 `link.href`는 `#flow-step-` 접두사가 붙은 페이지 안 링크뿐입니다.
- 3차 점검이 적은 대로 연결의 `username`, 게시물 `permalink`·`image_url`은 Meta가 준 값이고 이번 범위의 화면이 아니므로 넣지 않았습니다.

2부도 같은 형태의 하네스를 새 일회용 DB(`automations_audit4bui`, 확인 뒤 삭제)로 실행했습니다.
합성 데이터에는 연락처 태그 두 개, 텍스트 필드의 이름과 값, 태그 조건 필터와 조건 트리 필터(트리의 태그와 필드 값)의 이름, 고정 대상의 세그먼트 이름, 답장 템플릿의 이름과 본문, 플로 이름(보고서 필터 선택지), 연결 계정 이름(보고서 계정 선택지), DM 하나의 본문에 표지와 페이로드를 넣었습니다.

- 확인 일시와 브라우저: 2026-11-09 04:28Z~04:31Z(KST 13:28~13:31), Playwright 1.62의 headless Chromium(chrome-headless-shell 1248), 너비 1280px, `main` `05f803f`의 `public/app/`.
- 렌더링한 화면: 관리자로 `#contacts`에서 연락처 목록, 태그 조건 필터 선택과 그 고정 대상 목록, 명단 보기, 비교, 조건 트리 필터 선택과 필터 수정 열기, CSV 검사(페이로드를 담은 계정 이름과 태그의 파일을 올려 결과 행 표시), `#settings`의 답장 템플릿 목록과 수정, `#home`의 세 보고서(필터 선택지, 조회 실행)를 열었습니다. 상담원으로는 `#inbox`에서 대화를 열고 템플릿 선택기에서 페이로드 템플릿을 고르고 변수 값에 페이로드를 넣어 미리보기와 입력란 넣기를 실행했고, `#contacts`의 연락처 목록과 필터 선택도 열었습니다.
- 쓰기 요청: 대시보드 시작 요청(`POST /api/workspace`), 읽기 전용 검사인 `POST /api/contacts/import-preview`와 템플릿 미리보기, 대화를 열 때 화면이 보내는 읽음 표시(`POST /api/inbox/conversations/:connection/:recipient/read`) 말고는 0건이었습니다.
- 결과: CSP를 붙인 실행과 뺀 실행 모두에서 `window.__xss`는 `false`, DOM에 들어온 페이로드 요소와 CSP 위반은 0건, 페이지 오류는 0건이었고 23개 확인이 모두 통과했습니다. 화면마다 확인한 표지(태그, 필드 이름, 두 필터 이름, 고정 대상, CSV 검사 태그, 템플릿 이름·본문, 플로 이름, 계정 이름, DM, 템플릿 변수 값)가 텍스트나 입력란 값으로 보였습니다. 필드 값과 조건 트리의 태그·필드 값은 넣었지만 보이는지는 따로 확인하지 않았습니다. 실행·마크업·CSP 확인은 페이지 전체에 적용됩니다. 상담원 화면에는 고정 대상과 CSV 검사 영역이 나오지 않았습니다.
- 감시가 결함을 잡는지 보려고 `public/app/reply-templates.js`의 템플릿 목록에서 이름을 `innerHTML`로 쓰도록 잠시 바꾸자, CSP를 뺀 실행에서는 `window.__xss`가 `1`이 되고 `<img src="x" onerror="__xss=1">`가 기록됐으며, CSP를 붙인 실행에서는 같은 요소와 `script-src-attr` 위반이 기록됐습니다. 파일을 되돌린 뒤 `git diff --stat`에 `public/`의 변경이 없는 것을 확인했습니다.

## 남은 항목

- 실제 Meta 웹후크와 발송, 운영 DB 권한 확인
- 두 실제 사용자 사이의 운영 작업 공간 격리 확인([#13](https://github.com/AndrewDongminYoo/auto-chatter/issues/13))
