/**
 * M5 end-to-end agent demo through the real MCP tool path and the real payment guard (Testnet, local Docker Postgres).
 *
 * Usage:
 *   pnpm agent:demo -- --check-treasury      # read-only account_lines; prints the RLUSD balance and whether it is >= 6
 *   pnpm agent:demo -- --blocked-only        # default: one blocked run (over-cap invoice), execution disabled, nothing can be sent
 *   pnpm agent:demo -- --enable-execution    # blocked run + ONE real 1 RLUSD paid run (needs treasury >= 6 RLUSD)
 *
 * Budget: exactly ONE real payment of 1 RLUSD, ever. The treasury must keep >= 5 RLUSD afterwards (checked BEFORE
 * submitting). The single-use file .secrets/m5-agent-demo.json is created exclusively before the paid run; if it exists
 * the real mode refuses to run. The signer seed is handled only inside the guard launcher and never printed.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { XrplGateway, amountsEqual, isGreater, subtractAmounts } from "../packages/xrpl-adapter/src/index";
import { LOCAL_DB, loadLocalDbSecrets } from "../packages/database/src/index";
import { auditChainValid, createTestDatabase, invoicePaymentCounts, openLocalAdminPool, paymentReplayInputs, runStatusesForPayment, seedInvoice, seedScenario, type TestDatabase } from "../packages/database/src/testing/index";
import { SECRETS_DIR, loadConfig, readPublicWallets, toErrorMessage } from "./lib/common";
import { startAgent } from "./lib/agent-launcher";
import { startGuard, waitReady, type GuardHandle } from "./lib/guard-launcher";

const REAL_AMOUNT = "1";
const MIN_TREASURY_AFTER = "5";
const MIN_TREASURY_TO_RUN = "6";
const GUARD_PORT = 4013;
const SINGLE_USE_FILE = path.join(SECRETS_DIR, "m5-agent-demo.json");
const USAGE = "Usage: agent-demo --check-treasury | --blocked-only | --enable-execution [--regular-key] | --verify-paid";

type Mode = "check-treasury" | "blocked-only" | "real";

/** Pure: the demo mode from argv. Real submission needs the explicit --enable-execution flag. */
export function parseArgs(argv: readonly string[]): Mode {
  const args = argv.filter((a) => a !== "--" && a !== "--regular-key" && a !== "--verify-paid");
  if (argv.includes("--regular-key") && !args.includes("--enable-execution")) throw new Error(USAGE);
  if (args.length === 0) return "blocked-only";
  if (args.length !== 1) throw new Error(USAGE);
  if (args[0] === "--check-treasury") return "check-treasury";
  if (args[0] === "--blocked-only") return "blocked-only";
  if (args[0] === "--enable-execution") return "real";
  throw new Error(USAGE);
}

/**
 * Pure safety assert: refuse to submit unless the treasury holds at least 6 RLUSD and the payment would leave >= 5.
 * Throws with the reason; returns normally only when a 1 RLUSD payment is safe.
 */
export function assertSafeToPay(balance: string | null): void {
  if (balance === null) throw new Error("Refusing: no RLUSD trust line on the treasury.");
  if (isGreater(MIN_TREASURY_TO_RUN, balance)) throw new Error(`Refusing: treasury holds ${balance} RLUSD, below the ${MIN_TREASURY_TO_RUN} needed to run.`);
  if (isGreater(MIN_TREASURY_AFTER, subtractAmounts(balance, REAL_AMOUNT))) throw new Error(`Refusing: treasury would drop below ${MIN_TREASURY_AFTER} RLUSD (balance ${balance}).`);
}

