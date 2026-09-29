# 채널별 동의·수신 거부 원장과 발송 가드 계획

## TL;DR

> Summary: Instagram 서비스 답장의 기존 사용자 시작 근거와 마케팅 동의를 분리하고, 근거·발생 시각·철회·재동의를 보존하는 채널별 원장을 추가합니다.
> Deliverables:
>
> - append-only 동의 이벤트와 현재 상태 projection을 포함한 migration 016
> - 인증·same-origin·작업 공간 소유권을 검사하는 Instagram 동의 기록 API
> - Node·Cloudflare의 첫 답장, 팔로우 답장, 수동 답장에 적용되는 claim 이후 및 provider POST 직전 수신 거부 가드
> - 명시적 동의 없는 마케팅, import 근거, 다른 채널 동의 재사용을 거부하는 정책 테스트
>   Effort: Medium
>   Risk: High - 수신 거부가 race 중인 외부 POST를 놓치거나 기존 사용자 시작 서비스 답장을 과도하게 막으면 메시지 정책과 사용자 경험이 함께 깨집니다.

## Scope

### Must have

- 현재 구현된 Instagram 채널만 쓰기 경계를 제공하되 원장 키에 `channel`, `identity_kind`, `identity_value`, `purpose`를 명시하여 채널이나 식별자 간 동의를 추정하지 않습니다.
- `service_reply`와 `marketing`을 별도 purpose로 관리합니다.
- `service_reply`는 기존 댓글 이벤트 또는 저장된 수신 텍스트 DM의 시간 창이 있고 활성 수신 거부가 없을 때 기존 동작을 유지합니다.
- `marketing`은 동일 채널·동일 식별자·동일 purpose의 유효한 명시적 grant만 허용하고, 상태 부재·import 근거·다른 채널 grant는 거부합니다.
- 수신 거부와 재동의를 idempotent append-only 이벤트로 보존하고 현재 상태를 같은 트랜잭션에서 갱신합니다.
- `occurred_at`은 근거가 발생한 시각으로만 저장하고, 현재 허용 상태는 서버가 직렬화해 기록한 순서로 결정합니다.
  클라이언트가 보낸 미래 시각으로 이후 수신 거부를 무력화할 수 없어야 합니다.
- 현재 Instagram 첫 비공개 답장, 팔로우 답장, 수동 답장은 수신 거부를 admission 또는 policy 검사와 provider POST 직전 검사에서 모두 확인합니다.
- 수신 거부로 차단된 이미 대기 중인 첫 답장·팔로우 답장은 terminal `blocked / recipient_opted_out`, 수동 답장은 terminal `failed / recipient_opted_out / safe_to_retry=false`로 남겨 재동의 후 과거 메시지를 자동 재생하지 않습니다.
- 새 재동의 이벤트는 과거 차단 행을 되살리지 않으며 이후 새 서비스 답장만 기존 시간 창과 모든 기존 guard를 다시 통과하게 합니다.
- migration runner, fresh schema, Compose와 Supabase runtime role 권한, RLS, append-only 이벤트 불변성을 함께 갱신합니다.

### Must NOT have (guardrails, anti-slop, scope boundaries)

- 마케팅 broadcast, segment send, imported-contact send, 새 채널 adapter, 새 provider permission 또는 실제 발송을 구현하지 않습니다.
- Instagram DM 본문의 임의 단어를 수신 거부나 재동의로 자동 해석하지 않습니다.
  Issue #27은 승인된 명령어 집합을 정의하지 않으므로 현재 쓰기 경계는 인증된 same-origin API로 제한합니다.
- 댓글 작성자 ID와 DM recipient ID를 같은 사람으로 추정하지 않습니다.
  이미 저장된 `private_reply_outbox.sender_id`↔`recipient_id` 근거가 한 사람으로 확정되는 현재 대화에서만 양쪽 식별자의 활성 철회를 함께 확인합니다.
- `instagram_contact_automation.paused` 또는 `handoff_paused`를 동의 상태로 재사용하지 않습니다.
- 기존 reply window, 연결·규칙·토큰·cooldown·handoff 검사를 완화하지 않습니다.
- API role에 product table 권한을 추가하거나 runtime role에 DELETE 권한을 부여하지 않습니다.
- `SEND_ENABLED`, 연결별 `send_enabled`, 규칙 `enabled`를 켜거나 Cloudflare 배포, 실제 Meta 호출, 운영 DB migration을 수행하지 않습니다.
- UI와 개인정보처리방침 문구를 변경하지 않습니다.

