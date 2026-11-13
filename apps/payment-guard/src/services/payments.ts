import { redactError, type PaymentStatus, type PolicyDecision } from "@flow-ai/contracts";
import {
  DbError, appendAudit, getActiveWalletForBusiness, getBusiness, getLatestSnapshot, getPayment, getPaymentByIdempotencyKey, getPolicy, insertPayment,
  insertReservation, listPayments, lockPolicyForUpdate, setInvoiceStatus, sumInFlightReserved, transitionPayment, withTransaction,
  dbNow, type PaymentRow, type Pool, type PoolClient, type SupplierRow, type WalletRow,
} from "@flow-ai/database";
import { Dec, businessDate, formatMoney, parseMoney } from "@flow-ai/policy-engine";
import type { GuardLedgerGateway } from "@flow-ai/xrpl-adapter";
import { safeEqual } from "../auth";
import type { GuardConfig } from "../config";
import { decide, type LedgerFacts } from "../decision/decide";
import { requestHash } from "../decision/idempotency";
import { loadCanonical, loadReservationsAndPayments, reloadCanonical, type CanonicalRecords } from "../decision/load";
import { HttpError } from "../http/errors";
import type { AuditIntegrity } from "../jobs/audit-verify";
import type { Reconciler } from "../jobs/reconcile";
import type { Logger } from "../logger";
import { invoiceStatusFor, isInFlight } from "../state/payment-machine";
import type { PaymentExecutor } from "./execute";
export interface ServiceDeps {
  pool: Pool;
  gateway: GuardLedgerGateway;
  config: GuardConfig;
  /** Read at request time so the kill switch can change without a restart (13.1C). */
  env: () => NodeJS.ProcessEnv;
  logger: Logger;
  /** Signs and settles reserved payments. Absent in read-only test apps. */
  executor?: PaymentExecutor;
  /** Backs POST /internal/reconcile. */
  reconciler?: Reconciler;
  /** Audit chain verify state (AL-3). When it reports a break, execution is blocked like the kill switch. */
  integrity?: AuditIntegrity;
}
/** The kill switch value the policy engine sees. A detected, unacknowledged audit chain break forces it to "not true" (fail closed, 13.1C). */
export function killSwitchValue(deps: Pick<ServiceDeps, "env" | "integrity">): string | undefined {
  const env = deps.env();
  return deps.integrity?.blocked(env) ? "blocked:audit_chain" : env.PAYMENT_EXECUTION_ENABLED;
}
const EXPLORER = "https://testnet.xrpl.org/transactions/";
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
export interface PolicyDecisionView {
  allowed: boolean;
  decision_code: string;
  policy_version: number | null;
  checks_passed?: string[];
  failed_checks?: { check: string; code: string; message: string }[];
}
export interface PaymentResponse {
  payment_id: string | null;
  status: PaymentStatus | "blocked";
  amount: string | null;
  currency: string;
  destination: string | null;
  network: string;
  tx_hash: string | null;
  explorer_url?: string;
  failure_code: string | null;
  message: string | null;
  policy_decision: PolicyDecisionView;
}
export interface PaymentResult {
  httpStatus: 200 | 202;
  body: PaymentResponse;
}
/** Public view of a stored payment. Never includes signed_blob or request_hash (PG-10). */
export function toPublicPayment(p: PaymentRow, config: Pick<GuardConfig, "rlusd">): Omit<PaymentResponse, "policy_decision"> & { invoice_id: string; requested_at: string; updated_at: string } {
  return {
    payment_id: p.id,
    invoice_id: p.invoice_id,
    status: p.status,
    amount: p.amount,
    currency: config.rlusd.displaySymbol,
    destination: p.destination_address,
    network: p.network,
    tx_hash: p.tx_hash,
    ...(p.tx_hash === null ? {} : { explorer_url: `${EXPLORER}${p.tx_hash}` }),
    failure_code: p.failure_code,
    message: p.failure_message,
    requested_at: p.requested_at,
    updated_at: p.updated_at,
  };
}
function storedResult(p: PaymentRow, config: GuardConfig): PaymentResult {
  const { invoice_id: _i, requested_at: _r, updated_at: _u, ...pub } = toPublicPayment(p, config);
  return {
    httpStatus: isInFlight(p.status) ? 202 : 200,
    body: { ...pub, policy_decision: { allowed: p.status !== "blocked", decision_code: p.status === "blocked" ? (p.failure_code ?? "BLOCKED") : "ALLOWED", policy_version: p.policy_version } },
  };
}
function blockedNoRow(config: GuardConfig, code: string, message: string): PaymentResult {
  return {
    httpStatus: 200,
    body: {
      payment_id: null, status: "blocked", amount: null, currency: config.rlusd.displaySymbol, destination: null, network: config.network,
      tx_hash: null, failure_code: code, message, policy_decision: { allowed: false, decision_code: code, policy_version: null },
    },
  };
}
function decisionView(d: PolicyDecision): PolicyDecisionView {
  return {
    allowed: d.allowed, decision_code: d.decision_code, policy_version: d.policy_version, checks_passed: [...d.checks_passed],
    failed_checks: d.failed_checks.map((c) => ({ check: c.check, code: c.code, message: c.message })),
  };
}
/** Read-only ledger facts, fetched BEFORE any lock is taken (decision 5). Failures degrade to "unknown" so the engine blocks. */
async function readLedger(deps: ServiceDeps, wallet: WalletRow, supplier: SupplierRow): Promise<LedgerFacts & { live: boolean }> {
  const { rlusd } = deps.config;
  try {
    const [snap, reserves, trustline] = await Promise.all([
      deps.gateway.getAccountSnapshot(wallet.address, rlusd.issuer, rlusd.currencyHex),
      deps.gateway.getReserves(),
      deps.gateway.getDestinationTrustLine(supplier.xrpl_address, rlusd.issuer, rlusd.currencyHex),
    ]);
    return {
      live: true, rlusdBalance: snap.rlusdBalance, xrpDrops: snap.xrpDrops, baseReserveDrops: reserves.baseReserveDrops,
      ownerReserveDrops: reserves.ownerReserveDrops, ownerCount: snap.ownerCount, trustline,
    };
  } catch (err) {
    deps.logger.warn("ledger.read_failed", { error: redactError(err) });
    return { live: false, rlusdBalance: null, xrpDrops: null, baseReserveDrops: "0", ownerReserveDrops: "0", ownerCount: 0, trustline: "unknown" };
  }
}
/** live balance minus holds on in-flight payments, floored at zero. null stays null (fails closed). */
function effectiveBalance(live: string | null, inFlight: string): string | null {
  if (live === null) return null;
  const live_ = parseMoney(live, true);
  if (live_ === null) return null;
  const left = live_.minus(new Dec(inFlight));
  return formatMoney(left.isNegative() ? new Dec(0) : left);
}
function canPersistBlocked(r: CanonicalRecords, config: GuardConfig): boolean {
  return parseMoney(r.invoice.amount, false) !== null && CLASSIC_ADDRESS.test(r.supplier.xrpl_address) && r.wallet.network === config.network;
}
type TxOutcome =
  | { kind: "stored"; payment: PaymentRow }
  | { kind: "no_row"; code: string; message: string }
  | { kind: "blocked"; payment: PaymentRow | null; decision: PolicyDecision }
  | { kind: "reserved"; payment: PaymentRow; decision: PolicyDecision };
