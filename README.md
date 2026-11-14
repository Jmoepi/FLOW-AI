# Flow AI

Flow AI is an autonomous AI agent that pays supplier invoices in RLUSD on XRPL Testnet, within limits the business owner sets and an independent payment guard enforces. The target user is an importer who pays both cross-border and domestic suppliers. The agent chooses which eligible invoice to process next. The guard decides whether the payment is allowed and signs it only when every rule passes.

This is a hackathon MVP (Agentic Finance track). It runs on XRPL Testnet only, is not production software, and is not financial advice.

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 | Preflight: repo, strict TypeScript, env template, secret scan, Testnet accounts, trust lines | Done. RLUSD claimed; `pnpm preflight` passes (see `docs/m0-notes.md`) |
| M1 | One real RLUSD payment from a script | Done. 2 validated `tesSUCCESS` payments of 1 RLUSD (cross-border and domestic suppliers) with exact balance deltas; see `docs/m1-notes.md` |
| M2 | Pure policy engine | Done. 172 tests (169 at M2, plus 3 added by the F-14 review fix; see `docs/m2-notes.md`) |
| M3 | Payment guard with persistence | Done locally (Docker Postgres). One real 1 RLUSD payment made through the guard (validated `tesSUCCESS`, hash `87165684D8BF899BB5285141C4516ED40FB6E39DBC470E54A90E61F55A427B0C`), plus a blocked request and a duplicate request. Follow-up Medium findings M-1 (audit-chain verify job) and M-2 (`GUARD_BUSINESS_ID` required in production) are fixed. Tests at the current HEAD (counts include M4 work): 567 unit in `pnpm test` (contracts 67, xrpl-adapter 62, policy-engine 172, database 18, payment-guard 133, web 115) and 160 db in `pnpm test:db` (database 51, web 47, payment-guard 62); see `docs/m3-notes.md`. Migrations 0001 to 0008 are also applied to the owner's Supabase project and smoke-tested there (see `docs/supabase-runbook.md`) |
| M4 | Owner policy API and page, audit events | Done locally (Docker Postgres, no Supabase). Owner login, policy page with confirm and conflict handling, suppliers and audit pages, nonce CSP, same-transaction audit events, and a proof that lowering the cap blocks the next payment request. Tests: 567 unit in `pnpm test` (contracts 67, xrpl-adapter 62, policy-engine 172, database 18, payment-guard 133, web 115) and 160 db in `pnpm test:db` (database 51, web 47, payment-guard 62); typecheck, lint, secret-scan and audit pass. Built to WCAG 2.2 AA guidelines, not formally audited; no real-browser test. See `docs/m4-notes.md` |
| M5 | Agent plus MCP tools | Done locally (Docker Postgres, no Supabase) in deterministic mode. Five MCP tools over stdio with strict schemas, bounded agent loop, run records written through the guard (migration 0007), owner-only Agent activity page. The LLM path (Anthropic adapter) is unit tested with fakes only: no API key, no model id, no live LLM call. The real agent payment is done: 1 RLUSD on XRPL Testnet, hash `237170E2F24845D2FB5FD920913971DFA53C567536C165501FA66C473EED352D` (treasury holds 16 RLUSD after it); a real blocked run and the paid run are recorded in `docs/demo/`, and the full paid flow is also verified against the fake XRPL gateway. The guard now derives the run outcome itself (migration 0008); MCP tool errors are text-only so they pass the SDK `outputSchema` check. Tests: 851 unit in `pnpm test` (contracts 87, xrpl-adapter 62, policy-engine 172, database 18, payment-guard 137, web 145, agent 230) and 224 db in `pnpm test:db` (database 70, web 48, agent 17, payment-guard 89); typecheck, lint, secret-scan and audit pass. See `docs/m5-notes.md` |
| M6 | Dashboard screens and deployed URL | Done locally. **Public URL pending hosting account.** Nothing is deployed. Overview (four CFO questions, balance freshness, agent panel, invoice queue, recent payments), invoices and payments lists and details (explorer link only for a validated hash), pause and emergency-stop explanation, Run treasury agent through a request queue, plain-language explanation of all 29 decision codes, loading, empty, error, blocked and not-found states, a Testnet banner on every page. Deploy-ready: `pnpm build`, `pnpm start:web`, `pnpm start:guard`, `pnpm start:agent`, health endpoints, a Dockerfile with three targets, `docs/deployment.md` (env matrix, secret rules, pre-deploy checklist), a trusted-proxy setting and `login_attempts` pruning. Finance operator and CSV export are cut. Tests: 1064 unit in `pnpm test` (contracts 87, xrpl-adapter 62, policy-engine 172, database 31, payment-guard 137, web 333, agent 242) and 250 db in `pnpm test:db` (database 80, web 60, payment-guard 93, agent 17); typecheck, lint (0 warnings), secret-scan, audit and `pnpm deploy:check` pass. Built to WCAG 2.2 AA guidelines, not formally audited; axe-core in jsdom only, no real-browser run, load and phone performance unmeasured. The AU-1 local-auth exception is carried forward (demo credentials only). Migrations 0009 and 0010 are applied locally, not yet to the owner's Supabase project. See `docs/m6-notes.md` and `docs/deployment.md` |
| M7 | Revocable regular-key backstop | Done on Testnet (fee only, no RLUSD moved). Owner scripts `pnpm owner:set-regular-key`, `pnpm owner:revoke-regular-key` (both dry run unless `--confirm`) and `pnpm owner:status-key`; the master seed is read only inside the script and the master key is never disabled (tested). The guard signs with `XRPL_REGULAR_KEY_SEED` (file `.secrets/guard-regular-key.env`, gitignored; `pnpm guard:dev -- --regular-key`) and a revoked key is refused by the ledger with `tefBAD_AUTH` (resolves spec 19.2). The payment fails with `SIGNING_KEY_REVOKED`, the guard turns degraded (`/readyz` 503) and blocks execution until a valid key is registered. The dashboard shows the key status read-only. Migrations 0009 to 0011 are applied to the owner's Supabase project (0001 to 0011). Multi-sign SignerList stays P2. Tests: 1124 unit in `pnpm test` (contracts 87, xrpl-adapter 75, policy-engine 172, database 31, payment-guard 171, web 346, agent 242) and 268 db in `pnpm test:db` (database 80, web 64, payment-guard 107, agent 17); typecheck, lint (0 warnings), secret-scan and audit pass. The M6 public URL is still pending hosting, and LLM mode is untested with a live key. See `docs/m7-notes.md` |
| M8 | Demo hardening, video, threat model | Not started |

