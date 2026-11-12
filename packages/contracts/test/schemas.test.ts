import { describe, expect, it } from "vitest";
import { AgentPaymentRequestSchema, TreasuryPolicySchema } from "../src/index";

const policy = { enabled: true, max_payment_amount: "10", daily_spend_limit: "20", minimum_reserve: "5", allowed_assets: [], valid_until: null, version: 1 };

describe("schema strictness", () => {
  it("rejects unknown keys on contract schemas", () => {
    expect(TreasuryPolicySchema.safeParse(policy).success).toBe(true);
    expect(TreasuryPolicySchema.safeParse({ ...policy, is_admin: true }).success).toBe(false);
    expect(TreasuryPolicySchema.safeParse({ ...policy, allowed_assets: [{ currency: "A", issuer: "B", extra: 1 }] }).success).toBe(false);
  });

  it("strips (never trusts) model-supplied extra fields on the agent request", () => {
    const parsed = AgentPaymentRequestSchema.parse({ invoice_id: "i", idempotency_key: "k", destination: "rEvil", amount: "999" });
    expect(Object.keys(parsed).sort()).toEqual(["idempotency_key", "invoice_id"]);
  });

  it("does not let __proto__ in JSON reach the parsed object", () => {
    const parsed = AgentPaymentRequestSchema.parse(JSON.parse('{"invoice_id":"i","idempotency_key":"k","__proto__":{"polluted":true}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(parsed)).not.toContain("__proto__");
  });
});
