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
- Package scripts do not load `.env`; export variables into the shell first (`.env.example` lists the Meta ones).
- Trunk (`.trunk/trunk.yaml`) runs prettier, markdownlint, yamllint, osv-scanner and trufflehog. The pre-commit format hook is disabled and `trunk check` runs on pre-push, so run `trunk fmt` yourself before committing.

## Code conventions forced by the runtime

- Relative imports carry the `.ts` extension (`./store.ts`); `tsconfig.json` uses `NodeNext` with `allowImportingTsExtensions`.
- Only erasable TypeScript syntax works under Node's type stripping: no `enum`, `namespace`, or constructor parameter properties.
- The only runtime dependency is `pg`. HTTP uses `node:http`, tests use `node:test` + `node:assert/strict`, and Graph calls use global `fetch`.

## Architecture

Two processes share one PostgreSQL database (`db/schema.sql`; existing databases also need `db/migrations/*.sql` applied in order).

**Ingress** (`main.ts` → `http.ts` → `webhook.ts` → `store.ts`):
`GET/POST /webhooks/instagram` verifies the subscription challenge and the `x-hub-signature-256` HMAC over the raw body, parses comment events, and `ingestComments` writes them in one transaction.
Only comments on an `active` `instagram_connections` row are stored.
Deduplication is enforced by unique constraints, not application logic: one event per `(connection_id, comment_id)` and one outbox row per `(connection_id, media_id, sender_id)`, both inserted with `ON CONFLICT DO NOTHING`.
A rule matches normalized keywords with `contains`, `exact`, or `all` mode; excluded substrings take precedence.
One rule exists per `(connection_id, media_id)`; empty `keywords` falls back to the legacy `keyword`.
Apply `003_comment_rule_matching.sql` before deploying the expanded rule reader to an existing database.

**Worker** (`worker-main.ts` → `reply-worker.ts` → a `PrivateReplyTransport`):
The Node worker serves one active, send-enabled, environment-managed connection (`META_INSTAGRAM_CONNECTION_ID`, with no encrypted OAuth credential); the Cloudflare adapter reads encrypted credentials and send switches per queued connection from the database.
`processNextPrivateReply` claims a `pending` outbox row with `FOR UPDATE SKIP LOCKED` and a fresh `attempt_id`; every later state change is conditional on `status = 'sending' AND attempt_id = $n` and throws if the claim was lost.
In Instagram Login mode, each Node polling cycle processes a confirmed follow reply and a private reply, with startup and periodic stale-claim recovery scoped to that connection.
Follow delivery uses the environment account binding instead of the Cloudflare stored-token check; Cloudflare retains its encrypted-token and expiry requirements.
Both Node send paths recheck the claim, connection, rule, send switch and environment ownership immediately before POST; follow sends also recheck the 24-hour window.
OAuth-managed connections must use the Cloudflare adapter, and Facebook Login blocks follow-gated rules before the first DM (`follow_requires_instagram_login`).
The sequence is: transport `verify()` (read-only Graph checks) → `evaluatePrivateReply` in `reply-policy.ts` (connection active, authorization, media ownership, not own comment, 7-day comment window) → transport `send()`.
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

## Deployment