The hosting decision for the deployed demo URL has not been made.

Security review of the M0 to M2 code: done (0 Critical, 1 High and 7 Medium defects fixed; the M3 precondition F-19 / PG-4 is now closed, see the M3 additions). See `docs/security-review.md`; rules for M3 and later are in `docs/secure-coding-standards.md`.

Demo budget: the RLUSD faucet gives 10 RLUSD per claim per 24 h per account, so demo fixtures are scaled to about 8 to 10 RLUSD, not the 1,000 RLUSD in spec 13A (see the scaled-fixture note there).

## Architecture

Three processes and four packages, each process with its own credentials.

```text
 owner --> web (dashboard + app API) --> payment-guard (policy + signer) --> XRPL Testnet
                                              ^
                    agent (LLM loop) --MCP tools
```

- `apps/web`: owner pages (login, overview, policy, suppliers, audit) and the authenticated app API. It uses its own `flow_web` database role and holds no signing key.
- `apps/payment-guard`: policy service and signer module. The only process that holds a signing key.
- `apps/agent`: agent loop and MCP tools. No database credential, no signer.
- Packages: `contracts` (shared Zod schemas), `database`, `xrpl-adapter`, `policy-engine`.

Trust boundary: the agent never holds keys or policy. It can only ask the guard to pay an invoice. The guard rebuilds the payment from its own canonical records, ignoring any amount or destination the model supplies, runs the policy checks, and signs only on an allow decision. The owner sets limits outside the agent. The enforcement is application-layer, not a trustless on-ledger restriction. The spec adds a revocable regular key (M7) as an on-ledger backstop that lets the owner cut off the guard's signing authority.

`packages/contracts`, `packages/policy-engine`, `packages/xrpl-adapter`, `packages/database` and `apps/payment-guard` are implemented (M0 to M3); `apps/web` is implemented (M4); `apps/agent` is implemented (M5, deterministic mode verified, LLM mode untested against a live model).

## Repo layout

```text
apps/            web, payment-guard, agent
packages/        contracts, database, xrpl-adapter, policy-engine
scripts/         secret-scan, setup-testnet-accounts, trust-lines, preflight, m1-send-rlusd, db-local, db-migrate, guard-dev, agent-run, agent-demo, m3-e2e, seed-demo-owner, dev-web, setup-hooks, git-hooks/
docs/            m0-notes.md, m1-notes.md, m2-notes.md, m3-notes.md, m4-notes.md, m5-notes.md, demo/ (recorded agent runs), local-dev.md, supabase-runbook.md, task1-changes.md, security-review.md, secure-coding-standards.md
Flow_AI_MVP_README_v3.5.md   spec of record
.env.example     environment template (placeholders only)
```

