/**
 * M0 preflight (spec 16, Step 1). Read-only. Asserts Testnet, reads reserves from server_info,
 * checks the treasury account, its XRP balance and its RLUSD trust line, and verifies the configured
 * issuer + currency hex pair against what the account actually holds. Never touches seeds.
 *
 * Usage: pnpm preflight [treasuryAddress]
 *   Address resolution: argv[2], then TREASURY_ADDRESS env, then .secrets/testnet-wallets.json (address only).
 */
import { dropsToXrp, isValidClassicAddress, xrpToDrops } from "xrpl";
import { connectTestnetClient, isGreater } from "../packages/xrpl-adapter/src/index";
import { loadConfig, readPublicWallets, secretsFileExists, toErrorMessage, type PublicWallet } from "./lib/common";

type Status = "PASS" | "FAIL" | "BLOCKED" | "INFO";
const results: Array<{ status: Status; name: string; detail: string }> = [];
function report(status: Status, name: string, detail: string): void {
  results.push({ status, name, detail });
  console.log(`[${status.padEnd(7)}] ${name}: ${detail}`);
}

const LSF_REQUIRE_AUTH = 0x00040000;
const LSF_GLOBAL_FREEZE = 0x00400000;

function isNotFound(err: unknown): boolean {
  return (err as { data?: { error?: string } }).data?.error === "actNotFound";
}

