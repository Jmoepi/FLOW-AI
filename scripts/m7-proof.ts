/**
 * M7 Testnet proof tooling (fee only; no RLUSD ever moves). Testnet only.
 *   pnpm m7:proof -- probe --confirm-testnet [--old-key]
 *       Signs a 1 RLUSD Payment through the GUARD SIGNER MODULE with only XRPL_REGULAR_KEY_SEED in its environment, to a
 *       never-activated address. A valid regular key makes it validate as tecNO_DST (fee burned, nothing delivered).
 *       A revoked key is rejected at submit and never reaches a ledger. Prints the signing public key, the engine result and
 *       before/after balances. Seeds, blobs and keys are never printed.
 *   pnpm m7:proof -- guard --confirm-testnet
 *       Refuses unless the ledger shows NO regular key. Starts the guard against a throwaway local database with the revoked
 *       key and execution enabled, requests one payment, and checks FAILED + SIGNING_KEY_REVOKED + degraded readiness.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { decode, Wallet } from "xrpl";
import { createGuardSigner } from "../apps/payment-guard/src/signer/signer";
import { LOCAL_DB, verifyAuditChain } from "../packages/database/src/index";
import { auditEventTypesForBusiness, createTestDatabase, paymentSummaries, walletSigningKeyMode, seedInvoice, seedScenario, type TestDatabase } from "../packages/database/src/testing/index";
import { XrplGateway, prepareAndSign, reconcilePayment } from "../packages/xrpl-adapter/src/index";
import { SECRETS_DIR, loadConfig, readPublicWallets, toErrorMessage } from "./lib/common";
import { GUARD_REGULAR_KEY_FILE, startGuard, waitReady, type GuardHandle } from "./lib/guard-launcher";
import { parseRegularKeyAddress, parseRegularKeySeed } from "./lib/owner-key";

const REVOKED_FILE = path.join(SECRETS_DIR, "guard-regular-key.revoked.env");
const EXPLORER = "https://testnet.xrpl.org/transactions/";
const GUARD_PORT = 4017;

for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (err: unknown) => {
    console.error(`[FAIL   ] unhandled error: ${toErrorMessage(err)}`);
    process.exit(1);
  });
}

function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function probe(oldKey: boolean): Promise<void> {
  const cfg = loadConfig();
  const treasury = readPublicWallets().find((w) => w.role === "treasury");
  must(treasury, "treasury wallet");
  const file = oldKey ? REVOKED_FILE : GUARD_REGULAR_KEY_FILE;
  must(existsSync(file), "regular key file");
  const text = readFileSync(file, "utf8");
  const seed = parseRegularKeySeed(text);
  const address = parseRegularKeyAddress(text);
  must(seed !== null && address !== null, "regular key file is malformed");
  const regularPublicKey = Wallet.fromSeed(seed).publicKey; // public value
  const gw = await XrplGateway.connect(cfg.network, { wsUrl: cfg.wsUrl });
  try {
    const before = await gw.getAccountSnapshot(treasury.address, cfg.issuer, cfg.currencyHex);
    console.log(`Ledger RegularKey: ${before.regularKey ?? "not set"}  | configured key address: ${address}`);
    console.log(`Before: XRP drops ${before.xrpDrops}, RLUSD ${before.rlusdBalance ?? "none"}`);
    const destination = Wallet.generate().address; // never activated: an IOU payment to it cannot deliver anything
    const env = { PAYMENT_EXECUTION_ENABLED: "true", XRPL_REGULAR_KEY_SEED: seed } as NodeJS.ProcessEnv;
    const instruction = { account: treasury.address, destination, currency: cfg.currencyHex, issuer: cfg.issuer, value: "1" };
    const signer = createGuardSigner(instruction, { env: () => env, isExecutionEnabled: () => true, network: cfg.network });
    const signed = await prepareAndSign({ gateway: gw, signer, destination, currency: cfg.currencyHex, issuer: cfg.issuer, value: "1" });
    const decoded = decode(signed.txBlob) as { SigningPubKey?: string; Account?: string };
    console.log(`Signed with the regular key: SigningPubKey matches regular key public key = ${String(decoded.SigningPubKey === regularPublicKey)}; Account is the treasury = ${String(decoded.Account === treasury.address)}`);
    must(decoded.SigningPubKey === regularPublicKey, "SigningPubKey must equal the regular key public key");
    const ack = await gw.submitBlob(signed.txBlob);
    console.log(`SUBMIT engine_result: ${ack.engineResult} (${ack.engineResultMessage ?? ""})`);
    console.log(`Tx hash: ${signed.hash}  ${EXPLORER}${signed.hash}`);
    const deadline = Date.now() + 75_000;
    let state = "pending";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const out = await reconcilePayment(gw, { hash: signed.hash, lastLedgerSequence: signed.lastLedgerSequence, firstLedgerSequence: signed.firstLedgerSequence }, { currency: cfg.currencyHex, issuer: cfg.issuer, value: "1" });
      state = out.kind;
      if (out.kind === "validated_failed" || out.kind === "validated_success") console.log(`VALIDATED: ${out.resultCode} in ledger ${String(out.ledgerIndex)}`);
      if (out.kind !== "pending") break;
    }
    console.log(`Final state of the probe transaction: ${state}`);
    const after = await gw.getAccountSnapshot(treasury.address, cfg.issuer, cfg.currencyHex);
    console.log(`After: XRP drops ${after.xrpDrops}, RLUSD ${after.rlusdBalance ?? "none"}; RLUSD unchanged = ${String(after.rlusdBalance === before.rlusdBalance)}`);
    must(after.rlusdBalance === before.rlusdBalance, "RLUSD must be unchanged");
  } finally {
    await gw.disconnect();
  }
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

async function guardRun(): Promise<void> {
  const cfg = loadConfig();
  const wallets = readPublicWallets();
  const treasury = wallets.find((w) => w.role === "treasury");
  const supplier = wallets.find((w) => w.role === "supplier" && w.kind === "cross-border");
  must(treasury && supplier, "treasury and supplier wallets");
  must(existsSync(REVOKED_FILE), "the revoked regular key file (.secrets/guard-regular-key.revoked.env)");
  const gw = await XrplGateway.connect(cfg.network, { wsUrl: cfg.wsUrl });
  let guard: GuardHandle | undefined;
  let db: TestDatabase | undefined;
  try {
    const before = await gw.getAccountSnapshot(treasury.address, cfg.issuer, cfg.currencyHex);
    // Safety: with a regular key still registered on the ledger this run could really pay. Refuse.
    must(before.regularKey === null, "the ledger still has a RegularKey: revoke first, this run is only safe with a revoked key");
    console.log(`Before: RLUSD ${before.rlusdBalance ?? "none"}, XRP drops ${before.xrpDrops}`);
    db = await createTestDatabase();
    const sc = await seedScenario(db.adminPool, { walletAddress: treasury.address, supplierAddress: supplier.address, issuer: cfg.issuer, currencyHex: cfg.currencyHex, maxPayment: "2", dailyLimit: "3", minimumReserve: "4" });
    const inv1 = await seedInvoice(db.adminPool, sc, { amount: "1", invoiceNumber: "INV-M7-001", description: "DEMO M7 invoice (sample data)" });
    const inv2 = await seedInvoice(db.adminPool, sc, { amount: "1", invoiceNumber: "INV-M7-002", description: "DEMO M7 invoice (sample data)" });
    const databaseUrl = `postgres://flow_guard:${encodeURIComponent(db.secrets.guardPassword)}@${LOCAL_DB.host}:${String(LOCAL_DB.port)}/${db.name}`;
    guard = startGuard({ databaseUrl, businessId: sc.businessId, port: GUARD_PORT, treasuryLabel: treasury.label, signerMode: "regular_key", regularKeyFile: REVOKED_FILE });
    await waitReady(guard, 90_000);
    for (let i = 0; i < 40; i++) {
      const s = await call(guard, "GET", "/internal/status");
      if (typeof s.body.snapshot_as_of === "string") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const r1 = await call(guard, "POST", "/internal/payment-requests", { invoice_id: inv1, idempotency_key: `m7-${randomBytes(6).toString("hex")}`, agent_reason: "M7 proof: revoked key" });
    console.log(`Request 1: http ${String(r1.http)}, status ${String(r1.body.status)}, failure_code ${String(r1.body.failure_code)}`);
    must(r1.body.status === "failed" && r1.body.failure_code === "SIGNING_KEY_REVOKED", "the payment must be FAILED with SIGNING_KEY_REVOKED");
    const ready = await fetch(`http://127.0.0.1:${String(GUARD_PORT)}/readyz`);
    const readyBody = (await ready.json()) as Record<string, unknown>;
    console.log(`/readyz: http ${String(ready.status)}, status ${String(readyBody.status)}, signing_key ${String(readyBody.signing_key)}`);
    must(ready.status === 503 && readyBody.status === "degraded" && readyBody.signing_key === "revoked", "readiness must be degraded with signing_key revoked");
    const st = await call(guard, "GET", "/internal/status");
    console.log(`/internal/status signing_key: ${String(st.body.signing_key)}`);
    const mode = await walletSigningKeyMode(db.adminPool, sc.walletId);
    console.log(`Wallet signing_key_mode in DB: ${mode}`);
    must(mode === "revoked", "wallet mode must be revoked");
    const r2 = await call(guard, "POST", "/internal/payment-requests", { invoice_id: inv2, idempotency_key: `m7-${randomBytes(6).toString("hex")}`, agent_reason: "M7 proof: second request" });
    console.log(`Request 2 (blocked while degraded): http ${String(r2.http)}, status ${String(r2.body.status)}, failure_code ${String(r2.body.failure_code)}`);
    must(r2.body.tx_hash === null && r2.body.status !== "validated", "the second request must not be signed or submitted");
    const pays = await paymentSummaries(db.adminPool, sc.businessId);
    console.log(`Payments: ${JSON.stringify(pays.map((p) => ({ status: p.status, failure_code: p.failure_code, has_hash: p.tx_hash !== null })))}`);
    const events = await auditEventTypesForBusiness(db.adminPool, sc.businessId);
    console.log(`Audit events: ${events.join(", ")}`);
    must(events.includes("signing_key.revoked"), "audit event signing_key.revoked");
    must(await verifyAuditChain(db.adminPool, sc.businessId), "the audit chain must verify");
    console.log("Audit chain verifies: true");
    const after = await gw.getAccountSnapshot(treasury.address, cfg.issuer, cfg.currencyHex);
    console.log(`After: RLUSD ${after.rlusdBalance ?? "none"}, XRP drops ${after.xrpDrops}`);
    must(after.rlusdBalance === before.rlusdBalance, "RLUSD must be unchanged");
  } finally {
    if (guard) await guard.stop();
    if (db) await db.drop().catch(() => undefined);
    await gw.disconnect();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const [command, ...flags] = args;
  if (!flags.includes("--confirm-testnet") || flags.some((f) => f !== "--confirm-testnet" && f !== "--old-key")) throw new Error("Usage: m7-proof <probe|guard> --confirm-testnet [--old-key]");
  if (command === "probe") return probe(flags.includes("--old-key"));
  if (command === "guard") return guardRun();
  throw new Error("Usage: m7-proof <probe|guard> --confirm-testnet [--old-key]");
}

main().catch((err: unknown) => {
  console.error(`[FAIL   ] ${toErrorMessage(err)}`);
  process.exit(1);
});