## Verification strategy

> Zero human intervention - all verification is agent-executed.

- Test decision: TDD + Node `node:test`, PostgreSQL integration tests, local workerd/Cloudflare tests.
- QA policy: 각 task는 먼저 이름이 고정된 RED test가 예상 assertion으로 실패함을 확인하고, 구현 뒤 같은 test와 관련 suite를 다시 실행합니다.
- Evidence: executor가 RED와 GREEN command output, PostgreSQL row assertions, provider mock POST count, access-denial SQLSTATE를 반환합니다.
  공유 worktree 안에 별도 report 파일은 만들지 않습니다.
- Baseline: caller가 제공한 현재 green 기준은 unit 122, DB 167, Cloudflare 41입니다.
  새 수용 test 이름이 실제 실행됐고 전체 suite failure가 0인지 확인하며, 단순 총 개수만으로 새 계약을 증명하지 않습니다.

## Execution strategy

### Parallel execution waves

> 원장 계약을 먼저 확정한 다음 API와 발송 가드를 서로 다른 파일 소유권으로 병렬 구현합니다.
> 두 작업의 DB 테스트는 같은 격리 DB의 테이블을 초기화하므로 루트가 순차 실행합니다.

Wave 1 (no dependencies):

- Task 1: 채널별 동의 원장, 판정 함수, migration·권한 계약을 TDD로 추가합니다.

Wave 2 (after Wave 1):

- Task 2: 인증된 Instagram 동의 이벤트 API와 idempotent 상태 전이를 TDD로 추가합니다.
- Task 3: Node·Cloudflare의 모든 현재 발송 경로에 수신 거부 admission/final guard를 TDD로 적용합니다.

Critical path: Task 1 -> Task 3

### Dependency matrix

| Task | Depends on | Blocks | Can parallelize with |
| ---- | ---------- | ------ | -------------------- |
| 1    | none       | 2, 3   | none                 |
| 2    | 1          | none   | 3                    |
| 3    | 1          | none   | 2                    |

## Todos

> Implementation + Test = ONE task.
> 각 task는 RED를 먼저 관찰하고 해당 구현과 GREEN 검증을 같은 task에서 완료합니다.