async function audit(c: PoolClient, businessId: string, requestId: string, eventType: string, paymentId: string, metadata: Record<string, unknown>): Promise<void> {
  await appendAudit(c, { business_id: businessId, actor_type: "policy_service", actor_id: "payment-guard", event_type: eventType, entity_type: "payment", entity_id: paymentId, metadata, request_id: requestId });
}
export interface RequestPaymentInput {
  invoice_id: string;
  idempotency_key: string;
  agent_reason?: string | undefined;
}
/** POST /internal/payment-requests: decide, then persist blocked OR reserve, in one transaction under the policy lock. */
export async function requestPayment(deps: ServiceDeps, input: RequestPaymentInput, requestId: string): Promise<PaymentResult> {
  const { config, pool } = deps;
  const hash = requestHash(input);
  const first = await loadCanonical(pool, input.invoice_id, config.businessId);
  if (!first.ok) {
    deps.logger.info("payment.rejected_no_row", { request_id: requestId, reason: first.reason });
    return blockedNoRow(config, first.reason, "Invoice not found for this business.");
  }
  const replay = async (): Promise<PaymentResult | null> => {
    const existing = await getPaymentByIdempotencyKey(pool, first.records.business.id, input.idempotency_key);
    if (!existing) return null;
    if (!safeEqual(existing.request_hash, hash)) throw new HttpError(409);
    return storedResult(existing, config);
  };
  const early = await replay();
  if (early) return early;
  const ledger = await readLedger(deps, first.records.wallet, first.records.supplier);
  let outcome: TxOutcome;
  try {
    outcome = await withTransaction(pool, (c) => decideInTransaction(deps, c, first.records, ledger, input, hash, requestId));
  } catch (err) {
    // Lost a race on the idempotency or active-invoice unique index: serve the stored row if there is one.
    if (err instanceof DbError && err.code === "UNIQUE_VIOLATION") {
      const again = await replay();
      if (again) return again;
      return blockedNoRow(config, "PAYMENT_ALREADY_IN_PROGRESS", "A payment for this invoice is already in progress.");
    }
    throw err;
  }
  switch (outcome.kind) {
    case "stored":
      if (!safeEqual(outcome.payment.request_hash, hash)) throw new HttpError(409);
      return storedResult(outcome.payment, config);
    case "no_row":
      return blockedNoRow(config, outcome.code, outcome.message);
    case "blocked": {
      if (!outcome.payment) return blockedNoRow(config, outcome.decision.failure_code ?? "INTERNAL_ERROR", outcome.decision.message);
      const stored = storedResult(outcome.payment, config);
      return { ...stored, body: { ...stored.body, message: outcome.decision.message, policy_decision: decisionView(outcome.decision) } };
    }
    case "reserved": {
      const stored = storedResult(outcome.payment, config);
      return { ...stored, body: { ...stored.body, policy_decision: decisionView(outcome.decision) } };
    }
  }
}
async function decideInTransaction(
  deps: ServiceDeps, c: PoolClient, before: CanonicalRecords, ledger: LedgerFacts, input: RequestPaymentInput, hash: string, requestId: string,
): Promise<TxOutcome> {
  const { config } = deps;
  const businessId = before.business.id;
  // Serialise every decision for this business; everything below is reloaded after the lock.
  await lockPolicyForUpdate(c, businessId);
  const records = await reloadCanonical(c, before);
  if (!records) return { kind: "no_row", code: "RECORD_MISMATCH", message: "A required record is missing." };
  const existing = await getPaymentByIdempotencyKey(c, businessId, input.idempotency_key);
  if (existing) return { kind: "stored", payment: existing };
  const now = (await dbNow(c)).toISOString();
  const today = businessDate(Date.parse(now), records.business.timezone);
  const { reservations, payments } = await loadReservationsAndPayments(c, businessId, today, records.invoice.id);
  const inFlight = await sumInFlightReserved(c, businessId);
  const decision = decide({
    now, killSwitchValue: killSwitchValue(deps), request: input, records, config,
    ledger: { ...ledger, rlusdBalance: effectiveBalance(ledger.rlusdBalance, inFlight) }, reservations, payments,
  });
  const previous = payments.find((p) => p.status === "failed");
  const base = {
    business_id: businessId, invoice_id: records.invoice.id, supplier_id: records.supplier.id, wallet_id: records.wallet.id,
    network: config.network, asset_currency: config.rlusd.currencyHex, asset_issuer: config.rlusd.issuer, amount: records.invoice.amount,
    destination_address: records.supplier.xrpl_address, policy_version: records.policy.version, idempotency_key: input.idempotency_key,
    request_hash: hash, agent_reason: input.agent_reason, previous_payment_id: previous?.id, business_date: today,
  };
  if (!decision.allowed || decision.payment === null) {
    if (!canPersistBlocked(records, config) || decision.failure_code === null) return { kind: "blocked", payment: null, decision };
    const payment = await insertPayment(c, { ...base, status: "blocked", failure_code: decision.failure_code, failure_message: decision.message.slice(0, 500) });
    await audit(c, businessId, requestId, "payment.blocked", payment.id, {
      decision_code: decision.decision_code, failed_checks: decision.failed_checks.map((f) => f.code), policy_version: decision.policy_version,
      invoice_id: records.invoice.id, amount: payment.amount,
    });
    if (records.invoice.status === "open" || records.invoice.status === "blocked") await setInvoiceStatus(c, records.invoice.id, invoiceStatusFor("blocked"));
    return { kind: "blocked", payment, decision };
  }
  const approved = decision.payment;
  const requested = await insertPayment(c, {
    ...base, amount: approved.amount, destination_address: approved.destination, business_date: approved.business_date, status: "requested",
  });
  await audit(c, businessId, requestId, "payment.requested", requested.id, { invoice_id: approved.invoice_id, amount: approved.amount, policy_version: decision.policy_version });
  // The cap trigger only accepts a reservation for a payment that is already `reserved`, so transition first.
  const reserved = await transitionPayment(c, requested.id, "requested", "reserved");
  if (!reserved) throw new DbError("STATE_VIOLATION");
  await insertReservation(c, { business_id: businessId, business_date: approved.business_date, payment_id: requested.id, amount: approved.amount });
  await audit(c, businessId, requestId, "payment.reserved", reserved.id, {
    amount: approved.amount, business_date: approved.business_date, checks_passed: decision.checks_passed.length,
  });
  await setInvoiceStatus(c, records.invoice.id, invoiceStatusFor("reserved"));
  return { kind: "reserved", payment: reserved, decision };
}
function pinned(deps: ServiceDeps, p: PaymentRow | null): PaymentRow | null {
  return p && (deps.config.businessId === undefined || p.business_id === deps.config.businessId) ? p : null;
}
/** Stored-payment read view: the public fields plus the decision code the policy engine produced (9.3). */
function storedView(p: PaymentRow, config: GuardConfig): ReturnType<typeof toPublicPayment> & { decision_code: string } {
  return { ...toPublicPayment(p, config), decision_code: p.status === "blocked" ? (p.failure_code ?? "BLOCKED") : "ALLOWED" };
}
export async function getPaymentById(deps: ServiceDeps, id: string): Promise<ReturnType<typeof storedView> | null> {
  const p = pinned(deps, await getPayment(deps.pool, id));
  return p ? storedView(p, deps.config) : null;
}
export async function listPaymentsView(deps: ServiceDeps, f: { invoiceId?: string | undefined; status?: PaymentStatus | undefined; limit?: number | undefined }) {
  const rows = await listPayments(deps.pool, { businessId: deps.config.businessId, invoiceId: f.invoiceId, status: f.status, limit: f.limit });
  return rows.map((p) => storedView(p, deps.config));
}
/** XRP numeric string ("12.345678") to integer drops with BigInt only (G-4). */
export function xrpToDrops(xrp: string): string | null {
  const [whole = "", frac = "", ...rest] = xrp.split(".");
  if (rest.length > 0 || !/^\d{1,12}$/.test(whole) || !/^\d{0,6}$/.test(frac)) return null;
  return (BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"))).toString();
}
export interface EligibilityView {
  eligible: boolean;
  failed_checks: string[];
  as_of: string;
  preview: true;
}
/** GET /internal/invoices/:id/eligibility. Reads only: no payment, no reservation, no audit row (9.5). */
export async function previewEligibility(deps: ServiceDeps, invoiceId: string): Promise<EligibilityView | null> {
  const { pool, config } = deps;
  const loaded = await loadCanonical(pool, invoiceId, config.businessId);
  if (!loaded.ok) return loaded.reason === "INVOICE_NOT_FOUND" ? null : { eligible: false, failed_checks: [loaded.reason], as_of: new Date().toISOString(), preview: true };
  const r = loaded.records;
  const now = (await dbNow(pool)).toISOString();
  const snapshot = await getLatestSnapshot(pool, r.wallet.id);
  const fresh = snapshot !== null && Date.parse(now) - Date.parse(snapshot.as_of) <= 3 * config.balancePollIntervalSeconds * 1000;
  const live = await readLedger(deps, r.wallet, r.supplier);
  const today = businessDate(Date.parse(now), r.business.timezone);
  const { reservations, payments } = await loadReservationsAndPayments(pool, r.business.id, today, r.invoice.id);
  const inFlight = await sumInFlightReserved(pool, r.business.id);
  const rlusd = fresh && snapshot ? snapshot.rlusd_balance : null;
  const decision = decide({
    now, killSwitchValue: killSwitchValue(deps),
    request: { invoice_id: r.invoice.id, idempotency_key: `preview:${r.invoice.id}` }, records: r, config,
    ledger: {
      rlusdBalance: effectiveBalance(rlusd, inFlight), xrpDrops: fresh && snapshot ? xrpToDrops(snapshot.xrp_balance) : null,
      baseReserveDrops: live.baseReserveDrops, ownerReserveDrops: live.ownerReserveDrops, ownerCount: live.ownerCount,
      trustline: live.trustline,
    },
    reservations, payments,
  });
  return { eligible: decision.allowed, failed_checks: decision.failed_checks.map((f) => f.code), as_of: now, preview: true };
}
export interface StatusView {
  kill_switch: "enabled" | "disabled";
  automation: "enabled" | "disabled" | "unknown";
  snapshot_as_of: string | null;
  audit_chain: "unverified" | "ok" | "broken" | "error";
}
export async function getStatus(deps: ServiceDeps): Promise<StatusView> {
  const { pool, config } = deps;
  const kill_switch = killSwitchValue(deps) === "true" ? "enabled" : "disabled";
  const audit_chain = deps.integrity?.status(deps.env()).state ?? "unverified";
  const business = config.businessId === undefined ? null : await getBusiness(pool, config.businessId);
  if (!business) return { kill_switch, automation: "unknown", snapshot_as_of: null, audit_chain };
  const [policy, wallet] = await Promise.all([getPolicy(pool, business.id), getActiveWalletForBusiness(pool, business.id)]);
  const snapshot = wallet ? await getLatestSnapshot(pool, wallet.id) : null;
  return { kill_switch, automation: policy === null ? "unknown" : policy.enabled ? "enabled" : "disabled", snapshot_as_of: snapshot?.as_of ?? null, audit_chain };
}
