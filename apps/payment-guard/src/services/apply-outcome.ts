import type { MoneyString, PaymentStatus } from "@flow-ai/contracts";
import {
  appendAudit, getPaymentForUpdate, setInvoiceStatus, settleReservation, transitionPayment, withTransaction,
  type ActorType, type PaymentPatch, type PaymentRow, type Pool, type PoolClient,
} from "@flow-ai/database";
import { formatMoney, parseMoney } from "@flow-ai/policy-engine";
import type { PaymentOutcome } from "@flow-ai/xrpl-adapter";
import { invoiceStatusFor, isTerminal } from "../state/payment-machine";

export interface Actor {
  type: ActorType;
  id: string;
}
export const GUARD_ACTOR: Actor = { type: "policy_service", id: "payment-guard" };
export const SYSTEM_ACTOR: Actor = { type: "system", id: "payment-guard" };

const RESULT_CODE = /^[a-zA-Z_]{3,40}$/;

/** Server-reported values are data: anything the database CHECKs would reject is dropped instead of aborting the settlement. */
function safeResultCode(code: string): string | undefined {
  return RESULT_CODE.test(code) ? code : undefined;
}
function safeLedgerIndex(n: number): number | undefined {
  return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : undefined;
}
function safeFee(fee: string | undefined): string | undefined {
  return fee !== undefined && /^\d{1,15}$/.test(fee) ? fee : undefined;
}
function deliveredValue(delivered: unknown): MoneyString | undefined {
  if (typeof delivered !== "object" || delivered === null) return undefined;
  const d = parseMoney((delivered as { value?: unknown }).value, true);
  return d === null ? undefined : formatMoney(d);
}

async function audit(c: PoolClient, actor: Actor, p: PaymentRow, eventType: string, metadata: Record<string, unknown>): Promise<void> {
  await appendAudit(c, {
    business_id: p.business_id, actor_type: actor.type, actor_id: actor.id, event_type: eventType, entity_type: "payment", entity_id: p.id,
    metadata: { invoice_id: p.invoice_id, ...metadata }, // never a blob, seed or token
  });
}

/** Moves a locked payment to a final status together with its reservation, invoice and audit row. */
async function finish(
  c: PoolClient, actor: Actor, p: PaymentRow, to: PaymentStatus, reservation: "committed" | "released", patch: PaymentPatch, event: string, meta: Record<string, unknown>,
): Promise<PaymentRow> {
  const next = await transitionPayment(c, p.id, p.status, to, patch);
  if (!next) return p; // lost a race: the row changed under the lock, so the stored state stands
  await settleReservation(c, p.id, reservation);
  await setInvoiceStatus(c, p.invoice_id, invoiceStatusFor(to));
  await audit(c, actor, next, event, { ...meta, status: to });
  return next;
}

/**
 * Applies a PaymentOutcome inside an open transaction. Idempotent: a terminal row is returned unchanged. Used by the
 * execution flow and the reconciler so both settle a payment the same way (10.3).
 */
