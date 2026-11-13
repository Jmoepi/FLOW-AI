# M3 notes: payment guard with persistence

Scope: `apps/payment-guard` (Fastify, internal API), `packages/database` (Postgres migrations and repositories), guard signer, reconciler, sweeper, balance poller, dev launcher and the end-to-end script. Local Docker Postgres only. No Supabase project was created or contacted (see `docs/supabase-runbook.md` for later).

## The one real Testnet payment (authorised budget: exactly one, 1 RLUSD)

Made through the guard HTTP path (`POST /internal/payment-requests`) by `pnpm m3:e2e -- --confirm-real-payment`. It must not be repeated. The script refuses to run again because `.secrets/m3-e2e.json` (gitignored, ids and hashes only) already exists.

| Item | Value |
|---|---|
| Transaction hash | `87165684D8BF899BB5285141C4516ED40FB6E39DBC470E54A90E61F55A427B0C` |
| Explorer | https://testnet.xrpl.org/transactions/87165684D8BF899BB5285141C4516ED40FB6E39DBC470E54A90E61F55A427B0C |
| Ledger index | 22280843 (validated) |
| Result | `tesSUCCESS`, fee 12 drops |
| `delivered_amount` | `1` of currency `524C555344000000000000000000000000000000`, issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` (the configured RLUSD pair), checked independently with a ledger `tx` lookup |
| Route | treasury `rHwNC93iYF7ZcSpZJbVZiwLmpiCKauoHuo` to cross-border supplier `rpc4DFfxB6aXkbEPJTAGXLG4oZQuWpTXnT` |
| Treasury RLUSD | 6 before, 5 after (delta exactly -1). The script asserted `balance - 1 >= 5` before submitting. |
| Supplier RLUSD | 1 before, 2 after (delta exactly +1) |
| Guard payment id | `d8d2ee64-f27a-4979-9cc4-700d91b898f7` |
| Pending / retries | None. The response was final (`validated`); no reconcile or retry was needed. |

### Database evidence (throwaway local database `flow_test_da799298b89b`, admin pool, statuses and counts only)

- Payment: `validated`, `result_code` `tesSUCCESS`, `delivered_amount` 1, `signed_blob` NULL (cleared after the final outcome, PG-10).
- Reservation: `committed`; held total 1. Invoice `INV-DEMO-001`: `paid`.
- Audit events for the payment, in order: `payment.requested`, `payment.reserved`, `payment.signed`, `payment.submit_ack`, `payment.validated`. Whole business: 6 audit rows, `verify_audit_chain` returned true.
- Table counts: payments 2 (one blocked, one validated), reservations 1, invoices 2, suppliers 1.

### Duplicate request

A second `POST` with the same idempotency key and body returned HTTP 200 with the identical stored result (same `payment_id` and same `tx_hash`). The treasury balance did not change again, so no second payment exists.

### Blocked request (submitted nothing)

`INV-DEMO-OVERCAP` (5 RLUSD) against a per-payment cap of 2 returned HTTP 200, `status` `blocked`, `failure_code` `PAYMENT_LIMIT_EXCEEDED`, `tx_hash` null. DB: a `blocked` payment row, no reservation, invoice marked `blocked`; treasury balance unchanged. `pnpm m3:e2e -- --blocked-only` was also run first, in a mode where the payable invoice is never seeded, so nothing could be sent (it passed with the same result).

## What was built in the final step (FEAT-006)

- `scripts/lib/guard-launcher.ts`: starts the guard as a child process (`process.execPath --import tsx apps/payment-guard/src/main.ts`, argument array, `shell:false`). The signer seed is read from `.secrets` in the launcher (`loadGuardSignerSeed` in `scripts/lib/common.ts`), passed only through the child's environment in memory, never printed or written. The agent token is 32 random bytes per launch, in memory only. `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are removed from the child environment.
- `scripts/guard-dev.ts` (`pnpm guard:dev`): runs the guard against the local database `flow_ai` on port 4002.
- `scripts/m3-e2e.ts` (`pnpm m3:e2e`): strict argument parser (exactly one of `--blocked-only` or `--confirm-real-payment`), creates a fresh throwaway database with the real least-privilege `flow_guard` role, seeds one business and invoices, starts the guard, runs the blocked demo, the single real payment, independent ledger proof, the duplicate request and the database evidence. The blocked-only run drops its database; the real run keeps it so a pending payment could still be reconciled.
- Small helper change: `seedInvoice` in `packages/database/src/testing/scenario.ts` accepts an optional `invoiceNumber`.

## Verification (final tree)

| Check | Result |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS: contracts 49, xrpl-adapter 62, policy-engine 172, database 18, payment-guard 118 (419 total) |
| `pnpm test:db` (Docker Postgres) | PASS: database 37 (2 files), payment-guard 61 (4 files) (98 total) |
| `pnpm lint` | PASS, 0 warnings |
| `pnpm secret-scan` | PASS |
| `pnpm audit` (`--prod`) | No known vulnerabilities found |
| `pnpm preflight` | PASS (treasury 5 RLUSD, trust lines present) |

