import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Wallet, isValidClassicAddress } from "xrpl";
import { redactError } from "../../packages/contracts/src/index";
import {
  ALLOWED_TESTNET_WS_URLS,
  TESTNET_NETWORK,
  assertTestnetAsset,
  assertTestnetConfig,
} from "../../packages/xrpl-adapter/src/index";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SECRETS_DIR = path.join(ROOT, ".secrets");
export const SECRETS_FILE = path.join(SECRETS_DIR, "testnet-wallets.json");

// Load .env then .env.local (both gitignored). Existing process env wins.
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });

export { TESTNET_NETWORK };
export const DEFAULT_WS_URL = ALLOWED_TESTNET_WS_URLS[0] as string;

export interface XrplConfig {
  network: string;
  wsUrl: string;
  issuer: string;
  currencyHex: string;
}

/**
 * Refuses to continue unless XRPL_NETWORK is exactly "xrpl-testnet" (spec 10.1), the WebSocket URL is on the
 * exact Testnet allowlist and the RLUSD issuer is not the Mainnet issuer. Fail closed.
 */
export function loadConfig(): XrplConfig {
  const network = process.env.XRPL_NETWORK;
  const wsUrl = process.env.XRPL_WS_URL ?? DEFAULT_WS_URL;
  assertTestnetConfig(network, wsUrl);
  const issuer = process.env.RLUSD_ISSUER;
  const currencyHex = process.env.RLUSD_CURRENCY_HEX?.toUpperCase();
  assertTestnetAsset(issuer, currencyHex);
  return { network: network as string, wsUrl, issuer: issuer as string, currencyHex: currencyHex as string };
}

export type WalletRole = "treasury" | "supplier";
export type SupplierKind = "cross-border" | "domestic" | "extra";
export const SUPPLIER_KINDS: readonly SupplierKind[] = ["cross-border", "domestic", "extra"];

export interface PublicWallet {
  label: string;
  role: WalletRole;
  kind?: SupplierKind;
  address: string;
}
export interface StoredWallet extends PublicWallet {
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

/** Shape-checks the secrets file and copies only known fields (unknown keys are dropped). */
function parseWalletsFile(raw: string): WalletsFile {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Secrets file is malformed.");
  const f = parsed as Record<string, unknown>;
  if (f.network !== TESTNET_NETWORK) throw new Error("Secrets file is not for xrpl-testnet. Refusing to use it.");
  if (!Array.isArray(f.wallets) || f.wallets.length === 0 || f.wallets.length > 20) throw new Error("Secrets file has no valid wallets list.");
  const wallets: StoredWallet[] = f.wallets.map((w: unknown) => {
    if (typeof w !== "object" || w === null) throw new Error("Secrets file has a malformed wallet entry.");
    const e = w as Record<string, unknown>;
    if (typeof e.label !== "string" || e.label.length === 0 || e.label.length > 64) throw new Error("Secrets file has a wallet without a valid label.");
    if (e.role !== "treasury" && e.role !== "supplier") throw new Error(`Wallet ${e.label}: invalid role.`);
    if (e.kind !== undefined && !SUPPLIER_KINDS.includes(e.kind as SupplierKind)) throw new Error(`Wallet ${e.label}: invalid kind.`);
    if (typeof e.address !== "string" || !isValidClassicAddress(e.address)) throw new Error(`Wallet ${e.label}: invalid address.`);
    if (typeof e.seed !== "string" || e.seed.length === 0) throw new Error(`Wallet ${e.label}: missing seed.`);
    return { label: e.label, role: e.role, ...(e.kind !== undefined ? { kind: e.kind as SupplierKind } : {}), address: e.address, seed: e.seed };
  });
  return { network: f.network, createdAt: typeof f.createdAt === "string" ? f.createdAt : "", wallets };
}

function readRaw(): string {
  if (!existsSync(SECRETS_FILE)) {
    throw new Error("No .secrets/testnet-wallets.json found. Run `pnpm setup:testnet-accounts` first.");
  }
  return readFileSync(SECRETS_FILE, "utf8");
}

/** Includes seeds. Only for code that signs (setup-testnet-accounts, trust-lines). Prefer readPublicWallets / loadSigningWallet. */
export function readWalletsFile(): WalletsFile {
  return parseWalletsFile(readRaw());
}

/** Public data only. Seeds are dropped before this returns. */
export function readPublicWallets(): PublicWallet[] {
  return publicWallets(parseWalletsFile(readRaw()));
}

/** Public data only: never exposes seeds. */
export function publicWallets(file: WalletsFile): PublicWallet[] {
  return file.wallets.map(({ seed: _seed, ...rest }) => rest);
}

/**
 * The signer path: the only place a single seed is turned into a Wallet for a script. The seed string is
 * not returned, logged or stored beyond the Wallet object, and the address is cross-checked.
 */
export function loadSigningWallet(label: string): Wallet {
  const entry = parseWalletsFile(readRaw()).wallets.find((w) => w.label === label);
  if (!entry) throw new Error(`No wallet labelled ${JSON.stringify(label)} in the secrets file.`);
  const wallet = Wallet.fromSeed(entry.seed);
  if (wallet.address !== entry.address) throw new Error(`Wallet ${label}: seed does not match its recorded address`);
  return wallet;
}

/**
 * Launcher-only accessor (scripts/lib/guard-launcher.ts): returns the seed so it can be placed in a child process
 * environment IN MEMORY. The caller must never print, log, write or pass it on argv.
 */
export function loadGuardSignerSeed(label: string): string {
  const entry = parseWalletsFile(readRaw()).wallets.find((w) => w.label === label);
  if (!entry) throw new Error(`No wallet labelled ${JSON.stringify(label)} in the secrets file.`);
  if (Wallet.fromSeed(entry.seed).address !== entry.address) throw new Error(`Wallet ${label}: seed does not match its recorded address`);
  return entry.seed;
}
/** Redacted one-line description of anything thrown (never a stack). */
export function toErrorMessage(err: unknown): string {
  return redactError(err);
}

// Last line of defence: an uncaught error or rejection must not print a raw stack (which can embed argument values).
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (err: unknown) => {
    console.error(`[FAIL   ] unhandled error: ${toErrorMessage(err)}`);
    process.exit(1);
  });
}
