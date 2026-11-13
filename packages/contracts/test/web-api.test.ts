import { describe, expect, it } from "vitest";
import {
  AuditQuerySchema,
  IdParamsSchema,
  LoginSchema,
  SupplierPatchSchema,
  createPolicyUpdateSchema,
  diffPolicy,
  moneyToMicro,
  type PolicyFields,
} from "../src/index";
const NOW = Date.parse("2030-01-01T00:00:00Z");
const schema = createPolicyUpdateSchema(() => NOW);
const ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
const CUR = "524C555344000000000000000000000000000000";
const base = {
  enabled: true,
  max_payment_amount: "100",
  daily_spend_limit: "500",
  minimum_reserve: "50",
  allowed_assets: [{ currency: CUR, issuer: ISSUER }],
  valid_until: "2030-06-01T00:00:00Z",
};
const policy = (over: Partial<PolicyFields> = {}): PolicyFields => ({ ...base, ...over });
describe("PolicyUpdateSchema", () => {
  it("accepts a valid update, with and without confirm_risky", () => {
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, confirm_risky: true, valid_until: null }).success).toBe(true);
  });
  it("rejects unknown keys, including tenant and version fields", () => {
    for (const k of ["business_id", "user_id", "version", "updated_by", "id", "extra"]) {
      expect(schema.safeParse({ ...base, [k]: "x" }).success, k).toBe(false);
    }
  });
  it("rejects prototype pollution keys", () => {
    const evil = JSON.parse('{"__proto__": {"enabled": true}, "enabled": true}') as Record<string, unknown>;
    expect(schema.safeParse({ ...base, ...evil, constructor: {} }).success).toBe(false);
    expect(schema.safeParse(JSON.parse(`${JSON.stringify(base).slice(0, -1)},"__proto__":{"x":1}}`)).success).toBe(false);
  });
  it("rejects floats, numbers, exponents, negatives, signs, whitespace and too many decimals", () => {
    for (const bad of [100, 1.5, "1e3", "-1", "+1", " 1", "1 ", "1.1234567", "01", ".5", "", "NaN", "Infinity", "1,5", null]) {
      expect(schema.safeParse({ ...base, max_payment_amount: bad }).success, String(bad)).toBe(false);
    }
  });
  it("rejects amounts above the 1e9 bound and per-payment above daily", () => {
    expect(schema.safeParse({ ...base, daily_spend_limit: "1000000001", max_payment_amount: "1" }).success).toBe(false);
    expect(schema.safeParse({ ...base, daily_spend_limit: "1000000000", max_payment_amount: "1" }).success).toBe(true);
    expect(schema.safeParse({ ...base, max_payment_amount: "501" }).success).toBe(false);
    expect(schema.safeParse({ ...base, max_payment_amount: "500" }).success).toBe(true);
  });
  it("rejects a non-boolean enabled and a non-boolean confirm_risky", () => {
    expect(schema.safeParse({ ...base, enabled: "true" }).success).toBe(false);
    expect(schema.safeParse({ ...base, confirm_risky: "yes" }).success).toBe(false);
  });
  it("bounds and validates allowed_assets", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ currency: CUR, issuer: `r${String(i).repeat(25)}`.replace(/0/g, "1") }));
    expect(schema.safeParse({ ...base, allowed_assets: many }).success).toBe(false);
    expect(schema.safeParse({ ...base, allowed_assets: [{ currency: "rlusd", issuer: ISSUER }] }).success).toBe(false);
    expect(schema.safeParse({ ...base, allowed_assets: [{ currency: CUR, issuer: "notanaddress" }] }).success).toBe(false);
    expect(schema.safeParse({ ...base, allowed_assets: [{ currency: CUR, issuer: ISSUER, extra: 1 }] }).success).toBe(false);
    expect(schema.safeParse({ ...base, allowed_assets: [{ currency: CUR, issuer: ISSUER }, { currency: CUR, issuer: ISSUER }] }).success).toBe(false);
    expect(schema.safeParse({ ...base, allowed_assets: [] }).success).toBe(true);
  });
  it("valid_until must be a real future instant within a year, or null", () => {
    for (const bad of ["2029-12-31T23:59:59Z", "2030-01-01T00:00:00Z", "2032-01-01T00:00:00Z", "2030-02-30T00:00:00Z", "tomorrow", "2030-06-01", 20300601]) {
      expect(schema.safeParse({ ...base, valid_until: bad }).success, String(bad)).toBe(false);
    }
    expect(schema.safeParse({ ...base, valid_until: "2030-12-31T00:00:00Z" }).success).toBe(true);
    expect(schema.safeParse({ ...base, valid_until: null }).success).toBe(true);
  });
});
describe("other schemas", () => {
  it("LoginSchema bounds email and password and is strict", () => {
    expect(LoginSchema.safeParse({ email: "a@b.co", password: "x".repeat(12) }).success).toBe(true);
    expect(LoginSchema.safeParse({ email: "a@b.co", password: "x".repeat(11) }).success).toBe(false);
    expect(LoginSchema.safeParse({ email: "a@b.co", password: "x".repeat(257) }).success).toBe(false);
    expect(LoginSchema.safeParse({ email: "a".repeat(255), password: "x".repeat(12) }).success).toBe(false);
    expect(LoginSchema.safeParse({ email: "a@b.co", password: "x".repeat(12), role: "owner" }).success).toBe(false);
  });
  it("SupplierPatchSchema needs at least one boolean and nothing else", () => {
    expect(SupplierPatchSchema.safeParse({}).success).toBe(false);
    expect(SupplierPatchSchema.safeParse({ is_approved: true }).success).toBe(true);
    expect(SupplierPatchSchema.safeParse({ is_active: false, is_approved: false }).success).toBe(true);
    expect(SupplierPatchSchema.safeParse({ is_approved: "true" }).success).toBe(false);
    expect(SupplierPatchSchema.safeParse({ is_approved: true, name: "x" }).success).toBe(false);
    expect(SupplierPatchSchema.safeParse({ is_approved: true, xrpl_address: "x" }).success).toBe(false);
    expect(SupplierPatchSchema.safeParse({ is_approved: true, business_id: "x" }).success).toBe(false);
  });
  it("AuditQuerySchema parses bounded digit strings only", () => {
    expect(AuditQuerySchema.parse({ limit: "50", before_seq: "12" })).toEqual({ limit: 50, before_seq: 12 });
    expect(AuditQuerySchema.parse({})).toEqual({});
    for (const bad of [{ limit: "0" }, { limit: "101" }, { limit: "-1" }, { limit: "1e2" }, { before_seq: "0" }, { before_seq: "x" }, { other: "1" }]) {
      expect(AuditQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("IdParamsSchema requires a uuid", () => {
    expect(IdParamsSchema.safeParse({ id: "7f2c1f4e-8f6a-4a52-9c6b-3a2f0e1d4b5c" }).success).toBe(true);
    expect(IdParamsSchema.safeParse({ id: "1; DROP TABLE x" }).success).toBe(false);
  });
});
describe("moneyToMicro", () => {
  it("is exact", () => {
    expect(moneyToMicro("0")).toBe(0n);
    expect(moneyToMicro("0.000001")).toBe(1n);
    expect(moneyToMicro("1.5")).toBe(1_500_000n);
    expect(moneyToMicro("999999999999.999999")).toBe(999_999_999_999_999_999n);
    expect(() => moneyToMicro("1e3")).toThrow();
  });
});
describe("diffPolicy", () => {
  it("reports no change for equal policies, comparing decimals not text", () => {
    expect(diffPolicy(policy(), policy()).changed).toEqual([]);
    expect(diffPolicy(policy({ max_payment_amount: "1.50" }), policy({ max_payment_amount: "1.5" })).changed).toEqual([]);
    expect(diffPolicy(policy({ valid_until: "2030-06-01T00:00:00Z" }), policy({ valid_until: "2030-06-01T02:00:00+02:00" })).changed).toEqual([]);
  });
  it("lists only changed fields in before/after", () => {
    const d = diffPolicy(policy(), policy({ max_payment_amount: "40" }));
    expect(d.changed).toEqual(["max_payment_amount"]);
    expect(d.before).toEqual({ max_payment_amount: "100" });
    expect(d.after).toEqual({ max_payment_amount: "40" });
    expect(d.risky).toBe(false);
  });
  it("treats raising a cap, lowering the reserve, extending expiry, adding an asset and re-enabling as risky", () => {
    expect(diffPolicy(policy(), policy({ max_payment_amount: "101" })).risky).toBe(true);
    expect(diffPolicy(policy(), policy({ daily_spend_limit: "500.000001" })).risky).toBe(true);
    expect(diffPolicy(policy(), policy({ minimum_reserve: "49.999999" })).risky).toBe(true);
    expect(diffPolicy(policy(), policy({ valid_until: "2030-07-01T00:00:00Z" })).risky).toBe(true);
    expect(diffPolicy(policy(), policy({ valid_until: null })).risky).toBe(true);
    expect(diffPolicy(policy({ enabled: false }), policy({ enabled: true })).riskyFields).toEqual(["enabled"]);
    expect(diffPolicy(policy({ allowed_assets: [] }), policy()).riskyFields).toEqual(["allowed_assets"]);
  });
  it("treats pausing and tightening as safe", () => {
    expect(diffPolicy(policy(), policy({ enabled: false })).risky).toBe(false);
    expect(diffPolicy(policy(), policy({ minimum_reserve: "60", daily_spend_limit: "400", valid_until: "2030-03-01T00:00:00Z" })).risky).toBe(false);
    expect(diffPolicy(policy(), policy({ allowed_assets: [] })).risky).toBe(false);
    expect(diffPolicy(policy({ valid_until: null }), policy()).risky).toBe(false);
  });
  it("asset order does not matter", () => {
    const other = { currency: CUR, issuer: "rrrrrrrrrrrrrrrrrrrrrrrrrrr" };
    const a = policy({ allowed_assets: [{ currency: CUR, issuer: ISSUER }, other] });
    const b = policy({ allowed_assets: [other, { currency: CUR, issuer: ISSUER }] });
    expect(diffPolicy(a, b).changed).toEqual([]);
  });
});