Docker Desktop was already running; no Docker problem occurred.

## Honest caveats

- The demo business is created with the schema defaults, which are already `ZA` and `Africa/Johannesburg` (migration 0002), so the daily-cap day follows South African time. (Corrected in the Stage 2 review pass: this note previously said the demo used a non-matching default.)
- The guard ran as a local child process on loopback with an env-seed signer (spec 10.8 MVP default). There is no HTTPS, no deployed host and no regular-key backstop yet (M7).
- Windows: `child.kill` ends the guard without running its graceful shutdown handlers, so in-flight work is not drained on stop. The e2e run had nothing in flight at that point.
- `.secrets/m3-e2e.json` is a local single-use guard, not a distributed lock. Deleting it would allow another real payment; do not delete it.
- Test counts are from this run. `docs/m2-notes.md` is a historical record and still says 169; the README row for M2 now says 172.
- Not verified: behaviour against a hosted Supabase Postgres (not contacted). The runbook lists what to check there.
- The blocked invoice shows status `blocked` in the demo database; whether the owner UI should show that status is an M4 question.

## Spec v3.5 clarifications made (minimal, no renumbering)

1. 5A: one implementation note that no `SIGNING` state exists; crash windows map to existing states.
2. 8.1 `payments`: additive columns `request_hash`, `signed_blob`, `first_ledger_sequence`, `previous_payment_id`, `business_date`.
3. 8.1 `audit_events`: additive columns `seq`, `prev_hash`, `row_hash`, `request_id`.
4. 9.2: HTTP status semantics (200 stored or blocked, 202 in flight, 400, 409 key reuse, 401, 413, 415, 429) and the strict request body.

`Flow_AI_MVP_README_v3.0.md` was not touched.

## Stage 2 review fixes (M-1, M-2 and cheap Lows)
Fixes for the two Medium findings in the M3 review. Local Docker Postgres only; no remote database was contacted and no transaction was submitted.
- M-1, audit chain verify job (AL-3): `apps/payment-guard/src/jobs/audit-verify.ts`. Runs at startup before the guard listens, then every `AUDIT_VERIFY_INTERVAL_SECONDS` (default 300, range 10 to 86400). It runs `verify_audit_chain` for the pinned business, or every business when none is pinned, and records `unverified | ok | broken | error` with a timestamp. Logs go through the redacting logger and carry counts and a random `break_id` only (no business ids, rows or hashes).
- On a detected break the state is `broken` and execution is blocked fail closed, using the kill switch path (13.1C): the policy engine sees a non-`true` switch value (decision `EXECUTION_DISABLED`, nothing reserved or signed), and the executor cancels any payment that was reserved but not yet signed. The block stays until the operator sets `AUDIT_BREAK_ACK` to the `break_id` from the `audit.chain_broken` log line. The variable is re-read on every call (no restart), is not readable by the agent, and only the exact id of the current break counts; a later new break needs a new acknowledgement. After acknowledgement the state still reads `broken` (visible) and the job keeps verifying. An unreadable database is reported as `error`, logged, and is not treated as a break; it never clears an existing break.
- `/readyz` (public) reports `status` (`ok`, `degraded` with 503 while blocked, `unavailable`), `db`, `ledger`, `audit_chain` and `audit_verified_at`. `/internal/status` also reports `audit_chain` and shows the kill switch as `disabled` while blocked.
- The break state lives in process memory. A restart re-verifies at startup, so an unfixed break blocks again, with a new `break_id`.
- Chosen design: the acknowledgement is an operator-controlled environment value rather than an HTTP endpoint, so the agent token (which could otherwise self-acknowledge) cannot lift the block. A signed owner action in the web app is an M4 option.
- Tests: `test/audit-verify.test.ts` (unit, mocked database), `test/audit-verify.db.test.ts` (a row is tampered through a superuser connection in the throwaway database via `tamperAuditRow`; the job detects it, readiness degrades, a request is blocked, a pre-reserved payment is cancelled unsigned, an exact `break_id` unblocks).
- M-2, tenant pin: `GUARD_BUSINESS_ID` is now required (valid UUID) when `NODE_ENV=production` or when `GUARD_HOST` is not a loopback address (`127.0.0.1`, `::1`, `localhost`). Startup fails closed with a `ConfigError` that names the variable only. It stays optional for local and test use. Tests in `test/config.test.ts`.
- Lows: L-2 fixed (`/readyz` no longer reports whether the kill switch variable is set). L-3 fixed (the launcher builds the guard environment from an allowlist). L-5 fixed (timezone note corrected, README test count updated). L-1 (database trigger tying payments to invoice and supplier) and L-4 (TLS and bind checks) are deferred; see `docs/security-review.md`.
- Not verified here: the launcher allowlist change was checked by typecheck and lint only; `pnpm guard:dev` and `pnpm m3:e2e` were not run because they contact Testnet and the latter spends RLUSD. Acknowledgement by changing the environment of a running process depends on how the host sets variables (it is read from `process.env`); in practice set it and restart if the host cannot change a live environment.
