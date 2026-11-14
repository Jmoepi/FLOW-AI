# Local development stack (Docker or embedded Postgres, no Supabase)

Everything here runs on your machine. Nothing contacts Supabase or any remote database, and no secret is stored in a tracked file. Use either Docker Desktop (`pnpm db:up`) or, without Docker, the embedded Postgres (`pnpm db:up:native`, data in the gitignored `.local-pg/`). Both use port 54329 and the same `.secrets/local-db.env`, so run only one at a time. Step-by-step instructions for the Docker-free path are in the README section "Run locally without Docker".

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
pnpm db:up                   # or, without Docker: pnpm db:up:native
pnpm db:migrate --local
pnpm db:seed:demo            # demo business, 3 suppliers, 5 invoices, owner login; re-running is a no-op

# 2. Payment guard on 127.0.0.1:4002 (kill switch OFF: no payment can execute)
pnpm guard:dev

# 3. Web app on http://127.0.0.1:3000
pnpm dev:web
```
## Owner login and password reset
The local owner password is the `DEMO_OWNER_PASSWORD` line in `.secrets/web-owner.env`. It only works against the local database. The Supabase owner is a separate account with its own password in `.secrets/web-owner.supabase.env` (used with `pnpm dev:web -- --supabase`); the two files do not match each other. `pnpm db:seed:demo` never changes an existing owner's password, so if the file was regenerated or the database re-created, the file can be stale. Fix it with:
```bash
pnpm db:reset-owner-password -- --local        # new random password -> .secrets/web-owner.env (path printed, password never printed)
```
This also clears the owner's account lock, sessions and login-attempt counters. The Supabase variant (`-- --supabase --allow-remote`) writes `.secrets/web-owner.supabase.env` and is refused without `--allow-remote`. Use http://127.0.0.1:3000 (not `localhost`): the login checks the Origin header.
Open http://127.0.0.1:3000/login. Email: `owner@demo.flow-ai.test` (or the value in `.secrets/web-owner.env`). Password: the `DEMO_OWNER_PASSWORD` line in `.secrets/web-owner.env`.

Run the agent (guard must be running; deterministic mode needs no key): `pnpm agent:run` (add `-- --record` to write a transcript to `docs/demo/`, `-- --probe-ineligible` to see the guard block an invoice). Then open http://127.0.0.1:3000/agent. See [m5-notes.md](m5-notes.md).
`pnpm guard:dev -- --enable-execution` turns the kill switch on (real Testnet RLUSD payments become possible). Do not use it for click-through demos.

## Check it
```bash
curl http://127.0.0.1:4002/readyz      # db, ledger, audit_chain should be "ok"
pnpm db:migrate status --local          # applied: 6, pending: none
```
With the kill switch off, the guard's eligibility preview (`GET /internal/invoices/:id/eligibility`, bearer token from `.secrets/guard-dev.env`) always lists `EXECUTION_DISABLED`; lowering the per-payment cap in the policy page adds `PAYMENT_LIMIT_EXCEEDED` for invoices above the new cap.

## Stop
Press Ctrl+C in the guard and web terminals. The database keeps running; `pnpm db:down` stops the Docker one (data stays in the Docker volume); `pnpm db:down:native` stops the embedded one (data stays in `.local-pg/`; `pnpm db:reset:native -- --yes` wipes it). Database tests without Docker: `FLOW_TEST_DB=native pnpm test:db`.
