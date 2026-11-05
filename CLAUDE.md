# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A self-hosted messaging automation service positioned against ManyChat's paid features.
The implemented channel is Instagram: signed comment and message webhooks feed PostgreSQL, keyword rules queue private replies, and confirmed DM responses trigger conditional follow checks and follow-up messages.
The `/app/` dashboard uses server-verified Supabase Auth sessions and workspace-scoped APIs to connect accounts through Instagram OAuth and edit rules.
Product scope, non-goals and the phased roadmap live in `docs/specs/` and `docs/plans/`; README.md, the specs, plans and notes are written in Korean, while `docs/agents/` holds English guidance for coding agents.

## Commands

Node.js >= 24 runs the local TypeScript sources directly (native type stripping).
Cloudflare uses Wrangler to bundle the same modules for Workers.
Use `corepack pnpm` (pnpm 10, pinned by `packageManager`).

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check-types          # tsc --noEmit, the only compile check
corepack pnpm test                 # unit tests, no DB needed
python3 -m unittest discover -s .trunk/configs/tests -p 'test_*.py' -v # offline secret-scan reader
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
- `.trunk/trunk.yaml` owns the Trunk linter set; pinact runs both `lint` and `upgrade`, and trufflehog runs offline.
  Its filesystem JSONL reader retains findings without a literal source match and fails on malformed records; the Python regression suite above also runs in CI.
  The pre-commit hook formats staged files and `trunk check` runs on pre-push; a file that must keep its formatting needs an explicit `lint.ignore` entry in `.trunk/trunk.yaml`.
  cspell reads `cspell.config.yaml`: add project terms to `.cspell/custom-dictionary.txt` and PostgreSQL catalog or function names to `.cspell/postgres-terms.txt`, and fix a real misspelling in its source instead.
- Never enable sends, create cloud resources, or publish as part of tests.
- PostgreSQL timestamps retain microseconds, while the default `pg` JavaScript `Date` reader retains milliseconds.
  The subscription-check DB test reads epoch microseconds for strict ordering assertions; do not replace that reader with `Date` comparisons or sleeps.
