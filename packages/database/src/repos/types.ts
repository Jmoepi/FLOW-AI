import type { MoneyString, PaymentStatus } from "@flow-ai/contracts";

export type InvoiceStatus = "draft" | "open" | "processing" | "paid" | "blocked" | "cancelled";
export type ReservationStatus = "reserved" | "committed" | "released";
export type ActorType = "human" | "agent" | "policy_service" | "system";

export interface BusinessRow {
  id: string;
  name: string;
  country_code: string;
  timezone: string;
}

export interface WalletRow {
  id: string;
  business_id: string;
  network: string;
  address: string;
  asset_currency: string;
  asset_issuer: string;
  signing_key_mode: SigningKeyMode;
  is_active: boolean;
}

export interface SupplierRow {
  id: string;
  business_id: string;
  name: string;
  xrpl_address: string;
  country_code: string;
  is_approved: boolean;
  is_active: boolean;
}

export interface InvoiceRow {
  id: string;
  business_id: string;
  supplier_id: string;
  invoice_number: string;
  /** Untrusted text. Data only. */
  description: string | null;
  amount: MoneyString;
  currency: string;
  issue_date: string;
  due_date: string;
  priority: number | null;
  status: InvoiceStatus;
}

export interface PolicyRow {
  id: string;
  business_id: string;
  enabled: boolean;
  max_payment_amount: MoneyString;
  daily_spend_limit: MoneyString;
  minimum_reserve: MoneyString;
  allowed_assets: { currency: string; issuer: string }[];
  valid_until: string | null;
  version: number;
  updated_by: string | null;
}

export interface PaymentRow {
  id: string;
  business_id: string;
  invoice_id: string;
  supplier_id: string;
  wallet_id: string;
  network: string;
  asset_currency: string;
  asset_issuer: string;
  amount: MoneyString;
  destination_address: string;
  status: PaymentStatus;
  policy_version: number;
  idempotency_key: string;
  request_hash: string;
  tx_hash: string | null;
  last_ledger_sequence: number | null;
  first_ledger_sequence: number | null;
  ledger_index: number | null;
  result_code: string | null;
  delivered_amount: MoneyString | null;
  fee_drops: string | null;
  failure_code: string | null;
  failure_message: string | null;
  agent_reason: string | null;
  /** Sensitive (PG-10): never returned by an API, never logged. Cleared on final outcome. */
  signed_blob: string | null;
  previous_payment_id: string | null;
  business_date: string;
  requested_at: string;
  submitted_at: string | null;
  validated_at: string | null;
  updated_at: string;
}

export interface ReservationRow {
  id: string;
  business_id: string;
  business_date: string;
  payment_id: string;
  amount: MoneyString;
  status: ReservationStatus;
  created_at: string;
  updated_at: string;
}

/** What the poller observed about the treasury's RegularKey (M7). Read-only and informational. */
export type RegularKeyState = "active" | "not_set" | "other" | "not_configured";
export type SigningKeyMode = "master_env" | "regular_key" | "revoked";
export interface SnapshotRow {
  id: string;
  wallet_id: string;
  rlusd_balance: MoneyString | null;
  xrp_balance: MoneyString;
  as_of: string;
  ledger_index: number | null;
  regular_key_state: RegularKeyState | null;
}

export interface AuditRow {
  id: string;
  business_id: string;
  seq: number;
  prev_hash: string;
  row_hash: string;
  actor_type: ActorType;
  actor_id: string | null;
  event_type: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  request_id: string | null;
  created_at: string;
}
