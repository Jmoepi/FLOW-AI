import { describe, expect, it } from "vitest";
import { CHECK_IDS, PolicyDecisionSchema, type DecisionCode } from "@flow-ai/contracts";
import { evaluatePolicy } from "../src";
import { MAINNET_ISSUER, RLUSD_HEX, RLUSD_ISSUER, SUPPLIER_C, TREASURY, make } from "./helpers";

const blockedWith = (d: ReturnType<typeof evaluatePolicy>, code: DecisionCode): void => {
  expect(d.allowed).toBe(false);
  expect(d.decision_code).toBe(code);
  expect(d.failure_code).toBe(code);
  expect(d.payment).toBeNull();
  expect(d.message.length).toBeGreaterThan(0);
};

describe("baseline", () => {
  it("allows the eligible fixture request and returns a schema-valid decision", () => {
    const d = evaluatePolicy(make());
    expect(d.allowed).toBe(true);
    expect(d.decision_code).toBe("ALLOWED");
    expect(d.failure_code).toBeNull();
    expect(d.failed_checks).toEqual([]);
    expect([...d.checks_passed]).toEqual([...CHECK_IDS]);
    expect(d.payment).toMatchObject({ amount: "120.00", destination: expect.any(String), network: "xrpl-testnet", business_date: "2026-03-10" });
    expect(PolicyDecisionSchema.safeParse(d).success).toBe(true);
  });
  it("is deterministic", () => {
    expect(evaluatePolicy(make())).toEqual(evaluatePolicy(make()));
  });
  it("does not mutate its input", () => {
    const r = make();
    const copy = structuredClone(r);
    evaluatePolicy(r);
    expect(r).toEqual(copy);
  });
  it("records the policy version on allow and block decisions", () => {
    expect(evaluatePolicy(make()).policy_version).toBe(4);
    expect(evaluatePolicy(make((r) => { r.policy.enabled = false; r.policy.version = 9; })).policy_version).toBe(9);
  });
  it("reports the first failure in 6.3 order as the primary decision while listing all", () => {
    const d = evaluatePolicy(make((r) => { r.policy.enabled = false; r.supplier.is_approved = false; }));
    expect(d.failed_check).toBe("automation_enabled");
    expect(d.failed_checks.map((f) => f.code)).toEqual(["AUTOMATION_PAUSED", "SUPPLIER_NOT_APPROVED"]);
  });
});

describe("internal errors fail closed", () => {
  const boom = () => { throw new Error("boom"); };
  it.each(["invoice", "policy", "supplier"] as const)("blocks with INTERNAL_ERROR when reading %s throws", (key) => {
    const r = make();
    Object.defineProperty(r, key, { get: boom, enumerable: true });
    const d = evaluatePolicy(r);
    blockedWith(d, "INTERNAL_ERROR");
    expect(PolicyDecisionSchema.safeParse(d).success).toBe(true);
  });
});

describe("invalid input fails closed", () => {
  it.each([undefined, null, 42, "x", [], {}])("blocks malformed request %o", (v) => {
    blockedWith(evaluatePolicy(v), "INVALID_REQUEST");
  });
  it("blocks a bad timezone and bad now", () => {
    blockedWith(evaluatePolicy(make((r) => { r.business.timezone = "Nowhere/City"; })), "INVALID_REQUEST");
    blockedWith(evaluatePolicy(make((r) => { r.now = "2026-02-30T00:00:00Z"; })), "INVALID_REQUEST");
  });
  it("blocks malformed policy money strings", () => {
    blockedWith(evaluatePolicy(make((r) => { r.policy.max_payment_amount = "1e3"; })), "INVALID_REQUEST");
    blockedWith(evaluatePolicy(make((r) => { (r.policy as unknown as Record<string, unknown>).daily_spend_limit = 400; })), "INVALID_REQUEST");
  });
  it("blocks missing reserve inputs (never hardcoded)", () => {
    blockedWith(evaluatePolicy(make((r) => { delete (r as unknown as Record<string, unknown>).xrpl_reserves; })), "INVALID_REQUEST");
  });
  it("agent_reason longer than 280 chars is rejected; 280 passes", () => {
    blockedWith(evaluatePolicy(make((r) => { r.request.agent_reason = "x".repeat(281); })), "INVALID_REQUEST");
    expect(evaluatePolicy(make((r) => { r.request.agent_reason = "x".repeat(280); })).allowed).toBe(true);
  });
});

