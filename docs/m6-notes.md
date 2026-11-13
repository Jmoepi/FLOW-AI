# M6 notes: dashboard screens and deploy-readiness

Status: **done locally. Public URL pending hosting account.** Nothing was deployed, no hosting CLI was logged in to, no remote database was changed and no LLM provider was contacted. The owner's Supabase project still has migrations 0001 to 0008 only; 0009 and 0010 are applied to the local database and are for the owner to apply (see `docs/deployment.md`).

Accessibility wording used everywhere: **built to WCAG 2.2 AA guidelines, not formally audited.**

## 1. What was built

| Screen or surface | Route | Notes |
|---|---|---|
| Overview | `/` | The four CFO questions in order: what the agent may do (balance with `as_of` freshness, today's spend, remaining allowance, minimum reserve, automation state), who it can pay (link to Suppliers), how to stop it (control panel), how to prove it (recent payments, audit link). Also the agent panel, invoice queue (5 soonest due) and recent payments (5). |
| Invoices list and detail | `/invoices`, `/invoices/[id]` | Status filter (plain GET form), paging, route (domestic or cross-border), due text in words, blocked invoices show the decision in plain language. |
| Payments list and detail | `/payments`, `/payments/[id]` | Status filter, paging, short hash with Copy button. Detail shows network, destination with Copy, ledger index, validated time, delivered amount, fee, policy version, failure detail and agent reason. |
| Agent activity | `/agent` | From M5, unchanged apart from the shared shell and banner. |
| Payment policies | `/policy` | From M4. Resume goes through its existing review step. |
| Suppliers, Audit | `/suppliers`, `/audit` | From M4. |
| Control panel (on Overview) | `/` | Pause automation (versioned fail-safe write, no re-login needed because it never loosens a rule), Resume (link to Payment policies), plain explanation of the emergency stop. |
| Run treasury agent (on Overview) | `POST /api/agent-runs` | Writes an owner request row (migration 0009). The agent claims it through the guard. See decision 4. |
| Health | `GET /api/healthz`, `GET /api/readyz` | Liveness never touches the database. Readiness: database reachable and role is not a superuser or BYPASSRLS. Flags only. |
| States | every page | `loading.tsx` per route, `error.tsx`, `not-found.tsx`, empty states, blocked notices. The Testnet banner ("TESTNET DEMO", "XRPL Testnet, no real funds") is rendered once by the root layout, so login, error and not-found pages carry it too. |

Every decision code (28, spec 9.3 plus the M2 additions) has a plain-language title, explanation and next step in `components/decision-codes.ts`. A test iterates `DECISION_CODES`, so a new code without an entry fails.

## 2. Decisions and deviations

1. **No client-side "Eligible" badge.** The web process is forbidden from holding the guard token, so it cannot call the eligibility preview (9.5). Invoice status shows the stored status through the shared vocabulary; blocked invoices show the latest stored decision. The pages say that the payment service decides on every request. Deviation from a literal reading of 11.x; no web-to-guard credential was added.
2. **Gaps (not built in the web UI):** payment cancel (needs a web-to-guard write path; the guard sweeper already cancels stale unsigned payments), manual invoice create (needs an INSERT grant on `invoices` for `flow_web`, a wider write privilege on a money table; invoices are seeded) and supplier create or edit (absent since M4).
3. **Cut, per the settled decisions (spec 3.4 and 4.2):** the finance-operator role and CSV export. Nothing was built, and a route-table test fails if an export or operator route or role appears. Roles stay `owner` and `viewer`.
4. **Run treasury agent through a request queue.** Migration 0009 adds `agent_run_requests` (RLS enabled and forced). `flow_web` may SELECT and INSERT, and UPDATE `status` only through a policy that allows nothing but expiring a stale open request. `flow_guard` may SELECT and UPDATE `status` and `claimed_at`. At most one open request per business; a request older than 10 minutes counts as expired. The guard route `POST /internal/run-requests/claim` (bearer token, no body, claims atomically with `FOR UPDATE SKIP LOCKED`, audited) answers 200 with a request id or 204. The agent has a long-running `--serve` mode (also the `pnpm start:agent` entry) that polls the claim route every `AGENT_POLL_SECONDS` (default 5) and runs once per claim; it also runs the interval trigger when `AGENT_SCHEDULE_INTERVAL_MINUTES` is set. Runs never overlap. A request carries no instruction: the agent runs under the same rules and the guard decides every payment. The claimed request is not linked to the run id (the column was dropped as unused).
5. **Pause and emergency stop.** Pause is a fail-safe write and needs no step-up. Resume goes through Payment policies. The kill switch `PAYMENT_EXECUTION_ENABLED` stays operator controlled. The page never claims its live value: it says "Emergency stop was active on the last decision" only when the latest stored decision is `EXECUTION_DISABLED`.
6. **Authentication.** The AU-1 dated exception (local scrypt provider) is **carried forward, not closed.** Swapping to Supabase Auth needs a new dependency and an auth integration decision, so it was left for the owner to decide. `docs/secure-coding-standards.md` carries a dated note. A deployed instance is demo credentials only.
7. **Accessibility testing uses axe-core 4.14.0 in jsdom** (the setup since M4), not `jest-axe`, which was not added. **Playwright was not added** (heavy dependency, needs a browser download), so there is no real-browser run.
8. **Runtime for guard and agent.** Workspace packages ship TypeScript source, so there is no compile step; the production entry is `tsx` (exact pin 4.23.15, now in each app's `dependencies`). Typecheck is the compile gate. The web app uses `next build` and `next start` (no `standalone` output).
9. **Trusted proxy.** `WEB_TRUSTED_PROXY_HOPS` (0 to 5, default 0): the client IP is the `X-Forwarded-For` entry that many places from the right; a spoofed leftmost entry cannot choose the bucket. `WEB_TRUST_PROXY=true` is an alias for 1 hop; conflicting values are a configuration error that names only the variable. This replaces the earlier first-entry behaviour, which was spoofable.
10. **`login_attempts` pruning.** Migration 0010 grants DELETE to `flow_web` with a row policy that only allows windows older than one day, so the live counter can never be deleted by the web role; `flow_guard` has no grant. The web process runs the job from `src/instrumentation.ts`: first pass after 60 seconds, then hourly, on unref'd timers, non-overlapping, errors logged through the redacting path. It deletes windows older than two days and also revokes sessions past their absolute expiry.
11. **Pooler.** Documentation uses the session pooler on port 5432 (what the Stage 1 check used). The transaction pooler on 6543 is untested and breaks the guard's session advisory lock.
12. **Pagination** for invoices and payments is offset based (`page`, 20 per page, 1 to 1000), because those tables have no sequence column. Fine for the MVP data volume; keyset paging is the follow-up.
13. **Payment checks passed list.** The payment page shows the failure code, its explanation and the policy version. The audit metadata for the individual checks was not read into the page.
14. **`pnpm-workspace.yaml`:** `allowBuilds` now also lists the Linux and macOS `@embedded-postgres` packages as `false` (as the Windows one already was). Without it `pnpm install --frozen-lockfile` fails inside a Linux container on the ignored-build-scripts rule.
15. **Web `start` binds to loopback** (`next start --hostname 127.0.0.1`); `start:public` binds all interfaces and is what the Docker image uses. This keeps a local `pnpm start:web` off the network by default.

## 3. Tests

Counts from the final gate run (see `.agents/tasks/m6-m7/stage2-evidence.md` for the commands):

- `pnpm test`: **1064 unit** (contracts 87, xrpl-adapter 62, policy-engine 172, database 31, payment-guard 137, web 333, agent 242). Before M6: 864 (web 145 of them; the 851 in the M5 README row predates the Stage 1 additions).
- `FLOW_TEST_DB=native pnpm test:db` (per package, embedded Postgres): **250 db** (database 80, web 60, payment-guard 93, agent 17). Before M6: 224.
- `pnpm typecheck`, `pnpm lint` (0 warnings), `pnpm secret-scan`, `pnpm run audit` (no known vulnerabilities), `pnpm deploy:check` (26 of 26) all pass.
- `apps/payment-guard` unit tests now use a 20 s per-test timeout: the first cold `buildApp()` exceeded the 5 s default when every workspace ran in parallel. No test was skipped.

New test files: `decision-codes`, `status-vocab`, `explorer-link`, `invoice-format`, `control-panel`, `css-static`, `csp-static`, `housekeeping`, `deploy-readiness` (web, unit); `invoices-payments.db` (web, db); `run-requests.db` (database and guard, db); `serve` (agent). Extended: `a11y`, `xss`, `route-table`, `config`, `auth-primitives`.

What the automated checks do **not** cover (jsdom has no layout engine): colour contrast (token pairs are checked arithmetically in `contrast.test.ts`), reflow at 320 px, target size and focus visibility as rendered (the stylesheet is checked as text in `css-static.test.ts`), and screen reader behaviour.

### Manual checklist (not performed in a browser)

- [ ] Keyboard only, from login to Overview, Invoices, an invoice, Payments, a payment, Policy and back; no trap, visible focus on every control, skip link works.
- [ ] 320 CSS px wide phone or emulator: no horizontal scrolling, tables stack, banner and nav wrap.
- [ ] 200% text zoom and 400% page zoom: nothing clipped.
- [ ] Screen reader pass (NVDA or VoiceOver): headings, landmarks, table captions, live announcements for Pause, Copy and Run.
- [ ] Real contrast check on a rendered page, including forced-colors and dark mode.
- [ ] Reduced-motion preference on a real device: skeleton does not animate.
- [ ] Pointer targets at least 24 px (the stylesheet sets 44 px for controls).

## 4. Performance and reliability

Web build size, `pnpm --filter @flow-ai/web build` then `pnpm web:size` (bytes on disk, measured):

| | Before M6 (baseline build) | After M6 |
|---|---|---|
| JS files | 13 | 16 |
| JS raw | 597,679 B | 625,142 B (610.5 KiB) |
| JS gzip | not recorded | 194,396 B (189.8 KiB) |
| CSS raw | 6,751 B | 8,603 B (8.4 KiB) |
| CSS gzip | not recorded | 2,470 B (2.4 KiB) |

Largest chunks (raw / gzip): 223.9 / 70.1 KiB, 182.4 / 48.6 KiB, 110.0 / 38.7 KiB; the rest are under 17 KiB. These are the framework and React runtime; M6 added about 27 KiB raw of app code and no dependency.

The targets (JS gzip at most 250 KiB, CSS gzip at most 20 KiB) are targets, not measurements. **Unmeasured in a browser:** load time, time to interactive, largest contentful paint, phone performance and real-network behaviour.

Reliability measures in code (tested): liveness answers without the database; readiness reports flags; the housekeeping job cannot overlap and survives a failed pass; the agent loop survives guard errors and never overlaps runs; the claim is atomic; every container target runs as a non-root user with a health check.

## 5. Local checks performed

Against the local database only: migrations 0009 and 0010 applied and re-applied (second run: "Nothing to apply"); the guard started with the kill switch off (`/healthz` and `/readyz` 200); the agent in service mode answered `/healthz` 200 (a second route answered 404) and polled the claim route; `next start` answered `/api/healthz` 200 with the strict CSP and HSTS headers, and `/api/readyz` 503 without configuration. The three Docker targets (`web`, `guard`, `agent`) built; the web image ran as `node`, answered `/api/healthz` 200 and contained only `.env.example` among env-like files; the guard and agent images failed closed with no configuration. The images were removed afterwards. The press-the-button path through the web, guard claim and agent run was covered by the database and route tests (including a real claim over HTTP in the guard test), not by a manual run with a browser.

## 6. Hosting CLI availability (read only, nothing logged in to)

`vercel`: not installed. `flyctl`: not installed. `railway`: installed, not authenticated (its saved login is not valid). `gh`: installed and authenticated, which is for GitHub and is not a hosting account. Nothing was deployed.

## 7. Known limitations

- No real-browser accessibility or performance run (see the checklist).
- AU-1 exception carried forward (decision 6).
- Offset paging, no cancel, no manual invoice create (decisions 2 and 12).
- The images contain the full workspace install and are not size optimised.
- The owner's Supabase project does not have migrations 0009 and 0010 yet.
- The public URL is pending a hosting account.
