/**
 * Pure helpers for the owner key scripts (M7, spec 10.6 to 10.8). No I/O and no seeds here.
 * The ONLY transaction type these scripts may build is SetRegularKey. There is no code path that builds an
 * account-settings transaction, so the master key can never be disabled (10.6).
 */
export const SET_REGULAR_KEY = "SetRegularKey";

/** Fields the owner key scripts may sign. Anything else is refused before signing. */
const ALLOWED_TX_FIELDS: ReadonlySet<string> = new Set(["TransactionType", "Account", "RegularKey", "Fee", "Sequence", "LastLedgerSequence", "NetworkID"]);

export interface SetRegularKeyTx {
  TransactionType: "SetRegularKey";
  Account: string;
  /** Omitted to revoke (the ledger then has no RegularKey). */
  RegularKey?: string;
}

export function buildSetRegularKeyTx(account: string, regularKeyAddress?: string): SetRegularKeyTx {
  return regularKeyAddress === undefined ? { TransactionType: SET_REGULAR_KEY, Account: account } : { TransactionType: SET_REGULAR_KEY, Account: account, RegularKey: regularKeyAddress };
}

/** Runs immediately before signing. Throws for any other transaction type or field, so no flag can ever be set. */
export function assertSetRegularKeyOnly(tx: unknown, account: string): void {
  if (typeof tx !== "object" || tx === null) throw new Error("Refusing to sign: not a transaction.");
  const rec = tx as Record<string, unknown>;
  if (rec.TransactionType !== SET_REGULAR_KEY) throw new Error("Refusing to sign: only SetRegularKey is allowed.");
  if (rec.Account !== account) throw new Error("Refusing to sign: Account is not the treasury.");
  for (const k of Object.keys(rec)) if (!ALLOWED_TX_FIELDS.has(k) && rec[k] !== undefined) throw new Error(`Refusing to sign: field ${k} is not allowed.`);
  if (rec.RegularKey !== undefined && (typeof rec.RegularKey !== "string" || rec.RegularKey === account)) throw new Error("Refusing to sign: invalid RegularKey.");
}

export type RegularKeyState = "not_set" | "active" | "other" | "not_configured";

/** Compares the ledger RegularKey with the configured guard key ADDRESS (public). */
export function regularKeyState(ledgerKey: string | null, configuredAddress: string | null): RegularKeyState {
  if (ledgerKey === null) return "not_set";
  if (configuredAddress === null) return "other";
  return ledgerKey === configuredAddress ? "active" : "other";
}

/** Extracts ONLY the public address line from a guard-regular-key.env text. The seed line is never read into a result. */
export function parseRegularKeyAddress(text: string): string | null {
  const m = /^XRPL_REGULAR_KEY_ADDRESS=(r[1-9A-HJ-NP-Za-km-z]{24,34})\s*$/m.exec(text);
  return m?.[1] ?? null;
}

/**
 * Launcher/proof only: returns the guard regular-key seed so it can be placed in a CHILD env in memory.
 * The caller must never print, log, write or pass it on argv.
 */
export function parseRegularKeySeed(text: string): string | null {
  const m = /^XRPL_REGULAR_KEY_SEED=(s[1-9A-HJ-NP-Za-km-z]{20,40})\s*$/m.exec(text);
  return m?.[1] ?? null;
}

export function formatRegularKeyEnv(seed: string, address: string): string {
  return `# Guard signing key (M7). Gitignored. Never commit or print.\nXRPL_REGULAR_KEY_SEED=${seed}\nXRPL_REGULAR_KEY_ADDRESS=${address}\n`;
}

export interface OwnerKeyArgs {
  command: "set" | "revoke" | "status";
  confirm: boolean;
  rotate: boolean;
}

/** Explicit invocation only: a subcommand is required and unknown flags are refused. */
export function parseOwnerKeyArgs(argv: readonly string[]): OwnerKeyArgs {
  const args = argv.filter((a) => a !== "--");
  const [command, ...flags] = args;
  if (command !== "set" && command !== "revoke" && command !== "status") throw new Error("Usage: owner-key <set|revoke|status> [--confirm] [--rotate]");
  let confirm = false;
  let rotate = false;
  for (const f of flags) {
    if (f === "--confirm") confirm = true;
    else if (f === "--rotate" && command === "set") rotate = true;
    else throw new Error("Usage: owner-key <set|revoke|status> [--confirm] [--rotate]");
  }
  if (command === "status" && confirm) throw new Error("status is read-only and takes no --confirm.");
  return { command, confirm, rotate };
}
