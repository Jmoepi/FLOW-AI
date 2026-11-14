/** Shapes returned by the owner API (see src/server/api). Display-only: the server stays the authority. */
export interface PolicyData {
  enabled: boolean;
  max_payment_amount: string;
  daily_spend_limit: string;
  minimum_reserve: string;
  allowed_assets: { currency: string; issuer: string }[];
  valid_until: string | null;
  version: number;
  updated_at: string | null;
  updated_by: "you" | "another_user" | null;
}
export interface PolicyResponse {
  policy: PolicyData;
  timezone: string | null;
  network: string;
  display_unit: string;
}
export interface OverviewData {
  network: string;
  business: { name: string; timezone: string };
  treasury: { rlusd_balance: string | null; as_of: string | null; source: "snapshot" | "unavailable"; age_seconds: number | null; stale: boolean };
  today: { business_date: string; automated_spend: string; daily_limit: string; remaining_allowance: string };
  limits: { minimum_reserve: string; max_payment_amount: string };
  automation: { state: "paused" | "expired" | "needs_attention" | "active"; enabled: boolean; valid_until: string | null };
  invoices: { open: number; blocked: number; processing: number };
  /** Read-only status of the guard's signing key (M7). The dashboard never holds or asks for a key. */
  signing_key: { state: "revoked" | "active" | "other" | "not_set" | "unknown" };
  agent: {
    state: "ready" | "running" | "paused" | "needs_attention";
    last_run: { id: string; started_at: string; status: string; trigger: string; decision_code: string | null; invoice_number: string | null } | null;
    run_request: { status: string; requested_at: string } | null;
  };
  last_decision_code: string | null;
  queue: InvoiceData[];
  recent_payments: PaymentData[];
}
export interface InvoiceData {
  id: string;
  invoice_number: string;
  supplier_id: string;
  supplier_name: string;
  corridor: "Domestic" | "Cross-border";
  amount: string;
  currency: string;
  due_date: string;
  status: string;
  blocked_code: string | null;
  latest_payment_id: string | null;
  issue_date?: string;
  supplier_country?: string;
  supplier_address?: string;
  description?: string | null;
  latest_payment_status?: string | null;
}
export interface PaymentData {
  id: string;
  status: string;
  amount: string;
  asset: string;
  invoice_id: string;
  invoice_number: string;
  supplier_name: string;
  requested_at: string;
  tx_hash: string | null;
  explorer_url: string | null;
  failure_code: string | null;
  network?: string;
  destination_address?: string;
  ledger_index?: number | null;
  validated_at?: string | null;
  delivered_amount?: string | null;
  fee_drops?: string | null;
  policy_version?: number;
  failure_message?: string | null;
  agent_reason?: string | null;
}
export interface InvoicesPage {
  invoices: InvoiceData[];
  page: number;
  has_more: boolean;
}
export interface PaymentsPage {
  payments: PaymentData[];
  page: number;
  has_more: boolean;
}
export interface SupplierData {
  id: string;
  name: string;
  xrpl_address: string;
  country_code: string | null;
  is_approved: boolean;
  is_active: boolean;
  updated_at: string | null;
}
export interface AuditEventData {
  seq: number;
  created_at: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  actor: string;
  request_id: string | null;
  metadata: unknown;
}
export interface AuditPage {
  events: AuditEventData[];
  next_before_seq: number | null;
}
export interface AgentEventData {
  seq: number;
  kind: string;
  tool_name: string | null;
  ok: boolean | null;
  error_code: string | null;
  duration_ms: number | null;
  input: unknown;
  output: unknown;
}
export interface AgentRunData {
  id: string;
  seq: number;
  started_at: string;
  completed_at: string | null;
  status: string;
  trigger: string;
  mode: string;
  effective_mode: string | null;
  summary: string | null;
  tool_call_count: number;
  decision_code: string | null;
  agent_reason: string | null;
  invoice_number: string | null;
  payment: { id: string; status: string | null; tx_hash: string | null; explorer_url: string | null } | null;
  events: AgentEventData[];
}
export interface AgentRunsPage {
  runs: AgentRunData[];
  next_before_seq: number | null;
}
export interface RlusdPair {
  currency: string;
  issuer: string;
}
