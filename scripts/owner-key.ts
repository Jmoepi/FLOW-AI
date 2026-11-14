/**
 * Owner-only regular-key backstop tooling (M7, spec 10.6 to 10.8). Testnet only.
 *   pnpm owner:set-regular-key [--confirm] [--rotate]   generate a guard key and register it on the treasury (SetRegularKey)
 *   pnpm owner:revoke-regular-key [--confirm]           remove the regular key (SetRegularKey with no RegularKey)
 *   pnpm owner:status-key                               read-only: regular key and master key state, balances
 * The treasury MASTER seed is read inside this process only (OWNER_TREASURY_MASTER_SEED or .secrets/testnet-wallets.json),
 * used for one signature and never printed, logged or written. The master key is never disabled: only SetRegularKey is
 * ever built (assertSetRegularKeyOnly). Without --confirm this is a dry run that submits nothing.
 * The new guard seed is written ONLY to the gitignored .secrets/guard-regular-key.env and never printed.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Wallet, type SubmittableTransaction } from "xrpl";
import { XrplGateway, submitAccountTxAndWait } from "../packages/xrpl-adapter/src/index";
import { ROOT, SECRETS_DIR, loadConfig, readPublicWallets, readWalletsFile, toErrorMessage } from "./lib/common";
import { assertSetRegularKeyOnly, buildSetRegularKeyTx, formatRegularKeyEnv, parseOwnerKeyArgs, parseRegularKeyAddress, regularKeyState } from "./lib/owner-key";

export const REGULAR_KEY_FILE = path.join(SECRETS_DIR, "guard-regular-key.env");
const PENDING_FILE = `${REGULAR_KEY_FILE}.pending`;
const REVOKED_FILE = path.join(SECRETS_DIR, "guard-regular-key.revoked.env");
const PREV_FILE = `${REGULAR_KEY_FILE}.prev`;
const EXPLORER = "https://testnet.xrpl.org/transactions/";

for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (err: unknown) => {
    console.error(`[FAIL   ] unhandled error: ${toErrorMessage(err)}`);
    process.exit(1);
  });
}

function assertIgnored(file: string): void {
  try {
    execFileSync("git", ["check-ignore", "-q", file], { cwd: ROOT, stdio: "ignore" });
  } catch {
    throw new Error("git does not ignore the .secrets path. Refusing to write a key file.");
  }
}

function writeSecret(file: string, text: string): void {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on Windows */
  }
}

/** The treasury master wallet. Read here only; the seed string never leaves this function. */
function loadMasterWallet(): Wallet {
  const treasury = readPublicWallets().find((w) => w.role === "treasury");
  if (!treasury) throw new Error("No treasury wallet recorded in .secrets/testnet-wallets.json.");
  const fromEnv = process.env.OWNER_TREASURY_MASTER_SEED;
  let wallet: Wallet;
  try {
    wallet = Wallet.fromSeed(fromEnv !== undefined && fromEnv !== "" ? fromEnv : (readWalletsFile().wallets.find((w) => w.role === "treasury")?.seed ?? ""));
  } catch {
    throw new Error("The treasury master seed is missing or invalid.");
  }
  if (wallet.address !== treasury.address) throw new Error("The master seed does not match the recorded treasury address.");
  return wallet;
}

function configuredAddress(): string | null {
  return existsSync(REGULAR_KEY_FILE) ? parseRegularKeyAddress(readFileSync(REGULAR_KEY_FILE, "utf8")) : null;
}

