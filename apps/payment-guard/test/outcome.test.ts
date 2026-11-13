import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentPatch, PaymentRow } from "@flow-ai/database";
import type { PaymentOutcome } from "@flow-ai/xrpl-adapter";
import { canTransition } from "../src/state/payment-machine";
import { CURRENCY_HEX, ISSUER, TX_HASH, paymentRow, submittedRow } from "./payment-fixtures";

// In-memory stand-in for the repos: one payment row, one reservation, one invoice, an audit list.
interface Mem {
  payment: unknown;
  reservation: string;
  invoice: string;
  audits: { event_type: string; actor_type: string; metadata: Record<string, unknown> }[];
  stale: unknown[];
}
const mem = vi.hoisted((): Mem => ({ payment: null, reservation: "reserved", invoice: "processing", audits: [], stale: [] }));
vi.mock("@flow-ai/database", async (orig) => {
  const actual = await orig<typeof import("@flow-ai/database")>();
  return {
    ...actual,
    withTransaction: (_pool: unknown, fn: (c: unknown) => unknown) => fn({}),
    getPaymentForUpdate: async () => mem.payment,
    transitionPayment: async (_c: unknown, _id: string, from: string, to: string, patch: PaymentPatch) => {
      const p = mem.payment as PaymentRow;
      if (p.status !== from) return null;
      if (from !== to && !canTransition(p.status, to as never)) throw new Error("illegal transition");
      const final = to === "validated" || to === "failed" || to === "cancelled";
      mem.payment = { ...p, ...patch, status: to, signed_blob: final ? null : p.signed_blob, tx_hash: patch.tx_hash ?? p.tx_hash };
      return mem.payment;
    },
    settleReservation: async (_c: unknown, _id: string, to: string) => {
      if (mem.reservation !== "reserved") return null;
      mem.reservation = to;
      return {};
    },
    setInvoiceStatus: async (_c: unknown, _id: string, s: string) => void (mem.invoice = s),
    appendAudit: async (_c: unknown, e: { event_type: string; actor_type: string; metadata: Record<string, unknown> }) => void mem.audits.push(e),
    lockStaleUnsignedPayments: async () => mem.stale,
  };
});
const { applyOutcomeIn, cancelUnsignedIn, SYSTEM_ACTOR } = await import("../src/services/apply-outcome");
const { sweepStaleReservations } = await import("../src/jobs/sweeper");
const { makeSweepDeps } = await import("./sweep-deps");

const row = () => mem.payment as PaymentRow;
const delivered = { currency: CURRENCY_HEX, issuer: ISSUER, value: "1" };
const apply = (o: PaymentOutcome) => applyOutcomeIn({} as never, row().id, o);
const base = { hash: TX_HASH, ledgerIndex: 110, resultCode: "tesSUCCESS", feeDrops: "12" };

beforeEach(() => {
  mem.payment = submittedRow();
  mem.reservation = "reserved";
  mem.invoice = "processing";
  mem.audits = [];
  mem.stale = [];
});