export async function applyOutcomeIn(c: PoolClient, paymentId: string, outcome: PaymentOutcome, actor: Actor = GUARD_ACTOR): Promise<PaymentRow | null> {
  const p = await getPaymentForUpdate(c, paymentId);
  if (!p) return null;
  if (isTerminal(p.status)) return p;
  if (p.status !== "submitted" && p.status !== "pending_confirmation") return p; // nothing was signed: no outcome can apply
  switch (outcome.kind) {
    case "validated_success": {
      const delivered = deliveredValue(outcome.deliveredAmount);
      return finish(c, actor, p, "validated", "committed", {
        ...opt("ledger_index", safeLedgerIndex(outcome.ledgerIndex)), ...opt("result_code", safeResultCode(outcome.resultCode)),
        ...opt("delivered_amount", delivered), ...opt("fee_drops", safeFee(outcome.feeDrops)), validated_at: true,
      }, "payment.validated", { tx_hash: p.tx_hash, ledger_index: outcome.ledgerIndex, result_code: outcome.resultCode });
    }
    case "validated_failed":
      return finish(c, actor, p, "failed", "released", {
        ...opt("ledger_index", safeLedgerIndex(outcome.ledgerIndex)), ...opt("result_code", safeResultCode(outcome.resultCode)),
        ...opt("fee_drops", safeFee(outcome.feeDrops)), failure_code: "XRPL_SUBMISSION_FAILED", failure_message: `Ledger result ${safeResultCode(outcome.resultCode) ?? "unknown"}`,
      }, "payment.failed", { tx_hash: p.tx_hash, ledger_index: outcome.ledgerIndex, result_code: outcome.resultCode });
    case "partial_delivery":
      // Value may have left the wallet: the reservation is committed, never silently freed (decision 3).
      return finish(c, actor, p, "failed", "committed", {
        ...opt("ledger_index", safeLedgerIndex(outcome.ledgerIndex)), ...opt("result_code", safeResultCode(outcome.resultCode)),
        ...opt("delivered_amount", deliveredValue(outcome.deliveredAmount)), ...opt("fee_drops", safeFee(outcome.feeDrops)),
        failure_code: "PARTIAL_DELIVERY", failure_message: "Delivered amount differs from the intended amount.",
      }, "payment.partial_delivery", { tx_hash: p.tx_hash, ledger_index: outcome.ledgerIndex });
    case "failed_expired":
      return finish(c, actor, p, "failed", "released", {
        failure_code: "XRPL_SUBMISSION_FAILED", failure_message: "Transaction expired before validation (LastLedgerSequence passed).",
      }, "payment.expired", { tx_hash: p.tx_hash, last_ledger_sequence: outcome.lastLedgerSequence, validated_ledger: outcome.validatedLedgerIndex });
    case "rejected_authorization":
      // Nothing can have left the wallet: release the reservation and reopen the invoice. A dedicated code, never a generic failure.
      return finish(c, actor, p, "failed", "released", {
        ...opt("result_code", safeResultCode(outcome.engineResult)), failure_code: "SIGNING_KEY_REVOKED",
        failure_message: "The guard signing key was rejected by the ledger. Execution is blocked until the owner restores a valid key.",
      }, "payment.signing_key_revoked", { tx_hash: p.tx_hash, engine_result: outcome.engineResult });
    case "pending": {
      const wasSubmitted = p.status === "submitted";
      // submitted -> pending_confirmation; a repeat on pending_confirmation only touches updated_at so the reconciler rotates.
      const next = await transitionPayment(c, p.id, p.status, "pending_confirmation", {});
      if (next && wasSubmitted) await audit(c, actor, next, "payment.pending_confirmation", { tx_hash: p.tx_hash, reason: outcome.reason.slice(0, 200) });
      return next ?? p;
    }
  }
}

/** exactOptionalPropertyTypes-safe optional spread. */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

export function applyOutcome(pool: Pool, paymentId: string, outcome: PaymentOutcome, actor: Actor = GUARD_ACTOR): Promise<PaymentRow | null> {
  return withTransaction(pool, (c) => applyOutcomeIn(c, paymentId, outcome, actor));
}

/**
 * Cancels a payment that has no signing data (sweeper, kill switch flipped after reserve). Refuses anything with a
 * persisted hash or blob: those belong to the reconciler (5A.2). Returns null when the row is not cancellable.
 */
export async function cancelUnsignedIn(c: PoolClient, paymentId: string, code: string, message: string, actor: Actor): Promise<PaymentRow | null> {
  const p = await getPaymentForUpdate(c, paymentId);
  if (!p || (p.status !== "reserved" && p.status !== "requested")) return null;
  if (p.tx_hash !== null || p.signed_blob !== null) return null;
  const next = await transitionPayment(c, p.id, p.status, "cancelled", { failure_code: code, failure_message: message });
  if (!next) return null;
  await settleReservation(c, p.id, "released");
  await setInvoiceStatus(c, p.invoice_id, invoiceStatusFor("cancelled"));
  await audit(c, actor, next, "payment.cancelled", { failure_code: code, status: "cancelled" });
  return next;
}

export function cancelUnsigned(pool: Pool, paymentId: string, code: string, message: string, actor: Actor): Promise<PaymentRow | null> {
  return withTransaction(pool, (c) => cancelUnsignedIn(c, paymentId, code, message, actor));
}