describe("invoice amount validation (14.1 parser)", () => {
  it.each([
    ["negative", "-5"], ["zero", "0"], ["zero decimals", "0.00"], ["NaN string", "NaN"], ["Infinity", "Infinity"],
    ["exponent", "1e2"], ["excess precision", "10.0000001"], ["empty", ""], ["padded", " 10"],
    ["NaN number", NaN], ["float number", 10.5], ["integer number", 10], ["null", null], ["undefined", undefined], ["object", {}],
  ])("blocks %s", (_n, amount) => {
    const d = evaluatePolicy(make((r) => { r.invoice.amount = amount; }));
    blockedWith(d, "INVALID_AMOUNT");
    expect(d.checks_skipped).toContain("per_payment_limit");
  });
  it("allows 6-decimal amounts", () => {
    const d = evaluatePolicy(make((r) => { r.invoice.amount = "0.000001"; }));
    expect(d.allowed).toBe(true);
  });
});

describe("per-payment cap", () => {
  it("passes exactly at the cap", () => {
    expect(evaluatePolicy(make((r) => { r.invoice.amount = "200.00"; r.policy.daily_spend_limit = "1000"; })).allowed).toBe(true);
  });
  it("blocks one smallest unit over the cap", () => {
    const d = evaluatePolicy(make((r) => { r.invoice.amount = "200.000001"; r.policy.daily_spend_limit = "1000"; }));
    blockedWith(d, "PAYMENT_LIMIT_EXCEEDED");
    expect(d.failed_check).toBe("per_payment_limit");
    expect(d.message).toContain("200.000001");
  });
  it("passes one smallest unit under the cap", () => {
    expect(evaluatePolicy(make((r) => { r.invoice.amount = "199.999999"; })).allowed).toBe(true);
  });
});

describe("daily cap with reservation-aware totals", () => {
  const res = (amount: string, status: "reserved" | "committed" | "released", date = "2026-03-10") =>
    ({ payment_id: `p-${amount}-${status}`, business_date: date, amount, status });
  it("passes exactly at the daily limit and blocks one unit over", () => {
    expect(evaluatePolicy(make((r) => { r.reservations = [res("280", "committed")]; })).allowed).toBe(true); // 280 + 120 = 400
    const d = evaluatePolicy(make((r) => { r.reservations = [res("280.000001", "committed")]; }));
    blockedWith(d, "DAILY_LIMIT_EXCEEDED");
    expect(d.failed_checks[0]?.details?.remaining_allowance).toBe("119.999999");
  });
  it("counts reserved (pending/uncertain) and committed together", () => {
    blockedWith(evaluatePolicy(make((r) => { r.reservations = [res("150", "reserved"), res("131", "committed")]; })), "DAILY_LIMIT_EXCEEDED");
    blockedWith(evaluatePolicy(make((r) => { r.reservations = [res("281", "reserved")]; })), "DAILY_LIMIT_EXCEEDED");
  });
  it("ignores released reservations", () => {
    expect(evaluatePolicy(make((r) => { r.reservations = [res("390", "released")]; })).allowed).toBe(true);
  });
  it("sums decimals exactly (0.1 + 0.2 style)", () => {
    const d = evaluatePolicy(make((r) => {
      r.policy.daily_spend_limit = "0.6";
      r.policy.max_payment_amount = "1";
      r.policy.minimum_reserve = "0";
      r.invoice.amount = "0.3";
      r.reservations = [res("0.1", "reserved"), res("0.2", "committed")];
    }));
    expect(d.allowed).toBe(true); // 0.1 + 0.2 + 0.3 == 0.6 exactly
    const over = evaluatePolicy(make((r) => {
      r.policy.daily_spend_limit = "0.6";
      r.policy.max_payment_amount = "1";
      r.invoice.amount = "0.300001";
      r.reservations = [res("0.1", "reserved"), res("0.2", "committed")];
    }));
    blockedWith(over, "DAILY_LIMIT_EXCEEDED");
  });
  it("rolls over at Africa/Johannesburg midnight, not UTC midnight", () => {
    const full = [res("400", "committed", "2026-03-10")];
    // 21:59:59Z is still 10 March locally: day is full.
    blockedWith(evaluatePolicy(make((r) => { r.now = "2026-03-10T21:59:59Z"; r.reservations = full; })), "DAILY_LIMIT_EXCEEDED");
    // 22:00:00Z is 00:00 on 11 March locally: new day, fresh allowance.
    const next = evaluatePolicy(make((r) => { r.now = "2026-03-10T22:00:00Z"; r.reservations = full; }));
    expect(next.allowed).toBe(true);
    expect(next.payment?.business_date).toBe("2026-03-11");
  });
  it("does not let yesterday UTC-date rows leak across the local boundary", () => {
    // 23:30Z on the 10th is the 11th locally; a row dated 2026-03-10 must not count, one dated 2026-03-11 must.
    const t = "2026-03-10T23:30:00Z";
    expect(evaluatePolicy(make((r) => { r.now = t; r.reservations = [res("400", "committed", "2026-03-10")]; })).allowed).toBe(true);
    blockedWith(evaluatePolicy(make((r) => { r.now = t; r.reservations = [res("400", "committed", "2026-03-11")]; })), "DAILY_LIMIT_EXCEEDED");
  });
  it("uses the business timezone from the input, not a constant", () => {
    const full = [res("400", "committed", "2026-03-10")];
    // New York is UTC-4 in March (DST); 22:00Z is still the 10th there.
    blockedWith(evaluatePolicy(make((r) => { r.business.timezone = "America/New_York"; r.now = "2026-03-10T22:00:00Z"; r.reservations = full; })), "DAILY_LIMIT_EXCEEDED");
  });
});

