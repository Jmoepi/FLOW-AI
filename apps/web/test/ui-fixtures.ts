import type { AgentRunsPage, AuditPage, InvoiceData, OverviewData, PaymentData, PolicyData, RlusdPair, SupplierData } from "../src/components/types";
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
export const HASH = "A".repeat(64);
export const INVOICE_OPEN: InvoiceData = {
  id: "44444444-4444-4444-8444-444444444444",
  invoice_number: "INV-1001",
  supplier_id: "11111111-1111-4111-8111-111111111111",
  supplier_name: "Globex Ltd",
  corridor: "Cross-border",
  amount: "150.5",
  currency: "RLUSD",
  due_date: "2026-01-17",
  status: "open",
  blocked_code: null,
  latest_payment_id: null,
  issue_date: "2026-01-02",
  supplier_country: "GB",
  supplier_address: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  description: "Consulting, January",
  latest_payment_status: null,
};
export const INVOICE_BLOCKED: InvoiceData = { ...INVOICE_OPEN, id: "55555555-5555-4555-8555-555555555555", invoice_number: "INV-1002", status: "blocked", blocked_code: "SUPPLIER_NOT_APPROVED", corridor: "Domestic", due_date: "2026-01-10" };
export const PAYMENT_PAID: PaymentData = {
  id: "22222222-2222-4222-8222-222222222222",
  status: "validated",
  amount: "150.5",
  asset: "RLUSD",
  invoice_id: INVOICE_OPEN.id,
  invoice_number: "INV-1001",
  supplier_name: "Globex Ltd",
  requested_at: "2026-01-15T10:00:00.000Z",
  tx_hash: HASH,
  explorer_url: `https://testnet.xrpl.org/transactions/${HASH}`,
  failure_code: null,
  network: "XRPL Testnet",
  destination_address: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
  ledger_index: 123,
  validated_at: "2026-01-15T10:00:09.000Z",
  delivered_amount: "150.5",
  fee_drops: "12",
  policy_version: 3,
  failure_message: null,
  agent_reason: "Earliest due date.",
};
export const PAYMENT_BLOCKED: PaymentData = { ...PAYMENT_PAID, id: "66666666-6666-4666-8666-666666666666", status: "blocked", tx_hash: null, explorer_url: null, failure_code: "DAILY_LIMIT_EXCEEDED", ledger_index: null, validated_at: null, delivered_amount: null, fee_drops: null };
export const PAYMENT_PENDING: PaymentData = { ...PAYMENT_PAID, id: "77777777-7777-4777-8777-777777777777", status: "pending_confirmation", explorer_url: null, ledger_index: null, validated_at: null, delivered_amount: null };
export const OVERVIEW: OverviewData = {
  network: "XRPL Testnet",
  business: { name: "Acme Test Co", timezone: "Europe/London" },
  treasury: { rlusd_balance: "12345.5", as_of: "2026-01-15T09:00:00.000Z", source: "snapshot", age_seconds: 120, stale: false },
  today: { business_date: "2026-01-15", automated_spend: "100", daily_limit: "1000", remaining_allowance: "900" },
  limits: { minimum_reserve: "250", max_payment_amount: "500" },
  automation: { state: "active", enabled: true, valid_until: null },
  invoices: { open: 2, blocked: 1, processing: 0 },
  signing_key: { state: "active" },
  agent: { state: "ready", last_run: { id: "11111111-1111-4111-8111-111111111111", started_at: "2026-01-15T10:00:00.000Z", status: "paid", trigger: "manual", decision_code: null, invoice_number: "INV-1001" }, run_request: null },
  last_decision_code: "DAILY_LIMIT_EXCEEDED",
  queue: [INVOICE_BLOCKED, INVOICE_OPEN],
  recent_payments: [PAYMENT_PAID, PAYMENT_BLOCKED],
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
