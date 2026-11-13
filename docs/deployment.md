# Deployment guide (web + payment guard + agent)

Status: **no deployment has been made.** No hosting account exists yet, no hosting CLI was logged in to, and no remote database was changed for this guide. This file tells the owner how to deploy the three processes to a host of their choice. It contains variable NAMES only, never a value.

Scope: **XRPL Testnet only.** The code refuses Mainnet in every process. Nothing here moves real funds. Authentication is the local scrypt provider seeded for a demo owner (see `docs/secure-coding-standards.md`, AU-1 dated exception); treat the login as demo credentials and rotate the password.

## 1. Topology

| Process | Exposure | Talks to | Holds |
|---|---|---|---|
| web (Next.js) | Public, HTTPS only, behind the host's proxy | Database as `flow_web` | Session secrets in the database only. No signer, no agent token. |
| guard (Fastify payment service) | Private. A private network, or an IP allowlist plus the bearer token. Never a public listener. | Database as `flow_guard`, XRPL Testnet | The signer seed (guard host secret store only) and the agent token. |
| agent | No inbound traffic. Health listener on loopback by default. | The guard over HTTP with the agent token | The agent token only. No database, no signer. |

The agent reaches the guard at `PAYMENT_GUARD_INTERNAL_URL` (https anywhere except loopback). The web app never calls the guard and never holds the agent token: the owner's "Run treasury agent" button writes a request row that the agent claims through the guard.

## 2. Environment matrix (names only)

Levels: `required` (set it), `optional` (has a default), `forbidden` (the process refuses to start, or must not receive it), `-` (not used). `pnpm deploy:check` verifies that this table lists names and level words only, that every `required` or `optional` name is read by that process's code, and that the agent column has no database, signer or Supabase name.

<!-- env-matrix:start -->
| Variable | web | guard | agent |
|---|---|---|---|
| `NODE_ENV` | required | required | - |
| `APP_BASE_URL` | required | - | - |
| `PORT` | optional | - | - |
| `WEB_DATABASE_URL` | required | forbidden | forbidden |
| `GUARD_DATABASE_URL` | forbidden | required | forbidden |
| `DATABASE_URL` | forbidden | forbidden | forbidden |
| `DATABASE_SSL_CA_FILE` | required | required | forbidden |
| `SESSION_IDLE_SECONDS` | optional | - | - |
| `SESSION_ABSOLUTE_SECONDS` | optional | - | - |
| `STEP_UP_SECONDS` | optional | - | - |
| `WEB_TRUSTED_PROXY_HOPS` | optional | - | - |
| `WEB_TRUST_PROXY` | optional | - | - |
| `RLUSD_ISSUER` | required | required | - |
| `RLUSD_CURRENCY_HEX` | required | required | - |
| `RLUSD_DISPLAY_SYMBOL` | - | optional | - |
| `XRPL_NETWORK` | - | required | - |
| `XRPL_WS_URL` | - | required | - |
| `XRPL_DEMO_SIGNER_SEED` | forbidden | required | forbidden |
| `OWNER_TREASURY_MASTER_SEED` | forbidden | forbidden | forbidden |
| `SUPABASE_SERVICE_ROLE_KEY` | forbidden | forbidden | forbidden |
| `PAYMENT_EXECUTION_ENABLED` | - | required | forbidden |
| `AGENT_TO_PAYMENT_GUARD_TOKEN` | forbidden | required | required |
| `AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT` | forbidden | optional | - |
| `GUARD_HOST` | - | required | - |
| `GUARD_PORT` | - | optional | - |
| `GUARD_BUSINESS_ID` | - | required | - |
| `STALE_RESERVATION_TIMEOUT_SECONDS` | - | optional | - |
| `AGENT_RUN_STALE_SECONDS` | - | optional | - |
| `BALANCE_POLL_INTERVAL_SECONDS` | - | optional | - |
| `RECONCILE_INTERVAL_SECONDS` | - | optional | - |
| `AUDIT_VERIFY_INTERVAL_SECONDS` | - | optional | - |
| `AUDIT_BREAK_ACK` | - | optional | - |
| `GUARD_RATE_LIMIT_PER_MINUTE` | - | optional | - |
| `GUARD_PAYMENT_WAIT_SECONDS` | - | optional | - |
| `PAYMENT_GUARD_INTERNAL_URL` | - | - | required |
| `AGENT_MODE` | - | - | optional |
| `AGENT_MAX_TOOL_CALLS` | - | - | optional |
| `AGENT_MAX_PAYMENTS_PER_RUN` | - | - | optional |
| `AGENT_REASON_MAX_CHARS` | - | - | optional |
| `AGENT_RUN_TIMEOUT_SECONDS` | - | - | optional |
| `AGENT_SCHEDULE_INTERVAL_MINUTES` | - | - | optional |
| `AGENT_POLL_SECONDS` | - | - | optional |
| `AGENT_HEALTH_HOST` | - | - | optional |
| `AGENT_HEALTH_PORT` | - | - | optional |
| `AI_PROVIDER` | forbidden | - | optional |
| `AI_MODEL` | - | - | optional |
| `AI_API_KEY` | forbidden | - | optional |
<!-- env-matrix:end -->