describe("minimum reserve floor", () => {
  it("passes when the remaining balance equals the reserve exactly", () => {
    expect(evaluatePolicy(make((r) => { r.balances.rlusd_balance = "370.00"; })).allowed).toBe(true); // 370-120 = 250
  });
  it("blocks one smallest unit below the reserve", () => {
    const d = evaluatePolicy(make((r) => { r.balances.rlusd_balance = "369.999999"; }));
    blockedWith(d, "MINIMUM_RESERVE_BREACHED");
    expect(d.failed_checks[0]?.details?.remaining_after_payment).toBe("249.999999");
  });
  it("sufficient balance is checked before the reserve", () => {
    const d = evaluatePolicy(make((r) => { r.balances.rlusd_balance = "100"; }));
    blockedWith(d, "INSUFFICIENT_RLUSD_BALANCE");
    expect(d.failed_checks.map((f) => f.code)).toContain("MINIMUM_RESERVE_BREACHED");
  });
  it("blocks when the live balance is unavailable or malformed", () => {
    for (const v of [null, undefined, "abc", -5, "-1", NaN]) {
      blockedWith(evaluatePolicy(make((r) => { r.balances.rlusd_balance = v; })), "BALANCE_UNAVAILABLE");
    }
  });
});

describe("suppliers", () => {
  it("unapproved supplier is always rejected", () => {
    blockedWith(evaluatePolicy(make((r) => { r.supplier.is_approved = false; })), "SUPPLIER_NOT_APPROVED");
  });
  it("approval must be the boolean true (a truthy string is invalid input)", () => {
    blockedWith(evaluatePolicy(make((r) => { (r.supplier as unknown as Record<string, unknown>).is_approved = "true"; })), "INVALID_REQUEST");
  });
  it("inactive supplier is rejected", () => {
    blockedWith(evaluatePolicy(make((r) => { r.supplier.is_active = false; })), "SUPPLIER_INACTIVE");
  });
  it("supplier country_code does not change any outcome", () => {
    const outcome = (cc: string | undefined, mutate?: Parameters<typeof make>[0]) =>
      evaluatePolicy(make((r) => { r.supplier.country_code = cc; r.business.is_active = true; mutate?.(r); }));
    for (const mutate of [undefined, (r: ReturnType<typeof make>) => { r.invoice.amount = "275"; }, (r: ReturnType<typeof make>) => { r.supplier.is_approved = false; }]) {
      const results = ["NG", "KE", "ZA", "US", undefined].map((cc) => {
        const d = outcome(cc, mutate);
        return { allowed: d.allowed, code: d.decision_code, failed: d.failed_checks.map((f) => f.check) };
      });
      for (const x of results) expect(x).toEqual(results[0]);
    }
  });
  it("destination must be a valid classic address", () => {
    for (const bad of ["", "r123", "not-an-address", SUPPLIER_C.slice(0, -1) + "x", "X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ"]) {
      blockedWith(evaluatePolicy(make((r) => { r.supplier.xrpl_address = bad; })), "INVALID_DESTINATION");
    }
  });
  it("destination cannot be the treasury's own address", () => {
    const d = evaluatePolicy(make((r) => { r.supplier.xrpl_address = TREASURY; }));
    blockedWith(d, "INVALID_DESTINATION");
    expect(d.failed_check).toBe("destination_not_treasury");
  });
});

