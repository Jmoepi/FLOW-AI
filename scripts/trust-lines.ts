/**
 * M0: submit TrustSet to the RLUSD issuer (from env, spec 10.2) for every supplier wallet and the
 * treasury, skipping accounts that already hold the line. Testnet only. Never prints seeds.
 */
import { TrustSetFlags, Wallet, type Client, type TransactionMetadata } from "xrpl";
import { connectTestnetClient } from "../packages/xrpl-adapter/src/index";
import { loadConfig, readWalletsFile, toErrorMessage } from "./lib/common";

// Limit used in Ripple's official Testnet trust line example (a ceiling, not a balance).
const TRUST_LIMIT = "1000000000";

async function hasLine(client: Client, address: string, issuer: string, hex: string): Promise<boolean> {
  const res = await client.request({ command: "account_lines", account: address, peer: issuer, ledger_index: "validated" });
  return res.result.lines.some((l) => l.currency.toUpperCase() === hex && l.account === issuer);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const file = readWalletsFile();
  const client = await connectTestnetClient(cfg.network, cfg.wsUrl);
  let failed = false;
  try {
    for (const w of file.wallets) {
      if (await hasLine(client, w.address, cfg.issuer, cfg.currencyHex)) {
        console.log(`${w.label.padEnd(22)} ${w.address}  trust line already present`);
        continue;
      }
      try {
        const wallet = Wallet.fromSeed(w.seed);
        const res = await client.submitAndWait(
          {
            TransactionType: "TrustSet",
            Account: wallet.address,
            LimitAmount: { currency: cfg.currencyHex, issuer: cfg.issuer, value: TRUST_LIMIT },
            Flags: TrustSetFlags.tfSetNoRipple,
          },
          { autofill: true, wallet },
        );
        const result = (res.result.meta as TransactionMetadata).TransactionResult;
        const ok = res.result.validated && result === "tesSUCCESS";
        if (!ok) failed = true;
        console.log(`${w.label.padEnd(22)} ${w.address}  TrustSet ${result} validated=${String(res.result.validated)} tx=${res.result.hash}`);
      } catch (err) {
        failed = true;
        console.log(`${w.label.padEnd(22)} ${w.address}  TrustSet FAILED: ${toErrorMessage(err)}`);
      }
    }
  } finally {
    await client.disconnect();
  }
  if (failed) process.exit(1);
  console.log("Done. Next: claim RLUSD for the treasury (see docs/m0-notes.md), then pnpm preflight");
}

main().catch((err) => {
  console.error(`trust-lines failed: ${toErrorMessage(err)}`);
  process.exit(1);
});