async function main(): Promise<void> {
  const args = parseOwnerKeyArgs(process.argv.slice(2));
  const cfg = loadConfig(); // Testnet-only assertions (network name, URL allowlist, issuer)
  const treasury = readPublicWallets().find((w) => w.role === "treasury");
  if (!treasury) throw new Error("No treasury wallet recorded in .secrets/testnet-wallets.json.");
  const gw = await XrplGateway.connect(cfg.network, { wsUrl: cfg.wsUrl }); // asserts network_id 1
  try {
    const snap = await gw.getAccountSnapshot(treasury.address, cfg.issuer, cfg.currencyHex);
    const state = regularKeyState(snap.regularKey, configuredAddress());
    console.log(`Treasury:            ${treasury.address}`);
    console.log(`Regular key (ledger): ${snap.regularKey ?? "not set"} [${state}]`);
    console.log(`Master key:          ${snap.masterDisabled ? "DISABLED" : "enabled"}`);
    console.log(`XRP: ${(Number(snap.xrpDrops) / 1e6).toFixed(6)}   RLUSD: ${snap.rlusdBalance ?? "no trust line"}   ledger ${String(snap.ledgerIndex)}`);
    if (args.command === "status") {
      if (state === "not_set") console.log("Guard signs with the master key (dev mode). Run `pnpm owner:set-regular-key` to add a revocable backstop key.");
      else console.log("To revoke the guard key at any time: `pnpm owner:revoke-regular-key --confirm` (needs the master seed, run locally).");
      return;
    }
    if (snap.masterDisabled) throw new Error("The master key is disabled on this account. Refusing to continue.");

    if (args.command === "set") {
      if (snap.regularKey !== null && !args.rotate) {
        console.log("A regular key is already set. Nothing to do. Use --rotate to replace it with a new key.");
        return;
      }
      console.log(args.confirm ? "Submitting SetRegularKey (fee only, no RLUSD moves)..." : "DRY RUN: would generate a new guard key and submit SetRegularKey. Add --confirm to proceed.");
      if (!args.confirm) return;
      assertIgnored(REGULAR_KEY_FILE);
      if (existsSync(PENDING_FILE)) throw new Error("A pending guard key file exists from an earlier unresolved attempt. Run status, then remove or restore it deliberately before running set again.");
      const master = loadMasterWallet();
      const guardKey = Wallet.generate();
      if (guardKey.seed === undefined) throw new Error("Key generation failed.");
      const tx = buildSetRegularKeyTx(master.address, guardKey.address);
      assertSetRegularKeyOnly(tx, master.address);
      // Persist the new seed BEFORE submitting: a key that is set on the ledger but lost would be unusable.
      writeSecret(PENDING_FILE, formatRegularKeyEnv(guardKey.seed, guardKey.address));
      const out = await submitAccountTxAndWait(gw, master, tx as unknown as SubmittableTransaction);
      if (out.kind !== "validated_success") {
        if (out.kind !== "pending") rmSync(PENDING_FILE, { force: true });
        throw new Error(`SetRegularKey not validated: ${out.kind}${"resultCode" in out ? ` ${out.resultCode}` : ""}${"engineResult" in out ? ` ${out.engineResult}` : ""}. ${out.kind === "pending" ? "Outcome uncertain: re-run status; the pending key file was kept." : ""}`);
      }
      if (existsSync(REGULAR_KEY_FILE)) renameSync(REGULAR_KEY_FILE, PREV_FILE);
      renameSync(PENDING_FILE, REGULAR_KEY_FILE);
      console.log(`SetRegularKey validated: ${out.resultCode} in ledger ${String(out.ledgerIndex)}`);
      console.log(`Regular key address: ${guardKey.address}`);
      console.log(`Tx: ${EXPLORER}${out.hash}`);
      console.log("The key seed is stored only in .secrets/guard-regular-key.env (gitignored, not printed).");
      return;
    }

    // revoke
    if (snap.regularKey === null) {
      console.log("No regular key is set. Nothing to revoke.");
      return;
    }
    console.log(args.confirm ? "Submitting SetRegularKey with no RegularKey (revoke; fee only)..." : "DRY RUN: would revoke the regular key. Add --confirm to proceed.");
    if (!args.confirm) return;
    const master = loadMasterWallet();
    const tx = buildSetRegularKeyTx(master.address);
    assertSetRegularKeyOnly(tx, master.address);
    const out = await submitAccountTxAndWait(gw, master, tx as unknown as SubmittableTransaction);
    if (out.kind !== "validated_success") throw new Error(`Revoke not validated: ${out.kind}${"resultCode" in out ? ` ${out.resultCode}` : ""}${"engineResult" in out ? ` ${out.engineResult}` : ""}.`);
    if (existsSync(REGULAR_KEY_FILE)) renameSync(REGULAR_KEY_FILE, REVOKED_FILE);
    console.log(`Revoke validated: ${out.resultCode} in ledger ${String(out.ledgerIndex)}`);
    console.log(`Tx: ${EXPLORER}${out.hash}`);
    console.log("The old guard key file was moved to .secrets/guard-regular-key.revoked.env (still gitignored).");
  } finally {
    await gw.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`[FAIL   ] ${toErrorMessage(err)}`);
  process.exit(1);
});
