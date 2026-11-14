# M7 notes: revocable regular-key backstop

Scope: spec 10.6 to 10.8, 13.3, section 15 M7 row, section 16 step 8. Testnet only. Multi-sign SignerList stays P2 and is not built.

## What was built

- Owner scripts (run locally by the owner, never deployed): `pnpm owner:set-regular-key`, `pnpm owner:revoke-regular-key`, `pnpm owner:status-key`.
  - The treasury MASTER seed is read inside the script only (`OWNER_TREASURY_MASTER_SEED` from the process environment, otherwise the `treasury` entry of the gitignored `.secrets/testnet-wallets.json`), checked against the recorded treasury address, used for one signature and never printed, logged or written.
  - Testnet only: `loadConfig()` plus the adapter's network_id 1 assertion. A subcommand is required. Without `--confirm` the script is a dry run that submits nothing.
  - `set` generates a fresh keypair, writes its seed ONLY to `.secrets/guard-regular-key.env` (checked with `git check-ignore`, mode 0600, written to a `.pending` file before the submit and renamed after a validated `tesSUCCESS`). It refuses to overwrite an existing regular key without `--rotate`.
  - `revoke` submits `SetRegularKey` with no `RegularKey` field and moves the old key file to `.secrets/guard-regular-key.revoked.env`.
  - `status` is read-only and never reads a seed. It prints the ledger RegularKey, whether the master key is enabled and the balances.
  - The master key is never disabled. Only `SetRegularKey` is ever built, `assertSetRegularKeyOnly` runs immediately before signing and refuses any other type or field, and a source scan test fails if `asfDisableMaster`, an `AccountSet` type, `SetFlag` or `ClearFlag` appears in `scripts/`, `apps/*/src` or `packages/*/src`. The only mention of the flag bit is a read-only constant used to REPORT `lsfDisableMaster`.
  - Validated-result semantics come from the adapter (`submitAccountTxAndWait`): success only for a validated `tesSUCCESS`; a validated `tec` is failure; a `tef`/`tem` ack is a rejection; expiry only with proven history.
- Guard signer (`apps/payment-guard/src/signer/signer.ts`, still the only file that names the seed variables): when `XRPL_REGULAR_KEY_SEED` is present it signs with that key (Account stays the treasury, `SigningPubKey` is the regular key) and `XRPL_DEMO_SIGNER_SEED` is never read. The typed Payment-only, field allowlist, amount, destination and fee checks, the kill switch and the Testnet check are unchanged. A "regular key" that derives to the treasury address is refused.
- Rejection handling: the adapter returns `rejected_authorization` when the submit ack is in `SIGNING_KEY_REJECTION_CODES` (`tefBAD_AUTH`). The payment becomes `FAILED` with the dedicated code `SIGNING_KEY_REVOKED`, the reservation is released, the invoice reopens, and the audit event `payment.signing_key_revoked` is written. The guard then marks the wallet `revoked` (persisted, so it survives a restart), writes `signing_key.revoked` and blocks all further execution through the same fail-closed path as a broken audit chain (new requests are blocked with `EXECUTION_DISABLED`; reserved but unsigned payments are cancelled with `SIGNING_KEY_REVOKED`). The same flip happens when the reconciler's resubmit of a pending payment is refused. The blocked state holds whatever the environment: a guard restarted with only the master seed stays blocked until a restore (the configured regular key is seen registered again after the rejected blob expired).
- Visibility: `/readyz` returns 503 `degraded` with `signing_key: "revoked"`; `/internal/status` carries `signing_key`; the owner overview has a "Guard signing key" panel (icon plus text, an alert when revoked) with the revoke instruction. The dashboard holds no master seed and has no input fields. The web config already refuses `XRPL_REGULAR_KEY_SEED` and `OWNER_TREASURY_MASTER_SEED`.
- Balance poller: compares `account_info` RegularKey with the configured key ADDRESS and stores `regular_key_state` (`active`, `not_set`, `other`, `not_configured`) on each snapshot. It never flips the guard to revoked: only a ledger rejection does. It moves `master_env` to `regular_key` when it sees the configured key registered, and restores `revoked` to `regular_key` only when the ledger shows the configured key AND the rejected blob's `LastLedgerSequence` is below the snapshot ledger (the blob can no longer validate). The restore writes `signing_key.restored`.
- Migration `0011_signing_key.sql`: `balance_snapshots.regular_key_state`, `GRANT UPDATE (signing_key_mode)` on `treasury_wallets` to `flow_guard` only (one column, RLS policy), and a trigger that allows only `master_env -> regular_key`, `regular_key -> revoked` and `revoked -> regular_key`. The web role has no UPDATE.

## 19.2 resolved: the failure code of a revoked regular key