function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function call(guard: GuardHandle, route: string): Promise<{ http: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${String(guard.port)}${route}`, {
    headers: { authorization: `Bearer ${guard.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  return { http: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function waitForSnapshot(guard: GuardHandle): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const s = await call(guard, "/internal/status");
    if (typeof s.body.snapshot_as_of === "string" && Date.now() - Date.parse(s.body.snapshot_as_of) < 60_000) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("The guard has no fresh balance snapshot.");
}

function writeSingleUse(record: Record<string, unknown>): void {
  const tmp = `${SINGLE_USE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, SINGLE_USE_FILE);
}

interface ProofContext {
  businessId: string;
  invoiceId: string;
  paymentId: string;
  hash: string;
  treasuryAddress: string;
  treasuryAfter: string;
  bal: (address: string) => Promise<string | null>;
}
/** Replay and duplicate requests through the guard, then check payment count, balance, run record and audit chain. */
async function proveNoDoublePay(guard: GuardHandle, pool: TestDatabase["adminPool"], c: ProofContext): Promise<void> {
  const row = await paymentReplayInputs(pool, c.paymentId);
  const key = row?.idempotency_key;
  must(key !== undefined, "the payment must have an idempotency key");
  const reason = row?.agent_reason;
  const post = async (idempotency_key: string) => {
    const res = await fetch(`http://127.0.0.1:${String(guard.port)}/internal/payment-requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${guard.token}`, "content-type": "application/json" },
      body: JSON.stringify({ invoice_id: c.invoiceId, idempotency_key, ...(reason ? { agent_reason: reason } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    return { http: res.status, body: (await res.json()) as { status?: string; payment_id?: string; tx_hash?: string | null; decision_code?: string } };
  };
  const replay = await post(key);
  must(replay.body.payment_id === c.paymentId && replay.body.tx_hash === c.hash, "same-key replay must return the original payment and hash");
  const duplicate = await post(`dup-${key.slice(0, 40)}`);
  must(duplicate.body.status !== "validated" || duplicate.body.payment_id === c.paymentId, "a duplicate request must not create a second payment");
  const counts = await invoicePaymentCounts(pool, c.invoiceId);
  must(counts.validated === "1" && counts.hashed === "1", "exactly one validated payment with a hash must exist for the invoice");
  must((await c.bal(c.treasuryAddress)) === c.treasuryAfter, "treasury balance must not move after the replay and duplicate requests");
  const runs = await runStatusesForPayment(pool, c.businessId, c.paymentId);
  const auditOk = await auditChainValid(pool, c.businessId);
  console.log(`Proof: replay_http=${String(replay.http)} replay_status=${String(replay.body.status)} duplicate_http=${String(duplicate.http)} duplicate_status=${String(duplicate.body.status)} duplicate_code=${String(duplicate.body.decision_code)}`);
  console.log(`Proof: run_status=${runs.join(",")} audit_chain_valid=${String(auditOk)} validated_payments=${counts.validated} payment_rows=${counts.total} treasury_after=${c.treasuryAfter}`);
  must(runs.length === 1 && runs[0] === "paid", "the run record must show the derived outcome paid");
  must(auditOk, "the audit chain must verify");
}
async function verifyPaid(): Promise<void> {
  const cfg = loadConfig();
  const treasury = readPublicWallets().find((w) => w.role === "treasury");
  if (!treasury) throw new Error("Treasury wallet missing from the secrets file.");
  const rec = JSON.parse(readFileSync(SINGLE_USE_FILE, "utf8")) as Record<string, string | undefined>;
  const { database, business_id: businessId, invoice_id: invoiceId, payment_id: paymentId, tx_hash: hash } = rec;
  if (!database || !businessId || !invoiceId || !paymentId || !hash || !/^flow_test_[0-9a-f]+$/.test(database)) throw new Error("The single-use record has no completed payment to verify.");
  const secrets = loadLocalDbSecrets(SECRETS_DIR, false);
  if (secrets === null) throw new Error("No local database secrets.");
  const pool = openLocalAdminPool(secrets, database);
  const gw = await XrplGateway.connect(cfg.network, { wsUrl: cfg.wsUrl });
  let guard: GuardHandle | undefined;
  try {
    const bal = (a: string) => gw.getIssuedBalance(a, cfg.issuer, cfg.currencyHex);
    const treasuryNow = await bal(treasury.address);
    must(treasuryNow !== null, "treasury trust line");
    const databaseUrl = `postgres://flow_guard:${encodeURIComponent(secrets.guardPassword)}@${LOCAL_DB.host}:${String(LOCAL_DB.port)}/${database}`;
    // Kill switch OFF: nothing can be submitted during this verification.
    guard = startGuard({ databaseUrl, businessId, port: GUARD_PORT, treasuryLabel: treasury.label, executionEnabled: false, signerMode: "regular_key" });
    await waitReady(guard, 90_000);
    console.log("Verification guard ready (execution DISABLED).");
    await proveNoDoublePay(guard, pool, { businessId, invoiceId, paymentId, hash, treasuryAddress: treasury.address, treasuryAfter: treasuryNow, bal });
  } finally {
    await guard?.stop();
    await pool.end().catch(() => undefined);
    await gw.disconnect();
  }
}
async function main(): Promise<void> {
  if (process.argv.includes("--verify-paid")) return verifyPaid();
  const mode = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const real = mode === "real";
  const treasury = readPublicWallets().find((w) => w.role === "treasury");
  const supplier = readPublicWallets().find((w) => w.role === "supplier" && w.kind === "cross-border");
  if (!treasury || !supplier) throw new Error("Treasury or cross-border supplier missing from the secrets file.");

  if (real && existsSync(SINGLE_USE_FILE)) {
    const prior = JSON.parse(readFileSync(SINGLE_USE_FILE, "utf8")) as Record<string, unknown>;
    throw new Error(`Refusing: the single real agent payment was already attempted (${typeof prior.tx_hash === "string" ? prior.tx_hash : "no hash recorded"}). Never re-run; reconcile if pending.`);
  }

  const gw = await XrplGateway.connect(cfg.network, { wsUrl: cfg.wsUrl });
  let guard: GuardHandle | undefined;
  let db: TestDatabase | undefined;
  try {
    const bal = (a: string) => gw.getIssuedBalance(a, cfg.issuer, cfg.currencyHex);
    const treasuryBefore = await bal(treasury.address);
    if (mode === "check-treasury") {
      console.log(`treasury_rlusd=${String(treasuryBefore)} sufficient_for_demo=${String(treasuryBefore !== null && !isGreater(MIN_TREASURY_TO_RUN, treasuryBefore))}`);
      return;
    }
    const supplierBefore = await bal(supplier.address);
    if (treasuryBefore === null || supplierBefore === null) throw new Error("Missing RLUSD trust line on treasury or supplier.");
    console.log(`Before: treasury ${treasuryBefore} RLUSD, supplier ${supplierBefore} RLUSD`);
    if (real) assertSafeToPay(treasuryBefore);

    db = await createTestDatabase();
    const sc = await seedScenario(db.adminPool, {
      walletAddress: treasury.address,
      supplierAddress: supplier.address,
      issuer: cfg.issuer,
      currencyHex: cfg.currencyHex,
      maxPayment: "2",
      dailyLimit: "3",
      minimumReserve: "4",
    });
    const overcapId = await seedInvoice(db.adminPool, sc, { amount: "5", invoiceNumber: "INV-DEMO-OVERCAP", description: "DEMO over-cap invoice (sample data)" });

    const databaseUrl = `postgres://flow_guard:${encodeURIComponent(db.secrets.guardPassword)}@${LOCAL_DB.host}:${String(LOCAL_DB.port)}/${db.name}`;
    guard = startGuard({ databaseUrl, businessId: sc.businessId, port: GUARD_PORT, treasuryLabel: treasury.label, executionEnabled: real, signerMode: process.argv.includes("--regular-key") ? "regular_key" : "master_env" });
    await waitReady(guard, 90_000);
    await waitForSnapshot(guard);
    console.log(`Guard ready (Testnet, local database, execution ${real ? "ENABLED" : "disabled"}).`);

    // ---- Run 1: BLOCKED (over-cap probe) ----
    const code1 = await startAgent({ guardPort: guard.port, token: guard.token, args: ["--probe-ineligible", "--record"] });
    must(code1 === 0, `blocked agent run must exit 0 (got ${String(code1)})`);
    const blockedRows = (await call(guard, `/internal/payments?invoice_id=${overcapId}`)).body.payments as { status: string; tx_hash: string | null }[] | undefined;
    must(blockedRows !== undefined && blockedRows.every((p) => p.status === "blocked" && p.tx_hash === null), "the over-cap request must be blocked with no tx hash");
    must((await bal(treasury.address)) === treasuryBefore, "treasury balance must be unchanged after the blocked run");
    console.log("Blocked run complete: no hash, treasury unchanged.");

    if (!real) {
      console.log("Blocked-only run complete. Nothing was submitted.");
      return;
    }

    // ---- Run 2: ONE real paid run ----
    const payableId = await seedInvoice(db.adminPool, sc, { amount: REAL_AMOUNT, invoiceNumber: "INV-DEMO-001", description: "DEMO payable invoice (sample data)" });
    console.log("Waiting 65 s so the guard rate-limit window (30 requests per minute) is clear for the paid run...");
    await new Promise((r) => setTimeout(r, 65_000));
    const fd = openSync(SINGLE_USE_FILE, "wx", 0o600); // throws EEXIST when the budget was already spent
    closeSync(fd);
    writeSingleUse({ startedAt: new Date().toISOString(), database: db.name, business_id: sc.businessId, invoice_id: payableId, amount: REAL_AMOUNT, treasury_before: treasuryBefore, supplier_before: supplierBefore });
    console.log("Starting the ONE authorised real agent run...");
    const code2 = await startAgent({ guardPort: guard.port, token: guard.token, args: ["--record"] });

    const rows = (await call(guard, `/internal/payments?invoice_id=${payableId}`)).body.payments as { payment_id: string }[] | undefined;
    const paymentId = rows?.[0]?.payment_id ?? null;
    must(paymentId !== null, "a payment row must exist for the payable invoice");
    let current = (await call(guard, `/internal/payments/${paymentId}`)).body as { status: string; tx_hash: string | null };
    for (let i = 0; i < 40 && !["validated", "failed", "cancelled", "blocked"].includes(current.status); i++) {
      console.log(`Payment is ${current.status}; reconciling (no retry).`);
      await fetch(`http://127.0.0.1:${String(guard.port)}/internal/reconcile`, { method: "POST", headers: { authorization: `Bearer ${guard.token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30_000) });
      await new Promise((r) => setTimeout(r, 5000));
      current = (await call(guard, `/internal/payments/${paymentId}`)).body as { status: string; tx_hash: string | null };
    }
    const hash = current.tx_hash;
    writeSingleUse({ ...(JSON.parse(readFileSync(SINGLE_USE_FILE, "utf8")) as Record<string, unknown>), payment_id: paymentId, agent_exit: code2, status: current.status, tx_hash: hash });
    must(current.status === "validated" && hash !== null, `payment must be validated (got ${current.status}); do NOT re-run, reconcile instead`);

    const tx = await gw.lookupTx(hash);
    must(tx.status === "found" && tx.validated && tx.resultCode === "tesSUCCESS", "ledger must show a validated tesSUCCESS transaction");
    const treasuryAfter = await bal(treasury.address);
    must(treasuryAfter !== null && amountsEqual(subtractAmounts(treasuryAfter, treasuryBefore), `-${REAL_AMOUNT}`), "treasury delta must be exactly -1");
    must(!isGreater(MIN_TREASURY_AFTER, treasuryAfter), "treasury must still hold >= 5 RLUSD");
    await proveNoDoublePay(guard, db.adminPool, { businessId: sc.businessId, invoiceId: payableId, paymentId, hash, treasuryAddress: treasury.address, treasuryAfter, bal });
    writeSingleUse({ ...(JSON.parse(readFileSync(SINGLE_USE_FILE, "utf8")) as Record<string, unknown>), completed: true, treasury_after: treasuryAfter });
    console.log(`PAID: payment ${paymentId}, hash ${hash}, treasury ${treasuryBefore} -> ${treasuryAfter} RLUSD`);
    console.log(`Explorer: https://testnet.xrpl.org/transactions/${hash}`);
  } finally {
    await guard?.stop();
    if (db) {
      if (real) await Promise.all([db.guardPool.end(), db.noGrantPool.end(), db.adminPool.end()]).catch(() => undefined);
      else await db.drop();
    }
    await gw.disconnect();
  }
}

// Run only when executed directly (the pure helpers above are importable without side effects).
if (process.argv[1] !== undefined && /agent-demo\.[cm]?[tj]s$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(`[FAIL   ] agent-demo aborted: ${toErrorMessage(err)}`);
    process.exit(1);
  });
}