The primary deployment target is Cloudflare Workers + Queues + Supabase PostgreSQL through Hyperdrive.
`src/cloudflare/index.ts` reuses ingestion and the single-row worker; it does not run the Node polling loop.
Queue messages contain only a connection ID; database status remains authoritative.
Each notification processes at most one row, then wakes remaining due work only for that connection.
Webhook notifications are scoped to the account IDs in the received events; only cron discovers due work globally.
Cron runs each minute to recover stale sends and repair missed notifications or delayed retries.
The adapter supports multiple Instagram Login connections.
`TOKEN_ENCRYPTION_KEY` decrypts workspace/account-bound AES-GCM credentials; the Node worker retains its explicit environment-token path.
A valid per-account token and `send_enabled` are required in addition to the global switch.
The adapter prioritizes pending follow confirmations, and rechecks the rule, claim, connection, token version, cooldown and 24-hour window immediately before a normal DM POST.
There is no atomic transaction spanning PostgreSQL and Meta: a setting change after the final guard cannot recall an in-flight request.
`instagram_follow_conversations` snapshots the first reply configuration; a nonfollower response returns to waiting, a follower response completes, and ambiguous sends remain unknown.
A missing recipient ID after a successful first DM records `follow_recipient_unavailable` without resending.
Inbound DM text is compared in memory and is not persisted; receipt IDs and timestamps deduplicate confirmation events.
`SEND_ENABLED` must equal `true` to send; the committed configuration keeps it `false` and pins the provisioned personal Cloudflare account and Hyperdrive ID.
The Worker is deployed on workers.dev with both webhook secrets registered; incorrect verification tokens and unsigned requests return 403.
Public GET/HEAD routes `/privacy`, `/data-deletion`, and `/service` serve static Korean privacy policy, manual deletion instructions, and service terms without accessing secrets or database bindings.
Their approved text lives in `src/cloudflare/public-pages.ts`; no automatic deletion or unauthenticated deletion API is provided.
Wrangler serves `public/` as static assets before Worker routing; keep only public files in that directory.
The generated app icon at `public/icons/auto-chatter.png` appears in the public page header and favicon.
A dashboard webhook test returned 200 with no logged errors or exceptions.
That test ran before an Instagram connection was registered and did not persist a comment.
The production database has one active receive-only connection and no reply rules.
A real test comment was persisted on 2026-09-26; live private-reply sending remains unverified.
Generated provisioning credentials stay in the ignored `deploy/secrets/` directory; never log or commit them.
Hyperdrive query caching MUST be disabled to keep authorization and active-state reads fresh.
Apply `db/schema.sql` and `deploy/supabase-access.sql` in a single administrator transaction on a dedicated Supabase project.
The access script enables RLS, revokes API-role table access, and grants only SELECT/INSERT/UPDATE to the server role and the existing Compose `automations_app` role when present.
Both server roles must be unprivileged, have no memberships, and own no database objects.
It also revokes PUBLIC schema CREATE, so do not apply it to a shared project without reviewing that impact.
`test:cloudflare` requires a disposable local PostgreSQL cluster: it creates roles and modifies public schema grants in `automations_test`.
The `.mjs` workerd harness avoids Miniflare's incomplete published TypeScript declarations; application TypeScript remains strict.
Wrangler and Miniflare are pinned to the tested v4 runtime pair; upgrade them together and run `test:cloudflare`.
Never enable sends, create cloud resources, or publish as part of tests.
See `docs/notes/2026-09-26-cloudflare-runbook.md` for the deployed baseline and `docs/notes/2026-09-26-multi-user-cutover.md` for the new migration and configuration procedure.
This multi-user implementation is local until that cutover is explicitly performed.
Run `psql -f deploy/migrate-multi-user.sql` with an administrator connection before deploying this code.
This runner owns the transaction for migrations 003–006 and the access script, stops on the first error, and rolls back on failure.
Do not apply these migration files individually without that transaction.
Assign the existing workspace to a confirmed operator with `deploy/assign-workspace-owner.sql`; never claim legacy data automatically by email.
Token renewal currently requires reconnecting the Instagram account before the displayed expiry.

`Dockerfile` runs the sources as the non-root `node` user with production dependencies only.
`compose.yaml` starts PostgreSQL and ingress by default; profiles `send` and `public` enable the real worker and Caddy proxy respectively.
Use `--env-file deploy/runtime.env` explicitly; `deploy/environment.example` is the empty template.
Never print resolved configuration with secrets; use `config --quiet`.
Fresh DB volumes initialize the current schema and a separate DML-only `automations_app` role.
Existing volumes require explicit migrations as described in `docs/notes/2026-09-26-deployment-runbook.md`.
Deployment smoke checks must use synthetic credentials, a separate Compose project and loopback ports, with no live Meta calls.
`.github/workflows/ci.yaml` runs type checks, unit and PostgreSQL integration tests, a local workerd/Hyperdrive/Queue smoke check, Trunk, and a container deployment smoke check on PRs and pushes to `main`.
The deployment job verifies signed-event persistence, replay protection, restricted DB privileges and HTTPS with a local Caddy CA; it never starts a sending worker.

## Verification boundaries

What has and has not been proven against real Meta accounts is tracked in README.md and `docs/notes/2026-09-25-meta-permissions-and-worker.md`.
Type checks and mocked Graph tests do not prove live permissions or a live private-reply send; do not describe them as if they did.
