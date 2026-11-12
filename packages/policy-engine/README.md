# @flow-ai/policy-engine

Pure, deterministic payment eligibility engine (spec 6.3, 6.4, 9.3). No I/O, no clock, no randomness, no network. The payment guard resolves every fact from canonical records and the live ledger, passes it in, and gets back one structured decision. The same function powers the read-only preview (9.5).

Money is decimal-safe: canonical strings parsed with `decimal.js` (isolated clone), at most 12 integer and 6 fractional digits. No JS floats. XRP is handled as integer drops with `bigint`.

## API

```ts
import { evaluatePolicy } from "@flow-ai/policy-engine";
const decision = evaluatePolicy(input); // input: unknown, validated against PolicyEvaluationRequestSchema
```

- `evaluatePolicy(input: unknown): PolicyDecision` never throws. Malformed input blocks with `INVALID_REQUEST`; an unexpected error blocks with `INTERNAL_ERROR`.
- Schemas and types live in `@flow-ai/contracts`: `PolicyEvaluationRequestSchema`, `PolicyDecisionSchema`, `TreasuryPolicySchema`, `DECISION_CODES`, `CHECK_IDS`.
- `scaleDemoFixture(balance)` applies the 13A scaling rule. `parseMoney`, `businessDate`, `parseInstant` are exported helpers.

Decision fields: `allowed`, `decision_code` (`ALLOWED` or the first failed check's code), `failure_code`, `message`, `failed_check`, `failed_checks` (all failures, in order), `checks_passed`, `checks_skipped`, `policy_version`, `evaluated_at`, and `payment` (only on allow: canonical amount, destination, asset, network and the `business_date` to reserve against).

Inputs the caller must supply: `now` (ISO instant), `kill_switch_value` (raw `PAYMENT_EXECUTION_ENABLED`), business (with `timezone`), wallet, policy, invoice, supplier (`is_approved`, `is_active`), config (network, RLUSD hex, issuer, symbol), live balances, ledger reserves and fee (drops), destination trust-line state, `daily_spend_reservations` rows and existing payments. Approval comes from `suppliers.is_approved` and the timezone from `businesses.timezone`, never from the policy.

## Check order

All checks always run, in this order. The first failure is the primary decision.

| # | Check id | Code on failure | Spec |
|---|---|---|---|
| 1 | `automation_enabled` | `AUTOMATION_PAUSED` | 6.3 #1 |
| 2 | `execution_switch` (exact string `true` only) | `EXECUTION_DISABLED` | 6.3 #1, 13.1C |
| 3 | `mandate_valid` (`now >= valid_until` or unreadable blocks) | `MANDATE_EXPIRED` | 6.3 #1 |
| 4 | `records_active` (business, wallet) | `RECORD_INACTIVE` | 6.3 #2 |
| 5 | `invoice_belongs_to_business` | `INVOICE_NOT_FOUND` | 6.3 #3 |
| 6 | `records_consistent` | `RECORD_MISMATCH` | 6.3 #2-3 |
| 7 | `invoice_payable` | `INVOICE_NOT_PAYABLE`, `PAYMENT_ALREADY_IN_PROGRESS` | 6.3 #3 |
| 8 | `request_matches_canonical` | `REQUEST_MISMATCH` | 13.1A |
| 9 | `supplier_active` | `SUPPLIER_INACTIVE` | 6.3 #2 |
| 10 | `supplier_approved` | `SUPPLIER_NOT_APPROVED` | 6.3 #4 |
| 11 | `destination_valid` | `INVALID_DESTINATION` | 6.3 #5 |
| 12 | `destination_not_treasury` | `INVALID_DESTINATION` | 6.3 #5 |
| 13 | `amount_valid` | `INVALID_AMOUNT` | 6.3 #6 |
| 14 | `per_payment_limit` (equal passes) | `PAYMENT_LIMIT_EXCEEDED` | 6.3 #6 |
| 15 | `asset_allowed` (symbol and currency/issuer pair) | `ASSET_NOT_ALLOWED` | 6.3 #6 |
| 16 | `sufficient_rlusd_balance` | `INSUFFICIENT_RLUSD_BALANCE`, `BALANCE_UNAVAILABLE` | 6.3 #7 |
| 17 | `minimum_reserve` (remaining >= reserve passes) | `MINIMUM_RESERVE_BREACHED` | 6.3 #8 |
| 18 | `daily_spend_limit` (reserved + committed today + amount <= limit) | `DAILY_LIMIT_EXCEEDED` | 6.3 #9, 6.4 |
| 19 | `not_duplicate_request` | `DUPLICATE_REQUEST` | 6.3 #10 |
| 20 | `no_payment_in_progress` | `PAYMENT_ALREADY_IN_PROGRESS` | 6.3 #10 |
| 21 | `network_allowed` (testnet only, configured pair, Mainnet issuer denied) | `NETWORK_NOT_ALLOWED` | 6.3 #11 |
| 22 | `destination_trustline` (unknown blocks) | `MISSING_RLUSD_TRUSTLINE` | 6.3 #12 |
| 23 | `xrpl_reserve` (balance >= base + owner_count * owner + fee) | `XRPL_RESERVE_INSUFFICIENT` | 6.3 #12 |

Checks that need a valid amount or balance are reported in `checks_skipped` when that value is invalid; the invalid value itself already fails its own check.

Run tests with `pnpm test` from the repo root (or `pnpm --filter @flow-ai/policy-engine test`). See `docs/m2-notes.md` for interpretation decisions.
