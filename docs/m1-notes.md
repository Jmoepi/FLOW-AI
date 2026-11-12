# M1 notes: first real, validated RLUSD payments from a script

**Status: DONE.** Two real RLUSD payments validated on XRPL Testnet, each `tesSUCCESS` with `delivered_amount` equal to the intended amount and an exact balance delta on both sides. Testnet only. No seed appears in this file, the log or the code.

## What was built
- `packages/xrpl-adapter` (spec 10.3 flow). Pinned deps: `xrpl` 5.3.0, `decimal.js` 10.6.0, `vitest` 5.1.0 (dev).
  - `gateway.ts`: `XrplGateway` (connect with 10 s connect / 20 s request timeouts, 3 connect retries with backoff, reconnect-on-use). `XrplGateway.connect` refuses unless `XRPL_NETWORK` is exactly `xrpl-testnet`, the URL exactly matches the Testnet allowlist (`wss://s.altnet.rippletest.net:51233`; hardened after the security review, see `docs/security-review.md`) and `server_info.network_id === 1`. The send path re-checks `network_id` (10.1).
  - `amount.ts`: decimal-safe amounts (strings only, max 6 decimals, no numbers/exponents/zero). `delivered_amount` is compared as a decimal, currency hex case-insensitive, issuer exact.
  - `payment.ts`: `prepareAndSign` (autofill, explicit `LastLedgerSequence` if missing, window check, refuses `tfPartialPayment`/`SendMax`/`DeliverMin`; no `Flags` are ever set), `onSigned` hook that runs after signing and before submit (a throwing hook aborts, nothing submitted), `submitAndWait`, `reconcilePayment`, `sendIouPayment`.
  - `queue.ts`: `KeyedQueue` per sending account. The lock is held from autofill until the payment reaches a final outcome (or the wait times out), so two sends can never share a Sequence.
- `scripts/m1-send-rlusd.ts`, run as `pnpm m1:send`. Flags: `--dry-run`, `--to cross-border|domestic|extra`, `--amount` (capped), `--resume <runId>`.
- Append-only log `.secrets/m1-transactions.json` (confirmed gitignored via `.gitignore:5 .secrets/`). Each state transition is a new entry. It holds hashes, `LastLedgerSequence` and, for real runs, the signed blob (for safe resubmission). Dry runs do not store the blob. After the security hardening: a `final` entry is written only for a settled outcome (a still-pending `--resume` no longer logs `final`), the file is created owner-only, and a single-writer lock (`.secrets/m1-transactions.lock`, stale locks from dead PIDs are cleared) prevents concurrent runs from racing the budget check. CLI arguments are validated strictly (`--resume` needs a UUID, `--to` is an enum, no duplicates). The payment flow and policy results are unchanged.

## Outcome classes
| Class | Condition |
|---|---|
| `validated_success` | `validated: true`, `tesSUCCESS`, `meta.delivered_amount` equals currency + issuer + value |
| `validated_failed` | validated `tec*`; fee burned, fee recorded |
| `partial_delivery` | validated `tesSUCCESS` but delivered_amount differs or is missing; never treated as paid |
| `pending` | anything else, including submit errors and a tx not yet found while `LastLedgerSequence` is still ahead |
| `failed_expired` | a validated ledger index greater than `LastLedgerSequence` was read before the `tx` lookup and the tx is in no validated ledger |

Idempotency: `submitAndWait` looks up the persisted hash first. If it is already validated, or the window is over, or the server already knows the tx, it does not submit. Only an identical blob is ever resubmitted, and only while `LastLedgerSequence` is in the future. Submit tem/tef/ter results are not treated as definitive (10.3 step 12): they stay `pending` until the expiry rule applies.

## M1 safety limits in the script
Amount at most 2 RLUSD (default 1), treasury must keep at least 5 RLUSD after the send, at most 2 real signed payments across all runs (counted from the log), and a new real run is refused while an earlier one has no final outcome. After the two payments, a third attempt (`--to extra`) was refused: `Refusing: M1 budget used (2/2 real payments signed)`.