- Full-dashboard segment acceptance is a manual fixture outside the test scripts that needs its own fresh disposable cluster: see [Segment acceptance fixture](docs/agents/feature-invariants.md#segment-acceptance-fixture).

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
Cooldown is scoped to one stored connection.
A proactive budget also holds a connection's private replies at 700 provider calls per rolling hour (`PRIVATE_REPLY_HOURLY_BUDGET` in `src/instagram/send-quota.ts`, counted from `provider_called_at`, which is set just before `transport.send()`, plus the recent calls of deleted outbox rows, which an `AFTER DELETE` trigger carries on the connection for the rest of their hour so a data deletion and reconnect do not reset the count ([carry](docs/specs/2026-10-12-send-quotas.md#삭제한-행의-호출-이월))): the claim and the private-reply branch of the wake skip them, leaving them `pending` without spending a retry, while manual replies and follow DMs keep sending. Meta documents no app-wide shared messaging limit, so none is coordinated ([spec](docs/specs/2026-10-12-send-quotas.md)).

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
Webhook notifications are scoped to the account IDs in the received events; only cron discovers due work globally, queuing at most 100 connections per run, least recently woken first (`send_woken_at`, stamped only after its message is published), so every due connection is reached in rotation ([spec](docs/specs/2026-10-12-send-quotas.md#cron-깨우기의-공평성)).
Cron runs each minute to remove the text of kept early DMs after 15 minutes, remove expired OAuth states in batches (`oauth_state_cleanup`, [spec](docs/specs/2026-09-29-instagram-public-access.md)), recover stale sends, refresh due tokens, check due connections' webhook subscriptions (`subscription_check`, even while sending is off), link kept early DMs and then resume due delayed flow runs (both even while sending is off, and in that order so an in-time reply is linked before its wait times out), and repair missed notifications or delayed retries; while sending is on, its last send step `campaign_start` starts due campaign approvals' runs ([spec](docs/specs/2026-10-27-campaign-runs.md)).
`TOKEN_ENCRYPTION_KEY` decrypts workspace/account-bound AES-GCM credentials; a valid per-account token and `send_enabled` are required in addition to the global switch.
The adapter prioritizes manual replies, then pending follow confirmations, and rechecks the rule, claim, connection, token version, cooldown and 24-hour window immediately before a normal DM POST.
There is no atomic transaction spanning PostgreSQL and Meta: a setting change after the final guard cannot recall an in-flight request.

**Dashboard and API** (`src/app/`, `public/app/`):
The Worker delegates `/api/*` to `appApi` in `src/app/api.ts`; the modules beside it own auth, OAuth, token refresh, secrets, contacts, fields, inbox, handoff, manual replies and consent.
Every non-GET `/api/*` request must be same-origin (`requireSameOrigin`); routes other than `/api/auth/*` require a verified session and scope data to the caller's workspace, and each one names its least role through `workspaceFor` ([roles](docs/specs/2026-09-30-workspace-roles.md)).
Request limits, the static client and the browser session/auth rules are in [feature invariants](docs/agents/feature-invariants.md#dashboard-channel-and-token).

## Rules for every change

- None of the stored contact, segment, field or inbox records proves messaging consent or delivery eligibility, and none of these features grants DELETE privileges to server roles.
- Every runtime log goes through `logOperation` in `src/app/operations-log.ts` ([Operations health](docs/agents/feature-invariants.md#operations-health)).
- Every automated send path (`src/instagram/*-worker.ts`, `node-delivery.ts`, `channel-consent.ts`, the claim queries in `store.ts`, and the queue and cron steps in `src/cloudflare/index.ts`) rechecks the [contact pause](docs/agents/feature-invariants.md#per-contact-automation-pause) and [service revokes](docs/agents/feature-invariants.md#channel-consent) after the claim and before the POST.
- A new table or column must be registered wherever the data paths enumerate them; each owner below states its exact rule:
  - a connection-scoped table: `public.delete_connection_data` and `public.delete_workspace_data`; a person-keyed table: also `public.delete_person_data`; a workspace-scoped table: `public.delete_workspace_data` ([deletion](docs/agents/feature-invariants.md#connection-data-deletion));
  - every public table: `EXPORTED_TABLES` or `EXCLUDED_TABLES` in `src/app/workspace-export.ts` ([Workspace export](docs/agents/feature-invariants.md#workspace-export));
  - workspace rows that do not require an `instagram_connections` row: both workspace move checks ([Workspace roles](docs/agents/feature-invariants.md#workspace-roles));
  - a server-written `workspaces` column: the grants in `deploy/supabase-access.sql` and `deploy/init-app-user.sh` ([Plan entitlements](docs/agents/feature-invariants.md#plan-entitlements)).

## Feature invariants

[docs/agents/feature-invariants.md](docs/agents/feature-invariants.md) holds the per-feature invariants; read the section for the code you touch before editing it.
Write new or changed per-feature invariants there, not here: this file keeps only commands, architecture and the rules for every change.

- [Channel contract](docs/agents/feature-invariants.md#channel-contract): `src/channels/`, `src/instagram/channel-adapter.ts`
- [API request limits](docs/agents/feature-invariants.md#api-request-limits-and-static-client) and [session/auth client](docs/agents/feature-invariants.md#dashboard-session-and-auth-client): `src/app/api.ts`, `src/app/auth*.ts`, the session and API wrapper in `public/app/`
- [Follow flow](docs/agents/feature-invariants.md#follow-flow): `src/instagram/follow-*.ts`, `src/instagram/message-events.ts`, `src/instagram/confirmation-button.ts`
- [Token lifecycle](docs/agents/feature-invariants.md#token-lifecycle): `src/app/instagram-{token-refresh,reauth,deauthorization,subscription-check}.ts`
- [Campaigns](docs/agents/feature-invariants.md#campaigns): `src/app/campaign-*.ts`, `src/instagram/campaign-delivery-worker.ts`, `public/app/campaign-drafts.js`
- [Contacts and segments](docs/agents/feature-invariants.md#contacts-and-segments): `src/app/contact*.ts`, `src/app/segment-snapshots.ts`, `public/app/{condition-tree-model,contact-*,segment-*}.js`
- [Inbox](docs/agents/feature-invariants.md#inbox): `src/app/inbox*.ts`, `src/instagram/inbox.ts`, `src/app/manual-replies.ts`, `src/app/reply-templates.ts`
- [Consent and flows](docs/agents/feature-invariants.md#consent-and-flows): `src/app/channel-consent.ts`, `src/app/flow*.ts`, `src/app/webhook*.ts`, flow runs in `src/instagram/store.ts`
- [Deletion, workspace and operations](docs/agents/feature-invariants.md#deletion-workspace-and-operations): `src/app/data-deletion.ts`, `src/app/workspace-*.ts`, `src/app/plans.ts`, `src/app/operations-*.ts`, the deletion functions in `db/schema.sql` and `db/migrations/`, `deploy/*.sql`
- [Reports](docs/agents/feature-invariants.md#reports): `src/app/*-reports.ts`, `public/app/*-reports.js`

## Deployment

The primary target is Cloudflare Workers + Queues + Supabase PostgreSQL through Hyperdrive; `wrangler.json` pins the personal account and Hyperdrive ID.
`SEND_ENABLED` must equal `true` to send, and the committed configuration keeps it `false`.
Hyperdrive query caching MUST be disabled to keep authorization and active-state reads fresh.
The Worker serves both workers.dev and `auto-chat.donminzzi.kr` with both webhook secrets registered; incorrect verification tokens and unsigned requests return 403.
Public GET/HEAD routes `/privacy`, `/data-deletion` and `/service` serve static Korean pages from `src/cloudflare/public-pages.ts` without secrets or database bindings; no automatic or unauthenticated deletion API exists.
Wrangler serves `public/` as static assets before Worker routing; keep only public files in that directory.
The `/app/*` files are not versioned, so `public/_headers` sends `Cache-Control: no-cache` (revalidate every load, never stale after a deploy); `_headers` does not apply to Worker responses, which set their own headers.
Generated provisioning credentials stay in the ignored `deploy/secrets/` directory; never log or commit them.

**Database changes**: add a numbered file under `db/migrations/`, update `db/schema.sql`, and include the migration in `deploy/migrate-multi-user.sql`.
That runner owns the transaction for migrations 003 onward plus `deploy/supabase-access.sql`, stops on the first error and rolls back; never apply those migration files individually.
Run it with an administrator connection (`psql -f deploy/migrate-multi-user.sql`) before deploying code that reads the new schema.
A fresh dedicated Supabase project gets `db/schema.sql` and `deploy/supabase-access.sql` in a single administrator transaction.
The access script enables RLS, revokes API-role table access, and grants only SELECT/INSERT/UPDATE to the server role and the Compose `automations_app` role when present; both must be unprivileged, have no memberships, and own no objects.
It also revokes PUBLIC schema CREATE, so do not apply it to a shared project without reviewing that impact.
Assign a workspace to a confirmed user with `deploy/assign-workspace-owner.sql`; never claim legacy data automatically by email.
Whole-workspace deletion follows `docs/specs/2026-09-30-workspace-data-deletion.md`.

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
This file records no deployment status on purpose; read these owners before claiming anything is deployed or verified:

- Production deployments, migrations and live Meta checks: `docs/notes/2026-09-26-cloudflare-runbook.md`, `docs/notes/2026-09-26-multi-user-cutover.md`, and the latest production note (currently `docs/notes/2026-09-29-issue13-production-verification.md`).
- Per-issue code, local, provider and production state: `docs/notes/2026-09-27-manychat-acceptance-matrix.md` and the verification notes it links.
- `grep -l '^## 운영 ' docs/specs/*.md` lists the specs with a dedicated status section (`## 운영 상태`, `## 운영 확인` or `## 운영 적용`); `docs/specs/2026-09-25-messaging-automation-platform.md` also records live and production results in its current-state paragraph. A spec that says deployment was out of scope describes its PR, not the current production state.