describe("agent payload cannot override canonical records", () => {
  it("uses the invoice amount and supplier address in the approved payment", () => {
    const d = evaluatePolicy(make((r) => {
      Object.assign(r.request, { claimed_amount: "120.00", claimed_destination: r.supplier.xrpl_address, amount: "1", destination: TREASURY, supplier_id: "evil" });
    }));
    expect(d.allowed).toBe(true);
    expect(d.payment).toMatchObject({ amount: "120.00", destination: make().supplier.xrpl_address, supplier_id: "sup-a" });
  });
  it("blocks a claimed amount or destination that disagrees with the records", () => {
    blockedWith(evaluatePolicy(make((r) => { r.request.claimed_amount = "1.00"; })), "REQUEST_MISMATCH");
    blockedWith(evaluatePolicy(make((r) => { r.request.claimed_amount = 120; })), "REQUEST_MISMATCH");
    blockedWith(evaluatePolicy(make((r) => { r.request.claimed_destination = SUPPLIER_C; })), "REQUEST_MISMATCH");
  });
  it("a different invoice id is not found", () => {
    blockedWith(evaluatePolicy(make((r) => { r.request.invoice_id = "inv-999"; })), "INVOICE_NOT_FOUND");
  });
});

describe("assets and network", () => {
  it("rejects an asset pair not in allowed_assets (wrong issuer, wrong currency, empty list)", () => {
    blockedWith(evaluatePolicy(make((r) => { r.policy.allowed_assets = [{ currency: RLUSD_HEX, issuer: MAINNET_ISSUER }]; })), "ASSET_NOT_ALLOWED");
    blockedWith(evaluatePolicy(make((r) => { r.policy.allowed_assets = [{ currency: "USD", issuer: RLUSD_ISSUER }]; })), "ASSET_NOT_ALLOWED");
    blockedWith(evaluatePolicy(make((r) => { r.policy.allowed_assets = []; })), "ASSET_NOT_ALLOWED");
  });
  it("matches the pair, not the symbol alone, and rejects a non-RLUSD invoice currency", () => {
    blockedWith(evaluatePolicy(make((r) => { r.invoice.currency = "USD"; })), "ASSET_NOT_ALLOWED");
    blockedWith(evaluatePolicy(make((r) => { r.invoice.currency = "rlusd"; })), "ASSET_NOT_ALLOWED");
  });
  it("only xrpl-testnet is allowed", () => {
    blockedWith(evaluatePolicy(make((r) => { r.config.network = "xrpl-mainnet"; })), "NETWORK_NOT_ALLOWED");
    blockedWith(evaluatePolicy(make((r) => { r.wallet.network = "xrpl-mainnet"; })), "NETWORK_NOT_ALLOWED");
    blockedWith(evaluatePolicy(make((r) => { r.wallet.network = "XRPL-TESTNET"; })), "NETWORK_NOT_ALLOWED");
  });
  it("blocks the Mainnet issuer even if configured and allowlisted", () => {
    const d = evaluatePolicy(make((r) => {
      r.config.rlusd_issuer = MAINNET_ISSUER;
      r.wallet.asset_issuer = MAINNET_ISSUER;
      r.policy.allowed_assets = [{ currency: RLUSD_HEX, issuer: MAINNET_ISSUER }];
    }));
    blockedWith(d, "NETWORK_NOT_ALLOWED");
  });
  it("blocks a wallet whose asset differs from the configured pair", () => {
    blockedWith(evaluatePolicy(make((r) => { r.wallet.asset_issuer = SUPPLIER_C; })), "NETWORK_NOT_ALLOWED");
  });
});

