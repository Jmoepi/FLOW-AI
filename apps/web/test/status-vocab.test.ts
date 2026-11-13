import { PaymentStatusSchema } from "@flow-ai/contracts";
import { describe, expect, it } from "vitest";
import { INVOICE_STATUSES, PAYMENT_STATUSES, invoiceStatus, paymentStatus } from "../src/components/status-vocab";
describe("status vocabulary", () => {
  it("covers every payment status of the contract", () => {
    expect([...PAYMENT_STATUSES].sort()).toEqual([...PaymentStatusSchema.options].sort());
  });
  it("labels and icons are distinct per status, so colour is never the only cue", () => {
    for (const [list, fn] of [[PAYMENT_STATUSES, paymentStatus], [INVOICE_STATUSES, invoiceStatus]] as const) {
      const infos = list.map((s) => fn(s));
      expect(new Set(infos.map((i) => i.label)).size).toBe(infos.length);
      for (const i of infos) expect(i.definition.length).toBeGreaterThan(10);
    }
    // Payment statuses show distinct shapes among themselves.
    expect(new Set(PAYMENT_STATUSES.map((s) => paymentStatus(s).icon)).size).toBe(PAYMENT_STATUSES.length);
    expect(new Set(INVOICE_STATUSES.map((s) => invoiceStatus(s).icon)).size).toBe(INVOICE_STATUSES.length);
  });
  it("only a validated payment is called Paid", () => {
    for (const s of PAYMENT_STATUSES) expect(paymentStatus(s).label === "Paid", s).toBe(s === "validated");
    expect(paymentStatus("submitted").definition).toMatch(/not paid/i);
    expect(paymentStatus("pending_confirmation").definition).toMatch(/not counted as paid/i);
  });
  it("an unknown status is never presented as paid", () => {
    for (const s of ["", "PAID", "__proto__", "toString", "validated "]) {
      expect(paymentStatus(s).label).toBe("Unknown");
      expect(invoiceStatus(s).label).toBe("Unknown");
    }
  });
});