Notes on the matrix:

- `AI_*` is only for the optional LLM mode. The default `AGENT_MODE` is the deterministic rule and needs no key. Do not set a provider key unless you deliberately switch to the LLM mode.
- `DATABASE_URL` is the admin string used by the owner's machine for migrations. It is never set on any deployed process.
- `GUARD_HOST` must be a non-loopback address inside a container (for example the all-interfaces address). A non-loopback or production guard then **requires** `GUARD_BUSINESS_ID` (the tenant pin, the only business boundary for the guard role). The guard refuses to start without it.
- `PAYMENT_EXECUTION_ENABLED` is read by the guard on every request. Execution is allowed only when it is exactly `true`. Keep it `false` until the deliberate enabling step in section 8.
- `APP_BASE_URL` must be the public `https` origin with no path. In production an `http` value is a configuration error.
- `WEB_TRUSTED_PROXY_HOPS` is the number of reverse proxies in front of the web app (0 to 5, default 0). See section 5. `WEB_TRUST_PROXY=true` is the older alias for one hop; stating both with different meanings is a configuration error.
- `PORT` is read by `next start`.

## 3. Secret handling rules

1. The signer seed (`XRPL_DEMO_SIGNER_SEED`) lives **only in the guard host's secret store**. It is never in the repository, an image layer, a build argument, CI output, the web environment or the agent environment. The web and agent processes refuse to start if they receive it. Testnet seeds only.
2. Every other secret (`GUARD_DATABASE_URL`, `WEB_DATABASE_URL`, `AGENT_TO_PAYMENT_GUARD_TOKEN`) goes in the secret store of the host that runs that one process. Each process gets only its own.
3. Rotate on any suspected exposure: new database role passwords (`pnpm db:supabase:roles -- --rotate`), a new agent token (use `AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT` for a no-downtime swap), and for a seed a new Testnet wallet funded from the faucet.
4. The database CA file is public but is still mounted as a file at run time, never copied into an image (`*.crt` is excluded from the Docker build context).
5. Never paste a value into an issue, a chat or a log. Logs are redacted, but treat that as a last line of defence.

## 4. Supabase (session pooler and CA)

1. Create the project near the guard host. Keep the database password in your password manager.
2. Download the project's root CA certificate from the dashboard (Database settings). Keep it outside git; mount it into the web and guard containers and point `DATABASE_SSL_CA_FILE` at the mounted path. With it set, connections use verified TLS (`rejectUnauthorized: true`); the URL's `sslmode` cannot weaken that.
3. Use the **session pooler** (port 5432 on the pooler host) with the login `<role>.<project-ref>`. The guard holds a session-level advisory lock, which the transaction pooler (port 6543) breaks, and the transaction pooler has not been tested with this app. The direct host may be IPv6 only.
4. From the owner's machine (not from a deployed process), with the admin connection string and `DATABASE_SSL_CA_FILE` set in your shell only:
   - `pnpm db:migrate status --allow-remote` (read only).
   - `pnpm db:migrate --allow-remote`. This applies every pending migration, including `0009_agent_run_requests` and `0010_login_attempts_prune`, which are new in this release. The scripts never print the connection string.
   - `pnpm db:supabase:roles` (creates `flow_guard` and `flow_web` with random passwords written to the gitignored `.secrets/`).
   - `pnpm db:supabase:verify` (read only; exits 1 on any failure).
5. Put the `flow_guard` connection string only in the guard's secret store and the `flow_web` string only in the web's.

## 5. Proxy trust and rate-limit buckets

The login rate limit buckets by client IP. Behind a proxy that appends the address it saw to `X-Forwarded-For`, the real client is the entry **N places from the right**, where N is the number of proxies you control. Set `WEB_TRUSTED_PROXY_HOPS` to that number (usually 1). Anything to the left of that entry is client-controlled and is ignored, so a spoofed header cannot choose the bucket. With 0 (the default) the header is ignored and all callers share one bucket, which is safe but coarse. A short header, a missing header or a malformed entry also falls back to the shared bucket.

