# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A self-hosted messaging automation service positioned against ManyChat's paid features.
The only channel implemented so far is Instagram: comment webhooks are stored in PostgreSQL, keyword rules queue a private reply into an outbox, and a separate worker sends it through the Meta Graph API.
Product scope, non-goals and the phased roadmap live in `docs/specs/` and `docs/plans/`; README.md, the specs, plans and notes are written in Korean.

## Commands

Node.js >= 24 runs the TypeScript sources directly (native type stripping); there is no build step.
Use `corepack pnpm` (pnpm 10, pinned by `packageManager`).

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check-types          # tsc --noEmit, the only compile check
corepack pnpm test                 # unit tests, no DB needed
TEST_DATABASE_URL=postgres://postgres:local-dev@127.0.0.1:5433/automations_test corepack pnpm test:db
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
A rule matches by case-insensitive substring of its `keyword`, one rule per `(connection_id, media_id)`.

**Worker** (`worker-main.ts` → `reply-worker.ts` → a `PrivateReplyTransport`):
Each worker process serves exactly one connection (`META_INSTAGRAM_CONNECTION_ID`).
`processNextPrivateReply` claims a `pending` outbox row with `FOR UPDATE SKIP LOCKED` and a fresh `attempt_id`; every later state change is conditional on `status = 'sending' AND attempt_id = $n` and throws if the claim was lost.
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

`Dockerfile` runs the sources as the non-root `node` user with production dependencies only.
`compose.yaml` starts PostgreSQL and ingress by default; profiles `send` and `public` enable the real worker and Caddy proxy respectively.
Use `--env-file deploy/runtime.env` explicitly; `deploy/environment.example` is the empty template.
Never print resolved configuration with secrets; use `config --quiet`.
Fresh DB volumes initialize the current schema and a separate DML-only `automations_app` role.
Existing volumes require explicit migrations as described in `docs/notes/2026-09-26-deployment-runbook.md`.
Deployment smoke checks must use synthetic credentials, a separate Compose project and loopback ports, with no live Meta calls.
`.github/workflows/ci.yaml` runs type checks, unit and PostgreSQL integration tests, Trunk, and a container deployment smoke check on PRs and pushes to `main`.
The deployment job verifies signed-event persistence, replay protection, restricted DB privileges and HTTPS with a local Caddy CA; it never starts a sending worker.

## Verification boundaries

What has and has not been proven against real Meta accounts is tracked in README.md and `docs/notes/2026-09-25-meta-permissions-and-worker.md`.
Type checks and mocked Graph tests do not prove live permissions or a live private-reply send; do not describe them as if they did.