## Real payments (Testnet)
Treasury `rHwNC93iYF7ZcSpZJbVZiwLmpiCKauoHuo`. RLUSD issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`, currency hex `524C555344000000000000000000000000000000`. 1 RLUSD each, fee 12 drops each, engine result `tesSUCCESS` on submit.

| # | To | Hash | Sequence | LastLedgerSequence | Validated ledger | Result | delivered_amount |
|---|---|---|---:|---:|---:|---|---|
| 1 | cross-border `rpc4DFfxB6aXkbEPJTAGXLG4oZQuWpTXnT` | `378C17FB41E8871043A980C4D1A5772F78B140E4800F36C8AFCE5AAE19225ACD` | 22236911 | 22277647 | 22277629 | `tesSUCCESS` | 1 RLUSD (exact currency + issuer) |
| 2 | domestic `rNRXXz44CVbkCKxjAhrv5q83NgzDMHm4Af` | `7ED0B403DC006B9560AE2992AE75C7040C8DDBA03C6C560B96A0D36B0ED9852B` | 22236912 | 22277653 | 22277636 | `tesSUCCESS` | 1 RLUSD (exact currency + issuer) |

Explorer:
- https://testnet.xrpl.org/transactions/378C17FB41E8871043A980C4D1A5772F78B140E4800F36C8AFCE5AAE19225ACD
- https://testnet.xrpl.org/transactions/7ED0B403DC006B9560AE2992AE75C7040C8DDBA03C6C560B96A0D36B0ED9852B

Balances (validated ledger, `account_lines`, exact decimals):
| # | Sender before | Sender after | Receiver before | Receiver after |
|---|---:|---:|---:|---:|
| 1 | 8 | 7 (delta -1) | 0 | 1 (delta +1) |
| 2 | 7 | 6 (delta -1) | 0 | 1 (delta +1) |

The script printed `Balance delta PROVEN` for both. I did not open the explorer pages in a browser; the validated result comes from the `tx` and `account_lines` responses. Post-run `pnpm preflight`: PASS, treasury 6 RLUSD, 109.999964 XRP.

The dry run (run `4ffc11d1`) signed hash `BC250DC36E61F1EB23AF94E8A989AC3ADAB400BD478B9C05A5D3B6B4B371042F` and submitted nothing; that hash is not on the ledger.

## 19.2 items resolved by M1
- **Supplier trust-line receive behaviour: proven.** Both scripted supplier accounts (cross-border, domestic) received RLUSD through their scripted trust lines. The issuer has no `RequireAuth` or `GlobalFreeze`. The extra supplier was not paid (budget) but has the same trust-line setup.
- **Issuer + currency hex pair: proven** by a real issued-token payment that delivered exactly the configured currency and issuer.

## What was run and the results
- `pnpm --filter @flow-ai/xrpl-adapter test`: 26 tests passed (one file). Cases: validated success, validated `tec`, partial delivery (wrong value, missing, wrong issuer), uncertain then validated, found-but-not-validated stays pending, not-found inside the window stays pending, expired and not found -> `failed_expired`, strict `>` boundary at `LastLedgerSequence`, submit error treated as uncertain, dry run never submits, failing persist hook aborts before submit, `tfPartialPayment` refused, no Flags on the built tx, network_id != 1 refused, non-Testnet config refused, duplicate-submit (already validated, expired, already seen: no submit; two resumes of one blob submit once), per-wallet serialisation (three concurrent sends, max one in flight, distinct Sequences), a failed task does not block the queue. Tests use a mocked gateway and spend no RLUSD.
- `pnpm m1:send -- --dry-run`: signed, logged, nothing submitted.
- `pnpm m1:send` and `pnpm m1:send -- --to domestic`: validated as above.
- `pnpm m1:send -- --to extra`: refused by the budget guard (expected).
- `pnpm typecheck`, `pnpm test`, `pnpm secret-scan` and a search for the seed strings outside `.secrets`: see the final section.

## Not covered / caveats
- The reconcile and expiry logic is proven by mocks only; no real Testnet tx expired. The `tx` lookup does not pass a ledger range, so "not found" relies on the server having complete history for the recent ledgers (true for the public Testnet server used here, not checked via `complete_ledgers`).
- Single-process queue only. Multiple guard processes would need a DB-level lock (M3).
- The log is a local JSON file, not the M3 database. The adapter exposes the hook (`onSigned`) the guard will use to persist.
- Treasury now holds 6 RLUSD. The faucet gives 10 RLUSD per claim per 24 h per account, so a fixture scaled to 10 RLUSD needs a fresh claim before the demo (or `reset-demo`).

## Final verification
- `pnpm typecheck`: PASS (root scripts plus all workspaces, strict).
- `pnpm test`: PASS. xrpl-adapter 26 tests, policy-engine 172 tests.
- `pnpm secret-scan`: PASS (70 files).
- Seed search: every seed in `.secrets/testnet-wallets.json` was searched for in all 71 files outside `.secrets`, `node_modules` and `.git`: 0 hits.
- Nothing was committed or pushed in this task.
