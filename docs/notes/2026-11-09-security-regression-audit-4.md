# 보안 회귀 점검 4차, 1부: 발송 경로 (#62)

## 범위

[3차 점검](2026-10-12-security-regression-audit-3.md)(`c2d6e88`) 뒤에 합쳐진 발송 경로 기능을 2026-11-09 `main` `41951e7` 기준 코드와 자동 테스트에 대응시켰습니다.
대상은 다섯 묶음입니다.

1. 캠페인: 초안 #242와 화면 #243, 발송 조건 미리보기 #258과 화면 #261, 실행 승인 #264와 화면 #267, 실행 #269, 발송 worker #272, 실행 현황 화면 #276, 수정 #279·#282·#284, migration 063~067
2. DM 시작 트리거: 시작 기록 #295(migration 068), 재전달 제외와 advisory lock #297, DM 플로 발송 worker #298(migration 069), 계정 읽기 #303, 편집기 #304
3. 사용자 신원 연결 확인 #241
4. 일회성 예약 답장 #211(migration 049)
5. 세션 강화: 폐기된 세션의 요청 재전송 방지 #244, 인증 쿠키 전환 직렬화 #253

이 문서는 4차 점검의 1부입니다.
2부(세그먼트, 연락처 CSV 내보내기·가져오기, 답장 템플릿, 보고서: #202~#238, #210, #212~#214, #216~#217)는 별도 PR에서 점검합니다.
AI 자원(#55~#57)은 아직 구현되지 않아 이번에도 제외했습니다.
기능별 불변 조건은 [CLAUDE.md](../../CLAUDE.md), [기능별 불변 조건](../agents/feature-invariants.md)과 각 명세가 소유하므로 여기서 다시 적지 않습니다.

방법은 1~3차와 같습니다.
각 기능마다 누가 호출할 수 있는지, 악의적인 호출자가 무엇을 시도할 수 있는지, 방어가 어디에 있는지, 그 공격을 실제로 시도하는 테스트가 무엇인지를 적고, 테스트가 없던 변형에는 그 영역을 소유한 기존 테스트 파일에 회귀 테스트를 추가했습니다.
추가한 테스트는 기존 방어를 지키는 회귀 테스트이므로 처음부터 통과합니다.
그래서 테스트마다 방어 코드를 일시적으로 제거하거나 결함을 심어 실패를 한 번 확인한 뒤 원래 코드로 되돌렸고, 되돌린 뒤 `git diff --stat`에 테스트 파일만 남는 것을 확인했습니다.
작은 수정으로 고칠 실제 결함은 찾지 못했으므로 제품 코드는 바꾸지 않았습니다.

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

## 확인한 의심 사항

- 메시징 ID 정지(`instagram_dm_automation`)는 DM 시작을 막지 않고 발송만 붙잡습니다. 시작 기록과 실행은 생기고 첫 메시지 행은 `pending`으로 남습니다. 명세가 정한 동작이며, 붙잡힌 행은 claim·깨우기·운영 지표에서 같은 조건(`dmFlowDeliveryDueSql`)으로 빠지고 POST 직전에도 다시 확인됩니다.
- 시작 트리거는 플로와 버전을 잠그지 않고 읽으므로, 플로를 끄는 트랜잭션과 겹친 DM은 실행을 시작할 수 있습니다. 명세가 교착을 피하려고 정한 것이며, 그 행은 최종 guard의 `inactive_flow`로 막힙니다("the final guard after the claim: the flow was disabled").
- 서버 역할은 `instagram_dm_start_events`를 UPDATE할 수 있고, 이 표는 DM 플로의 24시간 창 기준입니다. 그러나 `src`에 이 표를 UPDATE하는 코드는 없고(`grep -rn "UPDATE instagram_dm_start_events" src`는 테스트 파일만 찾습니다), 수동 답장의 창 기준인 `instagram_inbox_messages`도 같은 권한을 가집니다. 서버 역할 자격 증명을 가진 사람은 이 표를 바꾸지 않고도 직접 보낼 수 있으므로 발견 사항으로 보지 않았습니다.
- 캠페인 행은 `beforeSend`에서 거절돼 실제 호출이 없어도 `provider_called_at`이 찍혀 시간당 캠페인 예산에 하나로 셉니다. 코드 주석과 명세가 "보내기 전에 센다"로 정한 보수적 동작입니다.
- DM 플로 발송에는 시간당 예산이 없습니다. 발송 한도 명세가 Send API DM을 예외로 정했습니다. 연결 정지는 적용됩니다.
- 캠페인 초안 이름은 C0 제어 문자와 DEL만 거절하므로, 양방향 서식 문자(예: U+202E)는 저장할 수 있습니다. 플로 이름은 `\p{Cf}`도 거절합니다. 화면은 이 값을 텍스트로만 그리고, 같은 작업 공간의 관리자만 쓰고 읽으므로 표시 혼동 이상의 영향은 없습니다.

## 추가한 회귀 테스트

각 테스트는 아래 방법으로 방어를 빼거나 결함을 심어 한 번 실패하는 것을 확인했고, 되돌린 뒤 제품 코드의 diff는 없습니다.

- `campaign-delivery-worker.db.test.ts` "the guard immediately before the POST: ..." 다섯 개(마케팅 동의 철회, 댓글 작성자의 수신 거부, 연결된 다른 DM 수신자의 수신 거부, 연락처 정지, 상담 전환 정지): worker가 `provider_called_at`을 찍는 순간에 상태를 바꾸므로 transport의 `beforeSend` guard만 그 변경을 볼 수 있습니다. 보내지 않았는지, 행이 `blocked`(수신 거부·동의 철회) 또는 `pending`(정지)으로 끝나는지 확인합니다. `src/instagram/follow-transport.ts`에서 `beforeSend` 호출을 빼면 다섯 개와 기존 창 테스트가 모두 실패했습니다.
- `dm-flow-delivery-worker.db.test.ts` "the guard immediately before the POST: a comment sender bridged to the messaging ID opted out": 같은 방법으로 응답 다리를 거친 수신 거부를 POST 직전에 시도합니다. `beforeSend` 호출을 빼면 실패했습니다.
- `dm-flow-delivery-worker.db.test.ts` "a fresh DM start event of the same sender on another connection does not reopen the window": 25시간 전 시작 기록의 행이 있고 같은 발신자의 새 시작 기록이 다른 연결에 있을 때 `reply_window_closed`로 막히는지 확인합니다. `WINDOW_ANCHOR`에서 `start.connection_id=d.connection_id`를 빼면 이 단언이 실패했습니다.
- `dm-flow-delivery-worker.db.test.ts` "a held row is skipped rather than waited on, and two workers claim one row each": 다른 트랜잭션이 가장 오래된 행을 `FOR UPDATE`로 잡은 동안 worker가 기다리지 않고 다음 행을 보내는지, 그 뒤 두 worker가 동시에 서로 다른 행을 하나씩 보내는지 확인합니다. claim에서 `SKIP LOCKED`를 빼면 worker가 5초 동안 기다려 이 테스트 하나만 실패했습니다(`tests 32`, `fail 1`, deadlock 없음).
  테스트가 실패해도 `finally`에서 잡은 트랜잭션을 `ROLLBACK`하고, 잠금을 기다리던 claim이 끝날 때까지 기다립니다. 그래서 열린 잠금이 다음 테스트로 넘어가지 않습니다. 처음 작성한 형태는 `ROLLBACK` 없이 연결을 풀에 돌려주어, 같은 변이에서 뒤의 guard 테스트 두 개가 `deadlock detected`로 함께 실패했습니다.
- `dm-start-trigger.db.test.ts` "concurrent enables of two default-reply flows on one connection leave one enabled": 첫 켜기를 UPDATE 뒤·커밋 전에 붙잡고 두 번째 켜기를 보낸 뒤 놓아, 결과가 `200`과 `422`이고 켜진 플로가 하나인지 확인합니다. 이 테스트를 위해 같은 파일의 `request` 도우미에 풀을 바꿔 넣는 선택 인자를 더했습니다. 켜기의 연결 조회에서 `FOR NO KEY UPDATE`를 빼면 결과 단언이 실패했습니다.
- `dm-start-trigger.db.test.ts` "a DM starts only the flows of the connection that received it": 같은 작업 공간의 다른 연결에 켜진 기본 응답 플로가 있을 때, 이 연결로 온 DM은 아무것도 시작하지 않고 다른 연결로 온 DM만 그 플로를 시작하는지 확인합니다. 후보 조회에서 `v.trigger_connection_id=$2`를 빼면 실패했습니다.
- `settings.db.test.ts` "scheduled manual reply changes are versioned idempotent scoped and cancelled without a send"에 두 줄을 보탰습니다. 만든 사람이 아닌 상담원의 취소는 `403`, 다른 작업 공간 사용자의 취소는 `404`이고, 두 거절 뒤에도 만든 사람의 버전 1 수정이 적용되는지 확인합니다. 역할 조건을 수정에만 적용하도록(`!cancel &&`) 바꾸면 실패했습니다.
- `settings.db.test.ts` "scheduled manual reply permits its creator and administrators and keeps valid agent permission"에 한 단계를 보탰습니다. 만든 사람(관리자)이 수정한 요청을 소유자가 같은 요청 키와 같은 본문으로 다시 보내면 `409 idempotency_conflict`인지 확인합니다. 재전송 확인에서 `previous.actor_id !== user.id` 조건을 빼면 이 단언이 실패했습니다.

## 테스트하지 않은 항목

- DM 키워드 플로의 발행(꺼진 플로)과 다른 플로의 켜기가 동시에 일어나는 경우는 테스트하지 않았습니다. 발행도 플로 잠금 뒤 같은 연결 `FOR NO KEY UPDATE`를 잡으므로 켜기 경쟁 테스트와 같은 잠금이 직렬화합니다.
- `src/cloudflare/`의 파일은 바꾸지 않았으므로 `test:cloudflare`는 이번 게이트에 넣지 않았습니다. 큐 소비자에서 발송 경로의 순서(수동 답장, 팔로우 확인, DM 플로, 비공개 답장, 캠페인)는 기존 `worker.db.test.ts`가 확인합니다.
- 세션 강화의 여러 문서·여러 탭 동작은 이번에 브라우저에서 다시 실행하지 않았습니다. 기존 근거는 [쿠키 순서 검증 기록](2026-10-22-auth-cookie-response-order.md)과 `auth-session.test.ts`입니다.
- 운영 DB의 권한, 운영 Worker, 실제 Meta 발송은 확인하지 않았습니다. 이 점검의 테스트는 모두 로컬 PostgreSQL에서 실행합니다.

## 별도 이슈

없습니다.
마이그레이션이나 넓은 변경이 필요한 결함은 찾지 못했습니다.

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

## 남은 항목

- 4차 점검 2부: 세그먼트, 연락처 CSV 내보내기·가져오기, 답장 템플릿, 보고서(#202~#238, #210, #212~#214, #216~#217)
- 실제 Meta 웹후크와 발송, 운영 DB 권한 확인
- 두 실제 사용자 사이의 운영 작업 공간 격리 확인([#13](https://github.com/AndrewDongminYoo/auto-chatter/issues/13))
