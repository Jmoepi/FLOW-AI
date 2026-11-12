import { describe, expect, it } from "vitest";
import { DEMO_FIXTURE_BASE, evaluatePolicy, scaleDemoFixture, type ScaledDemoFixture } from "../src";
import { SUPPLIER_C, make } from "./helpers";

type Inv = keyof typeof DEMO_FIXTURE_BASE.invoices;

/** Build the 13A request for one invoice at a given treasury balance. */
function fixtureRequest(inv: Inv, balance: string, f: ScaledDemoFixture, reservations: { amount: string }[] = []) {
  return make((r) => {
    r.balances.rlusd_balance = balance;
    r.policy.max_payment_amount = f.max_payment_amount;
    r.policy.daily_spend_limit = f.daily_spend_limit;
    r.policy.minimum_reserve = f.minimum_reserve;
    r.invoice.id = inv.toLowerCase();
    r.request.invoice_id = inv.toLowerCase();
    r.invoice.amount = f.invoices[inv];
    r.reservations = reservations.map((x, i) => ({ payment_id: `p${i}`, business_date: "2026-03-10", amount: x.amount, status: "committed" as const }));
    if (inv === "INV-103") {
      r.supplier.id = "sup-b";
      r.invoice.supplier_id = "sup-b";
      r.supplier.is_approved = false;
      r.supplier.country_code = "KE";
    }
    if (inv === "INV-105") {
      r.supplier.id = "sup-c";
      r.invoice.supplier_id = "sup-c";
      r.supplier.xrpl_address = SUPPLIER_C;
      r.supplier.country_code = "ZA";
    }
  });
}

const EXPECTED: Record<Inv, { allowed: boolean; code: string; also?: string[] }> = {
  "INV-101": { allowed: true, code: "ALLOWED" },
  "INV-102": { allowed: false, code: "PAYMENT_LIMIT_EXCEEDED" },
  "INV-103": { allowed: false, code: "SUPPLIER_NOT_APPROVED" },
  "INV-104": { allowed: false, code: "PAYMENT_LIMIT_EXCEEDED", also: ["MINIMUM_RESERVE_BREACHED"] },
  "INV-105": { allowed: true, code: "ALLOWED" },
};

describe("13A fixture at 1,000.00 RLUSD", () => {
  const f = scaleDemoFixture("1000.00")!;
  it("scales to itself at the base balance", () => {
    expect(f.max_payment_amount).toBe("200.00");
    expect(f.invoices["INV-104"]).toBe("800.00");
  });
  for (const inv of Object.keys(EXPECTED) as Inv[]) {
    it(`${inv} -> ${EXPECTED[inv].code}`, () => {
      const d = evaluatePolicy(fixtureRequest(inv, "1000.00", f));
      expect(d.allowed).toBe(EXPECTED[inv].allowed);
      expect(d.decision_code).toBe(EXPECTED[inv].code);
      for (const c of EXPECTED[inv].also ?? []) expect(d.failed_checks.map((x) => x.code)).toContain(c);
    });
  }
  it("INV-104 fails both the per-payment cap and the reserve (1000 - 800 < 250)", () => {
    const d = evaluatePolicy(fixtureRequest("INV-104", "1000.00", f));
    expect(d.failed_checks.map((x) => x.code)).toEqual(expect.arrayContaining(["PAYMENT_LIMIT_EXCEEDED", "MINIMUM_RESERVE_BREACHED", "DAILY_LIMIT_EXCEEDED"]));
  });
  it("INV-101 + INV-105 total 180 and both fit the 400 daily limit in one day", () => {
    const first = evaluatePolicy(fixtureRequest("INV-101", "1000.00", f));
    expect(first.allowed).toBe(true);
    // After INV-101 the balance is 880 and 120 is committed today.
    const second = evaluatePolicy(fixtureRequest("INV-105", "880.00", f, [{ amount: "120.00" }]));
    expect(second.allowed).toBe(true);
    expect(second.payment?.destination).toBe(SUPPLIER_C);
  });
  it("the daily cap eventually blocks eligible invoices", () => {
    const d = evaluatePolicy(fixtureRequest("INV-101", "1000.00", f, [{ amount: "281.00" }]));
    expect(d.decision_code).toBe("DAILY_LIMIT_EXCEEDED");
  });
});

describe("fixture scaling keeps pass/fail outcomes (14.1)", () => {
  // 100 gives the 12 / 27.5 / 9 / 80 / 6 RLUSD style numbers; 333.33 forces rounding.
  const balances = ["100", "100.00", "250", "333.33", "1000", "2500.50", "10000"];
  for (const bal of balances) {
    it(`balance ${bal}`, () => {
      const f = scaleDemoFixture(bal)!;
      for (const inv of Object.keys(EXPECTED) as Inv[]) {
        const d = evaluatePolicy(fixtureRequest(inv, bal, f));
        expect([inv, d.allowed, d.decision_code]).toEqual([inv, EXPECTED[inv].allowed, EXPECTED[inv].code]);
        for (const c of EXPECTED[inv].also ?? []) expect(d.failed_checks.map((x) => x.code)).toContain(c);
      }
      // Seeded numbers never exceed the real balance.
      for (const v of Object.values(f.invoices)) expect(Number(v)).toBeLessThanOrEqual(Number(bal));
      // Both eligible invoices still fit one day.
      const a = evaluatePolicy(fixtureRequest("INV-101", bal, f));
      const bBal = (Number(bal) - Number(f.invoices["INV-101"])).toFixed(2);
      const b = evaluatePolicy(fixtureRequest("INV-105", bBal, f, [{ amount: f.invoices["INV-101"] }]));
      expect([a.allowed, b.allowed]).toEqual([true, true]);
    });
  }
  it("balance 100 yields the 12 / 27.5 / 9 / 80 / 6 style amounts", () => {
    const f = scaleDemoFixture("100")!;
    expect(f.invoices).toEqual({ "INV-101": "12.00", "INV-102": "27.50", "INV-103": "9.00", "INV-104": "80.00", "INV-105": "6.00" });
    expect([f.max_payment_amount, f.daily_spend_limit, f.minimum_reserve]).toEqual(["20.00", "40.00", "25.00"]);
  });
  it("rejects unusable balances rather than guessing", () => {
    for (const v of ["0", "-5", "abc", "", "1e3"]) expect(scaleDemoFixture(v)).toBeNull();
  });
});
