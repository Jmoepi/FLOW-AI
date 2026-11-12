# M2 notes: pure policy engine

Scope: `packages/contracts` (zod schemas) and `packages/policy-engine` only. M1 (real RLUSD transfer, blocked on the user's faucet claim), guard, database, API, agent and UI are untouched. Nothing was committed (per instruction).

## Versions added (exact pins)
`decimal.js` 10.6.0, `ripple-address-codec` 5.0.1 (classic-address checksum validation, pure), `zod` 4.6.7, `vitest` 5.1.0. Root `pnpm test` runs `pnpm -r --if-present test`.

## Interpretation decisions (safest, blocking reading)
1. **Money format.** Strings only, at most 12 integer and 6 fractional digits, no sign, exponent, whitespace or leading zeros. JS numbers (including NaN) are rejected. "Excessive precision" is defined as more than 6 decimals; the spec gives no number.
2. **Mandate expiry.** `now >= valid_until` blocks (the instant of expiry is already expired). An unparseable `valid_until` blocks as `MANDATE_EXPIRED`.
3. **Kill switch.** Only the exact string `"true"` passes; `"TRUE"`, booleans, whitespace and missing values block (13.1C).
4. **Check order inside spec item 1.** Enabled, kill switch, mandate, as listed in 6.3. All checks run and are reported; the first failure is the primary code.
5. **`blocked` invoices stay re-evaluable.** 5A.1 says `blocked` returns to `open` on the next passing preview; refusing it would make that impossible. In-flight protection comes from the `payments` list and the `processing` status (`PAYMENT_ALREADY_IN_PROGRESS`). A validated payment for the invoice blocks with `INVOICE_NOT_PAYABLE`.
6. **Supplier active.** The `suppliers` table (8.1) has no `is_active` column, yet 6.3 #2 requires active supplier records. The engine takes `supplier.is_active` as a required input; the guard must derive it. **Resolved in v3.5:** 8.1 now has `suppliers.is_active` (default true), separate from `is_approved`.
7. **Agent claims.** 13.1A says the guard ignores model-supplied amount/destination; the payment is built only from canonical records. Unknown request keys are stripped. If optional `claimed_amount` or `claimed_destination` are present and disagree with the records, the engine blocks (`REQUEST_MISMATCH`) rather than silently ignoring. This is stricter than "ignore".
8. **`agent_reason` over 280 characters** is rejected (`INVALID_REQUEST`), not truncated (14.1 allows either).
9. **Daily window.** Rows are matched on `business_date` equal to the date of `now` in `businesses.timezone`. `reserved` and `committed` count; only `released` is excluded. Africa/Johannesburg has no DST; the engine uses `Intl` with the supplied IANA zone, so other zones also work. An unknown timezone blocks.
10. **Unknown or unavailable facts block:** live RLUSD balance (`BALANCE_UNAVAILABLE`), XRP balance, destination trust line `unknown`, malformed request (`INVALID_REQUEST`), any thrown error (`INTERNAL_ERROR`).
11. **Network (6.3 #11).** The configured pair is input, not hardcoded, but the Mainnet issuer from m0-notes is denied explicitly and the wallet asset must equal the configured pair. Asset check compares the pair; currency hex is case-insensitive, issuer exact.
12. **Duplicates (6.3 #10).** Any payment with the same idempotency key blocks with `DUPLICATE_REQUEST` and returns the existing payment id/status in `details` (the guard returns existing state). Active payments (`requested`, `reserved`, `submitted`, `pending_confirmation`) on the invoice block with `PAYMENT_ALREADY_IN_PROGRESS`. Idempotency in the database remains the guard's job (14.2).
13. **Extra decision codes** not in 9.3: `INVALID_REQUEST`, `INVALID_AMOUNT`, `SUPPLIER_INACTIVE`, `RECORD_INACTIVE`, `RECORD_MISMATCH`, `REQUEST_MISMATCH`, `BALANCE_UNAVAILABLE`, `INTERNAL_ERROR`. They are now listed in v3.5 section 9.3. `INTERNAL_ERROR` is covered by a throwing-getter test (and `bestEffortVersion` no longer lets a throwing getter escape). `XRPL_SUBMISSION_FAILED`, `PARTIAL_DELIVERY`, `VALIDATION_PENDING` are in the enum but never emitted by the pure engine.
14. **XRP sufficiency.** Required drops = base reserve + owner reserve x owner count + estimated fee, all inputs. The spec does not say whether the destination's XRP reserve is checked; it is not (the destination trust line check covers receivability).
15. **13A numbers.** The spec's fixture is 120 / 275 / 90 / 800 / 60. The brief's "12 / 27.5 / 9 / 80" are the same cases scaled to a 100 RLUSD balance and are tested via `scaleDemoFixture("100")`. Scaling can change outcomes at very small balances because of cent rounding; tests cover 100 to 10,000. 13A should state a minimum supported balance.

## Spec items touching 19.2 (unverified, unchanged by M2)
Issuer, currency hex, faucet amount and supplier trust-line behaviour remain unverified until M1. The engine takes them as configuration and proves nothing about the ledger.

## Test coverage summary (169 tests, 5 files)
- `money.test.ts`: parser rejects negative, zero, NaN, Infinity, exponent, signs, whitespace, over-precision, non-strings; exact 0.1 + 0.2 and 6-decimal arithmetic.
- `time.test.ts`: Johannesburg rollover at 22:00 UTC, no DST shift (Jan/Jul), year and leap-day edges, offsets, strict instant parsing (found and fixed `Date.parse` rolling Feb 30 over).
- `checks.test.ts`: every 14.1 bullet (cap equal passes, one micro-unit over blocks; daily cap with committed and reserved, released ignored, exact boundary, rollover; reserve floor boundary; unapproved supplier; asset not allowed; expired mandate; paused automation; kill switch missing/malformed/non-`true`; agent payload cannot override amount/destination; policy version recorded; `agent_reason` 280/281; `country_code` has no effect), plus destination validity, treasury-as-destination, network/Mainnet issuer, record state, duplicates and in-progress payments, trust line, XRP reserve boundary (one drop), reserves above 2^53.
- `fixture.test.ts`: all five 13A invoices with expected codes, INV-101 + INV-105 same day, daily cap, scaling at 7 balances including 100, 333.33 and 10,000.
- `property.test.ts`: 4 seeds x 3000 randomised cases against an independent bigint oracle (never allows a cap or reserve breach; also agrees exactly in both directions), plus 500 cases showing no closed gate is ever bypassed.
- Not covered here (later milestones): database locking and concurrent reservations (14.2), live ledger reads, signing.

## What was run
- `pnpm install`: OK.
- `pnpm typecheck` (root plus all workspaces, strict, including the new tests): PASS.
- `pnpm test`: 5 files, 169 tests PASS.
- `pnpm secret-scan`: PASS (61 files).
- `pnpm lint`: not present in this repo, not run.