describe("mandate, automation and kill switch", () => {
  it("paused automation rejects", () => {
    blockedWith(evaluatePolicy(make((r) => { r.policy.enabled = false; })), "AUTOMATION_PAUSED");
  });
  it.each([undefined, null, "", "TRUE", "True", "1", "yes", " true", "true ", "false", true, 1, {}, [], "unreadable"])(
    "kill switch value %o blocks (fail closed)",
    (v) => {
      blockedWith(evaluatePolicy(make((r) => { r.kill_switch_value = v; })), "EXECUTION_DISABLED");
    },
  );
  it("kill switch key missing entirely blocks", () => {
    blockedWith(evaluatePolicy(make((r) => { delete r.kill_switch_value; })), "EXECUTION_DISABLED");
  });
  it("only the exact string 'true' executes", () => {
    expect(evaluatePolicy(make((r) => { r.kill_switch_value = "true"; })).allowed).toBe(true);
  });
  it("expired mandate rejects; unexpired passes; exactly at expiry is expired", () => {
    blockedWith(evaluatePolicy(make((r) => { r.policy.valid_until = "2026-03-10T07:59:59Z"; })), "MANDATE_EXPIRED");
    blockedWith(evaluatePolicy(make((r) => { r.policy.valid_until = "2026-03-10T08:00:00Z"; })), "MANDATE_EXPIRED");
    expect(evaluatePolicy(make((r) => { r.policy.valid_until = "2026-03-10T08:00:01Z"; })).allowed).toBe(true);
    expect(evaluatePolicy(make((r) => { r.policy.valid_until = null; })).allowed).toBe(true);
  });
  it("compares mandate expiry as instants across offsets", () => {
    // 09:00+02:00 == 07:00Z, before now (08:00Z).
    blockedWith(evaluatePolicy(make((r) => { r.policy.valid_until = "2026-03-10T09:00:00+02:00"; })), "MANDATE_EXPIRED");
  });
  it("an unreadable valid_until fails closed as expired", () => {
    blockedWith(evaluatePolicy(make((r) => { r.policy.valid_until = "next tuesday"; })), "MANDATE_EXPIRED");
  });
});