## Getting started

Prerequisites: Node 20.19 or newer (`engines`; M0 ran on Node 24.17.0) and pnpm 11.8.0 (`packageManager`).

```bash
pnpm install
cp .env.example .env        # fill in values; .env is gitignored
```

Local development: the full stack runs on a local Postgres, with Docker or without it (see "Run locally without Docker" below). With Docker, run `pnpm db:up`, `pnpm db:migrate -- --local`, `pnpm db:seed:demo`, then `pnpm guard:dev` and `pnpm dev:web`. See [docs/local-dev.md](docs/local-dev.md). Supabase: the migrations are applied to the owner's hosted project with verified TLS (`DATABASE_SSL_CA_FILE`), the app roles are created and checked (`pnpm db:supabase:roles`, `pnpm db:supabase:verify`), and `pnpm guard:dev -- --supabase`, `pnpm dev:web -- --supabase` and `pnpm db:seed:demo -- --supabase` run the stack against it. Exact steps and findings: [docs/supabase-runbook.md](docs/supabase-runbook.md).

## Run locally without Docker

Everything runs from the terminal on your machine with an embedded PostgreSQL 16 (the `embedded-postgres` dev dependency). No Docker, no Supabase, no remote database. It uses the same roles, database name, port and `.secrets/local-db.env` as the Docker path, so every command below is the same either way.

Prerequisites: Node 20.19 or newer (verified on 24.17.0), pnpm 11.8.0, Windows x64, Linux or macOS. Use a normal, non-elevated terminal: PostgreSQL refuses to run with administrator or root rights. First-time setup also needs `.secrets/testnet-wallets.json` (`pnpm setup:testnet-accounts`, Testnet only) because the guard launcher reads the signer from it.

```bash
pnpm install --frozen-lockfile
pnpm db:up:native            # first run creates .local-pg/ (gitignored); idempotent
pnpm db:migrate --local      # applies migrations 0001 to 0010; a second run is a no-op
pnpm db:seed:demo            # demo business, suppliers, invoices and the owner login
```

Then start the two servers, each in its own terminal (three terminals in total with this one):

```bash
pnpm guard:dev               # terminal 2: payment guard on http://127.0.0.1:4002 (kill switch OFF)
pnpm dev:web                 # terminal 3: web app on http://127.0.0.1:3000
```

Open http://127.0.0.1:3000/login. The owner email is `owner@demo.flow-ai.test` and the password is the `DEMO_OWNER_PASSWORD` line in `.secrets/web-owner.env` (open the file; it is never printed). Check the guard with `curl http://127.0.0.1:4002/readyz`.

Run the agent (guard must be running; deterministic mode needs no key): `pnpm agent:run`. For a recorded blocked request, `pnpm agent:demo -- --blocked-only` starts its own guard with execution disabled and submits nothing.

Tests: `pnpm test` needs no database. For the database tests against the embedded Postgres: `FLOW_TEST_DB=native pnpm test:db` (bash) or `$env:FLOW_TEST_DB="native"; pnpm test:db` (PowerShell). The variable only changes the hint shown when the database is unreachable.

Stop: Ctrl+C in the guard and web terminals, then `pnpm db:down:native`. Data stays in `.local-pg/` and persists across restarts. `pnpm db:status:native` shows whether it is up. To wipe all native local data: `pnpm db:reset:native -- --yes` (keeps `.secrets/local-db.env`).

Troubleshooting:

- Port 54329 in use: another Postgres or the Docker database is running. Stop it (`pnpm db:down`) and retry. The server listens on `127.0.0.1` only (use that, not `localhost`, if IPv6 resolution gives trouble).
- "running as Administrator": open a non-elevated terminal.
- Windows antivirus or firewall: allow `postgres.exe` under `node_modules/.pnpm/@embedded-postgres*`; loopback traffic only is needed. If the binaries were quarantined, re-run `pnpm install --frozen-lockfile`.
- Stale lock file after a crash: run `pnpm db:down:native` then `pnpm db:up:native`; check `.local-pg/postgres.log`. As a last resort, `pnpm db:reset:native -- --yes`.
- `.local-pg/` exists but `.secrets/local-db.env` is missing: the password is unknown; reset (above) and start again.

