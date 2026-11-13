# M4 notes: owner policy API and page, audit events
Scope: `apps/web` (Next.js 16 App Router: owner pages and the authenticated app API), migration `0006_web_role_sessions.sql`, `packages/database/src/repos/web.ts`, `packages/contracts/src/web-api.ts`, the demo owner seed and the web dev launcher. Local Docker Postgres only. No Supabase project was created or contacted. No XRPL transaction was submitted and no RLUSD was spent.
## Run it locally
```bash
pnpm install
pnpm db:up                 # Docker Desktop must be running; passwords go to the gitignored .secrets/local-db.env
pnpm db:migrate -- --local # --local ignores a DATABASE_URL set in your shell or .env
pnpm db:seed:demo          # demo business + owner login; run twice, the second run is a no-op
pnpm dev:web               # http://127.0.0.1:3000
```
- Owner email: `DEMO_OWNER_EMAIL` (default `owner@demo.flow-ai.test`). Owner password: `DEMO_OWNER_PASSWORD` from the environment, else from `.secrets/web-owner.env`, else a random one is generated into that file (mode 0600). The script prints only the file path, never the value. A password is 12 to 256 characters.
- `pnpm db:seed:demo -- --reset-password` replaces the password (a new random one unless `DEMO_OWNER_PASSWORD` is set). Without the flag an existing login is never changed. `--balance <decimal>` (default 10) only scales the demo fixture when the demo business does not exist yet; the script makes no network call.
- The seed connects as the local admin and refuses a non-loopback host. `pnpm dev:web` assembles `WEB_DATABASE_URL` (role `flow_web`) in memory and gives the child an allowlisted environment: no signer seed, no guard token, no admin password, no `DATABASE_URL`. The web config also refuses to start if any of those names is present.
## Endpoints
| Method and path | Role | Purpose |
|---|---|---|
| `POST /api/auth/login` | public | Email and password; returns `{role, csrf_token}`; rotates the session |
| `POST /api/auth/logout` | any session | Revokes the session |
| `GET /api/session` | any session | Role and CSRF token |
| `GET /api/overview` | any session | Balance, today's spend, limits, automation state, invoice counts |
| `GET /api/policy` | any session | Policy plus `ETag` (the version) |
| `PUT /api/policy` | owner | Full policy, `If-Match` required, optional `confirm_risky`; audit event in the same transaction |
| `GET /api/suppliers` | any session | Suppliers of the session's business |
| `PATCH /api/suppliers/:id` | owner | Approve or remove approval, activate or deactivate |
| `GET /api/audit-events` | any session | Whitelisted audit feed, `limit` and `before_seq` pagination |
Pages: `/login`, `/` (four CFO answers), `/policy`, `/suppliers`, `/audit`. Every route declares a role (deny by default; `route-table.test.ts`). The business always comes from the session, never from the request; a body with `business_id` is a 400.
## Decisions
- Password hashing is `node:crypto` scrypt, N=2^17, r=8, p=1, with the parameters stored in the hash so they can be raised. Reason: the repo keeps `ignore-scripts=true`, so a native argon2 or bcrypt package (which needs an install script or a prebuilt binary) would mean widening `allowBuilds`. Standard AU-1 says to use the platform's vetted auth (Supabase Auth). This is a dated exception for the local milestone (M4, 2026): credentials and sessions are behind a provider interface (`auth/provider.ts`) and the swap point to Supabase Auth is M6, when the hosted database and project exist.
- Sessions: 256-bit random token, only its SHA-256 is stored in `web_sessions`; cookie `flow_session` (http, dev) or `__Host-flow_session` (https) with HttpOnly, SameSite=Lax, Path=/. Idle timeout 1800 s, absolute timeout 28800 s, rotated at login, revoked at logout.
- CSRF: a per-session token derived by HMAC, hash stored, sent as `x-csrf-token`, plus an `Origin` check against `APP_BASE_URL`.
- Tenant scoping: RLS on every tenant table for the `flow_web` role, driven by a transaction-local `app.business_id` set from the session; column-level grants (the role updates only the policy and supplier flag columns it needs), no DELETE or TRUNCATE anywhere, INSERT-only on `audit_events`, no write on payments, reservations, wallets or invoices.
- Concurrency: `If-Match` with the policy version; stale is 412, missing is 428. Two concurrent writers: exactly one wins.
- Risky changes (re-enable, raise either cap, lower the reserve, add an asset, extend or remove the expiry) need `confirm_risky` (422 otherwise) and a login within the last 15 minutes (`STEP_UP_SECONDS`, 401 `REAUTH_REQUIRED`). Pausing (enabled true to false alone) and un-approving or deactivating a supplier are exempt: they fail safe.
- `allowed_assets` is restricted to the configured RLUSD pair. `valid_until` must be in the future and within a year.
- Login protection: 10 attempts per email and 60 per IP per 15 minute window; account lock from the 5th failure (30 s, doubling to 15 min); identical generic errors; a dummy hash is spent for unknown emails.
- The CSP is nonce-based per request (`src/proxy.ts`, the Next 16 name for middleware); the layout is `force-dynamic` so the nonce applies. Production adds `upgrade-insecure-requests` and HSTS, so production must be served over https.
## Tests (real runs on this branch)
- `pnpm test`: 565 passed (contracts 67, xrpl-adapter 62, policy-engine 172, database 18, payment-guard 131, web 115).
- `pnpm test:db` (local Docker Postgres): 160 passed (database 51, web 47, payment-guard 62).
- The proof that the owner's policy governs the guard: `apps/web/test/policy-effect.db.test.ts` shows a request allowed, the owner lowering `max_payment_amount` through the real handlers, and the next request blocked with `PAYMENT_LIMIT_EXCEEDED`, with a correct `policy.updated` audit event and a valid audit chain.
- `pnpm typecheck`, `pnpm lint`, `pnpm secret-scan` and `pnpm run audit` pass (see the README status row).
## Limitations (honest)
- The pages are built to WCAG 2.2 AA guidelines, not formally audited. Automated checks run axe in jsdom, which cannot judge colour contrast, reflow, target size, focus visibility or real screen reader behaviour. Contrast is checked only at design-token level (`contrast.test.ts`); target size and 320 px reflow are by CSS design, not measured.
- No Playwright and no real-browser run: no screenshots were taken and CSP was verified through response headers and nonce matching in server HTML, not through a browser violation test.
- No Supabase: sessions and credentials are local Postgres tables. Hosted setup is in `docs/supabase-runbook.md` (including the `flow_web` password step).
- One demo owner. There is no sign-up, password reset, MFA or user management; there is no supplier create or edit UI.
- The kill switch (`PAYMENT_EXECUTION_ENABLED`) is unchanged and still an environment variable of the guard; the web Pause only changes the policy.
- `login_attempts` windows are never deleted because `flow_web` has no DELETE. The IP bucket is one shared bucket unless `WEB_TRUST_PROXY=true` behind a proxy that overwrites `X-Forwarded-For`.
- A policy whose `valid_until` already passed cannot be re-saved until a new expiry is set; Pause of such a policy is blocked only by the schema.
- `next build` prints a Turbopack warning that `migrate.ts` (filesystem access) is traced into the API routes; harmless.