describe("applyOutcome table (10.3, 5A.1, decision 3)", () => {
  it("validated_success -> validated, reservation committed, invoice paid, blob cleared", async () => {
    const r = await apply({ kind: "validated_success", ...base, deliveredAmount: delivered });
    expect(r).toMatchObject({ status: "validated", ledger_index: 110, result_code: "tesSUCCESS", delivered_amount: "1", fee_drops: "12", signed_blob: null });
    expect([mem.reservation, mem.invoice]).toEqual(["committed", "paid"]);
    expect(mem.audits.map((a) => a.event_type)).toEqual(["payment.validated"]);
    expect(JSON.stringify(mem.audits)).not.toMatch(/DEADBEEF/);
  });

  it("validated_failed -> failed with result and fee recorded, reservation released, invoice open", async () => {
    const r = await apply({ kind: "validated_failed", ...base, resultCode: "tecPATH_DRY" });
    expect(r).toMatchObject({ status: "failed", result_code: "tecPATH_DRY", fee_drops: "12", failure_code: "XRPL_SUBMISSION_FAILED", signed_blob: null });
    expect([mem.reservation, mem.invoice]).toEqual(["released", "open"]);
  });

  it("partial_delivery -> failed PARTIAL_DELIVERY, reservation COMMITTED (never silently freed), invoice open", async () => {
    const r = await apply({ kind: "partial_delivery", ...base, deliveredAmount: { ...delivered, value: "0.5" } });
    expect(r).toMatchObject({ status: "failed", failure_code: "PARTIAL_DELIVERY", delivered_amount: "0.5" });
    expect([mem.reservation, mem.invoice]).toEqual(["committed", "open"]);
  });

  it("failed_expired -> failed, reservation released, invoice open, blob cleared", async () => {
    const r = await apply({ kind: "failed_expired", hash: TX_HASH, lastLedgerSequence: 120, validatedLedgerIndex: 130 });
    expect(r).toMatchObject({ status: "failed", failure_code: "XRPL_SUBMISSION_FAILED", signed_blob: null });
    expect([mem.reservation, mem.invoice]).toEqual(["released", "open"]);
  });

  it("pending -> pending_confirmation, reservation held, blob kept; a repeat does not re-audit", async () => {
    const pending: PaymentOutcome = { kind: "pending", hash: TX_HASH, lastLedgerSequence: 120, validatedLedgerIndex: 110, seenOnLedger: false, reason: "not found yet" };
    expect(await apply(pending)).toMatchObject({ status: "pending_confirmation", signed_blob: expect.any(String) });
    expect([mem.reservation, mem.invoice]).toEqual(["reserved", "processing"]);
    await apply(pending);
    expect(mem.audits.filter((a) => a.event_type === "payment.pending_confirmation")).toHaveLength(1);
  });

  it("pending_confirmation can later settle to validated", async () => {
    mem.payment = submittedRow({ status: "pending_confirmation" });
    expect((await apply({ kind: "validated_success", ...base, deliveredAmount: delivered }))?.status).toBe("validated");
  });

  it("is idempotent: a terminal row is returned unchanged and nothing else is written", async () => {
    await apply({ kind: "validated_success", ...base, deliveredAmount: delivered });
    const before = JSON.stringify(mem.payment);
    const auditCount = mem.audits.length;
    const again = await apply({ kind: "failed_expired", hash: TX_HASH, lastLedgerSequence: 120, validatedLedgerIndex: 130 });
    expect(again?.status).toBe("validated");
    expect(JSON.stringify(mem.payment)).toBe(before);
    expect(mem.audits).toHaveLength(auditCount);
    expect(mem.reservation).toBe("committed");
  });

  it("does not apply an outcome to a payment that was never signed", async () => {
    mem.payment = paymentRow({ status: "reserved" });
    const r = await apply({ kind: "failed_expired", hash: TX_HASH, lastLedgerSequence: 120, validatedLedgerIndex: 130 });
    expect(r?.status).toBe("reserved");
  });

  it("drops server values the database would reject instead of aborting the settlement", async () => {
    const r = await apply({ kind: "validated_success", hash: TX_HASH, ledgerIndex: -4, resultCode: "tes SUCCESS!", deliveredAmount: { value: "1e3" }, feeDrops: "-1" });
    expect(r).toMatchObject({ status: "validated", ledger_index: null, result_code: null, delivered_amount: null, fee_drops: null });
  });
});

describe("cancel and sweeper (5A.2)", () => {
  it("cancels a hashless reserved payment: reservation released, invoice open, system actor", async () => {
    mem.payment = paymentRow({ status: "reserved" });
    expect(await cancelUnsignedIn({} as never, row().id, "STALE_RESERVATION", "x", SYSTEM_ACTOR)).toMatchObject({ status: "cancelled", failure_code: "STALE_RESERVATION" });
    expect([mem.reservation, mem.invoice]).toEqual(["released", "open"]);
    expect(mem.audits[0]).toMatchObject({ event_type: "payment.cancelled", actor_type: "system" });
  });

  it("never cancels a payment with a persisted hash or blob, or one already submitted", async () => {
    for (const p of [paymentRow({ status: "reserved", tx_hash: TX_HASH }), paymentRow({ status: "reserved", signed_blob: "AA" }), submittedRow(), submittedRow({ status: "pending_confirmation" })]) {
      mem.payment = p;
      expect(await cancelUnsignedIn({} as never, p.id, "STALE_RESERVATION", "x", SYSTEM_ACTOR)).toBeNull();
      expect(mem.payment).toBe(p);
    }
    expect(mem.reservation).toBe("reserved");
    expect(mem.audits).toEqual([]);
  });

  it("sweepStaleReservations cancels the hashless candidates the repo returns", async () => {
    const stale = paymentRow({ status: "reserved" });
    mem.payment = stale;
    mem.stale = [stale];
    expect(await sweepStaleReservations(makeSweepDeps())).toBe(1);
    expect(row().status).toBe("cancelled");
  });

  it("sweepStaleReservations skips a candidate that got a hash after selection", async () => {
    const racing = paymentRow({ status: "reserved" });
    mem.payment = { ...racing, status: "submitted", tx_hash: TX_HASH, last_ledger_sequence: 120, signed_blob: "AA" };
    mem.stale = [racing];
    expect(await sweepStaleReservations(makeSweepDeps())).toBe(0);
    expect(row().status).toBe("submitted");
  });
});