- [ ] 1. 채널별 원장과 보수적 판정 계약을 추가합니다.

  What to do: `src/instagram/channel-consent.test.ts`와 `src/instagram/channel-consent.db.test.ts`의 RED test를 먼저 추가하고 `package.json`의 unit·DB 명시 목록에 등록합니다.
  `src/instagram/channel-consent.ts`, `db/migrations/016_channel_consent.sql`, `db/schema.sql`, `deploy/migrate-multi-user.sql`, `deploy/supabase-access.sql`, `deploy/init-app-user.sh`를 최소 범위로 갱신합니다.
  `channel_consent_events`는 요청 UUID, 작업 공간, Instagram 연결, `channel`, `identity_kind`, `identity_value`, `purpose`, `decision`, `evidence_kind`, bounded evidence reference, `occurred_at`, actor, server 기록 시각을 append-only로 저장합니다.
  `channel_consent_state`는 동일한 exact-scope key별 마지막 적용 이벤트를 가리키고, 이벤트 insert와 projection upsert를 하나의 transaction에서 처리합니다.
  같은 request UUID와 같은 payload는 기존 결과를 반환하고 다른 payload 재사용은 conflict로 처리합니다.
  `occurred_at`이 과거 또는 미래여도 projection 순서에는 사용하지 않습니다.
  같은 연결의 기록을 잠금으로 직렬화하고 서버 기록 순서에 따라 projection을 갱신합니다.
  `service_reply` 판정은 활성 revoke가 없고 호출자가 현재 구현의 댓글 또는 수신 DM 시간 근거를 제공한 경우에만 허용합니다.
  `marketing` 판정은 exact-channel grant가 없거나 evidence가 `import`이면 `marketing_consent_required`를 반환합니다.
  수신 거부는 `recipient_opted_out`로 통일하고, reconsent는 동일 scope의 더 최신 명시적 grant로만 해제합니다.
  Must NOT do: 미래 채널 table, broadcast outbox, identity merge table, consent UI, opt-out keyword parser, DELETE API를 추가하지 않습니다.

  Parallelization: Can parallel: NO | Wave 1 | Blocks: [2, 3] | Blocked by: []

  References (executor has NO interview context - be exhaustive):
  - Requirement: [Issue #27](https://github.com/AndrewDongminYoo/auto-chatter/issues/27) - 서비스 답장과 마케팅 동의의 근거·시각·철회 분리, 대기 발송 최종 차단, cross-channel/import default deny 완료 조건입니다.
  - Product contract: `docs/specs/2026-09-25-messaging-automation-platform.md:175` - 수신 거부 또는 만료 창에서 발송을 시도하지 않고 차단 사유를 남기는 제품 계약입니다.
  - Current identity boundary: `db/schema.sql:56` - 댓글 sender 근거와 private outbox의 sender/recipient bridge가 정의된 위치입니다.
  - Current DM evidence: `db/schema.sql:127` - 저장된 Instagram inbox message의 recipient, kind, message timestamp 계약입니다.
  - Current projection pattern: `db/schema.sql:143` - 작업 공간·연결·연락처 단위 현재 상태와 FK pattern입니다.
  - Migration ordering: `deploy/migrate-multi-user.sql:3` - migration 003–015와 access script를 하나의 transaction으로 적용하는 runner입니다.
  - Access pattern: `deploy/supabase-access.sql:35` - product table RLS, API role revoke, runtime SELECT/INSERT/UPDATE grant loop입니다.
  - Append-only pattern: `deploy/supabase-access.sql:70` - runtime role의 audit UPDATE를 다시 revoke하는 기존 방식입니다.
  - Test registration: `package.json:13` - 새 unit·DB test 파일을 명시적 script 목록에 넣어야 하는 위치입니다.
  - Test pattern: `src/cloudflare/access.db.test.ts:6` - local test database gate, API role denial, runtime DML, DELETE/DDL denial, RLS 검증 pattern입니다.

  Acceptance criteria (agent-executable only):
  - [ ] `node --test --test-name-pattern='marketing consent is exact-channel and import-safe' src/instagram/channel-consent.test.ts`가 구현 전 `marketing_consent_required` assertion에서 실패하고 구현 후 통과합니다.
  - [ ] `TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='consent ledger preserves revoke and re-consent evidence' src/instagram/channel-consent.db.test.ts`가 구현 전 missing relation 또는 assertion으로 실패하고 구현 후 동일 request replay 1행, conflicting replay 409-equivalent domain error, 근거 발생 시각과 서버 적용 순서의 분리, 최신 projection, newer reconsent 적용을 모두 통과합니다.
  - [ ] 같은 unit test에서 Instagram marketing grant가 SMS·다른 recipient·다른 workspace에 권한을 주지 않고, `evidence_kind='import'` grant가 marketing을 허용하지 않음을 assertion합니다.
  - [ ] `TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='Supabase roles cannot read product data' src/cloudflare/access.db.test.ts`가 새 두 table에 대해 `anon`, `authenticated`, `service_role` SELECT SQLSTATE `42501`, runtime DELETE `42501`, event UPDATE `42501`, state SELECT/INSERT/UPDATE 성공을 확인합니다.
  - [ ] migration 016을 같은 test transaction에서 두 번 적용해 row와 현재 상태가 유지되고 두 번째 적용이 성공합니다.

  QA scenarios (MANDATORY - task incomplete without these):

  ```plaintext
  Scenario: 명시적 Instagram 마케팅 동의와 더 최신 재동의가 exact scope에서만 허용됩니다.
    Tool:     bash
    Steps:    TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='consent ledger preserves revoke and re-consent evidence|marketing consent is exact-channel and import-safe' src/instagram/channel-consent.test.ts src/instagram/channel-consent.db.test.ts
    Expected: 두 named test가 통과하고 event history에는 grant→revoke→reconsent가 모두 남으며 projection은 서버가 마지막으로 적용한 event를 가리킵니다.
    Evidence: node:test TAP output와 event/state row assertion output.

  Scenario: import 또는 다른 채널의 grant가 현재 Instagram 마케팅 권한으로 승격되지 않습니다.
    Tool:     bash
    Steps:    node --test --test-name-pattern='marketing consent is exact-channel and import-safe' src/instagram/channel-consent.test.ts
    Expected: import, missing state, channel mismatch, identity mismatch가 각각 `marketing_consent_required`이며 service-reply evidence가 marketing 권한으로 사용되지 않습니다.
    Evidence: named TAP subtest의 pass output.
  ```

  Commit: NO | Message: `feat(consent): add channel consent ledger` | Files: [`src/instagram/channel-consent.ts`, `src/instagram/channel-consent.test.ts`, `src/instagram/channel-consent.db.test.ts`, `db/migrations/016_channel_consent.sql`, `db/schema.sql`, `deploy/migrate-multi-user.sql`, `deploy/supabase-access.sql`, `deploy/init-app-user.sh`, `src/cloudflare/access.db.test.ts`, `package.json`]

- [ ] 2. 인증된 API로 철회와 재동의 근거를 기록합니다.

  What to do: `src/app/api.test.ts`와 새 `src/app/channel-consent.db.test.ts`에 RED test를 먼저 추가하고 DB script에 등록합니다.
  `src/app/channel-consent.ts`에서 `POST /api/connections/:connectionId/channel-consent-events`를 구현하고 `src/app/api.ts`에 route를 연결합니다.
  body는 정확히 `request_key`, `identity_kind`, `identity_value`, `purpose`, `decision`, `evidence_kind`, `evidence_reference`, `occurred_at`만 받으며 허용 enum, ID 길이, ISO timestamp, bounded reference를 검사합니다.
  현재 API는 `channel='instagram'`을 서버에서 고정하고 body가 channel을 고르게 하지 않습니다.
  same-origin 검사는 DB open 전에 수행하고, authenticated user의 workspace가 connection을 소유하는지 잠금 안에서 확인합니다.
  `purpose='all'` revoke는 하나의 event를 근거로 `service_reply`와 `marketing` state를 원자적으로 revoked로 만들고, reconsent는 `service_reply` 또는 `marketing` 중 하나를 명시해야 합니다.
  API가 받은 `import` evidence는 기록할 수 있지만 marketing grant projection을 authoritative하게 만들지 않습니다.
  response는 event ID, 적용 여부, purpose별 current decision과 `occurred_at`만 반환하고 message body, token, raw provider payload를 반환하지 않습니다.
  Must NOT do: unauthenticated webhook에서 상태를 변경하거나, free-form provider permission을 저장하거나, foreign connection·identity를 생성하거나, UI를 추가하지 않습니다.

  Parallelization: Can parallel: YES, with Task 3 | Wave 2 | Blocks: [] | Blocked by: [1]

  References (executor has NO interview context - be exhaustive):
  - API route pattern: `src/app/api.ts:38` - 인증, same-origin mutation gate, pool lifetime을 소유하는 top-level API handler입니다.
  - Contact mutation routing: `src/app/api.ts:195` - encoded contact identity를 검증하고 workspace-scoped service로 넘기는 route pattern입니다.
  - Manual idempotency pattern: `src/app/manual-replies.ts:33` - exact field set과 UUID request key validation pattern입니다.
  - Ownership/transaction pattern: `src/app/manual-replies.ts:55` - workspace-owned connection lock과 idempotent mutation transaction pattern입니다.
  - Existing API denial tests: `src/app/api.test.ts:605` - unauthenticated/cross-origin request가 DB를 열지 않는 assertion pattern입니다.
  - Current identity rule: `src/instagram/message-events.ts:18` - inbound Instagram sender ID를 entry account와 구분하고 numeric scoped ID로 검증하는 parsing boundary입니다.
  - External: [Issue #27](https://github.com/AndrewDongminYoo/auto-chatter/issues/27) - revoke/reconsent evidence와 timestamp 보존 요구입니다.

  Acceptance criteria (agent-executable only):
  - [ ] `node --test --test-name-pattern='consent mutation rejects unauthenticated and cross-origin requests before DB access' src/app/api.test.ts`가 RED 이후 통과하고 DB open count가 0임을 확인합니다.
  - [ ] `TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='owned consent API records idempotent revoke and scoped re-consent' src/app/channel-consent.db.test.ts`가 exact replay를 같은 event로 반환하고 payload conflict를 409, foreign connection을 404, invalid enum/timestamp를 400으로 검증합니다.
  - [ ] 같은 DB test에서 `purpose='all'` revoke가 service와 marketing state를 한 transaction에서 갱신하고, service-only reconsent 뒤에도 marketing은 revoked로 남음을 확인합니다.
  - [ ] API 응답과 error에 evidence 원문 밖의 webhook body, access token, SQL text가 포함되지 않음을 assertion합니다.

  QA scenarios (MANDATORY - task incomplete without these):

  ```plaintext
  Scenario: 소유한 Instagram 연결의 수신 거부와 service-only 재동의를 idempotent하게 기록합니다.
    Tool:     bash
    Steps:    TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='owned consent API records idempotent revoke and scoped re-consent' src/app/channel-consent.db.test.ts
    Expected: 첫 요청은 event를 만들고 동일 request key와 payload는 같은 event를 반환하며 service-only reconsent 뒤 service는 granted, marketing은 revoked입니다.
    Evidence: TAP output와 event/state row assertions.

  Scenario: cross-origin 또는 다른 workspace 요청이 원장을 변경하지 않습니다.
    Tool:     bash
    Steps:    node --test --test-name-pattern='consent mutation rejects unauthenticated and cross-origin requests before DB access' src/app/api.test.ts && TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='owned consent API records idempotent revoke and scoped re-consent' src/app/channel-consent.db.test.ts
    Expected: cross-origin/unauthenticated는 DB open 전 거부되고 foreign workspace는 404이며 각 실패 뒤 event count가 변하지 않습니다.
    Evidence: TAP output, DB open counter, final event count assertion.
  ```

  Commit: NO | Message: `feat(api): record channel consent events` | Files: [`src/app/channel-consent.ts`, `src/app/channel-consent.db.test.ts`, `src/app/api.ts`, `src/app/api.test.ts`, `package.json`]

- [ ] 3. 현재 Instagram 발송 경로의 대기 행과 최종 POST를 수신 거부로 차단합니다.

  What to do: `src/instagram/reply-worker.db.test.ts`, `src/instagram/follow-flow.db.test.ts`, `src/cloudflare/worker.db.test.ts`에 각 경로의 RED race test를 먼저 추가합니다.
  첫 private reply는 outbox의 `sender_id` service-reply state를 검사하고, follow reply는 linked outbox `sender_id`와 known `recipient_id` 중 하나라도 revoked이면 차단합니다.
  수동 reply는 handoff가 증명한 sender와 recipient를 모두 검사하며 queue admission, `manualReplyEligibility`, `assertManualReplyAllowed`에서 같은 판정을 사용합니다.
  `processNextPrivateReply`와 `processNextFollowReply`는 claim 후 provider 조회 전 수신 거부를 terminal 처리하고, Node `assertNodePrivateReplyAllowed`/`createNodeFollowTransport.beforeSend` 및 Cloudflare private/follow/manual `beforeSend`에서 claim token과 함께 상태를 다시 읽습니다.
  Cloudflare `wakeDueReplies`는 revoked pending row도 한 번 깨워 terminal 상태로 정리할 수 있어야 하며 provider POST를 호출하지 않아야 합니다.
  수신 거부가 authorization/profile lookup 뒤 commit되는 race에서 final guard가 `recipient_opted_out`을 반환하는지 검증합니다.
  terminal 처리 뒤 reconsent해도 같은 outbox/manual row가 자동 pending으로 돌아오지 않고 새 user-initiated service event만 새 work를 만들 수 있게 유지합니다.
  Must NOT do: active provider request를 취소할 수 있다고 주장하거나, `recipient_opted_out`을 retryable pause로 처리하거나, reconsent 시 blocked/failed/unknown 행을 재예약하거나, service reply에 marketing grant를 요구하지 않습니다.

  Parallelization: Can parallel: YES, with Task 2 | Wave 2 | Blocks: [] | Blocked by: [1]

  References (executor has NO interview context - be exhaustive):
  - Private claim/policy: `src/instagram/reply-worker.ts:94` - private outbox claim, verification, policy, contact pause race 처리 흐름입니다.
  - Private final Node guard: `src/instagram/node-delivery.ts:43` - claim·rule·connection 상태를 provider POST 직전에 다시 확인하는 Node path입니다.
  - Follow claim/policy: `src/instagram/follow-flow.ts:69` - follow reply claim, 24-hour window, 두 차례 permission 검사, terminal/retry 상태 전이입니다.
  - Follow final Node guard: `src/instagram/node-delivery.ts:6` - follow `beforeSend`의 claim 및 현재 상태 확인 pattern입니다.
  - Manual admission and final guard: `src/instagram/manual-reply-worker.ts:18` - handoff identity, latest inbound text window, claim/token 상태를 공유하는 eligibility snapshot입니다.
  - Manual API queue: `src/app/manual-replies.ts:66` - 새 수동 reply와 explicit retry가 현재 eligibility를 통과한 뒤 insert되는 경계입니다.
  - Cloudflare wake: `src/cloudflare/index.ts:50` - manual, private, follow due work를 connection queue로 알리는 query입니다.
  - Cloudflare final guards: `src/cloudflare/index.ts:197` - Graph POST wrapper의 private guard 및 manual/follow `beforeSend` 경계입니다.
  - Existing race tests: `src/instagram/follow-flow.db.test.ts:525` - authorization 후 pause가 Node private/follow 최종 guard에 보이는 test pattern입니다.
  - Existing Cloudflare race tests: `src/cloudflare/worker.db.test.ts:533` - verification 중 상태 변경 뒤 provider POST count가 0인 workerd test pattern입니다.
  - Manual queue contract: `docs/specs/2026-09-27-inbox-manual-replies.md:29` - 수동 reply의 claim, 실제 POST 직전 재검사, terminal 결과 계약입니다.

  Acceptance criteria (agent-executable only):
  - [ ] `TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='opt-out blocks queued private reply and re-consent does not replay it' src/instagram/reply-worker.db.test.ts`가 RED에서 provider mock 호출 또는 잘못된 상태로 실패하고 GREEN에서 `blocked / recipient_opted_out`, POST count 0, reconsent 후 동일 row 불변을 확인합니다.
  - [ ] `TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='opt-out committed after authorization blocks Node private and follow final POST' src/instagram/follow-flow.db.test.ts`가 양쪽 path의 POST count 0과 terminal `recipient_opted_out`을 확인합니다.
  - [ ] `corepack pnpm build:cloudflare && TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='Cloudflare opt-out final guards block private follow and manual POST' src/cloudflare/worker.db.test.ts`가 named workerd test를 실제 실행하고 통과합니다.
  - [ ] Cloudflare named test가 private/follow/manual 각 race에서 mock Meta POST count 0, private/follow `blocked`, manual `failed / safe_to_retry=false`, 모든 failure code `recipient_opted_out`을 확인합니다.
  - [ ] opt-out이 없는 기존 댓글 service reply, confirmed follow reply, handoff manual reply fixture는 기존 성공 상태와 provider POST count 1을 유지합니다.

  QA scenarios (MANDATORY - task incomplete without these):

  ```plaintext
  Scenario: Node는 authorization 뒤 기록된 opt-out을 첫 답장과 follow 최종 POST에서 차단합니다.
    Tool:     bash
    Steps:    TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='opt-out blocks queued private reply and re-consent does not replay it|opt-out committed after authorization blocks Node private and follow final POST' src/instagram/reply-worker.db.test.ts src/instagram/follow-flow.db.test.ts
    Expected: 모든 provider POST count가 0이고 대기 행은 terminal `recipient_opted_out`이며 이후 reconsent가 해당 행을 재생하지 않습니다.
    Evidence: TAP output, captured mock POST count, outbox/follow row assertions.

  Scenario: Cloudflare는 Queue claim 뒤 opt-out race를 private, follow, manual 모두에서 최종 차단합니다.
    Tool:     bash
    Steps:    corepack pnpm build:cloudflare && TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='Cloudflare opt-out final guards block private follow and manual POST' src/cloudflare/worker.db.test.ts
    Expected: Queue message는 ack되고 Meta POST count는 0이며 private/follow는 blocked, manual은 failed와 `safe_to_retry=false`로 기록됩니다.
    Evidence: Wrangler dry-run output, named TAP subtest, DB status/failure code assertions.

  Scenario: 수신 거부가 없는 사용자 시작 서비스 답장은 기존 의미를 유지합니다.
    Tool:     bash
    Steps:    TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='two workers claim one reply and record one provider message|nonfollowers can confirm again' src/instagram/reply-worker.db.test.ts src/instagram/follow-flow.db.test.ts && corepack pnpm build:cloudflare && TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test node --test --test-concurrency=1 --test-name-pattern='manual queued reply wakes on cron and duplicate queue messages send once' src/cloudflare/worker.db.test.ts
    Expected: 기존 fixture의 eligible private/follow/manual path가 각각 한 번만 send되고 기존 reply window와 handoff 조건이 유지됩니다.
    Evidence: named TAP output와 provider mock call-count assertions.
  ```

  Commit: NO | Message: `fix(delivery): enforce recipient opt-out guards` | Files: [`src/instagram/reply-worker.ts`, `src/instagram/reply-worker.db.test.ts`, `src/instagram/follow-flow.ts`, `src/instagram/follow-flow.db.test.ts`, `src/instagram/node-delivery.ts`, `src/instagram/manual-reply-worker.ts`, `src/app/manual-replies.ts`, `src/cloudflare/index.ts`, `src/cloudflare/worker.db.test.ts`]

## Final verification

> 이 변경은 core delivery와 DB/RLS를 함께 건드리므로 independent review와 adversarial race cross-check가 필요합니다.

- [ ] `corepack pnpm check-types`를 실행해 TypeScript error 0을 확인합니다.
- [ ] `corepack pnpm test`를 실행해 새 named policy/API tests가 포함되고 failure 0인지 확인합니다.
- [ ] `TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test corepack pnpm test:db`를 실행해 새 ledger/API/Node guard tests가 포함되고 failure 0인지 확인합니다.
- [ ] `TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:55433/automations_test corepack pnpm test:cloudflare`를 실행해 workerd/Hyperdrive/Queue와 access tests가 failure 0인지 확인합니다.
- [ ] 새 opt-out race fixture에서 revoke insert를 제거해 named test가 provider POST count assertion으로 실패하는지 확인한 뒤 fixture를 복구하고 GREEN을 다시 확인합니다.
- [ ] `trunk check --ci`를 실행해 formatter, markdown, security, secret scan 결과를 확인합니다.
- [ ] reviewer는 event/state atomicity, 서버 기록 순서와 클라이언트 발생 시각의 분리, idempotency conflict, exact identity/channel/purpose matching, append-only privilege, claim 이후 race, terminal no-replay를 구조화된 한 번의 pass로 검사합니다.
- [ ] adversarial cross-check는 revocation commit을 provider lookup 전, lookup 후, final guard 후 세 지점에 배치하고 final guard 후 이미 시작된 POST만 회수 불가라는 기존 한계를 정확히 남겼는지 확인합니다.
- [ ] `git -C /Users/dongminyu/Development/01_personal/auto-chatter status --short`와 `git -C /Users/dongminyu/Development/01_personal/auto-chatter diff --check`로 authorized file 외 변경과 whitespace error가 없음을 확인합니다.
- [ ] migration, schema, runner, access array, test cleanup/TRUNCATE 목록이 모두 새 두 table을 포함하고 `SEND_ENABLED`, `send_enabled`, rule `enabled` 값이나 deployment artifact가 변경되지 않았는지 diff를 확인합니다.

## Commit strategy

- 이 계획 요청은 commit을 승인하지 않았으므로 구현 executor는 stage하거나 commit하지 않습니다.
- 추후 commit 권한이 주어지면 Task 1, Task 2, Task 3을 각각 독립적인 conventional commit으로 분리하고 migration/schema/access 변경은 Task 1 commit에 함께 둡니다.
- 계획 단계에서는 stage하거나 commit하지 않습니다.

## Success criteria

- Issue #27의 세 완료 조건이 각각 Task 1의 원장/default-deny, Task 2의 evidence ingestion, Task 3의 대기·최종 guard에 매핑됩니다.
- 수신 거부가 없으면 기존 user-initiated service reply test가 그대로 통과하고, marketing은 exact explicit grant가 없으면 항상 거부됩니다.
- revoke와 reconsent의 근거·발생 시각·기록 시각이 append-only로 남고 stale/replayed event가 현재 상태를 잘못 되돌리지 않습니다.
- Node와 Cloudflare의 private, follow, manual send path가 모두 provider POST 직전에 현재 수신 거부를 읽으며 race test가 POST count 0을 증명합니다.
- runtime role은 필요한 SELECT/INSERT/UPDATE만 가지며 consent event UPDATE와 두 table DELETE, API role direct access는 계속 거부됩니다.
- 실제 Meta permission, 실제 delivery, 운영 migration, deployment 성공은 이 로컬 구현 계획의 증거로 주장하지 않습니다.
