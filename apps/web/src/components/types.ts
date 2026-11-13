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
  treasury: { rlusd_balance: string | null; as_of: string | null; source: "snapshot" | "unavailable" };
  today: { business_date: string; automated_spend: string; daily_limit: string; remaining_allowance: string };
  limits: { minimum_reserve: string; max_payment_amount: string };
  automation: { state: "paused" | "expired" | "needs_attention" | "active"; enabled: boolean; valid_until: string | null };
  invoices: { open: number; blocked: number; processing: number };
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
export interface RlusdPair {
  currency: string;
  issuer: string;
}