describe("record state, duplicates and idempotency", () => {
  it("inactive business or wallet blocks", () => {
    blockedWith(evaluatePolicy(make((r) => { r.business.is_active = false; })), "RECORD_INACTIVE");
    blockedWith(evaluatePolicy(make((r) => { r.wallet.is_active = false; })), "RECORD_INACTIVE");
  });
  it("invoice from another business is not found", () => {
    blockedWith(evaluatePolicy(make((r) => { r.invoice.business_id = "biz-2"; })), "INVOICE_NOT_FOUND");
  });
  it("mismatched wallet/supplier linkage blocks", () => {
    blockedWith(evaluatePolicy(make((r) => { r.wallet.business_id = "biz-2"; })), "RECORD_MISMATCH");
    blockedWith(evaluatePolicy(make((r) => { r.supplier.id = "sup-x"; })), "RECORD_MISMATCH");
    blockedWith(evaluatePolicy(make((r) => { r.supplier.business_id = "biz-2"; })), "RECORD_MISMATCH");
  });
  it.each(["draft", "paid", "cancelled"] as const)("%s invoice is not payable", (s) => {
    blockedWith(evaluatePolicy(make((r) => { r.invoice.status = s; })), "INVOICE_NOT_PAYABLE");
  });
  it("a previously blocked invoice can be re-evaluated and pass", () => {
    expect(evaluatePolicy(make((r) => { r.invoice.status = "blocked"; })).allowed).toBe(true);
  });
  it("a processing invoice is already in progress", () => {
    blockedWith(evaluatePolicy(make((r) => { r.invoice.status = "processing"; })), "PAYMENT_ALREADY_IN_PROGRESS");
  });
  it("a validated payment for the invoice means it is not payable", () => {
    blockedWith(evaluatePolicy(make((r) => { r.payments = [{ id: "p1", invoice_id: "inv-101", idempotency_key: "other", status: "validated" }]; })), "INVOICE_NOT_PAYABLE");
  });
  it("a reused idempotency key is a duplicate and names the existing payment", () => {
    const d = evaluatePolicy(make((r) => { r.payments = [{ id: "p1", invoice_id: "inv-other", idempotency_key: "idem-1", status: "blocked" }]; }));
    blockedWith(d, "DUPLICATE_REQUEST");
    expect(d.failed_checks[0]?.details?.existing_payment_id).toBe("p1");
  });
  it.each(["requested", "reserved", "submitted", "pending_confirmation"] as const)("active %s payment on the invoice blocks", (s) => {
    blockedWith(evaluatePolicy(make((r) => { r.payments = [{ id: "p1", invoice_id: "inv-101", idempotency_key: "other", status: s }]; })), "PAYMENT_ALREADY_IN_PROGRESS");
  });
  it.each(["blocked", "failed", "cancelled"] as const)("a %s earlier attempt does not block a new key", (s) => {
    expect(evaluatePolicy(make((r) => { r.payments = [{ id: "p1", invoice_id: "inv-101", idempotency_key: "other", status: s }]; })).allowed).toBe(true);
  });
  it("active payments on other invoices do not block", () => {
    expect(evaluatePolicy(make((r) => { r.payments = [{ id: "p1", invoice_id: "inv-777", idempotency_key: "other", status: "submitted" }]; })).allowed).toBe(true);
  });
});

describe("XRPL trust line and XRP reserve (reserves are inputs)", () => {
  it("missing or unknown destination trust line blocks", () => {
    blockedWith(evaluatePolicy(make((r) => { r.destination_trustline = "absent"; })), "MISSING_RLUSD_TRUSTLINE");
    blockedWith(evaluatePolicy(make((r) => { r.destination_trustline = "unknown"; })), "MISSING_RLUSD_TRUSTLINE");
  });
  it("passes when XRP equals base + owner reserve + fee exactly and blocks one drop less", () => {
    // 1_000_000 + 1*200_000 + 12 = 1_200_012
    expect(evaluatePolicy(make((r) => { r.balances.xrp_balance_drops = "1200012"; })).allowed).toBe(true);
    blockedWith(evaluatePolicy(make((r) => { r.balances.xrp_balance_drops = "1200011"; })), "XRPL_RESERVE_INSUFFICIENT");
  });
  it("responds to changed ledger reserves and owner counts", () => {
    blockedWith(evaluatePolicy(make((r) => { r.xrpl_reserves.treasury_owner_count = 5; r.balances.xrp_balance_drops = "1200012"; })), "XRPL_RESERVE_INSUFFICIENT");
    expect(evaluatePolicy(make((r) => { r.xrpl_reserves = { base_reserve_drops: "10000000", owner_reserve_drops: "2000000", treasury_owner_count: 2, estimated_fee_drops: "15" }; r.balances.xrp_balance_drops = "14000015"; })).allowed).toBe(true);
  });
  it("unavailable XRP balance blocks", () => {
    blockedWith(evaluatePolicy(make((r) => { r.balances.xrp_balance_drops = null; })), "XRPL_RESERVE_INSUFFICIENT");
  });
  it("handles drop values beyond 2^53 exactly", () => {
    const big = "9007199254740993"; // 2^53 + 1
    expect(evaluatePolicy(make((r) => { r.xrpl_reserves.base_reserve_drops = big; r.balances.xrp_balance_drops = (BigInt(big) + 200012n).toString(); })).allowed).toBe(true);
    blockedWith(evaluatePolicy(make((r) => { r.xrpl_reserves.base_reserve_drops = big; r.balances.xrp_balance_drops = (BigInt(big) + 200011n).toString(); })), "XRPL_RESERVE_INSUFFICIENT");
  });
});