## 6. Housekeeping job (`login_attempts`)

Migration `0010_login_attempts_prune` lets the web role delete rate-limit windows older than one day and nothing newer (a row policy enforces the age; the guard role has no delete right). The web process runs the job itself, from `src/instrumentation.ts`: first after 60 seconds, then hourly, on timers that do not keep the process alive. It prunes `login_attempts` windows older than two days and revokes sessions past their absolute expiry. A failed pass is logged (redacted) and retried at the next tick. No cron is needed. With more than one web instance the job runs on each; deletes are idempotent.

## 7. HSTS and headers

Production responses carry `Strict-Transport-Security: max-age=63072000; includeSubDomains` (no `preload`) and a per-request nonce CSP with no `unsafe-inline` and no `unsafe-eval`. Also enable HSTS and HTTPS redirection at the host's edge, because the edge answers some requests (redirects, error pages) before the app does. Terminate TLS at the host or proxy; the web app itself serves plain HTTP behind it.

## 8. Run guide

### 8a. Platform-neutral (Node 20.19 or newer, pnpm 11)

```bash
pnpm install --frozen-lockfile
pnpm build                 # next build for the web app
pnpm start:web:public      # web on all interfaces, port from PORT (default 3000). Use pnpm start:web for loopback only.
pnpm start:guard           # guard (tsx), port GUARD_PORT (default 4002)
pnpm start:agent           # agent service: polls the guard, health on AGENT_HEALTH_PORT (default 4003)
```

Run each on the host that holds its secrets. Start order: guard, then web, then agent. Health probes:

- web: `GET /api/healthz` (liveness, never touches the database) and `GET /api/readyz` (database reachable and the role is not a superuser or BYPASSRLS; flags only, 200 or 503).
- guard: `GET /healthz` and `GET /readyz` (database, ledger and audit chain flags).
- agent: `GET /healthz` on `AGENT_HEALTH_HOST:AGENT_HEALTH_PORT` (last poll time and a busy flag; no other route).

### 8b. Containers (one Dockerfile, three targets)

```bash
docker build --target web   -t flow-ai-web .
docker build --target guard -t flow-ai-guard .
docker build --target agent -t flow-ai-agent .
```

Pass configuration at run time from the host's secret or environment store (never `--build-arg`), and mount the CA file read-only, for example `-v <host path to CA>:/run/ca/supabase-ca.crt:ro` with `DATABASE_SSL_CA_FILE` set to `/run/ca/supabase-ca.crt`. Each image runs as a non-root user and has a health check. The images keep the full workspace install (the workspace packages ship TypeScript source), so they are not size optimised.

### 8c. Enabling execution (deliberate step, owner only)

Deploy with `PAYMENT_EXECUTION_ENABLED=false`. Check the pre-deploy list below. Only then, and only on Testnet, change it to `true` on the guard host and restart nothing else (the guard re-reads it per request). Setting it back to anything but `true` stops every payment immediately.

## 9. Pre-deploy checklist

- [ ] `pnpm preflight` passes (Testnet network, RLUSD issuer and currency re-verified).
- [ ] `pnpm db:migrate status --allow-remote` shows no pending migration (0001 to 0010 applied).
- [ ] `pnpm db:supabase:verify` passes against the real project.
- [ ] Every `required` name in the matrix is set for each process, and no `forbidden` name is set anywhere.
- [ ] `PAYMENT_EXECUTION_ENABLED` is `false`.
- [ ] `GUARD_BUSINESS_ID` is set on the guard, and `APP_BASE_URL` is the public https origin.
- [ ] `WEB_TRUSTED_PROXY_HOPS` matches the proxies in front of the web app.
- [ ] `DATABASE_SSL_CA_FILE` points at a mounted CA file in the web and guard.
- [ ] The signer seed is only in the guard host's secret store.
- [ ] The guard is not reachable from the public internet.
- [ ] The demo owner password was rotated (demo credentials only).
- [ ] HSTS and HTTPS redirect are on at the edge.
- [ ] `pnpm test`, `pnpm test:db`, `pnpm typecheck`, `pnpm lint`, `pnpm secret-scan`, `pnpm audit` and `pnpm deploy:check` pass on the commit being deployed.
- [ ] The three health endpoints return 200 after start.
- [ ] A leak grep over tracked files finds no real password, token, seed or database string.
- [ ] Reminder: **no deployment has been made** from this repository yet. Everything above is for the owner to do.
