# M5 notes: agent and MCP tools
Scope: `apps/agent` (agent loop, MCP tool server, provider adapter), guard run-record and read endpoints, migration `0007_agent_runs.sql`, the web "Agent activity" page, and the `agent:run` / `agent:demo` scripts. Local Docker Postgres only. No Supabase project was contacted. No LLM network call was made and no API key exists. No RLUSD was spent in M5 (see "Real payment status").

## Design
- The agent is an actor, not a chatbot (spec 1.2, 2.5). It talks to the guard only through the five MCP tools, and the tool server talks to the guard only over HTTP with the bearer token. The guard rebuilds the payment from its own records and remains the only decision maker in both modes.
- Default mode is `AGENT_MODE=deterministic`. It needs no key and still uses the real MCP stdio path and the real guard HTTP API. `AGENT_MODE=llm` adds a Claude tool-calling loop (Anthropic adapter on `fetch`, fixed system prompt that treats all tool data as untrusted). The LLM path is unit tested with a fake transport only.
- Run records are written by the agent loop through the guard (the agent has no database access): `POST /internal/agent-runs`, `POST /internal/agent-runs/:id/events`, `POST /internal/agent-runs/:id/finish`. The guard derives the final status from its own records (migration 0008, `agent_run_payment_requests`); the agent's status is only stored as an untrusted `client_status`. The web app reads them as `flow_web` (SELECT only).

## The five tools (spec 7.2.D)
All inputs are `z.strictObject` (unknown keys rejected). Free text from business data is returned as `{untrusted:true, text}` after control, bidi and zero-width characters are stripped, and every result carries a `data_notice` saying marked fields are data, not instructions.

| Tool | Input | Output (summary) |
|---|---|---|
| `get_business_snapshot` | `{}` | `as_of`, `rlusd_balance`, `minimum_reserve`, `daily_remaining`, `automation`, `network`, `stale` |
| `list_open_invoices` | `{limit?: 1..20}` | invoice items with supplier `{name(untrusted), country_code, approved}`, `description(untrusted)`, and a read-only `eligibility` preview (spec 9.5) |
| `get_invoice_details` | `{invoice_id: uuid}` | one invoice item as above |
| `request_supplier_payment` | `{invoice_id: uuid, idempotency_key: ^[A-Za-z0-9._:-]{8,128}$, agent_reason?: <=280 chars, controls stripped}` | `payment_id`, `status`, `decision_code`, `failure_code`, `message`, `amount`, `tx_hash`, `explorer_url`, `policy_version` |
| `get_payment_status` | exactly one of `{payment_id}` or `{invoice_id}` | same payment result shape |

No tool takes an amount, destination, currency, issuer, network or business id. No tool returns policy internals, seeds, tokens or database handles. Errors use stable codes (`INVALID_INPUT`, `UNKNOWN_TOOL`, `TOOL_CALL_LIMIT`, `PAYMENT_LIMIT_PER_RUN`, `GUARD_UNAVAILABLE`, `GUARD_TIMEOUT`, `RATE_LIMITED`, `GUARD_REJECTED`, `RUN_TIMEOUT`, `INTERNAL`).

