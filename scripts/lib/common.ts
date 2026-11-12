import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SECRETS_DIR = path.join(ROOT, ".secrets");
export const SECRETS_FILE = path.join(SECRETS_DIR, "testnet-wallets.json");

// Load .env then .env.local (both gitignored). Existing process env wins.
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });

export const TESTNET_NETWORK = "xrpl-testnet";
export const DEFAULT_WS_URL = "wss://s.altnet.rippletest.net:51233";

export interface XrplConfig {
  network: string;
  wsUrl: string;
  issuer: string;
  currencyHex: string;
}

/** Refuses to continue unless XRPL_NETWORK is exactly "xrpl-testnet" (spec 10.1). Fail closed. */
export function loadConfig(): XrplConfig {
  const network = process.env.XRPL_NETWORK;
  if (network !== TESTNET_NETWORK) {
    throw new Error(
      `Refusing to run: XRPL_NETWORK must be exactly "${TESTNET_NETWORK}" (got ${JSON.stringify(network ?? null)}). Testnet only.`,
    );
  }
  const wsUrl = process.env.XRPL_WS_URL ?? DEFAULT_WS_URL;
  if (!/altnet\.rippletest\.net|testnet/i.test(wsUrl) || /(^|\.)xrplcluster\.com|s1\.ripple\.com|s2\.ripple\.com/i.test(wsUrl)) {
    throw new Error(`Refusing to run: XRPL_WS_URL does not look like a Testnet endpoint (${wsUrl}).`);
  }
  const issuer = process.env.RLUSD_ISSUER;
  const currencyHex = process.env.RLUSD_CURRENCY_HEX?.toUpperCase();
  if (!issuer || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(issuer)) {
    throw new Error("RLUSD_ISSUER is missing or not a classic address. Set it in .env (see .env.example).");
  }
  if (!currencyHex || !/^[0-9A-F]{40}$/.test(currencyHex)) {
    throw new Error("RLUSD_CURRENCY_HEX is missing or not a 40-character hex string. Set it in .env.");
  }
  return { network, wsUrl, issuer, currencyHex };
}

export interface StoredWallet {
  label: string;
  role: "treasury" | "supplier";
  kind?: "cross-border" | "domestic" | "extra";
  address: string;
  seed: string;
}

export interface WalletsFile {
  network: string;
  createdAt: string;
  wallets: StoredWallet[];
}

export function secretsFileExists(): boolean {
  return existsSync(SECRETS_FILE);
}

export function readWalletsFile(): WalletsFile {
  if (!existsSync(SECRETS_FILE)) {
    throw new Error("No .secrets/testnet-wallets.json found. Run `pnpm setup:testnet-accounts` first.");
  }
  const parsed = JSON.parse(readFileSync(SECRETS_FILE, "utf8")) as WalletsFile;
  if (parsed.network !== TESTNET_NETWORK) {
    throw new Error("Secrets file is not for xrpl-testnet. Refusing to use it.");
  }
  return parsed;
}

/** Public data only: never exposes seeds. */
export function publicWallets(file: WalletsFile): Array<Omit<StoredWallet, "seed">> {
  return file.wallets.map(({ seed: _seed, ...rest }) => rest);
}

/** Replace anything seed-shaped before printing an error. */
export function redact(text: string): string {
  return text.replace(/\bs[1-9A-HJ-NP-Za-km-z]{24,34}\b/g, "[REDACTED]");
}

export function toErrorMessage(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}
