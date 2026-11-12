# Flow AI

Flow AI is an autonomous AI agent that pays supplier invoices in RLUSD on XRPL Testnet, within limits the business owner sets and an independent payment guard enforces. The target user is an importer who pays both cross-border and domestic suppliers. The agent chooses which eligible invoice to process next. The guard decides whether the payment is allowed and signs it only when every rule passes.

This is a hackathon MVP (Agentic Finance track). It runs on XRPL Testnet only, is not production software, and is not financial advice.

## Status

| Milestone | Scope | State |
|---|---|---|
| M0 | Preflight: repo, strict TypeScript, env template, secret scan, Testnet accounts, trust lines | Done, except the manual RLUSD claim. Treasury RLUSD balance was 0 at last check |
| M1 | One real RLUSD payment from a script | Blocked on the RLUSD claim |
| M2 | Pure policy engine | Done. 169 tests in 5 files (per `docs/m2-notes.md`) |
| M3 | Payment guard with persistence | Not started |
| M4 | Owner policy API and page, audit events | Not started |
| M5 | Agent plus MCP tools | Not started |
| M6 | Dashboard screens and deployed URL | Not started |
| M7 | Revocable regular-key backstop | Not started |
| M8 | Demo hardening, video, threat model | Not started |

The hosting decision for the deployed demo URL has not been made.

## Architecture

Three processes and four packages, each process with its own credentials.

```text
 owner --> web (dashboard + app API) --> payment-guard (policy + signer) --> XRPL Testnet
                                              ^
                    agent (LLM loop) --MCP tools
```

- `apps/web`: dashboard and authenticated app API.
- `apps/payment-guard`: policy service and signer module. The only process that holds a signing key.
- `apps/agent`: agent loop and MCP tools. No database credential, no signer.
- Packages: `contracts` (shared Zod schemas), `database`, `xrpl-adapter`, `policy-engine`.

Trust boundary: the agent never holds keys or policy. It can only ask the guard to pay an invoice. The guard rebuilds the payment from its own canonical records, ignoring any amount or destination the model supplies, runs the policy checks, and signs only on an allow decision. The owner sets limits outside the agent. The enforcement is application-layer, not a trustless on-ledger restriction. The spec adds a revocable regular key (M7) as an on-ledger backstop that lets the owner cut off the guard's signing authority.

Apart from `packages/contracts` and `packages/policy-engine`, the apps and packages are typechecked placeholders so far.

## Repo layout

```text
apps/            web, payment-guard, agent
packages/        contracts, database, xrpl-adapter, policy-engine
scripts/         secret-scan, setup-testnet-accounts, trust-lines, preflight
docs/            m0-notes.md, m2-notes.md, task1-changes.md
Flow_AI_MVP_README_v3.5.md   spec of record
.env.example     environment template (placeholders only)
```

## Getting started

Prerequisites: Node 20.19 or newer (`engines`; M0 ran on Node 24.17.0) and pnpm 11.8.0 (`packageManager`).

```bash
pnpm install
cp .env.example .env        # fill in values; .env is gitignored
```

Scripts:

- `pnpm setup:testnet-accounts`: creates and faucet-funds the treasury and three supplier wallets. Seeds go to `.secrets/testnet-wallets.json`. Safe to rerun.
- `pnpm trust-lines`: creates the RLUSD trust lines for those accounts. Skips ones that exist.
- `pnpm preflight`: read-only check of network, issuer, currency hex, reserves, trust lines and treasury RLUSD balance. It exits non-zero (2, BLOCKED) until the treasury holds RLUSD.
- `pnpm secret-scan`: scans for seed-shaped secrets without printing matches.
- `pnpm typecheck`: strict TypeScript across the root and all workspaces.
- `pnpm test`: runs workspace tests (the policy engine suite).

RLUSD claim (manual): open https://tryrlusd.com/, choose Testnet, and claim for the treasury address `rHwNC93iYF7ZcSpZJbVZiwLmpiCKauoHuo`. Then run `pnpm preflight` and expect `PREFLIGHT: PASS`. Record the amount received in `docs/m0-notes.md`.

## Security notes

- Testnet only. The scripts fail closed on any other network value, and the Mainnet RLUSD issuer must never be used.
- Seeds live only in the gitignored `.secrets/` folder. Never commit `.env`; `.env.example` holds placeholders only.
- `PAYMENT_EXECUTION_ENABLED` is a kill switch: execution is allowed only when it is exactly `true`.
- Secret scan: the repo has no versioned hook. A local, unversioned hook exists at `.git/hooks/pre-commit` on the M0 machine and runs `pnpm secret-scan`, blocking the commit on failure. On a fresh clone, create that file yourself (a bash script that changes to the repo root, runs `pnpm secret-scan`, and exits 1 on failure) and make it executable.

## Documentation and resources

- Spec: [Flow_AI_MVP_README_v3.5.md](Flow_AI_MVP_README_v3.5.md)
- Notes: [docs/m0-notes.md](docs/m0-notes.md), [docs/m2-notes.md](docs/m2-notes.md), [packages/policy-engine/README.md](packages/policy-engine/README.md)
- RLUSD on the XRPL (Ripple docs): https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl
- Send a trust line token: https://xrpl.org/docs/tutorials/payments/send-a-trust-line-token
- xrpl.js: https://js.xrpl.org/
- Testnet explorer: https://testnet.xrpl.org/
- MCP specification: https://modelcontextprotocol.io/specification/

## Judging criteria

- Product design: owner-facing limits, a plain-language agent explanation per decision, and a dashboard (M6, not built yet).
- Technical: independent guard, pure tested policy engine, and Testnet payments with validated results (M1 onward).
- Business fit: importers paying suppliers across African borders; the spec frames cost and speed advantages as hypotheses to validate.
