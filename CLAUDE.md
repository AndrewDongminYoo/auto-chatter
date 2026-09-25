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

- `pending` + `next_attempt_at` pushed 1 minute: verification failed, or `PreSendVerificationError` with `retry`.
- `blocked` + `failure_code`: the policy rejected it, or `PreSendVerificationError` with `block`.
- `unknown`: `send()` threw anything else, or a `sending` row outlived 10 minutes (`recoverStalePrivateReplies`). These are never retried automatically, to avoid double-sending.
- `sent` + `provider_message_id`.

A transport may throw `PreSendVerificationError` only before it issues the provider send request; any other error from `send()` is treated as an ambiguous outcome.

**Transports** (selected by `META_LOGIN_MODE`, default `facebook`; the configured Meta app uses `instagram`):

- `instagram-login-private-reply.ts`: Instagram user token against `graph.instagram.com`.
- `facebook-private-reply.ts`: Facebook Login path; additionally checks token scopes, the Page↔Instagram link and the `MESSAGING` task.

Both accept an injectable `fetchImpl`, which is how the unit tests mock Graph responses.
`worker-main.ts` only surfaces error messages that start with `Invalid Meta`/`Meta Graph` (or the account ID error); anything else prints a generic message so tokens never reach logs.

## Verification boundaries

What has and has not been proven against real Meta accounts is tracked in README.md and `docs/notes/2026-09-25-meta-permissions-and-worker.md`.
Type checks and mocked Graph tests do not prove live permissions or a live private-reply send; do not describe them as if they did.