Safety: the payment kill switch is OFF by default (no payment can execute), this is XRPL Testnet only, and `.env` and `.secrets/` are gitignored and must never be committed. Supabase is not touched by any of these commands. Docker is still supported as the alternative: `pnpm db:up` instead of `pnpm db:up:native`, then the same commands. Details: [docs/local-dev.md](docs/local-dev.md).

Scripts:

- `pnpm setup:testnet-accounts`: creates and faucet-funds the treasury and three supplier wallets. Seeds go to `.secrets/testnet-wallets.json`. Safe to rerun.
- `pnpm trust-lines`: creates the RLUSD trust lines for those accounts. Skips ones that exist.
- `pnpm preflight`: read-only check of network, issuer, currency hex, reserves, trust lines and treasury RLUSD balance. It exits non-zero (2, BLOCKED) when the treasury holds no RLUSD.
- `pnpm m1:send -- --dry-run` / `pnpm m1:send -- --to domestic`: M1 sender. Sends 1 RLUSD (hard cap 2, treasury keeps at least 5, at most 2 real payments, Testnet only), logs to the gitignored `.secrets/m1-transactions.json`, prints the validated hash and explorer URL, and proves the balance delta.
- `pnpm db:up` / `pnpm db:down` / `pnpm db:status`: start, stop and check the local Postgres in Docker (loopback only, port 54329). Passwords are generated into the gitignored `.secrets/local-db.env` and never printed. Docker Desktop must be running. Without the script: `docker compose -f docker-compose.local-db.yml up -d --wait` needs `FLOW_LOCAL_PG_PASSWORD` set, so prefer `pnpm db:up`.
- `pnpm db:up:native` / `db:down:native` / `db:status:native` / `db:reset:native -- --yes`: the same local Postgres without Docker (embedded-postgres binaries, data in `.local-pg/`).
- `pnpm db:migrate [status]`: applies the SQL migrations to the local database (a non-local `DATABASE_URL` needs `--allow-remote` and TLS).
- `pnpm test:db`: database and guard integration tests against the local Docker Postgres (each run uses a throwaway database).
- `pnpm guard:dev`: starts the payment guard on 127.0.0.1:4002 (Testnet). The signer seed is read from `.secrets` by the launcher and handed to the guard through its environment in memory; the agent token is random per launch.
- `pnpm agent:run`: one agent run against the running guard (start `pnpm guard:dev` first). Deterministic mode needs no key. Flags after `--`: `--record` (secret-free transcript in `docs/demo/`), `--probe-ineligible`, `--schedule`. To use the LLM, set `AGENT_MODE=llm`, `AI_MODEL` and `AI_API_KEY` in the local gitignored `.env`; the agent refuses to start in llm mode without them and refuses to start if database or signer variables are present.
- `pnpm agent:demo -- --check-treasury` (read-only balance gate) / `--blocked-only` (default, submits nothing) / `--enable-execution` (one real 1 RLUSD agent payment; refuses unless the treasury holds at least 6 RLUSD and keeps at least 5; single use). Run for real once (add `--regular-key` to sign with the regular key): hash `237170E2F24845D2FB5FD920913971DFA53C567536C165501FA66C473EED352D`; see `docs/m5-notes.md`.
- `pnpm m3:e2e -- --blocked-only`: starts a fresh local database and the guard and shows an over-cap request being blocked (submits nothing). `pnpm m3:e2e -- --confirm-real-payment` makes the ONE authorised real 1 RLUSD payment and refuses to run again (already used; see `docs/m3-notes.md`).
- `pnpm db:seed:demo`: creates the labelled demo business (if missing) and one owner login in the local database. The owner password comes from `DEMO_OWNER_PASSWORD` or `.secrets/web-owner.env` (generated there if absent) and is never printed. Run `pnpm db:migrate -- --local` first. Re-running is a no-op; `-- --reset-password` replaces the password.
- `pnpm dev:web`: starts the owner web app on http://127.0.0.1:3000 against the local database as the `flow_web` role (connection assembled in memory, allowlisted environment).
- `pnpm build`: production build of the web app (`next build`). `pnpm web:size` prints a read-only size report of that build (raw and gzip bytes; it says nothing about load time).
- `pnpm start:web` (loopback only) or `pnpm start:web:public` (all interfaces), `pnpm start:guard`, `pnpm start:agent`: the production entry points. They read their configuration from the environment of the host (names in the matrix in [docs/deployment.md](docs/deployment.md)), not from `.env`. Health: web `/api/healthz` and `/api/readyz`, guard `/healthz` and `/readyz`, agent `/healthz` on `AGENT_HEALTH_PORT` (default 4003). For a local agent in service mode that picks up the owner's "Run treasury agent" button: `pnpm agent:run -- --serve` (guard running).
- `pnpm deploy:check`: static deploy-readiness verifier (Dockerfile, `.dockerignore`, env matrix names only, start scripts). It reads files only. Nothing is deployed by any script in this repository.
- `docker build --target web|guard|agent -t <name> .`: one Dockerfile, three non-root targets with health checks. No secret is baked in.
- `pnpm secret-scan`: scans staged, tracked and untracked files for seeds, hex keys, signed blobs, API keys, tokens and PEM blocks without printing matches.
- `pnpm setup:hooks`: opt-in; installs the versioned pre-commit hook for this clone.
- `pnpm lint`: ESLint with typed rules and `eslint-plugin-security` (zero warnings allowed).
- `pnpm run audit`: `pnpm audit --prod` (use `run`: bare `pnpm audit` is the built-in and also checks dev dependencies).
- `pnpm typecheck`: strict TypeScript across the root and all workspaces.
- `pnpm test`: runs workspace unit tests (contracts, policy engine, XRPL adapter, database helpers and guard; mocked ledger, no Docker, no RLUSD spent).

