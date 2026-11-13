# Local development stack (Docker Postgres, no Supabase)

Everything here runs on your machine. Nothing contacts Supabase or any remote database, and no secret is stored in a tracked file. Docker Desktop must be running.

## Files (all gitignored, created by the scripts, never printed)
| File | Created by | Holds |
|---|---|---|
| `.secrets/local-db.env` | `pnpm db:up` | Random passwords for the local `postgres`, `flow_guard` and `flow_web` roles. The roles' passwords are set in the Docker database by `db:up`. |
| `.secrets/web-owner.env` | `pnpm db:seed:demo` | Demo owner email and password (the login for the web app). |
| `.secrets/guard-dev.env` | `pnpm guard:dev` | Random bearer token for the guard's `/internal/*` API (only needed for curl checks). |
| `.secrets/testnet-wallets.json` | `pnpm setup:testnet-accounts` | Testnet wallet seeds (needed by the guard launcher to start). |

The launchers assemble database URLs, the session settings and the other variables in memory and hand them to the child process through an allowlisted environment. You do not need to put anything in `.env` for the local stack. A `DATABASE_URL` in `.env` (for example a Supabase one) is ignored when you pass `--local` to `db:migrate`.

## Start (three terminals, from the repo root)
```bash
# 1. Database (idempotent) and migrations, local only
pnpm db:up
pnpm db:migrate --local
pnpm db:seed:demo            # demo business, 3 suppliers, 5 invoices, owner login; re-running is a no-op

# 2. Payment guard on 127.0.0.1:4002 (kill switch OFF: no payment can execute)
pnpm guard:dev

# 3. Web app on http://127.0.0.1:3000
pnpm dev:web
```
Open http://127.0.0.1:3000/login. Email: `owner@demo.flow-ai.test` (or the value in `.secrets/web-owner.env`). Password: the `DEMO_OWNER_PASSWORD` line in `.secrets/web-owner.env`.

`pnpm guard:dev -- --enable-execution` turns the kill switch on (real Testnet RLUSD payments become possible). Do not use it for click-through demos.

## Check it
```bash
curl http://127.0.0.1:4002/readyz      # db, ledger, audit_chain should be "ok"
pnpm db:migrate status --local          # applied: 6, pending: none
```
With the kill switch off, the guard's eligibility preview (`GET /internal/invoices/:id/eligibility`, bearer token from `.secrets/guard-dev.env`) always lists `EXECUTION_DISABLED`; lowering the per-payment cap in the policy page adds `PAYMENT_LIMIT_EXCEEDED` for invoices above the new cap.

## Stop
Press Ctrl+C in the guard and web terminals. The database keeps running; `pnpm db:down` stops it (data stays in the Docker volume).
