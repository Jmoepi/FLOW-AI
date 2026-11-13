/**
 * M3 end-to-end demo through the payment guard HTTP API (Testnet only, local Docker Postgres).
 *
 * Usage:
 *   pnpm m3:e2e -- --blocked-only            # over-cap request only; the payable invoice is never seeded, nothing can be sent
 *   pnpm m3:e2e -- --confirm-real-payment    # blocked demo + ONE real 1 RLUSD payment + duplicate request
 *
 * Budget: exactly ONE real payment of 1 RLUSD, ever. The treasury must keep >= 5 RLUSD afterwards (checked BEFORE
 * submitting). The single-use file .secrets/m3-e2e.json is created exclusively before the payment request; if it exists
 * the real mode refuses to run. A pending result is reconciled through the guard, never retried.
 * The signer seed is handled only inside the launcher (scripts/lib/guard-launcher.ts) and never printed.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  XrplGateway,
  amountsEqual,
  isGreater,
  issuedAmountsEqual,
  subtractAmounts,
} from "../packages/xrpl-adapter/src/index";
import { LOCAL_DB, verifyAuditChain } from "../packages/database/src/index";
import {
  auditEventTypes,
  createTestDatabase,
  heldTotal,
  paymentSummaries,
  seedInvoice,
  seedScenario,
  tableCounts,
  type TestDatabase,
} from "../packages/database/src/testing/index";
import { SECRETS_DIR, loadConfig, readPublicWallets, toErrorMessage } from "./lib/common";
import { startGuard, waitReady, type GuardHandle } from "./lib/guard-launcher";

const REAL_AMOUNT = "1";
const MIN_TREASURY_AFTER = "5";
const GUARD_PORT = 4012;
const EXPLORER = "https://testnet.xrpl.org/transactions/";
const SINGLE_USE_FILE = path.join(SECRETS_DIR, "m3-e2e.json");

interface Args {
  mode: "blocked-only" | "real";
}

function parseArgs(argv: readonly string[]): Args {
  const args = argv.filter((a) => a !== "--");
  if (args.length !== 1) throw new Error("Usage: m3-e2e --blocked-only | --confirm-real-payment");
  if (args[0] === "--blocked-only") return { mode: "blocked-only" };
  if (args[0] === "--confirm-real-payment") return { mode: "real" };
  throw new Error("Unknown argument. Usage: m3-e2e --blocked-only | --confirm-real-payment");
}

interface GuardBody {
  payment_id: string | null;
  status: string;
  amount: string | null;
  tx_hash: string | null;
  explorer_url?: string;
  failure_code: string | null;
  policy_decision?: { allowed: boolean; decision_code: string };
}

async function call(guard: GuardHandle, method: "GET" | "POST", route: string, body?: unknown): Promise<{ http: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${String(guard.port)}${route}`, {
    method,
    headers: { authorization: `Bearer ${guard.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(150_000),
  });
  return { http: res.status, body: (await res.json()) as Record<string, unknown> };
}

function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Single-use record: ids and hashes only, no secrets. Exclusive create is the "budget spent" lock. */
function createSingleUse(record: Record<string, unknown>): void {
  const fd = openSync(SINGLE_USE_FILE, "wx", 0o600); // throws EEXIST when a real payment was already attempted
  closeSync(fd);
  writeSingleUse(record);
}
function writeSingleUse(record: Record<string, unknown>): void {
  const tmp = `${SINGLE_USE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, SINGLE_USE_FILE);
}

async function waitForSnapshot(guard: GuardHandle): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const s = await call(guard, "GET", "/internal/status");
    if (typeof s.body.snapshot_as_of === "string" && Date.now() - Date.parse(s.body.snapshot_as_of) < 60_000) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("The guard has no fresh balance snapshot.");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const real = args.mode === "real";
  const wallets = readPublicWallets();
  const treasury = wallets.find((w) => w.role === "treasury");
  const supplier = wallets.find((w) => w.role === "supplier" && w.kind === "cross-border");
  if (!treasury || !supplier) throw new Error("Treasury or cross-border supplier missing from the secrets file.");

  if (real && existsSync(SINGLE_USE_FILE)) {
    const prior = JSON.parse(readFileSync(SINGLE_USE_FILE, "utf8")) as Record<string, unknown>;
    throw new Error(`Refusing: the single real payment was already attempted (${typeof prior.tx_hash === "string" ? prior.tx_hash : "no hash recorded"}). Reuse the recorded evidence; reconcile if pending. Never re-run.`);
  }

  const gw = await XrplGateway.connect(cfg.network, { wsUrl: cfg.wsUrl });
  let guard: GuardHandle | undefined;
  let db: TestDatabase | undefined;
  try {
    const bal = (a: string) => gw.getIssuedBalance(a, cfg.issuer, cfg.currencyHex);
    const treasuryBefore = await bal(treasury.address);
    const supplierBefore = await bal(supplier.address);
    if (treasuryBefore === null || supplierBefore === null) throw new Error("Missing RLUSD trust line on treasury or supplier.");
    console.log(`Before: treasury ${treasuryBefore} RLUSD, supplier ${supplierBefore} RLUSD`);
    if (real && isGreater(MIN_TREASURY_AFTER, subtractAmounts(treasuryBefore, REAL_AMOUNT))) {
      throw new Error(`Refusing: treasury would drop below ${MIN_TREASURY_AFTER} RLUSD (balance ${treasuryBefore}).`);
    }

    // Fresh throwaway local database with the guard's least-privilege role.
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
    const payableId = real ? await seedInvoice(db.adminPool, sc, { amount: REAL_AMOUNT, invoiceNumber: "INV-DEMO-001", description: "DEMO payable invoice (sample data)" }) : null;

    const databaseUrl = `postgres://flow_guard:${encodeURIComponent(db.secrets.guardPassword)}@${LOCAL_DB.host}:${String(LOCAL_DB.port)}/${db.name}`;
    guard = startGuard({ databaseUrl, businessId: sc.businessId, port: GUARD_PORT, treasuryLabel: treasury.label });
    await waitReady(guard, 90_000);
    await waitForSnapshot(guard);
    console.log("Guard ready (Testnet, local database).");

    // ---- BLOCKED demo ----
    const blockedKey = `m3-blocked-${randomBytes(6).toString("hex")}`;
    const blocked = await call(guard, "POST", "/internal/payment-requests", { invoice_id: overcapId, idempotency_key: blockedKey, agent_reason: "M3 demo: over-cap invoice" });
    const bb = blocked.body as unknown as GuardBody;
    console.log(`BLOCKED demo: http ${String(blocked.http)}, status ${bb.status}, code ${String(bb.failure_code)}, tx_hash ${String(bb.tx_hash)}`);
    must(blocked.http === 200 && bb.status === "blocked", "over-cap request must be blocked");
    must(bb.failure_code === "PAYMENT_LIMIT_EXCEEDED", "block code must be PAYMENT_LIMIT_EXCEEDED");
    must(bb.tx_hash === null, "a blocked request must have no tx hash");
    const countsBlocked = await tableCounts(db.adminPool);
    must(countsBlocked.reservations === 0, "a blocked request must create no reservation");
    must((await bal(treasury.address)) === treasuryBefore, "treasury balance must be unchanged after the blocked request");
    console.log(`Blocked evidence: payments rows ${String(countsBlocked.payments)}, reservations ${String(countsBlocked.reservations)}, treasury unchanged.`);

    if (!real) {
      console.log("Blocked-only run complete. Nothing was submitted.");
      return;
    }
    must(payableId !== null, "payable invoice");

    // ---- ONE real payment ----
    const key = `m3-e2e-${randomBytes(8).toString("hex")}`;
    createSingleUse({ startedAt: new Date().toISOString(), database: db.name, business_id: sc.businessId, invoice_id: payableId, idempotency_key: key, amount: REAL_AMOUNT, treasury_before: treasuryBefore, supplier_before: supplierBefore });
    console.log("Submitting the ONE authorised real payment through the guard...");
    let first: GuardBody | undefined;
    let firstHttp = 0;
    try {
      const r = await call(guard, "POST", "/internal/payment-requests", { invoice_id: payableId, idempotency_key: key, agent_reason: "M3 demo: pay INV-DEMO-001" });
      first = r.body as unknown as GuardBody;
      firstHttp = r.http;
    } catch (err) {
      console.error(`Payment request did not return cleanly (${toErrorMessage(err)}). NOT retrying; looking the payment up instead.`);
    }
    let paymentId = first?.payment_id ?? null;
    if (paymentId === null) {
      const list = await call(guard, "GET", `/internal/payments?invoice_id=${payableId}`);
      const rows = list.body.payments as { payment_id: string }[] | undefined;
      paymentId = rows?.[0]?.payment_id ?? null;
    }
    must(paymentId !== null, "a payment row must exist for the payable invoice");
    writeSingleUse({ ...(JSON.parse(readFileSync(SINGLE_USE_FILE, "utf8")) as Record<string, unknown>), payment_id: paymentId, first_http: firstHttp });

    // Pending / in flight: reconcile through the guard (persisted hash + LastLedgerSequence), never a new payment.
    let current = (await call(guard, "GET", `/internal/payments/${paymentId}`)).body as unknown as GuardBody;
    for (let i = 0; i < 40 && !["validated", "failed", "cancelled", "blocked"].includes(current.status); i++) {
      console.log(`Payment is ${current.status}; reconciling (no retry).`);
      await call(guard, "POST", "/internal/reconcile", {});
      await new Promise((r) => setTimeout(r, 5000));
      current = (await call(guard, "GET", `/internal/payments/${paymentId}`)).body as unknown as GuardBody;
    }
    const hash = current.tx_hash;
    console.log(`Final guard status: ${current.status}, hash ${String(hash)}`);
    writeSingleUse({ ...(JSON.parse(readFileSync(SINGLE_USE_FILE, "utf8")) as Record<string, unknown>), status: current.status, tx_hash: hash });
    must(current.status === "validated" && hash !== null, `payment must be validated (got ${current.status}); do NOT re-run, reconcile instead`);

    // Independent ledger proof.
    const tx = await gw.lookupTx(hash);
    must(tx.status === "found" && tx.validated, "ledger must show the transaction as validated");
    must(tx.resultCode === "tesSUCCESS", "result must be tesSUCCESS");
    must(issuedAmountsEqual(tx.deliveredAmount, { currency: cfg.currencyHex, issuer: cfg.issuer, value: REAL_AMOUNT }), "delivered_amount must equal 1 RLUSD of the configured pair");
    const treasuryAfter = await bal(treasury.address);
    const supplierAfter = await bal(supplier.address);
    must(treasuryAfter !== null && supplierAfter !== null, "balances readable after payment");
    const tDelta = subtractAmounts(treasuryAfter, treasuryBefore);
    const sDelta = subtractAmounts(supplierAfter, supplierBefore);
    must(amountsEqual(tDelta, `-${REAL_AMOUNT}`) && amountsEqual(sDelta, REAL_AMOUNT), "balance deltas must be exactly -1 / +1");
    must(!isGreater(MIN_TREASURY_AFTER, treasuryAfter), "treasury must still hold >= 5 RLUSD");

    // ---- Duplicate request, same key ----
    const dup = await call(guard, "POST", "/internal/payment-requests", { invoice_id: payableId, idempotency_key: key, agent_reason: "M3 demo: pay INV-DEMO-001" });
    const db2 = dup.body as unknown as GuardBody;
    must(dup.http === 200 && db2.payment_id === paymentId && db2.tx_hash === hash && db2.status === "validated", "duplicate must return the identical stored result");
    must((await bal(treasury.address)) === treasuryAfter, "treasury balance must not change after the duplicate");
    console.log("Duplicate request: identical stored result, no second payment.");

    // ---- DB evidence (statuses and counts only) ----
    const summaries = await paymentSummaries(db.adminPool, sc.businessId);
    const row = summaries.find((s) => s.id === paymentId);
    must(row !== undefined, "payment row visible to the admin pool");
    must(row.status === "validated" && row.reservation === "committed" && row.invoice_status === "paid" && !row.signed_blob_present, "DB state: validated / committed / paid / signed_blob NULL");
    const events = await auditEventTypes(db.adminPool, paymentId);
    const chainOk = await verifyAuditChain(db.adminPool, sc.businessId);
    must(chainOk, "audit chain must verify");
    const counts = await tableCounts(db.adminPool);
    const held = await heldTotal(db.adminPool, sc.businessId);

    const evidence = {
      payment_id: paymentId,
      tx_hash: hash,
      explorer_url: `${EXPLORER}${hash}`,
      ledger_index: tx.ledgerIndex,
      result_code: tx.resultCode,
      delivered_amount: tx.deliveredAmount,
      fee_drops: tx.feeDrops,
      treasury: { before: treasuryBefore, after: treasuryAfter, delta: tDelta },
      supplier: { before: supplierBefore, after: supplierAfter, delta: sDelta },
      db: { database: db.name, payments: summaries.map((s) => ({ status: s.status, failure_code: s.failure_code, reservation: s.reservation, invoice: s.invoice_status, signed_blob_present: s.signed_blob_present, delivered_amount: s.delivered_amount, result_code: s.result_code })), audit_events: events, audit_chain_ok: chainOk, counts, held_total: held },
      blocked: { status: bb.status, failure_code: bb.failure_code, tx_hash: bb.tx_hash },
      duplicate: { http: dup.http, same_payment_id: true, same_tx_hash: true },
    };
    writeSingleUse({ ...(JSON.parse(readFileSync(SINGLE_USE_FILE, "utf8")) as Record<string, unknown>), completed: true, evidence });
    console.log(JSON.stringify(evidence, null, 2));
    console.log(`Explorer: ${EXPLORER}${hash}`);
  } finally {
    await guard?.stop();
    if (db) {
      if (real) await Promise.all([db.guardPool.end(), db.noGrantPool.end(), db.adminPool.end()]).catch(() => undefined);
      else await db.drop();
    }
    await gw.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`[FAIL   ] m3-e2e aborted: ${toErrorMessage(err)}`);
  process.exit(1);
});
