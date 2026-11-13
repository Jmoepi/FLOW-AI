import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageUpdatedAt, auditEventTypes, invoiceStatus, paymentSummaries } from "@flow-ai/database/testing";
import { verifyAuditChain } from "@flow-ai/database";
import { sweepStaleReservations } from "../src/jobs/sweeper";
import { requestPayment } from "../src/services/payments";
import { randomUUID } from "node:crypto";
import { assertNoLeaks, createHarness, key, type Harness } from "./db-harness";
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
async function pay(opts: { amount?: string } = {}) {
  const s = await h.scenario({ dailyLimit: "10" });
  const invoice = await h.invoice(s, { amount: opts.amount ?? "1" });
  const res = await h.post(invoice, key("out"));
  const [row] = await paymentSummaries(h.db.adminPool, s.businessId);
  return { s, invoice, res, row };
}
describe("outcome mapping end to end (10.3, 5A)", () => {
  it("tesSUCCESS -> validated, reservation committed, invoice paid, blob cleared", async () => {
    h.ledger.mode = "validate";
    const { s, invoice, res, row } = await pay();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "validated", currency: "RLUSD", network: "xrpl-testnet" });
    expect(res.body.tx_hash).toMatch(/^[0-9A-F]{64}$/);
    expect(res.body.explorer_url).toBe(`https://testnet.xrpl.org/transactions/${res.body.tx_hash as string}`);
    expect(row).toMatchObject({ status: "validated", reservation: "committed", invoice_status: "paid", signed_blob_present: false, result_code: "tesSUCCESS", delivered_amount: "1" });
    expect(await invoiceStatus(h.db.adminPool, invoice)).toBe("paid");
    expect(await auditEventTypes(h.db.adminPool, row?.id as string)).toEqual(
      expect.arrayContaining(["payment.requested", "payment.reserved", "payment.signed", "payment.submit_ack", "payment.validated"]),
    );
    expect(await verifyAuditChain(h.db.guardPool, s.businessId)).toBe(true);
  });
  it("tec -> failed with the fee recorded, hold released, invoice open again", async () => {
    h.ledger.mode = "tec";
    try {
      const { res, row } = await pay();
      expect(res.body).toMatchObject({ status: "failed", failure_code: "XRPL_SUBMISSION_FAILED" });
      expect(row).toMatchObject({ status: "failed", reservation: "released", invoice_status: "open", fee_drops: "12", result_code: "tecPATH_DRY", signed_blob_present: false });
    } finally {
      h.ledger.mode = "validate";
    }
  });
  it("partial delivery -> failed PARTIAL_DELIVERY, hold stays committed, never paid", async () => {
    h.ledger.mode = "partial";
    try {
      const { res, row } = await pay();
      expect(res.body).toMatchObject({ status: "failed", failure_code: "PARTIAL_DELIVERY" });
      expect(row).toMatchObject({ status: "failed", reservation: "committed", delivered_amount: "0.5" });
      expect(row?.invoice_status).not.toBe("paid");
    } finally {
      h.ledger.mode = "validate";
    }
  });
  it("ambiguous submit -> pending_confirmation with the hold kept, later reconciled to validated", async () => {
    h.ledger.mode = "throw";
    try {
      const { s, invoice, res, row } = await pay();
      expect(res.status).toBe(202);
      expect(res.body.status).toBe("pending_confirmation");
      expect(row).toMatchObject({ status: "pending_confirmation", reservation: "reserved", invoice_status: "processing", signed_blob_present: true });
      // A retry with a new key cannot start a second payment for the same invoice.
      const submits = h.ledger.submits.length;
      expect((await h.post(invoice, key("retry"))).body.status).toBe("blocked");
      expect(h.ledger.submits.length).toBe(submits);
      h.ledger.validate(row?.tx_hash as string);
      const counts = await h.reconciler.runOnce();
      expect(counts.validated).toBeGreaterThanOrEqual(1);
      const [after] = await paymentSummaries(h.db.adminPool, s.businessId);
      expect(after).toMatchObject({ status: "validated", reservation: "committed", invoice_status: "paid", signed_blob_present: false });
    } finally {
      h.ledger.mode = "validate";
    }
  });
  it("PG-4: expiry stays pending without proof of complete history, and fails only once history is proven", async () => {
    h.ledger.mode = "hold";
    h.ledger.searchedAll = false;
    h.ledger.complete = [];
    try {
      const { s, row } = await pay();
      expect(row).toMatchObject({ status: "pending_confirmation", reservation: "reserved" });
      const submits = h.ledger.submits.length;
      h.ledger.validated += 40; // past LastLedgerSequence
      await h.reconciler.runOnce();
      expect((await paymentSummaries(h.db.adminPool, s.businessId))[0]).toMatchObject({ status: "pending_confirmation", reservation: "reserved", invoice_status: "processing" });
      expect(h.ledger.submits.length).toBe(submits); // an expired transaction is never resubmitted
      h.ledger.complete = [{ minLedger: 1, maxLedger: h.ledger.validated + 100 }];
      await h.reconciler.runOnce();
      expect((await paymentSummaries(h.db.adminPool, s.businessId))[0]).toMatchObject({ status: "failed", reservation: "released", invoice_status: "open", signed_blob_present: false });
      expect(h.ledger.submits.length).toBe(submits);
    } finally {
      h.ledger.mode = "validate";
      h.ledger.complete = [];
    }
  });
  it("PG-5: crash recovery resubmits the identical blob while LastLedgerSequence is in the future", async () => {
    h.ledger.mode = "throw"; // the submit never reached the network
    const { s, row } = await pay();
    expect(row?.status).toBe("pending_confirmation");
    const sent = h.ledger.submits.splice(0);
    const original = sent[sent.length - 1]?.blob as string;
    h.ledger.known.clear();
    h.ledger.mode = "validate";
    // "Restart": a brand new service object, nothing in memory from the first one.
    const worker = h.spawnWorker();
    const counts = await worker.reconciler.runOnce();
    expect(counts.resubmitted).toBeGreaterThanOrEqual(1);
    expect(h.ledger.submits.map((x) => x.blob)).toContain(original);
    expect(h.ledger.submits.every((x) => x.hash === row?.tx_hash)).toBe(true);
    expect((await paymentSummaries(h.db.adminPool, s.businessId))[0]).toMatchObject({ status: "validated", reservation: "committed", invoice_status: "paid" });
  });
});
describe("sweeper (5A.2)", () => {
  it("cancels a stale reservation that never reached signing and releases its hold", async () => {
    const s = await h.scenario({ dailyLimit: "10" });
    const invoice = await h.invoice(s);
    const reserved = await requestPayment(h.reserveOnlyDeps, { invoice_id: invoice, idempotency_key: key("stale") }, randomUUID());
    expect(reserved.body.status).toBe("reserved");
    expect(await sweepStaleReservations(h.deps)).toBe(0); // fresh: untouched
    await ageUpdatedAt(h.db.adminPool, reserved.body.payment_id as string, 100_000);
    expect(await sweepStaleReservations(h.deps)).toBe(1);
    expect((await paymentSummaries(h.db.adminPool, s.businessId))[0]).toMatchObject({
      status: "cancelled", failure_code: "STALE_RESERVATION", reservation: "released", invoice_status: "open",
    });
  });
  it("never touches a payment that already has a hash, however old", async () => {
    h.ledger.mode = "throw";
    try {
      const { s, row } = await pay();
      expect(row?.status).toBe("pending_confirmation");
      await ageUpdatedAt(h.db.adminPool, row?.id as string, 100_000);
      expect(await sweepStaleReservations(h.deps)).toBe(0);
      expect((await paymentSummaries(h.db.adminPool, s.businessId))[0]?.status).toBe("pending_confirmation");
    } finally {
      h.ledger.mode = "validate";
    }
  });
});
describe("leaks", () => {
  it("G-3/PG-10: no seed, token, DB password or signed blob in logs, responses or stored rows", async () => {
    expect(await assertNoLeaks(h)).toEqual([]);
  });
});
