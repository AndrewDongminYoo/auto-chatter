# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A self-hosted messaging automation service positioned against ManyChat's paid features.
The implemented channel is Instagram: signed comment and message webhooks feed PostgreSQL, keyword rules queue private replies, and confirmed DM responses trigger conditional follow checks and follow-up messages.
The `/app/` dashboard uses server-verified Supabase Auth sessions and workspace-scoped APIs to connect accounts through Instagram OAuth and edit rules.
Product scope, non-goals and the phased roadmap live in `docs/specs/` and `docs/plans/`; README.md, the specs, plans and notes are written in Korean.

## Commands

Node.js >= 24 runs the local TypeScript sources directly (native type stripping).
Cloudflare uses Wrangler to bundle the same modules for Workers.
Use `corepack pnpm` (pnpm 10, pinned by `packageManager`).

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check-types          # tsc --noEmit, the only compile check
corepack pnpm test                 # unit tests, no DB needed
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:db
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:cloudflare
corepack pnpm build:cloudflare    # bundle only, never deploys
corepack pnpm start                # webhook receiver only (needs DATABASE_URL, INSTAGRAM_APP_SECRET, INSTAGRAM_VERIFY_TOKEN)
corepack pnpm meta:check           # read-only Meta token/account check
corepack pnpm worker:instagram     # sends real private replies — only after Meta permissions are confirmed
```

Run a single test file or test by name:

```bash
node --test src/instagram/reply-policy.test.ts
node --test --test-name-pattern="seven-day boundary" src/instagram/reply-policy.test.ts
```

- The `test` and `test:db` scripts list their files explicitly; a new test file must be added to the matching script in `package.json` or it never runs.
- `*.db.test.ts` files refuse to run unless `TEST_DATABASE_URL` points at a database named `automations_test` on `localhost`/`127.0.0.1`, and they apply `db/schema.sql` themselves, then `TRUNCATE` every product table before each test. They run with `--test-concurrency=1`. The local Postgres container setup is in README.md.
- `test:cloudflare` requires a disposable local PostgreSQL cluster: it creates roles and modifies public schema grants in `automations_test`.
- Package scripts do not load `.env`; export variables into the shell first (`.env.example` lists the Meta ones).
- Trunk (`.trunk/trunk.yaml`) runs prettier, markdownlint, yamllint, osv-scanner and trufflehog. The pre-commit format hook is disabled and `trunk check` runs on pre-push, so run `trunk fmt` yourself before committing.
- Never enable sends, create cloud resources, or publish as part of tests.

## Code conventions forced by the runtime

- Relative imports carry the `.ts` extension (`./store.ts`); `tsconfig.json` uses `NodeNext` with `allowImportingTsExtensions`.
- Only erasable TypeScript syntax works under Node's type stripping: no `enum`, `namespace`, or constructor parameter properties.
- The only runtime dependency is `pg`. HTTP uses `node:http`, tests use `node:test` + `node:assert/strict`, and Graph calls use global `fetch`.
- The `.mjs` workerd harness avoids Miniflare's incomplete published TypeScript declarations; application TypeScript remains strict.
- Wrangler and Miniflare are pinned to the tested v4 runtime pair; upgrade them together and run `test:cloudflare`.

## Architecture

Two processes share one PostgreSQL database (`db/schema.sql` is the current schema; existing databases are migrated as described under Deployment).

**Ingress** (`main.ts` → `http.ts` → `webhook.ts` → `store.ts`):
`GET/POST /webhooks/instagram` verifies the subscription challenge and the `x-hub-signature-256` HMAC over the raw body, parses comment events, and `ingestComments` writes them in one transaction.
Only comments on an `active` `instagram_connections` row are stored.
Deduplication is enforced by unique constraints, not application logic: one event per `(connection_id, comment_id)` and one outbox row per `(connection_id, media_id, sender_id)`, both inserted with `ON CONFLICT DO NOTHING`.
A rule matches normalized keywords with `contains`, `exact`, or `all` mode; excluded substrings take precedence.
One rule exists per `(connection_id, media_id)`; empty `keywords` falls back to the legacy `keyword`.

**Worker** (`worker-main.ts` → `reply-worker.ts` → a `PrivateReplyTransport`):
The Node worker serves one active, send-enabled, environment-managed connection (`META_INSTAGRAM_CONNECTION_ID`, with no encrypted OAuth credential); the Cloudflare adapter reads encrypted credentials and send switches per queued connection from the database.
`processNextPrivateReply` claims a `pending` outbox row with `FOR UPDATE SKIP LOCKED` and a fresh `attempt_id`; every later state change is conditional on `status = 'sending' AND attempt_id = $n` and throws if the claim was lost.
In Instagram Login mode, each Node polling cycle processes a confirmed follow reply and a private reply, with startup and periodic stale-claim recovery scoped to that connection.
Follow delivery uses the environment account binding instead of the Cloudflare stored-token check; Cloudflare retains its encrypted-token and expiry requirements.
Both Node send paths recheck the claim, connection, rule, send switch and environment ownership immediately before POST; follow sends also recheck the 24-hour window.
OAuth-managed connections must use the Cloudflare adapter, and Facebook Login blocks follow-gated rules before the first DM (`follow_requires_instagram_login`).
The Node environment-token worker does not process manual inbox replies.
The sequence is: transport `verify()` (read-only Graph checks) → `evaluatePrivateReply` in `reply-policy.ts` (connection active, authorization, media ownership, not own comment, 7-day comment window) → transport `send()`.
Media ownership accepts a numeric `profile.id` only after the same profile's `user_id` matches the stored account; both identities remain protected against own-comment replies.
Outbox status semantics matter for correctness:

- `pending` + `next_attempt_at` pushed 1 minute: verification failed (including transient Graph errors on read calls), or `PreSendVerificationError` with `retry`.
- `blocked` + `failure_code`: the policy rejected it, or `PreSendVerificationError` with `block`.
- `pending` + `rate_limit_retries` incremented: `ProviderRateLimitedError`, i.e. Meta refused the send `POST` with a throttle code in a 4xx body. The delay comes from the backoff tiers in `reply-worker.ts`, or from a longer `Retry-After`. The connection's `send_paused_until` is pushed out by the same delay, and the claim query skips every reply of a paused connection, so the other replies do not spend their own retries.
- `pending` + `failure_code = connection_paused`: a pause became visible after the reply was claimed and verified. The worker clears the attempt and defers the reply to the connection pause without consuming a rate-limit retry.
- `failed` + `failure_code = meta_error_<code>`: `ProviderRejectedError` (a non-transient error code on the send `POST`), or a rate limit after the backoff tiers are used up.
- `unknown`: `send()` threw anything else, or a `sending` row outlived 10 minutes (`recoverStalePrivateReplies`). These are never retried automatically, to avoid double-sending.
- `sent` + `provider_message_id`.

A transport may throw `PreSendVerificationError` only before it issues the provider send request, and `ProviderRejectedError` or `ProviderRateLimitedError` only for a definite rejection of that request; any other error from `send()` is treated as an ambiguous outcome.
`classifyMetaGraphFailure` in `meta-graph-error.ts` is the single place both transports use to classify a non-2xx, non-5xx Graph response.
It classifies provider refusals only for HTTP 4xx.
The service accepts `Retry-After` delays from zero through seven days; malformed or larger values fall back to the retry tier.
This bound is a service policy, not a Meta-specified maximum.
The worker checks the connection pause again before entering `transport.send()`; the check and the external POST are not atomic, and requests already admitted to `send()` can continue if a pause is recorded later.
Cooldown is scoped to one stored connection; an app-wide quota shared by multiple connections is not coordinated yet.

**Transports** (selected by `META_LOGIN_MODE`, default `facebook`; the configured Meta app uses `instagram`):

- `instagram-login-private-reply.ts`: Instagram user token against `graph.instagram.com`.
- `facebook-private-reply.ts`: Facebook Login path; additionally checks token scopes, the Page↔Instagram link and the `MESSAGING` task.

Both accept an injectable `fetchImpl`, which is how the unit tests mock Graph responses.
`worker-main.ts` only surfaces error messages that start with `Invalid Meta`/`Meta Graph` (or the account ID error); anything else prints a generic message so tokens never reach logs.

**Cloudflare Worker** (`src/cloudflare/index.ts`):
One Worker serves webhooks, public pages, the dashboard API and the queue/cron delivery path.
It reuses ingestion and the single-row worker; it does not run the Node polling loop.
Queue messages contain only a connection ID; database status remains authoritative.
Each notification processes at most one row, then wakes remaining due work only for that connection.
Webhook notifications are scoped to the account IDs in the received events; only cron discovers due work globally.
Cron runs each minute to recover stale sends, refresh due tokens, and repair missed notifications or delayed retries.
`TOKEN_ENCRYPTION_KEY` decrypts workspace/account-bound AES-GCM credentials; a valid per-account token and `send_enabled` are required in addition to the global switch.
The adapter prioritizes manual replies, then pending follow confirmations, and rechecks the rule, claim, connection, token version, cooldown and 24-hour window immediately before a normal DM POST.
There is no atomic transaction spanning PostgreSQL and Meta: a setting change after the final guard cannot recall an in-flight request.

**Dashboard and API** (`src/app/`, `public/app/`):
The Worker delegates `/api/*` to `appApi` in `src/app/api.ts`; the modules beside it own auth, OAuth, token refresh, secrets, contacts, fields, inbox, handoff, manual replies and consent.
Every non-GET `/api/*` request must be same-origin (`requireSameOrigin`); routes other than `/api/auth/*` require a verified session and scope data to the caller's workspace.
`public/app/` is a build-free static client (`app.js`, `inbox.js`) served by Wrangler assets.
The auth client wraps injected fetch in a standalone call because workerd rejects a native fetch invoked with the client object as its receiver.

**Follow flow** (`follow-flow.ts`, `message-events.ts`):
`instagram_follow_conversations` snapshots the first reply configuration; a nonfollower response returns to waiting, a follower response completes, and ambiguous sends remain unknown.
A missing recipient ID after a successful first DM records `follow_recipient_unavailable` without resending.
Inbound DM text is compared in memory for follow confirmation; receipt IDs and timestamps deduplicate confirmation events.
Optional `confirmation_button_title` adds a single postback template button to the first DM and nonfollower response; empty defaults preserve text-only delivery.
Button clicks are bound to the queued reply ID and validated against account, recipient and waiting flow; typed confirmation still works.
The service caps button labels at 20 and button-message text at 640.
OAuth subscribes `messaging_postbacks` as well as comments/messages, so existing accounts must reconnect and the app must subscribe that webhook field.

**Token lifecycle**: active Instagram Login connections refresh valid long-lived tokens from 30 days before expiry, after the token is at least 24 hours old.
Inactive, expired, or disconnected connections do not refresh; an expired token requires OAuth reconnection.

## Feature invariants

Each feature's contract lives in its spec; the lines below are the invariants a code change most easily breaks.
None of the stored contact, segment, field or inbox records proves messaging consent or delivery eligibility, and none of these features grants DELETE privileges to server roles.

- **Contacts** ([spec](docs/specs/2026-09-27-instagram-contacts.md)): contacts are derived from stored comment events and are returned without comment text or credentials. Manual tags (max 20) apply only to existing workspace-owned comment participants; empty tag arrays remove tags. Comment identities are not merged with DM identities.
- **Saved segments** ([spec](docs/specs/2026-09-27-contact-segments.md)): archive instead of delete. Creation locks the workspace row before checking the 50-active-segment limit; normalized active names are unique per workspace. `segment_id` cannot be mixed with manual `connection_id` or `tag` filters.
- **Typed fields** ([spec](docs/specs/2026-09-27-contact-fields.md)): text, number, boolean and date values are scoped to workspace, connection and sender; zero, false and empty text are set values. An active segment that references a field blocks its archive with `field_in_use`. Archived definitions keep stored values.
- **Per-contact automation pause** ([spec](docs/specs/2026-09-27-contact-automation-control.md)): `instagram_contact_automation` holds a manual `paused` and a derived `handoff_paused`. Every automated claim, Cloudflare wake query, verification check and Node/Cloudflare final guard checks both. A post-claim pause returns unsent work to pending with `contact_paused` without spending a rate-limit retry. Paused confirmations keep receipt metadata but cannot activate a follow flow; the activation UPDATE rechecks the current pause. Resume keeps queued work and original windows, never resets unknown, failed or blocked outcomes, and a manual resume is refused while a handoff is active.
- **Received inbox** ([spec](docs/specs/2026-09-27-instagram-inbox.md)): each connection defaults to `inbox_enabled=false`, and its activation timestamp gates storage of new text DMs and confirmation postbacks. Disabling it keeps stored history under the manual deletion policy. `instagram_inbox_messages` deduplicates by connection and provider message ID in the confirmation transaction. DM recipient IDs stay separate from comment participant IDs.
- **Handoff** ([contract](docs/specs/2026-09-27-inbox-handoff-contract.md)): the context read is advisory, masks identity unless one fresh sender is verified, and keeps missing, stale and ambiguous evidence distinct. Starting a handoff requires a currently verified comment bridge; resuming uses the captured sender. Writes are version-checked with append-only audit.
- **Manual replies** ([server](docs/specs/2026-09-27-inbox-manual-replies.md), [UI](docs/specs/2026-09-28-inbox-manual-reply-ui.md)): requests carry a UUID key and the active handoff version; identical repeats return the existing row and payload reuse is refused. Only a fresh stored inbound text DM opens the 24-hour window. Cloudflare delivery rechecks the claim, token version and expiry, connection, handoff, identity bridge, derived pause and window immediately before POST. Pending, sending or unresolved unknown rows block later replies in the same conversation. Definite unsent failures allow an audited retry as a new linked row; unknown never allows retry, and an audited `no_retry` releases later rows. Stale sends become unknown with audit in the same transaction. Server roles cannot UPDATE or DELETE the audit.
- **Channel consent** ([spec](docs/specs/2026-09-29-channel-consent.md)): `channel_consent_events` is append-only and `channel_consent_state` is its exact-scope projection, updated in the same transaction under the connection lock. `service_reply` grants need explicit evidence, `all` can only revoke, and marketing without an exact explicit grant is denied. Client `occurred_at` is evidence, not ordering. Private, follow and manual delivery check service revokes after claim and immediately before POST, for the comment sender and every DM recipient bridged by a provider-acknowledged same-sender reply. Only a later server-recorded explicit re-consent releases a revoke in the same scope; a delivery row already blocked or failed by an opt-out (`recipient_opted_out`) is terminal and never replays after re-consent. A consent read error defers the send (`pending / consent_unavailable`).

## Deployment

The primary target is Cloudflare Workers + Queues + Supabase PostgreSQL through Hyperdrive; `wrangler.json` pins the personal account and Hyperdrive ID.
`SEND_ENABLED` must equal `true` to send, and the committed configuration keeps it `false`.
Hyperdrive query caching MUST be disabled to keep authorization and active-state reads fresh.
The Worker serves both workers.dev and `auto-chat.donminzzi.kr` with both webhook secrets registered; incorrect verification tokens and unsigned requests return 403.
Public GET/HEAD routes `/privacy`, `/data-deletion` and `/service` serve static Korean pages from `src/cloudflare/public-pages.ts` without secrets or database bindings; no automatic or unauthenticated deletion API exists.
Wrangler serves `public/` as static assets before Worker routing; keep only public files in that directory.
Generated provisioning credentials stay in the ignored `deploy/secrets/` directory; never log or commit them.

**Database changes**: add a numbered file under `db/migrations/`, update `db/schema.sql`, and include the migration in `deploy/migrate-multi-user.sql`.
That runner owns the transaction for migrations 003 onward plus `deploy/supabase-access.sql`, stops on the first error and rolls back; never apply those migration files individually.
Run it with an administrator connection (`psql -f deploy/migrate-multi-user.sql`) before deploying code that reads the new schema.
A fresh dedicated Supabase project gets `db/schema.sql` and `deploy/supabase-access.sql` in a single administrator transaction.
The access script enables RLS, revokes API-role table access, and grants only SELECT/INSERT/UPDATE to the server role and the Compose `automations_app` role when present; both must be unprivileged, have no memberships, and own no objects.
It also revokes PUBLIC schema CREATE, so do not apply it to a shared project without reviewing that impact.
Assign a workspace to a confirmed operator with `deploy/assign-workspace-owner.sql`; never claim legacy data automatically by email.
Manual data deletion order is owned by `docs/notes/2026-09-26-multi-user-cutover.md`.

**Compose**: `Dockerfile` runs the sources as the non-root `node` user with production dependencies only.
`compose.yaml` starts PostgreSQL and ingress by default; profiles `send` and `public` enable the real worker and Caddy proxy respectively.
Use `--env-file deploy/runtime.env` explicitly; `deploy/environment.example` is the empty template.
Never print resolved configuration with secrets; use `config --quiet`.
Fresh DB volumes initialize the current schema and a separate DML-only `automations_app` role; existing volumes need the migrations in `docs/notes/2026-09-26-deployment-runbook.md`.
Deployment smoke checks use synthetic credentials, a separate Compose project and loopback ports, with no live Meta calls.

**CI**: `.github/workflows/ci.yaml` runs type checks, unit and PostgreSQL integration tests, a local workerd/Hyperdrive/Queue smoke check, Trunk, and a container deployment smoke check on PRs and pushes to `main`.
The deployment job verifies signed-event persistence, replay protection, restricted DB privileges and HTTPS with a local Caddy CA; it never starts a sending worker.

Operating procedures: `docs/notes/2026-09-26-cloudflare-runbook.md` (Cloudflare) and `docs/notes/2026-09-26-multi-user-cutover.md` (migration and configuration).

## Verification boundaries

Type checks, isolated DB/workerd tests and mocked Graph tests do not prove production migrations, deployed Worker behavior, live permissions or a live send; do not describe them as if they did.
This file records no deployment status on purpose: production and live Meta evidence, dated identifiers and the list of unverified behavior are owned by `docs/notes/2026-09-27-manychat-acceptance-matrix.md`, the dated verification notes it links, and each spec's operating-status section.
Read the latest of those before claiming anything is deployed or verified.