async function main(): Promise<void> {
  // 1. Network assertion (throws, so nothing else runs, if not Testnet)
  const cfg = loadConfig();
  report("PASS", "XRPL_NETWORK", `${cfg.network} (Testnet only)`);

  let treasury = process.argv[2] ?? process.env.TREASURY_ADDRESS;
  let suppliers: PublicWallet[] = [];
  if (secretsFileExists()) {
    const wallets = readPublicWallets(); // addresses only: preflight never needs a seed
    treasury ??= wallets.find((w) => w.role === "treasury")?.address;
    suppliers = wallets.filter((w) => w.role === "supplier");
  }
  if (!treasury) throw new Error("No treasury address. Pass one as an argument, set TREASURY_ADDRESS, or run setup-testnet-accounts.");
  if (!isValidClassicAddress(treasury)) throw new Error("Treasury address is not a valid XRPL classic address.");

  const client = await connectTestnetClient(cfg.network, cfg.wsUrl); // asserts server network_id === 1
  try {
    // 2. Connected network sanity + reserves (never hardcoded)
    const si = (await client.request({ command: "server_info" })).result.info;
    report("PASS", "Connected", `${cfg.wsUrl} (server ${si.build_version}, network_id=${String(si.network_id ?? "n/a")})`);
    const vl = si.validated_ledger;
    if (!vl) throw new Error("server_info returned no validated_ledger");
    const reserveBase = vl.reserve_base_xrp;
    const reserveInc = vl.reserve_inc_xrp;
    report("PASS", "Reserves (server_info)", `base ${reserveBase} XRP, owner ${reserveInc} XRP per object, validated ledger ${vl.seq}`);

    // 3. Issuer account exists; surface RequireAuth / GlobalFreeze (19.2 issuer behaviour)
    try {
      const iss = (await client.request({ command: "account_info", account: cfg.issuer, ledger_index: "validated" })).result.account_data;
      report("PASS", "Issuer account exists", cfg.issuer);
      const flags = iss.Flags;
      report(
        (flags & LSF_REQUIRE_AUTH) || (flags & LSF_GLOBAL_FREEZE) ? "FAIL" : "PASS",
        "Issuer flags",
        `RequireAuth=${Boolean(flags & LSF_REQUIRE_AUTH)} GlobalFreeze=${Boolean(flags & LSF_GLOBAL_FREEZE)}`,
      );
    } catch (err) {
      report("FAIL", "Issuer account exists", isNotFound(err) ? `${cfg.issuer} not found on this network` : toErrorMessage(err));
    }

    // 4. Treasury activated + XRP balance
    let treasuryOwnerCount = 0;
    try {
      const ad = (await client.request({ command: "account_info", account: treasury, ledger_index: "validated" })).result.account_data;
      treasuryOwnerCount = ad.OwnerCount;
      // Exact integer drops: no floating point in balance/reserve decisions.
      const balanceDrops = BigInt(ad.Balance);
      const reserveDrops = BigInt(xrpToDrops(String(reserveBase))) + BigInt(xrpToDrops(String(reserveInc))) * BigInt(ad.OwnerCount);
      const balanceXrp = String(dropsToXrp(ad.Balance));
      const reserve = String(dropsToXrp(reserveDrops.toString()));
      report("PASS", "Treasury activated", treasury);
      report(
        balanceDrops > reserveDrops ? "PASS" : "FAIL",
        "Treasury XRP balance",
        `${balanceXrp} XRP (reserve ${reserve} XRP for ${ad.OwnerCount} owned objects; spendable ${String(dropsToXrp((balanceDrops - reserveDrops).toString()))} XRP)`,
      );
    } catch (err) {
      report("FAIL", "Treasury activated", isNotFound(err) ? `${treasury} not found: fund it from the Testnet faucet` : toErrorMessage(err));
    }

    // 5. Treasury RLUSD trust line, issuer + hex pair verified against account_lines
    try {
      const lines = (await client.request({ command: "account_lines", account: treasury, ledger_index: "validated" })).result.lines;
      const match = lines.find((l) => l.currency.toUpperCase() === cfg.currencyHex && l.account === cfg.issuer);
      if (match) {
        report("PASS", "RLUSD trust line (issuer + hex pair)", `limit ${match.limit}, freeze=${String(match.freeze ?? false)}`);
        if (isGreater(match.balance, "0")) {
          report("PASS", "Treasury RLUSD balance", `${match.balance} RLUSD (scale the 13A fixture to this amount)`);
        } else {
          report("BLOCKED", "Treasury RLUSD balance", "0 RLUSD: blocked on manual RLUSD claim (see docs/m0-notes.md)");
        }
      } else {
        const sameIssuer = lines.filter((l) => l.account === cfg.issuer);
        const sameHex = lines.filter((l) => l.currency.toUpperCase() === cfg.currencyHex);
        if (sameIssuer.length || sameHex.length) {
          report(
            "FAIL",
            "RLUSD trust line (issuer + hex pair)",
            `MISMATCH. Account holds ${sameIssuer.map((l) => `issuer-match/currency=${l.currency}`).concat(sameHex.map((l) => `hex-match/issuer=${l.account}`)).join("; ")}; configured pair is ${cfg.issuer} / ${cfg.currencyHex}`,
          );
        } else {
          report("FAIL", "RLUSD trust line (issuer + hex pair)", `none found (owner count ${treasuryOwnerCount}). Run pnpm trust-lines.`);
        }
      }
    } catch (err) {
      report("FAIL", "RLUSD trust line", toErrorMessage(err));
    }

    // 6. Supplier trust lines (addresses only), if known
    for (const s of suppliers) {
      try {
        const lines = (await client.request({ command: "account_lines", account: s.address, peer: cfg.issuer, ledger_index: "validated" })).result.lines;
        const ok = lines.some((l) => l.currency.toUpperCase() === cfg.currencyHex && l.account === cfg.issuer);
        report(ok ? "PASS" : "FAIL", `Supplier trust line ${s.label}`, `${s.address} ${ok ? "present" : "missing"}`);
      } catch (err) {
        report("FAIL", `Supplier trust line ${s.label}`, `${s.address} ${isNotFound(err) ? "not activated" : toErrorMessage(err)}`);
      }
    }
  } finally {
    await client.disconnect();
  }

  const failed = results.some((r) => r.status === "FAIL");
  const blocked = results.some((r) => r.status === "BLOCKED");
  console.log("");
  console.log(failed ? "PREFLIGHT: FAIL" : blocked ? "PREFLIGHT: BLOCKED (manual RLUSD claim pending)" : "PREFLIGHT: PASS");
  process.exit(failed ? 1 : blocked ? 2 : 0);
}

main().catch((err) => {
  console.error(`[FAIL   ] preflight aborted: ${toErrorMessage(err)}`);
  process.exit(1);
});
