/**
 * M0: create a treasury wallet and 3 supplier wallets on XRPL Testnet and fund them with XRP
 * from the Testnet faucet. Seeds are written ONLY to the gitignored .secrets/testnet-wallets.json.
 * Only public classic addresses are ever printed. Idempotent: an existing secrets file is reused.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client, Wallet } from "xrpl";
import {
  ROOT,
  SECRETS_DIR,
  SECRETS_FILE,
  TESTNET_NETWORK,
  loadConfig,
  readWalletsFile,
  secretsFileExists,
  toErrorMessage,
  type StoredWallet,
  type WalletsFile,
} from "./lib/common";
import path from "node:path";

/** The secrets location must be gitignored BEFORE the file is created. */
function assertSecretsIgnored(): void {
  const gitignorePath = path.join(ROOT, ".gitignore");
  const lines = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8").split(/\r?\n/).map((l) => l.trim())
    : [];
  if (!lines.includes(".secrets/") && !lines.includes(".secrets")) {
    throw new Error(".gitignore does not cover .secrets/. Refusing to create the secrets file.");
  }
}

const PLAN: Array<Pick<StoredWallet, "label" | "role" | "kind">> = [
  { label: "treasury", role: "treasury" },
  { label: "supplier-cross-border", role: "supplier", kind: "cross-border" },
  { label: "supplier-domestic", role: "supplier", kind: "domestic" },
  { label: "supplier-extra", role: "supplier", kind: "extra" },
];

async function isActivated(client: Client, address: string): Promise<boolean> {
  try {
    await client.request({ command: "account_info", account: address, ledger_index: "validated" });
    return true;
  } catch (err) {
    const data = (err as { data?: { error?: string } }).data;
    if (data?.error === "actNotFound") return false;
    throw err;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  assertSecretsIgnored();

  let file: WalletsFile;
  if (secretsFileExists()) {
    file = readWalletsFile();
    console.log(`Reusing existing ${path.relative(ROOT, SECRETS_FILE)} (not overwritten).`);
  } else {
    file = {
      network: TESTNET_NETWORK,
      createdAt: new Date().toISOString(),
      wallets: PLAN.map((p) => {
        const w = Wallet.generate();
        return { ...p, address: w.address, seed: w.seed! };
      }),
    };
    mkdirSync(SECRETS_DIR, { recursive: true });
    writeFileSync(SECRETS_FILE, JSON.stringify(file, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`Created ${path.relative(ROOT, SECRETS_FILE)} (gitignored, contains seeds, never print or share).`);
  }

  const client = new Client(cfg.wsUrl);
  await client.connect();
  try {
    for (const w of file.wallets) {
      if (await isActivated(client, w.address)) {
        console.log(`${w.label.padEnd(22)} ${w.address}  already activated, skipping faucet`);
        continue;
      }
      const wallet = Wallet.fromSeed(w.seed);
      const res = await client.fundWallet(wallet);
      console.log(`${w.label.padEnd(22)} ${w.address}  funded ${res.balance} XRP from faucet`);
    }
  } finally {
    await client.disconnect();
  }
  console.log("Done. Next: pnpm trust-lines");
}

main().catch((err) => {
  console.error(`setup-testnet-accounts failed: ${toErrorMessage(err)}`);
  process.exit(1);
});
