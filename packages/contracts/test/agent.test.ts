import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_INPUT_SCHEMAS,
  AGENT_TOOL_NAMES,
  AGENT_TOOL_OUTPUT_SCHEMAS,
  AgentReasonSchema,
  AgentRunCreateSchema,
  AgentRunEventSchema,
  AgentRunFinishSchema,
  AgentRunsQuerySchema,
  GetPaymentStatusInputSchema,
  InvoiceItemSchema,
  RequestSupplierPaymentInputSchema,
  sanitizeText,
  untrusted,
} from "../src/index";

const ID = "6f1c1d0e-8b7a-4c1e-9a52-3d2f5b1a7c10";
const ID2 = "7f1c1d0e-8b7a-4c1e-9a52-3d2f5b1a7c11";
const KEY = "agent-0123456789abcdef";

describe("tool names", () => {
  it("are exactly the five spec 7.2.D tools", () => {
    expect([...AGENT_TOOL_NAMES]).toEqual(["get_business_snapshot", "list_open_invoices", "get_invoice_details", "request_supplier_payment", "get_payment_status"]);
    expect(Object.keys(AGENT_TOOL_INPUT_SCHEMAS).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    expect(Object.keys(AGENT_TOOL_OUTPUT_SCHEMAS).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
  });
});

describe("tool inputs reject unknown keys", () => {
  const valid: Record<string, unknown> = {
    get_business_snapshot: {},
    list_open_invoices: { limit: 5 },
    get_invoice_details: { invoice_id: ID },
    request_supplier_payment: { invoice_id: ID, idempotency_key: KEY, agent_reason: "ok" },
    get_payment_status: { payment_id: ID },
  };
  for (const name of AGENT_TOOL_NAMES) {
    it(name, () => {
      const schema = AGENT_TOOL_INPUT_SCHEMAS[name];
      expect(schema.safeParse(valid[name]).success).toBe(true);
      expect(schema.safeParse({ ...(valid[name] as object), amount: "1000" }).success).toBe(false);
      expect(schema.safeParse({ ...(valid[name] as object), destination: "rXXXX", business_id: ID }).success).toBe(false);
    });
  }
  it("request_supplier_payment rejects bad ids and keys", () => {
    expect(RequestSupplierPaymentInputSchema.safeParse({ invoice_id: "x", idempotency_key: KEY }).success).toBe(false);
    expect(RequestSupplierPaymentInputSchema.safeParse({ invoice_id: ID, idempotency_key: "short" }).success).toBe(false);
  });
  it("list_open_invoices bounds limit", () => {
    expect(AGENT_TOOL_INPUT_SCHEMAS.list_open_invoices.safeParse({ limit: 21 }).success).toBe(false);
    expect(AGENT_TOOL_INPUT_SCHEMAS.list_open_invoices.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe("agent_reason", () => {
  it("strips controls, bidi and zero-width characters", () => {
    const r = AgentReasonSchema.parse("  a\u0000b\u001b[31mc\u202Ed\u200Be\u0085f\n  ");
    expect(r).toBe("ab[31mcdef");
  });
  it("rejects more than 280 characters after stripping, accepts exactly 280", () => {
    expect(AgentReasonSchema.safeParse("x".repeat(281)).success).toBe(false);
    expect(AgentReasonSchema.safeParse("x".repeat(280)).success).toBe(true);
    expect(AgentReasonSchema.safeParse("x".repeat(280) + "\u0000".repeat(50)).success).toBe(true);
    expect(AgentReasonSchema.safeParse("x".repeat(2001)).success).toBe(false);
  });
});

describe("get_payment_status input", () => {
  it("requires exactly one id", () => {
    expect(GetPaymentStatusInputSchema.safeParse({}).success).toBe(false);
    expect(GetPaymentStatusInputSchema.safeParse({ payment_id: ID, invoice_id: ID2 }).success).toBe(false);
    expect(GetPaymentStatusInputSchema.safeParse({ invoice_id: ID2 }).success).toBe(true);
  });
});

describe("sanitizeText / untrusted", () => {
  it("strips controls and truncates by code point", () => {
    expect(sanitizeText("a\u0007b\u2066c\u2069d", 10)).toBe("abcd");
    expect(sanitizeText("😀😀😀", 2)).toBe("😀😀");
  });
  it("wraps text as untrusted data", () => {
    expect(untrusted("hi\u0000", 10)).toEqual({ untrusted: true, text: "hi" });
  });
});

describe("output schemas", () => {
  const item = {
    invoice_id: ID,
    invoice_number: untrusted("INV-1", 64),
    due_date: "2030-01-01",
    amount: "1",
    currency: "RLUSD",
    status: "open",
    supplier: { name: untrusted("Acme", 200), country_code: "ZA", approved: true },
    description: null,
    eligibility: { eligible: true, failed_checks: [], as_of: "2030-01-01T00:00:00Z", preview: true },
  };
  it("accept a valid invoice and reject extra keys or unwrapped text", () => {
    expect(InvoiceItemSchema.safeParse(item).success).toBe(true);
    expect(InvoiceItemSchema.safeParse({ ...item, destination: "rXXXX" }).success).toBe(false);
    expect(InvoiceItemSchema.safeParse({ ...item, invoice_number: "INV-1" }).success).toBe(false);
    expect(InvoiceItemSchema.safeParse({ ...item, supplier: { ...item.supplier, xrpl_address: "r" } }).success).toBe(false);
  });
  it("snapshot output rejects policy internals", () => {
    const snap = { as_of: null, rlusd_balance: "5", minimum_reserve: "1", daily_remaining: "1", automation: "enabled", network: "testnet", stale: false };
    expect(AGENT_TOOL_OUTPUT_SCHEMAS.get_business_snapshot.safeParse(snap).success).toBe(true);
    expect(AGENT_TOOL_OUTPUT_SCHEMAS.get_business_snapshot.safeParse({ ...snap, kill_switch: "enabled" }).success).toBe(false);
  });
});

describe("run-record contracts", () => {
  it("create is strict", () => {
    expect(AgentRunCreateSchema.safeParse({ trigger: "manual", mode: "deterministic" }).success).toBe(true);
    expect(AgentRunCreateSchema.safeParse({ trigger: "manual", mode: "deterministic", business_id: ID }).success).toBe(false);
  });
  it("event is strict and size bounded", () => {
    expect(AgentRunEventSchema.safeParse({ kind: "tool_call", tool_name: "get_payment_status", input: { a: 1 } }).success).toBe(true);
    expect(AgentRunEventSchema.safeParse({ kind: "tool_call", tool_name: "sign_transaction" }).success).toBe(false);
    expect(AgentRunEventSchema.safeParse({ kind: "note", extra: 1 }).success).toBe(false);
    expect(AgentRunEventSchema.safeParse({ kind: "note", output: { big: "x".repeat(5000) } }).success).toBe(false);
  });
  it("finish accepts only terminal client_status hints and at most 5 tool calls", () => {
    const f = { client_status: "paid", summary: "ok", tool_call_count: 5 };
    expect(AgentRunFinishSchema.safeParse(f).success).toBe(true);
    expect(AgentRunFinishSchema.safeParse({ ...f, client_status: "running" }).success).toBe(false);
    expect(AgentRunFinishSchema.safeParse({ ...f, tool_call_count: 6 }).success).toBe(false);
  });
  it("finish carries no authoritative outcome fields: status and decision_code are rejected as unknown keys", () => {
    const f = { client_status: "paid", summary: "ok", tool_call_count: 1 };
    expect(AgentRunFinishSchema.safeParse({ ...f, status: "paid" }).success).toBe(false);
    expect(AgentRunFinishSchema.safeParse({ ...f, decision_code: "ALLOWED" }).success).toBe(false);
    expect(AgentRunFinishSchema.safeParse({ ...f, summary: "x".repeat(501) }).success).toBe(false);
  });
  it("web query is strict", () => {
    expect(AgentRunsQuerySchema.safeParse({ limit: "10", before_seq: "5" }).success).toBe(true);
    expect(AgentRunsQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(AgentRunsQuerySchema.safeParse({ business_id: ID }).success).toBe(false);
  });
});
