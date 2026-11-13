import { describe, expect, it } from "vitest";
import { AgentPaymentRequestSchema, GuardPaymentRequestSchema, TreasuryPolicySchema } from "../src/index";

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

describe("GuardPaymentRequestSchema", () => {
  const ok = { invoice_id: "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b", idempotency_key: "run-1:inv-0001" };
  it("accepts the minimal and the full request", () => {
    expect(GuardPaymentRequestSchema.safeParse(ok).success).toBe(true);
    expect(GuardPaymentRequestSchema.safeParse({ ...ok, agent_reason: "Due soon." }).success).toBe(true);
  });
  it("rejects unknown keys instead of stripping them", () => {
    for (const extra of ["amount", "destination", "business_id", "tx_blob", "__proto__"]) {
      const body = JSON.parse(JSON.stringify(ok)) as Record<string, unknown>;
      Object.defineProperty(body, extra, { value: "x", enumerable: true, configurable: true, writable: true });
      expect(GuardPaymentRequestSchema.safeParse(body).success).toBe(false);
    }
  });
  it("rejects bad ids, keys, long reasons and control characters", () => {
    expect(GuardPaymentRequestSchema.safeParse({ ...ok, invoice_id: "1; DROP TABLE payments" }).success).toBe(false);
    expect(GuardPaymentRequestSchema.safeParse({ ...ok, idempotency_key: "short" }).success).toBe(false);
    expect(GuardPaymentRequestSchema.safeParse({ ...ok, idempotency_key: "has space in it" }).success).toBe(false);
    expect(GuardPaymentRequestSchema.safeParse({ ...ok, agent_reason: "a".repeat(281) }).success).toBe(false);
    expect(GuardPaymentRequestSchema.safeParse({ ...ok, agent_reason: "line\u0000break\u001b[31m" }).success).toBe(false);
  });
});
