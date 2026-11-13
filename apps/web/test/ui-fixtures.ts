import type { AgentRunsPage, AuditPage, OverviewData, PolicyData, RlusdPair, SupplierData } from "../src/components/types";
export const PAIR: RlusdPair = { currency: "524C555344000000000000000000000000000000", issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV" };
export const POLICY: PolicyData = {
  enabled: true,
  max_payment_amount: "500",
  daily_spend_limit: "1000",
  minimum_reserve: "250",
  allowed_assets: [PAIR],
  valid_until: null,
  version: 3,
  updated_at: "2026-01-15T10:00:00.000Z",
  updated_by: "you",
};
export const OVERVIEW: OverviewData = {
  network: "XRPL Testnet",
  business: { name: "Acme Test Co", timezone: "Europe/London" },
  treasury: { rlusd_balance: "12345.5", as_of: "2026-01-15T09:00:00.000Z", source: "snapshot" },
  today: { business_date: "2026-01-15", automated_spend: "100", daily_limit: "1000", remaining_allowance: "900" },
  limits: { minimum_reserve: "250", max_payment_amount: "500" },
  automation: { state: "active", enabled: true, valid_until: null },
  invoices: { open: 2, blocked: 1, processing: 0 },
};
export const SUPPLIERS: SupplierData[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Globex Ltd", xrpl_address: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe", country_code: "GB", is_approved: true, is_active: true, updated_at: null },
  { id: "22222222-2222-4222-8222-222222222222", name: "Initech", xrpl_address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", country_code: null, is_approved: false, is_active: true, updated_at: null },
];
export const AUDIT: AuditPage = {
  events: [
    {
      seq: 7,
      created_at: "2026-01-15T10:00:00.000Z",
      event_type: "policy.updated",
      entity_type: "treasury_policy",
      entity_id: null,
      actor: "you",
      request_id: "r1",
      metadata: { changed: ["max_payment_amount"], before: { max_payment_amount: "600" }, after: { max_payment_amount: "500" } },
    },
  ],
  next_before_seq: 7,
};
export const HASH = "A".repeat(64);
export const AGENT_RUNS: AgentRunsPage = {
  runs: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      seq: 5,
      started_at: "2026-01-15T10:00:00.000Z",
      completed_at: "2026-01-15T10:00:09.000Z",
      status: "paid",
      trigger: "manual",
      mode: "deterministic",
      effective_mode: "deterministic",
      summary: "Paid",
      tool_call_count: 4,
      decision_code: "ALLOWED",
      agent_reason: "Deterministic rule: earliest due date (2026-02-01) among 2 eligible invoices, amount 1 RLUSD. The payment guard decides.",
      invoice_number: "INV-1",
      payment: { id: "22222222-2222-4222-8222-222222222222", status: "validated", tx_hash: HASH, explorer_url: `https://testnet.xrpl.org/transactions/${HASH}` },
      events: [
        { seq: 1, kind: "tool_call", tool_name: "get_business_snapshot", ok: true, error_code: null, duration_ms: 12, input: {}, output: {} },
        { seq: 2, kind: "decision", tool_name: null, ok: true, error_code: null, duration_ms: null, input: null, output: null },
      ],
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      seq: 4,
      started_at: "2026-01-14T10:00:00.000Z",
      completed_at: "2026-01-14T10:00:05.000Z",
      status: "blocked",
      trigger: "interval",
      mode: "llm",
      effective_mode: "deterministic",
      summary: "Blocked",
      tool_call_count: 3,
      decision_code: "SUPPLIER_NOT_APPROVED",
      agent_reason: null,
      invoice_number: null,
      payment: null,
      events: [],
    },
  ],
  next_before_seq: 4,
};