## Decision log
1. Tool names are the spec 7.2.D names. The brief's `list_payable_invoices` and `check_invoice_eligibility` do not exist in the spec; eligibility is the read-only preview inside the list and details tools.
2. The MCP server uses the SDK's low-level `Server` with our own dispatch table and strict zod schemas, because `McpServer.registerTool` strips unknown keys instead of rejecting them. The SDK is pinned exactly.
3. Real runs spawn the tool server as a child over stdio with a minimal explicit environment. Unit tests use the SDK in-memory transport against the same server factory.
4. The Anthropic adapter uses `fetch` against a fixed host, with no extra SDK. No model id is hardcoded; `AI_MODEL` is required in llm mode.
5. Agent environment isolation: `config.ts` refuses to start if `DATABASE_URL`, `GUARD_DATABASE_URL`, any `*SEED*`, `OWNER_TREASURY_MASTER_SEED`, `*SERVICE_ROLE*`, `SUPABASE_*`, `PAYMENT_EXECUTION_ENABLED`, `DEMO_OWNER_PASSWORD` or `*PRIVATE_KEY*` is present (names only in the error). The launcher builds a clean child environment from an allowlist. The tool-server child never gets `AI_API_KEY`.
6. The guard resolves the business (pinned `GUARD_BUSINESS_ID`, else the sole business, else 503). The agent never sends a business id.
7. Deterministic rule: among open invoices whose preview says `eligible`, pick the earliest `due_date`, then the smallest amount (exact decimal compare, no floats), then `invoice_number`, then `id`. If none is eligible the run ends `no_candidate` and no payment is requested. The CLI flag `--probe-ineligible` (not an env var) makes the run request the earliest-due ineligible invoice so the guard visibly blocks it (used by the blocked demo).
8. The reason string is a template built from dates, counts and amounts only (no untrusted text), at most 280 characters.
9. Idempotency key is `agent-` plus the first 40 hex characters of `sha256("<run_id>|<invoice_id>")`. A retried run cannot double pay. The tool client retries once on network error or timeout only; never on a guard decision, 4xx, 409 or 429.
10. A blocked or final decision ends the run. The agent never re-requests payment in the same run. Bounds (5 tool calls, 1 payment request) are enforced in both the loop and the tool server.
11. An intent event is appended before the payment request. If that append fails the payment is not requested (fail closed). Events store small projections (ids, codes, amounts), never raw invoice descriptions or supplier names.
12. Run states: `running`, `paid`, `pending`, `blocked`, `no_candidate`, `failed`, `timed_out`, `limit_exceeded`, `interrupted`. Terminal states are immutable (trigger). Only the guard sweeper sets `interrupted`.
13. LLM fallback: `AGENT_MODE=llm` without a key or model exits with code 2 and a clear message. A provider outage (network, 5xx, 429, timeout) before any payment request falls back to deterministic mode, is logged, recorded as a `mode_fallback` event and shown as the effective mode. A 401/403 fails the run and does not fall back.
14. Concurrency: a partial unique index on `agent_runs(business_id) WHERE status='running'` is the guard-side lock (`409 RUN_IN_PROGRESS`), plus an in-process overlap flag in the scheduler. The sweeper marks runs with no activity for `AGENT_RUN_STALE_SECONDS` (guard env, default 180, range 120..3600: the floor sits above the 55 s payment wait) as `interrupted`.
15. Rate limit: a full run uses about 14 guard requests, under the guard default of 30 per minute; a test asserts at most 20. A 429 surfaces as `RATE_LIMITED` with no retry.

## Limits and bounds
`AGENT_MAX_TOOL_CALLS` 5 (1..5), `AGENT_MAX_PAYMENTS_PER_RUN` 1, `AGENT_REASON_MAX_CHARS` 280, `AGENT_RUN_TIMEOUT_SECONDS` 60 (5..120), `AGENT_SCHEDULE_INTERVAL_MINUTES` empty (disabled; 1..1440). Guard response cap 256 KB, redirects refused, guard URL restricted to loopback http or https. At most 32 events per run, 8 KB per event payload.

## Guard endpoints and migration 0007
- Read (agent token): `GET /internal/snapshot`, `GET /internal/invoices?limit=`, `GET /internal/invoices/:id`; existing payment status routes now return `decision_code`.
- Run records (agent token, append only): create, append event, finish. No GET, PATCH or DELETE for runs on the agent surface. Create and finish write `agent.run_started` / `agent.run_finished` audit events; the sweeper writes `agent.run_interrupted`.
- `0007_agent_runs.sql` extends `agent_runs` (seq, effective_mode, payment_id, decision_code, agent_reason, last_activity_at, status check, one-running-per-business index), adds `agent_run_events` (append-only, seq 1..32, immutable by trigger), grants `flow_guard` SELECT/INSERT (columnar UPDATE on runs only) and `flow_web` SELECT only, with RLS enabled and forced.

## How to run
```bash
pnpm db:up
pnpm db:migrate -- --local
pnpm db:seed:demo
pnpm guard:dev -- --business <business-uuid>      # add --enable-execution only for a real payment
pnpm agent:run                                    # one run (deterministic)
pnpm agent:run -- --record                        # also writes a secret-free transcript to docs/demo/
pnpm agent:run -- --probe-ineligible              # request the earliest-due ineligible invoice; the guard blocks it
pnpm agent:run -- --schedule                      # interval trigger when AGENT_SCHEDULE_INTERVAL_MINUTES is set
pnpm dev:web                                      # open /agent (owner login) to see the runs
```
Switch to LLM mode: put `AGENT_MODE=llm`, `AI_MODEL=<model id from the provider docs>` and `AI_API_KEY=<key>` in the local gitignored `.env`. No code change is needed. The launcher reads only those allowlisted names from `.env`, in memory.