Verified on Testnet: a payment signed by a regular key that has been revoked is refused at submit with `tefBAD_AUTH` ("Transaction's public key is not authorized."). It never reaches a ledger, no fee is charged and the account Sequence does not move. Only this code is in `SIGNING_KEY_REJECTION_CODES`; `tefMASTER_DISABLED` is not included because it was not observed (it concerns a disabled master key, which this project never creates).

## Testnet proof (fee only, no RLUSD moved)

Treasury `rHwNC93iYF7ZcSpZJbVZiwLmpiCKauoHuo`. Explorer links are `https://testnet.xrpl.org/transactions/<hash>`.

| Step | Result | Hash |
|---|---|---|
| Baseline `owner:status-key` | RegularKey not set, master enabled, XRP 109.999952, RLUSD 17 | none |
| (i) `owner:set-regular-key --confirm` (regular key `rpzStkpz4fuER8tE8mTJxY7qQRA29t6Q1Y`) | validated `tesSUCCESS`, ledger 22302193; `account_info` shows the RegularKey | 5E4797C5D56ECCC1E7962BEECCEAE9E919AE2FFD6736D35C72DF01CC1A1C4FAB |
| (ii) `m7:proof probe`: guard signer module, only `XRPL_REGULAR_KEY_SEED` in its environment, 1 RLUSD payment to a never-activated address | `SigningPubKey` equals the regular key public key; ledger accepted the signature and applied `tecNO_DST` (validated, ledger 22302213, 12 drops fee, nothing delivered) | 47B3060C932975FCB4DF1140D61850C99A59CBFF49F596978359A40953DF5FF0 |
| (iii) `owner:revoke-regular-key --confirm` | validated `tesSUCCESS`, ledger 22302229; `account_info` shows no RegularKey, master still enabled | D243B5512661146AD88DD4F0E985DEAC8688D61D95EB04CAF84625772C9D2978 |
| (iii) `m7:proof probe --old-key`: same signing with the revoked key | submit result `tefBAD_AUTH`; the transaction is in no ledger; XRP and Sequence unchanged | 2AC9566B41AED56F12284A4782004BCBAD30E3562D282756EF94999ABE464C57 (never validated) |
| (iii) `m7:proof guard`: real guard process, throwaway local database, execution enabled, revoked key, ledger shows no RegularKey | request 1: `failed` / `SIGNING_KEY_REVOKED`; `/readyz` 503 `degraded`, `signing_key: revoked`; wallet mode `revoked`; request 2: `blocked` / `EXECUTION_DISABLED`, nothing submitted; audit events include `payment.signing_key_revoked` and `signing_key.revoked`; audit chain verifies | none (nothing reached a ledger) |
| (iv) final `owner:set-regular-key --confirm` (new key `rBo9yA5iS9y8D1GNmz7eLnZqfYEHei5fpb`) | validated `tesSUCCESS`, ledger 22302741 | 0A4ED48BFD0221FF7A99E9B21477540E4DAA89974F7129E598DBB5B8E9C83443 |

Final account state: RegularKey SET to the guard key `rBo9yA5iS9y8D1GNmz7eLnZqfYEHei5fpb`; master key fully enabled (never disabled); XRP 109.999904 (4 transactions at 12 drops each); RLUSD 17, unchanged from the baseline (read only, via `account_lines`). The brief expected exactly 5 RLUSD; the account actually held 17 before and after, so the "never below 5" rule held throughout. No RLUSD payment was ever sent. `.secrets/guard-regular-key.env` holds the active key seed; `.secrets/guard-regular-key.revoked.env` holds the revoked one. Both are gitignored and were never printed.

Not run on the live ledger: the plan's "guard with an ACTIVE key reads `regular_key` on `/readyz`" step. That path is covered by the database tests with the fake gateway (a real run would have used the active key against a payable invoice, which could move RLUSD). The restore-after-rotate path is also covered only by the database tests.

## Honest limits

- A regular key can still sign any valid payment while it is active. This does not enforce limits on-ledger; it lets the owner cut off the guard's authority. The application-layer checks remain the control for amounts and destinations.
- Detection is on the ledger's rejection of a signed payment. The poller's RegularKey comparison is informational. If the key is revoked and no payment is attempted, the dashboard shows "No regular key registered" or "Different regular key", not "revoked".
- A rejected submit uses a blob that never validates; the failed payment keeps that hash for the audit trail but it has no explorer page.
- SignerList multi-sign is P2 and not built.

## Rotating, revoking and cleanup

- Rotate: `pnpm owner:set-regular-key --confirm --rotate` (the old key file moves to `guard-regular-key.env.prev`). Restart the guard with `pnpm guard:dev -- --regular-key`; the poller restores a revoked guard once the new key is on the ledger and the rejected blob has expired.
- Revoke: `pnpm owner:revoke-regular-key --confirm`.
- Dev mode without a regular key is unchanged: the launcher passes the master seed to the guard only when `--regular-key` is not given. With `--regular-key` the child gets only the regular key seed.
- Delete `.secrets/guard-regular-key.*` when a demo is over; they are gitignored.
