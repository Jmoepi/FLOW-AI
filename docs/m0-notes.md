# M0 Preflight notes

**Update (M1 done):** the RLUSD claim has since been made and `pnpm preflight` passes. The status line below is the original M0 snapshot. See "Facts verified after M0" at the end and `docs/m1-notes.md`.

**Status: BLOCKED on manual RLUSD claim.** Everything scriptable in M0 is done and verified on Testnet. The treasury holds XRP and a valid RLUSD trust line but 0 RLUSD. The claim at tryrlusd.com is a web UI and was not automated.

Testnet only. No git repository exists in this folder (`git rev-parse --is-inside-work-tree` failed), so nothing was committed and no git hook was installed. `git init` was not run. `pnpm secret-scan` works with or without git and should be wired as a pre-commit hook and CI step once the repo is initialised.

## Public addresses (Testnet)

| Role | Address |
|---|---|
| Treasury | `rHwNC93iYF7ZcSpZJbVZiwLmpiCKauoHuo` |
| Supplier, cross-border | `rpc4DFfxB6aXkbEPJTAGXLG4oZQuWpTXnT` |
| Supplier, domestic | `rNRXXz44CVbkCKxjAhrv5q83NgzDMHm4Af` |
| Supplier, extra | `rfVD3hiAXXub2ppTgm9MphHT9ZjZAvyqpT` |
| RLUSD issuer (Testnet) | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` |

Seeds live only in `.secrets/testnet-wallets.json` (gitignored, created after confirming `.gitignore` covers `.secrets/`). They were never printed. A local `.env` (gitignored) holds only non-secret Testnet network values.

## Manual step for the user: claim RLUSD

1. Open https://tryrlusd.com/ ("Claim testnet RLUSD", choose the Testnet network).
2. Claim for the treasury address `rHwNC93iYF7ZcSpZJbVZiwLmpiCKauoHuo`. The trust line to the issuer already exists, so no wallet-side setup is needed. If the site insists on a connected wallet, use the treasury address as the destination if it accepts one; if it only works with a connected wallet, import the treasury seed from `.secrets/testnet-wallets.json` into a Testnet-only wallet locally (never paste it anywhere else or share it).
3. Run `pnpm preflight`. It must report the real RLUSD balance and `PREFLIGHT: PASS`.
4. Write the actual amount received below and scale the section 13A fixture to it. Do not assume 1,000 RLUSD.

How the faucet works: I fetched the page and only got its shell ("Choose a network and get tokens for your next build"); the claim flow is rendered client side. Ripple's docs say to set up the trust line first, then visit the faucet. I could not confirm the amount, rate limits, or whether it needs a browser wallet, so I did not attempt to automate it. Claimed RLUSD amount: **not yet recorded**.

## Issuer and currency hex: where found

Source: Ripple docs, "RLUSD on the XRP Ledger" (https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl), Testnet section and trust line example:
- Testnet issuer: `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`
- Currency hex: `524C555344000000000000000000000000000000`
- The same page lists a different Mainnet issuer (`rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`), which must never be used here.

These match the values in spec sections 10.1, 10.2 and 17. Scripts read them from env (`RLUSD_ISSUER`, `RLUSD_CURRENCY_HEX`).

## What was run and the results

- `pnpm install`: OK (pnpm 11.8.0, Node 24.17.0). `esbuild` build script explicitly allowed in `pnpm-workspace.yaml` (`allowBuilds`).
- `pnpm typecheck` (root scripts plus all 7 workspace placeholders, strict): PASS.
- `pnpm setup:testnet-accounts`: created 4 wallets, faucet funded 100 XRP each. Second run reused the existing file and skipped funding (idempotent).
- `pnpm trust-lines`: 4 TrustSet transactions, all `tesSUCCESS`, `validated: true` (treasury, 3 suppliers). Second run skipped all (already present). Limit 1000000000 and `tfSetNoRipple`, as in Ripple's example.
  - Treasury: `F8038CEFD3A52A7443C604925A789E7FB1B6D0074D3DC76793105B31D52A8B14`
  - Cross-border: `26DC03CB85493EDD2EBCD45D1B70F7A9FDC632F7E7554CA2496BCC634E98DA4C`
  - Domestic: `1825A8D6260D16F8B8B20C1F5E1DAD97635E2040505FEBAD7F70E6C1F0253C94`
  - Extra: `F9648C3ACF84EE84C681C91601716F42E389BDD41084B6AF698A6F69AF424D31`
- `pnpm preflight`: exit code 2 (BLOCKED). Results:
  - Network `xrpl-testnet` and server `network_id=1`: PASS
  - Reserves from `server_info`: base 1 XRP, owner 0.2 XRP per object (validated ledger 22236943)
  - Issuer account exists, `RequireAuth=false`, `GlobalFreeze=false`: PASS
  - Treasury activated, 99.999988 XRP (1.2 XRP reserved with one trust line): PASS
  - Treasury RLUSD trust line for the configured issuer and hex pair: PASS (account_lines)
  - Treasury RLUSD balance: 0, BLOCKED on manual claim
  - Three supplier trust lines: PASS
- `pnpm secret-scan`: PASS (also checked that a dummy seed-shaped string is detected and that the match value is never printed; the test file was removed).

## Spec 19.2 items

Resolved or partly resolved by M0:
- RLUSD issuer address and currency hex: **verified against Ripple's docs**, and the issuer account exists on Testnet. The pair is confirmed on the treasury's trust line. It is not yet proven that the issuer actually issues this currency (needs a non-zero balance after the claim, or the M1 transfer).
- Supplier trust-line behaviour: partly resolved. Issuer has no `RequireAuth` or `GlobalFreeze`, and all 3 scripted supplier TrustSets succeeded. Receiving a payment is still unproven until M1.

Not resolved (still unverified):
- RLUSD faucet amount and rate limits (needs the manual claim).
- Amendment status of anything beyond Payment, TrustSet, SetRegularKey.
- Failure code for a revoked regular key (M7).
- Current Anthropic model id (`AI_MODEL` left as a placeholder in `.env.example`).
- Judging weights/dates/prize terms, Privy and Open Wallet Standard capabilities, regulatory position, cost/speed comparisons.

## Deviations and decisions

- `XRPL_NETWORK` uses the spec value `xrpl-testnet` (sections 10.1 and 17), and the WebSocket variable is `XRPL_WS_URL`, as in the spec. The scripts fail closed on anything else.
- Script names: `setup-testnet-accounts.ts` (as requested for M0) replaces the spec's `setup-suppliers.ts`; it also creates the treasury. `trust-lines.ts` is separate. The spec's `scripts/preflight.ts` is not the "fund a throwaway account" variant; it checks the real treasury read-only, since trust lines are created by `trust-lines.ts`.
- Hosting decision for the deployed demo URL (an M0 outcome) is **not made** and is left to the product owner.
- The `docs/implementation-notes.md` file from Step 1 was not needed because the repository was empty of code.

## Repository
- Git repo now exists; branch `main` tracks `origin` at https://github.com/Jmoepi/FLOW-AI.git. First commit contains only `README.md`; everything else is still untracked.
- Local pre-commit hook installed at `.git/hooks/pre-commit` (not versioned, not git config). It runs `pnpm secret-scan` and blocks the commit on failure. Verified by running the script directly: PASS, exit 0.

## Facts verified after M0 (updated during M1)
- **Faucet amount and rate limit:** tryrlusd.com gives 10 RLUSD per claim, once per 24 h per account (reported from a real claim by the project owner; I did not automate or re-test the faucet). The treasury held 8 RLUSD when M1 started (how the 8 got there was not recorded in this repo). Budget accordingly: demo fixtures must be scaled to about 8 to 10 RLUSD (see the scaled-fixture note in spec 13A).
- **Issuer + currency hex pair: confirmed on-ledger.** A real RLUSD claim credited the treasury's trust line for `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` / `524C555344000000000000000000000000000000`, and two M1 payments delivered exactly that currency and issuer.
- **Supplier trust-line receive behaviour: proven.** Cross-border and domestic supplier accounts each received 1 RLUSD via their scripted trust lines (validated `tesSUCCESS`, exact balance deltas). No `RequireAuth` or `GlobalFreeze` on the issuer.
- **M1 status:** done. Hashes and balances are in `docs/m1-notes.md`. Treasury is at 6 RLUSD after M1.
- Still unverified: amendment status beyond Payment/TrustSet/SetRegularKey, revoked regular-key failure code (M7), current Anthropic model id, judging terms, Privy/OWS capabilities, regulatory position, cost/speed comparisons.