## Real payment status
The treasury held exactly 5 RLUSD at the time of M5 (after the M3 payment), below the 6 RLUSD gate. The real agent payment was therefore SKIPPED and no RLUSD was spent. The read-only gate is `pnpm agent:demo -- --check-treasury`. A genuine blocked run against the real guard (kill switch off, live Testnet reads, nothing submitted) is recorded in `docs/demo/` (`status: blocked`, `decision_code: EXECUTION_DISABLED`, no `tx_hash`). The full paid flow (paid with validated hash, audit chain intact, one payment per run, concurrency, crash recovery) is verified against the fake XRPL gateway in `pnpm test:db`.
Pending: claim 10 RLUSD at https://tryrlusd.com/ for the treasury address and forward it so the balance is at least 6. Then run once: `pnpm agent:demo -- --enable-execution`. The script refuses unless that flag is given, the balance is at least 6 and the balance after the payment stays at least 5, and it uses a single-use file `.secrets/m5-agent-demo.json` so it cannot run twice.

## Spec v3.5 clarifications
None were made. `Flow_AI_MVP_README_v3.5.md` and v3.0 are unchanged. Candidates for a later clarification: `get_payment_status` accepts `invoice_id`; `list_open_invoices` item shape; pending (202) handling; `AGENT_RUN_STALE_SECONDS`.
Other doc edits: `docs/secure-coding-standards.md` AG-2 now names the five spec tools instead of the earlier shorthand list (no rule was weakened).

## Review fixes (M-1, M-2, L-1 to L-4)
- M-1: the guard records each payment request it serves for a running run (`agent_run_payment_requests`, migration 0008) and derives the stored run outcome from it and the live payments table. The agent only sends an untrusted `client_status`; a paid/pending/blocked claim with no recorded request is stored as `failed`. Payment ids from another run or business get 400; a second finish is 409. The web page shows "Paid" only for a validated payment.
- M-2: tool errors are `isError` with text only, so the SDK client does not validate them against `outputSchema`. `apps/agent/test/mcp-sdk-errors.test.ts` covers this with the real SDK client.
- L-1: the agent env guard is an allowlist; secret- or database-looking names fail startup (name only in the message).
- L-2: `AI_API_KEY` is dropped outside `AGENT_MODE=llm` with a name-only warning.
- L-3: `AGENT_RUN_STALE_SECONDS` has a floor of 120.
- L-4: test databases are tagged per run and dropped by tag and exact name pattern at teardown; the property test keeps its seeds and iterations with a 120 s timeout.

## Verification record (final run, this working tree, nothing committed)
| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass, lockfile up to date |
| `pnpm typecheck` | pass, all workspace projects plus root |
| `pnpm lint` (`--max-warnings 0`) | pass, 0 warnings |
| `pnpm test` | pass, 851 tests: contracts 87, xrpl-adapter 62, policy-engine 172, database 18, payment-guard 137, web 145, agent 230 |
| `pnpm test:db` (Docker Postgres) | pass, 224 tests: database 70, web 48, agent 17, payment-guard 89 |
| `pnpm secret-scan` | PASS (306 file versions) |
| `pnpm run audit` (`pnpm audit --prod`) | No known vulnerabilities found |
| Count-only script over tracked and untracked files | treasury/supplier seeds, demo owner password, guard dev token (6 values checked): 0 files; API-key patterns (`sk-ant-`, `sk-`, `AIza`): 0; family-seed-shaped strings: 0. Values were never printed |

## Unverified
- The Anthropic model id (no value is set anywhere) and the `anthropic-version` header value (`2023-06-01`) and response shape against the live API.
- Live LLM behaviour (the LLM path was tested only with a fake model, including a model that obeys prompt injection).
- A single shared agent token (rotation supported by `AGENT_TO_PAYMENT_GUARD_TOKEN_NEXT`, no per-run scoping).
- MCP SDK stdio behaviour on Windows beyond the tests that ran.
- The paid agent run on Testnet (pending the faucet top-up above).
- Web accessibility of the new page: automated jsdom checks only, no real-browser or formal WCAG audit.
