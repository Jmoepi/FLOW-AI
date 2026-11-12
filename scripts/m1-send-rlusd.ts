/**
 * M1: one real, validated RLUSD payment from a script (spec 10.3, section 16 Step 2). Testnet only.
 *
 * Usage:
 *   pnpm m1:send -- --dry-run                      # prepare + sign + log, never submits
 *   pnpm m1:send                                   # send 1 RLUSD treasury -> cross-border supplier
 *   pnpm m1:send -- --to domestic --amount 1
 *   pnpm m1:send -- --resume <runId>               # reconcile a run that ended pending (never signs again)
 *
 * Hard M1 limits (the faucet only gives 10 RLUSD per claim per 24 h): amount <= 2 RLUSD, treasury must keep
 * >= 5 RLUSD after the send, at most 2 real signed payments in total across all runs (see the log).
 * The seed is read from .secrets/testnet-wallets.json inside this process and is never printed or logged.
 * Append-only log: .secrets/m1-transactions.json (gitignored; contains hashes, never seeds).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  XrplGateway,
  amountsEqual,
  parseAmount,
  sendIouPayment,
  submitAndWait,
  subtractAmounts,
  isGreater,
  walletSigner,
  type IssuedAmount,
  type PaymentEvent,
  type PaymentOutcome,
} from "../packages/xrpl-adapter/src/index";
import { SECRETS_DIR, SUPPLIER_KINDS, loadConfig, loadSigningWallet, readPublicWallets, toErrorMessage, type SupplierKind } from "./lib/common";

const M1_MAX_AMOUNT = "2";
const M1_MIN_TREASURY_AFTER = "5";
const M1_MAX_REAL_PAYMENTS = 2;
const LOG_FILE = path.join(SECRETS_DIR, "m1-transactions.json");
const LOCK_FILE = path.join(SECRETS_DIR, "m1-transactions.lock");
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXPLORER = "https://testnet.xrpl.org/transactions/";

type LogEvent = { at: string; runId: string; dryRun: boolean; type: string; [k: string]: unknown };

/**
 * Single-writer lock (exclusive create). Two concurrent runs could both read "budget not used" and both pay,
 * or interleave log writes. A lock left by a dead process is detected by PID and removed; a live one blocks.
 */
function acquireLock(): () => void {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      const release = () => {
        try {
          unlinkSync(LOCK_FILE);
        } catch {
          /* already gone */
        }
      };
      process.once("exit", release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number.parseInt(readFileSync(LOCK_FILE, "utf8"), 10);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (killErr) {
        alive = (killErr as NodeJS.ErrnoException).code === "EPERM";
      }
      if (alive || !Number.isInteger(pid)) {
        throw new Error(`Another m1:send run holds ${path.basename(LOCK_FILE)} (pid ${String(pid)}). If no run is active, delete that file and retry.`, { cause: err });
      }
      unlinkSync(LOCK_FILE); // stale lock from a crashed run
    }
  }
  throw new Error("Could not acquire the m1:send lock");
}

function readLog(): LogEvent[] {
  if (!existsSync(LOG_FILE)) return [];
  const parsed = JSON.parse(readFileSync(LOG_FILE, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${LOG_FILE} is not a JSON array`);
  // Fail closed: a damaged log could hide spent budget, so refuse to continue rather than guess.
  for (const e of parsed) {
    const o = e as Record<string, unknown> | null;
    if (typeof o !== "object" || o === null || Array.isArray(o) || typeof o.runId !== "string" || typeof o.type !== "string" || typeof o.dryRun !== "boolean") {
      throw new Error(`${LOG_FILE} contains a malformed entry. Refusing to continue.`);
    }
  }
  return parsed as LogEvent[];
}

/** Append-only: existing entries are never modified. Written via temp file + rename, owner-only mode. */
function append(ev: { runId: string; dryRun: boolean; type: string; [k: string]: unknown }): void {
  const all = readLog();
  all.push({ ...ev, at: new Date().toISOString() });
  const tmp = `${LOG_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, LOG_FILE);
}

function parseArgs(argv: string[]) {
  const out = { dryRun: false, to: "cross-border" as SupplierKind, amount: "1", resume: undefined as string | undefined };
  const seen = new Set<string>();
  const value = (flag: string, i: number): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") continue;
    if (seen.has(a)) throw new Error(`Duplicate argument ${a}`);
    seen.add(a);
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--to") {
      const v = value(a, ++i);
      if (!SUPPLIER_KINDS.includes(v as SupplierKind)) throw new Error(`--to must be one of ${SUPPLIER_KINDS.join(", ")}`);
      out.to = v as SupplierKind;
    } else if (a === "--amount") out.amount = value(a, ++i);
    else if (a === "--resume") {
      const v = value(a, ++i);
      if (!RUN_ID_RE.test(v)) throw new Error("--resume expects a run id (UUID)");
      out.resume = v;
    } else throw new Error("Unknown argument");
  }
  if (out.resume && (out.dryRun || seen.has("--to") || seen.has("--amount"))) throw new Error("--resume cannot be combined with --dry-run, --to or --amount");
  return out;
}