RLUSD claim (manual, only needed to top up): open https://tryrlusd.com/, choose Testnet, and claim for the treasury address `rHwNC93iYF7ZcSpZJbVZiwLmpiCKauoHuo`. The faucet gives 10 RLUSD per claim per 24 h per account. Run `pnpm preflight` afterwards.

## Security notes
- Testnet only. Every entry point checks that `XRPL_NETWORK` is exactly `xrpl-testnet`, that `XRPL_WS_URL` is on an exact allowlist (`wss://s.altnet.rippletest.net:51233`), that the RLUSD issuer is not the Mainnet issuer, and that the server reports `network_id` 1. Any mismatch stops the process.
- Seeds live only in the gitignored `.secrets/` folder and are read only on the signer path. Never commit `.env`; `.env.example` holds placeholders only. On Windows, keep the repo in a user-only folder and restrict `.secrets` with `icacls .secrets /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`.
- Logs and errors go through one redaction helper (`packages/contracts/src/redact.ts`) that scrubs family seeds, hex keys, signed transaction blobs, API keys, JWT/Bearer tokens and PEM blocks.
- `PAYMENT_EXECUTION_ENABLED` is a kill switch: execution is allowed only when it is exactly `true`.
- Secret scan: `pnpm secret-scan` checks the staged index content plus tracked and untracked files. A versioned pre-commit hook lives in `scripts/git-hooks/pre-commit`. Enable it once per clone with `pnpm setup:hooks` (opt-in; it sets `core.hooksPath` for that clone only). Hooks can be skipped, so CI must run the same scan.
- Supply chain: all dependency versions are exact, the lockfile is committed, `.npmrc` sets `ignore-scripts=true`, and `pnpm run audit` (`pnpm audit --prod`) must be clean for production dependencies.
- Reporting and rules: see [SECURITY.md](SECURITY.md), the audit in [docs/security-review.md](docs/security-review.md), and the binding rules for M3 and later in [docs/secure-coding-standards.md](docs/secure-coding-standards.md) (spec 13.4).
## Documentation and resources

- Spec: [Flow_AI_MVP_README_v3.5.md](Flow_AI_MVP_README_v3.5.md)
- Notes: [docs/m0-notes.md](docs/m0-notes.md), [docs/m1-notes.md](docs/m1-notes.md), [docs/m2-notes.md](docs/m2-notes.md), [docs/m3-notes.md](docs/m3-notes.md), [docs/m4-notes.md](docs/m4-notes.md), [docs/m5-notes.md](docs/m5-notes.md), [docs/m6-notes.md](docs/m6-notes.md), [docs/deployment.md](docs/deployment.md), [packages/policy-engine/README.md](packages/policy-engine/README.md)
- RLUSD on the XRPL (Ripple docs): https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl
- Send a trust line token: https://xrpl.org/docs/tutorials/payments/send-a-trust-line-token
- xrpl.js: https://js.xrpl.org/
- Testnet explorer: https://testnet.xrpl.org/
- MCP specification: https://modelcontextprotocol.io/specification/

## Judging criteria

- Product design: owner-facing limits, a plain-language agent explanation per decision, and a dashboard (M6, built and tested locally; public URL pending hosting account).
- Technical: independent guard, pure tested policy engine, and Testnet payments with validated results (M1 onward).
- Business fit: importers paying suppliers across African borders; the spec frames cost and speed advantages as hypotheses to validate.
