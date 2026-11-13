import { randomBytes } from "node:crypto";
import { createTestDatabase, seedInvoice, seedScenario, storedTextForLeakScan, type Scenario, type ScenarioOptions, type TestDatabase } from "@flow-ai/database/testing";
import type { AccountSnapshot, GuardLedgerGateway, LedgerRange, Reserves, SubmitAck, TrustLineState, TxLookup } from "@flow-ai/xrpl-adapter";
import { Wallet, decode, hashes, type Payment } from "xrpl";
import { buildApp, type GuardApp } from "../src/app";
import { loadConfig, type GuardConfig } from "../src/config";
import { createReconciler, type Reconciler } from "../src/jobs/reconcile";
import { createLogger } from "../src/logger";
import { createExecutor, type PaymentExecutor } from "../src/services/execute";
import type { ServiceDeps } from "../src/services/payments";
import { CURRENCY_HEX, ISSUER } from "./payment-fixtures";
import { TOKEN, validEnv } from "./helpers";
/** Integration harness: real Postgres (throwaway DB, least-privilege role), real guard signer, scriptable fake ledger. */
export type SubmitMode = "validate" | "tec" | "partial" | "hold" | "throw";
export interface SubmitRecord {
  blob: string;
  hash: string;
  startedAt: number;
  endedAt: number;
}
export class FakeLedger {
  validated = 1000;
  balance: string | null = "100";
  xrpDrops = "100000000";
  ownerCount = 1;
  trustline: TrustLineState = "present";
  mode: SubmitMode = "validate";
  submitDelayMs = 0;
  searchedAll = false;
  complete: LedgerRange[] = [];
  readonly submits: SubmitRecord[] = [];
  readonly known = new Map<string, TxLookup>();
  private sequence = 1;
  private ledgerIndex = 2000;
  constructor(private readonly reportAccount: () => string) {}
  /** Makes a previously held/lost transaction appear in a validated ledger. */
  validate(hash: string, result: "tesSUCCESS" | "tecPATH_DRY" = "tesSUCCESS"): void {
    const record = this.submits.find((s) => s.hash === hash);
    if (!record) throw new Error("unknown hash");
    const tx = decode(record.blob) as unknown as Payment;
    this.known.set(hash, { status: "found", validated: true, ledgerIndex: ++this.ledgerIndex, resultCode: result, deliveredAmount: tx.Amount, feeDrops: "12" });
  }
  asGateway(): GuardLedgerGateway {
    const gw = {
      getNetworkInfo: () => Promise.resolve({ networkId: 1, validatedLedgerIndex: this.validated }),
      getValidatedLedgerIndex: () => Promise.resolve(this.validated),
      autofill: (tx: Payment) => Promise.resolve({ ...tx, Sequence: this.sequence++, Fee: "12", LastLedgerSequence: this.validated + 20 }),
      submitBlob: async (blob: string): Promise<SubmitAck> => {
        const startedAt = Date.now();
        const hash = hashes.hashSignedTx(blob);
        if (this.submitDelayMs > 0) await new Promise((r) => setTimeout(r, this.submitDelayMs));
        this.submits.push({ blob, hash, startedAt, endedAt: Date.now() });
        if (this.mode === "throw") throw new Error("connection reset");
        if (this.mode === "validate") this.validate(hash);
        else if (this.mode === "tec") this.validate(hash, "tecPATH_DRY");
        else if (this.mode === "partial") {
          const tx = decode(blob) as unknown as Payment;
          const amount = tx.Amount as { currency: string; issuer: string; value: string };
          this.known.set(hash, {
            status: "found", validated: true, ledgerIndex: ++this.ledgerIndex, resultCode: "tesSUCCESS",
            deliveredAmount: { ...amount, value: "0.5" }, feeDrops: "12",
          });
        }
        return { engineResult: "tesSUCCESS" };
      },
      lookupTx: (hash: string): Promise<TxLookup> => Promise.resolve(this.known.get(hash) ?? { status: "not_found", searchedAll: this.searchedAll }),
      getAccountSnapshot: (account: string): Promise<AccountSnapshot> => {
        if (account !== this.reportAccount()) return Promise.reject(new Error("unknown account"));
        return Promise.resolve({ xrpDrops: this.xrpDrops, ownerCount: this.ownerCount, rlusdBalance: this.balance, ledgerIndex: this.validated });
      },
      getReserves: (): Promise<Reserves> => Promise.resolve({ baseReserveDrops: "1000000", ownerReserveDrops: "200000" }),
      getDestinationTrustLine: (): Promise<TrustLineState> => Promise.resolve(this.trustline),
      getCompleteLedgers: (): Promise<LedgerRange[]> => Promise.resolve(this.complete),
    };
    return gw;
  }
}
export interface Harness {
  db: TestDatabase;
  wallet: Wallet;
  supplierAddress: string;
  env: NodeJS.ProcessEnv;
  ledger: FakeLedger;
  config: GuardConfig;
  logs: string[];
  /** Every response body this harness saw (leak scan). */
  bodies: string[];
  deps: ServiceDeps;
  /** Same services without an executor: requests stop at `reserved`. */
  reserveOnlyDeps: ServiceDeps;
  executor: PaymentExecutor;
  reconciler: Reconciler;
  guard: GuardApp;
  scenario: (o?: Partial<ScenarioOptions>) => Promise<Scenario>;
  invoice: (s: Scenario, o?: { amount?: string; description?: string | null }) => Promise<string>;
  post: (invoiceId: string, key: string, extra?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown>; raw: string }>;
  get: (url: string) => Promise<{ status: number; body: Record<string, unknown>; raw: string }>;
  /** A second service object over the same database and ledger (a "second worker" / a restarted process). */
  spawnWorker: () => { executor: PaymentExecutor; reconciler: Reconciler; deps: ServiceDeps };
  close: () => Promise<void>;
}
export interface HarnessOptions {
  config?: Partial<GuardConfig>;
}
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDatabase();
  const wallet = Wallet.generate();
  const supplierAddress = Wallet.generate().address;
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PAYMENT_EXECUTION_ENABLED: "true", XRPL_DEMO_SIGNER_SEED: wallet.seed };
  const ledger = new FakeLedger(() => wallet.address);
  const logs: string[] = [];
  const bodies: string[] = [];
  const config: GuardConfig = { ...loadConfig(validEnv()), rateLimitPerMinute: 1000, paymentWaitSeconds: 3, ...options.config };
  const logger = createLogger((l) => logs.push(l));
  const gateway = ledger.asGateway();
  const base: ServiceDeps = { pool: db.guardPool, gateway, config, env: () => env, logger };
  const executor = createExecutor(base);
  const deps: ServiceDeps = { ...base, executor };
  const reconciler = createReconciler(deps);
  const guard = await buildApp({ ...deps, reconciler });
  const send = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await guard.app.inject({
      method, url, headers: { authorization: `Bearer ${TOKEN}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    bodies.push(res.body);
    return { status: res.statusCode, body: (res.body.startsWith("{") ? JSON.parse(res.body) : {}) as Record<string, unknown>, raw: res.body };
  };
  return {
    db, wallet, supplierAddress, env, ledger, config, logs, bodies, deps, reserveOnlyDeps: base, executor, reconciler, guard,
    scenario: (o = {}) => seedScenario(db.adminPool, { walletAddress: wallet.address, supplierAddress, issuer: ISSUER, currencyHex: CURRENCY_HEX, ...o }),
    invoice: (s, o = {}) => seedInvoice(db.adminPool, s, o),
    post: (invoiceId, key, extra = {}) => send("POST", "/internal/payment-requests", { invoice_id: invoiceId, idempotency_key: key, ...extra }),
    get: (url) => send("GET", url),
    spawnWorker: () => {
      const workerBase: ServiceDeps = { ...base };
      const workerExecutor = createExecutor(workerBase);
      const workerDeps: ServiceDeps = { ...workerBase, executor: workerExecutor };
      return { executor: workerExecutor, reconciler: createReconciler(workerDeps), deps: workerDeps };
    },
    close: async () => {
      await guard.app.close();
      await executor.idle();
      await db.drop();
    },
  };
}
/** Unique, valid idempotency key. */
export const key = (label = "k"): string => `${label}-${randomBytes(6).toString("hex")}`;
/** Scans everything observable for secret-shaped content (G-3, PG-10). `blobs` are signed transaction blobs seen by the ledger. */
export async function assertNoLeaks(h: Harness, blobs: readonly string[] = h.ledger.submits.map((s) => s.blob)): Promise<string[]> {
  const stored = await storedTextForLeakScan(h.db.adminPool);
  const hay = [...h.logs, ...h.bodies, stored].join("\n");
  const problems: string[] = [];
  const needles: [string, string][] = [
    ["wallet seed", h.wallet.seed as string],
    ["bearer token", TOKEN],
    ["database password", h.db.secrets.guardPassword],
    ...blobs.map((b): [string, string] => ["signed blob", b]),
  ];
  for (const [label, value] of needles) if (value !== "" && hay.includes(value)) problems.push(label);
  if (/\bs[1-9A-HJ-NP-Za-km-z]{25,34}\b/.test(hay.replace(/"[A-Za-z_]*":/g, ""))) problems.push("seed-shaped string");
  if (/signed_blob|tx_blob|SELECT\s.+\sFROM|at\s\S+\s\([A-Za-z]:\\|node_modules/i.test(h.bodies.join("\n"))) problems.push("internal detail in a response");
  return problems;
}