function describe(o: PaymentOutcome): string {
  switch (o.kind) {
    case "validated_success":
      return `VALIDATED ${o.resultCode} in ledger ${o.ledgerIndex}, delivered_amount ${JSON.stringify(o.deliveredAmount)}, fee ${o.feeDrops ?? "?"} drops`;
    case "validated_failed":
      return `FAILED on ledger ${o.resultCode} in ledger ${o.ledgerIndex} (fee burned: ${o.feeDrops ?? "?"} drops)`;
    case "partial_delivery":
      return `PARTIAL_DELIVERY ${o.resultCode} in ledger ${o.ledgerIndex}, delivered_amount ${JSON.stringify(o.deliveredAmount)}`;
    case "failed_expired":
      return `FAILED_EXPIRED: validated ledger ${o.validatedLedgerIndex} is past LastLedgerSequence ${o.lastLedgerSequence} and the tx is in no validated ledger`;
    case "pending":
      return `PENDING_CONFIRMATION (${o.reason}); LastLedgerSequence ${o.lastLedgerSequence}, validated ledger ${o.validatedLedgerIndex}`;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(); // fails closed unless XRPL_NETWORK=xrpl-testnet
  const releaseLock = acquireLock();
  let gw: XrplGateway | undefined;
  try {
    gw = await XrplGateway.connect(cfg.network, { wsUrl: cfg.wsUrl }); // allowlist + server network_id === 1
    await run(gw, args, cfg);
  } finally {
    await gw?.disconnect();
    releaseLock();
  }
}

type Args = ReturnType<typeof parseArgs>;

async function run(gw: XrplGateway, args: Args, cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const wallets = readPublicWallets(); // addresses only
  const treasuryW = wallets.find((w) => w.role === "treasury");
  if (!treasuryW) throw new Error("No treasury wallet in .secrets/testnet-wallets.json");
  const supplier = wallets.find((w) => w.role === "supplier" && w.kind === args.to);
  if (!supplier) throw new Error(`No supplier of kind "${args.to}" in the secrets file`);
  const bal = (account: string) => gw.getIssuedBalance(account, cfg.issuer, cfg.currencyHex);

  // ---- resume path: reconcile only, never sign again ----
  if (args.resume) {
    const events = readLog().filter((e) => e.runId === args.resume);
    const signedEv = events.find((e) => e.type === "signed" && e.dryRun === false);
    const startedEv = events.find((e) => e.type === "started");
    if (!signedEv || !startedEv) throw new Error(`No real signed run ${args.resume} in the log`);
    if (events.some((e) => e.type === "outcome" && (e.outcome as PaymentOutcome).kind !== "pending")) {
      throw new Error(`Run ${args.resume} already has a final outcome; nothing to do`);
    }
    const amount = signedEv.amount as IssuedAmount;
    if (
      typeof signedEv.hash !== "string" || typeof signedEv.txBlob !== "string" || typeof signedEv.lastLedgerSequence !== "number" || !Number.isInteger(signedEv.lastLedgerSequence) ||
      typeof amount?.value !== "string" || amount.currency !== cfg.currencyHex || amount.issuer !== cfg.issuer || startedEv.from !== treasuryW.address
    ) {
      throw new Error(`Run ${args.resume} in the log does not match the current configuration. Refusing to resubmit.`);
    }
    const outcome = await submitAndWait(
      gw,
      { hash: signedEv.hash, txBlob: signedEv.txBlob, lastLedgerSequence: signedEv.lastLedgerSequence, amount },
      { onEvent: (e) => logEvent(args.resume!, false, e) },
    );
    console.log(describe(outcome));
    await proveBalances(args.resume, startedEv, outcome, amount.value);
    return;
  }

  // ---- guards ----
  const amount = parseAmount(args.amount);
  if (isGreater(amount, M1_MAX_AMOUNT)) {
    throw new Error(`Refusing: amount ${amount} exceeds the M1 maximum of ${M1_MAX_AMOUNT} RLUSD`);
  }
  const log = readLog();
  const realRuns = new Set(log.filter((e) => e.type === "signed" && e.dryRun === false).map((e) => e.runId));
  if (!args.dryRun) {
    if (realRuns.size >= M1_MAX_REAL_PAYMENTS) throw new Error(`Refusing: M1 budget used (${realRuns.size}/${M1_MAX_REAL_PAYMENTS} real payments signed)`);
    const unresolved = [...realRuns].filter((id) => !log.some((e) => e.runId === id && e.type === "outcome" && (e.outcome as PaymentOutcome).kind !== "pending"));
    if (unresolved.length) throw new Error(`Refusing: unresolved run(s) ${unresolved.join(", ")}. Reconcile with --resume <runId> first.`);
  }

  // Signer path: the seed is read here, turned into a Wallet and never printed, logged or returned.
  const wallet = loadSigningWallet(treasuryW.label);
  const senderBefore = await bal(treasuryW.address);
  const receiverBefore = await bal(supplier.address);
  if (senderBefore === null) throw new Error("Treasury has no RLUSD trust line");
  if (receiverBefore === null) throw new Error(`Destination ${supplier.address} has no RLUSD trust line (spec 10.2)`);
  if (isGreater(M1_MIN_TREASURY_AFTER, subtractAmounts(senderBefore, amount))) {
    throw new Error(`Refusing: treasury would drop below ${M1_MIN_TREASURY_AFTER} RLUSD (balance ${senderBefore}, sending ${amount})`);
  }

  const runId = randomUUID();
  const startedEv = {
    runId,
    dryRun: args.dryRun,
    type: "started",
    from: treasuryW.address,
    to: supplier.address,
    toKind: args.to,
    amount: { currency: cfg.currencyHex, issuer: cfg.issuer, value: amount },
    senderBefore,
    receiverBefore,
  };
  append(startedEv);
  console.log(`Run ${runId}${args.dryRun ? " (DRY RUN)" : ""}: ${amount} RLUSD ${treasuryW.address} -> ${supplier.address} (${args.to})`);
  console.log(`Before: sender ${senderBefore} RLUSD, receiver ${receiverBefore} RLUSD`);

  const result = await sendIouPayment({
    gateway: gw,
    signer: walletSigner(wallet),
    destination: supplier.address,
    currency: cfg.currencyHex,
    issuer: cfg.issuer,
    value: amount,
    dryRun: args.dryRun,
    // Persist hash + LastLedgerSequence (+ blob for real runs) BEFORE submit.
    onSigned: (s) => {
      append({
        runId,
        dryRun: args.dryRun,
        type: "signed",
        hash: s.hash,
        lastLedgerSequence: s.lastLedgerSequence,
        sequence: s.sequence,
        feeDrops: s.feeDrops,
        amount: s.amount,
        ...(args.dryRun ? {} : { txBlob: s.txBlob }),
      });
      console.log(`Signed: hash ${s.hash}, LastLedgerSequence ${s.lastLedgerSequence}, Sequence ${s.sequence}, Fee ${s.feeDrops} drops`);
    },
    wait: { onEvent: (e) => logEvent(runId, args.dryRun, e) },
  });

  if (args.dryRun || !result.outcome) {
    console.log("Dry run complete: signed and logged, nothing submitted.");
    console.log(`Hash that WOULD be used: ${result.signed.hash} (not on ledger)`);
    return;
  }
  console.log(describe(result.outcome));
  await proveBalances(runId, startedEv, result.outcome, amount);

  function logEvent(runId: string, dryRun: boolean, e: PaymentEvent): void {
    if (e.type === "signed") return; // the full "signed" record is written by onSigned
    if (e.type === "poll") {
      const key = e.outcome.kind === "pending" ? `${e.outcome.reason}|${e.outcome.seenOnLedger}` : e.outcome.kind;
      if (key === lastPollKey) return;
      lastPollKey = key;
    }
    append({ runId, dryRun, ...e });
  }

  async function proveBalances(runId: string, started: Record<string, unknown>, outcome: PaymentOutcome, amount: string): Promise<void> {
    // Only a settled outcome is final; a still-pending run is resumed later and must not look finished in the log.
    if (outcome.kind !== "pending") append({ runId, dryRun: false, type: "final", outcome, explorer: EXPLORER + outcome.hash });
    console.log(`Hash: ${outcome.hash}`);
    console.log(`Explorer: ${EXPLORER}${outcome.hash}`);
    if (outcome.kind !== "validated_success") {
      process.exitCode = 1;
      console.log("No balance delta expected/proven for this outcome.");
      return;
    }
        const sAfter = await gw.getIssuedBalance(started.from as string, cfg.issuer, cfg.currencyHex);
    const rAfter = await gw.getIssuedBalance(started.to as string, cfg.issuer, cfg.currencyHex);
    if (sAfter === null || rAfter === null) throw new Error("Trust line vanished while reading balances");
    const sDelta = subtractAmounts(sAfter, started.senderBefore as string);
    const rDelta = subtractAmounts(rAfter, started.receiverBefore as string);
    console.log(`After:  sender ${sAfter} RLUSD (delta ${sDelta}), receiver ${rAfter} RLUSD (delta ${rDelta})`);
    const ok = amountsEqual(sDelta, `-${amount}`) && amountsEqual(rDelta, amount);
    append({ runId, dryRun: false, type: "balances_after", senderAfter: sAfter, receiverAfter: rAfter, senderDelta: sDelta, receiverDelta: rDelta, exactDeltaProven: ok });
    console.log(ok ? "Balance delta PROVEN: sender -amount, receiver +amount." : "BALANCE DELTA MISMATCH");
    if (!ok) process.exitCode = 1;
  }
}

let lastPollKey = "";

main().catch((err) => {
  console.error(`[FAIL   ] m1-send-rlusd aborted: ${toErrorMessage(err)}`);
  process.exit(1);
});
